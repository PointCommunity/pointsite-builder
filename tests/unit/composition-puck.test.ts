import { describe, expect, it } from 'vitest';
import type { ComponentData } from '@puckeditor/core';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import { independentGridArea, independentResponsiveValue } from '../../src/site-kit/grid-layout';
import { SiteDocumentSchema } from '../../src/site-kit/schema';
import { dataToSection, sectionToData } from '../../src/client/editor/editor-section-data';

describe('Puck composition round trip', () => {
  it('preserves nested element identities, layers and responsive placement through edits', () => {
    const section = structuredClone(defaultSiteDocument.pages[0].blocks[1]);
    section.layout = 'grid';
    section.columns = 12;
    section.items = [
      {
        id: crypto.randomUUID(),
        span: 12,
        align: independentResponsiveValue('stretch'),
        grid: independentGridArea({ column: 1, row: 1, columnSpan: 12, rowSpan: 6 }),
        element: {
          id: crypto.randomUUID(),
          type: 'composition',
          name: 'Editable group',
          items: [
            {
              id: crypto.randomUUID(),
              span: 5,
              align: independentResponsiveValue('stretch'),
              grid: independentGridArea({ column: 3, row: 2, columnSpan: 5, rowSpan: 2 }),
              layer: 2,
              element: {
                id: crypto.randomUUID(),
                type: 'text',
                text: 'A first title',
                semantic: 'h1',
                style: 'lead',
                align: 'left',
              },
            },
          ],
        },
      },
    ];
    const document = SiteDocumentSchema.parse({
      ...defaultSiteDocument,
      schemaVersion: 12,
      rendererVersion: '12.0.0',
      pages: defaultSiteDocument.pages.map((page, index) =>
        index === 0
          ? { ...page, blocks: [page.blocks[0], section, ...page.blocks.slice(2)] }
          : page,
      ),
    });
    const source = document.pages[0].blocks[1];
    const data = sectionToData(source);
    const group = (data.props.content as ComponentData[])[0];
    const child = (group.props.content as ComponentData[])[0];
    expect(group.type).toBe('composition');
    expect(child.type).toBe('text');
    expect(child.props.layer).toBe(2);
    expect(dataToSection(data)).toEqual(source);
    (child.props.block as { text: string }).text = 'A changed title';
    const edited = dataToSection(data);
    expect(edited.items[0].element).toMatchObject({
      type: 'composition',
      items: [
        {
          id:
            source.items[0].element.type === 'composition'
              ? source.items[0].element.items[0].id
              : '',
          element: { text: 'A changed title' },
        },
      ],
    });
    (child.props.grid as { mobile: { row: number; rowSpan: number } }).mobile = {
      ...(child.props.grid as { mobile: { row: number; rowSpan: number } }).mobile,
      row: 9,
      rowSpan: 4,
    };
    expect(dataToSection(data).items[0].grid.mobile.rowSpan).toBe(12);
  });
});
