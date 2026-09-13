import { Component, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import type {
  DraftCheckout,
  DraftCheckoutAvailability,
  DraftRecord,
} from '../server/repositories/contracts';
import { api, ClientApiError, type ActorResponse } from './api';
import { DraftList } from './drafts/DraftList';
import { EditorRoute } from './editor/EditorRoute';
import { FeedbackButton } from './feedback/FeedbackButton';
import {
  clearFeedbackWorkspace,
  readFeedbackWorkspace,
  saveFeedbackWorkspace,
} from './feedback/workspace';
import type { EditorPanel } from '../server/repositories/contracts';
import { PendingJournal } from './editor/pending-journal';

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
  const [feedbackWorkspace] = useState(readFeedbackWorkspace);
  const [feedbackPanel, setFeedbackPanel] = useState<EditorPanel | undefined>(() =>
    feedbackWorkspace?.screen.startsWith('editor.')
      ? (feedbackWorkspace.screen.slice(7) as EditorPanel)
      : undefined,
  );
  const [builderTheme, setBuilderTheme] = useState<'dark' | 'light'>(() => {
    const saved = globalThis.localStorage?.getItem('pointsite-builder:theme:v1');
    return saved === 'light' ? 'light' : 'dark';
  });
  const [actor, setActor] = useState<ActorResponse | null>(null);
  const [drafts, setDrafts] = useState<DraftRecord[]>([]);
  const [selected, setSelected] = useState<DraftRecord | null>(null);
  const [checkout, setCheckout] = useState<DraftCheckout | null>(null);
  const [checkouts, setCheckouts] = useState<DraftCheckoutAvailability[]>([]);
  const [checkoutConflict, setCheckoutConflict] = useState(false);
  const checkoutTrigger = useRef<HTMLButtonElement | null>(null);
  const logoutForm = useRef<HTMLFormElement | null>(null);
  const [pendingSignout, setPendingSignout] = useState(false);
  const [signoutError, setSignoutError] = useState('');
  const [clientId] = useState(() => {
    const key = 'pointsite-builder:editing-client:v1';
    const existing = globalThis.sessionStorage?.getItem(key);
    if (existing) return existing;
    const created = crypto.randomUUID();
    globalThis.sessionStorage?.setItem(key, created);
    return created;
  });
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
        clearFeedbackWorkspace();
        if (feedbackWorkspace?.screen === 'dashboard') return;
        if (feedbackWorkspace?.draftId) {
          const returningDraft = items.find((item) => item.id === feedbackWorkspace.draftId);
          if (
            returningDraft &&
            (identity.role === 'viewer' || returningDraft.status !== 'active')
          ) {
            setSelected(returningDraft);
            return;
          }
        }
        if (identity.role !== 'viewer') {
          void api
            .ownedCheckout()
            .then(async (owned) => {
              if (!active || !owned) return;
              const draft = items.find((item) => item.id === owned.draftId);
              if (!draft) return;
              const acquired = await api.acquireCheckout(draft.id, clientId, true);
              if (!active) return;
              setCheckout(acquired);
              setSelected(await api.getDraft(draft.id));
            })
            .catch(() => undefined);
        }
      })
      .catch((error: unknown) => {
        if (!active) return;
        setState(failureState(error));
      });
    return () => {
      active = false;
    };
  }, [clientId, feedbackWorkspace]);
  useEffect(() => {
    if (state !== 'ready' || selected) return;
    let active = true;
    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      void api
        .listCheckouts()
        .then((items) => {
          if (active) setCheckouts(items);
        })
        .catch(() => undefined);
    };
    refresh();
    const timer = window.setInterval(refresh, 4_000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [selected, state]);
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
        checkout={checkout}
        role={actor.role}
        feedbackPanel={feedbackWorkspace?.draftId === selected.id ? feedbackPanel : undefined}
        canPublish={
          (actor.role === 'publisher' || actor.role === 'administrator') &&
          Boolean(
            actor.repositoryPermission &&
            ['write', 'maintain', 'admin'].includes(actor.repositoryPermission),
          )
        }
        onClose={() => {
          setFeedbackPanel(undefined);
          setSelected(null);
          setCheckout(null);
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
          <FeedbackButton
            screen="dashboard"
            beforeLaunch={() => {
              saveFeedbackWorkspace('dashboard');
              return Promise.resolve();
            }}
          />
          <form
            ref={logoutForm}
            action="/auth/logout"
            method="post"
            onSubmit={(event) => {
              if (typeof indexedDB === 'undefined') return;
              event.preventDefault();
              void PendingJournal.prepareSignout(actor.email)
                .then((ready) => {
                  if (ready) logoutForm.current?.submit();
                  else setPendingSignout(true);
                })
                .catch(() => {
                  setSignoutError(
                    'Browser recovery could not be checked. Retry before signing out.',
                  );
                  setPendingSignout(true);
                });
            }}
          >
            <button className="button" type="submit">
              Sign out
            </button>
          </form>
        </div>
      </header>
      <main id="main-content">
        {pendingSignout ? (
          <section
            className="autosave-recovery"
            role="alert"
            aria-label="Pending changes before sign out"
          >
            <p>
              {signoutError ||
                'Pending changes remain on this browser. Return to the draft to save them, or discard your pending changes before signing out.'}
            </p>
            <button
              className="button"
              type="button"
              onClick={() => {
                setPendingSignout(false);
                setSignoutError('');
              }}
            >
              Keep working
            </button>
            <button
              className="button button--danger"
              type="button"
              onClick={() => {
                void PendingJournal.discardPending(actor.email)
                  .then(() => logoutForm.current?.submit())
                  .catch(() =>
                    setSignoutError(
                      'Sign-out could not finish. Retry after saving or discarding pending changes.',
                    ),
                  );
              }}
            >
              Discard my pending changes and sign out
            </button>
          </section>
        ) : null}
        <DraftList
          drafts={drafts}
          role={actor.role}
          checkouts={checkouts}
          onOpen={async (draft, trigger) => {
            checkoutTrigger.current = trigger ?? null;
            if (actor.role === 'viewer' || draft.status !== 'active') {
              setSelected(draft);
              return;
            }
            try {
              const acquired = await api.acquireCheckout(draft.id, clientId);
              setCheckout(acquired);
              setSelected(await api.getDraft(draft.id));
            } catch (error) {
              if (error instanceof ClientApiError && error.status === 409)
                setCheckoutConflict(true);
              else throw error;
            }
          }}
          onCreate={async (name) => {
            const draft = await api.createDraft(name);
            setDrafts((current) => [draft, ...current]);
            setCheckout(await api.acquireCheckout(draft.id, clientId));
            setSelected(draft);
          }}
          onDuplicate={async (source) => {
            const draft = await api.createDraft(`${source.name} copy`, source.revision.id);
            setDrafts((current) => [draft, ...current]);
            setCheckout(await api.acquireCheckout(draft.id, clientId));
            setSelected(draft);
          }}
          onArchive={async (draft) => {
            const updated = await api.setDraftStatus(draft.id, 'archive');
            setDrafts((current) =>
              current.map((item) => (item.id === updated.id ? updated : item)),
            );
          }}
          onUnarchive={async (draft) => {
            const updated = await api.setDraftStatus(draft.id, 'recover');
            setDrafts((current) =>
              current.map((item) => (item.id === updated.id ? updated : item)),
            );
          }}
          onDelete={async (draft) => {
            await api.deleteDraft(draft.id);
            setDrafts((current) => current.filter((item) => item.id !== draft.id));
          }}
        />
        {checkoutConflict ? (
          <div className="dialog-backdrop">
            <section
              className="confirmation-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="checkout-conflict-title"
            >
              <h2 id="checkout-conflict-title">Draft already checked out</h2>
              <p>Another editor acquired this draft first. No changes were made.</p>
              <button
                autoFocus
                className="button button--primary"
                type="button"
                onClick={() => {
                  setCheckoutConflict(false);
                  window.queueMicrotask(() => checkoutTrigger.current?.focus());
                }}
              >
                Continue
              </button>
            </section>
          </div>
        ) : null}
      </main>
    </div>
  );
}
