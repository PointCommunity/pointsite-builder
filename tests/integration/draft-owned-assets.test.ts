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
import { D1ProductionPublisher } from '../../src/server/publish/promotion';
import { recoverQueuedPublication } from '../../src/server/publish/recovery';
import { retryCapturedPublication as retryCapturedStaging } from '../../src/server/publish/retry';
import { reconcileCompletedPublication } from '../../src/server/publish/reconcile';
import { retirePublicationMetadata } from '../../src/server/publish/releases';
import { publicationClaims } from '../fixtures/publication-runner';
import { exportPKCS8, generateKeyPair, SignJWT } from 'jose';
import { D1ApprovalService } from '../../src/server/approvals/service';
import { StagingPublisher } from '../../src/server/publish/service';
import { D1PublishPreflightStore } from '../../src/server/publish/preflights';
import {
  PUBLICATION_CALLER_BLOB,
  PUBLICATION_WORKFLOW_REVISION,
} from '../../src/server/publish/renderer-contract';
import { dispatchPendingPublication, dispatchPublication } from '../../src/server/publish/dispatch';
import { publicationGitHubFixture } from '../fixtures/publication-github';

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
  const placement = structuredClone(draft.document.pages[0].blocks[0].items[0]);
  let section = structuredClone(draft.document.pages[0].blocks[0]);
  section.items = [];
  const placeLastImage = () => {
    if (!section.items.length || section.items.length === 60) {
      section = { ...section, id: crypto.randomUUID(), layout: 'flow', items: [] };
      draft.document.pages[0].blocks.push(section);
    }
    section.items.push({
      ...structuredClone(placement),
      id: crypto.randomUUID(),
      element: {
        id: crypto.randomUUID(),
        type: 'image',
        mediaId: draft.document.media.at(-1)!.id,
        alt: 'Image',
        aspect: 'natural',
        fit: 'contain',
      },
    });
  };
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
    placeLastImage();
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
    placeLastImage();
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

it.each(['staging', 'production'] as const)(
  'recovers a completed %s deployment without publishing again',
  async (target) => {
    const { database, repository, createInput } = await fixture();
    const subject = 'github:12345',
      administrator = 'github:54321';
    for (const [email, role] of [
      [subject, 'publisher'],
      [administrator, 'administrator'],
    ])
      await database
        .prepare(
          "INSERT INTO user_roles(email,github_login,role,active,created_at,updated_at,updated_by) VALUES (?,?,?,1,'fixture','fixture','fixture')",
        )
        .bind(email, `fixture-${role}`, role)
        .run();
    const draft = await repository.createDraft({ ...createInput, actor: subject });
    const store = new D1PublishJobStore(database);
    const captured = await store.captureStaging({
      draft,
      actor: subject,
      workflowRevision: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      idempotencyKey: 'completed-recovery-source',
      requestId: 'capture',
    });
    const jobId = target === 'staging' ? captured.id : crypto.randomUUID();
    if (target === 'production')
      await database.batch([
        database
          .prepare(
            `INSERT INTO publish_jobs(id,idempotency_key,environment,status,candidate_json,candidate_checksum,repository,base_sha,requested_by,requested_at)
      SELECT ?,'completed-production-fixture','production-merge','running',candidate_json,candidate_checksum,'PointCommunity/pointsite',base_sha,requested_by,requested_at FROM publish_jobs WHERE id=?`,
          )
          .bind(jobId, captured.id),
        database
          .prepare(
            'INSERT INTO publication_inputs(job_id,draft_id,revision_id,workflow_revision) SELECT ?,draft_id,revision_id,workflow_revision FROM publication_inputs WHERE job_id=?',
          )
          .bind(jobId, captured.id),
        database
          .prepare('INSERT INTO publication_runs(job_id,nonce,dispatch_revision) VALUES (?,?,?)')
          .bind(jobId, 'd'.repeat(64), 'b'.repeat(40)),
        database
          .prepare("INSERT INTO publication_slots(target,job_id) VALUES ('production',?)")
          .bind(jobId),
      ]);
    const { build } = await publicationGitHubFixture(jobId, captured.candidateChecksum, [], target);
    const workerVersionId = crypto.randomUUID();
    // Snapshot after the separately tested signed runner authorized, committed and acknowledged deployment.
    await database.batch([
      database
        .prepare(
          `UPDATE publication_runs SET reserved_run_id='12345',reserved_run_attempt='1',reserved_check_run_id='23456',
      run_id='12345',run_attempt='1',check_run_id='34567',claimed_at='fixture',commit_authorized_at='fixture',
      deploy_authorized_at='fixture',build_json=?,deployment_json=? WHERE job_id=?`,
        )
        .bind(
          JSON.stringify(build),
          JSON.stringify(
            target === 'staging' ? { workerVersionId } : { artifactDigest: build.artifactDigest },
          ),
          jobId,
        ),
      database
        .prepare("UPDATE publish_jobs SET status='running',result_sha=? WHERE id=?")
        .bind(build.commitSha, jobId),
      database.prepare('UPDATE user_roles SET active=0 WHERE email=?').bind(subject),
    ]);
    const repositoryName = target === 'staging' ? 'pointsite-staging' : 'pointsite';
    const environment = target === 'staging' ? 'staging' : 'github-pages';
    const origin = target === 'staging' ? 'https://staging.pointatx.org' : 'https://pointatx.org';
    const apiRoot = `https://api.github.com/repos/PointCommunity/${repositoryName}`;
    const jobUrl = `https://github.com/PointCommunity/${repositoryName}/actions/runs/12345/job/34567`;
    let failure = '',
      reads = 0,
      deployments = 0;
    const fetcher: typeof fetch = async (url, init) => {
      const path = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      reads++;
      expect(init?.method).toBeUndefined();
      expect(init?.body).toBeUndefined();
      expect(init?.redirect).toBe('error');
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      if (path.startsWith(`${apiRoot}/actions/runs/12345`))
        return Response.json({
          id: 12345,
          run_attempt: 1,
          status: failure === 'pending' ? 'in_progress' : 'completed',
          conclusion: 'failure',
          head_sha: 'b'.repeat(40),
          head_branch: 'main',
          event: 'repository_dispatch',
          path: '.github/workflows/publish-candidate.yml',
          repository: {
            id: target === 'staging' ? 1357847426 : 1348084954,
            full_name: `PointCommunity/${repositoryName}`,
          },
          referenced_workflows: [
            {
              path: `PointCommunity/pointsite-staging/.github/workflows/${target === 'staging' ? 'publish-runtime' : 'publish-production-runtime'}.yml@${'a'.repeat(40)}`,
              sha: 'a'.repeat(40),
            },
          ],
        });
      if (path === `${apiRoot}/check-runs/34567`)
        return Response.json({
          id: 34567,
          status: 'completed',
          conclusion: failure === 'checks' ? 'failure' : 'success',
          head_sha: 'b'.repeat(40),
          details_url: jobUrl,
          app: { id: 15368, slug: 'github-actions' },
          deployment: { id: 1 },
        });
      if (path === `${apiRoot}/git/ref/heads/main`)
        return Response.json({ object: { sha: build.commitSha } });
      if (path === `${apiRoot}/deployments?environment=${environment}&per_page=1`) {
        if (++deployments === 2 && failure === 'role-race')
          await database
            .prepare("UPDATE user_roles SET role='viewer' WHERE email=?")
            .bind(administrator)
            .run();
        return Response.json([
          {
            id: 1,
            sha: 'b'.repeat(40),
            environment,
            performed_via_github_app: { id: 15368, slug: 'github-actions' },
          },
        ]);
      }
      if (path === `${apiRoot}/deployments/1/statuses?per_page=1`)
        return Response.json([
          { state: 'success', environment, log_url: jobUrl, environment_url: origin },
        ]);
      if (path === `${origin}/__pointsite_release.json`)
        return Response.json({
          format: 2,
          candidateChecksum: captured.candidateChecksum,
          workflowRevision: 'a'.repeat(40),
          artifactDigest: failure === 'live' ? '0'.repeat(64) : build.artifactDigest,
          ...(target === 'staging' ? { workerVersionId } : {}),
        });
      throw new Error('Unexpected recovery request');
    };
    const input = {
      jobId,
      action: 'verify-completed' as const,
      expectedAttempts: 0,
      actor: administrator,
      idempotencyKey: 'completed-recovery-request',
      requestId: 'recover',
    };
    expect((await store.dispatchStatus(jobId))?.canVerifyCompleted).toBe(true);
    await expect(
      reconcileCompletedPublication(database, { ...input, actor: subject }, fetcher),
    ).rejects.toThrow('PUBLISH_AUTHORITY_CHANGED');
    expect(reads).toBe(0);
    if (target === 'production') {
      await database
        .prepare("UPDATE user_roles SET role='publisher' WHERE email=?")
        .bind(administrator)
        .run();
      await expect(reconcileCompletedPublication(database, input, fetcher)).rejects.toThrow(
        'PUBLISH_AUTHORITY_CHANGED',
      );
      expect(reads).toBe(0);
      await database
        .prepare("UPDATE user_roles SET role='administrator' WHERE email=?")
        .bind(administrator)
        .run();
    }
    for (failure of ['pending', 'checks', 'live', 'role-race']) {
      deployments = 0;
      await expect(reconcileCompletedPublication(database, input, fetcher)).rejects.toThrow(
        /PUBLICATION_(RUN_NOT_TERMINAL|VERIFICATION_UNCONFIRMED|RECOVERY_CHANGED)/,
      );
      expect(
        await database
          .prepare('SELECT status FROM publish_jobs WHERE id=?')
          .bind(jobId)
          .first('status'),
      ).toBe('running');
      expect(
        await database
          .prepare('SELECT job_id FROM publication_slots WHERE target=?')
          .bind(target)
          .first('job_id'),
      ).toBe(jobId);
      await database
        .prepare("UPDATE user_roles SET role='administrator' WHERE email=?")
        .bind(administrator)
        .run();
    }
    failure = '';
    deployments = 0;
    const lostResponse = new Proxy(database, {
      get: (db, property) =>
        property === 'batch'
          ? async (statements: D1PreparedStatement[]) => {
              await database.batch(statements);
              throw new Error('lost committed response');
            }
          : (Reflect.get(db, property) as unknown),
    });
    expect(await reconcileCompletedPublication(lostResponse, input, fetcher)).toEqual({
      recovered: true,
    });
    expect(
      await database
        .prepare('SELECT status FROM publish_jobs WHERE id=?')
        .bind(jobId)
        .first('status'),
    ).toBe('succeeded');
    expect(
      JSON.parse(
        (await database
          .prepare('SELECT evidence_json FROM publish_jobs WHERE id=?')
          .bind(jobId)
          .first<string>('evidence_json'))!,
      ),
    ).toMatchObject({
      verificationStatus: 'passed',
      artifactDigest: build.artifactDigest,
      checkRunId: '34567',
    });
    expect(
      await database
        .prepare('SELECT job_id FROM publication_slots WHERE target=?')
        .bind(target)
        .first('job_id'),
    ).toBe(target === 'staging' ? jobId : null);
    expect(await database.prepare('SELECT count(*) AS n FROM approvals').first('n')).toBe(0);
    const previousReads = reads;
    expect(await reconcileCompletedPublication(database, input, fetcher)).toEqual({
      recovered: true,
    });
    expect(reads).toBe(previousReads);
    expect(
      await database
        .prepare("SELECT count(*) AS n FROM publication_releases WHERE kind='publication'")
        .first('n'),
    ).toBe(target === 'production' ? 1 : 0);
    if (target === 'production') {
      const recorded = await database
        .prepare('SELECT job_id,artifact_digest,evidence_json FROM publication_releases WHERE id=?')
        .bind(jobId)
        .first<{ job_id: string; artifact_digest: string; evidence_json: string }>();
      expect(recorded).toMatchObject({ job_id: jobId, artifact_digest: build.artifactDigest });
      expect(JSON.parse(recorded!.evidence_json)).toMatchObject({
        verificationStatus: 'passed',
        checkRunId: '34567',
      });
    }
    await expect(
      recoverQueuedPublication(database, { ...input, action: 'cancel' }, fetcher),
    ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    expect(
      await database
        .prepare(
          "SELECT count(*) AS n FROM audit_events WHERE action='publish.deployment-reconciled'",
        )
        .first('n'),
    ).toBe(1);
    await database
      .prepare('UPDATE user_roles SET active=0 WHERE email=?')
      .bind(administrator)
      .run();
    await expect(reconcileCompletedPublication(database, input, fetcher)).rejects.toThrow(
      'PUBLISH_AUTHORITY_CHANGED',
    );
  },
);

it.each([false, true])(
  'retries pinned Staging inputs after cancellation with recorded commit=%s',
  async (committed) => {
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
    const store = new D1PublishJobStore(database);
    const parent = await store.captureStaging({
      draft,
      actor: subject,
      workflowRevision: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      idempotencyKey: 'captured-retry-parent',
      requestId: 'capture',
    });
    const document = structuredClone(draft.document);
    document.pages[0].title = 'A later edit must not be published by this retry';
    await repository.saveDraft({
      draftId: draft.id,
      document,
      actor: subject,
      ...(await acquireDraftProof(repository, draft.id, subject)),
      idempotencyKey: 'captured-retry-later-edit',
      requestId: 'later',
      action: { category: 'text-edit', context: 'draft' },
    });
    const input = {
      jobId: parent.id,
      action: 'retry-captured' as const,
      expectedAttempts: 0,
      actor: subject,
      idempotencyKey: 'captured-retry-request',
      requestId: 'retry',
    };
    const verifyBase = vi.fn(async () => {});
    await expect(retryCapturedStaging(database, input, 'a'.repeat(40), verifyBase)).rejects.toThrow(
      'PUBLICATION_RECOVERY_CHANGED',
    );
    expect(verifyBase).not.toHaveBeenCalled();
    await recoverQueuedPublication(database, {
      ...input,
      action: 'cancel',
      idempotencyKey: 'captured-retry-cancel',
    });
    await expect(
      retryCapturedStaging(
        database,
        { ...input, idempotencyKey: 'captured-retry-cancel' },
        'a'.repeat(40),
        verifyBase,
      ),
    ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    if (committed)
      await database
        .prepare('UPDATE publish_jobs SET result_sha=? WHERE id=?')
        .bind('c'.repeat(40), parent.id)
        .run();
    const pins = await database
      .prepare(
        'SELECT draft_id,source_path,asset_id FROM publication_asset_pins WHERE job_id=? ORDER BY source_path',
      )
      .bind(parent.id)
      .all();
    const oldNonce = await database
      .prepare('SELECT nonce FROM publication_runs WHERE job_id=?')
      .bind(parent.id)
      .first<string>('nonce');
    await expect(retryCapturedStaging(database, input, 'd'.repeat(40), verifyBase)).rejects.toThrow(
      'PUBLICATION_RECOVERY_CHANGED',
    );
    const lostResponse = new Proxy(database, {
      get: (target, property) =>
        property === 'batch'
          ? async (statements: D1PreparedStatement[]) => {
              await database.batch(statements);
              throw new Error('response lost after committed transaction');
            }
          : (Reflect.get(target, property) as unknown),
    });
    const [first, duplicate] = await Promise.all([
      retryCapturedStaging(lostResponse, input, 'a'.repeat(40), verifyBase),
      retryCapturedStaging(database, input, 'a'.repeat(40), verifyBase),
    ]);
    expect(duplicate).toEqual(first);
    expect(verifyBase).toHaveBeenCalledWith((committed ? 'c' : 'b').repeat(40));
    const child = await store.getById(first.jobId);
    if (!child) throw new Error('Missing captured retry');
    expect(child.candidate).toEqual(parent.candidate);
    expect(child.candidateChecksum).toBe(parent.candidateChecksum);
    expect(child.baseSha).toBe((committed ? 'c' : 'b').repeat(40));
    expect(child.resultSha).toBeNull();
    expect(
      (
        await database
          .prepare(
            'SELECT draft_id,source_path,asset_id FROM publication_asset_pins WHERE job_id=? ORDER BY source_path',
          )
          .bind(child.id)
          .all()
      ).results,
    ).toEqual(pins.results);
    expect(
      await database
        .prepare('SELECT nonce FROM publication_runs WHERE job_id=?')
        .bind(child.id)
        .first<string>('nonce'),
    ).not.toBe(oldNonce);
    expect(
      await database
        .prepare("SELECT count(*) AS count FROM audit_events WHERE action='publish.captured-retry'")
        .first<number>('count'),
    ).toBe(1);
    verifyBase.mockClear();
    expect(await retryCapturedStaging(database, input, 'd'.repeat(40), verifyBase)).toEqual(first);
    expect(verifyBase).not.toHaveBeenCalled();
    await expect(
      retryCapturedStaging(
        database,
        { ...input, idempotencyKey: 'another-retry-request' },
        'a'.repeat(40),
        verifyBase,
      ),
    ).rejects.toThrow('PUBLICATION_RECOVERY_CHANGED');
    await database.prepare("UPDATE user_roles SET role='viewer' WHERE email=?").bind(subject).run();
    await expect(retryCapturedStaging(database, input, 'a'.repeat(40), verifyBase)).rejects.toThrow(
      'PUBLISH_AUTHORITY_CHANGED',
    );
    await database
      .prepare("UPDATE user_roles SET role='publisher' WHERE email=?")
      .bind(subject)
      .run();
    let current = child;
    for (let attempt = 2; attempt <= 4; attempt++) {
      const recovery = {
        ...input,
        jobId: current.id,
        idempotencyKey: `captured-retry-number-${attempt}`,
      };
      await recoverQueuedPublication(database, {
        ...recovery,
        action: 'cancel',
        idempotencyKey: `captured-cancel-number-${attempt}`,
      });
      if (attempt === 4) {
        await expect(
          retryCapturedStaging(database, recovery, 'a'.repeat(40), verifyBase),
        ).rejects.toThrow('PUBLICATION_RECOVERY_CHANGED');
        expect((await store.dispatchStatus(current.id))?.canRetryCaptured).toBe(false);
      } else {
        const next = await store.getById(
          (await retryCapturedStaging(database, recovery, 'a'.repeat(40), verifyBase)).jobId,
        );
        if (!next) throw new Error('Missing captured retry');
        current = next;
      }
    }
  },
);

it.each(['base', 'role', 'deployment', 'slot'] as const)(
  'does not create a retry when %s changes during the provider check',
  async (failure) => {
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
    const store = new D1PublishJobStore(database);
    const parent = await store.captureStaging({
      draft,
      actor: subject,
      workflowRevision: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      idempotencyKey: 'retry-race-parent',
      requestId: 'capture',
    });
    const input = {
      jobId: parent.id,
      action: 'retry-captured' as const,
      expectedAttempts: 0,
      actor: subject,
      idempotencyKey: 'retry-race-request',
      requestId: 'retry',
    };
    await recoverQueuedPublication(database, {
      ...input,
      action: 'cancel',
      idempotencyKey: 'retry-race-cancel',
    });
    const client = {
      currentMainSha: async () => {
        if (failure === 'base') return 'd'.repeat(40);
        if (failure === 'role')
          await database
            .prepare("UPDATE user_roles SET role='viewer' WHERE email=?")
            .bind(subject)
            .run();
        if (failure === 'deployment')
          await database
            .prepare("UPDATE publication_runs SET deploy_authorized_at='fixture' WHERE job_id=?")
            .bind(parent.id)
            .run();
        if (failure === 'slot')
          await store.captureStaging({
            draft,
            actor: subject,
            workflowRevision: 'a'.repeat(40),
            baseSha: 'b'.repeat(40),
            idempotencyKey: 'concurrent-capture',
            requestId: 'other',
          });
        return 'b'.repeat(40);
      },
      assertPublicationCaller: vi.fn((base: string, blob: string) => {
        expect(base).toBe('b'.repeat(40));
        expect(blob).toBe(PUBLICATION_CALLER_BLOB);
        return Promise.resolve();
      }),
      assertRendererCompatible: vi.fn(async () => {}),
      advanceCommit: vi.fn(),
      verificationForCommit: vi.fn(),
    };
    const publisher = new StagingPublisher(
      repository,
      {
        appId: '123',
        installationId: '456',
        privateKey: 'unused fixture',
        workflowRevision: 'a'.repeat(40),
      },
      undefined,
      store,
      undefined,
      () => Promise.resolve(client),
    );
    await expect(publisher.recoverQueued(input)).rejects.toThrow('PUBLICATION_RECOVERY_CHANGED');
    expect(client.assertPublicationCaller).toHaveBeenCalledTimes(failure === 'base' ? 0 : 1);
    expect(client.advanceCommit).not.toHaveBeenCalled();
    expect(
      await database
        .prepare('SELECT count(*) AS count FROM publication_retries')
        .first<number>('count'),
    ).toBe(0);
    expect(
      await database
        .prepare("SELECT count(*) AS count FROM audit_events WHERE action='publish.captured-retry'")
        .first<number>('count'),
    ).toBe(0);
  },
);

it.each(['reserved', 'claimed', 'committed', 'authorization-race'] as const)(
  'reconciles terminal %s execution only before deployment authorization',
  async (mode) => {
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
    const store = new D1PublishJobStore(database);
    const job = await store.captureStaging({
      draft,
      actor: subject,
      workflowRevision: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      idempotencyKey: 'terminal-capture-fixture',
      requestId: 'capture',
    });
    const nonce = await database
      .prepare('SELECT nonce FROM publication_runs WHERE job_id=?')
      .bind(job.id)
      .first<string>('nonce');
    const keys = await generateKeyPair('RS256');
    const runner = new D1PublicationRunner(database, () => Promise.resolve(keys.publicKey));
    const signed = (checkRunId: string) =>
      new SignJWT({
        ...publicationClaims({
          target: 'staging',
          jobId: job.id,
          nonce: nonce!,
          workflowRevision: 'a'.repeat(40),
          dispatchRevision: 'b'.repeat(40),
        }),
        check_run_id: checkRunId,
      })
        .setProtectedHeader({ alg: 'RS256' })
        .sign(keys.privateKey);
    await runner.reserve(job.id, await signed('23456'));
    if (mode !== 'reserved') await runner.claim(job.id, await signed('34567'));
    if (mode === 'committed')
      await database.batch([
        database
          .prepare(
            "UPDATE publication_runs SET commit_authorized_at='fixture-authorized' WHERE job_id=?",
          )
          .bind(job.id),
        database
          .prepare('UPDATE publish_jobs SET result_sha=? WHERE id=?')
          .bind('c'.repeat(40), job.id),
      ]);
    expect(await store.dispatchStatus(job.id)).toMatchObject({
      reserved: true,
      canReconcileStopped: true,
    });
    const run = {
      id: 12345,
      run_attempt: 1,
      status: 'completed',
      conclusion: 'failure',
      head_sha: 'b'.repeat(40),
      head_branch: 'main',
      event: 'repository_dispatch',
      path: '.github/workflows/publish-candidate.yml',
      repository: { id: 1357847426, full_name: 'PointCommunity/pointsite-staging' },
      referenced_workflows: [
        {
          path: `PointCommunity/pointsite-staging/.github/workflows/publish-runtime.yml@${'a'.repeat(40)}`,
          sha: 'a'.repeat(40),
        },
      ],
    };
    let override: Record<string, unknown> = {};
    let latestOverride: Record<string, unknown> = {};
    let authorizeDuringRead = false;
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      expect(init?.redirect).toBe('error');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const root =
        'https://api.github.com/repos/PointCommunity/pointsite-staging/actions/runs/12345';
      expect([root, `${root}/attempts/1`]).toContain(
        typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
      );
      if (url === root && authorizeDuringRead)
        await database
          .prepare("UPDATE publication_runs SET deploy_authorized_at='raced' WHERE job_id=?")
          .bind(job.id)
          .run();
      return Response.json({ ...run, ...override, ...(url === root ? latestOverride : {}) });
    });
    const input = {
      jobId: job.id,
      action: 'reconcile' as const,
      expectedAttempts: 0,
      actor: subject,
      idempotencyKey: 'reconcile-stopped-fixture',
      requestId: 'recover',
    };
    if (mode === 'reserved') {
      for (const changed of [
        { status: 'in_progress' },
        { head_sha: 'c'.repeat(40) },
        { run_attempt: 2 },
        { repository: { id: 1348084954, full_name: 'PointCommunity/pointsite' } },
        { referenced_workflows: [] },
      ]) {
        override = changed;
        await expect(recoverQueuedPublication(database, input, fetcher)).rejects.toThrow(
          'PUBLICATION_RUN_NOT_TERMINAL',
        );
      }
      override = {};
      latestOverride = { status: 'in_progress', run_attempt: 2 };
      await expect(recoverQueuedPublication(database, input, fetcher)).rejects.toThrow(
        'PUBLICATION_RUN_NOT_TERMINAL',
      );
      latestOverride = {};
      expect((await store.cloudAvailability()).state).toBe('busy');
    }
    if (mode === 'authorization-race') {
      authorizeDuringRead = true;
      await expect(recoverQueuedPublication(database, input, fetcher)).rejects.toThrow(
        'PUBLICATION_RECOVERY_CHANGED',
      );
      expect((await store.cloudAvailability()).state).toBe('busy');
      expect(await store.dispatchStatus(job.id)).toMatchObject({ canReconcileStopped: false });
      return;
    }
    await Promise.all([
      recoverQueuedPublication(database, input, fetcher),
      recoverQueuedPublication(database, input, fetcher),
    ]);
    expect((await store.getById(job.id))?.status).toBe('cancelled');
    expect((await store.getById(job.id))?.resultSha).toBe(
      mode === 'committed' ? 'c'.repeat(40) : null,
    );
    expect((await store.cloudAvailability()).state).toBe('available');
    fetcher.mockClear();
    await recoverQueuedPublication(database, input, fetcher);
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      await database
        .prepare("SELECT COUNT(*) n FROM audit_events WHERE action='publish.reconcile-requested'")
        .first('n'),
    ).toBe(1);
    await expect(runner.claim(job.id, await signed('34567'))).rejects.toThrow(
      'PUBLISH_RUNNER_UNAUTHORIZED',
    );
  },
);

