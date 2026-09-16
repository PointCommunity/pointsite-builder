// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { exportPKCS8, generateKeyPair } from 'jose';
import { SqliteDatabase } from '../../server/sqlite';
import { migrateDatabase } from '../../server/migrations';
import { createPublicAssets } from '../../server/http';
import { D1DraftRepository } from '../../src/server/repositories/d1';
import { D1DraftAssets } from '../../src/server/media/draft-assets';
import { D1MediaRepository, D1PrivateBucket, MediaService } from '../../src/server/media/service';
import { createApp } from '../../src/server';
import { D1PublishJobStore } from '../../src/server/publish/jobs';
import { D1ApprovalService } from '../../src/server/approvals/service';
import { D1ProductionPublisher } from '../../src/server/publish/promotion';
import {
  verifiedReleaseStatement,
  retirePublicationMetadata,
} from '../../src/server/publish/releases';
import { D1CloudRollback } from '../../src/server/publish/rollback';
import { D1PublicationVerifier } from '../../src/server/publish/verification';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import { publicationGitHubFixture } from '../fixtures/publication-github';

const canaryOrigin = 'https://builder-canary.eaglepass.io';
const productionOrigin = 'https://builder.eaglepass.io';
const actor = 'github:12345';
const databases: SqliteDatabase[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

async function fixture(builderOrigin = canaryOrigin) {
  const database = new SqliteDatabase(':memory:');
  databases.push(database);
  await migrateDatabase(database, 'migrations');
  await database
    .prepare(
      "INSERT INTO user_roles(email,github_login,role,active,created_at,updated_at,updated_by) VALUES (?,'fixture','administrator',1,'fixture','fixture','fixture')",
    )
    .bind(actor)
    .run();
  const legacy = new MediaService(new D1MediaRepository(database), new D1PrivateBucket(database));
  const assets = new D1DraftAssets(database, legacy, createPublicAssets(process.cwd() + '/public'));
  const repository = new D1DraftRepository(database, assets, 'compact-v1');
  const draft = await repository.createDraft({
    name: 'Publication lane fixture',
    document: defaultSiteDocument,
    actor,
    idempotencyKey: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
  });
  const workflowRevision = 'a'.repeat(40);
  const job = await new D1PublishJobStore(database, builderOrigin).captureStaging({
    draft,
    actor,
    workflowRevision,
    baseSha: 'b'.repeat(40),
    idempotencyKey: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
  });
  const canary = builderOrigin === canaryOrigin;
  const stagingRepository = canary ? 'pointsite-staging-canary' : 'pointsite-staging';
  const publicRepository = canary ? 'pointsite-canary' : 'pointsite';
  const stagingOrigin = canary
    ? 'https://staging-canary.pointatx.org'
    : 'https://staging.pointatx.org';
  const github = await publicationGitHubFixture(
    job.id,
    job.candidateChecksum,
    [],
    canary ? 'canary' : 'staging',
  );
  const jobUrl = `https://github.com/PointCommunity/${stagingRepository}/actions/runs/12345/job/23456`;
  const evidence = {
    format: 2,
    verificationStatus: 'passed',
    deploymentId: '1',
    runId: '12345',
    checkRunId: '23456',
    dispatchRevision: job.baseSha,
    commitSha: github.build.commitSha,
    workflowRevision,
    candidateChecksum: job.candidateChecksum,
    artifactDigest: github.build.artifactDigest,
    jobUrl,
    deploymentUrl: stagingOrigin,
  };
  // The runner execution itself is covered by native-publication-isolation.test.ts.
  // Seed its verified result here so these tests isolate acceptance and promotion.
  await database
    .prepare(
      "UPDATE publish_jobs SET status='succeeded',result_sha=?,evidence_json=?,completed_at='2026-09-16T12:00:00Z' WHERE id=?",
    )
    .bind(github.build.commitSha, JSON.stringify(evidence), job.id)
    .run();
  await database
    .prepare(
      "UPDATE publication_runs SET build_json=?,run_id='12345',run_attempt='1',check_run_id='23456',claimed_at='2026-09-16T11:59:00Z' WHERE job_id=?",
    )
    .bind(JSON.stringify(github.build), job.id)
    .run();
  const keys = await generateKeyPair('RS256', { extractable: true });
  const config = {
    appId: '123',
    installationId: '456',
    privateKey: await exportPKCS8(keys.privateKey),
    builderOrigin,
    workflowRevision,
  };
  const callerBlob = 'e'.repeat(40);
  const state = { publicBase: 'f'.repeat(40), artifactDigest: github.build.artifactDigest };
  const requests: { url: string; method: string; body: unknown }[] = [];
  const respond = (body: unknown) => Promise.resolve(Response.json(body));
  const fetcher: typeof fetch = (url, init) => {
    const path = url instanceof Request ? url.url : String(url);
    const method = init?.method ?? 'GET';
    if (init?.body !== undefined && typeof init.body !== 'string')
      throw new Error('Expected JSON request body');
    const body: unknown = init?.body ? JSON.parse(init.body) : null;
    requests.push({
      url: path,
      method,
      body,
    });
    if (path.endsWith('/access_tokens')) {
      expect(body).toMatchObject({
        repositories: [
          expect.stringMatching(new RegExp(`^(?:${stagingRepository}|${publicRepository})$`)),
        ],
      });
      return respond({ token: 'fixture-installation-token', expires_at: 'fixture' });
    }
    if (path.startsWith('https://api.github.com/repos/')) {
      expect(path).toMatch(
        new RegExp(
          `^https://api\\.github\\.com/repos/PointCommunity/(?:${stagingRepository}|${publicRepository})/`,
        ),
      );
      expect(method).toBe('GET');
    }
    if (path.endsWith('/permission')) return respond({ permission: 'write', user: { id: 12345 } });
    const publicApi = `https://api.github.com/repos/PointCommunity/${publicRepository}`;
    const stagingApi = `https://api.github.com/repos/PointCommunity/${stagingRepository}`;
    if (path === `${publicApi}/git/ref/heads/main`)
      return respond({ object: { sha: state.publicBase } });
    if (
      path ===
      `${publicApi}/contents/.github/workflows/publish-candidate.yml?ref=${state.publicBase}`
    )
      return respond({ type: 'file', sha: callerBlob });
    if (path === `${stagingApi}/git/ref/heads/main`)
      return respond({ object: { sha: github.build.commitSha } });
    if (path === `${stagingApi}/check-runs/23456`)
      return respond({
        id: 23456,
        status: 'completed',
        conclusion: 'success',
        head_sha: job.baseSha,
        details_url: jobUrl,
        app: { id: 15368, slug: 'github-actions' },
        deployment: { id: 1 },
      });
    if (path === `${stagingApi}/deployments?environment=staging&per_page=1`)
      return respond([{ id: 1, sha: job.baseSha, environment: 'staging' }]);
    if (path === `${stagingApi}/deployments/1/statuses?per_page=1`)
      return respond([
        {
          state: 'success',
          environment: 'staging',
          log_url: jobUrl,
          environment_url: stagingOrigin,
        },
      ]);
    if (path === `${stagingOrigin}/__pointsite_release.json`)
      return respond({
        format: 2,
        candidateChecksum: job.candidateChecksum,
        artifactDigest: state.artifactDigest,
        workflowRevision,
      });
    throw new Error(`Unexpected publication lane request: ${path}`);
  };
  const tuple = {
    siteId: 'pointsite' as const,
    revisionId: draft.revision.id,
    revisionChecksum: draft.revision.checksum,
    schemaVersion: draft.document.schemaVersion,
    rendererVersion: draft.document.rendererVersion,
    candidateChecksum: job.candidateChecksum,
    stagingBaseSha: job.baseSha,
    stagingCommitSha: github.build.commitSha,
    productionBaseSha: state.publicBase,
    publicationProtocol: 2 as const,
    workflowRevision,
    artifactDigest: github.build.artifactDigest,
  };
  const approvals = new D1ApprovalService(database, config, fetcher);
  const decision = {
    publishJobId: job.id,
    expectedTuple: tuple,
    decision: 'approved' as const,
    actor,
    requestId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    expectedApprovalId: null,
  };
  const accept = async () => {
    const approval = await approvals.record(decision);
    return {
      stagingJobId: job.id,
      approvalId: approval.id,
      tuple,
      actor,
      requestId: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
    };
  };
  const service = new D1ProductionPublisher(database, config, callerBlob, fetcher);
  return {
    database,
    repository,
    draft,
    job,
    config,
    callerBlob,
    fetcher,
    requests,
    state,
    tuple,
    approvals,
    decision,
    accept,
    service,
  };
}

it('accepts Canary staging against the public Canary base and captures only its public lane', async () => {
  const { database, draft, service, accept, requests, tuple } = await fixture();
  const input = await accept();
  const captured = await service.capture(input);
  expect(await service.capture(input)).toEqual(captured);
  expect(
    await database
      .prepare('SELECT repository,base_sha,candidate_checksum FROM publish_jobs WHERE id=?')
      .bind(captured.id)
      .first(),
  ).toEqual({
    repository: 'PointCommunity/pointsite-canary',
    base_sha: tuple.productionBaseSha,
    candidate_checksum: tuple.candidateChecksum,
  });
  expect(
    await database
      .prepare('SELECT staging_job_id,artifact_digest FROM publication_promotions WHERE job_id=?')
      .bind(captured.id)
      .first(),
  ).toEqual({ staging_job_id: input.stagingJobId, artifact_digest: tuple.artifactDigest });
  expect(await service.workflowForDraft(draft.id, actor)).toMatchObject({
    job: { id: captured.id },
  });
  expect(
    requests.some(
      ({ url }) =>
        url === 'https://api.github.com/repos/PointCommunity/pointsite-canary/git/ref/heads/main',
    ),
  ).toBe(true);
  expect(
    requests.some(
      ({ url }) => url === 'https://staging-canary.pointatx.org/__pointsite_release.json',
    ),
  ).toBe(true);
  expect(requests.filter(({ url }) => /\/PointCommunity\/pointsite(?:\/|$)/.test(url))).toEqual([]);
  expect(
    requests.filter(({ method, url }) => method !== 'GET' && !url.endsWith('/access_tokens')),
  ).toEqual([]);
});

it('rejects changed public Canary base and changed accepted staging evidence before promotion', async () => {
  const { database, state, tuple, approvals, decision, accept, service } = await fixture();
  state.publicBase = '9'.repeat(40);
  await expect(approvals.record(decision)).rejects.toThrow('PRODUCTION_BASE_DRIFT');
  state.publicBase = tuple.productionBaseSha;
  const input = await accept();
  state.publicBase = '9'.repeat(40);
  await expect(service.capture(input)).rejects.toThrow();
  state.publicBase = tuple.productionBaseSha;
  state.artifactDigest = '0'.repeat(64);
  await expect(service.capture(input)).rejects.toThrow('PUBLICATION_VERIFICATION_UNCONFIRMED');
  expect(
    await database
      .prepare("SELECT count(*) n FROM publish_jobs WHERE environment='production-merge'")
      .first('n'),
  ).toBe(0);
});

it('refuses Production staging acceptance and historical Production recovery in a Canary Builder', async () => {
  const { database, repository, draft, config, callerBlob, fetcher, accept, service, requests } =
    await fixture(productionOrigin);
  const input = await accept();
  const captured = await service.capture(input);
  const canary = new D1ProductionPublisher(
    database,
    { ...config, builderOrigin: canaryOrigin },
    callerBlob,
    fetcher,
  );
  requests.length = 0;
  await expect(canary.capture(input)).rejects.toThrow('IDEMPOTENCY_CONFLICT');
  const verifier = new D1PublicationVerifier(
    database,
    { ...config, builderOrigin: canaryOrigin },
    { staging: callerBlob, production: callerBlob },
  );
  await expect(verifier.status(captured.id, 'production', actor)).rejects.toThrow(
    'PUBLISH_AUTHORITY_CHANGED',
  );
  await expect(verifier.status(input.stagingJobId, 'staging', actor)).rejects.toThrow(
    'PUBLISH_AUTHORITY_CHANGED',
  );
  await expect(canary.capture({ ...input, idempotencyKey: crypto.randomUUID() })).rejects.toThrow(
    'PRODUCTION_INPUTS_UNAVAILABLE',
  );
  const app = createApp({
    repository,
    production: canary,
    environment: 'test',
    version: 'test',
    authenticate: () =>
      Promise.resolve({ email: actor, role: 'administrator', repositoryPermission: 'write' }),
  });
  const workflow = await app.request(
    `${canaryOrigin}/api/publish/production/workflow?draftId=${draft.id}`,
  );
  expect(workflow.status).toBe(200);
  expect(await workflow.json()).toMatchObject({ job: null });
  for (const action of [
    'retry',
    'cancel',
    'reconcile',
    'retry-captured',
    'verify-completed',
  ] as const) {
    await expect(
      canary.recoverQueued({
        jobId: captured.id,
        action,
        expectedAttempts: 0,
        actor,
        requestId: crypto.randomUUID(),
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toThrow('PUBLICATION_RECOVERY_CHANGED');
  }
  expect(requests).toEqual([]);
  expect(
    await database
      .prepare('SELECT status FROM publish_jobs WHERE id=?')
      .bind(captured.id)
      .first('status'),
  ).toBe('queued');
});

it('refuses the immutable Production baseline as a Canary rollback source', async () => {
  const { database, config, callerBlob, fetcher, requests, state } = await fixture();
  const rollback = new D1CloudRollback(database, config, callerBlob, fetcher);
  await expect(
    rollback.capture({
      sourceReleaseId: 'public-baseline-2026-09-13',
      previousReleaseId: 'public-baseline-2026-09-13',
      baseSha: state.publicBase,
      previousDeploymentId: '6276181817',
      actor,
      idempotencyKey: crypto.randomUUID(),
      requestId: crypto.randomUUID(),
    }),
  ).rejects.toThrow('ROLLBACK_SOURCE_UNAVAILABLE');
  expect(await database.prepare('SELECT count(*) n FROM publication_rollbacks').first('n')).toBe(0);
  expect(requests.filter(({ url }) => /\/PointCommunity\/pointsite(?:\/|$)/.test(url))).toEqual([]);
  expect(
    requests.filter(({ method, url }) => method !== 'GET' && !url.endsWith('/access_tokens')),
  ).toEqual([]);
});

async function publicationRecord(
  context: Awaited<ReturnType<typeof fixture>>,
  repository: 'PointCommunity/pointsite' | 'PointCommunity/pointsite-canary',
  deploymentId: string,
) {
  const { database, job } = context;
  const id = crypto.randomUUID();
  const original = await database
    .prepare(
      'SELECT j.evidence_json,pr.build_json FROM publish_jobs j JOIN publication_runs pr ON pr.job_id=j.id WHERE j.id=?',
    )
    .bind(job.id)
    .first<{ evidence_json: string; build_json: string }>();
  const build = JSON.parse(original!.build_json) as {
    commitSha: string;
    treeSha: string;
    manifestBlobSha: string;
    artifactDigest: string;
    fileCount: number;
    totalBytes: number;
  };
  const evidence = JSON.stringify({
    ...(JSON.parse(original!.evidence_json) as Record<string, unknown>),
    deploymentId,
    jobUrl: `https://github.com/${repository}/actions/runs/12345/job/23456`,
    deploymentUrl: repository.endsWith('-canary')
      ? 'https://canary.pointatx.org'
      : 'https://pointatx.org',
  });
  await database
    .prepare(
      `INSERT INTO publish_jobs
    (id,idempotency_key,environment,status,candidate_json,candidate_checksum,repository,base_sha,result_sha,requested_by,requested_at,completed_at,evidence_json)
    SELECT ?,?,'production-merge','succeeded',candidate_json,candidate_checksum,?,base_sha,result_sha,requested_by,
      '2000-01-01T00:00:00Z','2000-01-01T00:00:00Z',? FROM publish_jobs WHERE id=?`,
    )
    .bind(id, crypto.randomUUID(), repository, evidence, job.id)
    .run();
  await database
    .prepare(
      `INSERT INTO publication_inputs(job_id,draft_id,revision_id,workflow_revision)
    SELECT ?,draft_id,revision_id,workflow_revision FROM publication_inputs WHERE job_id=?`,
    )
    .bind(id, job.id)
    .run();
  await database
    .prepare(
      `INSERT INTO publication_asset_pins(job_id,draft_id,source_path,asset_id)
    SELECT ?,draft_id,source_path,asset_id FROM publication_asset_pins WHERE job_id=?`,
    )
    .bind(id, job.id)
    .run();
  await database
    .prepare(
      `INSERT INTO publication_runs(job_id,nonce,dispatch_revision,run_id,run_attempt,check_run_id,claimed_at,build_json,deploy_authorized_at,deployment_json)
    SELECT ?,?,dispatch_revision,run_id,run_attempt,check_run_id,claimed_at,build_json,'2000-01-01T00:00:00Z',?
    FROM publication_runs WHERE job_id=?`,
    )
    .bind(id, '9'.repeat(64), JSON.stringify({ artifactDigest: build.artifactDigest }), job.id)
    .run();
  const source = JSON.stringify({
    repository,
    commitSha: build.commitSha,
    treeSha: build.treeSha,
    manifestBlobSha: build.manifestBlobSha,
    workflowRevision: context.config.workflowRevision,
    candidateChecksum: job.candidateChecksum,
    fileCount: build.fileCount,
    totalBytes: build.totalBytes,
  });
  const previous = () =>
    database
      .prepare(
        `SELECT id FROM publication_releases
    WHERE COALESCE(json_extract(source_json,'$.repository'),'PointCommunity/pointsite')=? ORDER BY sequence DESC LIMIT 1`,
      )
      .bind(repository)
      .first<string>('id');
  const record = (previousId: string | null) =>
    database
      .prepare(
        `INSERT INTO publication_releases
    (id,kind,job_id,previous_release_id,artifact_digest,source_json,evidence_json,verified_at,recorded_at)
    VALUES (?,'publication',?,?,?,?,?,'2000-01-01T00:00:00Z','2000-01-01T00:00:00Z')`,
      )
      .bind(id, id, previousId, build.artifactDigest, source, evidence)
      .run();
  return { id, previous, record };
}

it('binds previous releases and the current view to each public repository despite interleaved history', async () => {
  for (const origin of [canaryOrigin, productionOrigin]) {
    const context = await fixture(origin);
    const { database } = context;
    await database
      .prepare('INSERT INTO builder_instance(id,origin,instance_id) VALUES (1,?,?)')
      .bind(origin, crypto.randomUUID())
      .run();
    const production = await publicationRecord(context, 'PointCommunity/pointsite', '7001');
    const productionPrevious = await production.previous();
    expect(productionPrevious).toBe('public-baseline-2026-09-13');
    await verifiedReleaseStatement(database, production.id).run();
    const canary = await publicationRecord(context, 'PointCommunity/pointsite-canary', '7002');
    const canaryPrevious = await canary.previous();
    await expect(canary.record(production.id)).rejects.toThrow('PUBLICATION_RELEASE_MISMATCH');
    await verifiedReleaseStatement(database, canary.id).run();
    const nextProduction = await publicationRecord(context, 'PointCommunity/pointsite', '7003');
    await expect(nextProduction.record(canary.id)).rejects.toThrow('PUBLICATION_RELEASE_MISMATCH');
    await verifiedReleaseStatement(database, nextProduction.id).run();
    for (const [id, previous] of [
      [production.id, productionPrevious],
      [canary.id, canaryPrevious],
      [nextProduction.id, production.id],
    ]) {
      expect(
        await database
          .prepare('SELECT previous_release_id FROM publication_releases WHERE id=?')
          .bind(id)
          .first('previous_release_id'),
      ).toBe(previous);
    }
    const visible = (
      await database
        .prepare('SELECT id FROM current_publication_releases ORDER BY sequence')
        .all<{ id: string }>()
    ).results.map(({ id }) => id);
    if (origin === canaryOrigin) {
      expect(visible).toContain(canary.id);
      expect(visible).not.toContain(production.id);
      expect(visible).not.toContain(nextProduction.id);
      expect(visible).not.toContain('public-baseline-2026-09-13');
    } else {
      expect(visible).toContain(production.id);
      expect(visible).toContain(nextProduction.id);
      expect(visible).toContain('public-baseline-2026-09-13');
      expect(visible).not.toContain(canary.id);
    }
  }
});

it('retains the latest two releases and their inputs independently in both lanes', async () => {
  const context = await fixture();
  const { database } = context;
  const lanes: string[][] = [];
  for (const [lane, repository] of (
    ['PointCommunity/pointsite', 'PointCommunity/pointsite-canary'] as const
  ).entries()) {
    const ids: string[] = [];
    for (let index = 0; index < 3; index++) {
      const publication = await publicationRecord(
        context,
        repository,
        String(8000 + lane * 10 + index),
      );
      await publication.record(await publication.previous());
      ids.push(publication.id);
    }
    lanes.push(ids);
  }
  // All Canary releases are newer than every Production release. Global latest-two retention would lose Production inputs.
  for (const ids of lanes)
    for (const id of ids.slice(1)) {
      await expect(
        database.prepare('DELETE FROM publication_releases WHERE id=?').bind(id).run(),
      ).rejects.toThrow('PUBLICATION_RELEASE_RETAINED');
      await expect(
        database.prepare('DELETE FROM publication_inputs WHERE job_id=?').bind(id).run(),
      ).rejects.toThrow('PUBLICATION_RELEASE_INPUTS_RETAINED');
      expect(
        await database
          .prepare('SELECT count(*) n FROM publication_asset_pins WHERE job_id=?')
          .bind(id)
          .first<number>('n'),
      ).toBeGreaterThan(0);
      await expect(
        database.prepare('DELETE FROM publication_asset_pins WHERE job_id=?').bind(id).run(),
      ).rejects.toThrow('PUBLICATION_RELEASE_INPUTS_RETAINED');
    }
  for (let pass = 0; pass < 3; pass++) await retirePublicationMetadata(database);
  for (const [oldest, ...retained] of lanes) {
    expect(
      await database.prepare('SELECT 1 FROM publication_releases WHERE id=?').bind(oldest).first(),
    ).toBeNull();
    expect(
      await database
        .prepare('SELECT 1 FROM publication_inputs WHERE job_id=?')
        .bind(oldest)
        .first(),
    ).toBeNull();
    expect(
      await database
        .prepare('SELECT count(*) n FROM publication_asset_pins WHERE job_id=?')
        .bind(oldest)
        .first('n'),
    ).toBe(0);
    for (const id of retained) {
      expect(
        await database.prepare('SELECT 1 FROM publication_releases WHERE id=?').bind(id).first(),
      ).not.toBeNull();
      expect(
        await database.prepare('SELECT 1 FROM publication_inputs WHERE job_id=?').bind(id).first(),
      ).not.toBeNull();
      expect(
        await database
          .prepare('SELECT count(*) n FROM publication_asset_pins WHERE job_id=?')
          .bind(id)
          .first<number>('n'),
      ).toBeGreaterThan(0);
    }
  }
  expect((await database.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
});
