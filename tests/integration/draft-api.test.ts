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

async function checkout(
  app: ReturnType<typeof createApp>,
  draftId: string,
  clientId = 'browser-client-0001',
) {
  const response = await app.request(`${origin}/api/drafts/${draftId}/checkout`, {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify({ clientId }),
  });
  expect(response.status).toBe(200);
  return responseJson<{ token: string; expiresAt: string }>(response);
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
    const lease = await checkout(app, created.id);
    const saveHeaders = {
      ...requestHeaders,
      'idempotency-key': 'save-website-0001',
      'if-match': `"${created.revision.checksum}"`,
      'x-draft-checkout': lease.token,
    };
    const savedResponse = await app.request(`${origin}/api/drafts/${created.id}`, {
      method: 'PUT',
      headers: saveHeaders,
      body: JSON.stringify({
        document: changed,
        action: { category: 'text-edit', context: 'site-settings' },
      }),
    });
    expect(savedResponse.status).toBe(200);
    const saved = await responseJson<{ revision: { id: string; checksum: string } }>(savedResponse);

    const retry = await app.request(`${origin}/api/drafts/${created.id}`, {
      method: 'PUT',
      headers: saveHeaders,
      body: JSON.stringify({
        document: changed,
        action: { category: 'text-edit', context: 'site-settings' },
      }),
    });
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({ revision: { id: saved.revision.id } });
  });

  it('duplicates an existing immutable revision into a new draft', async () => {
    const { app } = appFor({ email: 'editor@pointatx.org', role: 'editor' });
    const sourceResponse = await app.request(`${origin}/api/drafts`, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify({ name: 'Source' }),
    });
    const source = await responseJson<{ revision: { id: string }; document: SiteDocument }>(
      sourceResponse,
    );
    const duplicateResponse = await app.request(`${origin}/api/drafts`, {
      method: 'POST',
      headers: { ...requestHeaders, 'idempotency-key': 'duplicate-draft-01' },
      body: JSON.stringify({ name: 'Duplicate', fromRevisionId: source.revision.id }),
    });
    expect(duplicateResponse.status).toBe(201);
    await expect(duplicateResponse.json()).resolves.toMatchObject({
      name: 'Duplicate',
      document: source.document,
    });
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
    const lease = await checkout(app, created.id);
    await app.request(`${origin}/api/drafts/${created.id}`, {
      method: 'PUT',
      headers: {
        ...requestHeaders,
        'idempotency-key': 'first-save-00001',
        'if-match': `"${created.revision.checksum}"`,
        'x-draft-checkout': lease.token,
      },
      body: JSON.stringify({
        document: first,
        action: { category: 'text-edit', context: 'page-details' },
      }),
    });

    const stale = await app.request(`${origin}/api/drafts/${created.id}`, {
      method: 'PUT',
      headers: {
        ...requestHeaders,
        'idempotency-key': 'stale-save-00001',
        'if-match': `"${created.revision.checksum}"`,
        'x-draft-checkout': lease.token,
      },
      body: JSON.stringify({
        document: created.document,
        action: { category: 'undo', context: 'page-content' },
      }),
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
      body: JSON.stringify({
        document: created.document,
        action: { category: 'text-edit', context: 'page-content' },
      }),
    });
    expect(response.status).toBe(422);
    const error = await responseJson<{ code: string; fieldErrors: unknown }>(response);
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(Array.isArray(error.fieldErrors)).toBe(true);
  });

  it('requires finite content-free action attribution for every draft save', async () => {
    const { app } = appFor({ email: 'editor@pointatx.org', role: 'editor' });
    const created = await responseJson<{
      id: string;
      revision: { checksum: string };
      document: SiteDocument;
    }>(
      await app.request(`${origin}/api/drafts`, {
        method: 'POST',
        headers: { ...requestHeaders, 'idempotency-key': 'create-action-contract' },
        body: JSON.stringify({ name: 'Action contract' }),
      }),
    );
    const changed = structuredClone(created.document);
    changed.site.shortName = 'Action metadata';
    const headers = {
      ...requestHeaders,
      'idempotency-key': 'save-action-contract',
      'if-match': `"${created.revision.checksum}"`,
    };

    const missing = await app.request(`${origin}/api/drafts/${created.id}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ document: changed }),
    });
    expect(missing.status).toBe(422);

    const contentBearing = await app.request(`${origin}/api/drafts/${created.id}`, {
      method: 'PUT',
      headers: { ...headers, 'idempotency-key': 'save-action-invalid' },
      body: JSON.stringify({
        document: changed,
        action: { category: 'changed-heading-to-secret', context: 'page-content' },
      }),
    });
    expect(contentBearing.status).toBe(422);
  });

  it('rejects documents above the canonical D1 safety ceiling before persistence', async () => {
    const { app } = appFor({ email: 'editor@pointatx.org', role: 'editor' });
    const created = await responseJson<{ id: string; revision: { checksum: string } }>(
      await app.request(`${origin}/api/drafts`, {
        method: 'POST',
        headers: { ...requestHeaders, 'idempotency-key': 'create-size-contract' },
        body: JSON.stringify({ name: 'Size contract' }),
      }),
    );
    const oversized = await app.request(`${origin}/api/drafts/${created.id}`, {
      method: 'PUT',
      headers: {
        ...requestHeaders,
        'idempotency-key': 'save-size-contract',
        'if-match': `"${created.revision.checksum}"`,
      },
      body: JSON.stringify({
        document: { oversized: 'x'.repeat(1_500_001) },
        action: { category: 'text-edit', context: 'page-content' },
      }),
    });
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({ code: 'DOCUMENT_TOO_LARGE' });
  });

  it('atomically denies another user and supersedes an older client for the owner', async () => {
    const repository = new InMemoryRepository();
    let actor: Actor = { email: 'first@pointatx.org', role: 'editor' };
    const app = createApp({
      repository,
      authenticate: () => Promise.resolve(actor),
      environment: 'test',
      version: 'test',
    });
    const created = await responseJson<{
      id: string;
      document: SiteDocument;
      revision: { checksum: string };
    }>(
      await app.request(`${origin}/api/drafts`, {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify({ name: 'Lease race' }),
      }),
    );
    const first = await checkout(app, created.id, 'first-browser-0001');
    actor = { email: 'second@pointatx.org', role: 'editor' };
    const denied = await app.request(`${origin}/api/drafts/${created.id}/checkout`, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify({ clientId: 'second-browser-001' }),
    });
    expect(denied.status).toBe(409);
    actor = { email: 'first@pointatx.org', role: 'editor' };
    const transferred = await checkout(app, created.id, 'first-browser-0002');
    expect(transferred.token).not.toBe(first.token);
    const staleValidation = await app.request(`${origin}/api/drafts/${created.id}/checkout`, {
      headers: { 'x-draft-checkout': first.token },
    });
    expect(staleValidation.status).toBe(409);
    const currentValidation = await app.request(`${origin}/api/drafts/${created.id}/checkout`, {
      headers: { 'x-draft-checkout': transferred.token },
    });
    expect(currentValidation.status).toBe(200);
    await expect(currentValidation.json()).resolves.toEqual({ active: true });
    const changed = structuredClone(created.document);
    changed.site.shortName = 'Blocked old client';
    const stale = await app.request(`${origin}/api/drafts/${created.id}`, {
      method: 'PUT',
      headers: {
        ...requestHeaders,
        'idempotency-key': 'stale-client-save',
        'if-match': `"${created.revision.checksum}"`,
        'x-draft-checkout': first.token,
      },
      body: JSON.stringify({
        document: changed,
        action: { category: 'text-edit', context: 'site-settings' },
      }),
    });
    expect(stale.status).toBe(409);
  });
});
