import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from 'react';
import type { DraftRecord } from '../server/repositories/contracts';
import { api, ClientApiError, type ActorResponse } from './api';
import { DraftList } from './drafts/DraftList';
import { EditorRoute } from './editor/EditorRoute';

export class BuilderErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('PointSite Builder rendering failed', error, info.componentStack);
  }

  render() {
    if (this.state.failed)
      return (
        <main id="main-content" className="state-page">
          <h1>Builder view interrupted</h1>
          <p>
            Your draft and public website are unaffected. Reload the private workspace to continue.
          </p>
          <button className="button" onClick={() => window.location.reload()}>
            Reload builder
          </button>
        </main>
      );
    return this.props.children;
  }
}

export function App() {
  const [builderTheme, setBuilderTheme] = useState<'dark' | 'light'>(() => {
    const saved = globalThis.localStorage?.getItem('pointsite-builder:theme:v1');
    return saved === 'light' ? 'light' : 'dark';
  });
  const [actor, setActor] = useState<ActorResponse | null>(null);
  const [drafts, setDrafts] = useState<DraftRecord[]>([]);
  const [selected, setSelected] = useState<DraftRecord | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'signed-out' | 'denied' | 'error'>(
    'loading',
  );
  const failureState = (error: unknown) => {
    if (error instanceof ClientApiError && error.status === 401) return 'signed-out' as const;
    if (error instanceof ClientApiError && error.status === 403) return 'denied' as const;
    return 'error' as const;
  };
  const load = async () => {
    try {
      const [identity, items] = await Promise.all([api.me(), api.listDrafts()]);
      setActor(identity);
      setDrafts(items);
      setState('ready');
    } catch (error) {
      setState(failureState(error));
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
        setState(failureState(error));
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    document.documentElement.setAttribute('data-builder-theme', builderTheme);
    document.querySelector('.builder-app')?.setAttribute('data-builder-theme', builderTheme);
    localStorage.setItem('pointsite-builder:theme:v1', builderTheme);
  }, [builderTheme]);

  const themeToggle = (
    <button
      className="button theme-toggle"
      type="button"
      aria-pressed={builderTheme === 'light'}
      onClick={() => setBuilderTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
    >
      {builderTheme === 'dark' ? 'Light mode' : 'Dark mode'}
    </button>
  );

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
        <p>Your GitHub login is valid, but collaboration or a Builder role is not active.</p>
      </main>
    );
  if (state === 'signed-out')
    return (
      <main id="main-content" className="state-page">
        <p className="eyebrow">Private workspace</p>
        <h1>Sign in to PointSite Builder</h1>
        <p>Use an approved PointCommunity GitHub collaborator account.</p>
        <a className="button button--primary" href="/auth/login">
          Sign in with GitHub
        </a>
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
        canPublish={
          (actor.role === 'publisher' || actor.role === 'administrator') &&
          Boolean(
            actor.repositoryPermission &&
            ['write', 'maintain', 'admin'].includes(actor.repositoryPermission),
          )
        }
        onClose={() => {
          setSelected(null);
          void load();
        }}
        themeToggle={themeToggle}
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
          <span>{actor.displayName ?? actor.email}</span>
          <span className="environment-label">{actor.role}</span>
          {themeToggle}
          <form action="/auth/logout" method="post">
            <button className="button" type="submit">
              Sign out
            </button>
          </form>
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
