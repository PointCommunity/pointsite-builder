import { z } from 'zod';
import { DraftActionSchema } from '../../shared/draft-actions';
import { SiteDocumentSchema } from '../../site-kit/schema';

export const PENDING_JOURNAL_DATABASE = 'pointsite-builder-pending-v1';
export const PENDING_JOURNAL_LIMIT = 32 * 1024 * 1024;
export const PENDING_JOURNAL_MAX_AGE = 7 * 86_400_000;

const ScopeSchema = z.strictObject({
  actor: z.string().min(1).max(200),
  draftId: z.uuid(),
  clientId: z.string().min(16).max(100),
});
const ChecksumSchema = z.string().regex(/^[a-f0-9]{64}$/);
const PendingActionSchema = z
  .strictObject({
    idempotencyKey: z.string().min(16).max(100),
    document: SiteDocumentSchema,
    action: DraftActionSchema,
    expectedRevisionId: z.uuid().nullable(),
    expectedChecksum: ChecksumSchema.nullable(),
    ready: z.boolean(),
    coalesceKey: z.string().max(300).optional(),
  })
  .refine((value) => (value.expectedRevisionId === null) === (value.expectedChecksum === null));
export const PendingJournalSchema = z
  .strictObject({
    version: z.literal(1),
    scope: ScopeSchema,
    baseRevisionId: z.uuid(),
    baseChecksum: ChecksumSchema,
    updatedAt: z.iso.datetime(),
    actions: z.array(PendingActionSchema).max(250),
    staged: PendingActionSchema.nullable(),
  })
  .refine((value) => value.actions.length + Number(Boolean(value.staged)) <= 250)
  .refine((value) => {
    const keys = [...value.actions, ...(value.staged ? [value.staged] : [])].map(
      (action) => action.idempotencyKey,
    );
    return new Set(keys).size === keys.length;
  });

export type PendingJournalScope = z.infer<typeof ScopeSchema>;
export type PendingJournalState = z.infer<typeof PendingJournalSchema>;

export class PendingJournalError extends Error {
  constructor(readonly code: 'unavailable' | 'quota' | 'ownership' | 'invalid' | 'expired') {
    super(`Pending recovery ${code}`);
  }
}

interface StoredJournal {
  id: string;
  owner: string;
  bytes: number;
  payload: string | null;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = indexedDB.open(PENDING_JOURNAL_DATABASE, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('pending', { keyPath: 'id' });
      request.result.createObjectStore('budget').put(0, 'bytes');
    };
    const fail = () => {
      settled = true;
      reject(new PendingJournalError('unavailable'));
    };
    request.onerror = fail;
    request.onblocked = fail;
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

/** Pending payloads only. The owner is a local writer generation, never server authority. */
export class PendingJournal {
  readonly #id: string;
  readonly #owner = crypto.randomUUID();

  static countPending(actor: string): Promise<number> {
    return PendingJournal.#actorRecords(actor, false);
  }

  static async discardPending(actor: string): Promise<void> {
    await PendingJournal.#actorRecords(actor, true);
  }

