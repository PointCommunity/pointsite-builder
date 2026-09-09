import { describe, expect, it } from 'vitest';
import {
  adjustHeroTextWidth,
  heroTextWidthFromDrag,
} from '../../src/client/editor/hero-text-resize';

describe('Hero text resizing', () => {
  it('converts pointer movement into a bounded percentage', () => {
    expect(heroTextWidthFromDrag(60, 100, 1_000)).toBe(70);
    expect(heroTextWidthFromDrag(60, -1_000, 1_000)).toBe(30);
    expect(heroTextWidthFromDrag(60, 1_000, 1_000)).toBe(100);
  });

  it('keeps a centered handle under the pointer while both edges move', () => {
    expect(heroTextWidthFromDrag(60, 100, 1_000, true)).toBe(80);
  });

  it('supports bounded keyboard steps', () => {
    expect(adjustHeroTextWidth(60, 'ArrowLeft')).toBe(55);
    expect(adjustHeroTextWidth(60, 'ArrowRight', true)).toBe(70);
    expect(adjustHeroTextWidth(30, 'ArrowLeft')).toBe(30);
    expect(adjustHeroTextWidth(100, 'ArrowRight')).toBe(100);
  });
});
