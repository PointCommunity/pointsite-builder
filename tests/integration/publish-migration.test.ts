// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { afterEach, expect, it } from 'vitest';

let miniflare: Miniflare;
afterEach(async () => miniflare?.dispose());

it('migrates existing publication history and bounds the one active Staging job', async () => {
  miniflare = new Miniflare({
    compatibilityDate: '2026-09-05',
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { DB: crypto.randomUUID() },
  });
  const database = await miniflare.getD1Database('DB');
  for (const migration of [
    'migrations/0001_initial.sql',
    'migrations/0002_integrity_triggers.sql',
    'migrations/0003_revision_labels.sql',
    'migrations/0004_exact_approvals.sql',
    'migrations/0005_revision_retention.sql',
    'migrations/0006_free_only_auth_media.sql',
    'migrations/0007_media_metadata.sql',
    'migrations/0008_revision_actions.sql',
    'migrations/0009_draft_checkouts.sql',
  ]) {
    await database.exec((await readFile(migration, 'utf8')).replace(/\s+/g, ' ').trim());
  }
  const candidate = (draftId: string) =>
    JSON.stringify({
      siteId: 'pointsite',
      draftId,
      revisionId: crypto.randomUUID(),
      revisionChecksum: 'a'.repeat(64),
      schemaVersion: 8,
      rendererVersion: '8.0.0',
    });
  const insertJob = async (
    id: string,
    status: 'queued' | 'running' | 'succeeded',
    minute: string,
  ) =>
    database
      .prepare(
        "INSERT INTO publish_jobs (id,idempotency_key,environment,status,candidate_json,candidate_checksum,repository,base_sha,result_sha,external_url,requested_by,requested_at,completed_at) VALUES (?,?,'staging',?,? ,?,'PointCommunity/pointsite-staging',?,?,?,?,?,?)",
      )
      .bind(
        id,
        `migration-${id}`,
        status,
        candidate(id),
        'b'.repeat(64),
        'c'.repeat(40),
        status === 'succeeded' ? 'd'.repeat(40) : null,
        status === 'succeeded' ? 'https://github.com/PointCommunity/pointsite-staging' : null,
        'publisher@pointatx.org',
        `2026-09-08T12:${minute}:00Z`,
        status === 'succeeded' ? `2026-09-08T12:${minute}:30Z` : null,
      )
      .run();
  await insertJob('historical', 'succeeded', '00');
  await insertJob('active', 'running', '01');
  await insertJob('queued', 'queued', '02');

  await database.exec(
    (await readFile('migrations/0010_publish_preflight_leases.sql', 'utf8'))
      .replace(/\s+/g, ' ')
      .trim(),
  );

  const rows = await database
    .prepare(
      'SELECT id,status,result_sha,completed_at,lease_expires_at FROM publish_jobs ORDER BY requested_at',
    )
    .all();
  expect(rows.results).toEqual([
    {
      id: 'historical',
      status: 'succeeded',
      result_sha: 'd'.repeat(40),
      completed_at: '2026-09-08T12:00:30Z',
      lease_expires_at: null,
    },
    {
      id: 'active',
      status: 'running',
      result_sha: null,
      completed_at: null,
      lease_expires_at: '2026-09-08T12:16:00.000Z',
    },
    {
      id: 'queued',
      status: 'cancelled',
      result_sha: null,
      completed_at: '2026-09-08T12:02:00Z',
      lease_expires_at: null,
    },
  ]);
  await expect(
    database
      .prepare(
        "INSERT INTO publish_jobs (id,idempotency_key,environment,status,candidate_json,candidate_checksum,repository,base_sha,requested_by,requested_at,lease_expires_at) VALUES ('competing','migration-competing','staging','queued',? ,?,'PointCommunity/pointsite-staging',?,'publisher@pointatx.org','2026-09-08T12:03:00Z','2026-09-08T12:18:00Z')",
      )
      .bind(candidate('competing'), 'e'.repeat(64), 'f'.repeat(40))
      .run(),
  ).rejects.toThrow();
});
