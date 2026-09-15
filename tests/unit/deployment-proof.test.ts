// @vitest-environment node
import {
  verifyDeploymentProof,
  verifyRecoveryRevision,
  type DeploymentExpectation,
} from '../../src/server/publish/deployment-proof';

it('allows only verification maintenance between retained publication and recovery dispatch', async () => {
  const original = '1'.repeat(40);
  const current = '2'.repeat(40);
  const file = {
    path: 'content/builder-site.json',
    mode: '100644',
    type: 'blob',
    sha: '3'.repeat(40),
  };
  const verifier = { ...file, path: 'scripts/verification-output.mts' };
  for (const failure of ['', 'content', 'delete', 'extra', 'mode', 'truncated', 'identity']) {
    const read = vi.fn((path: string) => {
      const next = path.includes(current);
      if (path.includes('/git/commits/'))
        return Promise.resolve({
          sha: next ? current : original,
          tree: { sha: next ? current : original },
        });
      return Promise.resolve({
        sha: failure === 'identity' ? '9'.repeat(40) : next ? current : original,
        truncated: failure === 'truncated',
        tree: !next
          ? [file, verifier]
          : [
              ...(failure === 'delete'
                ? []
                : [{ ...file, sha: failure === 'content' ? '4'.repeat(40) : file.sha }]),
              { ...verifier, sha: '5'.repeat(40), mode: failure === 'mode' ? '120000' : '100644' },
              ...(failure === 'extra' ? [{ ...file, path: 'scripts/publication-build.mts' }] : []),
            ],
      });
    });
    if (failure)
      await expect(verifyRecoveryRevision(original, current, read), failure).rejects.toThrow();
    else await expect(verifyRecoveryRevision(original, current, read)).resolves.toBeUndefined();
  }
});

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
function fixture(input = expectation, change = '', token?: string, canary = false) {
  const staging = input.target === 'staging';
  const repository = `PointCommunity/${canary ? 'pointsite-staging-canary' : staging ? 'pointsite-staging' : 'pointsite'}`;
  const environment = staging ? 'staging' : 'github-pages';
  const origin = canary
    ? 'https://staging-canary.pointatx.org'
    : staging
      ? 'https://staging.pointatx.org'
      : 'https://pointatx.org';
  const api = `https://api.github.com/repos/${repository}`;
  const jobUrl = `https://github.com/${repository}/actions/runs/${input.runId}/job/${input.checkRunId}`;
  const app = { id: change === 'app' ? 999 : 15368, slug: 'github-actions' };
  let lists = 0;
  return vi.fn<typeof fetch>((url, init) => {
    expect(init?.redirect).toBe('error');
    const address = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    expect(new Headers(init?.headers).get('authorization')).toBe(
      token && address.startsWith(`${api}/`) ? `Bearer ${token}` : null,
    );
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
        deployment:
          change === 'missing-deployment' ? null : { id: change === 'deployment' ? 9 : 1 },
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
          performed_via_github_app: null,
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
    'deployment',
    'missing-deployment',
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
  expect(unused).toHaveBeenCalled();
});

it('verifies Pages staging without a Worker identity and rejects substituted output or a historical Worker release', async () => {
  const input = { ...expectation, workerVersionId: undefined };
  expect(await verifyDeploymentProof(input, fixture(input))).toMatchObject({
    deploymentUrl: 'https://staging.pointatx.org',
    artifactDigest: input.artifactDigest,
  });
  for (const failure of ['artifact', 'drift', 'failed', 'version'])
    await expect(verifyDeploymentProof(input, fixture(input, failure))).rejects.toThrow(
      'PUBLICATION_VERIFICATION_UNCONFIRMED',
    );
});

it('sends the repository token only to fixed GitHub proof endpoints, never to the live site', async () => {
  const fetcher = fixture(expectation, '', 'fixture-token');
  await verifyDeploymentProof(expectation, fetcher, 'fixture-token');
  expect(fetcher).toHaveBeenCalledTimes(6);
});

it('verifies isolated Canary Pages through the same proof and rejects higher-environment evidence', async () => {
  const input = { ...expectation, workerVersionId: undefined };
  const origin = 'https://builder-canary.eaglepass.io';
  const fetcher = fixture(input, '', 'canary-scoped-token', true);
  expect(await verifyDeploymentProof(input, fetcher, 'canary-scoped-token', origin)).toMatchObject({
    deploymentUrl: 'https://staging-canary.pointatx.org',
    artifactDigest: input.artifactDigest,
  });
  await expect(verifyDeploymentProof(input, fixture(input), undefined, origin)).rejects.toThrow(
    'PUBLICATION_VERIFICATION_UNCONFIRMED',
  );
  await expect(verifyDeploymentProof(input, fixture(input, '', undefined, true))).rejects.toThrow(
    'PUBLICATION_VERIFICATION_UNCONFIRMED',
  );
  const unused = vi.fn<typeof fetch>();
  await expect(
    verifyDeploymentProof({ ...input, target: 'production' }, unused, undefined, origin),
  ).rejects.toThrow('PUBLICATION_VERIFICATION_UNCONFIRMED');
  expect(unused).not.toHaveBeenCalled();
});

it('requires current full native Worker traffic and exact retained version annotations', async () => {
  const { verifyStagingDeployment } = await import('../../src/server/publish/deployment-proof');
  const deploymentId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const api =
    'https://api.cloudflare.com/client/v4/accounts/bc890091d86ddf9ce669e96e79d47746/workers/scripts/pointsite-staging';
  for (const failure of ['', 'split', 'tag', 'candidate', 'changed', 'provider']) {
    let reads = 0;
    const fetcher = vi.fn<typeof fetch>((value, init) => {
      expect(init?.redirect).toBe('error');
      expect(init?.method ?? 'GET').toBe('GET');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-native-reader');
      const url = typeof value === 'string' ? value : value instanceof URL ? value.href : value.url;
      if (failure === 'provider')
        return Promise.resolve(new Response('private-provider-body', { status: 403 }));
      if (url === `${api}/deployments`) {
        reads++;
        return Promise.resolve(
          Response.json({
            success: true,
            result: {
              deployments: [
                {
                  id: failure === 'changed' && reads > 1 ? crypto.randomUUID() : deploymentId,
                  versions: [{ version_id: versionId, percentage: failure === 'split' ? 50 : 100 }],
                },
              ],
            },
          }),
        );
      }
      expect(url).toBe(`${api}/versions/${versionId}`);
      return Promise.resolve(
        Response.json({
          success: true,
          result: {
            id: versionId,
            annotations: {
              'workers/tag': failure === 'tag' ? 'f'.repeat(40) : expectation.commitSha,
              'workers/message': `Staging candidate ${failure === 'candidate' ? 'f'.repeat(64) : expectation.candidateChecksum} from ${expectation.commitSha}`,
            },
          },
        }),
      );
    });
    const check = verifyStagingDeployment(
      expectation.commitSha,
      expectation.candidateChecksum,
      'fixture-native-reader',
      fetcher,
    );
    if (failure)
      await expect(check, failure).rejects.toThrow('PUBLICATION_VERIFICATION_UNCONFIRMED');
    else {
      expect(await check).toEqual({ deploymentId, workerVersionId: versionId });
      expect(fetcher).toHaveBeenCalledTimes(3);
    }
  }
});

it('preserves failed original execution only with an independently successful verification check', async () => {
  const verification = {
    runId: '45678',
    checkRunId: '56789',
    dispatchRevision: expectation.commitSha,
    workflowRevision: 'f'.repeat(40),
  };
  for (const failure of [
    '',
    'verification-failed',
    'verification-pending',
    'verification-head',
    'verification-app',
    'verification-run',
    'native-pending',
  ]) {
    const original = fixture(expectation, 'failed');
    const fetcher: typeof fetch = async (url, init) => {
      const path = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      if (path.endsWith(`/check-runs/${verification.checkRunId}`))
        return Response.json({
          id: Number(verification.checkRunId),
          status: failure === 'verification-pending' ? 'in_progress' : 'completed',
          conclusion: failure === 'verification-failed' ? 'failure' : 'success',
          head_sha:
            failure === 'verification-head'
              ? expectation.dispatchRevision
              : verification.dispatchRevision,
          details_url: `https://github.com/PointCommunity/pointsite-staging/actions/runs/${failure === 'verification-run' ? '45679' : verification.runId}/job/${verification.checkRunId}`,
          app: { id: failure === 'verification-app' ? 42 : 15368, slug: 'github-actions' },
        });
      if (path.includes('/statuses?'))
        return Response.json([
          {
            state: failure === 'native-pending' ? 'in_progress' : 'failure',
            environment: 'staging',
            log_url: `https://github.com/PointCommunity/pointsite-staging/actions/runs/${expectation.runId}/job/${expectation.checkRunId}`,
            environment_url: 'https://staging.pointatx.org/',
          },
        ]);
      return original(url, init);
    };
    const check = verifyDeploymentProof({ ...expectation, verification }, fetcher);
    if (failure)
      await expect(check, failure).rejects.toThrow('PUBLICATION_VERIFICATION_UNCONFIRMED');
    else
      expect(await check).toMatchObject({
        verification: {
          ...verification,
          originalConclusion: 'failure',
          originalDeploymentState: 'failure',
        },
        runId: expectation.runId,
        checkRunId: expectation.checkRunId,
        artifactDigest: expectation.artifactDigest,
      });
  }
});
