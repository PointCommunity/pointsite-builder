// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import { SiteRenderer } from '../../src/site-kit/SiteRenderer';
import { buildCandidate } from '../../src/server/publish/candidate';
import type { DraftRecord } from '../../src/server/repositories/contracts';

function draft(): DraftRecord {
  const document = structuredClone(defaultSiteDocument);
  document.media.push({
    id: '99999999-9999-4999-8999-999999999999',
    sourcePath: '/assets/builder/99999999-9999-4999-8999-999999999999.png',
    alt: 'Uploaded',
  });
  return {
    id: '10000000-0000-4000-8000-000000000001',
    siteId: 'pointsite',
    name: 'Candidate',
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
      schemaVersion: 1,
      rendererVersion: document.rendererVersion,
      createdBy: 'editor',
      createdAt: '2026-09-05T00:00:00Z',
      actionCategory: null,
      actionContext: null,
    },
    createdBy: 'editor',
    createdAt: '2026-09-05T00:00:00Z',
    updatedAt: '2026-09-05T00:00:00Z',
    deletedAt: null,
  };
}

it('packages every local image through its owner, independently of source storage', async () => {
  const source = draft();
  const stored = new Map(
    source.document.media.map((item) => [item.sourcePath, Uint8Array.from([1, 2, 3])]),
  );
  const otherDraft = structuredClone(source);
  otherDraft.id = crypto.randomUUID();
  const otherStorage = new Map(stored);
  const media = {
    readManyForDraft: vi.fn((draftId: string, paths: string[]) =>
      Promise.resolve(
        new Map(
          paths.map((path) => [
            path,
            {
              bytes: (draftId === source.id ? stored : otherStorage).get(path)!,
              contentType: 'image/png',
              filename: 'upload.png',
            },
          ]),
        ),
      ),
    ),
  };
  const candidate = await buildCandidate(source, media as never);
  const otherBefore = await buildCandidate(otherDraft, media as never);
  expect(candidate.files).toContainEqual({
    path: 'public/assets/builder/99999999-9999-4999-8999-999999999999.png',
    content: 'AQID',
    encoding: 'base64',
  });
  for (const item of source.document.media) {
    expect(media.readManyForDraft).toHaveBeenCalledWith(
      source.id,
      expect.arrayContaining([item.sourcePath]),
      20 * 1024 * 1024,
    );
    expect(candidate.files).toContainEqual({
      path: `public${item.sourcePath}`,
      content: 'AQID',
      encoding: 'base64',
    });
  }
  stored.clear();
  expect(await buildCandidate(otherDraft, media as never)).toEqual(otherBefore);
  const published = structuredClone(candidate);
  const publishedDocument = JSON.parse(published.files[0].content) as typeof source.document;
  for (const item of publishedDocument.media) {
    expect(published.files.find((file) => file.path === `public${item.sourcePath}`)?.content).toBe(
      'AQID',
    );
  }
  const html = renderToStaticMarkup(
    createElement(SiteRenderer, { document: publishedDocument, route: '/' }),
  );
  expect(html).toContain('Point');
  expect(html).not.toContain('/api/');
  for (const match of html.matchAll(/(?:src="|url\(&quot;)(\/assets\/[^"&]+)/g)) {
    expect(published.files.some((file) => file.path === `public${match[1]}`)).toBe(true);
  }
  expect(source.document).toEqual(publishedDocument);
});

it('binds every image byte into the candidate checksum and reads duplicate paths once', async () => {
  const source = draft();
  source.document.media.push({ ...source.document.media[0], id: crypto.randomUUID() });
  const media = {
    readManyForDraft: vi.fn().mockResolvedValue(
      new Map(
        source.document.media.map((item) => [
          item.sourcePath,
          {
            bytes: Uint8Array.of(1),
            contentType: 'image/png',
            filename: 'image.png',
          },
        ]),
      ),
    ),
  };
  const first = await buildCandidate(source, media as never);
  expect(media.readManyForDraft).toHaveBeenCalledOnce();
  expect(media.readManyForDraft.mock.calls[0][1]).toHaveLength(source.document.media.length - 1);
  media.readManyForDraft.mockResolvedValue(
    new Map(
      source.document.media.map((item) => [
        item.sourcePath,
        {
          bytes: Uint8Array.of(2),
          contentType: 'image/png',
          filename: 'image.png',
        },
      ]),
    ),
  );
  expect((await buildCandidate(source, media as never)).candidateChecksum).not.toBe(
    first.candidateChecksum,
  );
});

it.each([
  '/assets/../secret.png',
  '/assets//secret.png',
  '/api/media/private',
  '/assets/file.html',
])('rejects unsafe local source %s before reading bytes', async (sourcePath) => {
  const source = draft();
  source.document.media = [{ ...source.document.media[0], sourcePath }];
  const media = { readManyForDraft: vi.fn() };
  await expect(buildCandidate(source, media as never)).rejects.toThrow(
    'CANDIDATE_MEDIA_PATH_INVALID',
  );
  expect(media.readManyForDraft).not.toHaveBeenCalled();
});

it('supports owned immutable paths and fails closed when their bytes are missing', async () => {
  const source = draft();
  source.document.media[0].sourcePath = `/assets/builder/${source.id}/${crypto.randomUUID()}/photo.png`;
  const media = {
    readManyForDraft: vi.fn().mockRejectedValue(new Error('MEDIA_NOT_FOUND')),
    read: vi.fn(),
  };
  await expect(buildCandidate(source, media as never)).rejects.toThrow('MEDIA_NOT_FOUND');
  expect(media.read).not.toHaveBeenCalled();
});

it.each([
  'https://builder.pointatx.org/api/drafts/owner/assets?path=x',
  'https://builder.pointatx.org/assets/builder/owner/version/photo.png',
  'https://builder.pointatx.org/%61pi/media/private',
])('rejects draft-dependent Builder link %s before reading bytes', async (url) => {
  const source = draft();
  source.document.linkedMedia = [
    {
      id: crypto.randomUUID(),
      type: 'image',
      url: 'https://pointatx.org/assets/builder/owner/image.png',
      displayName: 'Production snapshot',
      alternativeText: 'Published image',
      tags: [],
    },
    {
      id: crypto.randomUUID(),
      type: 'image',
      url,
      displayName: 'Private',
      alternativeText: 'Private image',
      tags: [],
    },
  ];
  const media = { readManyForDraft: vi.fn() };
  await expect(buildCandidate(source, media as never)).rejects.toThrow('PRIVATE_MEDIA_LINK');
  expect(media.readManyForDraft).not.toHaveBeenCalled();
});

it('preserves external published snapshot and YouTube links', async () => {
  const source = draft();
  source.document.media = [];
  source.document.linkedMedia = [
    {
      id: crypto.randomUUID(),
      type: 'image',
      url: 'https://staging.pointatx.org/assets/builder/owner/image.png',
      displayName: 'Published',
      alternativeText: 'Published image',
      tags: [],
    },
    {
      id: crypto.randomUUID(),
      type: 'youtube',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      displayName: 'Video',
      tags: [],
    },
  ];
  const candidate = await buildCandidate(source);
  expect((JSON.parse(candidate.files[0].content) as typeof source.document).linkedMedia).toEqual(
    source.document.linkedMedia,
  );
});
