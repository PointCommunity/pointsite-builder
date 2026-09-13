import type { JWTPayload } from 'jose';
import {
  publicationRunnerAudience,
  type PublicationRunnerScope,
} from '../../src/server/publish/runner-auth';

const issuer = 'https://token.actions.githubusercontent.com';

export function publicationClaims(expected: PublicationRunnerScope): JWTPayload {
  const staging = expected.target === 'staging';
  const name = staging ? 'pointsite-staging' : 'pointsite';
  const id = staging ? '1357847426' : '1348084954';
  const environment = staging ? 'staging' : 'github-pages';
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: issuer,
    sub: `repo:PointCommunity@323764526/${name}@${id}:environment:${environment}`,
    aud: publicationRunnerAudience(expected.jobId, expected.nonce),
    iat: now,
    nbf: now,
    exp: now + 300,
    jti: 'signed-fixture-token',
    repository: `PointCommunity/${name}`,
    repository_id: id,
    repository_owner: 'PointCommunity',
    repository_owner_id: '323764526',
    repository_visibility: 'public',
    runner_environment: 'github-hosted',
    event_name: 'repository_dispatch',
    ref: 'refs/heads/main',
    ref_type: 'branch',
    sha: expected.dispatchRevision,
    workflow_sha: expected.dispatchRevision,
    workflow_ref: `PointCommunity/${name}/.github/workflows/publish-candidate.yml@refs/heads/main`,
    job_workflow_sha: expected.workflowRevision,
    job_workflow_ref: `PointCommunity/pointsite-staging/.github/workflows/${staging ? 'publish-runtime' : 'publish-production-runtime'}.yml@${expected.workflowRevision}`,
    environment,
    run_id: '12345',
    run_attempt: '1',
    check_run_id: '23456',
  };
}
