// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import type { StagingVerificationEvidence } from '../../src/server/github/client';
import { D1PublishJobStore } from '../../src/server/publish/jobs';
import { D1PublishPreflightStore } from '../../src/server/publish/preflights';
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
  for (const migration of [
    'migrations/0001_initial.sql',
    'migrations/0010_publish_preflight_leases.sql',
  ]) {
    await database.exec((await readFile(migration, 'utf8')).replace(/\s+/g, ' ').trim());
  }
  const repository = new InMemoryRepository();
  const draft = await repository.createDraft({
    name: 'Publish test',
    document: defaultSiteDocument,
    actor: 'publisher@pointatx.org',
    idempotencyKey: 'create-publish-test',
    requestId: 'request-create',
  });
  await database
    .prepare(
      "INSERT INTO drafts (id,site_id,name,status,created_by,created_at,updated_at) VALUES (?,'pointsite',?,'active',?,?,?)",
    )
    .bind(draft.id, draft.name, draft.createdBy, draft.createdAt, draft.updatedAt)
    .run();
  await database
    .prepare(
      'INSERT INTO revisions (id,draft_id,sequence,parent_revision_id,checksum,document_json,label,schema_version,renderer_version,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    )
    .bind(
      draft.revision.id,
      draft.id,
      draft.revision.sequence,
      draft.revision.parentRevisionId,
      draft.revision.checksum,
      JSON.stringify(draft.document),
      draft.revision.label,
      draft.revision.schemaVersion,
      draft.revision.rendererVersion,
      draft.revision.createdBy,
      draft.revision.createdAt,
    )
    .run();
  await database
    .prepare('UPDATE drafts SET latest_revision_id=? WHERE id=?')
    .bind(draft.revision.id, draft.id)
    .run();
  let currentSha = baseSha;
  const client = {
    currentMainSha: vi.fn(() => Promise.resolve(currentSha)),
    assertRendererCompatible: vi.fn(() => Promise.resolve()),
    advanceCommit: vi.fn(() => {
      currentSha = commitSha;
      return Promise.resolve({
        status: 'succeeded' as const,
        commit: {
          sha: commitSha,
          url: `https://github.com/PointCommunity/pointsite-staging/commit/${commitSha}`,
        },
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
  const preflights = new D1PublishPreflightStore(database);
  const media = {
    readManyForDraft: vi.fn().mockResolvedValue(
      new Map(
        draft.document.media.map((item) => [
          item.sourcePath,
          {
            bytes: Uint8Array.of(1, 2, 3),
            contentType: 'image/png',
            filename: 'fixture.png',
          },
        ]),
      ),
    ),
  };
  return {
    database,
    repository,
    draft,
    client,
    jobs,
    preflights,
    media,
    publisher: new StagingPublisher(repository, config, media as never, jobs, preflights, () =>
      Promise.resolve(client),
    ),
  };
}

const preflightInput = (
  draft: Awaited<ReturnType<InMemoryRepository['createDraft']>>,
  key: string,
) => ({
  draftId: draft.id,
  expectedRevisionId: draft.revision.id,
  expectedRevisionChecksum: draft.revision.checksum,
  actor: 'publisher@pointatx.org',
  idempotencyKey: key,
  requestId: `request-${key}`,
});

describe('staging publish coordinator', () => {
  it('rejects archived drafts before preflight or publication', async () => {
    const { publisher, repository, draft, client } = await setup();
    await publisher.preflight(preflightInput(draft, 'preflight-before-archive'));
    vi.spyOn(repository, 'getDraft').mockResolvedValue({ ...draft, status: 'archived' });
    await expect(
      publisher.preflight(preflightInput(draft, 'preflight-after-archive')),
    ).rejects.toThrow('DRAFT_REVISION_DRIFT');
    await expect(
      publisher.publish({
        ...preflightInput(draft, 'publish-after-archive'),
        expectedBaseSha: baseSha,
      }),
    ).rejects.toThrow('DRAFT_REVISION_DRIFT');
    expect(client.advanceCommit).not.toHaveBeenCalled();
  });

  it('stops archive racing publication after the in-memory revision check', async () => {
    const { publisher, draft, client, database } = await setup();
    await publisher.preflight(preflightInput(draft, 'preflight-before-archive-race'));
    client.assertRendererCompatible.mockImplementationOnce(async () => {
      await database.prepare("UPDATE drafts SET status='archived' WHERE id=?").bind(draft.id).run();
    });
    await expect(
      publisher.publish({
        ...preflightInput(draft, 'publish-archive-race'),
        expectedBaseSha: baseSha,
      }),
    ).rejects.toThrow('DRAFT_REVISION_DRIFT');
    expect(client.advanceCommit).not.toHaveBeenCalled();
    expect(
      await database.prepare('SELECT COUNT(*) AS count FROM publish_jobs').first('count'),
    ).toBe(0);
  });

  it('rejects bytes missing or changed since preflight before any destination write', async () => {
    const { publisher, draft, client, media } = await setup();
    await publisher.preflight(preflightInput(draft, 'preflight-before-byte-change'));
    media.readManyForDraft.mockResolvedValue(
      new Map(
        draft.document.media.map((item) => [
          item.sourcePath,
          {
            bytes: Uint8Array.of(9),
            contentType: 'image/png',
            filename: 'fixture.png',
          },
        ]),
      ),
    );
    await expect(
      publisher.publish({
        ...preflightInput(draft, 'publish-after-byte-change'),
        expectedBaseSha: baseSha,
      }),
    ).rejects.toThrow('PREFLIGHT_CANDIDATE_DRIFT');
    expect(client.advanceCommit).not.toHaveBeenCalled();
  });

  it('requires and retains a private exact-revision preflight before any Staging write', async () => {
    const { publisher, draft, client, preflights } = await setup();
    const input = {
      draftId: draft.id,
      expectedRevisionId: draft.revision.id,
      expectedRevisionChecksum: draft.revision.checksum,
      expectedBaseSha: baseSha,
      actor: 'publisher@pointatx.org',
      idempotencyKey: 'publish-after-preflight',
      requestId: 'request-publish',
    };

    await expect(publisher.publish(input)).rejects.toThrow('PREFLIGHT_REQUIRED');
    expect(client.advanceCommit).not.toHaveBeenCalled();

    const result = await publisher.preflight({
      draftId: draft.id,
      expectedRevisionId: draft.revision.id,
      expectedRevisionChecksum: draft.revision.checksum,
      actor: input.actor,
      idempotencyKey: 'preflight-exact-revision',
      requestId: 'request-preflight',
    });
    expect(result).toMatchObject({
      state: 'passed',
      revisionId: draft.revision.id,
      revisionChecksum: draft.revision.checksum,
    });
    expect(client.advanceCommit).not.toHaveBeenCalled();
    expect(await preflights.getLatestForDraft(draft.id)).toMatchObject({
      status: 'passed',
      candidateChecksum: result.candidateChecksum,
    });

    await expect(publisher.publish(input)).resolves.toMatchObject({ status: 'succeeded' });
  });

  it('keeps preflight current across unrelated Staging changes but invalidates contract drift', async () => {
    const { publisher, draft, client, preflights } = await setup();
    const passed = await publisher.preflight(
      preflightInput(draft, 'preflight-independent-staging'),
    );
    client.currentMainSha.mockResolvedValueOnce('e'.repeat(40));
    await expect(publisher.workflowForDraft(draft.id)).resolves.toMatchObject({
      currentStagingSha: 'e'.repeat(40),
      preflight: {
        state: 'passed',
        candidateChecksum: passed.candidateChecksum,
      },
    });

    await preflights.recordFailed({
      idempotencyKey: 'preflight-contract-drift',
      draftId: draft.id,
      revisionId: draft.revision.id,
      revisionChecksum: draft.revision.checksum,
      rendererContractChecksum: 'f'.repeat(64),
      failureCode: 'STAGING_RENDERER_MISMATCH',
      actor: 'publisher@pointatx.org',
      requestId: 'request-contract-drift',
      now: '2099-09-08T12:00:00Z',
    });
    await expect(publisher.workflowForDraft(draft.id)).resolves.toMatchObject({
      preflight: { state: 'required', reason: 'renderer-contract-changed' },
    });
    expect(client.advanceCommit).not.toHaveBeenCalled();
  });

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
    await publisher.preflight(preflightInput(draft, 'preflight-candidate-0001'));
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
    expect(client.advanceCommit).toHaveBeenCalledOnce();
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

  it('presents an expired publication lease as safely stopped and available to retry', async () => {
    const { publisher, draft, jobs, client } = await setup();
    const preflight = await publisher.preflight(preflightInput(draft, 'preflight-expired-lease'));
    await jobs.claim({
      idempotencyKey: 'publish-expired-lease',
      candidateChecksum: preflight.candidateChecksum,
      candidate: {
        siteId: 'pointsite',
        draftId: draft.id,
        revisionId: draft.revision.id,
        revisionChecksum: draft.revision.checksum,
        schemaVersion: draft.document.schemaVersion,
        rendererVersion: draft.document.rendererVersion,
        fileCount: 2,
      },
      baseSha,
      actor: 'publisher@pointatx.org',
      requestId: 'request-expired-lease',
      now: '2020-01-01T00:00:00Z',
    });

    await expect(publisher.workflowForDraft(draft.id)).resolves.toMatchObject({
      availability: { state: 'available' },
      job: {
        status: 'cancelled',
        evidence: { failureCode: 'PUBLISH_LEASE_EXPIRED' },
      },
    });
    await expect(
      publisher.publish({
        draftId: draft.id,
        expectedRevisionId: draft.revision.id,
        expectedRevisionChecksum: draft.revision.checksum,
        expectedBaseSha: baseSha,
        actor: 'publisher@pointatx.org',
        idempotencyKey: 'publish-expired-lease',
        requestId: 'request-expired-lease-retry',
      }),
    ).resolves.toMatchObject({ status: 'succeeded', commitSha });
    expect(client.advanceCommit).toHaveBeenCalledOnce();
  });

  it('rechecks the exact draft revision immediately before claiming Staging', async () => {
    const { publisher, repository, draft, client } = await setup();
    await publisher.preflight(preflightInput(draft, 'preflight-revision-recheck'));
    vi.spyOn(repository, 'getDraft')
      .mockResolvedValueOnce(draft)
      .mockResolvedValueOnce({
        ...draft,
        revision: {
          ...draft.revision,
          id: '20000000-0000-4000-8000-000000000099',
          checksum: 'f'.repeat(64),
        },
      });

    await expect(
      publisher.publish({
        draftId: draft.id,
        expectedRevisionId: draft.revision.id,
        expectedRevisionChecksum: draft.revision.checksum,
        expectedBaseSha: baseSha,
        actor: 'publisher@pointatx.org',
        idempotencyKey: 'publish-revision-recheck',
        requestId: 'request-revision-recheck',
      }),
    ).rejects.toThrow('DRAFT_REVISION_DRIFT');
    expect(client.advanceCommit).not.toHaveBeenCalled();
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
    await publisher.preflight(preflightInput(draft, 'preflight-candidate-0002'));
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
    client.advanceCommit.mockRejectedValueOnce(new Error('GITHUB_TEST_FAILURE'));
    const input = {
      draftId: draft.id,
      expectedRevisionId: draft.revision.id,
      expectedRevisionChecksum: draft.revision.checksum,
      expectedBaseSha: baseSha,
      actor: 'publisher@pointatx.org',
      idempotencyKey: 'publish-candidate-0003',
      requestId: 'request-failure',
    };
    await publisher.preflight(preflightInput(draft, 'preflight-candidate-0003'));
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

  it('rejects a stale expected Staging base before claiming or writing', async () => {
    const { publisher, draft, client, jobs } = await setup();
    await publisher.preflight(preflightInput(draft, 'preflight-stale-base'));
    client.currentMainSha.mockResolvedValue('e'.repeat(40));

    await expect(
      publisher.publish({
        draftId: draft.id,
        expectedRevisionId: draft.revision.id,
        expectedRevisionChecksum: draft.revision.checksum,
        expectedBaseSha: baseSha,
        actor: 'publisher@pointatx.org',
        idempotencyKey: 'publish-stale-base',
        requestId: 'request-stale-base',
      }),
    ).rejects.toThrow('STAGING_BASE_DRIFT');
    expect(await jobs.getByKey('publish-stale-base')).toBeNull();
    expect(client.advanceCommit).not.toHaveBeenCalled();
  });

  it('fails before candidate writes when protected Staging has a different renderer', async () => {
    const { publisher, draft, client, jobs } = await setup();
    client.assertRendererCompatible.mockRejectedValueOnce(
      new Error('STAGING_RENDERER_MISMATCH: site.css'),
    );
    await expect(
      publisher.preflight({
        draftId: draft.id,
        expectedRevisionId: draft.revision.id,
        expectedRevisionChecksum: draft.revision.checksum,
        actor: 'publisher@pointatx.org',
        idempotencyKey: 'preflight-renderer-mismatch',
        requestId: 'request-renderer-mismatch',
      }),
    ).rejects.toThrow('STAGING_RENDERER_MISMATCH: site.css');
    expect(client.advanceCommit).not.toHaveBeenCalled();
    expect(await jobs.getByKey('publish-renderer-mismatch')).toBeNull();
  });
});
