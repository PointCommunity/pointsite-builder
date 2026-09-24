import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { draftAssetFixture, imageFixture as previewPng } from './draft-asset-fixture';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import { SiteDocumentSchema } from '../../src/site-kit/schema';
import { upgradeNavigation } from '../../src/site-kit/migrations';
import { legacyFooterDocument } from '../fixtures/legacy-footer';
import { blockDefinitions } from '../../src/site-kit/registry';
import { blockCatalogDocument } from '../fixtures/block-data';
import { siteViewports } from '../../src/client/preview/viewports';
import type * as HeroPublication from '../fixtures/hero-publication';
import type { PendingJournalState } from '../../src/client/editor/pending-journal';
import type * as JournalModule from '../../src/client/editor/pending-journal';
import type { DraftRecord, RevisionRecord, Role } from '../../src/server/repositories/contracts';
import type {
  LibraryItem,
  LibraryLinkInput,
  LibraryMetadata,
  LibrarySnapshot,
} from '../../src/shared/library';

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
  configureDocument?: (document: DraftRecord['document']) => void,
  densityFixture = false,
) {
  const draft = original();
  configureDocument?.(draft.document);
  draft.revision.schemaVersion = draft.document.schemaVersion;
  draft.revision.rendererVersion = draft.document.rendererVersion;
  const drafts = [draft];
  if (densityFixture) {
    for (let index = 1; index < 8; index++)
      drafts.push({
        ...structuredClone(draft),
        id: crypto.randomUUID(),
        name: `Sunday update ${index + 1}`,
      });
  }
  // Browser interaction fixture only. D1 integration tests prove actual ownership and purge.
  const libraries = new Map<string, LibraryItem[]>();
  const libraryRequests: Array<{
    action: string;
    draftId: string;
    headers: Record<string, string>;
  }> = [];
  const librarySnapshot = (owner: DraftRecord): LibrarySnapshot => {
    let items = libraries.get(owner.id);
    if (!items) {
      const common = {
        createdAt: owner.createdAt,
        updatedAt: owner.updatedAt,
        archivedAt: null,
        usageCount: 0,
        deleteBlockers: [],
      };
      items = [
        ...owner.document.media.map((item): LibraryItem => ({
          ...common,
          id: item.id,
          mediaType: 'image',
          sourceType: 'managed',
          displayName: item.displayName || item.alt,
          filename: item.sourcePath.split('/').at(-1) ?? '',
          sourcePath: item.sourcePath,
          url: `/api/drafts/${owner.id}/assets?path=${encodeURIComponent(item.sourcePath)}`,
          altText: item.alt,
          tags: item.tags ?? [],
        })),
        ...owner.document.linkedMedia.map((item): LibraryItem => ({
          ...common,
          id: item.id,
          mediaType: item.type,
          sourceType: 'linked',
          displayName: item.displayName,
          filename: '',
          sourcePath: '',
          url: item.url,
          altText: item.alternativeText ?? '',
          tags: item.tags ?? [],
        })),
      ];
      if (densityFixture)
        items.push(
          ...items.slice(0, 2).map((item) => ({
            ...item,
            id: crypto.randomUUID(),
            displayName: `Archived ${item.displayName}`,
            archivedAt: owner.createdAt,
          })),
        );
      libraries.set(owner.id, items);
    }
    return {
      draftId: owner.id,
      revisionChecksum: owner.revision.checksum,
      revisionId: owner.latestRevisionId,
      items,
      activeCount: items.filter((item) => !item.archivedAt).length,
      archivedCount: items.filter((item) => item.archivedAt).length,
    };
  };
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
  let ownedDraftId: string | null = null;
  let checkoutAcquiredAt: string | null = null;
  let nextSaveGate: Promise<void> | null = null;
  let releaseNextSave: (() => void) | null = null;
  const saveRequests: Array<{
    action: { category: string; context: string };
    idempotencyKey: string | null;
    expectedRevisionId: string | null;
    document: DraftRecord['document'];
  }> = [];
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    let body: unknown = {};
    let status = 200;
    if (path.endsWith('/me')) body = { email: `${role}@pointatx.org`, role, repositoryPermission };
    else if (/^\/api\/draft-sources\/(staging|production)$/.test(path))
      body = {
        sourceCommit: '0'.repeat(40),
        deploymentId: '1',
        artifactDigest: 'a'.repeat(64),
        fixture: true,
      };
    else if (/^\/api\/drafts\/[^/]+\/publication$/.test(path))
      body = {
        sourceTarget: 'unknown',
        state: 'unknown',
        displayCount: Math.max(0, draft.revision.sequence - 1),
      };
    else if (path === '/api/drafts/checkouts')
      body = {
        items: drafts.map(({ id }) => ({ draftId: id, state: 'available', expiresAt: null })),
      };
    else if (path === '/api/drafts/checkout/owned')
      body = ownedDraftId ? { draftId: ownedDraftId } : null;
    else if (path.endsWith('/checkout') && method === 'GET') body = { active: true };
    else if (path.endsWith('/checkout') && method === 'DELETE') {
      ownedDraftId = null;
      checkoutAcquiredAt = null;
      status = 204;
      body = undefined;
    } else if (path.endsWith('/checkout')) {
      const event = checkoutAcquiredAt ? 'resumed' : 'acquired';
      checkoutAcquiredAt ??= new Date().toISOString();
      ownedDraftId = path.split('/').at(-2)!;
      body = {
        draftId: path.split('/').at(-2),
        actor: `${role}@pointatx.org`,
        clientId: (request.postDataJSON() as { clientId: string }).clientId,
        token: '30000000-0000-4000-8000-000000000001',
        acquiredAt: checkoutAcquiredAt,
        lastActivityAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
        event,
        viewState: null,
      };
    } else if (path === '/api/drafts' && method === 'GET')
      body = {
        items: drafts.map((item) => ({
          ...item,
          document: undefined,
          revision: { ...item.revision, document: undefined },
        })),
        nextCursor: null,
      };
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
      body = {
        items: densityFixture
          ? Array.from({ length: 30 }, (_, index) => ({
              ...oldRevision,
              id: `revision-${index}`,
              sequence: 30 - index,
            }))
          : [draft.revision, oldRevision],
        nextCursor: null,
      };
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
        if (!SiteDocumentSchema.safeParse(input.document).success) {
          await route.fulfill({
            status: 422,
            contentType: 'application/json',
            body: JSON.stringify({
              code: 'VALIDATION_FAILED',
              message: 'Review the draft content',
              requestId: 'request',
            }),
          });
          return;
        }
        saveRequests.push({
          action: input.action as { category: string; context: string },
          idempotencyKey: request.headers()['idempotency-key'] ?? null,
          expectedRevisionId: request.headers()['x-draft-revision'] ?? null,
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
          schemaVersion: input.document.schemaVersion,
          rendererVersion: input.document.rendererVersion,
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
      if (updated.id === draft.id) Object.assign(draft, updated);
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
        libraries.delete(deleted.id);
        body = { id: deleted.id, status: 'deleted', deletedAt: new Date().toISOString() };
      }
    } else if (/\/api\/drafts\/[^/]+$/.test(path) && method === 'GET') {
      const id = path.split('/').at(-1);
      body = drafts.find((candidate) => candidate.id === id) ?? draft;
    } else if (/\/api\/drafts\/[^/]+$/.test(path)) body = draft;
    else if (/^\/api\/drafts\/[^/]+\/assets$/.test(path)) {
      await route.fulfill(draftAssetFixture(request.url()));
      return;
    } else if (/^\/api\/drafts\/[^/]+\/library(?:\/|$)/.test(path)) {
      const owner = drafts.find((candidate) => candidate.id === path.split('/')[3]);
      if (!owner) {
        status = 404;
        body = { code: 'NOT_FOUND', message: 'Draft not found' };
      } else if (method === 'GET') body = librarySnapshot(owner);
      else if (
        role === 'viewer' ||
        owner.status !== 'active' ||
        request.headers()['x-draft-checkout'] !== '30000000-0000-4000-8000-000000000001' ||
        request.headers()['if-match'] !== `"${owner.revision.checksum}"` ||
        request.headers()['x-draft-revision'] !== owner.latestRevisionId ||
        !request.headers()['idempotency-key']
      ) {
        status = 409;
        body = { code: 'CONFLICT', message: 'Saved draft and active checkout required' };
      } else {
        const items = librarySnapshot(owner).items;
        const itemId = path.split('/')[6];
        const item = items.find((candidate) => candidate.id === itemId);
        let action: string;
        if (path.endsWith('/images') || path.endsWith('/replacement')) {
          const form = await new Request(request.url(), {
            method: 'POST',
            headers: request.headers(),
            body: Uint8Array.from(request.postDataBuffer() ?? []),
          }).formData();
          const file = form.get('file') as File;
          const textField = (key: string, fallback = '') => {
            const value = form.get(key);
            return typeof value === 'string' ? value : fallback;
          };
          const replacement = path.endsWith('/replacement');
          expect(replacement ? form.get('confirmed') : 'true').toBe('true');
          const id = item?.id ?? crypto.randomUUID();
          const sourcePath = `/assets/builder/${owner.id}/${crypto.randomUUID()}.png`;
          const image: LibraryItem = {
            id,
            mediaType: 'image',
            sourceType: 'uploaded',
            displayName: textField('displayName', file.name),
            filename: file.name,
            sourcePath,
            url: `/api/drafts/${owner.id}/assets?path=${encodeURIComponent(sourcePath)}`,
            altText: textField('altText'),
            tags: replacement ? (JSON.parse(textField('tags', '[]')) as string[]) : [],
            createdAt: item?.createdAt ?? new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            archivedAt: null,
            usageCount: item?.usageCount ?? 0,
            deleteBlockers: [],
          };
          if (item) items.splice(items.indexOf(item), 1, image);
          else items.push(image);
          const existing = owner.document.media.find((record) => record.id === id);
          const media = {
            id,
            sourcePath,
            alt: image.altText,
            displayName: image.displayName,
            tags: image.tags,
          };
          if (existing) Object.assign(existing, media);
          else owner.document.media.push(media);
          action = replacement ? 'replace' : 'upload';
          status = replacement ? 200 : 201;
        } else if (path.endsWith('/links')) {
          const input = request.postDataJSON() as LibraryLinkInput;
          const id = crypto.randomUUID();
          items.push({
            ...input,
            id,
            sourceType: 'linked',
            filename: '',
            sourcePath: '',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            archivedAt: null,
            usageCount: 0,
            deleteBlockers: [],
          });
          owner.document.linkedMedia.push({
            id,
            type: input.mediaType,
            displayName: input.displayName,
            url: input.url,
            alternativeText: input.altText,
            tags: input.tags,
          });
          action = 'link';
          status = 201;
        } else if (method === 'DELETE') {
          expect(item?.archivedAt).toBeTruthy();
          expect(request.postDataJSON()).toEqual({ confirmation: true });
          libraries.set(
            owner.id,
            items.filter((candidate) => candidate.id !== itemId),
          );
          owner.document.media = owner.document.media.filter((record) => record.id !== itemId);
          owner.document.linkedMedia = owner.document.linkedMedia.filter(
            (record) => record.id !== itemId,
          );
          action = 'delete';
        } else {
          const input = request.postDataJSON() as {
            action: 'update' | 'archive' | 'unarchive';
            metadata?: LibraryMetadata;
          };
          if (!item) throw new Error('Fixture Library item missing');
          if (input.action === 'update') {
            Object.assign(item, input.metadata);
            const record = owner.document.media.find((media) => media.id === item.id);
            if (record && input.metadata)
              Object.assign(record, {
                displayName: input.metadata.displayName,
                alt: input.metadata.altText,
                tags: input.metadata.tags,
              });
          } else {
            item.archivedAt = input.action === 'archive' ? new Date().toISOString() : null;
            item.deleteBlockers = item.archivedAt
              ? ['Retained draft revisions contain this item. Unarchive to use it again.']
              : [];
          }
          item.updatedAt = new Date().toISOString();
          action = input.action;
        }
        libraryRequests.push({ action, draftId: owner.id, headers: request.headers() });
        owner.latestRevisionId = crypto.randomUUID();
        owner.revision = {
          ...owner.revision,
          id: owner.latestRevisionId,
          sequence: owner.revision.sequence + 1,
          checksum: (owner.revision.sequence + 1).toString(16).padStart(64, '0'),
          document: owner.document,
        };
        body = { draft: owner, library: librarySnapshot(owner) };
      }
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
        storage: {
          allocatedBytes: 10485760,
          privateMediaBytes: 1048576,
          revisionPayloadBytes: 8388608,
          receiptPayloadBytes: 0,
        },
        activity: {
          auditEvents: 1,
          periodStart: '2026-09-05T00:00:00Z',
          periodEnd: '2026-09-05T00:00:00Z',
        },
        providerUsage: { state: 'unknown', reason: 'Provider counters unavailable.' },
        measuredAt: '2026-09-05T00:00:00Z',
      };
    else if (path.endsWith('/publish/staging/workflow'))
      body = {
        draftId: draft.id,
        revisionId: draft.revision.id,
        revisionChecksum: draft.revision.checksum,
        preflight: { state: 'required', reason: 'not-validated' },
        availability: { state: 'available' },
        job: null,
        approval: null,
      };
    else if (path.endsWith('/staging/base')) body = { sha: 'b'.repeat(40) };
    else body = draft;
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  return {
    saveRequests,
    libraryRequests,
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

test('keeps Properties state only for the current checkout', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();
  const properties = page.getByRole('button', { name: 'Properties', exact: true });
  await expect(properties).toHaveAttribute('aria-pressed', 'false');
  await properties.click();
  await expect(properties).toHaveAttribute('aria-pressed', 'true');
  await page.getByLabel('Choose page').selectOption({ label: 'Who We Are' });
  await expect(properties).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await page.getByRole('button', { name: 'Layout', exact: true }).click();
  await expect(properties).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await expect(properties).toHaveAttribute('aria-pressed', 'true');
  await properties.click();
  await page.reload();
  await expect(properties).toHaveAttribute('aria-pressed', 'false');
  await properties.click();
  await page.getByRole('button', { name: '← All drafts', exact: true }).click();
  await page.getByRole('button', { name: 'Open editor' }).click();
  await expect(properties).toHaveAttribute('aria-pressed', 'false');
});

test('preserves deliberately opened Properties across narrow-screen view changes and refresh', async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();
  const properties = page.getByRole('button', { name: 'Properties', exact: true });
  await expect(properties).toHaveAttribute('aria-pressed', 'false');
  await properties.click();
  await expect(properties).toHaveAttribute('aria-pressed', 'true');
  const panel = page.getByRole('combobox', { name: 'Editor section', exact: true });
  await panel.selectOption({ label: 'Preview' });
  await panel.selectOption({ label: 'Layout' });
  await expect(properties).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await expect(properties).toHaveAttribute('aria-pressed', 'true');
});

test('recreates the fixed footer with editable Blocks at every responsive boundary', async ({
  page,
}) => {
  const document = legacyFooterDocument();
  const composed = upgradeNavigation(document);
  await page.goto('/');
  await page.evaluate(
    async ({ legacy, composed }) => {
      const modulePath = '/tests/fixtures/hero-publication.tsx';
      const { publishedHtml } = (await import(modulePath)) as typeof HeroPublication;
      for (const [id, document] of [
        ['legacy-footer', legacy],
        ['composed-footer', composed],
      ] as const) {
        const frame = window.document.createElement('iframe');
        frame.id = id;
        frame.style.cssText = 'border:0;height:900px';
        frame.srcdoc = publishedHtml(document, '/');
        window.document.body.appendChild(frame);
      }
    },
    { legacy: document, composed },
  );
  const measure = async (frame: FrameLocator) => {
    await frame.owner().scrollIntoViewIfNeeded();
    await frame.locator('.point-site > footer').scrollIntoViewIfNeeded();
    return frame.locator('.point-site > footer').evaluate(async (root) => {
      await root.ownerDocument.fonts.ready;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const top = root.getBoundingClientRect().top;
      return [root, ...root.querySelectorAll('h2,p,address,a')].map((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          tag: element.tagName,
          text:
            element === root ? '' : (element as HTMLElement).innerText.replace(/\s+/g, ' ').trim(),
          font: style.font,
          color: style.color,
          bounds: [rect.x, rect.y - top, rect.width, rect.height],
        };
      });
    });
  };
  for (const width of [1920, 1280, 901, 900, 768, 761, 760, 601, 600, 520, 360]) {
    for (const id of ['legacy-footer', 'composed-footer'])
      await page
        .locator(`#${id}`)
        .evaluate((element, width) => (element.style.width = `${width}px`), width);
    const legacy = await measure(page.locator('#legacy-footer').contentFrame());
    const actual = await measure(page.locator('#composed-footer').contentFrame());
    expect(actual, `footer recreation at ${width}px`).toEqual(legacy);
  }
});

