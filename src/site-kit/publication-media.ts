import type { SiteDocument } from './types';

/** Match exported routes; Library inventory and unused people are not page placements. */
export function publicationMediaPaths(document: SiteDocument): string[] {
  const ids = new Set<string>();
  const paths = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === 'string') {
        if (key === 'navigationDesignId') {
          const design = document.navigationDesigns?.find((item) => item.id === child);
          if (!design) throw new Error('CANDIDATE_NAVIGATION_REFERENCE_INVALID');
          visit(design);
        }
        if (['mediaId', 'backgroundMediaId', 'ogImageMediaId'].includes(key)) ids.add(child);
        if (['href', 'linkHref'].includes(key) && child.startsWith('/assets/')) {
          paths.add(decodeURI(child.split(/[?#]/, 1)[0]));
        }
      }
      if (key === 'personIds' && Array.isArray(child)) {
        for (const id of child) {
          const person = document.collections.people.find((item) => item.id === id);
          if (!person) throw new Error('CANDIDATE_PERSON_REFERENCE_INVALID');
          visit(person);
        }
      } else visit(child);
    }
  };
  // The static route generator currently exports every page, including hidden routes.
  visit(document.pages);
  visit(document.footer);
  visit(document.navigation);
  for (const id of ids) {
    const media = document.media.find((item) => item.id === id);
    if (!media) throw new Error('CANDIDATE_MEDIA_REFERENCE_INVALID');
    paths.add(media.sourcePath);
  }
  return [...paths].sort();
}
