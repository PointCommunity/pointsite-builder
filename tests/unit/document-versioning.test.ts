import { validSiteDocument } from '../fixtures/site-documents';
import { canonicalize, checksumDocument } from '../../src/site-kit/canonicalize';
import { migrateDocument, UnsupportedSchemaVersionError } from '../../src/site-kit/migrations';
import { RENDERER_VERSION, SCHEMA_VERSION } from '../../src/site-kit/version';

describe('document versioning', () => {
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
    const legacy: Record<string, unknown> = structuredClone(validSiteDocument);
    delete legacy.rendererVersion;
    legacy.schemaVersion = 0;

    const migrated = migrateDocument(legacy);
    expect(migrated.applied).toEqual(['0-to-1']);
    expect(migrated.document.schemaVersion).toBe(SCHEMA_VERSION);
    expect(migrated.document.rendererVersion).toBe(RENDERER_VERSION);

    const repeated = migrateDocument(migrated.document);
    expect(repeated.applied).toEqual([]);
    expect(repeated.document).toEqual(migrated.document);
  });

  it('fails closed for an unknown future schema version', () => {
    const future = { ...structuredClone(validSiteDocument), schemaVersion: SCHEMA_VERSION + 1 };
    expect(() => migrateDocument(future)).toThrow(UnsupportedSchemaVersionError);
  });
});
