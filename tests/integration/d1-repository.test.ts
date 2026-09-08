// @vitest-environment node

import { readFile } from 'node:fs/promises';
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
  for (const migration of [
    'migrations/0001_initial.sql',
    'migrations/0002_integrity_triggers.sql',
    'migrations/0003_revision_labels.sql',
    'migrations/0008_revision_actions.sql',
  ]) {
    // D1's exec helper executes one statement per physical line, so collapse
    // formatted migration SQL while preserving statement delimiters.
    await database.exec((await readFile(migration, 'utf8')).replace(/\s+/g, ' ').trim());
  }
  return { database, repository: new D1DraftRepository(database) };
}

afterEach(async () => {
  await miniflare?.dispose();
});

describe('D1 draft repository', () => {
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
    const saved = await repository.saveDraft({
      draftId: created.id,
      expectedChecksum: created.revision.checksum,
      document,
      actor: 'editor@pointatx.org',
      idempotencyKey: 'save-d1-draft-0001',
      requestId: 'd1-request-2',
      action: { category: 'text-edit', context: 'page-details' },
    });
    expect(saved.revision.sequence).toBe(2);
    expect(saved.revision).toMatchObject({
      actionCategory: 'text-edit',
      actionContext: 'page-details',
    });
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
      (
        await repository.setDraftStatus(
          created.id,
          'deleted',
          'editor@pointatx.org',
          'd1-request-8',
        )
      ).status,
    ).toBe('deleted');
    expect(await repository.listDrafts()).toEqual([]);
    expect(await repository.listDrafts('deleted')).toHaveLength(1);
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
