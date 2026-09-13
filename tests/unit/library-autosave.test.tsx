import { act, render } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import { api } from '../../src/client/api';
import { EditorProvider, useEditor } from '../../src/client/editor/EditorProvider';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import type { DraftCheckout, DraftRecord } from '../../src/server/repositories/contracts';
import type { LibraryMutationResult } from '../../src/shared/library';

function fixture(): DraftRecord {
  const document = structuredClone(defaultSiteDocument);
  return {
    id: 'draft',
    siteId: 'pointsite',
    name: 'Draft',
    status: 'active',
    document,
    latestRevisionId: 'revision',
    revision: {
      id: 'revision',
      draftId: 'draft',
      sequence: 1,
      parentRevisionId: null,
      checksum: 'before',
      document,
      label: null,
      schemaVersion: document.schemaVersion,
      rendererVersion: document.rendererVersion,
      createdBy: 'editor@example.com',
      createdAt: '2026-09-01',
      actionCategory: null,
      actionContext: null,
    },
    createdBy: 'editor@example.com',
    createdAt: '2026-09-01',
    updatedAt: '2026-09-01',
    deletedAt: null,
  };
}
const checkout: DraftCheckout = {
  draftId: 'draft',
  actor: 'editor@example.com',
  clientId: 'client',
  token: 'token',
  acquiredAt: '2026-09-01',
  lastActivityAt: '2026-09-01',
  expiresAt: '2099-01-01',
  event: 'acquired',
  viewState: null,
};
let editor: ReturnType<typeof useEditor>;
function Harness() {
  const value = useEditor();
  useLayoutEffect(() => {
    editor = value;
  });
  return null;
}
function setup(owned: DraftCheckout | null = checkout) {
  const draft = fixture();
  vi.spyOn(api, 'validateCheckout').mockResolvedValue({ active: true });
  vi.spyOn(api, 'saveDraft').mockImplementation(() => new Promise(() => {}));
  render(
    <EditorProvider initialDraft={draft} checkout={owned}>
      <Harness />
    </EditorProvider>,
  );
  const saved = structuredClone(draft);
  saved.revision.checksum = 'after';
  saved.document.site.mission = 'Server Library change';
  saved.revision.document = saved.document;
  const result: LibraryMutationResult = {
    draft: saved,
    library: {
      draftId: draft.id,
      revisionChecksum: 'after',
      revisionId: saved.latestRevisionId,
      items: [],
      activeCount: 0,
      archivedCount: 0,
    },
  };
  return { draft, result };
}
afterEach(() => vi.restoreAllMocks());

it('adopts the committed draft and uses its checksum in subsequent saves', async () => {
  const { result } = setup();
  const operation = vi.fn().mockResolvedValue(result);
  await act(async () => {
    await editor.runLibraryMutation(operation);
  });
  expect(operation).toHaveBeenCalledWith(
    expect.objectContaining({
      draftId: 'draft',
      checkoutToken: 'token',
      expectedChecksum: 'before',
      expectedRevisionId: 'revision',
    }),
  );
  expect(editor.draft.revision.checksum).toBe('after');
  expect(editor.document.site.mission).toBe('Server Library change');
  act(() => {
    editor.updateDocument(
      (document) => ({ ...document, site: { ...document.site, mission: 'Next edit' } }),
      { category: 'control-change', context: 'site-settings' },
    );
  });
  expect(api.saveDraft).toHaveBeenCalledWith(
    'draft',
    'after',
    expect.anything(),
    expect.anything(),
    expect.any(String),
    'token',
    result.draft.latestRevisionId,
  );
});

it('blocks mutations without an owned checkout', async () => {
  setup(null);
  const operation = vi.fn();
  await expect(editor.runLibraryMutation(operation)).rejects.toThrow('checkout is required');
  expect(operation).not.toHaveBeenCalled();
});

it('uses the new revision identity after a metadata mutation with an unchanged checksum', async () => {
  const { draft, result } = setup();
  result.draft.document = structuredClone(draft.document);
  result.draft.latestRevisionId = 'metadata-revision';
  result.draft.revision = {
    ...result.draft.revision,
    id: 'metadata-revision',
    checksum: 'before',
    document: result.draft.document,
  };
  result.library.revisionId = 'metadata-revision';
  result.library.revisionChecksum = 'before';
  await act(async () => {
    await editor.runLibraryMutation(vi.fn().mockResolvedValue(result));
  });
  const next = vi.fn().mockResolvedValue(result);
  await act(async () => {
    await editor.runLibraryMutation(next);
  });
  expect(next).toHaveBeenCalledWith(
    expect.objectContaining({
      expectedChecksum: 'before',
      expectedRevisionId: 'metadata-revision',
    }),
  );
});

it.each(['pending', 'staged'])(
  'preserves %s edits and never submits a Library mutation',
  async (kind) => {
    setup();
    const operation = vi.fn();
    act(() => {
      const next = structuredClone(editor.document);
      next.site.mission = 'Pending local edit';
      if (kind === 'staged') editor.stageDocument(next);
      else
        editor.completeDocument(next, {
          category: 'text-edit',
          context: 'site-settings',
          boundary: 'text',
        });
    });
    await act(async () => {
      await expect(editor.runLibraryMutation(operation)).rejects.toThrow(
        'pending edits are preserved',
      );
    });
    expect(operation).not.toHaveBeenCalled();
    expect(editor.document.site.mission).toBe('Pending local edit');
  },
);

it('preserves edits made while a server Library mutation is in flight', async () => {
  const { result } = setup();
  let finish!: (result: LibraryMutationResult) => void;
  const operation = vi.fn(
    () =>
      new Promise<LibraryMutationResult>((resolve) => {
        finish = resolve;
      }),
  );
  let pending!: Promise<unknown>;
  await act(async () => {
    pending = editor.runLibraryMutation(operation);
    await Promise.resolve();
  });
  const rejection = expect(pending).rejects.toThrow('newer local edits were preserved');
  act(() => {
    const next = structuredClone(editor.document);
    next.site.mission = 'Raced local edit';
    editor.stageDocument(next);
  });
  await act(async () => {
    finish(result);
    await rejection;
  });
  expect(editor.document.site.mission).toBe('Raced local edit');
  expect(editor.draft.revision.checksum).toBe('before');
});

it('rejects overlapping mutations and preserves the draft on server failures', async () => {
  const { draft } = setup();
  let fail!: (cause: Error) => void;
  let pending!: Promise<unknown>;
  await act(async () => {
    pending = editor.runLibraryMutation(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    await Promise.resolve();
  });
  await expect(editor.runLibraryMutation(vi.fn())).rejects.toThrow('current Library change');
  const rejection = expect(pending).rejects.toThrow('Server unavailable');
  await act(async () => {
    fail(new Error('Server unavailable'));
    await rejection;
  });
  expect(editor.document).toEqual(draft.document);
  expect(editor.draft.revision.checksum).toBe('before');
});
