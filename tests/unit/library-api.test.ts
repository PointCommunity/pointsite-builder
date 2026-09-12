import { api } from '../../src/client/api';

const context = {
  draftId: 'draft-one',
  expectedChecksum: 'revision-checksum',
  expectedRevisionId: 'current-revision',
  checkoutToken: 'owned-checkout',
  idempotencyKey: 'retry-key',
};
afterEach(() => vi.unstubAllGlobals());

it('sends ownership and revision guards on every JSON Library mutation', async () => {
  const fetcher = vi
    .fn()
    .mockImplementation(() => Promise.resolve(new Response('{}', { status: 200 })));
  vi.stubGlobal('fetch', fetcher);
  const metadata = { displayName: 'Sunday', altText: 'Sunday gathering', tags: ['Sunday'] };
  await api.addLibraryLink(context, {
    ...metadata,
    mediaType: 'image',
    url: 'https://example.com/image.png',
  });
  await api.updateLibraryItem(context, 'item-one', 'archive');
  await api.updateLibraryItem(context, 'item-one', 'unarchive');
  await api.updateLibraryItem(context, 'item-one', 'update', metadata);
  await api.deleteLibraryItem(context, 'item-one');
  for (const call of fetcher.mock.calls) {
    const [path, init] = call as [string, RequestInit];
    expect(path).toMatch(/^\/api\/drafts\/draft-one\/library\//);
    expect(init.headers).toMatchObject({
      'x-draft-checkout': 'owned-checkout',
      'if-match': '"revision-checksum"',
      'x-draft-revision': 'current-revision',
      'idempotency-key': 'retry-key',
      'content-type': 'application/json',
    });
  }
  const deletion = fetcher.mock.calls.at(-1)?.[1] as RequestInit;
  expect(deletion.method).toBe('DELETE');
  expect(deletion.body).toBe(JSON.stringify({ confirmation: true }));
});

it('retains checkout guards and explicit replacement confirmation without forcing a multipart boundary', async () => {
  const fetcher = vi
    .fn()
    .mockImplementation(() => Promise.resolve(new Response('{}', { status: 200 })));
  vi.stubGlobal('fetch', fetcher);
  const file = new File(['test-image'], 'image.png', { type: 'image/png' });
  const metadata = { displayName: 'New image', altText: 'Fresh description', tags: ['New'] };
  await api.uploadLibraryImage(context, file, metadata.altText);
  await api.replaceLibraryImage(context, 'item-one', file, metadata);
  const [path, init] = fetcher.mock.calls[1] as [string, RequestInit];
  expect(path).toBe('/api/drafts/draft-one/library/items/item-one/replacement');
  expect(init.headers).toMatchObject({
    'x-draft-checkout': 'owned-checkout',
    'if-match': '"revision-checksum"',
    'x-draft-revision': 'current-revision',
    'idempotency-key': 'retry-key',
  });
  expect(new Headers(init.headers).has('content-type')).toBe(false);
  const form = init.body as FormData;
  expect(form.get('file')).toBe(file);
  expect(form.get('confirmed')).toBe('true');
  expect(form.get('altText')).toBe('Fresh description');
  expect(form.get('displayName')).toBe('New image');
  expect(form.get('tags')).toBe('["New"]');
});
