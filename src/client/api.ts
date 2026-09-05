import type { SiteDocument } from '../site-kit/types';
import type { DraftRecord, RevisionRecord, Role } from '../server/repositories/contracts';

export interface ActorResponse {
  email: string;
  role: Role;
}

export class ClientApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ClientApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { code?: string; message?: string };
    throw new ClientApiError(
      response.status,
      body.code ?? 'REQUEST_FAILED',
      body.message ?? 'Request failed',
    );
  }
  return await response.json();
}

function mutationHeaders(key: string, extra?: HeadersInit): HeadersInit {
  return { 'content-type': 'application/json', 'idempotency-key': key, ...extra };
}

export const api = {
  me: () => request<ActorResponse>('/me'),
  listDrafts: async () => (await request<{ items: DraftRecord[] }>('/drafts')).items,
  getDraft: (id: string) => request<DraftRecord>(`/drafts/${id}`),
  createDraft: (name: string, fromRevisionId?: string) =>
    request<DraftRecord>('/drafts', {
      method: 'POST',
      headers: mutationHeaders(crypto.randomUUID()),
      body: JSON.stringify({ name, ...(fromRevisionId ? { fromRevisionId } : {}) }),
    }),
  saveDraft: (id: string, checksum: string, document: SiteDocument) =>
    request<DraftRecord>(`/drafts/${id}`, {
      method: 'PUT',
      headers: mutationHeaders(crypto.randomUUID(), { 'if-match': `"${checksum}"` }),
      body: JSON.stringify({ document }),
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
          ? '{}'
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
  publishStaging: (draftId: string, expectedBaseSha: string) =>
    request<{ commitSha: string; candidateChecksum: string; url: string }>('/publish/staging', {
      method: 'POST',
      headers: mutationHeaders(crypto.randomUUID()),
      body: JSON.stringify({ draftId, expectedBaseSha }),
    }),
};
