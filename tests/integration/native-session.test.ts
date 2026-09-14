// @vitest-environment node
import { expect, test, vi } from 'vitest';
import { SqliteDatabase } from '../../server/sqlite';
import { migrateDatabase } from '../../server/migrations';
import { createBuilderRuntime } from '../../src/server/application';
import { GitHubSessionCodec } from '../../src/server/auth/github';
import { parseConfig } from '../../src/server/config';

test('a recovery epoch invalidates existing sessions and in-flight OAuth before any provider request', async () => {
  const workspace = new SqliteDatabase(':memory:');
  const recovery = new SqliteDatabase(':memory:');
  const provider = vi.fn(() => {
    throw new Error('Unexpected provider request');
  });
  vi.stubGlobal('fetch', provider);
  try {
    await migrateDatabase(workspace, 'migrations');
    await migrateDatabase(recovery, 'recovery-migrations');
    const config = parseConfig({
      RUNTIME: 'node',
      ENVIRONMENT: 'canary',
      APP_VERSION: 'fixture',
      BUILDER_ORIGIN: 'https://builder-canary.eaglepass.io',
      STAGING_REPOSITORY: 'PointCommunity/pointsite-staging',
      PRODUCTION_ENABLED: 'false',
      GITHUB_APP_ID: '1',
      GITHUB_STAGING_INSTALLATION_ID: '2',
      GITHUB_APP_PRIVATE_KEY: 'a'.repeat(100),
      GITHUB_CLIENT_ID: 'a'.repeat(8),
      GITHUB_CLIENT_SECRET: 'b'.repeat(20),
      SESSION_SECRET: 'c'.repeat(32),
    });
    let epoch = 1;
    const app = createBuilderRuntime({
      workspace,
      recovery,
      config,
      assets: { fetch: () => Promise.resolve(new Response(null, { status: 404 })) },
      sessionEpoch: () => Promise.resolve(epoch),
      release: {
        sourceRevision: 'a'.repeat(40),
        sourceClean: true,
        workerVersionId: null,
        storageWriteFormat: 'compact-v1',
      },
    });
    const codec = (value: number, origin = config.builderOrigin) =>
      new GitHubSessionCodec(JSON.stringify([config.github!.sessionSecret, origin, value]));
    const login = await app.fetch(new Request(config.builderOrigin + '/auth/login'));
    expect(login.status).toBe(302);
    const cookie = login.headers
      .getSetCookie()
      .find((value) => value.startsWith('__Host-pointsite_builder_oauth='))!
      .split(';')[0];
    const token = cookie.slice(cookie.indexOf('=') + 1);
    const state = await codec(1).decodeOAuth(token);
    const session = await codec(1).encode({ id: 1202831, login: 'brimdor' });
    await expect(codec(1, 'https://builder.eaglepass.io').decode(session)).rejects.toThrow();
    epoch = 2;
    const callback = await app.fetch(
      new Request(config.builderOrigin + '/auth/callback?code=fixture&state=' + state.state, {
        headers: { cookie },
      }),
    );
    expect(callback.status).toBe(401);
    expect(
      (
        await app.fetch(
          new Request(config.builderOrigin + '/api/me', {
            headers: { cookie: '__Host-pointsite_builder_session=' + session },
          }),
        )
      ).status,
    ).toBe(401);
    const fresh = await app.fetch(new Request(config.builderOrigin + '/auth/login'));
    const freshCookie = fresh.headers
      .getSetCookie()
      .find((value) => value.startsWith('__Host-pointsite_builder_oauth='))!
      .split(';')[0];
    const freshToken = freshCookie.slice(freshCookie.indexOf('=') + 1);
    expect((await codec(2).decodeOAuth(freshToken)).kind).toBe('oauth');
    await expect(codec(1).decodeOAuth(freshToken)).rejects.toThrow();
    expect(provider).not.toHaveBeenCalled();
  } finally {
    workspace.close();
    recovery.close();
    vi.unstubAllGlobals();
  }
});
