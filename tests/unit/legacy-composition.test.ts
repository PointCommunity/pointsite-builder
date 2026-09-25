import { describe, expect, it } from 'vitest';
import { compositionFromLegacy } from '../../src/client/editor/legacy-composition';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import { SiteElementSchema } from '../../src/site-kit/schema';
import { areasOverlap } from '../../src/site-kit/grid-layout';
import type { SiteElement } from '../../src/site-kit/types';

const id = () => crypto.randomUUID();

function content(group: ReturnType<typeof compositionFromLegacy>) {
  expect(group).toBeDefined();
  expect(SiteElementSchema.safeParse(group).success).toBe(true);
  return group!.items.map((item) => item.element);
}

describe('explicit legacy-to-grid conversion', () => {
  it('keeps Hero copy, action destination and media as independently editable parts', () => {
    const block: SiteElement = {
      id: id(),
      type: 'hero',
      variant: 'pageHero',
      eyebrow: 'About',
      heading: 'Who We Are',
      body: 'Our story',
      align: 'center',
      surface: 'image',
      mediaId: defaultSiteDocument.media[0].id,
      mediaFocal: { x: 32, y: 68 },
      actions: [{ label: 'Contact', href: '/contact', style: 'primary' }],
      headingWidth: { desktop: 100, tablet: 100, mobile: 100 },
      bodyWidth: { desktop: 100, tablet: 100, mobile: 100 },
    };
    const parts = content(compositionFromLegacy(block, defaultSiteDocument));
    expect(parts.filter((part) => part.type === 'text').map((part) => part.text)).toEqual([
      'About',
      'Who We Are',
      'Our story',
    ]);
    expect(parts.find((part) => part.type === 'image')).toMatchObject({
      mediaId: block.mediaId,
      focal: block.mediaFocal,
    });
    expect(parts.find((part) => part.type === 'button')).toMatchObject({ href: '/contact' });
    expect(parts.every((part) => part.id !== block.id)).toBe(true);
  });

  it('keeps Card and People images, text, links, and accessible alternatives', () => {
    const mediaId = defaultSiteDocument.media[0].id;
    const cards: SiteElement = {
      id: id(),
      type: 'cards',
      columns: 2,
      items: [
        {
          title: 'Card',
          body: 'Description',
          mediaId,
          mediaAlt: 'Portrait',
          mediaFit: 'contain',
          mediaFrame: 'portrait',
          href: '/about',
        },
      ],
    };
    const cardParts = content(compositionFromLegacy(cards, defaultSiteDocument));
    expect(cardParts.find((part) => part.type === 'image')).toMatchObject({
      mediaId,
      alt: 'Portrait',
      fit: 'contain',
      aspect: '4:5',
    });
    expect(cardParts.find((part) => part.type === 'button')).toMatchObject({ href: '/about' });
    const person = defaultSiteDocument.collections.people[0];
    const people: SiteElement = {
      id: id(),
      type: 'people',
      personIds: [person.id],
      layout: 'grid',
    };
    const personParts = content(compositionFromLegacy(people, defaultSiteDocument));
    expect(personParts.filter((part) => part.type === 'text').map((part) => part.text)).toEqual([
      person.name,
      person.role,
      person.bio,
    ]);
    expect(personParts.find((part) => part.type === 'image')).toMatchObject({
      mediaId: person.mediaId,
    });
  });

  it('keeps a contact Form reference and splits surrounding copy from its control', () => {
    const formId = defaultSiteDocument.forms[0].id;
    const block: SiteElement = {
      id: id(),
      type: 'form',
      variant: 'contact',
      formId,
      eyebrow: 'Office Hours',
      heading: 'Get in touch',
      body: 'connect@example.org\n11300 Old San Antonio Rd',
      supportingText: 'We will reply',
      linkLabel: 'Directions',
      linkHref: '/visit',
    };
    const parts = content(compositionFromLegacy(block, defaultSiteDocument));
    expect(parts.find((part) => part.type === 'form')).toMatchObject({
      formId,
      variant: 'standard',
    });
    expect(parts.filter((part) => part.type === 'text').map((part) => part.text)).toEqual([
      'Office Hours',
      'Get in touch',
      '11300 Old San Antonio Rd',
      'We will reply',
    ]);
    expect(
      parts.find((part) => part.type === 'button' && part.href === 'mailto:connect@example.org'),
    ).toMatchObject({ label: 'connect@example.org' });
    expect(parts.find((part) => part.type === 'button' && part.href === '/visit')).toMatchObject({
      label: 'Directions',
      href: '/visit',
    });
    const placements = compositionFromLegacy(block, defaultSiteDocument)!.items;
    for (let index = 0; index < placements.length; index++)
      for (let other = index + 1; other < placements.length; other++)
        expect(areasOverlap(placements[index].grid.mobile, placements[other].grid.mobile)).toBe(
          false,
        );
  });

  it('fits the maximum Card count on the mobile grid without losing optional fields', () => {
    const cards: SiteElement = {
      id: id(),
      type: 'cards',
      columns: 4,
      eyebrow: 'Collection',
      heading: 'All cards',
      items: Array.from({ length: 12 }, (_, index) => ({
        eyebrow: `Label ${index}`,
        title: `Title ${index}`,
        body: `Body ${index}`,
        supportingText: `Detail ${index}`,
        mediaId: defaultSiteDocument.media[0].id,
        href: '/about',
      })),
    };
    const group = compositionFromLegacy(cards, defaultSiteDocument);
    const parts = content(group);
    expect(parts).toHaveLength(74);
    expect(
      Math.max(...group!.items.map((item) => item.grid.mobile.row + item.grid.mobile.rowSpan - 1)),
    ).toBeLessThanOrEqual(100);
  });

  it('keeps an existing Heading 4 semantic level', () => {
    const heading: SiteElement = {
      id: id(),
      type: 'heading',
      text: 'Subheading',
      level: 4,
      align: 'left',
      width: 'wide',
    };
    expect(content(compositionFromLegacy(heading, defaultSiteDocument))).toContainEqual(
      expect.objectContaining({ type: 'text', text: 'Subheading', semantic: 'h4' }),
    );
  });
});
