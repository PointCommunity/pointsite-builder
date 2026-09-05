import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import {
  POINTSITE_CLOUDFLARE_ACCOUNT_ID,
  POINTSITE_CLOUDFLARE_EMAIL,
  validatePointSiteCloudflareIdentity,
} from '../../scripts/verify-cloudflare-account';

describe('PointSite Cloudflare account guard', () => {
  const expectedIdentity = {
    loggedIn: true,
    email: POINTSITE_CLOUDFLARE_EMAIL,
    accounts: [{ id: POINTSITE_CLOUDFLARE_ACCOUNT_ID, name: 'PointSite' }],
  };

  it('accepts the authenticated PointSite church account', () => {
    expect(validatePointSiteCloudflareIdentity(expectedIdentity)).toEqual({
      accountId: POINTSITE_CLOUDFLARE_ACCOUNT_ID,
      email: POINTSITE_CLOUDFLARE_EMAIL,
    });
  });

  it('rejects a personal or otherwise different account', () => {
    expect(() =>
      validatePointSiteCloudflareIdentity({
        ...expectedIdentity,
        email: 'personal@example.com',
        accounts: [{ id: 'personal-account-id', name: 'Personal' }],
      }),
    ).toThrow(/PointSite Cloudflare account mismatch/);
  });

  it('rejects the right email when the PointSite account membership is absent', () => {
    expect(() =>
      validatePointSiteCloudflareIdentity({
        ...expectedIdentity,
        accounts: [{ id: 'personal-account-id', name: 'Personal' }],
      }),
    ).toThrow(/PointSite Cloudflare account mismatch/);
  });

  it('rejects unauthenticated and malformed responses', () => {
    expect(() => validatePointSiteCloudflareIdentity({ loggedIn: false })).toThrow(
      /not authenticated/,
    );
    expect(() => validatePointSiteCloudflareIdentity('unexpected')).toThrow(/invalid response/);
  });

  it('pins the account and disables every workers.dev route in deployment config', async () => {
    const config = await readFile('wrangler.jsonc', 'utf8');
    expect(config).toContain(`"account_id": "${POINTSITE_CLOUDFLARE_ACCOUNT_ID}"`);
    expect(config).toContain('"workers_dev": false');
    expect(config).toContain('"preview_urls": false');
    expect(config).toContain('"pattern": "builder.pointatx.org"');
    expect(config).toContain('"custom_domain": true');
    expect(config).toContain('"d1_databases"');
    expect(config).not.toMatch(/r2_buckets|cloudflareaccess|ACCESS_AUD|ACCESS_TEAM_DOMAIN/i);
  });
});
