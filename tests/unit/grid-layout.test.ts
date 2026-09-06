import {
  areaForBreakpoint,
  clampGridArea,
  legacyGridAreas,
  moveGridArea,
  nextGridArea,
  resizeGridArea,
  updateGridArea,
} from '../../src/site-kit/grid-layout';

describe('responsive grid layout', () => {
  const desktop = { column: 1, row: 1, columnSpan: 6, rowSpan: 4 };

  it('inherits desktop until a narrower breakpoint is changed', () => {
    const grid = { desktop };
    expect(areaForBreakpoint(grid, 'tablet')).toEqual(desktop);
    const changed = updateGridArea(grid, 'tablet', { column: 3, columnSpan: 8 });
    expect(changed.desktop).toEqual(desktop);
    expect(changed.tablet).toEqual({ column: 3, row: 1, columnSpan: 8, rowSpan: 4 });
    expect(areaForBreakpoint(changed, 'mobile')).toEqual(desktop);
  });

  it('clamps moves and resizes inside twelve columns', () => {
    expect(moveGridArea(desktop, 20, -20)).toEqual({
      column: 7,
      row: 1,
      columnSpan: 6,
      rowSpan: 4,
    });
    expect(resizeGridArea(desktop, 'south-east', 20, 2)).toEqual({
      column: 1,
      row: 1,
      columnSpan: 12,
      rowSpan: 6,
    });
    expect(clampGridArea({ column: 12, row: 0, columnSpan: 4, rowSpan: 0 })).toEqual({
      column: 9,
      row: 1,
      columnSpan: 4,
      rowSpan: 1,
    });
  });

  it('finds the first unoccupied location', () => {
    const items = [
      { grid: { desktop: { column: 1, row: 1, columnSpan: 6, rowSpan: 4 } } },
      { grid: { desktop: { column: 7, row: 1, columnSpan: 6, rowSpan: 4 } } },
    ];
    expect(nextGridArea(items, 6, 3)).toEqual({
      column: 1,
      row: 5,
      columnSpan: 6,
      rowSpan: 3,
    });
  });

  it('deterministically maps legacy two-column spans onto twelve columns', () => {
    const areas = legacyGridAreas({
      layout: 'grid',
      columns: 2,
      items: [
        { span: 1, element: { id: crypto.randomUUID(), type: 'spacer', size: 'small' } },
        { span: 1, element: { id: crypto.randomUUID(), type: 'spacer', size: 'small' } },
      ],
    });
    expect(areas).toEqual([
      { desktop: { column: 1, row: 1, columnSpan: 6, rowSpan: 2 } },
      { desktop: { column: 7, row: 1, columnSpan: 6, rowSpan: 2 } },
    ]);
  });
});
