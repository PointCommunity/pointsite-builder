// @vitest-environment node
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { afterEach, expect, it } from 'vitest';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import { checksumDocument } from '../../src/site-kit/canonicalize';
import { D1DraftRepository } from '../../src/server/repositories/d1';
import { D1MediaRepository, D1PrivateBucket, MediaService } from '../../src/server/media/service';
import { D1OwnershipMigration } from '../../src/server/maintenance/asset-migration';
import { D1DraftAssets } from '../../src/server/media/draft-assets';
import { RetentionService } from '../../src/server/maintenance/retention';
import { createApp } from '../../src/server/index';
import type { Actor } from '../../src/server/auth/roles';

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
  for (const file of (await readdir('migrations'))
    .filter((name) => name.endsWith('.sql') && name < '0013')
    .sort()) {
    await database.exec((await readFile(`migrations/${file}`, 'utf8')).replace(/\s+/g, ' ').trim());
  }
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  new DataView(bytes.buffer).setUint32(16, 1);
  new DataView(bytes.buffer).setUint32(20, 1);
  const media = new MediaService(new D1MediaRepository(database), new D1PrivateBucket(database));
  const first = await media.upload({
    filename: 'legacy.png',
    contentType: 'image/png',
    bytes,
    altText: 'Legacy image',
    actor: 'editor',
    requestId: 'upload-first',
  });
  const orphanBytes = bytes.slice();
  orphanBytes[8] = 1;
  const orphan = await media.upload({
    filename: 'unassigned.png',
    contentType: 'image/png',
    bytes: orphanBytes,
    altText: 'Unassigned upload',
    actor: 'editor',
    requestId: 'upload-orphan',
  });
  const historicalBytes = bytes.slice();
  historicalBytes[8] = 2;
  const historical = await media.upload({
    filename: 'current.png',
    contentType: 'image/png',
    bytes: historicalBytes,
    altText: 'Current image',
    actor: 'editor',
    requestId: 'upload-current',
  });
  const document = structuredClone(defaultSiteDocument);
  for (const item of document.media) item.sourcePath = `/assets/builder/${first.id}.png`;
  const repository = new D1DraftRepository(database);
  const drafts = [];
  for (const name of ['First draft', 'Second draft'])
    drafts.push(
      await repository.createDraft({
        name,
        document,
        actor: 'editor',
        idempotencyKey: `create-migration-${name}`,
        requestId: 'create',
      }),
    );
  const updated = structuredClone(document);
  for (const item of updated.media) item.sourcePath = `/assets/builder/${historical.id}.png`;
  const nextRevisionId = crypto.randomUUID();
  await database
    .prepare(
      'INSERT INTO revisions(id,draft_id,sequence,parent_revision_id,checksum,document_json,schema_version,renderer_version,created_by,created_at) VALUES (?,?,2,?,?,?,?,?,?,?)',
    )
    .bind(
      nextRevisionId,
      drafts[0].id,
      drafts[0].revision.id,
      await checksumDocument(updated),
      JSON.stringify(updated),
      updated.schemaVersion,
      updated.rendererVersion,
      'editor',
      new Date().toISOString(),
    )
    .run();
  await database
    .prepare("UPDATE drafts SET latest_revision_id=?,status='archived' WHERE id=?")
    .bind(nextRevisionId, drafts[0].id)
    .run();
  drafts[0] = await repository.getDraft(drafts[0].id);
  await new D1PrivateBucket(database).put('draft/unregistered.png', bytes);
  await database
    .prepare(
      "INSERT INTO audit_events(id,occurred_at,actor,action,target_type,target_id,outcome,request_id,metadata_json) VALUES (?,'2026-09-12','editor','media.upload','media',?,'succeeded','legacy-upload',?)",
    )
    .bind(
      crypto.randomUUID(),
      first.id,
      JSON.stringify({ filename: 'legacy.png', description: 'Legacy private metadata' }),
    )
    .run();
  await database.exec(
    (await readFile('migrations/0013_asset_migration.sql', 'utf8')).replace(/\s+/g, ' ').trim(),
  );
  return {
    database,
    repository,
    drafts,
    first,
    orphan,
    migration: new D1OwnershipMigration(database),
  };
}

