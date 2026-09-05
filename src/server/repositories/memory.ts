/* eslint-disable @typescript-eslint/require-await -- async parity with the D1 repository is intentional */

import { checksumDocument } from '../../site-kit/canonicalize';
import { SiteDocumentSchema } from '../../site-kit/schema';
import type {
  AuditEventRecord,
  CreateDraftInput,
  DraftRecord,
  DraftRepository,
  DraftStatus,
  RestoreRevisionInput,
  RevisionRecord,
  SaveDraftInput,
} from './contracts';

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class InMemoryRepository implements DraftRepository {
  readonly #drafts = new Map<string, DraftRecord>();
  readonly #revisions = new Map<string, RevisionRecord[]>();
  readonly #idempotency = new Map<string, DraftRecord>();
  readonly #audit: AuditEventRecord[] = [];

  get auditEvents(): AuditEventRecord[] {
    return clone(this.#audit);
  }

  async listDrafts(status?: DraftStatus): Promise<DraftRecord[]> {
    return [...this.#drafts.values()]
      .filter((draft) => !status || draft.status === status)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(clone);
  }

  async getDraft(id: string): Promise<DraftRecord> {
    const draft = this.#drafts.get(id);
    if (!draft) throw new NotFoundError(`Draft ${id} was not found`);
    return clone(draft);
  }

  async getRevision(id: string): Promise<RevisionRecord> {
    for (const revisions of this.#revisions.values()) {
      const revision = revisions.find((candidate) => candidate.id === id);
      if (revision) return clone(revision);
    }
    throw new NotFoundError(`Revision ${id} was not found`);
  }

  async createDraft(input: CreateDraftInput): Promise<DraftRecord> {
    const operationKey = `draft.create:${input.actor}:${input.idempotencyKey}`;
    const prior = this.#idempotency.get(operationKey);
    if (prior) return clone(prior);

    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const document = SiteDocumentSchema.parse(clone(input.document));
    const revision: RevisionRecord = {
      id: crypto.randomUUID(),
      draftId: id,
      sequence: 1,
      parentRevisionId: null,
      checksum: await checksumDocument(document),
      document,
      label: 'Initial PointSite import',
      schemaVersion: document.schemaVersion,
      rendererVersion: document.rendererVersion,
      createdBy: input.actor,
      createdAt: now,
    };
    const draft: DraftRecord = {
      id,
      siteId: 'pointsite',
      name: input.name,
      status: 'active',
      latestRevisionId: revision.id,
      revision,
      document,
      createdBy: input.actor,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    this.#drafts.set(id, clone(draft));
    this.#revisions.set(id, [clone(revision)]);
    this.#idempotency.set(operationKey, clone(draft));
    this.#recordAudit(input.actor, 'draft.create', id, input.requestId, {
      revisionId: revision.id,
      sequence: revision.sequence,
    });
    return clone(draft);
  }

  async saveDraft(input: SaveDraftInput): Promise<DraftRecord> {
    const operationKey = `draft.save:${input.actor}:${input.idempotencyKey}`;
    const prior = this.#idempotency.get(operationKey);
    if (prior) return clone(prior);

    const current = this.#drafts.get(input.draftId);
    if (!current) throw new NotFoundError(`Draft ${input.draftId} was not found`);
    if (current.status !== 'active') throw new ConflictError('Only active drafts can be saved');
    if (current.revision.checksum !== input.expectedChecksum) {
      throw new ConflictError('The draft has a newer revision');
    }

    const document = SiteDocumentSchema.parse(clone(input.document));
    const checksum = await checksumDocument(document);
    if (checksum === current.revision.checksum) {
      this.#idempotency.set(operationKey, clone(current));
      return clone(current);
    }

    const revisions = this.#revisions.get(input.draftId) ?? [];
    const now = new Date().toISOString();
    const revision: RevisionRecord = {
      id: crypto.randomUUID(),
      draftId: input.draftId,
      sequence: revisions.length + 1,
      parentRevisionId: current.revision.id,
      checksum,
      document,
      label: input.label ?? null,
      schemaVersion: document.schemaVersion,
      rendererVersion: document.rendererVersion,
      createdBy: input.actor,
      createdAt: now,
    };
    const updated: DraftRecord = {
      ...current,
      latestRevisionId: revision.id,
      revision,
      document,
      updatedAt: now,
    };
    revisions.push(clone(revision));
    this.#revisions.set(input.draftId, revisions);
    this.#drafts.set(input.draftId, clone(updated));
    this.#idempotency.set(operationKey, clone(updated));
    this.#recordAudit(input.actor, 'draft.save', input.draftId, input.requestId, {
      revisionId: revision.id,
      sequence: revision.sequence,
    });
    return clone(updated);
  }

  async listRevisions(draftId: string): Promise<RevisionRecord[]> {
    if (!this.#drafts.has(draftId)) throw new NotFoundError(`Draft ${draftId} was not found`);
    return clone([...(this.#revisions.get(draftId) ?? [])].reverse());
  }

  async restoreRevision(input: RestoreRevisionInput): Promise<DraftRecord> {
    const revisions = this.#revisions.get(input.draftId);
    const source = revisions?.find((revision) => revision.id === input.revisionId);
    if (!source) throw new NotFoundError(`Revision ${input.revisionId} was not found`);
    return this.saveDraft({
      draftId: input.draftId,
      expectedChecksum: input.expectedChecksum,
      document: source.document,
      actor: input.actor,
      idempotencyKey: `restore:${input.idempotencyKey.slice(0, 92)}`,
      requestId: input.requestId,
      label: `Restored revision ${source.sequence}`,
    });
  }

  async labelRevision(
    draftId: string,
    revisionId: string,
    label: string,
    actor: string,
    requestId: string,
  ): Promise<RevisionRecord> {
    const revisions = this.#revisions.get(draftId);
    const index = revisions?.findIndex((revision) => revision.id === revisionId) ?? -1;
    if (!revisions || index < 0) throw new NotFoundError(`Revision ${revisionId} was not found`);
    const currentRevision = revisions[index];
    if (!currentRevision) throw new NotFoundError(`Revision ${revisionId} was not found`);
    const labeled = { ...currentRevision, label };
    revisions[index] = clone(labeled);
    const draft = this.#drafts.get(draftId);
    if (draft?.latestRevisionId === revisionId) {
      this.#drafts.set(draftId, { ...draft, revision: clone(labeled) });
    }
    this.#recordAudit(actor, 'revision.label', revisionId, requestId, { draftId });
    return clone(labeled);
  }

  async renameDraft(
    draftId: string,
    name: string,
    actor: string,
    requestId: string,
  ): Promise<DraftRecord> {
    const current = this.#drafts.get(draftId);
    if (!current) throw new NotFoundError(`Draft ${draftId} was not found`);
    if (current.status === 'deleted') throw new ConflictError('Deleted drafts cannot be renamed');
    const updated = { ...current, name, updatedAt: new Date().toISOString() };
    this.#drafts.set(draftId, clone(updated));
    this.#recordAudit(actor, 'draft.rename', draftId, requestId, {});
    return clone(updated);
  }

  async setDraftStatus(
    draftId: string,
    status: DraftStatus,
    actor: string,
    requestId: string,
  ): Promise<DraftRecord> {
    const current = this.#drafts.get(draftId);
    if (!current) throw new NotFoundError(`Draft ${draftId} was not found`);
    if (current.status === status) return clone(current);
    const allowed =
      (current.status === 'active' && (status === 'archived' || status === 'deleted')) ||
      (current.status === 'archived' && (status === 'active' || status === 'deleted'));
    if (!allowed) throw new ConflictError(`Cannot change ${current.status} draft to ${status}`);

    const now = new Date().toISOString();
    const updated = {
      ...current,
      status,
      updatedAt: now,
      deletedAt: status === 'deleted' ? now : null,
    };
    this.#drafts.set(draftId, clone(updated));
    this.#recordAudit(actor, `draft.${status}`, draftId, requestId, {
      previousStatus: current.status,
    });
    return clone(updated);
  }

  #recordAudit(
    actor: string,
    action: string,
    targetId: string,
    requestId: string,
    metadata: AuditEventRecord['metadata'],
  ) {
    this.#audit.push({
      id: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
      actor,
      action,
      targetType: 'draft',
      targetId,
      outcome: 'succeeded',
      requestId,
      metadata,
    });
  }
}
