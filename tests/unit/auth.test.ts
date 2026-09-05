// @vitest-environment node

import { createLocalJWKSet } from 'jose';
import { accessTokenFixture } from '../fixtures/access-tokens';
import {
  AccessVerifier,
  AuthenticationError,
  authenticateRequest,
} from '../../src/server/auth/access';
import { AuthorizationError, requireRole } from '../../src/server/auth/roles';
import { parseConfig } from '../../src/server/config';

const config = parseConfig({
  ENVIRONMENT: 'preview',
  APP_VERSION: 'test',
  ACCESS_TEAM_DOMAIN: 'point.cloudflareaccess.com',
  ACCESS_AUD: 'builder-audience',
  PRODUCTION_ENABLED: 'false',
});

describe('Cloudflare Access authentication', () => {
  it('rejects missing, forged, expired, wrong-issuer, and wrong-audience assertions', async () => {
    const fixture = await accessTokenFixture();
    const verifier = new AccessVerifier(config, createLocalJWKSet(fixture.jwks));
    const request = (token?: string) =>
      new Request('https://builder.pointatx.org/api/me', {
        headers: token ? { 'Cf-Access-Jwt-Assertion': token } : {},
      });

    await expect(verifier.verify(request())).rejects.toBeInstanceOf(AuthenticationError);
    await expect(verifier.verify(request('not-a-token'))).rejects.toBeInstanceOf(
      AuthenticationError,
    );
    await expect(
      verifier.verify(request(await fixture.sign({ expiresIn: -60 }))),
    ).rejects.toBeInstanceOf(AuthenticationError);
    await expect(
      verifier.verify(request(await fixture.sign({ issuer: 'https://evil.example' }))),
    ).rejects.toBeInstanceOf(AuthenticationError);
    await expect(
      verifier.verify(request(await fixture.sign({ audience: 'wrong-audience' }))),
    ).rejects.toBeInstanceOf(AuthenticationError);
  });

  it('normalizes verified email and resolves an active server-side role', async () => {
    const fixture = await accessTokenFixture();
    const verifier = new AccessVerifier(config, createLocalJWKSet(fixture.jwks));
    const token = await fixture.sign({ email: 'Editor@PointATX.org' });
    const actor = await authenticateRequest(
      new Request('https://builder.pointatx.org/api/me', {
        headers: { 'Cf-Access-Jwt-Assertion': token },
      }),
      config,
      {
        getRole: (email) =>
          Promise.resolve(
            email === 'editor@pointatx.org' ? { role: 'editor', active: true } : null,
          ),
      },
      verifier,
    );
    expect(actor).toEqual({ email: 'editor@pointatx.org', role: 'editor' });
  });

  it('denies missing and inactive application roles', async () => {
    const fixture = await accessTokenFixture();
    const verifier = new AccessVerifier(config, createLocalJWKSet(fixture.jwks));
    const token = await fixture.sign();
    const request = new Request('https://builder.pointatx.org/api/me', {
      headers: { 'Cf-Access-Jwt-Assertion': token },
    });
    await expect(
      authenticateRequest(request, config, { getRole: () => Promise.resolve(null) }, verifier),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      authenticateRequest(
        request,
        config,
        { getRole: () => Promise.resolve({ role: 'editor', active: false }) },
        verifier,
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('enforces the role matrix independently from client controls', () => {
    expect(() => requireRole({ email: 'viewer@pointatx.org', role: 'viewer' }, 'editor')).toThrow(
      AuthorizationError,
    );
    expect(requireRole({ email: 'publisher@pointatx.org', role: 'publisher' }, 'editor')).toEqual({
      email: 'publisher@pointatx.org',
      role: 'publisher',
    });
    expect(
      requireRole({ email: 'admin@pointatx.org', role: 'administrator' }, 'publisher'),
    ).toEqual({ email: 'admin@pointatx.org', role: 'administrator' });
  });

  it('allows development identity only on local loopback and never in production config', async () => {
    const local = parseConfig({
      ENVIRONMENT: 'local',
      APP_VERSION: 'test',
      DEV_AUTH_EMAIL: 'local@pointatx.org',
      ACCESS_TEAM_DOMAIN: 'point.cloudflareaccess.com',
      ACCESS_AUD: 'builder-audience',
      PRODUCTION_ENABLED: 'false',
    });
    const actor = await authenticateRequest(new Request('http://127.0.0.1:4173/api/me'), local, {
      getRole: () => Promise.resolve({ role: 'administrator', active: true }),
    });
    expect(actor.email).toBe('local@pointatx.org');
    await expect(
      authenticateRequest(new Request('https://builder.pointatx.org/api/me'), local, {
        getRole: () => Promise.resolve({ role: 'administrator', active: true }),
      }),
    ).rejects.toBeInstanceOf(AuthenticationError);
    expect(() =>
      parseConfig({
        ENVIRONMENT: 'production',
        APP_VERSION: 'test',
        DEV_AUTH_EMAIL: 'local@pointatx.org',
        ACCESS_TEAM_DOMAIN: 'point.cloudflareaccess.com',
        ACCESS_AUD: 'builder-audience',
        PRODUCTION_ENABLED: 'false',
      }),
    ).toThrow(/development identity/i);
  });
});
