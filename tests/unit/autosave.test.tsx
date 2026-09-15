import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../src/client/api';
import { EditorProvider, useEditor } from '../../src/client/editor/EditorProvider';
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