test('edits composed footer Blocks, saves, reloads and previews the same content', async ({
  page,
}) => {
  const controls = await installApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();
  const canvas = page.locator('.visual-editor iframe').contentFrame();
  await canvas.getByRole('button', { name: 'Edit global footer' }).click();
  await expect(page.getByLabel('Choose page')).toHaveValue('footer');
  await canvas
    .getByRole('button', { name: 'Service Times Sunday at 10:30 AM', exact: true })
    .click();
  await page.getByRole('textbox', { name: 'Section heading', exact: true }).fill('Gather together');
  await page.getByRole('textbox', { name: 'Paragraph', exact: true }).fill('Sundays at 11 AM');
  await page.getByRole('button', { name: 'Blocks', exact: true }).click();
  for (const { label } of Object.values(blockDefinitions).filter(({ label }) => label !== 'Group'))
    await expect(
      page.getByText(label, { exact: true }).filter({ visible: true }).first(),
    ).toBeVisible();
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
  await page.reload();
  await canvas.getByRole('button', { name: 'Edit global footer' }).click();
  await expect(canvas.getByRole('heading', { name: 'Gather together' })).toBeVisible();
  await expect(canvas.getByText('Sundays at 11 AM', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  const preview = page.locator('iframe.preview-frame').contentFrame();
  await expect(preview.getByRole('heading', { name: 'Gather together' })).toBeVisible();
  expect(controls.saveRequests.at(-1)?.document.footer?.[0].items[0].element).toMatchObject({
    type: 'richText',
    heading: 'Gather together',
    content: [{ type: 'paragraph', children: [{ text: 'Sundays at 11 AM' }] }],
  });
  expect(controls.saveRequests.at(-1)?.document.schemaVersion).toBe(11);
});

test('rebuilds identity, editorial text and footer content from Blocks on an empty page', async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName === 'webkit',
    'Playwright WebKit cannot reliably synthesize Puck cross-frame pointer drags; footer editing and renderer parity run in all browsers.',
  );
  test.setTimeout(90_000);
  const controls = await installApi(page, 'administrator', 'admin', (document) => {
    document.pages[0].blocks = [];
    document.footer = [];
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();
  const canvas = page.locator('.visual-editor iframe').contentFrame();
  const drag = async (name: string, target: ReturnType<typeof page.locator>) => {
    const selectedFooter = (await page.getByLabel('Choose page').inputValue()) === 'footer';
    const sectionId =
      name === 'Blank'
        ? null
        : await target.evaluate((element) =>
            element
              .closest<HTMLElement>('[data-point-section-id]')
              ?.dataset.pointSectionId?.replace(/^Section-/, ''),
          );
    const blocks = () => {
      const document = controls.saveRequests.at(-1)?.document;
      return selectedFooter ? document?.footer : document?.pages[0].blocks;
    };
    const count = () =>
      (name === 'Blank'
        ? blocks()?.length
        : blocks()?.find((section) => section.id === sectionId)?.items.length) ?? 0;
    const before = count();
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
      const beforeRequests = controls.saveRequests.length;
      const source = page
        .getByRole('button', { name, exact: true })
        .and(page.locator(':not([inert])'));
      let from = await source.boundingBox();
      let to = await target.boundingBox();
      // Puck replaces section DOM after settings changes; remeasure before each pointer gesture.
      await expect(async () => {
        await source.scrollIntoViewIfNeeded();
        await target.scrollIntoViewIfNeeded();
        from = await source.boundingBox();
        to = await target.boundingBox();
        expect(from).not.toBeNull();
        expect(to).not.toBeNull();
      }).toPass({ timeout: 5000 });
      await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
      await page.mouse.down();
      await page.mouse.move(from!.x + from!.width / 2 + 8, from!.y + from!.height / 2 + 8, {
        steps: 4,
      });
      await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 16 });
      const settled = await target.boundingBox();
      expect(settled).not.toBeNull();
      await page.mouse.move(settled!.x + settled!.width / 2, settled!.y + settled!.height / 2, {
        steps: 4,
      });
      await page.waitForTimeout(250);
      await page.mouse.up();
      try {
        await expect
          .poll(() => controls.saveRequests.length, { timeout: 5_000 })
          .toBeGreaterThan(beforeRequests);
      } catch {
        // Firefox occasionally drops a synthesized cross-frame pointer gesture with no insert action.
        continue;
      }
      await expect.poll(count, { timeout: 5_000 }).toBe(before + 1);
      return;
    }
    expect(count(), `${name} inserted into the intended section`).toBe(before + 1);
  };
  await page.getByRole('button', { name: 'Blocks', exact: true }).click();
  await drag('Blank', canvas.locator('[data-puck-dropzone]').first());
  const sectionId = (await canvas
    .locator('section[aria-label="Blank section"]')
    .first()
    .getAttribute('data-point-section-id'))!.replace(/^Section-/, '');
  const section = canvas.locator(`[data-point-section-id$="${sectionId}"]`);
  await expect(section).toBeVisible();
  await page.getByRole('combobox', { name: 'Section layout', exact: true }).selectOption('flow');
  await page.getByRole('combobox', { name: 'Columns', exact: true }).selectOption('1');
  await page.getByRole('combobox', { name: 'Content width', exact: true }).selectOption('full');
  await page.getByRole('combobox', { name: 'Spacing', exact: true }).selectOption('none');
  await drag('Cards', section.locator('[data-puck-dropzone]'));
  await page.getByRole('combobox', { name: 'Layout style', exact: true }).selectOption('identity');
  await page
    .getByRole('textbox', { name: 'Section heading', exact: true })
    .fill('Family. Disciples. Mission.');
  await page.getByRole('textbox', { name: 'Eyebrow', exact: true }).first().fill('Our identity');
  await page.getByRole('textbox', { name: 'Title', exact: true }).first().fill('Family');
  await page
    .getByRole('textbox', { name: 'Body', exact: true })
    .first()
    .fill('We care for one another.');
  for (const title of ['Disciples', 'Mission']) {
    await page.getByRole('button', { name: 'Add card', exact: true }).click();
    await page.getByRole('textbox', { name: 'Title', exact: true }).last().fill(title);
    await page
      .getByRole('textbox', { name: 'Body', exact: true })
      .last()
      .fill(`Our ${title.toLowerCase()} together.`);
  }
  await expect(canvas.getByRole('heading', { name: 'Family. Disciples. Mission.' })).toBeVisible();
  await drag('Rich text', section.locator('[data-puck-dropzone]'));
  await page.getByRole('combobox', { name: 'Layout style', exact: true }).selectOption('prose');
  await page
    .getByRole('textbox', { name: 'Section heading', exact: true })
    .fill('What is the Church anyway?');
  await page
    .getByRole('textbox', { name: 'Paragraph', exact: true })
    .fill('People connected to one another because of Jesus.');
  await page.getByRole('button', { name: 'Pages', exact: true }).click();
  await page.getByLabel('Choose page').selectOption('footer');
  await page.getByRole('button', { name: 'Blocks', exact: true }).click();
  await drag('Blank', canvas.locator('[data-puck-dropzone]').first());
  const footerId = (await canvas
    .locator('.point-composed-footer section[aria-label="Blank section"]')
    .first()
    .getAttribute('data-point-section-id'))!.replace(/^Section-/, '');
  const footerSection = canvas.locator(`[data-point-section-id$="${footerId}"]`);
  await expect(footerSection).toHaveCount(1);
  await page.getByRole('combobox', { name: 'Section layout', exact: true }).selectOption('flow');
  await page.getByRole('combobox', { name: 'Columns', exact: true }).selectOption('3');
  await page.getByRole('combobox', { name: 'Stack columns on', exact: true }).selectOption('phone');
  await page.getByRole('combobox', { name: 'Content width', exact: true }).selectOption('site');
  await page
    .getByRole('spinbutton', { name: 'Custom space between elements', exact: true })
    .fill('50');
  await page
    .getByRole('spinbutton', { name: 'Custom space above and below', exact: true })
    .fill('65');
  await page.getByRole('combobox', { name: 'Border', exact: true }).selectOption('top');
  await drag('Rich text', footerSection.locator('[data-puck-dropzone]'));
  await page.getByRole('combobox', { name: 'Layout style', exact: true }).selectOption('footer');
  await page.getByRole('textbox', { name: 'Section heading', exact: true }).fill('Service Times');
  await page.getByRole('textbox', { name: 'Paragraph', exact: true }).fill('Sunday at 10:30 AM');
  await drag('Rich text', footerSection.locator('[data-puck-dropzone]'));
  await page.getByRole('combobox', { name: 'Layout style', exact: true }).selectOption('footer');
  await page.getByRole('textbox', { name: 'Section heading', exact: true }).fill('Contact Info');
  await page.getByRole('combobox', { name: 'Content type', exact: true }).selectOption('address');
  await page
    .getByRole('textbox', { name: 'Address', exact: true })
    .fill('11300 Old San Antonio Road\nManchaca, TX 78652');
  await drag('Social links', footerSection.locator('[data-puck-dropzone]'));
  await page.getByRole('combobox', { name: 'Layout style', exact: true }).selectOption('footer');
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  const preview = page.locator('iframe.preview-frame').contentFrame();
  for (const name of [
    'Family. Disciples. Mission.',
    'What is the Church anyway?',
    'Service Times',
    'Contact Info',
  ])
    await expect(preview.getByRole('heading', { name, exact: true })).toBeVisible();
  const saved = controls.saveRequests.at(-1)!.document;
  expect(saved.pages[0].blocks).toHaveLength(1);
  expect(saved.footer).toHaveLength(1);
  expect(
    saved.pages[0].blocks.flatMap((block) => block.items.map((item) => item.element.type)).sort(),
  ).toEqual(['cards', 'richText']);
  expect(
    saved.footer?.flatMap((block) => block.items.map((item) => item.element.type)).sort(),
  ).toEqual(['richText', 'richText', 'socialLinks']);
});

