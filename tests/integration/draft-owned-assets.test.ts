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
      client_payload: { jobId: job.id, nonce },
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

it('captures cloud inputs without reading image bytes and polls only metadata after later edits', async () => {
  const { database, repository, createInput } = await fixture();
  await database.prepare("UPDATE user_roles SET role='publisher' WHERE email=?").bind(actor).run();
  const draft = await repository.createDraft(createInput);
  const jobs = new D1PublishJobStore(database),
    preflights = new D1PublishPreflightStore(database);
  const client = {
    currentMainSha: vi.fn(() => Promise.resolve('b'.repeat(40))),
    assertRendererCompatible: vi.fn(async () => {}),
    assertPublicationCaller: vi.fn(async () => {}),
    advanceCommit: vi.fn(),
    verificationForCommit: vi.fn(),
  };
  const publisher = new StagingPublisher(
    repository,
    {
      appId: '123',
      installationId: '456',
      privateKey: 'unused',
      workflowRevision: PUBLICATION_WORKFLOW_REVISION,
    },
    undefined,
    jobs,
    preflights,
    () => Promise.resolve(client),
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
}, 30_000);

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
    let publishedWorkerVersion = workerVersionId;
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
          artifactDigest: github.build.artifactDigest,
          workerVersionId: publishedWorkerVersion,
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
    await expect(runner.reportDeployment(job.id, token, { workerVersionId })).rejects.toThrow(
      'PUBLICATION_DEPLOYMENT_NOT_AUTHORIZED',
    );
    await runner.authorizeDeployment(job.id, token);
    await runner.reportDeployment(job.id, token, { workerVersionId });
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
      { workerVersionId: undefined },
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
    publishedWorkerVersion = crypto.randomUUID();
    await expect(approvals.record(decision)).rejects.toThrow(
      'PUBLICATION_VERIFICATION_UNCONFIRMED',
    );
    publishedWorkerVersion = workerVersionId;
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
    publishedWorkerVersion = crypto.randomUUID();
    await expect(production.capture(promotion)).rejects.toThrow(
      'PUBLICATION_VERIFICATION_UNCONFIRMED',
    );
    publishedWorkerVersion = workerVersionId;
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
    const [promoted, repeated] = await Promise.all([
      production.capture(promotion),
      production.capture(promotion),
    ]);
    expect(promoted).toEqual(repeated);
    expect(promoted.status).toBe('queued');
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
      publishedWorkerVersion = crypto.randomUUID();
      await expect(production.retryCaptured(recovery)).rejects.toThrow(
        'PUBLICATION_VERIFICATION_UNCONFIRMED',
      );
      publishedWorkerVersion = workerVersionId;
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
        production.retryCaptured(recovery),
      ]);
      expect(retried).toEqual(duplicateRetry);
      expect(retried.jobId).not.toBe(promoted.id);
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
