import type { DraftCheckout } from '../../server/repositories/contracts';

const key = 'pointsite-builder-properties';
const identity = (checkout: DraftCheckout) =>
  JSON.stringify([checkout.actor, checkout.draftId, checkout.clientId, checkout.acquiredAt]);

export function clearPropertiesPreference() {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // Storage restrictions must not prevent editing or check-in.
  }
}

export function restorePropertiesPreference(checkout: DraftCheckout | null): boolean {
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (
      !checkout ||
      checkout.event !== 'resumed' ||
      !(Date.parse(checkout.expiresAt) > Date.now()) ||
      typeof stored !== 'object' ||
      stored === null ||
      !('checkout' in stored) ||
      stored.checkout !== identity(checkout)
    ) {
      clearPropertiesPreference();
      return false;
    }
    return 'open' in stored && stored.open === true;
  } catch {
    return false;
  }
}

export function savePropertiesPreference(checkout: DraftCheckout, open: boolean) {
  try {
    sessionStorage.setItem(key, JSON.stringify({ checkout: identity(checkout), open }));
  } catch {
    // The current view still works when session storage is unavailable.
  }
}
