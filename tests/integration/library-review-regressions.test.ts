// @vitest-environment node

import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import { createApp } from '../../src/server/index';
import { D1DraftAssets } from '../../src/server/media/draft-assets';
import { D1LibraryService } from '../../src/server/media/library';
import type { DraftRecord } from '../../src/server/repositories/contracts';
import { D1DraftRepository } from '../../src/server/repositories/d1';
import { ConflictError } from '../../src/server/repositories/memory';

const actor = 'reviewer@pointatx.org';
let miniflare: Miniflare;
let database: D1Database;
let repository: D1DraftRepository;
let library: D1LibraryService;
let draft: DraftRecord;
let token: string;

const image = (width = 32) => {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, 20);
  return { filename: 'review.png', contentType: 'image/png', bytes, altText: 'Review image' };
};
const context = (current: DraftRecord, key = crypto.randomUUID()) => ({
  draftId: current.id,
  expectedChecksum: current.revision.checksum,
  expectedRevisionId: current.revision.id,
  checkoutToken: token,
  idempotencyKey: key,
  actor,
  requestId: key,
});

beforeEach(async () => {
  miniflare = new Miniflare({
    compatibilityDate: '2026-09-05',
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    d1Databases: { DB: crypto.randomUUID() },
  });
  database = await miniflare.getD1Database('DB');
  for (const name of (await readdir('migrations')).filter((name) => name.endsWith('.sql')).sort())
    await database.exec(
      (await readFile(`migrations/${name}`, 'utf8'))
        .replace(/--[^\n]*/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    );
  repository = new D1DraftRepository(database);
  library = new D1LibraryService(
    database,
    repository,
    new D1DraftAssets(database, {
      read: vi.fn().mockRejectedValue(new Error('Unexpected legacy read')),
    }),
  );
  draft = await repository.createDraft({
    name: 'Review draft',
    document: structuredClone(defaultSiteDocument),
    actor,
    idempotencyKey: crypto.randomUUID(),
    requestId: 'create',
  });
  token = (
    await repository.acquireCheckout({
      draftId: draft.id,
      actor,
      clientId: 'review-browser-client',
      requestId: 'checkout',
    })
  ).token;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await miniflare.dispose();
});

it('preserves archived images referenced by section backgrounds, social previews, and people collections', async () => {
  const uploaded = await library.mutate(context(draft), { action: 'upload', image: image() });
  const item = uploaded.library.items.find((entry) => entry.altText === 'Review image');
  if (!item) throw new Error('Uploaded item missing');
  const document = structuredClone(uploaded.draft.document);
  document.pages[0].blocks[0].backgroundMediaId = item.id;
  document.pages[0].metadata.ogImageMediaId = item.id;
  document.collections.people[0].mediaId = item.id;
  const placed = await repository.saveDraft({
    ...context(uploaded.draft),
    document,
    action: { category: 'control-change', context: 'page-content' },
  });
  expect
    .soft((await library.list(draft.id)).items.find((entry) => entry.id === item.id)?.usageCount)
    .toBe(3);
  const archived = await library.mutate(context(placed), { action: 'archive', itemId: item.id });
  expect(archived.draft.document.media.some((entry) => entry.id === item.id)).toBe(true);
  expect(archived.library.items.find((entry) => entry.id === item.id)?.archivedAt).toBeTruthy();
});

it('rejects a duplicate current image when an older replacement version has the same checksum', async () => {
  const uploaded = await library.mutate(context(draft), { action: 'upload', image: image() });
  const item = uploaded.library.items.find((entry) => entry.altText === 'Review image');
  if (!item) throw new Error('Uploaded item missing');
  const replaced = await library.mutate(context(uploaded.draft), {
    action: 'replace',
    itemId: item.id,
    image: image(64),
    metadata: { displayName: 'Replacement', altText: 'Replacement', tags: [] },
  });
  const restoredBytes = await library.mutate(context(replaced.draft), {
    action: 'upload',
    image: image(),
  });
  const rejected = await library
    .mutate(context(restoredBytes.draft), { action: 'upload', image: image() })
    .then(
      () => false,
      (error: unknown) =>
        error instanceof ConflictError && error.message.includes('already exists'),
    );
  expect(rejected).toBe(true);
});

it('rejects duplicate bytes already present through a retained legacy image binding', async () => {
  const document = structuredClone(defaultSiteDocument);
  for (const [index, media] of document.media.entries())
    media.sourcePath = `/assets/legacy-${index}.png`;
  const legacy = await repository.createDraft({
    name: 'Legacy draft',
    document,
    actor,
    idempotencyKey: crypto.randomUUID(),
    requestId: 'legacy-create',
  });
  token = (
    await repository.acquireCheckout({
      draftId: legacy.id,
      actor,
      clientId: 'legacy-review-client',
      requestId: 'checkout',
    })
  ).token;
  const assets = new D1DraftAssets(
    database,
    { read: vi.fn().mockRejectedValue(new Error('Unexpected upload read')) },
    {
      fetch: () =>
        Promise.resolve(new Response(image().bytes, { headers: { 'content-type': 'image/png' } })),
    },
  );
  await assets.materializeLegacyDraft(legacy.id);
  const legacyLibrary = new D1LibraryService(database, repository, assets);
  const rejected = await legacyLibrary
    .mutate(context(legacy), { action: 'upload', image: image() })
    .then(
      () => false,
      (error: unknown) =>
        error instanceof ConflictError && error.message.includes('already exists'),
    );
  expect(rejected).toBe(true);
});

it('accepts a valid 100-character request key without overflowing the stored save key', async () => {
  const app = createApp({
    repository,
    library,
    environment: 'test',
    version: 'test',
    authenticate: () => Promise.resolve({ email: actor, role: 'editor' }),
  });
  const response = await app.request(`https://builder.test/api/drafts/${draft.id}/library/links`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://builder.test',
      'sec-fetch-site': 'same-origin',
      'if-match': `"${draft.revision.checksum}"`,
      'x-draft-revision': draft.revision.id,
      'x-draft-checkout': token,
      'idempotency-key': 'k'.repeat(100),
    },
    body: JSON.stringify({
      mediaType: 'video',
      url: 'https://example.org/review.mp4',
      displayName: 'Review',
      altText: '',
      tags: [],
    }),
  });
  expect(response.status).toBe(201);
});

