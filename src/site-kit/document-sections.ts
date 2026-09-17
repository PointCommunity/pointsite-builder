import type { SectionBlock, SiteDocument } from './types';

export const FOOTER_REGION = 'footer';

export function documentRegions(document: SiteDocument) {
  return [
    ...document.pages,
    ...(document.footer === undefined
      ? []
      : [{ id: FOOTER_REGION, title: 'Footer', blocks: document.footer }]),
  ];
}

export function layoutSections(document: SiteDocument, regionId: string) {
  return documentRegions(document).find((region) => region.id === regionId)?.blocks;
}

export function replaceLayoutSections(
  document: SiteDocument,
  regionId: string,
  blocks: SectionBlock[],
) {
  if (regionId === FOOTER_REGION) document.footer = blocks;
  else {
    const page = document.pages.find((item) => item.id === regionId);
    if (page) page.blocks = blocks;
  }
}
