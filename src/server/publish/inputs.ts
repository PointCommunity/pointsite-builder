import { z } from 'zod';
import { checksumDocument } from '../../site-kit/canonicalize';
import { assertNoPrivateBuilderLinks } from '../../shared/private-media-links';
import type { DraftRecord } from '../repositories/contracts';
import { candidateImagePath } from './candidate';

export const PublicationAssetSchema = z.strictObject({
  assetId: z.uuid(),
  sourcePath: z.string().regex(candidateImagePath),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  byteSize: z
    .number()
    .int()
    .min(1)
    .max(5 * 1024 * 1024),
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/avif']),
});
export type PublicationAsset = z.infer<typeof PublicationAssetSchema>;

/** Prepare references only; the caller commits these with its role/base/job guards. */
export async function preparePublicationInputs(
  database: D1Database,
  draft: DraftRecord,
  jobId: string,
  workflowRevision: string,
) {
  z.uuid().parse(jobId);
  z.string()
    .regex(/^[a-f0-9]{40}$/)
    .parse(workflowRevision);
  assertNoPrivateBuilderLinks(draft.document);
  if (
    draft.latestRevisionId !== draft.revision.id ||
    draft.revision.draftId !== draft.id ||
    (await checksumDocument(draft.document)) !== draft.revision.checksum
  )
    throw new Error('PUBLICATION_REVISION_MISMATCH');
  const paths = [...new Set(draft.document.media.map((item) => item.sourcePath))].sort();
  if (paths.length > 500 || paths.some((path) => !candidateImagePath.test(path))) {
    throw new Error('CANDIDATE_MEDIA_PATH_INVALID');
  }
  const rows = await database
    .prepare(
      `SELECT v.id AS assetId,b.source_path AS sourcePath,v.checksum,
      v.byte_size AS byteSize,v.content_type AS contentType
     FROM json_each(?) requested
     JOIN draft_asset_bindings b ON b.draft_id=? AND b.source_path=requested.value
     JOIN draft_asset_versions v ON v.id=b.asset_id AND v.draft_id=b.draft_id
     ORDER BY b.source_path`,
    )
    .bind(JSON.stringify(paths), draft.id)
    .all();
  const assets = z.array(PublicationAssetSchema).max(500).parse(rows.results);
  if (
    assets.length !== paths.length ||
    assets.some((asset, index) => asset.sourcePath !== paths[index])
  ) {
    throw new Error('PUBLICATION_ASSET_MISSING');
  }
  const byteSize = assets.reduce((sum, asset) => sum + asset.byteSize, 0);
  if (byteSize > 20 * 1024 * 1024) throw new Error('CANDIDATE_MEDIA_TOO_LARGE');
  const candidate = {
    siteId: draft.siteId,
    draftId: draft.id,
    revisionId: draft.revision.id,
    revisionChecksum: draft.revision.checksum,
    schemaVersion: draft.document.schemaVersion,
    rendererVersion: draft.document.rendererVersion,
    publicationProtocol: 2,
    workflowRevision,
    fileCount: assets.length + 2,
  };
  const candidateChecksum = await checksumDocument({ ...candidate, assets });
  const serialized = JSON.stringify(assets);
  return {
    candidate,
    candidateChecksum,
    assets,
    byteSize,
    statements: [
      database
        .prepare(
          `SELECT json(CASE WHEN NOT EXISTS (
          SELECT 1 FROM json_each(?) expected
          LEFT JOIN draft_asset_bindings b ON b.draft_id=?
            AND b.source_path=json_extract(expected.value,'$.sourcePath')
            AND b.asset_id=json_extract(expected.value,'$.assetId')
          LEFT JOIN draft_asset_versions v ON v.id=b.asset_id AND v.draft_id=b.draft_id
          WHERE v.id IS NULL OR v.checksum!=json_extract(expected.value,'$.checksum')
            OR v.byte_size!=json_extract(expected.value,'$.byteSize')
            OR v.content_type!=json_extract(expected.value,'$.contentType')
        ) THEN 'true' ELSE 'publication inputs changed' END)`,
        )
        .bind(serialized, draft.id),
      database
        .prepare(
          'INSERT INTO publication_inputs(job_id,draft_id,revision_id,workflow_revision) VALUES (?,?,?,?)',
        )
        .bind(jobId, draft.id, draft.revision.id, workflowRevision),
      database
        .prepare(
          `INSERT INTO publication_asset_pins(job_id,draft_id,source_path,asset_id)
         SELECT ?,?,json_extract(value,'$.sourcePath'),json_extract(value,'$.assetId') FROM json_each(?)`,
        )
        .bind(jobId, draft.id, serialized),
    ],
  };
}
