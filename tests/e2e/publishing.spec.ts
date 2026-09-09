import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import type { DraftRecord } from '../../src/server/repositories/contracts';

type Scenario =
  'immediate' | 'prolonged' | 'failed-then-passed' | 'stale' | 'timed-out' | 'accepted';

const document = structuredClone(defaultSiteDocument);
const draft: DraftRecord = {
  id: '10000000-0000-4000-8000-000000000011',
  siteId: 'pointsite',
  name: 'Guided publishing',
  status: 'active',
  latestRevisionId: '20000000-0000-4000-8000-000000000011',
  document,
  revision: {
    id: '20000000-0000-4000-8000-000000000011',
    draftId: '10000000-0000-4000-8000-000000000011',
    sequence: 7,
    parentRevisionId: null,
    checksum: 'a'.repeat(64),
    document,
    label: null,
    schemaVersion: document.schemaVersion,
    rendererVersion: document.rendererVersion,
    createdBy: 'publisher@pointatx.org',
    createdAt: '2026-09-07T17:00:00Z',
    actionCategory: 'text-edit',
    actionContext: 'page-content',
  },
  createdBy: 'publisher@pointatx.org',
  createdAt: '2026-09-07T17:00:00Z',
  updatedAt: '2026-09-07T17:00:00Z',
  deletedAt: null,
};

async function mockPublishing(
  page: Page,
  scenario: Scenario,
  role: 'publisher' | 'administrator' = 'publisher',
) {
  let verificationRequests = 0;
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
    if (path.endsWith('/checkout'))
      return route.fulfill({
        status: request.method() === 'DELETE' ? 204 : 200,
        contentType: 'application/json',
        body:
          request.method() === 'DELETE'
            ? ''
            : JSON.stringify({
                draftId: draft.id,
                actor: `${role}@pointatx.org`,
                clientId: 'browser-client-0001',
                token: '30000000-0000-4000-8000-000000000001',
                acquiredAt: new Date().toISOString(),
                lastActivityAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
                event: 'acquired',
                viewState: null,
              }),
      });
    if (path.endsWith('/verification')) verificationRequests += 1;
    const passed =
      scenario === 'accepted'
        ? true
        : scenario === 'immediate'
          ? verificationRequests >= 1
          : scenario === 'prolonged'
            ? verificationRequests >= 2
            : scenario === 'failed-then-passed'
              ? verificationRequests >= 2
              : false;
    const failed = scenario === 'failed-then-passed' && verificationRequests === 1;
    const requestedAt =
      scenario === 'timed-out'
        ? new Date(Date.now() - 16 * 60_000).toISOString()
        : new Date().toISOString();
    const job = {
      id: '30000000-0000-4000-8000-000000000011',
      status: 'succeeded',
      candidateChecksum: 'b'.repeat(64),
      draftId: draft.id,
      revisionId: scenario === 'stale' ? '20000000-0000-4000-8000-000000000099' : draft.revision.id,
      revisionChecksum: draft.revision.checksum,
      schemaVersion: document.schemaVersion,
      rendererVersion: document.rendererVersion,
      stagingBaseSha: 'c'.repeat(40),
      stagingCommitSha: 'd'.repeat(40),
      commitUrl: `https://github.com/PointCommunity/pointsite-staging/commit/${'d'.repeat(40)}`,
      requestedAt,
      completedAt: requestedAt,
      evidence: {
        verificationStatus: passed ? 'passed' : failed ? 'failed' : 'pending',
        ...(failed
          ? {
              failedChecks: ['verify', 'deploy'],
              failedCheckUrls: {
                verify: 'https://github.com/PointCommunity/pointsite-staging/actions/runs/11',
                deploy: 'https://github.com/PointCommunity/pointsite-staging/actions/runs/12',
              },
            }
          : {}),
      },
    };
    const body = path.endsWith('/me')
      ? {
          email: 'publisher@pointatx.org',
          role,
          repositoryPermission: 'write',
        }
      : path.endsWith('/drafts')
        ? { items: [draft] }
        : path.includes('/revisions')
          ? { items: [draft.revision] }
          : path.endsWith('/publish/staging/workflow')
            ? {
                currentStagingSha: job.stagingCommitSha,
                reviewUrl: 'https://staging.pointatx.org',
                job,
                approval:
                  scenario === 'accepted'
                    ? {
                        id: '40000000-0000-4000-8000-000000000011',
                        publishJobId: job.id,
                        decision: 'approved',
                        createdAt: new Date().toISOString(),
                      }
                    : null,
              }
            : path.endsWith('/verification')
              ? job
              : path.endsWith('/media')
                ? { items: [] }
                : draft;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
  return () => verificationRequests;
}

