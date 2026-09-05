import { z } from 'zod';
import { githubHeaders } from './app-auth';

const Sha = z.string().regex(/^[a-f0-9]{40}$/);
const RefResponse = z.object({ object: z.object({ sha: Sha }) });
const BlobResponse = z.object({ sha: Sha });
const TreeResponse = z.object({ sha: Sha });
const CommitResponse = z.object({ sha: Sha, html_url: z.url() });
const allowedPaths = new Set(['content/builder-site.json', 'content/builder-site.manifest.json']);

export interface StagingCommit {
  sha: string;
  url: string;
}

export class GitHubStagingClient {
  constructor(
    private readonly repository: 'PointCommunity/pointsite-staging',
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async currentMainSha(): Promise<string> {
    const value = await this.call('GET', 'git/ref/heads/main');
    return RefResponse.parse(value).object.sha;
  }

  async commitFiles(input: {
    expectedBaseSha: string;
    message: string;
    files: Array<{ path: string; content: string }>;
  }): Promise<StagingCommit> {
    Sha.parse(input.expectedBaseSha);
    if (!input.files.length || input.files.some((file) => !allowedPaths.has(file.path))) {
      throw new Error('Candidate contains a path outside the staging allowlist');
    }
    const observed = await this.currentMainSha();
    if (observed !== input.expectedBaseSha) throw new Error('STAGING_BASE_DRIFT');
    const tree = [];
    for (const file of input.files) {
      const blob = BlobResponse.parse(
        await this.call('POST', 'git/blobs', { content: file.content, encoding: 'utf-8' }),
      );
      tree.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
    }
    const createdTree = TreeResponse.parse(
      await this.call('POST', 'git/trees', { base_tree: input.expectedBaseSha, tree }),
    );
    const commit = CommitResponse.parse(
      await this.call('POST', 'git/commits', {
        message: input.message,
        tree: createdTree.sha,
        parents: [input.expectedBaseSha],
      }),
    );
    await this.call('PATCH', 'git/refs/heads/main', { sha: commit.sha, force: false });
    return { sha: commit.sha, url: commit.html_url };
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await this.fetcher(`https://api.github.com/repos/${this.repository}/${path}`, {
      method,
      headers: {
        ...githubHeaders(this.token),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`GitHub staging operation failed (${response.status})`);
    return response.status === 204 ? null : response.json();
  }
}
