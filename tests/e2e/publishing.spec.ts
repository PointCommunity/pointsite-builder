import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import { draftAssetFixture } from './draft-asset-fixture';
import type { DraftRecord } from '../../src/server/repositories/contracts';
import type { StagingWorkflowSnapshot } from '../../src/client/publish/workflow';

const publicDestination = { repository: 'pointsite', origin: 'https://pointatx.org' };

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
    if (path === '/api/publish/production/rollback' && request.method() === 'GET')
      return route.fulfill({ json: { enabled: false } });
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

for (const canary of [false, true])
  test(`compact publishing sends accepted Staging to ${canary ? 'Canary' : 'Production'} with Help and confirmation`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 760, height: 900 });
    await page.clock.install();
    await mockPublishing(page, 'accepted', 'administrator');
    const label = canary ? 'Site Canary' : 'Site Production';
    const origin = canary ? 'https://canary.pointatx.org' : 'https://pointatx.org';
    const stagingOrigin = canary
      ? 'https://staging-canary.pointatx.org'
      : 'https://staging.pointatx.org';
    const tuple = {
      siteId: 'pointsite',
      publicationProtocol: 2,
      revisionId: draft.revision.id,
      revisionChecksum: draft.revision.checksum,
      schemaVersion: draft.document.schemaVersion,
      rendererVersion: draft.document.rendererVersion,
      candidateChecksum: 'b'.repeat(64),
      stagingBaseSha: 'c'.repeat(40),
      stagingCommitSha: 'd'.repeat(40),
      productionBaseSha: 'e'.repeat(40),
      workflowRevision: 'f'.repeat(40),
      artifactDigest: '1'.repeat(64),
    };
    const approval = {
      id: 'acceptance',
      publishJobId: 'staging',
      decision: 'approved',
      createdAt: new Date().toISOString(),
      tuple,
    };
    await page.route('**/api/publish/staging/workflow?**', (route) =>
      route.fulfill({
        json: {
          publicationProtocol: 2,
          currentStagingSha: tuple.stagingCommitSha,
          reviewUrl: stagingOrigin,
          preflight: { state: 'required', reason: 'not-validated' },
          availability: { state: 'available' },
          approval,
          job: {
            ...tuple,
            id: 'staging',
            draftId: draft.id,
            status: 'succeeded',
            requestedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            evidence: { verificationStatus: 'passed', artifactDigest: tuple.artifactDigest },
          },
        },
      }),
    );
    let progress = 0;
    const captures: unknown[] = [];
    await page.route('**/api/publish/production/workflow?**', (route) => {
      const stage = progress;
      if (progress > 0 && progress < 3) progress++;
      return route.fulfill({
        json: {
          enabled: true,
          destination: { repository: canary ? 'pointsite-canary' : 'pointsite', origin },
          busy: stage > 0 && stage < 3,
          job: stage
            ? {
                id: 'production',
                status: stage === 3 ? 'succeeded' : 'running',
                revisionId: tuple.revisionId,
                candidateChecksum: tuple.candidateChecksum,
                stagingJobId: 'staging',
                approvalId: approval.id,
                artifactDigest: tuple.artifactDigest,
                requestedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
                completedAt: null,
                dispatch: {
                  attempts: 1,
                  reserved: true,
                  needsAttention: false,
                  stage: stage === 1 ? 'building' : 'verifying',
                  retryAt: new Date().toISOString(),
                },
                evidence:
                  stage === 3
                    ? { verificationStatus: 'passed', artifactDigest: tuple.artifactDigest }
                    : {},
              }
            : null,
        },
      });
    });
    await page.route('**/api/publish/production', (route) => {
      captures.push(route.request().postDataJSON());
      progress = 1;
      return route.fulfill({ status: 202, json: { id: 'production', status: 'queued' } });
    });
    await openPublishing(page);
    const panel = page.getByRole('dialog', { name: 'Publish your site' });
    const helpButton = page.getByRole('button', { name: 'Publishing help' });
    await helpButton.click();
    await expect(page.getByRole('dialog', { name: 'Publishing help' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Publishing help' })).toHaveCount(0);
    await expect(panel).toBeVisible();
    await expect(helpButton).toBeFocused();
    await expect(page.locator('.technical-details')).not.toHaveAttribute('open', '');
    const publish = page.getByRole('button', { name: `Publish to ${label}`, exact: true });
    await publish.click();
    let confirm = page.getByRole('dialog', { name: `Publish to ${label}?` });
    await expect(confirm.getByRole('link', { name: stagingOrigin })).toHaveAttribute(
      'target',
      '_blank',
    );
    await expect(confirm.getByRole('link', { name: origin })).toHaveAttribute('target', '_blank');
    expect(captures).toHaveLength(0);
    await page.keyboard.press('Escape');
    await expect(publish).toBeFocused();
    await publish.click();
    confirm = page.getByRole('dialog', { name: `Publish to ${label}?` });
    await expect(
      confirm.evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).resolves.toBe(true);
    expect((await new AxeBuilder({ page }).include('dialog[open]').analyze()).violations).toEqual(
      [],
    );
    await confirm.getByRole('button', { name: `Confirm publish to ${label}` }).click();
    await expect(page.getByText('Building your website')).toBeVisible();
    await page.clock.runFor(10_000);
    await expect(page.getByText('Checking the published website')).toBeVisible();
    await page.clock.runFor(10_000);
    await expect(
      page.getByRole('heading', { name: `Congratulations! Your site is live in ${label}.` }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: `Open ${label}` })).toHaveAttribute('href', origin);
    expect(captures).toEqual([{ stagingJobId: 'staging', approvalId: approval.id, tuple }]);
    await expect(page.getByRole('button', { name: /accept/i })).toHaveCount(0);
    await expect(
      panel.evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).resolves.toBe(true);
    await panel.screenshot({ path: testInfo.outputPath('publishing-complete.png') });
    expect((await new AxeBuilder({ page }).include('.publish-panel').analyze()).violations).toEqual(
      [],
    );
  });

