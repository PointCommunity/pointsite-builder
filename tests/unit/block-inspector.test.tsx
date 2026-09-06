import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BlockInspector } from '../../src/client/editor/BlockInspector';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import { allBlocks } from '../fixtures/block-data';

describe('BlockInspector', () => {
  it('edits a hero through human-readable fields', () => {
    const document = structuredClone(defaultSiteDocument);
    const block = document.pages[0].blocks
      .flatMap((section) => section.items.map((item) => item.element))
      .find((item) => item.type === 'hero')!;
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
      .flatMap((page) =>
        page.blocks.flatMap((section) => section.items.map((item) => item.element)),
      )
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

  it('hides controls that do not apply to fixed editorial presets', () => {
    const photoBanner = {
      ...allBlocks.find((item) => item.type === 'splitFeature')!,
      type: 'splitFeature' as const,
      variant: 'photoBanner' as const,
    };
    const { rerender } = render(
      <BlockInspector block={photoBanner} document={defaultSiteDocument} onChange={vi.fn()} />,
    );
    expect(screen.queryByLabelText('Image side')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Proportion')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Background')).not.toBeInTheDocument();

    const beliefs = {
      ...allBlocks.find((item) => item.type === 'cards')!,
      type: 'cards' as const,
      variant: 'beliefs' as const,
    };
    rerender(<BlockInspector block={beliefs} document={defaultSiteDocument} onChange={vi.fn()} />);
    expect(screen.queryByLabelText('Columns')).not.toBeInTheDocument();

    const splitEditorial = {
      ...allBlocks.find((item) => item.type === 'cards')!,
      type: 'cards' as const,
      variant: 'splitEditorial' as const,
    };
    rerender(
      <BlockInspector block={splitEditorial} document={defaultSiteDocument} onChange={vi.fn()} />,
    );
    expect(screen.getAllByLabelText('Eyebrow')).toHaveLength(splitEditorial.items.length);
    expect(screen.queryByLabelText('Section heading')).not.toBeInTheDocument();
  });

  it.each(allBlocks.map((block) => [block.type, block] as const))(
    'wires every enabled %s inspector control to a document change',
    (_type, block) => {
      const onChange = vi.fn();
      const { container } = render(
        <BlockInspector block={block} document={defaultSiteDocument} onChange={onChange} />,
      );
      const controls = Array.from(
        container.querySelectorAll('input, select, textarea, button'),
      ).filter((control) => !(control as HTMLInputElement).disabled);
      expect(controls.length).toBeGreaterThan(0);

      for (const control of controls) {
        const before = onChange.mock.calls.length;
        if (control.tagName === 'BUTTON') {
          fireEvent.click(control);
        } else if (control.tagName === 'SELECT') {
          const select = control as unknown as HTMLSelectElement;
          const next = Array.from(select.options).find((option) => option.value !== select.value);
          fireEvent.change(select, { target: { value: next?.value ?? select.value } });
        } else if (
          (control as unknown as HTMLInputElement).type === 'checkbox' ||
          (control as unknown as HTMLInputElement).type === 'radio'
        ) {
          fireEvent.click(control);
        } else {
          const field = control as unknown as HTMLInputElement | HTMLTextAreaElement;
          fireEvent.change(field, { target: { value: `${field.value || 'Value'} updated` } });
        }
        expect(onChange.mock.calls.length).toBeGreaterThan(before);
      }
    },
  );
});
