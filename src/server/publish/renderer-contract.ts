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
  'migrations.ts': 'f67602881ca31f628905b2eb78decd4cfc9a44f8',
  'presets.ts': '00f8bf6df9e55c2eac6a92bb5388a32dc21563ff',
  'publication-media.ts': '5ddefb7d934e45bc32606cf0699822c5ba4e48fc',
  'registry.tsx': 'fcf40b3bbc6f2de92982042372e3c382aeccc7cc',
  'schema.ts': '949499943fa4a7a83319adce709cb449e7d0e36f',
  'site.css': '4d5ae56f96899495feb7323a982882c466e3c63a',
  'tokens.ts': '8ff9fdad08fa333d3e192408fd4b4a228460df94',
  'types.ts': '32d9441a49bea07132287d8e32643f977b4bb13f',
  'url-policy.ts': 'd0f49d5513bd3790764d3dc804c49c314a63daea',
  'version.ts': '224173cba56b1f21cffb68bcf1740396688173a6',
} satisfies Record<string, string>);

export type StagingRendererContract = Record<string, string>;

/** Reviewed reusable runtime and caller; content commits never select executable code. */
export const PUBLICATION_WORKFLOW_REVISION = '8e0a568e21cf00518cc0e8754c7ce692e83b4461';
export const PUBLICATION_CALLER_BLOB = 'f0a3672db712c4e760031474a7dfd5f521afc160';
export const PUBLICATION_PRODUCTION_CALLER_BLOB = 'b87145b067100414413f7e197bb1fb65f6592535';

/** Verification advances independently from the original deployment runtime. */
export const VERIFICATION_WORKFLOW_REVISION = '8e0a568e21cf00518cc0e8754c7ce692e83b4461';
export const VERIFICATION_CALLER_BLOBS = Object.freeze({
  staging: '8ba6ae27aae2cc726fe518273689bf97e66e9203',
  production: '0cc1629a37e6355e5e259eee082f0ca619a1aeec',
});

/** Reviewed native Production rollback caller, scoped to the same reusable runtime. */
export const ROLLBACK_PRODUCTION_CALLER_BLOB = 'bbdafab6268b63e80bc9caf84232f3c120c02595';
