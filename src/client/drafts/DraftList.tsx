import { useState } from 'react';
import type { DraftRecord, Role } from '../../server/repositories/contracts';

export function DraftList({
  drafts,
  role,
  onOpen,
  onCreate,
  onDuplicate,
  onArchive,
}: {
  drafts: DraftRecord[];
  role: Role;
  onOpen: (draft: DraftRecord) => void;
  onCreate: (name: string) => Promise<void>;
  onDuplicate: (draft: DraftRecord) => Promise<void>;
  onArchive: (draft: DraftRecord) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const canEdit = role !== 'viewer';
  return (
    <section className="drafts-panel" aria-labelledby="drafts-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Workspace</p>
          <h1 id="drafts-title">Website drafts</h1>
          <p className="safety-note">Publishing is staging-only. Production remains locked.</p>
        </div>
        {canEdit ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim()) void onCreate(name.trim()).then(() => setName(''));
            }}
            className="create-draft"
          >
            <label>
              <span>New draft name</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={100}
                required
              />
            </label>
            <button className="button button--primary" type="submit">
              Create draft
            </button>
          </form>
        ) : null}
      </div>
      {drafts.length === 0 ? (
        <div className="empty-state">
          <h2>No drafts yet</h2>
          <p>Create the first safe copy of PointSite to begin.</p>
        </div>
      ) : (
        <ul className="draft-grid">
          {drafts.map((draft) => (
            <li className="draft-card" key={draft.id}>
              <p className="status-badge">{draft.status}</p>
              <h2>{draft.name}</h2>
              <p>
                Revision {draft.revision.sequence} · {new Date(draft.updatedAt).toLocaleString()}
              </p>
              <div className="button-row">
                <button className="button button--primary" onClick={() => onOpen(draft)}>
                  Open {canEdit ? 'editor' : 'preview'}
                </button>
                {canEdit && draft.status === 'active' ? (
                  <>
                    <button className="button" onClick={() => void onDuplicate(draft)}>
                      Duplicate
                    </button>
                    <button className="button" onClick={() => void onArchive(draft)}>
                      Archive
                    </button>
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
