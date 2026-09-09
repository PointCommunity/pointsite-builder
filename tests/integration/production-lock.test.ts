// @vitest-environment node
import { createApp } from '../../src/server';
import type { D1ApprovalService } from '../../src/server/approvals/service';
import type { StagingPublisher } from '../../src/server/publish/service';
import { InMemoryRepository } from '../../src/server/repositories/memory';

it('keeps production publishing hard disabled without invoking a publisher', async () => {
  const app = createApp({
    repository: new InMemoryRepository(),
    authenticate: () => Promise.resolve({ email: 'admin@pointatx.org', role: 'administrator' }),
    environment: 'test',
    version: 'test',
  });
  const response = await app.request('https://builder.pointatx.org/api/publish/production', {
    method: 'POST',
    headers: {
      origin: 'https://builder.pointatx.org',
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
      'idempotency-key': 'production-locked',
    },
    body: '{}',
  });
  expect(response.status).toBe(403);
  await expect(response.json()).resolves.toMatchObject({ code: 'PRODUCTION_DISABLED' });
});

it('restores a sanitized workflow and rejects acceptance after Staging drift', async () => {
  const stagingCommitSha = 'd'.repeat(40);
  let acceptanceCalls = 0;
  const publisher = {
    currentBaseSha: () => Promise.resolve('f'.repeat(40)),
    workflowForDraft: () =>
      Promise.resolve({
        currentStagingSha: stagingCommitSha,
        reviewUrl: 'https://staging.pointatx.org',
        preflight: {
          state: 'passed',
          revisionId: '20000000-0000-4000-8000-000000000001',
          revisionChecksum: 'a'.repeat(64),
          candidateChecksum: 'b'.repeat(64),
          validatedAt: '2026-09-07T11:59:00Z',
        },
        availability: { state: 'available' },
        job: {
          id: '30000000-0000-4000-8000-000000000001',
          status: 'succeeded',
          candidateChecksum: 'b'.repeat(64),
          draftId: '10000000-0000-4000-8000-000000000001',
          revisionId: '20000000-0000-4000-8000-000000000001',
          revisionChecksum: 'a'.repeat(64),
          schemaVersion: 8,
          rendererVersion: '8.0.0',
          stagingBaseSha: 'c'.repeat(40),
          stagingCommitSha,
          commitUrl: `https://github.com/PointCommunity/pointsite-staging/commit/${stagingCommitSha}`,
          requestedAt: '2026-09-07T12:00:00Z',
          completedAt: '2026-09-07T12:01:00Z',
          evidence: { verificationStatus: 'passed' },
        },
      }),
  } as unknown as StagingPublisher;
  const approvals = {
    getLatestForJob: () =>
      Promise.resolve({
        id: '40000000-0000-4000-8000-000000000001',
        publishJobId: '30000000-0000-4000-8000-000000000001',
        decision: 'approved',
        createdAt: '2026-09-07T12:02:00Z',
      }),
    record: () => {
      acceptanceCalls += 1;
      throw new Error('must not be called');
    },
  } as unknown as D1ApprovalService;
  const app = createApp({
    repository: new InMemoryRepository(),
    authenticate: () =>
      Promise.resolve({
        email: 'publisher@pointatx.org',
        role: 'publisher',
        repositoryPermission: 'write',
      }),
    environment: 'test',
    version: 'test',
    publisher,
    approvals,
  });

  const workflow = await app.request(
    'https://builder.pointatx.org/api/publish/staging/workflow?draftId=10000000-0000-4000-8000-000000000001',
  );
  expect(workflow.status).toBe(200);
  const restored = await workflow.json<Record<string, unknown>>();
  expect(restored).toMatchObject({
    currentStagingSha: stagingCommitSha,
    reviewUrl: 'https://staging.pointatx.org',
    approval: {
      id: '40000000-0000-4000-8000-000000000001',
      decision: 'approved',
    },
  });
  expect(JSON.stringify(restored)).not.toContain('idempotencyKey');

  const acceptance = await app.request('https://builder.pointatx.org/api/approvals', {
    method: 'POST',
    headers: {
      origin: 'https://builder.pointatx.org',
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
      'idempotency-key': 'approval-drift-test-0001',
    },
    body: JSON.stringify({
      publishJobId: '30000000-0000-4000-8000-000000000001',
      decision: 'approved',
      expectedTuple: {
        siteId: 'pointsite',
        revisionId: '20000000-0000-4000-8000-000000000001',
        revisionChecksum: 'a'.repeat(64),
        schemaVersion: 8,
        rendererVersion: '8.0.0',
        candidateChecksum: 'b'.repeat(64),
        stagingBaseSha: 'c'.repeat(40),
        stagingCommitSha,
        productionBaseSha: 'e'.repeat(40),
      },
    }),
  });
  expect(acceptance.status).toBe(409);
  await expect(acceptance.json()).resolves.toMatchObject({ code: 'STAGING_CANDIDATE_DRIFT' });
  expect(acceptanceCalls).toBe(0);
});

it('allows a read collaborator to author drafts while denying every staging publish operation', async () => {
  const repository = new InMemoryRepository();
  const app = createApp({
    repository,
    authenticate: () =>
      Promise.resolve({
        email: 'github:22',
        role: 'publisher',
        repositoryPermission: 'read',
      }),
    environment: 'test',
    version: 'test',
    publisher: {} as never,
  });
  const mutationHeaders = {
    origin: 'https://builder.pointatx.org',
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json',
    'idempotency-key': crypto.randomUUID(),
  };

  const draft = await app.request('https://builder.pointatx.org/api/drafts', {
    method: 'POST',
    headers: mutationHeaders,
    body: JSON.stringify({ name: 'Read collaborator draft' }),
  });
  expect(draft.status).toBe(201);

  const base = await app.request('https://builder.pointatx.org/api/publish/staging/base');
  expect(base.status).toBe(403);
  await expect(base.json()).resolves.toMatchObject({ code: 'FORBIDDEN' });

  const workflow = await app.request(
    'https://builder.pointatx.org/api/publish/staging/workflow?draftId=10000000-0000-4000-8000-000000000001',
  );
  expect(workflow.status).toBe(403);
  await expect(workflow.json()).resolves.toMatchObject({ code: 'FORBIDDEN' });

  const preflight = await app.request(
    'https://builder.pointatx.org/api/publish/staging/preflight',
    {
      method: 'POST',
      headers: { ...mutationHeaders, 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({
        draftId: '10000000-0000-4000-8000-000000000001',
        expectedRevisionId: '20000000-0000-4000-8000-000000000001',
        expectedRevisionChecksum: 'b'.repeat(64),
      }),
    },
  );
  expect(preflight.status).toBe(403);
  await expect(preflight.json()).resolves.toMatchObject({ code: 'FORBIDDEN' });

  const publish = await app.request('https://builder.pointatx.org/api/publish/staging', {
    method: 'POST',
    headers: { ...mutationHeaders, 'idempotency-key': crypto.randomUUID() },
    body: JSON.stringify({
      draftId: '10000000-0000-4000-8000-000000000001',
      expectedRevisionId: '20000000-0000-4000-8000-000000000001',
      expectedRevisionChecksum: 'b'.repeat(64),
      expectedBaseSha: 'a'.repeat(40),
    }),
  });
  expect(publish.status).toBe(403);
  await expect(publish.json()).resolves.toMatchObject({ code: 'FORBIDDEN' });
});
