import { z } from 'zod';

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const size = {
  repository: z
    .enum(['PointCommunity/pointsite', 'PointCommunity/pointsite-canary'])
    .default('PointCommunity/pointsite'),
  artifactDigest: digest,
  fileCount: z.number().int().min(1).max(2000),
  totalBytes: z.number().int().min(1).max(100_000_000),
};
export const RollbackSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('baseline'),
    sourceRevision: sha,
    ...size,
    archiveRevision: sha,
    archivePath: z.literal('publication-baseline/site.tar.gz'),
    archiveBlobSha: sha,
    archiveSha256: digest,
    archiveBytes: z.number().int().min(1).max(4_000_000),
    manifestPath: z.literal('publication-baseline/manifest.json'),
    manifestBlobSha: sha,
  }),
  z.object({
    kind: z.literal('publication'),
    ...size,
    commitSha: sha,
    treeSha: sha,
    manifestBlobSha: sha,
    workflowRevision: sha,
    candidateChecksum: digest,
  }),
]);
export type RollbackSource = z.infer<typeof RollbackSourceSchema>;

export function rollbackSource(release: {
  kind: string;
  artifact_digest: string;
  source_json: string;
}): RollbackSource {
  const stored: unknown = JSON.parse(release.source_json);
  return RollbackSourceSchema.parse({
    ...z.record(z.string(), z.unknown()).parse(stored),
    ...(release.kind === 'rollback' ? {} : { kind: release.kind }),
    artifactDigest: release.artifact_digest,
  });
}
