// @vitest-environment node

import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import type { DraftRepository } from '../../src/server/repositories/contracts';
import { D1DraftRepository } from '../../src/server/repositories/d1';
import { D1PublishJobStore } from '../../src/server/publish/jobs';
import {
  ConflictError,
  InMemoryRepository,
  NotFoundError,
} from '../../src/server/repositories/memory';

const actor = 'editor@pointatx.org';
let miniflare: Miniflare | undefined;

async function d1Fixture() {
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
    const sql = await readFile(`migrations/${migration}`, 'utf8');
    await database.exec(
      sql
        .replace(/--[^\n]*/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    );
  }
  await database
    .prepare(
      "INSERT INTO user_roles(email,role,active,created_at,updated_at,updated_by) VALUES (?,'editor',1,'fixture','fixture','fixture')",
    )
    .bind(actor)
    .run();
  return { database, repository: new D1DraftRepository(database) };
}

async function draftFixture(repository: DraftRepository) {
  const createInput = {
    name: 'Private draft to purge',
    document: structuredClone(defaultSiteDocument),
    actor,
    idempotencyKey: 'purge-create-draft-0001',
    requestId: 'purge-create',
  };
  const draft = await repository.createDraft(createInput);
  const document = structuredClone(draft.document);
  document.site.shortName = 'Private edited contents';
  const saveInput = {
    draftId: draft.id,
    document,
    expectedChecksum: draft.revision.checksum,
    actor,
    idempotencyKey: 'purge-save-draft-00001',
    requestId: 'purge-save',
    action: { category: 'control-change' as const, context: 'site-settings' as const },
  };
  const saved = await repository.saveDraft(saveInput);
  await repository.labelRevision(
    draft.id,
    saved.revision.id,
    'Private revision label',
    actor,
    'label',
  );
  const other = await repository.createDraft({
    ...createInput,
    name: 'Independent draft to retain',
    idempotencyKey: 'purge-other-draft-0001',
    requestId: 'other-create',
  });
  return { draft, saved, other, createInput, saveInput };
}

afterEach(async () => {
  await miniflare?.dispose();
  miniflare = undefined;
});

