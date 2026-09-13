// @vitest-environment node

import { acquireDraftProof } from '../fixtures/draft-proof';

import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import { D1DraftAssets } from '../../src/server/media/draft-assets';
import { D1MediaRepository, D1PrivateBucket, MediaService } from '../../src/server/media/service';
import { createApp } from '../../src/server/index';
import { D1DraftRepository } from '../../src/server/repositories/d1';
import { ConflictError, NotFoundError } from '../../src/server/repositories/memory';
import { buildCandidate } from '../../src/server/publish/candidate';
import { preparePublicationInputs } from '../../src/server/publish/inputs';
import { checksumDocument } from '../../src/site-kit/canonicalize';
import { D1PublishJobStore } from '../../src/server/publish/jobs';
import { D1PublicationRunner } from '../../src/server/publish/runner';
import { publicationClaims } from '../fixtures/publication-runner';
import { exportPKCS8, generateKeyPair, SignJWT } from 'jose';
import { dispatchPublication } from '../../src/server/publish/dispatch';

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
  draft.revision.checksum = await checksumDocument(draft.document);
  const pinned = await preparePublicationInputs(
    tracked,
    draft,
    crypto.randomUUID(),
    'a'.repeat(40),
  );
  expect(pinned.assets).toHaveLength(102);
  expect(pinned.statements).toHaveLength(3);
  expect(prepare).toHaveBeenCalledTimes(4);
  expect(prepare.mock.calls.some(([query]) => query.includes('draft_asset_chunks'))).toBe(false);
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
  draft.revision.checksum = await checksumDocument(draft.document);
  capped.mockClear();
  await expect(
    preparePublicationInputs(tracked, draft, crypto.randomUUID(), 'a'.repeat(40)),
  ).rejects.toThrow('CANDIDATE_MEDIA_TOO_LARGE');
  expect(capped).toHaveBeenCalledOnce();
}, 30_000);
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

it('dispatches one captured job with scoped credentials, fresh permission, bounded retries and no browser session', async () => {
  const { database, repository, createInput } = await fixture();
  const subject = 'github:12345';
  await database
    .prepare(
      `INSERT INTO user_roles(email,github_login,role,active,created_at,updated_at,updated_by)
    VALUES (?,'fixture-publisher','publisher',1,'fixture','fixture','fixture')`,
    )
    .bind(subject)
    .run();
  const draft = await repository.createDraft({ ...createInput, actor: subject });
  const job = await new D1PublishJobStore(database).captureStaging({
    draft,
    actor: subject,
    workflowRevision: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    idempotencyKey: 'dispatch-owned-fixture',
    requestId: 'capture',
  });
  const keys = await generateKeyPair('RS256', { extractable: true });
  const config = {
    appId: '123',
    installationId: '456',
    privateKey: await exportPKCS8(keys.privateKey),
  };
  const calls: { url: string; body: unknown }[] = [];
  let permission = 'write';
  let userId = 12345;
  let sha = 'b'.repeat(40);
  let responseStatus = 204;
  let revokeDuringRequest = false;
  const fetcher: typeof fetch = async (url, init) => {
    const value = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    calls.push({
      url: value,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null,
    });
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    if (value.endsWith('/access_tokens'))
      return Response.json({ token: 'fixture-installation-token', expires_at: 'fixture' });
    if (value.endsWith('/permission')) return Response.json({ permission, user: { id: userId } });
    if (value.endsWith('/git/ref/heads/main')) {
      if (revokeDuringRequest)
        await database.prepare('UPDATE user_roles SET active=0 WHERE email=?').bind(subject).run();
      return Response.json({ object: { sha } });
    }
    if (value.endsWith('/dispatches'))
      return new Response(responseStatus === 204 ? null : 'private-provider-error', {
        status: responseStatus,
        headers: { 'retry-after': '120' },
      });
    throw new Error('Unexpected URL');
  };
  await dispatchPublication(database, config, job.id, fetcher);
  expect(calls).toHaveLength(4);
  expect(calls[0].body).toEqual({
    repositories: ['pointsite-staging'],
    permissions: { contents: 'write', checks: 'read', metadata: 'read' },
  });
  const nonce = await database
    .prepare('SELECT nonce FROM publication_runs WHERE job_id=?')
    .bind(job.id)
    .first<string>('nonce');
  expect(nonce).toMatch(/^[a-f0-9]{64}$/);
  expect(calls[3]).toEqual({
    url: 'https://api.github.com/repos/PointCommunity/pointsite-staging/dispatches',
    body: {
      event_type: 'publish-candidate',
      client_payload: { jobId: job.id, nonce },
    },
  });
  expect((await new D1PublishJobStore(database).getById(job.id))?.status).toBe('queued');
  await expect(dispatchPublication(database, config, job.id, fetcher)).rejects.toThrow(
    'PUBLISH_DISPATCH_BACKOFF',
  );
  expect(calls).toHaveLength(4);
  const resetBackoff = () =>
    database
      .prepare(
        "UPDATE publication_runs SET dispatch_after='1970-01-01T00:00:00.000Z' WHERE job_id=?",
      )
      .bind(job.id)
      .run();
  for (const failure of ['permission', 'identity', 'base', 'revocation', 'provider'] as const) {
    await resetBackoff();
    calls.length = 0;
    permission = failure === 'permission' ? 'read' : 'write';
    userId = failure === 'identity' ? 54321 : 12345;
    sha = failure === 'base' ? 'c'.repeat(40) : 'b'.repeat(40);
    revokeDuringRequest = failure === 'revocation';
    responseStatus = failure === 'provider' ? 429 : 204;
    await expect(dispatchPublication(database, config, job.id, fetcher)).rejects.toThrow(
      /^PUBLISH_/,
    );
    expect(calls.filter((call) => call.url.endsWith('/dispatches'))).toHaveLength(
      failure === 'provider' ? 1 : 0,
    );
    await database.prepare('UPDATE user_roles SET active=1 WHERE email=?').bind(subject).run();
  }
  expect(
    await database
      .prepare(
        "SELECT dispatch_after>strftime('%Y-%m-%dT%H:%M:%fZ','now','+110 seconds') AS held FROM publication_runs WHERE job_id=?",
      )
      .bind(job.id)
      .first('held'),
  ).toBe(1);
}, 30_000);