test('saves an in-memory schema upgrade before publishing without requiring an edit', async ({
  page,
}) => {
  const selected = structuredClone(draft);
  selected.revision.schemaVersion = 9;
  selected.revision.rendererVersion = '9.0.0';
  await mockPublishing(page, 'stale', 'administrator', selected);
  let saves = 0;
  await page.route(`**/api/drafts/${selected.id}`, async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    saves++;
    expect(route.request().headers()['if-match']).toBe(`"${draft.revision.checksum}"`);
    expect(route.request().headers()['x-draft-checkout']).toBeTruthy();
    expect(route.request().postDataJSON()).toMatchObject({ document: draft.document });
    selected.latestRevisionId = '20000000-0000-4000-8000-000000000070';
    selected.revision = {
      ...selected.revision,
      id: selected.latestRevisionId,
      sequence: 8,
      checksum: 'f'.repeat(64),
      schemaVersion: 10,
      rendererVersion: '10.0.0',
    };
    await route.fulfill({ json: selected });
  });
  const published: unknown[] = [];
  await page.route('**/api/publish/staging/preflight', async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({
      expectedRevisionId: selected.latestRevisionId,
      expectedRevisionChecksum: 'f'.repeat(64),
    });
    await route.fulfill({
      json: {
        state: 'passed',
        revisionId: selected.latestRevisionId,
        revisionChecksum: 'f'.repeat(64),
        candidateChecksum: 'b'.repeat(64),
        validatedAt: new Date().toISOString(),
      },
    });
  });
  await page.route('**/api/publish/staging', async (route) => {
    published.push(route.request().postDataJSON());
    await route.fulfill({
      status: 202,
      json: {
        jobId: '30000000-0000-4000-8000-000000000070',
        status: 'queued',
        publicationProtocol: 2,
      },
    });
  });
  await openPublishing(page);
  await page.getByRole('button', { name: 'Publish to Staging' }).click();
  await expect.poll(() => published.length).toBe(1);
  expect(published[0]).toMatchObject({
    expectedRevisionId: selected.latestRevisionId,
    expectedRevisionChecksum: 'f'.repeat(64),
  });
  expect(saves).toBe(1);
  await page.reload();
  await page.getByRole('button', { name: 'Open editor' }).click();
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
  expect(saves).toBe(1);
});