it('resumes verified ownership conversion, recovers unassigned uploads, then removes all shared bytes', async () => {
  const { database, repository, drafts, migration } = await setup();
  await expect(
    database
      .prepare("UPDATE audit_events SET metadata_json='{}' WHERE request_id='legacy-upload'")
      .run(),
  ).rejects.toThrow('audit events are immutable');
  const retention = new RetentionService(database, new D1PrivateBucket(database));
  const plan = await retention.plan();
  await expect(
    retention.apply(plan, plan.exportChecksum, 'administrator', 'retention-race'),
  ).rejects.toThrow('ASSET_MIGRATION_INCOMPLETE');
  await expect(
    database
      .prepare("UPDATE drafts SET status='deleted',deleted_at='2026-09-12' WHERE id=?")
      .bind(drafts[0].id)
      .run(),
  ).rejects.toThrow('draft asset migration incomplete');
  expect((await migration.status()).state).toBe('pending');
  await migration.step('administrator', 'first-step');
  const resumed = new D1OwnershipMigration(database);
  for (let step = 0; step < 12 && (await resumed.status()).state !== 'complete'; step++)
    await resumed.step('administrator', `resume-${step}`);
  expect((await resumed.status()).state).toBe('complete');
  await expect(
    database
      .prepare("UPDATE audit_events SET actor='changed' WHERE request_id='legacy-upload'")
      .run(),
  ).rejects.toThrow('audit events are immutable');
  expect(await database.prepare('SELECT COUNT(*) FROM media_assets').first('COUNT(*)')).toBe(0);
  expect(
    await database
      .prepare(
        "SELECT COUNT(*) FROM audit_events WHERE target_type='media' AND metadata_json!='{}'",
      )
      .first('COUNT(*)'),
  ).toBe(0);
  expect(await database.prepare('SELECT COUNT(*) FROM media_object_chunks').first('COUNT(*)')).toBe(
    0,
  );
  for (const draft of drafts)
    expect((await repository.getDraft(draft.id)).revision).toEqual(draft.revision);
  expect(
    await database
      .prepare('SELECT COUNT(*) FROM draft_asset_versions WHERE draft_id=?')
      .bind(drafts[0].id)
      .first('COUNT(*)'),
  ).toBe(2);
  expect((await repository.getDraft(drafts[0].id)).status).toBe('archived');
  const recovery = await database
    .prepare(
      "SELECT id FROM drafts WHERE name LIKE 'Recovered legacy uploads%' AND status='archived'",
    )
    .first<{ id: string }>();
  expect(recovery).not.toBeNull();
  expect((await repository.getDraft(recovery!.id)).document.media).toHaveLength(2);
  await expect(resumed.step('administrator', 'safe-repeat')).resolves.toMatchObject({
    state: 'complete',
  });
});

it('keeps completed migration status clear after creating a new independent draft', async () => {
  const { database, drafts, migration } = await setup();
  for (let step = 0; step < 12 && (await migration.status()).state !== 'complete'; step++) {
    await migration.step('administrator', `complete-${step}`);
  }
  const assets = new D1DraftAssets(database, {
    read: () => Promise.reject(new Error('Shared storage is retired')),
  });
  const repository = new D1DraftRepository(database, assets);
  const created = await repository.createDraft({
    name: 'After migration',
    document: drafts[0].document,
    sourceDraftId: drafts[0].id,
    actor: 'editor',
    idempotencyKey: 'post-migration-draft-0001',
    requestId: 'post-migration-create',
  });
  expect(
    await database
      .prepare('SELECT COUNT(*) FROM draft_asset_versions WHERE draft_id=?')
      .bind(created.id)
      .first('COUNT(*)'),
  ).toBeGreaterThan(0);
  expect(
    await database
      .prepare('SELECT COUNT(*) FROM draft_asset_migration_verified WHERE draft_id=?')
      .bind(created.id)
      .first('COUNT(*)'),
  ).toBe(0);
  await expect(migration.status()).resolves.toMatchObject({
    state: 'complete',
    remainingDrafts: 0,
    legacyAssets: 0,
    legacyBytes: 0,
  });
});

it('fails closed on corrupt legacy bytes and retains original storage', async () => {
  const { database, first, migration } = await setup();
  await database.exec('DROP TRIGGER legacy_chunks_no_update');
  await database
    .prepare('UPDATE media_object_chunks SET bytes=zeroblob(byte_size) WHERE object_key=?')
    .bind(first.objectKey)
    .run();
  await expect(migration.step('administrator', 'corrupt-source')).rejects.toThrow(
    'MEDIA_STORAGE_CORRUPT',
  );
  expect((await migration.status()).state).toBe('pending');
  expect(await database.prepare('SELECT COUNT(*) FROM media_assets').first('COUNT(*)')).toBe(3);
});

it('exposes read-only counts to administrators and provides no worker mutation route', async () => {
  const { repository, migration } = await setup();
  const actor: Actor = { email: 'administrator', role: 'viewer' };
  const app = createApp({
    repository,
    authenticate: () => Promise.resolve(actor),
    environment: 'test',
    version: 'test',
    ownershipMigration: migration,
  });
  expect((await app.request('https://builder.test/api/admin/asset-migration')).status).toBe(403);
  actor.role = 'administrator';
  const response = await app.request('https://builder.test/api/admin/asset-migration');
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).toContain('remainingDrafts');
  expect(body).not.toContain('sourcePath');
  expect(body).not.toContain('document');
  expect(
    (
      await app.request('https://builder.test/api/admin/asset-migration/step', {
        method: 'POST',
        body: '{}',
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await app.request('https://builder.test/api/admin/asset-migration/step', {
        method: 'POST',
        headers: {
          origin: 'https://builder.test',
          'sec-fetch-site': 'same-origin',
          'content-type': 'application/json',
          'idempotency-key': 'migration-test-step-0001',
        },
        body: '{}',
      })
    ).status,
  ).toBe(404);
});
