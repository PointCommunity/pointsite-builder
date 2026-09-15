// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import { captureProductionSource, capturePublicationSource } from '../../server/production-source';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import { checksumDocument } from '../../src/site-kit/canonicalize';
import { publicationMediaPaths } from '../../src/site-kit/publication-media';
import { SqliteDatabase } from '../../server/sqlite';
import { migrateDatabase } from '../../server/migrations';
import { D1DraftRepository } from '../../src/server/repositories/d1';
import { D1DraftAssets } from '../../src/server/media/draft-assets';

async function fixture(target: 'production' | 'staging' | 'canary' = 'production') {
  const repository =
    target === 'canary'
      ? 'pointsite-staging-canary'
      : target === 'staging'
        ? 'pointsite-staging'
        : 'pointsite';
  const environment = target === 'production' ? 'github-pages' : 'staging';
  const origin =
    target === 'canary'
      ? 'https://staging-canary.pointatx.org'
      : target === 'staging'
        ? 'https://staging.pointatx.org'
        : 'https://pointatx.org';
  const document = structuredClone(defaultSiteDocument);
  document.site.name = 'Currently deployed fixture';
  const objects = new Map<string, Buffer>();
  const assets = await Promise.all(
    publicationMediaPaths(document).map(async (sourcePath) => {
      const bytes = await readFile(`public${sourcePath}`);
      objects.set(sourcePath, bytes);
      return {
        assetId: crypto.randomUUID(),
        sourcePath,
        byteSize: bytes.length,
        checksum: createHash('sha256').update(bytes).digest('hex'),
        contentType: sourcePath.endsWith('.png') ? 'image/png' : 'image/jpeg',
      };
    }),
  );
  const candidate = {
    siteId: 'pointsite',
    draftId: crypto.randomUUID(),
    revisionId: crypto.randomUUID(),
    revisionChecksum: await checksumDocument(document),
    schemaVersion: document.schemaVersion,
    rendererVersion: document.rendererVersion,
    publicationProtocol: 2,
    mediaSelection: 'referenced',
    workflowRevision: 'a'.repeat(40),
    fileCount: assets.length + 2,
    assets,
  };
  const manifest = {
    ...candidate,
    source: 'PointCommunity/pointsite-builder',
    candidateChecksum: await checksumDocument(candidate),
  };
  const files = [
    ...assets.map((a) => ({ path: a.sourcePath.slice(1), bytes: a.byteSize, sha256: a.checksum })),
    ...document.pages.map((p) => ({
      path: p.route === '/' ? 'index.html' : `${p.route.slice(1)}/index.html`,
      bytes: 1,
      sha256: 'a'.repeat(64),
    })),
  ].sort((a, b) => (a.path < b.path ? -1 : 1));
  const output = {
    files,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    artifactDigest: await checksumDocument(files),
  };
  // Rollback: workflow/branch identity is deliberately different from live content identity.
  const release = {
    format: 2,
    sourceCommit: 'b'.repeat(40),
    workflowRevision: 'c'.repeat(40),
    candidateChecksum: 'd'.repeat(64),
    artifactDigest: output.artifactDigest,
  };
  let deployment = 1;
  const responseFor = (value: string) => {
    if (value.includes('/deployments?'))
      return Response.json([
        {
          id: deployment,
          sha: 'e'.repeat(40),
          environment,
          performed_via_github_app: { id: 15368, slug: 'github-actions' },
        },
      ]);
    if (value.includes('/statuses?'))
      return Response.json([
        {
          state: 'success',
          environment,
          environment_url: origin + '/',
          log_url: 'https://github.com/PointCommunity/' + repository + '/actions/runs/123/job/456',
        },
      ]);
    if (value.endsWith('/__pointsite_release.json')) return Response.json(release);
    if (
      value.startsWith(
        'https://raw.githubusercontent.com/PointCommunity/' +
          repository +
          '/' +
          release.sourceCommit +
          '/',
      )
    ) {
      if (value.endsWith('/builder-site.json')) return Response.json(document);
      if (value.endsWith('/builder-site.manifest.json')) return Response.json(manifest);
      if (value.endsWith('/builder-site.output.json')) return Response.json(output);
    }
    const path = new URL(value).pathname;
    const object = objects.get(path);
    if (object)
      return new Response(Uint8Array.from(object).buffer, {
        headers: { 'content-type': assets.find((a) => a.sourcePath === path)!.contentType },
      });
    throw new Error(`Unexpected fixture URL: ${value}`);
  };
  const fetcher = vi.fn<typeof fetch>((url) =>
    Promise.resolve(responseFor(url instanceof Request ? url.url : String(url))),
  );
  return { document, objects, output, release, fetcher, changeDeployment: () => deployment++ };
}

