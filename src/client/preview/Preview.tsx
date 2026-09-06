import { useState } from 'react';
import type { SiteDocument } from '../../site-kit/types';
import { SitePreviewFrame } from './SitePreviewFrame';

const widths = { mobile: 360, tablet: 768, desktop: 1280 } as const;

export function Preview({ document }: { document: SiteDocument }) {
  const [viewport, setViewport] = useState<keyof typeof widths>('desktop');
  const [pageId, setPageId] = useState(document.pages[0]?.id ?? '');
  const page = document.pages.find((candidate) => candidate.id === pageId) ?? document.pages[0];
  if (!page) return <p>No page selected.</p>;
  const navigate = (route: string) => {
    const target = document.pages.find((candidate) => candidate.route === route);
    if (target) setPageId(target.id);
  };
  return (
    <section className="preview-panel" aria-labelledby="preview-title">
      <div className="preview-toolbar">
        <h2 id="preview-title">Live preview</h2>
        <label>
          Page
          <select value={page.id} onChange={(event) => setPageId(event.target.value)}>
            {document.pages.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </label>
        <fieldset>
          <legend>Viewport</legend>
          {Object.entries(widths).map(([name]) => (
            <label key={name}>
              <input
                type="radio"
                name="viewport"
                checked={viewport === name}
                onChange={() => setViewport(name as keyof typeof widths)}
              />
              {name}
            </label>
          ))}
        </fieldset>
      </div>
      <div className="preview-stage" tabIndex={0} aria-label="Scrollable preview viewport">
        <SitePreviewFrame
          document={document}
          route={page.route}
          width={widths[viewport]}
          onNavigate={navigate}
        />
      </div>
    </section>
  );
}