  static async prepareSignout(actor: string): Promise<boolean> {
    return (await PendingJournal.#actorRecords(actor, 'empty')) === 0;
  }

  static async #actorRecords(actor: string, clear: boolean | 'empty'): Promise<number> {
    ScopeSchema.shape.actor.parse(actor);
    const prefix = `${JSON.stringify([actor]).slice(0, -1)},`;
    const database = await openDatabase();
    try {
      return await new Promise<number>((resolve, reject) => {
        const transaction = database.transaction(
          ['pending', 'budget'],
          clear ? 'readwrite' : 'readonly',
        );
        const budget = transaction.objectStore('budget');
        const cursor = transaction
          .objectStore('pending')
          .openCursor(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
        let count = 0;
        let removed = 0;
        let hasPending = false;
        transaction.oncomplete = () => resolve(count);
        transaction.onabort = () =>
          hasPending ? resolve(count) : reject(new PendingJournalError('unavailable'));
        cursor.onsuccess = () => {
          const current = cursor.result;
          if (current) {
            const record = current.value as StoredJournal;
            if (record.payload !== null) count += 1;
            if (clear) {
              if (!Number.isSafeInteger(record.bytes) || record.bytes < 0) {
                transaction.abort();
                return;
              }
              removed += record.bytes;
              current.delete();
            }
            current.continue();
          } else if (clear) {
            if (clear === 'empty' && count > 0) {
              // Roll back every deletion. Only explicit discard may remove pending payloads.
              hasPending = true;
              transaction.abort();
              return;
            }
            const total = budget.get('bytes');
            total.onsuccess = () => {
              const used: unknown = total.result;
              if (typeof used !== 'number' || !Number.isSafeInteger(used) || used < removed) {
                transaction.abort();
                return;
              }
              budget.put(used - removed, 'bytes');
            };
          }
        };
      });
    } finally {
      database.close();
    }
  }

  readonly scope: PendingJournalScope;
  constructor(scope: PendingJournalScope) {
    this.scope = ScopeSchema.parse(scope);
    this.#id = JSON.stringify([this.scope.actor, this.scope.draftId, this.scope.clientId]);
  }

  async load(now = Date.now()): Promise<PendingJournalState | null> {
    const record = await this.#transaction(undefined);
    if (!record || record.payload === null) return null;
    try {
      if (typeof record.payload !== 'string') throw new PendingJournalError('invalid');
      if (new TextEncoder().encode(record.payload).byteLength > PENDING_JOURNAL_LIMIT)
        throw new PendingJournalError('quota');
      const state = PendingJournalSchema.parse(JSON.parse(record.payload));
      if (
        state.scope.actor !== this.scope.actor ||
        state.scope.draftId !== this.scope.draftId ||
        state.scope.clientId !== this.scope.clientId
      )
        throw new PendingJournalError('invalid');
      if (now - Date.parse(state.updatedAt) > PENDING_JOURNAL_MAX_AGE)
        throw new PendingJournalError('expired');
      if (Date.parse(state.updatedAt) > now + 60_000) throw new PendingJournalError('invalid');
      return state;
    } catch (error) {
      throw error instanceof PendingJournalError ? error : new PendingJournalError('invalid');
    }
  }

  async write(state: PendingJournalState | null): Promise<void> {
    if (
      state &&
      (state.scope.actor !== this.scope.actor ||
        state.scope.draftId !== this.scope.draftId ||
        state.scope.clientId !== this.scope.clientId)
    )
      throw new PendingJournalError('invalid');
    // ponytail: snapshots are capped at 32 MiB; use per-action records if measured typing stalls.
    const payload = state ? JSON.stringify(state) : null;
    if (payload && new TextEncoder().encode(payload).byteLength > PENDING_JOURNAL_LIMIT)
      throw new PendingJournalError('quota');
    if (state && !PendingJournalSchema.safeParse(state).success)
      throw new PendingJournalError('invalid');
    await this.#transaction(payload);
  }

  async #transaction(payload: string | null | undefined): Promise<StoredJournal | null> {
    const database = await openDatabase().catch(() => {
      throw new PendingJournalError('unavailable');
    });
    try {
      return await new Promise<StoredJournal | null>((resolve, reject) => {
        const transaction = database.transaction(['pending', 'budget'], 'readwrite');
        const pending = transaction.objectStore('pending');
        const budget = transaction.objectStore('budget');
        const read = pending.get(this.#id);
        let result: StoredJournal | null = null;
        let failure: PendingJournalError | null = null;
        const abort = (code: PendingJournalError['code']) => {
          failure = new PendingJournalError(code);
          transaction.abort();
        };
        transaction.onabort = () =>
          reject(
            failure ??
              new PendingJournalError(
                transaction.error?.name === 'QuotaExceededError' ? 'quota' : 'unavailable',
              ),
          );
        transaction.onerror = () => {
          /* onabort reports the transaction failure, not a request success. */
        };
        transaction.oncomplete = () => resolve(result);
        read.onsuccess = () => {
          const previous = read.result as StoredJournal | undefined;
          if (payload === undefined) {
            result = previous ?? null;
            pending.put(
              previous
                ? { ...previous, owner: this.#owner }
                : { id: this.#id, owner: this.#owner, bytes: 0, payload: null },
            );
            return;
          }
          if (previous?.owner !== this.#owner) {
            abort('ownership');
            return;
          }
          const total = budget.get('bytes');
          total.onsuccess = () => {
            const bytes = payload ? new TextEncoder().encode(payload).byteLength : 0;
            const used: unknown = total.result;
            if (
              typeof used !== 'number' ||
              !Number.isSafeInteger(used) ||
              !Number.isSafeInteger(previous.bytes) ||
              previous.bytes < 0 ||
              used < previous.bytes
            ) {
              abort('invalid');
              return;
            }
            const next = used - previous.bytes + bytes;
            if (next > PENDING_JOURNAL_LIMIT) {
              abort('quota');
              return;
            }
            pending.put({ id: this.#id, owner: this.#owner, bytes, payload });
            budget.put(next, 'bytes');
          };
        };
      });
    } finally {
      database.close();
    }
  }
}