test('Production restore requires a separate confirmation and keeps the captured choice', async ({
  page,
}) => {
  await mockPublishing(page, 'accepted', 'administrator');
  await page.route('**/api/publish/production/workflow?**', (route) =>
    route.fulfill({
      json: { enabled: true, destination: publicDestination, busy: false, job: null },
    }),
  );
  let restored = false;
  const captured = {
    baseSha: 'a'.repeat(40),
    previousDeploymentId: '123',
    previousReleaseId: 'baseline',
  };
  const mutations: string[] = [];
  await page.route('**/api/publish/production/rollback**', async (route) => {
    const request = route.request();
    if (request.method() === 'GET')
      return route.fulfill({
        json: {
          enabled: true,
          destination: publicDestination,
          publicationJobId: null,
          releases: [
            {
              id: 'baseline',
              kind: 'baseline',
              verifiedAt: '2026-09-13T00:00:00Z',
              artifactDigest: 'b'.repeat(64),
            },
          ],
          job: restored
            ? {
                id: 'rollback',
                sourceReleaseId: 'baseline',
                status: 'queued',
                attempts: 1,
                canVerify: false,
                requestedAt: new Date().toISOString(),
              }
            : null,
        },
      });
    expect(request.method()).toBe('POST');
    expect(request.headers()['idempotency-key']).toMatch(/^[a-f0-9-]{36}$/);
    if (new URL(request.url()).pathname.endsWith('/prepare')) {
      mutations.push('prepare');
      return route.fulfill({ json: captured });
    }
    expect(request.postDataJSON()).toEqual({ ...captured, sourceReleaseId: 'baseline' });
    mutations.push('restore');
    restored = true;
    return route.fulfill({ status: 202, json: { id: 'rollback', status: 'queued' } });
  });
  await openPublishing(page);
  await page.getByText('Danger zone', { exact: true }).click();
  const prepare = page.getByRole('button', { name: 'Prepare selected restore' });
  await expect(prepare).toBeDisabled();
  await page.getByLabel('Verified release').selectOption('baseline');
  await prepare.click();
  const confirm = page.getByRole('button', { name: 'Restore selected release to Site Production' });
  await expect(confirm).toBeEnabled();
  expect(mutations).toEqual(['prepare']);
  expect(
    (
      await new AxeBuilder({ page })
        .include('section[aria-labelledby="production-rollback-heading"]')
        .analyze()
    ).violations,
  ).toEqual([]);
  await confirm.focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByText('The captured rollback continues in the cloud after you close Builder.'),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Restore a Site Production release' }),
  ).toBeFocused();
  expect(mutations).toEqual(['prepare', 'restore']);
});

