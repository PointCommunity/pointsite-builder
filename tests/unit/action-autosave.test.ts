import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ActionAutosaveController,
  type AutosavePersistRequest,
} from '../../src/client/editor/action-autosave';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import type { DraftRecord } from '../../src/server/repositories/contracts';

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
    expect(persist.mock.calls[1]?.[0]).toMatchObject({ expectedChecksum: 'checksum-2' });
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
