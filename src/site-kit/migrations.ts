import { SiteDocumentSchema, SiteElementSchema } from './schema';
import { independentGridArea, independentResponsiveValue, legacyGridAreas } from './grid-layout';
import type { SectionBlock, SiteDocument, SiteElement } from './types';
import { RENDERER_VERSION, SCHEMA_VERSION } from './version';
import { createEditableHeaderSection, derivedUuid } from './editable-header';
import { createEditablePageHeroSection, type LegacyPageHero } from './editable-page-hero';

export class UnsupportedSchemaVersionError extends Error {
  constructor(version: unknown) {
    super(`Unsupported SiteDocument schema version: ${String(version)}`);
    this.name = 'UnsupportedSchemaVersionError';
  }
}

export interface MigrationResult {
  document: SiteDocument;
  applied: string[];
}

function readVersion(input: unknown): number {
  if (typeof input !== 'object' || input === null || !('schemaVersion' in input)) {
    throw new UnsupportedSchemaVersionError('missing');
  }
  const version = input.schemaVersion;
  if (!Number.isInteger(version)) throw new UnsupportedSchemaVersionError(version);
  return version as number;
}

function migrateZeroToOne(input: object): unknown {
  return {
    ...input,
    schemaVersion: 1,
    rendererVersion: '1.1.0',
  };
}

export function createCompatibilitySection(element: SiteElement): SectionBlock {
  return {
    id: derivedUuid(element.id, 0xa5a5a5a5),
    type: 'section',
    name: `${element.type.replace(/([A-Z])/g, ' $1')} section`,
    layout: 'compatibility',
    position: 'flow',
    columns: 1,
    gap: 'none',
    width: 'full',
    surface: 'transparent',
    padding: 'none',
    minRows: 1,
    backgroundPosition: 'center',
    overlay: 'none',
    items: [
      {
        id: derivedUuid(element.id, 0x5a5a5a5a),
        span: 12,
        align: independentResponsiveValue('stretch'),
        grid: independentGridArea({ column: 1, row: 1, columnSpan: 12, rowSpan: 1 }),
        element,
      },
    ],
  };
}

function migrateOneToTwo(input: object): unknown {
  const legacy = input as { pages?: Array<Record<string, unknown>> };
  return {
    ...input,
    schemaVersion: 2,
    rendererVersion: '2.0.0',
    pages: (legacy.pages ?? []).map((page) => ({
      ...page,
      blocks: ((page.blocks as unknown[]) ?? []).map((block) =>
        createCompatibilitySection(SiteElementSchema.parse(block)),
      ),
    })),
  };
}

function migrateTwoToThree(input: object): unknown {
  const legacy = input as { pages?: Array<Record<string, unknown>> };
  return {
    ...input,
    schemaVersion: 3,
    rendererVersion: '3.0.0',
    pages: (legacy.pages ?? []).map((page) => ({
      ...page,
      blocks: ((page.blocks as Array<Record<string, unknown>>) ?? []).map((block) => {
        const items = (block.items as Array<Record<string, unknown>>) ?? [];
        const gridAreas = legacyGridAreas({
          layout: block.layout as SectionBlock['layout'],
          columns: block.columns as SectionBlock['columns'],
          items: items.map((item) => ({
            span: Number(item.span),
            element: SiteElementSchema.parse(item.element),
          })),
        });
        return {
          ...block,
          ...(block.layout === 'grid' ? { columns: 12 } : {}),
          items: items.map((item, index) => ({ ...item, grid: gridAreas[index] })),
        };
      }),
    })),
  };
}

function migrateThreeToFour(input: object): unknown {
  const legacy = input as { pages?: Array<Record<string, unknown>> };
  return {
    ...input,
    schemaVersion: 4,
    rendererVersion: '4.0.0',
    pages: (legacy.pages ?? []).map((page) => ({
      ...page,
      blocks: ((page.blocks as Array<Record<string, unknown>>) ?? []).map((section) => {
        const items = (section.items as Array<Record<string, unknown>>) ?? [];
        const occupiedRows = items.reduce((rows, item) => {
          const desktop = (
            item.grid as { desktop?: { row?: number; rowSpan?: number } } | undefined
          )?.desktop;
          return Math.max(rows, (desktop?.row ?? 1) + (desktop?.rowSpan ?? 1) - 1);
        }, 1);
        return {
          ...section,
          minRows: section.layout === 'grid' ? Math.min(100, occupiedRows) : 1,
          backgroundPosition: 'center',
          overlay: 'none',
        };
      }),
    })),
  };
}

function migrateFourToFive(input: object): unknown {
  const legacy = input as {
    forms?: Array<Record<string, unknown> & { fields?: Array<Record<string, unknown>> }>;
  };
  return {
    ...input,
    schemaVersion: 5,
    rendererVersion: '5.0.0',
    linkedMedia: [],
    forms: (legacy.forms ?? []).map((form) => ({
      ...form,
      layout: 'two-column',
      density: 'comfortable',
      fields: (form.fields ?? []).map((field) => ({ ...field, width: 'half' })),
    })),
  };
}

function migrateFiveToSix(input: object): unknown {
  const legacy = input as { pages?: Array<Record<string, unknown>> };
  return {
    ...input,
    schemaVersion: 6,
    rendererVersion: '6.0.0',
    pages: (legacy.pages ?? []).map((page) => ({ ...page, showHeader: true })),
  };
}

