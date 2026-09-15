import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { RetentionService } from '../../src/server/maintenance/retention';
import { prepareRevisionPayload } from '../../src/server/repositories/revision-payloads';
import { canonicalize, checksumDocument } from '../../src/site-kit/canonicalize';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import { D1DraftRepository } from '../../src/server/repositories/d1';
import { D1LibraryService } from '../../src/server/media/library';
import type { D1DraftAssets } from '../../src/server/media/draft-assets';
import type { DraftRecord } from '../../src/server/repositories/contracts';
import { meterDatabase } from '../fixtures/d1-meter';

// Local D1 emulator evidence, not provider billing or Worker CPU evidence.
const actor = 'editorial-workload@pointatx.org';
const workload = {
  drafts: 12,
  mediaEntriesPerDraft: 100,
  startingRevisions: 800,
  actionsPerDay: 400,
  libraryListings: 80,
  dashboardRefreshes: 40,
  historyVisits: 16,
  foregroundChecks: 2700,
  passiveContextChecks: 360,
  retryFraction: 0.1,
  retentionDays: 90,
  mediaBudgetBytes: 100_000_000,
  databaseBudgetBytes: 350_000_000,
};

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
    f.meter.reset();
    const listed = await f.repository.listDraftSummaries();
    assert.equal(listed.length, workload.drafts);
    assert(listed.every((item) => !('document' in item) && !('document' in item.revision)));
    const dashboardCosts = { ...f.meter.totals };
    assert.equal(dashboardCosts.queries, 1);
    f.meter.reset();
    for (let index = 0; index < 4; index++) {
      const history = await f.repository.listRevisions(sessions[index].draft.id);
      assert(history.every((item) => !('document' in item)));
    }
    const historyCosts = { ...f.meter.totals };
    assert.equal(historyCosts.queries, 8);
    f.meter.reset();
    for (let index = 0; index < 4; index++)
      await f.repository.assertCheckout(sessions[index].draft.id, actor, sessions[index].token);
    const observationCosts = { ...f.meter.totals };
    f.meter.reset();
    for (let index = 0; index < 4; index++)
      await f.repository.touchCheckout({
        draftId: sessions[index].draft.id,
        actor,
        clientId: `workload-client-${index}`,
        token: sessions[index].token,
        requestId: 'passive-context',
        activity: false,
      });
    const passiveContextCosts = { ...f.meter.totals };
    assert.equal(passiveContextCosts.rowsWritten, 0);
    f.meter.reset();
    await f.meter.database
      .prepare('SELECT role,active FROM user_roles WHERE email=?')
      .bind(actor)
      .first();
    const authenticationCosts = { ...f.meter.totals };
    const modeledRequests =
      workload.actionsPerDay * (1 + workload.retryFraction) +
      workload.libraryListings +
      workload.dashboardRefreshes +
      workload.historyVisits +
      workload.foregroundChecks +
      workload.passiveContextChecks;
    const editorDay = { queries: 0, rowsRead: 0, rowsWritten: 0, requests: modeledRequests };
    // Scale explicitly counted read-only samples; changed saves/retries were executed in full.
    for (const [cost, count] of [
      [saveCosts, 1],
      [libraryCosts, workload.libraryListings / 4],
      [dashboardCosts, workload.dashboardRefreshes],
      [historyCosts, workload.historyVisits / 4],
      [observationCosts, workload.foregroundChecks / 4],
      [passiveContextCosts, workload.passiveContextChecks / 4],
      [authenticationCosts, modeledRequests],
    ] as const)
      for (const key of ['queries', 'rowsRead', 'rowsWritten'] as const)
        editorDay[key] += cost[key] * count;
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
      dashboardCosts,
      historyCosts,
      observationCosts,
      passiveContextCosts,
      authenticationCosts,
      modeledEditorDay: editorDay,
      growthDatabaseBytes:
        startingBytes + bytesPerAction * 1600 * workload.retentionDays + workload.mediaBudgetBytes,
    };
  } finally {
    await f.miniflare.dispose();
  }
}

