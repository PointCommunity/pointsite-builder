import {
  areaForBreakpoint,
  areasOverlap,
  clampGridArea,
  gridAreaFromPoint,
  legacyGridAreas,
  moveGridArea,
  nextGridArea,
  resolveGridArea,
  resizeGridArea,
  requiredSectionRows,
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

  it('resizes from each cardinal edge without moving the opposite edge', () => {
    expect(resizeGridArea(desktop, 'north', 0, -2)).toEqual({
      column: 1,
      row: 1,
      columnSpan: 6,
      rowSpan: 6,
    });
    expect(resizeGridArea(desktop, 'east', 2, 0)).toEqual({
      column: 1,
      row: 1,
      columnSpan: 8,
      rowSpan: 4,
    });
    expect(resizeGridArea(desktop, 'south', 0, 2)).toEqual({
      column: 1,
      row: 1,
      columnSpan: 6,
      rowSpan: 6,
    });
    expect(resizeGridArea(desktop, 'west', 2, 0)).toEqual({
      column: 3,
      row: 1,
      columnSpan: 4,
      rowSpan: 4,
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

  it('rejects a move or resize that would overlap a sibling', () => {
    const occupied = [{ column: 7, row: 1, columnSpan: 6, rowSpan: 4 }];
    const moved = { column: 5, row: 1, columnSpan: 6, rowSpan: 4 };

    expect(areasOverlap(moved, occupied[0])).toBe(true);
    expect(resolveGridArea(moved, desktop, occupied)).toEqual({
      area: desktop,
      rejected: true,
    });
    expect(
      resolveGridArea({ column: 1, row: 5, columnSpan: 6, rowSpan: 4 }, desktop, occupied),
    ).toEqual({ area: { column: 1, row: 5, columnSpan: 6, rowSpan: 4 }, rejected: false });
  });

  it('snaps a pointer to the requested area while keeping it inside twelve columns', () => {
    expect(
      gridAreaFromPoint(
        { x: 720, y: 205, width: 1_200, columnGap: 0, rowGap: 0, cellSize: 100 },
        6,
        3,
      ),
    ).toEqual({ column: 7, row: 3, columnSpan: 6, rowSpan: 3 });
    expect(
      gridAreaFromPoint(
        { x: 1_190, y: 0, width: 1_200, columnGap: 0, rowGap: 0, cellSize: 100 },
        4,
        2,
      ),
    ).toEqual({ column: 9, row: 1, columnSpan: 4, rowSpan: 2 });
  });

  it('never lets a section become shorter than its content', () => {
    expect(
      requiredSectionRows(4, [
        { grid: { desktop: { column: 1, row: 8, columnSpan: 4, rowSpan: 3 } } },
      ]),
    ).toBe(10);
    expect(requiredSectionRows(12, [])).toBe(12);
  });
});
