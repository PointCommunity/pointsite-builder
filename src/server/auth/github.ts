import { z } from 'zod';
import type { RuntimeConfig } from '../config';
import { createInstallationToken, githubHeaders } from '../github/app-auth';
import { AuthorizationError, type Actor, type RoleDirectory } from './roles';

const SESSION_COOKIE = '__Secure-pointsite_builder_session';
const OAUTH_COOKIE = '__Host-pointsite_builder_oauth';
const SESSION_SECONDS = 8 * 60 * 60;
const OAUTH_SECONDS = 10 * 60;

const IdentitySchema = z.strictObject({
  id: z.number().int().positive(),
  login: z.string().regex(/^[A-Za-z0-9-]{1,39}$/),
});
const SessionSchema = IdentitySchema.extend({
  kind: z.literal('session'),
  exp: z.number().int().positive(),
});
const OAuthStateSchema = z.strictObject({
  kind: z.literal('oauth'),
  state: z.string().min(20).max(100),
  verifier: z.string().min(43).max(128),
  exp: z.number().int().positive(),
});
const TokenResponseSchema = z.object({ access_token: z.string().min(20) });
const PermissionSchema = z.object({
  permission: z.enum(['admin', 'maintain', 'write', 'triage', 'read', 'none']),
  user: IdentitySchema,
});

export interface GitHubIdentity {
  id: number;
  login: string;
}

export interface GitHubAuthConfig {
  appId: string;
  installationId: string;
  privateKey: string;
  clientId: string;
  clientSecret: string;
  sessionSecret: string;
  repository: 'PointCommunity/pointsite-staging';
  builderOrigin: string;
}

export interface GitHubIdentityGateway {
  authorizationUrl(input: { state: string; codeChallenge: string; redirectUri: string }): URL;
  exchangeCode(code: string, codeVerifier: string): Promise<GitHubIdentity>;
  isCollaborator(identity: GitHubIdentity): Promise<boolean>;
}

export class AuthenticationError extends Error {
  constructor(message = 'Sign in with an approved PointCommunity GitHub account') {
    super(message);
    this.name = 'AuthenticationError';
  }
}

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64url(value: string): Uint8Array {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

class SignedTokenCodec {
  constructor(private readonly secret: string) {}

  async encode(payload: unknown): Promise<string> {
    const body = base64url(encoder.encode(JSON.stringify(payload)));
    const signature = await crypto.subtle.sign(
      'HMAC',
      await hmacKey(this.secret),
      encoder.encode(body),
    );
    return `${body}.${base64url(new Uint8Array(signature))}`;
  }

  async decode(token: string): Promise<unknown> {
    const [body, signature, extra] = token.split('.');
    if (!body || !signature || extra) throw new AuthenticationError();
    const valid = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(this.secret),
      Uint8Array.from(fromBase64url(signature)).buffer,
      encoder.encode(body),
    );
    if (!valid) throw new AuthenticationError();
    try {
      return JSON.parse(new TextDecoder().decode(fromBase64url(body))) as unknown;
    } catch {
      throw new AuthenticationError();
    }
  }
}

export class GitHubSessionCodec {
  private readonly codec: SignedTokenCodec;

  constructor(secret: string) {
    this.codec = new SignedTokenCodec(secret);
  }

  encode(identity: GitHubIdentity, now = new Date(), lifetimeSeconds = SESSION_SECONDS) {
    return this.codec.encode({
      kind: 'session',
      id: identity.id,
      login: identity.login,
      exp: Math.floor(now.getTime() / 1_000) + lifetimeSeconds,
    });
  }

  async decode(token: string, now = new Date()): Promise<GitHubIdentity> {
    const payload = SessionSchema.parse(await this.codec.decode(token));
    if (payload.exp <= Math.floor(now.getTime() / 1_000)) throw new AuthenticationError();
    return { id: payload.id, login: payload.login };
  }

  encodeOAuth(state: string, verifier: string, now = new Date()) {
    return this.codec.encode({
      kind: 'oauth',
      state,
      verifier,
      exp: Math.floor(now.getTime() / 1_000) + OAUTH_SECONDS,
    });
  }

  async decodeOAuth(token: string, now = new Date()) {
    let payload: z.infer<typeof OAuthStateSchema>;
    try {
      payload = OAuthStateSchema.parse(await this.codec.decode(token));
    } catch {
      throw new AuthenticationError('GitHub sign-in state is invalid');
    }
    if (payload.exp <= Math.floor(now.getTime() / 1_000))
      throw new AuthenticationError('GitHub sign-in expired; start again');
    return payload;
  }
}