it('captures once, rejects duplicate runners, and serves pinned inputs after further editing', async () => {
  const { database, repository, createInput } = await fixture();
  await database.prepare("UPDATE user_roles SET role='publisher' WHERE email=?").bind(actor).run();
  const draft = await repository.createDraft(createInput);
  const jobs = new D1PublishJobStore(database);
  const input = {
    draft,
    workflowRevision: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    actor,
    idempotencyKey: 'cloud-publication-fixture',
    requestId: 'capture',
  };
  const [job, duplicate] = await Promise.all([
    jobs.captureStaging(input),
    jobs.captureStaging(input),
  ]);
  expect(duplicate.id).toBe(job.id);
  expect(JSON.stringify(job)).not.toContain('nonce');
  expect(await database.prepare('SELECT COUNT(*) AS n FROM publication_runs').first('n')).toBe(1);
  expect(
    await database
      .prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='publish.queued'")
      .first('n'),
  ).toBe(1);
  await expect(jobs.captureStaging({ ...input, baseSha: 'c'.repeat(40) })).rejects.toThrow(
    'IDEMPOTENCY_CONFLICT',
  );
  await expect(
    jobs.captureStaging({ ...input, idempotencyKey: 'another-cloud-candidate' }),
  ).rejects.toThrow();

  const nonce = await database
    .prepare('SELECT nonce FROM publication_runs WHERE job_id=?')
    .bind(job.id)
    .first<string>('nonce');
  const keys = await generateKeyPair('RS256');
  const resolver = () => Promise.resolve(keys.publicKey);
  const claims = publicationClaims({
    target: 'staging',
    jobId: job.id,
    nonce: nonce!,
    workflowRevision: input.workflowRevision,
    dispatchRevision: input.baseSha,
  });
  const sign = (change = {}) =>
    new SignJWT({ ...claims, ...change })
      .setProtectedHeader({ alg: 'RS256' })
      .sign(keys.privateKey);
  const token = await sign();
  const runner = new D1PublicationRunner(database, resolver);
  const authenticate = vi.fn(() => Promise.reject(new Error('User authentication required')));
  const app = createApp({
    repository,
    authenticate,
    publicationRunner: runner,
    environment: 'test',
    version: 'test',
  });
  const runnerUrl = `https://builder.pointatx.org/api/publish/runner/${job.id}`;
  const log = vi.spyOn(console, 'error');
  const denied = await app.request(`${runnerUrl}/inputs`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(denied.status).toBe(409);
  expect(await denied.text()).not.toMatch(/SELECT|json|nonce|Bearer/);
  expect(log).not.toHaveBeenCalled();
  expect((await app.request(`${runnerUrl}/claim`, { method: 'POST' })).status).toBe(401);
  expect(
    (
      await app.request(`${runnerUrl}/claim`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      })
    ).status,
  ).toBe(200);
  expect(authenticate).not.toHaveBeenCalled();
  await Promise.all([runner.claim(job.id, token), runner.claim(job.id, token)]);
  expect((await jobs.getById(job.id))?.status).toBe('running');
  expect(
    await database
      .prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='publish.runner-claimed'")
      .first('n'),
  ).toBe(1);
  for (const change of [{ run_id: '555' }, { run_attempt: '2' }, { check_run_id: '556' }]) {
    await expect(runner.claim(job.id, await sign(change))).rejects.toThrow();
  }
  const document = structuredClone(draft.document);
  document.media[0].alt = 'Later edit';
  await repository.saveDraft({
    draftId: draft.id,
    ...(await acquireDraftProof(repository, draft.id, actor)),
    document,
    actor,
    idempotencyKey: 'after-publication-capture',
    requestId: 'edit',
    action: { category: 'control-change', context: 'library-attachment' },
  });
  const pinned = await runner.inputs(job.id, token);
  expect(pinned.document).toEqual(draft.document);
  const response = await app.request(`${runnerUrl}/inputs`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('x-request-id')).toBeTruthy();
  expect(await response.json()).toEqual(pinned);
  expect(
    (
      await app.request(`${runnerUrl}/inputs`, {
        headers: { authorization: `Bearer ${token}`, cookie: 'session=irrelevant' },
      })
    ).status,
  ).toBe(401);
  await app.request(`${runnerUrl}/unknown`);
  expect(authenticate).toHaveBeenCalledOnce();
  expect(pinned.candidateChecksum).toBe(job.candidateChecksum);
  expect(new Uint8Array(await runner.chunk(job.id, token, pinned.assets[0].assetId, 0))).toEqual(
    png,
  );
  await expect(runner.chunk(job.id, token, crypto.randomUUID(), 0)).rejects.toThrow(
    'PUBLICATION_ASSET_MISSING',
  );

  await database.prepare("UPDATE user_roles SET role='editor' WHERE email=?").bind(actor).run();
  await expect(runner.inputs(job.id, token)).rejects.toThrow('PUBLISH_RUNNER_UNAUTHORIZED');
  await expect(runner.chunk(job.id, token, pinned.assets[0].assetId, 0)).rejects.toThrow(
    'PUBLISH_RUNNER_UNAUTHORIZED',
  );
  await expect(jobs.captureStaging(input)).rejects.toThrow();
  await database.prepare("UPDATE user_roles SET role='publisher' WHERE email=?").bind(actor).run();
  // Revocation between token verification and the claim transaction still wins.
  const revoke = async () => {
    await database.prepare('UPDATE user_roles SET active=0 WHERE email=?').bind(actor).run();
    return keys.publicKey;
  };
  await expect(new D1PublicationRunner(database, revoke).claim(job.id, token)).rejects.toThrow();
  await database.prepare('UPDATE user_roles SET active=1 WHERE email=?').bind(actor).run();
  await database.prepare("UPDATE drafts SET status='archived' WHERE id=?").bind(draft.id).run();
  await expect(runner.inputs(job.id, token)).rejects.toThrow('PUBLISH_RUNNER_UNAUTHORIZED');
  expect(await database.prepare('SELECT job_id FROM publication_slots').first('job_id')).toBe(
    job.id,
  );
}, 30_000);

