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
  'registry.tsx': '9b1911bb215d8416fa6d66878d368d9630631559',
  'schema.ts': '949499943fa4a7a83319adce709cb449e7d0e36f',
  'site.css': 'db7e1d854345e12662426a0040f9bcc1718af09d',
  'tokens.ts': '8ff9fdad08fa333d3e192408fd4b4a228460df94',
  'types.ts': '32d9441a49bea07132287d8e32643f977b4bb13f',
  'url-policy.ts': 'd0f49d5513bd3790764d3dc804c49c314a63daea',
  'version.ts': 'bd5521f50a9a7d7496208d01ed4e4d34f6a5d403',
} satisfies Record<string, string>);

export type StagingRendererContract = Record<string, string>;

/** Reviewed reusable runtime and caller; content commits never select executable code. */
export const PUBLICATION_WORKFLOW_REVISION = '52b24585b6dc5e555bbbee250bcb3362f49576b4';
export const PUBLICATION_CALLER_BLOB = '77b533d609a8d9765ece046df6207a081ce0afb5';
export const PUBLICATION_PRODUCTION_CALLER_BLOB = 'bd838872ed21e5653f0c6172b8e014e019028ca8';

/** Verification advances independently from the original deployment runtime. */
export const VERIFICATION_WORKFLOW_REVISION = '5fc43bf6909a042841f3d6d6ebea0136f70b2f54';
export const VERIFICATION_CALLER_BLOBS = Object.freeze({
  staging: '6d2961c1cdb4cec121ea785cb091f51f88b5781b',
  production: '20213ee02dca8af159408bc37656dbcf8669f320',
});

/** Reviewed native Production rollback caller, scoped to the same reusable runtime. */
export const ROLLBACK_PRODUCTION_CALLER_BLOB = 'b062f365ee973c30e50bbd625bdae4e4dab98029';
