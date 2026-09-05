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
      schemaVersion: 1,
      rendererVersion: document.rendererVersion,
      createdBy: 'editor@pointatx.org',
      createdAt: '2026-09-05T00:00:00.000Z',
    },
    createdBy: 'editor@pointatx.org',
    createdAt: '2026-09-05T00:00:00.000Z',
    updatedAt: '2026-09-05T00:00:00.000Z',
    deletedAt: null,
  };
};

function Harness() {
  const { document, updateDocument, saveState } = useEditor();
  return (
    <>
      <span role="status">{saveState}</span>
      <button
        onClick={() =>
          updateDocument((next) => ({
            ...next,
            site: { ...next.site, mission: `${document.site.mission}!` },
          }))
        }
      >
        Change
      </button>
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

  it('saves an acknowledged change after five seconds', async () => {
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
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(save).toHaveBeenCalledOnce();
    expect(screen.getByRole('status')).toHaveTextContent('saved');
  });

  it('waits offline and retries immediately when connectivity returns', async () => {
    const draft = initialDraft();
    const save = vi.spyOn(api, 'saveDraft').mockResolvedValue(draft);
    render(
      <EditorProvider initialDraft={draft}>
        <Harness />
      </EditorProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    online = false;
    await act(() => vi.advanceTimersByTimeAsync(5_000));
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
