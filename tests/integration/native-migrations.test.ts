// @vitest-environment node
import { mkdtemp, rm, writeFile, copyFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { SqliteDatabase } from '../../server/sqlite';
import { migrateDatabase } from '../../server/migrations';
import { D1DraftRepository } from '../../src/server/repositories/d1';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import { checksumDocument } from '../../src/site-kit/canonicalize';

const databases: SqliteDatabase[] = [];
const directories: string[] = [];
const open = () => {
  const db = new SqliteDatabase(':memory:');
  databases.push(db);
  return db;
};
afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  for (const path of directories.splice(0)) await rm(path, { recursive: true });
});

test('every real workspace and recovery migration applies natively and repeats without changes', async () => {
  for (const [directory, expected] of [
    ['migrations', 37],
    ['recovery-migrations', 7],
  ] as const) {
    const db = open();
    expect(await migrateDatabase(db, directory)).toHaveLength(expected);
    expect(await migrateDatabase(db, directory)).toEqual([]);
    expect(await db.prepare('PRAGMA integrity_check').first('integrity_check')).toBe('ok');
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    expect(await db.prepare('PRAGMA foreign_keys').first('foreign_keys')).toBe(1);
  }
});

test('failed migration rolls back its schema and receipt; changed or unknown migrations refuse startup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'builder-native-migrations-'));
  directories.push(directory);
  const path = join(directory, '0001_fixture.sql');
  const db = open();
  await writeFile(path, 'CREATE TABLE fixture(id INTEGER); INSERT INTO missing VALUES (1);');
  await expect(migrateDatabase(db, directory)).rejects.toThrow();
  expect(
    await db.prepare("SELECT name FROM sqlite_master WHERE name='fixture'").first(),
  ).toBeNull();
  await writeFile(path, 'CREATE TABLE fixture(id INTEGER);');
  expect(await migrateDatabase(db, directory)).toEqual(['0001_fixture.sql']);
  await writeFile(path, 'CREATE TABLE fixture(id TEXT);');
  await expect(migrateDatabase(db, directory)).rejects.toThrow(/MIGRATION_CHANGED/);
  await rm(path);
  await expect(migrateDatabase(db, directory)).rejects.toThrow(/MIGRATION_UNKNOWN/);
  expect(await db.prepare('PRAGMA foreign_keys').first('foreign_keys')).toBe(1);
});

test('upgrades existing drafts without guessing unproven lineage or changing history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'builder-57-upgrade-'));
  directories.push(directory);
  for (const name of (await readdir('migrations')).filter(
    (value) => value.endsWith('.sql') && value < '0037',
  ))
    await copyFile(join('migrations', name), join(directory, name));
  const db = open();
  expect(await migrateDatabase(db, directory)).toHaveLength(36);
  const document = JSON.stringify(defaultSiteDocument);
  const checksum = await checksumDocument(defaultSiteDocument);
  const ids = [crypto.randomUUID(), crypto.randomUUID()];
  for (const [index, id] of ids.entries()) {
    const revisionId = crypto.randomUUID();
    await db
      .prepare(
        "INSERT INTO drafts(id,site_id,name,status,latest_revision_id,created_by,created_at,updated_at) VALUES (?,'pointsite',?,'active',?,?,'fixture','fixture')",
      )
      .bind(id, `Season ${index + 1}`, revisionId, 'github:12345')
      .run();
    await db
      .prepare(
        "INSERT INTO revisions(id,draft_id,sequence,checksum,document_json,schema_version,renderer_version,created_by,created_at) VALUES (?,?,1,?,?,?,?,?,'fixture')",
      )
      .bind(
        revisionId,
        id,
        checksum,
        document,
        defaultSiteDocument.schemaVersion,
        defaultSiteDocument.rendererVersion,
        'github:12345',
      )
      .run();
  }
  await db
    .prepare('INSERT INTO draft_production_sources(draft_id,provenance_json) VALUES (?,?)')
    .bind(
      ids[0],
      JSON.stringify({
        sourceCommit: '0187c95c8a9d3441049616a801f66f6f6d11050e',
        deploymentId: '6276181817',
        artifactDigest: '45562c9e111136f631c901892d2f1058e45050e93fa8d507f5beb0858eb68894',
        documentChecksum: checksum,
        capturedAt: 'fixture',
      }),
    )
    .run();
  expect(await migrateDatabase(db, 'migrations')).toEqual(['0037_draft_publication_baselines.sql']);
  const repository = new D1DraftRepository(db);
  expect((await repository.getDraft(ids[0])).publication).toMatchObject({
    sourceTarget: 'production',
    state: 'published',
    displayCount: 0,
  });
  expect((await repository.getDraft(ids[1])).publication).toMatchObject({
    sourceTarget: 'unknown',
    state: 'unknown',
    displayCount: 0,
  });
  expect(await db.prepare('SELECT COUNT(*) FROM revisions').first('COUNT(*)')).toBe(2);
  expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
});

