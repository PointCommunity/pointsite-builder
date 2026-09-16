import { createHash } from 'node:crypto';
import { checksumDocument } from '../../src/site-kit/canonicalize';

/** Public synthetic output; all provider changes are local to this fixture. */
export async function publicationGitHubFixture(
  jobId: string,
  candidateChecksum: string,
  assetPaths: string[] = [],
  target: 'staging' | 'canary' | 'production' | 'publicCanary' = 'staging',
  baseSha = 'b'.repeat(40),
) {
  const files = [{ path: 'index.html', sha256: 'f'.repeat(64), bytes: 123 }];
  const manifest = { files, totalBytes: 123, artifactDigest: await checksumDocument(files) };
  const content = JSON.stringify(manifest);
  const manifestBlobSha = createHash('sha1')
    .update(`blob ${Buffer.byteLength(content)}\0${content}`)
    .digest('hex');
  const build = {
    candidateChecksum,
    commitSha: 'c'.repeat(40),
    treeSha: 'd'.repeat(40),
    manifestBlobSha,
    artifactDigest: manifest.artifactDigest,
    fileCount: 1,
    totalBytes: 123,
  };
  const baseTree = 'e'.repeat(40);
  const name =
    target === 'canary'
      ? 'pointsite-staging-canary'
      : target === 'staging'
        ? 'pointsite-staging'
        : target === 'publicCanary'
          ? 'pointsite-canary'
          : 'pointsite';
  const api = `https://api.github.com/repos/PointCommunity/${name}`;
  const untouched = { path: 'README.md', type: 'blob', mode: '100644', sha: '1'.repeat(40) };
  const state = {
    main: baseSha,
    failure: '',
    permission: 'write',
    userId: 12345,
    mutations: 0,
    beforeMutation: async () => {},
    beforePermission: async () => {},
  };
  const requests: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const path = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    requests.push(path);
    if (path.endsWith('/access_tokens'))
      return Response.json({ token: 'fixture-installation-token', expires_at: 'fixture' });
    if (path.endsWith('/permission')) {
      await state.beforePermission();
      return Response.json({ permission: state.permission, user: { id: state.userId } });
    }
    if (path === `${api}/git/ref/heads/builder-publications/${jobId}`)
      return Response.json({
        object: { sha: state.failure === 'branch' ? baseSha : build.commitSha },
      });
    if (path === `${api}/git/commits/${build.commitSha}`)
      return Response.json({
        sha: build.commitSha,
        tree: { sha: build.treeSha },
        parents: [
          { sha: state.failure === 'parent' ? '0'.repeat(40) : baseSha },
          ...(state.failure === 'merge' ? [{ sha: baseSha }] : []),
        ],
      });
    if (path === `${api}/git/commits/${baseSha}`)
      return Response.json({ sha: baseSha, tree: { sha: baseTree } });
    if (path === `${api}/git/trees/${baseTree}?recursive=1`)
      return Response.json({ sha: baseTree, truncated: false, tree: [untouched] });
    if (path === `${api}/git/trees/${build.treeSha}?recursive=1`) {
      const paths = [
        'content/builder-site.json',
        'content/builder-site.manifest.json',
        'content/builder-site.output.json',
        ...assetPaths.map((path) => `public${path}`),
      ];
      return Response.json({
        sha: build.treeSha,
        truncated: state.failure === 'truncated',
        tree: [
          ...(state.failure === 'deleted'
            ? []
            : [
                { ...untouched, ...(state.failure === 'unrelated' ? { sha: '2'.repeat(40) } : {}) },
              ]),
          ...paths
            .filter((path) => state.failure !== 'missing' || path !== 'content/builder-site.json')
            .map((path) => ({
              path,
              type: 'blob',
              mode: state.failure === 'symlink' ? '120000' : '100644',
              sha: path === 'content/builder-site.output.json' ? manifestBlobSha : '3'.repeat(40),
            })),
          ...(state.failure === 'extra'
            ? [
                {
                  path: '.github/workflows/attack.yml',
                  type: 'blob',
                  mode: '100644',
                  sha: '4'.repeat(40),
                },
              ]
            : []),
        ],
      });
    }
    if (path === `${api}/git/blobs/${manifestBlobSha}`)
      return Response.json({
        sha: manifestBlobSha,
        encoding: 'base64',
        size: Buffer.byteLength(content),
        content: Buffer.from(
          state.failure === 'blob' ? content.replace('index.html', 'wrong.html') : content,
        ).toString('base64'),
      });
    if (path === api)
      return Response.json({
        node_id: 'fixture-repository-node',
        id:
          state.failure === 'repository'
            ? 1
            : target === 'canary'
              ? 1370792530
              : target === 'staging'
                ? 1357847426
                : target === 'publicCanary'
                  ? 1373215793
                  : 1348084954,
        full_name: `PointCommunity/${name}`,
      });
    if (path === `${api}/git/ref/heads/main`) return Response.json({ object: { sha: state.main } });
    if (path === 'https://api.github.com/graphql') {
      await state.beforeMutation();
      if (typeof init?.body !== 'string') throw new Error('Expected JSON body');
      const request = JSON.parse(init.body) as {
        variables: {
          input: {
            repositoryId: string;
            clientMutationId: string;
            refUpdates: { name: string; beforeOid: string; afterOid: string; force: boolean }[];
          };
        };
      };
      const input = request.variables.input;
      const [update] = input.refUpdates;
      if (
        input.repositoryId !== 'fixture-repository-node' ||
        input.clientMutationId !== jobId ||
        input.refUpdates.length !== 1 ||
        update.name !== 'refs/heads/main' ||
        update.beforeOid !== state.main ||
        update.afterOid !== build.commitSha ||
        update.force !== false ||
        state.failure === 'provider'
      )
        return Response.json({
          errors: [{ type: 'UNPROCESSABLE', message: 'private provider error' }],
        });
      state.mutations++;
      state.main = build.commitSha;
      if (state.failure === 'lost-response') throw new Error('private connection error');
      return Response.json({ data: { updateRefs: { clientMutationId: jobId } } });
    }
    throw new Error('Unexpected publication endpoint');
  };
  return { build, baseSha, manifest, state, requests, fetcher };
}
