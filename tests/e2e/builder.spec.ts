import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import type { DraftRecord } from '../../src/server/repositories/contracts';

const document = structuredClone(defaultSiteDocument);
const draft: DraftRecord = {
  id: '10000000-0000-4000-8000-000000000001',
  siteId: 'pointsite',
  name: 'Sunday update',
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

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = path.endsWith('/me')
      ? { email: 'admin@pointatx.org', role: 'administrator' }
      : path.endsWith('/drafts')
        ? { items: [draft] }
        : path.includes('/revisions')
          ? { items: [draft.revision] }
          : path.endsWith('/staging/base')
            ? { sha: 'b'.repeat(40) }
            : path.endsWith('/media')
              ? { items: [] }
              : path.endsWith('/admin/roles')
                ? { items: [] }
                : path.endsWith('/admin/audit')
                  ? { items: [] }
                  : path.endsWith('/admin/capacity')
                    ? {
                        privateMedia: {
                          used: 0,
                          limit: 1,
                          percent: 0,
                          warning: false,
                          unit: 'bytes',
                        },
                        revisionData: {
                          used: 0,
                          limit: 1,
                          percent: 0,
                          warning: false,
                          unit: 'bytes',
                        },
                        writesToday: {
                          used: 0,
                          limit: 100000,
                          percent: 0,
                          warning: false,
                          unit: 'operations',
                        },
                        measuredAt: '2026-09-05T00:00:00Z',
                      }
                    : draft;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
});

test('loads an accessible private draft workspace', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Website drafts' })).toBeVisible();
  await expect(page.getByText('Production remains locked.')).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter((item) => ['critical', 'serious'].includes(item.impact ?? '')),
  ).toEqual([]);
});

test('changes the design and creates a page without code', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();
  await page.getByRole('button', { name: 'settings' }).click();
  await page.getByRole('button', { name: /Evening Bold/ }).click();
  await expect(page.getByRole('button', { name: /Evening Bold/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'content' }).click();
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await expect(page.getByLabel('Choose page')).toContainText('New page');
  await expect(page.getByText(/Production is locked/)).toHaveCount(0);
});
