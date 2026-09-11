/**
 * Git blob identities for the canonical site-kit files synchronized to protected Staging.
 * Update these values only when the matching files have been reviewed and synced there.
 */
export const STAGING_RENDERER_CONTRACT = Object.freeze({
  'SiteRenderer.tsx': 'dd8e0b0c6e627f18a7d4315639e9ebd71fd17122',
  'canonicalize.ts': '9afccffbcc207cd96787d08429fd78d705f0d84a',
  'default-site.ts': 'b026cf208f96f5fe8282d5add4b4f9eb868c9cda',
  'editable-header.ts': 'a620209ae74ddea5babb34b63ad320c2df313d0f',
  'editable-page-hero.ts': '083f6dd3a9fc3321792579fc0da69b534c96dce5',
  'grid-layout.ts': 'f20b698d9803a60be65ba9d6bb954a3cc86d5bae',
  'linked-media.ts': 'edd07dd69ae91f4103b65cd565105701e5ce94cc',
  'migrations.ts': 'a69f786b8e7533d19e6d19a170f96cd49a9f4a66',
  'presets.ts': '00f8bf6df9e55c2eac6a92bb5388a32dc21563ff',
  'registry.tsx': 'a3f70045894ec6cc724ea60335297a581f7080f3',
  'schema.ts': 'dc2b58e51e2f1220cfa81ce668443f9c2be8c269',
  'site.css': 'b1e4f0baea2d6032580150980c899d2b64c9203b',
  'tokens.ts': '8ff9fdad08fa333d3e192408fd4b4a228460df94',
  'types.ts': '32d9441a49bea07132287d8e32643f977b4bb13f',
  'url-policy.ts': 'd0f49d5513bd3790764d3dc804c49c314a63daea',
  'version.ts': '7b7f7a1edb4e8d5bf27bd59f25c9b715fd41ea03',
} satisfies Record<string, string>);

export type StagingRendererContract = Record<string, string>;
