/**
 * Git blob identities for the canonical site-kit files synchronized to protected Staging.
 * Update these values only when the matching files have been reviewed and synced there.
 */
export const STAGING_RENDERER_CONTRACT = Object.freeze({
  'SiteRenderer.tsx': 'dd8e0b0c6e627f18a7d4315639e9ebd71fd17122',
  'canonicalize.ts': '9afccffbcc207cd96787d08429fd78d705f0d84a',
  'default-site.ts': 'c5851b912b79eed62f006dd2db4f06ee74c7f65e',
  'editable-header.ts': '455c47104758edfebfb4b5facb635592c0f5ea04',
  'editable-page-hero.ts': '470e861a77388d43e815d42855398a9ea084982a',
  'grid-layout.ts': 'af68ea686fb1808b121912604b1cdd3a191e8c40',
  'linked-media.ts': 'edd07dd69ae91f4103b65cd565105701e5ce94cc',
  'migrations.ts': '66017c400016b2cd6cf8e8c75c5fa6063427a48b',
  'presets.ts': '00f8bf6df9e55c2eac6a92bb5388a32dc21563ff',
  'registry.tsx': 'c73ed4a452637af83d2b5bcdcc4bbfdbd4986070',
  'schema.ts': '38443932a06b0667a93e58c69551a4a4922c0ede',
  'site.css': 'ff525e1c742f94c6ded218d0033b12fafac524ba',
  'tokens.ts': '8ff9fdad08fa333d3e192408fd4b4a228460df94',
  'types.ts': '32d9441a49bea07132287d8e32643f977b4bb13f',
  'url-policy.ts': 'd0f49d5513bd3790764d3dc804c49c314a63daea',
  'version.ts': 'a666a7fab5937366edb73c50cb301bd737e4d568',
} satisfies Record<string, string>);

export type StagingRendererContract = Record<string, string>;
