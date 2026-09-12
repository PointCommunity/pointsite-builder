import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import { draftAssetFixture } from './draft-asset-fixture';
import type { DraftRecord } from '../../src/server/repositories/contracts';

type Scenario =
  'immediate' | 'prolonged' | 'failed-then-passed' | 'stale' | 'timed-out' | 'accepted' | 'busy';

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

const alternativeDraft: DraftRecord = {
  ...draft,
  id: '10000000-0000-4000-8000-000000000012',
  name: 'Christmas site',
  latestRevisionId: '20000000-0000-4000-8000-000000000012',
  document: structuredClone(document),
  revision: {
    ...draft.revision,
    id: '20000000-0000-4000-8000-000000000012',
    draftId: '10000000-0000-4000-8000-000000000012',
    checksum: 'f'.repeat(64),
    document: structuredClone(document),
  },
};

async function mockPublishing(
  page: Page,
  scenario: Scenario,
  role: 'publisher' | 'administrator' = 'publisher',
  selectedDraft: DraftRecord = draft,
) {
  let verificationRequests = 0;
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/assets')) {
      return route.fulfill(draftAssetFixture(request.url()));
    }
    if (path === '/api/drafts/checkouts')
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          items: [{ draftId: selectedDraft.id, state: 'available', expiresAt: null }],
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
                draftId: selectedDraft.id,
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
      draftId: selectedDraft.id,
      revisionId: selectedDraft.revision.id,
      revisionChecksum: selectedDraft.revision.checksum,
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
        ? { items: [selectedDraft] }
        : path.includes('/revisions')
          ? { items: [selectedDraft.revision] }
          : path.endsWith('/publish/staging/workflow')
            ? {
                currentStagingSha: scenario === 'stale' ? 'e'.repeat(40) : job.stagingCommitSha,
                reviewUrl: 'https://staging.pointatx.org',
                preflight: {
                  state: 'passed',
                  revisionId: selectedDraft.revision.id,
                  revisionChecksum: selectedDraft.revision.checksum,
                  candidateChecksum: job.candidateChecksum,
                  validatedAt: requestedAt,
                },
                availability:
                  scenario === 'busy'
                    ? {
                        state: 'busy',
                        phase: 'running',
                        retryAt: new Date(Date.now() + 15 * 60_000).toISOString(),
                      }
                    : { state: 'available' },
                job: scenario === 'busy' ? null : job,
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
              : path.endsWith('/library')
                ? {
                    draftId: selectedDraft.id,
                    revisionId: selectedDraft.latestRevisionId,
                    revisionChecksum: selectedDraft.revision.checksum,
                    items: [],
                    activeCount: 0,
                    archivedCount: 0,
                  }
                : selectedDraft;
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

test('marks a replaced Staging candidate stale and offers safe republication', async ({ page }) => {
  await mockPublishing(page, 'stale');
  await openPublishing(page);
  await expect(page.getByText('No longer current on Staging')).toBeVisible();
  await expect(page.getByText(/another accepted or published candidate/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Publish current revision 7' })).toBeVisible();
  await expect(page.getByRole('button', { name: /accept this revision/i })).toHaveCount(0);
});

test('keeps replaced and current candidates associated with separate drafts across sessions', async ({
  browser,
}, testInfo) => {
  const baseURL = String(testInfo.project.use.baseURL);
  const earlierContext = await browser.newContext({ baseURL });
  const currentContext = await browser.newContext({ baseURL });
  try {
    const earlierPage = await earlierContext.newPage();
    const currentPage = await currentContext.newPage();
    await mockPublishing(earlierPage, 'stale', 'publisher', draft);
    await mockPublishing(currentPage, 'accepted', 'administrator', alternativeDraft);

    await Promise.all([openPublishing(earlierPage), openPublishing(currentPage)]);
    await expect(
      earlierPage.getByRole('heading', { level: 1, name: 'Guided publishing' }),
    ).toBeVisible();
    await expect(earlierPage.getByText('No longer current on Staging')).toBeVisible();
    await expect(
      earlierPage.getByRole('button', { name: 'Publish current revision 7' }),
    ).toBeVisible();
    await expect(
      currentPage.getByRole('heading', { level: 1, name: 'Christmas site' }),
    ).toBeVisible();
    await expect(currentPage.getByText('Official Staging candidate accepted')).toBeVisible();
  } finally {
    await Promise.all([earlierContext.close(), currentContext.close()]);
  }
});

test('waits for an occupied shared Staging slot without publishing or exposing another draft', async ({
  page,
}) => {
  await page.clock.install();
  let publicationRequests = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/publish/staging')
      publicationRequests += 1;
  });
  await mockPublishing(page, 'busy');
  await openPublishing(page);
  await expect(page.getByText('Staging is currently in use')).toBeVisible();
  await expect(page.getByText(/without queuing or interrupting/i)).toBeVisible();
  await expect(page.getByText(/another publication is currently publishing/i)).toBeVisible();
  await expect(page.getByText(/safely recover the slot after/i)).toBeVisible();
  await page.clock.runFor(10_000);
  expect(publicationRequests).toBe(0);
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
