import { Fragment } from 'react';
import { renderBlock } from './registry';
import { themeToTokens } from './tokens';
import type { SiteDocument } from './types';
import './site.css';

export function SiteRenderer({ document, route }: { document: SiteDocument; route: string }) {
  const page = document.pages.find((candidate) => candidate.route === route);

  if (!page) {
    return (
      <main className="point-site point-not-found">
        <h1>Page not found</h1>
        <a href="/">Return home</a>
      </main>
    );
  }

  const hasHero = page.blocks[0]?.type === 'hero';
  return (
    <div className="point-site" style={themeToTokens(document.theme)}>
      <a className="point-skip-link" href="#point-main">
        Skip to main content
      </a>
      <header className="point-header point-shell">
        <a className="point-brand" href="/">
          {document.site.shortName}
        </a>
        <nav aria-label="Primary navigation">
          <ul>
            {document.navigation.map((item) => (
              <li key={item.id}>
                <a href={item.href}>{item.label}</a>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <main id="point-main">
        {!hasHero ? (
          <header className="point-shell point-page-title">
            <h1>{page.title}</h1>
            <p>{page.metadata.description}</p>
          </header>
        ) : null}
        {page.blocks.map((siteBlock) => (
          <Fragment key={siteBlock.id}>{renderBlock(siteBlock, document)}</Fragment>
        ))}
      </main>
      <footer className="point-footer">
        <div className="point-shell">
          <div>
            <strong>{document.site.name}</strong>
            <p>{document.site.service.schedule}</p>
          </div>
          <address>
            {document.site.address.street}
            <br />
            {document.site.address.city}, {document.site.address.region}{' '}
            {document.site.address.postalCode}
            <br />
            <a href={`mailto:${document.site.email}`}>{document.site.email}</a>
          </address>
        </div>
      </footer>
    </div>
  );
}
