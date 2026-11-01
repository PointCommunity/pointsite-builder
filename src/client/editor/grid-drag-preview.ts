import type { SiteElement } from '../../site-kit/types';
import {
  areasOverlap,
  gridAreaFromPoint,
  gridRowOffset,
  type GridArea,
} from '../../site-kit/grid-layout';

export function measureGrid(surface: HTMLElement) {
  const view = surface.ownerDocument.defaultView!;
  const style = view.getComputedStyle(surface);
  const width = surface.getBoundingClientRect().width;
  const columnGap = Number.parseFloat(style.columnGap) || 0;
  const rowGap = Number.parseFloat(style.rowGap) || 0;
  const rootFontSize =
    Number.parseFloat(view.getComputedStyle(surface.ownerDocument.documentElement).fontSize) || 16;
  const minRem = Number.parseFloat(style.getPropertyValue('--point-grid-min-cell')) || 1.5;
  const cellSize = Math.max(minRem * rootFontSize, (width - columnGap * 11) / 12);
  const rowSizes = style.gridTemplateRows
    .split(/\s+/)
    .map(Number.parseFloat)
    .filter(Number.isFinite);
  const step = (width - columnGap * 11) / 12 + columnGap;
  let top = 0;
  const visibleRows = [...rowSizes];
  let height = visibleRows.reduce((sum, size) => sum + size + rowGap, 0) - rowGap;
  while (height < surface.clientHeight) {
    visibleRows.push(cellSize);
    height += cellSize + rowGap;
  }
  const dots = visibleRows
    .map((size) => {
      const dot = `<circle cx="${(step - columnGap) / 2}" cy="${top + size / 2}" r="1.5"/>`;
      top += size + rowGap;
      return dot;
    })
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${step}" height="${Math.max(1, top - rowGap)}"><g fill="${style.getPropertyValue('--point-primary').trim() || '#567f37'}">${dots}</g></svg>`;
  surface.style.setProperty(
    '--point-grid-track-dots',
    `url("data:image/svg+xml,${encodeURIComponent(svg)}")`,
  );
  surface.style.setProperty('--point-grid-track-step', `${step}px`);
  surface.style.setProperty('--point-grid-track-height', `${Math.max(1, top - rowGap)}px`);
  return { width, columnGap, rowGap, cellSize, rowSizes };
}

export interface GridDropIntent {
  type: SiteElement['type'];
  sectionId?: string;
  breakpoint?: 'desktop' | 'tablet' | 'mobile';
  area: GridArea;
  valid: boolean;
  label: string;
  bounds: { left: number; top: number; width: number; height: number };
}

export function deriveGridDropIntent(input: {
  type: SiteElement['type'];
  label: string;
  sectionId?: string;
  breakpoint?: 'desktop' | 'tablet' | 'mobile';
  metrics: {
    x: number;
    y: number;
    width: number;
    columnGap: number;
    rowGap: number;
    cellSize: number;
    rowSizes?: number[];
  };
  columnSpan: number;
  rowSpan: number;
  occupied: GridArea[];
  maxRows?: number;
}): GridDropIntent {
  const area = gridAreaFromPoint(input.metrics, input.columnSpan, input.rowSpan);
  const outsideRows = Boolean(input.maxRows && area.row + area.rowSpan - 1 > input.maxRows);
  const valid = !outsideRows && !input.occupied.some((sibling) => areasOverlap(area, sibling));
  const columnSize = (input.metrics.width - input.metrics.columnGap * 11) / 12;
  const columnEnd = area.column + area.columnSpan - 1;
  const rowEnd = area.row + area.rowSpan - 1;
  return {
    type: input.type,
    sectionId: input.sectionId,
    ...(input.breakpoint ? { breakpoint: input.breakpoint } : {}),
    area,
    valid,
    label: `${input.label} · columns ${area.column}–${columnEnd}, rows ${area.row}–${rowEnd} · ${outsideRows ? 'outside the group row limit' : valid ? 'valid placement' : 'blocked by another element'}`,
    bounds: {
      left: (area.column - 1) * (columnSize + input.metrics.columnGap),
      top: gridRowOffset(input.metrics, area.row - 1),
      width: area.columnSpan * columnSize + (area.columnSpan - 1) * input.metrics.columnGap,
      height:
        gridRowOffset(input.metrics, area.row + area.rowSpan - 1) -
        gridRowOffset(input.metrics, area.row - 1) -
        input.metrics.rowGap,
    },
  };
}

let draggedElementType: SiteElement['type'] | null = null;
let gridDropIntent: GridDropIntent | null = null;

export function setDraggedElementType(type: SiteElement['type'] | null): void {
  draggedElementType = type;
}

export function getDraggedElementType(): SiteElement['type'] | null {
  return draggedElementType;
}

export function setGridDropIntent(intent: GridDropIntent | null): void {
  gridDropIntent = intent;
}

export function getGridDropIntent(): GridDropIntent | null {
  return gridDropIntent;
}

export function setPointerFeedbackHidden(ownerDocument: Document, hidden: boolean): void {
  const hostDocument = ownerDocument.defaultView?.frameElement?.ownerDocument ?? ownerDocument;
  hostDocument.documentElement.toggleAttribute('data-point-grid-preview', hidden);
}
