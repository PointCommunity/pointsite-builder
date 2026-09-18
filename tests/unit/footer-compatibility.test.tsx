import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import { migrateDocument } from '../../src/site-kit/migrations';
import { SiteDocumentSchema } from '../../src/site-kit/schema';
import { SiteRenderer } from '../../src/site-kit/SiteRenderer';
import { supportsRenderer } from '../../src/site-kit/version';
import { createEditableFooterSection } from '../../src/site-kit/editable-footer';
import { publicationMediaPaths } from '../../src/site-kit/publication-media';
import { renderSection } from '../../src/site-kit/registry';
import { legacyFooterDocument } from '../fixtures/legacy-footer';

test('old Flow sections keep stacking while schema 11 supports authored columns', () => {
  const document = legacyFooterDocument();
  const section = document.pages[0].blocks[0];
  section.layout = 'flow';
  section.columns = 3;
  const view = render(renderSection(section, document));
  expect(view.container.querySelector('.point-layout-section__grid')).toHaveStyle(
    '--point-section-columns: 1',
  );
  expect(view.container.querySelectorAll('.point-layout-item--span-1')).toHaveLength(
    section.items.length,
  );
  document.schemaVersion = 11;
  document.rendererVersion = '11.0.0';
  document.footer = [];
  view.rerender(renderSection(section, document));
  expect(view.container.querySelector('.point-layout-section__grid')).toHaveStyle(
    '--point-section-columns: 3',
  );
});

function nextDocument() {
  const document = migrateDocument(defaultSiteDocument).document;
  const section = structuredClone(document.pages[0].blocks[0]);
  section.layout = 'flow';
  section.position = 'flow';
  section.columns = 1;
  section.items = [
    {
      ...section.items[0],
      span: 1,
      element: {
        id: '88888888-8888-4888-8888-888888888888',
        type: 'text',
        text: 'My editable footer',
        style: 'body',
        align: 'left',
      },
    },
  ];
  return { ...document, schemaVersion: 11, rendererVersion: '11.0.0', footer: [section] };
}

test('the compatibility reader preserves and renders composed footers without adding a fixed footer', () => {
  const input = nextDocument();
  const document = SiteDocumentSchema.parse(input);
  expect(supportsRenderer(document)).toBe(true);
  expect(migrateDocument(document).document).toEqual(document);
  render(<SiteRenderer document={document} route="/" />);
  expect(screen.getByText('My editable footer').closest('footer')).not.toBeNull();
  expect(screen.queryByRole('heading', { name: 'Contact Info' })).toBeNull();
  expect(
    migrateDocument({ ...document, site: { ...document.site, name: 'Still editable' } }).document
      .footer,
  ).toEqual(document.footer);
});

test('composed content requires its own format and cannot silently enter an older document', () => {
  const input = nextDocument();
  expect(
    SiteDocumentSchema.safeParse({ ...input, schemaVersion: 10, rendererVersion: '10.0.0' })
      .success,
  ).toBe(false);
  const missingFooter = { ...input, footer: undefined };
  expect(SiteDocumentSchema.safeParse(missingFooter).success).toBe(false);
  expect(SiteDocumentSchema.safeParse({ ...input, rendererVersion: '10.0.0' }).success).toBe(false);
  const legacy = legacyFooterDocument();
  legacy.pages[0].blocks = [{ ...input.footer[0], items: [], gapPixels: 50 }];
  expect(SiteDocumentSchema.safeParse(legacy).success).toBe(false);
});

test('the footer composition keeps legacy content and every referenced publication asset', () => {
  const input = nextDocument();
  input.footer = [createEditableFooterSection(input.site)];
  const document = SiteDocumentSchema.parse(input);
  expect(createEditableFooterSection(document.site)).toEqual(document.footer![0]);
  const { container } = render(<SiteRenderer document={document} route="/" />);
  const footer = container.querySelector('.point-composed-footer')!;
  expect(footer.textContent).toContain(document.site.service.schedule);
  expect(footer.textContent).toContain(document.site.address.street);
  expect(footer.querySelectorAll('a')).toHaveLength(2);
  const asset = { id: crypto.randomUUID(), sourcePath: '/assets/footer-only.webp', alt: 'Footer' };
  document.media.push(asset);
  document.footer![0].backgroundMediaId = asset.id;
  expect(publicationMediaPaths(document)).toContain(asset.sourcePath);
  expect(migrateDocument(document).document).toEqual(document);
});

test('validates navigation references in the footer and reports the actual footer path', () => {
  const input = nextDocument();
  const navigation = input.pages[0].blocks
    .flatMap((section) => section.items)
    .find((item) => item.element.type === 'navigation')!;
  input.footer[0].items = [structuredClone(navigation)];
  expect(SiteDocumentSchema.safeParse(input).success).toBe(true);
  input.footer[0].items[0].element = {
    ...navigation.element,
    type: 'navigation',
    navigationDesignId: crypto.randomUUID(),
  } as typeof navigation.element;
  const result = SiteDocumentSchema.safeParse(input);
  expect(result.success).toBe(false);
  if (!result.success)
    expect(result.error.issues[0].path).toEqual([
      'footer',
      0,
      'items',
      0,
      'element',
      'navigationDesignId',
    ]);
});
