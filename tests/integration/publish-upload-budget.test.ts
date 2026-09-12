// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import { GitHubStagingClient } from '../../src/server/github/client';
import { STAGING_RENDERER_CONTRACT } from '../../src/server/publish/renderer-contract';
import { D1PublishJobStore } from '../../src/server/publish/jobs';
import { D1PublishPreflightStore } from '../../src/server/publish/preflights';
import { StagingPublisher } from '../../src/server/publish/service';
import { InMemoryRepository } from '../../src/server/repositories/memory';

let miniflare: Miniflare;
afterEach(async () => miniflare?.dispose());

const baseSha = 'a'.repeat(40);
const commitSha = 'b'.repeat(40);
const config = { appId: '1', installationId: '2', privateKey: 'unused' };
async function setup(imageCount = 100) {
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
  const document = structuredClone(defaultSiteDocument);
  while (document.media.length < imageCount)
    document.media.push({
      ...document.media[0],
      id: crypto.randomUUID(),
      sourcePath: `/assets/uploads/budget-${document.media.length}.png`,
    });
  const draft = await repository.createDraft({
    name: 'Publish test',
    document,
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
  let uncertainRefResponse = false;
  const calls: { method: string; path: string; body: Record<string, unknown> }[] = [];
  const fetcher = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(url instanceof Request ? url.url : url).pathname.split(
      '/pointsite-staging/',
    )[1];
    const method = init?.method ?? 'GET';
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
      string,
      unknown
    >;
    calls.push({ method, path, body });
    const response = (value: unknown) => Promise.resolve(Response.json(value));
    if (path === 'git/ref/heads/main') return response({ object: { sha: currentSha } });
    if (path.startsWith('contents/site-kit/'))
      return response({
        sha: STAGING_RENDERER_CONTRACT[
          path.split('/').at(-1)! as keyof typeof STAGING_RENDERER_CONTRACT
        ],
      });
    if (path === 'git/blobs') return response({ sha: 'c'.repeat(40) });
    if (path === `git/commits/${baseSha}`) return response({ tree: { sha: 'd'.repeat(40) } });
    if (path === 'git/trees') return response({ sha: 'e'.repeat(40) });
    if (path === 'git/commits')
      return response({
        sha: commitSha,
        html_url: `https://github.com/PointCommunity/pointsite-staging/commit/${commitSha}`,
      });
    if (path === 'git/refs/heads/main') {
      currentSha = String(body.sha);
      if (uncertainRefResponse) {
        uncertainRefResponse = false;
        throw new Error('UNCERTAIN_REF_RESPONSE');
      }
      return response({ object: { sha: currentSha } });
    }
    throw new Error(`Unexpected GitHub call ${method} ${path}`);
  });
  const client = new GitHubStagingClient('PointCommunity/pointsite-staging', 'token', fetcher);
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
    calls,
    loseNextRefResponse: () => {
      uncertainRefResponse = true;
    },
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

describe('resumable standalone publication', () => {
  it.each([100, 500])(
    'publishes %i images within each request budget and writes one final ref',
    async (count) => {
      const { publisher, draft, calls, jobs } = await setup(count);
      await publisher.preflight(preflightInput(draft, 'preflight-budget'));
      calls.length = 0;
      const input = {
        ...preflightInput(draft, 'publish-budget-snapshot'),
        expectedBaseSha: baseSha,
      };
      let result = await publisher.publish(input);
      const jobId = result.jobId!;
      let invocations = 1;
      const checkBudget = () => {
        // Reserve cold request authentication (two requests) and publisher app token (one).
        expect(calls.length + 3).toBeLessThanOrEqual(50);
        expect(calls.filter((call) => call.path === 'git/blobs').length).toBeLessThanOrEqual(20);
      };
      checkBudget();
      while (result.status === 'running') {
        expect(calls.some((call) => call.path === 'git/refs/heads/main')).toBe(false);
        expect(calls.some((call) => call.path === 'git/commits' && call.method === 'POST')).toBe(
          false,
        );
        const job = await jobs.getById(jobId);
        expect(JSON.stringify(job?.evidence)).not.toContain('sourcePath');
        expect(JSON.stringify(job?.evidence)).not.toContain('budget-image');
        calls.length = 0;
        result = await publisher.continuePublication(
          jobId,
          input.actor,
          `continue-${invocations++}`,
        );
        checkBudget();
      }
      expect(invocations).toBe(Math.ceil((count + 2) / 20));
      expect(calls.filter((call) => call.path === 'git/refs/heads/main')).toHaveLength(1);
      expect(
        calls.filter((call) => call.path === 'git/commits' && call.method === 'POST'),
      ).toHaveLength(1);
      const tree = calls.find((call) => call.path === 'git/trees')!.body;
      expect(tree.base_tree).toBe('d'.repeat(40));
      expect(tree.tree).toHaveLength(count + 2);
      calls.length = 0;
      await expect(
        publisher.continuePublication(jobId, input.actor, 'retry-completed'),
      ).resolves.toMatchObject({ status: 'succeeded', commitSha });
      expect(calls).toHaveLength(0);
    },
  );

  it('recovers an uncertain ref response without creating another commit', async () => {
    const { publisher, draft, calls, loseNextRefResponse } = await setup();
    await publisher.preflight(preflightInput(draft, 'preflight-uncertain'));
    const input = { ...preflightInput(draft, 'publish-uncertain'), expectedBaseSha: baseSha };
    const started = await publisher.publish(input);
    for (let index = 0; index < 4; index++)
      await publisher.continuePublication(started.jobId!, input.actor, `advance-${index}`);
    loseNextRefResponse();
    await expect(
      publisher.continuePublication(started.jobId!, input.actor, 'uncertain'),
    ).rejects.toThrow('UNCERTAIN_REF_RESPONSE');
    calls.length = 0;
    await expect(publisher.publish(input)).resolves.toMatchObject({
      status: 'succeeded',
      commitSha,
    });
    expect(calls.some((call) => call.method === 'POST' || call.method === 'PATCH')).toBe(false);
  });

  it('rejects a changed or purged draft before uploading more files', async () => {
    const { publisher, repository, draft, calls, jobs } = await setup();
    await publisher.preflight(preflightInput(draft, 'preflight-drift-budget'));
    const started = await publisher.publish({
      ...preflightInput(draft, 'publish-drift-budget'),
      expectedBaseSha: baseSha,
    });
    calls.length = 0;
    const spy = vi
      .spyOn(repository, 'getDraft')
      .mockResolvedValue({ ...draft, revision: { ...draft.revision, id: crypto.randomUUID() } });
    await expect(
      publisher.continuePublication(started.jobId!, 'publisher@pointatx.org', 'drift'),
    ).rejects.toThrow('DRAFT_REVISION_DRIFT');
    expect((await jobs.getById(started.jobId!))?.status).toBe('failed');
    expect(calls).toHaveLength(0);
    spy.mockRejectedValue(new Error('NOT_FOUND'));
    await expect(
      publisher.continuePublication(started.jobId!, 'publisher@pointatx.org', 'purged'),
    ).rejects.toThrow('NOT_FOUND');
    expect(calls).toHaveLength(0);
  });

  it('allows only one active upload step for a job', async () => {
    const { publisher, draft, jobs, calls } = await setup();
    await publisher.preflight(preflightInput(draft, 'preflight-step-budget'));
    const started = await publisher.publish({
      ...preflightInput(draft, 'publish-step-budget'),
      expectedBaseSha: baseSha,
    });
    const held = await jobs.acquireStep(started.jobId!);
    calls.length = 0;
    await expect(
      publisher.continuePublication(started.jobId!, 'publisher@pointatx.org', 'parallel'),
    ).rejects.toThrow('PUBLISH_STEP_UNAVAILABLE');
    expect(calls).toHaveLength(0);
    await jobs.releaseStep(started.jobId!, held.token);
    await expect(
      publisher.continuePublication(started.jobId!, 'publisher@pointatx.org', 'released'),
    ).resolves.toMatchObject({ status: 'running', uploaded: 40 });
  });
});
