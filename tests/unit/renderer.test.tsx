import { render, screen } from '@testing-library/react';
import { allBlocksDocument } from '../fixtures/block-data';
import { blockDefinitions, renderBlock } from '../../src/site-kit/registry';
import { SiteRenderer } from '../../src/site-kit/SiteRenderer';
import { defaultSiteDocument } from '../../src/site-kit/default-site';

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
