// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { afterEach, expect, it } from 'vitest';
import { D1PublishJobStore } from '../../src/server/publish/jobs';

let miniflare: Miniflare;
afterEach(async () => miniflare?.dispose());

it('persists an auditable publish lifecycle and idempotency key', async () => {
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
  const store = new D1PublishJobStore(database);
  const created = await store.create({
    idempotencyKey: 'publish-test-key-0001',
    candidateChecksum: 'a'.repeat(64),
    candidate: { draftId: 'draft' },
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
  const audits = await database
    .prepare("SELECT action FROM audit_events WHERE target_type='publish-job'")
    .all<{ action: string }>();
  expect(audits.results.map((row) => row.action)).toEqual([
    'publish.queued',
    'publish.running',
    'publish.succeeded',
  ]);
});
