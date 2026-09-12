import type { DraftRecord } from '../server/repositories/contracts';

export interface LibraryItem {
  id: string;
  mediaType: 'image' | 'video' | 'youtube';
  sourceType: 'managed' | 'uploaded' | 'linked';
  displayName: string;
  filename: string;
  sourcePath: string;
  url: string;
  altText: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  usageCount: number;
  deleteBlockers: string[];
  width?: number;
  height?: number;
  byteSize?: number;
}

export interface LibrarySnapshot {
  draftId: string;
  revisionId: string;
  revisionChecksum: string;
  items: LibraryItem[];
  activeCount: number;
  archivedCount: number;
}

export interface LibraryMutationResult {
  draft: DraftRecord;
  library: LibrarySnapshot;
}

export interface LibraryMetadata {
  displayName: string;
  altText: string;
  tags: string[];
}

export interface LibraryLinkInput extends LibraryMetadata {
  mediaType: 'image' | 'video' | 'youtube';
  url: string;
}

export interface LibraryMutationContext {
  draftId: string;
  expectedRevisionId: string;
  expectedChecksum: string;
  checkoutToken: string;
  idempotencyKey: string;
}