test.each([
  ['staging', 'https://builder.eaglepass.io'],
  ['canary', 'https://builder-canary.eaglepass.io'],
] as const)(
  'captures verified %s publication from fixed runtime destination',
  async (target, builderOrigin) => {
    const input = await fixture(target);
    const source = await capturePublicationSource('staging', builderOrigin, input.fetcher);
    expect(source.document.site.name).toBe(input.document.site.name);
    expect(source.provenance.sourceCommit).toBe(input.release.sourceCommit);
    expect(source.provenance.artifactDigest).toBe(input.output.artifactDigest);
    expect(source.provenance.candidateChecksum).toBe(input.release.candidateChecksum);
    expect(source.assets.size).toBe(input.objects.size);
  },
);

test('capture uses deployed rollback content, verifies media, and rejects altered or changing source', async () => {
  const input = await fixture();
  const source = await captureProductionSource(input.fetcher);
  expect(source.document.site.name).toBe('Currently deployed fixture');
  expect(source.provenance.sourceCommit).toBe(input.release.sourceCommit);
  expect(source.assets.size).toBe(input.objects.size);
  expect(source.document.media).toHaveLength(input.objects.size);
  for (const [path, object] of source.assets)
    expect(Buffer.from(object.bytes)).toEqual(input.objects.get(path));
  input.objects.set([...input.objects.keys()][0], Buffer.from('altered'));
  await expect(captureProductionSource(input.fetcher)).rejects.toMatchObject({
    code: 'PRODUCTION_IMPORT_UNCONFIRMED',
  });
  const changed = await fixture();
  let reads = 0;
  const racing: typeof fetch = async (url, options) => {
    if ((url instanceof Request ? url.url : String(url)).includes('/deployments?') && reads++ > 0)
      changed.changeDeployment();
    return changed.fetcher(url, options);
  };
  await expect(captureProductionSource(racing)).rejects.toThrow(
    'Current Production content could not be confirmed',
  );
  changed.release.sourceCommit = '../not-a-commit';
  await expect(captureProductionSource(changed.fetcher)).rejects.toThrow();
});

