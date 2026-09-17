import { derivedUuid } from './editable-header';
import { independentGridArea, independentResponsiveValue } from './grid-layout';
import type { SectionBlock, SiteDocument, SiteElement } from './types';

/** Recreates the existing footer using the same controls available in Blocks. */
export function createEditableFooterSection(site: SiteDocument['site']): SectionBlock {
  const id = '00000000-0000-4000-8000-000000000078';
  const social = new Map(site.socialLinks.map((link) => [link.platform, link]));
  const elements: SiteElement[] = [
    {
      id: derivedUuid(id, 1),
      type: 'richText',
      variant: 'footer',
      heading: 'Service Times',
      content: [{ type: 'paragraph', children: [{ text: site.service.schedule }] }],
    },
    {
      id: derivedUuid(id, 2),
      type: 'richText',
      variant: 'footer',
      heading: 'Contact Info',
      content: [
        {
          type: 'address',
          text: `${site.address.street}\n${site.address.city}, ${site.address.region} ${site.address.postalCode}`,
        },
      ],
    },
    {
      id: derivedUuid(id, 3),
      type: 'socialLinks',
      variant: 'footer',
      heading: 'Follow Us',
      align: 'center',
      appearance: 'icons',
      links: (['facebook', 'instagram'] as const).flatMap((platform) => {
        const link = social.get(platform);
        return link ? [{ ...link }] : [];
      }),
    },
  ];
  return {
    id,
    type: 'section',
    name: 'Footer information',
    layout: 'flow',
    position: 'flow',
    columns: 3,
    gap: 'none',
    gapPixels: 50,
    width: 'site',
    surface: 'transparent',
    padding: 'none',
    paddingPixels: 65,
    border: 'top',
    stackAt: 'phone',
    minRows: 1,
    backgroundPosition: 'center',
    overlay: 'none',
    items: elements.map((element, index) => ({
      id: derivedUuid(id, 10 + index),
      span: 1,
      align: independentResponsiveValue('stretch'),
      grid: independentGridArea({ column: index * 4 + 1, row: 1, columnSpan: 4, rowSpan: 3 }),
      element,
    })),
  };
}
