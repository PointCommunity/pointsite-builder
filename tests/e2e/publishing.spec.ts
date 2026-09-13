import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import { draftAssetFixture } from './draft-asset-fixture';
import type { DraftRecord } from '../../src/server/repositories/contracts';
import type { StagingWorkflowSnapshot } from '../../src/client/publish/workflow';

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
    if (path.endsWith('/publish/production/workflow'))
      return route.fulfill({ contentType: 'application/json', body: '{"enabled":false}' });
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

test('an Administrator recovers saved Production progress after reopening', async ({
  page,
}, testInfo) => {
  await mockPublishing(page, 'accepted', 'administrator');
  let recovered = false;
  const jobId = '50000000-0000-4000-8000-000000000011';
  await page.route('**/api/publish/production/workflow?**', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        enabled: true,
        busy: !recovered,
        job: {
          id: jobId,
          status: recovered ? 'succeeded' : 'running',
          revisionId: draft.revision.id,
          stagingJobId: '30000000-0000-4000-8000-000000000011',
          approvalId: 'acceptance',
          candidateChecksum: 'b'.repeat(64),
          artifactDigest: 'a'.repeat(64),
          baseSha: 'e'.repeat(40),
          commitSha: 'f'.repeat(40),
          requestedAt: new Date(Date.now() - 16 * 60_000).toISOString(),
          completedAt: null,
          evidence: recovered
            ? { verificationStatus: 'passed', artifactDigest: 'a'.repeat(64) }
            : {},
          dispatch: {
            attempts: 1,
            needsAttention: false,
            reserved: true,
            canVerifyCompleted: !recovered,
            retryAt: '2026-09-13T00:00:00Z',
          },
        },
      }),
    });
  });
  await page.route(`**/api/publish/production/jobs/${jobId}/recovery`, async (route) => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().postDataJSON()).toEqual({
      action: 'verify-completed',
      expectedAttempts: 1,
    });
    expect(route.request().headers()['idempotency-key']).toBeTruthy();
    recovered = true;
    await route.fulfill({ contentType: 'application/json', body: '{"recovered":true}' });
  });
  await openPublishing(page);
  await expect(
    page.getByRole('button', { name: 'Verify completed Production publication' }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Open editor' }).click();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  const verify = page.getByRole('button', { name: 'Verify completed Production publication' });
  await expect(verify).toBeVisible();
  await verify.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('This Production publication was verified.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Production', exact: true })).toBeFocused();
  await expect(verify).toHaveCount(0);
  await page.getByText('Production publication details', { exact: true }).click();
  await page
    .locator('.production-lock')
    .screenshot({ path: testInfo.outputPath('production-status.png') });
  const violations = await new AxeBuilder({ page }).include('.production-lock').analyze();
  expect(violations.violations).toEqual([]);
});

