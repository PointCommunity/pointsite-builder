// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { SqliteDatabase } from '../../server/sqlite';

const databases: SqliteDatabase[] = [];
const directories: string[] = [];
function open(path = ':memory:') {
  const database = new SqliteDatabase(path);
  databases.push(database);
  return database;
}
afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true });
});

test('preserves bindings, BLOB bytes, column reads and statement-local changes', async () => {
  const db = open();
  await db.exec('CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT NOT NULL, bytes BLOB)');
  const bytes = new Uint8Array([0, 128, 255]);
  const write = await db
    .prepare('INSERT INTO items(name,bytes) VALUES (?,?) RETURNING id')
    .bind('first', bytes.buffer)
    .all<{ id: number }>();
  expect(write.results).toEqual([{ id: 1 }]);
  expect(write.meta.changes).toBe(1);
  expect(write.meta.last_row_id).toBe(1);
  const read = await db.prepare('SELECT * FROM items').all<{ bytes: number[] }>();
  expect(read.results[0].bytes).toEqual([0, 128, 255]);
  expect(new Uint8Array(read.results[0].bytes)).toEqual(bytes);
  expect(read.meta.changes).toBe(0);
  expect(Number.isNaN(read.meta.rows_read)).toBe(true);
  expect(read.meta.size_after).toBeGreaterThan(0);
  expect(await db.prepare('SELECT name FROM items').first('name')).toBe('first');
  expect(await db.prepare('SELECT name FROM items WHERE id=2').first()).toBeNull();
  await expect(db.prepare('SELECT name FROM items').first('missing')).rejects.toThrow();
  const statement = db.prepare('SELECT ? AS value');
  expect(await statement.bind('a').first('value')).toBe('a');
  expect(await statement.bind('b').first('value')).toBe('b');
});

test('a trigger failure rolls back every statement and a successful batch commits once', async () => {
  const db = open();
  await db.exec(`CREATE TABLE items(id INTEGER PRIMARY KEY);
    CREATE TRIGGER refuse BEFORE INSERT ON items WHEN NEW.id=2
    BEGIN SELECT RAISE(ABORT,'blocked'); END;`);
  await expect(
    db.batch([
      db.prepare('INSERT INTO items VALUES (1)'),
      db.prepare('INSERT INTO items VALUES (2)'),
    ]),
  ).rejects.toThrow('blocked');
  expect(await db.prepare('SELECT count(*) AS count FROM items').first('count')).toBe(0);
  const results = await db.batch([
    db.prepare('INSERT INTO items VALUES (3)'),
    db.prepare('SELECT id FROM items'),
  ]);
  expect(results[0].meta.changes).toBe(1);
  expect(results[1].meta.changes).toBe(0);
  expect(results[1].results).toEqual([{ id: 3 }]);
});

test('rejects foreign keys, unsupported bindings, trailing SQL and statements from another store', async () => {
  const db = open();
  const other = open();
  await db.exec(
    'CREATE TABLE parents(id INTEGER PRIMARY KEY); CREATE TABLE children(parent INTEGER REFERENCES parents(id));',
  );
  await expect(db.prepare('INSERT INTO children VALUES (1)').run()).rejects.toThrow();
  for (const value of [undefined, {}, true, Number.NaN, Infinity]) {
    expect(() => db.prepare('SELECT ?').bind(value)).toThrow();
  }
  expect(() => db.prepare('SELECT 1; SELECT 2')).toThrow();
  await expect(db.batch([other.prepare('SELECT 1')])).rejects.toThrow();
  await expect(db.dump()).rejects.toThrow();
  expect(() => db.withSession()).toThrow();
});

test('persists private workspace data across reopening and serializes writers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'builder-native-sqlite-'));
  directories.push(directory);
  const path = join(directory, 'workspace.sqlite');
  const first = open(path);
  await first.exec('CREATE TABLE items(id INTEGER PRIMARY KEY); INSERT INTO items VALUES (1)');
  const second = open(path);
  expect(await second.prepare('SELECT id FROM items').first('id')).toBe(1);
  await first.exec('BEGIN IMMEDIATE');
  await second.exec('PRAGMA busy_timeout=5');
  await expect(second.prepare('INSERT INTO items VALUES (2)').run()).rejects.toThrow(/locked/);
  await first.exec('ROLLBACK');
  await second.prepare('INSERT INTO items VALUES (2)').run();
  first.close();
  const reopened = open(path);
  expect(await reopened.prepare('SELECT count(*) AS count FROM items').first('count')).toBe(2);
  expect(await reopened.prepare('PRAGMA journal_mode').first('journal_mode')).toBe('wal');
});
