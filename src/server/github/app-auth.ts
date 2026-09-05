import { importPKCS8, SignJWT } from 'jose';
import { z } from 'zod';

const TokenResponse = z.object({ token: z.string().min(20), expires_at: z.string() });

export function unboundFetch(fetcher: typeof fetch): typeof fetch {
  return (input, init) => fetcher(input, init);
}

export async function createInstallationToken(input: {
  appId: string;
  installationId: string;
  privateKey: string;
  fetcher?: typeof fetch;
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
    { method: 'POST', headers: githubHeaders(jwt) },
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
