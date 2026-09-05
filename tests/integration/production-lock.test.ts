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