for (const target of ['staging', 'production'] as const)
  test(`${target} verification survives reopening and recovers without publishing again`, async ({
    page,
  }, testInfo) => {
    await mockPublishing(page, 'accepted', 'administrator');
    const jobId = '50000000-0000-4000-8000-000000000061';
    let verified = false;
    let verification: null | {
      id: string;
      status: string;
      attempt: number;
      dispatchAttempts: number;
      reported: boolean;
      requestedAt: string;
      retryAt: string;
      needsAttention: boolean;
    } = null;
    const actions: string[] = [];
    await page.route('**/api/publish/**', async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === '/api/publish/production/rollback' && request.method() === 'GET')
        return route.fulfill({ json: { enabled: false } });
      if (path === `/api/publish/${target}/workflow`) {
        const job = {
          id: jobId,
          publicationProtocol: 2,
          workflowRevision: 'e'.repeat(40),
          status: verified ? 'succeeded' : 'running',
          candidateChecksum: 'b'.repeat(64),
          draftId: draft.id,
          revisionId: draft.revision.id,
          revisionChecksum: draft.revision.checksum,
          schemaVersion: draft.revision.schemaVersion,
          rendererVersion: draft.revision.rendererVersion,
          stagingBaseSha: 'c'.repeat(40),
          stagingCommitSha: 'd'.repeat(40),
          commitUrl: null,
          stagingJobId: 'staging',
          approvalId: 'approval',
          artifactDigest: 'a'.repeat(64),
          baseSha: 'c'.repeat(40),
          commitSha: 'd'.repeat(40),
          requestedAt: new Date().toISOString(),
          completedAt: null,
          evidence: verified
            ? { verificationStatus: 'passed', artifactDigest: 'a'.repeat(64) }
            : {},
          dispatch: {
            attempts: 1,
            reserved: true,
            needsAttention: false,
            canVerifyOutput: !verified,
            retryAt: new Date().toISOString(),
          },
        };
        return route.fulfill({
          json:
            target === 'production'
              ? { enabled: true, destination: publicDestination, busy: !verified, job }
              : {
                  publicationProtocol: 2,
                  currentStagingSha: 'd'.repeat(40),
                  reviewUrl: 'https://staging.pointatx.org',
                  preflight: {
                    state: 'passed',
                    revisionId: draft.revision.id,
                    revisionChecksum: draft.revision.checksum,
                    candidateChecksum: 'b'.repeat(64),
                    validatedAt: new Date().toISOString(),
                  },
                  availability: { state: 'busy', phase: verified ? 'review' : 'running' },
                  approval: null,
                  job,
                },
        });
      }
      if (path === `/api/publish/${target}/jobs/${jobId}/verification`) {
        if (request.method() === 'GET') return route.fulfill({ json: { verification } });
        expect(request.postDataJSON()).toEqual({ expectedAttempts: 1 });
        expect(request.headers()['idempotency-key']).toMatch(/^[a-f0-9-]{36}$/);
        actions.push('capture');
        verification = {
          id: '60000000-0000-4000-8000-000000000061',
          status: 'queued',
          attempt: 1,
          dispatchAttempts: 6,
          reported: false,
          requestedAt: new Date().toISOString(),
          retryAt: new Date().toISOString(),
          needsAttention: true,
        };
        return route.fulfill({
          status: 202,
          json: { recovered: true, verificationId: verification.id },
        });
      }
      if (
        path === `/api/publish/${target}/jobs/${jobId}/verification/${verification?.id}/recovery`
      ) {
        const body = request.postDataJSON() as { action: string; expectedDispatches: number };
        actions.push(body.action);
        expect(request.headers()['idempotency-key']).toMatch(/^[a-f0-9-]{36}$/);
        if (body.action === 'retry') {
          expect(body.expectedDispatches).toBe(6);
          verification = {
            ...verification!,
            id: '60000000-0000-4000-8000-000000000062',
            status: 'running',
            attempt: 2,
            dispatchAttempts: 0,
            needsAttention: false,
            reported: true,
          };
          return route.fulfill({ json: { recovered: true, verificationId: verification.id } });
        }
        expect(body).toEqual({ action: 'reconcile', expectedDispatches: 0 });
        verified = true;
        verification!.status = 'passed';
        return route.fulfill({ json: { recovered: true } });
      }
      if (target === 'production' && path === '/api/publish/staging/workflow')
        return route.fallback();
      if (target === 'staging' && path === '/api/publish/production/workflow')
        return route.fulfill({ json: { enabled: false } });
      throw new Error(`Unexpected publication mutation during verification: ${path}`);
    });
    await openPublishing(page);
    await page.getByRole('button', { name: 'Verify existing publication' }).click();
    const region = page.getByRole('region', {
      name: `${target === 'staging' ? 'Staging' : 'Site Production'} verification`,
    });
    await expect(region.getByRole('button', { name: 'Retry stopped verification' })).toBeVisible();
    expect(
      (
        await new AxeBuilder({ page })
          .include(`section[aria-labelledby="${target}-verification-heading"]`)
          .analyze()
      ).violations,
    ).toEqual([]);
    await region.screenshot({ path: testInfo.outputPath(`${target}-verification.png`) });
    await page.reload();
    await page.getByRole('button', { name: 'Open editor' }).click();
    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    const retry = page.getByRole('button', { name: 'Retry stopped verification' });
    await retry.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator(`#${target}-verification-heading`)).toBeFocused();
    await page.getByRole('button', { name: 'Finish verification' }).click();
    await expect(region).toHaveCount(0);
    await expect(
      page.locator(target === 'staging' ? '#publish-next-action-title' : '#production-heading'),
    ).toBeFocused();
    expect(actions).toEqual(['capture', 'retry', 'reconcile']);
  });

