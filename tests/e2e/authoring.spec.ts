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
};

async function installApi(
  page: Page,
  role: Role = 'administrator',
  repositoryPermission: 'admin' | 'maintain' | 'write' | 'triage' | 'read' = 'admin',
) {
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
    githubLogin: string;
    githubUserId: number;
    role: Role;
    active: boolean;
    updatedAt: string;
    updatedBy: string;
  }> = [
    {
      githubLogin: 'brimdor',
      githubUserId: 1_202_831,
      role: 'administrator' as const,
      active: true,
      updatedAt: '2026-09-05T00:00:00Z',
      updatedBy: 'admin@pointatx.org',
    },
  ];
  let conflictNextSave = false;
  let nextSaveGate: Promise<void> | null = null;
  let releaseNextSave: (() => void) | null = null;
  const saveRequests: Array<{
    action: { category: string; context: string };
    idempotencyKey: string | null;
    document: DraftRecord['document'];
  }> = [];
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    let body: unknown = {};
    let status = 200;
    if (path.endsWith('/me')) body = { email: `${role}@pointatx.org`, role, repositoryPermission };
    else if (path === '/api/drafts/checkouts')
      body = {
        items: drafts.map(({ id }) => ({ draftId: id, state: 'available', expiresAt: null })),
      };
    else if (path === '/api/drafts/checkout/owned') body = null;
    else if (path.endsWith('/checkout') && method === 'GET') body = { active: true };
    else if (path.endsWith('/checkout') && method === 'DELETE') {
      status = 204;
      body = undefined;
    } else if (path.endsWith('/checkout'))
      body = {
        draftId: path.split('/').at(-2),
        actor: `${role}@pointatx.org`,
        clientId: (request.postDataJSON() as { clientId: string }).clientId,
        token: '30000000-0000-4000-8000-000000000001',
        acquiredAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
        event: 'acquired',
        viewState: null,
      };
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
        const input = request.postDataJSON() as {
          document: DraftRecord['document'];
          action: {
            category: RevisionRecord['actionCategory'];
            context: RevisionRecord['actionContext'];
          };
        };
        saveRequests.push({
          action: input.action as { category: string; context: string },
          idempotencyKey: request.headers()['idempotency-key'] ?? null,
          document: input.document,
        });
        const gate = nextSaveGate;
        nextSaveGate = null;
        if (gate) await gate;
        draft.document = input.document;
        draft.revision = {
          ...draft.revision,
          sequence: draft.revision.sequence + 1,
          checksum: 'c'.repeat(64),
          document: input.document,
          actionCategory: input.action.category,
          actionContext: input.action.context,
        };
        draft.latestRevisionId = draft.revision.id;
        body = draft;
      }
    } else if (/\/api\/drafts\/[^/]+$/.test(path) && method === 'PATCH') {
      const id = path.split('/').at(-1);
      const index = drafts.findIndex((candidate) => candidate.id === id);
      const input = request.postDataJSON() as { status?: 'active' | 'archived'; name?: string };
      const updated = {
        ...drafts[index],
        ...(input.status ? { status: input.status } : {}),
        ...(input.name ? { name: input.name } : {}),
        updatedAt: new Date().toISOString(),
      } as DraftRecord;
      drafts[index] = updated;
      body = updated;
    } else if (/\/api\/drafts\/[^/]+$/.test(path) && method === 'DELETE') {
      const id = path.split('/').at(-1);
      const index = drafts.findIndex((candidate) => candidate.id === id);
      const input = request.postDataJSON() as { confirmation?: string };
      if (index < 0) {
        status = 404;
        body = { code: 'NOT_FOUND', message: 'Draft not found' };
      } else if (drafts[index].status !== 'archived') {
        status = 409;
        body = { code: 'CONFLICT', message: 'Only archived drafts can be deleted' };
      } else if (input.confirmation !== 'DELETE') {
        status = 422;
        body = { code: 'VALIDATION_FAILED', message: 'Review the highlighted fields' };
      } else {
        const [deleted] = drafts.splice(index, 1);
        body = { ...deleted, status: 'deleted', deletedAt: new Date().toISOString() };
      }
    } else if (/\/api\/drafts\/[^/]+$/.test(path) && method === 'GET') {
      const id = path.split('/').at(-1);
      body = drafts.find((candidate) => candidate.id === id) ?? draft;
    } else if (/\/api\/drafts\/[^/]+$/.test(path)) body = draft;
    else if (path === '/api/media' && method === 'GET') body = { items: [], nextCursor: null };
    else if (path === '/api/media' && method === 'POST') {
      body = {
        id: '30000000-0000-4000-8000-000000000001',
        filename: 'gathering.png',
        displayName: 'Gathering',
        tags: [],
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
      const input = request.postDataJSON() as {
        githubLogin: string;
        role: Role;
        active: boolean;
      };
      const item = {
        ...input,
        githubUserId: input.githubLogin === 'brimdor' ? 1_202_831 : 9_999,
        updatedAt: '2026-09-05T00:00:01Z',
        updatedBy: 'admin@pointatx.org',
      };
      roles = [item, ...roles.filter((candidate) => candidate.githubUserId !== item.githubUserId)];
      body = item;
    } else if (path.endsWith('/admin/audit'))
      body = {
        items: [
          {
            id: 'audit-1',
            occurredAt: '2026-09-05T00:00:00Z',
            actor: '@brimdor',
            action: 'draft.save',
            targetType: 'draft',
            targetId: draft.id,
            outcome: 'succeeded',
            requestId: 'request-1',
            metadata: {
              sequence: 2,
              actionCategory: 'text-edit',
              actionContext: 'page-details',
            },
          },
        ],
        nextCursor: null,
      };
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
  return {
    saveRequests,
    setConflictNextSave: () => (conflictNextSave = true),
    holdNextSave: () => {
      nextSaveGate = new Promise<void>((resolve) => {
        releaseNextSave = resolve;
      });
      return () => {
        releaseNextSave?.();
        releaseNextSave = null;
      };
    },
  };
}

test.beforeEach(async ({ page }) => installApi(page));

test('keeps draft cards in a left-aligned responsive grid of at most three columns', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  const grid = page.locator('.draft-grid');
  const card = page.locator('.draft-card');
  const [gridBox, cardBox] = await Promise.all([grid.boundingBox(), card.boundingBox()]);
  expect(gridBox).not.toBeNull();
  expect(cardBox).not.toBeNull();
  expect(cardBox!.x).toBeCloseTo(gridBox!.x, 0);
  expect(cardBox!.width).toBeLessThan(gridBox!.width * 0.35);
  expect(cardBox!.width).toBeGreaterThan(gridBox!.width * 0.3);

  await page.setViewportSize({ width: 700, height: 800 });
  const [tabletGrid, tabletCard] = await Promise.all([grid.boundingBox(), card.boundingBox()]);
  expect(tabletCard!.width).toBeGreaterThan(tabletGrid!.width * 0.45);
  expect(tabletCard!.width).toBeLessThan(tabletGrid!.width * 0.55);

  await page.setViewportSize({ width: 420, height: 800 });
  const [phoneGrid, phoneCard] = await Promise.all([grid.boundingBox(), card.boundingBox()]);
  expect(phoneCard!.width).toBeCloseTo(phoneGrid!.width, 0);
});

