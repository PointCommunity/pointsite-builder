import type { SectionBlock } from './types';
import { derivedUuid } from './editable-header';

export interface LegacyPageHero {
  id: string;
  title: string;
  eyebrow?: string;
  intro?: string;
  heroMediaId?: string;
}

export function createEditablePageHeroSection(page: LegacyPageHero): SectionBlock {
  return {
    id: derivedUuid(page.id, 0x6f1e2d3c),
    type: 'section',
    name: 'Page hero',
    layout: 'compatibility',
    position: 'flow',
    columns: 1,
    gap: 'none',
    width: 'full',
    surface: 'transparent',
    padding: 'none',
    minRows: 1,
    backgroundPosition: 'center',
    overlay: 'none',
    items: [
      {
        id: derivedUuid(page.id, 0x7a2b3c4d),
        span: 12,
        align: 'stretch',
        grid: { desktop: { column: 1, row: 1, columnSpan: 12, rowSpan: 1 } },
        element: {
          id: derivedUuid(page.id, 0x8b3c4d5e),
          type: 'hero',
          variant: 'pageHero',
          ...(page.eyebrow ? { eyebrow: page.eyebrow } : {}),
          heading: page.title,
          ...(page.intro ? { body: page.intro } : {}),
          ...(page.heroMediaId ? { mediaId: page.heroMediaId } : {}),
          align: 'left',
          surface: page.heroMediaId ? 'image' : 'primary',
          actions: [],
        },
      },
    ],
  };
}
