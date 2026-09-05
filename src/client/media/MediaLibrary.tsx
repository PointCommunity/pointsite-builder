import { useEffect, useState, type FormEvent } from 'react';
import { api, type MediaItem } from '../api';

export interface MediaClient {
  list(): Promise<MediaItem[]>;
  upload(file: File, altText: string): Promise<MediaItem>;
}

const defaultClient: MediaClient = { list: api.listMedia, upload: api.uploadMedia };

export function MediaLibrary({
  client = defaultClient,
  onSelect,
}: {
  client?: MediaClient;
  onSelect?: (item: MediaItem) => void;
}) {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [altText, setAltText] = useState('');
  const [status, setStatus] = useState('Loading media…');
  const [busy, setBusy] = useState(false);
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
        if (active) setStatus('Media could not be loaded.');
      });
    return () => {
      active = false;
    };
  }, [client]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!file || !altText.trim()) return;
    setBusy(true);
    setStatus('Uploading and validating image…');
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
  return (
    <section className="media-panel" aria-labelledby="media-title">
      <div>
        <p className="eyebrow">Private library</p>
        <h2 id="media-title">Media</h2>
        <p>Images remain private until included in a reviewed staging candidate.</p>
      </div>
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
          <span>Alternative text</span>
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
      <p role="status" aria-live="polite">
        {status}
      </p>
      {!status && items.length === 0 ? (
        <div className="empty-state">
          <strong>No uploaded media yet</strong>
          <p>Upload a JPG, PNG, WebP, or AVIF up to 5 MiB.</p>
        </div>
      ) : null}
      {items.length ? (
        <ul className="media-grid">
          {items.map((item) => (
            <li key={item.id}>
              <img src={`/api/media/${item.id}`} alt={item.altText} loading="lazy" />
              <div>
                <strong>{item.filename}</strong>
                <span>
                  {item.width} × {item.height} · {(item.byteSize / 1024).toFixed(1)} KiB
                </span>
                {onSelect ? (
                  <button className="button" onClick={() => onSelect(item)}>
                    Use image
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
