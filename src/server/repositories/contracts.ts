import type { SiteDocument } from '../../site-kit/types';
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

export interface DeletedDraftReceipt {
  id: string;
  status: 'deleted';
  deletedAt: string;
}

export interface SaveDraftInput {
  draftId: string;
  expectedRevisionId?: string;
  expectedChecksum: string;
  document: SiteDocument;
  actor: string;
  idempotencyKey: string;
  requestId: string;
  action: DraftAction;
  checkoutToken?: string;
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
    status: Exclude<DraftStatus, 'deleted'>,
    actor: string,
    requestId: string,
  ): Promise<DraftRecord>;
  purgeDraft(draftId: string, actor: string, requestId: string): Promise<DeletedDraftReceipt>;
  listCheckoutAvailability(actor: string, now?: string): Promise<DraftCheckoutAvailability[]>;
  acquireCheckout(input: Omit<CheckoutCommand, 'token'>): Promise<DraftCheckout>;
  touchCheckout(input: CheckoutCommand, viewState?: EditorViewState): Promise<DraftCheckout>;
  releaseCheckout(input: CheckoutCommand): Promise<void>;
  assertCheckout(draftId: string, actor: string, token: string, now?: string): Promise<void>;
  ownedCheckout(actor: string, now?: string): Promise<DraftCheckout | null>;
}