function migrateSixToSeven(input: object): unknown {
  const legacy = input as {
    media?: Array<{ id?: string; sourcePath?: string }>;
    pages?: Array<Record<string, unknown>>;
  };
  const logoMediaId = legacy.media?.find((item) =>
    item.sourcePath?.endsWith('/point-logo.png'),
  )?.id;
  return {
    ...input,
    schemaVersion: 7,
    rendererVersion: '7.0.0',
    pages: (legacy.pages ?? []).map((page) => {
      const { showHeader = true, ...nextPage } = page;
      const blocks = ((page.blocks as Array<Record<string, unknown>>) ?? []).map((section) => ({
        ...section,
        position: 'flow',
      }));
      const isHome = page.template === 'home' || page.route === '/';
      return {
        ...nextPage,
        blocks: showHeader
          ? [
              createEditableHeaderSection(
                String(page.id),
                logoMediaId,
                isHome ? 'overlay' : 'flow',
              ),
              ...blocks,
            ]
          : blocks,
      };
    }),
  };
}

function migrateSevenToEight(input: object): unknown {
  const legacy = input as { pages?: Array<Record<string, unknown>> };
  return {
    ...input,
    schemaVersion: 8,
    rendererVersion: '8.0.0',
    pages: (legacy.pages ?? []).map((page) => {
      const { eyebrow, intro, heroMediaId, ...nextPage } = page;
      const isHome = page.template === 'home' || page.route === '/';
      const blocks = ((page.blocks as Array<Record<string, unknown>>) ?? []) as SectionBlock[];
      if (isHome) return { ...nextPage, blocks };
      const hero = createEditablePageHeroSection({
        id: String(page.id),
        title: String(page.title),
        ...(typeof eyebrow === 'string' && eyebrow ? { eyebrow } : {}),
        ...(typeof intro === 'string' && intro ? { intro } : {}),
        ...(typeof heroMediaId === 'string' && heroMediaId ? { heroMediaId } : {}),
      } satisfies LegacyPageHero);
      return { ...nextPage, blocks: [hero, ...blocks] };
    }),
  };
}

function migrateEightToNine(input: object): unknown {
  const legacy = input as { pages?: Array<Record<string, unknown>> };
  const responsiveWidth = (value: unknown) => {
    if (typeof value === 'number') return independentResponsiveValue(value);
    if (value && typeof value === 'object') {
      const widths = value as Partial<Record<'desktop' | 'tablet' | 'mobile', number>>;
      const desktop = widths.desktop ?? 100;
      return {
        desktop,
        tablet: widths.tablet ?? desktop,
        mobile: widths.mobile ?? desktop,
      };
    }
    return independentResponsiveValue(100);
  };
  return {
    ...input,
    schemaVersion: SCHEMA_VERSION,
    rendererVersion: RENDERER_VERSION,
    pages: (legacy.pages ?? []).map((page) => ({
      ...page,
      blocks: ((page.blocks as Array<Record<string, unknown>>) ?? []).map((section) => ({
        ...section,
        items: ((section.items as Array<Record<string, unknown>>) ?? []).map((item) => {
          const grid = item.grid as
            | {
                desktop?: { column: number; row: number; columnSpan: number; rowSpan: number };
                tablet?: { column: number; row: number; columnSpan: number; rowSpan: number };
                mobile?: { column: number; row: number; columnSpan: number; rowSpan: number };
              }
            | undefined;
          const desktop = grid?.desktop ?? { column: 1, row: 1, columnSpan: 12, rowSpan: 1 };
          const rawAlign = item.align;
          const align =
            rawAlign && typeof rawAlign === 'object'
              ? {
                  desktop: (rawAlign as Record<string, unknown>).desktop ?? 'stretch',
                  tablet:
                    (rawAlign as Record<string, unknown>).tablet ??
                    (rawAlign as Record<string, unknown>).desktop ??
                    'stretch',
                  mobile:
                    (rawAlign as Record<string, unknown>).mobile ??
                    (rawAlign as Record<string, unknown>).desktop ??
                    'stretch',
                }
              : independentResponsiveValue(rawAlign ?? 'stretch');
          const element = item.element as Record<string, unknown> | undefined;
          return {
            ...item,
            align,
            grid: {
              desktop: { ...desktop },
              tablet: { ...(grid?.tablet ?? desktop) },
              mobile: { ...(grid?.mobile ?? desktop) },
            },
            ...(element?.type === 'hero'
              ? {
                  element: {
                    ...element,
                    headingWidth: responsiveWidth(element.headingWidth),
                    bodyWidth: responsiveWidth(element.bodyWidth),
                  },
                }
              : {}),
          };
        }),
      })),
    })),
  };
}

export function migrateDocument(input: unknown): MigrationResult {
  const version = readVersion(input);

  if (version > SCHEMA_VERSION || version < 0) {
    throw new UnsupportedSchemaVersionError(version);
  }

  let current = input as object;
  const applied: string[] = [];
  let currentVersion = version;
  const apply = (targetVersion: number, migration: (value: object) => unknown) => {
    if (currentVersion !== targetVersion - 1) return;
    current = migration(current) as object;
    applied.push(`${currentVersion}-to-${targetVersion}`);
    currentVersion = targetVersion;
  };

  apply(1, migrateZeroToOne);
  apply(2, migrateOneToTwo);
  apply(3, migrateTwoToThree);
  apply(4, migrateThreeToFour);
  apply(5, migrateFourToFive);
  apply(6, migrateFiveToSix);
  apply(7, migrateSixToSeven);
  apply(8, migrateSevenToEight);
  apply(9, migrateEightToNine);

  return { document: SiteDocumentSchema.parse(current), applied };
}
