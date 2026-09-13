// @vitest-environment node
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { afterEach, describe, expect, it } from 'vitest';
import { D1AdminService } from '../../src/server/admin/service';
import { refreshProviderUsage, readProviderUsage } from '../../src/server/admin/provider-usage';

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
  it('collects bounded provider counters, preserves unknowns and labels stale samples', async () => {
    const { database, service } = await fixture();
    const fetcher = vi.fn<typeof fetch>((url, init) => {
      expect(init?.redirect).toBe('error');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(init?.headers).get('authorization')).toBe(
        'Bearer fixture-read-only-credential',
      );
      if (url === 'https://api.cloudflare.com/client/v4/graphql') {
        const body = JSON.parse(init!.body as string) as {
          variables: {
            accountFilter: { datetimeHour_geq: string; datetimeHour_leq: string };
            workspaceFilter: { databaseId: string };
          };
        };
        expect(body.variables.accountFilter.datetimeHour_geq).toMatch(/T00:00:00.000Z$/);
        expect(body.variables.accountFilter.datetimeHour_leq).toMatch(/Z$/);
        expect(body.variables.workspaceFilter.databaseId).toBe(
          'd4f44410-3f61-47bd-976a-5595973fa6f1',
        );
        return Promise.resolve(
          Response.json({
            data: {
              viewer: {
                accounts: [
                  {
                    account: [{ sum: { rowsRead: 123456, rowsWritten: 1234 } }],
                    workspace: [{ sum: { rowsRead: 23456, rowsWritten: 234 } }],
                  },
                ],
              },
            },
            errors: null,
          }),
        );
      }
      expect(url).toBe(
        'https://api.cloudflare.com/client/v4/accounts/bc890091d86ddf9ce669e96e79d47746/d1/database/d4f44410-3f61-47bd-976a-5595973fa6f1?fields=uuid,file_size',
      );
      return Promise.resolve(
        Response.json({
          success: true,
          result: { uuid: 'd4f44410-3f61-47bd-976a-5595973fa6f1', file_size: 4505600 },
        }),
      );
    });
    expect((await readProviderUsage(database)).state).toBe('unknown');
    await refreshProviderUsage(database, undefined, fetcher);
    expect(fetcher).not.toHaveBeenCalled();
    await Promise.all([
      refreshProviderUsage(database, 'fixture-read-only-credential', fetcher),
      refreshProviderUsage(database, 'fixture-read-only-credential', fetcher),
    ]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const snapshot = await service.capacity();
    expect(snapshot.providerUsage).toMatchObject({
      state: 'reported',
      sample: {
        account: { rowsRead: 123456, rowsWritten: 1234 },
        workspace: { rowsRead: 23456, rowsWritten: 234 },
        workspaceStorageBytes: 4505600,
      },
    });
    await refreshProviderUsage(database, 'fixture-read-only-credential', fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const saved = await database.prepare('SELECT * FROM provider_usage').first();
    await service.capacity();
    expect(await database.prepare('SELECT * FROM provider_usage').first()).toEqual(saved);
    const failed = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json({ private: 'provider-detail' }, { status: 403 })),
    );
    await database
      .prepare("UPDATE provider_usage SET refresh_after='1970-01-01T00:00:00.000Z'")
      .run();
    await refreshProviderUsage(database, 'fixture-read-only-credential', failed);
    expect(await readProviderUsage(database)).toMatchObject({
      state: 'stale',
      sample: snapshot.providerUsage.state === 'reported' ? snapshot.providerUsage.sample : null,
    });
    expect(
      JSON.stringify(await database.prepare('SELECT * FROM provider_usage').first()),
    ).not.toContain('provider-detail');
    await database
      .prepare(
        "UPDATE provider_usage SET data_json=NULL,collected_at=NULL,refresh_after='1970-01-01T00:00:00.000Z'",
      )
      .run();
    const partial = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json({
          data: { viewer: { accounts: [{ account: [], workspace: [] }] } },
          errors: [{ message: 'private-provider-error' }],
        }),
      ),
    );
    await refreshProviderUsage(database, 'fixture-read-only-credential', partial);
    expect((await readProviderUsage(database)).state).toBe('unknown');
    await database
      .prepare("UPDATE provider_usage SET refresh_after='1970-01-01T00:00:00.000Z'")
      .run();
    const empty = vi.fn<typeof fetch>((url, init) =>
      url === 'https://api.cloudflare.com/client/v4/graphql'
        ? Promise.resolve(
            Response.json({
              data: { viewer: { accounts: [{ account: [], workspace: [] }] } },
              errors: null,
            }),
          )
        : fetcher(url, init),
    );
    await refreshProviderUsage(database, 'fixture-read-only-credential', empty);
    expect((await readProviderUsage(database)).state).toBe('unknown');
    await database
      .prepare(
        "UPDATE provider_usage SET checked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),collected_at='2000-01-01T00:00:00.000Z',data_json=?,last_error=NULL",
      )
      .bind(
        JSON.stringify(
          snapshot.providerUsage.state === 'reported' ? snapshot.providerUsage.sample : {},
        ),
      )
      .run();
    expect((await readProviderUsage(database)).state).toBe('stale');
  });
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
