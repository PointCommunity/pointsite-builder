// @vitest-environment node

import {
  AuthenticationError,
  GitHubAuthenticator,
  GitHubSessionCodec,
  authenticateRequest,
  type GitHubIdentityGateway,
} from '../../src/server/auth/github';
import { AuthorizationError, requireRole } from '../../src/server/auth/roles';
import { parseConfig } from '../../src/server/config';

const github = {
  appId: '12345',
  installationId: '67890',
  privateKey: 'private-key-placeholder'.repeat(10),
  clientId: 'Iv1.pointsite',
  clientSecret: 'github-client-secret-placeholder',
  sessionSecret: 'session-secret-at-least-thirty-two-characters',
  repository: 'PointCommunity/pointsite-staging' as const,
  builderOrigin: 'https://builder.pointatx.org',
};

const config = parseConfig({
  ENVIRONMENT: 'preview',
  APP_VERSION: 'test',
  BUILDER_ORIGIN: github.builderOrigin,
  STAGING_REPOSITORY: github.repository,
  GITHUB_APP_ID: github.appId,
  GITHUB_STAGING_INSTALLATION_ID: github.installationId,
  GITHUB_APP_PRIVATE_KEY: github.privateKey,
  GITHUB_CLIENT_ID: github.clientId,
  GITHUB_CLIENT_SECRET: github.clientSecret,
  SESSION_SECRET: github.sessionSecret,
  PRODUCTION_ENABLED: 'false',
});

const identity = { id: 1_202_831, login: 'brimdor' };

function gateway(collaborator = true): GitHubIdentityGateway {
  return {
    authorizationUrl: ({ state, codeChallenge }) =>
      new URL(
        `https://github.com/login/oauth/authorize?client_id=Iv1.pointsite&state=${state}&code_challenge=${codeChallenge}`,
      ),
    exchangeCode: () => Promise.resolve(identity),
    isCollaborator: () => Promise.resolve(collaborator),
  };
}

describe('GitHub collaborator authentication', () => {
  it('rejects missing, forged, and expired sessions', async () => {
    const codec = new GitHubSessionCodec(github.sessionSecret);
    const authenticator = new GitHubAuthenticator(github, gateway(), codec);
    const request = (cookie?: string) =>
      new Request('https://builder.pointatx.org/api/me', {
        headers: cookie ? { cookie: `__Secure-pointsite_builder_session=${cookie}` } : {},
      });

    await expect(authenticator.verifySession(request())).rejects.toBeInstanceOf(
      AuthenticationError,
    );
    await expect(authenticator.verifySession(request('forged.payload'))).rejects.toBeInstanceOf(
      AuthenticationError,
    );
    const expired = await codec.encode(identity, new Date('2026-09-05T00:00:00Z'), -1);
    await expect(
      authenticator.verifySession(request(expired), new Date('2026-09-05T00:00:01Z')),
    ).rejects.toBeInstanceOf(AuthenticationError);
  });

  it('rechecks staging collaboration and resolves an active server-side role', async () => {
    const codec = new GitHubSessionCodec(github.sessionSecret);
    const token = await codec.encode(identity, new Date('2026-09-05T00:00:00Z'));
    const authenticator = new GitHubAuthenticator(github, gateway(), codec);
    const actor = await authenticateRequest(
      new Request('https://builder.pointatx.org/api/me', {
        headers: { cookie: `__Secure-pointsite_builder_session=${token}` },
      }),
      config,
      {
        getRole: (subject) =>
          Promise.resolve(subject === 'github:1202831' ? { role: 'editor', active: true } : null),
      },
      authenticator,
      new Date('2026-09-05T00:01:00Z'),
    );
    expect(actor).toEqual({
      email: 'github:1202831',
      displayName: '@brimdor',
      role: 'editor',
    });
  });

  it('denies a revoked collaborator and missing or inactive application roles', async () => {
    const codec = new GitHubSessionCodec(github.sessionSecret);
    const token = await codec.encode(identity, new Date('2026-09-05T00:00:00Z'));
    const request = new Request('https://builder.pointatx.org/api/me', {
      headers: { cookie: `__Secure-pointsite_builder_session=${token}` },
    });
    await expect(
      authenticateRequest(
        request,
        config,
        { getRole: () => Promise.resolve({ role: 'editor', active: true }) },
        new GitHubAuthenticator(github, gateway(false), codec),
        new Date('2026-09-05T00:01:00Z'),
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
    const authenticator = new GitHubAuthenticator(github, gateway(), codec);
    await expect(
      authenticateRequest(
        request,
        config,
        { getRole: () => Promise.resolve(null) },
        authenticator,
        new Date('2026-09-05T00:01:00Z'),
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      authenticateRequest(
        request,
        config,
        { getRole: () => Promise.resolve({ role: 'editor', active: false }) },
        authenticator,
        new Date('2026-09-05T00:01:00Z'),
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('enforces the role matrix independently from client controls', () => {
    expect(() => requireRole({ email: 'github:1', role: 'viewer' }, 'editor')).toThrow(
      AuthorizationError,
    );
    expect(requireRole({ email: 'github:2', role: 'publisher' }, 'editor')).toEqual({
      email: 'github:2',
      role: 'publisher',
    });
  });

  it('allows development identity only on local loopback and never in production config', async () => {
    const local = parseConfig({
      ENVIRONMENT: 'local',
      APP_VERSION: 'test',
      DEV_AUTH_EMAIL: 'local@pointatx.org',
      BUILDER_ORIGIN: 'http://127.0.0.1:4173',
      STAGING_REPOSITORY: github.repository,
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
        BUILDER_ORIGIN: github.builderOrigin,
        STAGING_REPOSITORY: github.repository,
        PRODUCTION_ENABLED: 'false',
      }),
    ).toThrow(/development identity/i);
  });
});
