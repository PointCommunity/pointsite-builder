import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { SiteDocument } from '../../site-kit/types';
import type { DraftCheckout, DraftRecord } from '../../server/repositories/contracts';
import { api } from '../api';
import type {
  LibraryMutationContext,
  LibraryMutationResult,
  LibrarySnapshot,
} from '../../shared/library';
import {
  ActionAutosaveController,
  type AutosaveMutation,
  type AutosaveSnapshot,
  type AutosaveState,
} from './action-autosave';

interface EditorValue {
  draft: DraftRecord;
  document: SiteDocument;
  saveState: AutosaveState;
  autosave: AutosaveSnapshot;
  updateDocument: (
    update: (document: SiteDocument) => SiteDocument,
    mutation: AutosaveMutation,
  ) => boolean;
  stageDocument: (document: SiteDocument) => void;
  completeDocument: (document: SiteDocument, mutation: AutosaveMutation) => boolean;
  flushTextAction: () => void;
  retryAutosave: () => void;
  copyRecoveryData: () => Promise<void>;
  reloadLatest: () => Promise<void>;
  renameDraft: (name: string) => Promise<void>;
  runLibraryMutation: (
    operation: (context: LibraryMutationContext) => Promise<LibraryMutationResult>,
  ) => Promise<LibrarySnapshot>;
}

type EditorDocumentValue = Pick<
  EditorValue,
  'document' | 'updateDocument' | 'stageDocument' | 'completeDocument'
>;

const EditorContext = createContext<EditorValue | null>(null);
const EditorDocumentContext = createContext<EditorDocumentValue | null>(null);

