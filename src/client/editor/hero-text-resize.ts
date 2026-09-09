export const HERO_TEXT_MIN_WIDTH = 30;
export const HERO_TEXT_MAX_WIDTH = 100;
export const HERO_TEXT_KEYBOARD_STEP = 5;
export const HERO_TEXT_KEYBOARD_LARGE_STEP = 10;

export function clampHeroTextWidth(width: number): number {
  return Math.max(HERO_TEXT_MIN_WIDTH, Math.min(HERO_TEXT_MAX_WIDTH, Math.round(width)));
}

export function heroTextWidthFromDrag(
  startWidth: number,
  deltaPixels: number,
  containerWidth: number,
  centered = false,
): number {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0)
    return clampHeroTextWidth(startWidth);
  const alignmentFactor = centered ? 2 : 1;
  return clampHeroTextWidth(startWidth + (deltaPixels / containerWidth) * 100 * alignmentFactor);
}

export function adjustHeroTextWidth(
  width: number,
  key: 'ArrowLeft' | 'ArrowRight',
  largeStep = false,
): number {
  const step = largeStep ? HERO_TEXT_KEYBOARD_LARGE_STEP : HERO_TEXT_KEYBOARD_STEP;
  return clampHeroTextWidth(width + (key === 'ArrowRight' ? step : -step));
}