for (const site of ['Canary', 'Production'])
  test(`an Administrator recovers saved Site ${site} progress after reopening`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: site === 'Canary' ? 760 : 1280, height: 900 });
    await mockPublishing(page, 'accepted', 'administrator');
    const label = `Site ${site}`;
    const destination =
      site === 'Canary'
        ? { repository: 'pointsite-canary', origin: 'https://canary.pointatx.org' }
        : publicDestination;
    let recovered = false;
    const jobId = '50000000-0000-4000-8000-000000000011';
    await page.route('**/api/publish/production/workflow?**', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          enabled: true,
          destination,
          busy: !recovered,
          job: {
            id: jobId,
            status: recovered ? 'succeeded' : 'running',
            revisionId: draft.revision.id,
            stagingJobId: '30000000-0000-4000-8000-000000000011',
            approvalId: '40000000-0000-4000-8000-000000000011',
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
    await expect(page.getByRole('heading', { name: `Publishing to ${label}` })).toBeVisible();
    await expect(
      page.getByRole('button', { name: `Verify completed ${label} publication` }),
    ).toBeVisible();
    await page.reload();
    await page.getByRole('button', { name: 'Open editor' }).click();
    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    const verify = page.getByRole('button', { name: `Verify completed ${label} publication` });
    await expect(verify).toBeVisible();
    await verify.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Publication completed and verified.')).toBeVisible();
    await expect(page.getByRole('heading', { name: /Congratulations/ })).toBeFocused();
    await expect(verify).toHaveCount(0);
    await page.getByText('Technical details', { exact: true }).click();
    await page
      .locator('.publish-panel')
      .screenshot({ path: testInfo.outputPath('production-status.png') });
    const violations = await new AxeBuilder({ page }).include('.publish-panel').analyze();
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
        workflow.job!.revisionId = '20000000-0000-4000-8000-000000000099';
        workflow.job!.evidence = {
          verificationStatus: 'passed',
          artifactDigest: 'f'.repeat(64),
          verification: { dispatchRevision: '9'.repeat(40) },
        };
        workflow.currentStagingSha = '9'.repeat(40);
        workflow.availability = { state: 'busy', phase: 'review' };
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
  await page.getByText('Cancel this publication', { exact: true }).click();
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
  if (!(await cancel.isVisible()))
    await page.getByText('Cancel this publication', { exact: true }).click();
  await expect(cancel).toBeEnabled();
  await cancel.focus();
  await page.keyboard.press('Enter');
  await expect(cancel).toHaveCount(0);
  await expect(page.locator('#publish-next-action-title')).toBeFocused();
  await page.getByRole('button', { name: 'Publish to Staging' }).click();
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
  await expect(page.getByText('Review Staging, then accept this version')).toBeVisible();
  await expect(page.getByText('Newer draft edits are not included.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Accept this Staging version' })).toBeEnabled();
  expect(actions).toEqual(['retry', 'cancel', 'retry-captured', 'cancel', 'verify-completed']);
  expect(published).toHaveLength(1);
});

test('automatically advances an immediate exact verification', async ({ page }) => {
  await page.clock.install();
  const requests = await mockPublishing(page, 'immediate');
  await openPublishing(page);
  await expect(page.getByText('No action needed — Builder is verifying Staging')).toBeVisible();
  await expect(page.getByText(/Progress updates automatically/)).toBeVisible();
  await page.clock.runFor(10_000);
  await expect(page.getByText('Review Staging, then accept this version')).toBeVisible();
  expect(requests()).toBe(1);
});

