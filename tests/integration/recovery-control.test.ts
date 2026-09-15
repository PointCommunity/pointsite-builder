// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { Miniflare } from 'miniflare';
import {
  openRecoveryDatabase,
  quarantineWorkspace,
  assertRecoveryDrained,
} from '../../src/server/maintenance/recovery-control';
import { D1DeletionReceipts } from '../../src/server/maintenance/deletion-receipts';
import worker from '../../worker/index';
import { bindOperatorSql, operatorDatabase } from '../../scripts/lib/d1-operator';

it('encodes native operator parameters without SQL injection or losing Unicode and binary values', async () => {
  const { database } = await fixture();
  const text = "apostrophe '; DROP TABLE content; -- ? 教会\u0000end";
  const sql = bindOperatorSql("SELECT ? AS text,? AS bytes,? AS value,'?' AS literal /* ? */", [
    text,
    new Uint8Array([0, 255]),
    null,
  ]);
  const result = await database
    .prepare(sql)
    .first<{ text: string; bytes: number[]; value: null; literal: string }>();
  expect(result).toEqual({ text, bytes: [0, 255], value: null, literal: '?' });
  expect(await database.prepare('SELECT count(*) n FROM content').first('n')).toBe(1);
  expect(() => bindOperatorSql('SELECT ?1', [1])).toThrow('RECOVERY_SQL_BINDING');
  expect(() => bindOperatorSql('SELECT ?', [])).toThrow('RECOVERY_SQL_BINDING');
  const query = vi.fn(() =>
    Promise.resolve([
      {
        success: true,
        results: [{ count: 1 }],
        meta: {
          rows_read: 1,
          rows_written: 0,
          changes: 0,
          duration: 0,
          size_after: 4096,
          last_row_id: 0,
          changed_db: false,
        },
      },
    ]),
  );
  const native = operatorDatabase(query);
  expect(await native.prepare('SELECT ? AS count').bind(1).first('count')).toBe(1);
  expect(query).toHaveBeenCalledWith('SELECT 1 AS count');
  await expect(native.batch([database.prepare('DELETE FROM content')])).rejects.toThrow(
    'RECOVERY_SQL_UNSUPPORTED',
  );
  query.mockResolvedValueOnce([]);
  await expect(native.prepare('SELECT 1').all()).rejects.toThrow('RECOVERY_SQL_RESULTS');
});

let runtime: Miniflare | undefined;
afterEach(async () => {
  await runtime?.dispose();
  vi.unstubAllGlobals();
});

