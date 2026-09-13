// @vitest-environment node

import { acquireDraftProof } from '../fixtures/draft-proof';

import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import { checksumDocument } from '../../src/site-kit/canonicalize';
import { D1DraftRepository } from '../../src/server/repositories/d1';
import { ConflictError, InMemoryRepository } from '../../src/server/repositories/memory';
import type { SaveDraftInput } from '../../src/server/repositories/contracts';
import { D1StorageCompaction } from '../../src/server/maintenance/storage-compaction';
import { RetentionService } from '../../src/server/maintenance/retention';
import { D1LibraryProjection } from '../../src/server/media/library-projection';
import { AuthorizationError } from '../../src/server/auth/roles';
import { createApp } from '../../src/server/index';
import type { RevisionSummary } from '../../src/server/repositories/contracts';

let miniflare: Miniflare | undefined;

async function repositoryFixture() {
  miniflare = new Miniflare({
    compatibilityDate: '2026-09-05',
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { DB: crypto.randomUUID() },
  });
  const database = await miniflare.getD1Database('DB');
  for (const migration of (await readdir('migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    // D1's exec helper executes one statement per physical line, so collapse
    // formatted migration SQL while preserving statement delimiters.
    await database.exec(
      (await readFile(`migrations/${migration}`, 'utf8'))
        .replace(/--[^\n]*/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    );
  }
  for (const actor of [
    'editor@pointatx.org',
    'owner@pointatx.org',
    'other@pointatx.org',
    'another@pointatx.org',
  ])
    await database
      .prepare(
        "INSERT INTO user_roles(email,role,active,created_at,updated_at,updated_by) VALUES (?,'editor',1,'fixture','fixture','fixture')",
      )
      .bind(actor)
      .run();
  return { database, repository: new D1DraftRepository(database) };
}

afterEach(async () => {
  vi.useRealTimers();
  await miniflare?.dispose();
  miniflare = undefined;
});

describe('D1 draft repository', () => {
  it('pages and searches retained metadata without reading revision payloads', async () => {
    const { database } = await repositoryFixture();
    const actor = 'editor@pointatx.org';
    const writer = new D1DraftRepository(database, undefined, 'compact-v1');
    const first = await writer.createDraft({
      name: 'History pages',
      document: defaultSiteDocument,
      actor,
      idempotencyKey: crypto.randomUUID(),
      requestId: 'create',
    });
    const labeled = await writer.labelRevision(
      first.id,
      first.latestRevisionId,
      'Oldest named revision',
      actor,
      'label',
      await acquireDraftProof(writer, first.id, actor),
    );
    const ids = [first.latestRevisionId];
    // Imported public fixture history. Listing must not fetch or decode its documents.
    for (let sequence = 2; sequence <= 205; sequence++) {
      const id = crypto.randomUUID();
      await database
        .prepare(
          `INSERT INTO revisions(id,draft_id,sequence,parent_revision_id,checksum,document_json,schema_version,renderer_version,created_by,created_at)
        SELECT ?,draft_id,?,?,checksum,?,schema_version,renderer_version,created_by,created_at FROM revisions WHERE id=?`,
        )
        .bind(
          id,
          sequence,
          ids.at(-1)!,
          JSON.stringify(defaultSiteDocument),
          first.latestRevisionId,
        )
        .run();
      ids.push(id);
    }
    await database
      .prepare('UPDATE drafts SET latest_revision_id=? WHERE id=?')
      .bind(ids.at(-1)!, first.id)
      .run();
    const queries: string[] = [];
    const metered = new D1DraftRepository({
      prepare: (sql: string) => {
        queries.push(sql);
        if (/revision_payloads|document_json/.test(sql)) throw new Error('Listing read a document');
        return database.prepare(sql);
      },
    } as D1Database);
    const app = createApp({
      repository: metered,
      authenticate: () => Promise.resolve({ email: actor, role: 'viewer' }),
      environment: 'test',
      version: 'test',
    });
    const url = `https://builder.pointatx.org/api/drafts/${first.id}/revisions`;
    const dashboard = await app.request('https://builder.pointatx.org/api/drafts?view=summary');
    expect(dashboard.status).toBe(200);
    const listed = await dashboard.json<{
      items: Array<{ id: string; revision: RevisionSummary }>;
    }>();
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0].id).toBe(first.id);
    expect(listed.items[0]).not.toHaveProperty('document');
    expect(listed.items[0].revision).not.toHaveProperty('document');
    expect(queries).toHaveLength(1);
    queries.length = 0;
    const legacy = await writer.listDrafts();
    expect(legacy[0].document).toEqual(defaultSiteDocument);
    expect(legacy[0].revision.document).toEqual(defaultSiteDocument);
    const get = async (query = '') => {
      const response = await app.request(`${url}${query}`);
      expect(response.status).toBe(200);
      const body = await response.json<{ items: RevisionSummary[]; nextCursor: string | null }>();
      expect(body.items.every((item) => !('document' in item))).toBe(true);
      return body;
    };
    const newest = await get();
    expect(newest.items).toHaveLength(100);
    expect(newest.nextCursor).toBe('106');
    expect(queries).toHaveLength(2);
    const current = await writer.getDraft(first.id);
    const changed = structuredClone(current.document);
    changed.site.shortName = 'New save between pages';
    await writer.saveDraft({
      action: { category: 'text-edit', context: 'site-settings' },
      draftId: first.id,
      document: changed,
      actor,
      ...(await acquireDraftProof(writer, first.id, actor)),
      idempotencyKey: crypto.randomUUID(),
      requestId: 'save',
    });
    const older = await get(`?cursor=${newest.nextCursor}`);
    expect(older.items.map((item) => item.sequence)).toEqual(
      Array.from({ length: 100 }, (_, index) => 105 - index),
    );
    const oldest = await get(`?cursor=${older.nextCursor}`);
    expect(oldest.items.map((item) => item.sequence)).toEqual([5, 4, 3, 2, 1]);
    expect(oldest.nextCursor).toBeNull();
    expect((await get('?query=oldest&filter=named')).items.map((item) => item.id)).toEqual([
      first.latestRevisionId,
    ]);
    expect((await get('?filter=current')).items[0].sequence).toBe(206);
    for (const query of [
      '?cursor=0',
      '?cursor=-1',
      '?cursor=1.5',
      '?cursor=9007199254740992',
      '?filter=invalid',
      `?query=${'a'.repeat(101)}`,
    ])
      expect((await app.request(`${url}${query}`)).status).toBe(422);
    expect((await app.request(url.replace(first.id, crypto.randomUUID()))).status).toBe(404);
    expect(await writer.getRevision(first.latestRevisionId)).toEqual(labeled);
  });

  it('preserves legacy data when conversion is interrupted before commit or a receipt differs', async () => {
    const { database, repository } = await repositoryFixture();
    const actor = 'editor@pointatx.org';
    const draft = await repository.createDraft({
      name: 'Interrupted conversion',
      document: defaultSiteDocument,
      actor,
      idempotencyKey: crypto.randomUUID(),
      requestId: 'create',
    });
    const conversion = new D1StorageCompaction(database);
    const interrupted = new D1StorageCompaction({
      prepare: (sql: string) => database.prepare(sql),
      batch: () => Promise.reject(new Error('Interrupted before commit')),
    } as unknown as D1Database);
    await expect(interrupted.step(actor, 'convert')).rejects.toThrow('Interrupted before commit');
    expect(await conversion.status()).toMatchObject({ revisions: 1, receipts: 1 });
    expect(await database.prepare('SELECT COUNT(*) FROM revision_payloads').first('COUNT(*)')).toBe(
      0,
    );
    expect(await repository.getDraft(draft.id)).toEqual(draft);
    await conversion.step(actor, 'convert');
    await database
      .prepare(
        "UPDATE idempotency_keys SET response_json=json_set(response_json,'$.document.site.shortName','Different receipt')",
      )
      .run();
    const before = await database
      .prepare('SELECT response_json FROM idempotency_keys')
      .first('response_json');
    await expect(conversion.step(actor, 'convert')).rejects.toThrow('RECEIPT_DOCUMENT_MISMATCH');
    expect(
      await database.prepare('SELECT response_json FROM idempotency_keys').first('response_json'),
    ).toBe(before);
    expect(await conversion.status()).toMatchObject({ revisions: 0, receipts: 1 });
  });

  it('does not convert a legacy document whose stored checksum differs', async () => {
    const { database, repository } = await repositoryFixture();
    const draft = await repository.createDraft({
      name: 'Corrupt legacy source',
      document: defaultSiteDocument,
      actor: 'editor@pointatx.org',
      idempotencyKey: crypto.randomUUID(),
      requestId: 'create',
    });
    // Simulate pre-existing corruption, outside the ordinary immutable write path.
    await database.exec('DROP TRIGGER revisions_are_immutable');
    await database
      .prepare('UPDATE revisions SET checksum=? WHERE id=?')
      .bind('0'.repeat(64), draft.latestRevisionId)
      .run();
    const before = await database
      .prepare('SELECT document_json FROM revisions WHERE id=?')
      .bind(draft.latestRevisionId)
      .first('document_json');
    await expect(new D1StorageCompaction(database).step('operator', 'convert')).rejects.toThrow(
      'REVISION_CHECKSUM_MISMATCH',
    );
    expect(
      await database
        .prepare('SELECT document_json FROM revisions WHERE id=?')
        .bind(draft.latestRevisionId)
        .first('document_json'),
    ).toBe(before);
    expect(await database.prepare('SELECT COUNT(*) FROM revision_payloads').first('COUNT(*)')).toBe(
      0,
    );
  });

  it.each(['ahead', 'behind'] as const)(
    'uses the database clock for receipt conversion and replay when JavaScript is %s',
    async (direction) => {
      const { database, repository } = await repositoryFixture();
      const actor = 'editor@pointatx.org';
      const input = {
        name: 'Receipt clock',
        document: defaultSiteDocument,
        actor,
        idempotencyKey: crypto.randomUUID(),
        requestId: 'create',
      };
      const draft = await repository.createDraft(input);
      if (direction === 'behind')
        await database
          .prepare("UPDATE idempotency_keys SET expires_at='2000-01-01T00:00:00.000Z'")
          .run();
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(direction === 'ahead' ? '2100-01-01' : '1900-01-01'));
      const conversion = new D1StorageCompaction(database);
      await conversion.step(actor, 'convert');
      await conversion.step(actor, 'convert');
      if (direction === 'ahead') expect(await repository.createDraft(input)).toEqual(draft);
      else {
        expect(
          await database
            .prepare('SELECT response_json FROM idempotency_keys')
            .first('response_json'),
        ).toBe('{"expired":true}');
        await expect(repository.createDraft(input)).rejects.toThrow('receipt expired');
      }
    },
  );

  it('restarts conversion after lost acknowledgements without changing canonical history or replay', async () => {
    const { database, repository } = await repositoryFixture();
    const actor = 'editor@pointatx.org';
    const create = {
      name: 'Legacy conversion',
      document: defaultSiteDocument,
      actor,
      idempotencyKey: crypto.randomUUID(),
      requestId: 'create',
    };
    const draft = await repository.createDraft(create);
    const checkout = await repository.acquireCheckout({
      draftId: draft.id,
      actor,
      clientId: 'conversion-fixture-client',
      requestId: 'checkout',
    });
    const document = structuredClone(draft.document);
    document.site.shortName = 'Before conversion 🌿';
    const input: SaveDraftInput = {
      draftId: draft.id,
      actor,
      document,
      expectedRevisionId: draft.latestRevisionId,
      expectedChecksum: draft.revision.checksum,
      checkoutToken: checkout.token,
      idempotencyKey: crypto.randomUUID(),
      requestId: 'save',
      action: { category: 'text-edit', context: 'site-settings' },
    };
    const saved = await repository.saveDraft(input);
    const before = await repository.listRevisions(draft.id);
    const conversion = new D1StorageCompaction(database);
    expect(await conversion.status()).toMatchObject({
      state: 'pending',
      revisions: 2,
      receipts: 2,
    });
    let interrupted = false;
    const lostAck = new D1StorageCompaction({
      prepare: (sql: string) => database.prepare(sql),
      batch: async (statements: D1PreparedStatement[]) => {
        const result = await database.batch(statements);
        if (!interrupted) {
          interrupted = true;
          throw new Error('Lost acknowledgement');
        }
        return result;
      },
    } as unknown as D1Database);
    await expect(lostAck.step(actor, 'convert')).rejects.toThrow('Lost acknowledgement');
    expect(await conversion.status()).toMatchObject({ revisions: 1, receipts: 2 });
    for (let count = 0; count < 3; count++)
      expect((await conversion.step(actor, 'convert')).processed).not.toBeNull();
    expect(await conversion.status()).toEqual({ state: 'complete', revisions: 0, receipts: 0 });
    expect(await conversion.step(actor, 'convert')).toEqual({ processed: null });
    expect(await repository.listRevisions(draft.id)).toEqual(before);
    expect(await repository.createDraft(create)).toEqual(draft);
    expect(await repository.saveDraft(input)).toEqual(saved);
    expect(
      await database
        .prepare("SELECT COUNT(*) FROM audit_events WHERE action='revision.storage.compact'")
        .first('COUNT(*)'),
    ).toBe(2);
    expect(
      await database
        .prepare("SELECT COUNT(*) FROM audit_events WHERE action='receipt.storage.compact'")
        .first('COUNT(*)'),
    ).toBe(2);
  });

  it('rejects cross-draft checkpoints, delta chains and gaps of 32 revisions', async () => {
    const { database, repository: bridge } = await repositoryFixture();
    const repository = new D1DraftRepository(database, undefined, 'compact-v1');
    const actor = 'editor@pointatx.org';
    let draft = await repository.createDraft({
      name: 'Checkpoint owner',
      document: defaultSiteDocument,
      actor,
      idempotencyKey: crypto.randomUUID(),
      requestId: 'create',
    });
    const base = draft.latestRevisionId;
    const checkout = await repository.acquireCheckout({
      draftId: draft.id,
      actor,
      clientId: 'checkpoint-fixture-client',
      requestId: 'checkout',
    });
    const save = async (writer: D1DraftRepository, name: string) => {
      const document = structuredClone(draft.document);
      document.site.shortName = name;
      draft = await writer.saveDraft({
        draftId: draft.id,
        actor,
        document,
        expectedRevisionId: draft.latestRevisionId,
        expectedChecksum: draft.revision.checksum,
        checkoutToken: checkout.token,
        idempotencyKey: crypto.randomUUID(),
        requestId: 'save',
        action: { category: 'text-edit', context: 'site-settings' },
      });
    };
    await save(repository, 'Delta');
    const delta = draft.latestRevisionId;
    await save(bridge, 'Legacy target');
    const other = await repository.createDraft({
      name: 'Other checkpoint owner',
      document: defaultSiteDocument,
      actor,
      idempotencyKey: crypto.randomUUID(),
      requestId: 'create',
    });
    const payload = await database
      .prepare('SELECT payload FROM revision_payloads WHERE revision_id=?')
      .bind(base)
      .first<number[]>('payload');
    const insert = (target: string, checkpoint: string) =>
      database
        .prepare(
          "INSERT INTO revision_payloads(revision_id,base_revision_id,codec,payload,raw_bytes,prefix_bytes,suffix_bytes) VALUES (?,?,'gzip-splice',?,100,0,0)",
        )
        .bind(target, checkpoint, new Uint8Array(payload!).buffer)
        .run();
    await expect(insert(draft.latestRevisionId, other.latestRevisionId)).rejects.toThrow(
      'invalid revision checkpoint',
    );
    await expect(insert(draft.latestRevisionId, delta)).rejects.toThrow(
      'invalid revision checkpoint',
    );
    const distant = crypto.randomUUID();
    await database
      .prepare(
        'INSERT INTO revisions(id,draft_id,sequence,parent_revision_id,checksum,document_json,schema_version,renderer_version,created_by,created_at) SELECT ?,draft_id,33,NULL,checksum,document_json,schema_version,renderer_version,created_by,created_at FROM revisions WHERE id=?',
      )
      .bind(distant, draft.latestRevisionId)
      .run();
    await expect(insert(distant, base)).rejects.toThrow('invalid revision checkpoint');
  });

  it('replays compact receipts exactly, pins their source revisions and tombstones them on purge', async () => {
    const { database, repository: bridge } = await repositoryFixture();
    const repository = new D1DraftRepository(database, undefined, 'compact-v1');
    const actor = 'editor@pointatx.org';
    const create = {
      name: 'Original receipt name',
      document: defaultSiteDocument,
      actor,
      idempotencyKey: crypto.randomUUID(),
      requestId: 'create',
    };
    const draft = await repository.createDraft(create);
    const checkout = await repository.acquireCheckout({
      draftId: draft.id,
      actor,
      clientId: 'compact-receipt-client',
      requestId: 'checkout',
    });
    const document = structuredClone(draft.document);
    document.site.shortName = 'First change';
    const input: SaveDraftInput = {
      draftId: draft.id,
      actor,
      document,
      expectedRevisionId: draft.latestRevisionId,
      expectedChecksum: draft.revision.checksum,
      checkoutToken: checkout.token,
      idempotencyKey: crypto.randomUUID(),
      requestId: 'save',
      action: { category: 'text-edit', context: 'site-settings' },
    };
    const saved = await repository.saveDraft(input);
    const proof = {
      expectedRevisionId: saved.latestRevisionId,
      expectedChecksum: saved.revision.checksum,
      checkoutToken: checkout.token,
    };
    await repository.renameDraft(draft.id, 'Later name', actor, 'rename', proof);
    await repository.labelRevision(
      draft.id,
      saved.latestRevisionId,
      'Later label',
      actor,
      'label',
      proof,
    );
    expect(await bridge.saveDraft(input)).toEqual(saved);
    expect(await bridge.createDraft(create)).toEqual(draft);
    const noop: SaveDraftInput = { ...input, ...proof, idempotencyKey: crypto.randomUUID() };
    const acknowledged = await repository.saveDraft(noop);
    const next = structuredClone(document);
    next.site.shortName = 'Second change';
    const advanced = await repository.saveDraft({
      ...noop,
      document: next,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(await bridge.saveDraft(noop)).toEqual(acknowledged);
    await expect(repository.saveDraft({ ...input, document: next })).rejects.toBeInstanceOf(
      ConflictError,
    );
    await expect(
      database.prepare('DELETE FROM revisions WHERE id=?').bind(advanced.latestRevisionId).run(),
    ).rejects.toThrow('retained by request receipt');
    const rows = await database
      .prepare(
        "SELECT response_version,length(response_json) AS bytes,json_extract(response_json,'$.document') AS document,json_extract(response_json,'$.revision.document') AS nested_document FROM idempotency_keys",
      )
      .all<{ response_version: number; bytes: number; document: null; nested_document: null }>();
    for (const row of rows.results) {
      expect(row.response_version).toBe(2);
      expect(row.bytes).toBeLessThan(2000);
      expect(row.document).toBeNull();
      expect(row.nested_document).toBeNull();
    }
    await repository.setDraftStatus(
      draft.id,
      'archived',
      actor,
      'archive',
      await acquireDraftProof(repository, draft.id, actor),
    );
    await repository.purgeDraft(
      draft.id,
      actor,
      'purge',
      await acquireDraftProof(repository, draft.id, actor),
    );
    await expect(bridge.createDraft(create)).rejects.toThrow('permanently deleted');
    await expect(bridge.saveDraft(input)).rejects.toThrow('not found');
    const tombstones = await database
      .prepare('SELECT response_json FROM idempotency_keys')
      .all<{ response_json: string }>();
    expect(tombstones.results.every((row) => row.response_json === '{"deleted":true}')).toBe(true);
  });

  it('reads mixed formats, bounds checkpoint dependencies, rebuilds projections and purges compact history', async () => {
    const { database, repository: bridge } = await repositoryFixture();
    const repository = new D1DraftRepository(database, undefined, 'compact-v1');
    const actor = 'editor@pointatx.org';
    const original = await bridge.createDraft({
      name: 'Mixed storage',
      document: defaultSiteDocument,
      actor,
      idempotencyKey: crypto.randomUUID(),
      requestId: 'create',
    });
    let draft = original;
    const checkout = await repository.acquireCheckout({
      draftId: draft.id,
      actor,
      clientId: 'compact-fixture-client',
      requestId: 'checkout',
    });
    for (let index = 0; index < 35; index++) {
      const document = structuredClone(draft.document);
      document.site.shortName = `Unicode ${index}: 🌿`;
      draft = await repository.saveDraft({
        draftId: draft.id,
        document,
        actor,
        expectedRevisionId: draft.latestRevisionId,
        expectedChecksum: draft.revision.checksum,
        checkoutToken: checkout.token,
        idempotencyKey: crypto.randomUUID(),
        requestId: 'save',
        action: { category: 'text-edit', context: 'site-settings' },
      });
      expect((await bridge.getDraft(draft.id)).document).toEqual(document);
    }
    const payloads = await database
      .prepare(
        `SELECT r.sequence,p.codec,p.base_revision_id,b.sequence AS base_sequence FROM revision_payloads p JOIN revisions r ON r.id=p.revision_id LEFT JOIN revisions b ON b.id=p.base_revision_id ORDER BY r.sequence`,
      )
      .all<{
        sequence: number;
        codec: string;
        base_revision_id: string | null;
        base_sequence: number | null;
      }>();
    expect(
      payloads.results.filter((row) => row.codec === 'gzip').map((row) => row.sequence),
    ).toEqual([2, 34]);
    for (const row of payloads.results.filter((row) => row.codec === 'gzip-splice'))
      expect(row.sequence - row.base_sequence!).toBeLessThan(32);
    const firstBase = payloads.results.find((row) => row.base_revision_id)?.base_revision_id;
    await database
      .prepare(
        "UPDATE idempotency_keys SET expires_at='2000-01-01T00:00:00.000Z' WHERE json_extract(response_json,'$.latestRevisionId')=?",
      )
      .bind(firstBase)
      .run();
    await expect(
      database.prepare('DELETE FROM revisions WHERE id=?').bind(firstBase).run(),
    ).rejects.toThrow('FOREIGN KEY');
    await expect(
      database
        .prepare('UPDATE revision_payloads SET payload=? WHERE revision_id=?')
        .bind(new Uint8Array([1]).buffer, draft.latestRevisionId)
        .run(),
    ).rejects.toThrow('immutable');
    expect(await bridge.listRevisions(draft.id)).toHaveLength(36);
    const restored = await bridge.restoreRevision({
      draftId: draft.id,
      revisionId: original.latestRevisionId,
      actor,
      expectedRevisionId: draft.latestRevisionId,
      expectedChecksum: draft.revision.checksum,
      checkoutToken: checkout.token,
      idempotencyKey: crypto.randomUUID(),
      requestId: 'restore',
    });
    expect(restored.document).toEqual(original.document);
    await database
      .prepare('DELETE FROM draft_library_projection WHERE draft_id=?')
      .bind(draft.id)
      .run();
    const projection = new D1LibraryProjection(database);
    let processed = 0;
    for (;;) {
      const step = await projection.backfill(draft.id);
      processed += step.processed;
      if (!step.processed) break;
    }
    expect(processed).toBe(37);
    await expect(projection.requireCoverage(draft.id, restored.revision.sequence)).resolves.toEqual(
      expect.any(String),
    );
    await database
      .prepare("UPDATE idempotency_keys SET expires_at='2000-01-01T00:00:00.000Z'")
      .run();
    const retention = new RetentionService(database, { delete: () => Promise.resolve() });
    const plan = await retention.plan(new Date('2027-12-01T00:00:00.000Z'));
    expect(plan.report.revisionsToDelete).toBe(33);
    for (const row of plan.export.revisions)
      expect(await checksumDocument(JSON.parse(row.document_json))).toBe(row.checksum);
    await retention.apply(plan, plan.exportChecksum, actor, 'retention');
    expect(await bridge.listRevisions(draft.id)).toHaveLength(4);
    await expect(
      projection.requireCoverage(draft.id, restored.revision.sequence),
    ).rejects.toThrow();
    expect((await projection.backfill(draft.id)).processed).toBe(4);
    await expect(projection.requireCoverage(draft.id, restored.revision.sequence)).resolves.toEqual(
      expect.any(String),
    );
    await repository.setDraftStatus(
      draft.id,
      'archived',
      actor,
      'archive',
      await acquireDraftProof(repository, draft.id, actor),
    );
    await repository.purgeDraft(
      draft.id,
      actor,
      'purge',
      await acquireDraftProof(repository, draft.id, actor),
    );
    expect(
      await database.prepare('SELECT COUNT(*) AS count FROM revision_payloads').first('count'),
    ).toBe(0);
    await expect(bridge.getDraft(draft.id)).rejects.toThrow('not found');
  }, 30_000);

  it('rolls back compact writes before ownership migration completes and fails closed on missing payloads', async () => {
    const { database } = await repositoryFixture();
    const repository = new D1DraftRepository(database, undefined, 'compact-v1');
    const actor = 'editor@pointatx.org';
    const input = {
      name: 'Compact guard',
      document: defaultSiteDocument,
      actor,
      idempotencyKey: crypto.randomUUID(),
      requestId: 'create',
    };
    await database.prepare("UPDATE draft_asset_migration SET state='pending' WHERE id=1").run();
    await expect(repository.createDraft(input)).rejects.toThrow('migration incomplete');
    expect(await database.prepare('SELECT COUNT(*) AS count FROM drafts').first('count')).toBe(0);
    expect(await database.prepare('SELECT COUNT(*) AS count FROM revisions').first('count')).toBe(
      0,
    );
    await database.prepare("UPDATE draft_asset_migration SET state='complete' WHERE id=1").run();
    const draft = await repository.createDraft(input);
    await database
      .prepare('DELETE FROM revision_payloads WHERE revision_id=?')
      .bind(draft.latestRevisionId)
      .run();
    await expect(repository.getDraft(draft.id)).rejects.toThrow('REVISION_PAYLOAD_MISSING');
  });

  it.each(['save', 'touch', 'release', 'assert'])(
    'rejects a token replaced during hashing in the memory model (%s)',
    async (operation) => {
      const repository = new InMemoryRepository();
      const actor = 'editor@pointatx.org';
      const draft = await repository.createDraft({
        name: 'Token rotation race',
        document: defaultSiteDocument,
        actor,
        idempotencyKey: 'hash-create-00001',
        requestId: 'create',
      });
      const input = {
        draftId: draft.id,
        actor,
        clientId: 'hash-client-00001',
        requestId: 'checkout',
      };
      const checkout = await repository.acquireCheckout(input);
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      let rotated = false;
      const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, bytes) => {
        const result = await digest(algorithm, bytes);
        if (!rotated && new TextDecoder().decode(bytes) === checkout.token) {
          rotated = true;
          await repository.acquireCheckout(input);
        }
        return result;
      });
      try {
        const execute = () => {
          if (operation === 'assert')
            return repository.assertCheckout(draft.id, actor, checkout.token);
          if (operation === 'touch')
            return repository.touchCheckout({ ...input, token: checkout.token });
          if (operation === 'release')
            return repository.releaseCheckout({ ...input, token: checkout.token });
          return repository.saveDraft({
            draftId: draft.id,
            actor,
            document: draft.document,
            expectedChecksum: draft.revision.checksum,
            expectedRevisionId: draft.latestRevisionId,
            checkoutToken: checkout.token,
            idempotencyKey: 'hash-save-0000001',
            requestId: 'save',
            action: { category: 'undo', context: 'page-content' },
          });
        };
        await expect(execute()).rejects.toBeInstanceOf(ConflictError);
        expect(rotated).toBe(true);
        expect(await repository.ownedCheckout(actor)).not.toBeNull();
        expect(
          repository.auditEvents.filter((event) => event.action === 'draft.save'),
        ).toHaveLength(0);
      } finally {
        spy.mockRestore();
      }
    },
  );

  it.each(['label', 'rename', 'archive', 'unarchive', 'purge'] as const)(
    'rejects a changed revision or expired or superseded lease at metadata commit (%s)',
    async (operation) => {
      const { database, repository } = await repositoryFixture();
      const actor = 'editor@pointatx.org';
      for (const race of ['revision', 'expiry', 'token'] as const) {
        const draft = await repository.createDraft({
          name: 'Metadata authority',
          document: defaultSiteDocument,
          actor,
          idempotencyKey: crypto.randomUUID(),
          requestId: 'create',
        });
        if (operation === 'unarchive' || operation === 'purge')
          await repository.setDraftStatus(
            draft.id,
            'archived',
            actor,
            'archive',
            await acquireDraftProof(repository, draft.id, actor),
          );
        const proof = await acquireDraftProof(repository, draft.id, actor);
        const before = await repository.getDraft(draft.id);
        const counts = () =>
          database
            .prepare(
              `SELECT (SELECT COUNT(*) FROM revisions) AS revisions, (SELECT COUNT(*) FROM revision_labels) AS labels, (SELECT COUNT(*) FROM audit_events) AS audits`,
            )
            .first();
        const beforeCounts = await counts();
        const delayed = new D1DraftRepository({
          prepare: (sql: string) => database.prepare(sql),
          batch: async (statements: D1PreparedStatement[]) => {
            if (race === 'revision')
              await database
                .prepare('UPDATE drafts SET latest_revision_id=NULL WHERE id=?')
                .bind(draft.id)
                .run();
            if (race === 'expiry')
              await database
                .prepare(
                  "UPDATE draft_checkouts SET expires_at='2000-01-01T00:00:00.000Z' WHERE draft_id=?",
                )
                .bind(draft.id)
                .run();
            if (race === 'token')
              await database
                .prepare('UPDATE draft_checkouts SET token_hash=? WHERE draft_id=?')
                .bind('f'.repeat(64), draft.id)
                .run();
            try {
              return await database.batch(statements);
            } finally {
              if (race === 'revision')
                await database
                  .prepare('UPDATE drafts SET latest_revision_id=? WHERE id=?')
                  .bind(draft.latestRevisionId, draft.id)
                  .run();
            }
          },
        } as unknown as D1Database);
        const execute = () => {
          if (operation === 'label')
            return delayed.labelRevision(
              draft.id,
              draft.latestRevisionId,
              'Denied',
              actor,
              'label',
              proof,
            );
          if (operation === 'rename')
            return delayed.renameDraft(draft.id, 'Denied', actor, 'rename', proof);
          if (operation === 'purge') return delayed.purgeDraft(draft.id, actor, 'purge', proof);
          return delayed.setDraftStatus(
            draft.id,
            operation === 'archive' ? 'archived' : 'active',
            actor,
            'status',
            proof,
          );
        };
        await expect(execute()).rejects.toBeInstanceOf(ConflictError);
        expect(await repository.getDraft(draft.id)).toEqual(before);
        expect(await counts()).toEqual(beforeCounts);
      }
    },
  );

  it.each(['create', 'save', 'no-op', 'label', 'rename', 'archive', 'purge', 'touch'])(
    'rejects role revocation at the committing boundary (%s)',
    async (operation) => {
      const { database, repository } = await repositoryFixture();
      const actor = 'editor@pointatx.org';
      const draft = await repository.createDraft({
        name: 'Current role',
        document: defaultSiteDocument,
        actor,
        idempotencyKey: 'role-create-00001',
        requestId: 'create',
      });
      const checkout = await repository.acquireCheckout({
        draftId: draft.id,
        actor,
        clientId: 'role-client-00001',
        requestId: 'checkout',
      });
      if (operation === 'purge')
        await repository.setDraftStatus(
          draft.id,
          'archived',
          actor,
          'archive',
          await acquireDraftProof(repository, draft.id, actor),
        );
      const proof =
        operation === 'purge'
          ? await acquireDraftProof(repository, draft.id, actor)
          : {
              expectedRevisionId: draft.latestRevisionId,
              expectedChecksum: draft.revision.checksum,
              checkoutToken: checkout.token,
            };
      const counts = () =>
        database
          .prepare(
            `SELECT (SELECT COUNT(*) FROM drafts) AS drafts,
        (SELECT COUNT(*) FROM revisions) AS revisions, (SELECT COUNT(*) FROM revision_labels) AS labels,
        (SELECT COUNT(*) FROM audit_events) AS audits, (SELECT COUNT(*) FROM idempotency_keys) AS receipts`,
          )
          .first();
      const before = await counts();
      const delayed = new D1DraftRepository({
        prepare: (sql: string) => database.prepare(sql),
        batch: async (statements: D1PreparedStatement[]) => {
          await database.prepare('UPDATE user_roles SET active=0 WHERE email=?').bind(actor).run();
          return database.batch(statements);
        },
      } as unknown as D1Database);
      const document = structuredClone(draft.document);
      if (operation === 'save') document.site.shortName = 'Denied after revocation';
      const execute = () => {
        if (operation === 'create')
          return delayed.createDraft({
            name: 'Denied create',
            document,
            actor,
            idempotencyKey: 'role-create-00002',
            requestId: 'create',
          });
        if (operation === 'label')
          return delayed.labelRevision(
            draft.id,
            draft.latestRevisionId,
            'Denied label',
            actor,
            'label',
            proof,
          );
        if (operation === 'rename')
          return delayed.renameDraft(draft.id, 'Denied rename', actor, 'rename', proof);
        if (operation === 'archive')
          return delayed.setDraftStatus(draft.id, 'archived', actor, 'archive', proof);
        if (operation === 'purge') return delayed.purgeDraft(draft.id, actor, 'purge', proof);
        if (operation === 'touch')
          return delayed.touchCheckout({
            draftId: draft.id,
            actor,
            clientId: checkout.clientId,
            token: checkout.token,
            requestId: 'touch',
          });
        return delayed.saveDraft({
          draftId: draft.id,
          actor,
          document,
          expectedChecksum: draft.revision.checksum,
          expectedRevisionId: draft.latestRevisionId,
          checkoutToken: checkout.token,
          idempotencyKey: 'role-save-0000001',
          requestId: 'save',
          action: { category: 'control-change', context: 'site-settings' },
        });
      };
      await expect(execute()).rejects.toBeInstanceOf(AuthorizationError);
      expect(await counts()).toEqual(before);
      expect((await repository.getDraft(draft.id)).document).toEqual(draft.document);
    },
  );

  it.each(['D1', 'memory'])(
    'only resumes the same active client without extending its lease (%s)',
    async (kind) => {
      const repository =
        kind === 'D1' ? (await repositoryFixture()).repository : new InMemoryRepository();
      const actor = 'editor@pointatx.org';
      const draft = await repository.createDraft({
        name: 'Resume authority',
        document: defaultSiteDocument,
        actor,
        idempotencyKey: 'resume-create-0001',
        requestId: 'create',
      });
      const input = {
        draftId: draft.id,
        actor,
        clientId: 'resume-client-0001',
        requestId: 'checkout',
        now: '2026-09-12T12:00:00.000Z',
      };
      const resume = { ...input, resumeOnly: true };
      await expect(repository.acquireCheckout(resume)).rejects.toBeInstanceOf(ConflictError);
      const first = await repository.acquireCheckout(input);
      const resumed = await repository.acquireCheckout({
        ...resume,
        now: '2026-09-12T12:10:00.000Z',
      });
      expect(resumed).toMatchObject({
        event: 'resumed',
        clientId: input.clientId,
        expiresAt: first.expiresAt,
        lastActivityAt: first.lastActivityAt,
      });
      expect(resumed.token).not.toBe(first.token);
      await expect(
        repository.assertCheckout(draft.id, actor, first.token, input.now),
      ).rejects.toBeInstanceOf(ConflictError);
      await expect(
        repository.acquireCheckout({ ...resume, clientId: 'resume-client-0002' }),
      ).rejects.toBeInstanceOf(ConflictError);
      await expect(
        repository.acquireCheckout({ ...resume, actor: 'another@pointatx.org' }),
      ).rejects.toBeInstanceOf(ConflictError);
      await expect(
        repository.acquireCheckout({ ...resume, now: first.expiresAt }),
      ).rejects.toBeInstanceOf(ConflictError);
      const transferred = await repository.acquireCheckout({
        ...input,
        clientId: 'resume-client-0002',
      });
      expect(transferred.event).toBe('transferred');
      await expect(repository.acquireCheckout(resume)).rejects.toBeInstanceOf(ConflictError);
      await repository.assertCheckout(draft.id, actor, transferred.token, input.now);
    },
  );

  it.each([false, true])(
    'checks the database clock when committing a save (changed=%s)',
    async (changed) => {
      const { database, repository } = await repositoryFixture();
      const actualNow = Date.now();
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(actualNow - 60_000);
      const actor = 'editor@pointatx.org';
      const draft = await repository.createDraft({
        name: 'Expiry at commit',
        document: defaultSiteDocument,
        actor,
        idempotencyKey: 'expiry-create-0001',
        requestId: 'create',
      });
      const checkout = await repository.acquireCheckout({
        draftId: draft.id,
        actor,
        clientId: 'expiry-client-0001',
        requestId: 'checkout',
      });
      const delayed = new D1DraftRepository({
        prepare: (sql: string) => database.prepare(sql),
        batch: async (statements: D1PreparedStatement[]) => {
          await database
            .prepare('UPDATE draft_checkouts SET expires_at=? WHERE draft_id=?')
            .bind(new Date(actualNow - 1_000).toISOString(), draft.id)
            .run();
          return database.batch(statements);
        },
      } as unknown as D1Database);
      const document = structuredClone(draft.document);
      if (changed) document.site.shortName = 'Must not commit after expiry';
      await expect(
        delayed.saveDraft({
          draftId: draft.id,
          actor,
          document,
          expectedChecksum: draft.revision.checksum,
          expectedRevisionId: draft.latestRevisionId,
          checkoutToken: checkout.token,
          idempotencyKey: 'expiry-save-00001',
          requestId: 'save',
          action: { category: 'control-change', context: 'site-settings' },
        }),
      ).rejects.toBeInstanceOf(ConflictError);
      expect(await repository.listRevisions(draft.id)).toHaveLength(1);
      expect(
        await database
          .prepare("SELECT COUNT(*) AS count FROM idempotency_keys WHERE scope='draft.save'")
          .first('count'),
      ).toBe(0);
    },
  );

  it('persists passive view changes without renewing checkout or rewriting identical context', async () => {
    const { database, repository } = await repositoryFixture();
    const actor = 'editor@pointatx.org';
    const draft = await repository.createDraft({
      name: 'Passive context',
      document: defaultSiteDocument,
      actor,
      idempotencyKey: 'passive-create-001',
      requestId: 'create',
    });
    const now = '2026-09-12T12:00:00.000Z';
    const owned = await repository.acquireCheckout({
      draftId: draft.id,
      actor,
      clientId: 'passive-browser-001',
      requestId: 'checkout',
      now,
    });
    const command = {
      draftId: draft.id,
      actor,
      clientId: owned.clientId,
      token: owned.token,
      requestId: 'context',
      now: '2026-09-12T12:10:00.000Z',
      activity: false,
    };
    const context = {
      draftId: draft.id,
      panel: 'library' as const,
      pageId: null,
      selectedElementId: null,
      previewViewport: 'desktop' as const,
      previewZoom: 1,
      scrollPositions: { first: 1, second: 2 },
      updatedAt: now,
    };
    const saved = await repository.touchCheckout(command, context);
    expect(saved.expiresAt).toBe(owned.expiresAt);
    expect(saved.lastActivityAt).toBe(owned.lastActivityAt);
    const batches = vi.fn((statements: D1PreparedStatement[]) => database.batch(statements));
    const measured = new D1DraftRepository({
      prepare: (sql: string) => database.prepare(sql),
      batch: batches,
    } as unknown as D1Database);
    const repeated = await measured.touchCheckout(
      { ...command, now: '2026-09-12T12:20:00.000Z' },
      { ...context, scrollPositions: { second: 2, first: 1 }, updatedAt: command.now },
    );
    expect(repeated.viewState).toEqual(saved.viewState);
    const batchResult = await (batches.mock.results.at(-1)!.value as Promise<D1Result[]>);
    expect(batchResult.at(-1)?.meta.changes).toBe(0);
    expect(repeated.expiresAt).toBe(owned.expiresAt);
    const active = await repository.touchCheckout({ ...command, activity: true });
    expect(active.expiresAt).toBe('2026-09-12T12:40:00.000Z');
    await expect(
      repository.touchCheckout({ ...command, clientId: 'wrong-browser-001' }, context),
    ).rejects.toBeInstanceOf(ConflictError);
    expect((await repository.ownedCheckout(actor, command.now))?.viewState).toEqual(
      saved.viewState,
    );
  });

  it('cannot write a no-op receipt after checkout transfers between read and commit', async () => {
    const { database, repository } = await repositoryFixture();
    const actor = 'editor@pointatx.org';
    const draft = await repository.createDraft({
      name: 'No-op transfer',
      document: defaultSiteDocument,
      actor,
      idempotencyKey: 'noop-transfer-create',
      requestId: 'create',
    });
    const owned = await repository.acquireCheckout({
      draftId: draft.id,
      actor,
      clientId: 'noop-transfer-first',
      requestId: 'checkout',
    });
    const read = repository.getDraft.bind(repository);
    vi.spyOn(repository, 'getDraft').mockImplementationOnce(async (id) => {
      const current = await read(id);
      await repository.acquireCheckout({
        draftId: draft.id,
        actor,
        clientId: 'noop-transfer-second',
        requestId: 'transfer',
      });
      return current;
    });
    await expect(
      repository.saveDraft({
        draftId: draft.id,
        expectedRevisionId: draft.revision.id,
        expectedChecksum: draft.revision.checksum,
        document: draft.document,
        actor,
        idempotencyKey: 'noop-transfer-save',
        requestId: 'save',
        action: { category: 'control-change', context: 'site-settings' },
        checkoutToken: owned.token,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(
      await database
        .prepare("SELECT COUNT(*) AS count FROM idempotency_keys WHERE scope='draft.save'")
        .first('count'),
    ).toBe(0);
    expect(await repository.listRevisions(draft.id)).toHaveLength(1);
  });

  it.each(['d1', 'memory'])(
    '%s does not renew a lease for delayed saves or receipt replay',
    async (kind) => {
      const repository =
        kind === 'd1' ? (await repositoryFixture()).repository : new InMemoryRepository();
      const actor = 'editor@pointatx.org';
      const draft = await repository.createDraft({
        name: 'Delayed save',
        document: defaultSiteDocument,
        actor,
        idempotencyKey: 'delayed-create-0001',
        requestId: 'create',
      });
      const owned = await repository.acquireCheckout({
        draftId: draft.id,
        actor,
        clientId: 'delayed-browser-01',
        requestId: 'checkout',
        now: new Date(Date.now() - 60_000).toISOString(),
      });
      const input: SaveDraftInput = {
        draftId: draft.id,
        expectedRevisionId: draft.revision.id,
        expectedChecksum: draft.revision.checksum,
        document: {
          ...draft.document,
          site: { ...draft.document.site, shortName: 'Delayed action' },
        },
        actor,
        idempotencyKey: 'delayed-save-000001',
        requestId: 'save',
        action: { category: 'control-change', context: 'site-settings' },
        checkoutToken: owned.token,
      };
      await repository.saveDraft(input);
      await repository.saveDraft(input);
      expect(await repository.ownedCheckout(actor)).toMatchObject({
        expiresAt: owned.expiresAt,
        lastActivityAt: owned.lastActivityAt,
      });
    },
  );

  it.each(['d1', 'memory'])(
    '%s binds retries to the complete request before checking the latest revision',
    async (kind) => {
      const repository =
        kind === 'd1' ? (await repositoryFixture()).repository : new InMemoryRepository();
      const create = {
        name: 'Receipts',
        document: defaultSiteDocument,
        actor: 'editor@pointatx.org',
        idempotencyKey: 'receipt-create-00001',
        requestId: 'create',
      };
      const draft = await repository.createDraft(create);
      await expect(repository.createDraft({ ...create, name: 'Different' })).rejects.toBeInstanceOf(
        ConflictError,
      );
      const checkout = await repository.acquireCheckout({
        draftId: draft.id,
        actor: create.actor,
        clientId: 'receipt-browser-01',
        requestId: 'checkout',
      });
      const input: SaveDraftInput = {
        draftId: draft.id,
        expectedRevisionId: draft.revision.id,
        expectedChecksum: draft.revision.checksum,
        document: { ...draft.document, site: { ...draft.document.site, shortName: 'Saved once' } },
        actor: create.actor,
        idempotencyKey: 'receipt-save-000001',
        requestId: 'save',
        action: { category: 'control-change', context: 'site-settings' },
        checkoutToken: checkout.token,
      };
      const saved = await repository.saveDraft(input);
      expect(await repository.saveDraft({ ...input, requestId: 'retry' })).toEqual(saved);
      for (const altered of [
        { ...input, document: draft.document },
        { ...input, label: 'Another label' },
        { ...input, expectedRevisionId: saved.revision.id },
        { ...input, action: { category: 'undo' as const, context: 'site-settings' as const } },
      ])
        await expect(repository.saveDraft(altered)).rejects.toBeInstanceOf(ConflictError);
      const restored = await repository.saveDraft({
        ...input,
        document: draft.document,
        expectedRevisionId: saved.revision.id,
        expectedChecksum: saved.revision.checksum,
        idempotencyKey: 'receipt-return-00001',
      });
      expect(restored.revision.checksum).toBe(draft.revision.checksum);
      await expect(
        repository.saveDraft({ ...input, idempotencyKey: 'receipt-aba-test-001' }),
      ).rejects.toBeInstanceOf(ConflictError);
      expect(await repository.saveDraft(input)).toEqual(saved);
      await repository.acquireCheckout({
        draftId: draft.id,
        actor: create.actor,
        clientId: 'receipt-browser-02',
        requestId: 'transfer',
      });
      await expect(repository.saveDraft(input)).rejects.toBeInstanceOf(ConflictError);
      expect(await repository.listRevisions(draft.id)).toHaveLength(3);
    },
  );

  it('persists a no-op receipt and returns the same result after another save', async () => {
    const { database, repository } = await repositoryFixture();
    const actor = 'editor@pointatx.org';
    const draft = await repository.createDraft({
      name: 'No-op',
      document: defaultSiteDocument,
      actor,
      idempotencyKey: 'noop-create-00001',
      requestId: 'create',
    });
    const input: SaveDraftInput = {
      draftId: draft.id,
      expectedRevisionId: draft.revision.id,
      expectedChecksum: draft.revision.checksum,
      document: draft.document,
      actor,
      checkoutToken: (
        await repository.acquireCheckout({
          draftId: draft.id,
          actor,
          clientId: 'receipt-fixture-001',
          requestId: 'checkout',
        })
      ).token,
      idempotencyKey: 'noop-save-000001',
      requestId: 'noop',
      action: { category: 'control-change', context: 'site-settings' },
    };
    expect(await repository.saveDraft(input)).toEqual(draft);
    expect(await repository.listRevisions(draft.id)).toHaveLength(1);
    expect(
      await database
        .prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action='draft.save'")
        .first('count'),
    ).toBe(0);
    const receipt = await database
      .prepare(
        'SELECT created_at,expires_at,request_version FROM idempotency_keys WHERE idempotency_key=?',
      )
      .bind(input.idempotencyKey)
      .first<{ created_at: string; expires_at: string; request_version: number }>();
    expect(receipt?.request_version).toBe(2);
    expect(Date.parse(receipt!.expires_at) - Date.parse(receipt!.created_at)).toBe(90 * 86_400_000);
    await repository.saveDraft({
      ...input,
      idempotencyKey: 'noop-next-save-0001',
      document: { ...draft.document, site: { ...draft.document.site, shortName: 'Next' } },
    });
    expect(await repository.saveDraft(input)).toEqual(draft);
    await database
      .prepare('UPDATE idempotency_keys SET expires_at=? WHERE idempotency_key=?')
      .bind('2000-01-01T00:00:00.000Z', input.idempotencyKey)
      .run();
    await expect(repository.saveDraft(input)).rejects.toThrow('expired');
  });

  it('returns one committed result to simultaneous identical saves', async () => {
    const { database, repository } = await repositoryFixture();
    const actor = 'editor@pointatx.org';
    const create = {
      name: 'Simultaneous',
      document: defaultSiteDocument,
      actor,
      idempotencyKey: 'parallel-create-001',
      requestId: 'create',
    };
    const [draft, repeatedCreate] = await Promise.all([
      repository.createDraft(create),
      repository.createDraft(create),
    ]);
    expect(repeatedCreate).toEqual(draft);
    expect(await repository.listDrafts()).toHaveLength(1);
    const input: SaveDraftInput = {
      draftId: draft.id,
      expectedRevisionId: draft.revision.id,
      expectedChecksum: draft.revision.checksum,
      document: { ...draft.document, site: { ...draft.document.site, shortName: 'Exactly once' } },
      actor,
      checkoutToken: (
        await repository.acquireCheckout({
          draftId: draft.id,
          actor,
          clientId: 'receipt-fixture-001',
          requestId: 'checkout',
        })
      ).token,
      idempotencyKey: 'parallel-save-0001',
      requestId: 'save',
      action: { category: 'control-change', context: 'site-settings' },
    };
    const results = await Promise.all([repository.saveDraft(input), repository.saveDraft(input)]);
    expect(results[0]).toEqual(results[1]);
    expect(await repository.listRevisions(draft.id)).toHaveLength(2);
    expect(
      await database
        .prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action='draft.save'")
        .first('count'),
    ).toBe(1);
    // A pre-upgrade receipt still replays its original hash contract safely.
    const legacyHash = await checksumDocument({
      draftId: input.draftId,
      expectedChecksum: input.expectedChecksum,
      document: input.document,
      action: input.action,
    });
    await database
      .prepare(
        'UPDATE idempotency_keys SET request_version=1,request_hash=? WHERE idempotency_key=?',
      )
      .bind(legacyHash, input.idempotencyKey)
      .run();
    expect(await repository.saveDraft(input)).toEqual(results[0]);
    await expect(
      repository.saveDraft({ ...input, label: 'Altered legacy request' }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('repeated renames change only display metadata and audit while preserving revisions and checkout', async () => {
    const { database, repository } = await repositoryFixture();
    const draft = await repository.createDraft({
      name: 'Original',
      document: defaultSiteDocument,
      actor: 'editor@pointatx.org',
      idempotencyKey: 'rename-d1-create',
      requestId: 'create',
    });
    const acquired = await repository.acquireCheckout({
      draftId: draft.id,
      actor: 'editor@pointatx.org',
      clientId: 'rename-browser-01',
      requestId: 'checkout',
    });
    const revisions = await repository.listRevisions(draft.id);
    const checkout = await repository.ownedCheckout('editor@pointatx.org');
    for (const name of ['Renamed once', 'Renamed twice']) {
      const renamed = await repository.renameDraft(
        draft.id,
        name,
        'editor@pointatx.org',
        'rename',
        {
          expectedRevisionId: draft.latestRevisionId,
          expectedChecksum: draft.revision.checksum,
          checkoutToken: acquired.token,
        },
      );
      expect(renamed).toEqual({ ...draft, name, updatedAt: renamed.updatedAt });
      expect(await repository.getDraft(draft.id)).toEqual(renamed);
      expect(await repository.listRevisions(draft.id)).toEqual(revisions);
      expect(await repository.ownedCheckout('editor@pointatx.org')).toEqual(checkout);
    }
    expect(
      await database
        .prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action = 'draft.rename'")
        .first('count'),
    ).toBe(2);
  });

  it('atomically acquires, transfers, expires, persists view state, and rejects stale tokens', async () => {
    const { repository } = await repositoryFixture();
    const created = await repository.createDraft({
      name: 'Checked out',
      document: defaultSiteDocument,
      actor: 'owner@pointatx.org',
      idempotencyKey: 'create-checkout-draft',
      requestId: 'create-checkout',
    });
    const now = '2026-09-08T12:00:00.000Z';
    const first = await repository.acquireCheckout({
      draftId: created.id,
      actor: 'owner@pointatx.org',
      clientId: 'owner-browser-0001',
      requestId: 'acquire-1',
      now,
    });
    await expect(
      repository.acquireCheckout({
        draftId: created.id,
        actor: 'other@pointatx.org',
        clientId: 'other-browser-0001',
        requestId: 'denied-1',
        now,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    const transferred = await repository.acquireCheckout({
      draftId: created.id,
      actor: 'owner@pointatx.org',
      clientId: 'owner-browser-0002',
      requestId: 'transfer-1',
      now,
    });
    expect(transferred.event).toBe('transferred');
    await expect(
      repository.assertCheckout(created.id, 'owner@pointatx.org', first.token, now),
    ).rejects.toBeInstanceOf(ConflictError);
    const viewState = {
      draftId: created.id,
      panel: 'library' as const,
      pageId: created.document.pages[0]?.id ?? null,
      selectedElementId: null,
      previewViewport: 'tablet' as const,
      previewZoom: 1,
      scrollPositions: { library: 120 },
      updatedAt: now,
    };
    const touched = await repository.touchCheckout(
      {
        draftId: created.id,
        actor: 'owner@pointatx.org',
        clientId: 'owner-browser-0002',
        token: transferred.token,
        requestId: 'touch-1',
        now,
      },
      viewState,
    );
    expect(touched.viewState).toMatchObject({
      panel: 'library',
      scrollPositions: { library: 120 },
    });
    const expired = await repository.acquireCheckout({
      draftId: created.id,
      actor: 'other@pointatx.org',
      clientId: 'other-browser-0001',
      requestId: 'after-expiry',
      now: '2026-09-08T12:31:00.000Z',
    });
    expect(expired.event).toBe('acquired');
  });
  it('persists create, list, read, save, label, restore, rename, and lifecycle operations', async () => {
    const { database, repository } = await repositoryFixture();
    const created = await repository.createDraft({
      name: 'D1 draft',
      document: defaultSiteDocument,
      actor: 'editor@pointatx.org',
      idempotencyKey: 'create-d1-draft-001',
      requestId: 'd1-request-1',
    });
    expect((await repository.listDrafts())[0]?.id).toBe(created.id);
    expect(await repository.listDrafts('archived')).toEqual([]);
    expect((await repository.getDraft(created.id)).revision.id).toBe(created.revision.id);
    expect((await repository.getRevision(created.revision.id)).draftId).toBe(created.id);
    expect(
      (
        await repository.createDraft({
          name: 'D1 draft',
          document: defaultSiteDocument,
          actor: 'editor@pointatx.org',
          idempotencyKey: 'create-d1-draft-001',
          requestId: 'd1-request-duplicate',
        })
      ).id,
    ).toBe(created.id);

    const document = structuredClone(created.document);
    document.site.shortName = 'D1 changed';
    const hero = document.pages
      .flatMap((page) => page.blocks)
      .flatMap((section) => section.items)
      .map((placement) => placement.element)
      .find((element) => element.type === 'hero');
    if (!hero || hero.type !== 'hero') throw new Error('Expected a Hero fixture');
    hero.headingWidth.mobile = 73;
    hero.bodyWidth.mobile = 57;
    const saveCheckout = await repository.acquireCheckout({
      draftId: created.id,
      actor: 'editor@pointatx.org',
      clientId: 'repository-fixture-01',
      requestId: 'checkout',
    });
    const saved = await repository.saveDraft({
      draftId: created.id,
      expectedChecksum: created.revision.checksum,
      expectedRevisionId: created.revision.id,
      checkoutToken: saveCheckout.token,
      document,
      actor: 'editor@pointatx.org',
      idempotencyKey: 'save-d1-draft-0001',
      requestId: 'd1-request-2',
      action: { category: 'resize', context: 'element-layout' },
    });
    expect(saved.revision.sequence).toBe(2);
    expect(saved.revision).toMatchObject({
      actionCategory: 'resize',
      actionContext: 'element-layout',
    });
    const savedHero = saved.revision.document.pages
      .flatMap((page) => page.blocks)
      .flatMap((section) => section.items)
      .map((placement) => placement.element)
      .find((element) => element.id === hero.id);
    const reloadedHero = (await repository.getDraft(created.id)).document.pages
      .flatMap((page) => page.blocks)
      .flatMap((section) => section.items)
      .map((placement) => placement.element)
      .find((element) => element.id === hero.id);
    expect(savedHero).toMatchObject({
      headingWidth: { desktop: 100, tablet: 100, mobile: 73 },
      bodyWidth: { desktop: 100, tablet: 100, mobile: 57 },
    });
    expect(reloadedHero).toEqual(savedHero);
    await expect(
      database
        .prepare('UPDATE revisions SET action_context = ? WHERE id = ?')
        .bind('theme', saved.revision.id)
        .run(),
    ).rejects.toThrow('revisions are immutable');
    expect(await repository.listRevisions(created.id)).toHaveLength(2);
    await expect(
      repository.saveDraft({
        draftId: created.id,
        expectedChecksum: created.revision.checksum,
        expectedRevisionId: created.revision.id,
        checkoutToken: saveCheckout.token,
        document,
        actor: 'editor@pointatx.org',
        idempotencyKey: 'stale-d1-draft-001',
        requestId: 'd1-request-3',
        action: { category: 'undo', context: 'page-content' },
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(
      (
        await repository.labelRevision(
          created.id,
          created.revision.id,
          'Original',
          'editor@pointatx.org',
          'd1-request-4',
          {
            expectedRevisionId: saved.latestRevisionId,
            expectedChecksum: saved.revision.checksum,
            checkoutToken: saveCheckout.token,
          },
        )
      ).label,
    ).toBe('Original');
    const restored = await repository.restoreRevision({
      draftId: created.id,
      revisionId: created.revision.id,
      expectedChecksum: saved.revision.checksum,
      expectedRevisionId: saved.revision.id,
      checkoutToken: saveCheckout.token,
      actor: 'editor@pointatx.org',
      idempotencyKey: 'restore-d1-draft-01',
      requestId: 'd1-request-5',
    });
    expect(restored.revision.sequence).toBe(3);
    expect(restored.revision).toMatchObject({
      actionCategory: 'restore',
      actionContext: 'revision-history',
    });
    expect(
      (
        await repository.renameDraft(
          created.id,
          'Renamed D1 draft',
          'editor@pointatx.org',
          'd1-request-6',
          await acquireDraftProof(repository, created.id, 'editor@pointatx.org'),
        )
      ).name,
    ).toBe('Renamed D1 draft');
    expect(
      (
        await repository.setDraftStatus(
          created.id,
          'archived',
          'editor@pointatx.org',
          'd1-request-7',
          await acquireDraftProof(repository, created.id, 'editor@pointatx.org'),
        )
      ).status,
    ).toBe('archived');
    expect(
      (
        await repository.purgeDraft(
          created.id,
          'editor@pointatx.org',
          'd1-request-8',
          await acquireDraftProof(repository, created.id, 'editor@pointatx.org'),
        )
      ).status,
    ).toBe('deleted');
    expect(await repository.listDrafts()).toEqual([]);
    expect(await repository.listDrafts('deleted')).toEqual([]);
  });

  it('allows only one concurrent compare-and-swap revision and leaves no partial audit', async () => {
    const { database, repository } = await repositoryFixture();
    const created = await repository.createDraft({
      name: 'Concurrent draft',
      document: defaultSiteDocument,
      actor: 'editor@pointatx.org',
      idempotencyKey: 'create-concurrent-draft',
      requestId: 'create-concurrent-request',
    });
    const first = structuredClone(created.document);
    first.site.shortName = 'First writer';
    const second = structuredClone(created.document);
    second.site.shortName = 'Second writer';

    const saveCheckout = await repository.acquireCheckout({
      draftId: created.id,
      actor: 'editor@pointatx.org',
      clientId: 'repository-fixture-01',
      requestId: 'checkout',
    });
    const results = await Promise.allSettled([
      repository.saveDraft({
        draftId: created.id,
        expectedChecksum: created.revision.checksum,
        expectedRevisionId: created.revision.id,
        checkoutToken: saveCheckout.token,
        document: first,
        actor: 'editor@pointatx.org',
        idempotencyKey: 'concurrent-save-first',
        requestId: 'concurrent-request-first',
        action: { category: 'text-edit', context: 'site-settings' },
      }),
      repository.saveDraft({
        draftId: created.id,
        expectedChecksum: created.revision.checksum,
        expectedRevisionId: created.revision.id,
        checkoutToken: saveCheckout.token,
        document: second,
        actor: 'editor@pointatx.org',
        idempotencyKey: 'concurrent-save-second',
        requestId: 'concurrent-request-second',
        action: { category: 'text-edit', context: 'site-settings' },
      }),
    ]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    expect(await repository.listRevisions(created.id)).toHaveLength(2);
    const saveAudits = await database
      .prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action = 'draft.save'")
      .first<{ count: number }>();
    expect(saveAudits?.count).toBe(1);
  });
});