it.each([
  [
    'https://builder-canary.eaglepass.io',
    'pointsite-staging-canary',
    'https://builder.eaglepass.io',
  ],
  ['https://builder.eaglepass.io', 'pointsite-staging', 'https://builder-canary.eaglepass.io'],
])(
  'binds capture, dispatch, recovery and signed runner access to %s',
  async (origin, name, otherOrigin) => {
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
    const store = new D1PublishJobStore(database, origin);
    const otherStore = new D1PublishJobStore(database, otherOrigin);
    const job = await store.captureStaging({
      draft,
      actor: subject,
      workflowRevision: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      idempotencyKey: 'isolated-capture-fixture',
      requestId: 'capture',
    });
    expect(
      await database
        .prepare('SELECT repository FROM publish_jobs WHERE id=?')
        .bind(job.id)
        .first('repository'),
    ).toBe(`PointCommunity/${name}`);
    expect(await otherStore.getById(job.id)).toBeNull();
    const keys = await generateKeyPair('RS256', { extractable: true });
    const config = {
      builderOrigin: origin,
      appId: '123',
      installationId: '456',
      privateKey: await exportPKCS8(keys.privateKey),
    };
    const calls: string[] = [];
    const fetcher: typeof fetch = (url, init) => {
      const value = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      calls.push(value);
      if (value.endsWith('/access_tokens')) {
        expect(body).toEqual({
          repositories: [name],
          permissions: { contents: 'write', checks: 'read', metadata: 'read' },
        });
        return Promise.resolve(
          Response.json({ token: 'fixture-installation-token', expires_at: 'fixture' }),
        );
      }
      expect(value).toContain(`/repos/PointCommunity/${name}/`);
      if (value.endsWith('/permission'))
        return Promise.resolve(Response.json({ permission: 'write', user: { id: 12345 } }));
      if (value.endsWith('/git/ref/heads/main'))
        return Promise.resolve(Response.json({ object: { sha: 'b'.repeat(40) } }));
      if (value.endsWith('/dispatches')) {
        expect(body).toMatchObject({
          client_payload: { builderOrigin: origin, jobId: job.id },
        });
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      throw new Error('Unexpected URL');
    };
    await expect(
      dispatchPublication(database, { ...config, builderOrigin: otherOrigin }, job.id, fetcher),
    ).rejects.toThrow('PUBLISH_DESTINATION_REJECTED');
    expect(calls).toHaveLength(0);
    await expect(
      otherStore.recoverQueued({
        jobId: job.id,
        action: 'cancel',
        expectedAttempts: 0,
        actor: subject,
        idempotencyKey: 'isolated-cancel-fixture',
        requestId: 'cancel',
      }),
    ).rejects.toThrow('PUBLICATION_RECOVERY_CHANGED');
    expect((await store.getById(job.id))?.status).toBe('queued');
    await dispatchPublication(database, config, job.id, fetcher);
    expect(calls).toHaveLength(4);
    const nonce = await database
      .prepare('SELECT nonce FROM publication_runs WHERE job_id=?')
      .bind(job.id)
      .first<string>('nonce');
    const signed = (builderOrigin: string) =>
      new SignJWT(
        publicationClaims({
          builderOrigin,
          target: 'staging',
          jobId: job.id,
          nonce: nonce!,
          workflowRevision: 'a'.repeat(40),
          dispatchRevision: 'b'.repeat(40),
        }),
      )
        .setProtectedHeader({ alg: 'RS256' })
        .sign(keys.privateKey);
    const runner = new D1PublicationRunner(
      database,
      () => Promise.resolve(keys.publicKey),
      config,
      fetcher,
    );
    await expect(runner.reserve(job.id, await signed(otherOrigin))).rejects.toThrow(
      'PUBLISH_RUNNER_UNAUTHORIZED',
    );
    const otherRunner = new D1PublicationRunner(
      database,
      () => Promise.resolve(keys.publicKey),
      { ...config, builderOrigin: otherOrigin },
      fetcher,
    );
    await expect(otherRunner.reserve(job.id, await signed(otherOrigin))).rejects.toThrow(
      'PUBLISH_RUNNER_UNAUTHORIZED',
    );
    await expect(runner.reserve(job.id, await signed(origin))).resolves.toEqual({ reserved: true });
  },
);

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
  await Promise.all([
    dispatchPendingPublication(database, config, fetcher),
    dispatchPendingPublication(database, config, fetcher),
  ]);
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
      client_payload: { jobId: job.id, nonce, builderOrigin: 'https://builder.pointatx.org' },
    },
  });
  expect((await new D1PublishJobStore(database).getById(job.id))?.status).toBe('queued');
  await expect(dispatchPublication(database, config, job.id, fetcher)).rejects.toThrow(
    'PUBLISH_DISPATCH_BACKOFF',
  );
  expect(calls).toHaveLength(4);
  await dispatchPendingPublication(database, config, fetcher);
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
  await resetBackoff();
  calls.length = 0;
  await dispatchPendingPublication(database, config, fetcher);
  expect(calls).toHaveLength(0);
  expect(await new D1PublishJobStore(database).dispatchStatus(job.id)).toMatchObject({
    attempts: 6,
    needsAttention: true,
  });
  const recovery = {
    jobId: job.id,
    action: 'retry' as const,
    expectedAttempts: 6,
    actor: subject,
    idempotencyKey: 'manual-dispatch-retry',
    requestId: 'manual-retry',
  };
  await expect(
    recoverQueuedPublication(database, { ...recovery, expectedAttempts: 5 }),
  ).rejects.toThrow('PUBLICATION_RECOVERY_CHANGED');
  await database.prepare("UPDATE user_roles SET role='editor' WHERE email=?").bind(subject).run();
  await expect(recoverQueuedPublication(database, recovery)).rejects.toThrow(
    'PUBLISH_AUTHORITY_CHANGED',
  );
  await database
    .prepare("UPDATE user_roles SET role='publisher' WHERE email=?")
    .bind(subject)
    .run();
  await Promise.all([
    recoverQueuedPublication(database, recovery),
    recoverQueuedPublication(database, recovery),
  ]);
  expect(await new D1PublishJobStore(database).dispatchStatus(job.id)).toMatchObject({
    attempts: 0,
    needsAttention: false,
  });
  expect(
    await database
      .prepare('SELECT nonce FROM publication_runs WHERE job_id=?')
      .bind(job.id)
      .first('nonce'),
  ).toBe(nonce);
  responseStatus = 204;
  await dispatchPendingPublication(database, config, fetcher);
  expect(await new D1PublishJobStore(database).dispatchStatus(job.id)).toMatchObject({
    attempts: 1,
  });
  await recoverQueuedPublication(database, recovery);
  expect(await new D1PublishJobStore(database).dispatchStatus(job.id)).toMatchObject({
    attempts: 1,
  });
  expect(
    await database
      .prepare("SELECT COUNT(*) n FROM audit_events WHERE action='publish.retry-requested'")
      .first('n'),
  ).toBe(1);
  await expect(
    recoverQueuedPublication(database, { ...recovery, action: 'cancel' }),
  ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
  const cancel = {
    ...recovery,
    action: 'cancel' as const,
    expectedAttempts: 1,
    idempotencyKey: 'cancel-queued-publication',
  };
  await Promise.all([
    recoverQueuedPublication(database, cancel),
    recoverQueuedPublication(database, cancel),
  ]);
  expect((await new D1PublishJobStore(database).getById(job.id))?.status).toBe('cancelled');
  expect(await new D1PublishJobStore(database).cloudAvailability()).toEqual({ state: 'available' });
  const runner = new D1PublicationRunner(database, () => Promise.resolve(keys.publicKey));
  const signed = (id: string, jobNonce: string) =>
    new SignJWT(
      publicationClaims({
        target: 'staging',
        jobId: id,
        nonce: jobNonce,
        workflowRevision: 'a'.repeat(40),
        dispatchRevision: 'b'.repeat(40),
      }),
    )
      .setProtectedHeader({ alg: 'RS256' })
      .sign(keys.privateKey);
  await expect(runner.reserve(job.id, await signed(job.id, nonce!))).rejects.toThrow(
    'PUBLISH_RUNNER_UNAUTHORIZED',
  );
  const next = await new D1PublishJobStore(database).captureStaging({
    draft,
    actor: subject,
    workflowRevision: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    idempotencyKey: 'next-after-cancellation',
    requestId: 'next',
  });
  await recoverQueuedPublication(database, cancel);
  expect(
    await database
      .prepare("SELECT job_id FROM publication_slots WHERE target='staging'")
      .first('job_id'),
  ).toBe(next.id);
  const nextNonce = await database
    .prepare('SELECT nonce FROM publication_runs WHERE job_id=?')
    .bind(next.id)
    .first<string>('nonce');
  const nextCancel = {
    ...cancel,
    jobId: next.id,
    expectedAttempts: 0,
    idempotencyKey: 'cancel-reservation-race',
  };
  const race = await Promise.allSettled([
    runner.reserve(next.id, await signed(next.id, nextNonce!)),
    recoverQueuedPublication(database, nextCancel),
  ]);
  expect(race.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  if (race[0].status === 'fulfilled') {
    await expect(recoverQueuedPublication(database, nextCancel)).rejects.toThrow(
      'PUBLICATION_RECOVERY_CHANGED',
    );
    expect(
      await database
        .prepare("SELECT job_id FROM publication_slots WHERE target='staging'")
        .first('job_id'),
    ).toBe(next.id);
  } else {
    await expect(runner.reserve(next.id, await signed(next.id, nextNonce!))).rejects.toThrow(
      'PUBLISH_RUNNER_UNAUTHORIZED',
    );
    expect(await new D1PublishJobStore(database).cloudAvailability()).toEqual({
      state: 'available',
    });
  }
}, 30_000);

