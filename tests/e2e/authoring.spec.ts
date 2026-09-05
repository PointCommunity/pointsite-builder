import { expect, test, type Page } from '@playwright/test';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import type { DraftRecord, RevisionRecord, Role } from '../../src/server/repositories/contracts';

const original = (): DraftRecord => {
  const document = structuredClone(defaultSiteDocument);
  return {
    id: '10000000-0000-4000-8000-000000000001',
    siteId: 'pointsite',
    name: 'Sunday update',
    status: 'active',
    latestRevisionId: '20000000-0000-4000-8000-000000000002',
    document,
    revision: {
      id: '20000000-0000-4000-8000-000000000002',
      draftId: '10000000-0000-4000-8000-000000000001',
      sequence: 2,
      parentRevisionId: '20000000-0000-4000-8000-000000000001',
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
};

async function installApi(page: Page, role: Role = 'administrator') {
  const draft = original();
  const drafts = [draft];
  const oldRevision: RevisionRecord = {
    ...draft.revision,
    id: '20000000-0000-4000-8000-000000000001',
    sequence: 1,
    parentRevisionId: null,
    checksum: '9'.repeat(64),
    label: 'Before refresh',
  };
  let roles: Array<{
    email: string;
    role: Role;
    active: boolean;
    updatedAt: string;
    updatedBy: string;
  }> = [
    {
      email: 'admin@pointatx.org',
      role: 'administrator' as const,
      active: true,
      updatedAt: '2026-09-05T00:00:00Z',
      updatedBy: 'admin@pointatx.org',
    },
  ];
  let conflictNextSave = false;
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    let body: unknown = {};
    let status = 200;
    if (path.endsWith('/me')) body = { email: `${role}@pointatx.org`, role };
    else if (path === '/api/drafts' && method === 'GET') body = { items: drafts, nextCursor: null };
    else if (path === '/api/drafts' && method === 'POST') {
      const input = request.postDataJSON() as { name: string };
      const created = {
        ...structuredClone(draft),
        id: crypto.randomUUID(),
        name: input.name,
      };
      drafts.unshift(created);
      body = created;
      status = 201;
    } else if (path.endsWith('/revisions') && method === 'GET')
      body = { items: [draft.revision, oldRevision], nextCursor: null };
    else if (path.includes('/revisions/') && method === 'PATCH') {
      const input = request.postDataJSON() as { label: string };
      body = { ...oldRevision, label: input.label };
    } else if (path.endsWith('/restore') && method === 'POST')
      body = { ...draft, revision: { ...draft.revision, sequence: 3 } };
    else if (/\/api\/drafts\/[^/]+$/.test(path) && method === 'PUT') {
      if (conflictNextSave) {
        conflictNextSave = false;
        status = 412;
        body = { code: 'REVISION_CONFLICT', message: 'Newer revision', requestId: 'request' };
      } else {
        const input = request.postDataJSON() as { document: DraftRecord['document'] };
        body = { ...draft, document: input.document, revision: { ...draft.revision, sequence: 3 } };
      }
    } else if (/\/api\/drafts\/[^/]+$/.test(path) && method === 'GET') body = draft;
    else if (/\/api\/drafts\/[^/]+$/.test(path)) body = draft;
    else if (path === '/api/media' && method === 'GET') body = { items: [], nextCursor: null };
    else if (path === '/api/media' && method === 'POST') {
      body = {
        id: '30000000-0000-4000-8000-000000000001',
        filename: 'gathering.png',
        contentType: 'image/png',
        byteSize: 68,
        width: 1,
        height: 1,
        altText: 'People gathering',
        status: 'ready',
        createdAt: '2026-09-05T00:00:00Z',
      };
      status = 201;
    } else if (path.startsWith('/api/media/')) {
      await route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z2S8AAAAASUVORK5CYII=',
          'base64',
        ),
      });
      return;
    } else if (path.endsWith('/admin/roles') && method === 'GET')
      body = { items: roles, nextCursor: null };
    else if (path.endsWith('/admin/roles') && method === 'PUT') {
      const input = request.postDataJSON() as { email: string; role: Role; active: boolean };
      const item = {
        ...input,
        updatedAt: '2026-09-05T00:00:01Z',
        updatedBy: 'admin@pointatx.org',
      };
      roles = [item, ...roles.filter((candidate) => candidate.email !== item.email)];
      body = item;
    } else if (path.endsWith('/admin/audit')) body = { items: [], nextCursor: null };
    else if (path.endsWith('/admin/capacity'))
      body = {
        privateMedia: { used: 1, limit: 10, percent: 10, warning: false, unit: 'bytes' },
        revisionData: { used: 8, limit: 10, percent: 80, warning: true, unit: 'bytes' },
        writesToday: { used: 1, limit: 100000, percent: 0, warning: false, unit: 'operations' },
        measuredAt: '2026-09-05T00:00:00Z',
      };
    else if (path.endsWith('/staging/base')) body = { sha: 'b'.repeat(40) };
    else body = draft;
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  return { setConflictNextSave: () => (conflictNextSave = true) };
}

