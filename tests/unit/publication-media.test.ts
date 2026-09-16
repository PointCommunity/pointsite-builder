// @vitest-environment node
import { expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import { SiteRenderer } from '../../src/site-kit/SiteRenderer';
import { publicationMediaPaths } from '../../src/site-kit/publication-media';
import { upgradeNavigation } from '../../src/site-kit/migrations';

it('retains every rendered image, metadata image and asset link without mutating the draft', () => {
  const document = structuredClone(defaultSiteDocument);
  const unused = { id: crypto.randomUUID(), sourcePath: '/assets/unused.webp', alt: 'Unused' };
  const background = { ...unused, id: crypto.randomUUID(), sourcePath: '/assets/background.webp' };
  const metadata = { ...unused, id: crypto.randomUUID(), sourcePath: '/assets/metadata.webp' };
  document.media.push(unused, background, metadata);
  document.collections.people.push({
    id: crypto.randomUUID(),
    name: 'Unused',
    role: 'Unused',
    bio: 'Unused',
    mediaId: unused.id,
  });
  document.pages[0].blocks[0].backgroundMediaId = background.id;
  document.pages[0].metadata.ogImageMediaId = metadata.id;
  document.navigation[0].href = '/assets/download.webp?download=1#image';
  document.pages[1].status = 'hidden';
  const before = structuredClone(document);
  const paths = publicationMediaPaths(document);
  expect(paths).not.toContain(unused.sourcePath);
  expect(paths).toEqual(
    expect.arrayContaining([background.sourcePath, metadata.sourcePath, '/assets/download.webp']),
  );
  for (const page of document.pages) {
    const html = renderToStaticMarkup(createElement(SiteRenderer, { document, route: page.route }));
    for (const match of html.matchAll(/(?:src="|url\(&quot;)(\/assets\/[^"&]+)/g))
      expect(paths).toContain(match[1]);
  }
  expect(document).toEqual(before);
  expect(new Set(paths).size).toBe(paths.length);
});

it('rejects missing referenced media instead of silently publishing a broken image', () => {
  const document = structuredClone(defaultSiteDocument);
  document.pages[0].metadata.ogImageMediaId = crypto.randomUUID();
  expect(() => publicationMediaPaths(document)).toThrow('CANDIDATE_MEDIA_REFERENCE_INVALID');
});

it('retains asset links from referenced designs and excludes unused designs', () => {
  const document = upgradeNavigation(defaultSiteDocument);
  const design = document.navigationDesigns![0];
  design.items[0].href = '/assets/menu-download';
  document.navigationDesigns!.push({
    ...structuredClone(design),
    id: crypto.randomUUID(),
    items: [
      { id: crypto.randomUUID(), label: 'Unused', href: '/assets/unused-menu', children: [] },
    ],
  });
  expect(publicationMediaPaths(document)).toContain('/assets/menu-download');
  expect(publicationMediaPaths(document)).not.toContain('/assets/unused-menu');
  document.navigationDesigns = [];
  expect(() => publicationMediaPaths(document)).toThrow('CANDIDATE_NAVIGATION_REFERENCE_INVALID');
});
