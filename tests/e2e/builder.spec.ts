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
    schemaVersion: document.schemaVersion,
    rendererVersion: document.rendererVersion,
    createdBy: 'admin@pointatx.org',
    createdAt: '2026-09-05T00:00:00Z',
    actionCategory: 'text-edit',
    actionContext: 'page-content',
  },
  createdBy: 'admin@pointatx.org',
  createdAt: '2026-09-05T00:00:00Z',
  updatedAt: '2026-09-05T00:00:00Z',
  deletedAt: null,
};

test.beforeEach(async ({ page }) => {
  let publishedToStaging = false;
  let verificationPassed = false;
  let acceptedOnStaging = false;
  const publishTime = new Date().toISOString();
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/drafts/checkouts')
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          items: [{ draftId: draft.id, state: 'available', expiresAt: null }],
        }),
      });
    if (path === '/api/drafts/checkout/owned')
      return route.fulfill({ contentType: 'application/json', body: 'null' });
    if (path.endsWith('/checkout') && request.method() === 'GET')
      return route.fulfill({ contentType: 'application/json', body: '{"active":true}' });
    if (path.endsWith('/checkout'))
      return route.fulfill({
        status: request.method() === 'DELETE' ? 204 : 200,
        contentType: 'application/json',
        body:
          request.method() === 'DELETE'
            ? ''
            : JSON.stringify({
                draftId: draft.id,
                actor: 'admin@pointatx.org',
                clientId: 'browser-client-0001',
                token: '30000000-0000-4000-8000-000000000001',
                acquiredAt: publishTime,
                lastActivityAt: publishTime,
                expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
                event: 'acquired',
                viewState: null,
              }),
      });
    const publishResult = {
      jobId: '30000000-0000-4000-8000-000000000001',
      siteId: 'pointsite',
      revisionId: draft.revision.id,
      revisionChecksum: draft.revision.checksum,
      schemaVersion: document.schemaVersion,
      rendererVersion: document.rendererVersion,
      candidateChecksum: 'c'.repeat(64),
      stagingBaseSha: 'b'.repeat(40),
      commitSha: 'd'.repeat(40),
      url: 'https://github.com/PointCommunity/pointsite-staging/commit/d',
    };
    const workflowJob = {
      id: publishResult.jobId,
      status: 'succeeded',
      candidateChecksum: publishResult.candidateChecksum,
      draftId: draft.id,
      revisionId: publishResult.revisionId,
      revisionChecksum: publishResult.revisionChecksum,
      schemaVersion: publishResult.schemaVersion,
      rendererVersion: publishResult.rendererVersion,
      stagingBaseSha: publishResult.stagingBaseSha,
      stagingCommitSha: publishResult.commitSha,
      commitUrl: publishResult.url,
      requestedAt: publishTime,
      completedAt: publishTime,
      evidence: {
        verificationStatus: verificationPassed ? 'passed' : 'pending',
        ...(verificationPassed
          ? {
              workflowUrl: 'https://github.com/PointCommunity/pointsite-staging/actions/runs/1',
              deploymentUrl: 'https://github.com/PointCommunity/pointsite-staging/actions/runs/2',
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
            }
          : {}),
      },
    };
    if (path.endsWith('/publish/staging') && request.method() === 'POST') publishedToStaging = true;
    if (path.endsWith(`/publish/jobs/${publishResult.jobId}/verification`))
      verificationPassed = true;
    if (path.endsWith('/approvals') && request.method() === 'POST') acceptedOnStaging = true;
    const body = path.endsWith('/me')
      ? { email: 'admin@pointatx.org', role: 'administrator', repositoryPermission: 'admin' }
      : path.endsWith('/drafts')
        ? { items: [draft] }
        : path.includes('/revisions')
          ? { items: [draft.revision] }
          : path.endsWith('/publish/staging/workflow')
            ? {
                currentStagingSha: publishedToStaging
                  ? publishResult.commitSha
                  : publishResult.stagingBaseSha,
                reviewUrl: 'https://staging.pointatx.org',
                job: publishedToStaging ? workflowJob : null,
                approval: acceptedOnStaging
                  ? {
                      id: '40000000-0000-4000-8000-000000000001',
                      publishJobId: publishResult.jobId,
                      decision: 'approved',
                      createdAt: '2026-09-07T12:02:00Z',
                    }
                  : null,
              }
            : path.endsWith('/staging/base')
              ? { sha: 'b'.repeat(40) }
              : path.endsWith('/publish/staging')
                ? publishResult
                : path.endsWith(`/publish/jobs/${publishResult.jobId}/verification`)
                  ? {
                      id: publishResult.jobId,
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

  for (const panel of ['Forms', 'Library', 'Preview', 'History', 'Settings', 'Admin']) {
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
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: /Evening Bold/ }).click();
  await expect(page.getByRole('button', { name: /Evening Bold/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'Layout' }).click();
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await expect(page.getByLabel('Choose page')).toContainText('New page');
  const canvas = page.locator('.visual-editor iframe').contentFrame();
  await expect(canvas.locator('section[aria-label="Site header"]')).toBeVisible();
  await expect(canvas.getByRole('img', { name: 'Point Community Church' })).toBeVisible();
  await expect(canvas.getByRole('navigation', { name: 'Church navigation' })).toBeVisible();
  await expect(page.getByText(/Production is locked/)).toHaveCount(0);
});

test('publishes and accepts only exact verified staging while production stays locked', async ({
  page,
}) => {
  await page.clock.install();
  const productionWrites: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path === '/api/publish/production' && request.method() !== 'GET')
      productionWrites.push(request.method());
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Close publishing window' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(
    page
      .getByRole('dialog', { name: 'Publish and accept on Staging' })
      .evaluate((dialog) => dialog.contains(globalThis.document.activeElement)),
  ).resolves.toBe(true);
  await expect(
    page.getByRole('list', { name: 'Staging publishing progress' }).getByRole('listitem'),
  ).toHaveCount(5);
  await expect(page.getByText('Ready to publish')).toBeVisible();
  await page.getByRole('button', { name: /Publish revision \d+ to Staging/ }).click();
  await expect(page.getByText('Verifying the exact Staging candidate')).toBeVisible();
  await expect(page.getByRole('button', { name: /publish this revision/i })).toHaveCount(0);

  await page.getByRole('button', { name: 'Close publishing window' }).click();
  await expect(page.getByRole('button', { name: 'Publish', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Verifying the exact Staging candidate')).toBeVisible();
  await expect(page.getByText(/Automatic updates are on/)).toBeVisible();
  await page.clock.runFor(10_000);
  await expect(page.getByText('Staging is ready for review')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open Staging for review' })).toHaveAttribute(
    'href',
    'https://staging.pointatx.org',
  );
  await expect(page.getByText('c'.repeat(64))).toBeHidden();
  await page.getByRole('button', { name: 'Accept this Staging version' }).click();
  await expect(page.getByText('Official Staging candidate accepted')).toBeVisible();
  await expect(page.getByText(/public website has not changed/i)).toBeVisible();
  await expect(page.getByText('Production remains unchanged')).toBeVisible();

  await page.getByRole('button', { name: 'Close publishing window' }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Open editor' }).click();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Official Staging candidate accepted')).toBeVisible();
  await expect(page.getByRole('button', { name: /publish this revision/i })).toHaveCount(0);
  expect(productionWrites).toEqual([]);
});
