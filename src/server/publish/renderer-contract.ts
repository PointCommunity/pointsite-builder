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
  'registry.tsx': 'a3f70045894ec6cc724ea60335297a581f7080f3',
  'schema.ts': 'dc2b58e51e2f1220cfa81ce668443f9c2be8c269',
  'site.css': '8642d939d731e99ca8927d46b83fd9ae4be2ac18',
  'tokens.ts': '8ff9fdad08fa333d3e192408fd4b4a228460df94',
  'types.ts': '32d9441a49bea07132287d8e32643f977b4bb13f',
  'url-policy.ts': 'd0f49d5513bd3790764d3dc804c49c314a63daea',
  'version.ts': '7b7f7a1edb4e8d5bf27bd59f25c9b715fd41ea03',
} satisfies Record<string, string>);

export type StagingRendererContract = Record<string, string>;

/** Reviewed reusable runtime and caller; content commits never select executable code. */
export const PUBLICATION_WORKFLOW_REVISION = 'bed2916eb4ab7c3ebfd56a951a43b40cbd2b0081';
export const PUBLICATION_CALLER_BLOB = 'd1957e6261429d002da23d3359885151f69d22d8';
export const PUBLICATION_PRODUCTION_CALLER_BLOB = 'ca91be0a8c0ae67c8c0e4633bf2c90c9ffe35286';

/** Verification advances independently from the original deployment runtime. */
export const VERIFICATION_WORKFLOW_REVISION = 'e1ef2ae8369ff699550b04794c1955339d5e96de';
export const VERIFICATION_CALLER_BLOBS = Object.freeze({
  staging: '6aa66fbf8cc686a38ae57ac6f5e450ff466d24cd',
  production: '4ae1253337307dd610353fbd886bc6135ddd39fa',
});

/** Reviewed native Production rollback caller, scoped to the same reusable runtime. */
export const ROLLBACK_PRODUCTION_CALLER_BLOB = '83d166b34f9a1be139b0778a3b606b85cd44f99f';