test('native imports own independent images and immutable provenance; retries never recapture Production', async () => {
  const fixtureSource = await fixture();
  const source = await captureProductionSource(fixtureSource.fetcher);
  const capture = vi.fn(() => Promise.resolve(source));
  const db = new SqliteDatabase(':memory:');
  try {
    await migrateDatabase(db, 'migrations');
    const actor = 'github:12345';
    await db
      .prepare(
        "INSERT INTO user_roles(email,role,active,created_at,updated_at,updated_by) VALUES (?,'administrator',1,'fixture','fixture','fixture')",
      )
      .bind(actor)
      .run();
    const assets = new D1DraftAssets(db, {
      read: () => Promise.reject(new Error('Private fallback forbidden')),
    });
    const repository = new D1DraftRepository(db, assets, 'compact-v1', undefined, capture);
    const input = {
      name: 'Production import',
      document: defaultSiteDocument,
      actor,
      idempotencyKey: crypto.randomUUID(),
      requestId: crypto.randomUUID(),
    };
    const first = await repository.createDraft(input);
    expect(first.document.site.name).toBe(source.document.site.name);
    expect((await repository.createDraft(input)).id).toBe(first.id);
    expect(capture).toHaveBeenCalledTimes(1);
    await expect(repository.createDraft({ ...input, name: 'Changed request' })).rejects.toThrow(
      'different input',
    );
    const second = await repository.createDraft({ ...input, idempotencyKey: crypto.randomUUID() });
    expect(second.document.media[0].sourcePath).not.toBe(first.document.media[0].sourcePath);
    const originalPath = first.document.media[0].sourcePath;
    expect((await assets.readForDraft(first.id, originalPath)).bytes).toEqual(
      Uint8Array.from(source.assets.get(source.document.media[0].sourcePath)!.bytes),
    );
    await expect(assets.readForDraft(second.id, originalPath)).rejects.toThrow();
    const provenance = await db
      .prepare('SELECT provenance_json FROM draft_production_sources WHERE draft_id=?')
      .bind(first.id)
      .first<string>('provenance_json');
    expect(JSON.parse(provenance!)).toEqual(source.provenance);
    await expect(
      db.prepare("UPDATE draft_production_sources SET provenance_json='{}'").run(),
    ).rejects.toThrow('immutable');
    capture.mockRejectedValueOnce(new Error('Capture interrupted'));
    await expect(
      repository.createDraft({ ...input, idempotencyKey: crypto.randomUUID() }),
    ).rejects.toThrow('Capture interrupted');
    expect((await repository.listDrafts()).length).toBe(2);
    await db.prepare('UPDATE user_roles SET active=0 WHERE email=?').bind(actor).run();
    await expect(repository.createDraft(input)).rejects.toThrow();
  } finally {
    db.close();
  }
});

test('native creation selects verified Staging source and does not use Production callback', async () => {
  const staging = await fixture('staging');
  const source = await capturePublicationSource(
    'staging',
    'https://builder.eaglepass.io',
    staging.fetcher,
  );
  const capture = vi.fn((target: 'staging' | 'production') =>
    target === 'staging' ? Promise.resolve(source) : Promise.reject(new Error('Wrong source')),
  );
  const db = new SqliteDatabase(':memory:');
  try {
    await migrateDatabase(db, 'migrations');
    const actor = 'github:12345';
    await db
      .prepare(
        "INSERT INTO user_roles(email,role,active,created_at,updated_at,updated_by) VALUES (?,'editor',1,'fixture','fixture','fixture')",
      )
      .bind(actor)
      .run();
    const assets = new D1DraftAssets(db, {
      read: () => Promise.reject(new Error('Private fallback forbidden')),
    });
    const repository = new D1DraftRepository(db, assets, 'compact-v1', undefined, capture);
    const draft = await repository.createDraft({
      name: 'Staging season',
      document: defaultSiteDocument,
      sourceTarget: 'staging',
      actor,
      idempotencyKey: crypto.randomUUID(),
      requestId: crypto.randomUUID(),
    });
    expect(capture).toHaveBeenCalledWith('staging');
    expect(draft.document.site.name).toBe(source.document.site.name);
    const stored = await db
      .prepare('SELECT provenance_json FROM draft_production_sources WHERE draft_id=?')
      .bind(draft.id)
      .first<string>('provenance_json');
    expect(JSON.parse(stored!).target).toBe('staging');
    await expect(
      new D1DraftRepository(db, assets).createDraft({
        name: 'Unavailable source',
        document: defaultSiteDocument,
        sourceTarget: 'staging',
        actor,
        idempotencyKey: crypto.randomUUID(),
        requestId: crypto.randomUUID(),
      }),
    ).rejects.toThrow();
    expect((await repository.listDrafts()).length).toBe(1);
  } finally {
    db.close();
  }
});
