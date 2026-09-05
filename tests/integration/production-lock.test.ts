// @vitest-environment node
import { createApp } from '../../src/server';
import { InMemoryRepository } from '../../src/server/repositories/memory';

it('keeps production publishing hard disabled without invoking a publisher', async () => {
  const app = createApp({
    repository: new InMemoryRepository(),
    authenticate: () => Promise.resolve({ email: 'admin@pointatx.org', role: 'administrator' }),
    environment: 'test',
    version: 'test',
  });
  const response = await app.request('https://builder.pointatx.org/api/publish/production', {
    method: 'POST',
    headers: {
      origin: 'https://builder.pointatx.org',
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
      'idempotency-key': 'production-locked',
    },
    body: '{}',
  });
  expect(response.status).toBe(403);
  await expect(response.json()).resolves.toMatchObject({ code: 'PRODUCTION_DISABLED' });
});

it('allows a read collaborator to author drafts while denying every staging publish operation', async () => {
  const repository = new InMemoryRepository();
  const app = createApp({
    repository,
    authenticate: () =>
      Promise.resolve({
        email: 'github:22',
        role: 'publisher',
        repositoryPermission: 'read',
      }),
    environment: 'test',
    version: 'test',
    publisher: {} as never,
  });
  const mutationHeaders = {
    origin: 'https://builder.pointatx.org',
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json',
    'idempotency-key': crypto.randomUUID(),
  };

  const draft = await app.request('https://builder.pointatx.org/api/drafts', {
    method: 'POST',
    headers: mutationHeaders,
    body: JSON.stringify({ name: 'Read collaborator draft' }),
  });
  expect(draft.status).toBe(201);

  const base = await app.request('https://builder.pointatx.org/api/publish/staging/base');
  expect(base.status).toBe(403);
  await expect(base.json()).resolves.toMatchObject({ code: 'FORBIDDEN' });

  const publish = await app.request('https://builder.pointatx.org/api/publish/staging', {
    method: 'POST',
    headers: { ...mutationHeaders, 'idempotency-key': crypto.randomUUID() },
    body: JSON.stringify({
      draftId: '10000000-0000-4000-8000-000000000001',
      expectedBaseSha: 'a'.repeat(40),
    }),
  });
  expect(publish.status).toBe(403);
  await expect(publish.json()).resolves.toMatchObject({ code: 'FORBIDDEN' });
});
