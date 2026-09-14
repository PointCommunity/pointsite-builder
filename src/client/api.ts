import type { SiteDocument } from '../site-kit/types';
import { compressImage } from './media/compress-image';
import type {
  DeletedDraftReceipt,
  DraftCheckout,
  DraftCheckoutAvailability,
  DraftRecord,
  DraftSummary,
  EditorViewState,
  RevisionRecord,
  Role,
} from '../server/repositories/contracts';
import { DELETE_DRAFT_CONFIRMATION } from '../shared/draft-lifecycle';
import type { DraftAction } from '../shared/draft-actions';
import type {
  RollbackSelection,
  RollbackSnapshot,
  StagingWorkflowSnapshot,
  ProductionWorkflowSnapshot,
  PublicationVerificationState,
} from './publish/workflow';
import type { FeedbackAvailability, FeedbackScreen } from '../shared/feedback';
import type {
  LibrarySnapshot,
  LibraryMutationContext,
  LibraryMutationResult,
  LibraryLinkInput,
  LibraryMetadata,
} from '../shared/library';

export interface ActorResponse {
  email: string;
  displayName?: string;
  role: Role;
  repositoryPermission?: 'admin' | 'maintain' | 'write' | 'triage' | 'read';
}

export interface AdminRoleItem {
  githubLogin: string;
  githubUserId: number;
  role: Role;
  active: boolean;
  updatedAt: string;
  updatedBy: string;
}

export interface AuditItem {
  id: string;
  occurredAt: string;
  actor: string;
  action: string;
  targetType: string;
  targetId: string;
  outcome: string;
  requestId: string;
  metadata: Record<string, string | number | boolean | null>;
}

export type { CapacityReport } from '../server/admin/service';
import type { CapacityReport } from '../server/admin/service';

export type { CandidateTuple } from '../server/approvals/service';
import type { CandidateTuple } from '../server/approvals/service';

export type StagingPublishResponse =
  | {
      environment: 'staging';
      jobId: string;
      status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
      publicationProtocol: 2;
      candidateChecksum: string;
    }
  | StagingPublishResult
  | {
      status: 'running';
      environment: 'staging';
      jobId: string;
      uploaded: number;
      total: number;
      candidateChecksum: string;
    };
export interface StagingPublishResult {
  status?: 'succeeded';
  jobId?: string;
  siteId: 'pointsite';
  revisionId: string;
  revisionChecksum: string;
  schemaVersion: number;
  rendererVersion: string;
  candidateChecksum: string;
  stagingBaseSha: string;
  commitSha: string;
  url: string;
}

export interface PublishJobResponse {
  id: string;
  status: string;
  candidateChecksum: string;
  resultSha: string | null;
  evidence: {
    verificationStatus?: string;
    failureCode?: string;
    failedChecks?: string[];
    failedCheckUrls?: Record<string, string>;
    workflowUrl?: string;
    deploymentUrl?: string;
    checks?: Record<string, boolean>;
  };
}

export class ClientApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ClientApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      code?: string;
      message?: string;
      requestId?: string;
    };
    throw new ClientApiError(
      response.status,
      body.code ?? 'REQUEST_FAILED',
      body.message ?? 'Request failed',
      body.requestId,
    );
  }
  if (response.status === 204) return undefined as T;
  return await response.json();
}

function mutationHeaders(key: string, extra?: HeadersInit): HeadersInit {
  return { 'content-type': 'application/json', 'idempotency-key': key, ...extra };
}

function libraryHeaders(context: LibraryMutationContext): Record<string, string> {
  return {
    'x-draft-checkout': context.checkoutToken,
    'if-match': `"${context.expectedChecksum}"`,
    'x-draft-revision': context.expectedRevisionId,
    'idempotency-key': context.idempotencyKey,
  };
}

async function libraryImage(
  context: LibraryMutationContext,
  file: File,
  altText: string,
  replacement?: { itemId: string; metadata: LibraryMetadata },
): Promise<LibraryMutationResult> {
  const body = new FormData();
  body.set('file', await compressImage(file));
  body.set('altText', altText);
  if (replacement) {
    body.set('displayName', replacement.metadata.displayName);
    body.set('tags', JSON.stringify(replacement.metadata.tags));
    body.set('confirmed', 'true');
  }
  return request(
    `/drafts/${context.draftId}/library/${replacement ? `items/${encodeURIComponent(replacement.itemId)}/replacement` : 'images'}`,
    {
      method: 'POST',
      headers: libraryHeaders(context),
      body,
    },
  );
}

