import { useEffect, useState } from 'react';
import type { RevisionRecord } from '../../server/repositories/contracts';
import { api } from '../api';
import { useEditor } from '../editor/EditorProvider';

export function RevisionHistory() {
  const { draft, reloadLatest } = useEditor();
  const [items, setItems] = useState<RevisionRecord[]>([]);
  const [error, setError] = useState('');
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [status, setStatus] = useState('');
  useEffect(() => {
    void api
      .listRevisions(draft.id)
      .then(setItems)
      .catch(() => setError('Revision history could not be loaded.'));
  }, [draft.id, draft.revision.id]);
  return (
    <section className="revision-panel" aria-labelledby="revision-title">
      <h2 id="revision-title">Revision history</h2>
      {error ? <p role="alert">{error}</p> : null}
      <p role="status" aria-live="polite">
        {status}
      </p>
      <ol>
        {items.map((revision) => (
          <li key={revision.id}>
            <div>
              <strong>{revision.label || `Revision ${revision.sequence}`}</strong>
              <span>
                {new Date(revision.createdAt).toLocaleString()} · {revision.createdBy}
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
                  void api
                    .labelRevision(draft.id, revision.id, label)
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
                <button className="button" type="submit">
                  Save label
                </button>
              </form>
            </div>
            {revision.id !== draft.revision.id ? (
              <button
                className="button"
                type="button"
                onClick={() => {
                  if (window.confirm(`Restore revision ${revision.sequence} as a new revision?`))
                    void api
                      .restoreRevision(draft.id, revision.id, draft.revision.checksum)
                      .then(reloadLatest)
                      .then(() =>
                        setStatus(`Revision ${revision.sequence} restored as a new revision.`),
                      )
                      .catch(() => setStatus('Revision could not be restored.'));
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
    </section>
  );
}
