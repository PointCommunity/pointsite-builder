import { render, screen } from '@testing-library/react';
import { allBlocksDocument } from '../fixtures/block-data';
import { blockDefinitions, renderBlock, renderSection } from '../../src/site-kit/registry';
import { SiteRenderer } from '../../src/site-kit/SiteRenderer';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import type { SectionBlock } from '../../src/site-kit/types';

describe('controlled public renderer', () => {
  it('renders the Point Classic production chrome and homepage structure', () => {
    const { container } = render(<SiteRenderer document={defaultSiteDocument} route="/" />);

    expect(container.querySelector('.site-header.site-header--overlay')).not.toBeNull();
    expect(screen.getByRole('link', { name: 'Point Community Church home' })).toContainElement(
      screen.getByRole('img', { name: 'Point' }),
    );
    expect(container.querySelector('.home-hero')).not.toBeNull();
    expect(container.querySelector('.home-intro')).not.toBeNull();
    expect(container.querySelector('.home-feature--photo')).not.toBeNull();
    expect(container.querySelector('.home-feature--split')).not.toBeNull();
    expect(container.querySelector('.gathering-section')).not.toBeNull();
    expect(container.querySelector('.site-footer .footer-grid')).not.toBeNull();
    expect(screen.getByRole('link', { name: 'Who we are' })).toHaveAttribute('href', '/who-we-are');
    expect(screen.getByRole('link', { name: 'Our beliefs' })).toHaveAttribute(
      'href',
      '/what-we-believe',
    );
  });

  it('renders production page chrome from editable page data', () => {
    const { container } = render(
      <SiteRenderer document={defaultSiteDocument} route="/who-we-are" />,
    );

    expect(container.querySelector('.site-header:not(.site-header--overlay)')).not.toBeNull();
    expect(container.querySelector('.page-hero.page-hero--image')).not.toBeNull();
    expect(container.querySelector('.page-body.shell')).not.toBeNull();
    expect(screen.getByText('About Point')).toHaveClass('eyebrow');
    expect(screen.getByRole('heading', { level: 1, name: 'Who We Are' })).toBeVisible();
    expect(screen.getByText('We are a family of disciples on mission.')).toBeVisible();
  });

  it('renders every current production route with its editable page chrome and footer', () => {
    for (const page of defaultSiteDocument.pages) {
      const { container, unmount } = render(
        <SiteRenderer document={defaultSiteDocument} route={page.route} />,
      );
      expect(container.querySelector('.site-header')).not.toBeNull();
      expect(container.querySelector('.site-footer')).not.toBeNull();
      expect(container.querySelector('#point-main')).not.toBeNull();
      expect(container.textContent).toContain(
        page.title === 'Home' ? 'Jesus-followers' : page.title,
      );
      unmount();
    }
  });

  it('renders the complete approved block registry with semantic controls', () => {
    const { container } = render(<SiteRenderer document={allBlocksDocument} route="/" />);

    expect(screen.getByRole('heading', { level: 1, name: 'Point ATX' })).toBeVisible();
    expect(screen.getByRole('heading', { level: 2, name: 'A meaningful heading' })).toBeVisible();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeVisible();
    expect(container.querySelector('script')).toBeNull();
    expect(screen.getByRole('img', { name: 'People sharing a meal' })).toHaveAttribute(
      'src',
      '/assets/neighborhood-table.jpeg',
    );
    expect(screen.getByRole('button', { name: 'Send message' })).toBeVisible();
    expect(screen.getByText('When do you meet?')).toBeVisible();
    expect(screen.getByTitle('Point Community Church location')).toHaveAttribute(
      'src',
      expect.stringMatching(/^https:\/\/www\.google\.com\/maps\?/),
    );
  });

  it('hardens external links and preserves internal navigation', () => {
    render(<SiteRenderer document={allBlocksDocument} route="/" />);

    expect(screen.getByRole('link', { name: 'External resource' })).toMatchObject({
      target: '_blank',
      rel: 'noreferrer',
    });
    expect(screen.getByRole('link', { name: 'Visit' })).not.toHaveAttribute('target');
  });

  it('submits public forms only to the configured mail client', () => {
    const { container } = render(<SiteRenderer document={allBlocksDocument} route="/" />);
    const form = container.querySelector('form');
    expect(form).toHaveAttribute('action', 'mailto:hello@pointatx.org?subject=Website%20contact');
    expect(form).toHaveAttribute('method', 'post');
    expect(form).toHaveAttribute('enctype', 'text/plain');
  });

  it('publishes accessible non-drag structure metadata for every block', () => {
    expect(Object.keys(blockDefinitions)).toHaveLength(13);
    for (const definition of Object.values(blockDefinitions)) {
      expect(definition.label.length).toBeGreaterThan(0);
      expect(definition.supportsMoveButtons).toBe(true);
    }
  });

  it('renders standardized grid settings and element placements', () => {
    const heading = allBlocksDocument.pages[0].blocks[1].items[0].element;
    const section: SectionBlock = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01',
      type: 'section',
      name: 'Test grid',
      layout: 'grid' as const,
      columns: 12 as const,
      gap: 'large' as const,
      width: 'narrow' as const,
      surface: 'primary' as const,
      padding: 'large' as const,
      items: [
        {
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb01',
          span: 6,
          align: 'end' as const,
          grid: {
            desktop: { column: 4, row: 2, columnSpan: 6, rowSpan: 3 },
          },
          element: heading,
        },
      ],
    };
    const { container } = render(<>{renderSection(section, allBlocksDocument)}</>);
    expect(
      container.querySelector(
        '.point-layout-section--narrow.point-layout-section--primary.point-layout-section--pad-large',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector('.point-layout-item--end.point-layout-item--span-6'),
    ).not.toBeNull();
    expect(container.querySelector('.point-layout-item--grid')).toHaveStyle({
      '--point-grid-desktop-column': '4',
      '--point-grid-desktop-row': '2',
      '--point-grid-desktop-column-span': '6',
      '--point-grid-desktop-row-span': '3',
    });
    expect(container.querySelector('.point-layout-section__grid')).toHaveStyle(
      '--point-section-columns: 12',
    );
  });

  it('reflects standardized element controls in rendered output', () => {
    const headingSource = allBlocksDocument.pages[0].blocks[1].items[0].element;
    const splitSource = allBlocksDocument.pages[0].blocks[4].items[0].element;
    const peopleSource = allBlocksDocument.pages[0].blocks[7].items[0].element;
    const formSource = allBlocksDocument.pages[0].blocks[9].items[0].element;
    if (headingSource.type !== 'heading') throw new Error('Expected heading fixture');
    if (splitSource.type !== 'splitFeature') throw new Error('Expected split feature fixture');
    if (peopleSource.type !== 'people') throw new Error('Expected people fixture');
    if (formSource.type !== 'form') throw new Error('Expected form fixture');
    const heading = {
      ...headingSource,
      width: 'narrow' as const,
    };
    const split = {
      ...splitSource,
      note: 'A visible note',
      calloutLabel: 'When',
      calloutValue: 'Sunday',
      action: { label: 'Details', href: '/details', style: 'primary' as const },
    };
    const people = {
      ...peopleSource,
      variant: 'leadership' as const,
      layout: 'featured' as const,
    };
    const form = {
      ...formSource,
      variant: 'standard' as const,
    };
    const { container } = render(
      <>
        {renderBlock(heading, allBlocksDocument)}
        {renderBlock(split, allBlocksDocument)}
        {renderBlock(people, allBlocksDocument)}
        {renderBlock(form, allBlocksDocument)}
      </>,
    );

    expect(container.querySelector('.point-heading--narrow')).not.toBeNull();
    expect(screen.getByText('A visible note')).toBeVisible();
    expect(screen.getByText('When')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Details' })).toHaveAttribute('href', '/details');
    expect(container.querySelector('.people-grid--featured')).not.toBeNull();
    expect(container.querySelector('.point-form-wrapper--standard')).not.toBeNull();
  });

  it('uses the selected hero surface instead of leaving a hidden image control active', () => {
    const heroSource = allBlocksDocument.pages[0].blocks[0].items[0].element;
    if (heroSource.type !== 'hero') throw new Error('Expected hero fixture');
    const hero = {
      ...heroSource,
      surface: 'canvas' as const,
    };
    const { container } = render(<>{renderBlock(hero, allBlocksDocument)}</>);

    expect(container.querySelector('.point-hero__image')).toBeNull();
    expect(container.querySelector('.point-overlay')).toBeNull();
    expect(container.querySelector('.point-surface--canvas')).not.toBeNull();
  });

  it('fails closed on an unknown block type', () => {
    expect(() =>
      renderBlock(
        { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', type: 'customHtml' } as never,
        allBlocksDocument,
      ),
    ).toThrow(/unsupported block type/i);
  });

  it('returns an explicit not-found result for an unknown route', () => {
    render(<SiteRenderer document={allBlocksDocument} route="/missing" />);
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  });
});
