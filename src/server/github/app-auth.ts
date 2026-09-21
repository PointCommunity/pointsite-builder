import { importPKCS8, SignJWT } from 'jose';
import { z } from 'zod';
import type { PublicationRepository } from '../publish/destinations';

const TokenResponse = z.object({ token: z.string().min(20), expires_at: z.string() });

export function unboundFetch(fetcher: typeof fetch): typeof fetch {
  return (input, init) => fetcher(input, init);
}

export async function createInstallationToken(input: {
  appId: string;
  installationId: string;
  privateKey: string;
  fetcher?: typeof fetch;
  repository?: PublicationRepository;
  readOnly?: boolean;
  cancelActions?: boolean;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  const key = await importPKCS8(input.privateKey.replaceAll('\\n', '\n'), 'RS256');
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(input.appId)
    .setIssuedAt(now - 30)
    .setExpirationTime(now + 540)
    .sign(key);
  const response = await (input.fetcher ?? fetch)(
    `https://api.github.com/app/installations/${encodeURIComponent(input.installationId)}/access_tokens`,
    {
      method: 'POST',
      headers: { ...githubHeaders(jwt), 'content-type': 'application/json' },
      ...(input.repository
        ? {
            body: JSON.stringify({
              repositories: [input.repository],
              permissions: {
                contents: input.readOnly || input.cancelActions ? 'read' : 'write',
                ...(input.cancelActions ? { actions: 'write' } : {}),
                checks: 'read',
                metadata: 'read',
              },
            }),
          }
        : {}),
    },
  );
  if (!response.ok) throw new Error(`GitHub App token exchange failed (${response.status})`);
  return TokenResponse.parse(await response.json()).token;
}

export function githubHeaders(token: string): HeadersInit {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
    'user-agent': 'PointSite-Builder',
  };
}

/** Check the current account ID and repository permission, never a cached user role. */
export async function createPublisherToken(input: {
  appId: string;
  installationId: string;
  privateKey: string;
  repository: PublicationRepository;
  subject: string;
  login: string;
  fetcher?: typeof fetch;
  cancelActions?: boolean;
}): Promise<string> {
  try {
    z.string()
      .regex(/^github:[1-9][0-9]*$/)
      .parse(input.subject);
    z.string()
      .regex(/^[A-Za-z0-9-]{1,39}$/)
      .parse(input.login);
    const token = await createInstallationToken(input);
    const response = await (input.fetcher ?? fetch)(
      `https://api.github.com/repos/PointCommunity/${input.repository}/collaborators/${encodeURIComponent(input.login)}/permission`,
      { headers: githubHeaders(token), redirect: 'error', signal: AbortSignal.timeout(10_000) },
    );
    if (!response.ok) throw new Error('Permission unavailable');
    const permission = z
      .object({
        permission: z.enum(['admin', 'maintain', 'write']),
        user: z.object({ id: z.number().int().positive() }),
      })
      .parse(await response.json());
    if (`github:${permission.user.id}` !== input.subject) throw new Error('Account changed');
    return token;
  } catch {
    throw new Error('PUBLISH_GITHUB_AUTHORITY_CHANGED');
  }
}
