// @vitest-environment node
import { afterEach, expect, test } from 'vitest';
import { SqliteDatabase } from '../../server/sqlite';
import { migrateDatabase } from '../../server/migrations';
import { bindInstance, bootstrapAdministrator } from '../../server/identity';

const databases: SqliteDatabase[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
async function fixture() {
  const workspace = new SqliteDatabase(':memory:');
  const recovery = new SqliteDatabase(':memory:');
  databases.push(workspace, recovery);
  await migrateDatabase(workspace, 'migrations');
  await migrateDatabase(recovery, 'recovery-migrations');
  return { workspace, recovery };
}
test('a workspace cannot reopen under another origin or with another recovery database', async () => {
  const a = await fixture();
  const b = await fixture();
  const origin = 'https://builder-canary.eaglepass.io';
  const identity = await bindInstance(a.workspace, a.recovery, origin);
  expect(await bindInstance(a.workspace, a.recovery, origin)).toBe(identity);
  await bindInstance(b.workspace, b.recovery, 'https://builder.eaglepass.io');
  await expect(
    bindInstance(a.workspace, a.recovery, 'https://builder.eaglepass.io'),
  ).rejects.toThrow('BUILDER_INSTANCE_MISMATCH');
  await expect(bindInstance(a.workspace, b.recovery, origin)).rejects.toThrow(
    'BUILDER_INSTANCE_MISMATCH',
  );
  await expect(a.workspace.prepare('DELETE FROM builder_instance').run()).rejects.toThrow();
});
test('only the verified PM is bootstrapped once; startup never reactivates a revoked Administrator', async () => {
  const { workspace, recovery } = await fixture();
  await bindInstance(workspace, recovery, 'https://builder-canary.eaglepass.io');
  await expect(
    bootstrapAdministrator(workspace, () =>
      Promise.resolve(Response.json({ id: 999, login: 'brimdor' })),
    ),
  ).rejects.toThrow();
  expect(await workspace.prepare('SELECT 1 FROM user_roles').first()).toBeNull();
  let calls = 0;
  const fetcher: typeof fetch = () => {
    calls++;
    return Promise.resolve(Response.json({ id: 1202831, login: 'brimdor' }));
  };
  await bootstrapAdministrator(workspace, fetcher);
  expect(await workspace.prepare('SELECT email,role,active FROM user_roles').first()).toEqual({
    email: 'github:1202831',
    role: 'administrator',
    active: 1,
  });
  await workspace.prepare('UPDATE user_roles SET active=0').run();
  await bootstrapAdministrator(workspace, fetcher);
  expect(calls).toBe(1);
  expect(await workspace.prepare('SELECT active FROM user_roles').first('active')).toBe(0);
  await expect(
    workspace.prepare('UPDATE builder_instance SET bootstrapped=0').run(),
  ).rejects.toThrow();
});
