// @vitest-environment node
import { readFile, readdir } from 'node:fs/promises';
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
  for (const file of (await readdir('migrations')).filter((name) => name.endsWith('.sql')).sort())
    await database.exec(
      (await readFile(`migrations/${file}`, 'utf8'))
        .replace(/--[^\n]*/g, '')
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

  it('separates measured storage and audit activity from unknown provider quotas', async () => {
    const { service } = await fixture();
    const report = await service.capacity();
    expect(report.storage).toMatchObject({
      privateMediaBytes: 0,
      revisionPayloadBytes: 0,
      receiptPayloadBytes: 0,
    });
    expect(report.providerUsage.state).toBe('unknown');
    expect(report.activity.periodStart).toBe(`${report.measuredAt.slice(0, 10)}T00:00:00.000Z`);
    expect(report.activity.periodEnd).toBe(report.measuredAt);
    expect(report).not.toHaveProperty('writesToday');
  });
});
