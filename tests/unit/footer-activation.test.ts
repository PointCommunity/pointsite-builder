import { expect, test } from 'vitest';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import { migrateDocument } from '../../src/site-kit/migrations';
import { SiteDocumentSchema } from '../../src/site-kit/schema';
import { legacyFooterDocument } from '../fixtures/legacy-footer';

test('converts old footer content without mutating the source or changing existing layout', () => {
  const legacy = legacyFooterDocument();
  legacy.pages[0].blocks[1].layout = 'flow';
  legacy.pages[0].blocks[1].columns = 4;
  const before = structuredClone(legacy);
  expect(SiteDocumentSchema.safeParse(legacy).success).toBe(true);

  const result = migrateDocument(legacy);
  expect(result.applied).toEqual(['10-to-11']);
  expect(result.document).toMatchObject({ schemaVersion: 11, rendererVersion: '11.0.0' });
  expect(result.document.pages).toEqual(
    before.pages.map((page) => ({
      ...page,
      blocks: page.blocks.map((section) =>
        section.layout === 'flow' ? { ...section, columns: 1 } : section,
      ),
    })),
  );
  for (const key of [
    'site',
    'theme',
    'navigationDesigns',
    'forms',
    'media',
    'linkedMedia',
    'collections',
  ] as const)
    expect(result.document[key]).toEqual(before[key]);
  const footer = result.document.footer![0];
  expect(footer).toMatchObject({ columns: 3, stackAt: 'phone', width: 'site' });
  expect(footer.items.map((item) => item.element.type)).toEqual([
    'richText',
    'richText',
    'socialLinks',
  ]);
  expect(footer.items[0].element).toMatchObject({
    heading: 'Service Times',
    content: [{ type: 'paragraph', children: [{ text: before.site.service.schedule }] }],
  });
  expect(footer.items[1].element).toMatchObject({
    heading: 'Contact Info',
    content: [
      {
        type: 'address',
        text: `${before.site.address.street}\n${before.site.address.city}, ${before.site.address.region} ${before.site.address.postalCode}`,
      },
    ],
  });
  expect(footer.items[2].element).toMatchObject({ links: before.site.socialLinks });
  expect(legacy).toEqual(before);
  expect(migrateDocument(before)).toEqual(result);
});

test('leaves deliberately empty footers and authored columns unchanged after activation', () => {
  const document = SiteDocumentSchema.parse({
    ...legacyFooterDocument(),
    schemaVersion: 11,
    rendererVersion: '11.0.0',
    footer: [],
  });
  document.pages[0].blocks[1].layout = 'flow';
  document.pages[0].blocks[1].columns = 3;
  expect(migrateDocument(document)).toEqual({ document, applied: [] });
});

test('new default documents expose ordinary editable footer Blocks immediately', () => {
  expect(defaultSiteDocument.schemaVersion).toBe(11);
  expect(defaultSiteDocument.rendererVersion).toBe('11.0.0');
  expect(defaultSiteDocument.footer).toHaveLength(1);
  expect(migrateDocument(defaultSiteDocument)).toEqual({
    document: defaultSiteDocument,
    applied: [],
  });
});
