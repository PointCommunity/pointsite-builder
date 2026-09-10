// @vitest-environment node
import { exportPKCS8, generateKeyPair } from 'jose';
import { AuthenticationError } from '../../src/server/auth/github';
import { FeedbackService, parseFeedbackConfig } from '../../src/server/feedback/service';
import { createApp } from '../../src/server/index';
import { InMemoryRepository } from '../../src/server/repositories/memory';
import type { Role } from '../../src/server/repositories/contracts';

const origin = 'https://builder.pointatx.org';
const headers = {
  origin,
  'sec-fetch-site': 'same-origin',
  'content-type': 'application/json',
  'idempotency-key': 'feedback-test-000001',
};
let service: FeedbackService;
beforeAll(async () => {
  const { privateKey } = await generateKeyPair('EdDSA', { extractable: true });
  const config = parseFeedbackConfig({
    POINTVIEW_MODE: 'pilot',
    POINTVIEW_ORIGIN: 'https://pointview-canary.eaglepass.io',
    POINTVIEW_KEY_ID: 'key-1',
    POINTVIEW_PRIVATE_KEY: await exportPKCS8(privateKey),
    BUILDER_ORIGIN: origin,
  });
  service = new FeedbackService(config!, '0.1.0', 'a'.repeat(40));
});
const appFor = (role: Role | null, feedback = service) =>
  createApp({
    repository: new InMemoryRepository(),
    environment: 'test',
    version: 'test',
    feedback,
    authenticate: () => {
      if (!role) throw new AuthenticationError();
      return Promise.resolve({ email: `${crypto.randomUUID()}@pointatx.org`, role });
    },
  });
const launch = (app: ReturnType<typeof createApp>, body: unknown, override = headers) =>
  app.request(`${origin}/api/feedback/launch`, {
    method: 'POST',
    headers: override,
    body: JSON.stringify(body),
  });

describe('feedback API', () => {
  it('requires authentication and Administrator authorization for the pilot', async () => {
    expect((await launch(appFor(null), { screen: 'dashboard' })).status).toBe(401);
    for (const role of ['viewer', 'editor', 'publisher'] as const) {
      const app = appFor(role);
      expect(await (await app.request(`${origin}/api/feedback`)).json()).toEqual({
        mode: 'disabled',
      });
      expect((await launch(app, { screen: 'dashboard' })).status).toBe(403);
    }
    expect((await launch(appFor('administrator'), { screen: 'dashboard' })).status).toBe(200);
  });
  it('rejects forged provenance, private extra fields, and cross-site requests', async () => {
    const app = appFor('administrator');
    for (const body of [
      { screen: '/drafts/private-id' },
      { screen: 'dashboard', draftName: 'private' },
      { screen: 'dashboard', returnUrl: 'https://evil.example' },
    ]) {
      const response = await launch(app, body);
      expect(response.status).toBe(422);
      expect(await response.text()).not.toMatch(/private|evil/);
    }
    expect(
      (await launch(app, { screen: 'dashboard' }, { ...headers, origin: 'https://evil.example' }))
        .status,
    ).toBe(403);
  });
  it('keeps launch responses private and handles key errors without leaking them', async () => {
    const response = await launch(appFor('administrator'), { screen: 'editor.layout' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    const logger = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broken = new FeedbackService(
      {
        POINTVIEW_MODE: 'pilot',
        POINTVIEW_ORIGIN: 'https://pointview-canary.eaglepass.io',
        POINTVIEW_KEY_ID: 'key-1',
        POINTVIEW_PRIVATE_KEY: 'secret-invalid-key',
        BUILDER_ORIGIN: origin,
      },
      '0.1.0',
      'a'.repeat(40),
    );
    const failed = await launch(appFor('administrator', broken), { screen: 'dashboard' });
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain('secret-invalid-key');
    expect(JSON.stringify(logger.mock.calls)).not.toContain('secret-invalid-key');
    logger.mockRestore();
  });
});
