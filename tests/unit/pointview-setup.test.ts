// @vitest-environment node
import { validateRegistration } from '../../scripts/pointview-setup';

const source = {
  slug: 'pointsite-builder',
  display_name: 'PointSite Builder',
  github_owner: 'PointCommunity',
  github_repo: 'pointsite-builder',
  github_project_node_id: 'PVT_kwDOE0xBLs4Bivi-',
  github_project_number: 1,
  github_installation_id: 1,
  allowed_origins: ['https://builder.pointatx.org'],
  return_url_prefixes: ['https://builder.pointatx.org/'],
  governed_labels: ['type:bug', 'type:feature', 'type:maintenance', 'type:security', 'area:ui'],
  public_keys: [
    {
      kid: 'test-key',
      jwk: { kty: 'OKP', crv: 'Ed25519', x: 'a'.repeat(43) },
      not_before: new Date(Date.now() - 60000).toISOString(),
      not_after: new Date(Date.now() + 86400000).toISOString(),
    },
  ],
};
describe('PointView setup checks', () => {
  it('accepts only the exact Builder mapping and matching active public key', () => {
    expect(validateRegistration(source, 'test-key', 'a'.repeat(43)).slug).toBe('pointsite-builder');
    for (const input of [
      { ...source, github_repo: 'pointsite' },
      { ...source, github_project_number: 4 },
      { ...source, allowed_origins: ['https://evil.example'] },
      {
        ...source,
        public_keys: [
          { ...source.public_keys[0], jwk: { ...source.public_keys[0].jwk, d: 'private' } },
        ],
      },
      {
        ...source,
        public_keys: [
          { ...source.public_keys[0], not_after: new Date(Date.now() - 1000).toISOString() },
        ],
      },
      { ...source, governed_labels: ['area:ui'] },
    ])
      expect(() => validateRegistration(input, 'test-key', 'a'.repeat(43))).toThrow();
    expect(() => validateRegistration(source, 'other-key', 'a'.repeat(43))).toThrow();
  });
});
