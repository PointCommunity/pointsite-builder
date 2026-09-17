import { afterEach, expect, test, vi } from 'vitest';
import type { DraftCheckout } from '../../src/server/repositories/contracts';
import {
  clearPropertiesPreference,
  restorePropertiesPreference,
  savePropertiesPreference,
} from '../../src/client/editor/layout-preferences';

const checkout: DraftCheckout = {
  draftId: 'draft',
  actor: 'editor',
  clientId: 'tab',
  token: 'never-store-this-token',
  acquiredAt: '2026-09-17T00:00:00Z',
  lastActivityAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  event: 'resumed',
  viewState: null,
};
afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

test('restores only this user, draft and live checkout, with collapse as the default', () => {
  expect(restorePropertiesPreference(checkout)).toBe(false);
  savePropertiesPreference(checkout, true);
  expect(restorePropertiesPreference(checkout)).toBe(true);
  expect(sessionStorage.getItem('pointsite-builder-properties')).not.toContain(checkout.token);
  savePropertiesPreference(checkout, false);
  expect(restorePropertiesPreference(checkout)).toBe(false);
  for (const changed of [
    { actor: 'someone-else' },
    { draftId: 'another-draft' },
    { clientId: 'another-tab' },
    { acquiredAt: '2026-09-17T01:00:00Z' },
    { event: 'acquired' as const },
    { expiresAt: '2000-01-01T00:00:00Z' },
  ]) {
    savePropertiesPreference(checkout, true);
    expect(restorePropertiesPreference({ ...checkout, ...changed })).toBe(false);
  }
  savePropertiesPreference(checkout, true);
  clearPropertiesPreference();
  expect(restorePropertiesPreference(checkout)).toBe(false);
});

test('unavailable or invalid storage does not prevent using the editor', () => {
  sessionStorage.setItem('pointsite-builder-properties', '{');
  expect(restorePropertiesPreference(checkout)).toBe(false);
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  expect(restorePropertiesPreference(checkout)).toBe(false);
  expect(() => savePropertiesPreference(checkout, true)).not.toThrow();
  expect(clearPropertiesPreference).not.toThrow();
});
