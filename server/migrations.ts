import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { SqliteDatabase } from './sqlite';

/** Startup only: callers must not expose the database to requests until this completes. */
export async function migrateDatabase(
  database: SqliteDatabase,
  directory: string,
): Promise<string[]> {
  const files = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
  const migrations = await Promise.all(
    files.map(async (name) => {
      if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(name)) throw new Error('MIGRATION_NAME_INVALID');
      const sql = await readFile(join(directory, name), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    }),
  );
  if (new Set(migrations.map(({ name }) => name.slice(0, 4))).size !== migrations.length) {
    throw new Error('MIGRATION_NUMBER_DUPLICATED');
  }
  const tracked = await database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='builder_schema_migrations'",
    )
    .first();
  if (
    !tracked &&
    (await database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1",
      )
      .first())
  )
    throw new Error('MIGRATION_UNTRACKED_DATABASE');
  await database.exec(`CREATE TABLE IF NOT EXISTS builder_schema_migrations(
    name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const applied = (
    await database
      .prepare('SELECT name,checksum FROM builder_schema_migrations ORDER BY name')
      .all<{ name: string; checksum: string }>()
  ).results;
  for (const [index, row] of applied.entries()) {
    const expected = migrations.find(({ name }) => name === row.name);
    if (!expected) throw new Error(`MIGRATION_UNKNOWN: ${row.name}`);
    if (expected.checksum !== row.checksum) throw new Error(`MIGRATION_CHANGED: ${row.name}`);
    if (migrations[index].name !== row.name) throw new Error('MIGRATION_ORDER_CHANGED');
  }
  const completed: string[] = [];
  for (const migration of migrations.slice(applied.length)) {
    // Historical table rebuilds toggle foreign_keys. Set it before the transaction, then check
    // the complete resulting schema before committing; toggles inside a transaction are no-ops.
    await database.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
    try {
      await database.exec(migration.sql);
      if ((await database.prepare('PRAGMA foreign_key_check').all()).results.length) {
        throw new Error('MIGRATION_FOREIGN_KEY_VIOLATION');
      }
      await database
        .prepare('INSERT INTO builder_schema_migrations(name,checksum,applied_at) VALUES (?,?,?)')
        .bind(migration.name, migration.checksum, new Date().toISOString())
        .run();
      await database.exec('COMMIT');
      completed.push(migration.name);
    } catch (error) {
      try {
        await database.exec('ROLLBACK');
      } catch {
        /* Preserve the original migration error. */
      }
      throw error;
    } finally {
      await database.exec('PRAGMA foreign_keys=ON');
    }
  }
  if ((await database.prepare('PRAGMA integrity_check').first('integrity_check')) !== 'ok') {
    throw new Error('MIGRATION_INTEGRITY_FAILED');
  }
  return completed;
}
