// @vitest-environment node
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import { D1DraftRepository } from '../../src/server/repositories/d1';
import { D1DraftAssets } from '../../src/server/media/draft-assets';
import { D1LibraryService } from '../../src/server/media/library';
import { createApp } from '../../src/server';
import type { DraftRecord } from '../../src/server/repositories/contracts';

const actor = 'editor@pointatx.org';
let miniflare: Miniflare;
let database: D1Database;
let repository: D1DraftRepository;
let library: D1LibraryService;
let draft: DraftRecord;
let checkoutToken: string;
const png = (width = 32) => {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, 20);
  return bytes;
};
const context = (current = draft, key = crypto.randomUUID()) => ({
  draftId: current.id,
  expectedRevisionId: current.latestRevisionId,
  expectedChecksum: current.revision.checksum,
  checkoutToken,
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
  const assets = new D1DraftAssets(database, {
    read: vi.fn().mockRejectedValue(new Error('Unexpected legacy read')),
  });
  library = new D1LibraryService(database, repository, assets);
  draft = await repository.createDraft({
    name: 'Isolated Library',
    document: structuredClone(defaultSiteDocument),
    actor,
    idempotencyKey: crypto.randomUUID(),
    requestId: 'create',
  });
  checkoutToken = (
    await repository.acquireCheckout({
      draftId: draft.id,
      actor,
      clientId: 'library-browser-client',
      requestId: 'checkout',
    })
  ).token;
});
afterEach(async () => {
  await miniflare.dispose();
});

it('persists an upload exactly once, scopes its bytes, and rejects key reuse and duplicate files', async () => {
  const command = {
    action: 'upload' as const,
    image: {
      filename: 'New image.png',
      contentType: 'image/png',
      bytes: png(),
      altText: 'New image',
    },
  };
  const input = context();
  const result = await library.mutate(input, command);
  const item = result.library.items.find((item) => item.altText === 'New image')!;
  expect(item.sourcePath).toContain(`/assets/builder/${draft.id}/`);
  expect(item.url).toContain(`/api/drafts/${draft.id}/assets?path=`);
  expect(result.draft.document.media.filter((media) => media.id === item.id)).toHaveLength(1);
  expect(
    (await library.mutate(input, command)).library.items.filter((media) => media.id === item.id),
  ).toHaveLength(1);
  await expect(
    library.mutate(input, { ...command, image: { ...command.image, altText: 'Changed' } }),
  ).rejects.toThrow('request key');
  await expect(library.mutate(context(result.draft), command)).rejects.toThrow('already exists');
  expect(
    await database
      .prepare('SELECT COUNT(*) AS count FROM draft_asset_versions WHERE draft_id=?')
      .bind(draft.id)
      .first('count'),
  ).toBe(1);
});

it('archives unused items, protects retained history, and restores the same identity', async () => {
  const added = await library.mutate(context(), {
    action: 'link',
    link: {
      mediaType: 'image',
      url: 'https://example.org/photo.png',
      displayName: 'Linked photo',
      altText: 'Landscape',
      tags: ['camp'],
    },
  });
  const item = added.library.items.find((item) => item.displayName === 'Linked photo')!;
  const archived = await library.mutate(context(added.draft), {
    action: 'archive',
    itemId: item.id,
  });
  expect(archived.draft.document.linkedMedia.some((entry) => entry.id === item.id)).toBe(false);
  expect(archived.library.items.find((entry) => entry.id === item.id)?.archivedAt).toBeTruthy();
  await expect(
    library.mutate(context(archived.draft), { action: 'delete', itemId: item.id }),
  ).rejects.toThrow('Retained draft revisions');
  const restored = await library.mutate(context(archived.draft), {
    action: 'unarchive',
    itemId: item.id,
  });
  expect(restored.draft.document.linkedMedia.filter((entry) => entry.id === item.id)).toHaveLength(
    1,
  );
});

