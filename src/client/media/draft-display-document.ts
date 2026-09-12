import type { SiteDocument } from '../../site-kit/types';

/** Render-only URLs. Persist and validate the original document, never this display copy. */
export function draftDisplayDocument(document: SiteDocument, draftId: string): SiteDocument {
  return {
    ...document,
    media: document.media.map((item) => ({
      ...item,
      sourcePath: `/api/drafts/${encodeURIComponent(draftId)}/assets?path=${encodeURIComponent(item.sourcePath)}`,
    })),
  };
}
