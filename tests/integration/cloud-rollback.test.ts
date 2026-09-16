// @vitest-environment node
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { exportPKCS8, generateKeyPair, SignJWT } from 'jose';
import { D1CloudRollback } from '../../src/server/publish/rollback';
import { publicationClaims } from '../fixtures/publication-runner';
import { publicationRunnerAudience } from '../../src/server/publish/runner-auth';

let runtime: Miniflare;
afterEach(async () => {
  await runtime?.dispose();
});

async function fixture() {
  runtime = new Miniflare({
    compatibilityDate: '2026-09-05',
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { DB: crypto.randomUUID() },
  });
  const database = await runtime.getD1Database('DB');
  for (const name of (await readdir('migrations')).filter((name) => name.endsWith('.sql')).sort())
    await database.exec(
      (await readFile(`migrations/${name}`, 'utf8'))
        .replace(/--[^\n]*/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    );
  const actor = 'github:12345';
  await database
    .prepare(
      `INSERT INTO user_roles(email,github_login,role,active,created_at,updated_at,updated_by)
    VALUES (?,'fixture','administrator',1,'fixture','fixture','fixture')`,
    )
    .bind(actor)
    .run();
  const keys = await generateKeyPair('RS256', { extractable: true });
  const config = {
    appId: '123',
    installationId: '456',
    privateKey: await exportPKCS8(keys.privateKey),
    workflowRevision: 'a'.repeat(40),
  };
  const state = {
    main: 'b'.repeat(40),
    deployment: 6276181817,
    permission: 'write',
    requests: [] as string[],
    dispatches: 0,
    executing: false,
    completed: false,
    nativeState: 'in_progress',
    terminal: false,
    release: {} as Record<string, unknown>,
    beforePermission: async () => {},
  };
  const fetcher: typeof fetch = async (url) => {
    const path = url instanceof Request ? url.url : String(url);
    state.requests.push(path);
    if (path.endsWith('/access_tokens'))
      return Response.json({ token: 'fixture-installation-token', expires_at: 'fixture' });
    if (path.endsWith('/permission')) {
      await state.beforePermission();
      return Response.json({ permission: state.permission, user: { id: 12345 } });
    }
    if (path.endsWith('/git/ref/heads/main')) return Response.json({ object: { sha: state.main } });
    if (path.includes('/contents/.github/workflows/rollback-production.yml'))
      return Response.json({ type: 'file', sha: 'c'.repeat(40) });
    const deployment = (id: number) => ({
      id,
      sha: state.main,
      environment: 'github-pages',
      performed_via_github_app: null,
    });
    if (path.includes('/deployments?environment=github-pages&per_page='))
      return Response.json(
        path.endsWith('2')
          ? [deployment(state.deployment + 1), deployment(state.deployment)]
          : [deployment(state.deployment + (state.executing ? 1 : 0))],
      );
    if (path.includes('/statuses?per_page=1'))
      return Response.json([
        {
          state: state.executing && !state.completed ? state.nativeState : 'success',
          environment: 'github-pages',
          environment_url: 'https://pointatx.org',
          log_url: 'https://github.com/PointCommunity/pointsite/actions/runs/12345/job/23456',
        },
      ]);
    if (path.endsWith('/check-runs/23456'))
      return Response.json({
        id: 23456,
        status: state.completed ? 'completed' : 'in_progress',
        conclusion: 'success',
        head_sha: state.main,
        details_url: 'https://github.com/PointCommunity/pointsite/actions/runs/12345/job/23456',
        app: { id: 15368, slug: 'github-actions' },
        deployment: { id: state.deployment + (state.executing ? 1 : 0) },
      });
    if (path === 'https://pointatx.org/__pointsite_release.json')
      return Response.json(state.release);
    if (path.includes('/actions/runs/12345'))
      return Response.json({
        id: 12345,
        run_attempt: 1,
        status: state.terminal ? 'completed' : 'in_progress',
        conclusion: 'success',
        head_sha: state.main,
        head_branch: 'main',
        event: 'repository_dispatch',
        path: '.github/workflows/rollback-production.yml',
        repository: { id: 1348084954, full_name: 'PointCommunity/pointsite' },
        referenced_workflows: [
          {
            path: `PointCommunity/pointsite-staging/.github/workflows/rollback-runtime.yml@${config.workflowRevision}`,
            sha: config.workflowRevision,
          },
        ],
      });
    if (path.endsWith('/dispatches')) {
      state.dispatches++;
      return new Response(null, { status: 204 });
    }
    throw new Error('Unexpected fixture request');
  };
  const service = new D1CloudRollback(database, config, 'c'.repeat(40), fetcher, () =>
    Promise.resolve(keys.publicKey),
  );
  const input = {
    actor,
    sourceReleaseId: 'public-baseline-2026-09-13',
    previousReleaseId: 'public-baseline-2026-09-13',
    baseSha: state.main,
    previousDeploymentId: String(state.deployment),
    idempotencyKey: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
  };
  const signed = async (jobId: string, check = '23456', overrides = {}) => {
    const row = await database
      .prepare('SELECT nonce FROM publication_rollbacks WHERE id=?')
      .bind(jobId)
      .first<{ nonce: string }>();
    const scope = {
      jobId,
      nonce: row!.nonce,
      target: 'production' as const,
      dispatchRevision: input.baseSha,
      workflowRevision: config.workflowRevision,
    };
    return new SignJWT({
      ...publicationClaims(scope),
      aud: publicationRunnerAudience(jobId, row!.nonce, 'rollback'),
      check_run_id: check,
      workflow_ref:
        'PointCommunity/pointsite/.github/workflows/rollback-production.yml@refs/heads/main',
      job_workflow_ref: `PointCommunity/pointsite-staging/.github/workflows/rollback-runtime.yml@${config.workflowRevision}`,
      ...overrides,
    })
      .setProtectedHeader({ alg: 'RS256' })
      .sign(keys.privateKey);
  };
  return { database, service, input, state, config, keys, fetcher, signed };
}

it('captures immutable baseline rollback without a synthetic draft and reconciles duplicate capture', async () => {
  const { database, service, input, state } = await fixture();
  const first = await service.capture(input);
  expect(await service.capture(input)).toEqual(first);
  expect(await database.prepare('SELECT count(*) n FROM drafts').first('n')).toBe(0);
  expect(await database.prepare('SELECT count(*) n FROM publication_rollbacks').first('n')).toBe(1);
  expect(state.dispatches).toBe(0);
  await expect(service.capture({ ...input, sourceReleaseId: 'different' })).rejects.toThrow(
    'IDEMPOTENCY_CONFLICT',
  );
  await expect(service.capture({ ...input, idempotencyKey: crypto.randomUUID() })).rejects.toThrow(
    'ROLLBACK_CAPTURE_CHANGED',
  );
  await expect(
    database
      .prepare('UPDATE publication_rollbacks SET base_sha=? WHERE id=?')
      .bind('d'.repeat(40), first.id)
      .run(),
  ).rejects.toThrow('ROLLBACK_IDENTITY_CHANGED');
});

it('rejects revoked authority and changed native state before rollback capture', async () => {
  const { database, service, input, state } = await fixture();
  for (const role of ['publisher', 'editor', 'viewer']) {
    await database.prepare('UPDATE user_roles SET role=?').bind(role).run();
    await expect(service.capture(input)).rejects.toThrow('PRODUCTION_AUTHORITY_CHANGED');
  }
  await database.prepare("UPDATE user_roles SET role='administrator'").run();
  state.main = 'd'.repeat(40);
  await expect(service.capture(input)).rejects.toThrow('ROLLBACK_STATE_CHANGED');
  state.main = input.baseSha;
  state.deployment++;
  await expect(service.capture(input)).rejects.toThrow('ROLLBACK_STATE_CHANGED');
  state.deployment--;
  state.beforePermission = async () => {
    await database.prepare('UPDATE user_roles SET active=0').run();
  };
  await expect(service.capture(input)).rejects.toThrow();
  expect(await database.prepare('SELECT count(*) n FROM publication_rollbacks').first('n')).toBe(0);
});

it('bounds cloud dispatch and refuses normal Production publication while rollback holds its lock', async () => {
  const { database, service, input, state } = await fixture();
  await service.capture(input);
  await service.dispatchPending();
  await service.dispatchPending();
  expect(state.dispatches).toBe(1);
  await expect(
    database
      .prepare(
        `INSERT INTO publish_jobs
    (id,idempotency_key,environment,status,candidate_json,candidate_checksum,repository,base_sha,requested_by,requested_at)
    VALUES (?,?,'production-merge','queued','{}',?,'PointCommunity/pointsite',?,?,'fixture')`,
      )
      .bind(crypto.randomUUID(), crypto.randomUUID(), 'a'.repeat(64), input.baseSha, input.actor)
      .run(),
  ).rejects.toThrow('PUBLISH_SLOT_BUSY');
});

it('requires separate signed reservation, execution and finalizer and appends verified rollback once', async () => {
  const { database, service, input, state, signed } = await fixture();
  const { id } = await service.capture(input);
  const execute = await signed(id),
    reserve = await signed(id, '23455'),
    finalize = await signed(id, '23457');
  await expect(service.claim(id, execute)).rejects.toThrow();
  await expect(service.reserve(id, await signed(id, '23455', { aud: 'wrong' }))).rejects.toThrow(
    'PUBLISH_RUNNER_UNAUTHORIZED',
  );
  await service.reserve(id, reserve);
  await expect(service.claim(id, reserve)).rejects.toThrow();
  await expect(
    service.reserve(id, await signed(id, '23454', { run_attempt: '2' })),
  ).rejects.toThrow();
  state.executing = true;
  await service.claim(id, execute);
  await expect(service.inputs(id, finalize)).rejects.toThrow();
  const captured = await service.inputs(id, execute);
  await expect(
    service.reportDeployment(id, execute, { artifactDigest: captured.source.artifactDigest }),
  ).rejects.toThrow();
  await service.authorizeDeployment(id, execute);
  await expect(
    service.reportDeployment(id, execute, { artifactDigest: 'a'.repeat(64) }),
  ).rejects.toThrow();
  await service.reportDeployment(id, execute, { artifactDigest: captured.source.artifactDigest });
  await expect(service.finalize(id, execute)).rejects.toThrow('PUBLISH_RUNNER_UNAUTHORIZED');
  await expect(service.finalize(id, finalize)).rejects.toThrow();
  state.completed = true;
  state.release = {
    format: 2,
    candidateChecksum: captured.candidateChecksum,
    artifactDigest: captured.source.artifactDigest,
    workflowRevision: captured.workflowRevision,
  };
  expect(await service.finalize(id, finalize)).toEqual({ verified: true });
  expect(await service.finalize(id, finalize)).toEqual({ verified: true });
  expect(
    await database
      .prepare("SELECT count(*) FROM publication_releases WHERE kind='rollback'")
      .first('count(*)'),
  ).toBe(1);
  const release = await database
    .prepare('SELECT * FROM publication_releases WHERE id=?')
    .bind(id)
    .first();
  expect(release?.previous_release_id).toBe(input.previousReleaseId);
  const next = await service.capture({
    ...input,
    sourceReleaseId: id,
    previousReleaseId: id,
    previousDeploymentId: String(state.deployment + 1),
    idempotencyKey: crypto.randomUUID(),
  });
  expect(next.status).toBe('queued');
  expect(
    (
      JSON.parse(
        (await database
          .prepare('SELECT source_json FROM publication_rollbacks WHERE id=?')
          .bind(next.id)
          .first<string>('source_json'))!,
      ) as { kind: string }
    ).kind,
  ).toBe('baseline');
});

it('never releases a running rollback on elapsed time, and fences delayed runners after cancellation', async () => {
  const { database, service, input, state, signed } = await fixture();
  const { id } = await service.capture(input);
  await service.reserve(id, await signed(id, '23455'));
  await service.claim(id, await signed(id));
  await expect(service.recover(id, input.actor, 'cancel')).rejects.toThrow(
    'PUBLICATION_RUN_NOT_TERMINAL',
  );
  state.terminal = true;
  expect(await service.recover(id, input.actor, 'cancel')).toEqual({ recovered: true });
  expect(await service.recover(id, input.actor, 'cancel')).toEqual({ recovered: true });
  await expect(service.inputs(id, await signed(id))).rejects.toThrow('PUBLISH_RUNNER_UNAUTHORIZED');
  expect(
    await database.prepare('SELECT count(*) FROM current_publication_releases').first('count(*)'),
  ).toBe(1);
});

it('rechecks local revocation and native deployment ownership immediately before authorization', async () => {
  const { database, service, input, state, signed } = await fixture();
  const { id } = await service.capture(input);
  await service.reserve(id, await signed(id, '23455'));
  await service.claim(id, await signed(id));
  state.executing = true;
  state.nativeState = 'success';
  await expect(service.authorizeDeployment(id, await signed(id))).rejects.toThrow(
    'ROLLBACK_STATE_CHANGED',
  );
  state.nativeState = 'in_progress';
  state.beforePermission = async () => {
    await database.prepare('UPDATE user_roles SET active=0').run();
  };
  await expect(service.authorizeDeployment(id, await signed(id))).rejects.toThrow();
  expect(
    await database
      .prepare('SELECT deploy_authorized_at FROM publication_rollbacks WHERE id=?')
      .bind(id)
      .first('deploy_authorized_at'),
  ).toBe(null);
});
