import { z } from 'zod';
import { githubHeaders, unboundFetch } from './app-auth';
import type { CandidateFile } from '../publish/candidate';

const Sha = z.string().regex(/^[a-f0-9]{40}$/);
const RefResponse = z.object({ object: z.object({ sha: Sha }) });
const BlobResponse = z.object({ sha: Sha });
const TreeResponse = z.object({ sha: Sha });
const CommitResponse = z.object({ sha: Sha, html_url: z.url() });
const ContentResponse = z.object({ sha: Sha });
const CheckRunsResponse = z.object({
  check_runs: z
    .array(
      z.object({
        id: z.number().int().positive(),
        name: z.string(),
        status: z.enum(['queued', 'in_progress', 'completed', 'pending', 'requested', 'waiting']),
        conclusion: z.string().nullable(),
        html_url: z.url(),
      }),
    )
    .max(100),
});
const allowedPaths = new Set(['content/builder-site.json', 'content/builder-site.manifest.json']);
const allowedMediaPath = /^public\/assets\/builder\/[0-9a-f-]{36}\.(?:avif|jpe?g|png|webp)$/;

export interface StagingCommit {
  sha: string;
  url: string;
}

export interface StagingVerificationEvidence {
  commitSha: string;
  workflowRunId: string;
  workflowUrl: string;
  deploymentId: string;
  deploymentUrl: string;
  checks: {
    build: true;
    schema: true;
    renderer: true;
    routes: true;
    assets: true;
    accessibility: true;
    responsive: true;
    security: true;
    primaryFlow: true;
    live: true;
  };
}

export class GitHubProductionReader {
  private readonly fetcher: typeof fetch;

  constructor(fetcher: typeof fetch = fetch) {
    this.fetcher = unboundFetch(fetcher);
  }

  async currentMainSha(): Promise<string> {
    const response = await this.fetcher(
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
    if (!response.ok) throw new Error(`GitHub production read failed (${response.status})`);
    return RefResponse.parse(await response.json()).object.sha;
  }
}

export class GitHubStagingClient {
  private readonly fetcher: typeof fetch;

  constructor(
    private readonly repository: 'PointCommunity/pointsite-staging',
    private readonly token: string,
    fetcher: typeof fetch = fetch,
  ) {
    this.fetcher = unboundFetch(fetcher);
  }

  async currentMainSha(): Promise<string> {
    const value = await this.call('GET', 'git/ref/heads/main');
    return RefResponse.parse(value).object.sha;
  }

  async assertRendererCompatible(
    expectedBaseSha: string,
    contract: Record<string, string>,
  ): Promise<void> {
    Sha.parse(expectedBaseSha);
    const entries = Object.entries(contract);
    for (const [filename, expectedBlob] of entries) {
      if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(filename))
        throw new Error('STAGING_RENDERER_CONTRACT_INVALID');
      Sha.parse(expectedBlob);
    }
    const observedBlobs = await Promise.all(
      entries.map(
        async ([filename]) =>
          ContentResponse.parse(
            await this.call(
              'GET',
              `contents/site-kit/${encodeURIComponent(filename)}?ref=${expectedBaseSha}`,
            ),
          ).sha,
      ),
    );
    const mismatch = entries.findIndex(
      ([, expectedBlob], index) => observedBlobs[index] !== expectedBlob,
    );
    if (mismatch >= 0) {
      throw new Error(`STAGING_RENDERER_MISMATCH: ${entries[mismatch][0]}`);
    }
  }

  async commitFiles(input: {
    expectedBaseSha: string;
    message: string;
    files: CandidateFile[];
  }): Promise<StagingCommit> {
    Sha.parse(input.expectedBaseSha);
    if (
      !input.files.length ||
      input.files.some((file) => !allowedPaths.has(file.path) && !allowedMediaPath.test(file.path))
    ) {
      throw new Error('Candidate contains a path outside the staging allowlist');
    }
    const observed = await this.currentMainSha();
    if (observed !== input.expectedBaseSha) throw new Error('STAGING_BASE_DRIFT');
    const tree = [];
    for (const file of input.files) {
      const blob = BlobResponse.parse(
        await this.call('POST', 'git/blobs', {
          content: file.content,
          encoding: file.encoding ?? 'utf-8',
        }),
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

  async verificationForCommit(commitSha: string): Promise<
    | { status: 'pending' }
    | {
        status: 'failed';
        failedChecks: string[];
        failedCheckUrls: Record<string, string>;
      }
    | { status: 'passed'; evidence: StagingVerificationEvidence }
  > {
    Sha.parse(commitSha);
    const response = CheckRunsResponse.parse(
      await this.call('GET', `commits/${commitSha}/check-runs?per_page=100`),
    );
    const latest = (name: 'verify' | 'deploy') =>
      response.check_runs
        .filter((check) => check.name === name)
        .sort((left, right) => right.id - left.id)[0];
    const quality = latest('verify');
    const deploy = latest('deploy');
    if (!quality || !deploy || quality.status !== 'completed' || deploy.status !== 'completed')
      return { status: 'pending' };
    const failedChecks = [quality, deploy]
      .filter((check) => check.conclusion !== 'success')
      .map((check) => check.name);
    if (failedChecks.length)
      return {
        status: 'failed',
        failedChecks,
        failedCheckUrls: Object.fromEntries(
          [quality, deploy]
            .filter((check) => check.conclusion !== 'success')
            .map((check) => [check.name, check.html_url]),
        ),
      };
    return {
      status: 'passed',
      evidence: {
        commitSha,
        workflowRunId: String(quality.id),
        workflowUrl: quality.html_url,
        deploymentId: String(deploy.id),
        deploymentUrl: deploy.html_url,
        checks: {
          build: true,
          schema: true,
          renderer: true,
          routes: true,
          assets: true,
          accessibility: true,
          responsive: true,
          security: true,
          primaryFlow: true,
          live: true,
        },
      },
    };
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
