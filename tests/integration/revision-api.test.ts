// @vitest-environment node

import type { SiteDocument } from '../../src/site-kit/types';
import type { DraftRecord, Role } from '../../src/server/repositories/contracts';
import { createApp } from '../../src/server/index';
import { InMemoryRepository } from '../../src/server/repositories/memory';

const origin = 'https://builder.pointatx.org';
const mutationHeaders = (key: string) => ({
  'content-type': 'application/json',
  origin,
  'sec-fetch-site': 'same-origin',
  'idempotency-key': key,
});

async function json<T>(response: Response): Promise<T> {
  const value: unknown = JSON.parse(await response.text());
  return value as T;
}

describe('revision and lifecycle API', () => {
  it('renames by stable ID, validates names and roles, and preserves history through recovery', async () => {
    const repository = new InMemoryRepository();
    let role: Role = 'editor';
    const app = createApp({
      repository,
      authenticate: () => Promise.resolve({ email: 'editor@pointatx.org', role }),
      environment: 'test',
      version: 'test',
    });
    const created = await repository.createDraft({
      name: 'Original',
      document: (await import('../../src/site-kit/default-site')).defaultSiteDocument,
      actor: 'editor@pointatx.org',
      idempotencyKey: 'rename-test-create',
      requestId: 'create',
    });
    const other = await repository.createDraft({
      name: 'Other draft',
      document: created.document,
      actor: 'editor@pointatx.org',
      idempotencyKey: 'rename-test-other',
      requestId: 'other',
    });
    const revisions = await repository.listRevisions(created.id);
    const rename = (name: string) =>
      app.request(`${origin}/api/drafts/${created.id}`, {
        method: 'PATCH',
        headers: mutationHeaders(crypto.randomUUID()),
        body: JSON.stringify({ name }),
      });
    for (const nextRole of ['editor', 'publisher', 'administrator'] as const) {
      role = nextRole;
      const response = await rename(`  ${role} draft  `);
      expect(response.status).toBe(200);
      const renamed = await json<DraftRecord>(response);
      expect(renamed).toEqual({ ...created, name: `${role} draft`, updatedAt: renamed.updatedAt });
      expect(await repository.listRevisions(created.id)).toEqual(revisions);
      expect(repository.auditEvents.at(-1)).toMatchObject({
        action: 'draft.rename',
        targetId: created.id,
        actor: 'editor@pointatx.org',
        metadata: {},
      });
      expect(await repository.getDraft(other.id)).toEqual(other);
    }
    const beforeInvalid = await repository.getDraft(created.id);
    for (const name of ['', '   ', 'x'.repeat(101)]) expect((await rename(name)).status).toBe(422);
    role = 'viewer';
    expect((await rename('Forbidden')).status).toBe(403);
    expect(await repository.getDraft(created.id)).toEqual(beforeInvalid);
    role = 'editor';
    expect((await rename('x'.repeat(100))).status).toBe(200);
    await repository.setDraftStatus(created.id, 'archived', 'editor@pointatx.org', 'archive');
    const recovered = await repository.setDraftStatus(
      created.id,
      'active',
      'editor@pointatx.org',
      'recover',
    );
    expect(recovered.id).toBe(created.id);
    expect(recovered.name).toBe('x'.repeat(100));
    expect(await repository.listRevisions(created.id)).toEqual(revisions);
    expect((await app.request(`${origin}/api/drafts/${created.id}`)).status).toBe(200);
  });

  it('lists, labels, and restores immutable revisions as a new revision', async () => {
    const repository = new InMemoryRepository();
    const app = createApp({
      repository,
      authenticate: () => Promise.resolve({ email: 'editor@pointatx.org', role: 'editor' }),
      environment: 'test',
      version: 'test',
    });
    const created = await json<{
      id: string;
      document: SiteDocument;
      revision: { id: string; checksum: string };
    }>(
      await app.request(`${origin}/api/drafts`, {
        method: 'POST',
        headers: mutationHeaders('create-revisions-01'),
        body: JSON.stringify({ name: 'Revision flow' }),
      }),
    );
    const changed = structuredClone(created.document);
    changed.site.shortName = 'Revision two';
    const checkoutResponse = await app.request(`${origin}/api/drafts/${created.id}/checkout`, {
      method: 'POST',
      headers: mutationHeaders('checkout-revisions-01'),
      body: JSON.stringify({ clientId: 'revision-browser-01' }),
    });
    const checkout = await json<{ token: string }>(checkoutResponse);
    const saved = await json<{ revision: { id: string; checksum: string } }>(
      await app.request(`${origin}/api/drafts/${created.id}`, {
        method: 'PUT',
        headers: {
          ...mutationHeaders('save-revisions-0001'),
          'if-match': `"${created.revision.checksum}"`,
          'x-draft-checkout': checkout.token,
        },
        body: JSON.stringify({
          document: changed,
          action: { category: 'text-edit', context: 'page-details' },
        }),
      }),
    );

    const labeled = await app.request(
      `${origin}/api/drafts/${created.id}/revisions/${created.revision.id}`,
      {
        method: 'PATCH',
        headers: mutationHeaders('label-revision-001'),
        body: JSON.stringify({ label: 'Before homepage refresh' }),
      },
    );
    expect(labeled.status).toBe(200);
    await expect(labeled.json()).resolves.toMatchObject({ label: 'Before homepage refresh' });

    const revisions = await json<{
      items: Array<{ id: string; sequence: number }>;
      nextCursor: null;
    }>(await app.request(`${origin}/api/drafts/${created.id}/revisions`));
    expect(revisions.items.map(({ sequence }) => sequence)).toEqual([2, 1]);

    const restoredResponse = await app.request(`${origin}/api/drafts/${created.id}/restore`, {
      method: 'POST',
      headers: mutationHeaders('restore-revision-01'),
      body: JSON.stringify({
        revisionId: created.revision.id,
        expectedChecksum: saved.revision.checksum,
      }),
    });
    expect(restoredResponse.status).toBe(200);
    const restored = await json<{
      document: SiteDocument;
      revision: { sequence: number; actionCategory: string; actionContext: string };
    }>(restoredResponse);
    expect(restored.document.site.shortName).toBe('Point ATX');
    expect(restored.revision.sequence).toBe(3);
    expect(restored.revision).toMatchObject({
      actionCategory: 'restore',
      actionContext: 'revision-history',
    });
  });

  it('archives, recovers, and permanently purges without returning deleted contents', async () => {
    const repository = new InMemoryRepository();
    const app = createApp({
      repository,
      authenticate: () => Promise.resolve({ email: 'editor@pointatx.org', role: 'editor' }),
      environment: 'test',
      version: 'test',
    });
    const created = await json<{ id: string }>(
      await app.request(`${origin}/api/drafts`, {
        method: 'POST',
        headers: mutationHeaders('create-lifecycle-01'),
        body: JSON.stringify({ name: 'Lifecycle flow' }),
      }),
    );

    const archived = await app.request(`${origin}/api/drafts/${created.id}`, {
      method: 'PATCH',
      headers: mutationHeaders('archive-draft-0001'),
      body: JSON.stringify({ status: 'archived' }),
    });
    expect(await json<{ status: string }>(archived)).toMatchObject({ status: 'archived' });
    const recovered = await app.request(`${origin}/api/drafts/${created.id}`, {
      method: 'PATCH',
      headers: mutationHeaders('recover-draft-0001'),
      body: JSON.stringify({ status: 'active', name: 'Recovered draft' }),
    });
    expect(await json<{ status: string; name: string }>(recovered)).toMatchObject({
      status: 'active',
      name: 'Recovered draft',
    });
    const activeDelete = await app.request(`${origin}/api/drafts/${created.id}`, {
      method: 'DELETE',
      headers: mutationHeaders('delete-draft-00001'),
      body: JSON.stringify({ confirmation: 'DELETE' }),
    });
    expect(activeDelete.status).toBe(409);

    await app.request(`${origin}/api/drafts/${created.id}`, {
      method: 'PATCH',
      headers: mutationHeaders('rearchive-draft-001'),
      body: JSON.stringify({ status: 'archived' }),
    });
    const wrongCase = await app.request(`${origin}/api/drafts/${created.id}`, {
      method: 'DELETE',
      headers: mutationHeaders('delete-draft-wrong1'),
      body: JSON.stringify({ confirmation: 'delete' }),
    });
    expect(wrongCase.status).toBe(422);

    const deleted = await app.request(`${origin}/api/drafts/${created.id}`, {
      method: 'DELETE',
      headers: mutationHeaders('delete-draft-00002'),
      body: JSON.stringify({ confirmation: 'DELETE' }),
    });
    const receipt = await json<{ id: string; status: string; deletedAt: string }>(deleted);
    expect(Object.keys(receipt).sort()).toEqual(['deletedAt', 'id', 'status']);
    expect(receipt).toMatchObject({
      id: created.id,
      status: 'deleted',
    });
    expect(typeof receipt.deletedAt).toBe('string');
    const denied = await app.request(`${origin}/api/drafts/${created.id}`, {
      method: 'PATCH',
      headers: mutationHeaders('undelete-draft-001'),
      body: JSON.stringify({ status: 'active' }),
    });
    expect(denied.status).toBe(404);
  });
});
