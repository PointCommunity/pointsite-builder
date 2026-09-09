import type { EditorViewState } from '../server/repositories/contracts';

export const CHECKOUT_TTL_MS = 30 * 60 * 1_000;
export const CHECKOUT_WARNING_MS = 5 * 60 * 1_000;
export const CHECKOUT_POLL_MS = 4_000;

export function checkoutExpiry(now: string): string {
  return new Date(Date.parse(now) + CHECKOUT_TTL_MS).toISOString();
}

export function checkoutRemaining(expiresAt: string, now = Date.now()): number {
  return Math.max(0, Date.parse(expiresAt) - now);
}

export function checkoutPhase(
  expiresAt: string,
  now = Date.now(),
): 'active' | 'warning' | 'expired' {
  const remaining = checkoutRemaining(expiresAt, now);
  if (remaining === 0) return 'expired';
  return remaining <= CHECKOUT_WARNING_MS ? 'warning' : 'active';
}

export function isGenuineActivity(event: Pick<Event, 'type'>, visible = true): boolean {
  return (
    visible && ['pointerdown', 'keydown', 'touchstart', 'focus', 'online'].includes(event.type)
  );
}

export function sanitizeViewState(
  input: EditorViewState,
  pageIds: string[],
  elementIds: string[],
): EditorViewState {
  const pageId =
    input.pageId && pageIds.includes(input.pageId) ? input.pageId : (pageIds[0] ?? null);
  return {
    ...input,
    pageId,
    selectedElementId:
      input.selectedElementId && elementIds.includes(input.selectedElementId)
        ? input.selectedElementId
        : null,
    previewZoom: Math.min(2, Math.max(0.25, input.previewZoom)),
    scrollPositions: Object.fromEntries(
      Object.entries(input.scrollPositions)
        .slice(0, 8)
        .map(([key, value]) => [key.slice(0, 40), Math.min(1_000_000, Math.max(0, value))]),
    ),
  };
}
