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
  'grid-layout.ts': 'cdabc2509916356e14bf1f4931577e500fb1a292',
  'linked-media.ts': 'edd07dd69ae91f4103b65cd565105701e5ce94cc',
  'migrations.ts': '42db65f0ed20468504a6a1b7e4458c797cdae636',
  'presets.ts': '00f8bf6df9e55c2eac6a92bb5388a32dc21563ff',
  'publication-media.ts': 'cc68fd974109d23c6c285ce1ddff9c2c451b7b2a',
  'registry.tsx': 'd7836e79e69e1e2a08a4a324e65e506a43985c8b',
  'schema.ts': '13e0885b1045ec3a35fff79523a85ee9383cce12',
  'site.css': '37fd2c17db45b53c68adb19bb08d0d61e95e988d',
  'tokens.ts': '8ff9fdad08fa333d3e192408fd4b4a228460df94',
  'types.ts': '32d9441a49bea07132287d8e32643f977b4bb13f',
  'url-policy.ts': 'd0f49d5513bd3790764d3dc804c49c314a63daea',
  'version.ts': '39cf2cf28d0761367dde026b9716d5deac475be5',
} satisfies Record<string, string>);

export type StagingRendererContract = Record<string, string>;

/** Reviewed reusable runtime and caller; content commits never select executable code. */
export const PUBLICATION_WORKFLOW_REVISION = '0524bc8f58acbd8ca875e8a797f58cc1f83d99d9';
export const PUBLICATION_CALLER_BLOB = '52c6866fa99d07db0a887ff9a0562bf17a6f673f';
export const PUBLICATION_PRODUCTION_CALLER_BLOB = 'd56ee502a7c91d1640c46fbf403f41bf5ec08c5a';

/** Verification advances independently from the original deployment runtime. */
export const VERIFICATION_WORKFLOW_REVISION = '5fc43bf6909a042841f3d6d6ebea0136f70b2f54';
export const VERIFICATION_CALLER_BLOBS = Object.freeze({
  staging: '6d2961c1cdb4cec121ea785cb091f51f88b5781b',
  production: '20213ee02dca8af159408bc37656dbcf8669f320',
});

/** Reviewed native Production rollback caller, scoped to the same reusable runtime. */
export const ROLLBACK_PRODUCTION_CALLER_BLOB = '7db46f0117af6e8f27794deb525c765fbad4144e';
