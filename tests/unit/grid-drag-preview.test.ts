import { describe, expect, it } from 'vitest';
import { deriveGridDropIntent } from '../../src/client/editor/grid-drag-preview';

describe('grid insertion intent', () => {
  const metrics = {
    x: 610,
    y: 220,
    width: 1_200,
    columnGap: 0,
    rowGap: 0,
    cellSize: 100,
  };

  it('uses the pointed cells and exposes exact geometry for a valid drop', () => {
    expect(
      deriveGridDropIntent({
        type: 'heading',
        label: 'Heading',
        metrics,
        columnSpan: 6,
        rowSpan: 3,
        occupied: [],
      }),
    ).toEqual({
      type: 'heading',
      sectionId: undefined,
      area: { column: 7, row: 3, columnSpan: 6, rowSpan: 3 },
      valid: true,
      label: 'Heading · columns 7–12, rows 3–5 · valid placement',
      bounds: { left: 600, top: 200, width: 600, height: 300 },
    });
  });

  it('keeps an occupied pointer target visible and invalid instead of using a fallback', () => {
    expect(
      deriveGridDropIntent({
        type: 'heading',
        label: 'Heading',
        sectionId: 'section-a',
        metrics,
        columnSpan: 6,
        rowSpan: 3,
        occupied: [{ column: 7, row: 3, columnSpan: 2, rowSpan: 2 }],
      }),
    ).toEqual({
      type: 'heading',
      sectionId: 'section-a',
      area: { column: 7, row: 3, columnSpan: 6, rowSpan: 3 },
      valid: false,
      label: 'Heading · columns 7–12, rows 3–5 · blocked by another element',
      bounds: { left: 600, top: 200, width: 600, height: 300 },
    });
  });

  it('accounts for row and column gaps in the final phantom bounds', () => {
    const intent = deriveGridDropIntent({
      type: 'text',
      label: 'Text',
      metrics: { x: 110, y: 70, width: 1_310, columnGap: 10, rowGap: 5, cellSize: 100 },
      columnSpan: 2,
      rowSpan: 2,
      occupied: [],
    });
    expect(intent.area).toEqual({ column: 2, row: 1, columnSpan: 2, rowSpan: 2 });
    expect(intent.bounds).toEqual({ left: 110, top: 0, width: 210, height: 205 });
  });
});
