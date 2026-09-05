import { describe, expect, it } from 'vitest';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import { themePresets } from '../../src/site-kit/presets';
import { SiteDocumentSchema } from '../../src/site-kit/schema';

describe('theme presets', () => {
  it('provides valid current, overhaul, and dark options', () => {
    expect(themePresets.map((preset) => preset.id)).toEqual([
      'point-classic',
      'open-modern',
      'evening-bold',
    ]);
    for (const preset of themePresets)
      expect(
        SiteDocumentSchema.safeParse({ ...defaultSiteDocument, theme: preset.theme }).success,
      ).toBe(true);
  });
});
