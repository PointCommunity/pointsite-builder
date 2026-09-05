import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type JWTVerifyOptions } from 'jose';
import { z } from 'zod';
import type { RuntimeConfig } from '../config';
import { AuthorizationError, type Actor, type RoleDirectory } from './roles';

const AccessClaimsSchema = z.object({ email: z.email() });

export class AuthenticationError extends Error {
  constructor(message = 'Valid Cloudflare Access authentication is required') {
    super(message);
    this.name = 'AuthenticationError';
  }
}

export class AccessVerifier {
  readonly #key: JWTVerifyGetKey;
  readonly #options: JWTVerifyOptions;

  constructor(config: RuntimeConfig, key?: JWTVerifyGetKey) {
    this.#key =
      key ?? createRemoteJWKSet(new URL(`https://${config.accessTeamDomain}/cdn-cgi/access/certs`));
    this.#options = {
      issuer: `https://${config.accessTeamDomain}`,
      audience: config.accessAudience,
      algorithms: ['RS256'],
    };
  }

  async verify(request: Request): Promise<{ email: string }> {
    const assertion = request.headers.get('Cf-Access-Jwt-Assertion');
    if (!assertion) throw new AuthenticationError();

    try {
      const { payload } = await jwtVerify(assertion, this.#key, this.#options);
      const claims = AccessClaimsSchema.parse(payload);
      return { email: claims.email.toLowerCase() };
    } catch {
      throw new AuthenticationError();
    }
  }
}

function isLoopback(request: Request): boolean {
  const hostname = new URL(request.url).hostname;
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

export async function authenticateRequest(
  request: Request,
  config: RuntimeConfig,
  roles: RoleDirectory,
  verifier = new AccessVerifier(config),
): Promise<Actor> {
  let email: string;
  if (config.environment === 'local' && config.devAuthEmail && isLoopback(request)) {
    email = config.devAuthEmail;
  } else {
    email = (await verifier.verify(request)).email;
  }

  const role = await roles.getRole(email);
  if (!role?.active)
    throw new AuthorizationError('Your identity does not have an active builder role');
  return { email, role: role.role };
}
