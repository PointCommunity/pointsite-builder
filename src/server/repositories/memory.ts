/* eslint-disable @typescript-eslint/require-await -- async parity with the D1 repository is intentional */

import { canonicalize, checksumDocument } from '../../site-kit/canonicalize';
import { migrateDocument } from '../../site-kit/migrations';
import { checkoutExpiry } from '../../shared/draft-checkout';
import { createRequestHash, saveRequestHash } from './request-hash';
import type {
  AuditEventRecord,
  AcquireCheckoutCommand,
  CheckoutCommand,
  CreateDraftInput,
  DeletedDraftReceipt,
  DraftRecord,
  DraftCheckout,
  DraftCheckoutAvailability,
  DraftRepository,
  DraftStatus,
  RestoreRevisionInput,
  RevisionRecord,
  SaveDraftInput,
  EditorViewState,
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
  readonly #idempotency = new Map<string, DraftRecord | null>();
  readonly #requestHashes = new Map<string, string>();
  readonly #audit: AuditEventRecord[] = [];
  readonly #checkouts = new Map<
    string,
    Omit<DraftCheckout, 'token' | 'event' | 'viewState'> & { tokenHash: string }
  >();
  readonly #viewStates = new Map<string, EditorViewState>();

  get auditEvents(): AuditEventRecord[] {
    return clone(this.#audit);
  }

  async listDrafts(status?: DraftStatus): Promise<DraftRecord[]> {
    return [...this.#drafts.values()]
      .filter((draft) => (status ? draft.status === status : draft.status !== 'deleted'))
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
    const document = migrateDocument(clone(input.document)).document;
    const [requestHash, checksum] = await Promise.all([
      createRequestHash(input),
      checksumDocument(document),
    ]);
    const prior = this.#idempotency.get(operationKey);
    if (prior === null)
      throw new ConflictError('This request belongs to a permanently deleted draft');
    if (prior) {
      if (this.#requestHashes.get(operationKey) !== requestHash)
        throw new ConflictError('This request identity was already used with different input');
      return clone(prior);
    }

    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const revision: RevisionRecord = {
      id: crypto.randomUUID(),
      draftId: id,
      sequence: 1,
      parentRevisionId: null,
      checksum,
      document,
      label: 'Initial PointSite import',
      schemaVersion: document.schemaVersion,
      rendererVersion: document.rendererVersion,
      createdBy: input.actor,
      createdAt: now,
      actionCategory: 'add',
      actionContext: 'draft',
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
    this.#requestHashes.set(operationKey, requestHash);
    this.#recordAudit(input.actor, 'draft.create', id, input.requestId, {
      revisionId: revision.id,
      sequence: revision.sequence,
    });
    return clone(draft);
  }

  async saveDraft(input: SaveDraftInput): Promise<DraftRecord> {
    const document = migrateDocument(clone(input.document)).document;
    const [requestHash, checksum, checkoutHash] = await Promise.all([
      saveRequestHash(input),
      checksumDocument(document),
      input.checkoutToken ? hashToken(input.checkoutToken) : Promise.resolve(null),
    ]);
    if (checkoutHash) this.#checkedCheckout(input.draftId, input.actor, checkoutHash);
    const current = this.#drafts.get(input.draftId);
    if (!current) throw new NotFoundError(`Draft ${input.draftId} was not found`);
    if (current.status !== 'active') throw new ConflictError('Only active drafts can be saved');
    const operationKey = `draft.save:${input.actor}:${input.idempotencyKey}`;
    const prior = this.#idempotency.get(operationKey);
    if (prior === null) throw new NotFoundError(`Draft ${input.draftId} was not found`);
    if (prior) {
      if (this.#requestHashes.get(operationKey) !== requestHash)
        throw new ConflictError('This request identity was already used with different input');
      return clone(prior);
    }

    if (input.expectedRevisionId && input.expectedRevisionId !== current.revision.id)
      throw new ConflictError('The draft has a newer revision');

    if (current.revision.checksum !== input.expectedChecksum) {
      throw new ConflictError('The draft has a newer revision');
    }

    if (checksum === current.revision.checksum) {
      this.#idempotency.set(operationKey, clone(current));
      this.#requestHashes.set(operationKey, requestHash);
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
      actionCategory: input.action.category,
      actionContext: input.action.context,
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
    this.#requestHashes.set(operationKey, requestHash);
    this.#recordAudit(input.actor, 'draft.save', input.draftId, input.requestId, {
      sequence: revision.sequence,
      actionCategory: input.action.category,
      actionContext: input.action.context,
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
      action: { category: 'restore', context: 'revision-history' },
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
    if ((await this.getDraft(draftId)).status !== 'active')
      throw new ConflictError('Only active drafts can be edited');
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
    if (current.status !== 'active') throw new ConflictError('Only active drafts can be renamed');
    const updated = { ...current, name, updatedAt: new Date().toISOString() };
    this.#drafts.set(draftId, clone(updated));
    this.#recordAudit(actor, 'draft.rename', draftId, requestId, {});
    return clone(updated);
  }

  async setDraftStatus(
    draftId: string,
    status: Exclude<DraftStatus, 'deleted'>,
    actor: string,
    requestId: string,
  ): Promise<DraftRecord> {
    const current = this.#drafts.get(draftId);
    if (!current) throw new NotFoundError(`Draft ${draftId} was not found`);
    if (current.status === status) return clone(current);
    const allowed =
      (current.status === 'active' && status === 'archived') ||
      (current.status === 'archived' && status === 'active');
    if (!allowed) throw new ConflictError(`Cannot change ${current.status} draft to ${status}`);

    const now = new Date().toISOString();
    const updated = {
      ...current,
      status,
      updatedAt: now,
      deletedAt: null,
    };
    this.#drafts.set(draftId, clone(updated));
    if (status === 'archived') this.#clearEditorState(draftId);
    this.#recordAudit(actor, `draft.${status}`, draftId, requestId, {
      previousStatus: current.status,
    });
    return clone(updated);
  }

  async purgeDraft(
    draftId: string,
    actor: string,
    requestId: string,
  ): Promise<DeletedDraftReceipt> {
    const current = await this.getDraft(draftId);
    if (current.status !== 'archived')
      throw new ConflictError('Only archived drafts can be deleted');
    const revisionIds = new Set(
      (this.#revisions.get(draftId) ?? []).map((revision) => revision.id),
    );
    this.#drafts.delete(draftId);
    this.#revisions.delete(draftId);
    this.#clearEditorState(draftId);
    for (const [key, value] of this.#idempotency) {
      if (value?.id === draftId) this.#idempotency.set(key, null);
    }
    for (let index = this.#audit.length - 1; index >= 0; index--) {
      const event = this.#audit[index];
      if (
        event.targetId === draftId ||
        revisionIds.has(event.targetId) ||
        event.metadata.draftId === draftId
      )
        this.#audit.splice(index, 1);
    }
    this.#recordAudit(actor, 'draft.deleted', draftId, requestId, {});
    return { id: draftId, status: 'deleted', deletedAt: new Date().toISOString() };
  }

  #clearEditorState(draftId: string): void {
    this.#checkouts.delete(draftId);
    for (const [actor, state] of this.#viewStates) {
      if (state.draftId === draftId) this.#viewStates.delete(actor);
    }
  }

  async listCheckoutAvailability(
    actor: string,
    now = new Date().toISOString(),
  ): Promise<DraftCheckoutAvailability[]> {
    return [...this.#drafts.values()]
      .filter((draft) => draft.status !== 'deleted')
      .map((draft) => {
        const lease = this.#checkouts.get(draft.id);
        if (!lease || lease.expiresAt <= now)
          return { draftId: draft.id, state: 'available' as const, expiresAt: null };
        return {
          draftId: draft.id,
          state:
            lease.actor.toLowerCase() === actor.toLowerCase()
              ? ('owned' as const)
              : ('unavailable' as const),
          expiresAt: lease.expiresAt,
        };
      });
  }

  async acquireCheckout(input: AcquireCheckoutCommand): Promise<DraftCheckout> {
    const token = crypto.randomUUID();
    const tokenHash = await hashToken(token);
    const draft = this.#drafts.get(input.draftId);
    if (!draft) throw new NotFoundError(`Draft ${input.draftId} was not found`);
    if (draft.status !== 'active') throw new ConflictError('Only active drafts can be checked out');
    const now = input.now ?? new Date().toISOString();
    const current = this.#checkouts.get(input.draftId);
    if (
      input.resumeOnly &&
      (!current ||
        current.expiresAt <= now ||
        current.actor.toLowerCase() !== input.actor.toLowerCase() ||
        current.clientId !== input.clientId)
    )
      throw new ConflictError('This editing client no longer owns the draft checkout');
    if (
      current &&
      current.expiresAt > now &&
      current.actor.toLowerCase() !== input.actor.toLowerCase()
    ) {
      this.#recordAudit(input.actor, 'draft.checkout.denied', input.draftId, input.requestId, {});
      throw new ConflictError('This draft is already checked out');
    }
    if (current && current.expiresAt <= now)
      this.#recordAudit(
        current.actor,
        'draft.checkout.expired',
        input.draftId,
        input.requestId,
        {},
      );
    const event =
      !current || current.expiresAt <= now
        ? 'acquired'
        : current.clientId === input.clientId
          ? 'resumed'
          : 'transferred';
    const acquiredAt = event === 'acquired' ? now : current!.acquiredAt;
    const record = {
      draftId: input.draftId,
      actor: input.actor,
      clientId: input.clientId,
      tokenHash,
      acquiredAt,
      lastActivityAt: input.resumeOnly ? current!.lastActivityAt : now,
      expiresAt: input.resumeOnly ? current!.expiresAt : checkoutExpiry(now),
    };
    this.#checkouts.set(input.draftId, record);
    this.#recordAudit(input.actor, `draft.checkout.${event}`, input.draftId, input.requestId, {});
    return { ...record, token, event, viewState: clone(this.#viewStates.get(input.actor) ?? null) };
  }

  async touchCheckout(input: CheckoutCommand, viewState?: EditorViewState): Promise<DraftCheckout> {
    const current = this.#checkedCheckout(
      input.draftId,
      input.actor,
      await hashToken(input.token),
      input.now,
    );
    if (current.clientId !== input.clientId)
      throw new ConflictError('This editing client no longer owns the draft checkout');
    const now = input.now ?? new Date().toISOString();
    const updated =
      input.activity === false
        ? current
        : { ...current, lastActivityAt: now, expiresAt: checkoutExpiry(now) };
    this.#checkouts.set(input.draftId, updated);
    const previous = this.#viewStates.get(input.actor);
    if (
      viewState &&
      (!previous ||
        canonicalize({ ...previous, updatedAt: '' }) !==
          canonicalize({ ...viewState, draftId: input.draftId, updatedAt: '' }))
    )
      this.#viewStates.set(
        input.actor,
        clone({ ...viewState, draftId: input.draftId, updatedAt: now }),
      );
    return {
      ...updated,
      token: input.token,
      event: 'resumed',
      viewState: clone(this.#viewStates.get(input.actor) ?? null),
    };
  }

  async releaseCheckout(input: CheckoutCommand): Promise<void> {
    const tokenHash = await hashToken(input.token);
    const current = this.#checkouts.get(input.draftId);
    if (!current) return;
    this.#checkedCheckout(input.draftId, input.actor, tokenHash, input.now);
    if (current.clientId !== input.clientId)
      throw new ConflictError('This editing client no longer owns the draft checkout');
    this.#checkouts.delete(input.draftId);
    this.#recordAudit(input.actor, 'draft.checkout.released', input.draftId, input.requestId, {});
  }

  async assertCheckout(draftId: string, actor: string, token: string, now?: string): Promise<void> {
    this.#checkedCheckout(draftId, actor, await hashToken(token), now);
  }

  #checkedCheckout(
    draftId: string,
    actor: string,
    tokenHash: string,
    now = new Date().toISOString(),
  ) {
    const current = this.#checkouts.get(draftId);
    if (!current || current.expiresAt <= now || this.#drafts.get(draftId)?.status !== 'active')
      throw new ConflictError('The draft checkout expired');
    if (current.actor.toLowerCase() !== actor.toLowerCase() || current.tokenHash !== tokenHash)
      throw new ConflictError('This editing client no longer owns the draft checkout');
    return current;
  }

  async ownedCheckout(
    actor: string,
    now = new Date().toISOString(),
  ): Promise<DraftCheckout | null> {
    const current = [...this.#checkouts.values()].find(
      (lease) => lease.actor.toLowerCase() === actor.toLowerCase() && lease.expiresAt > now,
    );
    return current
      ? {
          ...current,
          token: '',
          event: 'resumed',
          viewState: clone(this.#viewStates.get(actor) ?? null),
        }
      : null;
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

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
