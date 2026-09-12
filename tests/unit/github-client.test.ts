// @vitest-environment node
import { GitHubProductionReader, GitHubStagingClient } from '../../src/server/github/client';
import { STAGING_RENDERER_CONTRACT } from '../../src/server/publish/renderer-contract';

const base = 'a'.repeat(40);
const blobA = 'b'.repeat(40);
const blobB = 'c'.repeat(40);
const tree = 'd'.repeat(40);
const commit = 'e'.repeat(40);

const uploadStep = () => ({
  requestedAt: '2026-09-12T12:00:00Z',
  progress: { blobShas: [] },
  checkpoint: () => Promise.resolve(),
  guard: () => Promise.resolve(),
});
function response(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(body === null ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

describe('GitHub staging client', () => {
  it('checks every canonical renderer file at the immutable expected base', async () => {
    const fetcher = vi.fn(() => response({ sha: blobA }));
    const client = new GitHubStagingClient('PointCommunity/pointsite-staging', 'token', fetcher);
    await expect(
      client.assertRendererCompatible(
        base,
        Object.fromEntries(Object.keys(STAGING_RENDERER_CONTRACT).map((path) => [path, blobA])),
      ),
    ).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(Object.keys(STAGING_RENDERER_CONTRACT).length);
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining(`contents/site-kit/SiteRenderer.tsx?ref=${base}`),
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('fails a renderer mismatch before any candidate write request', async () => {
    const fetcher = vi.fn(() => response({ sha: blobB }));
    const client = new GitHubStagingClient('PointCommunity/pointsite-staging', 'token', fetcher);
    await expect(
      client.assertRendererCompatible(base, { 'SiteRenderer.tsx': blobA }),
    ).rejects.toThrow('STAGING_RENDERER_MISMATCH: SiteRenderer.tsx');
    expect(fetcher).toHaveBeenCalledOnce();
    expect((fetcher.mock.calls as unknown[][])[0]?.[1]).toMatchObject({ method: 'GET' });
  });

  it('creates two blobs and advances main once for the expected base', async () => {
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => response({ object: { sha: base } }))
      .mockImplementationOnce(() => response({ sha: blobA }))
      .mockImplementationOnce(() => response({ sha: blobB }))
      .mockImplementationOnce(() => response({ tree: { sha: tree } }))
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
      client.advanceCommit({
        ...uploadStep(),
        expectedBaseSha: base,
        message: 'Publish',
        files: [
          { path: 'content/builder-site.json', content: '{}' },
          { path: 'content/builder-site.manifest.json', content: '{}' },
        ],
      }),
    ).resolves.toMatchObject({ status: 'succeeded', commit: { sha: commit } });
    expect(fetcher).toHaveBeenCalledTimes(7);
    expect(fetcher.mock.calls.at(-1)?.[1]).toMatchObject({ method: 'PATCH' });
  });

  it('refuses drift and paths outside the staging allowlist', async () => {
    const drift = vi.fn(() => response({ object: { sha: 'f'.repeat(40) } }));
    const client = new GitHubStagingClient('PointCommunity/pointsite-staging', 'token', drift);
    await expect(
      client.advanceCommit({
        ...uploadStep(),
        expectedBaseSha: base,
        message: 'Publish',
        files: [{ path: 'content/builder-site.json', content: '{}' }],
      }),
    ).rejects.toThrow('STAGING_BASE_DRIFT');
    await expect(
      client.advanceCommit({
        ...uploadStep(),
        expectedBaseSha: base,
        message: 'Publish',
        files: [{ path: '../production', content: '{}' }],
      }),
    ).rejects.toThrow('INVALID_UPLOAD_PROGRESS');
  });

  it.each([
    'public/assets/point-logo.png',
    'public/assets/builder/10000000-0000-4000-8000-000000000001/20000000-0000-4000-8000-000000000001/photo.png',
  ])('accepts the self-contained candidate image %s', async (path) => {
    const fetcher = vi.fn(() => response({ object: { sha: 'f'.repeat(40) } }));
    const client = new GitHubStagingClient('PointCommunity/pointsite-staging', 'token', fetcher);
    await expect(
      client.advanceCommit({
        ...uploadStep(),
        expectedBaseSha: base,
        message: 'Publish',
        files: [{ path, content: 'AQID', encoding: 'base64' }],
      }),
    ).rejects.toThrow('STAGING_BASE_DRIFT');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('rejects duplicate destination paths before any GitHub calls', async () => {
    const fetcher = vi.fn();
    const client = new GitHubStagingClient('PointCommunity/pointsite-staging', 'token', fetcher);
    await expect(
      client.advanceCommit({
        ...uploadStep(),
        expectedBaseSha: base,
        message: 'Publish',
        files: [
          { path: 'public/assets/photo.png', content: 'AQID' },
          { path: 'public/assets/photo.png', content: 'BAUG' },
        ],
      }),
    ).rejects.toThrow('INVALID_UPLOAD_PROGRESS');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    'public/assets/../secret.png',
    'public/assets//secret.png',
    'public/assets/fixture.svg',
    'public/assets/fixture.html',
    'public/assets/a.png/../../worker.ts',
  ])('rejects unsafe image write %s without GitHub calls', async (path) => {
    const fetcher = vi.fn();
    const client = new GitHubStagingClient('PointCommunity/pointsite-staging', 'token', fetcher);
    await expect(
      client.advanceCommit({
        ...uploadStep(),
        expectedBaseSha: base,
        message: 'Publish',
        files: [{ path, content: 'AQID', encoding: 'base64' }],
      }),
    ).rejects.toThrow('INVALID_UPLOAD_PROGRESS');
    expect(fetcher).not.toHaveBeenCalled();
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
    ).resolves.toMatchObject({
      status: 'failed',
      failedChecks: ['verify'],
      failedCheckUrls: {
        verify: 'https://github.com/PointCommunity/pointsite-staging/actions/runs/11',
      },
    });
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
