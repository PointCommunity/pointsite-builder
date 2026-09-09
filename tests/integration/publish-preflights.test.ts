// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { afterEach, expect, it } from 'vitest';
import { D1PublishPreflightStore } from '../../src/server/publish/preflights';

let miniflare: Miniflare;
afterEach(async () => miniflare?.dispose());

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
  await database
    .prepare(
      "INSERT INTO drafts (id,site_id,name,status,created_by,created_at,updated_at) VALUES (?,'pointsite','A','active','actor',?,?)",
    )
    .bind('10000000-0000-4000-8000-000000000001', '2026-09-08T12:00:00Z', '2026-09-08T12:00:00Z')
    .run();
  await database
    .prepare(
      'INSERT INTO revisions (id,draft_id,sequence,parent_revision_id,label,checksum,document_json,schema_version,renderer_version,created_by,created_at) VALUES (?,?,1,NULL,NULL,?,?,?,?,?,?)',
    )
    .bind(
      '20000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000001',
      'a'.repeat(64),
      '{}',
      8,
      '8.0.0',
      'actor',
      '2026-09-08T12:00:00Z',
    )
    .run();
  return { database, store: new D1PublishPreflightStore(database) };
}

it('retains exact passed and failed preflight attempts without draft content', async () => {
  const { database, store } = await setup();
  const passed = await store.recordPassed({
    idempotencyKey: 'preflight-pass-0001',
    draftId: '10000000-0000-4000-8000-000000000001',
    revisionId: '20000000-0000-4000-8000-000000000001',
    revisionChecksum: 'a'.repeat(64),
    candidateChecksum: 'b'.repeat(64),
    schemaVersion: 8,
    rendererVersion: '8.0.0',
    rendererContractChecksum: 'c'.repeat(64),
    validatedBaseSha: 'd'.repeat(40),
    fileCount: 2,
    actor: 'publisher@pointatx.org',
    requestId: 'request-pass',
    now: '2026-09-08T12:01:00Z',
  });
  expect(passed).toMatchObject({ status: 'passed', candidateChecksum: 'b'.repeat(64) });
  await expect(
    store.recordPassed({
      idempotencyKey: 'preflight-pass-0001',
      draftId: passed.draftId,
      revisionId: passed.revisionId,
      revisionChecksum: passed.revisionChecksum,
      candidateChecksum: 'f'.repeat(64),
      schemaVersion: 8,
      rendererVersion: '8.0.0',
      rendererContractChecksum: passed.rendererContractChecksum,
      validatedBaseSha: 'd'.repeat(40),
      fileCount: 2,
      actor: 'publisher@pointatx.org',
      requestId: 'request-conflict',
    }),
  ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
  expect(
    await store.getLatestCurrent(
      passed.draftId,
      passed.revisionId,
      passed.revisionChecksum,
      passed.rendererContractChecksum,
    ),
  ).toMatchObject({ id: passed.id, status: 'passed' });

  await store.recordFailed({
    idempotencyKey: 'preflight-fail-0001',
    draftId: passed.draftId,
    revisionId: passed.revisionId,
    revisionChecksum: passed.revisionChecksum,
    rendererContractChecksum: passed.rendererContractChecksum,
    failureCode: 'STAGING_RENDERER_MISMATCH',
    actor: 'publisher@pointatx.org',
    requestId: 'request-fail',
    now: '2026-09-08T12:02:00Z',
  });
  expect(
    await store.getLatestCurrent(
      passed.draftId,
      passed.revisionId,
      passed.revisionChecksum,
      passed.rendererContractChecksum,
    ),
  ).toBeNull();
  const rows = await database
    .prepare('SELECT status,failure_code FROM publish_preflights ORDER BY completed_at')
    .all();
  expect(rows.results).toEqual([
    { status: 'passed', failure_code: null },
    { status: 'failed', failure_code: 'STAGING_RENDERER_MISMATCH' },
  ]);
  const audits = await database
    .prepare(
      "SELECT action,outcome,metadata_json FROM audit_events WHERE target_type='publish-preflight' ORDER BY occurred_at",
    )
    .all<{ action: string; outcome: string; metadata_json: string }>();
  expect(audits.results.map((row) => row.action)).toEqual([
    'publish.preflight-passed',
    'publish.preflight-failed',
  ]);
  expect(audits.results.map((row) => row.outcome)).toEqual(['succeeded', 'failed']);
  expect(audits.results.every((row) => !row.metadata_json.includes('document'))).toBe(true);
});

it('deduplicates simultaneous exact preflight retries', async () => {
  const { database, store } = await setup();
  const input = {
    idempotencyKey: 'preflight-race-0001',
    draftId: '10000000-0000-4000-8000-000000000001',
    revisionId: '20000000-0000-4000-8000-000000000001',
    revisionChecksum: 'a'.repeat(64),
    candidateChecksum: 'b'.repeat(64),
    schemaVersion: 8,
    rendererVersion: '8.0.0',
    rendererContractChecksum: 'c'.repeat(64),
    validatedBaseSha: 'd'.repeat(40),
    fileCount: 2,
    actor: 'publisher@pointatx.org',
    requestId: 'request-race',
    now: '2026-09-08T12:01:00Z',
  };

  const [first, second] = await Promise.all([store.recordPassed(input), store.recordPassed(input)]);
  expect(second).toEqual(first);
  const count = await database
    .prepare('SELECT COUNT(*) AS count FROM publish_preflights WHERE idempotency_key=?')
    .bind(input.idempotencyKey)
    .first<{ count: number }>();
  expect(count?.count).toBe(1);
});