export const api = {
  feedbackAvailability: () =>
    request<FeedbackAvailability>('/feedback', { signal: AbortSignal.timeout(10_000) }),
  launchFeedback: (screen: FeedbackScreen) =>
    request<{ action: string; launchToken: string }>('/feedback/launch', {
      method: 'POST',
      headers: mutationHeaders(crypto.randomUUID()),
      body: JSON.stringify({ screen }),
      signal: AbortSignal.timeout(10_000),
    }),
  me: () => request<ActorResponse>('/me'),
  listDrafts: async () => (await request<{ items: DraftSummary[] }>('/drafts?view=summary')).items,
  getDraft: (id: string) => request<DraftRecord>(`/drafts/${id}`),
  createDraft: (name: string, fromRevisionId?: string) =>
    request<DraftRecord>('/drafts', {
      method: 'POST',
      headers: mutationHeaders(crypto.randomUUID()),
      body: JSON.stringify({ name, ...(fromRevisionId ? { fromRevisionId } : {}) }),
    }),
  saveDraft: (
    id: string,
    checksum: string,
    document: SiteDocument,
    action: DraftAction,
    idempotencyKey: string,
    checkoutToken: string,
    expectedRevisionId: string,
  ) =>
    request<DraftRecord>(`/drafts/${id}`, {
      method: 'PUT',
      headers: mutationHeaders(idempotencyKey, {
        'if-match': `"${checksum}"`,
        'x-draft-checkout': checkoutToken,
        'x-draft-revision': expectedRevisionId,
      }),
      body: JSON.stringify({ document, action }),
    }),
  listCheckouts: async () =>
    (await request<{ items: DraftCheckoutAvailability[] }>('/drafts/checkouts')).items,
  ownedCheckout: () =>
    request<{ draftId: string; expiresAt: string } | null>('/drafts/checkout/owned'),
  acquireCheckout: (
    id: string,
    clientId: string,
    options: { resumeOnly?: boolean; expectedStatus?: 'active' | 'archived' } = {},
  ) =>
    request<DraftCheckout>(`/drafts/${id}/checkout`, {
      method: 'POST',
      headers: mutationHeaders(crypto.randomUUID()),
      body: JSON.stringify({ clientId, ...options }),
    }),
  validateCheckout: (id: string, token: string) =>
    request<{ active: true }>(`/drafts/${id}/checkout`, {
      headers: { 'x-draft-checkout': token },
    }),
  touchCheckout: (
    id: string,
    clientId: string,
    token: string,
    viewState?: EditorViewState,
    activity = true,
  ) =>
    request<DraftCheckout>(`/drafts/${id}/checkout`, {
      method: 'PATCH',
      headers: mutationHeaders(crypto.randomUUID(), { 'x-draft-checkout': token }),
      body: JSON.stringify({ clientId, activity, ...(viewState ? { viewState } : {}) }),
    }),
  releaseCheckout: (id: string, clientId: string, token: string) =>
    request<void>(`/drafts/${id}/checkout`, {
      method: 'DELETE',
      headers: mutationHeaders(crypto.randomUUID(), { 'x-draft-checkout': token }),
      body: JSON.stringify({ clientId }),
    }),
  renameDraft: (context: LibraryMutationContext, name: string) =>
    request<DraftRecord>(`/drafts/${context.draftId}`, {
      method: 'PATCH',
      headers: mutationHeaders(context.idempotencyKey, libraryHeaders(context)),
      body: JSON.stringify({ name }),
    }),
  setDraftStatus: (context: LibraryMutationContext, action: 'archive' | 'recover') =>
    request<DraftRecord>(`/drafts/${context.draftId}`, {
      method: 'PATCH',
      headers: mutationHeaders(context.idempotencyKey, libraryHeaders(context)),
      body: JSON.stringify({ status: action === 'archive' ? 'archived' : 'active' }),
    }),
  deleteDraft: (context: LibraryMutationContext) =>
    request<DeletedDraftReceipt>(`/drafts/${context.draftId}`, {
      method: 'DELETE',
      headers: mutationHeaders(context.idempotencyKey, libraryHeaders(context)),
      body: JSON.stringify({ confirmation: DELETE_DRAFT_CONFIRMATION }),
    }),
  listRevisions: (
    id: string,
    options: {
      cursor?: string;
      query?: string;
      filter?: 'all' | 'named' | 'current';
      signal?: AbortSignal;
    } = {},
  ) => {
    const query = new URLSearchParams();
    if (options.cursor) query.set('cursor', options.cursor);
    if (options.query) query.set('query', options.query);
    if (options.filter) query.set('filter', options.filter);
    return request<{ items: Omit<RevisionRecord, 'document'>[]; nextCursor: string | null }>(
      `/drafts/${id}/revisions?${query}`,
      { signal: options.signal },
    );
  },
  labelRevision: (context: LibraryMutationContext, revisionId: string, label: string) =>
    request<RevisionRecord>(`/drafts/${context.draftId}/revisions/${revisionId}`, {
      method: 'PATCH',
      headers: mutationHeaders(context.idempotencyKey, libraryHeaders(context)),
      body: JSON.stringify({ label }),
    }),
  restoreRevision: (context: LibraryMutationContext, revisionId: string) =>
    request<DraftRecord>(`/drafts/${context.draftId}/restore`, {
      method: 'POST',
      headers: mutationHeaders(context.idempotencyKey, libraryHeaders(context)),
      body: JSON.stringify({ revisionId, expectedChecksum: context.expectedChecksum }),
    }),
  stagingBase: () => request<{ sha: string }>('/publish/staging/base'),
  getStagingWorkflow: (draftId: string) =>
    request<StagingWorkflowSnapshot>(
      `/publish/staging/workflow?draftId=${encodeURIComponent(draftId)}`,
    ),
  preflightStaging: (
    draftId: string,
    expectedRevisionId: string,
    expectedRevisionChecksum: string,
  ) =>
    request<StagingWorkflowSnapshot['preflight']>('/publish/staging/preflight', {
      method: 'POST',
      headers: mutationHeaders(`preflight-${expectedRevisionId}-${crypto.randomUUID()}`),
      body: JSON.stringify({ draftId, expectedRevisionId, expectedRevisionChecksum }),
    }),
  publishStaging: (
    draftId: string,
    expectedRevisionId: string,
    expectedRevisionChecksum: string,
    expectedBaseSha: string,
    requestKey?: string,
  ) =>
    request<StagingPublishResponse>('/publish/staging', {
      method: 'POST',
      headers: mutationHeaders(requestKey ?? `staging-${expectedRevisionId}-${expectedBaseSha}`),
      body: JSON.stringify({
        draftId,
        expectedRevisionId,
        expectedRevisionChecksum,
        expectedBaseSha,
      }),
    }),
  continueStagingPublication: (jobId: string) =>
    request<StagingPublishResponse>(`/publish/jobs/${jobId}/continue`, {
      method: 'POST',
      headers: mutationHeaders(crypto.randomUUID()),
      body: '{}',
    }),
  recoverQueuedPublication: (
    jobId: string,
    action: 'retry' | 'cancel' | 'reconcile' | 'retry-captured' | 'verify-completed',
    expectedAttempts: number,
    requestKey: string,
  ) =>
    request<{ recovered: true; jobId?: string }>(`/publish/jobs/${jobId}/recovery`, {
      method: 'POST',
      headers: mutationHeaders(requestKey),
      body: JSON.stringify({ action, expectedAttempts }),
    }),
  refreshStagingVerification: (jobId: string) =>
    request<PublishJobResponse>(`/publish/jobs/${jobId}/verification`, {
      method: 'POST',
      headers: mutationHeaders(crypto.randomUUID()),
      body: '{}',
    }),
  productionBase: () => request<{ sha: string }>('/approvals/production-base'),
  getPublicationVerification: (target: 'staging' | 'production', jobId: string) =>
    request<{ verification: PublicationVerificationState | null }>(
      `/publish/${target}/jobs/${jobId}/verification`,
    ),
  capturePublicationVerification: (
    target: 'staging' | 'production',
    jobId: string,
    expectedAttempts: number,
    key: string,
  ) =>
    request<{ recovered: true; verificationId: string }>(
      `/publish/${target}/jobs/${jobId}/verification`,
      {
        method: 'POST',
        headers: mutationHeaders(key),
        body: JSON.stringify({ expectedAttempts }),
      },
    ),
  recoverPublicationVerification: (
    target: 'staging' | 'production',
    jobId: string,
    verificationId: string,
    action: 'retry' | 'reconcile',
    expectedDispatches: number,
    key: string,
  ) =>
    request<{ recovered: true; verificationId?: string }>(
      `/publish/${target}/jobs/${jobId}/verification/${verificationId}/recovery`,
      {
        method: 'POST',
        headers: mutationHeaders(key),
        body: JSON.stringify({ action, expectedDispatches }),
      },
    ),
  getRollback: () => request<RollbackSnapshot>('/publish/production/rollback'),
  prepareRollback: () =>
    request<Omit<RollbackSelection, 'sourceReleaseId'>>('/publish/production/rollback/prepare', {
      method: 'POST',
      headers: mutationHeaders(crypto.randomUUID()),
      body: JSON.stringify({}),
    }),
  rollbackProduction: (selection: RollbackSelection, key: string) =>
    request<{ id: string; status: string }>('/publish/production/rollback', {
      method: 'POST',
      headers: mutationHeaders(key),
      body: JSON.stringify(selection),
    }),
  recoverRollback: (id: string, action: 'cancel' | 'verify') =>
    request<{ recovered: true }>(`/publish/production/rollback/${id}/recovery`, {
      method: 'POST',
      headers: mutationHeaders(crypto.randomUUID()),
      body: JSON.stringify({ action }),
    }),
  getProductionWorkflow: (draftId: string) =>
    request<ProductionWorkflowSnapshot>(
      `/publish/production/workflow?draftId=${encodeURIComponent(draftId)}`,
    ),
  publishProduction: (
    stagingJobId: string,
    approvalId: string,
    tuple: CandidateTuple,
    requestKey: string,
  ) =>
    request<{ id: string; status: string }>('/publish/production', {
      method: 'POST',
      headers: mutationHeaders(requestKey),
      body: JSON.stringify({ stagingJobId, approvalId, tuple }),
    }),
  recoverProduction: (
    jobId: string,
    action: 'retry' | 'cancel' | 'reconcile' | 'retry-captured' | 'verify-completed',
    expectedAttempts: number,
    requestKey: string,
  ) =>
    request<{ recovered: true; jobId?: string }>(`/publish/production/jobs/${jobId}/recovery`, {
      method: 'POST',
      headers: mutationHeaders(requestKey),
      body: JSON.stringify({ action, expectedAttempts }),
    }),
  revokeStaging: (
    publishJobId: string,
    expectedTuple: CandidateTuple,
    expectedApprovalId: string,
  ) =>
    request<{ id: string; decision: string; tuple: CandidateTuple }>('/approvals', {
      method: 'POST',
      headers: mutationHeaders(crypto.randomUUID()),
      body: JSON.stringify({
        publishJobId,
        expectedTuple,
        expectedApprovalId,
        decision: 'revoked',
        note: 'Staging acceptance revoked in Builder',
      }),
    }),
  acceptStaging: (
    publishJobId: string,
    expectedTuple: CandidateTuple,
    note?: string,
    expectedApprovalId?: string | null,
  ) =>
    request<{ id: string; decision: string; tuple: CandidateTuple }>('/approvals', {
      method: 'POST',
      headers: mutationHeaders(crypto.randomUUID()),
      body: JSON.stringify({
        ...(expectedApprovalId !== undefined ? { expectedApprovalId } : {}),
        publishJobId,
        expectedTuple,
        decision: 'approved',
        ...(note ? { note } : {}),
      }),
    }),
  listLibrary: (draftId: string) => request<LibrarySnapshot>(`/drafts/${draftId}/library`),
  uploadLibraryImage: (context: LibraryMutationContext, file: File, altText: string) =>
    libraryImage(context, file, altText),
  replaceLibraryImage: (
    context: LibraryMutationContext,
    itemId: string,
    file: File,
    metadata: LibraryMetadata,
  ) => libraryImage(context, file, metadata.altText, { itemId, metadata }),
  addLibraryLink: (context: LibraryMutationContext, input: LibraryLinkInput) =>
    request<LibraryMutationResult>(`/drafts/${context.draftId}/library/links`, {
      method: 'POST',
      headers: mutationHeaders(context.idempotencyKey, libraryHeaders(context)),
      body: JSON.stringify(input),
    }),
  updateLibraryItem: (
    context: LibraryMutationContext,
    itemId: string,
    action: 'archive' | 'unarchive' | 'update',
    metadata?: LibraryMetadata,
  ) =>
    request<LibraryMutationResult>(
      `/drafts/${context.draftId}/library/items/${encodeURIComponent(itemId)}`,
      {
        method: 'PATCH',
        headers: mutationHeaders(context.idempotencyKey, libraryHeaders(context)),
        body: JSON.stringify({ action, ...(metadata ? { metadata } : {}) }),
      },
    ),
  deleteLibraryItem: (context: LibraryMutationContext, itemId: string) =>
    request<LibraryMutationResult>(
      `/drafts/${context.draftId}/library/items/${encodeURIComponent(itemId)}`,
      {
        method: 'DELETE',
        headers: mutationHeaders(context.idempotencyKey, libraryHeaders(context)),
        body: JSON.stringify({ confirmation: true }),
      },
    ),
  listRoles: async () => (await request<{ items: AdminRoleItem[] }>('/admin/roles')).items,
  upsertRole: (input: { githubLogin: string; role: Role; active: boolean }) =>
    request<AdminRoleItem>('/admin/roles', {
      method: 'PUT',
      headers: mutationHeaders(crypto.randomUUID()),
      body: JSON.stringify(input),
    }),
  listAudit: async () => (await request<{ items: AuditItem[] }>('/admin/audit')).items,
  getCapacity: () => request<CapacityReport>('/admin/capacity'),
};