test.beforeEach(async ({ page }) => installApi(page));

test('creates, duplicates, and archives drafts without code', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('New draft name').fill('Fall launch');
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page.getByText('Fall launch')).toBeVisible();
  await page.getByRole('button', { name: '← All drafts' }).click();
  const originalCard = page.getByRole('listitem').filter({ hasText: 'Sunday update' });
  await originalCard.getByRole('button', { name: 'Duplicate' }).click();
  await expect(page.getByText('Sunday update copy')).toBeVisible();
  await page.getByRole('button', { name: '← All drafts' }).click();
  await page
    .getByRole('listitem')
    .filter({ hasText: 'Sunday update' })
    .last()
    .getByRole('button', { name: 'Archive' })
    .click();
  await expect(page.getByRole('heading', { name: 'Sunday update', exact: true })).toHaveCount(0);
});

test('operates page modules by keyboard and announces the result', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();
  const duplicate = page.getByRole('button', { name: /Duplicate Hero/ }).first();
  await duplicate.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'Hero duplicated.' })).toHaveText(
    'Hero duplicated.',
  );
  await expect(page.getByRole('button', { name: /Duplicate Hero/ })).toHaveCount(2);
});

test('previews the same renderer at mobile, tablet, and desktop widths', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();
  await page.getByRole('button', { name: 'preview' }).click();
  const frame = page.locator('.preview-frame');
  for (const [label, width] of [
    ['mobile', '360px'],
    ['tablet', '768px'],
    ['desktop', '1280px'],
  ] as const) {
    await page.getByRole('radio', { name: label }).check();
    await expect(frame).toHaveCSS('max-width', width);
  }
  await expect(frame.getByRole('heading', { level: 1 })).toBeVisible();
});

test('labels history and restores only after confirmation', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();
  await page.getByRole('button', { name: 'history' }).click();
  await page.getByLabel('Label for revision 1').fill('Approved homepage');
  await page.getByRole('button', { name: 'Save label' }).last().click();
  await expect(page.getByText('Revision label saved.')).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByText(/restored as a new revision/)).toBeVisible();
});

test('uploads private media with alternative text and attaches it to the draft library', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();
  await page.getByRole('button', { name: 'media' }).click();
  await page.getByLabel('Image file').setInputFiles({
    name: 'gathering.png',
    mimeType: 'image/png',
    buffer: Buffer.from('image-fixture'),
  });
  await page.getByLabel('Alternative text').fill('People gathering');
  await page.getByRole('button', { name: 'Upload image' }).click();
  await expect(page.getByText('Image uploaded privately.')).toBeVisible();
  await page.getByRole('button', { name: 'Add to site library' }).click();
  await expect(page.getByRole('heading', { name: 'Page structure' })).toBeVisible();
});

test('manages roles and exposes capacity warnings to administrators', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();
  await page.getByRole('button', { name: 'admin' }).click();
  await expect(page.getByText('80% — action recommended')).toBeVisible();
  await page.getByLabel('Email').fill('publisher@pointatx.org');
  await page.locator('.inline-editor select').selectOption('publisher');
  await page.getByRole('button', { name: 'Add person' }).click();
  await expect(page.getByText('publisher@pointatx.org updated')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'publisher@pointatx.org' })).toBeVisible();
});

test('recovers from a server-side revision conflict without overwriting', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Conflict semantics are browser-independent.');
  await page.unroute('**/api/**');
  const controls = await installApi(page);
  controls.setConflictNextSave();
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();
  await expect(page.getByLabel('Visual canvas for Home')).toBeVisible();
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('button', { name: 'Save now' }).click();
  await expect(page.getByRole('button', { name: 'Load latest' })).toBeVisible();
  await page.getByRole('button', { name: 'Load latest' }).click();
  await expect(page.getByText('All changes saved')).toBeVisible();
});

test('keeps an unsaved change offline and retries when connectivity returns', async ({
  page,
  context,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Offline events need one engine proof.');
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();
  await expect(page.getByLabel('Visual canvas for Home')).toBeVisible();
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await context.setOffline(true);
  await page.waitForTimeout(5_100);
  await expect(page.getByText('offline', { exact: true })).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByText('All changes saved')).toBeVisible();
});
