'use client';

import { Fragment, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { renderSection } from './registry';
import { themeToTokens } from './tokens';
import type { PageDocument, SiteDocument } from './types';
import './site.css';

function mediaSource(document: SiteDocument, id?: string): string | undefined {
  if (!id) return undefined;
  return document.media.find((candidate) => candidate.id === id)?.sourcePath;
}

function SiteFooter({
  document,
  editing = false,
  onEdit,
}: {
  document: SiteDocument;
  editing?: boolean;
  onEdit?: () => void;
}) {
  const social = new Map(document.site.socialLinks.map((item) => [item.platform, item]));
  const facebook = social.get('facebook');
  const instagram = social.get('instagram');
  return (
    <footer className="site-footer">
      {editing && onEdit ? (
        <button className="point-footer-edit" type="button" onClick={onEdit}>
          Edit global footer
        </button>
      ) : null}
      <div className="footer-grid shell">
        <section>
          <h2>Service Times</h2>
          <p>{document.site.service.schedule}</p>
        </section>
        <section>
          <h2>Contact Info</h2>
          <address>
            <span>{document.site.address.street}</span>
            <span>
              {document.site.address.city}, {document.site.address.region}{' '}
              {document.site.address.postalCode}
            </span>
          </address>
        </section>
        <section>
          <h2>Follow Us</h2>
          <div className="social-links">
            {facebook ? (
              <a href={facebook.url} target="_blank" rel="noreferrer" aria-label={facebook.label}>
                f
              </a>
            ) : null}
            {instagram ? (
              <a href={instagram.url} target="_blank" rel="noreferrer" aria-label={instagram.label}>
                ◎
              </a>
            ) : null}
          </div>
        </section>
      </div>
    </footer>
  );
}

export function SiteFrame({
  document,
  page,
  children,
  editing = false,
  onEditFooter,
  onNavigate,
}: {
  document: SiteDocument;
  page: PageDocument;
  children: ReactNode;
  editing?: boolean;
  onEditFooter?: () => void;
  onNavigate?: (route: string) => void;
}) {
  const isHome = page.template === 'home' || page.route === '/';
  const hero = mediaSource(document, page.heroMediaId);
  const navigate = (event: ReactMouseEvent) => {
    if (!onNavigate) return;
    const anchor = (event.target as Element | null)?.closest<HTMLAnchorElement>('a[href]');
    const href = anchor?.getAttribute('href');
    if (!href) return;
    const isRootRelative = href.startsWith('/');
    const url = isRootRelative ? null : new URL(href, globalThis.location.origin);
    const pathname = isRootRelative ? href.split(/[?#]/, 1)[0] : url?.pathname;
    const target = document.pages.find((candidate) => candidate.route === pathname);
    if (!target || (!isRootRelative && url?.origin !== globalThis.location.origin)) return;
    event.preventDefault();
    onNavigate(target.route);
  };
  return (
    <div
      className={`point-site${editing ? ' point-site--editing' : ''}`}
      style={themeToTokens(document.theme)}
      onClickCapture={navigate}
    >
      <a className="skip-link point-skip-link" href="#point-main">
        Skip to main content
      </a>
      <main id="point-main">
        {!isHome ? (
          <header className={`page-hero ${hero ? 'page-hero--image' : ''}`}>
            {hero ? <img src={hero} alt="" /> : null}
            {hero ? <div className="hero-shade" /> : null}
            <div className="shell page-hero-copy">
              {page.eyebrow ? <p className="eyebrow">{page.eyebrow}</p> : null}
              <h1>{page.title}</h1>
              {page.intro ? <p>{page.intro}</p> : null}
            </div>
          </header>
        ) : null}
        {isHome ? children : <div className="page-body shell">{children}</div>}
      </main>
      <SiteFooter document={document} editing={editing} onEdit={onEditFooter} />
    </div>
  );
}

export function SiteRenderer({
  document,
  route,
  onNavigate,
}: {
  document: SiteDocument;
  route: string;
  onNavigate?: (route: string) => void;
}) {
  const page = document.pages.find((candidate) => candidate.route === route);
  if (!page) {
    return (
      <main className="point-site not-found">
        <h1>Page not found</h1>
        <a href="/">Return home</a>
      </main>
    );
  }
  return (
    <SiteFrame document={document} page={page} onNavigate={onNavigate}>
      {page.blocks.map((siteBlock) => (
        <Fragment key={siteBlock.id}>{renderSection(siteBlock, document, onNavigate)}</Fragment>
      ))}
    </SiteFrame>
  );
}