test('keeps following prolonged verification without duplicate publication', async ({ page }) => {
  await page.clock.install();
  const requests = await mockPublishing(page, 'prolonged');
  await openPublishing(page);
  await expect(page.getByText(/Progress updates automatically/)).toBeVisible();
  await page.clock.runFor(10_000);
  await expect(page.getByText('No action needed — Builder is verifying Staging')).toBeVisible();
  await expect.poll(requests).toBe(1);
  await expect(page.getByRole('button', { name: 'Publish to Staging' })).toHaveCount(0);
  await page.clock.runFor(10_000);
  await expect(page.getByText('Review Staging, then accept this version')).toBeVisible();
  expect(requests()).toBe(2);
  await expect(page.getByRole('button', { name: /publish .*Staging/i })).toHaveCount(0);
});

test('explains failed verification and recovers with manual refresh', async ({ page }) => {
  await page.clock.install();
  await mockPublishing(page, 'failed-then-passed');
  await openPublishing(page);
  await expect(page.getByText(/Progress updates automatically/)).toBeVisible();
  await page.clock.runFor(10_000);
  await expect(page.getByRole('heading', { name: 'Staging needs attention' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy support details' })).toBeVisible();
  await expect(page.locator('.technical-details')).not.toHaveAttribute('open', '');
  await expect(page.getByRole('button', { name: 'Accept this Staging version' })).toHaveCount(0);
  await page.setViewportSize({ width: 760, height: 900 });
  const dialog = page.getByRole('dialog', { name: 'Publish your site' });
  await expect(
    dialog.evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).resolves.toBe(true);
  const results = await new AxeBuilder({ page }).include('.publish-modal').analyze();
  expect(
    results.violations.filter((item) => ['critical', 'serious'].includes(item.impact ?? '')),
  ).toEqual([]);
  await page.getByRole('button', { name: 'Check Staging status' }).click();
  await expect(page.getByText('Review Staging, then accept this version')).toBeVisible();
});

test('marks a replaced Staging candidate stale and offers safe republication', async ({ page }) => {
  await mockPublishing(page, 'stale');
  await openPublishing(page);
  await expect(page.getByText('Publish the current revision 7')).toBeVisible();
  await expect(page.getByText(/Builder checks this saved version/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Publish to Staging' })).toBeVisible();
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
    await expect(earlierPage.getByText('Publish the current revision 7')).toBeVisible();
    await expect(earlierPage.getByRole('button', { name: 'Publish to Staging' })).toBeVisible();
    await expect(
      currentPage.getByRole('heading', { level: 1, name: 'Christmas site' }),
    ).toBeVisible();
    await expect(currentPage.getByText('Staging accepted')).toBeVisible();
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
  await expect(page.getByText('Wait for Staging to become available')).toBeVisible();
  await expect(page.getByText(/Another publication is using Staging/)).toBeVisible();
  await page.clock.runFor(10_000);
  expect(publicationRequests).toBe(0);
});

test('keeps old publication progress live with accessible responsive status', async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 900 });
  await page.clock.install();
  const reads = await mockPublishing(page, 'timed-out');
  await openPublishing(page);
  await expect(page.getByText(/Progress updates automatically/)).toBeVisible();
  await page.clock.runFor(10_000);
  await expect.poll(reads).toBe(1);
  const dialog = page.getByRole('dialog', { name: 'Publish your site' });
  await expect(
    dialog.evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).resolves.toBe(true);
  expect((await new AxeBuilder({ page }).include('.publish-modal').analyze()).violations).toEqual(
    [],
  );
});

test('gives an Administrator a clear Production handoff without an unavailable action', async ({
  page,
}) => {
  await mockPublishing(page, 'accepted', 'administrator');
  await openPublishing(page);

  await expect(page.getByRole('heading', { name: 'Staging accepted' })).toBeVisible();
  await expect(page.getByText(/Public site publishing is not enabled/)).toBeVisible();
  await expect(page.getByRole('button', { name: /publish.*production/i })).toHaveCount(0);
});
