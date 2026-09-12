import { render } from '@testing-library/react';
import { checksumDocument } from '../../src/site-kit/canonicalize';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import { SiteRenderer } from '../../src/site-kit/SiteRenderer';
import { draftDisplayDocument } from '../../src/client/media/draft-display-document';

it('renders local images through their draft owner without changing persisted paths or checksum', async () => {
  const draftId = '10000000-0000-4000-8000-000000000001';
  const source = structuredClone(defaultSiteDocument);
  const checksum = await checksumDocument(source);
  const display = draftDisplayDocument(source, draftId);
  const { container } = render(<SiteRenderer document={display} route="/" />);
  const images = [...container.querySelectorAll('img')];
  expect(images.length).toBeGreaterThan(0);
  for (const image of images) {
    const url = new URL(image.getAttribute('src')!, 'https://builder.pointatx.org');
    expect(url.pathname).toBe(`/api/drafts/${draftId}/assets`);
    expect(source.media.some((item) => item.sourcePath === url.searchParams.get('path'))).toBe(
      true,
    );
  }
  expect(source.media.find((item) => item.sourcePath.endsWith('/point-logo.png'))).toBeDefined();
  expect(await checksumDocument(source)).toBe(checksum);
  expect(source).toEqual(defaultSiteDocument);
  expect(display.pages).toBe(source.pages);
  expect(display.linkedMedia).toBe(source.linkedMedia);
});

it('isolates display URLs for two owners sharing the same retained source path', () => {
  const first = draftDisplayDocument(defaultSiteDocument, 'first-owner');
  const second = draftDisplayDocument(defaultSiteDocument, 'second-owner');
  expect(first.media[0].sourcePath).toContain('/api/drafts/first-owner/assets?path=');
  expect(second.media[0].sourcePath).toContain('/api/drafts/second-owner/assets?path=');
  expect(first.media[0].sourcePath).not.toBe(second.media[0].sourcePath);
  expect(defaultSiteDocument.media[0].sourcePath).toMatch(/^\/assets\//);
});