it('keeps the original owned version associated with its item when replacing imported draft images', async () => {
  const template = {
    fetch: () =>
      Promise.resolve(new Response(image().bytes, { headers: { 'content-type': 'image/png' } })),
  };
  const assets = new D1DraftAssets(
    database,
    { read: vi.fn().mockRejectedValue(new Error('Unexpected legacy read')) },
    template,
  );
  const ownedRepository = new D1DraftRepository(database, assets);
  const document = structuredClone(defaultSiteDocument);
  for (const [index, media] of document.media.entries())
    media.sourcePath = `/assets/review-${index}.png`;
  const owned = await ownedRepository.createDraft({
    name: 'Imported draft',
    document,
    actor,
    idempotencyKey: crypto.randomUUID(),
    requestId: 'import',
  });
  token = (
    await ownedRepository.acquireCheckout({
      draftId: owned.id,
      actor,
      clientId: 'imported-review-client',
      requestId: 'checkout',
    })
  ).token;
  const ownedLibrary = new D1LibraryService(database, ownedRepository, assets);
  const item = owned.document.media[0];
  const original = await database
    .prepare('SELECT asset_id FROM draft_asset_bindings WHERE draft_id=? AND source_path=?')
    .bind(owned.id, item.sourcePath)
    .first<{ asset_id: string }>();
  await ownedLibrary.mutate(context(owned), {
    action: 'replace',
    itemId: item.id,
    image: image(64),
    metadata: { displayName: 'Replacement', altText: 'Replacement', tags: [] },
  });
  expect(
    await database
      .prepare(
        'SELECT COUNT(*) AS count FROM draft_library_asset_versions WHERE draft_id=? AND item_id=? AND asset_id=?',
      )
      .bind(owned.id, item.id, original?.asset_id ?? '')
      .first<number>('count'),
  ).toBe(1);
});

it('rejects an oversized multipart body when Content-Length is absent', async () => {
  const app = createApp({
    repository,
    library,
    environment: 'test',
    version: 'test',
    authenticate: () => Promise.resolve({ email: actor, role: 'editor' }),
  });
  const form = new FormData();
  form.set('file', new File([image().bytes], 'review.png', { type: 'image/png' }));
  form.set('altText', 'Review image');
  form.set('unused', 'x'.repeat(6 * 1024 * 1024));
  const response = await app.request(`https://builder.test/api/drafts/${draft.id}/library/images`, {
    method: 'POST',
    headers: {
      origin: 'https://builder.test',
      'sec-fetch-site': 'same-origin',
      'if-match': `"${draft.revision.checksum}"`,
      'x-draft-revision': draft.revision.id,
      'x-draft-checkout': token,
      'idempotency-key': crypto.randomUUID(),
    },
    body: form,
  });
  expect(response.status).toBe(413);
  expect(
    await database
      .prepare('SELECT COUNT(*) AS count FROM draft_asset_versions')
      .first<number>('count'),
  ).toBe(0);
});

it('rejects a stale metadata update instead of silently undoing a concurrent archive', async () => {
  const uploaded = await library.mutate(context(draft), { action: 'upload', image: image() });
  const item = uploaded.library.items.find((entry) => entry.altText === 'Review image');
  if (!item) throw new Error('Uploaded item missing');
  const document = structuredClone(uploaded.draft.document);
  const placement = document.pages[0].blocks[0].items[0];
  placement.element = {
    id: placement.element.id,
    type: 'image',
    mediaId: item.id,
    alt: 'Review image',
    aspect: 'natural',
    fit: 'cover',
  };
  const placed = await repository.saveDraft({
    ...context(uploaded.draft),
    document,
    action: { category: 'replace', context: 'page-content' },
  });
  let ready!: () => void;
  let resume!: () => void;
  const pendingSave = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const resumeSave = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const save = repository.saveDraft.bind(repository);
  vi.spyOn(repository, 'saveDraft').mockImplementation(async (input, statements, paths) => {
    if (input.action.category === 'control-change') {
      ready();
      await resumeSave;
    }
    return save(input, statements, paths);
  });
  const update = library
    .mutate(context(placed), {
      action: 'update',
      itemId: item.id,
      metadata: { displayName: 'Changed metadata', altText: 'Review image', tags: [] },
    })
    .then(
      () => false,
      (error: unknown) => error instanceof ConflictError,
    );
  await pendingSave;
  try {
    const archived = await library.mutate(context(placed), { action: 'archive', itemId: item.id });
    expect(archived.draft.revision.checksum).toBe(placed.revision.checksum);
  } finally {
    resume();
  }
  expect(await update).toBe(true);
  expect(
    (await library.list(draft.id)).items.find((entry) => entry.id === item.id)?.archivedAt,
  ).toBeTruthy();
});
