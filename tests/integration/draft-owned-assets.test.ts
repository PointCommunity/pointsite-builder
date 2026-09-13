// @vitest-environment node

import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import { D1DraftAssets } from '../../src/server/media/draft-assets';
import { D1MediaRepository, D1PrivateBucket, MediaService } from '../../src/server/media/service';
import { createApp } from '../../src/server/index';
import { D1DraftRepository } from '../../src/server/repositories/d1';
import { ConflictError, NotFoundError } from '../../src/server/repositories/memory';
import { buildCandidate } from '../../src/server/publish/candidate';

const actor = 'editor@pointatx.org';
const png = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aTgAAAABJRU5ErkJggg==',
    'base64',
  ),
);

it('packages more than 100 owned images with two reads and enforces size before loading chunks', async () => {
  const { database, repository, assets, createInput, legacy, template } = await fixture();
  const draft = await repository.createDraft(createInput);
  const seed: D1PreparedStatement[] = [];
  for (let index = 0; index < 101; index++) {
    const image = await assets.prepareImage(draft.id, png, {
      filename: `image-${index}.png`,
      contentType: 'image/png',
      altText: 'Image',
      actor,
    });
    seed.push(...image.statements);
    draft.document.media.push({
      id: crypto.randomUUID(),
      sourcePath: image.sourcePath,
      alt: 'Image',
    });
  }
  await database.batch(seed);
  const prepare = vi.fn((query: string) => database.prepare(query));
  const tracked = new Proxy(database, {
    get: (target, property) =>
      property === 'prepare' ? prepare : (Reflect.get(target, property) as unknown),
  });
  const reader = new D1DraftAssets(tracked, legacy, template);
  const candidate = await buildCandidate(
    draft,
    new MediaService(
      new D1MediaRepository(database),
      new D1PrivateBucket(database),
      undefined,
      reader,
    ),
  );
  expect(candidate.files.length).toBe(104);
  expect(prepare).toHaveBeenCalledTimes(2);
  prepare.mockClear();
  await reader.prepareCreate({
    draftId: crypto.randomUUID(),
    sourceDraftId: draft.id,
    document: draft.document,
    actor,
    now: new Date().toISOString(),
  });
  expect(prepare.mock.calls.filter(([query]) => /^\s*SELECT/.test(query))).toHaveLength(2);
  prepare.mockClear();
  await expect(
    reader.prepareSave({
      draftId: draft.id,
      previousDocument: draft.document,
      document: draft.document,
      actor,
      now: new Date().toISOString(),
    }),
  ).resolves.toEqual([]);
  expect(prepare).toHaveBeenCalledOnce();
  prepare.mockClear();
  await expect(
    reader.readManyForDraft(crypto.randomUUID(), [draft.document.media[0].sourcePath]),
  ).rejects.toBeInstanceOf(NotFoundError);
  expect(prepare).not.toHaveBeenCalled();
  await expect(reader.readManyForDraft(draft.id, ['/assets/missing.png'])).rejects.toBeInstanceOf(
    NotFoundError,
  );
  expect(prepare).toHaveBeenCalledOnce();
  expect(legacy.read).not.toHaveBeenCalled();
  prepare.mockClear();
  for (let index = 0; index < 5; index++) {
    const id = crypto.randomUUID();
    const path = `/assets/builder/${draft.id}/${id}/large.png`;
    await database.batch([
      database
        .prepare(
          'INSERT INTO draft_asset_versions(id,draft_id,source_path,filename,content_type,byte_size,width,height,checksum,created_by,created_at) VALUES (?,?,?,?,?,5242880,1,1,?,?,?)',
        )
        .bind(
          id,
          draft.id,
          path,
          'large.png',
          'image/png',
          'a'.repeat(64),
          actor,
          new Date().toISOString(),
        ),
      database
        .prepare('INSERT INTO draft_asset_bindings(draft_id,source_path,asset_id) VALUES (?,?,?)')
        .bind(draft.id, path, id),
    ]);
    draft.document.media.push({ id: crypto.randomUUID(), sourcePath: path, alt: 'Large' });
  }
  const capped = prepare;
  await expect(
    buildCandidate(
      draft,
      new MediaService(
        new D1MediaRepository(database),
        new D1PrivateBucket(database),
        undefined,
        reader,
      ),
    ),
  ).rejects.toThrow('CANDIDATE_MEDIA_TOO_LARGE');
  expect(capped).toHaveBeenCalledTimes(1);
  expect(capped.mock.calls[0][0]).not.toContain('draft_asset_chunks');
});
let miniflare: Miniflare | undefined;