test('keeps alignment controls available in Flow sections', async ({ page }) => {
  const controls = await installApi(page, 'administrator', 'admin', (document) => {
    const section = document.pages[0].blocks.find(
      (item) => item.items[0]?.element.type === 'hero',
    )!;
    section.layout = 'flow';
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();
  const canvas = page.locator('.visual-editor iframe').contentFrame();
  await canvas.getByRole('heading', { level: 1 }).click();
  await page
    .getByRole('combobox', { name: 'desktop vertical alignment', exact: true })
    .selectOption('end');
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
  const saved = controls.saveRequests.at(-1)!.document;
  expect(saved.schemaVersion).toBe(11);
  expect(saved.pages[0].blocks.find((item) => item.layout === 'flow')?.items[0].align.desktop).toBe(
    'end',
  );
});

test('restoring an older revision from the footer keeps the footer editable', async ({ page }) => {
  await installApi(page);
  await page.route('**/restore', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(original()),
    }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();
  await page.getByLabel('Choose page').selectOption('footer');
  await page.getByRole('button', { name: 'History', exact: true }).click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(page.getByText(/restored as a new revision/)).toBeVisible();
  await page.getByRole('button', { name: 'Layout', exact: true }).click();
  await expect(page.getByLabel('Choose page')).toHaveValue('footer');
  await expect(
    page
      .locator('.visual-editor iframe')
      .contentFrame()
      .getByRole('heading', { name: 'Service Times' }),
  ).toBeVisible();
});

test('Navigation Designer creates, shares and protects designs across pages', async ({ page }) => {
  const controls = await installApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();
  const tabs = page.getByRole('navigation', { name: 'Editor sections' });
  await tabs.getByRole('button', { name: 'Navigation', exact: true }).click();
  await page.getByRole('button', { name: 'New design' }).click();
  await page.getByLabel('Design name', { exact: true }).fill('Shared secondary');
  await page.getByRole('button', { name: 'Add top-level link' }).click();
  await page.getByLabel('Link label', { exact: true }).fill('Visit');
  await page.getByLabel('Internal page').selectOption('/contact');
  await page.getByRole('button', { name: 'Add child link' }).click();
  await page.getByLabel('Link label', { exact: true }).fill('First child');
  await page.getByRole('button', { name: '1. Visit /contact', exact: true }).click();
  await page.getByRole('button', { name: 'Add child link' }).click();
  await page.getByLabel('Link label', { exact: true }).fill('Second child');
  await page
    .getByRole('button', { name: 'Child: Second child /', exact: true })
    .dragTo(page.getByRole('button', { name: 'Child: First child /', exact: true }));
  await expect(
    page.getByRole('status').filter({ hasText: 'Second child moved to position 1' }),
  ).toBeVisible();
  await page.getByLabel('Parent link').selectOption('');
  await page.getByRole('button', { name: 'Move earlier' }).press('Enter');
  await expect(page.getByRole('button', { name: '1. Second child /', exact: true })).toBeVisible();
  const designId = await page
    .getByRole('combobox', { name: 'Navigation design', exact: true })
    .inputValue();
  await tabs.getByRole('button', { name: 'Layout', exact: true }).click();
  const canvas = page.locator('.visual-editor iframe').contentFrame();
  for (const title of ['Home', 'Who We Are']) {
    await page.getByLabel('Choose page').selectOption({ label: title });
    await canvas.getByRole('button', { name: 'Church navigation', exact: true }).click();
    await page
      .getByRole('combobox', { name: 'Navigation design', exact: true })
      .selectOption(designId);
    await expect(canvas.getByRole('link', { name: 'Visit', exact: true })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Edit in Navigation Designer' }).click();
  await expect(
    page.getByRole('heading', { name: 'Navigation Designer', exact: true }),
  ).toBeFocused();
  await expect(page.getByRole('button', { name: 'Delete design' })).toBeDisabled();
  await expect(page.getByText(/Used by 2 Navigation elements/)).toBeVisible();
  await page.getByLabel('Design name', { exact: true }).fill('Renamed secondary');
  await page.getByLabel('Link label', { exact: true }).fill('Shared update');
  await page.getByRole('heading', { name: 'Navigation Designer', exact: true }).click();
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
  await tabs.getByRole('button', { name: 'Layout', exact: true }).click();
  for (const title of ['Home', 'Who We Are']) {
    await page.getByLabel('Choose page').selectOption({ label: title });
    await expect(canvas.getByRole('link', { name: 'Shared update', exact: true })).toBeVisible();
  }
  await page.getByLabel('Choose page').selectOption({ label: 'Our Beliefs' });
  await expect(canvas.getByRole('link', { name: 'About', exact: true })).toBeVisible();
  await tabs.getByRole('button', { name: 'Navigation', exact: true }).click();
  await page.getByRole('button', { name: 'New design' }).click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Delete design' }).click();
  await expect(page.getByRole('option', { name: 'New navigation', exact: true })).toHaveCount(0);
  expect(controls.saveRequests.length).toBeGreaterThan(0);
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
  const closingCheckout = page.waitForRequest(
    (request) => request.method() === 'PATCH' && request.url().endsWith('/checkout'),
  );
  await page.getByRole('button', { name: '← All drafts', exact: true }).click();
  const checkoutBody = (await closingCheckout).postDataJSON() as { viewState: { panel: string } };
  expect(checkoutBody.viewState.panel).toBe('settings');
  await expect(page.getByRole('heading', { name: 'Website drafts' })).toBeVisible();
});

test('Navigation Designer edits and reloads independently selected designs', async ({ page }) => {
  const document = upgradeNavigation(defaultSiteDocument);
  const secondary = {
    id: '00000000-0000-4000-8000-000000000037',
    name: 'Secondary navigation',
    items: [{ id: crypto.randomUUID(), label: 'Secondary link', href: '/give', children: [] }],
  };
  document.navigationDesigns!.push(secondary);
  await installApi(page, 'administrator', 'admin', (target) => Object.assign(target, document));
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();
  await page.getByRole('button', { name: 'Navigation', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Navigation design', exact: true })
    .selectOption(secondary.id);
  await page.getByLabel('Link label', { exact: true }).fill('Updated secondary');
  await page.getByRole('heading', { name: 'Navigation Designer', exact: true }).click();
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
  await page
    .getByRole('combobox', { name: 'Navigation design', exact: true })
    .selectOption(document.navigationDesigns![0].id);
  await expect(page.getByLabel('Link label', { exact: true })).toHaveValue('About');
  await page.getByRole('button', { name: 'Layout', exact: true }).click();
  const canvas = page.locator('.visual-editor iframe').contentFrame();
  await canvas.getByRole('button', { name: 'Church navigation', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Navigation design', exact: true })
    .selectOption(secondary.id);
  await expect(canvas.getByRole('link', { name: 'Updated secondary', exact: true })).toBeVisible();
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
  await page.reload();
  await expect(canvas.getByRole('link', { name: 'Updated secondary', exact: true })).toBeVisible();
  await canvas.getByRole('button', { name: 'Church navigation', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Navigation design', exact: true })).toHaveValue(
    secondary.id,
  );
  await expect(canvas.getByRole('button', { name: 'Resize navigation from east' })).toBeVisible();
});

test('compact categories and questions preserve edits without navigation revisions', async ({
  page,
}) => {
  const controls = await installApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();
  await expect(page.locator('.visual-editor iframe')).toBeVisible();
  for (const panel of ['Blocks', 'Outline', 'Pages', 'Properties']) {
    await page.getByRole('button', { name: panel, exact: true }).click();
  }
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  for (const category of ['Footer', 'Social', 'Collections', 'Design', 'Identity']) {
    await page
      .getByRole('navigation', { name: 'Settings categories' })
      .getByRole('button', { name: category, exact: true })
      .click();
  }
  expect(controls.saveRequests).toHaveLength(0);
  await page.getByLabel('Church name').fill('Compact editing');
  await page.getByRole('button', { name: 'Footer', exact: true }).click();
  await page.getByRole('button', { name: 'Identity', exact: true }).click();
  await expect(page.getByLabel('Church name')).toHaveValue('Compact editing');
  await expect.poll(() => controls.saveRequests.length).toBe(1);
  await page.getByLabel('Contact email').filter({ visible: true }).fill('invalid');
  await page.getByRole('button', { name: 'Design', exact: true }).click();
  await expect(page.getByLabel('Contact email').filter({ visible: true })).toBeFocused();
  await expect(page.getByText('A change needs attention before it can save.')).toBeVisible();
  await page.getByLabel('Contact email').filter({ visible: true }).fill('valid@example.com');
  await page.getByRole('button', { name: 'Forms', exact: true }).click();
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
  await expect(page.locator('.form-field-editor:visible')).toHaveCount(1);
  const summaries = page.locator('.question-summary');
  await summaries.last().click();
  await page.getByLabel('Question or label').filter({ visible: true }).fill('Last question edited');
  await summaries.first().click();
  await summaries.last().click();
  await expect(page.getByLabel('Question or label').filter({ visible: true })).toHaveValue(
    'Last question edited',
  );
  await page.getByRole('button', { name: 'Form details', exact: true }).click();
  await expect(page.getByLabel('Form name', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Questions', exact: true }).click();
  await expect(page.getByLabel('Question or label').filter({ visible: true })).toHaveValue(
    'Last question edited',
  );
});

test.describe('compact tablet workspace', () => {
  test.use({ hasTouch: true });
  test('fits portrait and landscape fixtures with reachable panels and touch controls', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName === 'firefox', 'Chromium and WebKit provide tablet touch emulation.');
    test.setTimeout(120_000);
    const controls = await installApi(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Open editor' }).click();
    await expect(page.locator('.visual-editor iframe')).toBeVisible();
    const sizes = [
      [744, 1133],
      [810, 1080],
      [820, 1180],
      [834, 1194],
      [834, 1210],
      [1024, 1366],
      [1032, 1376],
    ];
    for (const portrait of sizes)
      for (const [width, height] of [portrait, [...portrait].reverse()]) {
        await page.setViewportSize({ width, height });
        await page.getByRole('button', { name: 'Blocks', exact: true }).click();
        await page.getByRole('button', { name: 'Outline', exact: true }).click();
        await page.getByRole('button', { name: 'Pages', exact: true }).click();
        await expect(page.getByLabel('Choose page')).toBeVisible();
        const geometry = await page.evaluate(() => ({
          overflow: document.documentElement.scrollWidth > innerWidth,
          top: document.querySelector('.visual-editor iframe')!.getBoundingClientRect().top,
          targets: [...document.querySelectorAll('.layout-actions button')].map((button) => ({
            w: button.getBoundingClientRect().width,
            h: button.getBoundingClientRect().height,
          })),
        }));
        expect(geometry.overflow, `${width}×${height}`).toBe(false);
        expect(geometry.top, `${width}×${height} chrome`).toBeLessThanOrEqual(128);
        for (const target of geometry.targets) {
          expect(target.w).toBeGreaterThanOrEqual(44);
          expect(target.h).toBeGreaterThanOrEqual(44);
        }
      }
    expect(controls.saveRequests).toHaveLength(0);
  });

  test('keeps touch canvas handles and selected properties reachable after rotation', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName === 'firefox', 'Chromium and WebKit provide tablet touch emulation.');
    const controls = await installApi(page);
    await page.setViewportSize({ width: 820, height: 1180 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Open editor' }).click();
    const canvas = page.locator('.visual-editor iframe').contentFrame();
    await canvas.locator('.home-hero h1').click();
    await expect(page.getByLabel('Heading').filter({ visible: true })).toBeVisible();
    const handle = canvas.getByRole('button', { name: 'Resize Hero heading width', exact: true });
    const target = await handle.boundingBox();
    expect(target!.width).toBeGreaterThanOrEqual(43.9);
    expect(target!.height).toBeGreaterThanOrEqual(43.9);
    expect(
      await handle.evaluate((element) => {
        const frame = element.ownerDocument.defaultView!.frameElement!;
        return (
          (parseFloat(getComputedStyle(element).fontSize) * frame.getBoundingClientRect().width) /
          frame.clientWidth
        );
      }),
    ).toBeGreaterThanOrEqual(13.99);
    await page.getByLabel('Heading').filter({ visible: true }).fill('Rotate while editing');
    await page.setViewportSize({ width: 1180, height: 820 });
    await expect(page.getByLabel('Heading').filter({ visible: true })).toHaveValue(
      'Rotate while editing',
    );
    await page.setViewportSize({ width: 820, height: 1180 });
    await expect(page.getByLabel('Heading').filter({ visible: true })).toHaveValue(
      'Rotate while editing',
    );
    await expect.poll(() => controls.saveRequests.length).toBe(1);
    await page.getByLabel('Editor section', { exact: true }).selectOption({ label: 'Forms' });
    await page.getByRole('button', { name: 'Add field', exact: true }).click();
    await expect(page.getByLabel('Question or label').filter({ visible: true })).toBeFocused();
    await page.getByRole('button', { name: 'Duplicate field', exact: true }).click();
    await expect(page.getByLabel('Question or label').filter({ visible: true })).toBeFocused();
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(page.getByLabel('Question or label').filter({ visible: true })).toBeFocused();
  });
});

test('compact desktop chrome meets its budget across supported sizes', async ({ page }) => {
  const controls = await installApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();
  for (const [width, height] of [
    [1280, 720],
    [1440, 900],
    [1920, 1080],
    [2560, 1440],
  ]) {
    await page.setViewportSize({ width, height });
    await expect
      .poll(async () => (await page.locator('.visual-editor iframe').boundingBox())?.y ?? Infinity)
      .toBeLessThanOrEqual(112);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  expect(controls.saveRequests).toHaveLength(0);
});

test('compact workspace density measurements', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  test.skip(!process.env.BUILDER_DENSITY_MEASURE, 'Opt-in matched baseline/candidate measurements');
  await page.route('https://example.com/fixture-*.png', (route) =>
    route.fulfill({ contentType: 'image/png', body: previewPng }),
  );
  await installApi(
    page,
    'administrator',
    'admin',
    (document) => {
      const originalMedia = document.media;
      document.media = Array.from({ length: 20 }, (_, index) => ({
        ...structuredClone(originalMedia[index % originalMedia.length]),
        id: index < originalMedia.length ? originalMedia[index].id : crypto.randomUUID(),
      }));
      document.linkedMedia = Array.from({ length: 4 }, (_, index) => ({
        id: crypto.randomUUID(),
        type: index % 2 ? ('image' as const) : ('video' as const),
        url: `https://example.com/fixture-${index}.${index % 2 ? 'png' : 'mp4'}`,
        displayName: `Linked fixture ${index + 1}`,
        alternativeText: 'Synthetic Library example',
        tags: [],
      }));
      const originalBlocks = structuredClone(document.pages[0].blocks);
      while (document.pages[0].blocks.length < 12) {
        const copy = structuredClone(
          originalBlocks[document.pages[0].blocks.length % originalBlocks.length],
        );
        copy.id = crypto.randomUUID();
        copy.items = copy.items.map((item) => ({
          ...item,
          id: crypto.randomUUID(),
          element: { ...item.element, id: crypto.randomUUID() },
        }));
        document.pages[0].blocks.push(copy);
      }
      const form = document.forms[0];
      const types = [
        'text',
        'textarea',
        'email',
        'tel',
        'url',
        'number',
        'date',
        'time',
        'select',
        'radio',
        'checkbox',
        'text',
      ] as const;
      form.fields = types.map((type, index) => ({
        ...structuredClone(form.fields[0]),
        id: crypto.randomUUID(),
        name: `question${index}`,
        label: `Question ${index + 1}`,
        type,
        required: index % 2 === 0,
        options: ['select', 'radio', 'checkbox'].includes(type) ? ['First', 'Second'] : undefined,
      }));
    },
    true,
  );
  const measurements: Array<Record<string, unknown>> = [];
  for (const [width, height] of [
    [1440, 900],
    [820, 1180],
  ]) {
    await page.setViewportSize({ width, height });
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Open editor' })).toHaveCount(8);
    const measure = async (surface: string) => {
      const dimensions = await page.evaluate(() => {
        const rect = (selector: string) => {
          const el = document.querySelector(selector);
          if (!el) return null;
          const b = el.getBoundingClientRect();
          return {
            top: b.top,
            width: b.width,
            height: b.height,
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
          };
        };
        return {
          header: rect('.editor-header'),
          tabs: rect('.editor-tabs'),
          canvas: rect('.visual-editor iframe'),
          content: rect('#main-content'),
          drafts: rect('.drafts-panel'),
          fields: rect('.form-fields-list'),
          settings: rect('.settings-panel'),
        };
      });
      measurements.push({ width, height, surface, ...dimensions });
      await page.screenshot({ path: testInfo.outputPath(`${width}-${surface}.png`) });
    };
    await measure('Drafts');
    await page.getByRole('button', { name: 'Open editor' }).first().click();
    await expect(page.locator('.visual-editor iframe')).toBeVisible();
    await measure('Layout');
    for (const surface of ['Forms', 'Settings', 'Library', 'History', 'Admin']) {
      if (width <= 1100 && process.env.BUILDER_DENSITY_MEASURE !== 'baseline')
        await page.getByLabel('Editor section', { exact: true }).selectOption({ label: surface });
      else await page.getByRole('button', { name: surface, exact: true }).click();
      await expect(page.locator('#main-content')).toBeVisible();
      if (surface === 'Library') await expect(page.locator('.library-item')).toHaveCount(24);
      if (surface === 'History')
        await expect(page.locator('.revision-panel ol > li')).toHaveCount(30);
      if (surface === 'Admin') {
        await expect(page.getByRole('heading', { name: 'Capacity', exact: true })).toBeVisible();
        await expect(page.locator('.admin-card tbody tr')).toHaveCount(2);
      }
      await measure(surface);
      if (surface === 'Forms' && process.env.BUILDER_DENSITY_MEASURE !== 'baseline') {
        for (const question of await page.locator('.question-summary').all()) {
          await question.click();
          await expect(page.locator('.form-field-editor:visible')).toHaveCount(1);
          const type = await page
            .getByRole('combobox', { name: 'Answer type', exact: true })
            .filter({ visible: true })
            .inputValue();
          if (['select', 'radio', 'checkbox'].includes(type))
            await expect(
              page.getByLabel('Choices (one per line)').filter({ visible: true }),
            ).toHaveValue('First\nSecond');
        }
      }
      if (surface === 'Library') {
        await page.getByRole('button', { name: 'Archived items (2)', exact: true }).click();
        await expect(page.locator('.library-item')).toHaveCount(2);
        await measure('Archived-Library');
        await page.getByRole('button', { name: 'Back to Library', exact: true }).click();
      }
    }
    await page.getByRole('button', { name: '← All drafts' }).click();
    await expect(page.getByRole('button', { name: 'Open editor' })).toHaveCount(8);
  }
  await testInfo.attach('density-measurements', {
    body: JSON.stringify(measurements, null, 2),
    contentType: 'application/json',
  });
  console.log('DENSITY_MEASUREMENTS', JSON.stringify(measurements));
});

test('keeps authoring controls reachable with text enlarged to 200 percent', async ({ page }) => {
  const controls = await installApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();
  await page.addStyleTag({ content: 'html { font-size: 200%; }' });
  for (const section of ['Settings', 'Forms', 'Library', 'History', 'Admin', 'Layout']) {
    await page.getByRole('button', { name: section, exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await page.getByRole('button', { name: 'Properties', exact: true }).focus();
  await expect(page.getByRole('button', { name: 'Properties', exact: true })).toBeInViewport();
  expect(controls.saveRequests).toHaveLength(0);
});

test('preserves People image layouts through undo, redo, reload and preview', async ({ page }) => {
  const controls = await installApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();
  await page.getByLabel('Choose page').selectOption({ label: 'Leadership' });
  const canvas = page.locator('.visual-editor iframe').contentFrame();
  await canvas.locator('.person-card h2').first().click();
  const style = page.getByLabel('Layout style').filter({ visible: true });
  await expect(style).toHaveValue('leadership');
  await style.selectOption({ label: 'Horizontal Grid' });
  await expect(canvas.locator('.people-grid--horizontal')).toBeVisible();
  await expect.poll(() => controls.saveRequests.length).toBeGreaterThan(0);
  const savedPeople = () =>
    controls.saveRequests
      .at(-1)!
      .document.pages.find((item) => item.title === 'Leadership')!
      .blocks.flatMap((section) => section.items)
      .map((item) => item.element)
      .find((item) => item.type === 'people')!;
  const selections = savedPeople().personIds;
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(canvas.locator('.people-grid--horizontal')).toHaveCount(0);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(canvas.locator('.people-grid--horizontal')).toBeVisible();
  await expect.poll(() => savedPeople().variant).toBe('horizontal');
  await page.reload();
  await page.getByLabel('Choose page').selectOption({ label: 'Leadership' });
  await expect(canvas.locator('.people-grid--horizontal')).toBeVisible();
  expect(savedPeople().personIds).toEqual(selections);
  await canvas.locator('.person-card h2').first().click();
  await style.selectOption({ label: 'Standard People' });
  await expect(canvas.locator('.point-people__grid')).toBeVisible();
  await style.selectOption({ label: 'Horizontal Grid' });
  await expect(canvas.locator('.people-grid--horizontal')).toBeVisible();
  const geometry = (frame: FrameLocator) =>
    frame.locator('.person-card > img, .person-placeholder').evaluateAll((items) =>
      items.map((item) => {
        const rect = item.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      }),
    );
  const authored = await geometry(canvas);
  await page.getByRole('button', { name: 'Preview' }).click();
  await page
    .getByRole('combobox', { name: 'Page', exact: true })
    .selectOption({ label: 'Leadership' });
  await page.getByRole('button', { name: 'Preview at desktop width' }).click();
  const preview = page.locator('iframe.preview-frame').contentFrame();
  await expect(preview.locator('.people-grid--horizontal')).toBeVisible();
  const previewBounds = await geometry(preview);
  expect(previewBounds).toHaveLength(authored.length);
  for (const [index, bounds] of previewBounds.entries()) {
    expect(bounds.width).toBeCloseTo(authored[index].width, 2);
    expect(bounds.height).toBeCloseTo(authored[index].height, 2);
  }
});

async function readPending(page: Page): Promise<PendingJournalState | null> {
  return page.evaluate(
    () =>
      new Promise<PendingJournalState | null>((resolve, reject) => {
        const open = indexedDB.open('pointsite-builder-pending-v1', 1);
        open.onerror = () => reject(new Error('Journal fixture could not open'));
        open.onsuccess = () => {
          const database = open.result;
          const transaction = database.transaction('pending', 'readonly');
          const request = transaction.objectStore('pending').getAll();
          transaction.oncomplete = () => {
            database.close();
            const records = request.result as Array<{ payload: string | null }>;
            const payload = records.find((record) => record.payload)?.payload;
            resolve(payload ? (JSON.parse(payload) as PendingJournalState) : null);
          };
          transaction.onabort = () => {
            database.close();
            reject(new Error('Journal fixture could not read'));
          };
        };
      }),
  );
}

test('refresh restores pending text with the same action identity and clears its acknowledged journal', async ({
  page,
}) => {
  await page.unroute('**/api/**');
  const controls = await installApi(page);
  // Keep HTTP fixture access available while the editor observes an offline connection.
  await page.addInitScript(() =>
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Church name').fill('Pending church name after refresh');
  await expect(page.locator('.pending-journal-status')).toHaveText(
    'Pending changes protected on this browser.',
  );
  const pending = await readPending(page);
  expect(pending?.actions).toHaveLength(1);
  expect(controls.saveRequests).toHaveLength(0);
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('Church name')).toHaveValue('Pending church name after refresh');
  await expect(page.locator('.pending-journal-status')).toHaveText(
    'Pending changes protected on this browser.',
  );
  expect((await readPending(page))?.actions[0].idempotencyKey).toBe(
    pending?.actions[0].idempotencyKey,
  );
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
    window.dispatchEvent(new Event('online'));
  });
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
  await expect.poll(() => readPending(page)).toBeNull();
  expect(controls.saveRequests).toHaveLength(1);
  expect(controls.saveRequests[0]).toMatchObject({
    idempotencyKey: pending?.actions[0].idempotencyKey,
    expectedRevisionId: pending?.baseRevisionId,
    action: { category: 'text-edit', context: 'site-settings' },
  });
});

test('denied browser storage blocks recovery without sending and reports explicit discard failure', async ({
  page,
}) => {
  await page.unroute('**/api/**');
  const controls = await installApi(page);
  await page.addInitScript(() => {
    IDBFactory.prototype.open = () => {
      throw new DOMException('Storage denied', 'SecurityError');
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor', exact: true }).click();
  await expect(
    page
      .getByRole('region', { name: 'Autosave recovery' })
      .or(page.getByRole('alert', { name: 'Autosave recovery' })),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy pending draft' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Retry recovery' }).click();
  await expect(page.getByText('Pending recovery needs attention.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Discard pending changes and leave' }).click();
  await expect(
    page.getByText('Recovery could not be cleared safely. Keep this tab open and retry.'),
  ).toBeVisible();
  expect(controls.saveRequests).toHaveLength(0);
});

test('lost access preserves pending changes and allows local discard without a remote read', async ({
  page,
}) => {
  await page.unroute('**/api/**');
  await installApi(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => {} },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Church name').fill('Preserve after permission change');
  await expect(page.locator('.pending-journal-status')).toHaveText(
    'Pending changes protected on this browser.',
  );
  const pending = await readPending(page);
  expect(pending).not.toBeNull();
  let saves = 0;
  let draftReads = 0;
  await page.route(`**/api/drafts/${pending!.scope.draftId}`, (route) => {
    if (route.request().method() === 'PUT') saves += 1;
    if (route.request().method() === 'GET') draftReads += 1;
    return route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: '{"code":"FORBIDDEN","message":"Access changed"}',
    });
  });
  await page.route('**/api/drafts/*/checkout', (route) =>
    route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: '{"code":"FORBIDDEN","message":"Access changed"}',
    }),
  );
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
    window.dispatchEvent(new Event('online'));
  });
  await expect(page.getByText('Editing access is unavailable.', { exact: true })).toBeVisible();
  expect((await readPending(page))?.actions).toHaveLength(1);
  const sendsAtAccessLoss = saves;
  expect(sendsAtAccessLoss).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: 'Copy pending draft' }).click();
  await page.getByRole('button', { name: 'Discard pending changes and leave' }).click();
  await expect(page.getByRole('button', { name: 'Open editor', exact: true })).toBeVisible();
  expect(await readPending(page)).toBeNull();
  expect(saves).toBe(sendsAtAccessLoss);
  expect(draftReads).toBe(0);
});

test('automatic recovery cannot take a superseded checkout before explicit Open editor', async ({
  page,
}) => {
  await page.unroute('**/api/**');
  const controls = await installApi(page);
  await page.addInitScript(() =>
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Church name').fill('Pending before transfer');
  await expect(page.locator('.pending-journal-status')).toHaveText(
    'Pending changes protected on this browser.',
  );
  const pending = await readPending(page);
  const attempts: boolean[] = [];
  await page.route('**/api/drafts/*/checkout', (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const input = route.request().postDataJSON() as { resumeOnly?: boolean };
    attempts.push(Boolean(input.resumeOnly));
    return input.resumeOnly
      ? route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: '{"code":"CONFLICT","message":"Checkout moved to another client"}',
        })
      : route.fallback();
  });
  await page.reload();
  await expect.poll(() => attempts).toEqual([true]);
  await expect(page.getByRole('button', { name: 'Open editor', exact: true })).toBeVisible();
  expect(controls.saveRequests).toHaveLength(0);
  expect((await readPending(page))?.actions[0].idempotencyKey).toBe(
    pending?.actions[0].idempotencyKey,
  );
  await page.getByRole('button', { name: 'Open editor', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('Church name')).toHaveValue('Pending before transfer');
  expect(attempts).toEqual([true, false]);
});

for (const kind of ['control', 'unfinished resize']) {
  test(`refresh restores a pending ${kind} before continuing remote saves`, async ({ page }) => {
    await page.unroute('**/api/**');
    const controls = await installApi(page);
    await page.addInitScript(() =>
      Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }),
    );
    await page.goto('/');
    await page.getByRole('button', { name: 'Open editor', exact: true }).click();
    if (kind === 'control') {
      await page.getByRole('button', { name: 'Forms', exact: true }).click();
      await page.getByRole('button', { name: 'New form', exact: true }).click();
    } else {
      await page.getByLabel('Choose page').selectOption({ label: 'Our Beliefs' });
      const canvas = page.locator('.visual-editor iframe').contentFrame();
      await canvas.getByRole('heading', { level: 1, name: 'Our Beliefs' }).click();
      const handle = canvas.getByRole('button', { name: 'Resize Hero body width', exact: true });
      const box = await handle.boundingBox();
      expect(box).not.toBeNull();
      await handle.dispatchEvent('pointerdown', {
        pointerId: 7,
        clientX: box!.x + box!.width / 2,
        clientY: box!.y + box!.height / 2,
      });
      await canvas.locator('body').dispatchEvent('pointermove', {
        pointerId: 7,
        clientX: box!.x - 90,
        clientY: box!.y + box!.height / 2,
      });
    }
    await expect(page.locator('.pending-journal-status')).toHaveText(
      'Pending changes protected on this browser.',
    );
    const before = await readPending(page);
    const action = kind === 'control' ? before?.actions.at(-1) : before?.staged;
    expect(action).toBeTruthy();
    if (kind !== 'control') expect(before?.actions).toHaveLength(0);
    expect(controls.saveRequests).toHaveLength(0);
    await page.reload();
    await expect(page.locator('.pending-journal-status')).toHaveText(
      'Pending changes protected on this browser.',
    );
    const restored = await readPending(page);
    expect(restored?.actions[0].document).toEqual(action?.document);
    expect(restored?.actions[0].idempotencyKey).toBe(action?.idempotencyKey);
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
      window.dispatchEvent(new Event('online'));
    });
    await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
    await expect.poll(() => readPending(page)).toBeNull();
    expect(controls.saveRequests).toHaveLength(1);
    expect(controls.saveRequests[0]).toMatchObject({
      idempotencyKey: action?.idempotencyKey,
      action: action?.action,
      document: action?.document,
    });
  });
}

test('sign-out requires explicit pending discard and preserves another actor recovery', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  await page.evaluate(async (draft) => {
    const source = '/src/client/editor/pending-journal.ts';
    const { PendingJournal } = (await import(source)) as typeof JournalModule;
    for (const actor of ['administrator@pointatx.org', 'another-user@pointatx.org']) {
      const scope = { actor, draftId: draft.id, clientId: 'signout-browser-0001' };
      const journal = new PendingJournal(scope);
      await journal.load();
      await journal.write({
        version: 1,
        scope,
        baseRevisionId: draft.latestRevisionId,
        baseChecksum: draft.revision.checksum,
        updatedAt: new Date().toISOString(),
        staged: null,
        actions: [
          {
            idempotencyKey: crypto.randomUUID(),
            document: draft.document,
            action: { category: 'text-edit', context: 'site-settings' },
            expectedRevisionId: null,
            expectedChecksum: null,
            ready: false,
          },
        ],
      });
    }
  }, original());
  let logoutRequests = 0;
  await page.route('**/auth/logout', (route) => {
    logoutRequests += 1;
    return route.fulfill({ contentType: 'text/html', body: '<h1>Signed out fixture</h1>' });
  });
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('alert', { name: 'Pending changes before sign out' })).toBeVisible();
  expect(logoutRequests).toBe(0);
  await page.getByRole('button', { name: 'Keep working' }).click();
  await expect(page.getByRole('alert', { name: 'Pending changes before sign out' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByRole('button', { name: 'Discard my pending changes and sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Signed out fixture' })).toBeVisible();
  expect(logoutRequests).toBe(1);
  const remaining = await page.evaluate(async () => {
    const source = '/src/client/editor/pending-journal.ts';
    const { PendingJournal } = (await import(source)) as typeof JournalModule;
    return [
      await PendingJournal.countPending('administrator@pointatx.org'),
      await PendingJournal.countPending('another-user@pointatx.org'),
    ];
  });
  expect(remaining).toEqual([0, 1]);
});

test('renames inline with keyboard and pointer while keeping publishing, history and list names consistent', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor', exact: true }).click();
  await page.getByRole('button', { name: 'Rename draft' }).focus();
  await page.keyboard.press('Enter');
  const input = page.getByRole('textbox', { name: 'Draft name', exact: true });
  await expect(input).toBeFocused();
  await input.fill('Canceled');
  await input.press('Escape');
  await expect(page.getByRole('heading', { name: 'Sunday update', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rename draft' })).toBeFocused();
  await page.getByRole('heading', { name: 'Sunday update', exact: true }).dblclick();
  await input.fill('  Renamed Sunday  ');
  await input.press('Enter');
  await expect(page.getByRole('heading', { name: 'Renamed Sunday', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rename draft' })).toBeFocused();
  await expect(page.locator('.save-state')).toHaveText('All changes saved');
  await expect(page.locator('.editor-header')).toContainText(
    'Unknown public site baseline - Revision 1',
  );
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('Renamed Sunday', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close publishing window' }).click();
  await page.getByRole('button', { name: '← All drafts' }).click();
  await expect(page.locator('.draft-card h2')).toHaveText('Renamed Sunday');
  await page.reload();
  await expect(page.locator('.draft-card h2')).toHaveText('Renamed Sunday');
});

test('rename pencil stays beside short and long titles without growing the header', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor', exact: true }).click();
  const pencil = page.getByRole('button', { name: 'Rename draft' });
  const title = page.locator('.draft-name .editor-title');
  await expect(pencil).toHaveAttribute('title', 'Rename draft');
  await expect(pencil).toHaveText('');
  for (const width of [1440, 1280, 920, 768, 721]) {
    await page.setViewportSize({ width, height: 900 });
    let headerHeight = 0;
    for (const name of ['Sunday', 'LongUnbrokenDraftName'.repeat(5).slice(0, 100)]) {
      await pencil.click();
      await page.getByLabel('Draft name', { exact: true }).fill(name);
      await page.getByRole('button', { name: 'Save name' }).click();
      await expect(title).toHaveText(name);
      await expect(pencil).toBeFocused();
      const buttonBox = (await pencil.boundingBox())!;
      const titleBox = (await title.boundingBox())!;
      expect(Math.round(buttonBox.width)).toBeGreaterThanOrEqual(44);
      expect(Math.round(buttonBox.height)).toBeGreaterThanOrEqual(44);
      expect(buttonBox.x).toBeGreaterThanOrEqual(titleBox.x + titleBox.width);
      expect(buttonBox.x - titleBox.x - titleBox.width).toBeLessThanOrEqual(8);
      expect(buttonBox.y + buttonBox.height / 2).toBeCloseTo(titleBox.y + titleBox.height / 2, 0);
      expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(width);
      const height = (await page.locator('.editor-header').boundingBox())!.height;
      if (headerHeight) expect(height).toBe(headerHeight);
      headerHeight = height;
    }
  }
  await pencil.press('Space');
  await expect(page.getByLabel('Draft name', { exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(pencil).toBeFocused();
});

test('rename failure can retry without changing autosave and fits supported narrow and enlarged-text layouts', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor', exact: true }).click();
  let attempts = 0;
  await page.route('**/api/drafts/10000000-0000-4000-8000-000000000001', async (route) => {
    if (route.request().method() === 'PATCH' && attempts++ === 0) {
      await route.fulfill({ status: 503, json: { code: 'UNAVAILABLE', message: 'Try again' } });
    } else await route.fallback();
  });
  await page.getByRole('button', { name: 'Rename draft' }).click();
  const input = page.getByLabel('Draft name', { exact: true });
  await input.fill('x'.repeat(101));
  await input.press('Enter');
  await expect(page.locator('.draft-name [role=alert]')).toContainText('1–100');
  await input.fill('Retry Sunday');
  await input.press('Enter');
  await expect(page.locator('.draft-name [role=alert]')).toContainText('Try again');
  await expect(input).toHaveValue('Retry Sunday');
  await expect(input).toBeFocused();
  await expect(page.locator('.save-state')).toHaveText('All changes saved');
  for (const width of [1280, 920, 768, 721]) {
    await page.setViewportSize({ width, height: 900 });
    const box = await input.boundingBox();
    expect(box!.width).toBeGreaterThan(50);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    for (const button of await page.locator('.draft-name button').all()) {
      const bounds = await button.boundingBox();
      expect(bounds!.height).toBeGreaterThanOrEqual(44);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator('.draft-name').evaluate((element) => {
    const elements = [element, ...element.querySelectorAll<HTMLElement>('*')];
    const sizes = elements.map((item) => parseFloat(getComputedStyle(item).fontSize));
    elements.forEach((item, index) => {
      (item as HTMLElement).style.fontSize = `${sizes[index] * 2}px`;
    });
  });
  expect(
    await page
      .locator('.draft-name')
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  await input.press('Enter');
  await expect(page.getByRole('heading', { name: 'Retry Sunday', exact: true })).toBeVisible();
});

for (const role of ['viewer', 'editor', 'publisher'] as const) {
  test(`rename access for ${role}`, async ({ page }) => {
    await installApi(page, role);
    await page.goto('/');
    await page
      .getByRole('button', {
        name: role === 'viewer' ? 'Open preview' : 'Open editor',
        exact: true,
      })
      .click();
    if (role === 'viewer') {
      await expect(page.getByRole('button', { name: 'Rename draft' })).toHaveCount(0);
    } else {
      await page.getByRole('button', { name: 'Rename draft' }).click();
      await page.getByLabel('Draft name', { exact: true }).fill(`${role} name`);
      await page.getByRole('button', { name: 'Save name' }).click();
      await expect(page.getByRole('heading', { name: `${role} name`, exact: true })).toBeVisible();
    }
  });
}

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
  const lifecycleProofs: Record<string, string>[] = [];
  const lifecycleStatuses: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (/^\/api\/drafts\/[^/]+$/.test(path) && ['PATCH', 'DELETE'].includes(request.method()))
      lifecycleProofs.push(request.headers());
    if (path.endsWith('/checkout') && request.method() === 'POST') {
      const input = request.postDataJSON() as { expectedStatus?: string };
      if (input.expectedStatus) lifecycleStatuses.push(input.expectedStatus);
    }
  });
  await page.goto('/');
  await page.getByLabel('New draft name').fill('Fall launch');
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page.getByRole('dialog', { name: 'Create Fall launch' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog', { name: 'Create Fall launch' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Create draft' })).toBeFocused();
  await page.getByRole('button', { name: 'Create draft' }).click();
  await page.getByLabel('Copy published site from').selectOption('production');
  await expect(page.getByText('Local fixture ready')).toBeVisible();
  await page.getByRole('button', { name: 'Create independent draft' }).click();
  await expect(page.getByRole('heading', { name: 'Fall launch', exact: true })).toBeVisible();
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
  const previewRead = page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' &&
      new URL(response.url()).pathname === '/api/drafts/10000000-0000-4000-8000-000000000001',
  );
  await sourceCard.getByRole('button', { name: 'Open editor' }).click();
  await previewRead;
  await expect(page.locator('iframe.preview-frame')).toBeVisible();
  await expect(page.locator('.visual-editor')).toHaveCount(0);
  await page.getByRole('button', { name: '← All drafts' }).click();

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
  expect(lifecycleStatuses).toEqual(['active', 'archived', 'active', 'archived']);
  expect(lifecycleProofs).toHaveLength(4);
  for (const proof of lifecycleProofs) {
    expect(proof['x-draft-checkout']).toBe('30000000-0000-4000-8000-000000000001');
    expect(proof['x-draft-revision']).toMatch(/^[a-f0-9-]{36}$/);
    expect(proof['if-match']).toMatch(/^"[a-f0-9]{64}"$/);
  }
});

test('operates page modules by keyboard and announces the result', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();
  const canvas = page.locator('.visual-editor iframe').contentFrame();
  await expect(canvas.locator('.home-hero')).toHaveCount(1);
  await page.getByRole('button', { name: 'Outline', exact: true }).click();
  const duplicate = page.getByRole('button', { name: /Duplicate hero section/i }).first();
  await duplicate.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'hero section duplicated.' })).toHaveText(
    /hero section duplicated/i,
  );
  await expect(page.getByRole('button', { name: /Duplicate hero section/i })).toHaveCount(2);
  await expect(page.getByRole('button', { name: /Duplicate hero section/i }).first()).toBeFocused();
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

  await page.getByRole('button', { name: 'Blocks', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Hero', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Outline', exact: true }).click();
  await expect(
    page.locator('.structure-panel').getByText('Page hero', { exact: true }),
  ).toBeVisible();
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
  await page.getByRole('button', { name: 'Switch to Phone viewport' }).click();
  await expect.poll(() => canvas.locator('body').evaluate(() => window.innerWidth)).toBe(360);
  await page.getByRole('button', { name: 'Remove Page hero', exact: true }).click();
  await expect.poll(() => canvas.locator('body').evaluate(() => window.innerWidth)).toBe(1280);
  await expect(canvas.locator('.page-hero')).toHaveCount(1);
  await page.getByRole('button', { name: 'Remove Page hero copy', exact: true }).click();
  await expect(canvas.locator('.page-hero')).toHaveCount(0);
  await expect.poll(() => canvas.locator('body').evaluate(() => window.innerWidth)).toBe(1280);
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
  await page.getByRole('button', { name: 'Blocks', exact: true }).click();
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

  await expect(canvas.getByRole('heading', { level: 1, name: 'Welcome' })).toBeVisible();
  await expect(page.getByLabel('Layout style').filter({ visible: true })).toHaveValue('standard');
  await page.getByLabel('Layout style').filter({ visible: true }).selectOption('pageHero');
  await page.getByLabel('Heading').filter({ visible: true }).fill('Replacement page hero');
  await expect(
    canvas.getByRole('heading', { level: 1, name: 'Replacement page hero' }),
  ).toBeVisible();

  await expect(page.getByText('All changes saved')).toBeVisible();
  await page.reload();
  await page.getByLabel('Choose page').selectOption({ label: 'Who We Are' });
  canvas = page.locator('.visual-editor iframe').contentFrame();
  await expect(
    canvas.getByRole('heading', { level: 1, name: 'Replacement page hero' }),
  ).toBeVisible();
  await expect(canvas.getByRole('button', { name: 'Edit global footer' })).toBeVisible();
});

for (const surface of ['transparent', 'canvas', 'primary'] as const) {
  for (const sectionSurface of ['image', 'canvas', 'surface', 'primary'] as const) {
    test(`Navigation ${surface} colors over ${sectionSurface} match canvas and Preview`, async ({
      page,
      browserName,
    }) => {
      await installApi(page, 'administrator', 'admin', (document) => {
        Object.assign(document.theme.colors, {
          canvas: '#f2eadf',
          text: '#172536',
          primary: '#243c64',
          onPrimary: '#fff2d6',
          surface: '#e0e8ee',
          mutedText: '#bb2233',
          border: '#cc4488',
        });
        const header = document.pages[0].blocks.find((section) => section.name === 'Site header');
        if (!header) throw new Error('Expected header fixture');
        header.position = sectionSurface === 'image' ? 'overlay' : 'flow';
        header.surface = sectionSurface === 'image' ? 'transparent' : sectionSurface;
        const placement = header.items.find((item) => item.element.type === 'navigation');
        const navigation = placement?.element;
        if (!navigation || navigation.type !== 'navigation') throw new Error('Expected Navigation');
        navigation.surface = surface;
        if (placement?.grid) {
          placement.grid.mobile = { column: 9, row: 1, columnSpan: 4, rowSpan: 3 };
          placement.grid.tablet = { column: 11, row: 1, columnSpan: 2, rowSpan: 2 };
        }
      });
      const panelBackground = surface === 'canvas' ? 'rgb(242, 234, 223)' : 'rgb(36, 60, 100)';
      const panelText = surface === 'canvas' ? 'rgb(23, 37, 54)' : 'rgb(255, 242, 214)';
      const rootText =
        surface === 'primary' ||
        (surface === 'transparent' && ['image', 'primary'].includes(sectionSurface))
          ? 'rgb(255, 242, 214)'
          : 'rgb(23, 37, 54)';
      await page.goto('/');
      await page.getByRole('button', { name: 'Open editor' }).click();
      const canvas = page.locator('.visual-editor iframe').contentFrame();
      for (const device of ['Phone', 'Tablet', 'Desktop']) {
        await page.getByRole('button', { name: `Switch to ${device} viewport` }).click();
        await expect(canvas.locator('.point-navigation')).toHaveCSS('color', rootText);
        await expect(canvas.locator('.point-navigation__dropdown').first()).toHaveCSS(
          'background-color',
          panelBackground,
        );
        await expect(canvas.locator('.point-navigation__dropdown a').first()).toHaveCSS(
          'color',
          panelText,
        );
      }
      await page.getByRole('button', { name: 'Preview', exact: true }).click();
      const preview = page.locator('iframe.preview-frame').contentFrame();
      for (const device of ['phone', 'tablet', 'desktop']) {
        await page.getByRole('button', { name: `Preview at ${device} width` }).click();
        const toggle = preview.getByRole('button', { name: 'Menu', exact: true });
        const menu = preview.getByRole('navigation', { name: 'Church navigation' });
        const parent = menu.getByRole('link', { name: 'About', exact: true });
        const child = menu.getByRole('link', { name: 'Who We Are', exact: true });
        const dropdown = preview.locator('.point-navigation__dropdown').first();
        if (device === 'phone') {
          await preview.locator('html').evaluate((element) => {
            element.style.fontSize = '32px';
          });
        }
        if (device !== 'desktop') {
          if ((await toggle.getAttribute('aria-expanded')) === 'true') await toggle.press('Enter');
          await expect(toggle).toHaveCSS('color', rootText);
          const closedToggleTop = await toggle.evaluate(
            (element) => element.getBoundingClientRect().top + window.scrollY,
          );
          await toggle.press('Enter');
          await expect(toggle).toHaveAttribute('aria-expanded', 'true');
          await expect(toggle).toHaveCSS('background-color', panelBackground);
          await expect(toggle).toHaveCSS('color', panelText);
          await expect(menu).toHaveCSS('background-color', panelBackground);
          await expect(parent).toHaveCSS('color', panelText);
          expect(
            await menu.evaluate((element) => {
              const bounds = element.getBoundingClientRect();
              return (
                bounds.left + window.scrollX >= 0 &&
                bounds.right + window.scrollX <= window.innerWidth
              );
            }),
          ).toBe(true);
          expect(
            await toggle.evaluate(
              (element) => element.getBoundingClientRect().top + window.scrollY,
            ),
          ).toBeCloseTo(closedToggleTop, 0);
        } else {
          await parent.hover();
          await expect(parent).toHaveCSS('text-decoration-line', 'underline');
        }
        await expect(dropdown).toHaveCSS('opacity', '1');
        await expect(dropdown).toHaveCSS('background-color', panelBackground);
        await expect(child).toHaveCSS('color', panelText);
        if (device === 'phone') {
          expect(await menu.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
            true,
          );
        }
        await expect(preview.locator('.point-layout-item').filter({ has: menu })).toHaveCSS(
          'overflow',
          'visible',
        );
        await expect(
          preview.locator('.point-layout-section__grid').filter({ has: menu }),
        ).toHaveCSS('overflow', 'visible');
        await parent.focus();
        await parent.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
        await expect(child).toBeFocused();
        await expect(child).toHaveCSS('outline-style', 'solid');
        await expect(child).toHaveCSS('outline-color', panelText);
        await expect(child).toHaveCSS('text-decoration-line', 'underline');
        await expect(child).toHaveCSS('color', panelText);
        if (device !== 'desktop') {
          await toggle.press('Enter');
          await expect(toggle).toHaveAttribute('aria-expanded', 'false');
          await expect(menu).toBeHidden();
          await preview.locator('html').evaluate((element) => {
            element.style.fontSize = '';
          });
        } else {
          await child.press('Enter');
          await expect(
            preview.getByRole('heading', { level: 1, name: 'Who We Are' }),
          ).toBeVisible();
        }
      }
    });
  }
}

test('right-aligned Navigation dropdowns stay inside the published viewport', async ({ page }) => {
  await installApi(page, 'administrator', 'admin', (document) => {
    const navigation = document.navigationDesigns![0].items;
    navigation.at(-1)!.children = [
      { id: '70000000-0000-4000-8000-000000000070', label: 'Contact details', href: '/contact' },
    ];
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  const preview = page.locator('iframe.preview-frame').contentFrame();
  await page.getByRole('button', { name: 'Preview at desktop width' }).click();
  const menu = preview.getByRole('navigation', { name: 'Church navigation' });
  const parent = menu.getByRole('link', { name: 'Contact', exact: true });
  const dropdown = menu.locator('.point-navigation__dropdown').last();
  const fits = () =>
    preview.locator('html').evaluate((element) => element.scrollWidth <= innerWidth + 1);
  await expect.poll(fits).toBe(true);
  await parent.hover();
  await expect(dropdown).toHaveCSS('opacity', '1');
  expect(
    await dropdown.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return bounds.left >= 0 && bounds.right <= innerWidth;
    }),
  ).toBe(true);
  await parent.focus();
  await expect(menu.getByRole('link', { name: 'Contact details', exact: true })).toBeVisible();
  await expect.poll(fits).toBe(true);
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
  await preview.locator('.point-composed-footer').scrollIntoViewIfNeeded();
  await expect(preview.locator('.point-composed-footer')).toBeVisible();
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
    await expect(preview.locator('.point-composed-footer')).toBeAttached();
  }
});