test('cloud recovery retains the captured revision and keyboard focus', async ({ page }) => {
  await mockPublishing(page, 'immediate');
  const jobId = '30000000-0000-4000-8000-000000000011';
  const requestedAt = new Date().toISOString();
  const workflow: StagingWorkflowSnapshot = {
    publicationProtocol: 2,
    currentStagingSha: 'c'.repeat(40),
    reviewUrl: 'https://staging.pointatx.org',
    preflight: {
      state: 'passed',
      revisionId: draft.revision.id,
      revisionChecksum: draft.revision.checksum,
      candidateChecksum: 'b'.repeat(64),
      validatedAt: requestedAt,
    },
    availability: { state: 'busy', phase: 'running' },
    approval: null,
    job: {
      id: jobId,
      publicationProtocol: 2,
      workflowRevision: 'e'.repeat(40),
      status: 'queued',
      candidateChecksum: 'b'.repeat(64),
      draftId: draft.id,
      revisionId: draft.revision.id,
      revisionChecksum: draft.revision.checksum,
      schemaVersion: draft.revision.schemaVersion,
      rendererVersion: draft.revision.rendererVersion,
      stagingBaseSha: 'c'.repeat(40),
      stagingCommitSha: null,
      commitUrl: null,
      requestedAt,
      completedAt: null,
      evidence: { verificationStatus: 'pending' },
      dispatch: {
        attempts: 6,
        retryAt: '2026-01-01T00:00:00.000Z',
        needsAttention: true,
        reserved: false,
        canReconcileStopped: false,
      },
    },
  };
  const actions: string[] = [];
  const published: unknown[] = [];
  await page.route('**/api/publish/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/publish/staging/workflow') return route.fulfill({ json: workflow });
    if (path === `/api/publish/jobs/${workflow.job!.id}/recovery`) {
      const body = request.postDataJSON() as { action: string; expectedAttempts: number };
      expect(request.headers()['idempotency-key']).toMatch(/^[a-f0-9-]{36}$/);
      actions.push(body.action);
      expect(body.expectedAttempts).toBe(body.action === 'retry' ? 6 : 0);
      if (body.action === 'retry')
        workflow.job!.dispatch = { ...workflow.job!.dispatch!, attempts: 0, needsAttention: false };
      else if (body.action === 'retry-captured') {
        expect(workflow.job!.id).toBe(jobId);
        workflow.job!.id = '30000000-0000-4000-8000-000000000012';
        workflow.job!.status = 'queued';
        workflow.job!.dispatch!.canRetryCaptured = false;
        workflow.availability = { state: 'busy', phase: 'running' };
      } else if (body.action === 'verify-completed') {
        workflow.job!.status = 'succeeded';
        workflow.job!.dispatch!.canVerifyCompleted = false;
        workflow.job!.evidence = { verificationStatus: 'passed', artifactDigest: 'f'.repeat(64) };
        workflow.currentStagingSha = 'd'.repeat(40);
      } else {
        workflow.job!.status = 'cancelled';
        workflow.job!.dispatch!.canRetryCaptured = true;
        workflow.availability = { state: 'available' };
      }
      return route.fulfill({ json: { recovered: true, jobId: workflow.job!.id } });
    }
    if (path === '/api/publish/staging') {
      published.push(request.postDataJSON() as unknown);
      workflow.job!.id = '30000000-0000-4000-8000-000000000013';
      workflow.job!.status = 'running';
      workflow.job!.stagingCommitSha = 'd'.repeat(40);
      workflow.job!.dispatch = {
        ...workflow.job!.dispatch!,
        reserved: true,
        canRetryCaptured: false,
        canVerifyCompleted: true,
      };
      workflow.availability = { state: 'busy', phase: 'running' };
      return route.fulfill({
        status: 202,
        json: { jobId: workflow.job!.id, status: 'queued', publicationProtocol: 2 },
      });
    }
    throw new Error(`Unexpected cloud browser operation: ${path}`);
  });
  await openPublishing(page);
  const retry = page.getByRole('button', { name: 'Retry queued publication' });
  await expect(retry).toBeEnabled();
  const accessibility = await new AxeBuilder({ page }).include('.publish-panel').analyze();
  expect(accessibility.violations).toEqual([]);
  await retry.focus();
  await page.keyboard.press('Enter');
  await expect(retry).toHaveCount(0);
  await expect(page.locator('#publish-next-action-title')).toBeFocused();
  const cancel = page.getByRole('button', { name: 'Cancel queued publication' });
  await cancel.focus();
  await page.keyboard.press('Enter');
  await expect(cancel).toHaveCount(0);
  await expect(page.locator('#publish-next-action-title')).toBeFocused();
  const captured = page.getByRole('button', { name: 'Retry captured candidate' });
  await expect(captured).toBeEnabled();
  expect((await new AxeBuilder({ page }).include('.publish-panel').analyze()).violations).toEqual(
    [],
  );
  await captured.focus();
  await page.keyboard.press('Enter');
  await expect(captured).toHaveCount(0);
  await expect(page.locator('#publish-next-action-title')).toBeFocused();
  await expect(cancel).toBeEnabled();
  await cancel.focus();
  await page.keyboard.press('Enter');
  await expect(cancel).toHaveCount(0);
  await expect(page.locator('#publish-next-action-title')).toBeFocused();
  await page.getByRole('button', { name: 'Try publishing again' }).click();
  await expect.poll(() => published.length).toBe(1);
  expect(published[0]).toMatchObject({
    draftId: draft.id,
    expectedRevisionId: draft.revision.id,
    expectedRevisionChecksum: draft.revision.checksum,
    expectedBaseSha: 'c'.repeat(40),
  });
  const verify = page.getByRole('button', { name: 'Verify completed deployment' });
  await expect(verify).toBeEnabled();
  await verify.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#publish-next-action-title')).toBeFocused();
  await expect(page.getByText('Staging is ready for review')).toBeVisible();
  expect(actions).toEqual(['retry', 'cancel', 'retry-captured', 'cancel', 'verify-completed']);
  expect(published).toHaveLength(1);
});

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
  await expect(page.getByText(/check recovery after/i)).toBeVisible();
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
  await expect(page.getByText(/Check the Production section below/i)).toBeVisible();
  await expect(page.getByText(/organization owner.*Builder Administrator role/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /publish.*production/i })).toHaveCount(0);
});
