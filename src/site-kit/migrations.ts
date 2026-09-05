import { SiteDocumentSchema } from './schema';
import type { SiteDocument } from './types';
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
    schemaVersion: SCHEMA_VERSION,
    rendererVersion: RENDERER_VERSION,
  };
}

export function migrateDocument(input: unknown): MigrationResult {
  const version = readVersion(input);

  if (version > SCHEMA_VERSION || version < 0) {
    throw new UnsupportedSchemaVersionError(version);
  }

  if (version === 0) {
    return {
      document: SiteDocumentSchema.parse(migrateZeroToOne(input as object)),
      applied: ['0-to-1'],
    };
  }

  return { document: SiteDocumentSchema.parse(input), applied: [] };
}