test('preserves authored headings on wider Desktop viewports', async ({ page }) => {
  await installApi(page, 'administrator', 'admin', (document) => {
    const hero = document.pages[0].blocks
      .flatMap((section) => section.items)
      .map((item) => item.element)
      .find((element) => element.type === 'hero');
    if (!hero || hero.type !== 'hero') throw new Error('Expected home Hero');
    hero.heading = 'Point Community Church';
    hero.headingWidth = { desktop: 70, tablet: 90, mobile: 100 };
    const header = document.pages[0].blocks.find((section) => section.name === 'Site header');
    if (!header) throw new Error('Expected site header');
    header.width = 'full';
  });
  const measure = (surface: FrameLocator) =>
    surface.locator('body').evaluate(async () => {
      await document.fonts.ready;
      const geometry = (element: Element) => {
        const bounds = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const pixels = (value: number) => Number(value.toFixed(3));
        return {
          width: pixels(bounds.width),
          height: pixels(bounds.height),
          centerOffset: pixels(bounds.left + bounds.width / 2 - innerWidth / 2),
          fontSize: style.fontSize,
        };
      };
      return {
        viewport: innerWidth,
        overflow: document.documentElement.scrollWidth - innerWidth,
        headings: Array.from(document.querySelectorAll('.home-hero h1, .home-intro h2')).map(
          (element) => ({
            ...geometry(element),
            lines: Math.round(
              element.getBoundingClientRect().height /
                Number.parseFloat(getComputedStyle(element).lineHeight),
            ),
          }),
        ),
        grid: Array.from(
          document.querySelectorAll('section[aria-label="Site header"] .point-layout-item--grid'),
        ).map(geometry),
      };
    });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();
  const canvas = page.locator('.visual-editor iframe').contentFrame();
  await expect(canvas.getByRole('heading', { name: 'Point Community Church' })).toBeVisible();
  await expect.poll(() => canvas.locator('body').evaluate(() => innerWidth)).toBe(1280);
  const authored = await measure(canvas);
  await page.reload();
  await expect(canvas.getByRole('heading', { name: 'Point Community Church' })).toBeVisible();
  await expect.poll(() => canvas.locator('body').evaluate(() => innerWidth)).toBe(1280);
  expect(await measure(canvas)).toEqual(authored);
  await page.getByRole('button', { name: 'Preview' }).click();
  await page.getByRole('button', { name: 'Preview at desktop width' }).click();
  const frame = page.locator('iframe.preview-frame');
  const preview = frame.contentFrame();
  const samples = [];
  for (const width of [1280, 1281, 1360, 1440, 1920, 2560, 1280]) {
    await frame.evaluate((element, value) => {
      element.style.width = `${value}px`;
    }, width);
    samples.push(await measure(preview));
  }
  expect(samples[0].headings.map((heading) => heading.lines)).toEqual([1, 1]);
  expect(samples[0].headings).toEqual(authored.headings);
  expect(samples[0].grid).toEqual(authored.grid);
  for (const sample of samples) {
    expect(sample.overflow).toBe(0);
    expect(sample.headings).toEqual(samples[0].headings);
    expect(sample.grid).toEqual(samples[0].grid);
  }
  for (const width of [900, 901, 768, 520, 521, 360, 320, 1280]) {
    await frame.evaluate((element, value) => {
      element.style.width = `${value}px`;
    }, width);
    const sample = await measure(preview);
    expect(sample.overflow).toBe(0);
    await expect(preview.locator('.home-hero .point-hero-text-box--heading')).toHaveCSS(
      '--point-hero-text-width',
      width <= 520 ? '100%' : width <= 900 ? '90%' : '70%',
    );
  }
  await frame.evaluate((element) => {
    element.style.width = '640px';
  });
  await preview.locator('html').evaluate((element) => {
    element.style.fontSize = '200%';
  });
  expect((await measure(preview)).overflow).toBe(0);
  await preview.getByRole('button', { name: 'Menu', exact: true }).press('Enter');
  await expect(preview.getByRole('link', { name: 'About', exact: true })).toBeVisible();
});