test('creates, duplicates, archives, unarchives, and safely deletes drafts without code', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await page.getByLabel('New draft name').fill('Fall launch');
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page.getByText('Fall launch')).toBeVisible();
  await page.getByRole('button', { name: '← All drafts' }).click();
  const originalCard = page.getByRole('listitem').filter({ hasText: 'Sunday update' });
  await originalCard.getByRole('button', { name: 'Duplicate' }).click();
  await expect(page.getByText('Sunday update copy')).toBeVisible();
  await page.getByRole('button', { name: '← All drafts' }).click();
  const sourceCard = page.getByRole('listitem').filter({ hasText: 'Sunday update' }).last();
  await sourceCard.getByRole('button', { name: 'Archive' }).click();
  await expect(sourceCard.getByText('archived', { exact: true })).toBeVisible();
  await expect(sourceCard.getByRole('button', { name: 'Open editor' })).toBeVisible();
  await expect(sourceCard.getByRole('button', { name: 'Duplicate' })).toBeVisible();
  await expect(sourceCard.getByRole('button', { name: 'Unarchive' })).toBeVisible();
  await expect(sourceCard.getByRole('button', { name: 'Delete' })).toBeVisible();

  const deleteTrigger = sourceCard.getByRole('button', { name: 'Delete' });
  await deleteTrigger.click();
  const dialog = page.getByRole('dialog', { name: 'Delete Sunday update?' });
  const confirmation = dialog.getByLabel('Type DELETE to confirm');
  const confirmDelete = dialog.getByRole('button', { name: 'Delete draft' });
  await expect(confirmation).toBeFocused();
  await confirmation.fill('delete');
  await expect(confirmDelete).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(deleteTrigger).toBeFocused();

  await sourceCard.getByRole('button', { name: 'Unarchive' }).click();
  await expect(sourceCard.getByText('active', { exact: true })).toBeVisible();
  await expect(sourceCard.getByRole('button', { name: 'Archive' })).toBeVisible();
  await sourceCard.getByRole('button', { name: 'Archive' }).click();
  await sourceCard.getByRole('button', { name: 'Delete' }).click();
  await dialog.getByLabel('Type DELETE to confirm').fill('DELETE');
  await dialog.getByRole('button', { name: 'Delete draft' }).click();
  await expect(page.getByRole('heading', { name: 'Sunday update', exact: true })).toHaveCount(0);
});

test('operates page modules by keyboard and announces the result', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();
  const canvas = page.locator('.visual-editor iframe').contentFrame();
  await expect(canvas.locator('.home-hero')).toHaveCount(1);
  const duplicate = page.getByRole('button', { name: /Duplicate hero section/i }).first();
  await duplicate.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'hero section duplicated.' })).toHaveText(
    /hero section duplicated/i,
  );
  await expect(page.getByRole('button', { name: /Duplicate hero section/i })).toHaveCount(2);
  await expect(canvas.locator('.home-hero')).toHaveCount(2);
});

test('autosaves completed page actions in order without a global Save button', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'The ordered request contract needs one browser proof.');
  await page.unroute('**/api/**');
  const controls = await installApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();
  await expect(page.getByLabel('Visual canvas for Home')).toBeVisible();
  const baseline = controls.saveRequests.length;

  const releaseFirstSave = controls.holdNextSave();
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await expect.poll(() => controls.saveRequests.length).toBe(baseline + 1);
  await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await expect(page.getByLabel('Choose page').locator('option:checked')).toHaveText(
    'New page copy',
  );
  expect(controls.saveRequests).toHaveLength(baseline + 1);
  releaseFirstSave();
  await expect.poll(() => controls.saveRequests.length).toBe(baseline + 2);

  const completed = controls.saveRequests.slice(baseline);
  expect(completed.map(({ action }) => action)).toEqual([
    { category: 'add', context: 'page-structure' },
    { category: 'duplicate', context: 'page-structure' },
  ]);
  expect(new Set(completed.map(({ idempotencyKey }) => idempotencyKey)).size).toBe(2);
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  await expect(page.getByText('All changes saved')).toBeVisible();
});

test('coalesces text until blur and sends only content-free attribution', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'The text completion boundary needs one browser proof.');
  await page.unroute('**/api/**');
  const controls = await installApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();
  await page.getByText('Page details', { exact: true }).click();
  const baseline = controls.saveRequests.length;
  const name = page.getByLabel('Page name');
  await name.fill('A private working title');
  expect(controls.saveRequests).toHaveLength(baseline);
  await name.press('Tab');
  await expect.poll(() => controls.saveRequests.length).toBe(baseline + 1);

  const request = controls.saveRequests.at(-1);
  expect(request?.action).toEqual({ category: 'text-edit', context: 'page-details' });
  expect(JSON.stringify(request?.action)).not.toContain('private working title');
});

test('edits, rearranges, replaces, and persists a non-home Hero as a normal element', async ({
  page,
  browserName,
}) => {
  test.setTimeout(60_000);
  test.skip(
    browserName === 'webkit',
    'Playwright WebKit cannot reliably synthesize Puck cross-frame pointer drags; unit coverage still proves the shared Hero contract.',
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();
  await page.getByLabel('Choose page').selectOption({ label: 'Who We Are' });
  let canvas = page.locator('.visual-editor iframe').contentFrame();

  await expect(page.getByRole('button', { name: 'Hero', exact: true })).toBeVisible();
  await expect(page.getByText('Page hero', { exact: true })).toBeVisible();
  await expect(canvas.locator('.page-hero')).toHaveCount(1);
  expect(
    await canvas.locator('.page-hero').evaluate((element) => ({
      left: element.getBoundingClientRect().left,
      width: element.getBoundingClientRect().width,
      viewport: window.innerWidth,
      horizontalOverflow:
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
    })),
  ).toEqual({ left: 0, width: 1280, viewport: 1280, horizontalOverflow: 0 });
  await expect(canvas.getByRole('button', { name: 'Edit global footer' })).toBeVisible();
  await canvas.getByRole('heading', { level: 1, name: 'Who We Are' }).click();
  await expect(page.getByLabel('Layout style').filter({ visible: true })).toHaveValue('pageHero');
  await page.getByLabel('Heading').filter({ visible: true }).fill('Our editable story');
  await expect(canvas.getByRole('heading', { level: 1, name: 'Our editable story' })).toBeVisible();

  await page.getByRole('button', { name: 'Duplicate Page hero' }).click();
  await expect(canvas.locator('.page-hero')).toHaveCount(2);
  await page.getByRole('button', { name: 'Move Page hero copy down' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Page hero copy moved.' })).toBeVisible();
  await page.getByRole('button', { name: 'Remove Page hero', exact: true }).click();
  await page.getByRole('button', { name: 'Remove Page hero copy', exact: true }).click();
  await expect(canvas.locator('.page-hero')).toHaveCount(0);
  await expect(canvas.getByRole('button', { name: 'Edit global footer' })).toBeVisible();

  const drag = async (
    source: ReturnType<typeof page.locator>,
    target: ReturnType<typeof page.locator>,
    edge = false,
  ) => {
    await source.scrollIntoViewIfNeeded();
    await target.scrollIntoViewIfNeeded();
    const [from, to] = await Promise.all([source.boundingBox(), target.boundingBox()]);
    expect(from).not.toBeNull();
    expect(to).not.toBeNull();
    await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
    await page.mouse.down();
    await page.mouse.move(from!.x + from!.width / 2 + 8, from!.y + from!.height / 2 + 8, {
      steps: 4,
    });
    await page.mouse.move(to!.x + to!.width / 2, edge ? to!.y + 6 : to!.y + to!.height / 2, {
      steps: 16,
    });
    await page.waitForTimeout(250);
    await page.mouse.up();
  };
  await drag(
    page.getByRole('button', { name: 'Blank', exact: true }),
    canvas.locator('section[aria-label="Site header"]'),
    true,
  );
  const blankSection = canvas.locator('section[aria-label="Blank section"]').last();
  await expect(blankSection).toBeVisible();
  await drag(
    page.getByRole('button', { name: 'Hero', exact: true }),
    blankSection.locator('[data-puck-dropzone]'),
  );

  await expect(canvas.getByRole('heading', { level: 1, name: 'Welcome to Point' })).toBeVisible();
  await expect(page.getByLabel('Layout style').filter({ visible: true })).toHaveValue('standard');
  await page.getByLabel('Layout style').filter({ visible: true }).selectOption('pageHero');
  await page.getByLabel('Heading').filter({ visible: true }).fill('Replacement page hero');
  await expect(
    canvas.getByRole('heading', { level: 1, name: 'Replacement page hero' }),
  ).toBeVisible();

  await expect(page.getByText('All changes saved')).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Open editor' }).click();
  await page.getByLabel('Choose page').selectOption({ label: 'Who We Are' });
  canvas = page.locator('.visual-editor iframe').contentFrame();
  await expect(
    canvas.getByRole('heading', { level: 1, name: 'Replacement page hero' }),
  ).toBeVisible();
  await expect(canvas.getByRole('button', { name: 'Edit global footer' })).toBeVisible();
});

test('previews the same renderer at mobile, tablet, and desktop widths', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();
  await page.getByRole('button', { name: 'Preview' }).click();
  const frame = page.locator('iframe.preview-frame');
  for (const [label, width] of [
    ['phone', 360],
    ['tablet', 768],
    ['desktop', 1280],
  ] as const) {
    await page.getByRole('button', { name: `Preview at ${label} width` }).click();
    await expect(frame).toHaveCSS('width', `${width}px`);
    await expect(frame).toHaveAttribute('title', new RegExp(`${width} pixel`));
    expect(
      await frame
        .contentFrame()
        .locator('body')
        .evaluate(() => window.innerWidth),
    ).toBe(width);
  }
  const preview = frame.contentFrame();
  await expect(page.getByRole('heading', { name: 'Live preview' })).toBeVisible();
  await expect(page.getByLabel('Page').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Zoom preview out' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Zoom preview in' })).toBeVisible();
  await expect(page.getByLabel('Preview zoom')).toHaveValue('auto');
  await page.getByRole('button', { name: 'Preview at phone width' }).click();
  await expect(preview.locator('.point-navigation__toggle')).toBeVisible();
  await preview.locator('.site-footer').scrollIntoViewIfNeeded();
  await expect(preview.locator('.site-footer')).toBeVisible();
  await preview.locator('.point-navigation__toggle').click();
  await expect(preview.getByRole('link', { name: 'About', exact: true })).toBeVisible();
  const pageSelector = page.getByLabel('Page').first();
  await pageSelector.selectOption(defaultSiteDocument.pages[1].id);
  await expect(preview.getByRole('heading', { level: 1, name: 'Who We Are' })).toBeVisible();

  for (const [title, landmark] of [
    ['Our Beliefs', '.belief-list'],
    ['Leadership', '.people-grid'],
    ['Next Generation', '.image-split'],
    ['Connect Card', '.standalone-form'],
    ['Neighborhood Groups', '.group-grid'],
    ['Prayer Requests', '.standalone-form'],
    ['Giving', '.giving-options'],
    ['Contact Us', '.contact-grid'],
    ['Building Rental', '.standalone-form'],
  ] as const) {
    await pageSelector.selectOption({ label: title });
    await expect(preview.getByRole('heading', { level: 1, name: title })).toBeVisible();
    await expect(preview.locator(landmark).first()).toBeVisible();
    await expect(preview.locator('.site-footer')).toBeAttached();
  }
});

