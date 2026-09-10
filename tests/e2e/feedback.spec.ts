import { expect, test } from '@playwright/test';
import { defaultSiteDocument } from '../../src/site-kit/default-site';

const draftId = '10000000-0000-4000-8000-000000000001';
const draft = {
  id: draftId,
  name: 'Feedback workspace',
  status: 'active',
  document: defaultSiteDocument,
  revision: {
    id: '20000000-0000-4000-8000-000000000001',
    sequence: 1,
    checksum: 'a'.repeat(64),
    document: defaultSiteDocument,
  },
};

for (const flow of ['cancel', 'submit'] as const) {
  test(`feedback ${flow} posts context and restores the viewer editor panel`, async ({ page }) => {
    const origin = 'https://pointview.eaglepass.io';
    const screens: string[] = [];
    let posts = 0;
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      let body: unknown = {};
      if (path === '/api/me') body = { email: 'viewer@pointatx.org', role: 'viewer' };
      if (path === '/api/drafts') body = { items: [draft], nextCursor: null };
      if (path === '/api/drafts/checkouts') body = { items: [] };
      if (path === '/api/feedback') body = { mode: 'production' };
      if (path === '/api/feedback/launch') {
        const input = route.request().postDataJSON() as { screen: string };
        expect(Object.keys(input)).toEqual(['screen']);
        screens.push(input.screen);
        body = { action: `${origin}/launch`, launchToken: 'test-only-assertion' };
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.goto('/');
    const builderUrl = page.url();
    await page.route(`${origin}/launch`, async (route) => {
      expect(route.request().method()).toBe('POST');
      expect(route.request().postData()).toBe('launch_token=test-only-assertion');
      expect(route.request().url()).not.toContain('assertion');
      posts += 1;
      await route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html><body><h1>PointView test intake</h1><a href="${builderUrl}">${flow === 'cancel' ? 'Cancel' : 'Complete feedback'}</a></body></html>`,
      });
    });
    await page.getByRole('button', { name: 'Open preview' }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const button = page.getByRole('button', { name: 'Send feedback', exact: true });
    await button.focus();
    await expect(button).toBeFocused();
    await button.press('Enter');
    await expect(page.getByRole('heading', { name: 'PointView test intake' })).toBeVisible();
    await page
      .getByRole('link', { name: flow === 'cancel' ? 'Cancel' : 'Complete feedback' })
      .click();
    await expect(page.getByRole('heading', { name: 'Feedback workspace' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screens).toEqual(['editor.settings']);
    expect(posts).toBe(1);
  });
}

test('pilot dashboard feedback handles unavailability and disablement', async ({ page }) => {
  let enabled = true;
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/feedback/launch')
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: '{"code":"FEEDBACK_UNAVAILABLE"}',
      });
    const body =
      path === '/api/me'
        ? { email: 'admin@pointatx.org', role: 'administrator' }
        : path === '/api/feedback'
          ? { mode: enabled ? 'pilot' : 'disabled' }
          : path === '/api/drafts/checkout/owned'
            ? null
            : { items: [] };
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Send feedback (test)' }).click();
  await expect(page.getByRole('alert')).toContainText('Your draft is safe');
  await expect(page.getByLabel('New draft name')).toBeVisible();
  enabled = false;
  await page.reload();
  await expect(page.getByLabel('New draft name')).toBeVisible();
  await expect(page.getByRole('button', { name: /Send feedback/ })).toHaveCount(0);
});
