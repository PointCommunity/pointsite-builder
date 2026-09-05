import { useEffect, useState } from 'react';
import type { RevisionRecord } from '../../server/repositories/contracts';
import { api } from '../api';
import { useEditor } from '../editor/EditorProvider';

export function RevisionHistory() {
  const { draft, reloadLatest } = useEditor();
  const [items, setItems] = useState<RevisionRecord[]>([]);
  const [error, setError] = useState('');
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
      <ol>
        {items.map((revision) => (
          <li key={revision.id}>
            <div>
              <strong>{revision.label || `Revision ${revision.sequence}`}</strong>
              <span>
                {new Date(revision.createdAt).toLocaleString()} · {revision.createdBy}
              </span>
            </div>
            {revision.id !== draft.revision.id ? (
              <button
                className="button"
                onClick={() => {
                  if (window.confirm(`Restore revision ${revision.sequence} as a new revision?`))
                    void api
                      .restoreRevision(draft.id, revision.id, draft.revision.checksum)
                      .then(reloadLatest);
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
