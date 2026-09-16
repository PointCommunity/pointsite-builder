import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../src/client/api';
import { EditorProvider, useEditor } from '../../src/client/editor/EditorProvider';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import type { DraftCheckout, DraftRecord } from '../../src/server/repositories/contracts';
import { StrictMode } from 'react';
import { PendingJournal, type PendingJournalState } from '../../src/client/editor/pending-journal';

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
      createdAt: '2026-09-05T00:00:00.000Z',
      actionCategory: null,
      actionContext: null,
    },
    createdBy: 'editor@pointatx.org',
    createdAt: '2026-09-05T00:00:00.000Z',
    updatedAt: '2026-09-05T00:00:00.000Z',
    deletedAt: null,
  };
};

function Harness() {
  const { document, updateDocument, saveState, flushTextAction } = useEditor();
  return (
    <>
      <span role="status">{saveState}</span>
      <button
        onClick={() =>
          updateDocument(
            (next) => ({
              ...next,
              site: { ...next.site, mission: `${document.site.mission}!` },
            }),
            { category: 'control-change', context: 'site-settings' },
          )
        }
      >
        Change
      </button>
      <input
        aria-label="Mission"
        value={document.site.mission}
        onChange={(event) =>
          updateDocument(
            (next) => ({ ...next, site: { ...next.site, mission: event.target.value } }),
            {
              category: 'text-edit',
              context: 'site-settings',
              boundary: 'text',
              coalesceKey: 'mission',
            },
          )
        }
        onBlur={flushTextAction}
      />
    </>
  );
}

describe('EditorProvider autosave', () => {
  let online = true;

  beforeEach(() => {
    vi.useFakeTimers();
    online = true;
    vi.spyOn(window.navigator, 'onLine', 'get').mockImplementation(() => online);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('saves a loaded schema migration once through its owned checkout without a manual edit', async () => {
    const draft = initialDraft();
    draft.revision.schemaVersion = 9;
    draft.revision.rendererVersion = '9.0.0';
    const checkout: DraftCheckout = {
      draftId: draft.id,
      actor: draft.createdBy,
      clientId: 'migration-browser-01',
      token: 'owned-checkout',
      acquiredAt: draft.createdAt,
      lastActivityAt: draft.createdAt,
      expiresAt: '2099-01-01',
      event: 'acquired',
      viewState: null,
    };
    const saved = initialDraft();
    saved.revision.checksum = 'upgraded-checksum';
    const save = vi.spyOn(api, 'saveDraft').mockResolvedValue(saved);
    render(
      <StrictMode>
        <EditorProvider initialDraft={draft} checkout={checkout}>
          <Harness />
        </EditorProvider>
      </StrictMode>,
    );
    await act(async () => Promise.resolve());
    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith(
      draft.id,
      draft.revision.checksum,
      draft.document,
      { category: 'control-change', context: 'draft' },
      expect.any(String),
      checkout.token,
      draft.revision.id,
    );
    expect(screen.getByRole('status')).toHaveTextContent('saved');
  });

  it('does not save a schema migration without an active checkout', async () => {
    const draft = initialDraft();
    draft.revision.schemaVersion = 9;
    const save = vi.spyOn(api, 'saveDraft');
    render(
      <EditorProvider initialDraft={draft}>
        <Harness />
      </EditorProvider>,
    );
    await act(async () => Promise.resolve());
    expect(save).not.toHaveBeenCalled();
  });

  it('recovers pending edits before saving an older loaded revision', async () => {
    const draft = initialDraft();
    draft.revision.schemaVersion = 9;
    draft.revision.rendererVersion = '9.0.0';
    const document = structuredClone(draft.document);
    document.site.mission = 'Recovered unsaved edit';
    const saved = initialDraft();
    saved.document = document;
    saved.revision.document = document;
    const checkout: DraftCheckout = {
      draftId: draft.id,
      actor: draft.createdBy,
      clientId: 'migration-browser-01',
      token: 'owned-checkout',
      acquiredAt: draft.createdAt,
      lastActivityAt: draft.createdAt,
      expiresAt: '2099-01-01',
      event: 'acquired',
      viewState: null,
    };
    let recover!: (value: PendingJournalState) => void;
    vi.stubGlobal('indexedDB', {});
    vi.spyOn(PendingJournal.prototype, 'load').mockImplementation(
      () =>
        new Promise((resolve) => {
          recover = resolve;
        }),
    );
    vi.spyOn(PendingJournal.prototype, 'write').mockResolvedValue(undefined);
    const save = vi.spyOn(api, 'saveDraft').mockResolvedValue(saved);
    render(
      <EditorProvider initialDraft={draft} checkout={checkout}>
        <Harness />
      </EditorProvider>,
    );
    expect(save).not.toHaveBeenCalled();
    await act(async () => {
      recover({
        version: 1,
        scope: { actor: checkout.actor, draftId: draft.id, clientId: checkout.clientId },
        baseRevisionId: draft.revision.id,
        baseChecksum: draft.revision.checksum,
        updatedAt: new Date().toISOString(),
        staged: null,
        actions: [
          {
            document,
            action: { category: 'text-edit', context: 'site-settings' },
            idempotencyKey: 'recovered-action-01',
            expectedRevisionId: draft.revision.id,
            expectedChecksum: draft.revision.checksum,
            ready: true,
          },
        ],
      });
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0]?.[2]).toEqual(document);
    expect(save.mock.calls[0]?.[4]).toBe('recovered-action-01');
    expect(screen.getByRole('textbox', { name: 'Mission' })).toHaveValue('Recovered unsaved edit');
  });

  it('saves a completed discrete action immediately', async () => {
    const draft = initialDraft();
    const save = vi.spyOn(api, 'saveDraft').mockResolvedValue({
      ...draft,
      revision: { ...draft.revision, sequence: 2 },
      updatedAt: '2026-09-05T00:00:05.000Z',
    });
    render(
      <EditorProvider initialDraft={draft}>
        <Harness />
      </EditorProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    await act(async () => Promise.resolve());
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0]?.[6]).toBe(draft.latestRevisionId);
    expect(screen.getByRole('status')).toHaveTextContent('saved');
  });

  it('closes a text action on blur without waiting for the idle timer', async () => {
    const draft = initialDraft();
    const save = vi.spyOn(api, 'saveDraft').mockResolvedValue({
      ...draft,
      revision: { ...draft.revision, sequence: 2 },
    });
    render(
      <EditorProvider initialDraft={draft}>
        <Harness />
      </EditorProvider>,
    );
    const input = screen.getByRole('textbox', { name: 'Mission' });
    fireEvent.change(input, { target: { value: 'A complete mission' } });
    expect(save).not.toHaveBeenCalled();
    fireEvent.blur(input);
    await act(async () => Promise.resolve());
    expect(save).toHaveBeenCalledOnce();
  });

  it('waits offline and retries immediately when connectivity returns', async () => {
    const draft = initialDraft();
    const save = vi.spyOn(api, 'saveDraft').mockResolvedValue(draft);
    render(
      <EditorProvider initialDraft={draft}>
        <Harness />
      </EditorProvider>,
    );
    online = false;
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    await act(async () => Promise.resolve());
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('offline');
    online = true;
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledOnce();
    expect(screen.getByRole('status')).toHaveTextContent('saved');
  });
});