test('keeps every page Hero inside the phone canvas and resizes Hero text by drag or keyboard', async ({
  page,
}) => {
  const controls = await installApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();
  const canvas = page.locator('.visual-editor iframe').contentFrame();
  const pageSelector = page.getByLabel('Choose page');
  for (const currentPage of defaultSiteDocument.pages.filter(
    (candidate) => candidate.route !== '/',
  )) {
    await pageSelector.selectOption(currentPage.id);
    await page.getByRole('button', { name: 'Switch to Phone viewport' }).click();
    await expect(canvas.getByRole('heading', { level: 1, name: currentPage.title })).toBeVisible();
    await expect.poll(() => canvas.locator('body').evaluate(() => window.innerWidth)).toBe(360);
    const bounds = await canvas.locator('.page-hero').evaluate((element) => {
      const box = element.getBoundingClientRect();
      const textBoxes = Array.from(
        element.querySelectorAll<HTMLElement>('.point-hero-text-box'),
      ).map((textBox) => {
        const textBoxBounds = textBox.getBoundingClientRect();
        return { left: textBoxBounds.left, right: textBoxBounds.right };
      });
      return {
        documentOverflow:
          document.documentElement.scrollWidth - document.documentElement.clientWidth,
        heroLeft: box.left,
        heroRight: box.right,
        textBoxes,
      };
    });
    expect(bounds.documentOverflow, `${currentPage.title} canvas overflow`).toBe(0);
    for (const textBox of bounds.textBoxes) {
      expect(textBox.left, `${currentPage.title} text left edge`).toBeGreaterThanOrEqual(
        bounds.heroLeft,
      );
      expect(textBox.right, `${currentPage.title} text right edge`).toBeLessThanOrEqual(
        bounds.heroRight,
      );
    }
  }

  await pageSelector.selectOption({ label: 'Home' });
  await page.getByRole('button', { name: 'Switch to Phone viewport' }).click();
  await expect.poll(() => canvas.locator('body').evaluate(() => window.innerWidth)).toBe(360);
  const homeHeading = canvas.getByRole('heading', {
    level: 1,
    name: /We are a family of Jesus-followers/,
  });
  await expect(homeHeading).toBeVisible();
  await homeHeading.click();
  await expect(
    canvas.getByRole('button', { name: 'Resize Hero heading width', exact: true }),
  ).toBeVisible();

  await pageSelector.selectOption({ label: 'Our Beliefs' });
  await page.getByRole('button', { name: 'Switch to Phone viewport' }).click();
  await expect.poll(() => canvas.locator('body').evaluate(() => window.innerWidth)).toBe(360);
  const hero = canvas.locator('.page-hero');
  const body = hero.locator('.point-hero-text-box--body');

  await expect(canvas.getByRole('heading', { level: 1, name: 'Our Beliefs' })).toBeVisible();
  await canvas.getByRole('heading', { level: 1, name: 'Our Beliefs' }).click();
  await expect(
    canvas.getByRole('button', { name: 'Resize Hero heading width', exact: true }),
  ).toBeVisible();
  const handle = canvas.getByRole('button', { name: 'Resize Hero body width', exact: true });
  await expect(handle).toBeVisible();
  const originalWidth = (await body.boundingBox())?.width ?? 0;
  const keyboardBaseline = controls.saveRequests.length;
  await handle.press('ArrowLeft');
  await expect.poll(() => controls.saveRequests.length).toBe(keyboardBaseline + 1);
  await expect.poll(async () => (await body.boundingBox())?.width ?? 0).toBeLessThan(originalWidth);
  expect(controls.saveRequests.at(-1)?.action).toEqual({
    category: 'resize',
    context: 'element-layout',
  });

  const beforeDrag = (await body.boundingBox())?.width ?? 0;
  const handleBox = await handle.boundingBox();
  expect(handleBox).not.toBeNull();
  await handle.dispatchEvent('pointerdown', {
    pointerId: 7,
    clientX: handleBox!.x + handleBox!.width / 2,
    clientY: handleBox!.y + handleBox!.height / 2,
  });
  await canvas.locator('body').dispatchEvent('pointermove', {
    pointerId: 7,
    clientX: handleBox!.x - 45,
    clientY: handleBox!.y + handleBox!.height / 2,
  });
  await canvas.locator('body').dispatchEvent('pointerup', { pointerId: 7 });
  await expect.poll(async () => (await body.boundingBox())?.width ?? 0).toBeLessThan(beforeDrag);

  const beforeCancel = (await body.boundingBox())?.width ?? 0;
  const cancelHandleBox = await handle.boundingBox();
  expect(cancelHandleBox).not.toBeNull();
  await handle.dispatchEvent('pointerdown', {
    pointerId: 8,
    clientX: cancelHandleBox!.x,
    clientY: cancelHandleBox!.y,
  });
  await canvas.locator('body').dispatchEvent('pointermove', {
    pointerId: 8,
    clientX: cancelHandleBox!.x + 60,
    clientY: cancelHandleBox!.y,
  });
  await canvas.locator('body').dispatchEvent('pointercancel', { pointerId: 8 });
  await expect
    .poll(async () => (await body.boundingBox())?.width ?? 0)
    .toBeCloseTo(beforeCancel, 0);

  await page.getByRole('button', { name: 'Preview' }).click();
  await page.getByRole('button', { name: 'Preview at phone width' }).click();
  const preview = page.locator('iframe.preview-frame').contentFrame();
  const previewPageSelector = page.getByLabel('Page').first();
  for (const currentPage of defaultSiteDocument.pages.filter(
    (candidate) => candidate.route !== '/',
  )) {
    await previewPageSelector.selectOption(currentPage.id);
    await expect(preview.getByRole('heading', { level: 1, name: currentPage.title })).toBeVisible();
    expect(
      await preview.locator('body').evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      })),
    ).toEqual({ clientWidth: 360, scrollWidth: 360 });
  }
});

