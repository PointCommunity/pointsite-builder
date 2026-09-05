import { IDS, validSiteDocument } from '../fixtures/site-documents';
import { SiteDocumentSchema } from '../../src/site-kit/schema';

function cloneDocument(): Record<string, unknown> {
  return structuredClone(validSiteDocument);
}

describe('SiteDocumentSchema', () => {
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
    'http://pointatx.org',
    'https://example.com\\@pointatx.org',
  ])('rejects unsafe link %s', (href) => {
    const input = cloneDocument();
    const pages = input.pages as Array<Record<string, unknown>>;
    const blocks = pages[0].blocks as Array<Record<string, unknown>>;
    const actions = blocks[0].actions as Array<Record<string, unknown>>;
    actions[0].href = href;
    expect(SiteDocumentSchema.safeParse(input).success).toBe(false);
  });

  it('rejects unknown component discriminators and component fields', () => {
    const unknownType = cloneDocument();
    const pages = unknownType.pages as Array<Record<string, unknown>>;
    const blocks = pages[0].blocks as Array<Record<string, unknown>>;
    blocks[0].type = 'custom-html';
    expect(SiteDocumentSchema.safeParse(unknownType).success).toBe(false);

    const unknownField = cloneDocument();
    const nextPages = unknownField.pages as Array<Record<string, unknown>>;
    const nextBlocks = nextPages[0].blocks as Array<Record<string, unknown>>;
    nextBlocks[0].dangerouslySetInnerHTML = '<script>alert(1)</script>';
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
    ];

    for (const block of blocks) {
      const input = cloneDocument();
      const pages = input.pages as Array<Record<string, unknown>>;
      pages[0].blocks = [block];
      expect(SiteDocumentSchema.safeParse(input).success, block.type).toBe(true);
    }
  });
});