test('refuses untracked existing data and foreign-key violations instead of marking schema ready', async () => {
  const db = open();
  await db.exec('CREATE TABLE existing(id INTEGER)');
  await expect(migrateDatabase(db, 'migrations')).rejects.toThrow(/MIGRATION_UNTRACKED_DATABASE/);
  const directory = await mkdtemp(join(tmpdir(), 'builder-native-migrations-'));
  directories.push(directory);
  await writeFile(
    join(directory, '0001_fixture.sql'),
    `CREATE TABLE parents(id INTEGER PRIMARY KEY);
    CREATE TABLE children(parent INTEGER REFERENCES parents(id)); INSERT INTO children VALUES (9);`,
  );
  const fresh = open();
  await expect(migrateDatabase(fresh, directory)).rejects.toThrow(/MIGRATION_FOREIGN_KEY/);
  expect(
    await fresh.prepare("SELECT name FROM sqlite_master WHERE name='parents'").first(),
  ).toBeNull();
});

test('real repositories create, retry, checkout and save compressed revisions on native SQLite', async () => {
  const db = open();
  await migrateDatabase(db, 'migrations');
  const actor = 'github:12345';
  await db
    .prepare(
      `INSERT INTO user_roles(email,role,active,created_at,updated_at,updated_by)
    VALUES (?,'administrator',1,'fixture','fixture','fixture')`,
    )
    .bind(actor)
    .run();
  const repository = new D1DraftRepository(db, undefined, 'compact-v1');
  const input = {
    name: 'Native draft',
    document: defaultSiteDocument,
    actor,
    idempotencyKey: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
  };
  const draft = await repository.createDraft(input);
  expect((await repository.createDraft(input)).id).toBe(draft.id);
  const checkout = await repository.acquireCheckout({
    draftId: draft.id,
    actor,
    clientId: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
  });
  const document = structuredClone(draft.document);
  document.site.name = 'Native changed name';
  const saved = await repository.saveDraft({
    draftId: draft.id,
    actor,
    document,
    idempotencyKey: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    checkoutToken: checkout.token,
    expectedRevisionId: draft.latestRevisionId,
    expectedChecksum: draft.revision.checksum,
    action: { category: 'text-edit', context: 'site-settings' },
  });
  expect(saved.revision.sequence).toBe(2);
  expect((await repository.getDraft(draft.id)).publication).toMatchObject({
    state: 'unknown',
    displayCount: 1,
  });
  expect((await repository.getDraft(draft.id)).document.site.name).toBe('Native changed name');
  expect((await repository.getRevision(draft.latestRevisionId)).document.site.name).toBe(
    defaultSiteDocument.site.name,
  );
  await db.prepare('UPDATE user_roles SET active=0 WHERE email=?').bind(actor).run();
  await expect(
    repository.createDraft({ ...input, idempotencyKey: crypto.randomUUID() }),
  ).rejects.toThrow();
});

test('proven current Production import starts at Published 0 and counts immutable saves separately', async () => {
  const db = open();
  await migrateDatabase(db, 'migrations');
  const actor = 'github:12345';
  await db
    .prepare(
      "INSERT INTO user_roles(email,role,active,created_at,updated_at,updated_by) VALUES (?,'editor',1,'fixture','fixture','fixture')",
    )
    .bind(actor)
    .run();
  const source = {
    document: defaultSiteDocument,
    assets: new Map(),
    provenance: {
      target: 'production' as const,
      sourceCommit: '0187c95c8a9d3441049616a801f66f6f6d11050e',
      deploymentId: '6276181817',
      artifactDigest: '45562c9e111136f631c901892d2f1058e45050e93fa8d507f5beb0858eb68894',
      documentChecksum: await checksumDocument(defaultSiteDocument),
      capturedAt: new Date().toISOString(),
    },
  };
  const repository = new D1DraftRepository(db, undefined, 'legacy', undefined, () =>
    Promise.resolve(source),
  );
  const draft = await repository.createDraft({
    name: 'Spring',
    document: defaultSiteDocument,
    sourceTarget: 'production',
    actor,
    idempotencyKey: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
  });
  expect((await repository.getDraft(draft.id)).publication).toMatchObject({
    sourceTarget: 'production',
    state: 'published',
    displayCount: 0,
  });
  const lease = await repository.acquireCheckout({
    draftId: draft.id,
    actor,
    clientId: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
  });
  const changed = structuredClone(draft.document);
  changed.site.shortName = 'Spring edits';
  await repository.saveDraft({
    draftId: draft.id,
    actor,
    document: changed,
    checkoutToken: lease.token,
    expectedRevisionId: draft.latestRevisionId,
    expectedChecksum: draft.revision.checksum,
    idempotencyKey: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    action: { category: 'text-edit', context: 'site-settings' },
  });
  expect((await repository.getDraft(draft.id)).publication).toMatchObject({
    state: 'published',
    displayCount: 1,
  });
  expect((await repository.listRevisions(draft.id)).map((revision) => revision.sequence)).toEqual([
    2, 1,
  ]);
});
