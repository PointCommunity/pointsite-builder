// @vitest-environment node

import {
  GitHubApiGateway,
  GitHubAuthenticator,
  GitHubSessionCodec,
  type GitHubIdentityGateway,
} from '../../src/server/auth/github';
import { exportPKCS8, generateKeyPair } from 'jose';
import { createHmac } from 'node:crypto';

const config = {
  appId: '12345',
  installationId: '67890',
  privateKey: 'private-key-placeholder'.repeat(10),
  clientId: 'Iv1.pointsite',
  clientSecret: 'github-client-secret-placeholder',
  sessionSecret: 'session-secret-at-least-thirty-two-characters',
  repository: 'PointCommunity/pointsite-staging' as const,
  builderOrigin: 'https://builder.pointatx.org',
};

it('uses state and PKCE, then issues a secure HttpOnly session after collaborator verification', async () => {
  let observedState = '';
  let observedVerifier = '';
  const gateway: GitHubIdentityGateway = {
    authorizationUrl: ({ state, codeChallenge, redirectUri }) => {
      observedState = state;
      expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(redirectUri).toBe('https://builder.pointatx.org/auth/callback');
      return new URL(`https://github.com/login/oauth/authorize?state=${state}`);
    },
    exchangeCode: (code, codeVerifier) => {
      expect(code).toBe('temporary-code');
      observedVerifier = codeVerifier;
      return Promise.resolve({ id: 1_202_831, login: 'brimdor' });
    },
    repositoryPermission: () => Promise.resolve('write'),
  };
  const authenticator = new GitHubAuthenticator(
    config,
    gateway,
    new GitHubSessionCodec(config.sessionSecret),
  );

  const login = await authenticator.beginLogin(
    new Request('https://builder.pointatx.org/auth/login'),
  );
  expect(login.status).toBe(302);
  expect(login.headers.get('location')).toContain('github.com/login/oauth/authorize');
  const stateCookie = login.headers.getSetCookie()[0] ?? '';
  expect(stateCookie).toContain('__Host-pointsite_builder_oauth=');
  expect(stateCookie).toContain('HttpOnly');
  expect(stateCookie).toContain('Secure');
  expect(stateCookie).toContain('SameSite=Lax');
  expect(stateCookie).not.toContain('Domain=');

  const callback = await authenticator.completeLogin(
    new Request(
      `https://builder.pointatx.org/auth/callback?code=temporary-code&state=${observedState}`,
      { headers: { cookie: stateCookie.split(';')[0] ?? '' } },
    ),
  );
  expect(observedVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(callback.status).toBe(302);
  expect(callback.headers.get('location')).toBe('https://builder.pointatx.org/');
  const sessionCookie = callback.headers.getSetCookie()[0];
  expect(sessionCookie).toContain('__Host-pointsite_builder_session=');
  expect(sessionCookie).not.toContain('Domain=');
  expect(sessionCookie).toContain('Path=/; Max-Age=28800; HttpOnly; Secure; SameSite=Lax');
  for (const response of [login, callback, authenticator.logout()])
    expect(response.headers.getSetCookie()).toContain(
      '__Secure-pointsite_builder_session=; Domain=pointatx.org; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax',
    );
  expect(authenticator.logout().headers.getSetCookie()[0]).toContain(
    '__Host-pointsite_builder_session=; Path=/; Max-Age=0;',
  );
});

it('rejects a retired shared session even when replayed in the host-only cookie', async () => {
  const codec = new GitHubSessionCodec(config.sessionSecret);
  const payload = Buffer.from(
    JSON.stringify({
      kind: 'session',
      id: 1202831,
      login: 'brimdor',
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toString('base64url');
  const token = `${payload}.${createHmac('sha256', config.sessionSecret).update(payload).digest('base64url')}`;
  const repositoryPermission = vi.fn().mockResolvedValue('write');
  const authenticator = new GitHubAuthenticator(
    config,
    {
      authorizationUrl: () => new URL('https://github.com/login/oauth/authorize'),
      exchangeCode: () => Promise.resolve({ id: 1202831, login: 'brimdor' }),
      repositoryPermission,
    },
    codec,
  );
  for (const name of ['__Secure-pointsite_builder_session', '__Host-pointsite_builder_session'])
    await expect(
      authenticator.verifySession(
        new Request('https://builder.pointatx.org/api/me', {
          headers: { cookie: `${name}=${token}` },
        }),
      ),
    ).rejects.toThrow();
  expect(repositoryPermission).not.toHaveBeenCalled();
});

it('fails closed when OAuth state is invalid', async () => {
  const gateway: GitHubIdentityGateway = {
    authorizationUrl: ({ state }) =>
      new URL(`https://github.com/login/oauth/authorize?state=${state}`),
    exchangeCode: () => Promise.resolve({ id: 404, login: 'outsider' }),
    repositoryPermission: () => Promise.resolve(null),
  };
  const authenticator = new GitHubAuthenticator(
    config,
    gateway,
    new GitHubSessionCodec(config.sessionSecret),
  );
  const login = await authenticator.beginLogin(
    new Request('https://builder.pointatx.org/auth/login'),
  );
  const stateCookie = login.headers.get('set-cookie') ?? '';

  await expect(
    authenticator.completeLogin(
      new Request('https://builder.pointatx.org/auth/callback?code=x&state=wrong', {
        headers: { cookie: stateCookie.split(';')[0] ?? '' },
      }),
    ),
  ).rejects.toThrow(/state/i);
});

it('exchanges the OAuth code without broad scopes and validates the stable collaborator ID', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const fetcher: typeof fetch = function (this: unknown, input, init) {
    expect(this).toBeUndefined();
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requests.push({ url, init });
    if (url.endsWith('/login/oauth/access_token'))
      return Promise.resolve(Response.json({ access_token: 'github-user-token-value' }));
    if (url === 'https://api.github.com/user')
      return Promise.resolve(
        Response.json({
          id: 1_202_831,
          login: 'brimdor',
          node_id: 'MDQ6VXNlcjEyMDI4MzE=',
          avatar_url: 'https://avatars.githubusercontent.com/u/1202831',
        }),
      );
    if (url.includes('/access_tokens'))
      return Promise.resolve(
        Response.json({
          token: 'github-installation-token-value',
          expires_at: '2026-09-05T12:00:00Z',
          permissions: { contents: 'write', metadata: 'read' },
          repository_selection: 'selected',
        }),
      );
    if (url.includes('/collaborators/brimdor/permission'))
      return Promise.resolve(
        Response.json({
          permission: 'admin',
          role_name: 'admin',
          user: {
            id: 1_202_831,
            login: 'brimdor',
            node_id: 'MDQ6VXNlcjEyMDI4MzE=',
            avatar_url: 'https://avatars.githubusercontent.com/u/1202831',
          },
        }),
      );
    return Promise.resolve(new Response('unexpected', { status: 500 }));
  };
  const gateway = new GitHubApiGateway(
    { ...config, privateKey: await exportPKCS8(privateKey) },
    fetcher,
  );
  const account = await gateway.exchangeCode('temporary', 'pkce-verifier');
  expect(account).toEqual({ id: 1_202_831, login: 'brimdor' });
  expect(await gateway.isCollaborator(account)).toBe(true);
  expect(await gateway.repositoryPermission(account)).toBe('admin');
  const rawBody = requests[0]?.init?.body;
  expect(typeof rawBody).toBe('string');
  const exchangeBody = JSON.parse(rawBody as string) as Record<string, unknown>;
  expect(exchangeBody).toMatchObject({ code: 'temporary', code_verifier: 'pkce-verifier' });
  expect(exchangeBody).not.toHaveProperty('scope');
  expect(requests.some((item) => item.url.includes('PointCommunity/pointsite-staging'))).toBe(true);
});
