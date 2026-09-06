import { defaultSiteDocument } from '../../src/site-kit/default-site';
import { SiteDocumentSchema } from '../../src/site-kit/schema';

const EXPECTED_ROUTES = [
  '/',
  '/building-rental',
  '/connect-card',
  '/contact',
  '/give',
  '/leadership',
  '/neighborhood-groups',
  '/next-generation',
  '/prayer-request',
  '/what-we-believe',
  '/who-we-are',
];

const EXPECTED_ASSETS = [
  '/assets/austin-skyline.jpeg',
  '/assets/neighborhood-table.jpeg',
  '/assets/next-generation-secondary.jpeg',
  '/assets/next-generation.jpeg',
  '/assets/pages/giving.png',
  '/assets/pages/kids-ministry-1.jpeg',
  '/assets/pages/kids-ministry-2.jpeg',
  '/assets/pages/kids-ministry-3.jpeg',
  '/assets/pages/neighborhood-map.png',
  '/assets/pages/who-we-are.jpeg',
  '/assets/people/gonzo-gonzales.jpeg',
  '/assets/people/josh-currer.jpeg',
  '/assets/people/landon-berryhill.jpeg',
  '/assets/people/laura-munoz.jpeg',
  '/assets/people/nick-shock.jpeg',
  '/assets/people/sandra-louviere.jpeg',
  '/assets/people/tim-gillen.jpeg',
  '/assets/point-logo.png',
  '/assets/point-wordmark.jpeg',
];

describe('default PointSite document', () => {
  it('is valid and carries the current renderer identity', () => {
    expect(SiteDocumentSchema.parse(defaultSiteDocument)).toEqual(defaultSiteDocument);
    expect(defaultSiteDocument.schemaVersion).toBe(2);
    expect(defaultSiteDocument.rendererVersion).toBe('2.0.0');
  });

  it('represents every current generated route and navigation link', () => {
    expect(defaultSiteDocument.pages.map(({ route }) => route).sort()).toEqual(EXPECTED_ROUTES);
    expect(
      defaultSiteDocument.navigation.flatMap(({ href, children }) => [
        href,
        ...children.map((child) => child.href),
      ]),
    ).toEqual([
      '/who-we-are',
      '/who-we-are',
      '/what-we-believe',
      '/leadership',
      '/next-generation',
      '/connect-card',
      '/connect-card',
      '/neighborhood-groups',
      '/prayer-request',
      '/give',
      '/contact',
    ]);
  });

  it('preserves all current public assets as managed records', () => {
    expect(defaultSiteDocument.media.map(({ sourcePath }) => sourcePath).sort()).toEqual(
      EXPECTED_ASSETS,
    );
  });

  it('preserves current forms, collections, and identity data', () => {
    expect(defaultSiteDocument.forms).toHaveLength(9);
    expect(defaultSiteDocument.forms.flatMap(({ fields }) => fields)).toHaveLength(48);
    expect(defaultSiteDocument.collections.people.map(({ name }) => name)).toEqual([
      'Nick Shock',
      'Josh Currer',
      'Gonzo Gonzales',
      'Laura Munoz',
      'Sandra Louviere',
    ]);
    expect(defaultSiteDocument.collections.beliefs).toHaveLength(7);
    expect(defaultSiteDocument.collections.groups).toHaveLength(6);
    expect(defaultSiteDocument.site.email).toBe('connect@pointaustin.org');
    expect(defaultSiteDocument.site.service.schedule).toBe('Sunday at 10:30 AM');
    expect(defaultSiteDocument.site.givingUrl).toBe('https://subsplash.com/u/-W69J2R/give');
  });

  it('keeps distinctive current page content editable', () => {
    const serialized = JSON.stringify(defaultSiteDocument);
    expect(serialized).toContain('Family. Disciples. Mission.');
    expect(serialized).toContain('Association of Hill Country Churches');
    expect(serialized).toContain('First Point');
    expect(serialized).toContain('How can I get connected?');
    expect(serialized).toContain('Give In Person');
    expect(serialized).toContain('Building Rental');
  });

  it('models every production visual surface as editable page and module data', () => {
    const home = defaultSiteDocument.pages.find((page) => page.route === '/');
    const about = defaultSiteDocument.pages.find((page) => page.route === '/who-we-are');
    const beliefs = defaultSiteDocument.pages.find((page) => page.route === '/what-we-believe');

    expect(home).toMatchObject({ eyebrow: 'Point ATX', template: 'home' });
    expect(home?.blocks.map((section) => section.items[0]?.element.variant)).toEqual([
      'homeHero',
      'homeIntro',
      'photoBanner',
      'splitFeature',
      'gathering',
    ]);
    expect(about).toMatchObject({
      eyebrow: 'About Point',
      intro: 'We are a family of disciples on mission.',
      template: 'standard',
    });
    expect(about?.heroMediaId).toBeTruthy();
    expect(about?.blocks.map((section) => section.items[0]?.element.variant)).toEqual([
      'splitEditorial',
      'identity',
      'prose',
    ]);
    expect(beliefs?.blocks.some((section) => section.items[0]?.element.variant === 'beliefs')).toBe(
      true,
    );
    expect(
      defaultSiteDocument.pages
        .find((page) => page.route === '/next-generation')
        ?.blocks.some((section) => section.items[0]?.element.variant === 'imageSplit'),
    ).toBe(true);
    expect(
      defaultSiteDocument.pages
        .find((page) => page.route === '/contact')
        ?.blocks.map((section) => section.items[0]?.element.variant),
    ).toEqual(['contact', 'rental']);
  });

  it('standardizes every production-derived module inside a compatibility section', () => {
    for (const page of defaultSiteDocument.pages) {
      expect(page.blocks.length).toBeGreaterThan(0);
      for (const section of page.blocks) {
        expect(section).toMatchObject({ type: 'section', layout: 'compatibility' });
        expect(section.items).toHaveLength(1);
      }
    }
  });
});
