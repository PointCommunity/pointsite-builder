import type { NavigationEntry, SiteDocument } from '../../site-kit/types';

/** Used by the compatibility editor; never write a legacy shadow of a named design. */
export function replaceNavigationItems(
  document: SiteDocument,
  items: NavigationEntry[],
  designId?: string,
): SiteDocument {
  if (document.schemaVersion === 9) return { ...document, navigation: items };
  if (!document.navigationDesigns?.some((design) => design.id === designId)) return document;
  return {
    ...document,
    navigationDesigns: document.navigationDesigns.map((design) =>
      design.id === designId ? { ...design, items } : design,
    ),
  };
}
