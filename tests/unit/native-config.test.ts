import { expect, test } from 'vitest';
import { parseConfig } from '../../src/server/config';

const fixture = {
  RUNTIME: 'node',
  ENVIRONMENT: 'canary',
  APP_VERSION: 'fixture',
  BUILDER_ORIGIN: 'https://builder-canary.eaglepass.io',
  STAGING_REPOSITORY: 'PointCommunity/pointsite-staging',
  PRODUCTION_ENABLED: 'false',
  GITHUB_APP_ID: '1',
  GITHUB_STAGING_INSTALLATION_ID: '2',
  GITHUB_APP_PRIVATE_KEY: 'a'.repeat(100),
  GITHUB_CLIENT_ID: 'a'.repeat(8),
  GITHUB_CLIENT_SECRET: 'b'.repeat(20),
  SESSION_SECRET: 'c'.repeat(32),
};
test('native Canary requires its own origin, real sign-in and disabled public Production publishing', () => {
  expect(parseConfig(fixture).runtime).toBe('node');
  expect(() => parseConfig({ ...fixture, PRODUCTION_ENABLED: 'true' })).toThrow();
  expect(() =>
    parseConfig({ ...fixture, BUILDER_ORIGIN: 'https://builder.eaglepass.io' }),
  ).toThrow();
  expect(() => parseConfig({ ...fixture, DEV_AUTH_EMAIL: 'fixture@example.com' })).toThrow();
  expect(() => parseConfig({ ...fixture, SESSION_SECRET: undefined })).toThrow();
  const production = {
    ...fixture,
    ENVIRONMENT: 'production',
    BUILDER_ORIGIN: 'https://builder.eaglepass.io',
    PRODUCTION_ENABLED: 'true',
  };
  expect(parseConfig(production).productionEnabled).toBe(true);
  expect(() =>
    parseConfig({ ...production, BUILDER_ORIGIN: 'https://builder.pointatx.org' }),
  ).toThrow();
});
