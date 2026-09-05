// @vitest-environment node
/* eslint-disable @typescript-eslint/require-await -- in-memory bucket mirrors the async R2 interface */
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import {
  D1MediaRepository,
  MediaService,
  type PrivateBucket,
} from '../../src/server/media/service';

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
  ])
    await database.exec((await readFile(migration, 'utf8')).replace(/\s+/g, ' ').trim());
  return { database, repository: new D1MediaRepository(database) };
}
afterEach(async () => miniflare?.dispose());

it('persists, audits, orphans, and removes private media metadata in D1', async () => {
  const { database, repository } = await fixture();
  const objects = new Map<string, Uint8Array>();
  const bucket: PrivateBucket = {
    put: async (key, bytes) => {
      objects.set(key, bytes);
    },
    get: async (key) => objects.get(key) ?? null,
    delete: async (key) => {
      objects.delete(key);
    },
  };
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
  expect(
    await repository.markOrphaned(new Set(), '9999-01-01T00:00:00.000Z', 'system', 'media-d1-2'),
  ).toBe(1);
  expect((await repository.get(record.id))?.status).toBe('orphaned');
  expect(
    await repository.deleteOrphans('9999-01-01T00:00:00.000Z', 'system', 'media-d1-3'),
  ).toHaveLength(1);
  expect(await repository.get(record.id)).toBeNull();
  const audit = await database
    .prepare("SELECT action FROM audit_events WHERE target_type='media' ORDER BY occurred_at")
    .all<{ action: string }>();
  expect(audit.results.map((item) => item.action)).toEqual([
    'media.upload',
    'media.orphan',
    'media.delete',
  ]);
});
