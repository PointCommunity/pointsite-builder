import { describe, expect, it } from 'vitest';
import { deriveGridDropIntent, measureGrid } from '../../src/client/editor/grid-drag-preview';
import { gridRowAtOffset, gridRowOffset } from '../../src/site-kit/grid-layout';

describe('grid insertion intent', () => {
  it('draws track centers and remaining empty rows without stretching expanded rows', () => {
    const surface = document.createElement('div');
    surface.style.cssText =
      'grid-template-rows:100px 220px;column-gap:10px;row-gap:5px;--point-primary:#123456';
    surface.getBoundingClientRect = () => ({ width: 1310 }) as DOMRect;
    Object.defineProperty(surface, 'clientHeight', { value: 535 });
    document.body.appendChild(surface);
    try {
      expect(measureGrid(surface).rowSizes).toEqual([100, 220]);
      const image = surface.style.getPropertyValue('--point-grid-track-dots');
      const svg = new DOMParser().parseFromString(
        decodeURIComponent(image.slice(image.indexOf(',') + 1, -2)),
        'image/svg+xml',
      );
      expect(
        Array.from(svg.querySelectorAll('circle'), (dot) => Number(dot.getAttribute('cy'))),
      ).toEqual([50, 215, 380, 485]);
      expect(surface.style.getPropertyValue('--point-grid-track-height')).toBe('535px');
    } finally {
      surface.remove();
    }
  });
  it('snaps and sizes the phantom using content-expanded rows and minimum-sized future rows', () => {
    const metrics = {
      x: 110,
      y: 340,
      width: 1310,
      columnGap: 10,
      rowGap: 5,
      cellSize: 100,
      rowSizes: [100, 220, 100],
    };
    expect(gridRowOffset(metrics, 2)).toBe(330);
    expect(gridRowAtOffset(metrics, 330)).toBe(2);
    expect(gridRowAtOffset(metrics, 217.5)).toBe(1.5);
    expect(gridRowOffset(metrics, 5)).toBe(645);
    expect(
      deriveGridDropIntent({
        type: 'text',
        label: 'Text',
        metrics,
        columnSpan: 2,
        rowSpan: 2,
        occupied: [],
      }),
    ).toMatchObject({
      area: { column: 2, row: 3, columnSpan: 2, rowSpan: 2 },
      bounds: { left: 110, top: 330, width: 210, height: 205 },
    });
  });
  it('blocks a nested drop whose content would exceed the group row limit', () => {
    const intent = deriveGridDropIntent({
      type: 'text',
      label: 'Text',
      metrics: { x: 0, y: 9900, width: 1200, columnGap: 0, rowGap: 0, cellSize: 100 },
      columnSpan: 6,
      rowSpan: 3,
      occupied: [],
      maxRows: 100,
    });
    expect(intent.valid).toBe(false);
    expect(intent.label).toContain('outside the group row limit');
  });
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
