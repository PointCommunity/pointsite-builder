'use client';

import { Fragment, useState, type ReactNode } from 'react';
import { renderSection } from './registry';
import { themeToTokens } from './tokens';
import type { PageDocument, SiteDocument } from './types';
import './site.css';

function mediaSource(document: SiteDocument, id?: string): string | undefined {
  if (!id) return undefined;
  return document.media.find((candidate) => candidate.id === id)?.sourcePath;
}

function SiteHeader({ document, overlay = false }: { document: SiteDocument; overlay?: boolean }) {
  const [open, setOpen] = useState(false);
  const logo = document.media.find((candidate) => candidate.sourcePath.endsWith('/point-logo.png'));
  return (
    <header className={`site-header ${overlay ? 'site-header--overlay' : ''}`}>
      <div className="header-inner">
        <a href="/" className="brand" aria-label={`${document.site.name} home`}>
          {logo ? (
            <img src={logo.sourcePath} alt="Point" width="498" height="188" />
          ) : (
            document.site.shortName
          )}
        </a>
        <button
          className="menu-toggle"
          type="button"
          aria-expanded={open}
          aria-controls="site-navigation"
          onClick={() => setOpen((value) => !value)}
        >
          <span />
          <span />
          <span />
          <span className="sr-only">Menu</span>
        </button>
        <nav
          id="site-navigation"
          className={open ? 'nav nav--open' : 'nav'}
          aria-label="Main navigation"
          onClick={() => setOpen(false)}
        >
          {document.navigation.map((item) => (
            <div className="nav-item" key={item.id}>
              <a href={item.href}>
                {item.label}
                {item.children.length ? <span aria-hidden="true">⌄</span> : null}
              </a>
              {item.children.length ? (
                <div className="nav-dropdown">
                  {item.children.map((child) => (
                    <a href={child.href} key={child.id}>
                      {child.label}
                    </a>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </nav>
      </div>
    </header>
  );
}

function SiteFooter({ document }: { document: SiteDocument }) {
  const social = new Map(document.site.socialLinks.map((item) => [item.platform, item]));
  const facebook = social.get('facebook');
  const instagram = social.get('instagram');
  return (
    <footer className="site-footer">
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
}: {
  document: SiteDocument;
  page: PageDocument;
  children: ReactNode;
  editing?: boolean;
}) {
  const isHome = page.template === 'home' || page.route === '/';
  const hero = mediaSource(document, page.heroMediaId);
  return (
    <div
      className={`point-site${editing ? ' point-site--editing' : ''}`}
      style={themeToTokens(document.theme)}
    >
      <a className="skip-link point-skip-link" href="#point-main">
        Skip to main content
      </a>
      {isHome ? <SiteHeader document={document} overlay /> : <SiteHeader document={document} />}
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
      <SiteFooter document={document} />
    </div>
  );
}

export function SiteRenderer({ document, route }: { document: SiteDocument; route: string }) {
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
    <SiteFrame document={document} page={page}>
      {page.blocks.map((siteBlock) => (
        <Fragment key={siteBlock.id}>{renderSection(siteBlock, document)}</Fragment>
      ))}
    </SiteFrame>
  );
}
