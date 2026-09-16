/**
 * Git blob identities for the canonical site-kit files synchronized to Staging.
 * Update these values only when the matching files have been reviewed and synced there.
 */
export const STAGING_RENDERER_CONTRACT = Object.freeze({
  'SiteRenderer.tsx': 'dd8e0b0c6e627f18a7d4315639e9ebd71fd17122',
  'canonicalize.ts': '9afccffbcc207cd96787d08429fd78d705f0d84a',
  'default-site.ts': '87f3ba36a19a3d21c15581868c607b8ba3401e1b',
  'editable-header.ts': 'a620209ae74ddea5babb34b63ad320c2df313d0f',
  'editable-page-hero.ts': '083f6dd3a9fc3321792579fc0da69b534c96dce5',
  'grid-layout.ts': 'f20b698d9803a60be65ba9d6bb954a3cc86d5bae',
  'linked-media.ts': 'edd07dd69ae91f4103b65cd565105701e5ce94cc',
  'migrations.ts': 'aae48642293999d909f52670de539f7bc2294d4b',
  'presets.ts': '00f8bf6df9e55c2eac6a92bb5388a32dc21563ff',
  'publication-media.ts': '5ddefb7d934e45bc32606cf0699822c5ba4e48fc',
  'registry.tsx': 'fcf40b3bbc6f2de92982042372e3c382aeccc7cc',
  'schema.ts': '949499943fa4a7a83319adce709cb449e7d0e36f',
  'site.css': '4d5ae56f96899495feb7323a982882c466e3c63a',
  'tokens.ts': '8ff9fdad08fa333d3e192408fd4b4a228460df94',
  'types.ts': '32d9441a49bea07132287d8e32643f977b4bb13f',
  'url-policy.ts': 'd0f49d5513bd3790764d3dc804c49c314a63daea',
  'version.ts': 'bd5521f50a9a7d7496208d01ed4e4d34f6a5d403',
} satisfies Record<string, string>);

export type StagingRendererContract = Record<string, string>;

/** Reviewed reusable runtime and caller; content commits never select executable code. */
export const PUBLICATION_WORKFLOW_REVISION = '3789751c8725f023945b9348d7b3b43737976f81';
export const PUBLICATION_CALLER_BLOB = 'c67e5a1d6ee26becfeb1ebf1fa72513e88f6dde3';
export const PUBLICATION_PRODUCTION_CALLER_BLOB = 'cac91d1cb3dfe127c68db7087e7e4ce6f1ef30db';

/** Verification advances independently from the original deployment runtime. */
export const VERIFICATION_WORKFLOW_REVISION = '3789751c8725f023945b9348d7b3b43737976f81';
export const VERIFICATION_CALLER_BLOBS = Object.freeze({
  staging: '3d59661903a5d3ba063b6ac181948a5450d5fe5d',
  production: '72b69b4ef8165b8a6faf901ef0f6b03991b9a4b8',
});

/** Reviewed native Production rollback caller, scoped to the same reusable runtime. */
export const ROLLBACK_PRODUCTION_CALLER_BLOB = '0e3e508b499bc38147f631b98cc34901b4ffb5bd';
