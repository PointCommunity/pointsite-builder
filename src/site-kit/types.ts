import type { z } from 'zod';
import type { SiteBlockSchema, SiteDocumentSchema } from './schema';

export type SiteBlock = z.infer<typeof SiteBlockSchema>;
export type SiteDocument = z.infer<typeof SiteDocumentSchema>;
export type PageDocument = SiteDocument['pages'][number];
export type ThemeDocument = SiteDocument['theme'];
export type NavigationEntry = SiteDocument['navigation'][number];
