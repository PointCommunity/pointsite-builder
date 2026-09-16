import { z } from 'zod';
import { checksumDocument } from '../../site-kit/canonicalize';
import { githubHeaders } from '../github/app-auth';
import { publicationDestinations, type PublicationRepository } from './destinations';

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const PublicationBuildSchema = z.strictObject({
  candidateChecksum: digest,
  commitSha: sha,
  treeSha: sha,
  manifestBlobSha: sha,
  artifactDigest: digest,
  fileCount: z.number().int().min(1).max(2000),
  totalBytes: z.number().int().min(1).max(100_000_000),
});
export type PublicationBuild = z.infer<typeof PublicationBuildSchema>;

/** Bound provider bodies as well as parsed collections; never forward provider errors. */
export async function publicationJson(response: Response, maximum = 3_000_000): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error('PUBLICATION_GITHUB_UNCONFIRMED');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '';
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximum) throw new Error('PUBLICATION_GITHUB_UNCONFIRMED');
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

/** Verify the uploaded immutable Git objects before an atomic expected-base update. */
export async function commitPublicationBuild(input: {
  repository: PublicationRepository;
  jobId: string;
  baseSha: string;
  build: PublicationBuild;
  assetPaths: string[];
  token: string;
  guard: (signal: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  fetcher: typeof fetch;
}): Promise<void> {
  const deadline = Date.now() + 20_000;
  const budget = input.signal ?? AbortSignal.timeout(20_000);
  let retryAfter = 0;
  for (const [attempt, backoff] of [0, 1000, 3000].entries()) {
    const delay = Math.max(backoff, retryAfter);
    if (Date.now() + delay >= deadline) break;
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    let stage = 'authority';
    let retryable = false;
    let status: number | undefined;
    let requestId: string | undefined;
    let providerErrors: string[] | undefined;
    let rateLimited = false;
    try {
      budget.throwIfAborted();
      await input.guard(budget);
      const build = PublicationBuildSchema.parse(input.build);
      z.uuid().parse(input.jobId);
      sha.parse(input.baseSha);
      const api = `https://api.github.com/repos/PointCommunity/${input.repository}`;
      const request = async (url: string, init: RequestInit, candidateObject = false) => {
        if (Date.now() >= deadline) throw new Error('Budget exhausted');
        let response: Response;
        status = undefined;
        requestId = undefined;
        try {
          response = await input.fetcher(url, {
            ...init,
            signal: AbortSignal.any([
              budget,
              AbortSignal.timeout(Math.min(10_000, deadline - Date.now())),
            ]),
          });
        } catch {
          retryable = true;
          throw new Error('Transport unavailable');
        }
        status = response.status;
        rateLimited = response.headers.get('x-ratelimit-remaining') === '0';
        const identifier = response.headers.get('x-github-request-id') ?? '';
        if (/^[a-f0-9]{4}(?::[a-f0-9]{1,16}){4}$/i.test(identifier)) requestId = identifier;
        retryable = response.status >= 500 || (candidateObject && response.status === 404);
        const header = response.headers.get('retry-after');
        retryAfter =
          header === null
            ? 0
            : /^\d+$/.test(header)
              ? Number(header) * 1000
              : Math.max(0, Date.parse(header) - Date.now());
        if (!Number.isFinite(retryAfter) || rateLimited) retryable = false;
        return response;
      };
      const read = async (path: string, operation: string, candidateObject = false) => {
        stage = operation;
        return publicationJson(
          await request(
            `${api}${path}`,
            {
              headers: githubHeaders(input.token),
              redirect: 'error',
            },
            candidateObject,
          ),
        );
      };
      z.object({ object: z.object({ sha: z.literal(build.commitSha) }) }).parse(
        await read(`/git/ref/heads/builder-publications/${input.jobId}`, 'candidate-ref', true),
      );
      const commit = z
        .object({
          sha: z.literal(build.commitSha),
          tree: z.object({ sha: z.literal(build.treeSha) }),
          parents: z.array(z.object({ sha: z.literal(input.baseSha) })).length(1),
        })
        .parse(await read(`/git/commits/${build.commitSha}`, 'candidate-commit', true));
      const base = z
        .object({ sha: z.literal(input.baseSha), tree: z.object({ sha }) })
        .parse(await read(`/git/commits/${input.baseSha}`, 'base-commit'));
      const treeSchema = z.object({
        sha,
        truncated: z.literal(false),
        tree: z
          .array(
            z.object({
              path: z.string().min(1).max(1024),
              mode: z.string(),
              type: z.enum(['blob', 'tree', 'commit']),
              sha,
            }),
          )
          .max(10_000),
      });
      const before = treeSchema.parse(
        await read(`/git/trees/${base.tree.sha}?recursive=1`, 'base-tree'),
      );
      const after = treeSchema.parse(
        await read(`/git/trees/${commit.tree.sha}?recursive=1`, 'candidate-tree', true),
      );
      if (before.sha !== base.tree.sha || after.sha !== build.treeSha)
        throw new Error('Tree changed');
      const leaves = (tree: z.infer<typeof treeSchema>) =>
        new Map(
          tree.tree.filter((entry) => entry.type !== 'tree').map((entry) => [entry.path, entry]),
        );
      const original = leaves(before);
      const candidate = leaves(after);
      const required = [
        'content/builder-site.json',
        'content/builder-site.manifest.json',
        'content/builder-site.output.json',
        ...input.assetPaths.map((path) => `public${path}`),
      ];
      const allowed = new Set(required);
      for (const path of new Set([...original.keys(), ...candidate.keys()])) {
        const old = original.get(path);
        const next = candidate.get(path);
        if (old?.sha === next?.sha && old?.mode === next?.mode && old?.type === next?.type)
          continue;
        if (!allowed.has(path) || !next || next.type !== 'blob' || next.mode !== '100644')
          throw new Error('Unexpected Git change');
      }
      if (
        required.some(
          (path) => candidate.get(path)?.type !== 'blob' || candidate.get(path)?.mode !== '100644',
        ) ||
        candidate.get('content/builder-site.output.json')?.sha !== build.manifestBlobSha
      )
        throw new Error('Publication files missing');
      const blob = z
        .object({
          sha: z.literal(build.manifestBlobSha),
          encoding: z.literal('base64'),
          size: z.number().int().max(500_000),
          content: z.string().max(700_000),
        })
        .parse(await read(`/git/blobs/${build.manifestBlobSha}`, 'manifest', true));
      const bytes = Uint8Array.from(atob(blob.content.replaceAll('\n', '')), (char) =>
        char.charCodeAt(0),
      );
      const prefix = new TextEncoder().encode(`blob ${bytes.length}\0`);
      const object = new Uint8Array(prefix.length + bytes.length);
      object.set(prefix);
      object.set(bytes, prefix.length);
      const actualSha = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-1', object)),
        (byte) => byte.toString(16).padStart(2, '0'),
      ).join('');
      if (bytes.length !== blob.size || actualSha !== build.manifestBlobSha)
        throw new Error('Blob changed');
      const manifest = z
        .strictObject({
          artifactDigest: z.literal(build.artifactDigest),
          totalBytes: z.literal(build.totalBytes),
          files: z
            .array(
              z.strictObject({
                path: z
                  .string()
                  .min(1)
                  .max(1024)
                  .refine(
                    (path) =>
                      !path.includes('\\') &&
                      path
                        .split('/')
                        .every((part) => part !== '' && part !== '.' && part !== '..') &&
                      [...path].every(
                        (character) =>
                          character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
                      ) &&
                      path !== '__pointsite_release.json',
                  ),
                sha256: digest,
                bytes: z.number().int().min(0).max(100_000_000),
              }),
            )
            .length(build.fileCount),
        })
        .parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
      if (
        (await checksumDocument(manifest.files)) !== build.artifactDigest ||
        manifest.files.reduce((sum, file) => sum + file.bytes, 0) !== build.totalBytes ||
        !manifest.files.some((file) => file.path === 'index.html') ||
        manifest.files.some(
          (file, index) => index > 0 && manifest.files[index - 1].path >= file.path,
        )
      )
        throw new Error('Output manifest changed');
      const repository = z
        .object({
          node_id: z.string().min(1),
          full_name: z.literal(`PointCommunity/${input.repository}`),
          id: z.literal(
            Number(
              Object.values(publicationDestinations).find(
                (destination) => destination.repository === input.repository,
              )?.id,
            ),
          ),
        })
        .parse(await read('', 'repository'));
      const current = z
        .object({ object: z.object({ sha }) })
        .parse(await read('/git/ref/heads/main', 'main'));
      stage = 'authority';
      await input.guard(budget);
      budget.throwIfAborted();
      stage = 'expected-base';
      if (current.object.sha === build.commitSha) return; // Reconcile an acknowledged or lost-response update.
      if (current.object.sha !== input.baseSha) throw new Error('Base changed');
      // Native CAS closes the race between reading main and writing it, including resets.
      // https://docs.github.com/en/graphql/reference/git#updaterefs
      stage = 'update-main';
      const response = await request('https://api.github.com/graphql', {
        method: 'POST',
        headers: { ...githubHeaders(input.token), 'content-type': 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({
          query: 'mutation($input:UpdateRefsInput!){updateRefs(input:$input){clientMutationId}}',
          variables: {
            input: {
              repositoryId: repository.node_id,
              clientMutationId: input.jobId,
              refUpdates: [
                {
                  name: 'refs/heads/main',
                  beforeOid: input.baseSha,
                  afterOid: build.commitSha,
                  force: false,
                },
              ],
            },
          },
        }),
      });
      // GraphQL can report failure with HTTP 200 or lose an acknowledgement after committing.
      // Re-enter the guarded expected-base path; never replace CAS with an unconditional update.
      if (response.ok && Number.isFinite(retryAfter) && !rateLimited) retryable = true;
      const result = await publicationJson(response, 16_384);
      const rejected = z
        .object({
          errors: z
            .array(
              z.object({
                type: z.string().optional(),
                message: z.string().optional(),
                extensions: z.object({ code: z.string().optional() }).optional(),
              }),
            )
            .min(1)
            .max(10),
        })
        .safeParse(result);
      if (rejected.success) {
        const terminal = [
          'FORBIDDEN',
          'UNAUTHORIZED',
          'NOT_FOUND',
          'UNPROCESSABLE',
          'RATE_LIMITED',
          'GRAPHQL_VALIDATION_FAILED',
          'GRAPHQL_PARSE_FAILED',
          'INVALID',
          'MAX_NODE_LIMIT_EXCEEDED',
        ];
        const known = [
          ...terminal,
          'INTERNAL',
          'INTERNAL_SERVER_ERROR',
          'SERVICE_UNAVAILABLE',
          'TIMEOUT',
        ];
        providerErrors = rejected.data.errors.map((error) => {
          if (rateLimited || /rate limit|abuse detection/i.test(error.message ?? ''))
            return 'RATE_LIMITED';
          const code = error.type ?? error.extensions?.code ?? '';
          return known.includes(code) ? code : 'UNCLASSIFIED';
        });
        retryable =
          response.ok &&
          Number.isFinite(retryAfter) &&
          !rateLimited &&
          !providerErrors.some((code) => terminal.includes(code));
        throw new Error('GraphQL mutation unconfirmed');
      }
      z.object({
        errors: z.array(z.never()).optional(),
        data: z.object({ updateRefs: z.object({ clientMutationId: z.literal(input.jobId) }) }),
      }).parse(result);
      const confirmed = await read('/git/ref/heads/main', 'confirm-main');
      // A stale acknowledgement is also ambiguous; the next attempt rechecks the exact main ref.
      retryable = Number.isFinite(retryAfter) && !rateLimited;
      z.object({ object: z.object({ sha: z.literal(build.commitSha) }) }).parse(confirmed);
      return;
    } catch {
      console.warn(
        JSON.stringify({
          event: 'publication_commit_rejected',
          jobId: z.uuid().safeParse(input.jobId).success ? input.jobId : undefined,
          stage,
          status,
          requestId,
          providerErrors,
          attempt: attempt + 1,
          retryable,
        }),
      );
      if (!retryable || attempt === 2) break;
    }
  }
  throw new Error('PUBLICATION_COMMIT_UNCONFIRMED');
}