async function fixture() {
  runtime = new Miniflare({
    compatibilityDate: '2026-09-05',
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { DB: crypto.randomUUID(), CONTROL: crypto.randomUUID() },
  });
  const database = await runtime.getD1Database('DB');
  const control = await runtime.getD1Database('CONTROL');
  await database.exec(
    "CREATE TABLE content (id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO content VALUES (1,'before restore');",
  );
  await control.exec(
    (await readFile('recovery-migrations/0001_control.sql', 'utf8'))
      .replace(/--[^\n]*/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
  );
  await control.exec(
    (await readFile('recovery-migrations/0002_deletion_receipts.sql', 'utf8'))
      .replace(/--[^\n]*/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
  );
  await database.exec(
    (await readFile('migrations/0032_deletion_commits.sql', 'utf8'))
      .replace(/--[^\n]*/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
  );
  return { database, control };
}

async function retentionFixture() {
  const value = await fixture();
  for (const [db, path] of [
    [value.control, 'recovery-migrations/0004_receipt_retention.sql'],
    [value.database, 'migrations/0033_deletion_retention.sql'],
  ] as const)
    await db.exec(
      (await readFile(path, 'utf8'))
        .replace(/--[^\n]*/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    );
  const receipts = new D1DeletionReceipts(
    await openRecoveryDatabase(value.database, value.control),
    value.control,
  );
  const seed = async (days: number, state = 'committed') => {
    const id = crypto.randomUUID();
    await value.control
      .prepare(
        `INSERT INTO deletion_receipts
      (id,target_json,target_hash,state,prepared_at,resolved_at)
      VALUES (?,'{}',?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now',?),
        CASE WHEN ?='pending' THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ','now',?) END)`,
      )
      .bind(id, 'a'.repeat(64), state, `-${days} days`, state, `-${days} days`)
      .run();
    await value.database
      .prepare('INSERT INTO deletion_commits(receipt_id,target_hash) VALUES (?,?)')
      .bind(id, 'a'.repeat(64))
      .run();
    return id;
  };
  return { ...value, receipts, seed };
}

it('bounds resolved deletion retention while keeping unresolved receipts, recent receipts and content', async () => {
  const { database, control, receipts, seed } = await retentionFixture();
  const pending = await seed(200, 'pending');
  const recent = await seed(89);
  for (let index = 0; index < 21; index++) await seed(91, index % 2 ? 'committed' : 'cancelled');
  expect(await receipts.retire()).toEqual({ receipts: 20, proofs: 20, replays: 0 });
  expect(await receipts.retire()).toEqual({ receipts: 1, proofs: 1, replays: 0 });
  expect(await receipts.retire()).toEqual({ receipts: 0, proofs: 0, replays: 0 });
  for (const id of [pending, recent]) {
    expect(
      await control.prepare('SELECT id FROM deletion_receipts WHERE id=?').bind(id).first('id'),
    ).toBe(id);
    expect(
      await database
        .prepare('SELECT receipt_id FROM deletion_commits WHERE receipt_id=?')
        .bind(id)
        .first('receipt_id'),
    ).toBe(id);
  }
  expect(await database.prepare('SELECT value FROM content').first('value')).toBe('before restore');
  const plan = await control
    .prepare(
      `EXPLAIN QUERY PLAN SELECT id FROM deletion_receipts
    INDEXED BY deletion_receipts_resolved WHERE state!='pending' AND resolved_at<?
    ORDER BY resolved_at,id LIMIT 20`,
    )
    .bind(new Date().toISOString())
    .all<{ detail: string }>();
  expect(plan.results.map((row) => row.detail).join(' ')).toContain(
    'USING INDEX deletion_receipts_resolved',
  );
});

it('drains replay markers in bounded batches before retiring their independent deletion receipt', async () => {
  const { database, control, receipts, seed } = await retentionFixture();
  const id = await seed(91);
  for (let index = 0; index < 21; index++)
    await database
      .prepare('INSERT INTO deletion_replays(recovery_id,receipt_id,target_hash) VALUES (?,?,?)')
      .bind(crypto.randomUUID(), id, 'a'.repeat(64))
      .run();
  expect(await receipts.retire()).toEqual({ receipts: 0, proofs: 1, replays: 20 });
  expect(await control.prepare('SELECT id FROM deletion_receipts').first('id')).toBe(id);
  expect(await receipts.retire()).toEqual({ receipts: 1, proofs: 0, replays: 1 });
});

it('keeps a receipt exactly at the independent database cutoff', async () => {
  const { database, control } = await retentionFixture();
  const id = crypto.randomUUID();
  const pinned = {
    prepare: (query: string) =>
      query.startsWith('SELECT epoch,strftime')
        ? {
            first: async () => {
              const state = await control.prepare(query).first<{ epoch: number; cutoff: string }>();
              await control
                .prepare(
                  `INSERT INTO deletion_receipts
        (id,target_json,target_hash,state,prepared_at,resolved_at) VALUES (?,'{}',?,'committed',?,?)`,
                )
                .bind(id, 'a'.repeat(64), state!.cutoff, state!.cutoff)
                .run();
              return state;
            },
          }
        : control.prepare(query),
    batch: control.batch.bind(control),
  } as D1Database;
  expect(await new D1DeletionReceipts(database, pinned).retire()).toEqual({
    receipts: 0,
    proofs: 0,
    replays: 0,
  });
  expect(await control.prepare('SELECT id FROM deletion_receipts').first('id')).toBe(id);
});

it('keeps independent receipts when workspace cleanup rolls back or quarantine wins after cleanup', async () => {
  const { database, control, seed } = await retentionFixture();
  const id = await seed(91);
  const broken = {
    prepare: database.prepare.bind(database),
    batch: (items: D1PreparedStatement[]) =>
      database.batch([...items, database.prepare("SELECT json('injected failure')")]),
  } as D1Database;
  await expect(new D1DeletionReceipts(broken, control).retire()).rejects.toThrow();
  expect(
    await database.prepare('SELECT receipt_id FROM deletion_commits').first('receipt_id'),
  ).toBe(id);
  expect(await control.prepare('SELECT id FROM deletion_receipts').first('id')).toBe(id);
  const raced = {
    prepare: database.prepare.bind(database),
    batch: async (items: D1PreparedStatement[]) => {
      const result = await database.batch(items);
      await quarantineWorkspace(control, 1, crypto.randomUUID());
      return result;
    },
  } as D1Database;
  await expect(new D1DeletionReceipts(raced, control).retire()).rejects.toThrow();
  expect(await control.prepare('SELECT id FROM deletion_receipts').first('id')).toBe(id);
  await expect(new D1DeletionReceipts(database, control).retire()).rejects.toThrow(
    'WORKSPACE_RECOVERY_CHANGED',
  );
});

it('retries retention after an uncertain control-store response without touching recent proofs', async () => {
  const { database, control, receipts, seed } = await retentionFixture();
  await seed(91);
  const recent = await seed(1);
  const lost = {
    prepare: control.prepare.bind(control),
    batch: async (items: D1PreparedStatement[]) => {
      await control.batch(items);
      throw new Error('lost response');
    },
  } as unknown as D1Database;
  await expect(new D1DeletionReceipts(database, lost).retire()).rejects.toThrow('lost response');
  expect(await receipts.retire()).toEqual({ receipts: 0, proofs: 0, replays: 0 });
  expect(
    await database.prepare('SELECT receipt_id FROM deletion_commits').first('receipt_id'),
  ).toBe(recent);
});

it('guards reads and whole transactions, preserves results and refuses unguarded statements', async () => {
  const { database, control } = await fixture();
  const guarded = await openRecoveryDatabase(database, control);
  expect(await guarded.prepare('SELECT value FROM content WHERE id=?').bind(1).first('value')).toBe(
    'before restore',
  );
  const results = await guarded.batch([
    guarded.prepare('UPDATE content SET value=? WHERE id=1').bind('saved'),
    guarded.prepare('SELECT value FROM content'),
  ]);
  expect(results).toHaveLength(2);
  expect(results[0].meta.changes).toBe(1);
  expect(results[1].results).toEqual([{ value: 'saved' }]);
  await expect(
    guarded.batch([
      guarded.prepare("UPDATE content SET value='wrong'"),
      guarded.prepare("SELECT json('fail')"),
    ]),
  ).rejects.toThrow();
  expect(await guarded.prepare('SELECT value FROM content').first('value')).toBe('saved');
  await expect(guarded.batch([database.prepare('DELETE FROM content')])).rejects.toThrow(
    'WORKSPACE_ACCESS_UNAVAILABLE',
  );
  expect(() => guarded.exec('DELETE FROM content')).toThrow('WORKSPACE_ACCESS_UNAVAILABLE');
  expect(() => guarded.withSession()).toThrow('WORKSPACE_ACCESS_UNAVAILABLE');
  expect(() => guarded.dump()).toThrow('WORKSPACE_ACCESS_UNAVAILABLE');
  expect(() => guarded.prepare('SELECT * FROM content').raw()).toThrow(
    'WORKSPACE_ACCESS_UNAVAILABLE',
  );
});

it('fences delayed reads and writes across a rewind and reopening', async () => {
  const { database, control } = await fixture();
  const old = await openRecoveryDatabase(database, control, 2);
  await old.prepare('SELECT * FROM content').all();
  const id = crypto.randomUUID();
  const state = await quarantineWorkspace(control, 1, id);
  expect(state.epoch).toBe(2);
  expect(state.mode).toBe('quarantined');
  expect(await quarantineWorkspace(control, 1, id)).toEqual(state);
  await expect(quarantineWorkspace(control, 1, crypto.randomUUID())).rejects.toThrow(
    'WORKSPACE_RECOVERY_CHANGED',
  );
  await expect(openRecoveryDatabase(database, control)).rejects.toThrow(
    'WORKSPACE_ACCESS_UNAVAILABLE',
  );
  await expect(assertRecoveryDrained(database, control, 2, id)).rejects.toThrow(
    'WORKSPACE_RECOVERY_DRAINING',
  );
  await setTimeout(2100);
  await expect(assertRecoveryDrained(database, control, 2, id)).resolves.toBeUndefined();
  // Simulate restored rows and a separately verified operator reopening. The old lease never renews.
  await database.prepare("UPDATE content SET value='restored'").run();
  await control
    .prepare(
      "UPDATE workspace_recovery SET mode='active',recovery_id=NULL,epoch=epoch+1 WHERE id=1",
    )
    .run();
  await expect(old.prepare('SELECT * FROM content').all()).rejects.toThrow(
    'WORKSPACE_ACCESS_UNAVAILABLE',
  );
  await expect(old.prepare("UPDATE content SET value='late writer'").run()).rejects.toThrow(
    'WORKSPACE_ACCESS_UNAVAILABLE',
  );
  const current = await openRecoveryDatabase(database, control);
  expect(await current.prepare('SELECT value FROM content').first('value')).toBe('restored');
});

it('settles uncertain deletion only from atomic workspace proof before a rewind', async () => {
  const { database, control } = await fixture();
  const receipts = new D1DeletionReceipts(database, control);
  const committed = await receipts.prepare({ kind: 'draft', draftId: crypto.randomUUID() });
  const aborted = await receipts.prepare({ kind: 'draft', draftId: crypto.randomUUID() });
  await expect(receipts.confirm(committed)).rejects.toThrow('DELETION_COMMIT_UNCONFIRMED');
  await expect(
    database.batch([
      database.prepare('DELETE FROM content'),
      receipts.proof(aborted),
      database.prepare("SELECT json('late failure')"),
    ]),
  ).rejects.toThrow();
  expect(await database.prepare('SELECT count(*) n FROM content').first('n')).toBe(1);
  await database.batch([database.prepare('DELETE FROM content'), receipts.proof(committed)]);
  // Lose the confirmation response: both independent receipts still read pending.
  expect(
    await control
      .prepare("SELECT count(*) n FROM deletion_receipts WHERE state='pending'")
      .first('n'),
  ).toBe(2);
  const id = crypto.randomUUID();
  await quarantineWorkspace(control, 1, id);
  await expect(receipts.prepare({ kind: 'draft', draftId: crypto.randomUUID() })).rejects.toThrow(
    'DELETION_RECEIPT_UNAVAILABLE',
  );
  expect(await receipts.settlePending(2, id)).toEqual({ settled: 2 });
  expect(await receipts.settlePending(2, id)).toEqual({ settled: 0 });
  expect(
    await control
      .prepare('SELECT state FROM deletion_receipts WHERE id=?')
      .bind(committed.id)
      .first('state'),
  ).toBe('committed');
  expect(
    await control
      .prepare('SELECT state FROM deletion_receipts WHERE id=?')
      .bind(aborted.id)
      .first('state'),
  ).toBe('cancelled');
  await receipts.confirm(committed);
  await expect(
    control
      .prepare("UPDATE deletion_receipts SET state='cancelled' WHERE id=?")
      .bind(committed.id)
      .run(),
  ).rejects.toThrow('DELETION_RECEIPT_IMMUTABLE');
  await expect(receipts.settlePending(2, crypto.randomUUID())).rejects.toThrow(
    'WORKSPACE_RECOVERY_CHANGED',
  );
});

it('rejects a lease when quarantine wins between its initial state and issuance', async () => {
  const { database, control } = await fixture();
  const delayed = {
    ...database,
    prepare: (query: string) =>
      query.includes("strftime('%s'")
        ? {
            first: async () => {
              await quarantineWorkspace(control, 1, crypto.randomUUID());
              return Math.floor(Date.now() / 1000);
            },
          }
        : database.prepare(query),
  } as unknown as D1Database;
  const guarded = await openRecoveryDatabase(delayed, control);
  await expect(guarded.prepare('SELECT * FROM content').all()).rejects.toThrow(
    'WORKSPACE_ACCESS_UNAVAILABLE',
  );
  expect(
    await control.prepare('SELECT leased_until FROM workspace_recovery').first('leased_until'),
  ).toBe(0);
});

it('fails closed when the independent control database is missing or unreadable', async () => {
  const { database, control } = await fixture();
  await expect(openRecoveryDatabase(database, undefined)).rejects.toThrow(
    'WORKSPACE_ACCESS_UNAVAILABLE',
  );
  await control.exec('DROP TABLE workspace_recovery');
  await expect(openRecoveryDatabase(database, control)).rejects.toThrow(
    'WORKSPACE_ACCESS_UNAVAILABLE',
  );
});

it('keeps liveness available while runtime routes and scheduled workspace work are quarantined', async () => {
  const { database, control } = await fixture();
  vi.stubGlobal('__BUILDER_SOURCE_REVISION__', 'a'.repeat(40));
  vi.stubGlobal('__BUILDER_SOURCE_CLEAN__', true);
  const env = {
    DB: database,
    RECOVERY_DB: control,
    ENVIRONMENT: 'local',
    APP_VERSION: 'fixture',
    BUILDER_ORIGIN: 'http://localhost',
    STAGING_REPOSITORY: 'PointCommunity/pointsite-staging',
    PRODUCTION_ENABLED: 'false',
  } as unknown as Env;
  expect((await worker.fetch(new Request('http://localhost/api/drafts'), env)).status).toBe(401);
  expect(
    await control.prepare('SELECT leased_until FROM workspace_recovery').first('leased_until'),
  ).toBe(0);
  await quarantineWorkspace(control, 1, crypto.randomUUID());
  expect((await worker.fetch(new Request('http://localhost/api/health'), env)).status).toBe(200);
  for (const path of [
    '/api/ready',
    '/api/drafts',
    '/auth/callback',
    '/assets/builder/10000000-0000-4000-8000-000000000001/image.png',
  ]) {
    const response = await worker.fetch(new Request(`http://localhost${path}`), env);
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ code: 'WORKSPACE_ACCESS_UNAVAILABLE' });
  }
  await expect(worker.scheduled({} as ScheduledController, env)).rejects.toThrow(
    'WORKSPACE_ACCESS_UNAVAILABLE',
  );
});
