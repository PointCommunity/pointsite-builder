import { checksumDocument } from '../../site-kit/canonicalize';
import type { CreateDraftInput, SaveDraftInput } from './contracts';

export function createRequestHash(input: CreateDraftInput): Promise<string> {
  return checksumDocument({
    name: input.name,
    document: input.document,
    sourceDraftId: input.sourceDraftId ?? null,
  });
}

export function saveRequestHash(input: SaveDraftInput): Promise<string> {
  return checksumDocument({
    draftId: input.draftId,
    expectedRevisionId: input.expectedRevisionId ?? null,
    expectedChecksum: input.expectedChecksum,
    document: input.document,
    action: input.action,
    label: input.label ?? null,
  });
}
