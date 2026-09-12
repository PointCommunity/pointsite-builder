// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { afterEach, expect, it } from 'vitest';
import { D1PublishJobStore } from '../../src/server/publish/jobs';

let miniflare: Miniflare;
afterEach(async () => miniflare?.dispose());

async function seedDraft(database: D1Database, candidate: Record<string, string | number>) {
  await database
    .prepare(
      "INSERT OR IGNORE INTO drafts (id,name,status,created_by,created_at,updated_at,latest_revision_id) VALUES (?,'Publish fixture','active','editor','2026-09-08','2026-09-08',?)",
    )
    .bind(candidate.draftId, candidate.revisionId)
    .run();
  await database
    .prepare(
      "INSERT OR IGNORE INTO revisions (id,draft_id,sequence,checksum,document_json,schema_version,renderer_version,created_by,created_at) VALUES (?,?,1,?,'{}',8,'8.0.0','editor','2026-09-08')",
    )
    .bind(candidate.revisionId, candidate.draftId, candidate.revisionChecksum)
    .run();
}

it('persists an auditable publish lifecycle and idempotency key', async () => {
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
  const store = new D1PublishJobStore(database);
  await seedDraft(database, {
    draftId: '10000000-0000-4000-8000-000000000001',
    revisionId: '20000000-0000-4000-8000-000000000001',
    revisionChecksum: 'd'.repeat(64),
  });
  const created = await store.create({
    idempotencyKey: 'publish-test-key-0001',
    candidateChecksum: 'a'.repeat(64),
    candidate: {
      siteId: 'pointsite',
      draftId: '10000000-0000-4000-8000-000000000001',
      revisionId: '20000000-0000-4000-8000-000000000001',
      revisionChecksum: 'd'.repeat(64),
      schemaVersion: 8,
      rendererVersion: '8.0.0',
      fileCount: 2,
    },
    baseSha: 'b'.repeat(40),
    actor: 'publisher@pointatx.org',
    requestId: 'request-1',
  });
  expect(created.status).toBe('queued');
  await store.markRunning(created.id, 'publisher@pointatx.org', 'request-1');
  await store.succeed(created.id, 'publisher@pointatx.org', 'request-1', {
    sha: 'c'.repeat(40),
    url: 'https://github.com/PointCommunity/pointsite-staging/commit/c',
  });
  expect(await store.getByKey('publish-test-key-0001')).toMatchObject({
    status: 'succeeded',
    resultSha: 'c'.repeat(40),
  });
  expect(await store.getLatestForDraft('10000000-0000-4000-8000-000000000001')).toMatchObject({
    id: created.id,
    candidateChecksum: 'a'.repeat(64),
  });
  expect(await store.getLatestReusable('a'.repeat(64), 'b'.repeat(40))).toMatchObject({
    id: created.id,
    status: 'succeeded',
  });

  const pendingEvidence = {
    candidateChecksum: 'a'.repeat(64),
    commitSha: 'c'.repeat(40),
    verificationStatus: 'pending',
  };
  await store.recordVerification(
    created.id,
    'publisher@pointatx.org',
    'request-2',
    pendingEvidence,
  );
  await store.recordVerification(
    created.id,
    'publisher@pointatx.org',
    'request-3',
    pendingEvidence,
  );
  const audits = await database
    .prepare("SELECT action FROM audit_events WHERE target_type='publish-job'")
    .all<{ action: string }>();
  expect(audits.results.map((row) => row.action)).toEqual([
    'publish.queued',
    'publish.running',
    'publish.succeeded',
    'publish.verification-recorded',
  ]);
});

