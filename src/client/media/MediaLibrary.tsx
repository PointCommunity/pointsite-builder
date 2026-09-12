import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { validateImageUpload } from '../../server/media/policy';
import { isDirectVideoUrl, youtubeVideoId } from '../../site-kit/linked-media';
import { isSafeHttpsUrl } from '../../site-kit/url-policy';
import type {
  LibraryItem,
  LibraryLinkInput,
  LibraryMetadata,
  LibraryMutationContext,
  LibraryMutationResult,
  LibrarySnapshot,
} from '../../shared/library';
import { api } from '../api';
import { libraryResults, librarySorts, libraryTags, type LibrarySort } from './library-query';

export interface MediaClient {
  list(this: void, draftId: string): Promise<LibrarySnapshot>;
  upload(
    this: void,
    context: LibraryMutationContext,
    file: File,
    altText: string,
  ): Promise<LibraryMutationResult>;
  addLink(
    this: void,
    context: LibraryMutationContext,
    input: LibraryLinkInput,
  ): Promise<LibraryMutationResult>;
  update(
    this: void,
    context: LibraryMutationContext,
    id: string,
    action: 'archive' | 'unarchive' | 'update',
    metadata?: LibraryMetadata,
  ): Promise<LibraryMutationResult>;
  delete(this: void, context: LibraryMutationContext, id: string): Promise<LibraryMutationResult>;
  replace(
    this: void,
    context: LibraryMutationContext,
    id: string,
    file: File,
    metadata: LibraryMetadata,
  ): Promise<LibraryMutationResult>;
}
const defaultClient: MediaClient = {
  list: api.listLibrary,
  upload: api.uploadLibraryImage,
  addLink: api.addLibraryLink,
  update: api.updateLibraryItem,
  delete: api.deleteLibraryItem,
  replace: api.replaceLibraryImage,
};
type Operation = (context: LibraryMutationContext) => Promise<LibraryMutationResult>;
type Selection =
  { action: 'delete' | 'replace' | 'edit'; item: LibraryItem } | { action: 'upload' | 'link' };

function LibraryDialog({
  title,
  busy,
  onClose,
  children,
  focusKey,
}: {
  title: string;
  busy: boolean;
  onClose: () => void;
  children: ReactNode;
  focusKey?: string;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    return () => {
      (trigger?.isConnected
        ? trigger
        : document.querySelector<HTMLElement>('[aria-label="Search Library"]')
      )?.focus();
    };
  }, []);
  useEffect(() => {
    dialog.current?.querySelector<HTMLElement>('[data-initial-focus]')?.focus();
  }, [focusKey]);
  return (
    <div className="dialog-backdrop">
      <div
        ref={dialog}
        className="confirmation-dialog library-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={busy}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            if (!busy) onClose();
          }
          if (event.key !== 'Tab') return;
          const elements = Array.from(
            dialog.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href]',
            ) ?? [],
          );
          const first = elements[0];
          const last = elements.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <h2 id={titleId}>{title}</h2>
        {children}
      </div>
    </div>
  );
}

function MetadataFields({
  metadata,
  onChange,
}: {
  metadata: LibraryMetadata;
  onChange: (next: LibraryMetadata) => void;
}) {
  const [tags, setTags] = useState(metadata.tags.join(', '));
  return (
    <>
      <label>
        <span>Display name</span>
        <input
          required
          maxLength={120}
          value={metadata.displayName}
          onChange={(event) => onChange({ ...metadata, displayName: event.target.value })}
        />
      </label>
      <label>
        <span>Alternative text or accessible description</span>
        <textarea
          required
          maxLength={300}
          value={metadata.altText}
          onChange={(event) => onChange({ ...metadata, altText: event.target.value })}
        />
      </label>
      <label>
        <span>Tags (comma separated)</span>
        <input
          value={tags}
          onChange={(event) => {
            setTags(event.target.value);
            onChange({ ...metadata, tags: libraryTags(event.target.value) });
          }}
        />
      </label>
    </>
  );
}

