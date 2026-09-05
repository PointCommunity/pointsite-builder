// @vitest-environment node
import { GitHubStagingClient } from '../../src/server/github/client';

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
});
