import { checksumDocument } from '../../site-kit/canonicalize';
import type { DraftRecord } from '../repositories/contracts';
import type { MediaService } from '../media/service';

export interface CandidateFile {
  path: string;
  content: string;
  encoding?: 'utf-8' | 'base64';
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 32_768));
  }
  return btoa(binary);
}

export async function buildCandidate(draft: DraftRecord, media?: MediaService) {
  const content = `${JSON.stringify(draft.document, null, 2)}\n`;
  const mediaFiles: CandidateFile[] = [];
  let mediaBytes = 0;
  for (const item of draft.document.media.filter((entry) =>
    entry.sourcePath.startsWith('/assets/builder/'),
  )) {
    if (!media) throw new Error('CANDIDATE_MEDIA_NOT_CONFIGURED');
    const expected = new RegExp(`^/assets/builder/${item.id}\\.(?:avif|jpe?g|png|webp)$`);
    if (!expected.test(item.sourcePath)) throw new Error('CANDIDATE_MEDIA_PATH_INVALID');
    const object = await media.read(item.id);
    mediaBytes += object.bytes.byteLength;
    if (mediaBytes > 20 * 1024 * 1024) throw new Error('CANDIDATE_MEDIA_TOO_LARGE');
    mediaFiles.push({
      path: `public${item.sourcePath}`,
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
