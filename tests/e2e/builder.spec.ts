import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import { draftAssetFixture } from './draft-asset-fixture';
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
  let preflightPassed = false;
  let verificationPassed = false;
  let acceptedOnStaging = false;
  const publishTime = new Date().toISOString();
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
    if (path.endsWith('/publish/staging/preflight') && request.method() === 'POST')
      preflightPassed = true;
    if (path.endsWith('/publish/staging') && request.method() === 'POST') publishedToStaging = true;
    if (path.endsWith(`/publish/jobs/${publishResult.jobId}/verification`))
      verificationPassed = true;
    if (path.endsWith('/approvals') && request.method() === 'POST') acceptedOnStaging = true;
    if (path.endsWith('/publish/production/workflow'))
      return route.fulfill({ contentType: 'application/json', body: '{"enabled":false}' });
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
                preflight: preflightPassed
                  ? {
                      state: 'passed',
                      revisionId: draft.revision.id,
                      revisionChecksum: draft.revision.checksum,
                      candidateChecksum: publishResult.candidateChecksum,
                      validatedAt: publishTime,
                    }
                  : { state: 'required', reason: 'not-validated' },
                availability: { state: 'available' },
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
              : path.endsWith('/publish/staging/preflight')
                ? {
                    state: 'passed',
                    revisionId: draft.revision.id,
                    revisionChecksum: draft.revision.checksum,
                    candidateChecksum: publishResult.candidateChecksum,
                    validatedAt: publishTime,
                  }
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
                        : path.endsWith('/library')
                          ? {
                              draftId: draft.id,
                              revisionId: draft.latestRevisionId,
                              revisionChecksum: draft.revision.checksum,
                              items: [],
                              activeCount: 0,
                              archivedCount: 0,
                            }
                          : path.endsWith('/admin/roles')
                            ? { items: [] }
                            : path.endsWith('/admin/audit')
                              ? { items: [] }
                              : path.endsWith('/admin/capacity')
                                ? {
                                    storage: {
                                      allocatedBytes: null,
                                      privateMediaBytes: 0,
                                      revisionPayloadBytes: 0,
                                      receiptPayloadBytes: 0,
                                    },
                                    activity: {
                                      auditEvents: 0,
                                      periodStart: '2026-09-05T00:00:00Z',
                                      periodEnd: '2026-09-05T00:00:00Z',
                                    },
                                    providerUsage: {
                                      state: 'unknown',
                                      reason: 'Provider counters unavailable.',
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
  await expect(page.getByText(/Public site publishing requires an Administrator/)).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter((item) => ['critical', 'serious'].includes(item.impact ?? '')),
  ).toEqual([]);
});

