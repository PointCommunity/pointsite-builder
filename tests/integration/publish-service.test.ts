// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import type { StagingVerificationEvidence } from '../../src/server/github/client';
import { D1PublishJobStore } from '../../src/server/publish/jobs';
import { StagingPublisher } from '../../src/server/publish/service';
import { InMemoryRepository } from '../../src/server/repositories/memory';

let miniflare: Miniflare;
afterEach(async () => miniflare?.dispose());

const baseSha = 'a'.repeat(40);
const commitSha = 'b'.repeat(40);
const config = { appId: '1', installationId: '2', privateKey: 'unused' };
type VerificationResult =
  | { status: 'pending' }
  | { status: 'failed'; failedChecks: string[]; failedCheckUrls: Record<string, string> }
  | { status: 'passed'; evidence: StagingVerificationEvidence };

async function setup() {
  miniflare = new Miniflare({
    compatibilityDate: '2026-09-05',
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { DB: crypto.randomUUID() },
  });
  const database = await miniflare.getD1Database('DB');
  await database.exec(
    (await readFile('migrations/0001_initial.sql', 'utf8')).replace(/\s+/g, ' ').trim(),
  );
  const repository = new InMemoryRepository();
  const draft = await repository.createDraft({
    name: 'Publish test',
    document: defaultSiteDocument,
    actor: 'publisher@pointatx.org',
    idempotencyKey: 'create-publish-test',
    requestId: 'request-create',
  });
  let currentSha = baseSha;
  const client = {
    currentMainSha: vi.fn(() => Promise.resolve(currentSha)),
    commitFiles: vi.fn(() => {
      currentSha = commitSha;
      return Promise.resolve({
        sha: commitSha,
        url: `https://github.com/PointCommunity/pointsite-staging/commit/${commitSha}`,
      });
    }),
    verificationForCommit: vi.fn<(_: string) => Promise<VerificationResult>>().mockResolvedValue({
      status: 'passed' as const,
      evidence: {
        commitSha,
        workflowRunId: '1',
        workflowUrl: 'https://github.com/PointCommunity/pointsite-staging/actions/runs/1',
        deploymentId: '2',
        deploymentUrl: 'https://github.com/PointCommunity/pointsite-staging/actions/runs/2',
        checks: {
          build: true as const,
          schema: true as const,
          renderer: true as const,
          routes: true as const,
          assets: true as const,
          accessibility: true as const,
          responsive: true as const,
          security: true as const,
          primaryFlow: true as const,
          live: true as const,
        },
      },
    }),
  };
  const jobs = new D1PublishJobStore(database);
  return {
    database,
    repository,
    draft,
    client,
    jobs,
    publisher: new StagingPublisher(repository, config, undefined, jobs, () =>
      Promise.resolve(client),
    ),
  };
}

describe('staging publish coordinator', () => {
  it('commits one exact candidate and returns the durable result on retry', async () => {
    const { publisher, draft, client, jobs } = await setup();
    await expect(publisher.currentBaseSha()).resolves.toBe(baseSha);
    const input = {
      draftId: draft.id,
      expectedRevisionId: draft.revision.id,
      expectedRevisionChecksum: draft.revision.checksum,
      expectedBaseSha: baseSha,
      actor: 'publisher@pointatx.org',
      idempotencyKey: 'publish-candidate-0001',
      requestId: 'request-publish',
    };
    const result = await publisher.publish(input);
    const retry = await publisher.publish({
      ...input,
      idempotencyKey: 'publish-candidate-duplicate-safe',
    });
    expect(retry).toEqual(result);
    expect(result.jobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result).toMatchObject({
      revisionId: draft.revision.id,
      stagingBaseSha: baseSha,
      commitSha,
      status: 'succeeded',
    });
    expect(client.commitFiles).toHaveBeenCalledOnce();
    expect((await jobs.getByKey(input.idempotencyKey))?.status).toBe('succeeded');
    await expect(publisher.workflowForDraft(draft.id)).resolves.toMatchObject({
      currentStagingSha: commitSha,
      reviewUrl: 'https://staging.pointatx.org',
      job: {
        id: result.jobId,
        revisionId: draft.revision.id,
        stagingCommitSha: commitSha,
        status: 'succeeded',
      },
    });
  });

  it('records exact verification evidence and rejects a reused key after draft drift', async () => {
    const { publisher, repository, draft, client } = await setup();
    const input = {
      draftId: draft.id,
      expectedRevisionId: draft.revision.id,
      expectedRevisionChecksum: draft.revision.checksum,
      expectedBaseSha: baseSha,
      actor: 'publisher@pointatx.org',
      idempotencyKey: 'publish-candidate-0002',
      requestId: 'request-publish',
    };
    const result = await publisher.publish(input);
    const verified = await publisher.refreshVerification(
      result.jobId ?? '',
      input.actor,
      'request-verify',
    );
    expect(verified.evidence).toMatchObject({
      verificationStatus: 'passed',
      commitSha,
      candidateChecksum: result.candidateChecksum,
    });
    expect(client.verificationForCommit).toHaveBeenCalledWith(commitSha);
    client.verificationForCommit.mockResolvedValueOnce({ status: 'pending' });
    await expect(
      publisher.refreshVerification(result.jobId ?? '', input.actor, 'request-pending'),
    ).resolves.toMatchObject({ evidence: { verificationStatus: 'pending' } });
    client.verificationForCommit.mockResolvedValueOnce({
      status: 'failed',
      failedChecks: ['deploy'],
      failedCheckUrls: {
        deploy: 'https://github.com/PointCommunity/pointsite-staging/actions/runs/2',
      },
    });
    await expect(
      publisher.refreshVerification(result.jobId ?? '', input.actor, 'request-failed'),
    ).resolves.toMatchObject({
      evidence: {
        verificationStatus: 'failed',
        failedChecks: ['deploy'],
        failedCheckUrls: {
          deploy: 'https://github.com/PointCommunity/pointsite-staging/actions/runs/2',
        },
      },
    });

    const changed = structuredClone(draft.document);
    changed.site.shortName = 'Changed';
    await repository.saveDraft({
      draftId: draft.id,
      expectedChecksum: draft.revision.checksum,
      document: changed,
      actor: input.actor,
      idempotencyKey: 'save-before-retry',
      requestId: 'request-save',
      action: { category: 'control-change', context: 'site-settings' },
    });
    await expect(publisher.publish(input)).rejects.toThrow('DRAFT_REVISION_DRIFT');
  });

  it('persists a failed commit and refuses verification before a successful result', async () => {
    const { publisher, draft, client, jobs } = await setup();
    client.commitFiles.mockRejectedValueOnce(new Error('GITHUB_TEST_FAILURE'));
    const input = {
      draftId: draft.id,
      expectedRevisionId: draft.revision.id,
      expectedRevisionChecksum: draft.revision.checksum,
      expectedBaseSha: baseSha,
      actor: 'publisher@pointatx.org',
      idempotencyKey: 'publish-candidate-0003',
      requestId: 'request-failure',
    };
    await expect(publisher.publish(input)).rejects.toThrow('GITHUB_TEST_FAILURE');
    const job = await jobs.getByKey(input.idempotencyKey);
    expect(job).toMatchObject({
      status: 'failed',
      evidence: { failureCode: 'GITHUB_TEST_FAILURE' },
    });
    await expect(
      publisher.refreshVerification(job?.id ?? '', input.actor, 'request-verify'),
    ).rejects.toThrow('PUBLISH_JOB_NOT_VERIFIABLE');
    await expect(publisher.getJob('missing')).resolves.toBeNull();
  });
});
