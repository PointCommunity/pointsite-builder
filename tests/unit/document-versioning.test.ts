import { validSiteDocument } from '../fixtures/site-documents';
import { canonicalize, checksumDocument } from '../../src/site-kit/canonicalize';
import { migrateDocument, UnsupportedSchemaVersionError } from '../../src/site-kit/migrations';
import { RENDERER_VERSION, SCHEMA_VERSION } from '../../src/site-kit/version';

describe('document versioning', () => {
  const versionOneDocument = () => {
    const current = structuredClone(validSiteDocument);
    return {
      ...current,
      schemaVersion: 1,
      rendererVersion: '1.1.0',
      pages: current.pages.map((page) => ({
        ...page,
        blocks: page.blocks.map((section) => section.items[0].element),
      })),
    };
  };
  it('serializes equivalent objects to exactly one canonical representation', () => {
    const left = { z: [3, { b: true, a: 'same' }], a: 1 };
    const right = { a: 1, z: [3, { a: 'same', b: true }] };

    expect(canonicalize(left)).toBe(canonicalize(right));
    expect(canonicalize(left)).toBe('{"a":1,"z":[3,{"a":"same","b":true}]}');
  });

  it('rejects values JSON cannot represent deterministically', () => {
    expect(() => canonicalize({ value: Number.NaN })).toThrow(/finite/i);
    expect(() => canonicalize({ value: undefined })).toThrow(/unsupported/i);
  });

  it('produces the same SHA-256 checksum for equivalent documents', async () => {
    const reordered = {
      pages: validSiteDocument.pages,
      navigation: validSiteDocument.navigation,
      collections: validSiteDocument.collections,
      theme: validSiteDocument.theme,
      forms: validSiteDocument.forms,
      media: validSiteDocument.media,
      site: validSiteDocument.site,
      rendererVersion: validSiteDocument.rendererVersion,
      schemaVersion: validSiteDocument.schemaVersion,
    };

    const [left, right] = await Promise.all([
      checksumDocument(validSiteDocument),
      checksumDocument(reordered),
    ]);
    expect(left).toMatch(/^[a-f0-9]{64}$/);
    expect(left).toBe(right);
  });

  it('migrates a version-zero document exactly once', () => {
    const legacy: Record<string, unknown> = versionOneDocument();
    delete legacy.rendererVersion;
    legacy.schemaVersion = 0;

    const migrated = migrateDocument(legacy);
    expect(migrated.applied).toEqual(['0-to-1', '1-to-2', '2-to-3', '3-to-4']);
    expect(migrated.document.schemaVersion).toBe(SCHEMA_VERSION);
    expect(migrated.document.rendererVersion).toBe(RENDERER_VERSION);

    const repeated = migrateDocument(migrated.document);
    expect(repeated.applied).toEqual([]);
    expect(repeated.document).toEqual(migrated.document);
  });

  it('migrates version one into deterministic standardized sections', () => {
    const first = migrateDocument(versionOneDocument());
    const second = migrateDocument(versionOneDocument());
    expect(first.applied).toEqual(['1-to-2', '2-to-3', '3-to-4']);
    expect(first.document).toEqual(second.document);
    expect(first.document.pages[0]?.blocks[0]).toMatchObject({
      type: 'section',
      layout: 'compatibility',
      items: [{ element: { type: 'hero' } }],
    });
  });

  it('migrates version two placements into deterministic responsive grid areas', () => {
    const legacy = structuredClone(validSiteDocument) as Record<string, unknown>;
    legacy.schemaVersion = 2;
    legacy.rendererVersion = '2.0.0';
    const pages = legacy.pages as typeof validSiteDocument.pages;
    for (const page of pages) {
      for (const section of page.blocks) {
        for (const placement of section.items) delete (placement as { grid?: unknown }).grid;
      }
    }

    const first = migrateDocument(legacy);
    const second = migrateDocument(legacy);
    expect(first.applied).toEqual(['2-to-3', '3-to-4']);
    expect(first.document).toEqual(second.document);
    expect(first.document.pages[0]?.blocks[0]?.items[0]?.grid.desktop).toEqual({
      column: 1,
      row: 1,
      columnSpan: 12,
      rowSpan: 10,
    });

    const legacyGrid = legacy as unknown as {
      pages: Array<{
        blocks: Array<{ layout: 'compatibility' | 'flow' | 'grid'; columns: number }>;
      }>;
    };
    legacyGrid.pages[0].blocks[0].layout = 'grid';
    legacyGrid.pages[0].blocks[0].columns = 2;
    expect(migrateDocument(legacy).document.pages[0]?.blocks[0]?.columns).toBe(12);
  });

  it('migrates saved version three drafts without losing section content', () => {
    const legacy = structuredClone(validSiteDocument) as Record<string, unknown>;
    legacy.schemaVersion = 3;
    legacy.rendererVersion = '3.0.0';
    const pages = legacy.pages as typeof validSiteDocument.pages;
    const originalElementIds = pages.flatMap((page) =>
      page.blocks.flatMap((section) => section.items.map((item) => item.element.id)),
    );
    for (const page of pages) {
      for (const section of page.blocks) {
        const legacySection = section as unknown as Record<string, unknown>;
        delete legacySection.minRows;
        delete legacySection.backgroundPosition;
        delete legacySection.overlay;
      }
    }

    const migrated = migrateDocument(legacy);
    expect(migrated.applied).toEqual(['3-to-4']);
    expect(
      migrated.document.pages.flatMap((page) =>
        page.blocks.flatMap((section) => section.items.map((item) => item.element.id)),
      ),
    ).toEqual(originalElementIds);
    expect(migrated.document.pages[0]?.blocks[0]).toMatchObject({
      backgroundPosition: 'center',
      overlay: 'none',
    });
  });

  it('fails closed for an unknown future schema version', () => {
    const future = { ...structuredClone(validSiteDocument), schemaVersion: SCHEMA_VERSION + 1 };
    expect(() => migrateDocument(future)).toThrow(UnsupportedSchemaVersionError);
  });
});
