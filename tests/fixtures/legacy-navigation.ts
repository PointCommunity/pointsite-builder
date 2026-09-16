import type { SiteDocument } from '../../src/site-kit/types';
import { defaultSiteDocument } from '../../src/site-kit/default-site';

/** Schema-9 fixture only. Production code must never downgrade a saved design document. */
export function legacyNavigationDocument(): SiteDocument {
  const document = structuredClone(defaultSiteDocument);
  document.schemaVersion = 9;
  document.rendererVersion = '9.0.0';
  document.navigation = document.navigationDesigns![0].items;
  delete document.navigationDesigns;
  for (const page of document.pages)
    for (const section of page.blocks)
      for (const { element } of section.items)
        if (element.type === 'navigation') delete element.navigationDesignId;
  return document;
}
