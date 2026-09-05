import { render, screen } from '@testing-library/react';
import { allBlocksDocument } from '../fixtures/block-data';
import { blockDefinitions, renderBlock } from '../../src/site-kit/registry';
import { SiteRenderer } from '../../src/site-kit/SiteRenderer';

describe('controlled public renderer', () => {
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
