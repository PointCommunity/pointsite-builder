import { exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet } from 'jose';

export async function accessTokenFixture() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = 'test-access-key';
  publicJwk.alg = 'RS256';
  const jwks: JSONWebKeySet = { keys: [publicJwk] };

  async function sign(
    overrides: {
      email?: string;
      issuer?: string;
      audience?: string;
      expiresIn?: string | number;
    } = {},
  ) {
    return new SignJWT({ email: overrides.email ?? 'editor@pointatx.org', type: 'app' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-access-key' })
      .setIssuer(overrides.issuer ?? 'https://point.cloudflareaccess.com')
      .setAudience(overrides.audience ?? 'builder-audience')
      .setIssuedAt()
      .setExpirationTime(overrides.expiresIn ?? '5m')
      .sign(privateKey);
  }

  return { jwks, sign };
}
