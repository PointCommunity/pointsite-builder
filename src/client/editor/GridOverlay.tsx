import type { ComponentData } from '@puckeditor/core';
import type { KeyboardEvent, PointerEvent, ReactNode } from 'react';
import {
  areaForBreakpoint,
  moveGridArea,
  resizeGridArea,
  updateGridArea,
  type GridArea,
} from '../../site-kit/grid-layout';
import type { ElementPlacement } from '../../site-kit/types';
import type { SectionSettings } from './SectionInspector';
import { useGridBreakpoint } from './GridBreakpointContext';
import { usePointPuck } from './puck-store';
import { setActiveGridSection } from './grid-interaction-store';

type Edge = 'north-west' | 'north-east' | 'south-west' | 'south-east';

function isGrid(value: unknown): value is ElementPlacement['grid'] {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'desktop' in value &&
    typeof (value as { desktop?: unknown }).desktop === 'object',
  );
}

export function GridOverlay({
  children,
  componentId,
  componentType,
  isSelected,
}: {
  children: ReactNode;
  componentId: string;
  componentType: string;
  hover: boolean;
  isSelected: boolean;
}) {
  const getItemById = usePointPuck((state) => state.getItemById);
  const getParentById = usePointPuck((state) => state.getParentById);
  const getSelectorForId = usePointPuck((state) => state.getSelectorForId);
  const dispatch = usePointPuck((state) => state.dispatch);
  const item = getItemById(componentId) as unknown as ComponentData | null;
  const parent = getParentById(componentId) as unknown as ComponentData | null;
  const itemProps = item?.props as unknown as Record<string, unknown> | undefined;
  const parentProps = parent?.props as unknown as Record<string, unknown> | undefined;
  const settings = parentProps?.settings as SectionSettings | undefined;
  const grid = itemProps?.grid;
  const breakpoint = useGridBreakpoint();

  if (!isSelected || !isGrid(grid) || settings?.layout !== 'grid') return <>{children}</>;

  const commit = (nextArea: GridArea, recordHistory = true) => {
    const selector = getSelectorForId(componentId);
    const current = getItemById(componentId) as unknown as ComponentData | null;
    const currentProps = current?.props as unknown as Record<string, unknown> | undefined;
    if (
      !selector ||
      !selector.zone ||
      !current ||
      !currentProps ||
      typeof currentProps.id !== 'string' ||
      !isGrid(currentProps.grid)
    )
      return;
    dispatch({
      type: 'replace',
      destinationIndex: selector.index,
      destinationZone: selector.zone,
      data: {
        ...current,
        props: {
          ...currentProps,
          id: currentProps.id,
          grid: updateGridArea(currentProps.grid, breakpoint, nextArea),
        },
      },
      recordHistory,
    });
  };

  const begin = (event: PointerEvent<HTMLButtonElement>, mode: 'move' | Edge) => {
    event.preventDefault();
    event.stopPropagation();
    const ownerDocument = event.currentTarget.ownerDocument;
    const source = ownerDocument.querySelector(`[data-puck-component="${componentId}"]`);
    const surface = source?.closest<HTMLElement>('.point-layout-section__grid');
    if (!surface) return;
    const rect = surface.getBoundingClientRect();
    const computed = ownerDocument.defaultView?.getComputedStyle(surface);
    const columnGap = Number.parseFloat(computed?.columnGap ?? '0') || 0;
    const rowGap = Number.parseFloat(computed?.rowGap ?? '0') || 0;
    const cell = (rect.width - columnGap * 11) / 12;
    const xStep = cell + columnGap;
    const yStep = cell + rowGap;
    const startX = event.clientX;
    const startY = event.clientY;
    const startArea = areaForBreakpoint(grid, breakpoint);
    let latest = startArea;
    const rawSectionId = parentProps?.id;
    const sectionId =
      typeof rawSectionId === 'string' || typeof rawSectionId === 'number'
        ? String(rawSectionId)
        : '';
    setActiveGridSection(sectionId || null);
    surface.dataset.gridActive = 'true';

    const move = (nextEvent: globalThis.PointerEvent) => {
      const columns = Math.round((nextEvent.clientX - startX) / xStep);
      const rows = Math.round((nextEvent.clientY - startY) / yStep);
      latest =
        mode === 'move'
          ? moveGridArea(startArea, columns, rows)
          : resizeGridArea(startArea, mode, columns, rows);
      commit(latest, false);
    };
    const finish = () => {
      ownerDocument.removeEventListener('pointermove', move);
      ownerDocument.removeEventListener('pointerup', finish);
      ownerDocument.removeEventListener('pointercancel', finish);
      delete surface.dataset.gridActive;
      setActiveGridSection(null);
      commit(latest, true);
    };
    ownerDocument.addEventListener('pointermove', move);
    ownerDocument.addEventListener('pointerup', finish, { once: true });
    ownerDocument.addEventListener('pointercancel', finish, { once: true });
  };

  const keyMove = (event: KeyboardEvent<HTMLButtonElement>, mode: 'move' | Edge) => {
    let columns = 0;
    let rows = 0;
    if (event.key === 'ArrowLeft') columns = -1;
    if (event.key === 'ArrowRight') columns = 1;
    if (event.key === 'ArrowUp') rows = -1;
    if (event.key === 'ArrowDown') rows = 1;
    if (!columns && !rows) return;
    event.preventDefault();
    event.stopPropagation();
    const current = areaForBreakpoint(grid, breakpoint);
    commit(
      mode === 'move'
        ? moveGridArea(current, columns, rows)
        : resizeGridArea(current, mode, columns, rows),
    );
  };

  return (
    <>
      {children}
      <div className="point-grid-controls" data-grid-controls={componentType}>
        <button
          type="button"
          className="point-grid-move"
          aria-label={`Move ${componentType} on ${breakpoint} grid`}
          title="Drag to move. Arrow keys move one grid square."
          onPointerDown={(event) => begin(event, 'move')}
          onKeyDown={(event) => keyMove(event, 'move')}
        >
          Move
        </button>
        {(['north-west', 'north-east', 'south-west', 'south-east'] as const).map((edge) => (
          <button
            type="button"
            key={edge}
            className={`point-grid-resize point-grid-resize--${edge}`}
            aria-label={`Resize ${componentType} from ${edge.replace('-', ' ')}`}
            title="Drag or use arrow keys to resize by one grid square."
            onPointerDown={(event) => begin(event, edge)}
            onKeyDown={(event) => keyMove(event, edge)}
          />
        ))}
      </div>
    </>
  );
}
