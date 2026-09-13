import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ActionAutosaveController,
  type AutosavePersistRequest,
} from '../../src/client/editor/action-autosave';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import type { DraftRecord } from '../../src/server/repositories/contracts';
import {
  PendingJournalError,
  type PendingJournalState,
} from '../../src/client/editor/pending-journal';

const initialDraft = (): DraftRecord => {
  const document = structuredClone(defaultSiteDocument);
  return {
    id: '10000000-0000-4000-8000-000000000001',
    siteId: 'pointsite',
    name: 'Autosave test',
    status: 'active',
    latestRevisionId: '20000000-0000-4000-8000-000000000001',
    document,
    revision: {
      id: '20000000-0000-4000-8000-000000000001',
      draftId: '10000000-0000-4000-8000-000000000001',
      sequence: 1,
      parentRevisionId: null,
      checksum: 'initial-checksum',
      document,
      label: null,
      schemaVersion: document.schemaVersion,
      rendererVersion: document.rendererVersion,
      createdBy: 'editor@pointatx.org',
      createdAt: '2026-09-07T00:00:00.000Z',
      actionCategory: null,
      actionContext: null,
    },
    createdBy: 'editor@pointatx.org',
    createdAt: '2026-09-07T00:00:00.000Z',
    updatedAt: '2026-09-07T00:00:00.000Z',
    deletedAt: null,
  };
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const savedDraft = (
  draft: DraftRecord,
  sequence: number,
  document = draft.document,
): DraftRecord => ({
  ...draft,
  document,
  latestRevisionId: `20000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
  revision: {
    ...draft.revision,
    id: `20000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
    sequence,
    checksum: `checksum-${sequence}`,
    document,
  },
});

