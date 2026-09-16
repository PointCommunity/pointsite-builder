// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from 'vitest';
import { SqliteDatabase } from '../../server/sqlite';
import { migrateDatabase } from '../../server/migrations';
import { D1DraftRepository } from '../../src/server/repositories/d1';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import { canonicalize, checksumDocument } from '../../src/site-kit/canonicalize';
import { upgradeNavigation } from '../../src/site-kit/migrations';
import { prepareRevisionPayload } from '../../src/server/repositories/revision-payloads';
import { legacyNavigationDocument } from '../fixtures/legacy-navigation';
import { acquireDraftProof } from '../fixtures/draft-proof';

test.each(['legacy', 'compact-v1'] as const)(
  'activation preserves immutable schema-9 bytes through %s migration, save and reopen',
  async (format) => {
    const directory = await mkdtemp(join(tmpdir(), 'builder-navigation-36-'));
    let database = new SqliteDatabase(join(directory, 'workspace.sqlite'));
    try {
      await migrateDatabase(database, 'migrations');
      let repository = new D1DraftRepository(database, undefined, format);
      const actor = 'navigation-fixture@example.com';
      await database
        .prepare(
          "INSERT INTO user_roles(email,role,active,created_at,updated_at,updated_by) VALUES (?,'editor',1,'fixture','fixture','fixture')",
        )
        .bind(actor)
        .run();
      const old = await repository.createDraft({
        name: 'Legacy navigation',
        document: defaultSiteDocument,
        actor,
        idempotencyKey: crypto.randomUUID(),
        requestId: 'fixture',
      });
      // Import an actual pre-activation revision; createDraft now writes schema 10.
      const legacy = legacyNavigationDocument();
      const legacyId = crypto.randomUUID();
      const legacyChecksum = await checksumDocument(legacy);
      const payload =
        format === 'compact-v1'
          ? await prepareRevisionPayload(database, {
              id: legacyId,
              draftId: old.id,
              sequence: 2,
              document: legacy,
            })
          : { documentJson: canonicalize(legacy), statements: [] };
      await database.batch([
        database
          .prepare(
            `INSERT INTO revisions(id,draft_id,sequence,parent_revision_id,checksum,document_json,schema_version,renderer_version,created_by,created_at)
          VALUES (?,?,2,?,?,?,9,'9.0.0',?,'fixture')`,
          )
          .bind(
            legacyId,
            old.id,
            old.latestRevisionId,
            legacyChecksum,
            payload.documentJson,
            actor,
          ),
        ...payload.statements,
        database
          .prepare('UPDATE drafts SET latest_revision_id=? WHERE id=?')
          .bind(legacyId, old.id),
      ]);
      const storedLegacy = async () => ({
        revision: await database
          .prepare('SELECT * FROM revisions WHERE id=?')
          .bind(legacyId)
          .first(),
        payload: await database
          .prepare('SELECT * FROM revision_payloads WHERE revision_id=?')
          .bind(legacyId)
          .first(),
      });
      const immutableBefore = await storedLegacy();
      const migrated = await repository.getDraft(old.id);
      expect(migrated.document).toEqual(defaultSiteDocument);
      expect(migrated.revision.checksum).toBe(legacyChecksum);
      const changedLegacy = structuredClone(migrated.document);
      changedLegacy.navigationDesigns![0].items[0].label = 'Migrated menu';
      await repository.saveDraft({
        draftId: old.id,
        ...(await acquireDraftProof(repository, old.id, actor)),
        document: changedLegacy,
        actor,
        idempotencyKey: crypto.randomUUID(),
        requestId: 'fixture',
        action: { category: 'text-edit', context: 'navigation' },
      });
      const current = upgradeNavigation(defaultSiteDocument);
      current.navigationDesigns!.push({
        ...structuredClone(current.navigationDesigns![0]),
        id: crypto.randomUUID(),
        name: 'Secondary',
      });
      const designId = current.navigationDesigns![1].id;
      const navigation = current.pages[1].blocks
        .flatMap((section) => section.items)
        .find((item) => item.element.type === 'navigation')!.element;
      if (navigation.type !== 'navigation') throw new Error('Expected navigation');
      navigation.navigationDesignId = designId;
      const draft = await repository.createDraft({
        name: 'Named navigation',
        document: current,
        actor,
        idempotencyKey: crypto.randomUUID(),
        requestId: 'fixture',
      });
      const items = structuredClone(current.navigationDesigns![1].items);
      items[0].label = 'Shared navigation change';
      const updated = structuredClone(current);
      updated.navigationDesigns![1].items = items;
      const saved = await repository.saveDraft({
        draftId: draft.id,
        ...(await acquireDraftProof(repository, draft.id, actor)),
        document: updated,
        actor,
        idempotencyKey: crypto.randomUUID(),
        requestId: 'fixture',
        action: { category: 'text-edit', context: 'navigation' },
      });
      expect(saved.document.navigationDesigns![0]).toEqual(current.navigationDesigns![0]);
      expect(saved.document.pages).toEqual(current.pages);
      expect(saved.revision.checksum).toBe(await checksumDocument(updated));
      database.close();
      database = new SqliteDatabase(join(directory, 'workspace.sqlite'));
      repository = new D1DraftRepository(database, undefined, format);
      expect(canonicalize((await repository.getDraft(old.id)).document)).toBe(
        canonicalize(changedLegacy),
      );
      expect((await repository.getRevision(legacyId)).document).toEqual(defaultSiteDocument);
      expect(await storedLegacy()).toEqual(immutableBefore);
      expect((await repository.getDraft(draft.id)).document).toEqual(updated);
      expect((await repository.getRevision(draft.revision.id)).document).toEqual(current);
      expect((await repository.getRevision(saved.revision.id)).actionContext).toBe('navigation');
      expect(await database.prepare('PRAGMA integrity_check').first('integrity_check')).toBe('ok');
      expect((await database.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    } finally {
      database.close();
      await rm(directory, { recursive: true });
    }
  },
);
