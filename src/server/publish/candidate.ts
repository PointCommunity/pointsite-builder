import { checksumDocument } from '../../site-kit/canonicalize';
import type { DraftRecord } from '../repositories/contracts';
import type { MediaService } from '../media/service';
import { assertNoPrivateBuilderLinks } from '../../shared/private-media-links';
import type { DraftAssetObject } from '../media/draft-assets';

export interface CandidateFile {
  path: string;
  content: string;
  encoding?: 'utf-8' | 'base64';
}

// Match the renderer's local image contract, with nonempty path segments.
export const candidateImagePath =
  /^\/assets\/(?:[a-z0-9][a-z0-9_-]*\/)*[a-z0-9][a-z0-9_-]*\.(?:avif|jpe?g|png|webp)$/;

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 32_768));
  }
  return btoa(binary);
}

export async function buildCandidate(draft: DraftRecord, media?: MediaService) {
  assertNoPrivateBuilderLinks(draft.document);
  const content = `${JSON.stringify(draft.document, null, 2)}\n`;
  const mediaFiles: CandidateFile[] = [];
  let mediaBytes = 0;
  const sourcePaths = [...new Set(draft.document.media.map((item) => item.sourcePath))].sort();
  for (const sourcePath of sourcePaths) {
    if (!candidateImagePath.test(sourcePath)) throw new Error('CANDIDATE_MEDIA_PATH_INVALID');
  }
  if (sourcePaths.length && !media) throw new Error('CANDIDATE_MEDIA_NOT_CONFIGURED');
  const objects = sourcePaths.length
    ? await media!
        .readManyForDraft(draft.id, sourcePaths, 20 * 1024 * 1024)
        .catch((error: unknown) => {
          if (error instanceof Error && error.message === 'MEDIA_READ_TOO_LARGE')
            throw new Error('CANDIDATE_MEDIA_TOO_LARGE');
          throw error;
        })
    : new Map<string, DraftAssetObject>();
  for (const sourcePath of sourcePaths) {
    const object = objects.get(sourcePath);
    if (!object) throw new Error('MEDIA_NOT_FOUND');
    mediaBytes += object.bytes.byteLength;
    if (mediaBytes > 20 * 1024 * 1024) throw new Error('CANDIDATE_MEDIA_TOO_LARGE');
    mediaFiles.push({
      path: `public${sourcePath}`,
      content: base64(object.bytes),
      encoding: 'base64',
    });
  }
  const candidateChecksum = await checksumDocument({
    revisionId: draft.revision.id,
    revisionChecksum: draft.revision.checksum,
    rendererVersion: draft.document.rendererVersion,
    content,
    media: mediaFiles.map(({ path, content: encoded }) => ({ path, encoded })),
  });
  const manifest = `${JSON.stringify(
    {
      schemaVersion: draft.document.schemaVersion,
      rendererVersion: draft.document.rendererVersion,
      revisionId: draft.revision.id,
      revisionChecksum: draft.revision.checksum,
      candidateChecksum,
      source: 'PointCommunity/pointsite-builder',
    },
    null,
    2,
  )}\n`;
  return {
    candidateChecksum,
    files: [
      { path: 'content/builder-site.json', content },
      { path: 'content/builder-site.manifest.json', content: manifest },
      ...mediaFiles,
    ],
  };
}
