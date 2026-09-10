// @vitest-environment node
import { exportPKCS8, generateKeyPair, jwtVerify } from 'jose';
import { FeedbackService, parseFeedbackConfig } from '../../src/server/feedback/service';

describe('PointView launch boundary', () => {
  const settings = {
    POINTVIEW_MODE: 'pilot',
    POINTVIEW_ORIGIN: 'https://pointview-canary.eaglepass.io',
    POINTVIEW_KEY_ID: 'builder-key-1',
    POINTVIEW_PRIVATE_KEY: 'placeholder',
    BUILDER_ORIGIN: 'https://builder.pointatx.org',
  };
  it('disables incomplete, unsafe, or mismatched configuration independently', () => {
    for (const input of [
      {},
      settings,
      { ...settings, POINTVIEW_MODE: 'disabled' },
      { ...settings, POINTVIEW_ORIGIN: 'https://evil.example' },
      { ...settings, POINTVIEW_MODE: 'production' },
      { ...settings, BUILDER_ORIGIN: 'https://builder.pointatx.org.evil.example' },
    ])
      expect(parseFeedbackConfig(input)).toBeUndefined();
  });
  it('signs only minimal canonical provenance, with unique nonces and bounded lifetime', async () => {
    const keys = await generateKeyPair('EdDSA', { extractable: true });
    const config = parseFeedbackConfig({
      ...settings,
      POINTVIEW_PRIVATE_KEY: await exportPKCS8(keys.privateKey),
    });
    expect(config).toBeDefined();
    const service = new FeedbackService(config!, '0.1.0', 'a'.repeat(40));
    const first = await service.launch('editor.settings', 'administrator');
    const second = await service.launch('dashboard', 'administrator');
    const { payload, protectedHeader } = await jwtVerify(first.launchToken, keys.publicKey, {
      issuer: 'pointsite-builder',
      audience: 'pointview',
    });
    expect(protectedHeader).toEqual({ alg: 'EdDSA', kid: 'builder-key-1', typ: 'JWT' });
    expect(payload).toEqual({
      iss: 'pointsite-builder',
      aud: 'pointview',
      source_app: 'pointsite-builder',
      environment: 'production',
      iat: payload.iat,
      exp: payload.exp,
      jti: payload.jti,
      context: {
        location: '/editor/settings',
        screen_name: 'Editor: Settings',
        app_version: '0.1.0',
        source_revision: 'a'.repeat(40),
        return_url: 'https://builder.pointatx.org/',
      },
    });
    expect(payload.exp! - payload.iat!).toBe(120);
    expect(payload.jti!.length).toBeGreaterThanOrEqual(20);
    const other = await jwtVerify(second.launchToken, keys.publicKey);
    expect(other.payload.jti).not.toBe(payload.jti);
    expect(first.action).toBe('https://pointview-canary.eaglepass.io/launch');
    await expect(
      jwtVerify(first.launchToken, keys.publicKey, {
        currentDate: new Date((payload.exp! + 1) * 1000),
      }),
    ).rejects.toThrow();
    await expect(service.launch('editor.admin', 'viewer')).rejects.toThrow();
  });
});
