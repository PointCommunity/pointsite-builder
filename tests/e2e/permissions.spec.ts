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
      schemaVersion: 1,
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
          ? { email: 'viewer@pointatx.org', role: 'viewer' }
          : path.endsWith('/drafts')
            ? { items: [draft], nextCursor: null }
            : draft,
      ),
    });
  });
  await page.goto('/');
  await expect(page.getByLabel('New draft name')).toHaveCount(0);
  await page.getByRole('button', { name: 'Open preview' }).click();
  await expect(page.getByRole('button', { name: 'publish' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'settings' })).toBeVisible();
  await page.getByRole('button', { name: 'settings' }).click();
  await expect(page.getByText('Viewer access is read only.')).toBeVisible();
  expect(mutations).toEqual([]);
});
