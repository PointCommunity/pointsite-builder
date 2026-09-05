import type { CSSProperties } from 'react';
import type { ThemeDocument } from './types';

export type SiteTokenStyle = CSSProperties & Record<`--${string}`, string>;

const spacingScale = {
  compact: ['0.75rem', '1.5rem', '3rem'],
  comfortable: ['1rem', '2rem', '4.5rem'],
  spacious: ['1.25rem', '2.75rem', '6rem'],
} as const;

const radii = { square: '0', soft: '0.5rem', rounded: '1.25rem' } as const;

export function themeToTokens(theme: ThemeDocument): SiteTokenStyle {
  const [spaceSmall, spaceMedium, spaceLarge] = spacingScale[theme.spacingDensity];
  return {
    '--point-canvas': theme.colors.canvas,
    '--point-surface': theme.colors.surface,
    '--point-text': theme.colors.text,
    '--point-muted': theme.colors.mutedText,
    '--point-primary': theme.colors.primary,
    '--point-on-primary': theme.colors.onPrimary,
    '--point-border': theme.colors.border,
    '--point-space-small': spaceSmall,
    '--point-space-medium': spaceMedium,
    '--point-space-large': spaceLarge,
    '--point-radius': theme.buttonStyle === 'pill' ? '999px' : radii[theme.radius],
    '--point-heading-font':
      theme.headingFont === 'serif' ? 'Georgia, serif' : 'Inter, system-ui, sans-serif',
    '--point-body-font': 'Inter, system-ui, sans-serif',
    '--paper': theme.colors.canvas,
    '--soft': theme.colors.surface,
    '--ink': theme.colors.text,
    '--muted': theme.colors.mutedText,
    '--green': theme.colors.primary,
    '--green-deep': theme.preset === 'point-classic' ? '#29381f' : theme.colors.primary,
    '--line': theme.colors.border,
    '--font-sans':
      theme.headingFont === 'serif'
        ? "'Point Libre Baskerville', Georgia, serif"
        : "'Point Lato', Arial, sans-serif",
    '--font-serif':
      theme.bodyFont === 'humanist'
        ? "'Point Lato', Arial, sans-serif"
        : "'Point Libre Baskerville', Georgia, serif",
  };
}
