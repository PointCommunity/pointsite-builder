import type { SiteDocument } from '../../site-kit/types';
import type {
  DraftAction,
  DraftActionCategory,
  DraftActionContext,
} from '../../shared/draft-actions';

export type Role = 'viewer' | 'editor' | 'publisher' | 'administrator';
export type DraftStatus = 'active' | 'archived' | 'deleted';

export interface RevisionRecord {
  id: string;
  draftId: string;
  sequence: number;
  parentRevisionId: string | null;
  checksum: string;
  document: SiteDocument;
  label: string | null;
  schemaVersion: number;
  rendererVersion: string;
  createdBy: string;
  createdAt: string;
  actionCategory: DraftActionCategory | null;
  actionContext: DraftActionContext | null;
}

export interface DraftRecord {
  id: string;
  siteId: 'pointsite';
  name: string;
  status: DraftStatus;
  latestRevisionId: string;
  document: SiteDocument;
  revision: RevisionRecord;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface AuditEventRecord {
  id: string;
  occurredAt: string;
  actor: string;
  action: string;
  targetType: string;
  targetId: string;
  outcome: 'succeeded' | 'failed' | 'denied';
  requestId: string;
  metadata: Record<string, string | number | boolean | null>;
}

export interface CreateDraftInput {
  name: string;
  document: SiteDocument;
  actor: string;
  idempotencyKey: string;
  requestId: string;
}

export interface SaveDraftInput {
  draftId: string;
  expectedChecksum: string;
  document: SiteDocument;
  actor: string;
  idempotencyKey: string;
  requestId: string;
  action: DraftAction;
  label?: string;
}

export interface RestoreRevisionInput {
  draftId: string;
  revisionId: string;
  expectedChecksum: string;
  actor: string;
  idempotencyKey: string;
  requestId: string;
}

export interface DraftRepository {
  listDrafts(status?: DraftStatus): Promise<DraftRecord[]>;
  getDraft(id: string): Promise<DraftRecord>;
  getRevision(id: string): Promise<RevisionRecord>;
  createDraft(input: CreateDraftInput): Promise<DraftRecord>;
  saveDraft(input: SaveDraftInput): Promise<DraftRecord>;
  listRevisions(draftId: string): Promise<RevisionRecord[]>;
  restoreRevision(input: RestoreRevisionInput): Promise<DraftRecord>;
  labelRevision(
    draftId: string,
    revisionId: string,
    label: string,
    actor: string,
    requestId: string,
  ): Promise<RevisionRecord>;
  renameDraft(
    draftId: string,
    name: string,
    actor: string,
    requestId: string,
  ): Promise<DraftRecord>;
  setDraftStatus(
    draftId: string,
    status: DraftStatus,
    actor: string,
    requestId: string,
  ): Promise<DraftRecord>;
}
