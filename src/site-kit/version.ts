export const SCHEMA_VERSION = 2 as const;
export const RENDERER_VERSION = '2.0.0' as const;

export interface RendererIdentity {
  schemaVersion: typeof SCHEMA_VERSION;
  rendererVersion: typeof RENDERER_VERSION;
}

export const RENDERER_IDENTITY: RendererIdentity = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  rendererVersion: RENDERER_VERSION,
});
