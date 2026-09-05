import { checksumDocument } from '../../site-kit/canonicalize';
import type { DraftRecord } from '../repositories/contracts';

export async function buildCandidate(draft: DraftRecord) {
  const content = `${JSON.stringify(draft.document, null, 2)}\n`;
  const candidateChecksum = await checksumDocument({
    revisionId: draft.revision.id,
    revisionChecksum: draft.revision.checksum,
    rendererVersion: draft.document.rendererVersion,
    content,
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
    ],
  };
}
