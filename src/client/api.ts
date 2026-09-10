import type { SiteDocument } from '../site-kit/types';
import type {
  DraftCheckout,
  DraftCheckoutAvailability,
  DraftRecord,
  EditorViewState,
  RevisionRecord,
  Role,
} from '../server/repositories/contracts';
import { DELETE_DRAFT_CONFIRMATION } from '../shared/draft-lifecycle';
import type { DraftAction } from '../shared/draft-actions';
import type { StagingWorkflowSnapshot } from './publish/workflow';
import type { FeedbackAvailability, FeedbackScreen } from '../shared/feedback';

export interface ActorResponse {
  email: string;
  displayName?: string;
  role: Role;
  repositoryPermission?: 'admin' | 'maintain' | 'write' | 'triage' | 'read';
}

export interface MediaItem {
  id: string;
  filename: string;
  displayName: string;
  tags: string[];
  contentType: string;
  byteSize: number;
  width: number;
  height: number;
  altText: string;
  status: string;
  createdAt: string;
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

export interface CapacityReport {
  privateMedia: { used: number; limit: number; percent: number; warning: boolean; unit: string };
  revisionData: { used: number; limit: number; percent: number; warning: boolean; unit: string };
  writesToday: { used: number; limit: number; percent: number; warning: boolean; unit: string };
  measuredAt: string;
}

export interface CandidateTuple {
  siteId: 'pointsite';
  revisionId: string;
  revisionChecksum: string;
  schemaVersion: number;
  rendererVersion: string;
  candidateChecksum: string;
  stagingBaseSha: string;
  stagingCommitSha: string;
  productionBaseSha: string;
}

export interface StagingPublishResult {
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
  listDrafts: async () => (await request<{ items: DraftRecord[] }>('/drafts')).items,
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
  ) =>
    request<DraftRecord>(`/drafts/${id}`, {
      method: 'PUT',
      headers: mutationHeaders(idempotencyKey, {
        'if-match': `"${checksum}"`,
        'x-draft-checkout': checkoutToken,
      }),
      body: JSON.stringify({ document, action }),
    }),
  listCheckouts: async () =>
    (await request<{ items: DraftCheckoutAvailability[] }>('/drafts/checkouts')).items,
  ownedCheckout: () =>
    request<{ draftId: string; expiresAt: string } | null>('/drafts/checkout/owned'),
  acquireCheckout: (id: string, clientId: string) =>
    request<DraftCheckout>(`/drafts/${id}/checkout`, {
      method: 'POST',
      headers: mutationHeaders(crypto.randomUUID()),
      body: JSON.stringify({ clientId }),
    }),
  validateCheckout: (id: string, token: string) =>
    request<{ active: true }>(`/drafts/${id}/checkout`, {
      headers: { 'x-draft-checkout': token },
    }),
  touchCheckout: (id: string, clientId: string, token: string, viewState?: EditorViewState) =>
    request<DraftCheckout>(`/drafts/${id}/checkout`, {
      method: 'PATCH',
      headers: mutationHeaders(crypto.randomUUID(), { 'x-draft-checkout': token }),
      body: JSON.stringify({ clientId, ...(viewState ? { viewState } : {}) }),
    }),
  releaseCheckout: (id: string, clientId: string, token: string) =>
    request<void>(`/drafts/${id}/checkout`, {
      method: 'DELETE',
      headers: mutationHeaders(crypto.randomUUID(), { 'x-draft-checkout': token }),
      body: JSON.stringify({ clientId }),
    }),
  renameDraft: (id: string, name: string) =>
    request<DraftRecord>(`/drafts/${id}`, {
      method: 'PATCH',
      headers: mutationHeaders(crypto.randomUUID()),
      body: JSON.stringify({ name }),
    }),
  setDraftStatus: (id: string, action: 'archive' | 'recover' | 'delete') =>
    request<DraftRecord>(`/drafts/${id}`, {
      method: action === 'delete' ? 'DELETE' : 'PATCH',
      headers: mutationHeaders(crypto.randomUUID()),
      body:
        action === 'delete'
          ? JSON.stringify({ confirmation: DELETE_DRAFT_CONFIRMATION })
          : JSON.stringify({ status: action === 'archive' ? 'archived' : 'active' }),
    }),
  listRevisions: async (id: string) =>
    (await request<{ items: RevisionRecord[] }>(`/drafts/${id}/revisions`)).items,
  labelRevision: (draftId: string, revisionId: string, label: string) =>
    request<RevisionRecord>(`/drafts/${draftId}/revisions/${revisionId}`, {
      method: 'PATCH',
      headers: mutationHeaders(crypto.randomUUID()),
      body: JSON.stringify({ label }),
    }),
  restoreRevision: (draftId: string, revisionId: string, expectedChecksum: string) =>
    request<DraftRecord>(`/drafts/${draftId}/restore`, {
      method: 'POST',
      headers: mutationHeaders(crypto.randomUUID()),
      body: JSON.stringify({ revisionId, expectedChecksum }),
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
  ) =>
    request<StagingPublishResult>('/publish/staging', {
      method: 'POST',
      headers: mutationHeaders(`staging-${expectedRevisionId}-${expectedBaseSha}`),
      body: JSON.stringify({
        draftId,
        expectedRevisionId,
        expectedRevisionChecksum,
        expectedBaseSha,
      }),
    }),
  refreshStagingVerification: (jobId: string) =>
    request<PublishJobResponse>(`/publish/jobs/${jobId}/verification`, {
      method: 'POST',
      headers: mutationHeaders(crypto.randomUUID()),
      body: '{}',
    }),
  productionBase: () => request<{ sha: string }>('/approvals/production-base'),
  acceptStaging: (publishJobId: string, expectedTuple: CandidateTuple, note?: string) =>
    request<{ id: string; decision: string; tuple: CandidateTuple }>('/approvals', {
      method: 'POST',
      headers: mutationHeaders(crypto.randomUUID()),
      body: JSON.stringify({
        publishJobId,
        expectedTuple,
        decision: 'approved',
        ...(note ? { note } : {}),
      }),
    }),
  listMedia: async () => (await request<{ items: MediaItem[] }>('/media')).items,
  uploadMedia: (file: File, altText: string) => {
    const body = new FormData();
    body.set('file', file);
    body.set('altText', altText);
    return request<MediaItem>('/media', {
      method: 'POST',
      headers: { 'idempotency-key': crypto.randomUUID() },
      body,
    });
  },
  updateMedia: (
    id: string,
    input: Pick<MediaItem, 'filename' | 'displayName' | 'altText' | 'tags'>,
  ) =>
    request<MediaItem>(`/media/${id}`, {
      method: 'PATCH',
      headers: mutationHeaders(crypto.randomUUID()),
      body: JSON.stringify(input),
    }),
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
