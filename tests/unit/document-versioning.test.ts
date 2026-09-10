import { validSiteDocument } from '../fixtures/site-documents';
import { canonicalize, checksumDocument } from '../../src/site-kit/canonicalize';
import { migrateDocument, UnsupportedSchemaVersionError } from '../../src/site-kit/migrations';
import { RENDERER_VERSION, SCHEMA_VERSION } from '../../src/site-kit/version';

describe('document versioning', () => {
  const versionSixDocument = () => {
    const legacy = structuredClone(validSiteDocument) as unknown as Record<string, unknown>;
    legacy.schemaVersion = 6;
    legacy.rendererVersion = '6.0.0';
    const pages = legacy.pages as Array<Record<string, unknown>>;
    for (const page of pages) {
      page.showHeader = true;
      page.blocks = (page.blocks as Array<Record<string, unknown>>).map((section) => {
        const legacySection = { ...section };
        delete legacySection.position;
        return legacySection;
      });
    }
    return legacy;
  };
  const versionSevenStandardPageDocument = () => {
    const legacy = structuredClone(validSiteDocument) as unknown as Record<string, unknown>;
    legacy.schemaVersion = 7;
    legacy.rendererVersion = '7.0.0';
    const pages = legacy.pages as Array<Record<string, unknown>>;
    const page = pages[0];
    if (!page) throw new Error('Expected a legacy page');
    page.title = 'Who We Are';
    page.route = '/who-we-are';
    page.template = 'standard';
    page.eyebrow = 'About Point';
    page.intro = 'We are a family of disciples on mission.';
    page.heroMediaId = validSiteDocument.media[0].id;
    return legacy;
  };
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
      linkedMedia: validSiteDocument.linkedMedia,
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
    expect(migrated.applied).toEqual([
      '0-to-1',
      '1-to-2',
      '2-to-3',
      '3-to-4',
      '4-to-5',
      '5-to-6',
      '6-to-7',
      '7-to-8',
      '8-to-9',
    ]);
    expect(migrated.document.schemaVersion).toBe(SCHEMA_VERSION);
    expect(migrated.document.rendererVersion).toBe(RENDERER_VERSION);

    const repeated = migrateDocument(migrated.document);
    expect(repeated.applied).toEqual([]);
    expect(repeated.document).toEqual(migrated.document);
  });

  it('migrates version one into deterministic standardized sections', () => {
    const first = migrateDocument(versionOneDocument());
    const second = migrateDocument(versionOneDocument());
    expect(first.applied).toEqual([
      '1-to-2',
      '2-to-3',
      '3-to-4',
      '4-to-5',
      '5-to-6',
      '6-to-7',
      '7-to-8',
      '8-to-9',
    ]);
    expect(first.document).toEqual(second.document);
    expect(first.document.pages[0]?.blocks[1]).toMatchObject({
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
    expect(first.applied).toEqual([
      '2-to-3',
      '3-to-4',
      '4-to-5',
      '5-to-6',
      '6-to-7',
      '7-to-8',
      '8-to-9',
    ]);
    expect(first.document).toEqual(second.document);
    expect(first.document.pages[0]?.blocks[1]?.items[0]?.grid.desktop).toEqual({
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
    expect(migrated.applied).toEqual(['3-to-4', '4-to-5', '5-to-6', '6-to-7', '7-to-8', '8-to-9']);
    expect(
      migrated.document.pages.flatMap((page) =>
        page.blocks.slice(1).flatMap((section) => section.items.map((item) => item.element.id)),
      ),
    ).toEqual(originalElementIds);
    expect(migrated.document.pages[0]?.blocks[1]).toMatchObject({
      backgroundPosition: 'center',
      overlay: 'none',
    });
  });

  it('migrates saved version four forms to parity-preserving v5 defaults', () => {
    const legacy = structuredClone(validSiteDocument) as unknown as Record<string, unknown>;
    legacy.schemaVersion = 4;
    legacy.rendererVersion = '4.0.0';
    delete legacy.linkedMedia;
    const forms = legacy.forms as Array<Record<string, unknown>>;
    delete forms[0].layout;
    delete forms[0].density;
    const fields = forms[0].fields as Array<Record<string, unknown>>;
    delete fields[0].width;

    const migrated = migrateDocument(legacy);
    expect(migrated.applied).toEqual(['4-to-5', '5-to-6', '6-to-7', '7-to-8', '8-to-9']);
    expect(migrated.document.linkedMedia).toEqual([]);
    expect(migrated.document.forms[0]).toMatchObject({
      layout: 'two-column',
      density: 'comfortable',
      fields: [{ width: 'half' }],
    });
  });

  it('migrates version five pages with the built-in header visible', () => {
    const legacy = structuredClone(validSiteDocument) as unknown as Record<string, unknown>;
    legacy.schemaVersion = 5;
    legacy.rendererVersion = '5.0.0';
    const pages = legacy.pages as Array<Record<string, unknown>>;
    for (const page of pages) delete page.showHeader;

    const migrated = migrateDocument(legacy);
    expect(migrated.applied).toEqual(['5-to-6', '6-to-7', '7-to-8', '8-to-9']);
    const migratedPage = migrated.document.pages[0];
    expect(migratedPage).not.toHaveProperty('showHeader');
    expect(migratedPage?.blocks[0]).toMatchObject({
      name: 'Site header',
      layout: 'grid',
      position: 'overlay',
      items: [
        { element: { type: 'image', mediaId: validSiteDocument.media[0].id } },
        { element: { type: 'navigation' } },
      ],
    });
    expect(migratedPage?.blocks.slice(1)).toEqual(
      validSiteDocument.pages[0]?.blocks.map((section) => ({ ...section, position: 'flow' })),
    );
  });

  it('turns a version six built-in header into deterministic editable grid content', () => {
    const legacy = versionSixDocument();

    const first = migrateDocument(legacy);
    const second = migrateDocument(legacy);

    expect(first.applied).toEqual(['6-to-7', '7-to-8', '8-to-9']);
    expect(first.document).toEqual(second.document);
    expect(first.document.pages[0]?.blocks[0]?.items.map((item) => item.element.type)).toEqual([
      'image',
      'navigation',
    ]);
    expect(first.document.pages[0]?.blocks[0]?.items[1]?.grid).toMatchObject({
      desktop: { column: 5, columnSpan: 8 },
      mobile: { column: 1, columnSpan: 12 },
    });
  });

  it('does not inject an editable header where the version six header was disabled', () => {
    const legacy = versionSixDocument();
    const pages = legacy.pages as Array<Record<string, unknown>>;
    pages[0].showHeader = false;

    const migrated = migrateDocument(legacy);

    expect(migrated.document.pages[0]?.blocks).toEqual(
      validSiteDocument.pages[0]?.blocks.map((section) => ({ ...section, position: 'flow' })),
    );
  });

  it('turns version seven page chrome into one deterministic existing Hero element', () => {
    const legacy = versionSevenStandardPageDocument();
    const originalBlocks = structuredClone(
      (legacy.pages as Array<{ blocks: unknown[] }>)[0]?.blocks ?? [],
    );

    const first = migrateDocument(legacy);
    const second = migrateDocument(versionSevenStandardPageDocument());
    const page = first.document.pages[0];

    expect(first.applied).toEqual(['7-to-8', '8-to-9']);
    expect(first.document).toEqual(second.document);
    expect(page).not.toHaveProperty('eyebrow');
    expect(page).not.toHaveProperty('intro');
    expect(page).not.toHaveProperty('heroMediaId');
    expect(page?.blocks[0]).toMatchObject({
      name: 'Page hero',
      layout: 'compatibility',
      position: 'flow',
      items: [
        {
          element: {
            type: 'hero',
            variant: 'pageHero',
            eyebrow: 'About Point',
            heading: 'Who We Are',
            body: 'We are a family of disciples on mission.',
            mediaId: validSiteDocument.media[0].id,
            align: 'left',
            surface: 'image',
            actions: [],
          },
        },
      ],
    });
    expect(page?.blocks.slice(1)).toEqual(originalBlocks);

    const repeated = migrateDocument(first.document);
    expect(repeated.applied).toEqual([]);
    expect(repeated.document).toEqual(first.document);
  });

  it('migrates version eight geometry into explicit independent responsive values', () => {
    const legacy = structuredClone(validSiteDocument) as unknown as Record<string, unknown>;
    legacy.schemaVersion = 8;
    legacy.rendererVersion = '8.0.0';
    const pages = legacy.pages as Array<{
      blocks: Array<{ items: Array<Record<string, unknown>> }>;
    }>;
    const item = pages[0]?.blocks[0]?.items[0];
    if (!item) throw new Error('Expected a version eight placement');
    item.align = 'end';
    item.grid = {
      desktop: { column: 2, row: 3, columnSpan: 7, rowSpan: 5 },
      tablet: { column: 3, row: 4, columnSpan: 8, rowSpan: 6 },
    };
    item.element = {
      ...(item.element as Record<string, unknown>),
      headingWidth: 72,
      bodyWidth: 58,
    };

    const migrated = migrateDocument(legacy);
    const migratedItem = migrated.document.pages[0]?.blocks[0]?.items[0];
    const hero = migratedItem?.element;

    expect(migrated.applied).toEqual(['8-to-9']);
    expect(migratedItem?.grid).toEqual({
      desktop: { column: 2, row: 3, columnSpan: 7, rowSpan: 5 },
      tablet: { column: 3, row: 4, columnSpan: 8, rowSpan: 6 },
      mobile: { column: 2, row: 3, columnSpan: 7, rowSpan: 5 },
    });
    expect(migratedItem?.align).toEqual({ desktop: 'end', tablet: 'end', mobile: 'end' });
    expect(hero).toMatchObject({
      type: 'hero',
      headingWidth: { desktop: 72, tablet: 72, mobile: 72 },
      bodyWidth: { desktop: 58, tablet: 58, mobile: 58 },
    });
    expect(migrateDocument(migrated.document)).toEqual({
      document: migrated.document,
      applied: [],
    });
  });

  it('fails closed for an unknown future schema version', () => {
    const future = { ...structuredClone(validSiteDocument), schemaVersion: SCHEMA_VERSION + 1 };
    expect(() => migrateDocument(future)).toThrow(UnsupportedSchemaVersionError);
  });
});
