import { lazy, Suspense, useState, type ReactNode } from 'react';
import type { DraftRecord, Role } from '../../server/repositories/contracts';
import { Preview } from '../preview/Preview';
import { RevisionHistory } from '../revisions/RevisionHistory';
import { SiteSettings } from '../settings/SiteSettings';
import { StagingPublish } from '../publish/StagingPublish';
import { MediaLibrary } from '../media/MediaLibrary';
import { AdminRoute } from '../admin/AdminRoute';
import { EditorProvider, useEditor } from './EditorProvider';
import { PageManager } from './PageManager';
import { StructurePanel } from './StructurePanel';

const VisualEditor = lazy(() =>
  import('./VisualEditor').then((module) => ({ default: module.VisualEditor })),
);
type Panel = 'content' | 'settings' | 'media' | 'preview' | 'history' | 'publish' | 'admin';

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
  const [panel, setPanel] = useState<Panel>(role === 'viewer' ? 'preview' : 'content');
  const [pageId, setPageId] = useState(document.pages[0]?.id ?? '');
  const [structureRevision, setStructureRevision] = useState(0);
  const editable = role !== 'viewer' && draft.status === 'active';
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
        </div>
      </header>
      <nav className="editor-tabs" aria-label="Editor sections">
        {(
          [
            'content',
            'settings',
            'media',
            'preview',
            'history',
            ...(canPublish ? ['publish' as const] : []),
            ...(role === 'administrator' ? ['admin' as const] : []),
          ] as Panel[]
        ).map((item) => (
          <button
            key={item}
            type="button"
            aria-current={panel === item ? 'page' : undefined}
            onClick={() => setPanel(item)}
          >
            {item}
          </button>
        ))}
      </nav>
      {panel === 'content' ? (
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
                <VisualEditor pageId={pageId} structureRevision={structureRevision} />
              </Suspense>
            ) : (
              <Preview document={document} />
            )}
          </section>
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
      {panel === 'media' ? (
        <main id="main-content" className="single-panel">
          <MediaLibrary
            onSelect={(item) => {
              const extension =
                item.contentType === 'image/jpeg' ? 'jpg' : item.contentType.replace('image/', '');
              updateDocument((next) => {
                if (!next.media.some((media) => media.id === item.id)) {
                  next.media.push({
                    id: item.id,
                    sourcePath: `/assets/builder/${item.id}.${extension}`,
                    alt: item.altText,
                  });
                }
                return next;
              });
              setPanel('content');
            }}
          />
        </main>
      ) : null}
      {panel === 'history' ? (
        <main id="main-content" className="single-panel">
          <RevisionHistory />
        </main>
      ) : null}
      {panel === 'publish' ? (
        <main id="main-content" className="single-panel">
          <StagingPublish />
        </main>
      ) : null}
      {panel === 'admin' ? (
        <main id="main-content" className="single-panel">
          <AdminRoute />
        </main>
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