it('rolls back publication capture when authority or the saved revision changes during preparation', async () => {
  const { database, repository, createInput } = await fixture();
  await database.prepare("UPDATE user_roles SET role='publisher' WHERE email=?").bind(actor).run();
  const draft = await repository.createDraft(createInput);
  const input = {
    draft,
    workflowRevision: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    actor,
    idempotencyKey: 'cloud-capture-race-fixture',
    requestId: 'capture',
  };
  for (const mutation of [
    database.prepare('UPDATE user_roles SET active=0 WHERE email=?').bind(actor),
    database.prepare("UPDATE drafts SET status='archived' WHERE id=?").bind(draft.id),
  ]) {
    const raced = new Proxy(database, {
      get: (target, property) =>
        property === 'batch'
          ? async (statements: D1PreparedStatement[]) => {
              await mutation.run();
              return database.batch(statements);
            }
          : (Reflect.get(target, property) as unknown),
    });
    await expect(new D1PublishJobStore(raced).captureStaging(input)).rejects.toThrow();
    for (const table of [
      'publish_jobs',
      'publication_inputs',
      'publication_runs',
      'publication_slots',
      'publication_asset_pins',
    ]) {
      expect(await database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first('n')).toBe(0);
    }
    await database.prepare('UPDATE user_roles SET active=1 WHERE email=?').bind(actor).run();
  }
});

