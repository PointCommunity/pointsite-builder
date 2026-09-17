import { renderToStaticMarkup } from 'react-dom/server';
import { SiteRenderer } from '../../src/site-kit/SiteRenderer';
import type { SiteDocument } from '../../src/site-kit/types';
import siteCss from '../../src/site-kit/site.css?inline';

export function publishedHtml(document: SiteDocument, route: string) {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${siteCss}</style></head><body>${renderToStaticMarkup(<SiteRenderer document={document} route={route} />)}</body></html>`;
}
