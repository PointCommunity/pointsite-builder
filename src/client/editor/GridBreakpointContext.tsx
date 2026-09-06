import { useSyncExternalStore } from 'react';
import type { GridBreakpoint } from '../../site-kit/grid-layout';

let activeBreakpoint: GridBreakpoint = 'desktop';
const listeners = new Set<() => void>();

export function setGridBreakpoint(value: GridBreakpoint) {
  if (value === activeBreakpoint) return;
  activeBreakpoint = value;
  for (const listener of listeners) listener();
}

export function useGridBreakpoint(): GridBreakpoint {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => activeBreakpoint,
    () => 'desktop',
  );
}