function cookie(request: Request, name: string): string | null {
  for (const item of (request.headers.get('cookie') ?? '').split(';')) {
    const [key, ...rest] = item.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

function setCookie(name: string, value: string, maxAge: number, shared = false): string {
  const domain = shared ? ' Domain=pointatx.org;' : '';
  return `${name}=${value};${domain} Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function assertOrigin(request: Request, expected: string) {
  if (new URL(request.url).origin !== expected)
    throw new AuthenticationError('Invalid login origin');
}

export class GitHubAuthenticator {
  constructor(
    private readonly config: GitHubAuthConfig,
    private readonly gateway: GitHubIdentityGateway,
    private readonly sessions: GitHubSessionCodec,
  ) {}

  async beginLogin(request: Request): Promise<Response> {
    assertOrigin(request, this.config.builderOrigin);
    const state = randomToken();
    const verifier = randomToken();
    const challenge = base64url(
      new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier))),
    );
    const location = this.gateway.authorizationUrl({
      state,
      codeChallenge: challenge,
      redirectUri: `${this.config.builderOrigin}/auth/callback`,
    });
    return new Response(null, {
      status: 302,
      headers: {
        location: location.toString(),
        'set-cookie': setCookie(
          OAUTH_COOKIE,
          await this.sessions.encodeOAuth(state, verifier),
          OAUTH_SECONDS,
        ),
      },
    });
  }

  async completeLogin(request: Request, now = new Date()): Promise<Response> {
    assertOrigin(request, this.config.builderOrigin);
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const stateCookie = cookie(request, OAUTH_COOKIE);
    if (!code || !state || !stateCookie)
      throw new AuthenticationError('GitHub sign-in state is missing');
    const saved = await this.sessions.decodeOAuth(stateCookie, now);
    if (saved.state !== state) throw new AuthenticationError('GitHub sign-in state does not match');
    const identity = await this.gateway.exchangeCode(code, saved.verifier);
    if (!(await this.gateway.isCollaborator(identity)))
      throw new AuthorizationError('GitHub account is not an approved staging collaborator');
    const response = new Response(null, {
      status: 302,
      headers: { location: `${this.config.builderOrigin}/` },
    });
    response.headers.append(
      'set-cookie',
      setCookie(SESSION_COOKIE, await this.sessions.encode(identity, now), SESSION_SECONDS, true),
    );
    response.headers.append('set-cookie', setCookie(OAUTH_COOKIE, '', 0));
    return response;
  }

  async verifySession(request: Request, now = new Date()): Promise<GitHubIdentity> {
    assertOrigin(request, this.config.builderOrigin);
    const token = cookie(request, SESSION_COOKIE);
    if (!token) throw new AuthenticationError();
    let identity: GitHubIdentity;
    try {
      identity = await this.sessions.decode(token, now);
    } catch {
      throw new AuthenticationError();
    }
    if (!(await this.gateway.isCollaborator(identity)))
      throw new AuthorizationError('GitHub collaboration is no longer active');
    return identity;
  }

  logout(): Response {
    return new Response(null, {
      status: 303,
      headers: {
        location: `${this.config.builderOrigin}/`,
        'set-cookie': setCookie(SESSION_COOKIE, '', 0, true),
      },
    });
  }
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export class GitHubApiGateway implements GitHubIdentityGateway {
  constructor(
    private readonly config: GitHubAuthConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  authorizationUrl(input: { state: string; codeChallenge: string; redirectUri: string }): URL {
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('state', input.state);
    url.searchParams.set('code_challenge', input.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url;
  }

  async exchangeCode(code: string, codeVerifier: string): Promise<GitHubIdentity> {
    const response = await this.fetcher('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code,
        code_verifier: codeVerifier,
        redirect_uri: `${this.config.builderOrigin}/auth/callback`,
      }),
    });
    if (!response.ok) throw new AuthenticationError('GitHub sign-in exchange failed');
    let token: string;
    try {
      token = TokenResponseSchema.parse(await response.json()).access_token;
    } catch {
      throw new AuthenticationError('GitHub sign-in exchange was invalid');
    }
    const user = await this.fetcher('https://api.github.com/user', {
      headers: githubHeaders(token),
    });
    if (!user.ok) throw new AuthenticationError('GitHub identity could not be verified');
    try {
      return IdentitySchema.parse(await user.json());
    } catch {
      throw new AuthenticationError('GitHub identity response was invalid');
    }
  }

  async isCollaborator(identity: GitHubIdentity): Promise<boolean> {
    const token = await this.installationToken();
    const response = await this.fetcher(
      `https://api.github.com/repos/${this.config.repository}/collaborators/${encodeURIComponent(identity.login)}/permission`,
      { headers: githubHeaders(token) },
    );
    if (response.status === 404) return false;
    if (!response.ok) throw new AuthenticationError('GitHub collaboration could not be verified');
    let permission: z.infer<typeof PermissionSchema>;
    try {
      permission = PermissionSchema.parse(await response.json());
    } catch {
      throw new AuthenticationError('GitHub collaboration response was invalid');
    }
    return permission.permission !== 'none' && permission.user.id === identity.id;
  }

  private async installationToken(): Promise<string> {
    const key = `${this.config.appId}:${this.config.installationId}`;
    const cached = tokenCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.token;
    const token = await createInstallationToken({
      appId: this.config.appId,
      installationId: this.config.installationId,
      privateKey: this.config.privateKey,
      fetcher: this.fetcher,
    });
    tokenCache.set(key, { token, expiresAt: Date.now() + 50 * 60 * 1_000 });
    return token;
  }
}

export function createGitHubAuthenticator(config: GitHubAuthConfig, fetcher: typeof fetch = fetch) {
  return new GitHubAuthenticator(
    config,
    new GitHubApiGateway(config, fetcher),
    new GitHubSessionCodec(config.sessionSecret),
  );
}

function isLoopback(request: Request): boolean {
  const hostname = new URL(request.url).hostname;
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

export async function authenticateRequest(
  request: Request,
  config: RuntimeConfig,
  roles: RoleDirectory,
  authenticator?: GitHubAuthenticator,
  now = new Date(),
): Promise<Actor> {
  if (config.environment === 'local' && config.devAuthEmail && isLoopback(request)) {
    const role = await roles.getRole(config.devAuthEmail);
    if (!role?.active)
      throw new AuthorizationError('Your identity does not have an active builder role');
    return { email: config.devAuthEmail, displayName: config.devAuthEmail, role: role.role };
  }
  if (!config.github) throw new AuthenticationError();
  const identity = await (authenticator ?? createGitHubAuthenticator(config.github)).verifySession(
    request,
    now,
  );
  const subject = `github:${identity.id}`;
  const role = await roles.getRole(subject);
  if (!role?.active)
    throw new AuthorizationError('Your identity does not have an active builder role');
  return { email: subject, displayName: `@${identity.login}`, role: role.role };
}
