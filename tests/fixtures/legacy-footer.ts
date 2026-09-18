import { defaultSiteDocument } from '../../src/site-kit/default-site';
import type { SiteDocument } from '../../src/site-kit/types';

/** Pre-activation fixture. Production code never downgrades a composed footer. */
export function legacyFooterDocument(): SiteDocument {
  const document = structuredClone(defaultSiteDocument);
  document.schemaVersion = 10;
  document.rendererVersion = '10.0.0';
  delete document.footer;
  return document;
}
