// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from 'vitest';
import { SqliteDatabase } from '../../server/sqlite';
import { migrateDatabase } from '../../server/migrations';
import { D1DraftRepository } from '../../src/server/repositories/d1';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import { checksumDocument } from '../../src/site-kit/canonicalize';
import { acquireDraftProof } from '../fixtures/draft-proof';
import { legacyFooterDocument } from '../fixtures/legacy-footer';
import { SiteDocumentSchema } from '../../src/site-kit/schema';

test.each(['legacy', 'compact-v1'] as const)(
  'new and legacy drafts get editable footers and preserve edits through %s save and reopen',
  async (format) => {
    const directory = await mkdtemp(join(tmpdir(), 'builder-footer-78-'));
    let database = new SqliteDatabase(join(directory, 'workspace.sqlite'));
    try {
      await migrateDatabase(database, 'migrations');
      let repository = new D1DraftRepository(database, undefined, format);
      const actor = 'footer-fixture@example.com';
      await database
        .prepare(
          "INSERT INTO user_roles(email,role,active,created_at,updated_at,updated_by) VALUES (?,'editor',1,'fixture','fixture','fixture')",
        )
        .bind(actor)
        .run();
      const create = (document: typeof defaultSiteDocument) =>
        repository.createDraft({
          name: 'Footer compatibility',
          document,
          actor,
          idempotencyKey: crypto.randomUUID(),
          requestId: 'fixture',
        });
      const old = await create(legacyFooterDocument());
      expect(old.document).toEqual(defaultSiteDocument);
      const document = defaultSiteDocument;
      const draft = await create(document);
      const changed = structuredClone(document);
      const block = changed.footer![0].items[0].element;
      if (block.type !== 'richText') throw new Error('Expected footer text');
      block.heading = 'Gather with us';
      const saved = await repository.saveDraft({
        draftId: draft.id,
        ...(await acquireDraftProof(repository, draft.id, actor)),
        document: changed,
        actor,
        idempotencyKey: crypto.randomUUID(),
        requestId: 'fixture',
        action: { category: 'text-edit', context: 'page-content' },
      });
      expect(saved.revision.schemaVersion).toBe(11);
      expect(saved.revision.rendererVersion).toBe('11.0.0');
      expect(saved.revision.checksum).toBe(await checksumDocument(changed));
      database.close();
      database = new SqliteDatabase(join(directory, 'workspace.sqlite'));
      repository = new D1DraftRepository(database, undefined, format);
      expect((await repository.getDraft(draft.id)).document).toEqual(changed);
      expect((await repository.getRevision(draft.revision.id)).document).toEqual(document);
      expect((await repository.getDraft(old.id)).document).toEqual(defaultSiteDocument);
      expect(await database.prepare('PRAGMA integrity_check').first('integrity_check')).toBe('ok');
      expect((await database.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    } finally {
      database.close();
      await rm(directory, { recursive: true });
    }
  },
);

test.each(['legacy', 'compact-v1'] as const)(
  'native %s storage edits composed version-12 content without downgrading it',
  async (format) => {
    const directory = await mkdtemp(join(tmpdir(), 'builder-composition-91-'));
    let database = new SqliteDatabase(join(directory, 'workspace.sqlite'));
    try {
      await migrateDatabase(database, 'migrations');
      let repository = new D1DraftRepository(database, undefined, format);
      const actor = 'composition-fixture@example.com';
      await database
        .prepare(
          "INSERT INTO user_roles(email,role,active,created_at,updated_at,updated_by) VALUES (?,'editor',1,'fixture','fixture','fixture')",
        )
        .bind(actor)
        .run();
      const document = structuredClone(defaultSiteDocument);
      const future = SiteDocumentSchema.parse({
        ...document,
        schemaVersion: 12,
        rendererVersion: '12.0.0',
        pages: document.pages.map((page, index) =>
          index === 0
            ? {
                ...page,
                blocks: page.blocks.map((section, sectionIndex) =>
                  sectionIndex === 1
                    ? {
                        ...section,
                        items: [
                          {
                            ...section.items[0],
                            element: {
                              id: crypto.randomUUID(),
                              type: 'composition',
                              name: 'Content group',
                              items: [
                                {
                                  id: crypto.randomUUID(),
                                  span: 12,
                                  align: section.items[0].align,
                                  grid: section.items[0].grid,
                                  layer: 0,
                                  element: {
                                    id: crypto.randomUUID(),
                                    type: 'text',
                                    text: 'Retained content',
                                    style: 'lead',
                                    align: 'left',
                                  },
                                },
                              ],
                            },
                          },
                        ],
                      }
                    : section,
                ),
              }
            : page,
        ),
      });
      const draft = await repository.createDraft({
        name: 'Future import fixture',
        document: future,
        actor,
        idempotencyKey: crypto.randomUUID(),
        requestId: 'fixture',
      });
      database.close();
      database = new SqliteDatabase(join(directory, 'workspace.sqlite'));
      repository = new D1DraftRepository(database, undefined, format);
      expect((await repository.getDraft(draft.id)).document).toEqual(future);
      const proof = await acquireDraftProof(repository, draft.id, actor);
      const save = {
        draftId: draft.id,
        ...proof,
        actor,
        idempotencyKey: crypto.randomUUID(),
        requestId: 'edit',
        action: { category: 'text-edit' as const, context: 'page-content' as const },
      };
      await expect(repository.saveDraft({ ...save, document })).rejects.toThrow('downgraded');
      const edited = structuredClone(future);
      edited.site.shortName = 'Edited composition';
      const saved = await repository.saveDraft({ ...save, document: edited });
      expect((await repository.getDraft(draft.id)).document).toEqual(saved.document);
      expect(await database.prepare('PRAGMA integrity_check').first('integrity_check')).toBe('ok');
    } finally {
      database.close();
      await rm(directory, { recursive: true });
    }
  },
);
