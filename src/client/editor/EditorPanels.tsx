import { Puck } from '@puckeditor/core';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { PageManager } from './PageManager';
import { StructurePanel } from './StructurePanel';
import { usePointPuck } from './puck-store';
import { setPuckActionIntent } from './puck-action-intent';

type Panel = 'Pages' | 'Blocks' | 'Outline';
type PanelProps = {
  pageId: string;
  onPageIdChange: (id: string) => void;
  onStructureChange: () => void;
  toolbar: HTMLElement | null;
};
const PanelsContext = createContext<
  | (PanelProps & {
      panel: Panel;
      setPanel: (panel: Panel) => void;
      setStatus: (status: string) => void;
      focus: string;
    })
  | null
>(null);

export function EditorPanelsProvider({ children, ...props }: PanelProps & { children: ReactNode }) {
  const [panel, setPanel] = useState<Panel>('Pages');
  const [feedback, setFeedback] = useState({ message: '', focus: '' });
  const setStatus = (message: string) =>
    setFeedback({
      message,
      focus: document.activeElement?.closest('.structure-panel')
        ? (document.activeElement.getAttribute('aria-label') ?? '')
        : '',
    });
  return (
    <PanelsContext.Provider value={{ ...props, panel, setPanel, setStatus, focus: feedback.focus }}>
      <p className="visually-hidden" role="status" aria-live="polite">
        {feedback.message}
      </p>
      {children}
    </PanelsContext.Provider>
  );
}

export function EditorPagePanel() {
  const state = useContext(PanelsContext)!;
  return (
    <div className="page-workspace">
      <div hidden={state.panel !== 'Pages'}>
        <PageManager pageId={state.pageId} onPageIdChange={state.onPageIdChange} />
      </div>
      <div hidden={state.panel !== 'Blocks'}>
        <Puck.Components />
      </div>
      <div hidden={state.panel !== 'Outline'}>
        <Puck.Outline />
        <StructurePanel
          pageId={state.pageId}
          onStructureChange={state.onStructureChange}
          setStatus={state.setStatus}
          focus={state.focus}
        />
      </div>
    </div>
  );
}

export function CompactEditorHeader() {
  const { toolbar, panel, setPanel } = useContext(PanelsContext)!;
  const dispatch = usePointPuck((state) => state.dispatch);
  const left = usePointPuck((state) => state.appState.ui.leftSideBarVisible);
  const right = usePointPuck((state) => state.appState.ui.rightSideBarVisible);
  const selectedId = usePointPuck(
    (state) => (state.selectedItem?.props as { id?: string } | undefined)?.id,
  );
  const history = usePointPuck((state) => state.history);
  useEffect(() => {
    const narrow = window.matchMedia('(max-width: 1100px)');
    const fit = () => {
      if (narrow.matches && right)
        dispatch({
          type: 'setUi',
          ui: { leftSideBarVisible: false },
          recordHistory: false,
        });
    };
    fit();
    narrow.addEventListener('change', fit);
    return () => narrow.removeEventListener('change', fit);
  }, [dispatch, right]);
  useEffect(() => {
    if (selectedId)
      dispatch({
        type: 'setUi',
        ui: {
          rightSideBarVisible: true,
          ...(window.matchMedia('(max-width: 1100px)').matches
            ? { leftSideBarVisible: false }
            : {}),
        },
        recordHistory: false,
      });
  }, [dispatch, selectedId]);
  if (!toolbar) return <></>;
  return createPortal(
    <div className="layout-actions" aria-label="Layout tools">
      {(['Pages', 'Blocks', 'Outline'] as const).map((item) => (
        <button
          type="button"
          key={item}
          aria-pressed={left && panel === item}
          onClick={() => {
            setPanel(item);
            dispatch({
              type: 'setUi',
              ui: {
                leftSideBarVisible: panel !== item || !left,
                ...(window.matchMedia('(max-width: 1100px)').matches
                  ? { rightSideBarVisible: false }
                  : {}),
              },
              recordHistory: false,
            });
          }}
        >
          {item}
        </button>
      ))}
      <button
        type="button"
        aria-pressed={right}
        onClick={() =>
          dispatch({
            type: 'setUi',
            ui: {
              rightSideBarVisible: !right,
              ...(window.matchMedia('(max-width: 1100px)').matches
                ? { leftSideBarVisible: false }
                : {}),
            },
            recordHistory: false,
          })
        }
      >
        Properties
      </button>
      <button
        type="button"
        aria-label="Undo"
        disabled={!history.hasPast}
        onClick={() => {
          setPuckActionIntent({ category: 'undo', context: 'page-content' });
          history.back();
        }}
      >
        ↶
      </button>
      <button
        type="button"
        aria-label="Redo"
        disabled={!history.hasFuture}
        onClick={() => {
          setPuckActionIntent({ category: 'redo', context: 'page-content' });
          history.forward();
        }}
      >
        ↷
      </button>
    </div>,
    toolbar,
  );
}