function ImageForm({
  item,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  item?: LibraryItem;
  busy: boolean;
  error: string;
  onClose: () => void;
  onSubmit: (file: File, metadata: LibraryMetadata) => Promise<boolean>;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState('');
  const [validation, setValidation] = useState('');
  const [validating, setValidating] = useState(false);
  const [decoded, setDecoded] = useState(false);
  const [metadata, setMetadata] = useState<LibraryMetadata>({
    displayName: item?.displayName ?? '',
    altText: '',
    tags: item?.tags ?? [],
  });
  const [confirming, setConfirming] = useState(false);
  const selection = useRef(0);
  useEffect(
    () => () => {
      selection.current += 1;
    },
    [],
  );
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );
  const chooseFile = async (next: File | undefined) => {
    const current = ++selection.current;
    setFile(null);
    setPreview('');
    setValidation('');
    setConfirming(false);
    setDecoded(false);
    if (!next) {
      setValidating(false);
      return;
    }
    setValidating(true);
    try {
      if (next.size > 5 * 1024 * 1024) throw new Error('Image must be at most 5 MiB');
      const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(new Error('Image could not be read. Choose it again.'));
        reader.readAsArrayBuffer(next);
      });
      validateImageUpload({
        filename: next.name,
        contentType: next.type,
        bytes: new Uint8Array(bytes),
        altText: 'Proposed image',
      });
      if (current !== selection.current) return;
      setFile(next);
      setPreview(URL.createObjectURL(next));
      if (!item) setMetadata((value) => ({ ...value, displayName: next.name }));
    } catch (cause) {
      if (current === selection.current)
        setValidation(cause instanceof Error ? cause.message : 'Image is invalid');
    } finally {
      if (current === selection.current) setValidating(false);
    }
  };
  const valid = Boolean(file && decoded && metadata.altText.trim() && metadata.displayName.trim());
  return (
    <LibraryDialog
      title={
        confirming
          ? `Replace ${item?.displayName}?`
          : item
            ? `Replace image: ${item.displayName}`
            : 'Upload image'
      }
      busy={busy}
      onClose={onClose}
      focusKey={confirming ? 'confirm' : 'details'}
    >
      {confirming ? (
        <>
          <p>
            This replaces the image in every current placement in this draft. This cannot be undone.
            Other drafts and published copies stay independent.
          </p>
          <img className="library-image-preview" src={preview} alt={metadata.altText} />
          <p>{metadata.displayName}</p>
          {error ? <p role="alert">{error}</p> : null}
          <div className="button-row">
            <button className="button" data-initial-focus disabled={busy} onClick={onClose}>
              Cancel
            </button>
            <button
              className="button button--danger"
              disabled={busy || !valid}
              onClick={() => {
                if (file) void onSubmit(file, metadata);
              }}
            >
              Yes, replace image
            </button>
          </div>
        </>
      ) : (
        <form
          className="media-metadata"
          onSubmit={(event) => {
            event.preventDefault();
            if (!valid || busy || !file) return;
            if (item) setConfirming(true);
            else void onSubmit(file, metadata);
          }}
        >
          <p>JPEG, PNG, WebP or AVIF. Up to 5 MiB and 8,000 pixels per side.</p>
          {item ? (
            <p>Choose a replacement, then write fresh alternative text describing the new image.</p>
          ) : null}
          <fieldset disabled={busy}>
            <label>
              <span>Image file</span>
              <input
                data-initial-focus
                type="file"
                accept=".jpg,.jpeg,.png,.webp,.avif,image/jpeg,image/png,image/webp,image/avif"
                required
                onChange={(event) => {
                  void chooseFile(event.target.files?.[0]);
                }}
              />
            </label>
            {validating ? <p role="status">Validating image…</p> : null}
            {preview ? (
              <img
                className="library-image-preview"
                src={preview}
                alt={metadata.altText || 'Proposed image preview'}
                onLoad={() => setDecoded(true)}
                onError={() => {
                  setDecoded(false);
                  setValidation('The selected image could not be decoded. Choose a valid image.');
                }}
              />
            ) : null}
            {item ? (
              <MetadataFields metadata={metadata} onChange={setMetadata} />
            ) : (
              <label>
                <span>Alternative text</span>
                <textarea
                  required
                  maxLength={300}
                  value={metadata.altText}
                  onChange={(event) => setMetadata({ ...metadata, altText: event.target.value })}
                />
              </label>
            )}
          </fieldset>
          {validation || error ? <p role="alert">{validation || error}</p> : null}
          <div className="button-row">
            <button className="button" type="button" disabled={busy} onClick={onClose}>
              Cancel
            </button>
            <button
              className="button button--primary"
              type="submit"
              disabled={busy || validating || !valid}
            >
              {item ? 'Review replacement' : 'Upload image'}
            </button>
          </div>
        </form>
      )}
    </LibraryDialog>
  );
}

