// @vitest-environment node

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import { checksumDocument } from '../../src/site-kit/canonicalize';
import {
  ConflictError,
  InMemoryRepository,
  NotFoundError,
} from '../../src/server/repositories/memory';

const actor = 'editor@pointatx.org';

describe('repository contract', () => {
  it('enforces role, draft, revision, job, approval, audit, and media constraints in SQL', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pointsite-builder-db-'));
    const database = join(directory, 'contract.sqlite');
    try {
      execFileSync('sqlite3', [database], {
        input: readFileSync('migrations/0001_initial.sql', 'utf8'),
      });
      const tables = execFileSync('sqlite3', [database, '.tables'], { encoding: 'utf8' });
      for (const table of [
        'user_roles',
        'drafts',
        'revisions',
        'idempotency_keys',
        'media_assets',
        'publish_jobs',
        'approvals',
        'audit_events',
      ]) {
        expect(tables).toContain(table);
      }
      for (const invalidSql of [
        "INSERT INTO user_roles VALUES ('x@example.com','owner',1,'now','now','x')",
        "INSERT INTO publish_jobs (id,idempotency_key,environment,status,candidate_json,candidate_checksum,repository,base_sha,requested_by,requested_at) VALUES ('1','1234567890123456','staging','unknown','{}',printf('%064d',0),'repo','sha','x','now')",
        "INSERT INTO media_assets VALUES ('1','key','a.jpg','image/jpeg',0,10,10,printf('%064d',0),'alt','ready','x','now',NULL)",
        "INSERT INTO approvals VALUES ('1','unknown',printf('%064d',0),'approved','x',NULL,'now')",
      ]) {
        expect(() => execFileSync('sqlite3', [database, invalidSql], { stdio: 'pipe' })).toThrow();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('creates a draft, immutable initial revision, and audit event atomically', async () => {
    const repository = new InMemoryRepository();
    const created = await repository.createDraft({
      name: 'Fall refresh',
      document: defaultSiteDocument,
      actor,
      idempotencyKey: 'create-fall-refresh-0001',
      requestId: 'request-1',
    });

    expect(created.name).toBe('Fall refresh');
    expect(created.revision.sequence).toBe(1);
    expect(created.revision.createdBy).toBe(actor);
    expect(created.revision).toMatchObject({ actionCategory: 'add', actionContext: 'draft' });
    expect(await repository.listRevisions(created.id)).toHaveLength(1);
    expect(repository.auditEvents).toMatchObject([
      { actor, action: 'draft.create', targetId: created.id, outcome: 'succeeded' },
    ]);

    created.document.pages[0].title = 'Changed outside repository';
    expect((await repository.getDraft(created.id)).document.pages[0].title).toBe('Home');
  });

  it('returns the original result for an idempotent retry', async () => {
    const repository = new InMemoryRepository();
    const input = {
      name: 'Retry-safe draft',
      document: defaultSiteDocument,
      actor,
      idempotencyKey: 'create-retry-safe-0001',
      requestId: 'request-2',
    };
    const first = await repository.createDraft(input);
    const repeated = await repository.createDraft(input);

    expect(repeated.id).toBe(first.id);
    expect(await repository.listDrafts()).toHaveLength(1);
  });

  it('uses compare-and-swap and never overwrites a newer revision', async () => {
    const repository = new InMemoryRepository();
    const created = await repository.createDraft({
      name: 'Concurrent draft',
      document: defaultSiteDocument,
      actor,
      idempotencyKey: 'create-concurrent-0001',
      requestId: 'request-3',
    });
    const updatedDocument = structuredClone(created.document);
    updatedDocument.pages[0].title = 'New homepage';

    const saved = await repository.saveDraft({
      draftId: created.id,
      expectedChecksum: created.revision.checksum,
      document: updatedDocument,
      actor,
      idempotencyKey: 'save-concurrent-0001',
      requestId: 'request-4',
      action: { category: 'text-edit', context: 'page-details' },
    });
    expect(saved.revision).toMatchObject({
      actionCategory: 'text-edit',
      actionContext: 'page-details',
    });
    await expect(
      repository.saveDraft({
        draftId: created.id,
        expectedChecksum: created.revision.checksum,
        document: created.document,
        actor,
        idempotencyKey: 'save-concurrent-stale',
        requestId: 'request-5',
        action: { category: 'undo', context: 'page-content' },
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    expect((await repository.getDraft(created.id)).revision.id).toBe(saved.revision.id);
    expect(await repository.listRevisions(created.id)).toHaveLength(2);
  });

  it('preserves independent Hero widths in the saved revision, checksum, and latest draft', async () => {
    const repository = new InMemoryRepository();
    const created = await repository.createDraft({
      name: 'Hero widths',
      document: defaultSiteDocument,
      actor,
      idempotencyKey: 'create-hero-widths-01',
      requestId: 'hero-widths-create',
    });
    const document = structuredClone(created.document);
    const hero = document.pages
      .flatMap((page) => page.blocks)
      .flatMap((section) => section.items)
      .map((placement) => placement.element)
      .find((element) => element.type === 'hero');
    if (!hero || hero.type !== 'hero') throw new Error('Expected a Hero fixture');
    hero.headingWidth.mobile = 71;
    hero.bodyWidth.mobile = 53;

    const saved = await repository.saveDraft({
      draftId: created.id,
      expectedChecksum: created.revision.checksum,
      document,
      actor,
      idempotencyKey: 'save-hero-widths-01',
      requestId: 'hero-widths-save',
      action: { category: 'resize', context: 'element-layout' },
    });
    const latest = await repository.getDraft(created.id);
    const revision = await repository.getRevision(saved.revision.id);
    const persistedHero = revision.document.pages
      .flatMap((page) => page.blocks)
      .flatMap((section) => section.items)
      .map((placement) => placement.element)
      .find((element) => element.id === hero.id);

    expect(persistedHero).toMatchObject({
      headingWidth: { desktop: 100, tablet: 100, mobile: 71 },
      bodyWidth: { desktop: 100, tablet: 100, mobile: 53 },
    });
    expect(latest.document).toEqual(revision.document);
    expect(revision.checksum).toBe(await checksumDocument(revision.document));
    expect(revision).toMatchObject({
      actionCategory: 'resize',
      actionContext: 'element-layout',
    });
  });

  it('restores old content as a new immutable revision', async () => {
    const repository = new InMemoryRepository();
    const created = await repository.createDraft({
      name: 'Restore draft',
      document: defaultSiteDocument,
      actor,
      idempotencyKey: 'create-restore-0001',
      requestId: 'request-6',
    });
    const changed = structuredClone(created.document);
    changed.site.shortName = 'Changed Point';
    const saved = await repository.saveDraft({
      draftId: created.id,
      expectedChecksum: created.revision.checksum,
      document: changed,
      actor,
      idempotencyKey: 'save-restore-0001',
      requestId: 'request-7',
      action: { category: 'control-change', context: 'site-settings' },
    });

    const restored = await repository.restoreRevision({
      draftId: created.id,
      revisionId: created.revision.id,
      expectedChecksum: saved.revision.checksum,
      actor,
      idempotencyKey: 'restore-0001',
      requestId: 'request-8',
    });
    expect(restored.document.site.shortName).toBe('Point ATX');
    expect(restored.revision.sequence).toBe(3);
    expect(restored.revision.parentRevisionId).toBe(saved.revision.id);
    expect(restored.revision).toMatchObject({
      actionCategory: 'restore',
      actionContext: 'revision-history',
    });
    expect(repository.auditEvents.at(-1)?.metadata).toEqual({
      actionCategory: 'restore',
      actionContext: 'revision-history',
      sequence: 3,
    });
  });

  it('enforces archive, recovery, and permanent deletion transitions', async () => {
    const repository = new InMemoryRepository();
    const created = await repository.createDraft({
      name: 'Lifecycle draft',
      document: defaultSiteDocument,
      actor,
      idempotencyKey: 'create-lifecycle-0001',
      requestId: 'request-9',
    });

    expect(
      (await repository.setDraftStatus(created.id, 'archived', actor, 'request-10')).status,
    ).toBe('archived');
    expect(
      (await repository.setDraftStatus(created.id, 'active', actor, 'request-11')).status,
    ).toBe('active');
    await expect(
      repository.purgeDraft(created.id, actor, 'request-active-delete'),
    ).rejects.toBeInstanceOf(ConflictError);
    await repository.setDraftStatus(created.id, 'archived', actor, 'request-rearchive');
    expect((await repository.purgeDraft(created.id, actor, 'request-12')).status).toBe('deleted');
    expect(await repository.listDrafts()).toEqual([]);
    expect(await repository.listDrafts('deleted')).toEqual([]);
    await expect(
      repository.setDraftStatus(created.id, 'active', actor, 'request-13'),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
