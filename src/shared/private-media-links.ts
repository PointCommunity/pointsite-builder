import type { SiteDocument } from '../site-kit/types';

export function assertNoPrivateBuilderLinks(document: Pick<SiteDocument, 'linkedMedia'>): void {
  for (const item of document.linkedMedia) {
    const url = new URL(item.url);
    if (url.hostname !== 'builder.pointatx.org') continue;
    let path: string;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      throw new Error('PRIVATE_MEDIA_LINK');
    }
    if (path.startsWith('/api/') || path.startsWith('/assets/builder/'))
      throw new Error('PRIVATE_MEDIA_LINK');
  }
}
