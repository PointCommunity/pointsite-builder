import { useEffect, useState } from 'react';
import type { DraftRecord } from '../server/repositories/contracts';
import { api, type ActorResponse } from './api';
import { DraftList } from './drafts/DraftList';
import { EditorRoute } from './editor/EditorRoute';

export function App() {
  const [actor, setActor] = useState<ActorResponse | null>(null);
  const [drafts, setDrafts] = useState<DraftRecord[]>([]);
  const [selected, setSelected] = useState<DraftRecord | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'denied' | 'error'>('loading');
  const load = async () => {
    try {
      const [identity, items] = await Promise.all([api.me(), api.listDrafts()]);
      setActor(identity);
      setDrafts(items);
      setState('ready');
    } catch (error) {
      setState(
        error instanceof Error && error.message.toLowerCase().includes('access')
          ? 'denied'
          : 'error',
      );
    }
  };
  useEffect(() => {
    let active = true;
    void Promise.all([api.me(), api.listDrafts()])
      .then(([identity, items]) => {
        if (!active) return;
        setActor(identity);
        setDrafts(items);
        setState('ready');
      })
      .catch((error: unknown) => {
        if (!active) return;
        setState(
          error instanceof Error && error.message.toLowerCase().includes('access')
            ? 'denied'
            : 'error',
        );
      });
    return () => {
      active = false;
    };
  }, []);

  if (state === 'loading')
    return (
      <main id="main-content" className="state-page">
        <p role="status">Loading your PointSite workspace…</p>
      </main>
    );
  if (state === 'denied')
    return (
      <main id="main-content" className="state-page">
        <h1>Access not assigned</h1>
        <p>Your Cloudflare login is valid, but a builder role has not been assigned.</p>
      </main>
    );
  if (state === 'error' || !actor)
    return (
      <main id="main-content" className="state-page">
        <h1>Builder unavailable</h1>
        <p>The private workspace could not be loaded. Your public website is unaffected.</p>
        <button className="button" onClick={() => void load()}>
          Try again
        </button>
      </main>
    );
  if (selected)
    return (
      <EditorRoute
        draft={selected}
        role={actor.role}
        onClose={() => {
          setSelected(null);
          void load();
        }}
      />
    );
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <header className="app-header">
        <div>
          <span className="brand-mark" aria-hidden="true">
            P
          </span>
          <span>PointSite Builder</span>
        </div>
        <div className="identity">
          <span>{actor.email}</span>
          <span className="environment-label">{actor.role}</span>
        </div>
      </header>
      <main id="main-content">
        <DraftList
          drafts={drafts}
          role={actor.role}
          onOpen={setSelected}
          onCreate={async (name) => {
            const draft = await api.createDraft(name);
            setDrafts((current) => [draft, ...current]);
            setSelected(draft);
          }}
          onDuplicate={async (source) => {
            const draft = await api.createDraft(`${source.name} copy`, source.revision.id);
            setDrafts((current) => [draft, ...current]);
            setSelected(draft);
          }}
          onArchive={async (draft) => {
            await api.setDraftStatus(draft.id, 'archive');
            setDrafts((current) => current.filter((item) => item.id !== draft.id));
          }}
        />
      </main>
    </div>
  );
}
