import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import type {
  DraftCheckout,
  DraftRecord,
  EditorPanel,
  EditorViewState,
  Role,
} from '../../server/repositories/contracts';
import { checkoutPhase, checkoutRemaining, isGenuineActivity } from '../../shared/draft-checkout';
import { api, ClientApiError } from '../api';
import { Preview } from '../preview/Preview';
import { RevisionHistory } from '../revisions/RevisionHistory';
import { SiteSettings } from '../settings/SiteSettings';
import { FormsEditor } from '../settings/FormsEditor';
import { StagingPublish } from '../publish/StagingPublish';
import { MediaLibrary } from '../media/MediaLibrary';
import { draftDisplayDocument } from '../media/draft-display-document';
import { AdminRoute } from '../admin/AdminRoute';
import { EditorProvider, useEditor } from './EditorProvider';
import { PageManager } from './PageManager';
import { StructurePanel } from './StructurePanel';
import { mutationForContext } from './action-attribution';
import { FeedbackButton } from '../feedback/FeedbackButton';
import { saveFeedbackWorkspace } from '../feedback/workspace';
import { DraftName } from './DraftName';

const VisualEditor = lazy(() =>
  import('./VisualEditor').then((module) => ({ default: module.VisualEditor })),
);
type Panel = EditorPanel;
const panelLabels: Record<Panel, string> = {
  layout: 'Layout',
  forms: 'Forms',
  library: 'Library',
  preview: 'Preview',
  history: 'History',
  settings: 'Settings',
  admin: 'Admin',
};

