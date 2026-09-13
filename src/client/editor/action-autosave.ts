import type { SiteDocument } from '../../site-kit/types';
import type { DraftRecord } from '../../server/repositories/contracts';
import type { DraftAction } from '../../shared/draft-actions';
import {
  PendingJournalError,
  type PendingJournal,
  type PendingJournalState,
} from './pending-journal';

export type AutosaveState =
  'saved' | 'pending' | 'saving' | 'offline' | 'retrying' | 'conflict' | 'validation' | 'error';

export type AutosaveErrorKind =
  'queue-limit' | 'document-too-large' | 'conflict' | 'validation' | 'transient' | null;

export interface AutosaveMutation extends DraftAction {
  boundary?: 'immediate' | 'text';
  coalesceKey?: string;
}

export interface AutosavePersistRequest {
  document: SiteDocument;
  action: DraftAction;
  expectedChecksum: string;
  expectedRevisionId: string;
  idempotencyKey: string;
}

export interface AutosaveSnapshot {
  draft: DraftRecord;
  document: SiteDocument;
  state: AutosaveState;
  pendingCount: number;
  canLeave: boolean;
  message: string;
  alert: string | null;
  errorKind: AutosaveErrorKind;
  recovery:
    | 'disabled'
    | 'checking'
    | 'clearing'
    | 'writing'
    | 'protected'
    | 'ready'
    | 'unavailable'
    | 'blocked';
  recoveryMessage: string | null;
}

interface QueueEntry extends AutosavePersistRequest {
  attempt: number;
  ready: boolean;
  coalesceKey?: string;
}

interface ControllerOptions {
  initialDraft: DraftRecord;
  persist: (request: AutosavePersistRequest) => Promise<DraftRecord>;
  isOnline?: () => boolean;
  createId?: () => string;
  textDelayMs?: number;
  maxQueue?: number;
  retryDelaysMs?: readonly number[];
  journal?: Pick<PendingJournal, 'load' | 'write' | 'scope'>;
  recoveryUnavailable?: boolean;
}

function messageFor(
  state: AutosaveState,
  count: number,
  errorKind: AutosaveErrorKind,
): { message: string; alert: string | null } {
  if (state === 'saved') return { message: 'All changes saved', alert: null };
  if (state === 'pending')
    return {
      message: `${count} ${count === 1 ? 'change' : 'changes'} waiting to save`,
      alert: null,
    };
  if (state === 'saving') return { message: 'Saving changes…', alert: null };
  if (state === 'retrying') return { message: 'Save interrupted. Retrying…', alert: null };
  if (state === 'offline') return { message: 'Offline—changes are waiting to save.', alert: null };
  if (state === 'conflict')
    return {
      message: 'A newer draft version is available.',
      alert:
        'Autosave stopped because this draft changed elsewhere. Copy your pending draft before loading the latest version.',
    };
  if (state === 'validation')
    return {
      message: 'A change needs attention before it can save.',
      alert:
        errorKind === 'document-too-large'
          ? 'This draft is too large to save. Reduce its content, then retry autosave.'
          : 'Autosave stopped because the draft did not pass validation. Correct the draft, then retry autosave.',
    };
  return {
    message: 'Changes are not saved yet.',
    alert:
      errorKind === 'queue-limit'
        ? 'Autosave is holding 250 changes. Reconnect or resolve the save failure before editing further.'
        : 'Autosave could not finish after three retries. Retry when the connection is stable.',
  };
}

export class ActionAutosaveController {
  readonly #persist: ControllerOptions['persist'];
  readonly #isOnline: () => boolean;
  readonly #createId: () => string;
  readonly #textDelayMs: number;
  readonly #maxQueue: number;
  readonly #retryDelaysMs: readonly number[];
  readonly #listeners = new Set<() => void>();
  #queue: QueueEntry[] = [];
  #inFlight: QueueEntry | null = null;
  #draft: DraftRecord;
  #renamed: Pick<DraftRecord, 'name' | 'updatedAt'> | null = null;
  #document: SiteDocument;
  #state: AutosaveState = 'saved';
  #errorKind: AutosaveErrorKind = null;
  #textTimer: ReturnType<typeof setTimeout> | null = null;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #snapshot: AutosaveSnapshot;
  #disposed = false;
  readonly #journal: ControllerOptions['journal'];
  #recovery: AutosaveSnapshot['recovery'];
  #journalInitialized = false;
  #journalStarted = false;
  #journalVersion = 0;
  #journalSavedVersion = 0;
  #journalNext: { state: PendingJournalState | null; version: number } | null = null;
  #journalWriting = false;
  #journalTask: Promise<void> | null = null;
  #journalHasPayload = false;
  #discarding = false;
  #staged: QueueEntry | null = null;

