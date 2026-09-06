import type { ElementPlacement, SectionBlock, SiteElement } from './types';

export type GridBreakpoint = 'desktop' | 'tablet' | 'mobile';
export type GridArea = ElementPlacement['grid']['desktop'];
export type ResponsiveGridArea = ElementPlacement['grid'];

export const GRID_COLUMNS = 12;
export const MAX_GRID_ROWS = 1_000;

const defaultRows: Record<SiteElement['type'], number> = {
  hero: 10,
  heading: 4,
  richText: 5,
  image: 7,
  mediaEmbed: 7,
  splitFeature: 8,
  cta: 5,
  cards: 8,
  people: 8,
  faq: 8,
  form: 10,
  map: 9,
  divider: 1,
  spacer: 2,
  text: 3,
  button: 2,
};

export function defaultRowSpan(type: SiteElement['type']): number {
  return defaultRows[type];
}

export function areaForBreakpoint(grid: ResponsiveGridArea, breakpoint: GridBreakpoint): GridArea {
  return grid[breakpoint] ?? grid.desktop;
}

export function clampGridArea(area: GridArea): GridArea {
  const columnSpan = Math.max(1, Math.min(GRID_COLUMNS, Math.round(area.columnSpan)));
  const column = Math.max(1, Math.min(GRID_COLUMNS - columnSpan + 1, Math.round(area.column)));
  return {
    column,
    row: Math.max(1, Math.min(MAX_GRID_ROWS, Math.round(area.row))),
    columnSpan,
    rowSpan: Math.max(1, Math.min(100, Math.round(area.rowSpan))),
  };
}

export function areasOverlap(a: GridArea, b: GridArea): boolean {
  return (
    a.column < b.column + b.columnSpan &&
    a.column + a.columnSpan > b.column &&
    a.row < b.row + b.rowSpan &&
    a.row + a.rowSpan > b.row
  );
}

export function resolveGridArea(
  candidate: GridArea,
  previous: GridArea,
  occupied: GridArea[],
): { area: GridArea; rejected: boolean } {
  const area = clampGridArea(candidate);
  return occupied.some((sibling) => areasOverlap(area, sibling))
    ? { area: clampGridArea(previous), rejected: true }
    : { area, rejected: false };
}

export function gridAreaFromPoint(
  metrics: {
    x: number;
    y: number;
    width: number;
    columnGap: number;
    rowGap: number;
    cellSize: number;
  },
  columnSpan: number,
  rowSpan: number,
): GridArea {
  const columnStep =
    (metrics.width - metrics.columnGap * (GRID_COLUMNS - 1)) / GRID_COLUMNS + metrics.columnGap;
  const rowStep = metrics.cellSize + metrics.rowGap;
  return clampGridArea({
    column: Math.floor(Math.max(0, metrics.x) / Math.max(1, columnStep)) + 1,
    row: Math.floor(Math.max(0, metrics.y) / Math.max(1, rowStep)) + 1,
    columnSpan,
    rowSpan,
  });
}

export function requiredSectionRows(
  minRows: number,
  items: Array<Pick<ElementPlacement, 'grid'>>,
  breakpoint: GridBreakpoint = 'desktop',
): number {
  return Math.max(
    1,
    Math.round(minRows),
    ...items.map(({ grid }) => {
      const area = areaForBreakpoint(grid, breakpoint);
      return area.row + area.rowSpan - 1;
    }),
  );
}

export function updateGridArea(
  grid: ResponsiveGridArea,
  breakpoint: GridBreakpoint,
  change: Partial<GridArea>,
): ResponsiveGridArea {
  const current = areaForBreakpoint(grid, breakpoint);
  const next = clampGridArea({ ...current, ...change });
  return breakpoint === 'desktop' ? { ...grid, desktop: next } : { ...grid, [breakpoint]: next };
}

export function moveGridArea(area: GridArea, columns: number, rows: number): GridArea {
  return clampGridArea({ ...area, column: area.column + columns, row: area.row + rows });
}

export function resizeGridArea(
  area: GridArea,
  edge: 'north-west' | 'north-east' | 'south-west' | 'south-east',
  columns: number,
  rows: number,
): GridArea {
  const next = { ...area };
  if (edge.includes('west')) {
    next.column += columns;
    next.columnSpan -= columns;
  } else {
    next.columnSpan += columns;
  }
  if (edge.includes('north')) {
    next.row += rows;
    next.rowSpan -= rows;
  } else {
    next.rowSpan += rows;
  }
  return clampGridArea(next);
}

export function nextGridArea(
  items: Array<Pick<ElementPlacement, 'grid'>>,
  columnSpan: number,
  rowSpan: number,
  breakpoint: GridBreakpoint = 'desktop',
): GridArea {
  const width = Math.max(1, Math.min(GRID_COLUMNS, columnSpan));
  const sorted = items.map((item) => areaForBreakpoint(item.grid, breakpoint));
  for (let row = 1; row <= 1_000; row += 1) {
    for (let column = 1; column <= GRID_COLUMNS - width + 1; column += 1) {
      const candidate = { column, row, columnSpan: width, rowSpan };
      const overlaps = sorted.some((area) => areasOverlap(candidate, area));
      if (!overlaps) return candidate;
    }
  }
  return { column: 1, row: 1_001, columnSpan: width, rowSpan };
}

export function legacyGridAreas(section: {
  layout: SectionBlock['layout'];
  columns: SectionBlock['columns'];
  items: Array<{ span: number; element: SiteElement }>;
}): ResponsiveGridArea[] {
  let occupied: Array<{ grid: ResponsiveGridArea }> = [];
  const unit = GRID_COLUMNS / section.columns;
  return section.items.map((item) => {
    const columnSpan =
      section.layout === 'grid'
        ? Math.max(1, Math.min(GRID_COLUMNS, Math.round(item.span * unit)))
        : GRID_COLUMNS;
    const desktop = nextGridArea(occupied, columnSpan, defaultRowSpan(item.element.type));
    const grid = { desktop };
    occupied = [...occupied, { grid }];
    return grid;
  });
}

export function gridSectionRows(section: SectionBlock, breakpoint: GridBreakpoint): number {
  return Math.max(
    1,
    ...section.items.map((item) => {
      const area = areaForBreakpoint(item.grid, breakpoint);
      return area.row + area.rowSpan - 1;
    }),
  );
}
