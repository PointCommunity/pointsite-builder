import { IDS, validSiteDocument } from '../fixtures/site-documents';
import { SiteDocumentSchema } from '../../src/site-kit/schema';
import { createCompatibilitySection } from '../../src/site-kit/migrations';
import type { SiteElement } from '../../src/site-kit/types';
import { allBlocks } from '../fixtures/block-data';
import { independentGridArea, independentResponsiveValue } from '../../src/site-kit/grid-layout';

function cloneDocument(): Record<string, unknown> {
  return structuredClone(validSiteDocument);
}

describe('SiteDocumentSchema', () => {
  it('rejects removed page-level visual hero fields', () => {
    for (const field of ['eyebrow', 'intro', 'heroMediaId']) {
      const input = cloneDocument();
      const page = (input.pages as Array<Record<string, unknown>>)[0];
      if (!page) throw new Error('Expected a page fixture');
      page[field] = field === 'heroMediaId' ? IDS.linkedMedia : 'Legacy visual value';

      expect(SiteDocumentSchema.safeParse(input).success).toBe(false);
    }
  });

  it('accepts a strict, versioned site document', () => {
    expect(SiteDocumentSchema.parse(validSiteDocument)).toEqual(validSiteDocument);
  });

  it('rejects unknown fields with their exact path', () => {
    const input = cloneDocument();
    input.script = '<script>alert(1)</script>';

    const result = SiteDocumentSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual([]);
      expect(result.error.issues[0]?.code).toBe('unrecognized_keys');
    }
  });

  it.each(['/About', 'about', '/about/', '/api/private', '/admin', '//evil.example'])(
    'rejects unsafe or noncanonical route %s',
    (route) => {
      const input = cloneDocument();
      const pages = input.pages as Array<Record<string, unknown>>;
      pages[0].route = route;
      expect(SiteDocumentSchema.safeParse(input).success).toBe(false);
    },
  );

  it('rejects duplicate page routes', () => {
    const input = cloneDocument();
    const pages = input.pages as Array<Record<string, unknown>>;
    pages.push({ ...structuredClone(pages[0]), id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
    expect(SiteDocumentSchema.safeParse(input).success).toBe(false);
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,unsafe',
    'example.com/path',
    'ftp://pointatx.org',
    'https://example.com\\@pointatx.org',
  ])('rejects unsafe link %s', (href) => {
    const input = cloneDocument();
    const pages = input.pages as Array<Record<string, unknown>>;
    const blocks = pages[0].blocks as Array<Record<string, unknown>>;
    const items = blocks[0].items as Array<Record<string, unknown>>;
    const element = items[0].element as Record<string, unknown>;
    const actions = element.actions as Array<Record<string, unknown>>;
    actions[0].href = href;
    expect(SiteDocumentSchema.safeParse(input).success).toBe(false);
  });

  it.each(['http://pointatx.org', 'https://pointatx.org'])(
    'accepts explicit web link %s',
    (href) => {
      const input = cloneDocument();
      const pages = input.pages as Array<Record<string, unknown>>;
      const blocks = pages[0].blocks as Array<Record<string, unknown>>;
      const items = blocks[0].items as Array<Record<string, unknown>>;
      const element = items[0].element as Record<string, unknown>;
      const actions = element.actions as Array<Record<string, unknown>>;
      actions[0].href = href;
      expect(SiteDocumentSchema.safeParse(input).success).toBe(true);
    },
  );

  it('rejects unknown component discriminators and component fields', () => {
    const unknownType = cloneDocument();
    const pages = unknownType.pages as Array<Record<string, unknown>>;
    const blocks = pages[0].blocks as Array<Record<string, unknown>>;
    const items = blocks[0].items as Array<Record<string, unknown>>;
    const element = items[0].element as Record<string, unknown>;
    element.type = 'custom-html';
    expect(SiteDocumentSchema.safeParse(unknownType).success).toBe(false);

    const unknownField = cloneDocument();
    const nextPages = unknownField.pages as Array<Record<string, unknown>>;
    const nextBlocks = nextPages[0].blocks as Array<Record<string, unknown>>;
    const nextItems = nextBlocks[0].items as Array<Record<string, unknown>>;
    const nextElement = nextItems[0].element as Record<string, unknown>;
    nextElement.dangerouslySetInnerHTML = '<script>alert(1)</script>';
    expect(SiteDocumentSchema.safeParse(unknownField).success).toBe(false);
  });

  it('rejects invalid identifiers and bounded fields', () => {
    const invalidId = cloneDocument();
    const pages = invalidId.pages as Array<Record<string, unknown>>;
    pages[0].id = 'page-1';
    expect(SiteDocumentSchema.safeParse(invalidId).success).toBe(false);

    const longTitle = cloneDocument();
    const titlePages = longTitle.pages as Array<Record<string, unknown>>;
    titlePages[0].title = 'x'.repeat(121);
    expect(SiteDocumentSchema.safeParse(longTitle).success).toBe(false);
  });

  it('accepts every required component discriminator', () => {
    const blocks = [
      { id: IDS.block, type: 'heading', text: 'Hello', level: 2, align: 'left', width: 'wide' },
      {
        id: IDS.block,
        type: 'richText',
        content: [{ type: 'paragraph', children: [{ text: 'Hello' }] }],
      },
      {
        id: IDS.block,
        type: 'image',
        mediaId: IDS.person,
        alt: 'People gathering',
        aspect: '16:9',
        fit: 'cover',
      },
      {
        id: IDS.block,
        type: 'splitFeature',
        heading: 'Together',
        body: 'Community.',
        mediaId: IDS.person,
        mediaSide: 'left',
        proportion: 'half',
        align: 'center',
        surface: 'canvas',
      },
      {
        id: IDS.block,
        type: 'cta',
        heading: 'Visit',
        body: 'This Sunday.',
        action: { label: 'Plan', href: '/visit', style: 'primary' },
        surface: 'primary',
      },
      {
        id: IDS.block,
        type: 'cards',
        columns: 3,
        items: [{ title: 'Belong', body: 'Find family.' }],
      },
      { id: IDS.block, type: 'people', personIds: [IDS.person], layout: 'grid' },
      { id: IDS.block, type: 'faq', items: [{ question: 'When?', answer: 'Sunday.' }] },
      { id: IDS.block, type: 'form', formId: IDS.form, heading: 'Contact us' },
      {
        id: IDS.block,
        type: 'map',
        query: '11300 Old San Antonio Road, Manchaca, TX',
        title: 'Point Community Church location',
      },
      { id: IDS.block, type: 'divider', style: 'line' },
      { id: IDS.block, type: 'spacer', size: 'medium' },
      { id: IDS.block, type: 'text', text: 'Independent body copy', style: 'body', align: 'left' },
      {
        id: IDS.block,
        type: 'button',
        label: 'Plan a visit',
        href: '/contact',
        style: 'primary',
        width: 'fit',
        align: 'left',
      },
      {
        id: IDS.block,
        type: 'mediaEmbed',
        linkedMediaId: IDS.linkedMedia,
        aspect: '16:9',
        fit: 'cover',
      },
      {
        id: IDS.block,
        type: 'navigation',
        label: 'Church navigation',
        orientation: 'responsive',
        align: 'right',
        surface: 'transparent',
      },
    ];

    for (const block of blocks) {
      const input = cloneDocument();
      const pages = input.pages as Array<Record<string, unknown>>;
      pages[0].blocks = [createCompatibilitySection(block as SiteElement)];
      expect(SiteDocumentSchema.safeParse(input).success, block.type).toBe(true);
    }
  });

  it('round-trips the complete element library inside one standardized grid section', () => {
    const input = cloneDocument();
    const pages = input.pages as Array<Record<string, unknown>>;
    pages[0].blocks = [
      {
        id: '30000000-0000-4000-8000-000000000001',
        type: 'section',
        name: 'Complete element library',
        layout: 'grid',
        position: 'flow',
        columns: 12,
        gap: 'medium',
        width: 'shell',
        surface: 'transparent',
        padding: 'medium',
        minRows: 1,
        backgroundPosition: 'center',
        overlay: 'none',
        items: allBlocks.map((element, index) => ({
          id: `30000000-0000-4000-8000-${String(index + 2).padStart(12, '0')}`,
          span: 12,
          align: independentResponsiveValue('stretch'),
          grid: independentGridArea({
            column: 1,
            row: index * 10 + 1,
            columnSpan: 12,
            rowSpan: 10,
          }),
          element,
        })),
      },
    ];

    const saved = JSON.stringify(SiteDocumentSchema.parse(input));
    const reloaded = SiteDocumentSchema.parse(JSON.parse(saved));
    const types = reloaded.pages[0].blocks[0].items.map((item) => item.element.type);
    expect(new Set(types)).toEqual(new Set(allBlocks.map((block) => block.type)));
    expect(types).toHaveLength(17);
  });

  it('rejects unsafe atomic button hyperlinks', () => {
    const input = cloneDocument();
    const pages = input.pages as Array<Record<string, unknown>>;
    const sections = pages[0].blocks as Array<Record<string, unknown>>;
    sections[0].items = [
      {
        id: '30000000-0000-4000-8000-000000000099',
        span: 4,
        align: independentResponsiveValue('start'),
        grid: independentGridArea({ column: 1, row: 1, columnSpan: 4, rowSpan: 2 }),
        element: {
          id: '30000000-0000-4000-8000-000000000098',
          type: 'button',
          label: 'Unsafe',
          href: 'javascript:alert(1)',
          style: 'primary',
          width: 'fit',
          align: 'left',
        },
      },
    ];
    expect(SiteDocumentSchema.safeParse(input).success).toBe(false);
  });

  it('rejects a grid section that is not standardized to twelve columns', () => {
    const input = cloneDocument();
    const pages = input.pages as Array<Record<string, unknown>>;
    const sections = pages[0].blocks as Array<Record<string, unknown>>;
    sections[0].layout = 'grid';
    sections[0].columns = 2;

    const result = SiteDocumentSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ['pages', 0, 'blocks', 0, 'columns'],
          message: 'Grid sections use exactly 12 columns',
        }),
      );
    }
  });
});
