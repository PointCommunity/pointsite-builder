import { describe, expect, it } from 'vitest';
import { availableRoute } from '../../src/client/editor/PageManager';

describe('page management', () => {
  it('creates canonical, unique routes without technical input', () => {
    expect(availableRoute('Plan Your Visit!', ['/plan-your-visit'])).toBe('/plan-your-visit-2');
    expect(availableRoute('Niños & Families', [])).toBe('/ninos-families');
    expect(availableRoute('', ['/page', '/page-2'])).toBe('/page-3');
  });
});
