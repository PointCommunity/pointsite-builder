import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { canonicalize } from '../../src/site-kit/canonicalize';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import { D1DraftRepository } from '../../src/server/repositories/d1';
import { D1LibraryService } from '../../src/server/media/library';
import type { D1DraftAssets } from '../../src/server/media/draft-assets';
import type { DraftRecord } from '../../src/server/repositories/contracts';

// Local D1 emulator evidence, not provider billing or Worker CPU evidence.
const actor = 'editorial-workload@pointatx.org';
const workload = {
  drafts: 12,
  mediaEntriesPerDraft: 100,
  startingRevisions: 800,
  actionsPerDay: 400,
  retryFraction: 0.1,
  retentionDays: 90,
  mediaBudgetBytes: 100_000_000,
  databaseBudgetBytes: 350_000_000,
};

function meterDatabase(database: D1Database) {
  const totals = { queries: 0, rowsRead: 0, rowsWritten: 0 };
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const collect = (result: D1Result) => {
    totals.queries++;
    totals.rowsRead += result.meta.rows_read;
    totals.rowsWritten += result.meta.rows_written;
  };
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, property) {
        if (property === 'bind') return (...values: unknown[]) => wrap(target.bind(...values));
        if (property === 'first')
          return async (column?: string) => {
            const result = await target.all<Record<string, unknown>>();
            collect(result);
            const row = result.results[0];
            if (row && column && !(column in row)) throw new Error('Missing result column');
            return row ? (column ? row[column] : row) : null;
          };
        if (property === 'all' || property === 'run')
          return async () => {
            const result = await target[property]();
            collect(result);
            return result;
          };
        return Reflect.get(target, property) as unknown;
      },
    });
    originals.set(proxy, statement);
    return proxy;
  };
  return {
    totals,
    reset: () => Object.assign(totals, { queries: 0, rowsRead: 0, rowsWritten: 0 }),
    database: new Proxy(database, {
      get(target, property) {
        if (property === 'prepare') return (sql: string) => wrap(target.prepare(sql));
        if (property === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            const results = await target.batch(
              statements.map((item) => originals.get(item) ?? item),
            );
            results.forEach(collect);
            return results;
          };
        return Reflect.get(target, property) as unknown;
      },
    }),
  };
}

const document = structuredClone(defaultSiteDocument);
while (document.media.length < workload.mediaEntriesPerDraft) {
  const index = document.media.length;
  document.media.push({
    id: `00000000-0000-4000-8000-${String(100_000 + index).padStart(12, '0')}`,
    sourcePath: `/assets/workload-${index}.png`,
    alt: `Public synthetic media entry ${index}`,
  });
}