for (const fixture of ['existing pages', 'every Block variant'] as const)
  test(`matches complete authored ${fixture} in Preview and publication`, async ({ page }) => {
    test.setTimeout(180_000);
    const source = fixture === 'existing pages' ? defaultSiteDocument : blockCatalogDocument();
    await installApi(page, 'administrator', 'admin', (document) => Object.assign(document, source));
    const measure = async (frame: FrameLocator) => {
      await frame.owner().scrollIntoViewIfNeeded();
      // Scrolling a surface under the pointer can open a navigation dropdown.
      await page.mouse.move(0, 0);
      return frame.locator('.point-site').evaluate(async (root) => {
        await document.fonts.ready;
        await Promise.all(
          Array.from(root.querySelectorAll('img')).map((image) => {
            image.loading = 'eager';
            return image.decode().catch(() => {});
          }),
        );
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await Promise.all(
          root
            .getAnimations({ subtree: true })
            .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
            .map((animation) => animation.finished.catch(() => {})),
        );
        return Array.from(
          root.querySelectorAll(
            'h1,h2,h3,h4,p,a,img,figure,address,video,iframe,.point-layout-item',
          ),
        )
          .filter(
            (element) =>
              !element.closest('.sr-only,[aria-hidden="true"]') &&
              element.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
          )
          .map((element) => {
            const bounds = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return {
              tag: element.tagName,
              kind: element.matches('.point-layout-item')
                ? element.firstElementChild?.className
                : element.className,
              text: element.matches('.point-layout-item') ? undefined : element.textContent?.trim(),
              font: style.font,
              color: style.color,
              background: style.backgroundColor,
              backgroundImage: style.backgroundImage,
              objectFit: style.objectFit,
              overflow: style.overflow,
              bounds: [bounds.x, bounds.y, bounds.width, bounds.height],
            };
          });
      });
    };
    await page.goto('/');
    await page.getByRole('button', { name: 'Open editor' }).click();
    const canvasElement = page.locator('.visual-editor iframe');
    const canvas = canvasElement.contentFrame();
    const authored = new Map<string, Awaited<ReturnType<typeof measure>>[]>();
    const viewports = [
      { name: 'desktop', ...siteViewports.desktop },
      { name: 'desktop', ...siteViewports.desktop, width: 1920 },
      { name: 'tablet', ...siteViewports.tablet },
      { name: 'phone', ...siteViewports.phone },
    ] as const;
    for (const target of source.pages) {
      await page.getByLabel('Choose page').selectOption(target.id);
      await expect(canvas.locator('.point-site')).toBeVisible();
      const samples = [];
      for (const viewport of viewports) {
        const button = page.getByRole('button', { name: `Switch to ${viewport.label} viewport` });
        if (await button.isEnabled()) await button.click();
        await canvasElement.evaluate((frame, width) => {
          frame.style.width = width === 1920 ? '1920px' : '100%';
        }, viewport.width);
        await expect
          .poll(() => canvas.locator('body').evaluate(() => [innerWidth, innerHeight]))
          .toEqual([viewport.width, viewport.height]);
        const sample = await measure(canvas);
        samples.push(sample);
        if (
          fixture === 'every Block variant' &&
          target === source.pages[0] &&
          viewport.width === 1280
        ) {
          await page.getByRole('button', { name: 'Properties', exact: true }).click();
          await page.getByRole('button', { name: 'Zoom viewport out', exact: true }).click();
          expect(await measure(canvas), 'panels and zoom preserve authored geometry').toEqual(
            sample,
          );
          await page.getByRole('button', { name: 'Properties', exact: true }).click();
        }
      }
      authored.set(target.route, samples);
    }
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    const previewElement = page.locator('iframe.preview-frame');
    const preview = previewElement.contentFrame();
    await page.evaluate(() => {
      const frame = document.createElement('iframe');
      frame.id = 'published-page';
      frame.style.cssText = 'border:0;height:900px';
      document.body.appendChild(frame);
    });
    const publishedElement = page.locator('#published-page');
    const published = publishedElement.contentFrame();
    for (const target of source.pages) {
      await page.getByRole('combobox', { name: 'Page', exact: true }).selectOption(target.id);
      const html = await page.evaluate(
        async ({ document, route }) => {
          const modulePath = '/tests/fixtures/hero-publication.tsx';
          const { publishedHtml } = (await import(modulePath)) as typeof HeroPublication;
          return publishedHtml(document, route);
        },
        { document: source, route: target.route },
      );
      await publishedElement.evaluate(
        (frame, value) => ((frame as HTMLIFrameElement).srcdoc = value),
        html,
      );
      await expect(published.locator('.point-site')).toBeVisible();
      for (const [index, { name, width, height }] of viewports.entries()) {
        await page.getByRole('button', { name: `Preview at ${name} width` }).click();
        if (width === 1920)
          await previewElement.evaluate((frame) => {
            frame.style.width = '1920px';
          });
        await expect
          .poll(() => preview.locator('body').evaluate(() => [innerWidth, innerHeight]))
          .toEqual([width, height]);
        await publishedElement.evaluate(
          (frame, viewport) => {
            frame.style.width = `${viewport.width}px`;
            frame.style.height = `${viewport.height}px`;
          },
          { width, height },
        );
        const expected = authored.get(target.route)![index];
        for (const [surface, frame] of [
          ['Preview', preview],
          ['Published', published],
        ] as const) {
          const actual = await measure(frame);
          expect(actual.length, `${target.route}: ${surface} content`).toBe(expected.length);
          for (const [position, element] of actual.entries()) {
            const reference = expected[position];
            expect(
              { ...element, bounds: [] },
              `${target.route}: ${surface} styles ${position}`,
            ).toEqual({ ...reference, bounds: [] });
            element.bounds.forEach((value, axis) => {
              expect(
                value,
                `${target.route}: ${surface} ${width}px ${position} ${element.tag} ${element.kind} ${element.text?.slice(0, 60)} axis ${axis}`,
              ).toBeCloseTo(reference.bounds[axis], 1);
            });
          }
          if (fixture === 'every Block variant' && width === 1280 && surface === 'Preview') {
            await page.getByLabel('Preview zoom', { exact: true }).selectOption('125');
            expect(await measure(frame), 'Preview zoom preserves content geometry').toEqual(actual);
            await page.getByLabel('Preview zoom', { exact: true }).selectOption('auto');
          }
        }
      }
    }
  });

