import { areaForBreakpoint, updateGridArea } from '../../site-kit/grid-layout';
import type { ElementPlacement } from '../../site-kit/types';
import { useGridBreakpoint } from './GridBreakpointContext';

export function GridPlacementInspector({
  value,
  onChange,
}: {
  value: ElementPlacement['grid'];
  onChange: (value: ElementPlacement['grid']) => void;
}) {
  const breakpoint = useGridBreakpoint();
  const area = areaForBreakpoint(value, breakpoint);
  const inherited = breakpoint !== 'desktop' && !value[breakpoint];
  const set = (change: Partial<typeof area>) => onChange(updateGridArea(value, breakpoint, change));

  return (
    <fieldset className="grid-placement-inspector">
      <legend>{breakpoint[0].toUpperCase() + breakpoint.slice(1)} grid position</legend>
      <p className="inspector-help">
        {inherited
          ? `Inheriting the desktop position. Changing a value creates a ${breakpoint} override.`
          : 'Drag on the canvas or enter exact grid values.'}
      </p>
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
            max="1000"
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
            max="100"
            value={area.rowSpan}
            onChange={(event) => set({ rowSpan: Number(event.target.value) })}
          />
        </label>
      </div>
      {breakpoint !== 'desktop' && value[breakpoint] ? (
        <button
          className="button button--compact"
          type="button"
          onClick={() => {
            const next = { ...value };
            delete next[breakpoint];
            onChange(next);
          }}
        >
          Reset to desktop
        </button>
      ) : null}
    </fieldset>
  );
}
