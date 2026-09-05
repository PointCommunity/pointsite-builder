import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BlockInspector } from '../../src/client/editor/BlockInspector';
import { defaultSiteDocument } from '../../src/site-kit/default-site';

describe('BlockInspector', () => {
  it('edits a hero through human-readable fields', () => {
    const document = structuredClone(defaultSiteDocument);
    const block = document.pages[0].blocks.find((item) => item.type === 'hero')!;
    const onChange = vi.fn();
    render(<BlockInspector block={block} document={document} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Heading'), { target: { value: 'A clearer welcome' } });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ heading: 'A clearer welcome' }),
    );
    expect(screen.queryByLabelText(/json/i)).not.toBeInTheDocument();
  });

  it('adds a FAQ item without drag and drop', () => {
    const document = structuredClone(defaultSiteDocument);
    const block = document.pages
      .flatMap((page) => page.blocks)
      .find((item) => item.type === 'faq')!;
    const onChange = vi.fn();
    render(<BlockInspector block={block} document={document} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add question' }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [...block.items, { question: 'New question', answer: 'Add an answer.' }],
      }),
    );
  });
});