for (const surface of ['primary', 'image', 'canvas'] as const) {
  test(`preserves editor hero containment in Preview and publication: ${surface}`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const controls = await installApi(page, 'administrator', 'admin', (document) => {
      const hero = document.pages[1].blocks
        .flatMap((section) => section.items)
        .map((item) => item.element)
        .find((element) => element.type === 'hero');
      if (!hero || hero.type !== 'hero') throw new Error('Expected page Hero');
      hero.surface = surface;
      hero.align = 'center';
      hero.actions = [{ label: 'Our beliefs', href: '/what-we-believe', style: 'primary' }];
    });
    const measure = (frame: FrameLocator) =>
      frame.locator('.page-hero').evaluate(async (hero) => {
        await document.fonts.ready;
        const rect = (element: Element) => {
          const box = element.getBoundingClientRect();
          return { left: box.left, right: box.right, width: box.width, height: box.height };
        };
        const box = rect(hero);
        let left = box.left,
          right = box.right;
        for (let parent = hero.parentElement; parent; parent = parent.parentElement) {
          if (['hidden', 'clip', 'auto', 'scroll'].includes(getComputedStyle(parent).overflowX)) {
            const clip = rect(parent);
            left = Math.max(left, clip.left);
            right = Math.min(right, clip.right);
          }
        }
        return {
          viewport: innerWidth,
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          visible: { left, right, width: right - left },
          box,
          background: getComputedStyle(hero).backgroundImage,
          shell: (() => {
            const { left, right, width } = rect(document.querySelector('.page-body')!);
            return { left, right, width };
          })(),
          navigation: rect(document.querySelector('.point-navigation')!),
          text: Array.from(hero.querySelectorAll('.point-hero-text-box')).map(rect),
          image: hero.querySelector('img') ? rect(hero.querySelector('img')!) : null,
        };
      });
    await page.goto('/');
    await page.getByRole('button', { name: 'Open editor' }).click();
    await page.getByLabel('Choose page').selectOption({ label: 'Who We Are' });
    const canvasElement = page.locator('.visual-editor iframe');
    const canvas = canvasElement.contentFrame();
    await canvas.getByRole('heading', { name: 'Who We Are', exact: true }).click();
    await canvas
      .getByRole('button', { name: 'Resize Hero heading width', exact: true })
      .press('ArrowLeft');
    await expect(page.getByText('All changes saved')).toBeVisible();
    await expect.poll(() => controls.saveRequests.length).toBeGreaterThan(0);
    const saved = controls.saveRequests.at(-1)!.document;
    await page.reload();
    await page.getByLabel('Choose page').selectOption({ label: 'Who We Are' });
    await expect(canvas.getByRole('heading', { name: 'Who We Are', exact: true })).toBeVisible();
    const widths = [1280, 1440, 1920, 2560, 901, 900, 768, 761, 760, 521, 520, 360];
    const authored = [];
    for (const width of widths) {
      await canvasElement.evaluate((frame, width) => {
        frame.style.width = `${width}px`;
      }, width);
      authored.push(await measure(canvas));
    }
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await page.getByRole('button', { name: 'Preview at desktop width' }).click();
    await page
      .getByRole('combobox', { name: 'Page', exact: true })
      .selectOption({ label: 'Who We Are' });
    const previewElement = page.locator('iframe.preview-frame');
    const preview = previewElement.contentFrame();
    const html = await page.evaluate(
      async ({ document, route }) => {
        const modulePath = '/tests/fixtures/hero-publication.tsx';
        const { publishedHtml } = (await import(modulePath)) as typeof HeroPublication;
        return publishedHtml(document, route);
      },
      { document: saved, route: '/who-we-are' },
    );
    await page.evaluate((html) => {
      const frame = document.createElement('iframe');
      frame.id = 'published-hero';
      frame.style.border = '0';
      frame.style.height = '900px';
      frame.srcdoc = html;
      document.body.appendChild(frame);
    }, html);
    const publishedElement = page.locator('#published-hero');
    const published = publishedElement.contentFrame();
    for (const [index, width] of widths.entries()) {
      await previewElement.evaluate((frame, width) => {
        frame.style.width = `${width}px`;
      }, width);
      await publishedElement.evaluate((frame, width) => {
        frame.style.width = `${width}px`;
      }, width);
      const expected = authored[index];
      expect(expected.viewport).toBe(width);
      expect(expected.visible.left).toBeGreaterThanOrEqual(0);
      expect(expected.visible.right).toBeLessThanOrEqual(width);
      expect(expected.visible.left).toBeCloseTo(expected.shell.left, 1);
      expect(expected.visible.right).toBeCloseTo(expected.shell.right, 1);
      const previewBounds = await measure(preview);
      const publishedBounds = await measure(published);
      // Unrelated compatibility sections already overflow at some narrow widths.
      // Compare against the pre-fix direct-child Hero markup to reject new overflow.
      const previousOverflow = await published.locator('.page-hero').evaluate((hero) => {
        const wrapper = hero.parentElement!;
        wrapper.replaceWith(hero);
        const overflow =
          document.documentElement.scrollWidth - document.documentElement.clientWidth;
        hero.replaceWith(wrapper);
        wrapper.appendChild(hero);
        return overflow;
      });
      expect(previewBounds.overflow).toBeLessThanOrEqual(previousOverflow);
      expect(publishedBounds).toEqual(previewBounds);
      expect({ ...previewBounds, overflow: expected.overflow }, `Preview ${width}`).toEqual(
        expected,
      );
    }
    await page.getByRole('combobox', { name: 'Preview zoom', exact: true }).selectOption('125');
    const zoomed = await measure(preview);
    expect({ ...zoomed, overflow: authored.at(-1)!.overflow }).toEqual(authored.at(-1));
    await preview.locator('html').evaluate((element) => {
      element.style.fontSize = '200%';
    });
    const enlarged = await measure(preview);
    expect(enlarged.visible.left).toBeGreaterThanOrEqual(0);
    expect(enlarged.visible.right).toBeLessThanOrEqual(enlarged.viewport);
    await preview.getByRole('link', { name: 'Our beliefs', exact: true }).last().click();
    await expect(preview.getByRole('heading', { name: 'Our Beliefs', exact: true })).toBeVisible();
  });
}

test('keeps a non-auto desktop grid position identical in canvas and Preview', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();
  const canvas = page.locator('.visual-editor iframe').contentFrame();
  await canvas.getByRole('button', { name: 'Church navigation', exact: true }).click();

  const placement = page.locator('.grid-placement-inspector').filter({ visible: true });
  await placement.getByLabel('desktop width in columns').fill('4');
  await placement.getByLabel('desktop column').fill('9');
  await expect(page.getByText('All changes saved')).toBeVisible();

  const canvasGeometry = await canvas
    .locator('section[aria-label="Site header"] .point-layout-item--grid')
    .filter({ has: canvas.getByRole('navigation', { name: 'Church navigation' }) })
    .evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return { left: bounds.left, width: bounds.width, viewport: window.innerWidth };
    });

  await page.getByRole('button', { name: 'Preview' }).click();
  await page.getByRole('button', { name: 'Preview at desktop width' }).click();
  const preview = page.locator('iframe.preview-frame').contentFrame();
  const previewGeometry = await preview
    .locator('section[aria-label="Site header"] .point-layout-item--grid')
    .filter({ has: preview.getByRole('navigation', { name: 'Church navigation' }) })
    .evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return { left: bounds.left, width: bounds.width, viewport: window.innerWidth };
    });

  expect(canvasGeometry.viewport).toBe(1280);
  expect(previewGeometry.viewport).toBe(1280);
  expect(previewGeometry.left).toBeCloseTo(canvasGeometry.left, 0);
  expect(previewGeometry.width).toBeCloseTo(canvasGeometry.width, 0);
});

test('preserves the latest resize when Undo precedes the history timer', async ({ page }) => {
  await page.clock.install();
  const controls = await installApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();
  await page.getByLabel('Choose page').selectOption({ label: 'Our Beliefs' });
  const canvas = page.locator('.visual-editor iframe').contentFrame();
  await canvas.getByRole('heading', { level: 1, name: 'Our Beliefs' }).click();
  const handle = canvas.getByRole('button', { name: 'Resize Hero heading width', exact: true });
  await handle.press('ArrowLeft');
  await expect.poll(() => controls.saveRequests.length).toBe(1);
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  await handle.press('ArrowLeft');
  await expect.poll(() => controls.saveRequests.length).toBe(2);
  await page.getByRole('button', { name: 'Undo', exact: true }).dispatchEvent('click');
  await page.clock.runFor(500);
  await expect.poll(() => controls.saveRequests.length).toBe(3);
  const width = () =>
    controls.saveRequests
      .at(-1)
      ?.document.pages.find((candidate) => candidate.title === 'Our Beliefs')
      ?.blocks.flatMap((section) => section.items)
      .map((item) => item.element)
      .find((element) => element.type === 'hero')?.headingWidth.desktop;
  expect(width()).toBe(95);
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Redo', exact: true }).dispatchEvent('click');
  await page.clock.runFor(500);
  await expect.poll(() => controls.saveRequests.length).toBe(4);
  expect(width()).toBe(90);
  await handle.press('ArrowLeft');
  await expect.poll(() => controls.saveRequests.length).toBe(5);
  await handle.press('Control+z');
  await page.clock.runFor(500);
  await expect.poll(() => controls.saveRequests.length).toBe(6);
  expect(width()).toBe(90);
  expect(controls.saveRequests.at(-1)?.action.category).toBe('undo');
  await handle.press('Control+y');
  await page.clock.runFor(500);
  await expect.poll(() => controls.saveRequests.length).toBe(7);
  expect(width()).toBe(85);
  expect(controls.saveRequests.at(-1)?.action.category).toBe('redo');
});

