import { describe, expect, it } from 'vitest';
import { ComposedBlockSchema, SiteDocumentSchema } from '../../src/site-kit/schema';
import { independentGridArea, independentResponsiveValue } from '../../src/site-kit/grid-layout';
import { defaultSiteDocument } from '../../src/site-kit/default-site';

const placement = (id: string, elementId: string) => ({
  id,
  span: 6,
  align: independentResponsiveValue('stretch' as const),
  grid: independentGridArea({ column: 1, row: 1, columnSpan: 6, rowSpan: 3 }),
  layer: 0,
  element: {
    id: elementId,
    type: 'text',
    text: 'Independent text',
    style: 'body',
    align: 'left',
  },
});

describe('composed block contract', () => {
  const group = {
    id: '22222222-2222-4222-8222-222222222221',
    type: 'composition',
    name: '',
    items: [
      placement('22222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222223'),
      placement('22222222-2222-4222-8222-222222222224', '22222222-2222-4222-8222-222222222225'),
    ],
  };

  it('keeps stable child identities, empty display name, breakpoint positions and layers', () => {
    const input = structuredClone(group);
    input.items[1].grid.tablet.column = 4;
    input.items[1].layer = 2;
    expect(ComposedBlockSchema.parse(input)).toEqual(input);
  });

  it('rejects duplicate placement or element identities within a group', () => {
    const duplicatePlacement = structuredClone(group);
    duplicatePlacement.items[1].id = duplicatePlacement.items[0].id;
    expect(ComposedBlockSchema.safeParse(duplicatePlacement).success).toBe(false);

    const duplicateElement = structuredClone(group);
    duplicateElement.items[1].element.id = duplicateElement.items[0].element.id;
    expect(ComposedBlockSchema.safeParse(duplicateElement).success).toBe(false);
  });

  it('bounds layers and grid coordinates and rejects nested groups', () => {
    const invalidLayer = structuredClone(group);
    invalidLayer.items[0].layer = 1000;
    expect(ComposedBlockSchema.safeParse(invalidLayer).success).toBe(false);

    const invalidGrid = structuredClone(group);
    invalidGrid.items[0].grid.desktop.column = 12;
    expect(ComposedBlockSchema.safeParse(invalidGrid).success).toBe(false);

    const nested = structuredClone(group) as Record<string, unknown>;
    (nested.items as Array<{ element: unknown }>)[0].element = {
      ...group,
      id: crypto.randomUUID(),
    };
    expect(ComposedBlockSchema.safeParse(nested).success).toBe(false);
  });
});

it('permits image wrapping only in version-12 documents', () => {
  const legacy = structuredClone(defaultSiteDocument);
  const image = legacy.pages[0]?.blocks
    .flatMap((section) => section.items)
    .find((item) => item.element.type === 'image');
  if (!image || image.element.type !== 'image') throw new Error('Expected image fixture');
  image.element.wrap = true;
  expect(SiteDocumentSchema.safeParse(legacy).success).toBe(false);
  legacy.schemaVersion = 12;
  legacy.rendererVersion = '12.0.0';
  expect(SiteDocumentSchema.safeParse(legacy).success).toBe(true);
});

it('permits an empty authored Section name', () => {
  const document = structuredClone(defaultSiteDocument);
  document.schemaVersion = 12;
  document.rendererVersion = '12.0.0';
  document.pages[0].blocks[0].name = '';
  expect(SiteDocumentSchema.safeParse(document).success).toBe(true);
});
