// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { D1PrivateBucket, D1MediaRepository, MediaService } from '../../src/server/media/service';

let miniflare: Miniflare;
function png() {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 120);
  view.setUint32(20, 90);
  return bytes;
}

async function fixture() {
  miniflare = new Miniflare({
    compatibilityDate: '2026-09-05',
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    d1Databases: { DB: crypto.randomUUID() },
  });
  const database = await miniflare.getD1Database('DB');
  for (const migration of [
    'migrations/0001_initial.sql',
    'migrations/0002_integrity_triggers.sql',
    'migrations/0003_revision_labels.sql',
    'migrations/0006_free_only_auth_media.sql',
  ])
    await database.exec((await readFile(migration, 'utf8')).replace(/\s+/g, ' ').trim());
  return { database, repository: new D1MediaRepository(database) };
}
afterEach(async () => miniflare?.dispose());

it('persists, reads, audits, orphans, and removes private media bytes in chunked D1 storage', async () => {
  const { database, repository } = await fixture();
  const bucket = new D1PrivateBucket(database);
  const service = new MediaService(repository, bucket);
  const record = await service.upload({
    filename: 'point.png',
    contentType: 'image/png',
    bytes: png(),
    altText: 'Point gathering',
    actor: 'editor@pointatx.org',
    requestId: 'media-d1-1',
  });
  expect(await repository.list()).toHaveLength(1);
  expect((await repository.get(record.id))?.altText).toBe('Point gathering');
  expect((await repository.findDuplicate(record.checksum, record.byteSize))?.id).toBe(record.id);
  expect((await service.read(record.id)).bytes).toEqual(png());
  expect(
    await database
      .prepare('SELECT COUNT(*) AS count FROM media_object_chunks WHERE object_key=?')
      .bind(record.objectKey)
      .first<{ count: number }>(),
  ).toEqual({ count: 1 });
  expect(
    await repository.markOrphaned(new Set(), '9999-01-01T00:00:00.000Z', 'system', 'media-d1-2'),
  ).toBe(1);
  expect((await repository.get(record.id))?.status).toBe('orphaned');
  expect(
    await repository.deleteOrphans('9999-01-01T00:00:00.000Z', 'system', 'media-d1-3'),
  ).toHaveLength(1);
  await bucket.delete(record.objectKey);
  expect(await repository.get(record.id)).toBeNull();
  expect(await bucket.get(record.objectKey)).toBeNull();
  const audit = await database
    .prepare("SELECT action FROM audit_events WHERE target_type='media' ORDER BY occurred_at")
    .all<{ action: string }>();
  expect(audit.results.map((item) => item.action)).toEqual([
    'media.upload',
    'media.orphan',
    'media.delete',
  ]);
});

it('chunks objects larger than a D1 row and reconstructs the exact bytes', async () => {
  const { database } = await fixture();
  const bucket = new D1PrivateBucket(database);
  const bytes = new Uint8Array(1_000_001).fill(7);
  await bucket.put('draft/large.webp', bytes);
  const rows = await database
    .prepare(
      'SELECT chunk_index, byte_size FROM media_object_chunks WHERE object_key=? ORDER BY chunk_index',
    )
    .bind('draft/large.webp')
    .all<{ chunk_index: number; byte_size: number }>();
  expect(rows.results).toHaveLength(2);
  expect(await bucket.get('draft/large.webp')).toEqual(bytes);
}, 15_000);

it('enforces the 250 MiB media cap inside D1 under concurrent application checks', async () => {
  const { database } = await fixture();
  for (let index = 0; index < 50; index++) {
    await database
      .prepare(
        "INSERT INTO media_assets (id,object_key,filename,content_type,byte_size,width,height,checksum,alt_text,status,created_by,created_at,last_referenced_at) VALUES (?,?,?,?,5242880,1,1,?,'Alt','ready','test','2026-09-05',NULL)",
      )
      .bind(
        `media-${index}`,
        `draft/${index}.png`,
        `${index}.png`,
        'image/png',
        index.toString(16).padStart(64, '0'),
      )
      .run();
  }
  await expect(
    database
      .prepare(
        "INSERT INTO media_assets (id,object_key,filename,content_type,byte_size,width,height,checksum,alt_text,status,created_by,created_at,last_referenced_at) VALUES ('overflow','draft/overflow.png','overflow.png','image/png',1,1,1,?,'Alt','ready','test','2026-09-05',NULL)",
      )
      .bind('f'.repeat(64))
      .run(),
  ).rejects.toThrow(/media capacity/i);
});