it('rejects private Builder links in templates and saves before reading storage', async () => {
  const { assets, createInput, legacy, template } = await fixture();
  const document = structuredClone(createInput.document);
  document.linkedMedia = [
    {
      id: crypto.randomUUID(),
      type: 'image',
      url: 'https://builder.pointatx.org/api/drafts/another/assets?path=private',
      displayName: 'Private',
      alternativeText: 'Private image',
      tags: [],
    },
  ];
  const draftId = crypto.randomUUID();
  const now = new Date().toISOString();
  await expect(assets.prepareCreate({ draftId, document, actor, now })).rejects.toThrow(
    'PRIVATE_MEDIA_LINK',
  );
  await expect(
    assets.prepareSave({ draftId, document, previousDocument: createInput.document, actor, now }),
  ).rejects.toThrow('PRIVATE_MEDIA_LINK');
  expect(legacy.read).not.toHaveBeenCalled();
  expect(template.fetch).not.toHaveBeenCalled();
});

async function fixture() {
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
    await database.exec(
      (await readFile(`migrations/${migration}`, 'utf8'))
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
  const template = {
    fetch: vi.fn(() =>
      Promise.resolve(
        new Response(Uint8Array.from(png).buffer, { headers: { 'content-type': 'image/png' } }),
      ),
    ),
  };
  const legacy = { read: vi.fn(() => Promise.reject(new Error('No shared upload'))) };
  const assets = new D1DraftAssets(database, legacy, template);
  const repository = new D1DraftRepository(database, assets);
  const document = structuredClone(defaultSiteDocument);
  for (const item of document.media) item.sourcePath = '/assets/point-logo.png';
  const createInput = {
    name: 'Owned draft',
    document,
    actor,
    idempotencyKey: 'owned-create-draft-0001',
    requestId: 'create',
  };
  return { database, assets, repository, template, legacy, createInput };
}

afterEach(async () => {
  await miniflare?.dispose();
  miniflare = undefined;
  vi.restoreAllMocks();
});

it('reserves aggregate image capacity atomically before accepting any image chunks', async () => {
  const { database, assets, createInput } = await fixture();
  const repository = new D1DraftRepository(database);
  const draft = await repository.createDraft(createInput);
  await database.batch(
    Array.from({ length: 50 }, (_, index) =>
      database
        .prepare(
          `INSERT INTO draft_asset_versions
     (id,draft_id,source_path,filename,content_type,byte_size,width,height,checksum,created_by,created_at)
     VALUES (?,?,?,'reserved.png','image/png',5242880,1,1,?,?,?)`,
        )
        .bind(
          crypto.randomUUID(),
          draft.id,
          `/assets/reserved-${index}.png`,
          'a'.repeat(64),
          actor,
          new Date().toISOString(),
        ),
    ),
  );
  const prepared = await assets.prepareImage(draft.id, png, {
    filename: 'extra.png',
    contentType: 'image/png',
    altText: 'Extra',
    actor,
  });
  await expect(database.batch(prepared.statements)).rejects.toThrow('MEDIA_CAPACITY_EXCEEDED');
  await expect(
    new D1DraftRepository(database, assets).createDraft({
      ...createInput,
      idempotencyKey: 'owned-over-capacity01',
    }),
  ).rejects.toThrow('MEDIA_CAPACITY_EXCEEDED');
  expect(
    await database.prepare('SELECT COUNT(*) AS count FROM drafts').first<number>('count'),
  ).toBe(1);
  expect(
    await database
      .prepare('SELECT COUNT(*) AS count FROM draft_asset_versions')
      .first<number>('count'),
  ).toBe(50);
  expect(
    await database
      .prepare('SELECT COUNT(*) AS count FROM draft_asset_chunks')
      .first<number>('count'),
  ).toBe(0);
});

it('creates physically independent image copies and purges one draft without changing its duplicate', async () => {
  const { database, repository, assets, createInput } = await fixture();
  const source = await repository.createDraft(createInput);
  const duplicate = await repository.createDraft({
    ...createInput,
    document: source.document,
    sourceDraftId: source.id,
    idempotencyKey: 'owned-duplicate-00001',
  });
  const sourcePath = source.document.media[0].sourcePath;
  const duplicatePath = duplicate.document.media[0].sourcePath;
  expect(sourcePath).toMatch(
    new RegExp(`^/assets/builder/${source.id}/[a-f0-9-]+/point-logo\\.png$`),
  );
  expect(duplicatePath).not.toBe(sourcePath);
  expect((await assets.readForDraft(duplicate.id, duplicatePath)).bytes).toEqual(png);
  expect(
    await database
      .prepare('SELECT COUNT(*) AS count FROM draft_asset_chunks')
      .first<number>('count'),
  ).toBe(2);
  await expect(assets.readForDraft(duplicate.id, sourcePath)).rejects.toBeInstanceOf(NotFoundError);
  const tampered = structuredClone(source.document);
  tampered.media[0].sourcePath = duplicatePath;
  await expect(
    repository.saveDraft({
      draftId: source.id,
      expectedChecksum: source.revision.checksum,
      document: tampered,
      actor,
      idempotencyKey: 'owned-invalid-save-01',
      requestId: 'invalid-save',
      action: { category: 'replace', context: 'library-attachment' },
    }),
  ).rejects.toBeInstanceOf(ConflictError);
  await repository.setDraftStatus(source.id, 'archived', actor, 'archive');
  await repository.purgeDraft(source.id, actor, 'purge');
  await expect(assets.readForDraft(source.id, sourcePath)).rejects.toBeInstanceOf(NotFoundError);
  expect((await assets.readForDraft(duplicate.id, duplicatePath)).bytes).toEqual(png);
  expect(
    await database
      .prepare('SELECT COUNT(*) AS count FROM draft_asset_versions WHERE draft_id=?')
      .bind(source.id)
      .first<number>('count'),
  ).toBe(0);
  expect(
    await database
      .prepare('SELECT COUNT(*) AS count FROM draft_asset_chunks')
      .first<number>('count'),
  ).toBe(1);
});

it('copies every bundled default image while preserving the logo basename', async () => {
  const { database, legacy, createInput } = await fixture();
  const assets = new D1DraftAssets(database, legacy, {
    fetch: async (request) => {
      const path = new URL(request instanceof Request ? request.url : String(request)).pathname;
      const bytes = await readFile(`public${path}`);
      return new Response(bytes, {
        headers: { 'content-type': path.endsWith('.png') ? 'image/png' : 'image/jpeg' },
      });
    },
  });
  const repository = new D1DraftRepository(database, assets);
  const draft = await repository.createDraft({ ...createInput, document: defaultSiteDocument });
  expect(draft.document.media).toHaveLength(defaultSiteDocument.media.length);
  expect(draft.document.media.some((item) => item.sourcePath.endsWith('/point-logo.png'))).toBe(
    true,
  );
  for (const item of draft.document.media) {
    const object = await assets.readForDraft(draft.id, item.sourcePath);
    expect(object.bytes.byteLength).toBeGreaterThan(0);
  }
});

it('serves only the requested draft image privately and retires the shared media endpoint', async () => {
  const { database, repository, assets, createInput } = await fixture();
  const draft = await repository.createDraft(createInput);
  const other = await repository.createDraft({
    ...createInput,
    idempotencyKey: 'owned-other-image-001',
  });
  const app = createApp({
    repository,
    media: new MediaService(
      new D1MediaRepository(database),
      new D1PrivateBucket(database),
      undefined,
      assets,
      false,
    ),
    authenticate: () => Promise.resolve({ email: actor, role: 'editor' }),
    environment: 'test',
    version: 'test',
  });
  const query = new URLSearchParams({ path: draft.document.media[0].sourcePath });
  const response = await app.request(
    `https://builder.pointatx.org/api/drafts/${draft.id}/assets?${query}`,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
  expect(
    (await app.request(`https://builder.pointatx.org/api/drafts/${other.id}/assets?${query}`))
      .status,
  ).toBe(404);
  expect((await app.request('https://builder.pointatx.org/api/media')).status).toBe(410);
});

it('commits queued asset writes with a forced revision even when the document checksum is unchanged', async () => {
  const { database, repository, assets, createInput } = await fixture();
  const draft = await repository.createDraft(createInput);
  const prepared = await assets.prepareImage(draft.id, png, {
    filename: 'extra.png',
    contentType: 'image/png',
    altText: 'Extra',
    actor,
  });
  expect(
    await database
      .prepare('SELECT COUNT(*) AS count FROM draft_asset_versions')
      .first<number>('count'),
  ).toBe(1);
  const saved = await repository.saveDraft(
    {
      draftId: draft.id,
      expectedChecksum: draft.revision.checksum,
      document: draft.document,
      actor,
      idempotencyKey: 'owned-metadata-save01',
      requestId: 'save',
      action: { category: 'control-change', context: 'library-attachment' },
    },
    prepared.statements,
    new Set([prepared.sourcePath]),
  );
  expect(saved.revision.sequence).toBe(2);
  expect(saved.revision.checksum).toBe(draft.revision.checksum);
  expect((await assets.readForDraft(draft.id, prepared.sourcePath)).bytes).toEqual(png);
  await repository.setDraftStatus(draft.id, 'archived', actor, 'archive');
  await repository.purgeDraft(draft.id, actor, 'purge');
  expect(
    await database
      .prepare('SELECT COUNT(*) AS count FROM draft_asset_chunks')
      .first<number>('count'),
  ).toBe(0);
});

it('aborts all queued image writes when checkout ownership changes before the transaction commits', async () => {
  const { database, repository, assets, createInput } = await fixture();
  const draft = await repository.createDraft(createInput);
  const checkout = await repository.acquireCheckout({
    draftId: draft.id,
    actor,
    clientId: 'owned-checkout-client1',
    requestId: 'checkout',
  });
  const prepared = await assets.prepareImage(draft.id, png, {
    filename: 'pending.png',
    contentType: 'image/png',
    altText: 'Pending',
    actor,
  });
  const original = assets.prepareSave.bind(assets);
  vi.spyOn(assets, 'prepareSave').mockImplementationOnce(async (input) => {
    await repository.releaseCheckout({
      draftId: draft.id,
      actor,
      clientId: checkout.clientId,
      token: checkout.token,
      requestId: 'release',
    });
    return original(input);
  });
  await expect(
    repository.saveDraft(
      {
        draftId: draft.id,
        expectedChecksum: draft.revision.checksum,
        document: draft.document,
        actor,
        checkoutToken: checkout.token,
        idempotencyKey: 'owned-stale-save-0001',
        requestId: 'stale-save',
        action: { category: 'add', context: 'library-attachment' },
      },
      prepared.statements,
      new Set([prepared.sourcePath]),
    ),
  ).rejects.toBeInstanceOf(ConflictError);
  expect(
    await database
      .prepare('SELECT COUNT(*) AS count FROM draft_asset_versions')
      .first<number>('count'),
  ).toBe(1);
  expect((await repository.getDraft(draft.id)).revision.id).toBe(draft.revision.id);
});

it('materializes every retained legacy revision without changing revision documents or checksums', async () => {
  const { database, assets, template, createInput } = await fixture();
  const legacyRepository = new D1DraftRepository(database);
  const draft = await legacyRepository.createDraft(createInput);
  const changed = structuredClone(draft.document);
  for (const item of changed.media) item.sourcePath = '/assets/retained-image.png';
  await legacyRepository.saveDraft({
    draftId: draft.id,
    expectedChecksum: draft.revision.checksum,
    document: changed,
    actor,
    idempotencyKey: 'legacy-save-draft-001',
    requestId: 'save',
    action: { category: 'replace', context: 'library-attachment' },
  });
  const history = await legacyRepository.listRevisions(draft.id);
  expect(await assets.materializeLegacyDraft(draft.id)).toBe(2);
  expect(await legacyRepository.listRevisions(draft.id)).toEqual(history);
  template.fetch.mockImplementation(() =>
    Promise.resolve(new Response('unavailable', { status: 404 })),
  );
  expect((await assets.readForDraft(draft.id, '/assets/point-logo.png')).bytes).toEqual(png);
  expect((await assets.readForDraft(draft.id, '/assets/retained-image.png')).bytes).toEqual(png);
});
