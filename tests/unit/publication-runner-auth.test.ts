// @vitest-environment node
import { generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import {
  publicationRunnerAudience,
  verifyPublicationRunner,
  type PublicationRunnerScope,
} from '../../src/server/publish/runner-auth';

import { publicationClaims } from '../fixtures/publication-runner';
const scope: PublicationRunnerScope = {
  target: 'staging',
  workflowRevision: 'a'.repeat(40),
  dispatchRevision: 'b'.repeat(40),
  jobId: '10000000-0000-4000-8000-000000000001',
  nonce: 'c'.repeat(64),
  run: { id: '12345', attempt: '1' },
};
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
beforeAll(async () => {
  keys = await generateKeyPair('RS256');
});
const resolver = () => Promise.resolve(keys.publicKey);

const claims = (expected = scope) => publicationClaims(expected);
const sign = (payload: JWTPayload) =>
  new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key', typ: 'JWT' })
    .sign(keys.privateKey);

it('accepts only the exact signed staging or production execution identity', async () => {
  for (const target of ['staging', 'production'] as const) {
    const expected = { ...scope, target };
    const token = await sign(claims(expected));
    expect(await verifyPublicationRunner(token, expected, resolver)).toEqual({
      runId: '12345',
      runAttempt: '1',
      checkRunId: '23456',
      tokenId: 'signed-fixture-token',
    });
  }
});

it('rejects substitution of each repository, caller, reusable workflow and run binding', async () => {
  const mutations = {
    iss: 'https://untrusted.example',
    sub: 'repo:PointCommunity/pointsite-staging:environment:staging',
    aud: 'https://builder.pointatx.org/publish/another-job',
    repository: 'PointCommunity/pointsite',
    repository_id: '1348084954',
    repository_owner: 'another-owner',
    repository_owner_id: '1',
    repository_visibility: 'private',
    runner_environment: 'self-hosted',
    event_name: 'workflow_dispatch',
    ref: 'refs/heads/unreviewed',
    ref_type: 'tag',
    sha: 'd'.repeat(40),
    workflow_sha: 'd'.repeat(40),
    workflow_ref: 'PointCommunity/pointsite-staging/.github/workflows/other.yml@refs/heads/main',
    job_workflow_sha: 'd'.repeat(40),
    job_workflow_ref:
      'PointCommunity/pointsite-staging/.github/workflows/publish-runtime.yml@refs/heads/main',
    environment: 'github-pages',
    run_id: '12346',
    run_attempt: '2',
    check_run_id: '0',
    jti: '',
  };
  for (const [field, value] of Object.entries(mutations)) {
    const token = await sign({ ...claims(), [field]: value });
    await expect(verifyPublicationRunner(token, scope, resolver), field).rejects.toThrow(
      'PUBLISH_RUNNER_UNAUTHORIZED',
    );
  }
});

it('rejects expiry, future activation, old issuance, missing claims and invalid signatures', async () => {
  const now = Math.floor(Date.now() / 1000);
  for (const change of [
    { exp: now - 1 },
    { nbf: now + 60 },
    { iat: now + 60 },
    { iat: now - 301, exp: now + 60 },
    { aud: [publicationRunnerAudience(scope.jobId, scope.nonce), 'another-job'] },
    ...['iat', 'nbf', 'exp', 'jti', 'sub', 'aud', 'job_workflow_sha', 'check_run_id'].map(
      (key) => ({ [key]: undefined }),
    ),
  ]) {
    await expect(
      verifyPublicationRunner(await sign({ ...claims(), ...change }), scope, resolver),
    ).rejects.toThrow('PUBLISH_RUNNER_UNAUTHORIZED');
  }
  const forged = await generateKeyPair('RS256');
  const token = await new SignJWT(claims())
    .setProtectedHeader({ alg: 'RS256' })
    .sign(forged.privateKey);
  await expect(verifyPublicationRunner(token, scope, resolver)).rejects.toThrow(
    'PUBLISH_RUNNER_UNAUTHORIZED',
  );
  for (const invalid of ['', 'not-a-jwt', 'x'.repeat(16_385)]) {
    await expect(verifyPublicationRunner(invalid, scope, resolver)).rejects.toThrow(
      'PUBLISH_RUNNER_UNAUTHORIZED',
    );
  }
});

it('binds tokens to one job and nonce and rejects missing configuration before key access', async () => {
  const token = await sign(claims());
  for (const change of [
    { nonce: 'd'.repeat(64) },
    { jobId: '10000000-0000-4000-8000-000000000002' },
    { target: 'production' as const },
  ]) {
    await expect(verifyPublicationRunner(token, { ...scope, ...change }, resolver)).rejects.toThrow(
      'PUBLISH_RUNNER_UNAUTHORIZED',
    );
  }
  const unused = vi.fn(resolver);
  await expect(
    verifyPublicationRunner(token, { ...scope, workflowRevision: '' }, unused),
  ).rejects.toThrow('PUBLISH_RUNNER_NOT_CONFIGURED');
  expect(unused).not.toHaveBeenCalled();
  // The first claim may discover a run; all later requests must supply its stored binding.
  const unclaimed = { ...scope, run: undefined };
  expect(await verifyPublicationRunner(token, unclaimed, resolver)).toMatchObject({
    runId: '12345',
  });
});

it('separates read-only verification audiences and workflows from deployment authority', async () => {
  for (const target of ['staging', 'production'] as const) {
    const deployment = { ...scope, target };
    const verification = { ...deployment, purpose: 'verification' as const };
    const name = target === 'staging' ? 'pointsite-staging' : 'pointsite';
    const payload = {
      ...claims(deployment),
      aud: `https://builder.pointatx.org/verify/${scope.jobId}/${scope.nonce}`,
      workflow_ref: `PointCommunity/${name}/.github/workflows/verify-publication.yml@refs/heads/main`,
      job_workflow_ref: `PointCommunity/pointsite-staging/.github/workflows/verify-runtime.yml@${scope.workflowRevision}`,
    };
    const token = await sign(payload);
    expect(await verifyPublicationRunner(token, verification, resolver)).toMatchObject({
      runId: '12345',
      checkRunId: '23456',
    });
    await expect(verifyPublicationRunner(token, deployment, resolver)).rejects.toThrow(
      'PUBLISH_RUNNER_UNAUTHORIZED',
    );
    await expect(
      verifyPublicationRunner(await sign(claims(deployment)), verification, resolver),
    ).rejects.toThrow('PUBLISH_RUNNER_UNAUTHORIZED');
    for (const field of ['aud', 'workflow_ref', 'job_workflow_ref'] as const) {
      await expect(
        verifyPublicationRunner(
          await sign({ ...payload, [field]: claims(deployment)[field] }),
          verification,
          resolver,
        ),
        field,
      ).rejects.toThrow('PUBLISH_RUNNER_UNAUTHORIZED');
    }
  }
});