test('keeps every page Hero inside the phone canvas and resizes Hero text by drag or keyboard', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.clock.install();
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
  const keyboardRequest = controls.saveRequests.at(-1);
  expect(keyboardRequest?.action).toEqual({
    category: 'resize',
    context: 'element-layout',
  });
  const requestedKeyboardWidth = keyboardRequest?.document.pages
    .find((candidate) => candidate.title === 'Our Beliefs')
    ?.blocks.flatMap((section) => section.items)
    .map((placement) => placement.element)
    .find((element) => element.type === 'hero')?.bodyWidth;
  expect(requestedKeyboardWidth).toEqual({ desktop: 100, tablet: 100, mobile: 95 });

  const beforeDrag = (await body.boundingBox())?.width ?? 0;
  const dragBaseline = controls.saveRequests.length;
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
  await expect.poll(() => controls.saveRequests.length).toBe(dragBaseline + 1);
  await expect.poll(async () => (await body.boundingBox())?.width ?? 0).toBeLessThan(beforeDrag);
  const requestedDragWidth = controls.saveRequests
    .at(-1)
    ?.document.pages.find((candidate) => candidate.title === 'Our Beliefs')
    ?.blocks.flatMap((section) => section.items)
    .map((placement) => placement.element)
    .find((element) => element.type === 'hero')?.bodyWidth.mobile;
  const renderedDragWidth = await body.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).getPropertyValue('--point-hero-text-width')),
  );
  expect(requestedDragWidth).toBe(renderedDragWidth);

  await page.getByRole('button', { name: 'Switch to Tablet viewport' }).click();
  await expect.poll(() => canvas.locator('body').evaluate(() => window.innerWidth)).toBe(768);
  await expect
    .poll(() =>
      body.evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).getPropertyValue('--point-hero-text-width')),
      ),
    )
    .toBe(100);
  await page.getByRole('button', { name: 'Switch to Desktop viewport' }).click();
  await expect.poll(() => canvas.locator('body').evaluate(() => window.innerWidth)).toBe(1280);
  await expect
    .poll(() =>
      body.evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).getPropertyValue('--point-hero-text-width')),
      ),
    )
    .toBe(100);
  await page.getByRole('button', { name: 'Switch to Phone viewport' }).click();
  await expect.poll(() => canvas.locator('body').evaluate(() => window.innerWidth)).toBe(360);
  await canvas.getByRole('heading', { level: 1, name: 'Our Beliefs' }).click();
  await expect(handle).toBeVisible();

  const beforeCancel = (await body.boundingBox())?.width ?? 0;
  const cancelBaseline = controls.saveRequests.length;
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
  await expect(page.getByText('All changes saved')).toBeVisible();
  expect(controls.saveRequests).toHaveLength(cancelBaseline);

  const panelSwitchBaseline = controls.saveRequests.length;
  const abandonedHandleBox = await handle.boundingBox();
  expect(abandonedHandleBox).not.toBeNull();
  await handle.dispatchEvent('pointerdown', {
    pointerId: 9,
    clientX: abandonedHandleBox!.x,
    clientY: abandonedHandleBox!.y,
  });
  await canvas.locator('body').dispatchEvent('pointermove', {
    pointerId: 9,
    clientX: abandonedHandleBox!.x + 60,
    clientY: abandonedHandleBox!.y,
  });
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByRole('heading', { name: 'Live preview' })).toBeVisible();
  expect(controls.saveRequests).toHaveLength(panelSwitchBaseline);
  await page.getByRole('button', { name: 'Layout' }).click();
  await page.getByLabel('Choose page').selectOption({ label: 'Our Beliefs' });
  await page.getByRole('button', { name: 'Switch to Phone viewport' }).click();
  await expect
    .poll(() =>
      page
        .locator('.visual-editor iframe')
        .contentFrame()
        .locator('.point-hero-text-box--body')
        .evaluate((element) =>
          Number.parseFloat(getComputedStyle(element).getPropertyValue('--point-hero-text-width')),
        ),
    )
    .toBe(requestedDragWidth);

  await page.reload();
  await page.getByLabel('Choose page').selectOption({ label: 'Our Beliefs' });
  await page.getByRole('button', { name: 'Switch to Phone viewport' }).click();
  const reloadedCanvas = page.locator('.visual-editor iframe').contentFrame();
  const reloadedBody = reloadedCanvas.locator('.point-hero-text-box--body');
  await expect(reloadedBody).toBeVisible();
  await expect
    .poll(() =>
      reloadedBody.evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).getPropertyValue('--point-hero-text-width')),
      ),
    )
    .toBe(requestedDragWidth);

  await reloadedCanvas.getByRole('heading', { level: 1, name: 'Our Beliefs' }).click();
  const reloadedHeadingHandle = reloadedCanvas.getByRole('button', {
    name: 'Resize Hero heading width',
    exact: true,
  });
  const orderedBaseline = controls.saveRequests.length;
  // These two keystrokes deliberately share Puck's 250 ms history entry.
  // Keep remote acknowledgement timing from changing that grouping across engines.
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  const releaseFirstResize = controls.holdNextSave();
  await reloadedHeadingHandle.press('ArrowLeft');
  await expect.poll(() => controls.saveRequests.length).toBe(orderedBaseline + 1);
  await reloadedHeadingHandle.press('ArrowLeft');
  expect(controls.saveRequests).toHaveLength(orderedBaseline + 1);
  releaseFirstResize();
  await expect.poll(() => controls.saveRequests.length).toBe(orderedBaseline + 2);
  const orderedWidths = controls.saveRequests.slice(orderedBaseline).map(
    (request) =>
      request.document.pages
        .find((candidate) => candidate.title === 'Our Beliefs')
        ?.blocks.flatMap((section) => section.items)
        .map((placement) => placement.element)
        .find((element) => element.type === 'hero')?.headingWidth.mobile,
  );
  expect(orderedWidths).toEqual([95, 90]);
  expect(
    controls.saveRequests
      .at(-1)
      ?.document.pages.find((candidate) => candidate.title === 'Our Beliefs')
      ?.blocks.flatMap((section) => section.items)
      .map((placement) => placement.element)
      .find((element) => element.type === 'hero'),
  ).toMatchObject({
    headingWidth: { desktop: 100, tablet: 100, mobile: 90 },
    bodyWidth: { desktop: 100, tablet: 100, mobile: requestedDragWidth },
  });

  await page.clock.runFor(300);
  await page.clock.resume();
  await expect(page.getByText('All changes saved')).toBeVisible();
  const undoBaseline = controls.saveRequests.length;
  await page.getByRole('button', { name: 'undo' }).click();
  await expect.poll(() => controls.saveRequests.length).toBe(undoBaseline + 1);
  expect(
    controls.saveRequests
      .at(-1)
      ?.document.pages.find((candidate) => candidate.title === 'Our Beliefs')
      ?.blocks.flatMap((section) => section.items)
      .map((placement) => placement.element)
      .find((element) => element.type === 'hero')?.headingWidth.mobile,
  ).toBe(100);
  await page.getByRole('button', { name: 'redo' }).click();
  await expect.poll(() => controls.saveRequests.length).toBe(undoBaseline + 2);
  expect(
    controls.saveRequests
      .at(-1)
      ?.document.pages.find((candidate) => candidate.title === 'Our Beliefs')
      ?.blocks.flatMap((section) => section.items)
      .map((placement) => placement.element)
      .find((element) => element.type === 'hero')?.headingWidth.mobile,
  ).toBe(90);

  await page.getByRole('button', { name: 'Preview' }).click();
  await page.getByRole('button', { name: 'Preview at phone width' }).click();
  const preview = page.locator('iframe.preview-frame').contentFrame();
  const previewPageSelector = page.getByLabel('Page').first();
  await previewPageSelector.selectOption({ label: 'Our Beliefs' });
  await expect(preview.locator('.point-hero-text-box--heading')).toHaveCSS(
    '--point-hero-text-width',
    '90%',
  );
  await expect(preview.locator('.point-hero-text-box--body')).toHaveCSS(
    '--point-hero-text-width',
    `${requestedDragWidth}%`,
  );
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

  const pageMetrics = await scrollContainer(page.locator('.page-workspace'));
  await page.getByRole('button', { name: 'Blocks', exact: true }).click();
  const catalogMetrics = await scrollContainer(
    page.getByRole('button', { name: 'Spacer', exact: true }),
  );
  for (const [name, metrics] of [
    ['page manager', pageMetrics],
    ['module catalog', catalogMetrics],
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
  await expect(canvas.locator('.point-composed-footer')).toBeVisible();

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
    await expect(canvas.locator('.point-composed-footer')).toBeVisible();
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
  await page.getByRole('button', { name: 'Blocks', exact: true }).click();
  const canvas = page.locator('.visual-editor iframe').contentFrame();

  const drag = async (
    source: ReturnType<typeof page.locator>,
    target: ReturnType<typeof page.locator>,
    targetEdge = false,
    targetXRatio = 0.5,
  ) => {
    await source.scrollIntoViewIfNeeded();
    await target.scrollIntoViewIfNeeded();
    const visibleTarget = async () => {
      const targetBox = await target.boundingBox();
      const frameBox = await page.locator('.visual-editor iframe').boundingBox();
      if (!targetBox || !frameBox) return null;
      const y = Math.max(targetBox.y, frameBox.y);
      return {
        ...targetBox,
        y,
        height: Math.min(targetBox.y + targetBox.height, frameBox.y + frameBox.height) - y,
      };
    };
    const from = await source.boundingBox();
    const to = await visibleTarget();
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
    const settledTarget = await visibleTarget();
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
    if (await phantom.count()) {
      const finalTarget = await visibleTarget();
      expect(finalTarget).not.toBeNull();
      await page.mouse.move(
        finalTarget!.x + finalTarget!.width * targetXRatio,
        finalTarget!.y + finalTarget!.height / 2,
      );
    }
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
  await page.getByLabel('desktop vertical alignment').last().selectOption({ label: 'End' });
  const placement = canvas.locator('.point-layout-item').filter({ hasText: 'Section heading' });
  await expect(placement).toHaveCSS('grid-column-start', '4');
  await expect(placement).toHaveCSS('grid-column-end', 'span 6');
  await expect(placement).toHaveCSS('align-self', 'end');

  const moveHandle = canvas.getByRole('button', { name: 'Move heading on desktop grid' });
  await expect(moveHandle).toHaveText('');
  await expect(moveHandle).toHaveAccessibleName('Move heading on desktop grid');
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
  await expect(page.getByText(/belongs only to the selected responsive view/).last()).toBeVisible();
  await page.getByLabel('tablet vertical alignment').last().selectOption({ label: 'Start' });
  await page.getByLabel('tablet width in columns').last().fill('8');
  await page.getByLabel('tablet column').last().fill('3');
  await expect(placement).toHaveCSS('grid-column-start', '3');
  await expect(placement).toHaveCSS('grid-column-end', 'span 8');
  await page.getByRole('button', { name: 'Switch to Desktop viewport' }).click();
  await canvas.getByRole('heading', { name: 'Section heading' }).click();
  await expect(page.getByLabel('desktop vertical alignment').last()).toHaveValue('end');
  await expect(placement).toHaveCSS('align-self', 'end');
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

  const blocksToggle = page.getByRole('button', { name: 'Blocks', exact: true });
  if ((await blocksToggle.getAttribute('aria-pressed')) !== 'true') await blocksToggle.click();
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
  const imageRowSpan = Number(await page.getByLabel('desktop height in rows').last().inputValue());
  const inspector = page.locator('.block-inspector').last();
  await expect(page.getByLabel('desktop width in columns').last()).toHaveValue('6');
  const inspectorOverflow = await inspector.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(inspectorOverflow.scrollWidth).toBeLessThanOrEqual(inspectorOverflow.clientWidth);

  await drag(page.getByRole('button', { name: 'Button', exact: true }), twoColumnSlot, false, 0.05);
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
  await buttonRow.fill(String(imageRow + imageRowSpan + 1));
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
  const reloadedCanvas = page.locator('.visual-editor iframe').contentFrame();
  await expect(reloadedCanvas.getByRole('heading', { name: 'Section heading' })).toBeVisible();
  await expect(reloadedCanvas.locator('section[aria-label="Two column section"]')).toBeVisible();

  await reloadedCanvas.getByRole('button', { name: 'Edit global footer' }).scrollIntoViewIfNeeded();
  await reloadedCanvas.getByRole('button', { name: 'Edit global footer' }).click();
  await expect(page.getByRole('button', { name: 'Layout', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByLabel('Choose page')).toHaveValue('footer');
});

test('keeps the Sections toolbox structural and exposes recipe parts as atomic items', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();
  await page.getByRole('button', { name: 'Blocks', exact: true }).click();
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
  await expect(page.getByRole('button', { name: 'Navigation', exact: true }).last()).toBeVisible();
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
  await page.getByRole('button', { name: 'Blocks', exact: true }).click();
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
  for (const [name, rendered] of [
    ['Image', '.point-image img'],
    ['Form', '.point-form-wrapper form'],
    ['Map', '.point-map iframe'],
  ] as const) {
    const item = page.getByRole('button', { name, exact: true });
    let start: Awaited<ReturnType<typeof item.boundingBox>> = null;
    let destination: Awaited<ReturnType<typeof grid.boundingBox>> = null;
    await expect(async () => {
      await item.scrollIntoViewIfNeeded();
      await grid.scrollIntoViewIfNeeded();
      [start, destination] = await Promise.all([item.boundingBox(), grid.boundingBox()]);
      expect(start).not.toBeNull();
      expect(destination).not.toBeNull();
    }).toPass({ timeout: 5000 });
    await page.mouse.move(start!.x + start!.width / 2, start!.y + start!.height / 2);
    await page.mouse.down();
    await page.mouse.move(start!.x + start!.width / 2 + 8, start!.y + start!.height / 2 + 8, {
      steps: 4,
    });
    await page.mouse.move(destination!.x + 24, destination!.y + 24, { steps: 16 });
    await expect(canvas.locator('.point-grid-drop-preview').locator(rendered)).toHaveCount(1);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect(canvas.locator('.point-grid-drop-preview')).toHaveCount(0);
  }
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
  await expect(phantom.locator('.point-heading h2')).toHaveText('Section heading');
  await expect(phantom.locator('.point-grid-drop-preview__content')).toHaveCSS('opacity', '0.65');
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
  expect(occupiedBox!.x).toBeCloseTo(second!.x, 0);
  expect(occupiedBox!.y).toBeCloseTo(second!.y, 0);
  expect(occupiedBox!.width).toBeCloseTo(second!.width, 0);
  expect(occupiedBox!.height).toBeCloseTo(second!.height, 0);
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

test('wraps an image dropped directly on an empty page in a resizable grid container', async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName === 'webkit',
    'Puck cross-frame drags are unreliable in Playwright WebKit.',
  );
  const controls = await installApi(page, 'administrator', 'admin', (document) => {
    document.pages[0].blocks = [];
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();
  await page.getByRole('button', { name: 'Blocks', exact: true }).click();
  const canvas = page.locator('.visual-editor iframe').contentFrame();
  const source = page.getByRole('button', { name: 'Image', exact: true });
  const target = canvas.locator('[data-puck-dropzone]').first();
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
  await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height - 6, { steps: 16 });
  await page.mouse.up();
  const section = canvas.locator('section[aria-label="Blank section"]');
  await expect(section.locator('.point-image')).toBeVisible();
  const resize = canvas.getByRole('button', { name: 'Resize image from south east' });
  await expect(resize).toBeVisible();
  const original = Number(await page.getByLabel('desktop width in columns').last().inputValue());
  await resize.press('ArrowLeft');
  await expect(page.getByLabel('desktop width in columns').last()).toHaveValue(
    String(original - 1),
  );
  await expect(page.getByText('All changes saved')).toBeVisible();
  const saved = controls.saveRequests.at(-1)!.document.pages[0].blocks;
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ layout: 'grid', items: [{ element: { type: 'image' } }] });
  expect(saved[0].items[0].grid.desktop.columnSpan).toBe(original - 1);
  await page.reload();
  const reopened = page.locator('.visual-editor iframe').contentFrame();
  await expect(reopened.locator('section[aria-label="Blank section"] .point-image')).toBeVisible();
});

test('drops the rendered Map phantom into an empty grid', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Puck cross-frame drags require Chromium for this flow.');
  const controls = await installApi(page, 'administrator', 'admin', (document) => {
    document.pages[0].blocks = [];
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();
  await page.getByRole('button', { name: 'Blocks', exact: true }).click();
  const canvas = page.locator('.visual-editor iframe').contentFrame();
  const drag = async (name: string, target: ReturnType<typeof page.locator>) => {
    const source = page.getByRole('button', { name, exact: true });
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
    await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 16 });
    const settled = await target.boundingBox();
    expect(settled).not.toBeNull();
    await page.mouse.move(settled!.x + settled!.width / 2, settled!.y + settled!.height / 2, {
      steps: 4,
    });
  };
  await drag('Blank', canvas.locator('[data-puck-dropzone]').first());
  await page.mouse.up();
  const grid = canvas.locator('section[aria-label="Blank section"] [data-puck-dropzone]');
  await expect(grid).toBeVisible();
  await drag('Map', grid);
  const phantom = canvas.locator('.point-grid-drop-preview');
  await expect(phantom).toHaveAttribute('data-drop-valid', 'true');
  await expect(phantom.locator('.point-map iframe')).toHaveCount(1);
  await page.mouse.up();
  await expect(grid.locator('.point-map iframe')).toHaveCount(1);
  await expect(page.getByText('All changes saved')).toBeVisible();
  expect(controls.saveRequests.at(-1)!.document.pages[0].blocks[0]).toMatchObject({
    items: [{ element: { type: 'map' } }],
  });
});