test('isolates Point Classic colors from Builder and Puck styles', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();

  const canvas = page.locator('.visual-editor iframe').contentFrame();
  const action = canvas.locator('.home-intro').getByRole('link', { name: 'Who we are' });
  await expect(action).toBeVisible();
  expect(
    await action.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        parentColor: getComputedStyle(element.parentElement!).color,
        background: style.backgroundColor,
      };
    }),
  ).toEqual({
    parentColor: 'rgb(23, 26, 23)',
    background: 'rgba(0, 0, 0, 0)',
  });

  await canvas.locator('.home-hero').click();
  const layoutStyle = page.getByLabel('Layout style').last();
  expect(
    await layoutStyle.evaluate((element) => {
      const style = getComputedStyle(element);
      return { color: style.color, background: style.backgroundColor };
    }),
  ).toEqual({ color: 'rgb(244, 245, 241)', background: 'rgb(27, 32, 26)' });

  await page.getByLabel('Choose page').selectOption({ label: 'Connect Card' });
  const submit = page.locator('.visual-editor iframe').contentFrame().getByRole('button', {
    name: 'Send',
    exact: true,
  });
  expect(
    await submit.evaluate((element) => {
      const style = getComputedStyle(element);
      return { color: style.color, background: style.backgroundColor };
    }),
  ).toEqual({ color: 'rgb(255, 255, 255)', background: 'rgb(23, 26, 23)' });
});

test('keeps every authoring pane independently scrollable without page scrolling', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 720 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();
  await page.getByText('Page details', { exact: true }).click();
  await page.locator('.visual-editor iframe').contentFrame().locator('.home-hero').click();

  const scrollContainer = async (element: ReturnType<typeof page.locator>) =>
    element.evaluate((target) => {
      let candidate: HTMLElement | null = target as HTMLElement;
      while (candidate) {
        const style = getComputedStyle(candidate);
        if (
          /(auto|scroll)/.test(style.overflowY) &&
          candidate.scrollHeight > candidate.clientHeight + 1
        ) {
          candidate.scrollTop = candidate.scrollHeight;
          return {
            className: candidate.className,
            clientHeight: candidate.clientHeight,
            scrollHeight: candidate.scrollHeight,
            scrollTop: candidate.scrollTop,
          };
        }
        candidate = candidate.parentElement;
      }
      return null;
    });

  for (const [name, metrics] of [
    ['page manager', await scrollContainer(page.locator('.content-workspace > aside'))],
    [
      'module catalog',
      await scrollContainer(page.getByRole('button', { name: 'Spacer', exact: true })),
    ],
    ['inspector', await scrollContainer(page.locator('.block-inspector').last())],
  ] as const) {
    expect(metrics, `${name} scroll container`).not.toBeNull();
    expect(metrics?.scrollHeight).toBeGreaterThan(
      metrics?.clientHeight ?? Number.POSITIVE_INFINITY,
    );
    expect(metrics?.scrollTop).toBeGreaterThan(0);
  }
  const canvasMetrics = await page
    .locator('.visual-editor iframe')
    .contentFrame()
    .locator('html')
    .evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return {
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        scrollTop: element.scrollTop,
      };
    });
  expect(canvasMetrics.scrollHeight).toBeGreaterThan(canvasMetrics.clientHeight);
  expect(canvasMetrics.scrollTop).toBeGreaterThan(0);
  expect(
    await page.evaluate(() => {
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
      return {
        scrollY: window.scrollY,
        documentOverflow: getComputedStyle(document.documentElement).overflowY,
        bodyOverflow: getComputedStyle(document.body).overflowY,
      };
    }),
  ).toEqual({ scrollY: 0, documentOverflow: 'hidden', bodyOverflow: 'hidden' });
});

