import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BlockInspector } from '../../src/client/editor/BlockInspector';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import { allBlocks } from '../fixtures/block-data';

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

  it.each([
    ['hero', 'Layout style', 'homeHero', 'variant'],
    ['heading', 'Layout style', 'homeIntro', 'variant'],
    ['richText', 'Layout style', 'prose', 'variant'],
    ['image', 'Layout style', 'wide', 'variant'],
    ['splitFeature', 'Layout style', 'imageSplit', 'variant'],
    ['cta', 'Layout style', 'rental', 'variant'],
    ['cards', 'Layout style', 'identity', 'variant'],
    ['people', 'Layout style', 'leadership', 'variant'],
    ['faq', 'Layout style', 'groups', 'variant'],
    ['form', 'Layout style', 'panel', 'variant'],
    ['map', 'Layout style', 'gathering', 'variant'],
    ['divider', 'Divider style', 'space', 'style'],
    ['spacer', 'Space size', 'small', 'size'],
  ] as const)(
    'edits the %s module through its primary presentation control',
    (type, label, value, property) => {
      const block = allBlocks.find((item) => item.type === type)!;
      const onChange = vi.fn();
      const { unmount } = render(
        <BlockInspector block={block} document={defaultSiteDocument} onChange={onChange} />,
      );
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ [property]: value }));
      unmount();
    },
  );
});
