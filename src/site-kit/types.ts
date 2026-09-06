import type { z } from 'zod';
import type {
  SectionBlockSchema,
  SiteBlockSchema,
  SiteDocumentSchema,
  SiteElementSchema,
} from './schema';

export type SiteBlock = z.infer<typeof SiteBlockSchema>;
export type SiteElement = z.infer<typeof SiteElementSchema>;
export type SectionBlock = z.infer<typeof SectionBlockSchema>;
export type ElementPlacement = SectionBlock['items'][number];
export type SiteDocument = z.infer<typeof SiteDocumentSchema>;
export type PageDocument = SiteDocument['pages'][number];
export type ThemeDocument = SiteDocument['theme'];
export type NavigationEntry = SiteDocument['navigation'][number];