it('replaces linked images and all placements without changing logical identity or history', async () => {
  const linked = draft.document.linkedMedia.find((item) => item.type === 'image');
  const added = linked
    ? { draft, library: await library.list(draft.id) }
    : await library.mutate(context(), {
        action: 'link',
        link: {
          mediaType: 'image',
          url: 'https://example.org/photo.png',
          displayName: 'Replace me',
          altText: 'Before',
          tags: [],
        },
      });
  const item = linked ?? added.draft.document.linkedMedia.at(-1)!;
  const placedDocument = structuredClone(added.draft.document);
  const placementId = crypto.randomUUID();
  const section = structuredClone(placedDocument.pages[0].blocks[0]);
  section.id = crypto.randomUUID();
  section.items = [
    {
      ...section.items[0],
      id: crypto.randomUUID(),
      element: {
        id: placementId,
        type: 'mediaEmbed',
        linkedMediaId: item.id,
        aspect: 'natural',
        fit: 'contain',
        caption: 'Keep this caption',
      },
    },
  ];
  placedDocument.pages[0].blocks.push(section);
  const placed = await repository.saveDraft({
    ...context(added.draft),
    document: placedDocument,
    action: { category: 'add', context: 'page-content' },
  });
  const original = await repository.getRevision(placed.latestRevisionId);
  const result = await library.mutate(context(placed), {
    action: 'replace',
    itemId: item.id,
    image: {
      filename: 'replacement.png',
      contentType: 'image/png',
      bytes: png(64),
      altText: 'After',
    },
    metadata: { displayName: 'Replacement', altText: 'After', tags: ['new'] },
  });
  expect(result.draft.document.media.find((entry) => entry.id === item.id)?.alt).toBe('After');
  expect(result.draft.document.linkedMedia.some((entry) => entry.id === item.id)).toBe(false);
  expect(await repository.getRevision(original.id)).toEqual(original);
  expect(result.library.items.filter((entry) => entry.id === item.id)).toHaveLength(1);
  expect(
    result.draft.document.pages[0].blocks
      .flatMap((block) => block.items.map((placement) => placement.element))
      .find((element) => element.id === placementId),
  ).toMatchObject({
    type: 'image',
    mediaId: item.id,
    alt: 'After',
    caption: 'Keep this caption',
    aspect: 'natural',
    fit: 'contain',
  });
  const again = await library.mutate(context(result.draft), {
    action: 'replace',
    itemId: item.id,
    image: { filename: 'second.png', contentType: 'image/png', bytes: png(65), altText: 'Second' },
    metadata: { displayName: 'Second', altText: 'Second', tags: [] },
  });
  expect(
    again.draft.document.pages[0].blocks
      .flatMap((block) => block.items.map((placement) => placement.element))
      .find((element) => element.id === placementId),
  ).toMatchObject({ type: 'image', mediaId: item.id, alt: 'Second', caption: 'Keep this caption' });
});

it('rejects stale mutations before any asset bytes or item metadata are written', async () => {
  const latest = await library.mutate(context(), {
    action: 'link',
    link: {
      mediaType: 'video',
      url: 'https://example.org/movie.mp4',
      displayName: 'Video',
      altText: '',
      tags: [],
    },
  });
  await expect(
    library.mutate(context(), {
      action: 'upload',
      image: { filename: 'stale.png', contentType: 'image/png', bytes: png(), altText: 'Stale' },
    }),
  ).rejects.toThrow('newer revision');
  expect(
    await database.prepare('SELECT COUNT(*) AS count FROM draft_asset_versions').first('count'),
  ).toBe(0);
  expect((await repository.getDraft(draft.id)).revision.checksum).toBe(
    latest.draft.revision.checksum,
  );
});

it('purges archived Library rows, operation records and all image versions with the whole draft', async () => {
  const added = await library.mutate(context(), {
    action: 'upload',
    image: { filename: 'private.png', contentType: 'image/png', bytes: png(), altText: 'Private' },
  });
  await repository.setDraftStatus(added.draft.id, 'archived', actor, 'archive');
  await repository.purgeDraft(added.draft.id, actor, 'purge');
  for (const table of ['draft_library_items', 'draft_library_operations', 'draft_asset_versions'])
    expect(await database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first('count')).toBe(0);
  expect(
    await database.prepare('SELECT COUNT(*) AS count FROM draft_asset_chunks').first('count'),
  ).toBe(0);
});

