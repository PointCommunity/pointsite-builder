import type { ThemeDocument } from './types';

export interface ThemePreset {
  id: string;
  name: string;
  description: string;
  theme: ThemeDocument;
}

export const themePresets: readonly ThemePreset[] = [
  {
    id: 'point-classic',
    name: 'Point Classic',
    description: 'The familiar warm, grounded Point Community Church look.',
    theme: {
      preset: 'point-classic',
      colors: {
        canvas: '#ffffff',
        surface: '#f3f1eb',
        text: '#171a17',
        mutedText: '#60665e',
        primary: '#3e522c',
        onPrimary: '#ffffff',
        border: '#d9d9d2',
      },
      headingFont: 'sans',
      bodyFont: 'sans',
      spacingDensity: 'comfortable',
      radius: 'square',
      buttonStyle: 'solid',
      surfaceStyle: 'warm',
    },
  },
  {
    id: 'open-modern',
    name: 'Open Modern',
    description: 'A bright, spacious system with clean typography and rounded details.',
    theme: {
      preset: 'open-modern',
      colors: {
        canvas: '#f7f9fc',
        surface: '#ffffff',
        text: '#162033',
        mutedText: '#4b586e',
        primary: '#2456a6',
        onPrimary: '#ffffff',
        border: '#c7d0df',
      },
      headingFont: 'sans',
      bodyFont: 'humanist',
      spacingDensity: 'spacious',
      radius: 'rounded',
      buttonStyle: 'pill',
      surfaceStyle: 'clean',
    },
  },
  {
    id: 'evening-bold',
    name: 'Evening Bold',
    description: 'A high-contrast dark canvas for a complete visual overhaul.',
    theme: {
      preset: 'evening-bold',
      colors: {
        canvas: '#11151c',
        surface: '#1b2430',
        text: '#f5f7fa',
        mutedText: '#bcc7d5',
        primary: '#d79a34',
        onPrimary: '#211600',
        border: '#465366',
      },
      headingFont: 'display',
      bodyFont: 'sans',
      spacingDensity: 'comfortable',
      radius: 'square',
      buttonStyle: 'outline',
      surfaceStyle: 'bold',
    },
  },
] as const;
