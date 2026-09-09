import {
  CHECKOUT_TTL_MS,
  checkoutExpiry,
  checkoutPhase,
  isGenuineActivity,
  sanitizeViewState,
} from '../../src/shared/draft-checkout';

describe('draft checkout timing and restoration', () => {
  it('uses a 30 minute lease and warns only during the final five minutes', () => {
    const now = '2026-09-08T12:00:00.000Z';
    const expiry = checkoutExpiry(now);
    expect(Date.parse(expiry) - Date.parse(now)).toBe(CHECKOUT_TTL_MS);
    expect(checkoutPhase(expiry, Date.parse(now) + 24 * 60_000)).toBe('active');
    expect(checkoutPhase(expiry, Date.parse(now) + 25 * 60_000)).toBe('warning');
    expect(checkoutPhase(expiry, Date.parse(expiry))).toBe('expired');
  });

  it('classifies only visible meaningful interaction as genuine activity', () => {
    expect(isGenuineActivity(new Event('pointerdown'))).toBe(true);
    expect(isGenuineActivity(new Event('keydown'))).toBe(true);
    expect(isGenuineActivity(new Event('pointerdown'), false)).toBe(false);
    expect(isGenuineActivity(new Event('poll'))).toBe(false);
    expect(isGenuineActivity(new Event('timer'))).toBe(false);
  });

  it('clamps invalid restored locations and bounded scroll values', () => {
    const restored = sanitizeViewState(
      {
        draftId: 'draft',
        panel: 'layout',
        pageId: 'missing',
        selectedElementId: 'gone',
        previewViewport: 'desktop',
        previewZoom: 9,
        scrollPositions: { canvas: -2, inspector: 2_000_000 },
        updatedAt: '2026-09-08T12:00:00Z',
      },
      ['home'],
      ['hero'],
    );
    expect(restored).toMatchObject({ pageId: 'home', selectedElementId: null, previewZoom: 2 });
    expect(restored.scrollPositions).toEqual({ canvas: 0, inspector: 1_000_000 });
  });
});
