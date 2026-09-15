/**
 * Git blob identities for the canonical site-kit files synchronized to Staging.
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
  'publication-media.ts': 'cf382d8b22fa57fbc2b9f44a381dfe0e7225c553',
  'registry.tsx': 'bdfc5336072908e146b5ebd30af88929278ee536',
  'schema.ts': 'acc61a503bfb3eed833637c1beadb3f84055d78a',
  'site.css': '4d5ae56f96899495feb7323a982882c466e3c63a',
  'tokens.ts': '8ff9fdad08fa333d3e192408fd4b4a228460df94',
  'types.ts': '32d9441a49bea07132287d8e32643f977b4bb13f',
  'url-policy.ts': 'd0f49d5513bd3790764d3dc804c49c314a63daea',
  'version.ts': '7b7f7a1edb4e8d5bf27bd59f25c9b715fd41ea03',
} satisfies Record<string, string>);

export type StagingRendererContract = Record<string, string>;

/** Reviewed reusable runtime and caller; content commits never select executable code. */
export const PUBLICATION_WORKFLOW_REVISION = '33619a5d8413e748f90cb0b8a23b3d1e7a511bf0';
export const PUBLICATION_CALLER_BLOB = '51a51f7a6991843e79b942b2788564fbae10db5f';
export const PUBLICATION_PRODUCTION_CALLER_BLOB = 'af4bcccc978a776cc55feae6dffd38235cea5d30';

/** Verification advances independently from the original deployment runtime. */
export const VERIFICATION_WORKFLOW_REVISION = '33619a5d8413e748f90cb0b8a23b3d1e7a511bf0';
export const VERIFICATION_CALLER_BLOBS = Object.freeze({
  staging: 'bc4c35667b170e3256f1a6a48d64e5ea20e62281',
  production: '0520f8a73d360e2079e118537a9d2e046286a7a2',
});

/** Reviewed native Production rollback caller, scoped to the same reusable runtime. */
export const ROLLBACK_PRODUCTION_CALLER_BLOB = 'cfbab4f165f4ca6647ad7e890e09073018cb231b';