export function EditorProvider({
  initialDraft,
  children,
  checkout = null,
}: {
  initialDraft: DraftRecord;
  checkout?: DraftCheckout | null;
  children: ReactNode;
}) {
  const [controller] = useState(
    () =>
      new ActionAutosaveController({
        initialDraft,
        persist: ({ document, action, expectedChecksum, idempotencyKey }) =>
          api.saveDraft(
            initialDraft.id,
            expectedChecksum,
            document,
            action,
            idempotencyKey,
            checkout?.token ?? '',
          ),
      }),
  );
  const autosave = useSyncExternalStore(
    controller.subscribe,
    () => controller.snapshot,
    () => controller.snapshot,
  );
  const libraryMutationPending = useRef(false);
  const runLibraryMutation = useCallback(
    async (
      operation: (context: LibraryMutationContext) => Promise<LibraryMutationResult>,
    ): Promise<LibrarySnapshot> => {
      const before = controller.snapshot;
      if (!checkout || before.draft.status !== 'active')
        throw new Error(
          'An active draft checkout is required. Reopen this draft to edit its Library.',
        );
      if (libraryMutationPending.current)
        throw new Error('Wait for the current Library change to finish.');
      if (
        before.state !== 'saved' ||
        !before.canLeave ||
        JSON.stringify(before.document) !== JSON.stringify(before.draft.document)
      ) {
        controller.flushTextAction();
        throw new Error(
          'Wait until all draft changes are saved, then try again. Your pending edits are preserved.',
        );
      }
      libraryMutationPending.current = true;
      try {
        await api.validateCheckout(before.draft.id, checkout.token);
        if (controller.snapshot !== before)
          throw new Error(
            'The draft changed while preparing this action. Wait for autosave, then try again.',
          );
        const result = await operation({
          draftId: before.draft.id,
          expectedChecksum: before.draft.revision.checksum,
          expectedRevisionId: before.draft.latestRevisionId,
          checkoutToken: checkout.token,
          idempotencyKey: crypto.randomUUID(),
        });
        if (controller.snapshot !== before)
          throw new Error(
            'The Library change was saved, but newer local edits were preserved. Copy pending edits before reloading the latest draft.',
          );
        if (
          result.draft.id !== before.draft.id ||
          result.library.draftId !== before.draft.id ||
          result.library.revisionId !== result.draft.latestRevisionId ||
          result.draft.revision.id !== result.draft.latestRevisionId ||
          result.library.revisionChecksum !== result.draft.revision.checksum
        )
          throw new Error(
            'The Library response could not be verified. Reload the latest draft before continuing.',
          );
        controller.replaceWithLatest(result.draft);
        return result.library;
      } finally {
        libraryMutationPending.current = false;
      }
    },
    [checkout, controller],
  );

  useEffect(() => {
    controller.activate();
    return () => controller.dispose();
  }, [controller]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!controller.snapshot.canLeave) event.preventDefault();
    };
    const markOffline = () => controller.setOnline(false);
    const resumeOnline = () => controller.setOnline(true);
    window.addEventListener('beforeunload', warn);
    window.addEventListener('offline', markOffline);
    window.addEventListener('online', resumeOnline);
    return () => {
      window.removeEventListener('beforeunload', warn);
      window.removeEventListener('offline', markOffline);
      window.removeEventListener('online', resumeOnline);
    };
  }, [controller]);

  useEffect(() => {
    const closeTextAction = () => controller.flushTextAction();
    globalThis.document.addEventListener('focusout', closeTextAction);
    return () => globalThis.document.removeEventListener('focusout', closeTextAction);
  }, [controller]);

  const reloadLatest = useCallback(async () => {
    const latest = await api.getDraft(initialDraft.id);
    controller.replaceWithLatest(latest);
  }, [controller, initialDraft.id]);

  const renameDraft = useCallback(
    async (name: string) => {
      const renamed = await api.renameDraft(initialDraft.id, name);
      controller.updateDraftName(renamed);
    },
    [controller, initialDraft.id],
  );

  const copyRecoveryData = useCallback(async () => {
    const recovery = controller.recoveryJson();
    try {
      await navigator.clipboard.writeText(recovery);
      return;
    } catch {
      const textarea = globalThis.document.createElement('textarea');
      textarea.value = recovery;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      globalThis.document.body.appendChild(textarea);
      textarea.select();
      const copied = globalThis.document.execCommand('copy');
      globalThis.document.body.removeChild(textarea);
      if (!copied) throw new Error('Clipboard access is unavailable');
    }
  }, [controller]);

  const value = useMemo<EditorValue>(
    () => ({
      draft: autosave.draft,
      document: autosave.document,
      saveState: autosave.state,
      autosave,
      updateDocument: (update, mutation) => controller.mutate(update, mutation),
      stageDocument: (document) => controller.stage(document),
      completeDocument: (document, mutation) => controller.complete(document, mutation),
      flushTextAction: controller.flushTextAction,
      retryAutosave: controller.retry,
      copyRecoveryData,
      reloadLatest,
      renameDraft,
      runLibraryMutation,
    }),
    [autosave, controller, copyRecoveryData, reloadLatest, renameDraft, runLibraryMutation],
  );

  const documentValue = useMemo<EditorDocumentValue>(
    () => ({
      document: autosave.document,
      updateDocument: (update, mutation) => controller.mutate(update, mutation),
      stageDocument: (document) => controller.stage(document),
      completeDocument: (document, mutation) => controller.complete(document, mutation),
    }),
    [autosave.document, controller],
  );

  return (
    <EditorContext.Provider value={value}>
      <EditorDocumentContext.Provider value={documentValue}>
        {children}
      </EditorDocumentContext.Provider>
    </EditorContext.Provider>
  );
}

// The provider and its colocated hook intentionally form one context module.
// eslint-disable-next-line react-refresh/only-export-components
export function useEditor(): EditorValue {
  const value = useContext(EditorContext);
  if (!value) throw new Error('useEditor must be used inside EditorProvider');
  return value;
}

// The visual editor consumes only document state so save acknowledgements do not reset Puck UI.
// eslint-disable-next-line react-refresh/only-export-components
export function useEditorDocument(): EditorDocumentValue {
  const value = useContext(EditorDocumentContext);
  if (!value) throw new Error('useEditorDocument must be used inside EditorProvider');
  return value;
}
