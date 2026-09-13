// @vitest-environment node
import {
  verifyDeploymentProof,
  type DeploymentExpectation,
} from '../../src/server/publish/deployment-proof';

const expectation: DeploymentExpectation = {
  target: 'staging',
  runId: '12345',
  checkRunId: '23456',
  dispatchRevision: 'a'.repeat(40),
  commitSha: 'b'.repeat(40),
  workflowRevision: 'c'.repeat(40),
  candidateChecksum: 'd'.repeat(64),
  artifactDigest: 'e'.repeat(64),
  workerVersionId: '10000000-0000-4000-8000-000000000001',
};
function fixture(input = expectation, change = '') {
  const staging = input.target === 'staging';
  const repository = `PointCommunity/${staging ? 'pointsite-staging' : 'pointsite'}`;
  const environment = staging ? 'staging' : 'github-pages';
  const origin = staging ? 'https://staging.pointatx.org' : 'https://pointatx.org';
  const api = `https://api.github.com/repos/${repository}`;
  const jobUrl = `https://github.com/${repository}/actions/runs/${input.runId}/job/${input.checkRunId}`;
  const app = { id: change === 'app' ? 999 : 15368, slug: 'github-actions' };
  let lists = 0;
  return vi.fn<typeof fetch>((url, init) => {
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
    if (change === 'provider')
      return Promise.resolve(new Response('private provider response', { status: 500 }));
    const path = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    let result: unknown;
    if (path === `${api}/check-runs/${input.checkRunId}`)
      result = {
        id: Number(input.checkRunId),
        app,
        head_sha: change === 'head' ? input.commitSha : input.dispatchRevision,
        status: change === 'pending' ? 'in_progress' : 'completed',
        conclusion: change === 'failed' ? 'failure' : 'success',
        details_url: change === 'run' ? `${jobUrl}1` : jobUrl,
      };
    else if (path === `${api}/git/ref/heads/main`)
      result = { object: { sha: change === 'base' ? input.dispatchRevision : input.commitSha } };
    else if (path === `${api}/deployments?environment=${environment}&per_page=1`) {
      lists++;
      result = [
        {
          id: change === 'drift' && lists > 1 ? 2 : 1,
          sha: input.dispatchRevision,
          environment,
          performed_via_github_app: app,
        },
      ];
    } else if (path === `${api}/deployments/1/statuses?per_page=1`)
      result = [
        {
          state: change === 'inactive' ? 'inactive' : 'success',
          environment,
          log_url: jobUrl,
          environment_url: change === 'url' ? 'https://other.example/' : `${origin}/`,
        },
      ];
    else if (path === `${origin}/__pointsite_release.json`)
      result = {
        format: 2,
        candidateChecksum: input.candidateChecksum,
        workflowRevision: input.workflowRevision,
        artifactDigest: change === 'artifact' ? 'f'.repeat(64) : input.artifactDigest,
        ...(staging
          ? { workerVersionId: change === 'version' ? crypto.randomUUID() : input.workerVersionId }
          : {}),
      };
    else throw new Error('Unexpected proof endpoint');
    return Promise.resolve(Response.json(result));
  });
}

it('verifies native execution and deployment separately from the new content commit and output identity', async () => {
  for (const target of ['staging', 'production'] as const) {
    const input = { ...expectation, target };
    const fetcher = fixture(input);
    expect(await verifyDeploymentProof(input, fetcher)).toMatchObject({
      deploymentId: '1',
      dispatchRevision: input.dispatchRevision,
      commitSha: input.commitSha,
      artifactDigest: input.artifactDigest,
      runId: input.runId,
    });
    expect(fetcher).toHaveBeenCalledTimes(6);
  }
});

it('refuses incomplete, substituted, changed or unavailable native and live evidence', async () => {
  for (const failure of [
    'app',
    'head',
    'pending',
    'failed',
    'run',
    'base',
    'drift',
    'inactive',
    'url',
    'artifact',
    'version',
    'provider',
  ]) {
    await expect(
      verifyDeploymentProof(expectation, fixture(expectation, failure)),
      failure,
    ).rejects.toThrow('PUBLICATION_VERIFICATION_UNCONFIRMED');
  }
  const unused = fixture();
  await expect(
    verifyDeploymentProof({ ...expectation, workerVersionId: undefined }, unused),
  ).rejects.toThrow('PUBLICATION_VERIFICATION_UNCONFIRMED');
  expect(unused).not.toHaveBeenCalled();
});
