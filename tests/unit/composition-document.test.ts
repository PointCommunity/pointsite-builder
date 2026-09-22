import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import { independentGridArea, independentResponsiveValue } from '../../src/site-kit/grid-layout';
import { migrateDocument } from '../../src/site-kit/migrations';
import { SiteDocumentSchema } from '../../src/site-kit/schema';
import { canEditDocument, supportsRenderer } from '../../src/site-kit/version';
import { SiteRenderer } from '../../src/site-kit/SiteRenderer';
import { allBlocks } from '../fixtures/block-data';
import { InMemoryRepository } from '../../src/server/repositories/memory';
import { acquireDraftProof } from '../fixtures/draft-proof';

function composedDocument() {
  const document = structuredClone(defaultSiteDocument) as unknown as Record<string, unknown>;
  document.schemaVersion = 12;
  document.rendererVersion = '12.0.0';
  const pages = document.pages as Array<{ blocks: Array<{ items: Array<{ element: unknown }> }> }>;
  pages[0].blocks[1].items[0].element = {
    id: '22222222-2222-4222-8222-222222222221',
    type: 'composition',
    name: 'Hero',
    items: [
      {
        id: '22222222-2222-4222-8222-222222222222',
        span: 6,
        align: independentResponsiveValue('stretch'),
        grid: independentGridArea({ column: 1, row: 1, columnSpan: 6, rowSpan: 3 }),
        layer: 0,
        element: {
          id: '22222222-2222-4222-8222-222222222223',
          type: 'text',
          text: 'Welcome',
          style: 'lead',
          align: 'left',
        },
      },
    ],
  };
  return document;
}