it('returns every item beyond 100 and keeps legacy dates stable after catalog initialization', async () => {
  const document = structuredClone(draft.document);
  for (let index = 0; index < 125; index++)
    document.linkedMedia.push({
      id: crypto.randomUUID(),
      type: 'video',
      url: `https://example.org/${index}.mp4`,
      displayName: `Video ${index}`,
      tags: [],
    });
  const saved = await repository.saveDraft({
    ...context(),
    document,
    action: { category: 'add', context: 'linked-media' },
  });
  const first = await library.list(draft.id);
  expect(first.items.length).toBe(saved.document.media.length + saved.document.linkedMedia.length);
  expect(first.items.length).toBeGreaterThan(100);
  expect((await library.list(draft.id)).items.map((item) => item.createdAt)).toEqual(
    first.items.map((item) => item.createdAt),
  );
});

it('enforces viewer read-only, confirmations and upload policy at the API boundary', async () => {
  const app = createApp({
    repository,
    library,
    environment: 'test',
    version: 'test',
    authenticate: () => Promise.resolve({ email: actor, role: 'viewer', active: true }),
  });
  const response = await app.request(`https://builder.test/api/drafts/${draft.id}/library`);
  expect(response.status).toBe(200);
  const mutation = await app.request(`https://builder.test/api/drafts/${draft.id}/library/links`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://builder.test',
      'if-match': `"${draft.revision.checksum}"`,
      'x-draft-checkout': checkoutToken,
      'idempotency-key': 'viewer-request',
    },
    body: JSON.stringify({}),
  });
  expect(mutation.status).toBe(403);
  await expect(
    library.mutate(context(), {
      action: 'upload',
      image: { filename: 'bad.svg', contentType: 'image/svg+xml', bytes: png(), altText: 'Bad' },
    }),
  ).rejects.toThrow('MEDIA_REJECTED');
});

it('rolls back image bytes, metadata and idempotency when the transaction fails after preparation', async () => {
  const save = repository.saveDraft.bind(repository);
  vi.spyOn(repository, 'saveDraft').mockImplementation((input, statements, paths) =>
    save(
      input,
      [...(statements ?? []), database.prepare("SELECT json('injected-failure')")],
      paths,
    ),
  );
  await expect(
    library.mutate(context(), {
      action: 'upload',
      image: {
        filename: 'rollback.png',
        contentType: 'image/png',
        bytes: png(),
        altText: 'Rollback',
      },
    }),
  ).rejects.toThrow();
  for (const table of [
    'draft_asset_versions',
    'draft_asset_chunks',
    'draft_library_operations',
    'draft_library_asset_versions',
  ])
    expect(await database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first('count')).toBe(0);
  expect((await repository.getDraft(draft.id)).revision.checksum).toBe(draft.revision.checksum);
});

it('requires explicit delete confirmation and refuses video replacement at the server boundary', async () => {
  const app = createApp({
    repository,
    library,
    environment: 'test',
    version: 'test',
    authenticate: () => Promise.resolve({ email: actor, role: 'editor', active: true }),
  });
  const item = (await library.list(draft.id)).items[0];
  const response = await app.request(
    `https://builder.test/api/drafts/${draft.id}/library/items/${item.id}`,
    {
      method: 'DELETE',
      headers: {
        'content-type': 'application/json',
        origin: 'https://builder.test',
        'if-match': `"${draft.revision.checksum}"`,
        'x-draft-checkout': checkoutToken,
        'idempotency-key': 'missing-confirmation',
        'x-draft-revision': draft.latestRevisionId,
        'sec-fetch-site': 'same-origin',
      },
      body: JSON.stringify({ confirmation: false }),
    },
  );
  expect(response.status).toBe(422);
  const video = await library.mutate(context(), {
    action: 'link',
    link: {
      mediaType: 'video',
      url: 'https://example.org/movie.mp4',
      displayName: 'Movie',
      altText: '',
      tags: [],
    },
  });
  const movie = video.library.items.find((entry) => entry.displayName === 'Movie')!;
  await expect(
    library.mutate(context(video.draft), {
      action: 'replace',
      itemId: movie.id,
      image: { filename: 'image.png', contentType: 'image/png', bytes: png(), altText: 'Image' },
      metadata: { displayName: 'Image', altText: 'Image', tags: [] },
    }),
  ).rejects.toThrow('Only active images');
});
