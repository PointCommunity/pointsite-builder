import { createHash } from 'node:crypto';
import { z } from 'zod';
import { defaultSiteDocument } from '../src/site-kit/default-site';
import { SiteDocumentSchema } from '../src/site-kit/schema';
import { checksumDocument } from '../src/site-kit/canonicalize';
import { publicationMediaPaths } from '../src/site-kit/publication-media';
import { PublicationAssetSchema } from '../src/server/publish/inputs';
import { publicationJson } from '../src/server/publish/build-proof';
import type { ProductionDraftSource } from '../src/server/repositories/contracts';
import { ApiError } from '../src/server/http/errors';
import { publicationDestination } from '../src/server/publish/destinations';

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const baseline = {
  sourceCommit: '0187c95c8a9d3441049616a801f66f6f6d11050e',
  archiveRevision: 'e860b80970067a9263a28fdd12bdcbdd57b110a5',
  manifestBlob: '6a95478ed6aee9ab500b40f8d7689b6343776630',
  artifactDigest: '45562c9e111136f631c901892d2f1058e45050e93fa8d507f5beb0858eb68894',
  documentChecksum: '7804918a4b4b4b96c4f4940aca8736019a18f9dc102d2ad842598c5301a4b40f',
};
const outputSchema = z.object({
  artifactDigest: digest,
  totalBytes: z.number().int().min(1).max(100_000_000),
  files: z
    .array(
      z.strictObject({
        path: z
          .string()
          .regex(/^[A-Za-z0-9_$./-]+$/)
          .refine(
            (path) =>
              path.split('/').every((part) => part && part !== '.' && part !== '..') &&
              path !== '__pointsite_release.json',
          ),
        sha256: digest,
        bytes: z.number().int().min(0).max(100_000_000),
      }),
    )
    .min(1)
    .max(2000),
});
const releaseSchema = z.strictObject({
  format: z.literal(2),
  candidateChecksum: digest,
  artifactDigest: digest,
  workflowRevision: sha,
  sourceCommit: sha,
});

async function bytes(response: Response, maximum: number): Promise<Uint8Array> {
  if (!response.ok || !response.body) throw new Error('SOURCE_UNAVAILABLE');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > maximum) throw new Error('SOURCE_TOO_LARGE');
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');

/** Public immutable inputs only; no source-supplied code, URL, or credentials execute here. */
export async function captureProductionSource(
  fetcher: typeof fetch = fetch,
): Promise<ProductionDraftSource> {
  return capturePublicationSource('production', undefined, fetcher);
}

