import { describe, expect, it } from 'vitest';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import { SiteDocumentSchema } from '../../src/site-kit/schema';
import {
  compositionPreset,
  compositionPresetNames,
} from '../../src/client/editor/composition-presets';

describe('brand-neutral composition presets', () => {
  it.each(compositionPresetNames)('%s uses independent, responsive primitives', (name) => {
    const first = compositionPreset(name, defaultSiteDocument);
    const second = compositionPreset(name, defaultSiteDocument);
    expect(first.name).toBe(name);
    expect(first.items.length).toBeGreaterThanOrEqual(3);
    expect(first.items.some((item) => item.element.type === 'text')).toBe(true);
    expect(new Set(first.items.map((item) => item.id)).size).toBe(first.items.length);
    expect(first.items.map((item) => item.id)).not.toEqual(second.items.map((item) => item.id));
    for (const item of first.items) {
      for (const breakpoint of ['desktop', 'tablet', 'mobile'] as const) {
        const area = item.grid[breakpoint];
        expect(area.column + area.columnSpan).toBeLessThanOrEqual(13);
      }
    }
    const section = structuredClone(defaultSiteDocument.pages[0].blocks[1]);
    section.layout = 'grid';
    section.columns = 12;
    section.items = [
      {
        id: crypto.randomUUID(),
        span: 12,
        align: { desktop: 'stretch', tablet: 'stretch', mobile: 'stretch' },
        grid: {
          desktop: { column: 1, row: 1, columnSpan: 12, rowSpan: 10 },
          tablet: { column: 1, row: 1, columnSpan: 12, rowSpan: 10 },
          mobile: { column: 1, row: 1, columnSpan: 12, rowSpan: 10 },
        },
        element: first,
      },
    ];
    expect(
      SiteDocumentSchema.safeParse({
        ...defaultSiteDocument,
        schemaVersion: 12,
        rendererVersion: '12.0.0',
        pages: defaultSiteDocument.pages.map((page, index) =>
          index === 0
            ? { ...page, blocks: [page.blocks[0], section, ...page.blocks.slice(2)] }
            : page,
        ),
      }).success,
    ).toBe(true);
  });

  it('builds Card, Person, FAQ and contact areas from editable leaves', () => {
    const cases = [
      ['Image Card', 'image'],
      ['Person Card', 'image'],
      ['FAQ Item', 'faq'],
      ['Contact Area', 'form'],
    ] as const;
    for (const [name, kind] of cases) {
      const group = compositionPreset(name, defaultSiteDocument);
      expect(group.items.some((item) => item.element.type === kind)).toBe(true);
      expect(
        group.items.filter((item) => item.element.type === 'text').length,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it('keeps a composed FAQ item interactive', () => {
    const group = compositionPreset('FAQ Item', defaultSiteDocument);
    const faq = group.items.find((item) => item.element.type === 'faq')?.element;
    expect(faq).toMatchObject({
      type: 'faq',
      items: [{ question: 'Add a question', answer: 'Add an answer.' }],
    });
  });

  it('does not substitute an unrelated photo when a Person has none', () => {
    const document = structuredClone(defaultSiteDocument);
    document.collections.people[0].mediaId = undefined;
    const group = compositionPreset('Person Card', document);
    expect(group.items.some((item) => item.element.type === 'image')).toBe(false);
  });
});