it('pins exact publication inputs without reading bytes and rolls back changed inputs', async () => {
  const { database, repository, createInput } = await fixture();
  const draft = await repository.createDraft(createInput);
  const prepare = vi.fn((query: string) => database.prepare(query));
  const tracked = new Proxy(database, {
    get: (target, property) =>
      property === 'prepare' ? prepare : (Reflect.get(target, property) as unknown),
  });
  const jobId = crypto.randomUUID();
  const workflow = 'a'.repeat(40);
  const input = await preparePublicationInputs(tracked, draft, jobId, workflow);
  expect(prepare).toHaveBeenCalledTimes(4);
  expect(prepare.mock.calls.some(([sql]) => sql.includes('draft_asset_chunks'))).toBe(false);
  expect(input.assets).toHaveLength(1);
  expect(input.byteSize).toBe(png.length);
  expect(input.candidateChecksum).toBe(
    await checksumDocument({ ...input.candidate, assets: input.assets }),
  );
  const repeated = await preparePublicationInputs(database, draft, crypto.randomUUID(), workflow);
  expect(repeated.candidateChecksum).toBe(input.candidateChecksum);
  expect(
    (await preparePublicationInputs(database, draft, crypto.randomUUID(), 'b'.repeat(40)))
      .candidateChecksum,
  ).not.toBe(input.candidateChecksum);
  const insertJob = () =>
    database
      .prepare(
        `INSERT INTO publish_jobs
      (id,idempotency_key,environment,status,candidate_json,candidate_checksum,repository,base_sha,requested_by,requested_at)
      VALUES (?,?,'staging','queued',?,?,'PointCommunity/pointsite-staging',?,?,'fixture')`,
      )
      .bind(
        jobId,
        jobId,
        JSON.stringify(input.candidate),
        input.candidateChecksum,
        'c'.repeat(40),
        actor,
      );
  expect(await database.prepare('SELECT COUNT(*) AS n FROM publication_inputs').first('n')).toBe(0);
  const asset = input.assets[0];
  await database
    .prepare('DELETE FROM draft_asset_bindings WHERE draft_id=? AND source_path=?')
    .bind(draft.id, asset.sourcePath)
    .run();
  await expect(database.batch([insertJob(), ...input.statements])).rejects.toThrow();
  expect(await database.prepare('SELECT COUNT(*) AS n FROM publish_jobs').first('n')).toBe(0);
  await database
    .prepare('INSERT INTO draft_asset_bindings(draft_id,source_path,asset_id) VALUES (?,?,?)')
    .bind(draft.id, asset.sourcePath, asset.assetId)
    .run();
  await database.batch([insertJob(), ...input.statements]);
  expect(
    await database.prepare('SELECT COUNT(*) AS n FROM publication_asset_pins').first('n'),
  ).toBe(1);
  for (const statement of [
    database.prepare('DELETE FROM draft_asset_versions WHERE id=?').bind(asset.assetId),
    database.prepare('DELETE FROM draft_asset_chunks WHERE asset_id=?').bind(asset.assetId),
    database.prepare('DELETE FROM draft_asset_bindings WHERE draft_id=?').bind(draft.id),
    database.prepare('DELETE FROM revisions WHERE id=?').bind(draft.revision.id),
    database
      .prepare('UPDATE publication_inputs SET workflow_revision=? WHERE job_id=?')
      .bind('d'.repeat(40), jobId),
    database
      .prepare('UPDATE publication_asset_pins SET source_path=? WHERE job_id=?')
      .bind('/assets/other.png', jobId),
    database.prepare('UPDATE publish_jobs SET base_sha=? WHERE id=?').bind('d'.repeat(40), jobId),
  ])
    await expect(statement.run()).rejects.toThrow();
});