function DetailsForm({
  item,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  item?: LibraryItem;
  busy: boolean;
  error: string;
  onClose: () => void;
  onSubmit: (metadata: LibraryMetadata, link?: LibraryLinkInput) => Promise<boolean>;
}) {
  const [metadata, setMetadata] = useState<LibraryMetadata>({
    displayName: item?.displayName ?? '',
    altText: item?.altText ?? '',
    tags: item?.tags ?? [],
  });
  const [mediaType, setMediaType] = useState<LibraryLinkInput['mediaType']>('image');
  const [url, setUrl] = useState('');
  const [validation, setValidation] = useState('');
  return (
    <LibraryDialog
      title={item ? `Edit details: ${item.displayName}` : 'Add linked media'}
      busy={busy}
      onClose={onClose}
    >
      <form
        className="media-metadata"
        onSubmit={(event) => {
          event.preventDefault();
          setValidation('');
          if (busy || !metadata.displayName.trim() || !metadata.altText.trim()) return;
          const cleanUrl = url.trim();
          if (
            !item &&
            (!isSafeHttpsUrl(cleanUrl) ||
              (mediaType === 'video' && !isDirectVideoUrl(cleanUrl)) ||
              (mediaType === 'youtube' && !youtubeVideoId(cleanUrl)))
          ) {
            setValidation(
              'Enter a valid HTTPS image, direct video URL, or YouTube URL matching the selected type.',
            );
            return;
          }
          const clean = {
            ...metadata,
            displayName: metadata.displayName.trim(),
            altText: metadata.altText.trim(),
          };
          void onSubmit(clean, item ? undefined : { ...clean, mediaType, url: cleanUrl });
        }}
      >
        <fieldset disabled={busy}>
          {!item ? (
            <>
              <label>
                <span>Media type</span>
                <select
                  data-initial-focus
                  value={mediaType}
                  onChange={(event) =>
                    setMediaType(event.target.value as LibraryLinkInput['mediaType'])
                  }
                >
                  <option value="image">Image</option>
                  <option value="video">Video</option>
                  <option value="youtube">YouTube</option>
                </select>
              </label>
              <label>
                <span>HTTPS URL</span>
                <input
                  type="url"
                  required
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                />
              </label>
            </>
          ) : null}
          <MetadataFields metadata={metadata} onChange={setMetadata} />
        </fieldset>
        {validation || error ? <p role="alert">{validation || error}</p> : null}
        <div className="button-row">
          <button
            data-initial-focus={item ? true : undefined}
            className="button"
            type="button"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="button button--primary"
            type="submit"
            disabled={busy || !metadata.displayName.trim() || !metadata.altText.trim()}
          >
            {item ? 'Save details' : 'Add linked media'}
          </button>
        </div>
      </form>
    </LibraryDialog>
  );
}

export function MediaLibrary(props: Parameters<typeof LibraryWorkspace>[0]) {
  return <LibraryWorkspace key={props.draftId} {...props} />;
}

