import { useState } from 'react';
import { isSafeExternalHttpUrl, isSafeInternalPath } from '../../site-kit/url-policy';

type PageChoice = { title: string; route: string };
type LinkType = 'internal' | 'external';

function typeFor(value: string): LinkType {
  return isSafeInternalPath(value) ? 'internal' : 'external';
}

export function LinkDestinationField({
  label,
  value,
  pages,
  onChange,
}: {
  label: string;
  value: string;
  pages: PageChoice[];
  onChange: (value: string) => void;
}) {
  const persistedType = typeFor(value);
  const [modeOverride, setModeOverride] = useState<LinkType>();
  const [externalDraft, setExternalDraft] = useState(persistedType === 'external' ? value : '');
  const [externalTouched, setExternalTouched] = useState(false);
  const mode = modeOverride ?? persistedType;
  const currentInternal = isSafeInternalPath(value) ? value : (pages[0]?.route ?? '/');
  const knownInternal = pages.some((page) => page.route === currentInternal);
  const externalInvalid = externalTouched && !isSafeExternalHttpUrl(externalDraft);

  return (
    <fieldset className="link-destination-field">
      <legend>{label}</legend>
      <div className="link-destination-controls">
        <label>
          <span>Type</span>
          <select
            data-local-control
            value={mode}
            onChange={(event) => {
              const next = event.target.value as LinkType;
              setModeOverride(next);
              setExternalTouched(false);
              if (next === 'internal') onChange(currentInternal);
              else
                setExternalDraft(
                  (current) => current || (persistedType === 'external' ? value : ''),
                );
            }}
          >
            <option value="internal">Internal</option>
            <option value="external">External</option>
          </select>
        </label>
        {mode === 'internal' ? (
          <label className="link-destination-value">
            <span>Internal page</span>
            <select value={currentInternal} onChange={(event) => onChange(event.target.value)}>
              {!knownInternal ? (
                <option value={currentInternal}>Current path — {currentInternal}</option>
              ) : null}
              {pages.map((page) => (
                <option key={page.route} value={page.route}>
                  {page.title} — {page.route}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className="link-destination-value">
            <span>External URL</span>
            <input
              data-local-control
              required
              type="url"
              inputMode="url"
              spellCheck={false}
              placeholder="http://example.com"
              value={externalDraft}
              aria-invalid={externalInvalid ? 'true' : undefined}
              onBlur={() => setExternalTouched(true)}
              onChange={(event) => {
                const next = event.target.value;
                setExternalDraft(next);
                setExternalTouched(true);
                if (isSafeExternalHttpUrl(next)) onChange(next);
              }}
            />
          </label>
        )}
      </div>
      {externalInvalid ? (
        <p className="field-error">
          External URLs must begin with http:// or https:// and include a site address.
        </p>
      ) : null}
    </fieldset>
  );
}