test('replaces phone-sized authoring with a widen-window warning at the 720 boundary', async ({
  page,
}) => {
  await page.setViewportSize({ width: 720, height: 800 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();
  await expect(page.getByRole('heading', { name: 'Widen your browser to edit' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Editor sections' })).toBeHidden();

  await page.setViewportSize({ width: 721, height: 800 });
  await expect(page.getByRole('heading', { name: 'Widen your browser to edit' })).toBeHidden();
  await expect(page.getByRole('navigation', { name: 'Editor sections' })).toBeVisible();
});

test('shows the complete production-style site chrome and content inside the editing canvas', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();

  const canvas = page.locator('.visual-editor iframe').contentFrame();
  await expect(canvas.locator('.site-header')).toHaveCount(0);
  await expect(canvas.locator('section[aria-label="Site header"]')).toBeVisible();
  await expect(canvas.getByRole('img', { name: 'Point Community Church' })).toBeVisible();
  await expect(canvas.getByRole('navigation', { name: 'Church navigation' })).toBeVisible();
  await expect(
    canvas.getByRole('heading', {
      level: 1,
      name: /We are a family of Jesus-followers empowered by the Holy Spirit/,
    }),
  ).toBeVisible();
  await expect(canvas.locator('.home-intro')).toBeVisible();
  await expect(canvas.locator('.home-feature--photo')).toBeVisible();
  await expect(canvas.locator('.home-feature--split')).toBeVisible();
  await expect(canvas.locator('.gathering-section')).toBeVisible();
  await expect(canvas.locator('.site-footer')).toBeVisible();

  const pageSelector = page.getByLabel('Choose page');
  for (const [title, landmark] of [
    ['Who We Are', '.split-section'],
    ['Our Beliefs', '.belief-list'],
    ['Leadership', '.people-grid'],
    ['Next Generation', '.image-split'],
    ['Connect Card', '.standalone-form'],
    ['Neighborhood Groups', '.group-grid'],
    ['Prayer Requests', '.standalone-form'],
    ['Giving', '.giving-options'],
    ['Contact Us', '.contact-grid'],
    ['Building Rental', '.standalone-form'],
  ] as const) {
    await pageSelector.selectOption({ label: title });
    await expect(canvas.getByRole('heading', { level: 1, name: title })).toBeVisible();
    await expect(canvas.locator(landmark).first()).toBeVisible();
    await expect(canvas.locator('section[aria-label="Site header"]')).toBeVisible();
    await expect(canvas.locator('.site-footer')).toBeVisible();
  }
});

test('builds a standardized section by dragging an element from the toybox', async ({
  page,
  browserName,
}) => {
  test.setTimeout(60_000);
  test.skip(
    browserName === 'webkit',
    'Playwright WebKit cannot reliably synthesize Puck cross-frame pointer drags; schema and renderer coverage still run in WebKit.',
  );
  await page.unroute('**/api/**');
  const autosave = await installApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();
  const canvas = page.locator('.visual-editor iframe').contentFrame();

  const drag = async (
    source: ReturnType<typeof page.locator>,
    target: ReturnType<typeof page.locator>,
    targetEdge = false,
    targetXRatio = 0.5,
  ) => {
    await source.scrollIntoViewIfNeeded();
    await target.scrollIntoViewIfNeeded();
    const from = await source.boundingBox();
    const to = await target.boundingBox();
    expect(from).not.toBeNull();
    expect(to).not.toBeNull();
    await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
    await page.mouse.down();
    await page.mouse.move(from!.x + from!.width / 2 + 8, from!.y + from!.height / 2 + 8, {
      steps: 4,
    });
    await page.mouse.move(
      to!.x + to!.width * targetXRatio,
      targetEdge ? to!.y + 6 : to!.y + to!.height / 2,
      {
        steps: 16,
      },
    );
    const settledTarget = await target.boundingBox();
    expect(settledTarget).not.toBeNull();
    await page.mouse.move(
      settledTarget!.x + settledTarget!.width * targetXRatio,
      targetEdge ? settledTarget!.y + 6 : settledTarget!.y + settledTarget!.height / 2,
      { steps: 4 },
    );
    const phantom = canvas.locator('.point-grid-drop-preview');
    if ((await phantom.count()) && (await phantom.getAttribute('data-drop-valid')) === 'false') {
      let foundValid = false;
      for (const yRatio of [0.05, 0.5, 0.95]) {
        for (const xRatio of [0.05, 0.5, 0.95]) {
          await page.mouse.move(
            settledTarget!.x + settledTarget!.width * xRatio,
            settledTarget!.y + settledTarget!.height * yRatio,
            { steps: 3 },
          );
          if ((await phantom.getAttribute('data-drop-valid')) === 'true') {
            foundValid = true;
            break;
          }
        }
        if (foundValid) break;
      }
      expect(foundValid, 'an unoccupied grid target must be available').toBe(true);
    }
    await page.waitForTimeout(250);
    await page.mouse.up();
  };

  await drag(
    page.getByRole('button', { name: 'Blank', exact: true }),
    canvas.locator('.home-hero'),
    true,
  );
  const section = canvas.locator('section[aria-label="Blank section"]').last();
  await expect(section).toBeVisible();
  const sectionSlot = section.locator('[data-puck-dropzone]');
  await expect(sectionSlot).toHaveCount(1);
  await expect(section).toHaveClass(/point-layout-section--grid/);
  await expect(sectionSlot).toHaveCSS('grid-template-columns', /repeat|px/);
  await section
    .locator('xpath=ancestor-or-self::*[@data-puck-component][1]')
    .click({ position: { x: 8, y: 8 } });
  await expect(page.getByLabel('Section name').filter({ visible: true })).toBeVisible();
  await page
    .locator('.block-inspector.inspector-grid label')
    .filter({ has: page.getByText('Background', { exact: true }) })
    .locator('select')
    .last()
    .selectOption('canvas');
  await expect(page.getByText('All changes saved')).toBeVisible();
  expect(autosave.saveRequests.at(-1)?.action).toEqual({
    category: 'control-change',
    context: 'section-settings',
  });
  const gridTracks = await sectionSlot.evaluate((element) => {
    const style = getComputedStyle(element);
    const parentStyle = getComputedStyle(element.parentElement!);
    return {
      column: Number.parseFloat(style.gridTemplateColumns),
      row: Number.parseFloat(style.gridAutoRows),
      width: element.getBoundingClientRect().width,
      paddingInline: `${style.paddingLeft} ${style.paddingRight}`,
      parentWidth: element.parentElement!.getBoundingClientRect().width,
      parentPaddingInline: `${parentStyle.paddingLeft} ${parentStyle.paddingRight}`,
    };
  });
  if (Math.abs(gridTracks.column - gridTracks.row) >= 1) {
    throw new Error(`Grid tracks are not square: ${JSON.stringify(gridTracks)}`);
  }
  await drag(page.getByRole('button', { name: 'Heading', exact: true }), sectionSlot);
  await expect(canvas.getByRole('heading', { name: 'Section heading' })).toBeVisible();
  await expect(sectionSlot.locator('.point-layout-item')).toContainText('Section heading');

  await page.getByLabel('desktop width in columns').last().fill('6');
  await page.getByLabel('desktop column').last().fill('4');
  await page.getByLabel('Vertical alignment').last().selectOption({ label: 'End' });
  const placement = canvas.locator('.point-layout-item').filter({ hasText: 'Section heading' });
  await expect(placement).toHaveCSS('grid-column-start', '4');
  await expect(placement).toHaveCSS('grid-column-end', 'span 6');
  await expect(placement).toHaveCSS('align-self', 'end');

  const moveHandle = canvas.getByRole('button', { name: 'Move heading on desktop grid' });
  const initialRow = Number(await page.getByLabel('desktop row').last().inputValue());
  await expect(page.getByText('All changes saved')).toBeVisible();
  const moveBaseline = autosave.saveRequests.length;
  await moveHandle.press('ArrowRight');
  await moveHandle.press('ArrowDown');
  await expect.poll(() => autosave.saveRequests.length).toBe(moveBaseline + 2);
  const moveEvidence = autosave.saveRequests.slice(moveBaseline).map((request) => ({
    action: request.action,
    grid: request.document.pages
      .flatMap((candidate) => candidate.blocks)
      .flatMap((candidate) => candidate.items)
      .find(
        (candidate) =>
          candidate.element.type === 'heading' && candidate.element.text === 'Section heading',
      )?.grid.desktop,
  }));
  expect(moveEvidence).toEqual([
    expect.objectContaining({
      action: { category: 'move', context: 'element-layout' },
      grid: expect.objectContaining({ column: 5, row: initialRow }),
    }),
    expect.objectContaining({
      action: { category: 'move', context: 'element-layout' },
      grid: expect.objectContaining({ column: 5, row: initialRow + 1 }),
    }),
  ]);
  await expect(placement).toHaveCSS('grid-column-start', '5');
  await expect(placement).toHaveCSS('grid-row-start', String(initialRow + 1));

  const resizeHandle = canvas.getByRole('button', {
    name: 'Resize heading from south east',
  });
  const originalHeight = Number(
    await page.getByLabel('desktop height in rows').last().inputValue(),
  );
  await resizeHandle.press('ArrowDown');
  await expect(page.getByLabel('desktop height in rows').last()).toHaveValue(
    String(originalHeight + 1),
  );
  await resizeHandle.dispatchEvent('pointerdown', { pointerId: 2, clientX: 10, clientY: 10 });
  await expect(sectionSlot).toHaveClass(/point-layout-section__grid--active/);
  await canvas.locator('body').dispatchEvent('pointermove', {
    pointerId: 2,
    clientX: -90,
    clientY: 110,
  });
  await expect
    .poll(async () => Number(await page.getByLabel('desktop width in columns').last().inputValue()))
    .toBeLessThan(6);
  const resizedDesktopWidth = Number(
    await page.getByLabel('desktop width in columns').last().inputValue(),
  );
  await expect
    .poll(async () => Number(await page.getByLabel('desktop height in rows').last().inputValue()))
    .toBeGreaterThan(originalHeight + 1);
  await canvas.locator('body').dispatchEvent('pointerup', { pointerId: 2 });
  await expect(sectionSlot).not.toHaveClass(/point-layout-section__grid--active/);

  await page.getByRole('button', { name: 'Switch to Tablet viewport' }).click();
  await canvas.getByRole('heading', { name: 'Section heading' }).click();
  await expect(page.getByText(/Inheriting the desktop position/).last()).toBeVisible();
  await page.getByLabel('tablet width in columns').last().fill('8');
  await page.getByLabel('tablet column').last().fill('3');
  await expect(placement).toHaveCSS('grid-column-start', '3');
  await expect(placement).toHaveCSS('grid-column-end', 'span 8');
  await page.getByRole('button', { name: 'Switch to Desktop viewport' }).click();
  await canvas.getByRole('heading', { name: 'Section heading' }).click();
  await expect(placement).toHaveCSS('grid-column-start', '5');
  await expect(placement).toHaveCSS('grid-column-end', `span ${resizedDesktopWidth}`);

  await expect(sectionSlot).toHaveCSS('background-image', 'none');
  await moveHandle.dispatchEvent('pointerdown', { pointerId: 1, clientX: 10, clientY: 10 });
  await expect(sectionSlot).toHaveClass(/point-layout-section__grid--active/);
  await expect(sectionSlot).not.toHaveCSS('background-image', 'none');
  await canvas.locator('body').dispatchEvent('pointermove', {
    pointerId: 1,
    clientX: 110,
    clientY: 110,
  });
  await expect
    .poll(async () => Number(await page.getByLabel('desktop column').last().inputValue()))
    .toBeGreaterThan(5);
  await canvas.locator('body').dispatchEvent('pointerup', { pointerId: 1 });
  await expect(sectionSlot).toHaveCSS('background-image', 'none');

  await page.getByText('Blocks', { exact: true }).last().click();
  await page.getByRole('button', { name: 'Toggle left sidebar' }).click();
  await expect(page.getByRole('button', { name: 'Sections' })).toBeVisible();
  await drag(
    page.getByRole('button', { name: 'Two Columns', exact: true }),
    canvas.locator('.home-hero'),
    true,
  );
  const twoColumn = canvas.locator('section[aria-label="Two column section"]');
  const twoColumnSlot = twoColumn.locator('[data-puck-dropzone]');
  await expect(twoColumnSlot).toBeVisible();
  await drag(page.getByRole('button', { name: 'Image', exact: true }), twoColumnSlot);
  const imagePlacement = twoColumn.locator('.point-layout-item');
  let imageColumn = Number(await page.getByLabel('desktop column').last().inputValue());
  let imageRow = Number(await page.getByLabel('desktop row').last().inputValue());
  expect(imageColumn).toBeGreaterThan(1);
  await expect(imagePlacement).toHaveCSS('grid-column-start', String(imageColumn));
  await expect(imagePlacement).toHaveCSS('grid-column-end', 'span 6');
  const [gridBox, imageBox] = await Promise.all([
    twoColumnSlot.boundingBox(),
    imagePlacement.boundingBox(),
  ]);
  expect(gridBox).not.toBeNull();
  expect(imageBox).not.toBeNull();
  expect(imageBox!.width).toBeLessThan(gridBox!.width * 0.6);
  expect(imageBox!.width).toBeGreaterThan(gridBox!.width * 0.35);

  await canvas.getByRole('button', { name: 'Move image on desktop grid' }).focus();
  await page.getByLabel('desktop column').last().fill('7');
  await page.getByLabel('desktop row').last().fill('1');
  imageColumn = 7;
  imageRow = 1;
  const inspector = page.locator('.block-inspector').last();
  await expect(page.getByLabel('desktop width in columns').last()).toHaveValue('6');
  const inspectorOverflow = await inspector.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(inspectorOverflow.scrollWidth).toBeLessThanOrEqual(inspectorOverflow.clientWidth);

  await drag(page.getByRole('button', { name: 'Button', exact: true }), twoColumnSlot, true, 0.05);
  const atomicButton = twoColumn.getByRole('link', { name: 'Learn more', exact: true });
  await expect(atomicButton).toBeVisible();
  await canvas.getByRole('button', { name: 'Move button on desktop grid' }).focus();
  await page.getByLabel('Button label').filter({ visible: true }).fill('Visit groups');
  await page
    .getByRole('group', { name: 'Button link' })
    .filter({ visible: true })
    .getByLabel('Internal page')
    .selectOption('/neighborhood-groups');
  await expect(twoColumn.getByRole('link', { name: 'Visit groups' })).toHaveAttribute(
    'href',
    '/neighborhood-groups',
  );
  const placementInspector = page.locator('.grid-placement-inspector').filter({ visible: true });
  const buttonColumn = placementInspector.getByLabel('desktop column');
  const buttonRow = placementInspector.getByLabel('desktop row');
  await expect(placementInspector).toHaveAttribute('data-occupied-elements', '1');
  await buttonColumn.fill(String(imageColumn));
  const previousButtonRow = await buttonRow.inputValue();
  await buttonRow.fill(String(imageRow));
  await expect(
    page.getByRole('alert').filter({ hasText: 'overlaps another element' }),
  ).toBeVisible();
  await expect(buttonRow).toHaveValue(previousButtonRow);

  await expect(page.getByText('All changes saved')).toBeVisible();
  expect(autosave.saveRequests.map(({ action }) => action.context)).toEqual(
    expect.arrayContaining(['page-content', 'element-settings', 'element-layout']),
  );
  if (browserName === 'chromium') {
    const historyBaseline = autosave.saveRequests.length;
    await page.getByRole('button', { name: 'undo' }).click();
    await expect.poll(() => autosave.saveRequests.length).toBe(historyBaseline + 1);
    expect(autosave.saveRequests.at(-1)?.action).toEqual({
      category: 'undo',
      context: 'page-content',
    });
    await expect(page.getByText('All changes saved')).toBeVisible();
    await page.getByRole('button', { name: 'redo' }).click();
    await expect.poll(() => autosave.saveRequests.length).toBe(historyBaseline + 2);
    expect(autosave.saveRequests.at(-1)?.action).toEqual({
      category: 'redo',
      context: 'page-content',
    });
    await expect(page.getByText('All changes saved')).toBeVisible();
  }
  await page.reload();
  await page.getByRole('button', { name: 'Open editor' }).click();
  const reloadedCanvas = page.locator('.visual-editor iframe').contentFrame();
  await expect(reloadedCanvas.getByRole('heading', { name: 'Section heading' })).toBeVisible();
  await expect(reloadedCanvas.locator('section[aria-label="Two column section"]')).toBeVisible();

  await reloadedCanvas.getByRole('button', { name: 'Edit global footer' }).scrollIntoViewIfNeeded();
  await reloadedCanvas.getByRole('button', { name: 'Edit global footer' }).click();
  await expect(page.getByRole('button', { name: 'Settings' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.locator('#footer-settings')).toBeFocused();
});

test('keeps the Sections toolbox structural and exposes recipe parts as atomic items', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();
  await expect(page.getByRole('button', { name: 'Sections' })).toBeVisible();

  for (const name of ['Blank', 'Two Columns', 'Three Columns', 'Full-Width']) {
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  }
  for (const name of ['Hero recipe', 'Image and text recipe', 'Call to action recipe']) {
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  }
  for (const name of ['Hero', 'Heading', 'Text', 'Button', 'Image']) {
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  }
  await expect(page.getByRole('button', { name: 'Split feature', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Navigation', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Linked media', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save now', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Publish', exact: true })).toHaveCount(1);
  await expect(page.locator('.visual-editor')).toHaveCSS('--puck-line-placeholder-width', '6px');
});

test('shows a snapped phantom while inserting into a grid and resizes from edges', async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName === 'webkit',
    'Playwright WebKit cannot reliably synthesize Puck cross-frame pointer drags.',
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();
  const canvas = page.locator('.visual-editor iframe').contentFrame();
  const dragInto = async (
    source: ReturnType<typeof page.locator>,
    target: ReturnType<typeof page.locator>,
    targetEdge = false,
  ) => {
    await source.scrollIntoViewIfNeeded();
    await target.scrollIntoViewIfNeeded();
    const [from, to] = await Promise.all([source.boundingBox(), target.boundingBox()]);
    expect(from).not.toBeNull();
    expect(to).not.toBeNull();
    await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
    await page.mouse.down();
    await page.mouse.move(from!.x + from!.width / 2 + 8, from!.y + from!.height / 2 + 8, {
      steps: 4,
    });
    await page.mouse.move(to!.x + to!.width / 2, targetEdge ? to!.y + 6 : to!.y + to!.height / 2, {
      steps: 16,
    });
    const settledTarget = await target.boundingBox();
    expect(settledTarget).not.toBeNull();
    await page.mouse.move(
      settledTarget!.x + settledTarget!.width / 2,
      targetEdge ? settledTarget!.y + 6 : settledTarget!.y + settledTarget!.height / 2,
      { steps: 4 },
    );
    await page.waitForTimeout(250);
    await page.mouse.up();
  };
  await dragInto(
    page.getByRole('button', { name: 'Two Columns', exact: true }),
    canvas.locator('.home-hero'),
    true,
  );
  const grid = canvas
    .locator('section[aria-label="Two column section"]')
    .locator('[data-puck-dropzone]');
  const source = page
    .getByRole('button', { name: 'Heading', exact: true })
    .filter({ visible: true });
  await grid.scrollIntoViewIfNeeded();
  await source.scrollIntoViewIfNeeded();
  const [from, to] = await Promise.all([source.boundingBox(), grid.boundingBox()]);
  expect(from).not.toBeNull();
  expect(to).not.toBeNull();
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
  await page.mouse.down();
  await page.mouse.move(from!.x + from!.width / 2 + 8, from!.y + from!.height / 2 + 8, {
    steps: 4,
  });
  await page.mouse.move(to!.x + 24, to!.y + 24, { steps: 16 });
  const phantom = canvas.locator('.point-grid-drop-preview');
  await expect(phantom).toContainText('Heading');
  await expect(phantom).toHaveAttribute('data-drop-valid', 'true');
  const first = await phantom.boundingBox();
  await page.mouse.move(to!.x + to!.width * 0.6, to!.y + 24, { steps: 8 });
  const second = await phantom.boundingBox();
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  expect(second!.x).toBeGreaterThan(first!.x);
  await page.mouse.up();

  await expect(canvas.getByRole('heading', { name: 'Section heading' })).toHaveCount(1);
  test.skip(
    browserName === 'firefox',
    'Playwright Firefox cannot reliably preserve a freshly dropped Puck item for a second cross-frame collision drag.',
  );
  const occupiedHeading = canvas
    .locator('.point-layout-item--grid')
    .filter({ has: canvas.getByRole('heading', { name: 'Section heading' }) });
  const occupiedBox = await occupiedHeading.boundingBox();
  expect(occupiedBox).not.toBeNull();
  await expect(occupiedHeading.locator('xpath=ancestor::section[1]')).toHaveAttribute(
    'aria-label',
    'Two column section',
  );
  await source.scrollIntoViewIfNeeded();
  await grid.scrollIntoViewIfNeeded();
  const [secondFrom, secondTo] = await Promise.all([source.boundingBox(), grid.boundingBox()]);
  expect(secondFrom).not.toBeNull();
  expect(secondTo).not.toBeNull();
  await page.mouse.move(
    secondFrom!.x + secondFrom!.width / 2,
    secondFrom!.y + secondFrom!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    secondFrom!.x + secondFrom!.width / 2 + 8,
    secondFrom!.y + secondFrom!.height / 2 + 8,
    { steps: 4 },
  );
  await page.mouse.move(
    occupiedBox!.x + occupiedBox!.width / 2,
    occupiedBox!.y + Math.min(24, occupiedBox!.height / 2),
    { steps: 16 },
  );
  await expect(phantom).toHaveAttribute('data-drop-valid', 'false');
  await expect(phantom).toContainText('blocked by another element');
  await expect(
    canvas.getByRole('status').filter({ hasText: /columns .*blocked by another element/i }),
  ).toBeVisible();
  await page.mouse.up();
  await expect(page.locator('.visual-editor')).toHaveAttribute('data-interaction-revision', '1');
  await expect(canvas.getByRole('heading', { name: 'Section heading' })).toHaveCount(1);

  const insertedHeading = canvas.getByRole('heading', { name: 'Section heading' });
  const headingBox = await insertedHeading.boundingBox();
  expect(headingBox).not.toBeNull();
  await page.mouse.click(
    headingBox!.x + headingBox!.width / 2,
    headingBox!.y + headingBox!.height / 2,
  );
  const east = canvas.getByRole('button', { name: 'Resize heading from east' });
  const north = canvas.getByRole('button', { name: 'Resize heading from north', exact: true });
  await expect(east).toBeVisible();
  await expect(north).toBeVisible();
  const eastHitArea = await east.evaluate((element) => {
    const style = getComputedStyle(element);
    return { width: Number.parseFloat(style.width), height: Number.parseFloat(style.height) };
  });
  expect(eastHitArea.width).toBeGreaterThanOrEqual(16);
  expect(eastHitArea.height).toBeGreaterThanOrEqual(24);
});

test('ships the logo and menu as independently editable grid elements', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();
  const canvas = page.locator('.visual-editor iframe').contentFrame();
  await expect(canvas.locator('.site-header')).toHaveCount(0);
  await expect(canvas.locator('section[aria-label="Site header"]')).toBeVisible();
  await expect(canvas.getByRole('img', { name: 'Point Community Church' })).toBeVisible();
  await expect(canvas.getByRole('navigation', { name: 'Church navigation' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Navigation', exact: true })).toBeVisible();

  await canvas.getByRole('button', { name: 'Church navigation', exact: true }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Navigation' })).toBeVisible();
  await expect(
    canvas.getByRole('button', { name: 'Move navigation on desktop grid' }),
  ).toBeVisible();
  await expect(canvas.getByRole('button', { name: 'Resize navigation from east' })).toBeVisible();
  await expect(page.getByLabel('desktop column').filter({ visible: true })).toHaveValue('5');
  await expect(page.getByLabel('desktop width in columns').filter({ visible: true })).toHaveValue(
    '8',
  );

  const aboutLabel = page
    .getByRole('group', { name: 'About' })
    .getByLabel('Label', { exact: true })
    .first();
  await aboutLabel.fill('Our church');
  await expect(
    page.getByRole('group', { name: 'Our church' }).getByLabel('Label', { exact: true }).first(),
  ).toHaveValue('Our church');
  await expect(canvas.getByRole('link', { name: 'Our church', exact: true })).toBeVisible();

  const aboutLink = page
    .getByRole('group', { name: 'Our church' })
    .getByRole('group', { name: 'Link' })
    .first();
  await aboutLink.getByLabel('Internal page').selectOption('/contact');
  await expect(canvas.getByRole('link', { name: 'Our church', exact: true })).toHaveAttribute(
    'href',
    '/contact',
  );
  await aboutLink.getByLabel('Type').selectOption('external');
  await aboutLink.getByLabel('External URL').fill('pointatx.org');
  await expect(aboutLink.getByLabel('External URL')).toHaveAttribute('aria-invalid', 'true');
  await aboutLink.getByLabel('External URL').fill('http://legacy.example.com');
  await expect(canvas.getByRole('link', { name: 'Our church', exact: true })).toHaveAttribute(
    'href',
    'http://legacy.example.com',
  );

  await canvas.getByRole('img', { name: 'Point Community Church' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Image' })).toBeVisible();
  await canvas.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(canvas.getByRole('img', { name: 'Point Community Church' })).toHaveCount(0);
  await expect(canvas.getByRole('navigation', { name: 'Church navigation' })).toBeVisible();
});

test('aligns Split View text horizontally and vertically without inspector overflow', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();
  const canvas = page.locator('.visual-editor iframe').contentFrame();
  await canvas.getByRole('heading', { name: 'Next Generation', exact: true }).click();

  await page.getByLabel('Horizontal alignment').filter({ visible: true }).selectOption('right');
  await page.getByLabel('Vertical alignment').filter({ visible: true }).selectOption('end');

  const splitView = canvas.locator('.home-feature--split');
  await expect(splitView).toHaveCSS('text-align', 'right');
  await expect(splitView.locator('.feature-copy')).toHaveCSS('align-self', 'end');
  const inspectorOverflow = await page
    .locator('.block-inspector')
    .filter({ visible: true })
    .evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return Array.from(element.querySelectorAll('*'))
        .filter((child) => {
          if (child instanceof HTMLOptionElement) return false;
          const childBounds = child.getBoundingClientRect();
          return (
            childBounds.width > 0 &&
            childBounds.height > 0 &&
            (childBounds.left < bounds.left - 0.5 || childBounds.right > bounds.right + 0.5)
          );
        })
        .map((child) => ({ tag: child.tagName, className: child.className }));
    });
  expect(inspectorOverflow).toEqual([]);
});

test('retains focus while typing a complete FAQ question in the visual inspector', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();
  await page.getByLabel('Choose page').selectOption({ label: 'Neighborhood Groups' });
  const canvas = page.locator('.visual-editor iframe').contentFrame();
  await canvas.getByText('Finding your group', { exact: true }).click();

  const question = page.getByLabel('Question', { exact: true }).filter({ visible: true }).first();
  await question.click({ clickCount: 3 });
  await question.pressSequentially('What should I expect?', { delay: 10 });

  await expect(question).toBeFocused();
  await expect(question).toHaveValue('What should I expect?');
});

test('retains focus while typing across every editable workspace', async ({ page }) => {
  const replaceSequentially = async (field: ReturnType<typeof page.locator>, value: string) => {
    await field.click({ clickCount: 3 });
    await field.pressSequentially(value, { delay: 5 });
    await expect(field).toBeFocused();
    await expect(field).toHaveValue(value);
  };

  await page.goto('/');
  await replaceSequentially(page.getByLabel('New draft name'), 'Focus-safe draft');
  await page.getByRole('button', { name: 'Open editor' }).click();

  await page.getByRole('button', { name: 'Forms' }).click();
  await replaceSequentially(
    page.getByLabel('Question or label').filter({ visible: true }).first(),
    'How can we help?',
  );

  await page.getByRole('button', { name: 'Library' }).click();
  await expect(page.getByText('19 site images')).toBeVisible();
  await expect(page.locator('.media-grid--site-assets img')).toHaveCount(19);
  await page
    .locator('.media-grid--site-assets li')
    .filter({ hasText: 'Austin skyline over the Colorado River' })
    .getByText('Edit details')
    .click();
  await expect(page.getByRole('button', { name: 'Save details' })).toBeVisible();
  await replaceSequentially(
    page.getByLabel('Display name for Austin skyline over the Colorado River'),
    'Austin skyline hero',
  );
  await replaceSequentially(
    page.getByLabel('Display name', { exact: true }).filter({ visible: true }).first(),
    'Welcome media',
  );

  await page.getByRole('button', { name: 'History' }).click();
  await replaceSequentially(page.getByLabel('Find a revision'), 'homepage');

  await page.getByRole('button', { name: 'Settings' }).click();
  await replaceSequentially(page.getByLabel('Church name'), 'Point Community Church');

  await page.getByRole('button', { name: 'Admin' }).click();
  await replaceSequentially(page.getByLabel('GitHub username'), 'point-editor');
});

test('attributes completed actions across Forms, Library, and whole-site settings', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Finite action attribution needs one browser proof.');
  await page.unroute('**/api/**');
  const controls = await installApi(page);
  const expectAction = async (
    run: () => Promise<unknown>,
    action: { category: string; context: string },
  ) => {
    const index = controls.saveRequests.length;
    await run();
    await expect.poll(() => controls.saveRequests.length).toBe(index + 1);
    expect(controls.saveRequests[index]?.action).toEqual(action);
    await expect(page.getByText('All changes saved')).toBeVisible();
  };

  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();

  await page.getByRole('button', { name: 'Forms' }).click();
  await expectAction(() => page.getByRole('button', { name: 'New form' }).click(), {
    category: 'add',
    context: 'forms',
  });

  await page.getByRole('button', { name: 'Library' }).click();
  await page.getByLabel('Media type').selectOption('youtube');
  await page.getByLabel('Display name', { exact: true }).fill('Attribution video');
  await page.getByLabel('HTTPS link').fill('https://www.youtube.com/watch?v=M7lc1UVf-VE');
  await expectAction(() => page.getByRole('button', { name: 'Add linked media' }).click(), {
    category: 'add',
    context: 'linked-media',
  });

  await page.getByRole('button', { name: 'Settings' }).click();
  await expectAction(
    async () => {
      await page.getByLabel('Church name').fill('Point Community Church Austin');
      await page.getByLabel('Church name').press('Tab');
    },
    { category: 'text-edit', context: 'site-settings' },
  );

  const navigationLabel = page
    .getByRole('group', { name: 'About' })
    .getByLabel('Label', { exact: true })
    .first();
  await expectAction(
    async () => {
      await navigationLabel.fill('About Point');
      await navigationLabel.press('Tab');
    },
    { category: 'text-edit', context: 'navigation' },
  );

  await expectAction(() => page.getByRole('button', { name: 'Add person' }).click(), {
    category: 'add',
    context: 'collections',
  });

  await expectAction(() => page.getByLabel('Heading typeface').selectOption('serif'), {
    category: 'control-change',
    context: 'theme',
  });
});

test('labels history and restores only after confirmation', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();
  await page.getByRole('button', { name: 'History' }).click();
  await page.getByLabel('Find a revision').fill('Before refresh');
  await expect(page.getByText('1 revision')).toBeVisible();
  await expect(page.locator('.revision-panel ol > li')).toHaveCount(1);
  await page.getByLabel('Find a revision').fill('');
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
  await page.unroute('**/api/**');
  const controls = await installApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();
  await page.getByRole('button', { name: 'Library' }).click();
  await page.getByLabel('Image file').setInputFiles({
    name: 'gathering.png',
    mimeType: 'image/png',
    buffer: Buffer.from('image-fixture'),
  });
  await page.getByLabel('Alternative text').fill('People gathering');
  await page.getByRole('button', { name: 'Upload image' }).click();
  await expect(page.getByText('Image uploaded privately.')).toBeVisible();
  const baseline = controls.saveRequests.length;
  await page.getByRole('button', { name: 'Use in Layout' }).click();
  await expect.poll(() => controls.saveRequests.length).toBe(baseline + 1);
  expect(controls.saveRequests.at(-1)?.action).toEqual({
    category: 'add',
    context: 'library-attachment',
  });
  await expect(page.getByRole('heading', { name: 'Page structure' })).toBeVisible();
});

test('builds a form and places linked YouTube media without code', async ({
  page,
  browserName,
}) => {
  test.setTimeout(60_000);
  test.skip(
    browserName === 'webkit',
    'Playwright WebKit cannot reliably synthesize Puck cross-frame pointer drags.',
  );
  await page.unroute('**/api/**');
  const controls = await installApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();
  await page.getByRole('button', { name: 'Forms' }).click();
  await page.getByRole('button', { name: 'New form' }).click();
  await page.getByLabel('Heading').fill('Plan a visit');
  await page.getByRole('button', { name: 'Add field' }).click();
  await expect(page.getByText('2. New field')).toBeVisible();

  await page.getByRole('button', { name: 'Library' }).click();
  await page.getByLabel('Media type').selectOption('youtube');
  await page.getByLabel('Display name', { exact: true }).fill('Point welcome video');
  await page.getByLabel('HTTPS link').fill('https://www.youtube.com/watch?v=M7lc1UVf-VE');
  await page.getByRole('button', { name: 'Add linked media' }).click();
  await expect(page.getByText('Linked media added to this draft.')).toBeVisible();
  await page.getByRole('button', { name: 'Layout' }).click();
  await expect(page.getByText('All changes saved')).toBeVisible();

  const canvas = page.locator('.visual-editor iframe').contentFrame();
  const drag = async (
    source: ReturnType<typeof page.locator>,
    target: ReturnType<typeof page.locator>,
    edge = false,
  ) => {
    await source.scrollIntoViewIfNeeded();
    await target.scrollIntoViewIfNeeded();
    const from = await source.boundingBox();
    const to = await target.boundingBox();
    expect(from).not.toBeNull();
    expect(to).not.toBeNull();
    await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
    await page.mouse.down();
    await page.mouse.move(from!.x + from!.width / 2 + 8, from!.y + from!.height / 2 + 8, {
      steps: 4,
    });
    await page.mouse.move(to!.x + to!.width / 2, edge ? to!.y + 6 : to!.y + to!.height / 2, {
      steps: 16,
    });
    await page.waitForTimeout(250);
    await page.mouse.up();
  };
  const sectionBaseline = controls.saveRequests.length;
  await drag(
    page.getByRole('button', { name: 'Blank', exact: true }),
    canvas.locator('.home-hero'),
    true,
  );
  const section = canvas.locator('section[aria-label="Blank section"]').last();
  await expect.poll(() => controls.saveRequests.length).toBe(sectionBaseline + 1);
  await expect(page.getByText('All changes saved')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Linked media', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Linked media', exact: true })).toBeEnabled();
  await drag(
    page.getByRole('button', { name: 'Linked media', exact: true }),
    section.locator('[data-puck-dropzone]'),
  );
  await expect(canvas.getByTitle('Point welcome video')).toHaveAttribute(
    'src',
    'https://www.youtube-nocookie.com/embed/M7lc1UVf-VE',
  );
});

test('manages roles and exposes capacity warnings to administrators', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();
  await page.getByRole('button', { name: 'Admin' }).click();
  await expect(page.getByText('80% — action recommended')).toBeVisible();
  await page.getByLabel('GitHub username').fill('point-publisher');
  await page.locator('.inline-editor select').selectOption('publisher');
  await page.getByRole('button', { name: 'Add person' }).click();
  await expect(page.getByText('@point-publisher updated')).toBeVisible();
  await expect(page.getByRole('cell', { name: '@point-publisher' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '@brimdor' }).last()).toBeVisible();
  await expect(page.getByText('Saved draft changes')).toBeVisible();
  await expect(page.getByText(/Action: Edited text · Area: Page details/)).toBeVisible();
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
  await expect(page.getByRole('button', { name: 'Copy pending draft' })).toBeVisible();
  await page.getByRole('button', { name: 'Copy pending draft' }).click();
  await expect(page.getByRole('button', { name: 'Load latest version' })).toBeEnabled();
  await page.getByRole('button', { name: 'Load latest version' }).click();
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
  await context.setOffline(true);
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await expect(page.getByText('Offline—changes are waiting to save.')).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByText('All changes saved')).toBeVisible();
});
