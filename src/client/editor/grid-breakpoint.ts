import type { GridBreakpoint } from '../../site-kit/grid-layout';

export function breakpointForWidth(width: number | '100%'): GridBreakpoint {
  if (width === '100%' || width > 900) return 'desktop';
  return width <= 520 ? 'mobile' : 'tablet';
}
