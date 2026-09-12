// @vitest-environment node

import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import { D1DraftRepository } from '../../src/server/repositories/d1';
import { ConflictError } from '../../src/server/repositories/memory';

let miniflare: Miniflare;

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
  return { database, repository: new D1DraftRepository(database) };
}

afterEach(async () => {
  await miniflare?.dispose();
});

describe('D1 draft repository', () => {
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
