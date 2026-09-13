// @vitest-environment node

import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import { checksumDocument } from '../../src/site-kit/canonicalize';
import { D1DraftRepository } from '../../src/server/repositories/d1';
import { ConflictError, InMemoryRepository } from '../../src/server/repositories/memory';
import type { SaveDraftInput } from '../../src/server/repositories/contracts';
import { AuthorizationError } from '../../src/server/auth/roles';

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
        await repository.setDraftStatus(draft.id, 'archived', actor, 'archive');
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
          );
        if (operation === 'rename')
          return delayed.renameDraft(draft.id, 'Denied rename', actor, 'rename');
        if (operation === 'archive')
          return delayed.setDraftStatus(draft.id, 'archived', actor, 'archive');
        if (operation === 'purge') return delayed.purgeDraft(draft.id, actor, 'purge');
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
    await repository.acquireCheckout({
      draftId: draft.id,
      actor: 'editor@pointatx.org',
      clientId: 'rename-browser-01',
      requestId: 'checkout',
    });
    const revisions = await repository.listRevisions(draft.id);
    const checkout = await repository.ownedCheckout('editor@pointatx.org');
    for (const name of ['Renamed once', 'Renamed twice']) {
      const renamed = await repository.renameDraft(draft.id, name, 'editor@pointatx.org', 'rename');
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
    const saved = await repository.saveDraft({
      draftId: created.id,
      expectedChecksum: created.revision.checksum,
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
        )
      ).label,
    ).toBe('Original');
    const restored = await repository.restoreRevision({
      draftId: created.id,
      revisionId: created.revision.id,
      expectedChecksum: saved.revision.checksum,
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
        )
      ).status,
    ).toBe('archived');
    expect(
      (await repository.purgeDraft(created.id, 'editor@pointatx.org', 'd1-request-8')).status,
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

    const results = await Promise.allSettled([
      repository.saveDraft({
        draftId: created.id,
        expectedChecksum: created.revision.checksum,
        document: first,
        actor: 'editor@pointatx.org',
        idempotencyKey: 'concurrent-save-first',
        requestId: 'concurrent-request-first',
        action: { category: 'text-edit', context: 'site-settings' },
      }),
      repository.saveDraft({
        draftId: created.id,
        expectedChecksum: created.revision.checksum,
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
