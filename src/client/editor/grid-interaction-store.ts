import { useSyncExternalStore } from 'react';

let activeSectionId: string | null = null;
const listeners = new Set<() => void>();

export function setActiveGridSection(sectionId: string | null) {
  if (sectionId === activeSectionId) return;
  activeSectionId = sectionId;
  for (const listener of listeners) listener();
}

export function useGridInteraction(sectionId?: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => Boolean(sectionId && sectionId === activeSectionId),
    () => false,
  );
}
