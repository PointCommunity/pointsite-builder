import {
  compositionPreset,
  compositionPresetNames,
} from '../../src/client/editor/composition-presets';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import { independentResponsiveValue, requiredSectionRows } from '../../src/site-kit/grid-layout';
import { createCompatibilitySection, upgradeComposition } from '../../src/site-kit/migrations';
import { SiteDocumentSchema } from '../../src/site-kit/schema';
import type { SiteDocument } from '../../src/site-kit/types';

export function compositionCatalogDocument(): SiteDocument {
  const document = upgradeComposition(structuredClone(defaultSiteDocument));
  const original = document.pages[0];
  document.pages = [
    {
      ...original,
      blocks: compositionPresetNames.map((name) => {
        const group = compositionPreset(name, document);
        const section = createCompatibilitySection(group);
        section.layout = 'grid';
        section.columns = 12;
        section.items[0].align = independentResponsiveValue('stretch');
        for (const breakpoint of ['desktop', 'tablet', 'mobile'] as const)
          section.items[0].grid[breakpoint] = {
            column: 1,
            row: 1,
            columnSpan: 12,
            rowSpan: requiredSectionRows(1, group.items, breakpoint),
          };
        return section;
      }),
    },
  ];
  return SiteDocumentSchema.parse(document);
}