describe('ActionAutosaveController', () => {
  it('pauses editing and sending during discard and preserves pending work if clearing fails', async () => {
    const draft = initialDraft();
    const pendingWrite = deferred<void>();
    const latest = deferred<DraftRecord>();
    const journal = {
      scope: { actor: draft.createdBy, draftId: draft.id, clientId: 'journal-browser-01' },
      load: vi.fn().mockResolvedValue(null),
      write: vi
        .fn<(state: PendingJournalState | null) => Promise<void>>()
        .mockImplementationOnce(() => pendingWrite.promise)
        .mockRejectedValue(new PendingJournalError('unavailable')),
    };
    const persist = vi.fn();
    const controller = new ActionAutosaveController({
      initialDraft: draft,
      journal,
      persist,
      isOnline: () => false,
    });
    expect(journal.load).not.toHaveBeenCalled();
    controller.activate();
    controller.dispose();
    controller.activate();
    expect(journal.load).toHaveBeenCalledOnce();
    await Promise.resolve();
    const document = structuredClone(draft.document);
    document.site.shortName = 'Keep if discard fails';
    const action = { category: 'control-change' as const, context: 'site-settings' as const };
    controller.complete(document, action);
    const discard = controller.discardAndReplace(() => latest.promise);
    expect(controller.snapshot.recovery).toBe('clearing');
    expect(controller.complete(draft.document, action)).toBe(false);
    controller.stage(draft.document, action);
    controller.setOnline(true);
    controller.retry();
    pendingWrite.resolve();
    latest.resolve(draft);
    await expect(discard).rejects.toThrow('Pending recovery unavailable');
    expect(persist).not.toHaveBeenCalled();
    expect(controller.snapshot.document.site.shortName).toBe('Keep if discard fails');
    expect(controller.snapshot.pendingCount).toBe(1);
    expect(controller.snapshot.canLeave).toBe(false);
    journal.write.mockResolvedValue(undefined);
    await controller.discardAndReplace(() => Promise.resolve(draft));
    await vi.waitFor(() => expect(controller.snapshot.canLeave).toBe(true));
    expect(controller.snapshot.document).toEqual(draft.document);
    controller.dispose();
  });

  it('keeps navigation blocked until acknowledged recovery payloads are cleared', async () => {
    const draft = initialDraft();
    const clear = deferred<void>();
    const journal = {
      scope: { actor: draft.createdBy, draftId: draft.id, clientId: 'journal-browser-01' },
      load: vi.fn().mockResolvedValue(null),
      write: vi.fn((state: PendingJournalState | null) =>
        state ? Promise.resolve() : clear.promise,
      ),
    };
    const controller = new ActionAutosaveController({
      initialDraft: draft,
      journal,
      persist: (request) => Promise.resolve(savedDraft(draft, 2, request.document)),
      isOnline: () => true,
    });
    controller.activate();
    await Promise.resolve();
    controller.complete(draft.document, { category: 'undo', context: 'page-content' });
    await vi.waitFor(() => expect(controller.snapshot.state).toBe('saved'));
    expect(controller.snapshot.canLeave).toBe(false);
    clear.resolve();
    await vi.waitFor(() => expect(controller.snapshot.canLeave).toBe(true));
    controller.dispose();
  });

  it('waits for recovery persistence before sending, then removes acknowledged payloads', async () => {
    const draft = initialDraft();
    const pendingWrite = deferred<void>();
    const journal = {
      scope: { actor: draft.createdBy, draftId: draft.id, clientId: 'journal-browser-01' },
      load: vi.fn().mockResolvedValue(null),
      write: vi
        .fn<(state: PendingJournalState | null) => Promise<void>>()
        .mockImplementationOnce(() => pendingWrite.promise)
        .mockResolvedValue(undefined),
    };
    const persist = vi.fn((request: AutosavePersistRequest) =>
      Promise.resolve(savedDraft(draft, 2, request.document)),
    );
    const controller = new ActionAutosaveController({
      initialDraft: draft,
      journal,
      persist,
      isOnline: () => true,
    });
    controller.activate();
    await Promise.resolve();
    controller.mutate(
      (document) => ({ ...document, site: { ...document.site, shortName: 'Durable first' } }),
      { category: 'control-change', context: 'site-settings' },
    );
    expect(persist).not.toHaveBeenCalled();
    expect(controller.snapshot.recovery).toBe('writing');
    pendingWrite.resolve();
    await vi.waitFor(() => expect(controller.snapshot.recovery).toBe('ready'));
    expect(persist).toHaveBeenCalledOnce();
    expect(journal.write.mock.calls.at(-1)?.[0]).toBeNull();
    expect(controller.snapshot.canLeave).toBe(true);
    controller.dispose();
  });

  it.each(['completed', 'staged', 'preview'])(
    'recovers %s work with its original identity and base after refresh',
    async (kind) => {
      const draft = initialDraft();
      let stored: PendingJournalState | null = null;
      const journal = {
        scope: { actor: draft.createdBy, draftId: draft.id, clientId: 'journal-browser-01' },
        load: () => Promise.resolve(structuredClone(stored)),
        write: (state: PendingJournalState | null) => {
          stored = structuredClone(state);
          return Promise.resolve();
        },
      };
      const offlinePersist = vi.fn();
      const first = new ActionAutosaveController({
        initialDraft: draft,
        journal,
        persist: offlinePersist,
        isOnline: () => false,
        createId: () => 'recovered-action-0001',
      });
      first.activate();
      await Promise.resolve();
      const document = structuredClone(draft.document);
      document.site.shortName = 'Pending after refresh';
      const action = { category: 'resize' as const, context: 'element-layout' as const };
      if (kind !== 'completed') first.stage(document, action, kind !== 'preview');
      else first.complete(document, action);
      if (kind === 'preview') expect(first.snapshot.document).toEqual(draft.document);
      expect(JSON.parse(first.recoveryJson())).toMatchObject({
        document,
        pendingActions: [{ idempotencyKey: 'recovered-action-0001', ...action }],
      });
      expect(first.snapshot.canLeave).toBe(false);
      await vi.waitFor(() => expect(first.snapshot.recovery).toBe('protected'));
      expect(offlinePersist).not.toHaveBeenCalled();
      first.dispose();
      const persist = vi.fn((request: AutosavePersistRequest) =>
        Promise.resolve(savedDraft(draft, 2, request.document)),
      );
      const restored = new ActionAutosaveController({
        initialDraft: savedDraft(draft, 2, document),
        journal,
        persist,
        isOnline: () => true,
      });
      restored.activate();
      await vi.waitFor(() => expect(restored.snapshot.recovery).toBe('ready'));
      expect(persist).toHaveBeenCalledOnce();
      expect(persist.mock.calls[0]?.[0]).toMatchObject({
        idempotencyKey: 'recovered-action-0001',
        expectedRevisionId: draft.latestRevisionId,
        expectedChecksum: draft.revision.checksum,
        action,
      });
      expect(stored).toBeNull();
      expect(restored.snapshot.document.site.shortName).toBe('Pending after refresh');
      restored.dispose();
    },
  );

  it('blocks invalid recovery until explicit discard and reports storage failure without stopping remote saves', async () => {
    const draft = initialDraft();
    const journal = {
      scope: { actor: draft.createdBy, draftId: draft.id, clientId: 'journal-browser-01' },
      load: vi.fn().mockRejectedValue(new PendingJournalError('invalid')),
      write: vi
        .fn<(state: PendingJournalState | null) => Promise<void>>()
        .mockResolvedValue(undefined),
    };
    const persist = vi.fn((request: AutosavePersistRequest) =>
      Promise.resolve(savedDraft(draft, 2, request.document)),
    );
    const controller = new ActionAutosaveController({
      initialDraft: draft,
      journal,
      persist,
      isOnline: () => true,
    });
    controller.activate();
    await Promise.resolve();
    expect(controller.snapshot.recovery).toBe('blocked');
    expect(controller.complete(draft.document, { category: 'undo', context: 'page-content' })).toBe(
      false,
    );
    expect(persist).not.toHaveBeenCalled();
    await controller.discardAndReplace(() => Promise.resolve(draft));
    await vi.waitFor(() => expect(controller.snapshot.recovery).toBe('ready'));
    journal.write.mockRejectedValue(new PendingJournalError('quota'));
    controller.mutate(
      (document) => ({
        ...document,
        site: { ...document.site, shortName: 'Remote remains available' },
      }),
      { category: 'control-change', context: 'site-settings' },
    );
    await vi.waitFor(() => expect(controller.snapshot.state).toBe('saved'));
    expect(controller.snapshot.recovery).toBe('unavailable');
    expect(controller.snapshot.recoveryMessage).toContain('unavailable');
    expect(persist).toHaveBeenCalledOnce();
    controller.dispose();
  });
  it('merges rename metadata without replacing pending content or accepting stale save names', async () => {
    const draft = initialDraft();
    const save = deferred<DraftRecord>();
    const controller = new ActionAutosaveController({
      initialDraft: draft,
      persist: () => save.promise,
      isOnline: () => true,
    });
    controller.mutate(
      (document) => ({ ...document, site: { ...document.site, shortName: 'Pending content' } }),
      { category: 'control-change', context: 'site-settings' },
    );
    const before = controller.snapshot;
    controller.updateDraftName({
      id: draft.id,
      name: 'Renamed',
      updatedAt: '2026-09-10T00:00:00.000Z',
    });
    expect(controller.snapshot.document).toBe(before.document);
    expect(controller.snapshot.draft.revision).toBe(before.draft.revision);
    expect(controller.snapshot.state).toBe('saving');
    expect(controller.snapshot.pendingCount).toBe(1);
    save.resolve(savedDraft(draft, 2, before.document));
    await Promise.resolve();
    expect(controller.snapshot.draft.name).toBe('Renamed');
    expect(controller.snapshot.draft.updatedAt).toBe('2026-09-10T00:00:00.000Z');
    expect(controller.snapshot.draft.revision.sequence).toBe(2);
    expect(controller.snapshot.document.site.shortName).toBe('Pending content');
    expect(controller.snapshot.state).toBe('saved');
    controller.updateDraftName({
      id: draft.id,
      name: 'Renamed twice',
      updatedAt: '2026-09-09T00:00:00.000Z',
    });
    expect(controller.snapshot.draft.updatedAt).toBe('2026-09-10T00:00:00.000Z');
    const recovery = JSON.parse(controller.recoveryJson()) as { draftName: string };
    expect(recovery.draftName).toBe('Renamed twice');
    expect(() => controller.updateDraftName({ ...draft, id: 'another-draft' })).toThrow();
    controller.replaceWithLatest(draft);
    expect(controller.snapshot.draft.name).toBe(draft.name);
    controller.dispose();
  });

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('can reactivate after a development Strict Mode cleanup cycle', async () => {
    const draft = initialDraft();
    const persist = vi.fn((request: AutosavePersistRequest) =>
      Promise.resolve(savedDraft(draft, 2, request.document)),
    );
    const controller = new ActionAutosaveController({
      initialDraft: draft,
      persist,
      isOnline: () => true,
    });

    controller.dispose();
    controller.activate();
    controller.mutate(
      (document) => ({ ...document, site: { ...document.site, shortName: 'Point' } }),
      { category: 'control-change', context: 'site-settings' },
    );
    await Promise.resolve();

    expect(persist).toHaveBeenCalledOnce();
    expect(controller.snapshot.state).toBe('saved');
  });

  it('coalesces continuing text until one second of inactivity and reuses one identity', async () => {
    const draft = initialDraft();
    const persist = vi.fn((request: AutosavePersistRequest) =>
      Promise.resolve(savedDraft(draft, 2, request.document)),
    );
    const controller = new ActionAutosaveController({
      initialDraft: draft,
      persist,
      createId: () => '30000000-0000-4000-8000-000000000001',
      isOnline: () => true,
    });

    controller.mutate(
      (document) => ({ ...document, site: { ...document.site, mission: 'First' } }),
      { category: 'text-edit', context: 'site-settings', boundary: 'text', coalesceKey: 'mission' },
    );
    await vi.advanceTimersByTimeAsync(900);
    controller.mutate(
      (document) => ({ ...document, site: { ...document.site, mission: 'Finished' } }),
      { category: 'text-edit', context: 'site-settings', boundary: 'text', coalesceKey: 'mission' },
    );

    expect(persist).not.toHaveBeenCalled();
    expect(controller.snapshot.state).toBe('pending');
    await vi.advanceTimersByTimeAsync(1_000);

    expect(persist).toHaveBeenCalledOnce();
    const request = persist.mock.calls[0]?.[0];
    expect(request?.idempotencyKey).toBe('30000000-0000-4000-8000-000000000001');
    expect(request?.expectedChecksum).toBe('initial-checksum');
    expect(request?.expectedRevisionId).toBe(draft.latestRevisionId);
    expect(request?.action).toEqual({ category: 'text-edit', context: 'site-settings' });
    expect(request?.document.site.mission).toBe('Finished');
    expect(controller.snapshot.state).toBe('saved');
  });

  it('serializes rapid actions and never lets an older acknowledgement replace newer local work', async () => {
    const draft = initialDraft();
    const first = deferred<DraftRecord>();
    const second = deferred<DraftRecord>();
    const persist = vi
      .fn<(request: AutosavePersistRequest) => Promise<DraftRecord>>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const controller = new ActionAutosaveController({
      initialDraft: draft,
      persist,
      isOnline: () => true,
    });

    controller.mutate(
      (document) => ({ ...document, site: { ...document.site, shortName: 'First' } }),
      { category: 'control-change', context: 'site-settings' },
    );
    controller.mutate(
      (document) => ({ ...document, site: { ...document.site, shortName: 'Second' } }),
      { category: 'control-change', context: 'site-settings' },
    );

    expect(persist).toHaveBeenCalledOnce();
    expect(controller.snapshot.document.site.shortName).toBe('Second');
    first.resolve(savedDraft(draft, 2, persist.mock.calls[0]?.[0].document));
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.snapshot.document.site.shortName).toBe('Second');
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist.mock.calls[1]?.[0]).toMatchObject({
      expectedChecksum: 'checksum-2',
      expectedRevisionId: savedDraft(draft, 2).latestRevisionId,
    });
    second.resolve(savedDraft(draft, 3, persist.mock.calls[1]?.[0].document));
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.snapshot.state).toBe('saved');
  });

  it('retries transient failures after one, two, and four seconds with the same key', async () => {
    const draft = initialDraft();
    const persist = vi
      .fn<(request: AutosavePersistRequest) => Promise<DraftRecord>>()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockRejectedValueOnce(new Error('temporary'))
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValue(savedDraft(draft, 2));
    const controller = new ActionAutosaveController({
      initialDraft: draft,
      persist,
      createId: () => 'stable-action-id',
      isOnline: () => true,
    });

    controller.mutate((document) => structuredClone(document), {
      category: 'undo',
      context: 'page-content',
    });
    await Promise.resolve();
    expect(controller.snapshot.state).toBe('retrying');
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(4_000);

    expect(persist).toHaveBeenCalledTimes(4);
    expect(new Set(persist.mock.calls.map(([request]) => request.idempotencyKey))).toEqual(
      new Set(['stable-action-id']),
    );
    expect(
      persist.mock.calls.every(
        ([request]) =>
          request.expectedRevisionId === draft.latestRevisionId &&
          request.expectedChecksum === draft.revision.checksum,
      ),
    ).toBe(true);
    expect(controller.snapshot.state).toBe('saved');
  });

  it.each([
    [412, 'REVISION_CONFLICT', 'conflict'],
    [422, 'VALIDATION_FAILED', 'validation'],
  ] as const)('stops on %s and retains pending work', async (status, code, expectedState) => {
    const draft = initialDraft();
    const persist = vi
      .fn<(request: AutosavePersistRequest) => Promise<DraftRecord>>()
      .mockRejectedValue(Object.assign(new Error(code), { status, code }));
    const controller = new ActionAutosaveController({
      initialDraft: draft,
      persist,
      isOnline: () => true,
    });

    controller.mutate(
      (document) => ({ ...document, site: { ...document.site, shortName: 'Pending' } }),
      { category: 'control-change', context: 'site-settings' },
    );
    await Promise.resolve();

    expect(controller.snapshot.state).toBe(expectedState);
    expect(controller.snapshot.pendingCount).toBe(1);
    expect(controller.snapshot.canLeave).toBe(false);
    await vi.runAllTimersAsync();

    expect(persist).toHaveBeenCalledOnce();
  });

  it('retains later local edits without retrying a conflicted checksum', async () => {
    const draft = initialDraft();
    const persist = vi
      .fn<(request: AutosavePersistRequest) => Promise<DraftRecord>>()
      .mockRejectedValue(
        Object.assign(new Error('REVISION_CONFLICT'), {
          status: 412,
          code: 'REVISION_CONFLICT',
        }),
      );
    const controller = new ActionAutosaveController({
      initialDraft: draft,
      persist,
      isOnline: () => true,
    });

    controller.mutate(
      (document) => ({ ...document, site: { ...document.site, shortName: 'First pending' } }),
      { category: 'text-edit', context: 'site-settings' },
    );
    await Promise.resolve();
    controller.mutate(
      (document) => ({ ...document, site: { ...document.site, shortName: 'Later pending' } }),
      { category: 'text-edit', context: 'site-settings' },
    );
    await vi.runAllTimersAsync();

    expect(controller.snapshot.state).toBe('conflict');
    expect(controller.snapshot.pendingCount).toBe(2);
    expect(controller.snapshot.document.site.shortName).toBe('Later pending');
    controller.retry();
    await vi.runAllTimersAsync();
    expect(persist).toHaveBeenCalledOnce();
  });

  it('pauses offline, resumes in order, and bounds the retained queue', () => {
    const draft = initialDraft();
    let online = false;
    const first = deferred<DraftRecord>();
    const persist = vi.fn(() => first.promise);
    const controller = new ActionAutosaveController({
      initialDraft: draft,
      persist,
      isOnline: () => online,
      maxQueue: 2,
    });

    expect(
      controller.mutate((document) => document, {
        category: 'add',
        context: 'page-structure',
      }),
    ).toBe(true);
    expect(
      controller.mutate((document) => document, {
        category: 'remove',
        context: 'page-structure',
      }),
    ).toBe(true);
    expect(
      controller.mutate((document) => document, {
        category: 'duplicate',
        context: 'page-structure',
      }),
    ).toBe(false);
    expect(controller.snapshot.state).toBe('error');
    expect(controller.snapshot.errorKind).toBe('queue-limit');
    expect(persist).not.toHaveBeenCalled();

    online = true;
    controller.setOnline(true);
    expect(persist).toHaveBeenCalledOnce();
  });
});
