// @vitest-environment node

import {
  GitHubApiGateway,
  GitHubAuthenticator,
  GitHubSessionCodec,
  type GitHubIdentityGateway,
} from '../../src/server/auth/github';
import { exportPKCS8, generateKeyPair } from 'jose';

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
    isCollaborator: () => Promise.resolve(true),
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
  const stateCookie = login.headers.get('set-cookie') ?? '';
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
  expect(callback.headers.get('set-cookie')).toContain('__Secure-pointsite_builder_session=');
  expect(callback.headers.get('set-cookie')).toContain('Domain=pointatx.org');
});

it('fails closed when OAuth state is invalid', async () => {
  const gateway: GitHubIdentityGateway = {
    authorizationUrl: ({ state }) =>
      new URL(`https://github.com/login/oauth/authorize?state=${state}`),
    exchangeCode: () => Promise.resolve({ id: 404, login: 'outsider' }),
    isCollaborator: () => Promise.resolve(false),
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
  const rawBody = requests[0]?.init?.body;
  expect(typeof rawBody).toBe('string');
  const exchangeBody = JSON.parse(rawBody as string) as Record<string, unknown>;
  expect(exchangeBody).toMatchObject({ code: 'temporary', code_verifier: 'pkce-verifier' });
  expect(exchangeBody).not.toHaveProperty('scope');
  expect(requests.some((item) => item.url.includes('PointCommunity/pointsite-staging'))).toBe(true);
});