async function measureMaintenance() {
  const f = await fixture('compact-v1');
  try {
    await f.raw
      .prepare("UPDATE user_roles SET role='administrator' WHERE email=?")
      .bind(actor)
      .run();
    const session = await create(f, 90);
    for (let sequence = 2; sequence <= 128; sequence++) {
      const changed = structuredClone(document);
      changed.site.shortName = `Retained ${sequence}`;
      const id = crypto.randomUUID();
      const payload = await prepareRevisionPayload(f.raw, {
        id,
        draftId: session.draft.id,
        sequence,
        document: changed,
      });
      await f.raw.batch([
        f.raw
          .prepare(
            `INSERT INTO revisions(id,draft_id,sequence,parent_revision_id,checksum,document_json,schema_version,renderer_version,created_by,created_at)
          SELECT ?,draft_id,?,id,?,'{}',schema_version,renderer_version,created_by,'2025-01-01' FROM revisions WHERE id=?`,
          )
          .bind(id, sequence, await checksumDocument(changed), session.draft.latestRevisionId),
        ...payload.statements,
        f.raw
          .prepare('UPDATE drafts SET latest_revision_id=? WHERE id=?')
          .bind(id, session.draft.id),
      ]);
      session.draft = await f.repository.getDraft(session.draft.id);
    }
    const retention = new RetentionService(f.meter.database);
    f.meter.reset();
    const plan = await retention.plan();
    const dryRun = { ...f.meter.totals };
    assert.equal(plan.export.revisions.length, 6);
    assert.equal(dryRun.rowsWritten, 0);
    f.meter.reset();
    await retention.applyCurrent(plan.exportChecksum, actor, 'measured-retention');
    const apply = { ...f.meter.totals };
    assert(
      apply.queries + 1 < 50,
      'Retention plus authentication exceeds Free statement allowance',
    );
    const current = await f.repository.getDraft(session.draft.id);
    await f.repository.setDraftStatus(current.id, 'archived', actor, 'archive', {
      checkoutToken: session.token,
      expectedRevisionId: current.latestRevisionId,
      expectedChecksum: current.revision.checksum,
    });
    const checkout = await f.repository.acquireCheckout({
      draftId: current.id,
      actor,
      clientId: 'purge-workload-client',
      requestId: 'checkout',
      expectedStatus: 'archived',
    });
    f.meter.reset();
    await f.repository.purgeDraft(current.id, actor, 'measured-purge', {
      checkoutToken: checkout.token,
      expectedRevisionId: current.latestRevisionId,
      expectedChecksum: current.revision.checksum,
    });
    const purge = { ...f.meter.totals };
    assert(purge.queries + 1 < 50, 'Purge plus authentication exceeds Free statement allowance');
    assert(purge.rowsRead < 4_000, 'Purge scanned revision history for each parent deletion');
    assert.equal(
      await f.raw.prepare('SELECT COUNT(*) FROM revision_payloads').first('COUNT(*)'),
      0,
    );
    return {
      startingRevisions: 128,
      retentionRevisions: 6,
      dryRun,
      apply,
      purgeRevisions: 122,
      purge,
    };
  } finally {
    await f.miniflare.dispose();
  }
}

if (process.argv[2] === '--maintenance-only') {
  console.log(JSON.stringify({ kind: 'local-d1-maintenance', ...(await measureMaintenance()) }));
} else {
  const library = await measureLibrary();
  console.log(JSON.stringify({ phase: 'library', samples: library }));
  const maintenance = await measureMaintenance();
  console.log(JSON.stringify({ phase: 'maintenance', ...maintenance }));
  const storage = await measureStorage();
  const evidence = {
    kind: 'local-d1-editorial-workload',
    measuredAt: new Date().toISOString(),
    workload,
    library,
    maintenance,
    storage,
    limitations:
      'Local emulator row counters and allocated SQLite bytes; Node repository/codec execution. Changed saves and retries are executed in full. Editor-day totals scale the declared read-only samples and one measured authentication lookup per modeled request; foreground observation is conservatively every four seconds. Storage is a linear projection including measured revision, receipt, audit and index growth plus a media reserve. Actual Worker CPU, provider billing, broader action distributions, startup and active context writes, publishing, sustained maintenance volume and other account consumers remain separate gates.',
  };
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/d1-editorial-workload.json', `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence));
  assert(storage.withinStorageBudget, 'Measured reference projection exceeds the database budget');
}
