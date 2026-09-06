// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { afterEach, describe, expect, it } from 'vitest';
import { D1AdminService } from '../../src/server/admin/service';

let miniflare: Miniflare;
afterEach(async () => miniflare?.dispose());

async function fixture() {
  miniflare = new Miniflare({
    compatibilityDate: '2026-09-05',
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { DB: crypto.randomUUID() },
  });
  const database = await miniflare.getD1Database('DB');
  await database.exec(
    (await readFile('migrations/0001_initial.sql', 'utf8')).replace(/\s+/g, ' ').trim(),
  );
  await database.exec(
    (await readFile('migrations/0006_free_only_auth_media.sql', 'utf8'))
      .replace(/\s+/g, ' ')
      .trim(),
  );
  return {
    database,
    service: new D1AdminService(database, {
      resolve: (login) =>
        Promise.resolve({
          id: login.toLowerCase() === 'brimdor' ? 1_202_831 : 9_999,
          login: login.toLowerCase(),
        }),
    }),
  };
}

describe('administrator service', () => {
  it('manages roles with audit records and never removes the final administrator', async () => {
    const { service } = await fixture();
    await service.upsertRole({
      githubLogin: 'Brimdor',
      role: 'administrator',
      active: true,
      actor: 'bootstrap',
      requestId: 'one',
    });
    await service.upsertRole({
      githubLogin: 'point-editor',
      role: 'editor',
      active: true,
      actor: 'github:1202831',
      requestId: 'two',
    });
    expect(await service.listRoles()).toMatchObject([
      { githubLogin: 'brimdor', githubUserId: 1202831, role: 'administrator' },
      { githubLogin: 'point-editor', githubUserId: 9999, role: 'editor' },
    ]);
    const audit = await service.listAudit();
    expect(audit.map((event) => event.action)).toContain('role.upsert');
    expect(audit.find((event) => event.requestId === 'two')).toMatchObject({
      actor: '@brimdor',
      targetId: '@point-editor',
    });
    await expect(
      service.upsertRole({
        githubLogin: 'brimdor',
        role: 'viewer',
        active: false,
        actor: 'github:1202831',
        requestId: 'three',
      }),
    ).rejects.toThrow(/one active administrator/i);
  });

  it('reports measured capacity and 70 percent warning state', async () => {
    const { service } = await fixture();
    const report = await service.capacity();
    expect(report.privateMedia).toMatchObject({ used: 0, warning: false, unit: 'bytes' });
    expect(report.writesToday.limit).toBe(100_000);
  });
});
