import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import { publicationDestination } from './destinations';
export { publicationDestinations } from './destinations';

const issuer = 'https://token.actions.githubusercontent.com';
const githubKeys = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks`));
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const identifier = z.string().regex(/^[1-9][0-9]{0,19}$/);
const builderOriginSchema = z.enum([
  'https://builder.pointatx.org',
  'https://builder.eaglepass.io',
  'https://builder-canary.eaglepass.io',
]);
const scopeSchema = z.strictObject({
  builderOrigin: z
    .string()
    .refine((value) => builderOriginSchema.safeParse(value).success)
    .optional(),
  target: z.enum(['staging', 'production']),
  purpose: z.enum(['verification', 'rollback']).optional(),
  workflowRevision: sha,
  dispatchRevision: sha,
  jobId: z.uuid(),
  nonce: z.string().regex(/^[a-f0-9]{64}$/),
  run: z.strictObject({ id: identifier, attempt: identifier }).optional(),
});

export type PublicationRunnerScope = z.infer<typeof scopeSchema>;

// Verified repository OIDC settings use immutable subjects. Do not silently accept
// legacy subjects, alternate repositories, user sessions, or caller-provided URLs.
export function publicationRunnerAudience(
  jobId: string,
  nonce: string,
  purpose?: 'verification' | 'rollback',
  builderOrigin = 'https://builder.pointatx.org',
): string {
  z.uuid().parse(jobId);
  scopeSchema.shape.nonce.parse(nonce);
  builderOriginSchema.parse(builderOrigin);
  return `${builderOrigin}/${purpose === 'verification' ? 'verify' : purpose === 'rollback' ? 'rollback' : 'publish'}/${jobId}/${nonce}`;
}

export async function verifyPublicationRunner(
  token: string,
  expected: PublicationRunnerScope,
  keys: JWTVerifyGetKey = githubKeys,
) {
  const scope = scopeSchema.safeParse(expected);
  if (!scope.success) throw new Error('PUBLISH_RUNNER_NOT_CONFIGURED');
  try {
    if (!token || token.length > 16_384) throw new Error('Invalid token size');
    const destination = publicationDestination(scope.data.target, scope.data.builderOrigin);
    const repository = `PointCommunity/${destination.repository}`;
    const audience = publicationRunnerAudience(
      scope.data.jobId,
      scope.data.nonce,
      scope.data.purpose,
      scope.data.builderOrigin,
    );
    const { payload } = await jwtVerify(token, keys, {
      algorithms: ['RS256'],
      issuer,
      audience,
      subject: `repo:PointCommunity@323764526/${destination.repository}@${destination.id}:environment:${destination.environment}`,
      requiredClaims: ['iat', 'nbf', 'exp', 'jti'],
      maxTokenAge: '5 minutes',
      clockTolerance: 0,
    });
    const claims = z
      .object({
        aud: z.literal(audience),
        repository: z.literal(repository),
        repository_id: z.literal(destination.id),
        repository_owner: z.literal('PointCommunity'),
        repository_owner_id: z.literal('323764526'),
        repository_visibility: z.literal('public'),
        runner_environment: z.literal('github-hosted'),
        event_name: z.literal('repository_dispatch'),
        ref: z.literal('refs/heads/main'),
        ref_type: z.literal('branch'),
        sha: z.literal(scope.data.dispatchRevision),
        workflow_sha: z.literal(scope.data.dispatchRevision),
        workflow_ref: z.literal(
          `${repository}/.github/workflows/${scope.data.purpose === 'verification' ? 'verify-publication' : scope.data.purpose === 'rollback' ? 'rollback-production' : 'publish-candidate'}.yml@refs/heads/main`,
        ),
        job_workflow_sha: z.literal(scope.data.workflowRevision),
        job_workflow_ref: z.literal(
          `PointCommunity/pointsite-staging/.github/workflows/${scope.data.purpose === 'verification' ? 'verify-runtime' : scope.data.purpose === 'rollback' ? 'rollback-runtime' : scope.data.target === 'staging' ? 'publish-runtime' : 'publish-production-runtime'}.yml@${scope.data.workflowRevision}`,
        ),
        environment: z.literal(destination.environment),
        run_id: identifier,
        run_attempt: identifier,
        check_run_id: identifier,
        jti: z.string().min(1).max(200),
      })
      .parse(payload);
    if (
      scope.data.run &&
      (claims.run_id !== scope.data.run.id || claims.run_attempt !== scope.data.run.attempt)
    )
      throw new Error('Runner changed');
    return {
      runId: claims.run_id,
      runAttempt: claims.run_attempt,
      checkRunId: claims.check_run_id,
      tokenId: claims.jti,
    };
  } catch {
    // JWT/parser errors may contain supplied values. Keep credentials and claims out
    // of HTTP errors and logs; callers receive only this stable authorization code.
    throw new Error('PUBLISH_RUNNER_UNAUTHORIZED');
  }
}
