// @vitest-environment node
import { expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import { SiteRenderer } from '../../src/site-kit/SiteRenderer';
import { publicationMediaPaths } from '../../src/site-kit/publication-media';

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
