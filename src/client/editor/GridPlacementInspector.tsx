import { useState } from 'react';
import { areaForBreakpoint, resolveGridArea, updateGridArea } from '../../site-kit/grid-layout';
import type { ElementPlacement } from '../../site-kit/types';
import { useGridBreakpoint } from './GridBreakpointContext';

export function GridPlacementInspector({
  value,
  occupied = [],
  allowOverlap = false,
  maxRows,
  onChange,
}: {
  value: ElementPlacement['grid'];
  occupied?: ElementPlacement['grid'][];
  allowOverlap?: boolean;
  maxRows?: number;
  onChange: (value: ElementPlacement['grid']) => void;
}) {
  const breakpoint = useGridBreakpoint();
  const [status, setStatus] = useState('');
  const area = areaForBreakpoint(value, breakpoint);
  const set = (change: Partial<typeof area>) => {
    const next = updateGridArea(value, breakpoint, change);
    const candidate = areaForBreakpoint(next, breakpoint);
    if (maxRows && candidate.row + candidate.rowSpan - 1 > maxRows) {
      setStatus(
        `Group content must fit within ${maxRows} grid rows. The previous position was kept.`,
      );
      return;
    }
    const resolved = resolveGridArea(
      areaForBreakpoint(next, breakpoint),
      area,
      allowOverlap ? [] : occupied.map((grid) => areaForBreakpoint(grid, breakpoint)),
    );
    if (resolved.rejected) {
      setStatus('That position overlaps another element. The previous position was kept.');
      return;
    }
    setStatus('');
    onChange(updateGridArea(value, breakpoint, resolved.area));
  };

  return (
    <fieldset className="grid-placement-inspector" data-occupied-elements={occupied.length}>
      <legend>{breakpoint[0].toUpperCase() + breakpoint.slice(1)} grid position</legend>
      <p className="inspector-help">
        This position belongs only to the selected responsive view. Drag on the canvas or enter
        exact grid values. A nonzero layer permits intentional overlap.
      </p>
      {status ? (
        <p className="inspector-error" role="alert">
          {status}
        </p>
      ) : null}
      <div className="grid-placement-inspector__fields">
        <label>
          <span>Column</span>
          <input
            aria-label={`${breakpoint} column`}
            type="number"
            min="1"
            max={13 - area.columnSpan}
            value={area.column}
            onChange={(event) => set({ column: Number(event.target.value) })}
          />
        </label>
        <label>
          <span>Row</span>
          <input
            aria-label={`${breakpoint} row`}
            type="number"
            min="1"
            max={maxRows ? maxRows - area.rowSpan + 1 : 1000}
            value={area.row}
            onChange={(event) => set({ row: Number(event.target.value) })}
          />
        </label>
        <label>
          <span>Width</span>
          <input
            aria-label={`${breakpoint} width in columns`}
            type="number"
            min="1"
            max={13 - area.column}
            value={area.columnSpan}
            onChange={(event) => set({ columnSpan: Number(event.target.value) })}
          />
        </label>
        <label>
          <span>Height</span>
          <input
            aria-label={`${breakpoint} height in rows`}
            type="number"
            min="1"
            max={maxRows ? Math.min(100, maxRows - area.row + 1) : 100}
            value={area.rowSpan}
            onChange={(event) => set({ rowSpan: Number(event.target.value) })}
          />
        </label>
      </div>
    </fieldset>
  );
}