describe.each(['D1', 'memory'] as const)('%s draft purge isolation', (kind) => {
  async function repositoryFixture(): Promise<DraftRepository> {
    return kind === 'D1' ? (await d1Fixture()).repository : new InMemoryRepository();
  }

  it('freezes archived contents and revokes the entire editing session', async () => {
    const repository = await repositoryFixture();
    const { draft, saved, saveInput } = await draftFixture(repository);
    const checkout = await repository.acquireCheckout({
      draftId: draft.id,
      actor,
      clientId: 'archive-browser-client-0001',
      requestId: 'checkout',
    });
    const history = await repository.listRevisions(draft.id);
    await repository.setDraftStatus(draft.id, 'archived', actor, 'archive');
    expect(await repository.ownedCheckout(actor)).toBeNull();
    await expect(repository.assertCheckout(draft.id, actor, checkout.token)).rejects.toBeInstanceOf(
      ConflictError,
    );
    await expect(repository.saveDraft(saveInput)).rejects.toBeInstanceOf(ConflictError);
    await expect(
      repository.renameDraft(draft.id, 'Changed', actor, 'rename'),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      repository.labelRevision(draft.id, saved.revision.id, 'Changed', actor, 'label'),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(await repository.listRevisions(draft.id)).toEqual(history);
    expect((await repository.getDraft(draft.id)).document).toEqual(saved.document);
  });

  it('retains archived contents, then permanently removes the draft and its history without changing another draft', async () => {
    const repository = await repositoryFixture();
    const { draft, saved, other } = await draftFixture(repository);
    const otherHistory = await repository.listRevisions(other.id);
    const history = await repository.listRevisions(draft.id);

    await repository.setDraftStatus(draft.id, 'archived', actor, 'archive');
    expect((await repository.getDraft(draft.id)).document).toEqual(saved.document);
    expect(await repository.listRevisions(draft.id)).toEqual(history);

    const deleted = await repository.purgeDraft(draft.id, actor, 'purge');
    expect('document' in (deleted ?? {})).toBe(false);
    expect('revision' in (deleted ?? {})).toBe(false);
    await expect(repository.getDraft(draft.id)).rejects.toBeInstanceOf(NotFoundError);
    for (const revision of history) {
      await expect(repository.getRevision(revision.id)).rejects.toBeInstanceOf(NotFoundError);
    }
    expect(await repository.listDrafts('deleted')).toEqual([]);
    expect(await repository.getDraft(other.id)).toEqual(other);
    expect(await repository.listRevisions(other.id)).toEqual(otherHistory);
  });

  it('cannot return deleted contents through cached create or save responses', async () => {
    const repository = await repositoryFixture();
    const { draft, other, createInput, saveInput } = await draftFixture(repository);
    await repository.setDraftStatus(draft.id, 'archived', actor, 'archive');
    await repository.purgeDraft(draft.id, actor, 'purge');

    expect(
      await repository.saveDraft(saveInput).then(
        () => 'returned deleted contents',
        (error: unknown) => error instanceof NotFoundError,
      ),
    ).toBe(true);
    expect(
      await repository.createDraft(createInput).then(
        () => 'returned deleted contents',
        (error: unknown) => error instanceof ConflictError,
      ),
    ).toBe(true);
    await expect(repository.getDraft(draft.id)).rejects.toBeInstanceOf(NotFoundError);
    expect(await repository.getDraft(other.id)).toEqual(other);
  });
});

it('blocks purge during publication, then preserves completed publication receipts while purging preflights', async () => {
  const { database, repository } = await d1Fixture();
  const { draft, saved } = await draftFixture(repository);
  const jobs = new D1PublishJobStore(database);
  const job = await jobs.create({
    idempotencyKey: 'purge-publish-job-0001',
    candidateChecksum: 'a'.repeat(64),
    candidate: {
      draftId: draft.id,
      revisionId: saved.revision.id,
      revisionChecksum: saved.revision.checksum,
    },
    baseSha: 'b'.repeat(40),
    actor,
    requestId: 'publish',
  });
  await database
    .prepare(
      `INSERT INTO publish_preflights
     (id,idempotency_key,draft_id,revision_id,revision_checksum,renderer_contract_checksum,status,failure_code,requested_by,requested_at,completed_at)
     VALUES (?,?,?,?,?,?,'failed','PREFLIGHT_FAILED',?,?,?)`,
    )
    .bind(
      crypto.randomUUID(),
      'purge-preflight-0001',
      draft.id,
      saved.revision.id,
      saved.revision.checksum,
      'c'.repeat(64),
      actor,
      new Date().toISOString(),
      new Date().toISOString(),
    )
    .run();
  await repository.setDraftStatus(draft.id, 'archived', actor, 'archive');
  await expect(repository.purgeDraft(draft.id, actor, 'purge-busy')).rejects.toBeInstanceOf(
    ConflictError,
  );
  expect((await repository.getDraft(draft.id)).status).toBe('archived');
  await repository.setDraftStatus(draft.id, 'active', actor, 'recover');
  await jobs.markRunning(job.id, actor, 'running');
  await repository.setDraftStatus(draft.id, 'archived', actor, 'rearchive');
  await expect(repository.purgeDraft(draft.id, actor, 'purge-running')).rejects.toBeInstanceOf(
    ConflictError,
  );
  await jobs.succeed(job.id, actor, 'published', {
    sha: 'd'.repeat(40),
    url: 'https://staging.example.test',
  });
  const receipt = await jobs.getById(job.id);
  await repository.purgeDraft(draft.id, actor, 'purge');
  expect(await jobs.getById(job.id)).toEqual(receipt);
  expect(
    await database
      .prepare('SELECT COUNT(*) AS count FROM publish_preflights WHERE draft_id=?')
      .bind(draft.id)
      .first<number>('count'),
  ).toBe(0);
  const tombstones = await database
    .prepare(
      'SELECT status_code,response_json,expires_at FROM idempotency_keys WHERE actor=? AND idempotency_key IN (?,?)',
    )
    .bind(actor, 'purge-create-draft-0001', 'purge-save-draft-00001')
    .all();
  expect(tombstones.results).toEqual([
    { status_code: 410, response_json: '{"deleted":true}', expires_at: '9999-12-31T23:59:59.999Z' },
    { status_code: 410, response_json: '{"deleted":true}', expires_at: '9999-12-31T23:59:59.999Z' },
  ]);
});

it('physically purges D1 contents, labels, editor state, and cached responses for only the deleted draft', async () => {
  const { database, repository } = await d1Fixture();
  const { draft, saved, other } = await draftFixture(repository);
  const checkout = await repository.acquireCheckout({
    draftId: draft.id,
    actor,
    clientId: 'purge-browser-client-0001',
    requestId: 'checkout',
  });
  await repository.touchCheckout(
    {
      draftId: draft.id,
      actor,
      clientId: checkout.clientId,
      token: checkout.token,
      requestId: 'view-state',
    },
    {
      draftId: draft.id,
      panel: 'library',
      pageId: saved.document.pages[0]?.id ?? null,
      selectedElementId: null,
      previewViewport: 'desktop',
      previewZoom: 1,
      scrollPositions: { library: 37 },
      updatedAt: new Date().toISOString(),
    },
  );
  await repository.setDraftStatus(draft.id, 'archived', actor, 'archive');
  await repository.purgeDraft(draft.id, actor, 'purge');

  const count = async (sql: string, id: string) =>
    database.prepare(sql).bind(id).first<number>('count');
  expect(await count('SELECT COUNT(*) AS count FROM drafts WHERE id = ?', draft.id)).toBe(0);
  expect(await count('SELECT COUNT(*) AS count FROM revisions WHERE draft_id = ?', draft.id)).toBe(
    0,
  );
  expect(
    await count(
      'SELECT COUNT(*) AS count FROM revision_labels WHERE revision_id = ?',
      saved.revision.id,
    ),
  ).toBe(0);
  expect(
    await count('SELECT COUNT(*) AS count FROM draft_checkouts WHERE draft_id = ?', draft.id),
  ).toBe(0);
  expect(
    await count('SELECT COUNT(*) AS count FROM editor_view_states WHERE draft_id = ?', draft.id),
  ).toBe(0);
  expect(
    await count(
      'SELECT COUNT(*) AS count FROM idempotency_keys WHERE response_json LIKE ?',
      `%${draft.id}%`,
    ),
  ).toBe(0);
  expect(await count('SELECT COUNT(*) AS count FROM drafts WHERE id = ?', other.id)).toBe(1);
  expect(await count('SELECT COUNT(*) AS count FROM revisions WHERE draft_id = ?', other.id)).toBe(
    1,
  );
  expect(
    await count(
      'SELECT COUNT(*) AS count FROM idempotency_keys WHERE response_json LIKE ?',
      `%${other.id}%`,
    ),
  ).toBe(1);
});
