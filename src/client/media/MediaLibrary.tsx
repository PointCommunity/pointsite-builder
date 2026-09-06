import { useEffect, useState, type FormEvent } from 'react';
import { isDirectVideoUrl, youtubeVideoId } from '../../site-kit/linked-media';
import type { SiteDocument } from '../../site-kit/types';
import { isSafeHttpsUrl } from '../../site-kit/url-policy';
import { api, type MediaItem } from '../api';

export interface MediaClient {
  list(): Promise<MediaItem[]>;
  upload(file: File, altText: string): Promise<MediaItem>;
  update(
    id: string,
    input: Pick<MediaItem, 'filename' | 'displayName' | 'altText' | 'tags'>,
  ): Promise<MediaItem>;
}

const defaultClient: MediaClient = {
  list: api.listMedia,
  upload: api.uploadMedia,
  update: api.updateMedia,
};
type LinkedMedia = SiteDocument['linkedMedia'][number];

function tagsFrom(value: string): string[] {
  return [
    ...new Set(
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ].slice(0, 20);
}

function MetadataEditor({
  item,
  client,
  onSaved,
}: {
  item: MediaItem;
  client: MediaClient;
  onSaved: (item: MediaItem) => void;
}) {
  const [filename, setFilename] = useState(item.filename);
  const [displayName, setDisplayName] = useState(item.displayName);
  const [altText, setAltText] = useState(item.altText);
  const [tags, setTags] = useState(item.tags.join(', '));
  const [status, setStatus] = useState('');
  return (
    <form
      className="media-metadata"
      onSubmit={(event) => {
        event.preventDefault();
        setStatus('Saving…');
        void client
          .update(item.id, {
            filename: filename.trim(),
            displayName: displayName.trim(),
            altText: altText.trim(),
            tags: tagsFrom(tags),
          })
          .then((saved) => {
            onSaved(saved);
            setStatus('Saved');
          })
          .catch(() => setStatus('Could not save these details.'));
      }}
    >
      <label>
        <span>File name</span>
        <input
          required
          maxLength={255}
          value={filename}
          onChange={(event) => setFilename(event.target.value)}
        />
      </label>
      <label>
        <span>Display name</span>
        <input
          required
          maxLength={120}
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
        />
      </label>
      <label>
        <span>Image description</span>
        <textarea
          required
          maxLength={300}
          value={altText}
          onChange={(event) => setAltText(event.target.value)}
        />
      </label>
      <label>
        <span>Tags (comma separated)</span>
        <input value={tags} onChange={(event) => setTags(event.target.value)} />
      </label>
      <div className="button-row">
        <button className="button" type="submit">
          Save details
        </button>
        <span role="status">{status}</span>
      </div>
    </form>
  );
}

export function MediaLibrary({
  client = defaultClient,
  document,
  onDocumentChange,
  onSelect,
}: {
  client?: MediaClient;
  document?: SiteDocument;
  onDocumentChange?: (document: SiteDocument) => void;
  onSelect?: (item: MediaItem) => void;
}) {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [altText, setAltText] = useState('');
  const [status, setStatus] = useState('Loading library…');
  const [busy, setBusy] = useState(false);
  const [linkType, setLinkType] = useState<LinkedMedia['type']>('image');
  const [linkName, setLinkName] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [linkAlt, setLinkAlt] = useState('');
  const [linkTags, setLinkTags] = useState('');
  useEffect(() => {
    let active = true;
    void client
      .list()
      .then((loaded) => {
        if (active) {
          setItems(loaded);
          setStatus('');
        }
      })
      .catch(() => {
        if (active) setStatus('Library could not be loaded.');
      });
    return () => {
      active = false;
    };
  }, [client]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!file || !altText.trim()) return;
    setBusy(true);
    setStatus('Uploading and checking image…');
    void client
      .upload(file, altText.trim())
      .then((item) => {
        setItems((current) => [item, ...current.filter((candidate) => candidate.id !== item.id)]);
        setFile(null);
        setAltText('');
        setStatus('Image uploaded privately.');
      })
      .catch((error: unknown) =>
        setStatus(error instanceof Error ? error.message : 'Image upload failed.'),
      )
      .finally(() => setBusy(false));
  };
  const updateLinked = (id: string, change: (item: LinkedMedia) => void) => {
    if (!document || !onDocumentChange) return;
    const next = structuredClone(document);
    const item = next.linkedMedia.find((candidate) => candidate.id === id);
    if (item) change(item);
    onDocumentChange(next);
  };
  const linkedUsage = (id: string) =>
    document?.pages.reduce(
      (count, page) =>
        count +
        page.blocks.reduce(
          (sectionCount, section) =>
            sectionCount +
            section.items.filter(
              (placement) =>
                placement.element.type === 'mediaEmbed' && placement.element.linkedMediaId === id,
            ).length,
          0,
        ),
      0,
    ) ?? 0;
  const addLinked = (event: FormEvent) => {
    event.preventDefault();
    if (!document || !onDocumentChange || !linkName.trim() || !isSafeHttpsUrl(linkUrl)) {
      setStatus('Enter a display name and a valid HTTPS link.');
      return;
    }
    if (linkType === 'youtube' && !youtubeVideoId(linkUrl)) {
      setStatus('Use a YouTube video, Shorts, or youtu.be link.');
      return;
    }
    if (linkType === 'video' && !isDirectVideoUrl(linkUrl)) {
      setStatus('Direct video links must end in .mp4, .webm, or .ogv.');
      return;
    }
    if (linkType === 'image' && !linkAlt.trim()) {
      setStatus('Describe linked images for visitors who cannot see them.');
      return;
    }
    const next = structuredClone(document);
    next.linkedMedia.push({
      id: crypto.randomUUID(),
      type: linkType,
      url: linkUrl,
      displayName: linkName.trim(),
      ...(linkAlt.trim() ? { alternativeText: linkAlt.trim() } : {}),
      tags: tagsFrom(linkTags),
    });
    onDocumentChange(next);
    setLinkName('');
    setLinkUrl('');
    setLinkAlt('');
    setLinkTags('');
    setStatus('Linked media added to this draft.');
  };
  return (
    <section className="media-panel" aria-labelledby="media-title">
      <header className="section-heading">
        <div>
          <p className="eyebrow">Organized assets</p>
          <h2 id="media-title">Library</h2>
        </div>
        <p>Upload private images or link approved external images and videos.</p>
      </header>
      <div className="library-columns">
        <section className="settings-section" aria-labelledby="uploads-title">
          <h3 id="uploads-title">Private image uploads</h3>
          <p>Private until included in a reviewed staging candidate.</p>
          <form className="media-upload" onSubmit={submit}>
            <label>
              <span>Image file</span>
              <input
                aria-label="Image file"
                type="file"
                accept=".jpg,.jpeg,.png,.webp,.avif,image/jpeg,image/png,image/webp,image/avif"
                required
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
            </label>
            <label>
              <span>Image description</span>
              <input
                aria-label="Alternative text"
                value={altText}
                maxLength={300}
                required
                onChange={(event) => setAltText(event.target.value)}
              />
            </label>
            <button
              className="button button--primary"
              type="submit"
              disabled={busy || !file || !altText.trim()}
            >
              Upload image
            </button>
          </form>
          {!status && items.length === 0 ? (
            <div className="empty-state">
              <strong>No uploaded images yet</strong>
              <p>Upload a JPG, PNG, WebP, or AVIF up to 5 MiB.</p>
            </div>
          ) : null}
          {items.length ? (
            <ul className="media-grid">
              {items.map((item) => (
                <li key={item.id}>
                  <img
                    src={`/api/media/${item.id}`}
                    alt={item.altText}
                    width={item.width}
                    height={item.height}
                    loading="lazy"
                  />
                  <div>
                    <strong>{item.displayName}</strong>
                    <span>
                      {item.filename} · {item.width} × {item.height} ·{' '}
                      {(item.byteSize / 1024).toFixed(1)} KiB
                    </span>
                    {item.tags.length ? <span>{item.tags.join(' · ')}</span> : null}
                    {onSelect ? (
                      <button className="button" type="button" onClick={() => onSelect(item)}>
                        Use in Layout
                      </button>
                    ) : null}
                    <details>
                      <summary>Edit details</summary>
                      <MetadataEditor
                        item={item}
                        client={client}
                        onSaved={(saved) =>
                          setItems((current) =>
                            current.map((candidate) =>
                              candidate.id === saved.id ? saved : candidate,
                            ),
                          )
                        }
                      />
                    </details>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
        {document && onDocumentChange ? (
          <section className="settings-section" aria-labelledby="links-title">
            <h3 id="links-title">Linked media</h3>
            <p>
              Display an HTTPS image, direct video file, or YouTube video without copying the file
              here.
            </p>
            <form className="linked-media-form" onSubmit={addLinked}>
              <label>
                <span>Media type</span>
                <select
                  value={linkType}
                  onChange={(event) => setLinkType(event.target.value as LinkedMedia['type'])}
                >
                  <option value="image">Image</option>
                  <option value="video">Direct video file</option>
                  <option value="youtube">YouTube video</option>
                </select>
              </label>
              <label>
                <span>Display name</span>
                <input
                  required
                  value={linkName}
                  onChange={(event) => setLinkName(event.target.value)}
                />
              </label>
              <label className="field-wide">
                <span>HTTPS link</span>
                <input
                  type="url"
                  required
                  placeholder={
                    linkType === 'youtube' ? 'https://www.youtube.com/watch?v=…' : 'https://…'
                  }
                  value={linkUrl}
                  onChange={(event) => setLinkUrl(event.target.value)}
                />
              </label>
              <label className="field-wide">
                <span>
                  {linkType === 'image'
                    ? 'Image description (required)'
                    : 'Accessible description (optional)'}
                </span>
                <input
                  required={linkType === 'image'}
                  value={linkAlt}
                  onChange={(event) => setLinkAlt(event.target.value)}
                />
              </label>
              <label className="field-wide">
                <span>Tags (comma separated)</span>
                <input value={linkTags} onChange={(event) => setLinkTags(event.target.value)} />
              </label>
              <button className="button button--primary" type="submit">
                Add linked media
              </button>
            </form>
            {document.linkedMedia.length === 0 ? (
              <div className="empty-state">
                <strong>No linked media yet</strong>
                <p>Add one here, then drag “Linked media” into a section in Layout.</p>
              </div>
            ) : null}
            <div className="linked-media-list">
              {document.linkedMedia.map((item) => (
                <article key={item.id}>
                  <div>
                    <span className="status-badge">
                      {item.type === 'youtube' ? 'YouTube' : item.type}
                    </span>
                    <strong>{item.displayName}</strong>
                    <a href={item.url} target="_blank" rel="noreferrer">
                      Open source
                    </a>
                  </div>
                  <div className="field-grid">
                    <label>
                      <span>Display name</span>
                      <input
                        value={item.displayName}
                        onChange={(event) =>
                          updateLinked(item.id, (target) => {
                            target.displayName = event.target.value;
                          })
                        }
                      />
                    </label>
                    <label>
                      <span>Tags</span>
                      <input
                        value={item.tags.join(', ')}
                        onChange={(event) =>
                          updateLinked(item.id, (target) => {
                            target.tags = tagsFrom(event.target.value);
                          })
                        }
                      />
                    </label>
                    <label className="field-wide">
                      <span>Description</span>
                      <input
                        required={item.type === 'image'}
                        value={item.alternativeText ?? ''}
                        onChange={(event) =>
                          updateLinked(item.id, (target) => {
                            target.alternativeText = event.target.value || undefined;
                          })
                        }
                      />
                    </label>
                  </div>
                  <button
                    className="button button--danger"
                    type="button"
                    disabled={linkedUsage(item.id) > 0}
                    onClick={() => {
                      const next = structuredClone(document);
                      next.linkedMedia = next.linkedMedia.filter(
                        (candidate) => candidate.id !== item.id,
                      );
                      onDocumentChange(next);
                    }}
                  >
                    {linkedUsage(item.id) > 0 ? 'Used in Layout' : 'Remove link'}
                  </button>
                </article>
              ))}
            </div>
          </section>
        ) : null}
      </div>
      <p role="status" aria-live="polite">
        {status}
      </p>
    </section>
  );
}
