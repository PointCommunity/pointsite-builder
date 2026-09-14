// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, test } from 'vitest';
import { parseConfig } from '../../src/server/config';
import { openNativeWorkspace } from '../../server/workspace';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});
test('the real native runtime authenticates local fixtures, persists drafts and fences recovery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'builder-native-workspace-'));
  cleanup.push(() => rm(directory, { recursive: true }));
  const config = parseConfig({
    RUNTIME: 'node',
    ENVIRONMENT: 'local',
    APP_VERSION: 'fixture',
    BUILDER_ORIGIN: 'http://127.0.0.1:3000',
    STAGING_REPOSITORY: 'PointCommunity/pointsite-staging',
    DEV_AUTH_EMAIL: 'fixture@example.com',
    PRODUCTION_ENABLED: 'false',
    DRAFT_STORAGE_FORMAT: 'compact-v1',
  });
  const options = {
    workspacePath: join(directory, 'workspace/data.sqlite'),
    recoveryPath: join(directory, 'recovery/data.sqlite'),
    migrationRoot: process.cwd(),
    publicRoot: join(process.cwd(), 'public'),
    config,
    release: {
      sourceRevision: 'a'.repeat(40),
      sourceClean: false,
      workerVersionId: null,
      storageWriteFormat: 'compact-v1' as const,
    },
  };
  const app = await openNativeWorkspace(options);
  cleanup.push(app.close);
  await app.workspace
    .prepare(
      `INSERT INTO user_roles(email,role,active,created_at,updated_at,updated_by)
    VALUES ('fixture@example.com','administrator',1,'fixture','fixture','fixture')`,
    )
    .run();
  const request = (path: string, init?: RequestInit) =>
    app.fetch(new Request(config.builderOrigin + path, init));
  expect((await request('/api/me')).status).toBe(200);
  const created = await request('/api/drafts', {
    method: 'POST',
    headers: {
      origin: config.builderOrigin,
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
      'idempotency-key': crypto.randomUUID(),
    },
    body: JSON.stringify({ name: 'Native persisted draft' }),
  });
  expect(created.status).toBe(201);
  const draft: { id: string } = await created.json();
  expect((await request(`/api/drafts/${draft.id}`)).status).toBe(200);
  expect((await request('/api/ready')).status).toBe(200);
  await app.runtime.scheduled();
  app.close();
  const reopened = await openNativeWorkspace(options);
  cleanup.push(reopened.close);
  const response = await reopened.fetch(
    new Request(`${config.builderOrigin}/api/drafts/${draft.id}`),
  );
  expect(response.status).toBe(200);
  await reopened.recovery
    .prepare(
      "UPDATE workspace_recovery SET mode='quarantined',epoch=epoch+1,recovery_id=? WHERE id=1",
    )
    .bind(crypto.randomUUID())
    .run();
  expect((await reopened.fetch(new Request(`${config.builderOrigin}/readyz`))).status).toBe(503);
  expect((await reopened.fetch(new Request(`${config.builderOrigin}/api/drafts`))).status).toBe(
    503,
  );
  expect((await reopened.fetch(new Request(`${config.builderOrigin}/api/health`))).status).toBe(
    200,
  );
});