test('composes text inside a nested grid and persists its placement', async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName === 'webkit',
    'Puck cross-frame drags are unreliable in Playwright WebKit.',
  );
  const controls = await installApi(page, 'administrator', 'admin', (document) => {
    document.pages[0].blocks = [];
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();
  await page.getByRole('button', { name: 'Blocks', exact: true }).click();
  const canvas = page.locator('.visual-editor iframe').contentFrame();
  const drag = async (name: string, target: ReturnType<typeof page.locator>, center = false) => {
    const source = page.getByRole('button', { name, exact: true });
    let from = await source.boundingBox();
    let to = await target.boundingBox();
    await expect(async () => {
      await source.scrollIntoViewIfNeeded();
      await target.scrollIntoViewIfNeeded();
      [from, to] = await Promise.all([source.boundingBox(), target.boundingBox()]);
      expect(from).not.toBeNull();
      expect(to).not.toBeNull();
    }).toPass({ timeout: 5000 });
    await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
    await page.mouse.down();
    await page.mouse.move(from!.x + from!.width / 2 + 8, from!.y + from!.height / 2 + 8, {
      steps: 4,
    });
    await page.mouse.move(
      to!.x + to!.width / 2,
      center ? to!.y + to!.height / 2 : to!.y + to!.height - 6,
      { steps: 16 },
    );
    const settled = await target.boundingBox();
    expect(settled).not.toBeNull();
    await page.mouse.move(settled!.x + settled!.width / 2, settled!.y + settled!.height / 2, {
      steps: 4,
    });
    if (center) {
      await expect(target.locator('xpath=..').locator('.point-grid-drop-preview')).toHaveAttribute(
        'data-drop-valid',
        'true',
      );
    }
    await page.waitForTimeout(200);
    await page.mouse.up();
  };
  await drag('Blank', canvas.locator('[data-puck-dropzone]').first());
  const section = canvas.locator('section[aria-label="Blank section"]');
  await expect(section.locator('[data-puck-dropzone]')).toBeVisible();
  await expect(page.getByText('All changes saved')).toBeVisible();
  await drag('Group', section.locator('[data-puck-dropzone]'));
  const group = section.locator('section[aria-label="Group"]');
  await expect(group).toBeVisible();
  await expect(page.getByText('All changes saved')).toBeVisible();
  expect(controls.saveRequests.at(-1)?.document).toMatchObject({
    schemaVersion: 12,
    rendererVersion: '12.0.0',
  });
  await drag('Text', group.locator('[data-puck-dropzone]'), true);
  await expect(group.locator('.point-text')).toHaveText('Add your text here.');
  await page.getByLabel('Text type').filter({ visible: true }).last().selectOption('h2');
  await page
    .getByRole('textbox', { name: 'Text', exact: true })
    .filter({ visible: true })
    .last()
    .fill('Independent heading');
  await expect(group.getByRole('heading', { name: 'Independent heading', level: 2 })).toBeVisible();
  await page.getByLabel('Layer').filter({ visible: true }).last().selectOption('2');
  await canvas.getByRole('button', { name: 'Resize text from south east' }).press('ArrowLeft');
  await expect(page.getByText('All changes saved')).toBeVisible();
  const composed = controls.saveRequests.at(-1)!.document.pages[0].blocks[0].items[0].element;
  expect(composed).toMatchObject({
    type: 'composition',
    items: [{ element: { type: 'text', semantic: 'h2', text: 'Independent heading' } }],
  });
  if (composed.type !== 'composition') throw new Error('Expected a group');
  expect(composed.items[0].grid.desktop).toMatchObject({ column: 7, columnSpan: 5 });
  expect(composed.items[0].layer).toBe(2);
  await page.reload();
  await expect(
    page
      .locator('.visual-editor iframe')
      .contentFrame()
      .getByRole('heading', { name: 'Independent heading', level: 2 }),
  ).toBeVisible();
});

test('ships the logo and menu as independently editable grid elements', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();
  const canvas = page.locator('.visual-editor iframe').contentFrame();
  await expect(canvas.locator('.site-header')).toHaveCount(0);
  await expect(canvas.locator('section[aria-label="Site header"]')).toBeVisible();
  await expect(canvas.getByRole('img', { name: 'Point Community Church' })).toBeVisible();
  await expect(canvas.getByRole('navigation', { name: 'Church navigation' })).toBeVisible();
  await page.getByRole('button', { name: 'Blocks', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Navigation', exact: true }).last()).toBeVisible();

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

  await page.getByRole('button', { name: 'Edit in Navigation Designer' }).click();
  const aboutLabel = page.getByLabel('Link label', { exact: true });
  await aboutLabel.fill('Our church');
  await expect(page.getByLabel('Link label', { exact: true })).toHaveValue('Our church');
  const menuPreview = page.locator('iframe.preview-frame').contentFrame();
  await expect(menuPreview.getByRole('link', { name: 'Our church', exact: true })).toBeVisible();
  const aboutLink = page.getByRole('group', { name: 'Destination', exact: true });
  await aboutLink.getByLabel('Internal page').selectOption('/contact');
  await expect(menuPreview.getByRole('link', { name: 'Our church', exact: true })).toHaveAttribute(
    'href',
    '/contact',
  );
  await menuPreview.getByRole('link', { name: 'Our church', exact: true }).click();
  await expect(menuPreview.getByRole('link', { name: 'Our church', exact: true })).toBeVisible();
  await aboutLink.getByLabel('Type').selectOption('external');
  await aboutLink.getByLabel('External URL').fill('pointatx.org');
  await expect(aboutLink.getByLabel('External URL')).toHaveAttribute('aria-invalid', 'true');
  await aboutLink.getByLabel('External URL').fill('http://legacy.example.com');
  await expect(menuPreview.getByRole('link', { name: 'Our church', exact: true })).toHaveAttribute(
    'href',
    'http://legacy.example.com',
  );
  await menuPreview.getByRole('link', { name: 'Our church', exact: true }).click();
  await expect(menuPreview.getByRole('link', { name: 'Our church', exact: true })).toBeVisible();
  expect(page.context().pages()).toHaveLength(1);

  await page.getByRole('button', { name: 'Layout', exact: true }).click();
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
  await expect(page.getByText('19 of 19 items')).toBeVisible();
  await expect(page.locator('.library-inventory img')).toHaveCount(19);
  await page
    .locator('.library-item')
    .filter({ hasText: 'Austin skyline over the Colorado River' })
    .getByText('Edit details')
    .click();
  await expect(page.getByRole('button', { name: 'Save details' })).toBeVisible();
  await replaceSequentially(
    page.getByRole('dialog').getByLabel('Display name', { exact: true }),
    'Austin skyline hero',
  );
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Add linked media' }).click();
  await replaceSequentially(
    page.getByRole('dialog').getByLabel('Display name', { exact: true }),
    'Welcome media',
  );
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();

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
  await page.getByRole('button', { name: 'Add linked media' }).click();
  await page.getByLabel('Media type').selectOption('youtube');
  await page.getByLabel('Display name', { exact: true }).fill('Attribution video');
  await page.getByLabel('HTTPS URL').fill('https://www.youtube.com/watch?v=M7lc1UVf-VE');
  await page
    .getByLabel('Alternative text or accessible description')
    .fill('Attribution video description');
  await page.getByRole('dialog').getByRole('button', { name: 'Add linked media' }).click();
  await expect.poll(() => controls.libraryRequests.length).toBe(1);
  expect(controls.libraryRequests[0]?.action).toBe('link');
  await expect(page.getByText('All changes saved')).toBeVisible();

  await page.getByRole('button', { name: 'Settings' }).click();
  await expectAction(
    async () => {
      await page.getByLabel('Church name').fill('Point Community Church Austin');
      await page.getByLabel('Church name').press('Tab');
    },
    { category: 'text-edit', context: 'site-settings' },
  );

  await page.getByRole('button', { name: 'Navigation', exact: true }).click();
  const navigationLabel = page.getByLabel('Link label', { exact: true });
  await expectAction(
    async () => {
      await navigationLabel.fill('About Point');
      await navigationLabel.press('Tab');
    },
    { category: 'text-edit', context: 'navigation' },
  );

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Collections', exact: true }).click();
  await expectAction(() => page.getByRole('button', { name: 'Add person' }).click(), {
    category: 'add',
    context: 'collections',
  });

  await page.getByRole('button', { name: 'Design', exact: true }).click();
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

test('uploads one independent image immediately into the unified Library', async ({ page }) => {
  await page.unroute('**/api/**');
  const controls = await installApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();
  await page.getByRole('button', { name: 'Library' }).click();
  await page.getByRole('button', { name: 'Upload image' }).click();
  await page.getByLabel('Image file').setInputFiles({
    name: 'gathering.unusual',
    mimeType: 'application/octet-stream',
    buffer: previewPng,
  });
  await page.getByLabel('Alternative text').fill('People gathering');
  await page.getByRole('dialog').getByRole('button', { name: 'Upload image' }).click();
  await expect(page.getByText('20 of 20 items · Image uploaded.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'gathering.webp', exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Use in Layout' })).toHaveCount(0);
  expect(controls.libraryRequests).toHaveLength(1);
  expect(controls.libraryRequests[0]?.action).toBe('upload');
  expect(controls.libraryRequests[0]?.headers['x-draft-checkout']).toBe(
    '30000000-0000-4000-8000-000000000001',
  );
  expect(controls.saveRequests).toHaveLength(0);
});

test('reviews image replacement and navigates archived Library items by keyboard', async ({
  page,
}) => {
  await page.unroute('**/api/**');
  const controls = await installApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();
  await page.getByRole('button', { name: 'Library' }).click();
  const item = page.locator('.library-item').filter({
    has: page.getByRole('heading', {
      name: 'Austin skyline over the Colorado River',
      exact: true,
    }),
  });
  await item.getByRole('button', { name: 'Replace image' }).click();
  let dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Alternative text or accessible description')).toHaveValue('');
  await dialog.getByLabel('Image file').setInputFiles({
    name: 'wrong.png',
    mimeType: 'image/png',
    buffer: Buffer.from('invalid bytes'),
  });
  await expect(dialog.getByRole('alert')).toHaveText(
    'Image format is unsupported or invalid. Choose JPEG, PNG, WebP or AVIF.',
  );
  await expect(dialog.getByRole('button', { name: 'Review replacement' })).toBeDisabled();
  await dialog
    .getByLabel('Image file')
    .setInputFiles({ name: 'sunset.png', mimeType: 'image/png', buffer: previewPng });
  await dialog
    .getByLabel('Alternative text or accessible description')
    .fill('Austin skyline at sunset');
  await dialog.getByRole('button', { name: 'Review replacement' }).click();
  await expect(dialog.getByText(/cannot be undone/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Yes, replace image' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(item.getByRole('button', { name: 'Replace image' })).toBeFocused();
  expect(controls.libraryRequests).toHaveLength(0);
  await item.getByRole('button', { name: 'Replace image' }).click();
  dialog = page.getByRole('dialog');
  await dialog
    .getByLabel('Image file')
    .setInputFiles({ name: 'sunset.png', mimeType: 'image/png', buffer: previewPng });
  await dialog
    .getByLabel('Alternative text or accessible description')
    .fill('Austin skyline at sunset');
  await dialog.getByRole('button', { name: 'Review replacement' }).click();
  await dialog.getByRole('button', { name: 'Yes, replace image' }).click();
  await expect(item.getByText('Austin skyline at sunset', { exact: true })).toBeVisible();
  expect(controls.libraryRequests.map((request) => request.action)).toEqual(['replace']);
  await item.getByRole('button', { name: 'Archive', exact: true }).click();
  await page.getByRole('button', { name: 'Archived items (1)' }).click();
  await expect(page.getByRole('searchbox', { name: 'Search Library' })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Delete permanently' })).toBeDisabled();
  await expect(
    page.getByText('Retained draft revisions contain this item. Unarchive to use it again.'),
  ).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search Library' }).fill('missing');
  await expect(page.getByText('No matching items')).toBeVisible();
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await page.getByRole('button', { name: 'Unarchive', exact: true }).click();
  await expect(page.getByText('No archived items', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to Library' }).click();
  await expect(item).toBeVisible();
  expect(controls.libraryRequests.map((request) => request.action)).toEqual([
    'replace',
    'archive',
    'unarchive',
  ]);
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
  await page.getByRole('button', { name: 'Form details', exact: true }).click();
  await page.getByLabel('Heading').fill('Plan a visit');
  await page.getByRole('button', { name: 'Questions', exact: true }).click();
  await page.getByRole('button', { name: 'Add field' }).click();
  await expect(page.locator('.question-summary').filter({ hasText: '2. New field' })).toBeVisible();

  await page.getByRole('button', { name: 'Library' }).click();
  await page.getByRole('button', { name: 'Add linked media' }).click();
  await page.getByLabel('Media type').selectOption('youtube');
  await page.getByLabel('Display name', { exact: true }).fill('Point welcome video');
  await page.getByLabel('HTTPS URL').fill('https://www.youtube.com/watch?v=M7lc1UVf-VE');
  await page
    .getByLabel('Alternative text or accessible description')
    .fill('Welcome to Point Community Church');
  await page.getByRole('dialog').getByRole('button', { name: 'Add linked media' }).click();
  await expect(page.getByText(/Linked media added\./)).toBeVisible();
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
  await page.getByRole('button', { name: 'Blocks', exact: true }).click();
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

test('manages roles and distinguishes measured storage from unknown provider usage', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open editor' }).click();
  await page.getByRole('button', { name: 'Admin' }).click();
  await expect(
    page.getByText('Provider usage: unknown. Provider counters unavailable.'),
  ).toBeVisible();
  await expect(page.getByText('8.0 MiB')).toBeVisible();
  await expect(page.getByRole('progressbar')).toHaveCount(0);
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
