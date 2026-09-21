import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { supportJson } from '../../shared/publication-support';
import { ClientApiError } from '../api';
import { PublicationDiagnostics, type ProgressProps } from './PublicationProgress';

const SupportContext = createContext<{
  records: Record<string, string>;
  record: (name: string, value: string) => void;
}>({ records: {}, record: () => {} });

export function PublishingSupport({ children }: { children: ReactNode }) {
  const [records, setRecords] = useState<Record<string, string>>({});
  const record = useCallback((name: string, value: string) => {
    setRecords((current) => {
      if (current[name] === value) return current;
      const next = { ...current, [name]: value };
      const detail = JSON.parse(value) as { error?: unknown } | null;
      if (detail?.error) {
        const errors = JSON.parse(current['Recent errors'] ?? '[]') as {
          section: string;
          capturedAt: string;
          error: unknown;
        }[];
        if (
          !errors.some(
            (item) =>
              item.section === name && JSON.stringify(item.error) === JSON.stringify(detail.error),
          )
        )
          next['Recent errors'] = JSON.stringify(
            [
              ...errors,
              { section: name, capturedAt: new Date().toISOString(), error: detail.error },
            ].slice(-20),
            null,
            2,
          );
      }
      return next;
    });
  }, []);
  return <SupportContext.Provider value={{ records, record }}>{children}</SupportContext.Provider>;
}

// The collector hook shares this provider's context.
// eslint-disable-next-line react-refresh/only-export-components
export function usePublishingSupport(name: string, details: unknown) {
  const { record } = useContext(SupportContext);
  const value = supportJson(details);
  // Updated action buttons must never copy the previous status snapshot.
  useLayoutEffect(() => record(name, value), [record, name, value]);
}

// eslint-disable-next-line react-refresh/only-export-components
export function supportError(error: unknown) {
  return error instanceof ClientApiError
    ? { code: error.code, status: error.status, requestId: error.requestId }
    : { code: 'REQUEST_FAILED' };
}

export function CopyPublishingDetails() {
  const { records } = useContext(SupportContext);
  const [status, setStatus] = useState('');
  const [fallback, setFallback] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (fallback) {
      field.current?.focus();
      field.current?.select();
    }
  }, [fallback]);
  const copy = async () => {
    const text = `PointSite Builder publishing support\nCaptured: ${new Date().toISOString()}\nBuilder: ${location.origin}\n\n${Object.entries(
      records,
    )
      .map(([name, value]) => `${name}\n${value}`)
      .join('\n\n')}`;
    try {
      await navigator.clipboard.writeText(text);
      setFallback('');
      setStatus('Copied. Paste these details into your message to support.');
    } catch {
      setFallback(text);
      setStatus('Clipboard access is unavailable. Copy the selected details below.');
    }
  };
  return (
    <div className="publish-copy">
      <button className="button" type="button" onClick={() => void copy()}>
        Copy support details
      </button>
      {status ? <p role="status">{status}</p> : null}
      {fallback ? (
        <textarea
          ref={field}
          aria-label="Support details to copy"
          readOnly
          value={fallback}
          rows={8}
        />
      ) : null}
    </div>
  );
}

export function PublishingDetails() {
  const { records } = useContext(SupportContext);
  return (
    <details className="technical-details">
      <summary>Technical details</summary>
      <CopyPublishingDetails />
      {Object.entries(records).map(([name, value]) => (
        <section key={name}>
          <h4>{name}</h4>
          {(JSON.parse(value) as { kind?: string })?.kind === 'progress' ? (
            <PublicationDiagnostics {...(JSON.parse(value) as ProgressProps)} />
          ) : null}
          <pre tabIndex={0} aria-label={`${name} technical details`}>
            {value}
          </pre>
        </section>
      ))}
    </details>
  );
}