async function fixture(format: 'legacy' | 'compact-v1') {
  const miniflare = new Miniflare({
    compatibilityDate: '2026-09-05',
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { DB: crypto.randomUUID() },
  });
  try {
    const raw = await miniflare.getD1Database('DB');
    for (const migration of (await readdir('migrations'))
      .filter((name) => name.endsWith('.sql'))
      .sort())
      await raw.exec(
        (await readFile(`migrations/${migration}`, 'utf8'))
          .replace(/--[^\n]*/g, '')
          .replace(/\s+/g, ' ')
          .trim(),
      );
    await raw
      .prepare(
        "INSERT INTO user_roles(email,role,active,created_at,updated_at,updated_by) VALUES (?,'editor',1,'fixture','fixture','fixture')",
      )
      .bind(actor)
      .run();
    const meter = meterDatabase(raw);
    const repository = new D1DraftRepository(meter.database, undefined, format);
    const library = new D1LibraryService(meter.database, repository, {} as D1DraftAssets);
    return { miniflare, raw, meter, repository, library };
  } catch (error) {
    await miniflare.dispose();
    throw error;
  }
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function create(f: Fixture, index: number) {
  const draft = await f.repository.createDraft({
    name: `Public workload ${index}`,
    document,
    actor,
    idempotencyKey: crypto.randomUUID(),
    requestId: 'workload-create',
  });
  const checkout = await f.repository.acquireCheckout({
    draftId: draft.id,
    actor,
    clientId: `workload-client-${index}`,
    requestId: 'workload-checkout',
  });
  return { draft, token: checkout.token };
}
async function save(
  f: Fixture,
  session: { draft: DraftRecord; token: string },
  index: number,
  retry = false,
) {
  const changed = structuredClone(session.draft.document);
  changed.pages[0].metadata.description = `Editorial action ${index}: résumé, 教会, 🌿.`;
  if (index % 10 === 0) changed.pages[0].title = `Welcome ${index}`;
  if (index % 50 === 0) changed.media[index % changed.media.length].alt = `Image ${index}`;
  const input = {
    draftId: session.draft.id,
    actor,
    document: changed,
    expectedRevisionId: session.draft.latestRevisionId,
    expectedChecksum: session.draft.revision.checksum,
    checkoutToken: session.token,
    idempotencyKey: crypto.randomUUID(),
    requestId: 'workload-save',
    action: { category: 'text-edit' as const, context: 'page-details' as const },
  };
  session.draft = await f.repository.saveDraft(input);
  if (retry) assert.deepEqual(await f.repository.saveDraft(input), session.draft);
}
async function allocated(database: D1Database) {
  const result = await database.prepare('SELECT 1').all();
  assert(result.meta.size_after > 0, 'Emulator did not report allocated bytes');
  return result.meta.size_after;
}

// The original history-expanding SQL, retained here solely as a measurement baseline.
const legacyHistory = `WITH entries AS (
 SELECT json_extract(item.value,'$.id') AS item_id,r.sequence,r.created_at,
 item.value AS signature,json_extract(item.value,'$.sourcePath') AS source_path
 FROM revisions r,json_each(r.document_json,'$.media') item WHERE r.draft_id=?
 UNION ALL SELECT json_extract(item.value,'$.id'),r.sequence,r.created_at,item.value,NULL
 FROM revisions r,json_each(r.document_json,'$.linkedMedia') item WHERE r.draft_id=?
), changes AS (SELECT *,LAG(signature) OVER (PARTITION BY item_id ORDER BY sequence) AS previous FROM entries)
SELECT 'item' AS kind,item_id,MIN(created_at) AS created_at,
 MAX(CASE WHEN previous IS NULL OR previous<>signature THEN created_at END) AS updated_at,
 NULL AS source_path FROM changes GROUP BY item_id
UNION ALL SELECT DISTINCT 'path',NULL,NULL,NULL,source_path FROM entries WHERE source_path IS NOT NULL`;
const indexedHistory = `SELECT 'item' AS kind,item_id,created_at,updated_at,NULL AS source_path FROM draft_library_history WHERE draft_id=?
UNION ALL SELECT 'path',NULL,NULL,NULL,source_path FROM draft_library_retained_paths WHERE draft_id=?`;

async function measureLibrary() {
  const f = await fixture('legacy');
  try {
    const session = await create(f, 0);
    const samples = [];
    for (let sequence = 2; sequence <= 80; sequence++) {
      await save(f, session, sequence);
      if (sequence !== 8 && sequence !== 80) continue;
      const baseline = await f.raw
        .prepare(legacyHistory)
        .bind(session.draft.id, session.draft.id)
        .all();
      const indexed = await f.raw
        .prepare(indexedHistory)
        .bind(session.draft.id, session.draft.id)
        .all();
      assert.deepEqual(
        baseline.results.map(canonicalize).sort(),
        indexed.results.map(canonicalize).sort(),
      );
      f.meter.reset();
      const listing = await f.library.list(session.draft.id);
      assert(listing.items.length >= workload.mediaEntriesPerDraft);
      assert.equal(f.meter.totals.rowsWritten, 0);
      samples.push({
        revisions: sequence,
        legacyAggregateReads: baseline.meta.rows_read,
        indexedAggregateReads: indexed.meta.rows_read,
        completeLibraryReads: f.meter.totals.rowsRead,
        completeLibraryQueries: f.meter.totals.queries,
      });
    }
    assert.equal(
      samples[0].completeLibraryReads,
      samples[1].completeLibraryReads,
      'Library reads grew with history',
    );
    assert(
      samples[1].indexedAggregateReads <= samples[1].legacyAggregateReads * 0.1,
      'Less than 90% aggregate read reduction',
    );
    return samples;
  } finally {
    await f.miniflare.dispose();
  }
}

async function measureStorage() {
  const f = await fixture('compact-v1');
  try {
    const sessions = [];
    for (let index = 0; index < workload.drafts; index++) sessions.push(await create(f, index));
    for (let index = workload.drafts; index < workload.startingRevisions; index++) {
      await save(f, sessions[index % sessions.length], index);
      if (index % 200 === 0) console.log(JSON.stringify({ phase: 'seed', revisions: index + 1 }));
    }
    const startingBytes = await allocated(f.raw);
    f.meter.reset();
    let maximumSaveAndRetryQueries = 0;
    for (let index = 0; index < workload.actionsPerDay; index++) {
      const before = f.meter.totals.queries;
      await save(
        f,
        sessions[Math.floor(index / 100)],
        workload.startingRevisions + index,
        index % 10 === 0,
      );
      maximumSaveAndRetryQueries = Math.max(
        maximumSaveAndRetryQueries,
        f.meter.totals.queries - before,
      );
      if ((index + 1) % 100 === 0)
        console.log(JSON.stringify({ phase: 'saves', actions: index + 1 }));
    }
    const saveCosts = { ...f.meter.totals };
    const endingBytes = await allocated(f.raw);
    f.meter.reset();
    for (let index = 0; index < 4; index++) await f.library.list(sessions[index].draft.id);
    const libraryCosts = { ...f.meter.totals };
    const bytesPerAction = Math.ceil((endingBytes - startingBytes) / workload.actionsPerDay);
    const projectedDatabaseBytes =
      startingBytes +
      bytesPerAction * workload.actionsPerDay * workload.retentionDays +
      workload.mediaBudgetBytes;
    return {
      startingBytes,
      endingBytes,
      bytesPerAction,
      projectedDatabaseBytes,
      withinStorageBudget: projectedDatabaseBytes <= workload.databaseBudgetBytes,
      saveCosts,
      maximumSaveAndRetryQueries,
      libraryCosts,
      growthDatabaseBytes:
        startingBytes + bytesPerAction * 1600 * workload.retentionDays + workload.mediaBudgetBytes,
    };
  } finally {
    await f.miniflare.dispose();
  }
}

const library = await measureLibrary();
console.log(JSON.stringify({ phase: 'library', samples: library }));
const storage = await measureStorage();
const evidence = {
  kind: 'local-d1-editorial-workload',
  measuredAt: new Date().toISOString(),
  workload,
  library,
  storage,
  limitations:
    'Local emulator row counters and allocated SQLite bytes; Node repository/codec execution. Storage is a linear projection including measured revision, receipt, audit and index growth plus a media reserve. Actual Worker CPU, provider billing, all action distributions, daily observation/dashboard/history/publishing/maintenance and other account consumers remain separate gates.',
};
await mkdir('artifacts', { recursive: true });
await writeFile('artifacts/d1-editorial-workload.json', `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence));
assert(storage.withinStorageBudget, 'Measured reference projection exceeds the database budget');
