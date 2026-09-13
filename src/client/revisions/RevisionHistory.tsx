import { useEffect, useRef, useState } from 'react';
import type { RevisionSummary } from '../../server/repositories/contracts';
import { draftActionCategoryLabel, draftActionContextLabel } from '../../shared/draft-actions';
import { api } from '../api';
import { useEditor } from '../editor/EditorProvider';

export function RevisionHistory({ editable }: { editable: boolean }) {
  const { draft, restoreRevision, labelRevision } = useEditor();
  const [items, setItems] = useState<RevisionSummary[]>([]);
  const [error, setError] = useState('');
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'named' | 'current'>('all');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadedKey, setLoadedKey] = useState('');
  const pending = useRef<AbortController | null>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const key = JSON.stringify([draft.id, draft.revision.id, query.trim(), filter]);
  useEffect(() => {
    const controller = new AbortController();
    pending.current = controller;
    const timer = window.setTimeout(
      () => {
        setLoading(true);
        setError('');
        void api
          .listRevisions(draft.id, { query: query.trim(), filter, signal: controller.signal })
          .then((page) => {
            if (controller.signal.aborted) return;
            setItems(page.items);
            setNextCursor(page.nextCursor);
            setLoadedKey(key);
          })
          .catch(() => {
            if (!controller.signal.aborted) setError('Revision history could not be loaded.');
          })
          .finally(() => {
            if (!controller.signal.aborted) setLoading(false);
          });
      },
      query.trim() ? 250 : 0,
    );
    return () => {
      window.clearTimeout(timer);
      pending.current?.abort();
    };
  }, [draft.id, key, query, filter]);

  const loadMore = async () => {
    if (!nextCursor || loading || loadedKey !== key) return;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true);
    setError('');
    const trigger = moreButton.current;
    const moveFocus = document.activeElement === trigger;
    try {
      const page = await api.listRevisions(draft.id, {
        cursor: nextCursor,
        query: query.trim(),
        filter,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setItems((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor);
      if (moveFocus && page.items[0])
        window.requestAnimationFrame(() => {
          if (
            !controller.signal.aborted &&
            (document.activeElement === trigger || document.activeElement === document.body)
          )
            document.getElementById(`history-revision-${page.items[0].id}`)?.focus();
        });
    } catch {
      if (!controller.signal.aborted) setError('Older revisions could not be loaded. Try again.');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  };
  const visible = items.filter((revision) => {
    if (filter === 'named' && !revision.label) return false;
    if (filter === 'current' && revision.id !== draft.revision.id) return false;
    const term = query.trim().toLowerCase();
    return (
      !term ||
      `${revision.label ?? ''} ${revision.sequence} ${revision.createdBy}`
        .toLowerCase()
        .includes(term)
    );
  });
  return (
    <section className="revision-panel" aria-labelledby="revision-title">
      <header className="section-heading">
        <div>
          <p className="eyebrow">Saved changes</p>
          <h2 id="revision-title">Revision history</h2>
        </div>
        <p>Find, name, or restore an earlier version.</p>
      </header>
      <div className="history-filters" role="search">
        <label>
          <span>Find a revision</span>
          <input
            type="search"
            maxLength={100}
            placeholder="Search by name, number, or person"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label>
          <span>Show</span>
          <select
            value={filter}
            onChange={(event) => setFilter(event.target.value as typeof filter)}
          >
            <option value="all">All revisions</option>
            <option value="named">Named revisions</option>
            <option value="current">Current revision</option>
          </select>
        </label>
        <span>
          {visible.length} {visible.length === 1 ? 'revision' : 'revisions'}
        </span>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      <p role="status" aria-live="polite">
        {loading ? 'Loading revision history…' : status}
      </p>
      <ol>
        {visible.map((revision) => (
          <li key={revision.id} id={`history-revision-${revision.id}`} tabIndex={-1}>
            <div>
              <strong>{revision.label || `Revision ${revision.sequence}`}</strong>
              <span>
                {new Date(revision.createdAt).toLocaleString()} · {revision.createdBy}
              </span>
              <span>
                {draftActionCategoryLabel(revision.actionCategory)} ·{' '}
                {draftActionContextLabel(revision.actionContext)}
              </span>
              <span>
                Revision {revision.sequence} · renderer {revision.rendererVersion} ·{' '}
                {revision.checksum.slice(0, 12)}
              </span>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const label = labels[revision.id]?.trim();
                  if (!label) return;
                  setStatus('Saving revision label…');
                  void labelRevision(revision.id, label)
                    .then((updated) => {
                      setItems((current) =>
                        current.map((item) => (item.id === updated.id ? updated : item)),
                      );
                      setStatus('Revision label saved.');
                    })
                    .catch(() => setStatus('Revision label could not be saved.'));
                }}
              >
                <label>
                  <span className="visually-hidden">Label for revision {revision.sequence}</span>
                  <input
                    disabled={!editable}
                    maxLength={100}
                    name={`revision-label-${revision.id}`}
                    autoComplete="off"
                    placeholder="Name this revision…"
                    value={labels[revision.id] ?? revision.label ?? ''}
                    onChange={(event) =>
                      setLabels((current) => ({ ...current, [revision.id]: event.target.value }))
                    }
                  />
                </label>
                <button className="button" type="submit" disabled={!editable}>
                  Save label
                </button>
              </form>
            </div>
            {revision.id !== draft.revision.id ? (
              <button
                className="button"
                type="button"
                disabled={!editable}
                onClick={() => {
                  if (window.confirm(`Restore revision ${revision.sequence} as a new revision?`))
                    void restoreRevision(revision.id)
                      .then(() =>
                        setStatus(`Revision ${revision.sequence} restored as a new revision.`),
                      )
                      .catch((error: unknown) =>
                        setStatus(
                          error instanceof Error
                            ? error.message
                            : 'Revision could not be restored.',
                        ),
                      );
                }}
              >
                Restore
              </button>
            ) : (
              <span className="status-badge">Current</span>
            )}
          </li>
        ))}
      </ol>
      {nextCursor && loadedKey === key ? (
        <button
          ref={moreButton}
          className="button"
          type="button"
          disabled={loading}
          onClick={() => void loadMore()}
        >
          Load older revisions
        </button>
      ) : null}
    </section>
  );
}
