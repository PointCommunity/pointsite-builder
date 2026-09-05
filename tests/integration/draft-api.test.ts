// @vitest-environment node

import type { SiteDocument } from '../../src/site-kit/types';
import { createApp } from '../../src/server/index';
import { InMemoryRepository } from '../../src/server/repositories/memory';
import type { Actor } from '../../src/server/auth/roles';

const origin = 'https://builder.pointatx.org';
const requestHeaders = {
  'content-type': 'application/json',
  origin,
  'sec-fetch-site': 'same-origin',
  'idempotency-key': '0123456789abcdef',
};

async function responseJson<T>(response: Response): Promise<T> {
  const value: unknown = JSON.parse(await response.text());
  return value as T;
}

function appFor(actor: Actor) {
  const repository = new InMemoryRepository();
  return {
    repository,
    app: createApp({
      repository,
      authenticate: () => Promise.resolve(actor),
      environment: 'test',
      version: 'test',
    }),
  };
}

describe('draft API', () => {
  it('exposes public process health without private state', async () => {
    const { app } = appFor({ email: 'viewer@pointatx.org', role: 'viewer' });
    const response = await app.request(`${origin}/api/health`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      environment: 'test',
      version: 'test',
    });
  });

  it('allows viewers to list drafts but denies mutations server-side', async () => {
    const { app } = appFor({ email: 'viewer@pointatx.org', role: 'viewer' });
    expect((await app.request(`${origin}/api/drafts`)).status).toBe(200);
    const denied = await app.request(`${origin}/api/drafts`, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify({ name: 'Denied' }),
    });
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('creates, reads, saves, and idempotently retries a draft', async () => {
    const { app } = appFor({ email: 'editor@pointatx.org', role: 'editor' });
    const createdResponse = await app.request(`${origin}/api/drafts`, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify({ name: 'Website refresh' }),
    });
    expect(createdResponse.status).toBe(201);
    const created = await responseJson<{
      id: string;
      revision: { checksum: string; id: string };
      document: SiteDocument;
    }>(createdResponse);

    const read = await app.request(`${origin}/api/drafts/${created.id}`);
    expect(read.status).toBe(200);
    const changed = structuredClone(created.document);
    changed.site.shortName = 'Point South Austin';
    const saveHeaders = {
      ...requestHeaders,
      'idempotency-key': 'save-website-0001',
      'if-match': `"${created.revision.checksum}"`,
    };
    const savedResponse = await app.request(`${origin}/api/drafts/${created.id}`, {
      method: 'PUT',
      headers: saveHeaders,
      body: JSON.stringify({ document: changed }),
    });
    expect(savedResponse.status).toBe(200);
    const saved = await responseJson<{ revision: { id: string; checksum: string } }>(savedResponse);

    const retry = await app.request(`${origin}/api/drafts/${created.id}`, {
      method: 'PUT',
      headers: saveHeaders,
      body: JSON.stringify({ document: changed }),
    });
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({ revision: { id: saved.revision.id } });
  });

  it('returns precondition failure for a stale save without overwriting', async () => {
    const { app } = appFor({ email: 'editor@pointatx.org', role: 'editor' });
    const createdResponse = await app.request(`${origin}/api/drafts`, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify({ name: 'Concurrent' }),
    });
    const created = await responseJson<{
      id: string;
      revision: { checksum: string };
      document: SiteDocument;
    }>(createdResponse);
    const first = structuredClone(created.document);
    first.site.shortName = 'First save';
    await app.request(`${origin}/api/drafts/${created.id}`, {
      method: 'PUT',
      headers: {
        ...requestHeaders,
        'idempotency-key': 'first-save-00001',
        'if-match': `"${created.revision.checksum}"`,
      },
      body: JSON.stringify({ document: first }),
    });

    const stale = await app.request(`${origin}/api/drafts/${created.id}`, {
      method: 'PUT',
      headers: {
        ...requestHeaders,
        'idempotency-key': 'stale-save-00001',
        'if-match': `"${created.revision.checksum}"`,
      },
      body: JSON.stringify({ document: created.document }),
    });
    expect(stale.status).toBe(412);
    await expect(stale.json()).resolves.toMatchObject({ code: 'REVISION_CONFLICT' });
  });

  it('returns bounded field errors for invalid documents', async () => {
    const { app } = appFor({ email: 'editor@pointatx.org', role: 'editor' });
    const createdResponse = await app.request(`${origin}/api/drafts`, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify({ name: 'Validation' }),
    });
    const created = await responseJson<{
      id: string;
      revision: { checksum: string };
      document: Record<string, unknown>;
    }>(createdResponse);
    created.document.script = 'unsafe';
    const response = await app.request(`${origin}/api/drafts/${created.id}`, {
      method: 'PUT',
      headers: {
        ...requestHeaders,
        'idempotency-key': 'invalid-save-0001',
        'if-match': `"${created.revision.checksum}"`,
      },
      body: JSON.stringify({ document: created.document }),
    });
    expect(response.status).toBe(422);
    const error = await responseJson<{ code: string; fieldErrors: unknown }>(response);
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(Array.isArray(error.fieldErrors)).toBe(true);
  });
});