it('grants one recoverable Staging lease and rejects a competing draft without leaking it', async () => {
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
  const store = new D1PublishJobStore(database);
  const candidate = (draftId: string) => ({
    siteId: 'pointsite',
    draftId,
    revisionId: crypto.randomUUID(),
    revisionChecksum: 'd'.repeat(64),
    schemaVersion: 8,
    rendererVersion: '8.0.0',
    fileCount: 2,
  });
  const firstCandidate = candidate('10000000-0000-4000-8000-000000000001');
  const secondCandidate = candidate('10000000-0000-4000-8000-000000000002');
  await seedDraft(database, firstCandidate);
  await seedDraft(database, secondCandidate);
  const first = await store.claim({
    idempotencyKey: 'publish-lease-first',
    candidateChecksum: 'a'.repeat(64),
    candidate: firstCandidate,
    baseSha: 'b'.repeat(40),
    actor: 'publisher@pointatx.org',
    requestId: 'request-first',
    now: '2026-09-08T12:00:00Z',
  });
  expect(first).toMatchObject({ status: 'running', leaseExpiresAt: '2026-09-08T12:15:00.000Z' });
  await expect(
    store.claim({
      idempotencyKey: 'publish-lease-second',
      candidateChecksum: 'e'.repeat(64),
      candidate: secondCandidate,
      baseSha: 'b'.repeat(40),
      actor: 'publisher@pointatx.org',
      requestId: 'request-second',
      now: '2026-09-08T12:01:00Z',
    }),
  ).rejects.toThrow('PUBLISH_SLOT_BUSY');
  await expect(store.availability('2026-09-08T12:01:00Z')).resolves.toEqual({
    state: 'busy',
    phase: 'running',
    retryAt: '2026-09-08T12:15:00.000Z',
  });

  const recovered = await store.claim({
    idempotencyKey: 'publish-lease-recovered',
    candidateChecksum: 'f'.repeat(64),
    candidate: secondCandidate,
    baseSha: 'b'.repeat(40),
    actor: 'publisher@pointatx.org',
    requestId: 'request-recovered',
    now: '2026-09-08T12:16:00Z',
  });
  expect(recovered).toMatchObject({ status: 'running' });
  expect(await store.getById(first.id)).toMatchObject({
    status: 'cancelled',
    leaseExpiresAt: null,
  });
  const denied = await database
    .prepare(
      "SELECT action,target_type,outcome,metadata_json FROM audit_events WHERE action IN ('publish.denied','publish.lease-recovered') ORDER BY occurred_at",
    )
    .all<{ action: string; target_type: string; outcome: string; metadata_json: string }>();
  expect(denied.results.map((row) => row.action)).toEqual([
    'publish.denied',
    'publish.lease-recovered',
  ]);
  expect(denied.results.map((row) => row.outcome)).toEqual(['denied', 'succeeded']);
  expect(
    denied.results.every(
      (row) => !row.metadata_json.includes('10000000-0000-4000-8000-000000000001'),
    ),
  ).toBe(true);

  await store.fail(
    recovered.id,
    'publisher@pointatx.org',
    'request-recovered-failure',
    'STAGING_BASE_DRIFT',
  );
  await expect(store.availability('2026-09-08T12:17:00Z')).resolves.toEqual({
    state: 'available',
  });
});

it('atomically grants exactly one lease to simultaneous competing drafts', async () => {
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
  const store = new D1PublishJobStore(database);
  for (const suffix of ['a', 'b']) {
    await seedDraft(database, {
      draftId: `10000000-0000-4000-8000-00000000000${suffix === 'a' ? '1' : '2'}`,
      revisionId: `20000000-0000-4000-8000-00000000000${suffix === 'a' ? '1' : '2'}`,
      revisionChecksum: suffix.repeat(64),
    });
  }
  const claim = (suffix: string) =>
    store.claim({
      idempotencyKey: `publish-race-${suffix}-0001`,
      candidateChecksum: suffix.repeat(64),
      candidate: {
        siteId: 'pointsite',
        draftId: `10000000-0000-4000-8000-00000000000${suffix === 'a' ? '1' : '2'}`,
        revisionId: `20000000-0000-4000-8000-00000000000${suffix === 'a' ? '1' : '2'}`,
        revisionChecksum: suffix.repeat(64),
        schemaVersion: 8,
        rendererVersion: '8.0.0',
        fileCount: 2,
      },
      baseSha: 'c'.repeat(40),
      actor: 'publisher@pointatx.org',
      requestId: `request-race-${suffix}`,
      now: '2026-09-08T12:00:00Z',
    });

  const results = await Promise.allSettled([claim('a'), claim('b')]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  expect(results.find((result) => result.status === 'rejected')?.reason).toMatchObject({
    message: 'PUBLISH_SLOT_BUSY',
  });
  const active = await database
    .prepare(
      "SELECT COUNT(*) AS count FROM publish_jobs WHERE environment='staging' AND status IN ('queued','running')",
    )
    .first<{ count: number }>();
  expect(active?.count).toBe(1);
});

it.each(['missing', 'archived', 'revision-changed'])(
  'rejects a %s draft at lease creation and retry',
  async (state) => {
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
    const store = new D1PublishJobStore(database);
    const candidate = {
      draftId: crypto.randomUUID(),
      revisionId: crypto.randomUUID(),
      revisionChecksum: 'a'.repeat(64),
    };
    await seedDraft(database, candidate);
    const input = {
      idempotencyKey: 'publish-owner-guard-0001',
      candidateChecksum: 'b'.repeat(64),
      candidate,
      baseSha: 'c'.repeat(40),
      actor: 'editor',
      requestId: 'request-guard',
    };
    const failed = await store.claim(input);
    await store.fail(failed.id, input.actor, input.requestId, 'TEST_FAILURE');
    if (state === 'missing') {
      await database
        .prepare('DELETE FROM revisions WHERE draft_id=?')
        .bind(candidate.draftId)
        .run();
      await database.prepare('DELETE FROM drafts WHERE id=?').bind(candidate.draftId).run();
    } else if (state === 'archived') {
      await database
        .prepare("UPDATE drafts SET status='archived' WHERE id=?")
        .bind(candidate.draftId)
        .run();
    } else {
      await database
        .prepare('UPDATE drafts SET latest_revision_id=NULL WHERE id=?')
        .bind(candidate.draftId)
        .run();
    }
    await expect(store.claim(input)).rejects.toThrow();
    await expect(
      store.create({ ...input, idempotencyKey: 'publish-owner-guard-0002' }),
    ).rejects.toThrow();
    expect(await store.getByKey('publish-owner-guard-0002')).toBeNull();
    expect((await store.getById(failed.id))?.status).toBe('failed');
  },
);
