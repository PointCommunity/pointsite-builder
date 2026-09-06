import { useEffect, useRef, useState } from 'react';
import type { DraftRecord, Role } from '../../server/repositories/contracts';
import { DELETE_DRAFT_CONFIRMATION } from '../../shared/draft-lifecycle';

function DeleteDraftDialog({
  draft,
  onCancel,
  onConfirm,
}: {
  draft: DraftRecord;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [confirmation, setConfirmation] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  const close = () => {
    if (!deleting) onCancel();
  };

  return (
    <div className="dialog-backdrop">
      <div
        className="confirmation-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-draft-title"
        aria-describedby="delete-draft-description"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            close();
            return;
          }
          if (event.key !== 'Tab') return;
          const focusable = [inputRef.current, cancelRef.current, confirmRef.current].filter(
            (element): element is HTMLInputElement | HTMLButtonElement =>
              Boolean(element && !element.hasAttribute('disabled')),
          );
          const first = focusable[0];
          const last = focusable.at(-1);
          if (!first || !last) return;
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <p className="eyebrow">Destructive action</p>
        <h2 id="delete-draft-title">Delete {draft.name}?</h2>
        <p id="delete-draft-description">
          This removes the draft from the workspace. Type{' '}
          <strong>{DELETE_DRAFT_CONFIRMATION}</strong> exactly to confirm. Confirmation is
          case-sensitive.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (confirmation !== DELETE_DRAFT_CONFIRMATION || deleting) return;
            setDeleting(true);
            setError('');
            void onConfirm().catch(() => {
              setDeleting(false);
              setError('The draft could not be deleted. Nothing was removed. Try again.');
              inputRef.current?.focus();
            });
          }}
        >
          <label>
            <span>Type DELETE to confirm</span>
            <input
              ref={inputRef}
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              disabled={deleting}
            />
          </label>
          {error ? (
            <p className="dialog-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="button-row confirmation-dialog__actions">
            <button
              ref={cancelRef}
              className="button"
              type="button"
              onClick={close}
              disabled={deleting}
            >
              Cancel
            </button>
            <button
              ref={confirmRef}
              className="button button--danger button--danger-filled"
              type="submit"
              disabled={confirmation !== DELETE_DRAFT_CONFIRMATION || deleting}
            >
              {deleting ? 'Deleting…' : 'Delete draft'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function DraftList({
  drafts,
  role,
  onOpen,
  onCreate,
  onDuplicate,
  onArchive,
  onUnarchive,
  onDelete,
}: {
  drafts: DraftRecord[];
  role: Role;
  onOpen: (draft: DraftRecord) => void;
  onCreate: (name: string) => Promise<void>;
  onDuplicate: (draft: DraftRecord) => Promise<void>;
  onArchive: (draft: DraftRecord) => Promise<void>;
  onUnarchive: (draft: DraftRecord) => Promise<void>;
  onDelete: (draft: DraftRecord) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<DraftRecord | null>(null);
  const deleteTrigger = useRef<HTMLButtonElement | null>(null);
  const canEdit = role !== 'viewer';
  const closeDeleteDialog = () => {
    setDeleteTarget(null);
    deleteTrigger.current?.focus();
  };
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
                {canEdit ? (
                  <>
                    <button className="button" onClick={() => void onDuplicate(draft)}>
                      Duplicate
                    </button>
                    {draft.status === 'active' ? (
                      <button className="button" onClick={() => void onArchive(draft)}>
                        Archive
                      </button>
                    ) : draft.status === 'archived' ? (
                      <>
                        <button className="button" onClick={() => void onUnarchive(draft)}>
                          Unarchive
                        </button>
                        <button
                          ref={(element) => {
                            if (deleteTarget?.id === draft.id) deleteTrigger.current = element;
                          }}
                          className="button button--danger"
                          onClick={(event) => {
                            deleteTrigger.current = event.currentTarget;
                            setDeleteTarget(draft);
                          }}
                        >
                          Delete
                        </button>
                      </>
                    ) : null}
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      {deleteTarget ? (
        <DeleteDraftDialog
          draft={deleteTarget}
          onCancel={closeDeleteDialog}
          onConfirm={async () => {
            await onDelete(deleteTarget);
            closeDeleteDialog();
          }}
        />
      ) : null}
    </section>
  );
}
