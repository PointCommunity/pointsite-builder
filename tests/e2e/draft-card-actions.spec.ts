import { expect, test, type Locator, type Page } from '@playwright/test';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import type { DraftRecord, Role } from '../../src/server/repositories/contracts';

function draft(index: number, status: DraftRecord['status'], name: string): DraftRecord {
  const id = `10000000-0000-4000-8000-00000000000${index}`;
  const revisionId = `20000000-0000-4000-8000-00000000000${index}`;
  return {
    id,
    siteId: 'pointsite',
    name,
    status,
    document: defaultSiteDocument,
    latestRevisionId: revisionId,
    createdBy: 'fixture@example.test',
    createdAt: '2026-09-01T12:00:00Z',
    updatedAt: '2026-09-10T18:59:00Z',
    deletedAt: null,
    revision: {
      id: revisionId,
      draftId: id,
      sequence: index === 2 ? 123456 : 1,
      parentRevisionId: null,
      checksum: 'a'.repeat(64),
      document: defaultSiteDocument,
      label: null,
      schemaVersion: defaultSiteDocument.schemaVersion,
      rendererVersion: defaultSiteDocument.rendererVersion,
      createdBy: 'fixture@example.test',
      createdAt: '2026-09-01T12:00:00Z',
      actionCategory: null,
      actionContext: null,
    },
  };
}

async function installDrafts(page: Page, role: Role = 'administrator') {
  const drafts = [
    draft(1, 'active', 'Sunday'),
    draft(2, 'archived', 'Archived autumn community gathering and volunteer welcome page'),
    draft(3, 'active', 'LongUnbrokenDraftName'.repeat(5)),
  ];
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body =
      path === '/api/me'
        ? { email: 'fixture@example.test', role, repositoryPermission: 'admin' }
        : path === '/api/drafts'
          ? { items: drafts, nextCursor: null }
          : path === '/api/drafts/checkouts'
            ? {
                items: drafts.map(({ id }, index) => ({
                  draftId: id,
                  state: index === 2 ? 'unavailable' : 'available',
                  expiresAt: null,
                })),
              }
            : null;
    await route.fulfill({ json: body });
  });
  await page.goto('/');
  await expect(page.locator('.draft-card')).toHaveCount(3);
}

async function box(locator: Locator) {
  const bounds = await locator.boundingBox();
  expect(bounds).not.toBeNull();
  return bounds!;
}

async function assertLayout(page: Page) {
  const cards = page.locator('.draft-card');
  const primaryPositions = [];
  for (const card of await cards.all()) {
    const cardBox = await box(card);
    const buttons = card.getByRole('button');
    const primary = await box(buttons.first());
    primaryPositions.push({ card: cardBox, primary });
    const duplicate = card.getByRole('button', { name: 'Duplicate' });
    if (await duplicate.count()) {
      const secondary = await box(duplicate);
      const lifecycle = await box(card.getByRole('button', { name: /^(Archive|Unarchive)$/ }));
      expect(secondary.y).toBeGreaterThanOrEqual(primary.y + primary.height + 8);
      expect(secondary.x).toBeCloseTo(primary.x, 0);
      expect(secondary.width).toBeCloseTo(lifecycle.width, 0);
      if (Math.abs(secondary.y - lifecycle.y) < 1) {
        expect(lifecycle.x).toBeGreaterThan(secondary.x + secondary.width);
        expect(lifecycle.x + lifecycle.width).toBeCloseTo(primary.x + primary.width, 0);
      } else {
        expect(lifecycle.y).toBeGreaterThanOrEqual(secondary.y + secondary.height + 8);
        expect(lifecycle.x).toBeCloseTo(primary.x, 0);
        expect(secondary.width).toBeCloseTo(primary.width, 0);
      }
      const remove = card.getByRole('button', { name: 'Delete', exact: true });
      if (await remove.count()) {
        const danger = await box(remove);
        expect(danger.y).toBeGreaterThanOrEqual(lifecycle.y + lifecycle.height + 8);
        expect(danger.width).toBeCloseTo(primary.width, 0);
        expect(danger.x).toBeCloseTo(primary.x, 0);
      }
    }
    for (const button of await buttons.all()) {
      const bounds = await box(button);
      expect(bounds.height).toBeGreaterThanOrEqual(43.99);
      expect(bounds.x).toBeGreaterThanOrEqual(cardBox.x);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(cardBox.x + cardBox.width);
      expect(await button.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
    }
    expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
  for (const first of primaryPositions) {
    for (const second of primaryPositions) {
      if (Math.abs(first.card.y - second.card.y) < 1) {
        expect(first.primary.y).toBeCloseTo(second.primary.y, 0);
      }
    }
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}

test('phone-sized authoring: draft actions keep their hierarchy at responsive and reflow widths', async ({
  page,
}) => {
  await installDrafts(page);
  for (const width of [1280, 920, 768, 620, 420, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await assertLayout(page);
  }
});

test('draft actions remain readable with 200% text sizing in both themes', async ({ page }) => {
  await installDrafts(page);
  // Double each computed text size while retaining the normal viewport and layout dimensions.
  await page.evaluate(() => {
    const elements = [...document.querySelectorAll<HTMLElement>('.drafts-panel, .drafts-panel *')];
    const sizes = elements.map((element) => parseFloat(getComputedStyle(element).fontSize));
    elements.forEach((element, index) => {
      element.style.fontSize = `${sizes[index] * 2}px`;
    });
  });
  for (const theme of ['dark', 'light']) {
    await page.locator('.builder-app').evaluate((element, value) => {
      element.setAttribute('data-builder-theme', value);
    }, theme);
    for (const width of [1280, 768, 420, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await assertLayout(page);
    }
  }
});

test('draft card keyboard order matches its layout and delete cancellation restores focus', async ({
  page,
  browserName,
}) => {
  await installDrafts(page);
  const card = page.locator('.draft-card').nth(1);
  const buttons = card.getByRole('button');
  await buttons.first().focus();
  for (const name of ['Open editor', 'Duplicate', 'Unarchive', 'Delete']) {
    const button = card.getByRole('button', { name, exact: true });
    await expect(button).toBeFocused();
    expect(await button.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe(
      'none',
    );
    // macOS WebKit uses Option+Tab to include buttons with its default keyboard preferences.
    if (name !== 'Delete') await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
  }
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByLabel('Type DELETE to confirm')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(card.getByRole('button', { name: 'Delete', exact: true })).toBeFocused();
});

test('viewer draft cards retain only the primary preview action', async ({ page }) => {
  await installDrafts(page, 'viewer');
  for (const width of [1280, 768, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await assertLayout(page);
    for (const card of await page.locator('.draft-card').all()) {
      await expect(card.getByRole('button')).toHaveText(['Open preview']);
    }
  }
});
