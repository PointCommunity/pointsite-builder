import { lazy, Suspense, useState, type ReactNode } from 'react';
import type { DraftRecord, Role } from '../../server/repositories/contracts';
import { Preview } from '../preview/Preview';
import { RevisionHistory } from '../revisions/RevisionHistory';
import { SiteSettings } from '../settings/SiteSettings';
import { FormsEditor } from '../settings/FormsEditor';
import { StagingPublish } from '../publish/StagingPublish';
import { MediaLibrary } from '../media/MediaLibrary';
import { AdminRoute } from '../admin/AdminRoute';
import { EditorProvider, useEditor } from './EditorProvider';
import { PageManager } from './PageManager';
import { StructurePanel } from './StructurePanel';

const VisualEditor = lazy(() =>
  import('./VisualEditor').then((module) => ({ default: module.VisualEditor })),
);
type Panel = 'layout' | 'forms' | 'library' | 'preview' | 'history' | 'settings' | 'admin';
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
}: {
  role: Role;
  canPublish: boolean;
  onClose: () => void;
  themeToggle: ReactNode;
}) {
  const { draft, document, updateDocument, saveNow, saveState, reloadLatest } = useEditor();
  const [panel, setPanel] = useState<Panel>(role === 'viewer' ? 'preview' : 'layout');
  const [publishOpen, setPublishOpen] = useState(false);
  const [pageId, setPageId] = useState(document.pages[0]?.id ?? '');
  const [structureRevision, setStructureRevision] = useState(0);
  const editable = role !== 'viewer' && draft.status === 'active';
  const openFooterSettings = () => {
    setPanel('settings');
    globalThis.setTimeout(() => {
      const target = globalThis.document.getElementById('footer-settings');
      target?.scrollIntoView({ block: 'start' });
      target?.focus();
    });
  };
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
        <button className="button" type="button" onClick={onClose}>
          ← All drafts
        </button>
        <div>
          <h1 className="editor-title">{draft.name}</h1>
          <span>Revision {draft.revision.sequence}</span>
        </div>
        <div className="save-cluster">
          {themeToggle}
          <span className={`save-state save-state--${saveState}`} role="status" aria-live="polite">
            {saveState === 'saved' ? 'All changes saved' : saveState}
          </span>
          {saveState === 'conflict' ? (
            <button className="button" type="button" onClick={() => void reloadLatest()}>
              Load latest
            </button>
          ) : null}
          {editable ? (
            <button
              className="button button--primary"
              type="button"
              disabled={saveState === 'saved' || saveState === 'saving'}
              onClick={() => void saveNow()}
            >
              Save now
            </button>
          ) : null}
          {canPublish && panel === 'layout' ? (
            <button
              className="button button--primary"
              type="button"
              onClick={() => setPublishOpen(true)}
            >
              Publish
            </button>
          ) : null}
        </div>
      </header>
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
                  pageId={pageId}
                  structureRevision={structureRevision}
                  onEditFooter={openFooterSettings}
                />
              </Suspense>
            ) : (
              <Preview document={document} />
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
              onChange={(forms) => updateDocument((next) => ({ ...next, forms }))}
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
          <Preview document={document} />
        </main>
      ) : null}
      {panel === 'library' ? (
        <main id="main-content" className="single-panel">
          <MediaLibrary
            document={document}
            onDocumentChange={(next) => updateDocument(() => next)}
            onSelect={(item) => {
              const extension =
                item.contentType === 'image/jpeg' ? 'jpg' : item.contentType.replace('image/', '');
              updateDocument((next) => {
                if (!next.media.some((media) => media.id === item.id)) {
                  next.media.push({
                    id: item.id,
                    sourcePath: `/assets/builder/${item.id}.${extension}`,
                    alt: item.altText,
                    displayName: item.displayName,
                    tags: item.tags,
                  });
                }
                return next;
              });
              setPanel('layout');
            }}
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
      {publishOpen && canPublish ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onKeyDown={(event) => {
            if (event.key === 'Escape') setPublishOpen(false);
          }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPublishOpen(false);
          }}
        >
          <section
            className="modal-card publish-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="publish-title"
          >
            <button
              autoFocus
              className="button modal-close"
              type="button"
              onClick={() => setPublishOpen(false)}
              aria-label="Close publishing window"
            >
              Close
            </button>
            <StagingPublish />
          </section>
        </div>
      ) : null}
    </div>
  );
}

export function EditorRoute({
  draft,
  role,
  canPublish,
  onClose,
  themeToggle,
}: {
  draft: DraftRecord;
  role: Role;
  canPublish: boolean;
  onClose: () => void;
  themeToggle: ReactNode;
}) {
  return (
    <EditorProvider initialDraft={draft}>
      <Workspace role={role} canPublish={canPublish} onClose={onClose} themeToggle={themeToggle} />
    </EditorProvider>
  );
}