test('audits configuration density across supported widths and text sizes', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor', exact: true }).click();
  const findings: unknown[] = [];
  for (const theme of ['light', 'dark']) {
    const toggle = page.getByRole('button', {
      name: `${theme === 'light' ? 'Light' : 'Dark'} mode`,
      exact: true,
    });
    if (await toggle.count()) await toggle.click();
    for (const width of [721, 744, 810, 820, 834, 1024, 1032, 1280, 1440, 1920, 2560]) {
      await page.setViewportSize({ width, height: 1024 });
      for (const scale of [1, 2]) {
        await page.evaluate((scale) => {
          globalThis.document.documentElement.style.fontSize = `${scale * 100}%`;
        }, scale);
        for (const panel of [
          'Layout',
          'Navigation',
          'Forms',
          'Library',
          'Preview',
          'History',
          'Settings',
          'Admin',
        ]) {
          const picker = page.getByRole('combobox', { name: 'Editor section', exact: true });
          if (width <= 1100) await picker.selectOption({ label: panel });
          else await page.getByRole('button', { name: panel, exact: true }).click();
          const measure = async (surface: string) => {
            const metrics = await page.evaluate(() => ({
              headerOverlaps: (() => {
                const elements = [
                  ...globalThis.document.querySelectorAll<HTMLElement>(
                    '.editor-header button, .editor-header summary, .editor-header h1, .save-state',
                  ),
                ].filter((el) => el.getClientRects().length);
                return elements.flatMap((first, index) =>
                  elements
                    .slice(index + 1)
                    .filter((second) => {
                      const a = first.getBoundingClientRect(),
                        b = second.getBoundingClientRect();
                      return (
                        Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
                        Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1
                      );
                    })
                    .map((second) => [first.textContent, second.textContent]),
                );
              })(),
              rootOverflow: Math.max(
                0,
                globalThis.document.documentElement.scrollWidth - innerWidth,
              ),
              clippedControls: [
                ...globalThis.document.querySelectorAll<HTMLElement>(
                  'main input, main select, main textarea, main button, [role=dialog] button',
                ),
              ]
                .filter(
                  (el) =>
                    el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden',
                )
                .filter((el) => {
                  const rect = el.getBoundingClientRect();
                  return rect.left < -1 || rect.right > innerWidth + 1;
                })
                .map((el) => ({
                  name:
                    el.getAttribute('aria-label') ||
                    el.closest('label')?.textContent?.slice(0, 60) ||
                    el.textContent?.slice(0, 60) ||
                    el.tagName,
                  left: el.getBoundingClientRect().left,
                  right: el.getBoundingClientRect().right,
                  parentWidth: el.parentElement?.getBoundingClientRect().width,
                  group: el.parentElement?.parentElement?.className,
                  groupWidth: el.parentElement?.parentElement?.getBoundingClientRect().width,
                })),
              indicators: [
                ...globalThis.document.querySelectorAll<HTMLInputElement>(
                  'input[type=checkbox],input[type=radio]',
                ),
              ]
                .filter((el) => el.getClientRects().length)
                .map((el) => ({
                  width: el.getBoundingClientRect().width,
                  height: el.getBoundingClientRect().height,
                  labelHeight: el.closest('label')?.getBoundingClientRect().height,
                  labelWidth: el.closest('label')?.getBoundingClientRect().width,
                })),
            }));
            if (
              metrics.rootOverflow ||
              metrics.headerOverlaps.length ||
              metrics.clippedControls.length ||
              metrics.indicators.some(
                (el) =>
                  el.height > 24 * scale || (el.labelHeight ?? 0) < 44 || (el.labelWidth ?? 0) < 44,
              )
            )
              findings.push({ theme, width, scale, surface, ...metrics });
          };
          await measure(panel);
          if (width === 744 && scale === 2 && ['Navigation', 'Forms'].includes(panel)) {
            await page.screenshot({
              path: testInfo.outputPath(`${theme}-${panel}-200-percent.png`),
              fullPage: true,
            });
          }
          if (panel === 'Settings') {
            for (const category of ['Footer', 'Social', 'Collections', 'Design', 'Identity']) {
              await page
                .getByRole('navigation', { name: 'Settings categories' })
                .getByRole('button', { name: category, exact: true })
                .click();
              await measure(`Settings: ${category}`);
            }
          }
          if (panel === 'Layout') {
            await page
              .locator('.visual-editor iframe')
              .contentFrame()
              .getByRole('button', { name: /^(Church navigation|Menu)$/ })
              .first()
              .click();
            await measure('Navigation inspector');
            await page.getByRole('button', { name: 'Publish', exact: true }).click();
            await measure('Publishing dialog');
            await page.getByRole('button', { name: 'Close publishing window' }).click();
          }
        }
      }
    }
  }
  await testInfo.attach('configuration-audit', {
    body: JSON.stringify(findings, null, 2),
    contentType: 'application/json',
  });
  expect(findings).toEqual([]);
});

test('keeps every editor panel semantic and free of serious axe findings', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Sunday update' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Skip to main content' })).toHaveAttribute(
    'href',
    '#main-content',
  );

  for (const panel of [
    'Navigation',
    'Forms',
    'Library',
    'Preview',
    'History',
    'Settings',
    'Admin',
  ]) {
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
  await page.getByRole('button', { name: 'Design', exact: true }).click();
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
  let releaseProductionStatus!: () => void;
  const productionStatus = new Promise<void>((resolve) => {
    releaseProductionStatus = resolve;
  });
  await page.route('**/api/publish/production/workflow?**', async (route) => {
    await productionStatus;
    await route.fulfill({ json: { enabled: false } });
  });
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
  await expect(page.getByText('Loading public site status…')).toBeVisible();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByText('Technical evidence', { exact: true })).toBeFocused();
  releaseProductionStatus();
  await expect(
    page.getByText(/Public site publishing is not enabled in Builder yet/),
  ).toBeVisible();
  await expect(
    page
      .getByRole('dialog', { name: 'Publish and accept on Staging' })
      .evaluate((dialog) => dialog.contains(globalThis.document.activeElement)),
  ).resolves.toBe(true);
  await expect(
    page.getByRole('list', { name: 'Staging publishing progress' }).getByRole('listitem'),
  ).toHaveCount(5);
  await expect(page.getByText('Private preflight required')).toBeVisible();
  await page.getByRole('button', { name: /Check and publish revision \d+/ }).click();
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
  await expect(
    page.getByText(
      'This exact revision is accepted on Staging. The public site has its own publication status.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByText(/Public site publishing is not enabled in Builder yet/),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Close publishing window' }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Open editor' }).click();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Official Staging candidate accepted')).toBeVisible();
  await expect(page.getByRole('button', { name: /publish this revision/i })).toHaveCount(0);
  expect(productionWrites).toEqual([]);
});
