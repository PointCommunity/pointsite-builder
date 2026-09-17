export const SCHEMA_VERSION = 10 as const;
export const RENDERER_VERSION = '10.0.0' as const;
// The retained compatibility release can also read and edit this contract.
export const MAX_SUPPORTED_SCHEMA_VERSION = 11 as const;

export function supportsRenderer(identity: {
  schemaVersion: number;
  rendererVersion: string;
}): boolean {
  return (
    (identity.schemaVersion === 9 && identity.rendererVersion === '9.0.0') ||
    (identity.schemaVersion === 10 && identity.rendererVersion === '10.0.0') ||
    (identity.schemaVersion === 11 && identity.rendererVersion === '11.0.0')
  );
}

export interface RendererIdentity {
  schemaVersion: typeof SCHEMA_VERSION;
  rendererVersion: typeof RENDERER_VERSION;
}

export const RENDERER_IDENTITY: RendererIdentity = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  rendererVersion: RENDERER_VERSION,
});
