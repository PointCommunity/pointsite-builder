import { z } from 'zod';
import type { SqliteDatabase } from './sqlite';

interface Identity {
  origin: string;
  instance_id: string;
}

export async function bindInstance(
  workspace: SqliteDatabase,
  recovery: SqliteDatabase,
  origin: string,
) {
  const read = (db: SqliteDatabase) =>
    db.prepare('SELECT origin,instance_id FROM builder_instance WHERE id=1').first<Identity>();
  const existing = await read(workspace);
  const control = await read(recovery);
  if (existing || control) {
    if (
      !existing ||
      !control ||
      existing.origin !== origin ||
      control.origin !== origin ||
      existing.instance_id !== control.instance_id
    )
      throw new Error('BUILDER_INSTANCE_MISMATCH');
    return existing.instance_id;
  }
  if (
    (await workspace.prepare('SELECT 1 FROM drafts LIMIT 1').first()) ||
    (await recovery.prepare('SELECT 1 FROM deletion_receipts LIMIT 1').first())
  ) {
    throw new Error('BUILDER_INSTANCE_UNTRACKED_DATA');
  }
  const id = crypto.randomUUID();
  for (const db of [workspace, recovery]) {
    await db
      .prepare('INSERT INTO builder_instance(id,origin,instance_id) VALUES (1,?,?)')
      .bind(origin, id)
      .run();
  }
  return id;
}

/** Initial administrator is the repository's verified PM; an empty role table is not an invitation. */
export async function bootstrapAdministrator(
  database: SqliteDatabase,
  fetcher: typeof fetch = fetch,
) {
  const state = await database
    .prepare('SELECT bootstrapped FROM builder_instance WHERE id=1')
    .first<{ bootstrapped: number }>();
  if (!state) throw new Error('BUILDER_INSTANCE_REQUIRED');
  if (state.bootstrapped === 1) return;
  if (await database.prepare('SELECT 1 FROM user_roles LIMIT 1').first())
    throw new Error('BUILDER_BOOTSTRAP_ROLES_EXIST');
  const response = await fetcher('https://api.github.com/users/brimdor', {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'pointsite-builder' },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('BUILDER_BOOTSTRAP_IDENTITY_UNAVAILABLE');
  z.object({ id: z.literal(1202831), login: z.literal('brimdor') }).parse(await response.json());
  const now = new Date().toISOString();
  await database.batch([
    database.prepare(`SELECT json(CASE WHEN (SELECT bootstrapped FROM builder_instance WHERE id=1)=0
      AND NOT EXISTS (SELECT 1 FROM user_roles) THEN 'true' ELSE 'bootstrap-changed' END)`),
    database
      .prepare(
        `INSERT INTO user_roles(email,github_login,role,active,created_at,updated_at,updated_by)
      VALUES ('github:1202831','brimdor','administrator',1,?,?,'native-bootstrap')`,
      )
      .bind(now, now),
    database.prepare('UPDATE builder_instance SET bootstrapped=1 WHERE id=1'),
  ]);
}
