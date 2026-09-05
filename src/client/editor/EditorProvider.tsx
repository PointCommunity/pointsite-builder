import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { SiteDocument } from '../../site-kit/types';
import type { DraftRecord } from '../../server/repositories/contracts';
import { api, ClientApiError } from '../api';

type SaveState = 'saved' | 'unsaved' | 'saving' | 'offline' | 'conflict' | 'error';

interface EditorValue {
  draft: DraftRecord;
  document: SiteDocument;
  saveState: SaveState;
  updateDocument: (update: (document: SiteDocument) => SiteDocument) => void;
  saveNow: () => Promise<void>;
  reloadLatest: () => Promise<void>;
}

const EditorContext = createContext<EditorValue | null>(null);

export function EditorProvider({
  initialDraft,
  children,
}: {
  initialDraft: DraftRecord;
  children: ReactNode;
}) {
  const [draft, setDraft] = useState(initialDraft);
  const [document, setDocument] = useState(initialDraft.document);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const saveNow = useCallback(async () => {
    if (saveState === 'saved' || saveState === 'saving') return;
    if (!navigator.onLine) {
      setSaveState('offline');
      return;
    }
    setSaveState('saving');
    try {
      const saved = await api.saveDraft(draft.id, draft.revision.checksum, document);
      setDraft(saved);
      setDocument(saved.document);
      setSaveState('saved');
    } catch (error) {
      if (error instanceof ClientApiError && error.status === 412) setSaveState('conflict');
      else if (!navigator.onLine) setSaveState('offline');
      else setSaveState('error');
    }
  }, [document, draft.id, draft.revision.checksum, saveState]);

  useEffect(() => {
    if (saveState !== 'unsaved') return;
    const timer = window.setTimeout(() => void saveNow(), 5_000);
    return () => window.clearTimeout(timer);
  }, [saveNow, saveState, document]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (saveState !== 'saved') event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [saveState]);

  useEffect(() => {
    const markOffline = () => {
      if (saveState !== 'saved') setSaveState('offline');
    };
    const retry = () => {
      if (saveState === 'offline' || saveState === 'error') void saveNow();
    };
    window.addEventListener('offline', markOffline);
    window.addEventListener('online', retry);
    return () => {
      window.removeEventListener('offline', markOffline);
      window.removeEventListener('online', retry);
    };
  }, [saveNow, saveState]);

  const reloadLatest = useCallback(async () => {
    const latest = await api.getDraft(draft.id);
    setDraft(latest);
    setDocument(latest.document);
    setSaveState('saved');
  }, [draft.id]);

  const value = useMemo<EditorValue>(
    () => ({
      draft,
      document,
      saveState,
      updateDocument: (update) => {
        setDocument((current) => update(structuredClone(current)));
        setSaveState('unsaved');
      },
      saveNow,
      reloadLatest,
    }),
    [document, draft, reloadLatest, saveNow, saveState],
  );

  return <EditorContext.Provider value={value}>{children}</EditorContext.Provider>;
}

// The provider and its colocated hook intentionally form one context module.
// eslint-disable-next-line react-refresh/only-export-components
export function useEditor(): EditorValue {
  const value = useContext(EditorContext);
  if (!value) throw new Error('useEditor must be used inside EditorProvider');
  return value;
}
