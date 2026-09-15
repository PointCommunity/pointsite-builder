// @vitest-environment node
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { SqliteDatabase } from '../../server/sqlite';
import { migrateDatabase } from '../../server/migrations';
import { bindInstance } from '../../server/identity';
import { BackupManifest, createBackups, fileIdentity, retainedBackups } from '../../server/backups';

test('online native backups preserve atomic writes, protect files, and publish only complete verified pairs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'builder-backups-'));
  const workspacePath = join(directory, 'workspace.sqlite');
  const workspace = new SqliteDatabase(workspacePath);
  const control = new SqliteDatabase(join(directory, 'control.sqlite'));
  try {
    await migrateDatabase(workspace, 'migrations');
    await migrateDatabase(control, 'recovery-migrations');
    const origin = 'https://builder-canary.eaglepass.io';
    await bindInstance(workspace, control, origin);
    await workspace.exec('CREATE TABLE backup_fixture(id INTEGER PRIMARY KEY,payload BLOB)');
    await workspace.prepare('INSERT INTO backup_fixture VALUES (1,zeroblob(2000000))').run();
    const single = join(directory, 'single.sqlite');
    const pending = workspace.backupTo(single);
    await workspace.batch(
      Array.from({ length: 100 }, (_, index) =>
        workspace.prepare('INSERT INTO backup_fixture VALUES (?,zeroblob(1000))').bind(index + 2),
      ),
    );
    await pending;
    const copy = new DatabaseSync(single, { readOnly: true });
    try {
      expect([1, 101]).toContain(
        copy.prepare('SELECT COUNT(*) AS count FROM backup_fixture').get()!.count,
      );
      expect(copy.prepare('PRAGMA integrity_check').get()!.integrity_check).toBe('ok');
    } finally {
      copy.close();
    }
    const original = await fileIdentity(single);
    await expect(workspace.backupTo(single)).rejects.toThrow();
    expect(await fileIdentity(single)).toEqual(original);
    expect((await stat(single)).mode & 0o777).toBe(0o600);
    const root = join(directory, 'backups');
    const options = { workspace, control, root, origin, workspacePath, requireOffVolume: false };
    const backups = await createBackups(options);
    await backups.due();
    const entries = await readdir(root);
    expect(entries).toHaveLength(2); // Instance marker + one complete pair.
    const id = entries.find((entry) => entry !== 'instance.json')!;
    const manifest = BackupManifest.parse(
      JSON.parse(await readFile(join(root, id, 'manifest.json'), 'utf8')),
    );
    expect(manifest.workspace).toEqual(await fileIdentity(join(root, id, 'workspace.sqlite')));
    expect(manifest.control).toEqual(await fileIdentity(join(root, id, 'control.sqlite')));
    expect((await backups.status()).backup.state).toBe('succeeded');
    await backups.due();
    expect(await readdir(root)).toEqual(entries);
    await expect(
      createBackups({ ...options, origin: 'https://builder.eaglepass.io' }),
    ).rejects.toThrow('INSTANCE_MISMATCH');
    await expect(createBackups({ ...options, requireOffVolume: true })).rejects.toThrow(
      'OFF_VOLUME',
    );
    await rm(root, { recursive: true });
    await expect(backups.run()).rejects.toThrow();
    expect((await backups.status()).backup).toMatchObject({
      state: 'failed',
      lastSucceededAt: manifest.completedAt,
    });
    expect(
      await workspace.prepare('SELECT COUNT(*) AS count FROM backup_fixture').first('count'),
    ).toBe(101);
  } finally {
    workspace.close();
    control.close();
    await rm(directory, { recursive: true });
  }
});

test('retention keeps seven latest distinct days, four weeks, and explicitly pinned evidence', () => {
  const items = Array.from({ length: 45 }, (_, index) => ({
    id: String(index),
    completedAt: new Date(Date.UTC(2026, 8, 14 - index, 12)).toISOString(),
    pinned: index === 44,
  }));
  items.push({ id: 'older-same-day', completedAt: '2026-09-14T01:00:00.000Z', pinned: false });
  const retained = retainedBackups(items);
  for (let day = 0; day < 7; day++) expect(retained.has(String(day))).toBe(true);
  expect(retained.has('44')).toBe(true);
  expect(retained.has('older-same-day')).toBe(false);
  expect(retained.has('40')).toBe(false);
  const weeks = new Set(
    items
      .filter((item) => retained.has(item.id) && !item.pinned)
      .map((item) => Math.floor((Date.parse(item.completedAt.slice(0, 10)) / 86_400_000 + 3) / 7)),
  );
  expect(weeks.size).toBe(4);
});
