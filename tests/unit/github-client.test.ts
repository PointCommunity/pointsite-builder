// @vitest-environment node
import { GitHubProductionReader, GitHubStagingClient } from '../../src/server/github/client';

const base = 'a'.repeat(40);
const blobA = 'b'.repeat(40);
const blobB = 'c'.repeat(40);
const tree = 'd'.repeat(40);
const commit = 'e'.repeat(40);

function response(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(body === null ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

describe('GitHub staging client', () => {
  it('creates two blobs and advances main once for the expected base', async () => {
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => response({ object: { sha: base } }))
      .mockImplementationOnce(() => response({ sha: blobA }))
      .mockImplementationOnce(() => response({ sha: blobB }))
      .mockImplementationOnce(() => response({ sha: tree }))
      .mockImplementationOnce(() =>
        response({
          sha: commit,
          html_url: 'https://github.com/PointCommunity/pointsite-staging/commit/x',
        }),
      )
      .mockImplementationOnce(() => response(null, 204));
    const client = new GitHubStagingClient('PointCommunity/pointsite-staging', 'token', fetcher);
    await expect(
      client.commitFiles({
        expectedBaseSha: base,
        message: 'Publish',
        files: [
          { path: 'content/builder-site.json', content: '{}' },
          { path: 'content/builder-site.manifest.json', content: '{}' },
        ],
      }),
    ).resolves.toMatchObject({ sha: commit });
    expect(fetcher).toHaveBeenCalledTimes(6);
    expect(fetcher.mock.calls.at(-1)?.[1]).toMatchObject({ method: 'PATCH' });
  });

  it('refuses drift and paths outside the staging allowlist', async () => {
    const drift = vi.fn(() => response({ object: { sha: 'f'.repeat(40) } }));
    const client = new GitHubStagingClient('PointCommunity/pointsite-staging', 'token', drift);
    await expect(
      client.commitFiles({
        expectedBaseSha: base,
        message: 'Publish',
        files: [{ path: 'content/builder-site.json', content: '{}' }],
      }),
    ).rejects.toThrow('STAGING_BASE_DRIFT');
    await expect(
      client.commitFiles({
        expectedBaseSha: base,
        message: 'Publish',
        files: [{ path: '../production', content: '{}' }],
      }),
    ).rejects.toThrow('allowlist');
  });

  it('accepts only successful quality and deploy checks for the exact commit', async () => {
    const fetcher = vi.fn(() =>
      response({
        check_runs: [
          {
            id: 11,
            name: 'verify',
            status: 'completed',
            conclusion: 'success',
            html_url: 'https://github.com/PointCommunity/pointsite-staging/actions/runs/11',
          },
          {
            id: 12,
            name: 'deploy',
            status: 'completed',
            conclusion: 'success',
            html_url: 'https://github.com/PointCommunity/pointsite-staging/actions/runs/12',
          },
        ],
      }),
    );
    const client = new GitHubStagingClient('PointCommunity/pointsite-staging', 'token', fetcher);
    await expect(client.verificationForCommit(commit)).resolves.toMatchObject({
      status: 'passed',
      evidence: {
        commitSha: commit,
        workflowRunId: '11',
        deploymentId: '12',
        checks: { build: true, accessibility: true, live: true },
      },
    });
    expect(fetcher).toHaveBeenCalledWith(
      `https://api.github.com/repos/PointCommunity/pointsite-staging/commits/${commit}/check-runs?per_page=100`,
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('reports pending or failed verification without manufacturing passing evidence', async () => {
    const pending = vi.fn(() =>
      response({
        check_runs: [
          {
            id: 11,
            name: 'verify',
            status: 'in_progress',
            conclusion: null,
            html_url: 'https://github.com/PointCommunity/pointsite-staging/actions/runs/11',
          },
        ],
      }),
    );
    const failed = vi.fn(() =>
      response({
        check_runs: [
          {
            id: 11,
            name: 'verify',
            status: 'completed',
            conclusion: 'failure',
            html_url: 'https://github.com/PointCommunity/pointsite-staging/actions/runs/11',
          },
          {
            id: 12,
            name: 'deploy',
            status: 'completed',
            conclusion: 'success',
            html_url: 'https://github.com/PointCommunity/pointsite-staging/actions/runs/12',
          },
        ],
      }),
    );
    await expect(
      new GitHubStagingClient(
        'PointCommunity/pointsite-staging',
        'token',
        pending,
      ).verificationForCommit(commit),
    ).resolves.toEqual({ status: 'pending' });
    await expect(
      new GitHubStagingClient(
        'PointCommunity/pointsite-staging',
        'token',
        failed,
      ).verificationForCommit(commit),
    ).resolves.toMatchObject({ status: 'failed', failedChecks: ['verify'] });
  });
});

it('reads the production base without sending write credentials or mutating production', async () => {
  const fetcher = vi.fn(() => response({ object: { sha: base } }));
  await expect(new GitHubProductionReader(fetcher).currentMainSha()).resolves.toBe(base);
  expect(fetcher).toHaveBeenCalledWith(
    'https://api.github.com/repos/PointCommunity/pointsite/git/ref/heads/main',
    {
      method: 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'pointsite-builder',
      },
    },
  );
});
