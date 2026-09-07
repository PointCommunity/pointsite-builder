export const SCHEMA_VERSION = 6 as const;
export const RENDERER_VERSION = '6.0.0' as const;

export interface RendererIdentity {
  schemaVersion: typeof SCHEMA_VERSION;
  rendererVersion: typeof RENDERER_VERSION;
}

export const RENDERER_IDENTITY: RendererIdentity = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  rendererVersion: RENDERER_VERSION,
});
