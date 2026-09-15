import type { SiteDocument } from '../../site-kit/types';
import type { DraftAssetObject } from '../media/draft-assets';
import type {
  DraftAction,
  DraftActionCategory,
  DraftActionContext,
} from '../../shared/draft-actions';

export type Role = 'viewer' | 'editor' | 'publisher' | 'administrator';
export type DraftStatus = 'active' | 'archived' | 'deleted';
export type EditorPanel =
  'layout' | 'forms' | 'library' | 'preview' | 'history' | 'settings' | 'admin';

export interface EditorViewState {
  draftId: string;
  panel: EditorPanel;
  pageId: string | null;
  selectedElementId: string | null;
  previewViewport: 'phone' | 'tablet' | 'desktop';
  previewZoom: number;
  scrollPositions: Record<string, number>;
  updatedAt: string;
}

export interface DraftCheckoutAvailability {
  draftId: string;
  state: 'available' | 'owned' | 'unavailable';
  expiresAt: string | null;
  ownerLogin?: string;
}

export interface DraftCheckout {
  draftId: string;
  actor: string;
  clientId: string;
  token: string;
  acquiredAt: string;
  lastActivityAt: string;
  expiresAt: string;
  event: 'acquired' | 'resumed' | 'transferred';
  viewState: EditorViewState | null;
}

export interface CheckoutCommand {
  draftId: string;
  actor: string;
  clientId: string;
  token: string;
  requestId: string;
  now?: string;
  activity?: boolean;
}

export interface AcquireCheckoutCommand extends Omit<CheckoutCommand, 'token' | 'activity'> {
  ownerLogin?: string;
  resumeOnly?: boolean;
  expectedStatus?: Exclude<DraftStatus, 'deleted'>;
}

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

export type RevisionSummary = Omit<RevisionRecord, 'document'>;
export type DraftSummary = Omit<DraftRecord, 'document' | 'revision'> & {
  revision: RevisionSummary;
};
export const REVISION_PAGE_SIZE = 100;
export interface RevisionListOptions {
  beforeSequence?: number;
  query?: string;
  filter?: 'all' | 'named' | 'current';
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
  sourceDraftId?: string;
  name: string;
  document: SiteDocument;
  actor: string;
  idempotencyKey: string;
  requestId: string;
}

export interface ProductionDraftSource {
  document: SiteDocument;
  assets: Map<string, DraftAssetObject>;
  provenance: {
    sourceCommit: string;
    deploymentId: string;
    artifactDigest: string;
    documentChecksum: string;
    capturedAt: string;
  };
}

export interface DeletedDraftReceipt {
  id: string;
  status: 'deleted';
  deletedAt: string;
}

export interface DraftMutationProof {
  expectedRevisionId: string;
  expectedChecksum: string;
  checkoutToken: string;
}

export interface SaveDraftInput extends DraftMutationProof {
  draftId: string;
  document: SiteDocument;
  actor: string;
  idempotencyKey: string;
  requestId: string;
  action: DraftAction;
  label?: string;
}

export interface RestoreRevisionInput extends DraftMutationProof {
  draftId: string;
  revisionId: string;
  actor: string;
  idempotencyKey: string;
  requestId: string;
}

export interface DraftRepository {
  listDrafts(status?: DraftStatus): Promise<DraftRecord[]>;
  listDraftSummaries(status?: DraftStatus): Promise<DraftSummary[]>;
  getDraft(id: string): Promise<DraftRecord>;
  getRevision(id: string): Promise<RevisionRecord>;
  createDraft(input: CreateDraftInput): Promise<DraftRecord>;
  saveDraft(input: SaveDraftInput): Promise<DraftRecord>;
  listRevisions(draftId: string, options?: RevisionListOptions): Promise<RevisionSummary[]>;
  restoreRevision(input: RestoreRevisionInput): Promise<DraftRecord>;
  labelRevision(
    draftId: string,
    revisionId: string,
    label: string,
    actor: string,
    requestId: string,
    proof: DraftMutationProof,
  ): Promise<RevisionRecord>;
  renameDraft(
    draftId: string,
    name: string,
    actor: string,
    requestId: string,
    proof: DraftMutationProof,
  ): Promise<DraftRecord>;
  setDraftStatus(
    draftId: string,
    status: Exclude<DraftStatus, 'deleted'>,
    actor: string,
    requestId: string,
    proof: DraftMutationProof,
  ): Promise<DraftRecord>;
  purgeDraft(
    draftId: string,
    actor: string,
    requestId: string,
    proof: DraftMutationProof,
  ): Promise<DeletedDraftReceipt>;
  listCheckoutAvailability(actor: string, now?: string): Promise<DraftCheckoutAvailability[]>;
  acquireCheckout(input: AcquireCheckoutCommand): Promise<DraftCheckout>;
  touchCheckout(input: CheckoutCommand, viewState?: EditorViewState): Promise<DraftCheckout>;
  releaseCheckout(input: CheckoutCommand): Promise<void>;
  assertCheckout(draftId: string, actor: string, token: string, now?: string): Promise<void>;
  ownedCheckout(actor: string, now?: string): Promise<DraftCheckout | null>;
}
