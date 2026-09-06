import { expect, test } from '@playwright/test';
import { defaultSiteDocument } from '../../src/site-kit/default-site';

test('viewer receives a read-only preview with no authoring or publish controls', async ({
  page,
}) => {
  const document = structuredClone(defaultSiteDocument);
  const draft = {
    id: '10000000-0000-4000-8000-000000000001',
    siteId: 'pointsite',
    name: 'Read only',
    status: 'active',
    latestRevisionId: '20000000-0000-4000-8000-000000000001',
    document,
    revision: {
      id: '20000000-0000-4000-8000-000000000001',
      draftId: '10000000-0000-4000-8000-000000000001',
      sequence: 1,
      parentRevisionId: null,
      checksum: 'a'.repeat(64),
      document,
      label: null,
      schemaVersion: document.schemaVersion,
      rendererVersion: document.rendererVersion,
      createdBy: 'admin@pointatx.org',
      createdAt: '2026-09-05T00:00:00Z',
    },
    createdBy: 'admin@pointatx.org',
    createdAt: '2026-09-05T00:00:00Z',
    updatedAt: '2026-09-05T00:00:00Z',
    deletedAt: null,
  };
  const mutations: string[] = [];
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    if (request.method() !== 'GET') mutations.push(`${request.method()} ${request.url()}`);
    const path = new URL(request.url()).pathname;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        path.endsWith('/me')
          ? { email: 'viewer@pointatx.org', role: 'viewer', repositoryPermission: 'read' }
          : path.endsWith('/drafts')
            ? { items: [draft], nextCursor: null }
            : draft,
      ),
    });
  });
  await page.goto('/');
  await expect(page.getByLabel('New draft name')).toHaveCount(0);
  await page.getByRole('button', { name: 'Open preview' }).click();
  await expect(page.getByRole('button', { name: 'Publish', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible();
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByText('Viewer access is read only.')).toBeVisible();
  expect(mutations).toEqual([]);
});

test('read-only GitHub collaborator can create and edit drafts but cannot publish', async ({
  page,
}) => {
  const document = structuredClone(defaultSiteDocument);
  const draft = {
    id: '10000000-0000-4000-8000-000000000002',
    siteId: 'pointsite',
    name: 'Read collaborator draft',
    status: 'active',
    latestRevisionId: '20000000-0000-4000-8000-000000000002',
    document,
    revision: {
      id: '20000000-0000-4000-8000-000000000002',
      draftId: '10000000-0000-4000-8000-000000000002',
      sequence: 1,
      parentRevisionId: null,
      checksum: 'b'.repeat(64),
      document,
      label: null,
      schemaVersion: document.schemaVersion,
      rendererVersion: document.rendererVersion,
      createdBy: 'github:22',
      createdAt: '2026-09-05T00:00:00Z',
    },
    createdBy: 'github:22',
    createdAt: '2026-09-05T00:00:00Z',
    updatedAt: '2026-09-05T00:00:00Z',
    deletedAt: null,
  };
  const mutations: string[] = [];
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') mutations.push(`${request.method()} ${path}`);
    const body = path.endsWith('/me')
      ? {
          email: 'github:22',
          displayName: '@read-collaborator',
          role: 'publisher',
          repositoryPermission: 'read',
        }
      : path.endsWith('/drafts') && request.method() === 'GET'
        ? { items: [draft], nextCursor: null }
        : path.endsWith('/revisions')
          ? { items: [draft.revision], nextCursor: null }
          : path.endsWith('/media')
            ? { items: [], nextCursor: null }
            : draft;
    await route.fulfill({
      status: path.endsWith('/drafts') && request.method() === 'POST' ? 201 : 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });

  await page.goto('/');
  await page.getByLabel('New draft name').fill('Another draft');
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page.getByLabel('Visual canvas for Home')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Publish', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('button', { name: 'Save now' }).click();
  expect(mutations).toContain('POST /api/drafts');
  expect(mutations.some((item) => item.startsWith('PUT /api/drafts/'))).toBe(true);
  expect(mutations.some((item) => item.includes('/api/publish'))).toBe(false);
});