function Workspace({
  role,
  canPublish,
  onClose,
  themeToggle,
  checkout,
  feedbackPanel,
}: {
  role: Role;
  canPublish: boolean;
  onClose: () => void;
  themeToggle: ReactNode;
  checkout: DraftCheckout | null;
  feedbackPanel?: Panel;
}) {
  const {
    draft,
    document,
    updateDocument,
    saveState,
    autosave,
    reloadLatest,
    retryAutosave,
    copyRecoveryData,
    renameDraft,
    runLibraryMutation,
  } = useEditor();
  const displayDocument = useMemo(
    () => draftDisplayDocument(document, draft.id),
    [document, draft.id],
  );
  const [panel, setPanel] = useState<Panel>(
    feedbackPanel && (feedbackPanel !== 'admin' || role === 'administrator')
      ? feedbackPanel
      : role === 'viewer'
        ? 'preview'
        : (checkout?.viewState?.panel ?? 'layout'),
  );
  const [publishOpen, setPublishOpen] = useState(false);
  const publishButtonRef = useRef<HTMLButtonElement>(null);
  const [pageId, setPageId] = useState(
    document.pages.some((page) => page.id === checkout?.viewState?.pageId)
      ? (checkout?.viewState?.pageId ?? '')
      : (document.pages[0]?.id ?? ''),
  );
  const [leaseExpiresAt, setLeaseExpiresAt] = useState(checkout?.expiresAt ?? null);
  const [leaseNow, setLeaseNow] = useState(0);
  const [leaseLost, setLeaseLost] = useState(false);
  const [structureRevision, setStructureRevision] = useState(0);
  const [recoveryCopied, setRecoveryCopied] = useState(false);
  const [recoveryStatus, setRecoveryStatus] = useState('');
  const leaseExpired = Boolean(
    leaseExpiresAt && checkoutPhase(leaseExpiresAt, leaseNow) === 'expired',
  );
  const checkoutUnavailable = leaseLost || leaseExpired;
  const editable =
    role !== 'viewer' &&
    draft.status === 'active' &&
    Boolean(checkout) &&
    !checkoutUnavailable &&
    autosave.recovery !== 'blocked' &&
    autosave.recovery !== 'clearing' &&
    autosave.recovery !== 'checking';
  const viewState = useCallback(
    (): EditorViewState => ({
      draftId: draft.id,
      panel,
      pageId: pageId || null,
      selectedElementId: null,
      previewViewport: checkout?.viewState?.previewViewport ?? 'desktop',
      previewZoom: checkout?.viewState?.previewZoom ?? 1,
      scrollPositions: { window: Math.max(0, window.scrollY) },
      updatedAt: new Date().toISOString(),
    }),
    [
      checkout?.viewState?.previewViewport,
      checkout?.viewState?.previewZoom,
      draft.id,
      pageId,
      panel,
    ],
  );
  const requestClose = () => {
    if (autosave.canLeave) {
      if (checkout)
        void api
          .touchCheckout(draft.id, checkout.clientId, checkout.token, viewState())
          .then(() => api.releaseCheckout(draft.id, checkout.clientId, checkout.token))
          .then(onClose)
          .catch(() => setLeaseLost(true));
      else onClose();
    } else setRecoveryStatus('Copy the pending draft before discarding changes and leaving.');
  };
  useEffect(() => {
    if (!checkout) return;
    const clock = window.setInterval(() => setLeaseNow(Date.now()), 1_000);
    let lastTouch = 0;
    const activity = (event: Event) => {
      if (
        !isGenuineActivity(event, globalThis.document.visibilityState === 'visible') ||
        Date.now() - lastTouch < 15_000
      )
        return;
      lastTouch = Date.now();
      void api
        .touchCheckout(draft.id, checkout.clientId, checkout.token, viewState())
        .then((next) => {
          setLeaseExpiresAt(next.expiresAt);
          setLeaseLost(false);
        })
        .catch((error) => {
          if (error instanceof ClientApiError && error.status === 409) setLeaseLost(true);
        });
    };
    for (const name of ['pointerdown', 'keydown', 'touchstart', 'focus', 'online'])
      window.addEventListener(name, activity, true);
    return () => {
      window.clearInterval(clock);
      for (const name of ['pointerdown', 'keydown', 'touchstart', 'focus', 'online'])
        window.removeEventListener(name, activity, true);
    };
  }, [checkout, draft.id, viewState]);
  useEffect(() => {
    if (!checkout || checkoutUnavailable) return;
    let active = true;
    const validate = () => {
      if (globalThis.document.visibilityState !== 'visible') return;
      void api.validateCheckout(draft.id, checkout.token).catch((error) => {
        if (active && error instanceof ClientApiError && error.status === 409) setLeaseLost(true);
      });
    };
    const timer = window.setInterval(validate, 4_000);
    globalThis.document.addEventListener('visibilitychange', validate);
    return () => {
      active = false;
      window.clearInterval(timer);
      globalThis.document.removeEventListener('visibilitychange', validate);
    };
  }, [checkout, checkoutUnavailable, draft.id]);
  useEffect(() => {
    if (!checkout || checkoutUnavailable) return;
    const persist = window.setTimeout(() => {
      void api
        .touchCheckout(draft.id, checkout.clientId, checkout.token, viewState(), false)
        .then((next) => setLeaseExpiresAt(next.expiresAt))
        .catch((error) => {
          if (error instanceof ClientApiError && error.status === 409) setLeaseLost(true);
        });
    }, 250);
    return () => window.clearTimeout(persist);
  }, [checkout, checkoutUnavailable, draft.id, pageId, panel, viewState]);
  const copyPendingDraft = async () => {
    try {
      await copyRecoveryData();
      setRecoveryCopied(true);
      setRecoveryStatus('Pending draft copied. You can now load the latest version or leave.');
    } catch {
      setRecoveryStatus(
        'The pending draft could not be copied. Keep this page open and try again.',
      );
    }
  };
  const discardPending = async (leave: boolean) => {
    try {
      await reloadLatest();
      setRecoveryStatus('');
      setRecoveryCopied(false);
      if (leave) {
        if (checkout) await api.releaseCheckout(draft.id, checkout.clientId, checkout.token);
        onClose();
      }
    } catch {
      setRecoveryStatus('Recovery could not be cleared safely. Keep this tab open and retry.');
    }
  };
  const closePublishing = () => {
    setPublishOpen(false);
    window.queueMicrotask(() => publishButtonRef.current?.focus());
  };
  const trapPublishingFocus = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closePublishing();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], summary, input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && globalThis.document.activeElement === first) {
      event.preventDefault();
      event.nativeEvent.preventDefault();
      window.queueMicrotask(() => last.focus());
    } else if (!event.shiftKey && globalThis.document.activeElement === last) {
      event.preventDefault();
      event.nativeEvent.preventDefault();
      window.queueMicrotask(() => first.focus());
    }
  };
  const keepPublishingFocus = (event: FocusEvent<HTMLElement>) => {
    if (event.currentTarget.contains(event.relatedTarget)) return;
    const dialog = event.currentTarget;
    window.queueMicrotask(() =>
      dialog.querySelector<HTMLElement>('button:not([disabled]), a[href], summary')?.focus(),
    );
  };
  const openFooterSettings = useCallback(() => {
    setPanel('settings');
    globalThis.setTimeout(() => {
      const target = globalThis.document.getElementById('footer-settings');
      target?.scrollIntoView({ block: 'start' });
      target?.focus();
    });
  }, []);
  return (
    <div className="editor-workspace">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <section className="workspace-too-small" role="alert" aria-labelledby="workspace-size-title">
        <p className="eyebrow">More room needed</p>
        <h1 id="workspace-size-title">Widen your browser to edit</h1>
        <p>
          PointSite Builder needs a window wider than 720 pixels. Your draft is safe—expand the
          browser and the editor will return automatically.
        </p>
      </section>
      <header className="editor-header">
        <button className="button" type="button" onClick={requestClose}>
          ← All drafts
        </button>
        <div>
          <DraftName name={draft.name} editable={editable} onRename={renameDraft} />
          <span>Revision {draft.revision.sequence}</span>
        </div>
        <div className="save-cluster">
          {themeToggle}
          <FeedbackButton
            screen={`editor.${panel}`}
            beforeLaunch={async () => {
              if (!autosave.canLeave) throw new Error('Autosave pending');
              if (checkout)
                await api.touchCheckout(draft.id, checkout.clientId, checkout.token, viewState());
              saveFeedbackWorkspace(`editor.${panel}`, draft.id);
            }}
          />
          <span className={`save-state save-state--${saveState}`} role="status" aria-live="polite">
            {autosave.message}
          </span>
          {saveState === 'error' || saveState === 'validation' ? (
            <button className="button" type="button" onClick={retryAutosave}>
              Retry autosave
            </button>
          ) : null}
          {canPublish && panel === 'layout' ? (
            <button
              ref={publishButtonRef}
              className="button button--primary"
              type="button"
              onClick={() => setPublishOpen(true)}
            >
              Publish
            </button>
          ) : null}
        </div>
      </header>
      <div className="autosave-recovery-slot">
        <p className="pending-journal-status" aria-live="off">
          {autosave.recovery === 'protected'
            ? 'Pending changes protected on this browser.'
            : autosave.recovery === 'writing'
              ? autosave.pendingCount
                ? 'Protecting pending changes…'
                : 'Clearing recovery copy…'
              : autosave.recovery === 'unavailable'
                ? 'Refresh recovery unavailable.'
                : autosave.recovery === 'blocked'
                  ? 'Pending recovery needs attention.'
                  : '\u00a0'}
        </p>
        {leaseExpiresAt &&
        checkoutPhase(leaseExpiresAt, leaseNow) === 'warning' &&
        !checkoutUnavailable ? (
          <section className="autosave-recovery" role="alert">
            <p>
              Your editing checkout expires in{' '}
              {Math.ceil(checkoutRemaining(leaseExpiresAt, leaseNow) / 60_000)} minutes without
              activity.
            </p>
          </section>
        ) : null}
        {checkoutUnavailable ? (
          <section className="autosave-recovery" role="alert">
            <p>
              This editing session is now read only because its checkout expired or moved to another
              device. Copy pending changes before leaving.
            </p>
          </section>
        ) : null}
        {autosave.alert ||
        recoveryStatus ||
        autosave.recovery === 'blocked' ||
        autosave.recovery === 'unavailable' ? (
          <section className="autosave-recovery" role="alert" aria-label="Autosave recovery">
            <p>{recoveryStatus || autosave.alert || autosave.recoveryMessage}</p>
            {autosave.recovery === 'blocked' || autosave.recovery === 'unavailable' ? (
              <button className="button" type="button" onClick={retryAutosave}>
                Retry recovery
              </button>
            ) : null}
            {!autosave.canLeave && autosave.recovery !== 'blocked' ? (
              <button className="button" type="button" onClick={() => void copyPendingDraft()}>
                Copy pending draft
              </button>
            ) : null}
            {saveState === 'conflict' ? (
              <button
                className="button"
                type="button"
                disabled={!recoveryCopied}
                onClick={() => void discardPending(false)}
              >
                Load latest version
              </button>
            ) : null}
            {!autosave.canLeave ? (
              <button
                className="button button--danger"
                type="button"
                disabled={
                  autosave.recovery === 'clearing' ||
                  (!recoveryCopied && autosave.recovery !== 'blocked')
                }
                onClick={() => void discardPending(true)}
              >
                Discard pending changes and leave
              </button>
            ) : null}
          </section>
        ) : null}
      </div>
      <nav className="editor-tabs" aria-label="Editor sections">
        {(
          [
            'layout',
            'forms',
            'library',
            'preview',
            'history',
            'settings',
            ...(role === 'administrator' ? ['admin' as const] : []),
          ] as Panel[]
        ).map((item) => (
          <button
            key={item}
            type="button"
            aria-current={panel === item ? 'page' : undefined}
            onClick={() => setPanel(item)}
          >
            {panelLabels[item]}
          </button>
        ))}
      </nav>
      {panel === 'layout' ? (
        <main id="main-content" className="content-workspace">
          <aside>
            <PageManager pageId={pageId} onPageIdChange={setPageId} />
            <StructurePanel
              pageId={pageId}
              onStructureChange={() => setStructureRevision((current) => current + 1)}
            />
          </aside>
          <section className="canvas-shell">
            {editable ? (
              <Suspense fallback={<p>Loading visual editor…</p>}>
                <VisualEditor
                  draftId={draft.id}
                  pageId={pageId}
                  structureRevision={structureRevision}
                  onEditFooter={openFooterSettings}
                />
              </Suspense>
            ) : (
              <Preview document={displayDocument} />
            )}
          </section>
        </main>
      ) : null}
      {panel === 'forms' ? (
        <main id="main-content" className="single-panel">
          {editable ? (
            <FormsEditor
              forms={document.forms}
              usedFormIds={
                new Set(
                  document.pages.flatMap((page) =>
                    page.blocks.flatMap((section) =>
                      section.items.flatMap((placement) =>
                        placement.element.type === 'form' ? [placement.element.formId] : [],
                      ),
                    ),
                  ),
                )
              }
              onChange={(forms) =>
                updateDocument((next) => ({ ...next, forms }), mutationForContext('forms'))
              }
            />
          ) : (
            <p>Viewer access is read only.</p>
          )}
        </main>
      ) : null}
      {panel === 'settings' ? (
        <main id="main-content" className="single-panel">
          {editable ? <SiteSettings /> : <p>Viewer access is read only.</p>}
        </main>
      ) : null}
      {panel === 'preview' ? (
        <main id="main-content" className="single-panel single-panel--preview">
          <Preview document={displayDocument} />
        </main>
      ) : null}
      {panel === 'library' ? (
        <main id="main-content" className="single-panel">
          <MediaLibrary
            draftId={draft.id}
            revisionChecksum={draft.revision.checksum}
            revisionId={draft.latestRevisionId}
            editable={editable && autosave.canLeave && saveState === 'saved'}
            disabledReason={
              role === 'viewer'
                ? 'Viewer access is read only.'
                : !editable
                  ? 'This draft is read only. An active checkout is required to change its Library.'
                  : 'Wait for all draft changes to save before changing the Library.'
            }
            runMutation={runLibraryMutation}
          />
        </main>
      ) : null}
      {panel === 'history' ? (
        <main id="main-content" className="single-panel">
          <RevisionHistory />
        </main>
      ) : null}
      {panel === 'admin' ? (
        <main id="main-content" className="single-panel">
          <AdminRoute />
        </main>
      ) : null}
      {publishOpen && canPublish && (role === 'publisher' || role === 'administrator') ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closePublishing();
          }}
        >
          <section
            className="modal-card publish-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="publish-title"
            onKeyDownCapture={trapPublishingFocus}
            onBlurCapture={keepPublishingFocus}
          >
            <button
              autoFocus
              className="button modal-close"
              type="button"
              onClick={closePublishing}
              aria-label="Close publishing window"
            >
              Close
            </button>
            <StagingPublish role={role} />
          </section>
        </div>
      ) : null}
    </div>
  );
}

export function EditorRoute({
  draft,
  checkout,
  role,
  canPublish,
  onClose,
  themeToggle,
  feedbackPanel,
}: {
  draft: DraftRecord;
  checkout: DraftCheckout | null;
  role: Role;
  canPublish: boolean;
  onClose: () => void;
  themeToggle: ReactNode;
  feedbackPanel?: Panel;
}) {
  return (
    <EditorProvider initialDraft={draft} checkout={checkout}>
      <Workspace
        role={role}
        canPublish={canPublish}
        onClose={onClose}
        themeToggle={themeToggle}
        checkout={checkout}
        feedbackPanel={feedbackPanel}
      />
    </EditorProvider>
  );
}