it.each(['https://builder.eaglepass.io', 'https://builder-canary.eaglepass.io'])(
  'checks canonical runtime independently of %s destination while capturing and polling metadata',
  async (builderOrigin) => {
    const { database, repository, createInput } = await fixture();
    await database
      .prepare("UPDATE user_roles SET role='publisher' WHERE email=?")
      .bind(actor)
      .run();
    const draft = await repository.createDraft(createInput);
    const jobs = new D1PublishJobStore(database, builderOrigin),
      preflights = new D1PublishPreflightStore(database);
    const client = {
      currentMainSha: vi.fn(() => Promise.resolve('b'.repeat(40))),
      assertRendererCompatible: vi.fn(async () => {}),
      assertPublicationCaller: vi.fn(async () => {}),
      advanceCommit: vi.fn(),
      verificationForCommit: vi.fn(),
    };
    const clientFactory = vi.fn((name?: string) =>
      Promise.resolve(
        name === 'PointCommunity/pointsite-staging'
          ? client
          : {
              ...client,
              assertRendererCompatible: () =>
                Promise.reject(new Error('GitHub staging operation failed (404)')),
            },
      ),
    );
    const publisher = new StagingPublisher(
      repository,
      {
        appId: '123',
        installationId: '456',
        privateKey: 'unused',
        workflowRevision: PUBLICATION_WORKFLOW_REVISION,
        builderOrigin,
      },
      undefined,
      jobs,
      preflights,
      clientFactory,
    );
    const input = {
      draftId: draft.id,
      expectedRevisionId: draft.revision.id,
      expectedRevisionChecksum: draft.revision.checksum,
      actor,
      idempotencyKey: 'cloud-preflight-fixture',
      requestId: 'cloud-fixture',
    };
    const reads = vi.spyOn(database, 'prepare');
    const passed = await publisher.preflight(input);
    expect(passed.state).toBe('passed');
    expect(client.assertPublicationCaller).toHaveBeenCalledWith(
      'b'.repeat(40),
      PUBLICATION_CALLER_BLOB,
    );
    expect(client.assertRendererCompatible).toHaveBeenCalledWith(
      PUBLICATION_WORKFLOW_REVISION,
      expect.any(Object),
    );
    const capture = {
      ...input,
      expectedBaseSha: 'b'.repeat(40),
      idempotencyKey: 'cloud-capture-fixture',
    };
    const job = await publisher.publish(capture);
    expect(job).toMatchObject({
      status: 'queued',
      publicationProtocol: 2,
      candidateChecksum: passed.candidateChecksum,
    });
    const externalCalls = client.currentMainSha.mock.calls.length;
    expect(await publisher.publish(capture)).toEqual(job);
    expect(client.currentMainSha.mock.calls).toHaveLength(externalCalls);
    expect(client.advanceCommit).not.toHaveBeenCalled();
    expect(reads.mock.calls.map(([sql]) => sql).join('\n')).not.toMatch(/draft_asset_chunks/);
    const document = structuredClone(draft.document);
    document.media[0].alt = 'Later edit';
    await repository.saveDraft({
      draftId: draft.id,
      ...(await acquireDraftProof(repository, draft.id, actor)),
      document,
      actor,
      idempotencyKey: 'cloud-captured-later-edit',
      requestId: 'later-edit',
      action: { category: 'control-change', context: 'library-attachment' },
    });
    const fullRead = vi.spyOn(repository, 'getDraft');
    fullRead.mockClear();
    reads.mockClear();
    const status = await publisher.workflowForDraft(draft.id);
    expect(status).toMatchObject({
      preflight: { state: 'required', reason: 'revision-changed' },
      availability: { state: 'busy', phase: 'queued' },
      job: {
        id: job.jobId,
        revisionId: draft.revision.id,
        publicationProtocol: 2,
        dispatch: { attempts: 0, needsAttention: false },
      },
    });
    expect(await publisher.publish(capture)).toEqual(job);
    await expect(
      publisher.publish({ ...capture, expectedRevisionChecksum: 'f'.repeat(64) }),
    ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    await database.prepare('UPDATE user_roles SET active=0 WHERE email=?').bind(actor).run();
    await expect(publisher.publish(capture)).rejects.toThrow('PUBLISH_AUTHORITY_CHANGED');
    await database.prepare('UPDATE user_roles SET active=1 WHERE email=?').bind(actor).run();
    expect(fullRead).not.toHaveBeenCalled();
    reads.mockClear();
    await publisher.workflowForDraft(draft.id);
    expect(reads.mock.calls.map(([sql]) => sql).join('\n')).not.toMatch(
      /INSERT|UPDATE|DELETE|document_json|draft_asset_chunks/,
    );
    await expect(publisher.continuePublication(job.jobId!, actor, 'old-tab')).rejects.toThrow(
      'PUBLISH_JOB_NOT_CLAIMABLE',
    );
  },
  30_000,
);

it('rechecks cloud preflight authority atomically and rejects changed preflight at capture', async () => {
  const { database, repository, createInput } = await fixture();
  await database.prepare("UPDATE user_roles SET role='publisher' WHERE email=?").bind(actor).run();
  const draft = await repository.createDraft(createInput);
  const jobs = new D1PublishJobStore(database),
    preflights = new D1PublishPreflightStore(database);
  const prepared = await jobs.prepareInputs(draft, PUBLICATION_WORKFLOW_REVISION);
  const input = {
    draftId: draft.id,
    revisionId: draft.revision.id,
    revisionChecksum: draft.revision.checksum,
    actor,
    idempotencyKey: 'cloud-guarded-preflight',
    requestId: 'guard',
    publicationProtocol: 2 as const,
    rendererContractChecksum: 'c'.repeat(64),
    candidateChecksum: prepared.candidateChecksum,
    schemaVersion: draft.document.schemaVersion,
    rendererVersion: draft.document.rendererVersion,
    validatedBaseSha: 'b'.repeat(40),
    fileCount: prepared.candidate.fileCount,
  };
  const passed = await preflights.recordPassed(input);
  await database.prepare('UPDATE user_roles SET active=0 WHERE email=?').bind(actor).run();
  await expect(preflights.recordPassed(input)).rejects.toThrow();
  await expect(
    preflights.recordPassed({ ...input, idempotencyKey: 'revoked-cloud-preflight' }),
  ).rejects.toThrow();
  expect(await preflights.getByKey('revoked-cloud-preflight')).toBeNull();
  await database.prepare('UPDATE user_roles SET active=1 WHERE email=?').bind(actor).run();
  await preflights.recordFailed({
    ...input,
    idempotencyKey: 'invalidate-cloud-preflight',
    failureCode: 'PREFLIGHT_CANDIDATE_DRIFT',
  });
  await expect(
    jobs.captureStaging({
      draft,
      workflowRevision: PUBLICATION_WORKFLOW_REVISION,
      baseSha: 'b'.repeat(40),
      actor,
      idempotencyKey: 'rejected-cloud-capture',
      requestId: 'capture',
      preflightId: passed.id,
    }),
  ).rejects.toThrow();
  expect(await jobs.getByKey('rejected-cloud-capture')).toBeNull();
  expect(await jobs.cloudAvailability()).toEqual({ state: 'available' });
}, 30_000);

it.each(['revoked', 'verified', 'retry-base', 'retry-commit', 'retry-revocation'] as const)(
  'production %s',
  async (productionOutcome) => {
    const { database, repository, assets, createInput } = await fixture();
    const subject = 'github:12345';
    await database
      .prepare(
        `INSERT INTO user_roles(email,github_login,role,active,created_at,updated_at,updated_by)
    VALUES (?,'fixture-publisher','publisher',1,'fixture','fixture','fixture')`,
      )
      .bind(subject)
      .run();
    const draft = await repository.createDraft({ ...createInput, actor: subject });
    const jobs = new D1PublishJobStore(database);
    const job = await jobs.captureStaging({
      draft,
      actor: subject,
      workflowRevision: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      idempotencyKey: 'execution-owned-fixture',
      requestId: 'capture',
    });
    const seasonalDrafts: Awaited<ReturnType<typeof repository.createDraft>>[] = [];
    if (productionOutcome === 'verified') {
      for (const name of ['Spring', 'Summer', 'Winter']) {
        const season = await repository.createDraft({
          ...createInput,
          name,
          actor: subject,
          idempotencyKey: crypto.randomUUID(),
        });
        await database
          .prepare(
            "INSERT INTO draft_publication_baselines(draft_id,source_target,baseline_release_id,baseline_sequence) VALUES (?,'production','public-baseline-2026-09-13',1)",
          )
          .bind(season.id)
          .run();
        seasonalDrafts.push(season);
      }
      expect(new Set([draft.id, ...seasonalDrafts.map((season) => season.id)]).size).toBe(4);
    }
    const nonce = await database
      .prepare('SELECT nonce FROM publication_runs WHERE job_id=?')
      .bind(job.id)
      .first<string>('nonce');
    const keys = await generateKeyPair('RS256', { extractable: true });
    const claims = publicationClaims({
      target: 'staging',
      jobId: job.id,
      nonce: nonce!,
      workflowRevision: 'a'.repeat(40),
      dispatchRevision: job.baseSha,
    });
    const sign = (change = {}) =>
      new SignJWT({ ...claims, ...change })
        .setProtectedHeader({ alg: 'RS256' })
        .sign(keys.privateKey);
    const token = await sign();
    const github = await publicationGitHubFixture(
      job.id,
      job.candidateChecksum,
      draft.document.media.map((media) => media.sourcePath),
    );
    const workerVersionId = crypto.randomUUID();
    const jobUrl = `https://github.com/PointCommunity/pointsite-staging/actions/runs/${String(claims.run_id)}/job/${String(claims.check_run_id)}`;
    let completed = false;
    let publishedArtifactDigest = github.build.artifactDigest;
    let productionBase = 'f'.repeat(40);
    const provider: typeof fetch = async (url, init) => {
      const path = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      if (path.includes('/check-runs/'))
        return Response.json({
          id: Number(claims.check_run_id),
          status: completed ? 'completed' : 'in_progress',
          conclusion: 'success',
          head_sha: job.baseSha,
          details_url: jobUrl,
          app: { id: 15368, slug: 'github-actions' },
          deployment: { id: 1 },
        });
      if (path.includes('/statuses?'))
        return Response.json([
          {
            state: 'success',
            environment: 'staging',
            log_url: jobUrl,
            environment_url: 'https://staging.pointatx.org/',
          },
        ]);
      if (path.includes('/deployments?'))
        return Response.json([
          {
            id: 1,
            sha: job.baseSha,
            environment: 'staging',
            performed_via_github_app: { id: 15368, slug: 'github-actions' },
          },
        ]);
      if (path === 'https://staging.pointatx.org/__pointsite_release.json')
        return Response.json({
          format: 2,
          candidateChecksum: job.candidateChecksum,
          workflowRevision: 'a'.repeat(40),
          artifactDigest: publishedArtifactDigest,
        });
      if (path === 'https://api.github.com/repos/PointCommunity/pointsite/git/ref/heads/main')
        return Response.json({ object: { sha: productionBase } });
      return github.fetcher(url, init);
    };
    const config = {
      appId: '123',
      installationId: '456',
      privateKey: await exportPKCS8(keys.privateKey),
    };
    const runner = new D1PublicationRunner(
      database,
      () => Promise.resolve(keys.publicKey),
      config,
      provider,
    );
    await runner.reserve(
      job.id,
      await sign({ check_run_id: String(Number(claims.check_run_id) + 10) }),
    );
    await runner.claim(job.id, token);
    github.state.beforePermission = async () => {
      await database.prepare('UPDATE user_roles SET active=0 WHERE email=?').bind(subject).run();
    };
    await expect(runner.authorizeBuild(job.id, token, github.build)).rejects.toThrow();
    expect(
      await database
        .prepare('SELECT build_json FROM publication_runs WHERE job_id=?')
        .bind(job.id)
        .first('build_json'),
    ).toBeNull();
    await database.prepare('UPDATE user_roles SET active=1 WHERE email=?').bind(subject).run();
    github.state.beforePermission = () => Promise.resolve();
    await runner.authorizeBuild(job.id, token, github.build);
    await runner.authorizeBuild(job.id, token, github.build);
    await expect(
      runner.authorizeBuild(job.id, token, { ...github.build, commitSha: 'f'.repeat(40) }),
    ).rejects.toThrow();
    await expect(runner.authorizeDeployment(job.id, token)).rejects.toThrow(
      'PUBLICATION_COMMIT_UNCONFIRMED',
    );
    github.state.permission = 'read';
    await expect(runner.commitBuild(job.id, token)).rejects.toThrow(
      'PUBLISH_GITHUB_AUTHORITY_CHANGED',
    );
    expect(github.state.mutations).toBe(0);
    github.state.permission = 'write';
    await runner.commitBuild(job.id, token);
    await runner.commitBuild(job.id, token);
    expect(github.state.mutations).toBe(1);
    expect((await jobs.getById(job.id))?.status).toBe('running');
    await expect(
      runner.reportDeployment(job.id, token, { artifactDigest: github.build.artifactDigest }),
    ).rejects.toThrow('PUBLICATION_DEPLOYMENT_NOT_AUTHORIZED');
    await runner.authorizeDeployment(job.id, token);
    await runner.reportDeployment(job.id, token, { artifactDigest: github.build.artifactDigest });
    await expect(
      runner.reportDeployment(job.id, token, { workerVersionId: crypto.randomUUID() }),
    ).rejects.toThrow();
    await expect(runner.finalize(job.id, token)).rejects.toThrow();
    const finalizer = await sign({ check_run_id: String(Number(claims.check_run_id) + 1) });
    await expect(runner.finalize(job.id, finalizer)).rejects.toThrow(
      'PUBLICATION_VERIFICATION_UNCONFIRMED',
    );
    completed = true;
    await runner.finalize(job.id, finalizer);
    await runner.finalize(job.id, finalizer);
    expect((await jobs.getById(job.id))?.status).toBe('succeeded');
    expect(
      await database
        .prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='publish.verified'")
        .first('n'),
    ).toBe(1);
    expect(await database.prepare('SELECT COUNT(*) AS n FROM publication_slots').first('n')).toBe(
      1,
    );
    await expect(runner.inputs(job.id, token)).rejects.toThrow('PUBLISH_RUNNER_UNAUTHORIZED');
    await expect(runner.commitBuild(job.id, token)).rejects.toThrow('PUBLISH_RUNNER_UNAUTHORIZED');

    const approvals = new D1ApprovalService(database, config, provider);
    const expectedTuple = {
      siteId: 'pointsite' as const,
      revisionId: draft.revision.id,
      revisionChecksum: draft.revision.checksum,
      schemaVersion: draft.document.schemaVersion,
      rendererVersion: draft.document.rendererVersion,
      candidateChecksum: job.candidateChecksum,
      stagingBaseSha: job.baseSha,
      stagingCommitSha: github.build.commitSha,
      productionBaseSha: productionBase,
      publicationProtocol: 2 as const,
      workflowRevision: 'a'.repeat(40),
      artifactDigest: github.build.artifactDigest,
    };
    const decision = {
      publishJobId: job.id,
      expectedTuple,
      decision: 'approved' as const,
      actor: subject,
      requestId: 'accept-cloud',
      idempotencyKey: 'cloud-exact-acceptance',
      expectedApprovalId: null,
    };
    for (const role of ['viewer', 'editor']) {
      await database
        .prepare('UPDATE user_roles SET role=? WHERE email=?')
        .bind(role, subject)
        .run();
      await expect(approvals.record(decision)).rejects.toThrow('APPROVAL_AUTHORITY_CHANGED');
    }
    await database
      .prepare("UPDATE user_roles SET role='publisher' WHERE email=?")
      .bind(subject)
      .run();
    await expect(
      approvals.record({
        ...decision,
        expectedTuple: { ...expectedTuple, artifactDigest: '0'.repeat(64) },
      }),
    ).rejects.toThrow('APPROVAL_TUPLE_MISMATCH');
    const originalEvidence = JSON.stringify((await jobs.getById(job.id))!.evidence);
    for (const change of [
      { verificationStatus: 'failed' },
      { runId: '99999' },
      { checkRunId: '99999' },
      { artifactDigest: '0'.repeat(64) },
      { candidateChecksum: undefined },
    ]) {
      await database
        .prepare('UPDATE publish_jobs SET evidence_json=? WHERE id=?')
        .bind(JSON.stringify({ ...JSON.parse(originalEvidence), ...change }), job.id)
        .run();
      await expect(approvals.record(decision)).rejects.toThrow('APPROVAL_EVIDENCE_INCOMPLETE');
    }
    await database
      .prepare('UPDATE publish_jobs SET evidence_json=? WHERE id=?')
      .bind(originalEvidence, job.id)
      .run();
    publishedArtifactDigest = '9'.repeat(64);
    await expect(approvals.record(decision)).rejects.toThrow(
      'PUBLICATION_VERIFICATION_UNCONFIRMED',
    );
    publishedArtifactDigest = github.build.artifactDigest;
    github.state.main = job.baseSha;
    await expect(approvals.record(decision)).rejects.toThrow(
      'PUBLICATION_VERIFICATION_UNCONFIRMED',
    );
    github.state.main = github.build.commitSha;
    productionBase = '0'.repeat(40);
    await expect(approvals.record(decision)).rejects.toThrow('PRODUCTION_BASE_DRIFT');
    productionBase = expectedTuple.productionBaseSha;
    github.state.permission = 'read';
    await expect(approvals.record(decision)).rejects.toThrow('PUBLISH_GITHUB_AUTHORITY_CHANGED');
    github.state.permission = 'write';
    github.state.beforePermission = async () => {
      await database.prepare('UPDATE user_roles SET active=0 WHERE email=?').bind(subject).run();
    };
    await expect(approvals.record(decision)).rejects.toThrow('APPROVAL_STATE_CHANGED');
    await database.prepare('UPDATE user_roles SET active=1 WHERE email=?').bind(subject).run();
    github.state.beforePermission = () => Promise.resolve();
    expect(await approvals.getLatestForJob(job.id)).toBeNull();
    expect(await jobs.cloudAvailability()).toEqual({ state: 'busy', phase: 'review' });

    const [accepted, duplicate] = await Promise.all([
      approvals.record(decision),
      approvals.record(decision),
    ]);
    expect(accepted.id).toBe(duplicate.id);
    expect(await jobs.cloudAvailability()).toEqual({ state: 'available' });
    expect(await approvals.getLatestForJob(job.id)).toMatchObject({
      id: accepted.id,
      tuple: expectedTuple,
    });
    expect(
      await database
        .prepare("SELECT COUNT(*) n FROM audit_events WHERE action='approval.approved'")
        .first('n'),
    ).toBe(1);
    await expect(
      database
        .prepare("UPDATE approvals SET decision='revoked' WHERE id=?")
        .bind(accepted.id)
        .run(),
    ).rejects.toThrow('CLOUD_APPROVAL_IMMUTABLE');
    await expect(
      approvals.record({ ...decision, expectedApprovalId: accepted.id }),
    ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    await expect(
      approvals.record({ ...decision, idempotencyKey: 'different-cloud-acceptance' }),
    ).rejects.toThrow('APPROVAL_STATE_CHANGED');
    const revoked = await approvals.record({
      ...decision,
      decision: 'revoked',
      expectedApprovalId: accepted.id,
      idempotencyKey: 'cloud-revoked-acceptance',
    });
    // A lost acknowledgment returns its historical receipt; it never reinstates the old decision.
    expect((await approvals.record(decision)).id).toBe(accepted.id);
    expect(await approvals.getLatestForJob(job.id)).toMatchObject({
      id: revoked.id,
      decision: 'revoked',
    });
    expect(await approvals.eligibility(expectedTuple, productionBase)).toMatchObject({
      eligible: false,
      reason: 'NOT_APPROVED',
    });
    await database
      .prepare("UPDATE user_roles SET role='administrator' WHERE email=?")
      .bind(subject)
      .run();
    const approveAgain = {
      ...decision,
      expectedApprovalId: revoked.id,
      idempotencyKey: 'cloud-reapprove-acceptance',
    };
    // A newer revocation arriving during provider reads wins at the committing boundary.
    github.state.beforePermission = async () => {
      github.state.beforePermission = () => Promise.resolve();
      await approvals.record({
        ...decision,
        decision: 'revoked',
        expectedApprovalId: revoked.id,
        idempotencyKey: 'cloud-raced-revocation',
      });
    };
    await expect(approvals.record(approveAgain)).rejects.toThrow('APPROVAL_STATE_CHANGED');
    const latest = await approvals.getLatestForJob(job.id);
    const acceptedAgain = await approvals.record({
      ...approveAgain,
      expectedApprovalId: latest!.id,
    });
    expect(acceptedAgain.decision).toBe('approved');
    expect(await approvals.eligibility(expectedTuple, productionBase)).toMatchObject({
      eligible: true,
    });
    expect(
      await approvals.eligibility(
        { ...expectedTuple, artifactDigest: '0'.repeat(64) },
        productionBase,
      ),
    ).toMatchObject({ eligible: false, reason: 'CANDIDATE_DRIFT' });
    expect(github.state.mutations).toBe(1);
    const productionCaller = 'e'.repeat(40);
    const productionProvider: typeof fetch = (url, init) => {
      const path = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      if (path.includes('/pointsite/contents/.github/workflows/publish-candidate.yml'))
        return Promise.resolve(Response.json({ type: 'file', sha: productionCaller }));
      return provider(url, init);
    };
    const prepare = vi.fn((query: string) => database.prepare(query));
    const tracked = new Proxy(database, {
      get: (target, property) =>
        property === 'prepare' ? prepare : (Reflect.get(target, property) as unknown),
    });
    const production = new D1ProductionPublisher(
      tracked,
      { ...config, workflowRevision: expectedTuple.workflowRevision },
      productionCaller,
      productionProvider,
    );
    const promotion = {
      stagingJobId: job.id,
      approvalId: acceptedAgain.id,
      tuple: expectedTuple,
      actor: subject,
      requestId: 'promote-cloud',
      idempotencyKey: 'production-capture-fixture',
    };
    for (const role of ['viewer', 'editor', 'publisher']) {
      await database
        .prepare('UPDATE user_roles SET role=? WHERE email=?')
        .bind(role, subject)
        .run();
      await expect(production.capture(promotion)).rejects.toThrow('PRODUCTION_AUTHORITY_CHANGED');
    }
    await database
      .prepare("UPDATE user_roles SET role='administrator' WHERE email=?")
      .bind(subject)
      .run();
    await expect(production.capture({ ...promotion, approvalId: revoked.id })).rejects.toThrow(
      'PRODUCTION_ACCEPTANCE_CHANGED',
    );
    await expect(
      production.capture({
        ...promotion,
        tuple: { ...expectedTuple, artifactDigest: '0'.repeat(64) },
      }),
    ).rejects.toThrow('PRODUCTION_ACCEPTANCE_CHANGED');
    github.state.permission = 'read';
    await expect(production.capture(promotion)).rejects.toThrow('PUBLISH_GITHUB_AUTHORITY_CHANGED');
    github.state.permission = 'write';
    productionBase = '0'.repeat(40);
    await expect(production.capture(promotion)).rejects.toThrow();
    productionBase = expectedTuple.productionBaseSha;
    publishedArtifactDigest = '9'.repeat(64);
    await expect(production.capture(promotion)).rejects.toThrow(
      'PUBLICATION_VERIFICATION_UNCONFIRMED',
    );
    publishedArtifactDigest = github.build.artifactDigest;
    github.state.beforePermission = async () => {
      await database
        .prepare("UPDATE user_roles SET role='publisher' WHERE email=?")
        .bind(subject)
        .run();
    };
    await expect(production.capture(promotion)).rejects.toThrow('PRODUCTION_CAPTURE_CHANGED');
    github.state.beforePermission = () => Promise.resolve();
    await database
      .prepare("UPDATE user_roles SET role='administrator' WHERE email=?")
      .bind(subject)
      .run();
    const laterDocument = structuredClone(draft.document);
    laterDocument.pages[0].title = 'Later editorial changes';
    const replacement = await assets.prepareImage(draft.id, png, {
      filename: 'later.png',
      contentType: 'image/png',
      altText: 'Replacement',
      actor: subject,
    });
    await database.batch(replacement.statements);
    laterDocument.media[0].sourcePath = replacement.sourcePath;
    const later = await repository.saveDraft({
      draftId: draft.id,
      document: laterDocument,
      actor: subject,
      ...(await acquireDraftProof(repository, draft.id, subject)),
      action: { category: 'text-edit', context: 'draft' },
      idempotencyKey: 'later-production-editorial-change',
      requestId: 'later-edit',
    });
    expect(later.revision.id).not.toBe(draft.revision.id);
    prepare.mockClear();
    const productionApp = createApp({
      repository,
      production,
      environment: 'test',
      version: 'test',
      authenticate: () =>
        Promise.resolve({ email: subject, role: 'administrator', repositoryPermission: 'write' }),
    });
    const captureThroughHttp = async () => {
      const response = await productionApp.request(
        'https://builder.pointatx.org/api/publish/production',
        {
          method: 'POST',
          headers: {
            origin: 'https://builder.pointatx.org',
            'sec-fetch-site': 'same-origin',
            'content-type': 'application/json',
            'idempotency-key': promotion.idempotencyKey,
          },
          body: JSON.stringify({
            stagingJobId: promotion.stagingJobId,
            approvalId: promotion.approvalId,
            tuple: promotion.tuple,
          }),
        },
      );
      expect(response.status).toBe(202);
      return response.json<{ id: string; status: string }>();
    };
    const [promoted, repeated] = await Promise.all([
      captureThroughHttp(),
      production.capture(promotion),
    ]);
    expect(promoted).toEqual(repeated);
    expect(promoted.status).toBe('queued');
    const statusUrl = `https://builder.pointatx.org/api/publish/production/workflow?draftId=${draft.id}`;
    const statusResponse = await productionApp.request(statusUrl);
    expect(statusResponse.status).toBe(200);
    expect(await statusResponse.json()).toMatchObject({
      enabled: true,
      busy: true,
      job: {
        id: promoted.id,
        status: 'queued',
        revisionId: draft.revision.id,
        stagingJobId: job.id,
        approvalId: acceptedAgain.id,
        artifactDigest: expectedTuple.artifactDigest,
        dispatch: { reserved: false, canRetryCaptured: false },
      },
    });
    expect(await jobs.getById(promoted.id)).toBeNull();
    await expect(
      jobs.recoverQueued({
        jobId: promoted.id,
        actor: subject,
        action: 'cancel',
        expectedAttempts: 0,
        requestId: 'staging-route-production-boundary',
        idempotencyKey: 'staging-must-not-cancel-production',
      }),
    ).rejects.toThrow('PUBLICATION_RECOVERY_CHANGED');
    expect(await production.workflowForDraft(crypto.randomUUID(), subject)).toEqual({
      job: null,
      busy: true,
    });
    await database.prepare('UPDATE user_roles SET active=0 WHERE email=?').bind(subject).run();
    expect((await productionApp.request(statusUrl)).status).toBe(403);
    await database.prepare('UPDATE user_roles SET active=1 WHERE email=?').bind(subject).run();
    expect(
      prepare.mock.calls.some(([query]) => /document_json|draft_asset_chunks/.test(query)),
    ).toBe(false);
    expect(
      await database
        .prepare('SELECT revision_id FROM publication_inputs WHERE job_id=?')
        .bind(promoted.id)
        .first('revision_id'),
    ).toBe(draft.revision.id);
    expect(
      await database
        .prepare('SELECT COUNT(*) n FROM publication_asset_pins WHERE job_id=?')
        .bind(promoted.id)
        .first('n'),
    ).toBe(new Set(draft.document.media.map((media) => media.sourcePath)).size);
    expect(
      await database
        .prepare('SELECT source_path FROM publication_asset_pins WHERE job_id=?')
        .bind(promoted.id)
        .first('source_path'),
    ).toBe(draft.document.media[0].sourcePath);
    await expect(
      production.capture({ ...promotion, idempotencyKey: 'second-production-capture' }),
    ).rejects.toThrow('PRODUCTION_CAPTURE_CHANGED');
    await expect(
      production.capture({
        ...promotion,
        tuple: { ...expectedTuple, artifactDigest: '0'.repeat(64) },
      }),
    ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    if (productionOutcome.startsWith('retry-')) {
      // Model a stopped run already reconciled before deployment authorization.
      // The separate terminal-run tests prove that cancellation boundary.
      const retryBase = productionOutcome === 'retry-commit' ? 'd'.repeat(40) : productionBase;
      await database.batch([
        database
          .prepare("UPDATE publish_jobs SET status='cancelled',result_sha=? WHERE id=?")
          .bind(productionOutcome === 'retry-commit' ? retryBase : null, promoted.id),
        database.prepare('DELETE FROM publication_slots WHERE job_id=?').bind(promoted.id),
      ]);
      const recovery = {
        jobId: promoted.id,
        action: 'retry-captured' as const,
        expectedAttempts: 0,
        actor: subject,
        idempotencyKey: 'production-captured-retry',
        requestId: 'retry-production',
      };
      await expect(production.recoverQueued({ ...recovery, jobId: job.id })).rejects.toThrow(
        'PUBLICATION_RECOVERY_CHANGED',
      );
      for (const role of ['viewer', 'editor', 'publisher']) {
        await database
          .prepare('UPDATE user_roles SET role=? WHERE email=?')
          .bind(role, subject)
          .run();
        await expect(production.retryCaptured(recovery)).rejects.toThrow(
          'PUBLISH_AUTHORITY_CHANGED',
        );
      }
      await database
        .prepare("UPDATE user_roles SET role='administrator' WHERE email=?")
        .bind(subject)
        .run();
      productionBase = '0'.repeat(40);
      await expect(production.retryCaptured(recovery)).rejects.toThrow();
      productionBase = retryBase;
      publishedArtifactDigest = '9'.repeat(64);
      await expect(production.retryCaptured(recovery)).rejects.toThrow(
        'PUBLICATION_VERIFICATION_UNCONFIRMED',
      );
      publishedArtifactDigest = github.build.artifactDigest;
      github.state.beforePermission = async () => {
        await database
          .prepare("UPDATE user_roles SET role='publisher' WHERE email=?")
          .bind(subject)
          .run();
      };
      await expect(production.retryCaptured(recovery)).rejects.toThrow(
        'PUBLICATION_RECOVERY_CHANGED',
      );
      github.state.beforePermission = () => Promise.resolve();
      await database
        .prepare("UPDATE user_roles SET role='administrator' WHERE email=?")
        .bind(subject)
        .run();

      if (productionOutcome === 'retry-revocation') {
        github.state.beforePermission = async () => {
          github.state.beforePermission = () => Promise.resolve();
          await approvals.record({
            ...decision,
            decision: 'revoked',
            expectedApprovalId: acceptedAgain.id,
            idempotencyKey: 'revoke-during-production-retry',
          });
        };
        await expect(production.retryCaptured(recovery)).rejects.toThrow(
          'PUBLICATION_RECOVERY_CHANGED',
        );
        expect(
          await database.prepare('SELECT COUNT(*) n FROM publication_retries').first('n'),
        ).toBe(0);
        expect(await database.prepare('SELECT COUNT(*) n FROM publication_slots').first('n')).toBe(
          0,
        );
        await expect(production.retryCaptured(recovery)).rejects.toThrow(
          'PUBLICATION_RECOVERY_CHANGED',
        );
        return;
      }
      await database
        .prepare("INSERT INTO publication_slots(target,job_id) VALUES ('production',?)")
        .bind(job.id)
        .run();
      await expect(production.retryCaptured(recovery)).rejects.toThrow(
        'PUBLICATION_RECOVERY_CHANGED',
      );
      expect(
        await database
          .prepare("SELECT job_id FROM publication_slots WHERE target='production'")
          .first('job_id'),
      ).toBe(job.id);
      await database.prepare('DELETE FROM publication_slots WHERE job_id=?').bind(job.id).run();
      await database
        .prepare("UPDATE publication_runs SET deploy_authorized_at='fixture' WHERE job_id=?")
        .bind(promoted.id)
        .run();
      await expect(production.retryCaptured(recovery)).rejects.toThrow(
        'PUBLICATION_RECOVERY_CHANGED',
      );
      await database
        .prepare('UPDATE publication_runs SET deploy_authorized_at=NULL WHERE job_id=?')
        .bind(promoted.id)
        .run();

      for (const substituted of ['base', 'artifact', 'approval'] as const) {
        const forged = crypto.randomUUID();
        await expect(
          database.batch([
            database
              .prepare(
                `INSERT INTO publish_jobs(id,idempotency_key,environment,status,candidate_json,candidate_checksum,repository,base_sha,requested_by,requested_at)
            SELECT ?,?,'production-merge','queued',candidate_json,candidate_checksum,repository,?,requested_by,requested_at FROM publish_jobs WHERE id=?`,
              )
              .bind(
                forged,
                forged,
                substituted === 'base' ? '0'.repeat(40) : retryBase,
                promoted.id,
              ),
            database
              .prepare(
                `INSERT INTO publication_inputs(job_id,draft_id,revision_id,workflow_revision)
            SELECT ?,draft_id,revision_id,workflow_revision FROM publication_inputs WHERE job_id=?`,
              )
              .bind(forged, promoted.id),
            database
              .prepare(
                'INSERT INTO publication_retries(job_id,parent_job_id,attempt,request_hash) VALUES (?,?,1,?)',
              )
              .bind(forged, promoted.id, 'a'.repeat(64)),
            database
              .prepare(
                `INSERT INTO publication_promotions(job_id,staging_job_id,approval_id,artifact_digest,request_hash)
            VALUES (?,?,?,?,?)`,
              )
              .bind(
                forged,
                job.id,
                substituted === 'approval' ? revoked.id : acceptedAgain.id,
                substituted === 'artifact' ? '0'.repeat(64) : expectedTuple.artifactDigest,
                'a'.repeat(64),
              ),
          ]),
        ).rejects.toThrow(
          substituted === 'base' ? 'PUBLICATION_RETRY_MISMATCH' : 'PUBLICATION_PROMOTION_MISMATCH',
        );
        expect(
          await database.prepare('SELECT id FROM publish_jobs WHERE id=?').bind(forged).first(),
        ).toBeNull();
      }
      let loseResponse = true;
      const lostResponse = new Proxy(database, {
        get: (target, property) =>
          property === 'batch'
            ? async (statements: D1PreparedStatement[]) => {
                const result = await target.batch(statements);
                if (loseResponse) {
                  loseResponse = false;
                  throw new Error('Lost committed retry response');
                }
                return result;
              }
            : (Reflect.get(target, property) as unknown),
      });
      const retrying = new D1ProductionPublisher(
        lostResponse,
        { ...config, workflowRevision: expectedTuple.workflowRevision },
        productionCaller,
        productionProvider,
      );
      const [retried, duplicateRetry] = await Promise.all([
        retrying.retryCaptured(recovery),
        production.recoverQueued(recovery),
      ]);
      expect(retried).toEqual(duplicateRetry);
      expect(retried.jobId).not.toBe(promoted.id);
      expect(await production.workflowForDraft(draft.id, subject)).toMatchObject({
        job: { id: retried.jobId, revisionId: draft.revision.id, approvalId: acceptedAgain.id },
        busy: true,
      });
      const child = await database
        .prepare(
          `SELECT j.candidate_json,j.base_sha,pi.revision_id,pr.nonce,
        promotion.approval_id,promotion.artifact_digest FROM publish_jobs j
        JOIN publication_inputs pi ON pi.job_id=j.id JOIN publication_runs pr ON pr.job_id=j.id
        JOIN publication_promotions promotion ON promotion.job_id=j.id WHERE j.id=?`,
        )
        .bind(retried.jobId)
        .first<{
          candidate_json: string;
          base_sha: string;
          revision_id: string;
          nonce: string;
          approval_id: string;
          artifact_digest: string;
        }>();
      expect(child).toMatchObject({
        base_sha: retryBase,
        revision_id: draft.revision.id,
        approval_id: acceptedAgain.id,
        artifact_digest: expectedTuple.artifactDigest,
      });
      expect(JSON.parse(child!.candidate_json)).toEqual((await jobs.getById(job.id))!.candidate);
      expect(
        await database
          .prepare('SELECT source_path FROM publication_asset_pins WHERE job_id=?')
          .bind(retried.jobId)
          .first('source_path'),
      ).toBe(draft.document.media[0].sourcePath);
      expect(child!.nonce).not.toBe(
        await database
          .prepare('SELECT nonce FROM publication_runs WHERE job_id=?')
          .bind(promoted.id)
          .first('nonce'),
      );
      await expect(
        production.retryCaptured({ ...recovery, idempotencyKey: 'second-production-retry' }),
      ).rejects.toThrow('PUBLICATION_RECOVERY_CHANGED');
      expect(
        await database
          .prepare("SELECT COUNT(*) n FROM audit_events WHERE action='publish.captured-retry'")
          .first('n'),
      ).toBe(1);

      const noRequests = vi.fn<typeof fetch>(() =>
        Promise.reject(new Error('Receipt must not call provider')),
      );
      const receipts = new D1ProductionPublisher(
        database,
        { ...config, workflowRevision: expectedTuple.workflowRevision },
        productionCaller,
        noRequests,
      );
      expect(await receipts.retryCaptured(recovery)).toEqual(retried);
      expect(noRequests).not.toHaveBeenCalled();
      await expect(
        recoverQueuedPublication(database, { ...recovery, action: 'cancel' }),
      ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
      let latestRetry = retried;
      for (let attempt = 2; attempt <= 4; attempt++) {
        await recoverQueuedPublication(database, {
          ...recovery,
          jobId: latestRetry.jobId,
          action: 'cancel',
          idempotencyKey: `cancel-production-retry-${attempt}`,
        });
        const again = {
          ...recovery,
          jobId: latestRetry.jobId,
          idempotencyKey: `retry-production-number-${attempt}`,
        };
        if (attempt === 4) {
          await expect(production.retryCaptured(again)).rejects.toThrow(
            'PUBLICATION_RECOVERY_CHANGED',
          );
        } else {
          latestRetry = await production.retryCaptured(again);
        }
      }
      expect(await database.prepare('SELECT COUNT(*) n FROM publication_retries').first('n')).toBe(
        3,
      );
      // Test the last permitted child's signed execution without manufacturing another retry.
      await database.batch([
        database
          .prepare("UPDATE publish_jobs SET status='queued' WHERE id=?")
          .bind(latestRetry.jobId),
        database
          .prepare("INSERT INTO publication_slots(target,job_id) VALUES ('production',?)")
          .bind(latestRetry.jobId),
      ]);
      const lastNonce = await database
        .prepare('SELECT nonce FROM publication_runs WHERE job_id=?')
        .bind(latestRetry.jobId)
        .first<string>('nonce');
      const signedRetry = (checkRunId: string) =>
        new SignJWT({
          ...publicationClaims({
            target: 'production',
            jobId: latestRetry.jobId,
            nonce: lastNonce!,
            workflowRevision: expectedTuple.workflowRevision,
            dispatchRevision: retryBase,
          }),
          check_run_id: checkRunId,
        })
          .setProtectedHeader({ alg: 'RS256' })
          .sign(keys.privateKey);
      await runner.reserve(latestRetry.jobId, await signedRetry('99999'));
      const retryToken = await signedRetry('99998');
      await runner.claim(latestRetry.jobId, retryToken);
      expect((await runner.inputs(latestRetry.jobId, retryToken)).document).toEqual(draft.document);
      await expect(
        runner.authorizeBuild(latestRetry.jobId, retryToken, {
          ...github.build,
          artifactDigest: '0'.repeat(64),
        }),
      ).rejects.toThrow('PUBLICATION_OUTPUT_MISMATCH');
      // A newer decision fences the retry's signed execution as well as its original parent.
      await approvals.record({
        ...decision,
        decision: 'revoked',
        expectedApprovalId: acceptedAgain.id,
        idempotencyKey: 'revoke-production-retry',
      });
      await expect(runner.inputs(latestRetry.jobId, retryToken)).rejects.toThrow(
        'PUBLISH_RUNNER_UNAUTHORIZED',
      );
      expect(await receipts.retryCaptured(recovery)).toEqual(retried);
      await database
        .prepare("UPDATE user_roles SET role='publisher' WHERE email=?")
        .bind(subject)
        .run();
      await expect(receipts.retryCaptured(recovery)).rejects.toThrow('PUBLISH_AUTHORITY_CHANGED');
      return;
    }
    const productionNonce = await database
      .prepare('SELECT nonce FROM publication_runs WHERE job_id=?')
      .bind(promoted.id)
      .first<string>('nonce');
    const productionClaims = publicationClaims({
      target: 'production',
      jobId: promoted.id,
      nonce: productionNonce!,
      workflowRevision: expectedTuple.workflowRevision,
      dispatchRevision: productionBase,
    });
    const signProduction = (change = {}) =>
      new SignJWT({ ...productionClaims, ...change })
        .setProtectedHeader({ alg: 'RS256' })
        .sign(keys.privateKey);
    const productionToken = await signProduction();
    await runner.reserve(promoted.id, await signProduction({ check_run_id: '99999' }));
    await runner.claim(promoted.id, productionToken);
    expect((await runner.inputs(promoted.id, productionToken)).document).toEqual(draft.document);
    await expect(
      runner.authorizeBuild(promoted.id, productionToken, {
        ...github.build,
        artifactDigest: '0'.repeat(64),
      }),
    ).rejects.toThrow('PUBLICATION_OUTPUT_MISMATCH');
    await runner.authorizeBuild(promoted.id, productionToken, github.build);
    await database
      .prepare("UPDATE user_roles SET role='publisher' WHERE email=?")
      .bind(subject)
      .run();
    await expect(runner.inputs(promoted.id, productionToken)).rejects.toThrow(
      'PUBLISH_RUNNER_UNAUTHORIZED',
    );
    await database
      .prepare("UPDATE user_roles SET role='administrator' WHERE email=?")
      .bind(subject)
      .run();
    if (productionOutcome === 'revoked') {
      await approvals.record({
        ...decision,
        decision: 'revoked',
        expectedApprovalId: acceptedAgain.id,
        idempotencyKey: 'revoke-captured-production',
      });
      await expect(
        runner.authorizeBuild(promoted.id, productionToken, github.build),
      ).rejects.toThrow('PUBLISH_RUNNER_UNAUTHORIZED');
      await expect(
        dispatchPublication(database, config, promoted.id, productionProvider),
      ).rejects.toThrow('PUBLISH_DISPATCH_UNAVAILABLE');
      expect(await production.capture(promotion)).toEqual({ ...promoted, status: 'running' });
    } else {
      const productionGithub = await publicationGitHubFixture(
        promoted.id,
        job.candidateChecksum,
        draft.document.media.map((media) => media.sourcePath),
        'production',
        productionBase,
      );
      let productionCompleted = false;
      const productionJobUrl = `https://github.com/PointCommunity/pointsite/actions/runs/${String(productionClaims.run_id)}/job/${String(productionClaims.check_run_id)}`;
      const productionExecution: typeof fetch = async (url, init) => {
        const path = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
        if (path.includes('/check-runs/'))
          return Response.json({
            id: Number(productionClaims.check_run_id),
            status: productionCompleted ? 'completed' : 'in_progress',
            conclusion: 'success',
            head_sha: productionBase,
            details_url: productionJobUrl,
            app: { id: 15368, slug: 'github-actions' },
            deployment: { id: 2 },
          });
        if (path.includes('/statuses?'))
          return Response.json([
            {
              state: 'success',
              environment: 'github-pages',
              log_url: productionJobUrl,
              environment_url: 'https://pointatx.org/',
            },
          ]);
        if (path.includes('/deployments?'))
          return Response.json([
            {
              id: 2,
              sha: productionBase,
              environment: 'github-pages',
              performed_via_github_app: { id: 15368, slug: 'github-actions' },
            },
          ]);
        if (path === 'https://pointatx.org/__pointsite_release.json')
          return Response.json({
            format: 2,
            candidateChecksum: job.candidateChecksum,
            artifactDigest: github.build.artifactDigest,
            workflowRevision: expectedTuple.workflowRevision,
          });
        return productionGithub.fetcher(url, init);
      };
      const executor = new D1PublicationRunner(
        database,
        () => Promise.resolve(keys.publicKey),
        config,
        productionExecution,
      );
      await executor.commitBuild(promoted.id, productionToken);
      await executor.commitBuild(promoted.id, productionToken);
      expect(productionGithub.state.mutations).toBe(1);
      await expect(
        executor.reportDeployment(promoted.id, productionToken, {
          artifactDigest: github.build.artifactDigest,
        }),
      ).rejects.toThrow('PUBLICATION_DEPLOYMENT_NOT_AUTHORIZED');
      await executor.authorizeDeployment(promoted.id, productionToken);
      await expect(
        executor.reportDeployment(promoted.id, productionToken, { workerVersionId }),
      ).rejects.toThrow();
      await expect(
        executor.reportDeployment(promoted.id, productionToken, { artifactDigest: '0'.repeat(64) }),
      ).rejects.toThrow();
      await executor.reportDeployment(promoted.id, productionToken, {
        artifactDigest: github.build.artifactDigest,
      });
      const productionFinalizer = await signProduction({ check_run_id: '99998' });
      await expect(executor.finalize(promoted.id, productionFinalizer)).rejects.toThrow(
        'PUBLICATION_VERIFICATION_UNCONFIRMED',
      );
      const newerDraft = await repository.getDraft(draft.id);
      expect(newerDraft.publication).toMatchObject({
        state: 'unknown',
        displayCount: newerDraft.revision.sequence - 1,
      });
      productionCompleted = true;
      await Promise.all([
        executor.finalize(promoted.id, productionFinalizer),
        executor.finalize(promoted.id, productionFinalizer),
      ]);
      expect(
        await database
          .prepare("SELECT job_id FROM publication_slots WHERE target='production'")
          .first(),
      ).toBeNull();
      expect(
        await database
          .prepare('SELECT status FROM publish_jobs WHERE id=?')
          .bind(promoted.id)
          .first('status'),
      ).toBe('succeeded');
      const releases = await database
        .prepare('SELECT * FROM publication_releases ORDER BY sequence')
        .all();
      expect(releases.results).toHaveLength(2);
      const [baseline, released] = releases.results;
      expect(baseline).toMatchObject({
        kind: 'baseline',
        job_id: null,
        artifact_digest: '45562c9e111136f631c901892d2f1058e45050e93fa8d507f5beb0858eb68894',
      });
      expect(released).toMatchObject({
        id: promoted.id,
        job_id: promoted.id,
        kind: 'publication',
        previous_release_id: baseline.id,
        artifact_digest: github.build.artifactDigest,
      });
      expect((await repository.getDraft(draft.id)).publication).toMatchObject({
        state: 'published',
        displayCount: newerDraft.revision.sequence - draft.revision.sequence,
      });
      for (const season of seasonalDrafts) {
        const unchanged = await repository.getDraft(season.id);
        expect(unchanged).toMatchObject({
          name: season.name,
          latestRevisionId: season.latestRevisionId,
          publication: { state: 'behind', displayCount: 0 },
        });
        expect((await repository.listRevisions(season.id)).map((revision) => revision.id)).toEqual([
          season.latestRevisionId,
        ]);
      }
      expect(JSON.parse(String(released.source_json))).toMatchObject({
        repository: 'PointCommunity/pointsite',
        commitSha: github.build.commitSha,
        workflowRevision: expectedTuple.workflowRevision,
        candidateChecksum: job.candidateChecksum,
      });
      expect(JSON.parse(String(released.evidence_json))).toMatchObject({
        deploymentId: '2',
        verificationStatus: 'passed',
      });
      await expect(
        database
          .prepare('UPDATE publication_releases SET artifact_digest=? WHERE id=?')
          .bind('0'.repeat(64), promoted.id)
          .run(),
      ).rejects.toThrow('PUBLICATION_RELEASE_IMMUTABLE');
      await expect(
        database.prepare('DELETE FROM publication_releases WHERE id=?').bind(promoted.id).run(),
      ).rejects.toThrow('PUBLICATION_RELEASE_RETAINED');
      await expect(
        database.prepare('DELETE FROM publication_inputs WHERE job_id=?').bind(promoted.id).run(),
      ).rejects.toThrow('PUBLICATION_RELEASE_INPUTS_RETAINED');
      await expect(
        database
          .prepare('DELETE FROM publication_asset_pins WHERE job_id=?')
          .bind(promoted.id)
          .run(),
      ).rejects.toThrow('PUBLICATION_RELEASE_INPUTS_RETAINED');
      const noRequests = vi.fn<typeof fetch>(() =>
        Promise.reject(new Error('No provider request expected for a receipt')),
      );
      const receiptRunner = new D1PublicationRunner(
        database,
        () => Promise.resolve(keys.publicKey),
        config,
        noRequests,
      );
      await expect(receiptRunner.finalize(promoted.id, productionFinalizer)).resolves.toEqual({
        verified: true,
      });
      await expect(receiptRunner.finalize(job.id, finalizer)).resolves.toEqual({ verified: true });
      expect(noRequests).not.toHaveBeenCalled();
      await expect(receiptRunner.finalize(promoted.id, productionToken)).rejects.toThrow(
        'PUBLISH_RUNNER_UNAUTHORIZED',
      );
      await expect(
        receiptRunner.finalize(
          promoted.id,
          await signProduction({ check_run_id: '99998', run_id: '54321' }),
        ),
      ).rejects.toThrow('PUBLISH_RUNNER_UNAUTHORIZED');
      await database
        .prepare("UPDATE user_roles SET role='publisher' WHERE email=?")
        .bind(subject)
        .run();
      await expect(receiptRunner.finalize(promoted.id, productionFinalizer)).rejects.toThrow(
        'PUBLISH_RUNNER_UNAUTHORIZED',
      );
    }
    expect(
      await database
        .prepare("SELECT COUNT(*) n FROM audit_events WHERE action='publish.production-captured'")
        .first('n'),
    ).toBe(1);
  },
  30_000,
);

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
  ).toBe(409);
  expect(authenticate).not.toHaveBeenCalled();
  await expect(runner.claim(job.id, token)).rejects.toThrow();
  const reservation = await sign({ check_run_id: String(Number(claims.check_run_id) + 10) });
  await runner.reserve(job.id, reservation);
  await runner.reserve(job.id, reservation);
  expect(
    (
      await app.request(`${runnerUrl}/claim`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      })
    ).status,
  ).toBe(200);
  await expect(runner.reserve(job.id, await sign({ run_id: '99999' }))).rejects.toThrow(
    'PUBLISH_RUNNER_UNAUTHORIZED',
  );
  await expect(runner.claim(job.id, reservation)).rejects.toThrow();
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
  const withUnused = structuredClone(draft);
  withUnused.document.media.push({
    id: crypto.randomUUID(),
    sourcePath: '/assets/unused.webp',
    alt: 'Unused',
  });
  withUnused.revision.checksum = await checksumDocument(withUnused.document);
  const selected = await preparePublicationInputs(
    database,
    withUnused,
    crypto.randomUUID(),
    workflow,
  );
  expect(selected.assets).toEqual(input.assets);
  expect(selected.candidate.mediaSelection).toBe('referenced');
  expect(selected.candidate.revisionChecksum).toBe(withUnused.revision.checksum);
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

it('retires bounded publication metadata without deleting content or replaying old captures', async () => {
  const { database, repository, createInput } = await fixture();
  const subject = 'github:12345';
  await database
    .prepare(
      `INSERT INTO user_roles(email,github_login,role,active,created_at,updated_at,updated_by)
    VALUES (?,'fixture-admin','administrator',1,'fixture','fixture','fixture')`,
    )
    .bind(subject)
    .run();
  const draft = await repository.createDraft({ ...createInput, actor: subject });
  const jobs = new D1PublishJobStore(database);
  const input = {
    draft,
    workflowRevision: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    actor: subject,
    requestId: 'retention-fixture',
  };
  const captured = [];
  for (let index = 0; index < 3; index++) {
    const job = await jobs.captureStaging({
      ...input,
      idempotencyKey: `metadata-retention-${index}`,
    });
    await database.batch([
      database.prepare('DELETE FROM publication_slots WHERE job_id=?').bind(job.id),
      database
        .prepare('UPDATE publish_jobs SET status=?,completed_at=?,evidence_json=? WHERE id=?')
        .bind(
          index === 2 ? 'succeeded' : 'cancelled',
          `202${index}-01-01T00:00:00.000Z`,
          index === 2 ? '{"verificationStatus":"passed"}' : '{}',
          job.id,
        ),
    ]);
    captured.push(job);
  }
  const [old, held, current] = captured;
  await database
    .prepare("INSERT INTO publication_slots(target,job_id) VALUES ('staging',?)")
    .bind(held.id)
    .run();
  const chunks = await database.prepare('SELECT count(*) n FROM draft_asset_chunks').first('n');
  await database.exec(
    "CREATE TRIGGER block_retirement BEFORE INSERT ON audit_events WHEN NEW.action='publication.retired' BEGIN SELECT RAISE(ABORT,'fixture-blocked'); END;",
  );
  await expect(retirePublicationMetadata(database)).rejects.toThrow('fixture-blocked');
  expect(await jobs.getById(old.id)).not.toBeNull();
  expect(
    await database
      .prepare('SELECT 1 FROM publication_tombstones WHERE job_id=?')
      .bind(old.id)
      .first(),
  ).toBeNull();
  expect(
    await database.prepare('SELECT 1 FROM publication_inputs WHERE job_id=?').bind(old.id).first(),
  ).not.toBeNull();
  await database.exec('DROP TRIGGER block_retirement;');
  expect(await retirePublicationMetadata(database)).toEqual({ jobs: 1, releases: 0 });
  expect(await jobs.getById(old.id)).toBeNull();
  expect(await jobs.getById(held.id)).not.toBeNull();
  expect(await jobs.getById(current.id)).not.toBeNull();
  expect(await database.prepare('SELECT count(*) n FROM draft_asset_chunks').first('n')).toBe(
    chunks,
  );
  expect((await repository.getDraft(draft.id)).document).toEqual(draft.document);
  await expect(
    jobs.captureStaging({ ...input, idempotencyKey: 'metadata-retention-0' }),
  ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
  await expect(
    database
      .prepare(
        `INSERT INTO publish_jobs(id,idempotency_key,environment,status,candidate_json,candidate_checksum,repository,base_sha,requested_by,requested_at)
    SELECT ?,'metadata-retention-0',environment,'queued',candidate_json,candidate_checksum,repository,base_sha,requested_by,requested_at FROM publish_jobs WHERE id=?`,
      )
      .bind(crypto.randomUUID(), held.id)
      .run(),
  ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
  const provider = vi.fn(() => Promise.reject(new Error('must not call provider')));
  const production = new D1ProductionPublisher(
    database,
    { appId: '1', installationId: '1', privateKey: 'unused', workflowRevision: 'a'.repeat(40) },
    'b'.repeat(40),
    provider,
  );
  await expect(
    production.capture({
      stagingJobId: current.id,
      approvalId: crypto.randomUUID(),
      actor: subject,
      requestId: 'old-key',
      idempotencyKey: 'metadata-retention-0',
      tuple: {
        siteId: 'pointsite',
        revisionId: draft.revision.id,
        revisionChecksum: draft.revision.checksum,
        schemaVersion: draft.revision.schemaVersion,
        rendererVersion: draft.revision.rendererVersion,
        candidateChecksum: current.candidateChecksum,
        stagingBaseSha: 'b'.repeat(40),
        stagingCommitSha: 'c'.repeat(40),
        productionBaseSha: 'd'.repeat(40),
        publicationProtocol: 2,
        workflowRevision: 'a'.repeat(40),
        artifactDigest: 'e'.repeat(64),
      },
    }),
  ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
  expect(provider).not.toHaveBeenCalled();
  expect(await retirePublicationMetadata(database)).toEqual({ jobs: 0, releases: 0 });
  await database.prepare('DELETE FROM publication_slots WHERE job_id=?').bind(held.id).run();
  const raced = new Proxy(database, {
    get(target, property) {
      if (property === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          await database
            .prepare("INSERT INTO publication_slots(target,job_id) VALUES ('staging',?)")
            .bind(held.id)
            .run();
          return database.batch(statements);
        };
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? (value.bind(target) as unknown) : value;
    },
  });
  await expect(retirePublicationMetadata(raced)).rejects.toThrow('PUBLICATION_RETENTION_CHANGED');
  expect(await jobs.getById(held.id)).not.toBeNull();
  expect(
    await database
      .prepare('SELECT 1 FROM publication_tombstones WHERE job_id=?')
      .bind(held.id)
      .first(),
  ).toBeNull();
}, 30_000);

it('retains the last two releases and recent evidence while retiring one old release', async () => {
  const { database, repository, createInput } = await fixture();
  const subject = 'github:12345';
  await database
    .prepare(
      `INSERT INTO user_roles(email,github_login,role,active,created_at,updated_at,updated_by)
    VALUES (?,'fixture-admin','administrator',1,'fixture','fixture','fixture')`,
    )
    .bind(subject)
    .run();
  const draft = await repository.createDraft({ ...createInput, actor: subject });
  const jobs = new D1PublishJobStore(database);
  const stage = await jobs.captureStaging({
    draft,
    workflowRevision: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    actor: subject,
    requestId: 'retained-releases',
    idempotencyKey: 'retained-staging-source',
  });
  await database.batch([
    database.prepare('DELETE FROM publication_slots WHERE job_id=?').bind(stage.id),
    database
      .prepare(
        `UPDATE publish_jobs SET status='succeeded',completed_at='2020-01-01T00:00:00.000Z',
      evidence_json='{"verificationStatus":"passed"}' WHERE id=?`,
      )
      .bind(stage.id),
  ]);
  const ids: string[] = [];
  const artifactDigest = 'c'.repeat(64);
  for (let index = 0; index < 4; index++) {
    const id = crypto.randomUUID();
    ids.push(id);
    const build = {
      artifactDigest,
      commitSha: 'd'.repeat(40),
      treeSha: 'e'.repeat(40),
      manifestBlobSha: 'f'.repeat(40),
      fileCount: 1,
      totalBytes: 100,
    };
    const evidence = {
      format: 2,
      verificationStatus: 'passed',
      artifactDigest,
      commitSha: build.commitSha,
      candidateChecksum: stage.candidateChecksum,
      workflowRevision: 'a'.repeat(40),
      dispatchRevision: 'b'.repeat(40),
      runId: String(8000 + index),
      checkRunId: String(9000 + index),
      deploymentId: String(10000 + index),
    };
    const source = {
      repository: 'PointCommunity/pointsite',
      ...build,
      workflowRevision: 'a'.repeat(40),
      candidateChecksum: stage.candidateChecksum,
    };
    await database.batch([
      database
        .prepare(
          `INSERT INTO publish_jobs(id,idempotency_key,environment,status,candidate_json,candidate_checksum,
        repository,base_sha,result_sha,evidence_json,requested_by,requested_at,completed_at)
        SELECT ?,?,'production-merge','succeeded',candidate_json,candidate_checksum,'PointCommunity/pointsite',base_sha,?,?,
        requested_by,requested_at,'2020-01-01T00:00:00.000Z' FROM publish_jobs WHERE id=?`,
        )
        .bind(
          id,
          `historical-production-${index}`,
          build.commitSha,
          JSON.stringify(evidence),
          stage.id,
        ),
      database
        .prepare(
          `INSERT INTO publication_inputs(job_id,draft_id,revision_id,workflow_revision)
        SELECT ?,draft_id,revision_id,workflow_revision FROM publication_inputs WHERE job_id=?`,
        )
        .bind(id, stage.id),
      database
        .prepare(
          `INSERT INTO publication_asset_pins(job_id,draft_id,source_path,asset_id)
        SELECT ?,draft_id,source_path,asset_id FROM publication_asset_pins WHERE job_id=?`,
        )
        .bind(id, stage.id),
      database
        .prepare(
          `INSERT INTO publication_runs(job_id,nonce,dispatch_revision,run_id,run_attempt,check_run_id,claimed_at,
        build_json,deploy_authorized_at,deployment_json) VALUES (?,?,?,?,'1',?,'2020-01-01',?,'2020-01-01',?)`,
        )
        .bind(
          id,
          String(index + 1).repeat(64),
          evidence.dispatchRevision,
          evidence.runId,
          evidence.checkRunId,
          JSON.stringify(build),
          JSON.stringify({ artifactDigest }),
        ),
      database
        .prepare(
          `INSERT INTO publication_releases(id,kind,job_id,previous_release_id,artifact_digest,source_json,evidence_json,verified_at,recorded_at)
        VALUES (?,'publication',?,(SELECT id FROM publication_releases ORDER BY sequence DESC LIMIT 1),?,?,?,?,?)`,
        )
        .bind(
          id,
          id,
          artifactDigest,
          JSON.stringify(source),
          JSON.stringify(evidence),
          '2020-01-01T00:00:00.000Z',
          index === 1 ? new Date().toISOString() : '2020-01-01T00:00:00.000Z',
        ),
    ]);
  }
  expect((await repository.getDraft(draft.id)).publication).toMatchObject({
    state: 'published',
    displayCount: 0,
  });
  expect(
    await database
      .prepare(
        'SELECT baseline_release_id,baseline_sequence FROM draft_publication_baselines WHERE draft_id=?',
      )
      .bind(draft.id)
      .first(),
  ).toMatchObject({ baseline_release_id: ids[3], baseline_sequence: draft.revision.sequence });
  expect(await retirePublicationMetadata(database)).toEqual({ jobs: 1, releases: 1 });
  expect(
    await database.prepare('SELECT 1 FROM publish_jobs WHERE id=?').bind(ids[0]).first(),
  ).toBeNull();
  expect(
    await database.prepare('SELECT 1 FROM publication_releases WHERE id=?').bind(ids[0]).first(),
  ).toBeNull();
  for (const id of [stage.id, ...ids.slice(1)]) {
    expect(
      await database.prepare('SELECT 1 FROM publication_inputs WHERE job_id=?').bind(id).first(),
    ).not.toBeNull();
    expect(
      await database
        .prepare('SELECT 1 FROM publication_asset_pins WHERE job_id=?')
        .bind(id)
        .first(),
    ).not.toBeNull();
  }
  expect(await retirePublicationMetadata(database)).toEqual({ jobs: 0, releases: 0 });
  expect((await repository.getDraft(draft.id)).document).toEqual(draft.document);
  await repository.setDraftStatus(
    draft.id,
    'archived',
    subject,
    'archive-retained',
    await acquireDraftProof(repository, draft.id, subject),
  );
  await expect(
    repository.purgeDraft(
      draft.id,
      subject,
      'purge-retained',
      await acquireDraftProof(repository, draft.id, subject),
    ),
  ).rejects.toThrow('retained for publication or rollback');
}, 30_000);

it.each([
  ['staging', 'signed'],
  ['production', 'signed'],
  ['staging', 'session'],
  ['production', 'session'],
  ['staging', 'retry'],
  ['production', 'retry'],
] as const)(
  'captures and verifies terminal %s output with %s completion and a missing acknowledgement',
  async (target, completion) => {
    const { D1PublicationVerifier } = await import('../../src/server/publish/verification');
    const { database, repository, createInput } = await fixture();
    const subject = 'github:12345';
    const staging = target === 'staging';
    const repositoryName = staging ? 'pointsite-staging' : 'pointsite';
    const environment = staging ? 'staging' : 'github-pages';
    const origin = staging ? 'https://staging.pointatx.org' : 'https://pointatx.org';
    await database
      .prepare(
        "INSERT INTO user_roles(email,github_login,role,active,created_at,updated_at,updated_by) VALUES (?,'fixture-publisher','publisher',1,'fixture','fixture','fixture')",
      )
      .bind(subject)
      .run();
    const draft = await repository.createDraft({ ...createInput, actor: subject });
    const jobs = new D1PublishJobStore(database);
    const originalRuntime = 'a'.repeat(40);
    const originalBase = 'b'.repeat(40);
    let job = await jobs.captureStaging({
      draft,
      actor: subject,
      workflowRevision: originalRuntime,
      baseSha: originalBase,
      idempotencyKey: 'verification-source-capture',
      requestId: 'capture',
    });
    if (!staging) {
      // Historical execution fixture; accepted Production capture is exercised independently above.
      const productionId = crypto.randomUUID();
      await database.batch([
        database.prepare("UPDATE user_roles SET role='administrator' WHERE email=?").bind(subject),
        database
          .prepare(
            `INSERT INTO publish_jobs(id,idempotency_key,environment,status,candidate_json,candidate_checksum,repository,base_sha,requested_by,requested_at)
          SELECT ?,'verification-production-source','production-merge','queued',candidate_json,candidate_checksum,'PointCommunity/pointsite',base_sha,requested_by,requested_at
          FROM publish_jobs WHERE id=?`,
          )
          .bind(productionId, job.id),
        database
          .prepare(
            'INSERT INTO publication_inputs(job_id,draft_id,revision_id,workflow_revision) SELECT ?,draft_id,revision_id,workflow_revision FROM publication_inputs WHERE job_id=?',
          )
          .bind(productionId, job.id),
        database
          .prepare(
            'INSERT INTO publication_asset_pins(job_id,draft_id,source_path,asset_id) SELECT ?,draft_id,source_path,asset_id FROM publication_asset_pins WHERE job_id=?',
          )
          .bind(productionId, job.id),
        database
          .prepare('INSERT INTO publication_runs(job_id,nonce,dispatch_revision) VALUES (?,?,?)')
          .bind(productionId, 'f'.repeat(64), originalBase),
        database
          .prepare("INSERT INTO publication_slots(target,job_id) VALUES ('production',?)")
          .bind(productionId),
      ]);
      job = { ...job, id: productionId };
    }
    const provider = await publicationGitHubFixture(job.id, job.candidateChecksum, [], target);
    const recoveryRevision = staging ? 'f'.repeat(40) : provider.build.commitSha;
    provider.state.main = recoveryRevision;
    await database.batch([
      database
        .prepare("UPDATE publish_jobs SET status='running',result_sha=? WHERE id=?")
        .bind(provider.build.commitSha, job.id),
      database
        .prepare(
          "UPDATE publication_runs SET claimed_at='fixture',run_id='12345',run_attempt='1',check_run_id='34567',reserved_run_id='12345',reserved_run_attempt='1',reserved_check_run_id='23456',build_json=?,commit_authorized_at='fixture',deploy_authorized_at='fixture' WHERE job_id=?",
        )
        .bind(JSON.stringify(provider.build), job.id),
    ]);
    const keys = await generateKeyPair('RS256', { extractable: true });
    const workflowRevision = 'd'.repeat(40);
    const caller = 'e'.repeat(40);
    const workerVersionId = crypto.randomUUID();
    const nativeDeploymentId = crypto.randomUUID();
    let terminal = false;
    let verificationSucceeded = false;
    let verificationTerminal = false;
    let revokeReconciler = false;
    let callerChanged = false;
    let revoke = false;
    let revokeBeforeDispatch = false;
    let dispatchStatus = 204;
    const dispatches: unknown[] = [];
    const fetcher = vi.fn<typeof fetch>(async (value, init) => {
      const url = typeof value === 'string' ? value : value instanceof URL ? value.href : value.url;
      if (staging && url.includes('/git/commits/')) {
        const revision = url.split('/').at(-1)!;
        return Response.json({ sha: revision, tree: { sha: revision } });
      }
      if (staging && url.includes('/git/trees/')) {
        const revision = url.split('/').at(-1)!.split('?')[0];
        return Response.json({
          sha: revision,
          truncated: false,
          tree: [
            {
              path: 'content/builder-site.json',
              type: 'blob',
              mode: '100644',
              sha: '1'.repeat(40),
            },
            {
              path: 'scripts/verification-output.mts',
              type: 'blob',
              mode: '100644',
              sha: revision,
            },
          ],
        });
      }
      if (url.endsWith(`/repos/PointCommunity/${repositoryName}/dispatches`)) {
        dispatches.push(JSON.parse(typeof init?.body === 'string' ? init.body : 'null'));
        return new Response(null, { status: dispatchStatus, headers: { 'retry-after': '3600' } });
      }
      if (revokeBeforeDispatch && url.endsWith('/git/ref/heads/main'))
        await database.prepare('UPDATE user_roles SET active=0 WHERE email=?').bind(subject).run();
      if (url.endsWith('/collaborators/fixture-reconciler/permission'))
        return Response.json({ permission: 'admin', user: { id: 12346 } });
      if (url.includes('/actions/runs/56789'))
        return Response.json({
          id: 56789,
          run_attempt: 1,
          status: verificationTerminal ? 'completed' : 'in_progress',
          conclusion: 'failure',
          head_sha: recoveryRevision,
          head_branch: 'main',
          event: 'repository_dispatch',
          path: '.github/workflows/verify-publication.yml',
          repository: {
            id: staging ? 1357847426 : 1348084954,
            full_name: `PointCommunity/${repositoryName}`,
          },
          referenced_workflows: [
            {
              path: `PointCommunity/pointsite-staging/.github/workflows/verify-runtime.yml@${workflowRevision}`,
              sha: workflowRevision,
            },
          ],
        });
      if (url.includes('/actions/runs/12345'))
        return Response.json({
          id: 12345,
          run_attempt: 1,
          status: terminal ? 'completed' : 'in_progress',
          conclusion: 'failure',
          head_sha: originalBase,
          head_branch: 'main',
          event: 'repository_dispatch',
          path: '.github/workflows/publish-candidate.yml',
          repository: {
            id: staging ? 1357847426 : 1348084954,
            full_name: `PointCommunity/${repositoryName}`,
          },
          referenced_workflows: [
            {
              path: `PointCommunity/pointsite-staging/.github/workflows/${staging ? 'publish-runtime' : 'publish-production-runtime'}.yml@${originalRuntime}`,
              sha: originalRuntime,
            },
          ],
        });
      if (url.includes('/check-runs/')) {
        if (revokeReconciler)
          await database.prepare("UPDATE user_roles SET active=0 WHERE email='github:12346'").run();
        const verification = url.endsWith('/78901');
        return Response.json({
          id: verification ? 78901 : 34567,
          status: verification && !verificationSucceeded ? 'in_progress' : 'completed',
          conclusion: verification ? 'success' : 'failure',
          head_sha: verification ? recoveryRevision : originalBase,
          details_url: `https://github.com/PointCommunity/${repositoryName}/actions/runs/${verification ? '56789/job/78901' : '12345/job/34567'}`,
          app: { id: 15368, slug: 'github-actions' },
          deployment: verification ? null : { id: 45678 },
        });
      }
      if (url.includes('/statuses?'))
        return Response.json([
          {
            state: 'failure',
            environment,
            log_url: `https://github.com/PointCommunity/${repositoryName}/actions/runs/12345/job/34567`,
            environment_url: `${origin}/`,
          },
        ]);
      if (url === `${origin}/__pointsite_release.json`)
        return Response.json({
          format: 2,
          candidateChecksum: job.candidateChecksum,
          artifactDigest: provider.build.artifactDigest,
          workflowRevision: originalRuntime,
        });
      if (url.includes('/contents/.github/workflows/verify-publication.yml')) {
        if (revoke)
          await database
            .prepare('UPDATE user_roles SET active=0 WHERE email=?')
            .bind(subject)
            .run();
        return Response.json({ type: 'file', sha: callerChanged ? 'f'.repeat(40) : caller });
      }
      if (url.startsWith('https://api.cloudflare.com/')) {
        expect(new Headers(init?.headers).get('authorization')).toBe(
          'Bearer fixture-native-reader',
        );
        if (url.endsWith('/deployments'))
          return Response.json({
            success: true,
            result: {
              deployments: [
                {
                  id: nativeDeploymentId,
                  versions: [{ version_id: workerVersionId, percentage: 100 }],
                },
              ],
            },
          });
        expect(url.endsWith(`/versions/${workerVersionId}`)).toBe(true);
        return Response.json({
          success: true,
          result: {
            id: workerVersionId,
            annotations: {
              'workers/tag': provider.build.commitSha,
              'workers/message': `Staging candidate ${job.candidateChecksum} from ${provider.build.commitSha}`,
            },
          },
        });
      }
      if (url.includes(`/deployments?environment=${environment}`))
        return Response.json([
          {
            id: 45678,
            sha: originalBase,
            environment,
            performed_via_github_app: null,
          },
        ]);
      return provider.fetcher(value, init);
    });
    let revokeOnIdentity = false;
    const identityKeys = async () => {
      if (revokeOnIdentity)
        await database.prepare('UPDATE user_roles SET active=0 WHERE email=?').bind(subject).run();
      return keys.publicKey;
    };
    const verifier = new D1PublicationVerifier(
      database,
      {
        appId: 'fixture-app',
        installationId: 'fixture-installation',
        privateKey: await exportPKCS8(keys.privateKey),
        workflowRevision,
      },
      { staging: caller, production: caller },
      'fixture-native-reader',
      identityKeys,
      fetcher,
    );
    const input = {
      jobId: job.id,
      target,
      actor: subject,
      expectedAttempts: 0,
      idempotencyKey: 'read-only-verification-fixture',
      requestId: 'verify',
    };
    await expect(verifier.capture(input)).rejects.toThrow('PUBLICATION_RUN_NOT_TERMINAL');
    terminal = true;
    callerChanged = true;
    await expect(verifier.capture(input)).rejects.toThrow('PUBLICATION_VERIFICATION_CHANGED');
    callerChanged = false;
    revoke = true;
    await expect(verifier.capture(input)).rejects.toThrow();
    expect(
      await database.prepare('SELECT count(*) n FROM publication_verifications').first('n'),
    ).toBe(0);
    revoke = false;
    await database.prepare('UPDATE user_roles SET active=1 WHERE email=?').bind(subject).run();
    await database.exec(
      "CREATE TRIGGER fixture_verification_audit BEFORE INSERT ON audit_events WHEN NEW.action='publish.verification-captured' BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END",
    );
    await expect(verifier.capture(input)).rejects.toThrow('PUBLICATION_VERIFICATION_CHANGED');
    expect(
      await database.prepare('SELECT count(*) n FROM publication_verifications').first('n'),
    ).toBe(0);
    await database.exec('DROP TRIGGER fixture_verification_audit');
    let captured = await verifier.capture(input);
    fetcher.mockClear();
    expect(await verifier.capture(input)).toEqual(captured);
    expect(fetcher).not.toHaveBeenCalled();
    let record = await database
      .prepare('SELECT * FROM publication_verifications WHERE id=?')
      .bind(captured.verificationId)
      .first();
    expect(record).toMatchObject({
      job_id: job.id,
      attempt: 1,
      status: 'queued',
      dispatch_count: 0,
      requested_by: subject,
      native_worker_deployment_id: null,
      workflow_revision: workflowRevision,
    });
    expect((await jobs.dispatchStatus(job.id))?.canVerifyOutput).toBe(true);
    expect(JSON.parse(String(record?.source_json))).toEqual({
      target,
      deploymentId: '45678',
      runId: '12345',
      checkRunId: '34567',
      dispatchRevision: originalBase,
      workflowRevision: originalRuntime,
      ...(staging ? { verificationDispatchRevision: recoveryRevision } : {}),
      build: provider.build,
    });
    expect(String(record?.source_json)).not.toContain(draft.document.media[0].sourcePath);
    expect(await verifier.status(job.id, target, subject)).toMatchObject({
      id: captured.verificationId,
      status: 'queued',
      attempt: 1,
      dispatchAttempts: 0,
      reported: false,
      needsAttention: false,
    });
    await expect(verifier.status(job.id, target, 'github:99999')).rejects.toThrow(
      'PUBLISH_AUTHORITY_CHANGED',
    );
    await Promise.all([verifier.dispatchPending(), verifier.dispatchPending()]);
    expect(dispatches).toEqual([
      {
        event_type: 'verify-publication',
        client_payload: {
          verificationId: captured.verificationId,
          nonce: record?.nonce,
          builderOrigin: 'https://builder.pointatx.org',
        },
      },
    ]);
    await expect(verifier.dispatch(captured.verificationId)).rejects.toThrow(
      'PUBLICATION_VERIFICATION_BACKOFF',
    );
    const readyDispatch = () =>
      database
        .prepare("UPDATE publication_verifications SET dispatch_after='1970' WHERE id=?")
        .bind(captured.verificationId)
        .run();
    await readyDispatch();
    revokeBeforeDispatch = true;
    await expect(verifier.dispatch(captured.verificationId)).rejects.toThrow(
      'PUBLICATION_VERIFICATION_DISPATCH_UNAVAILABLE',
    );
    expect(dispatches).toHaveLength(1);
    revokeBeforeDispatch = false;
    await database.prepare('UPDATE user_roles SET active=1 WHERE email=?').bind(subject).run();
    dispatchStatus = 503;
    for (let attempt = 3; attempt <= 6; attempt++) {
      await readyDispatch();
      await expect(verifier.dispatch(captured.verificationId)).rejects.toThrow(
        'PUBLICATION_VERIFICATION_DISPATCH_UNCONFIRMED',
      );
    }
    expect(dispatches).toHaveLength(5);
    expect(
      await database
        .prepare(
          "SELECT dispatch_count,dispatch_after>strftime('%Y-%m-%dT%H:%M:%fZ','now','+59 minutes') AS delayed FROM publication_verifications WHERE id=?",
        )
        .bind(captured.verificationId)
        .first(),
    ).toMatchObject({ dispatch_count: 6, delayed: 1 });
    await readyDispatch();
    await verifier.dispatchPending();
    await expect(verifier.dispatch(captured.verificationId)).rejects.toThrow(
      'PUBLICATION_VERIFICATION_BACKOFF',
    );
    expect(dispatches).toHaveLength(5);
    fetcher.mockClear();
    if (completion === 'retry') {
      const retry = {
        jobId: job.id,
        verificationId: captured.verificationId,
        target,
        actor: subject,
        expectedDispatches: 6,
        action: 'retry' as const,
        idempotencyKey: 'verification-queued-retry',
        requestId: 'retry',
      };
      await database.exec(
        "CREATE TRIGGER fixture_verification_retire_audit BEFORE INSERT ON audit_events WHEN NEW.action='publish.verification-retired' BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END",
      );
      await expect(verifier.retry(retry)).rejects.toThrow('PUBLICATION_VERIFICATION_CHANGED');
      expect(
        await database
          .prepare('SELECT status FROM publication_verifications WHERE id=?')
          .bind(captured.verificationId)
          .first('status'),
      ).toBe('queued');
      await database.exec('DROP TRIGGER fixture_verification_retire_audit');
      await database.exec(
        "CREATE TRIGGER fixture_verification_recapture_audit BEFORE INSERT ON audit_events WHEN NEW.action='publish.verification-captured' BEGIN SELECT RAISE(ABORT,'fixture capture interruption'); END",
      );
      const priorId = captured.verificationId;
      await expect(verifier.retry(retry)).rejects.toThrow('PUBLICATION_VERIFICATION_CHANGED');
      expect(
        await database
          .prepare('SELECT status FROM publication_verifications WHERE id=?')
          .bind(priorId)
          .first('status'),
      ).toBe('failed');
      await database.exec('DROP TRIGGER fixture_verification_recapture_audit');
      captured = await verifier.retry(retry);
      expect(await verifier.retry(retry)).toEqual(captured);
      record = await database
        .prepare('SELECT * FROM publication_verifications WHERE id=?')
        .bind(captured.verificationId)
        .first();
      expect(record).toMatchObject({ status: 'queued', attempt: 2, dispatch_count: 0 });
      await expect(verifier.reserve(priorId, 'revoked-fixture')).rejects.toThrow(
        'PUBLISH_RUNNER_UNAUTHORIZED',
      );
      fetcher.mockClear();
    }
    const verificationClaims = () => ({
      ...publicationClaims({
        target,
        jobId: captured.verificationId,
        nonce: String(record?.nonce),
        workflowRevision,
        dispatchRevision: recoveryRevision,
      }),
      aud: `https://builder.pointatx.org/verify/${captured.verificationId}/${String(record?.nonce)}`,
      workflow_ref: `PointCommunity/${repositoryName}/.github/workflows/verify-publication.yml@refs/heads/main`,
      job_workflow_ref: `PointCommunity/pointsite-staging/.github/workflows/verify-runtime.yml@${workflowRevision}`,
      run_id: '56789',
    });
    const signVerification = (check: string, run = '56789') =>
      new SignJWT({ ...verificationClaims(), run_id: run, check_run_id: check })
        .setProtectedHeader({ alg: 'RS256' })
        .sign(keys.privateKey);
    let reserveToken = await signVerification('67890');
    let verifyToken = await signVerification('78901');
    await expect(verifier.inputs(captured.verificationId, verifyToken)).rejects.toThrow();
    expect(await verifier.reserve(captured.verificationId, reserveToken)).toEqual({
      reserved: true,
    });
    expect(await verifier.reserve(captured.verificationId, reserveToken)).toEqual({
      reserved: true,
    });
    await expect(
      verifier.reserve(captured.verificationId, await signVerification('67890', '56790')),
    ).rejects.toThrow('PUBLISH_RUNNER_UNAUTHORIZED');
    await expect(verifier.claim(captured.verificationId, reserveToken)).rejects.toThrow();
    revokeOnIdentity = true;
    await expect(verifier.claim(captured.verificationId, verifyToken)).rejects.toThrow();
    expect(
      await database
        .prepare('SELECT check_run_id FROM publication_verifications WHERE id=?')
        .bind(captured.verificationId)
        .first('check_run_id'),
    ).toBeNull();
    revokeOnIdentity = false;
    await database.prepare('UPDATE user_roles SET active=1 WHERE email=?').bind(subject).run();
    expect(await verifier.claim(captured.verificationId, verifyToken)).toEqual({ claimed: true });
    expect(await verifier.claim(captured.verificationId, verifyToken)).toEqual({ claimed: true });
    expect(await verifier.status(job.id, target, subject)).toMatchObject({
      status: 'running',
      dispatchAttempts: completion === 'retry' ? 0 : 6,
      reported: false,
      workflowUrl: `https://github.com/PointCommunity/${repositoryName}/actions/runs/56789`,
    });
    expect(await verifier.inputs(captured.verificationId, verifyToken)).toEqual(
      JSON.parse(String(record?.source_json)),
    );
    if (completion === 'retry') {
      for (const attempt of [3]) {
        const retry = {
          jobId: job.id,
          verificationId: captured.verificationId,
          target,
          actor: subject,
          expectedDispatches: 0,
          action: 'retry' as const,
          idempotencyKey: `verification-retry-${attempt}`,
          requestId: 'retry',
        };
        await expect(verifier.retry(retry)).rejects.toThrow('PUBLICATION_RUN_NOT_TERMINAL');
        verificationTerminal = true;
        const priorId = captured.verificationId;
        const priorNonce = record?.nonce;
        captured = await verifier.retry(retry);
        expect(await verifier.retry(retry)).toEqual(captured);
        expect(
          await database
            .prepare('SELECT status FROM publication_verifications WHERE id=?')
            .bind(priorId)
            .first('status'),
        ).toBe('failed');
        await expect(verifier.claim(priorId, verifyToken)).rejects.toThrow(
          'PUBLISH_RUNNER_UNAUTHORIZED',
        );
        record = await database
          .prepare('SELECT * FROM publication_verifications WHERE id=?')
          .bind(captured.verificationId)
          .first();
        expect(record).toMatchObject({ attempt, dispatch_count: 0, status: 'queued' });
        expect(record?.nonce).not.toBe(priorNonce);
        reserveToken = await signVerification('67890');
        verifyToken = await signVerification('78901');
        await verifier.reserve(captured.verificationId, reserveToken);
        await verifier.claim(captured.verificationId, verifyToken);
        verificationTerminal = false;
      }
      await expect(
        verifier.retry({
          jobId: job.id,
          verificationId: captured.verificationId,
          target,
          actor: subject,
          expectedDispatches: 0,
          action: 'retry',
          idempotencyKey: 'verification-fourth-attempt',
          requestId: 'retry',
        }),
      ).rejects.toThrow('PUBLICATION_VERIFICATION_LIMIT');
      fetcher.mockClear();
    }
    const report = {
      artifactDigest: provider.build.artifactDigest,
      deploymentId: '45678',
    };
    await expect(
      verifier.report(captured.verificationId, verifyToken, { ...report, deploymentId: '45679' }),
    ).rejects.toThrow();
    await expect(verifier.report(captured.verificationId, reserveToken, report)).rejects.toThrow();
    expect(await verifier.report(captured.verificationId, verifyToken, report)).toEqual({
      recorded: true,
    });
    await expect(
      verifier.retry({
        jobId: job.id,
        verificationId: captured.verificationId,
        target,
        actor: subject,
        expectedDispatches: completion === 'retry' ? 0 : 6,
        action: 'retry',
        idempotencyKey: 'verification-reported-retry',
        requestId: 'retry',
      }),
    ).rejects.toThrow('PUBLICATION_VERIFICATION_RECONCILE_REQUIRED');
    expect(await verifier.report(captured.verificationId, verifyToken, report)).toEqual({
      recorded: true,
    });
    expect(
      await database
        .prepare('SELECT status FROM publish_jobs WHERE id=?')
        .bind(job.id)
        .first('status'),
    ).toBe('running');
    expect(fetcher).not.toHaveBeenCalled();

    await expect(
      verifier.capture({ ...input, idempotencyKey: 'another-verification-request' }),
    ).rejects.toThrow('PUBLICATION_VERIFICATION_BUSY');
    await expect(verifier.capture({ ...input, expectedAttempts: 1 })).rejects.toThrow(
      'IDEMPOTENCY_CONFLICT',
    );
    await expect(
      verifier.capture({ ...input, target: staging ? 'production' : 'staging' }),
    ).rejects.toThrow('PUBLISH_AUTHORITY_CHANGED');
    await expect(
      database
        .prepare('UPDATE publication_verifications SET source_json=? WHERE id=?')
        .bind('{}', captured.verificationId)
        .run(),
    ).rejects.toThrow('PUBLICATION_VERIFICATION_IMMUTABLE');
    const originalNonce = await database
      .prepare('SELECT nonce FROM publication_runs WHERE job_id=?')
      .bind(job.id)
      .first<string>('nonce');
    const originalToken = await new SignJWT({
      ...publicationClaims({
        target,
        jobId: job.id,
        nonce: originalNonce!,
        workflowRevision: originalRuntime,
        dispatchRevision: originalBase,
      }),
      check_run_id: '34567',
    })
      .setProtectedHeader({ alg: 'RS256' })
      .sign(keys.privateKey);
    const runner = new D1PublicationRunner(database, () => Promise.resolve(keys.publicKey));
    await expect(runner.inputs(job.id, originalToken)).rejects.toThrow(
      'PUBLISH_RUNNER_UNAUTHORIZED',
    );
    await database.prepare('UPDATE user_roles SET active=0 WHERE email=?').bind(subject).run();
    await expect(verifier.capture(input)).rejects.toThrow('PUBLISH_AUTHORITY_CHANGED');
    expect(
      await database
        .prepare('SELECT deployment_json FROM publication_runs WHERE job_id=?')
        .bind(job.id)
        .first('deployment_json'),
    ).toBeNull();
    await database.prepare('UPDATE user_roles SET active=1 WHERE email=?').bind(subject).run();
    const finalizerToken = await signVerification('89012');
    await expect(verifier.finalize(captured.verificationId, verifyToken)).rejects.toThrow();
    await expect(verifier.finalize(captured.verificationId, reserveToken)).rejects.toThrow();
    await expect(verifier.finalize(captured.verificationId, finalizerToken)).rejects.toThrow(
      'PUBLICATION_VERIFICATION_UNCONFIRMED',
    );
    verificationSucceeded = true;
    const reconciliation = {
      jobId: job.id,
      verificationId: captured.verificationId,
      target,
      actor: 'github:12346',
      expectedDispatches: 6,
      idempotencyKey: 'verification-session-receipt',
      requestId: 'reconcile',
      action: 'reconcile' as const,
    };
    const finish = () =>
      completion !== 'session'
        ? verifier.finalize(captured.verificationId, finalizerToken)
        : verifier.reconcile(reconciliation);
    const finished = completion !== 'session' ? { verified: true } : { recovered: true };
    if (completion === 'session') {
      await database
        .prepare(
          "INSERT INTO user_roles(email,github_login,role,active,created_at,updated_at,updated_by) VALUES ('github:12346','fixture-reconciler','administrator',1,'fixture','fixture','fixture')",
        )
        .run();
      await database.prepare('UPDATE user_roles SET active=0 WHERE email=?').bind(subject).run();
      await expect(finish()).rejects.toThrow('PUBLICATION_RUN_NOT_TERMINAL');
      verificationTerminal = true;
      revokeReconciler = true;
      await expect(finish()).rejects.toThrow();
      revokeReconciler = false;
      await database.prepare("UPDATE user_roles SET active=1 WHERE email='github:12346'").run();
    }
    await database.exec(
      "CREATE TRIGGER fixture_verification_completion_audit BEFORE INSERT ON audit_events WHEN NEW.action='publish.verification-completed' BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END",
    );
    await expect(finish()).rejects.toThrow();
    expect(
      await database
        .prepare('SELECT status FROM publish_jobs WHERE id=?')
        .bind(job.id)
        .first('status'),
    ).toBe('running');
    expect(
      await database
        .prepare('SELECT deployment_json FROM publication_runs WHERE job_id=?')
        .bind(job.id)
        .first('deployment_json'),
    ).toBeNull();
    expect(
      await database
        .prepare('SELECT status FROM publication_verifications WHERE id=?')
        .bind(captured.verificationId)
        .first('status'),
    ).toBe('running');
    await database.exec('DROP TRIGGER fixture_verification_completion_audit');
    expect(await Promise.all([finish(), finish()])).toEqual([finished, finished]);
    fetcher.mockClear();
    expect(await finish()).toEqual(finished);
    expect(fetcher).not.toHaveBeenCalled();
    if (completion === 'session') {
      await expect(
        verifier.reconcile({ ...reconciliation, expectedDispatches: 5 }),
      ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
      await database.prepare('UPDATE user_roles SET active=1 WHERE email=?').bind(subject).run();
      await database.prepare("UPDATE user_roles SET active=0 WHERE email='github:12346'").run();
      await expect(finish()).rejects.toThrow('PUBLISH_AUTHORITY_CHANGED');
    }
    const completed = await database
      .prepare('SELECT status,evidence_json FROM publish_jobs WHERE id=?')
      .bind(job.id)
      .first();
    expect(completed?.status).toBe('succeeded');
    expect((await jobs.dispatchStatus(job.id))?.canVerifyOutput).toBe(false);
    expect(await verifier.status(job.id, target, subject)).toMatchObject({
      status: 'passed',
      reported: true,
    });
    expect(JSON.parse(String(completed?.evidence_json))).toMatchObject({
      runId: '12345',
      checkRunId: '34567',
      verificationStatus: 'passed',
      verification: {
        runId: '56789',
        checkRunId: '78901',
        originalConclusion: 'failure',
        originalDeploymentState: 'failure',
      },
    });
    expect(
      await database
        .prepare('SELECT count(*) n FROM publication_slots WHERE job_id=?')
        .bind(job.id)
        .first('n'),
    ).toBe(staging ? 1 : 0);
    if (!staging) {
      const released = await database
        .prepare('SELECT evidence_json FROM publication_releases WHERE job_id=?')
        .bind(job.id)
        .first<string>('evidence_json');
      expect(JSON.parse(released!)).toEqual(JSON.parse(String(completed?.evidence_json)));
    }
    fetcher.mockClear();
    expect(await verifier.finalize(captured.verificationId, finalizerToken)).toEqual({
      verified: true,
    });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(verifier.finalize(captured.verificationId, verifyToken)).rejects.toThrow(
      'PUBLISH_RUNNER_UNAUTHORIZED',
    );
    if (staging) {
      await database
        .prepare(
          "UPDATE publish_jobs SET evidence_json=json_set(evidence_json,'$.workerVersionId',?) WHERE id=?",
        )
        .bind(crypto.randomUUID(), job.id)
        .run();
      await expect(verifier.finalize(captured.verificationId, finalizerToken)).rejects.toThrow(
        'PUBLISH_RUNNER_UNAUTHORIZED',
      );
      await database
        .prepare('UPDATE publish_jobs SET evidence_json=? WHERE id=?')
        .bind(completed!.evidence_json, job.id)
        .run();
    }

    await database.prepare('UPDATE user_roles SET active=0 WHERE email=?').bind(subject).run();
    await expect(verifier.finalize(captured.verificationId, finalizerToken)).rejects.toThrow(
      'PUBLISH_RUNNER_UNAUTHORIZED',
    );
    expect(provider.state.mutations).toBe(0);
  },
  30_000,
);
