import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LinkDestinationField } from '../../src/client/editor/LinkDestinationField';
import { defaultSiteDocument } from '../../src/site-kit/default-site';

const pages = defaultSiteDocument.pages.map(({ title, route }) => ({ title, route }));

describe('LinkDestinationField', () => {
  it('selects an internal destination from the current page catalog', () => {
    const onChange = vi.fn();
    render(<LinkDestinationField label="Link" value="/give" pages={pages} onChange={onChange} />);

    expect(screen.getByLabelText('Type')).toHaveValue('internal');
    expect(screen.getByRole('option', { name: 'Contact Us — /contact' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Internal page'), { target: { value: '/contact' } });

    expect(onChange).toHaveBeenCalledWith('/contact');
  });

  it('accepts explicit HTTP and HTTPS external URLs', () => {
    const onChange = vi.fn();
    render(
      <LinkDestinationField
        label="Button link"
        value="https://example.com/start"
        pages={pages}
        onChange={onChange}
      />,
    );

    const input = screen.getByLabelText('External URL');
    expect(screen.getByLabelText('Type')).toHaveValue('external');
    fireEvent.change(input, { target: { value: 'http://legacy.example.com/page' } });
    expect(onChange).toHaveBeenLastCalledWith('http://legacy.example.com/page');
    fireEvent.change(input, { target: { value: 'https://secure.example.com/page' } });
    expect(onChange).toHaveBeenLastCalledWith('https://secure.example.com/page');
  });

  it('keeps an invalid external draft out of the saved document', () => {
    const onChange = vi.fn();
    render(<LinkDestinationField label="Link" value="/" pages={pages} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'external' } });
    const input = screen.getByLabelText('External URL');
    fireEvent.change(input, { target: { value: 'example.com/page' } });

    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(/must begin with http:\/\/ or https:\/\//i)).toBeVisible();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('preserves an older internal path until the author chooses a current page', () => {
    render(
      <LinkDestinationField label="Link" value="/legacy-page" pages={pages} onChange={vi.fn()} />,
    );

    expect(screen.getByRole('option', { name: 'Current path — /legacy-page' })).toBeInTheDocument();
    expect(screen.getByLabelText('Internal page')).toHaveValue('/legacy-page');
  });
});