it('rejects mismatched revision, missing owned media, and cross-owner publication pins', async () => {
  const { database, repository, createInput } = await fixture();
  const draft = await repository.createDraft(createInput);
  const jobId = crypto.randomUUID();
  const workflow = 'a'.repeat(40);
  const changed = structuredClone(draft);
  changed.document.media[0].alt = 'Unsaved change';
  await expect(preparePublicationInputs(database, changed, jobId, workflow)).rejects.toThrow(
    'PUBLICATION_REVISION_MISMATCH',
  );
  const other = await repository.createDraft({
    ...createInput,
    idempotencyKey: 'other-publication-fixture',
  });
  const substituted = structuredClone(draft);
  substituted.document.media = other.document.media;
  substituted.revision.checksum = await checksumDocument(substituted.document);
  await expect(preparePublicationInputs(database, substituted, jobId, workflow)).rejects.toThrow(
    'PUBLICATION_ASSET_MISSING',
  );
  const input = await preparePublicationInputs(database, draft, jobId, workflow);
  await database
    .prepare(
      `INSERT INTO publish_jobs
    (id,idempotency_key,environment,status,candidate_json,candidate_checksum,repository,base_sha,requested_by,requested_at)
    VALUES (?,?,'staging','queued',?,?,'PointCommunity/pointsite-staging',?,?,'fixture')`,
    )
    .bind(
      jobId,
      jobId,
      JSON.stringify(input.candidate),
      input.candidateChecksum,
      'c'.repeat(40),
      actor,
    )
    .run();
  await expect(
    database
      .prepare(
        'INSERT INTO publication_inputs(job_id,draft_id,revision_id,workflow_revision) VALUES (?,?,?,?)',
      )
      .bind(jobId, other.id, draft.revision.id, workflow)
      .run(),
  ).rejects.toThrow('PUBLICATION_INPUT_MISMATCH');
  await database.batch(input.statements);
  const otherAsset = await database
    .prepare('SELECT asset_id FROM draft_asset_bindings WHERE draft_id=?')
    .bind(other.id)
    .first<string>('asset_id');
  await expect(
    database
      .prepare(
        'INSERT INTO publication_asset_pins(job_id,draft_id,source_path,asset_id) VALUES (?,?,?,?)',
      )
      .bind(jobId, draft.id, other.document.media[0].sourcePath, otherAsset)
      .run(),
  ).rejects.toThrow('PUBLICATION_ASSET_MISMATCH');
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
      expectedRevisionId: source.revision.id,
      checkoutToken: (
        await repository.acquireCheckout({
          draftId: source.id,
          actor,
          clientId: 'owned-fixture-0001',
          requestId: 'checkout',
        })
      ).token,
      document: tampered,
      actor,
      idempotencyKey: 'owned-invalid-save-01',
      requestId: 'invalid-save',
      action: { category: 'replace', context: 'library-attachment' },
    }),
  ).rejects.toBeInstanceOf(ConflictError);
  await repository.setDraftStatus(
    source.id,
    'archived',
    actor,
    'archive',
    await acquireDraftProof(repository, source.id, actor),
  );
  await repository.purgeDraft(
    source.id,
    actor,
    'purge',
    await acquireDraftProof(repository, source.id, actor),
  );
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
      expectedRevisionId: draft.revision.id,
      checkoutToken: (
        await repository.acquireCheckout({
          draftId: draft.id,
          actor,
          clientId: 'owned-fixture-0001',
          requestId: 'checkout',
        })
      ).token,
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
  await repository.setDraftStatus(
    draft.id,
    'archived',
    actor,
    'archive',
    await acquireDraftProof(repository, draft.id, actor),
  );
  await repository.purgeDraft(
    draft.id,
    actor,
    'purge',
    await acquireDraftProof(repository, draft.id, actor),
  );
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
        expectedRevisionId: draft.revision.id,
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
    expectedRevisionId: draft.revision.id,
    checkoutToken: (
      await legacyRepository.acquireCheckout({
        draftId: draft.id,
        actor,
        clientId: 'legacy-fixture-001',
        requestId: 'checkout',
      })
    ).token,
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