function LibraryWorkspace({
  draftId,
  revisionChecksum,
  revisionId,
  editable = false,
  disabledReason = 'Viewer access is read only.',
  runMutation,
  client = defaultClient,
}: {
  draftId: string;
  revisionChecksum: string;
  revisionId: string;
  editable?: boolean;
  disabledReason?: string;
  runMutation: (operation: Operation) => Promise<LibrarySnapshot>;
  client?: MediaClient;
}) {
  const [library, setLibrary] = useState<LibrarySnapshot | null>(null);
  const [archived, setArchived] = useState(false);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<LibrarySort>('added-desc');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [reload, setReload] = useState(0);
  const busyRef = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const loadGeneration = useRef(0);
  useEffect(() => {
    const generation = ++loadGeneration.current;
    void client
      .list(draftId)
      .then((next) => {
        if (next.draftId !== draftId)
          throw new Error('The Library response could not be verified. Reload this draft.');
        if (loadGeneration.current === generation) {
          setLibrary(next);
          setError('');
        }
      })
      .catch((cause: unknown) => {
        if (loadGeneration.current === generation)
          setError(cause instanceof Error ? cause.message : 'Library could not be loaded.');
      });
    return () => {
      loadGeneration.current += 1;
    };
  }, [client, draftId, revisionChecksum, revisionId, reload]);
  const mutate = async (operation: Operation, message: string): Promise<boolean> => {
    if (!editable) {
      setError(disabledReason);
      return false;
    }
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setError('');
    setStatus('');
    loadGeneration.current += 1;
    try {
      const next = await runMutation(operation);
      if (next.draftId !== draftId)
        throw new Error('The Library response could not be verified. Reload this draft.');
      loadGeneration.current += 1;
      setLibrary(next);
      setStatus(message);
      setSelection(null);
      return true;
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'The change could not be saved. Try again.',
      );
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const open = (next: Selection, trigger: HTMLElement) => {
    trigger.focus();
    setError('');
    setSelection(next);
  };
  const close = () => {
    if (!busyRef.current) {
      setSelection(null);
      setError('');
    }
  };
  const navigate = (next: boolean) => {
    setArchived(next);
    setQuery('');
    setStatus('');
    setError('');
    searchRef.current?.focus();
  };
  const visible = libraryResults(library?.items ?? [], archived, query, sort);
  const total = archived ? (library?.archivedCount ?? 0) : (library?.activeCount ?? 0);
  const formatDate = (value: string) =>
    Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : 'Date unavailable';
  return (
    <section
      className="media-panel library-workspace"
      aria-labelledby="media-title"
      aria-busy={busy}
    >
      <header className="section-heading">
        <div>
          <p className="eyebrow">Draft Library</p>
          <h2 id="media-title">{archived ? 'Archived items' : 'Library'}</h2>
        </div>
        <p>
          Images and linked media belong to this draft. Archive keeps each item available for
          recovery.
        </p>
      </header>
      <div className="button-row library-actions">
        {archived ? (
          <button className="button" onClick={() => navigate(false)}>
            Back to Library
          </button>
        ) : (
          <button className="button" onClick={() => navigate(true)}>
            Archived items ({library?.archivedCount ?? 0})
          </button>
        )}
        {editable && !archived ? (
          <>
            <button
              className="button button--primary"
              disabled={busy || !library}
              onClick={(event) => open({ action: 'upload' }, event.currentTarget)}
            >
              Upload image
            </button>
            <button
              className="button"
              disabled={busy || !library}
              onClick={(event) => open({ action: 'link' }, event.currentTarget)}
            >
              Add linked media
            </button>
          </>
        ) : null}
      </div>
      {!editable ? <p className="library-readonly">{disabledReason}</p> : null}
      <div className="library-toolbar">
        <label>
          <span>Search Library</span>
          <input
            ref={searchRef}
            type="search"
            aria-label="Search Library"
            placeholder="Name, description, tags, file or type"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label>
          <span>Sort Library</span>
          <select
            aria-label="Sort Library"
            value={sort}
            onChange={(event) => setSort(event.target.value as LibrarySort)}
          >
            {Object.entries(librarySorts).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button
          className="button"
          onClick={() => {
            setQuery('');
            setSort('added-desc');
            searchRef.current?.focus();
          }}
        >
          Reset
        </button>
      </div>
      <p role="status" aria-live="polite">
        {library
          ? `${visible.length} of ${total} items`
          : error
            ? 'Library unavailable.'
            : 'Loading Library…'}
        {status ? ` · ${status}` : ''}
      </p>
      {error && !selection ? (
        <div role="alert">
          <p>{error}</p>
          <button
            className="button"
            disabled={busy}
            onClick={() => {
              setError('');
              setReload((value) => value + 1);
            }}
          >
            Reload Library
          </button>
        </div>
      ) : null}
      {library && visible.length === 0 ? (
        <div className="library-empty">
          <h3>
            {total === 0
              ? archived
                ? 'No archived items'
                : 'Your Library is empty'
              : 'No matching items'}
          </h3>
          <p>
            {total === 0
              ? archived
                ? 'Archived items will appear here. Return to Library to manage active items.'
                : 'Upload an image or add linked media to get started.'
              : 'Try another keyword or Reset to show all items.'}
          </p>
        </div>
      ) : null}
      <div className="library-inventory">
        {visible.map((item) => (
          <article className="library-item" key={item.id} aria-labelledby={`library-${item.id}`}>
            {item.mediaType === 'image' ? (
              <img className="library-thumbnail" loading="lazy" src={item.url} alt={item.altText} />
            ) : (
              <div className="library-thumbnail library-type-preview" aria-hidden="true">
                {item.mediaType === 'youtube' ? 'YouTube' : 'Video'}
              </div>
            )}
            <div className="library-item-body">
              <p className="eyebrow">
                {item.mediaType} · {item.sourceType}
              </p>
              <h3 id={`library-${item.id}`}>{item.displayName}</h3>
              <p>{item.altText}</p>
              <p className="library-source">{item.filename || item.url || item.sourcePath}</p>
              {item.tags.length ? <p className="library-tags">{item.tags.join(' · ')}</p> : null}
              <dl className="library-facts">
                <div>
                  <dt>Added</dt>
                  <dd>{formatDate(item.createdAt)}</dd>
                </div>
                <div>
                  <dt>Updated</dt>
                  <dd>{formatDate(item.updatedAt)}</dd>
                </div>
                <div>
                  <dt>Used in this draft</dt>
                  <dd>
                    {item.usageCount} {item.usageCount === 1 ? 'placement' : 'placements'}
                  </dd>
                </div>
              </dl>
              {archived && item.deleteBlockers.length ? (
                <div id={`blockers-${item.id}`} className="library-blockers">
                  <p>Permanent deletion is blocked. Unarchive to use this item again.</p>
                  <ul>
                    {item.deleteBlockers.map((blocker) => (
                      <li key={blocker}>{blocker}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {editable ? (
                <div className="button-row library-item-actions">
                  {archived ? (
                    <>
                      <button
                        className="button"
                        disabled={busy}
                        onClick={() => {
                          void mutate(
                            (context) => client.update(context, item.id, 'unarchive'),
                            'Item unarchived.',
                          );
                          searchRef.current?.focus();
                        }}
                      >
                        Unarchive
                      </button>
                      <button
                        className="button button--danger"
                        disabled={busy || item.deleteBlockers.length > 0}
                        aria-describedby={
                          item.deleteBlockers.length ? `blockers-${item.id}` : undefined
                        }
                        onClick={(event) => open({ action: 'delete', item }, event.currentTarget)}
                      >
                        Delete permanently
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        className="button"
                        disabled={busy}
                        onClick={(event) => open({ action: 'edit', item }, event.currentTarget)}
                      >
                        Edit details
                      </button>
                      {item.mediaType === 'image' ? (
                        <button
                          className="button"
                          disabled={busy}
                          onClick={(event) =>
                            open({ action: 'replace', item }, event.currentTarget)
                          }
                        >
                          Replace image
                        </button>
                      ) : null}
                      <button
                        className="button"
                        disabled={busy}
                        onClick={() => {
                          void mutate(
                            (context) => client.update(context, item.id, 'archive'),
                            'Item archived.',
                          );
                          searchRef.current?.focus();
                        }}
                      >
                        Archive
                      </button>
                    </>
                  )}
                </div>
              ) : null}
            </div>
          </article>
        ))}
      </div>
      {selection?.action === 'upload' || selection?.action === 'replace' ? (
        <ImageForm
          item={selection.action === 'replace' ? selection.item : undefined}
          busy={busy}
          error={error}
          onClose={close}
          onSubmit={(file, metadata) =>
            mutate(
              (context) =>
                selection.action === 'replace'
                  ? client.replace(context, selection.item.id, file, metadata)
                  : client.upload(context, file, metadata.altText.trim()),
              selection.action === 'replace' ? 'Image replaced.' : 'Image uploaded.',
            )
          }
        />
      ) : null}
      {selection?.action === 'edit' || selection?.action === 'link' ? (
        <DetailsForm
          item={selection.action === 'edit' ? selection.item : undefined}
          busy={busy}
          error={error}
          onClose={close}
          onSubmit={(metadata, link) =>
            mutate(
              (context) =>
                selection.action === 'edit'
                  ? client.update(context, selection.item.id, 'update', metadata)
                  : client.addLink(context, link!),
              selection.action === 'edit' ? 'Details saved.' : 'Linked media added.',
            )
          }
        />
      ) : null}
      {selection?.action === 'delete' ? (
        <LibraryDialog title={`Delete ${selection.item.displayName}?`} busy={busy} onClose={close}>
          <p>
            This permanently deletes this archived item. This cannot be undone. Other drafts and
            published copies stay independent.
          </p>
          {error ? <p role="alert">{error}</p> : null}
          <div className="button-row">
            <button data-initial-focus className="button" disabled={busy} onClick={close}>
              Cancel
            </button>
            <button
              className="button button--danger"
              disabled={busy || !editable}
              onClick={() => {
                void mutate(
                  (context) => client.delete(context, selection.item.id),
                  'Item permanently deleted.',
                );
              }}
            >
              Yes, delete permanently
            </button>
          </div>
        </LibraryDialog>
      ) : null}
    </section>
  );
}
