import type { SectionBlock } from './types';

export function derivedUuid(id: string, mask: number): string {
  const [head = '00000000', ...rest] = id.split('-');
  const changed = (Number.parseInt(head, 16) ^ mask) >>> 0;
  return [changed.toString(16).padStart(8, '0'), ...rest].join('-');
}

export function createEditableHeaderSection(
  pageId: string,
  logoMediaId: string | undefined,
  position: SectionBlock['position'] = 'flow',
): SectionBlock {
  const items: SectionBlock['items'] = [];

  if (logoMediaId) {
    items.push({
      id: derivedUuid(pageId, 0x1a1a1a1a),
      span: 4,
      align: 'center',
      grid: {
        desktop: { column: 1, row: 1, columnSpan: 4, rowSpan: 2 },
        tablet: { column: 1, row: 1, columnSpan: 4, rowSpan: 2 },
        mobile: { column: 1, row: 1, columnSpan: 8, rowSpan: 2 },
      },
      element: {
        id: derivedUuid(pageId, 0x2b2b2b2b),
        type: 'image',
        mediaId: logoMediaId,
        alt: 'Point Community Church',
        aspect: 'natural',
        fit: 'contain',
      },
    });
  }

  items.push({
    id: derivedUuid(pageId, 0x3c3c3c3c),
    span: 8,
    align: 'center',
    grid: {
      desktop: { column: 5, row: 1, columnSpan: 8, rowSpan: 2 },
      tablet: { column: 5, row: 1, columnSpan: 8, rowSpan: 2 },
      mobile: { column: 1, row: 3, columnSpan: 12, rowSpan: 3 },
    },
    element: {
      id: derivedUuid(pageId, 0x4d4d4d4d),
      type: 'navigation',
      label: 'Church navigation',
      orientation: 'responsive',
      align: 'right',
      surface: 'transparent',
    },
  });

  return {
    id: derivedUuid(pageId, 0x5e5e5e5e),
    type: 'section',
    name: 'Site header',
    layout: 'grid',
    position,
    columns: 12,
    gap: 'small',
    width: 'shell',
    surface: 'transparent',
    padding: 'small',
    minRows: 2,
    backgroundPosition: 'center',
    overlay: 'none',
    items,
  };
}