export async function capturePublicationSource(
  target: 'staging' | 'production',
  builderOrigin?: string,
  fetcher: typeof fetch = fetch,
): Promise<ProductionDraftSource> {
  const destination = publicationDestination(target, builderOrigin);
  const { origin, environment, repository } = destination;
  const api = `https://api.github.com/repos/PointCommunity/${repository}`;
  const raw = `https://raw.githubusercontent.com/PointCommunity/${repository}`;
  try {
    const read = (url: string) =>
      fetcher(url, {
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: {
          'user-agent': 'PointSite-Builder',
          'cache-control': 'no-cache',
          accept: 'application/vnd.github+json',
        },
      });
    const json = async (url: string, maximum = 500_000) =>
      publicationJson(await read(url), maximum);
    const current = async (verifyAction = true) => {
      const [deployment] = z
        .array(
          z.object({
            id: z.number().int().positive(),
            sha,
            environment: z.literal(environment),
            performed_via_github_app: z
              .object({ id: z.literal(15368), slug: z.literal('github-actions') })
              .nullable(),
          }),
        )
        .length(1)
        .parse(
          await json(
            `${api}/deployments?environment=${encodeURIComponent(environment)}&per_page=1`,
          ),
        );
      const [status] = z
        .array(
          z.object({
            state: z.literal('success'),
            environment: z.literal(environment),
            environment_url: z.string().refine((value) => {
              try {
                const url = new URL(value);
                return (
                  ['https:', 'http:'].includes(url.protocol) &&
                  url.hostname === new URL(origin).hostname &&
                  !url.port &&
                  !url.username &&
                  !url.password &&
                  (url.pathname === '/' || url.pathname === '') &&
                  !url.search &&
                  !url.hash
                );
              } catch {
                return false;
              }
            }),
            log_url: z
              .string()
              .refine((value) =>
                new RegExp(
                  `^https://github\\.com/PointCommunity/${repository}/actions/runs/[0-9]+/job/[0-9]+$`,
                ).test(value),
              ),
          }),
        )
        .length(1)
        .parse(await json(`${api}/deployments/${deployment.id}/statuses?per_page=1`));
      if (!deployment.performed_via_github_app && verifyAction) {
        const [, runId, jobId] = status.log_url.match(/\/actions\/runs\/([0-9]+)\/job\/([0-9]+)$/)!;
        const run = z
          .object({
            id: z.number().int().positive(),
            status: z.literal('completed'),
            conclusion: z.literal('success'),
            head_sha: sha,
            path: z.enum([
              '.github/workflows/publish-candidate.yml',
              '.github/workflows/rollback-production.yml',
            ]),
          })
          .parse(await json(`${api}/actions/runs/${runId}`));
        const job = z
          .object({
            id: z.number().int().positive(),
            run_id: z.number().int().positive(),
            status: z.literal('completed'),
            conclusion: z.literal('success'),
            head_sha: sha,
          })
          .parse(await json(`${api}/actions/jobs/${jobId}`));
        if (
          run.id !== Number(runId) ||
          job.id !== Number(jobId) ||
          job.run_id !== run.id ||
          run.head_sha !== deployment.sha ||
          job.head_sha !== deployment.sha
        )
          throw new Error('SOURCE_DEPLOYMENT_ACTION_CHANGED');
      }
      return { ...deployment, ...status };
    };
    const before = await current();
    const releaseResponse = await read(`${origin}/__pointsite_release.json`);
    const release =
      releaseResponse.status === 404
        ? undefined
        : releaseSchema.parse(await publicationJson(releaseResponse, 2048));
    if (!release) await releaseResponse.body?.cancel();
    const sourceCommit = release?.sourceCommit ?? before.sha;
    let document: ProductionDraftSource['document'];
    let output: z.infer<typeof outputSchema>;
    if (target === 'production' && sourceCommit === baseline.sourceCommit) {
      if (release && release.artifactDigest !== baseline.artifactDigest)
        throw new Error('BASELINE_CHANGED');
      const content = await bytes(
        await read(`${raw}/${baseline.archiveRevision}/publication-baseline/manifest.json`),
        500_000,
      );
      if (
        createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex') !==
        baseline.manifestBlob
      )
        throw new Error('BASELINE_CHANGED');
      output = outputSchema.parse(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content)),
      );
      document = SiteDocumentSchema.parse(defaultSiteDocument);
      if (
        output.artifactDigest !== baseline.artifactDigest ||
        (await checksumDocument(document)) !== baseline.documentChecksum
      )
        throw new Error('BASELINE_CONVERSION_CHANGED');
    } else {
      if (!release) throw new Error('SOURCE_FORMAT_UNSUPPORTED');
      document = SiteDocumentSchema.parse(
        await json(`${raw}/${sourceCommit}/content/builder-site.json`, 3_000_000),
      );
      output = outputSchema.parse(
        await json(`${raw}/${sourceCommit}/content/builder-site.output.json`),
      );
      const manifest = z
        .object({
          source: z.literal('PointCommunity/pointsite-builder'),
          candidateChecksum: digest,
          revisionChecksum: digest,
          assets: z.array(PublicationAssetSchema).max(500),
        })
        .passthrough()
        .parse(await json(`${raw}/${sourceCommit}/content/builder-site.manifest.json`));
      const candidate = Object.fromEntries(
        Object.entries(manifest).filter(([key]) => !['source', 'candidateChecksum'].includes(key)),
      );
      if (
        (await checksumDocument(document)) !== manifest.revisionChecksum ||
        (await checksumDocument(candidate)) !== manifest.candidateChecksum ||
        output.artifactDigest !== release.artifactDigest
      )
        throw new Error('SOURCE_MANIFEST_CHANGED');
      const publishedPaths = new Set(publicationMediaPaths(document));
      document.media = document.media.filter((item) => publishedPaths.has(item.sourcePath));
      // Unplaced people remain editable; unpublished Library images are not public source material.
      for (const person of document.collections.people) {
        if (person.mediaId && !document.media.some((item) => item.id === person.mediaId))
          delete person.mediaId;
      }
      for (const asset of manifest.assets) {
        const file = output.files.find((file) => file.path === asset.sourcePath.slice(1));
        if (!file || file.sha256 !== asset.checksum || file.bytes !== asset.byteSize)
          throw new Error('SOURCE_ASSET_CHANGED');
      }
    }
    if (
      (await checksumDocument(output.files)) !== output.artifactDigest ||
      output.files.reduce((sum, file) => sum + file.bytes, 0) !== output.totalBytes ||
      output.files.some((file, index) => index > 0 && output.files[index - 1].path >= file.path)
    )
      throw new Error('SOURCE_OUTPUT_CHANGED');
    const paths = new Set(document.media.map((item) => item.sourcePath));
    for (const path of publicationMediaPaths(document))
      if (!paths.has(path)) throw new Error('SOURCE_IMAGE_REFERENCE_MISSING');
    for (const page of document.pages) {
      const path =
        page.route === '/' ? 'index.html' : `${page.route.replace(/^\/|\/$/g, '')}/index.html`;
      if (!output.files.some((file) => file.path === path)) throw new Error('SOURCE_ROUTE_MISSING');
    }
    const assets: ProductionDraftSource['assets'] = new Map();
    let total = 0;
    for (const path of paths) {
      const file = output.files.find((file) => file.path === path.slice(1));
      if (!file || file.bytes > 5 * 1024 * 1024 || (total += file.bytes) > 20 * 1024 * 1024)
        throw new Error('SOURCE_ASSET_MISSING');
      const response = await read(`${origin}${path}`);
      const contentType = response.headers.get('content-type')?.split(';')[0] ?? '';
      const content = await bytes(response, file.bytes);
      if (content.length !== file.bytes || hash(content) !== file.sha256)
        throw new Error('SOURCE_ASSET_CHANGED');
      assets.set(path, { bytes: content, contentType, filename: path.split('/').at(-1)! });
    }
    const after = await current(false);
    const finalRelease = await read(`${origin}/__pointsite_release.json`);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      await finalRelease.body?.cancel();
      throw new Error('SOURCE_DEPLOYMENT_CHANGED');
    }
    if (release) {
      if (
        JSON.stringify(releaseSchema.parse(await publicationJson(finalRelease, 2048))) !==
        JSON.stringify(release)
      )
        throw new Error('SOURCE_DEPLOYMENT_CHANGED');
    } else {
      await finalRelease.body?.cancel();
      if (finalRelease.status !== 404) throw new Error('SOURCE_DEPLOYMENT_CHANGED');
    }
    return {
      document,
      assets,
      provenance: {
        target,
        sourceCommit,
        deploymentId: String(before.id),
        artifactDigest: output.artifactDigest,
        ...(release ? { candidateChecksum: release.candidateChecksum } : {}),
        documentChecksum: await checksumDocument(document),
        capturedAt: new Date().toISOString(),
      },
    };
  } catch {
    throw new ApiError(
      503,
      target === 'staging' ? 'STAGING_IMPORT_UNCONFIRMED' : 'PRODUCTION_IMPORT_UNCONFIRMED',
      `Current ${target === 'staging' ? 'Staging' : 'Production'} content could not be confirmed. No draft was created; try again shortly.`,
    );
  }
}
