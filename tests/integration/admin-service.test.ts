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
  return { database, service: new D1AdminService(database) };
}

describe('administrator service', () => {
  it('manages roles with audit records and never removes the final administrator', async () => {
    const { service } = await fixture();
    await service.upsertRole({
      email: 'admin@pointatx.org',
      role: 'administrator',
      active: true,
      actor: 'bootstrap',
      requestId: 'one',
    });
    await service.upsertRole({
      email: 'editor@pointatx.org',
      role: 'editor',
      active: true,
      actor: 'admin@pointatx.org',
      requestId: 'two',
    });
    expect(await service.listRoles()).toHaveLength(2);
    expect((await service.listAudit()).map((event) => event.action)).toContain('role.upsert');
    await expect(
      service.upsertRole({
        email: 'admin@pointatx.org',
        role: 'viewer',
        active: false,
        actor: 'admin@pointatx.org',
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
