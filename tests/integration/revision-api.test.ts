// @vitest-environment node

import type { SiteDocument } from '../../src/site-kit/types';
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
    const saved = await json<{ revision: { id: string; checksum: string } }>(
      await app.request(`${origin}/api/drafts/${created.id}`, {
        method: 'PUT',
        headers: {
          ...mutationHeaders('save-revisions-0001'),
          'if-match': `"${created.revision.checksum}"`,
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

  it('archives, recovers, and soft deletes without making deleted drafts active', async () => {
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
    expect(await json<{ status: string }>(deleted)).toMatchObject({ status: 'deleted' });
    const denied = await app.request(`${origin}/api/drafts/${created.id}`, {
      method: 'PATCH',
      headers: mutationHeaders('undelete-draft-001'),
      body: JSON.stringify({ status: 'active' }),
    });
    expect(denied.status).toBe(409);
  });
});
