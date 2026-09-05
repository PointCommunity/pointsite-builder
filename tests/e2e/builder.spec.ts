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
    const publishResult = {
      jobId: 'job-1',
      siteId: 'pointsite',
      revisionId: draft.revision.id,
      revisionChecksum: draft.revision.checksum,
      schemaVersion: 1,
      rendererVersion: document.rendererVersion,
      candidateChecksum: 'c'.repeat(64),
      stagingBaseSha: 'b'.repeat(40),
      commitSha: 'd'.repeat(40),
      url: 'https://github.com/PointCommunity/pointsite-staging/commit/d',
    };
    const body = path.endsWith('/me')
      ? { email: 'admin@pointatx.org', role: 'administrator' }
      : path.endsWith('/drafts')
        ? { items: [draft] }
        : path.includes('/revisions')
          ? { items: [draft.revision] }
          : path.endsWith('/staging/base')
            ? { sha: 'b'.repeat(40) }
            : path.endsWith('/publish/staging')
              ? publishResult
              : path.endsWith('/publish/jobs/job-1/verification')
                ? {
                    id: 'job-1',
                    status: 'succeeded',
                    candidateChecksum: publishResult.candidateChecksum,
                    resultSha: publishResult.commitSha,
                    evidence: {
                      verificationStatus: 'passed',
                      workflowUrl:
                        'https://github.com/PointCommunity/pointsite-staging/actions/runs/1',
                      deploymentUrl:
                        'https://github.com/PointCommunity/pointsite-staging/actions/runs/2',
                      checks: {
                        build: true,
                        schema: true,
                        renderer: true,
                        routes: true,
                        assets: true,
                        accessibility: true,
                        responsive: true,
                        security: true,
                        primaryFlow: true,
                        live: true,
                      },
                    },
                  }
                : path.endsWith('/approvals/production-base')
                  ? { sha: 'e'.repeat(40) }
                  : path.endsWith('/approvals')
                    ? {
                        id: 'approval-1',
                        decision: 'approved',
                        tuple: {
                          ...publishResult,
                          stagingCommitSha: publishResult.commitSha,
                          productionBaseSha: 'e'.repeat(40),
                        },
                      }
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

test('keeps every editor panel semantic and free of serious axe findings', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Sunday update' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Skip to main content' })).toHaveAttribute(
    'href',
    '#main-content',
  );

  for (const panel of ['settings', 'media', 'preview', 'history', 'publish', 'admin']) {
    await page.getByRole('button', { name: panel, exact: true }).click();
    const serious = (await new AxeBuilder({ page }).analyze()).violations.filter((item) =>
      ['critical', 'serious'].includes(item.impact ?? ''),
    );
    expect(serious, `${panel} panel axe findings`).toEqual([]);
    expect(
      await page.evaluate(
        () => globalThis.document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
      `${panel} panel horizontal overflow`,
    ).toBe(true);
  }
});

test('supports keyboard bypass, text resizing, reflow, and reduced motion', async ({
  page,
  browserName,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Website drafts' })).toBeVisible();

  const skipLink = page.getByRole('link', { name: 'Skip to main content' });
  if (browserName === 'webkit') {
    // Desktop Safari follows the host's keyboard-navigation preference for links.
    await skipLink.focus();
    await expect(skipLink).toBeFocused();
    await page.keyboard.press('Enter');
  } else {
    await page.keyboard.press('Tab');
    await expect(skipLink).toBeFocused();
    await page.keyboard.press('Enter');
  }
  await expect(page).toHaveURL(/#main-content$/);

  await page.evaluate(() => {
    globalThis.document.documentElement.style.fontSize = '200%';
  });
  const overflow = await page.evaluate(() =>
    [...globalThis.document.querySelectorAll<HTMLElement>('body *')]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.right > window.innerWidth + 1 || rect.left < -1;
      })
      .map((element) => ({
        element: element.tagName.toLowerCase(),
        className: element.className,
        right: Math.round(element.getBoundingClientRect().right),
      })),
  );
  expect(overflow).toEqual([]);
  expect(
    await page.getByRole('button', { name: 'Open editor' }).evaluate((element) =>
      getComputedStyle(element)
        .transitionDuration.split(',')
        .every((duration) => Number.parseFloat(duration) <= 0.00001),
    ),
  ).toBe(true);
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

test('publishes and accepts only exact verified staging while production stays locked', async ({
  page,
}) => {
  const productionWrites: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path === '/api/publish/production' && request.method() !== 'GET')
      productionWrites.push(request.method());
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();
  await page.getByRole('button', { name: 'publish' }).click();
  await page.getByRole('button', { name: 'Publish to staging' }).click();
  await expect(page.getByText(/CI verification is now running/)).toBeVisible();
  await page.getByRole('button', { name: 'Check staging verification' }).click();
  await expect(page.getByText(/All mandatory staging evidence passed/)).toBeVisible();
  await page.getByRole('button', { name: 'Accept exact staging candidate' }).click();
  await expect(page.getByText(/Staging accepted for this exact candidate/)).toBeVisible();
  await expect(page.getByText('Production is locked')).toBeVisible();
  expect(productionWrites).toEqual([]);
});
