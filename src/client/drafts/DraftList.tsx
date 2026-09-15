import { useEffect, useRef, useState } from 'react';
import type {
  DraftCheckoutAvailability,
  DraftSummary,
  Role,
} from '../../server/repositories/contracts';
import { DELETE_DRAFT_CONFIRMATION } from '../../shared/draft-lifecycle';
import { api, ClientApiError } from '../api';
import type { PublicationSourceIdentity } from '../../server/repositories/contracts';
import { publicationExplanation, publicationLabel } from './publication-status';

function CreateDraftDialog({
  name,
  onCancel,
  onCreate,
}: {
  name: string;
  onCancel: () => void;
  onCreate: (target: 'staging' | 'production', source: PublicationSourceIdentity) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [target, setTarget] = useState<'' | 'staging' | 'production'>('');
  const [refresh, setRefresh] = useState(0);
  const [source, setSource] = useState<PublicationSourceIdentity | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  useEffect(() => {
    if (!target) return;
    let active = true;
    void api
      .previewDraftSource(target)
      .then((identity) => {
        if (active) setSource(identity);
      })
      .catch((failure: unknown) => {
        if (active)
          setError(
            failure instanceof ClientApiError
              ? failure.message
              : 'Selected publication could not be confirmed. Retry or choose another source.',
          );
      })
      .finally(() => {
        if (active) setChecking(false);
      });
    return () => {
      active = false;
    };
  }, [target, refresh]);
  return (
    <dialog
      ref={dialog}
      className="confirmation-dialog source-dialog"
      aria-labelledby="create-source-title"
      aria-describedby="create-source-description"
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else onCancel();
      }}
    >
      <h2 id="create-source-title">Create {name}</h2>
      <p id="create-source-description">
        Choose current published source. Builder copies it into an independent draft. Later edits do
        not change the published site.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!target || !source || busy) return;
          setBusy(true);
          setError('');
          void onCreate(target, source).catch((failure: unknown) => {
            setError(
              failure instanceof ClientApiError
                ? failure.message
                : 'Creation could not be confirmed. Refresh source before retrying.',
            );
            setSource(null);
            setBusy(false);
          });
        }}
      >
        <label>
          Copy published site from
          <select
            autoFocus
            required
            value={target}
            disabled={busy}
            onChange={(event) => {
              const selected = event.target.value as typeof target;
              setTarget(selected);
              setSource(null);
              setError('');
              setChecking(Boolean(selected));
            }}
          >
            <option value="">Choose source</option>
            <option value="staging">Staging</option>
            <option value="production">Production</option>
          </select>
        </label>
        {checking ? <p role="status">Checking selected publication…</p> : null}
        {source ? (
          <p role="status">
            {source.fixture
              ? 'Local fixture ready'
              : `${target === 'staging' ? 'Staging' : 'Production'} publication verified`}
            . Source commit {source.sourceCommit.slice(0, 8)}. A new draft keeps its own history.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="dialog-error">
            {error}
          </p>
        ) : null}
        <div className="button-row confirmation-dialog__actions">
          <button className="button" type="button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          {error && target ? (
            <button
              className="button"
              type="button"
              disabled={busy || checking}
              onClick={() => {
                setSource(null);
                setError('');
                setChecking(true);
                setRefresh((value) => value + 1);
              }}
            >
              Refresh source
            </button>
          ) : null}
          <button
            className="button button--primary"
            type="submit"
            disabled={!source || !target || checking || busy}
          >
            {busy ? 'Creating…' : 'Create independent draft'}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function DeleteDraftDialog({
  draft,
  onCancel,
  onConfirm,
}: {
  draft: DraftSummary;
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
              setError(
                'Deletion could not be confirmed. Refresh the draft list before trying again.',
              );
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
  checkouts = [],
}: {
  drafts: DraftSummary[];
  role: Role;
  onOpen: (draft: DraftSummary, trigger?: HTMLButtonElement) => void | Promise<void>;
  onCreate: (
    name: string,
    target: 'staging' | 'production',
    source: PublicationSourceIdentity,
  ) => Promise<void>;
  onDuplicate: (draft: DraftSummary) => Promise<void>;
  onArchive: (draft: DraftSummary) => Promise<void>;
  onUnarchive: (draft: DraftSummary) => Promise<void>;
  onDelete: (draft: DraftSummary) => Promise<void>;
  checkouts?: DraftCheckoutAvailability[];
}) {
  const [name, setName] = useState('');
  const [createName, setCreateName] = useState<string | null>(null);
  const createTrigger = useRef<HTMLButtonElement>(null);
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const actionPending = useRef(false);
  const runAction = async (operation: () => void | Promise<void>) => {
    if (actionPending.current) return;
    actionPending.current = true;
    setBusy(true);
    setActionError('');
    try {
      await operation();
    } catch {
      setActionError(
        'The action could not be confirmed. Refresh the draft list before trying again.',
      );
    } finally {
      actionPending.current = false;
      setBusy(false);
    }
  };
  const [deleteTarget, setDeleteTarget] = useState<DraftSummary | null>(null);
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
          <p className="safety-note">
            Review and accept on public Staging. Production publishing requires an Administrator.
          </p>
        </div>
        {canEdit ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim()) setCreateName(name.trim());
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
            <button
              ref={createTrigger}
              className="button button--primary"
              type="submit"
              disabled={busy}
            >
              Create draft
            </button>
          </form>
        ) : null}
      </div>
      {createName ? (
        <CreateDraftDialog
          name={createName}
          onCancel={() => {
            setCreateName(null);
            window.requestAnimationFrame(() => createTrigger.current?.focus());
          }}
          onCreate={async (target, source) => {
            await onCreate(createName, target, source);
            setCreateName(null);
            setName('');
          }}
        />
      ) : null}
      {actionError ? <p role="alert">{actionError}</p> : null}
      {drafts.length === 0 ? (
        <div className="empty-state">
          <h2>No drafts yet</h2>
          <p>Create the first safe copy of PointSite to begin.</p>
        </div>
      ) : (
        <ul className="draft-grid">
          {drafts.map((draft) => {
            const checkout = checkouts.find((item) => item.draftId === draft.id);
            const mutationUnavailable = checkout?.state === 'unavailable';
            const unavailable =
              canEdit && draft.status === 'active' && checkout?.state === 'unavailable';
            const owned = canEdit && checkout?.state === 'owned';
            const descriptionId = `checkout-${draft.id}`;
            return (
              <li className="draft-card" key={draft.id}>
                <div className="draft-card__details">
                  <p className="status-badge">{draft.status}</p>
                  <h2>{draft.name}</h2>
                  <p title={publicationExplanation(draft.publication)}>
                    {publicationLabel(draft.publication, draft.revision.sequence)} ·{' '}
                    {new Date(draft.updatedAt).toLocaleString()}
                  </p>
                  {draft.publication?.sourceTarget === 'staging' ? (
                    <p>Copied from Staging; draft content is not necessarily live on Production.</p>
                  ) : null}
                  {unavailable ? (
                    <p id={descriptionId}>
                      {checkout.ownerLogin
                        ? `Currently being edited by ${checkout.ownerLogin}.`
                        : 'Currently being edited.'}
                      <br /> It becomes available automatically after inactivity.
                    </p>
                  ) : null}
                </div>
                <div className="draft-card__actions">
                  <button
                    className="button button--primary"
                    disabled={unavailable || busy}
                    aria-describedby={unavailable ? descriptionId : undefined}
                    onClick={(event) => {
                      const trigger = event.currentTarget;
                      void runAction(() => onOpen(draft, trigger));
                    }}
                  >
                    {owned ? 'Resume editing' : `Open ${canEdit ? 'editor' : 'preview'}`}
                  </button>
                  {canEdit ? (
                    <>
                      <div className="draft-card__secondary-actions">
                        <button
                          className="button"
                          disabled={busy}
                          onClick={() => void runAction(() => onDuplicate(draft))}
                        >
                          Duplicate
                        </button>
                        {draft.status === 'active' ? (
                          <button
                            className="button"
                            disabled={busy || mutationUnavailable}
                            onClick={() => void runAction(() => onArchive(draft))}
                          >
                            Archive
                          </button>
                        ) : draft.status === 'archived' ? (
                          <button
                            className="button"
                            disabled={busy || mutationUnavailable}
                            onClick={() => void runAction(() => onUnarchive(draft))}
                          >
                            Unarchive
                          </button>
                        ) : null}
                      </div>
                      {draft.status === 'archived' ? (
                        <button
                          ref={(element) => {
                            if (deleteTarget?.id === draft.id) deleteTrigger.current = element;
                          }}
                          disabled={busy || mutationUnavailable}
                          className="button button--danger"
                          onClick={(event) => {
                            deleteTrigger.current = event.currentTarget;
                            setDeleteTarget(draft);
                          }}
                        >
                          Delete
                        </button>
                      ) : null}
                    </>
                  ) : null}
                </div>
              </li>
            );
          })}
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
