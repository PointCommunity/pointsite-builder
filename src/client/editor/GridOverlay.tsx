import type { ComponentData } from '@puckeditor/core';
import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import {
  areaForBreakpoint,
  moveGridArea,
  requiredSectionRows,
  resolveGridArea,
  resizeGridArea,
  updateGridArea,
  type GridArea,
  type GridResizeHandle,
} from '../../site-kit/grid-layout';
import type { ElementPlacement } from '../../site-kit/types';
import type { SectionSettings } from './SectionInspector';
import { useGridBreakpoint } from './GridBreakpointContext';
import { usePointPuck } from './puck-store';
import { setActiveGridSection } from './grid-interaction-store';
import { childComponents, siblingComponents } from './puck-grid-data';
import { setPuckActionIntent } from './puck-action-intent';

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
  const data = usePointPuck((state) => state.appState.data);
  const item = getItemById(componentId) as unknown as ComponentData | null;
  const parent = getParentById(componentId) as unknown as ComponentData | null;
  const itemProps = item?.props as unknown as Record<string, unknown> | undefined;
  const parentProps = parent?.props as unknown as Record<string, unknown> | undefined;
  const settings = parentProps?.settings as SectionSettings | undefined;
  const grid = itemProps?.grid;
  const breakpoint = useGridBreakpoint();
  const [status, setStatus] = useState('');
  const selectionMarker = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    if (componentType !== 'hero') return;
    const ownerDocument = selectionMarker.current?.ownerDocument;
    const source = ownerDocument?.querySelector<HTMLElement>(
      `[data-puck-component="${CSS.escape(componentId)}"]`,
    );
    if (!source) return;
    if (isSelected) source.dataset.pointSelected = 'true';
    else delete source.dataset.pointSelected;
    return () => {
      delete source.dataset.pointSelected;
    };
  }, [componentId, componentType, isSelected]);

  const heroSelectionMarker =
    componentType === 'hero' ? (
      <span ref={selectionMarker} className="point-hero-selection-marker" aria-hidden="true" />
    ) : null;

  const commitSectionRows = (minRows: number, recordHistory = true) => {
    const selector = getSelectorForId(componentId);
    const current = getItemById(componentId) as unknown as ComponentData | null;
    const currentProps = current?.props as unknown as Record<string, unknown> | undefined;
    const currentSettings = currentProps?.settings as SectionSettings | undefined;
    const storedContent = childComponents(data, componentId);
    const content = storedContent.length
      ? storedContent
      : ((currentProps?.content ?? []) as ComponentData[]);
    if (!selector || !selector.zone || !current || !currentProps || !currentSettings) return;
    const required = requiredSectionRows(
      1,
      content
        .map((child) => ({ grid: child.props.grid as ElementPlacement['grid'] }))
        .filter((placement) => isGrid(placement.grid)),
      breakpoint,
    );
    const nextRows = Math.max(required, Math.min(100, Math.round(minRows)));
    setPuckActionIntent({
      category: 'resize',
      context: 'element-layout',
      transient: !recordHistory,
    });
    dispatch({
      type: 'replace',
      destinationIndex: selector.index,
      destinationZone: selector.zone,
      data: {
        ...current,
        props: {
          ...currentProps,
          id:
            typeof currentProps.id === 'string' || typeof currentProps.id === 'number'
              ? String(currentProps.id)
              : componentId,
          settings: { ...currentSettings, minRows: nextRows },
        },
      },
      recordHistory,
    });
    setStatus(`Section height set to ${nextRows} grid rows.`);
  };

  if (isSelected && !isGrid(grid) && itemProps?.settings) {
    const ownSettings = itemProps?.settings as SectionSettings | undefined;
    if (!ownSettings || ownSettings.layout !== 'grid') return <>{children}</>;
    const resizeSection = (event: PointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const ownerDocument = event.currentTarget.ownerDocument;
      const source = ownerDocument.querySelector(`[data-puck-component="${componentId}"]`);
      const surface = source?.querySelector<HTMLElement>('.point-layout-section__grid');
      if (!surface) return;
      const computed = getComputedStyle(surface);
      const rowStep =
        (Number.parseFloat(computed.getPropertyValue('--point-grid-cell')) || 24) +
        (Number.parseFloat(computed.rowGap) || 0);
      const startY = event.clientY;
      const startRows = ownSettings.minRows;
      let latest = startRows;
      setActiveGridSection(
        typeof itemProps?.id === 'string' || typeof itemProps?.id === 'number'
          ? String(itemProps.id)
          : componentId,
      );
      surface.dataset.gridActive = 'true';
      const move = (nextEvent: globalThis.PointerEvent) => {
        latest = startRows + Math.round((nextEvent.clientY - startY) / rowStep);
        commitSectionRows(latest, false);
      };
      const finish = () => {
        ownerDocument.removeEventListener('pointermove', move);
        delete surface.dataset.gridActive;
        setActiveGridSection(null);
        commitSectionRows(latest, true);
      };
      ownerDocument.addEventListener('pointermove', move);
      ownerDocument.addEventListener('pointerup', finish, { once: true });
      ownerDocument.addEventListener('pointercancel', finish, { once: true });
    };
    return (
      <>
        {children}
        <div className="point-section-grid-controls">
          <button
            type="button"
            className="point-section-grid-resize"
            aria-label={`Resize ${ownSettings.name} height`}
            title="Drag vertically or use arrow keys to change section height."
            onPointerDown={resizeSection}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
              event.preventDefault();
              event.stopPropagation();
              commitSectionRows(ownSettings.minRows + (event.key === 'ArrowDown' ? 1 : -1));
            }}
          >
            <span aria-hidden="true">↕</span>
          </button>
          <p className="sr-only" role="status" aria-live="polite">
            {status}
          </p>
        </div>
      </>
    );
  }

  if (!isSelected || !isGrid(grid) || settings?.layout !== 'grid')
    return (
      <>
        {children}
        {heroSelectionMarker}
      </>
    );

  const commit = (nextArea: GridArea, category: 'move' | 'resize', recordHistory = true) => {
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
    const storedSiblings = siblingComponents(data, componentId);
    const siblings = (
      storedSiblings.length ? storedSiblings : ((parentProps?.content ?? []) as ComponentData[])
    )
      .filter((child) => child.props.id !== currentProps.id && isGrid(child.props.grid))
      .map((child) => areaForBreakpoint(child.props.grid as ElementPlacement['grid'], breakpoint));
    const previous = areaForBreakpoint(currentProps.grid, breakpoint);
    const resolved = resolveGridArea(nextArea, previous, siblings);
    if (resolved.rejected) {
      setStatus('Move blocked because elements cannot overlap.');
      return;
    }
    setStatus('');
    setPuckActionIntent({ category, context: 'element-layout', transient: !recordHistory });
    dispatch({
      type: 'replace',
      destinationIndex: selector.index,
      destinationZone: selector.zone,
      data: {
        ...current,
        props: {
          ...currentProps,
          id: currentProps.id,
          grid: updateGridArea(currentProps.grid, breakpoint, resolved.area),
        },
      },
      recordHistory,
    });
  };

  const begin = (event: PointerEvent<HTMLButtonElement>, mode: 'move' | GridResizeHandle) => {
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
      commit(latest, mode === 'move' ? 'move' : 'resize', false);
    };
    const finish = () => {
      ownerDocument.removeEventListener('pointermove', move);
      ownerDocument.removeEventListener('pointerup', finish);
      ownerDocument.removeEventListener('pointercancel', finish);
      delete surface.dataset.gridActive;
      setActiveGridSection(null);
      commit(latest, mode === 'move' ? 'move' : 'resize', true);
    };
    ownerDocument.addEventListener('pointermove', move);
    ownerDocument.addEventListener('pointerup', finish, { once: true });
    ownerDocument.addEventListener('pointercancel', finish, { once: true });
  };

  const keyMove = (event: KeyboardEvent<HTMLButtonElement>, mode: 'move' | GridResizeHandle) => {
    let columns = 0;
    let rows = 0;
    if (event.key === 'ArrowLeft') columns = -1;
    if (event.key === 'ArrowRight') columns = 1;
    if (event.key === 'ArrowUp') rows = -1;
    if (event.key === 'ArrowDown') rows = 1;
    if (!columns && !rows) return;
    event.preventDefault();
    event.stopPropagation();
    const currentItem = getItemById(componentId) as unknown as ComponentData | null;
    const currentGrid = (currentItem?.props as unknown as Record<string, unknown> | undefined)
      ?.grid;
    const current = areaForBreakpoint(isGrid(currentGrid) ? currentGrid : grid, breakpoint);
    commit(
      mode === 'move'
        ? moveGridArea(current, columns, rows)
        : resizeGridArea(current, mode, columns, rows),
      mode === 'move' ? 'move' : 'resize',
    );
  };

  const area = areaForBreakpoint(grid, breakpoint);
  const resizeHandles: GridResizeHandle[] = [
    'north-west',
    ...(area.columnSpan >= 2 ? (['north'] as const) : []),
    'north-east',
    ...(area.rowSpan >= 2 ? (['east'] as const) : []),
    'south-east',
    ...(area.columnSpan >= 2 ? (['south'] as const) : []),
    'south-west',
    ...(area.rowSpan >= 2 ? (['west'] as const) : []),
  ];

  return (
    <>
      {children}
      {heroSelectionMarker}
      <div className="point-grid-controls" data-grid-controls={componentType}>
        <button
          type="button"
          className="point-grid-move-surface"
          aria-label={`Move ${componentType} on ${breakpoint} grid`}
          title="Drag anywhere inside the selected box. Arrow keys move one grid square."
          onPointerDown={(event) => begin(event, 'move')}
          onKeyDown={(event) => keyMove(event, 'move')}
        ></button>
        {resizeHandles.map((edge) => (
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
        <p className="sr-only" role="status" aria-live="polite">
          {status}
        </p>
      </div>
    </>
  );
}
