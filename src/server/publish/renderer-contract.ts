/**
 * Git blob identities for the canonical site-kit files synchronized to Staging.
 * Update these values only when the matching files have been reviewed and synced there.
 */
export const STAGING_RENDERER_CONTRACT = Object.freeze({
  'SiteRenderer.tsx': '48bfb695b97050cc1398538465a81a6b0ac30771',
  'canonicalize.ts': '9afccffbcc207cd96787d08429fd78d705f0d84a',
  'default-site.ts': '87f3ba36a19a3d21c15581868c607b8ba3401e1b',
  'document-sections.ts': '3d07104db635e3a2e0688dc134290c081cf4c427',
  'editable-footer.ts': 'ba1a6fe74af3db542229621d69d789a3368bf432',
  'editable-header.ts': 'a620209ae74ddea5babb34b63ad320c2df313d0f',
  'editable-page-hero.ts': '083f6dd3a9fc3321792579fc0da69b534c96dce5',
  'grid-layout.ts': '48aaeec57aac4a4e52ae46a4b5ba603dfc52c60a',
  'linked-media.ts': 'edd07dd69ae91f4103b65cd565105701e5ce94cc',
  'migrations.ts': 'aae48642293999d909f52670de539f7bc2294d4b',
  'presets.ts': '00f8bf6df9e55c2eac6a92bb5388a32dc21563ff',
  'publication-media.ts': 'cc68fd974109d23c6c285ce1ddff9c2c451b7b2a',
  'registry.tsx': '94629a28d052b3f1473660458011964f8976276a',
  'schema.ts': '6339d699c89f853bb86536e98532c1df0ab3c0a8',
  'site.css': '8f5772428689b5ffe6a9abcb6fc5bdf3c8d6217e',
  'tokens.ts': '8ff9fdad08fa333d3e192408fd4b4a228460df94',
  'types.ts': '32d9441a49bea07132287d8e32643f977b4bb13f',
  'url-policy.ts': 'd0f49d5513bd3790764d3dc804c49c314a63daea',
  'version.ts': 'd827473eb21fbc04fd7f926ded7d5084c25b30a6',
} satisfies Record<string, string>);

export type StagingRendererContract = Record<string, string>;

/** Reviewed reusable runtime and caller; content commits never select executable code. */
export const PUBLICATION_WORKFLOW_REVISION = 'cc59ebcacf12550a42fc8c45684c450a0cacfb70';
export const PUBLICATION_CALLER_BLOB = 'b15a28bf15e8a059ea4e222b65e1fb81398ca7ee';
export const PUBLICATION_PRODUCTION_CALLER_BLOB = '11ba2ee10833d28c72bcd3ef3b9f4e6b70f7c273';

/** Verification advances independently from the original deployment runtime. */
export const VERIFICATION_WORKFLOW_REVISION = '5fc43bf6909a042841f3d6d6ebea0136f70b2f54';
export const VERIFICATION_CALLER_BLOBS = Object.freeze({
  staging: '6d2961c1cdb4cec121ea785cb091f51f88b5781b',
  production: '20213ee02dca8af159408bc37656dbcf8669f320',
});

/** Reviewed native Production rollback caller, scoped to the same reusable runtime. */
export const ROLLBACK_PRODUCTION_CALLER_BLOB = '9fc5435b8652dc5759628c909472d9d2cf317199';
