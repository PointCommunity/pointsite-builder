import { SiteDocumentSchema, SiteElementSchema } from './schema';
import { legacyGridAreas } from './grid-layout';
import type { SectionBlock, SiteDocument, SiteElement } from './types';
import { RENDERER_VERSION, SCHEMA_VERSION } from './version';

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

function derivedUuid(id: string, mask: number): string {
  const [head = '00000000', ...rest] = id.split('-');
  const changed = (Number.parseInt(head, 16) ^ mask) >>> 0;
  return [changed.toString(16).padStart(8, '0'), ...rest].join('-');
}

export function createCompatibilitySection(element: SiteElement): SectionBlock {
  return {
    id: derivedUuid(element.id, 0xa5a5a5a5),
    type: 'section',
    name: `${element.type.replace(/([A-Z])/g, ' $1')} section`,
    layout: 'compatibility',
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
        align: 'stretch',
        grid: {
          desktop: { column: 1, row: 1, columnSpan: 12, rowSpan: 1 },
        },
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
    schemaVersion: SCHEMA_VERSION,
    rendererVersion: RENDERER_VERSION,
    pages: (legacy.pages ?? []).map((page) => ({ ...page, showHeader: true })),
  };
}

export function migrateDocument(input: unknown): MigrationResult {
  const version = readVersion(input);

  if (version > SCHEMA_VERSION || version < 0) {
    throw new UnsupportedSchemaVersionError(version);
  }

  if (version === 0) {
    const versionOne = migrateZeroToOne(input as object);
    const versionTwo = migrateOneToTwo(versionOne as object);
    return {
      document: SiteDocumentSchema.parse(
        migrateFiveToSix(
          migrateFourToFive(
            migrateThreeToFour(migrateTwoToThree(versionTwo as object) as object) as object,
          ) as object,
        ),
      ),
      applied: ['0-to-1', '1-to-2', '2-to-3', '3-to-4', '4-to-5', '5-to-6'],
    };
  }

  if (version === 1)
    return {
      document: SiteDocumentSchema.parse(
        migrateFiveToSix(
          migrateFourToFive(
            migrateThreeToFour(
              migrateTwoToThree(migrateOneToTwo(input as object) as object) as object,
            ) as object,
          ) as object,
        ),
      ),
      applied: ['1-to-2', '2-to-3', '3-to-4', '4-to-5', '5-to-6'],
    };

  if (version === 2)
    return {
      document: SiteDocumentSchema.parse(
        migrateFiveToSix(
          migrateFourToFive(
            migrateThreeToFour(migrateTwoToThree(input as object) as object) as object,
          ) as object,
        ),
      ),
      applied: ['2-to-3', '3-to-4', '4-to-5', '5-to-6'],
    };

  if (version === 3)
    return {
      document: SiteDocumentSchema.parse(
        migrateFiveToSix(
          migrateFourToFive(migrateThreeToFour(input as object) as object) as object,
        ),
      ),
      applied: ['3-to-4', '4-to-5', '5-to-6'],
    };

  if (version === 4)
    return {
      document: SiteDocumentSchema.parse(
        migrateFiveToSix(migrateFourToFive(input as object) as object),
      ),
      applied: ['4-to-5', '5-to-6'],
    };

  if (version === 5)
    return {
      document: SiteDocumentSchema.parse(migrateFiveToSix(input as object)),
      applied: ['5-to-6'],
    };

  return { document: SiteDocumentSchema.parse(input), applied: [] };
}