  constructor(options: ControllerOptions) {
    this.#draft = structuredClone(options.initialDraft);
    this.#document = structuredClone(options.initialDraft.document);
    this.#persist = options.persist;
    this.#isOnline = options.isOnline ?? (() => navigator.onLine);
    this.#createId = options.createId ?? (() => crypto.randomUUID());
    this.#textDelayMs = options.textDelayMs ?? 1_000;
    this.#maxQueue = options.maxQueue ?? 250;
    this.#retryDelaysMs = options.retryDelaysMs ?? [1_000, 2_000, 4_000];
    this.#journal = options.journal;
    this.#recovery = options.journal
      ? 'checking'
      : options.recoveryUnavailable
        ? 'unavailable'
        : 'disabled';
    this.#snapshot = this.#makeSnapshot();
  }

  get snapshot(): AutosaveSnapshot {
    return this.#snapshot;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  mutate(update: (document: SiteDocument) => SiteDocument, mutation: AutosaveMutation): boolean {
    const next = update(structuredClone(this.#document));
    return this.complete(next, mutation);
  }

  stage(
    document: SiteDocument,
    mutation: AutosaveMutation = { category: 'control-change', context: 'page-content' },
    renderDocument = true,
  ): void {
    if (this.#discarding || this.#recovery === 'checking' || this.#recovery === 'blocked') return;
    if (this.#queue.length >= this.#maxQueue) {
      this.#state = 'error';
      this.#errorKind = 'queue-limit';
      this.#emit();
      return;
    }
    if (renderDocument) this.#document = structuredClone(document);
    if (
      JSON.stringify(document) ===
      JSON.stringify(this.#queue.at(-1)?.document ?? this.#draft.document)
    )
      this.#staged = null;
    else {
      this.#staged ??= this.#entry(document, mutation, false);
      this.#staged.document = structuredClone(document);
      this.#staged.action = { category: mutation.category, context: mutation.context };
    }
    if (!['conflict', 'validation', 'error'].includes(this.#state))
      this.#state = this.#staged ? 'pending' : this.#queue.length ? this.#state : 'saved';
    this.#scheduleJournal();
    this.#emit();
  }

  complete(document: SiteDocument, mutation: AutosaveMutation): boolean {
    if (this.#discarding || this.#recovery === 'checking' || this.#recovery === 'blocked')
      return false;
    this.#staged = null;
    if (this.#state === 'validation' && this.#queue[0] && !this.#inFlight) {
      const head = this.#queue[0];
      this.#document = structuredClone(document);
      head.document = structuredClone(document);
      head.action = { category: mutation.category, context: mutation.context };
      head.attempt = 0;
      head.idempotencyKey = this.#createId();
      head.expectedChecksum = '';
      head.expectedRevisionId = '';
      head.ready = (mutation.boundary ?? 'immediate') !== 'text';
      head.coalesceKey = mutation.coalesceKey;
      this.#state = this.#isOnline() ? 'pending' : 'offline';
      this.#errorKind = null;
      this.#scheduleJournal();
      if (head.ready) void this.#pump();
      else this.#scheduleTextFlush();
      this.#emit();
      return true;
    }
    if (this.#queue.length >= this.#maxQueue) {
      this.#state = 'error';
      this.#errorKind = 'queue-limit';
      this.#emit();
      return false;
    }

    this.#document = structuredClone(document);
    const boundary = mutation.boundary ?? 'immediate';
    if (boundary === 'text') {
      const tail = this.#queue.at(-1);
      if (
        tail &&
        !tail.ready &&
        tail.coalesceKey === mutation.coalesceKey &&
        tail.action.context === mutation.context
      ) {
        tail.document = structuredClone(document);
        tail.action = { category: mutation.category, context: mutation.context };
      } else {
        this.flushTextAction();
        this.#queue.push(this.#entry(document, mutation, false));
      }
      this.#scheduleTextFlush();
      this.#setWaitingState();
      return true;
    }

    this.flushTextAction();
    this.#queue.push(this.#entry(document, mutation, true));
    this.#setWaitingState();
    void this.#pump();
    return true;
  }

  flushTextAction = (): void => {
    if (this.#textTimer) clearTimeout(this.#textTimer);
    this.#textTimer = null;
    let changed = false;
    for (const entry of this.#queue) {
      if (!entry.ready) {
        entry.ready = true;
        changed = true;
      }
    }
    if (changed) {
      this.#setWaitingState();
      void this.#pump();
    }
  };

  setOnline(online: boolean): void {
    if (!online) {
      if (this.#queue.length > 0) {
        this.#state = 'offline';
        this.#emit();
      }
      return;
    }
    if (this.#state === 'offline' || this.#errorKind === 'queue-limit') {
      this.#state = 'pending';
      this.#errorKind = null;
      this.#emit();
      void this.#pump();
    }
  }

  retry = (): void => {
    if (this.#discarding || this.#recovery === 'checking') return;
    if (this.#journal && !this.#journalInitialized) {
      void this.#loadJournal();
      return;
    }
    if (this.#journal && this.#recovery === 'unavailable') this.#scheduleJournal();
    if (this.#state === 'conflict') return;
    const head = this.#queue[0];
    if (!head) return;
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    head.attempt = 0;
    this.#state = this.#isOnline() ? 'pending' : 'offline';
    this.#errorKind = null;
    this.#emit();
    void this.#pump();
  };

  replaceWithLatest(draft: DraftRecord): void {
    this.#clearTimers();
    this.#queue = [];
    this.#staged = null;
    this.#inFlight = null;
    this.#draft = structuredClone(draft);
    this.#renamed = null;
    this.#document = structuredClone(draft.document);
    this.#state = 'saved';
    this.#errorKind = null;
    this.#scheduleJournal();
    this.#emit();
  }

  async discardAndReplace(loadLatest: () => Promise<DraftRecord>): Promise<void> {
    if (this.#inFlight || this.#discarding || this.#recovery === 'checking')
      throw new Error('Wait for the current save to finish before discarding pending work.');
    this.#discarding = true;
    this.#emit();
    try {
      const draft = await loadLatest();
      if (this.#journal) {
        // Let earlier snapshots settle before removing the payload the user chose to discard.
        while (this.#journalTask) await this.#journalTask;
        await this.#journal.write(null);
        this.#journalHasPayload = false;
        this.#journalInitialized = true;
        this.#recovery = 'ready';
      }
      this.replaceWithLatest(draft);
    } finally {
      this.#discarding = false;
      this.#emit();
    }
  }

  recoveryJson(): string {
    return JSON.stringify(
      {
        draftName: this.#draft.name,
        document: this.#staged?.document ?? this.#document,
        pendingActions: [...this.#queue, ...(this.#staged ? [this.#staged] : [])].map(
          ({ action, idempotencyKey }) => ({
            idempotencyKey,
            ...action,
          }),
        ),
      },
      null,
      2,
    );
  }

  updateDraftName(draft: Pick<DraftRecord, 'id' | 'name' | 'updatedAt'>): void {
    if (draft.id !== this.#draft.id) throw new Error('Rename response belongs to another draft');
    this.#renamed = { name: draft.name, updatedAt: draft.updatedAt };
    this.#draft = this.#withConfirmedName(this.#draft);
    this.#emit();
  }

  #withConfirmedName(draft: DraftRecord): DraftRecord {
    if (!this.#renamed) return draft;
    return {
      ...draft,
      name: this.#renamed.name,
      updatedAt:
        draft.updatedAt > this.#renamed.updatedAt ? draft.updatedAt : this.#renamed.updatedAt,
    };
  }

  activate(): void {
    this.#disposed = false;
    // React may discard a constructed controller without ever mounting it.
    if (this.#journal && !this.#journalStarted) {
      this.#journalStarted = true;
      void this.#loadJournal();
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#clearTimers();
    this.#listeners.clear();
  }

  #entry(document: SiteDocument, mutation: AutosaveMutation, ready: boolean): QueueEntry {
    return {
      document: structuredClone(document),
      action: { category: mutation.category, context: mutation.context },
      expectedChecksum: '',
      expectedRevisionId: '',
      idempotencyKey: this.#createId(),
      attempt: 0,
      ready,
      ...(mutation.coalesceKey ? { coalesceKey: mutation.coalesceKey } : {}),
    };
  }

  #scheduleTextFlush(): void {
    if (this.#textTimer) clearTimeout(this.#textTimer);
    this.#textTimer = setTimeout(this.flushTextAction, this.#textDelayMs);
  }

  #setWaitingState(): void {
    this.#scheduleJournal();
    if (['conflict', 'validation', 'error'].includes(this.#state)) {
      this.#emit();
      return;
    }
    if (!this.#isOnline()) this.#state = 'offline';
    else if (!this.#inFlight && !this.#retryTimer) this.#state = 'pending';
    this.#errorKind = null;
    this.#emit();
  }

  async #pump(): Promise<void> {
    if (this.#disposed || this.#discarding || this.#inFlight || this.#retryTimer) return;
    if (this.#recovery === 'checking' || this.#recovery === 'blocked') return;
    if (['conflict', 'validation', 'error'].includes(this.#state)) return;
    const head = this.#queue[0];
    if (!head) {
      this.#state = this.#staged ? 'pending' : 'saved';
      this.#errorKind = null;
      this.#emit();
      return;
    }
    if (!head.ready) {
      this.#state = 'pending';
      this.#emit();
      return;
    }
    if (!this.#isOnline()) {
      this.#state = 'offline';
      this.#emit();
      return;
    }

    if (!head.expectedRevisionId) {
      head.expectedChecksum = this.#draft.revision.checksum;
      head.expectedRevisionId = this.#draft.latestRevisionId;
      this.#scheduleJournal();
    }
    if (
      this.#journal &&
      this.#journalSavedVersion < this.#journalVersion &&
      this.#recovery !== 'unavailable'
    )
      return;
    this.#inFlight = head;
    this.#state = 'saving';
    this.#errorKind = null;
    this.#emit();
    try {
      const saved = await this.#persist({
        document: structuredClone(head.document),
        action: head.action,
        expectedChecksum: head.expectedChecksum,
        expectedRevisionId: head.expectedRevisionId,
        idempotencyKey: head.idempotencyKey,
      });
      if (this.#queue[0] === head) this.#queue.shift();
      // Document acknowledgements can predate a confirmed metadata-only rename.
      this.#draft = this.#withConfirmedName(structuredClone(saved));
      this.#inFlight = null;
      this.#state = this.#queue.length === 0 && !this.#staged ? 'saved' : 'pending';
      this.#scheduleJournal();
      this.#emit();
      void this.#pump();
    } catch (error) {
      this.#inFlight = null;
      if (this.#disposed) return;
      const status =
        typeof error === 'object' && error && 'status' in error ? Number(error.status) : 0;
      const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
      if (!this.#isOnline()) {
        this.#state = 'offline';
      } else if (status === 412 || code === 'REVISION_CONFLICT') {
        this.#state = 'conflict';
        this.#errorKind = 'conflict';
      } else if (status === 413 || code === 'DOCUMENT_TOO_LARGE') {
        this.#state = 'validation';
        this.#errorKind = 'document-too-large';
      } else if (status === 422 || code === 'VALIDATION_FAILED') {
        this.#state = 'validation';
        this.#errorKind = 'validation';
      } else if (head.attempt < this.#retryDelaysMs.length) {
        const delay = this.#retryDelaysMs[head.attempt];
        head.attempt += 1;
        this.#state = 'retrying';
        this.#retryTimer = setTimeout(() => {
          this.#retryTimer = null;
          void this.#pump();
        }, delay);
      } else {
        this.#state = 'error';
        this.#errorKind = 'transient';
      }
      this.#emit();
    }
  }

  #clearTimers(): void {
    if (this.#textTimer) clearTimeout(this.#textTimer);
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#textTimer = null;
    this.#retryTimer = null;
  }

  #makeSnapshot(): AutosaveSnapshot {
    const pendingCount = this.#queue.length + Number(Boolean(this.#staged));
    const status = messageFor(this.#state, pendingCount, this.#errorKind);
    return {
      draft: this.#draft,
      document: this.#document,
      state: this.#state,
      pendingCount,
      canLeave:
        pendingCount === 0 &&
        !this.#inFlight &&
        !this.#discarding &&
        !this.#journalWriting &&
        !this.#journalHasPayload &&
        this.#recovery !== 'checking' &&
        this.#recovery !== 'blocked',
      message: status.message,
      alert: status.alert,
      errorKind: this.#errorKind,
      recovery: this.#discarding ? 'clearing' : this.#recovery,
      recoveryMessage:
        this.#recovery === 'checking'
          ? 'Checking this browser for pending changes…'
          : this.#recovery === 'blocked'
            ? 'Pending recovery needs attention. Reopen this draft to retry, or explicitly discard its recovery copy.'
            : this.#recovery === 'unavailable'
              ? pendingCount
                ? 'Refresh recovery is unavailable. Keep this tab open until all changes are saved remotely.'
                : this.#journalHasPayload
                  ? 'Changes are saved remotely, but the browser recovery copy could not be cleared. Retry recovery before leaving.'
                  : 'Refresh recovery is unavailable. Current changes are saved remotely.'
              : this.#recovery === 'writing'
                ? pendingCount
                  ? 'Protecting pending changes on this browser…'
                  : 'Clearing the acknowledged recovery copy…'
                : this.#recovery === 'protected'
                  ? 'Pending changes are protected on this browser; they are not all saved remotely yet.'
                  : null,
    };
  }

  async #loadJournal(): Promise<void> {
    if (!this.#journal) return;
    this.#recovery = 'checking';
    this.#emit();
    try {
      const stored = await this.#journal.load();
      this.#journalHasPayload = Boolean(stored);
      this.#journalInitialized = true;
      this.#recovery = 'ready';
      if (stored) {
        const actions = [...stored.actions, ...(stored.staged ? [stored.staged] : [])];
        this.#queue = actions.map((entry, index) => ({
          ...entry,
          ready: true,
          attempt: 0,
          expectedRevisionId:
            entry.expectedRevisionId ?? (index === 0 ? stored.baseRevisionId : ''),
          expectedChecksum: entry.expectedChecksum ?? (index === 0 ? stored.baseChecksum : ''),
        }));
        this.#document = structuredClone(this.#queue.at(-1)?.document ?? this.#draft.document);
        this.#state = this.#queue.length ? 'pending' : 'saved';
        this.#scheduleJournal();
      }
      this.#emit();
      void this.#pump();
    } catch {
      this.#recovery = 'blocked';
      this.#emit();
    }
  }

  #scheduleJournal(): void {
    if (!this.#journal || !this.#journalInitialized) return;
    const action = (entry: QueueEntry) => ({
      document: entry.document,
      action: entry.action,
      idempotencyKey: entry.idempotencyKey,
      expectedRevisionId: entry.expectedRevisionId || null,
      expectedChecksum: entry.expectedChecksum || null,
      ready: entry.ready,
      ...(entry.coalesceKey ? { coalesceKey: entry.coalesceKey } : {}),
    });
    const state: PendingJournalState | null =
      this.#queue.length || this.#staged
        ? {
            version: 1,
            scope: this.#journal.scope,
            baseRevisionId: this.#draft.latestRevisionId,
            baseChecksum: this.#draft.revision.checksum,
            updatedAt: new Date().toISOString(),
            actions: this.#queue.map(action),
            staged: this.#staged ? action(this.#staged) : null,
          }
        : null;
    this.#journalNext = { state, version: ++this.#journalVersion };
    this.#recovery = 'writing';
    if (!this.#journalWriting) this.#journalTask = this.#writeJournal();
  }

  async #writeJournal(): Promise<void> {
    if (!this.#journal) return;
    this.#journalWriting = true;
    while (this.#journalNext) {
      const next = this.#journalNext;
      this.#journalNext = null;
      try {
        await this.#journal.write(next.state);
        this.#journalHasPayload = Boolean(next.state);
        this.#journalSavedVersion = next.version;
        this.#recovery = this.#journalNext ? 'writing' : next.state ? 'protected' : 'ready';
      } catch (error) {
        this.#recovery =
          error instanceof PendingJournalError && error.code === 'ownership'
            ? 'blocked'
            : 'unavailable';
        this.#journalNext = null;
        break;
      }
    }
    this.#journalWriting = false;
    this.#journalTask = null;
    this.#emit();
    void this.#pump();
  }

  #emit(): void {
    this.#snapshot = this.#makeSnapshot();
    for (const listener of this.#listeners) listener();
  }
}