async function openPublishing(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
}

test('automatically advances an immediate exact verification', async ({ page }) => {
  await page.clock.install();
  const requests = await mockPublishing(page, 'immediate');
  await openPublishing(page);
  await expect(page.getByText('Verifying the exact Staging candidate')).toBeVisible();
  await expect(page.getByText(/Automatic updates are on/)).toBeVisible();
  await page.clock.runFor(10_000);
  await expect(page.getByText('Staging is ready for review')).toBeVisible();
  expect(requests()).toBe(1);
});

test('keeps following prolonged verification without duplicate publication', async ({ page }) => {
  await page.clock.install();
  const requests = await mockPublishing(page, 'prolonged');
  await openPublishing(page);
  await expect(page.getByText(/Automatic updates are on/)).toBeVisible();
  await page.clock.runFor(10_000);
  await expect(page.getByText('Verifying the exact Staging candidate')).toBeVisible();
  await expect.poll(requests).toBe(1);
  await expect(page.getByRole('button', { name: 'Check now' })).toBeEnabled();
  await page.clock.runFor(10_000);
  await expect(page.getByText('Staging is ready for review')).toBeVisible();
  expect(requests()).toBe(2);
  await expect(page.getByRole('button', { name: /publish .*Staging/i })).toHaveCount(0);
});

test('explains failed verification and recovers with manual refresh', async ({ page }) => {
  await page.clock.install();
  await mockPublishing(page, 'failed-then-passed');
  await openPublishing(page);
  await expect(page.getByText(/Automatic updates are on/)).toBeVisible();
  await page.clock.runFor(10_000);
  await expect(page.getByText('Staging verification failed')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Review 2 failed Staging checks' })).toBeVisible();
  await expect(page.getByText('Website safety checks')).toBeVisible();
  await expect(page.getByText('Staging update', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open website safety check' })).toHaveAttribute(
    'href',
    'https://github.com/PointCommunity/pointsite-staging/actions/runs/11',
  );
  await expect(page.getByText(/Automatic recovery has already checked/i)).toBeVisible();
  await expect(
    page.getByText(/do not publish the draft again just to clear this message/i),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /accept this revision/i })).toHaveCount(0);
  await page.setViewportSize({ width: 760, height: 900 });
  const dialog = page.getByRole('dialog', { name: 'Publish and accept on Staging' });
  await expect(
    dialog.evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).resolves.toBe(true);
  const results = await new AxeBuilder({ page }).include('.publish-modal').analyze();
  expect(
    results.violations.filter((item) => ['critical', 'serious'].includes(item.impact ?? '')),
  ).toEqual([]);
  await page.getByRole('button', { name: 'Check Staging status again' }).click();
  await expect(page.getByText('Staging is ready for review')).toBeVisible();
});

test('marks a changed draft candidate stale and offers safe republication', async ({ page }) => {
  await mockPublishing(page, 'stale');
  await openPublishing(page);
  await expect(page.getByText('A new Staging candidate is required')).toBeVisible();
  await expect(page.getByText(/draft changed/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Publish current revision 7' })).toBeVisible();
  await expect(page.getByRole('button', { name: /accept this revision/i })).toHaveCount(0);
});

test('pauses old pending monitoring with a manual fallback and accessible responsive status', async ({
  page,
}) => {
  await page.setViewportSize({ width: 760, height: 900 });
  await mockPublishing(page, 'timed-out');
  await openPublishing(page);
  await expect(page.getByText('Automatic monitoring paused')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Continue verification' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue verification' })).toBeVisible();
  await expect(page.getByText(/does not publish again/i)).toBeVisible();
  const dialog = page.getByRole('dialog', { name: 'Publish and accept on Staging' });
  await expect(
    dialog.evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).resolves.toBe(true);
  const results = await new AxeBuilder({ page }).include('.publish-modal').analyze();
  expect(
    results.violations.filter((item) => ['critical', 'serious'].includes(item.impact ?? '')),
  ).toEqual([]);
});

test('gives an Administrator a clear Production handoff without an unavailable action', async ({
  page,
}) => {
  await mockPublishing(page, 'accepted', 'administrator');
  await openPublishing(page);
  await expect(page.getByText('Your next step · Administrator')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your Staging work is complete' })).toBeVisible();
  await expect(page.getByText(/No Production action is available here yet/i)).toBeVisible();
  await expect(page.getByText(/organization owner.*Builder Administrator role/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /publish.*production/i })).toHaveCount(0);
});
