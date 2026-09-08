import type { SiteElement } from '../../site-kit/types';
import { areasOverlap, gridAreaFromPoint, type GridArea } from '../../site-kit/grid-layout';

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
  };
  columnSpan: number;
  rowSpan: number;
  occupied: GridArea[];
}): GridDropIntent {
  const area = gridAreaFromPoint(input.metrics, input.columnSpan, input.rowSpan);
  const valid = !input.occupied.some((sibling) => areasOverlap(area, sibling));
  const columnSize = (input.metrics.width - input.metrics.columnGap * 11) / 12;
  const columnEnd = area.column + area.columnSpan - 1;
  const rowEnd = area.row + area.rowSpan - 1;
  return {
    type: input.type,
    sectionId: input.sectionId,
    ...(input.breakpoint ? { breakpoint: input.breakpoint } : {}),
    area,
    valid,
    label: `${input.label} · columns ${area.column}–${columnEnd}, rows ${area.row}–${rowEnd} · ${valid ? 'valid placement' : 'blocked by another element'}`,
    bounds: {
      left: (area.column - 1) * (columnSize + input.metrics.columnGap),
      top: (area.row - 1) * (input.metrics.cellSize + input.metrics.rowGap),
      width: area.columnSpan * columnSize + (area.columnSpan - 1) * input.metrics.columnGap,
      height: area.rowSpan * input.metrics.cellSize + (area.rowSpan - 1) * input.metrics.rowGap,
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