describe('composed document compatibility', () => {
  it('reads version 12 without rewriting it', () => {
    const input = composedDocument();
    expect(SiteDocumentSchema.parse(input)).toEqual(input);
    expect(migrateDocument(input)).toEqual({ document: input, applied: [] });
    expect(supportsRenderer({ schemaVersion: 12, rendererVersion: '12.0.0' })).toBe(true);
  });

  it('does not write version 12 when reading existing version 11 drafts', () => {
    const existing = structuredClone(defaultSiteDocument);
    expect(migrateDocument(existing)).toEqual({ document: existing, applied: [] });
    expect(canEditDocument(existing)).toBe(true);
    expect(
      canEditDocument(composedDocument() as { schemaVersion: number; rendererVersion: string }),
    ).toBe(false);
  });

  it('does not allow composed content to be stored as a version 11 document', () => {
    const invalid = composedDocument();
    invalid.schemaVersion = 11;
    invalid.rendererVersion = '11.0.0';
    expect(SiteDocumentSchema.safeParse(invalid).success).toBe(false);
  });

  it('renders composed children from the shared site renderer', () => {
    const document = SiteDocumentSchema.parse(composedDocument());
    const html = renderToStaticMarkup(createElement(SiteRenderer, { document, route: '/' }));
    expect(html).toContain('aria-label="Hero"');
    expect(html).toContain('Welcome');
    expect(html).not.toContain('Point ATX</h1>');
  });

  it('renders independent semantic text and treats an empty field as no text', () => {
    const input = composedDocument();
    const pages = input.pages as Array<{ blocks: Array<{ items: Array<{ element: unknown }> }> }>;
    const group = pages[0].blocks[1].items[0].element as {
      items: Array<{ element: Record<string, unknown> }>;
    };
    group.items[0].element.semantic = 'h1';
    let document = SiteDocumentSchema.parse(input);
    expect(renderToStaticMarkup(createElement(SiteRenderer, { document, route: '/' }))).toContain(
      '<h1 class="point-text',
    );
    group.items[0].element.text = '';
    document = SiteDocumentSchema.parse(input);
    expect(
      renderToStaticMarkup(createElement(SiteRenderer, { document, route: '/' })),
    ).not.toContain('class="point-text');
  });

  it('rejects version-12 text semantics and image links mislabelled as version 11', () => {
    const old = structuredClone(defaultSiteDocument) as unknown as Record<string, unknown>;
    const pages = old.pages as Array<{
      blocks: Array<{ items: Array<{ element: Record<string, unknown> }> }>;
    }>;
    pages[0].blocks[1].items[0].element = {
      id: crypto.randomUUID(),
      type: 'text',
      text: '',
      style: 'body',
      align: 'left',
      semantic: 'h1',
    };
    expect(SiteDocumentSchema.safeParse(old).success).toBe(false);
    pages[0].blocks[1].items[0].element = {
      id: crypto.randomUUID(),
      type: 'image',
      mediaId: defaultSiteDocument.media[0].id,
      alt: 'Linked image',
      aspect: 'natural',
      fit: 'cover',
      href: 'https://example.com',
    };
    expect(SiteDocumentSchema.safeParse(old).success).toBe(false);
    pages[0].blocks[1].items[0].element = {
      id: crypto.randomUUID(),
      type: 'cards',
      columns: 2,
      items: [{ title: 'Linked card', body: 'Description', mediaFit: 'stretch' }],
    };
    expect(SiteDocumentSchema.safeParse(old).success).toBe(false);
  });

  it.each([
    ['hero', 'heading'],
    ['heading', 'text'],
    ['image', 'alt'],
    ['splitFeature', 'heading'],
    ['cta', 'heading'],
    ['button', 'label'],
    ['navigation', 'label'],
    ['map', 'title'],
  ] as const)('stores an empty %s %s only in version 12', (type, field) => {
    const element = allBlocks.find((block) => block.type === type)!;
    const old = structuredClone(defaultSiteDocument) as unknown as Record<string, unknown>;
    const pages = old.pages as Array<{ blocks: Array<{ items: Array<{ element: unknown }> }> }>;
    pages[0].blocks[1].items[0].element = {
      ...element,
      ...(type === 'navigation'
        ? { navigationDesignId: defaultSiteDocument.navigationDesigns?.[0]?.id }
        : {}),
      [field]: '',
    };
    expect(SiteDocumentSchema.safeParse(old).success).toBe(false);
    old.schemaVersion = 12;
    old.rendererVersion = '12.0.0';
    expect(SiteDocumentSchema.safeParse(old).success).toBe(true);
  });

  it('keeps blank card copy as empty text, without dropping the card', () => {
    const source = allBlocks.find((block) => block.type === 'cards')!;
    const input = composedDocument();
    const pages = input.pages as Array<{ blocks: Array<{ items: Array<{ element: unknown }> }> }>;
    pages[0].blocks[1].items[0].element = {
      ...source,
      items: [{ title: '', body: '' }],
    };
    const document = SiteDocumentSchema.parse(input);
    const html = renderToStaticMarkup(createElement(SiteRenderer, { document, route: '/' }));
    expect(html).not.toContain('<h3></h3>');
    expect(document.pages[0].blocks[1].items[0].element).toMatchObject({
      items: [{ title: '', body: '' }],
    });
  });

  it('allows blank rich text nodes in version 12 and omits their markup', () => {
    const input = composedDocument();
    const pages = input.pages as Array<{ blocks: Array<{ items: Array<{ element: unknown }> }> }>;
    pages[0].blocks[1].items[0].element = {
      id: crypto.randomUUID(),
      type: 'richText',
      content: [
        { type: 'paragraph', children: [{ text: '' }] },
        { type: 'bulletedList', items: [''] },
        { type: 'quote', text: '' },
        { type: 'link', text: '', href: '/' },
      ],
    };
    const document = SiteDocumentSchema.parse(input);
    const html = renderToStaticMarkup(createElement(SiteRenderer, { document, route: '/' }));
    expect(html).not.toContain('<li></li>');
    expect(html).not.toContain('<blockquote>');
    expect(html).not.toContain('href="/"');
    input.schemaVersion = 11;
    input.rendererVersion = '11.0.0';
    expect(SiteDocumentSchema.safeParse(input).success).toBe(false);
  });

  it('retains the previously valid empty inline paragraph on version 11', () => {
    const old = structuredClone(defaultSiteDocument);
    const element = old.pages
      .flatMap((page) =>
        page.blocks.flatMap((section) => section.items.map((item) => item.element)),
      )
      .find((block) => block.type === 'richText');
    expect(element?.type).toBe('richText');
    if (element?.type !== 'richText') return;
    element.content = [{ type: 'paragraph', children: [{ text: '' }] }];
    expect(SiteDocumentSchema.safeParse(old).success).toBe(true);
  });

  it('keeps newer drafts read only through repository writes', async () => {
    const repository = new InMemoryRepository();
    const actor = 'editor@example.com';
    const future = SiteDocumentSchema.parse(composedDocument());
    const draft = await repository.createDraft({
      name: 'Future document',
      document: future,
      actor,
      idempotencyKey: crypto.randomUUID(),
      requestId: 'fixture',
    });
    expect((await repository.getDraft(draft.id)).document).toEqual(future);
    const proof = await acquireDraftProof(repository, draft.id, actor);
    const save = {
      draftId: draft.id,
      ...proof,
      actor,
      idempotencyKey: crypto.randomUUID(),
      requestId: 'edit',
      action: { category: 'text-edit' as const, context: 'page-content' as const },
    };
    await expect(repository.saveDraft({ ...save, document: defaultSiteDocument })).rejects.toThrow(
      'read only',
    );
    await expect(repository.saveDraft({ ...save, document: future })).rejects.toThrow('read only');
    expect((await repository.getDraft(draft.id)).document).toEqual(future);
  });
});
