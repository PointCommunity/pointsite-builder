import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { BlockInspector } from '../../src/client/editor/BlockInspector';
import { defaultSiteDocument } from '../../src/site-kit/default-site';
import type { SiteElement } from '../../src/site-kit/types';
import { allBlocks } from '../fixtures/block-data';
import { upgradeNavigation } from '../../src/site-kit/migrations';

function ControlledInspector({ initial }: { initial: SiteElement }) {
  const [block, setBlock] = useState(initial);
  return <BlockInspector block={block} document={defaultSiteDocument} onChange={setBlock} />;
}

describe('BlockInspector', () => {
  it('offers optional internal and external destinations for a version-12 image', () => {
    const document = {
      ...defaultSiteDocument,
      schemaVersion: 12 as const,
      rendererVersion: '12.0.0',
    };
    const block = allBlocks.find((item) => item.type === 'image')!;
    const onChange = vi.fn();
    const { rerender } = render(
      <BlockInspector block={block} document={document} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'Link image' }));
    expect(onChange).toHaveBeenLastCalledWith({ ...block, href: '/' });
    rerender(
      <BlockInspector block={{ ...block, href: '/' }} document={document} onChange={onChange} />,
    );
    fireEvent.change(screen.getByLabelText('Internal page'), {
      target: { value: document.pages[1].route },
    });
    expect(onChange).toHaveBeenLastCalledWith({ ...block, href: document.pages[1].route });
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'external' } });
    fireEvent.change(screen.getByLabelText('External URL'), {
      target: { value: 'https://example.com/visit' },
    });
    expect(onChange).toHaveBeenLastCalledWith({ ...block, href: 'https://example.com/visit' });
    rerender(
      <BlockInspector
        block={{ ...block, href: 'https://example.com/visit' }}
        document={document}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'Link image' }));
    expect(onChange).toHaveBeenLastCalledWith(block);
  });

  it('allows a version-12 text field to be cleared and assigned H1 semantics', () => {
    const document = {
      ...defaultSiteDocument,
      schemaVersion: 12 as const,
      rendererVersion: '12.0.0',
    };
    const block = allBlocks.find((item) => item.type === 'text')!;
    const onChange = vi.fn();
    render(<BlockInspector block={block} document={document} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Text'), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith({ ...block, text: '' });
    fireEvent.change(screen.getByLabelText('Text type'), { target: { value: 'h1' } });
    expect(onChange).toHaveBeenCalledWith({ ...block, semantic: 'h1' });
  });

  it.each([
    ['hero', 'Heading', 'heading'],
    ['heading', 'Heading', 'text'],
    ['image', 'Alternative text', 'alt'],
    ['splitFeature', 'Heading', 'heading'],
    ['cta', 'Heading', 'heading'],
    ['button', 'Button label', 'label'],
    ['navigation', 'Navigation label', 'label'],
    ['map', 'Title', 'title'],
  ] as const)('clears %s Properties text without a minimum character', (type, label, key) => {
    const document = {
      ...defaultSiteDocument,
      schemaVersion: 12 as const,
      rendererVersion: '12.0.0',
    };
    const block = allBlocks.find((item) => item.type === type)!;
    const onChange = vi.fn();
    render(<BlockInspector block={block} document={document} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText(label), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith({ ...block, [key]: '' });
  });

  it('clears individual card title and body text without removing the card', () => {
    const document = {
      ...defaultSiteDocument,
      schemaVersion: 12 as const,
      rendererVersion: '12.0.0',
    };
    const block = allBlocks.find((item) => item.type === 'cards')!;
    const onChange = vi.fn();
    render(<BlockInspector block={block} document={document} onChange={onChange} />);
    fireEvent.change(screen.getAllByLabelText('Title')[0], { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith({
      ...block,
      items: block.items.map((item, index) => (index ? item : { ...item, title: '' })),
    });
    fireEvent.change(screen.getAllByLabelText('Body')[0], { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith({
      ...block,
      items: block.items.map((item, index) => (index ? item : { ...item, body: '' })),
    });
  });

  it('clears FAQ, social, and rich-text copy in version 12', () => {
    const document = {
      ...defaultSiteDocument,
      schemaVersion: 12 as const,
      rendererVersion: '12.0.0',
    };
    for (const [type, label, field] of [
      ['faq', 'Question', 'question'],
      ['socialLinks', 'Link label', 'label'],
      ['richText', 'Paragraph', 'text'],
    ] as const) {
      const block: SiteElement =
        type === 'socialLinks'
          ? {
              id: crypto.randomUUID(),
              type,
              links: [{ platform: 'other', label: 'Website', url: 'https://example.com' }],
              align: 'left',
              appearance: 'labels',
            }
          : allBlocks.find((item) => item.type === type)!;
      const onChange = vi.fn();
      const { unmount } = render(
        <BlockInspector block={block} document={document} onChange={onChange} />,
      );
      fireEvent.change(screen.getAllByLabelText(label)[0], { target: { value: '' } });
      if (block.type === 'richText')
        expect(onChange).toHaveBeenCalledWith({
          ...block,
          content: block.content.map((item, index) =>
            index ? item : { type: 'paragraph', children: [{ text: '' }] },
          ),
        });
      else if (block.type === 'faq')
        expect(onChange).toHaveBeenCalledWith({
          ...block,
          items: block.items.map((item, index) => (index ? item : { ...item, [field]: '' })),
        });
      else if (block.type === 'socialLinks')
        expect(onChange).toHaveBeenCalledWith({
          ...block,
          links: block.links.map((item, index) => (index ? item : { ...item, [field]: '' })),
        });
      unmount();
    }
  });

  it('sets fit independently for each card image in version 12', () => {
    const document = {
      ...defaultSiteDocument,
      schemaVersion: 12 as const,
      rendererVersion: '12.0.0',
    };
    const block = allBlocks.find((item) => item.type === 'cards')!;
    const onChange = vi.fn();
    const { rerender } = render(
      <BlockInspector block={block} document={document} onChange={onChange} />,
    );
    fireEvent.change(screen.getAllByLabelText('Image fit')[0], { target: { value: 'stretch' } });
    expect(onChange).toHaveBeenCalledWith({
      ...block,
      items: block.items.map((item, index) =>
        index === 0 ? { ...item, mediaFit: 'stretch' } : item,
      ),
    });
    fireEvent.change(screen.getAllByLabelText('Image frame')[0], { target: { value: 'square' } });
    expect(onChange).toHaveBeenCalledWith({
      ...block,
      items: block.items.map((item, index) =>
        index === 0 ? { ...item, mediaFrame: 'square' } : item,
      ),
    });
    const withImage = {
      ...block,
      items: block.items.map((item, index) =>
        index ? item : { ...item, mediaId: document.media[0].id },
      ),
    };
    rerender(<BlockInspector block={withImage} document={document} onChange={onChange} />);
    fireEvent.change(screen.getAllByLabelText('Horizontal focus (%)')[0], {
      target: { value: '25' },
    });
    expect(onChange).toHaveBeenCalledWith({
      ...withImage,
      items: withImage.items.map((item, index) =>
        index === 0 ? { ...item, mediaFocal: { x: 25, y: 50 } } : item,
      ),
    });
  });
  it('selects a named design and routes edits to its stable identity in Navigation Designer', () => {
    const document = upgradeNavigation(defaultSiteDocument);
    const first = document.navigationDesigns![0];
    const second = { ...structuredClone(first), id: crypto.randomUUID(), name: 'Secondary' };
    second.items = [{ id: crypto.randomUUID(), label: 'Secondary link', href: '/', children: [] }];
    document.navigationDesigns!.push(second);
    const block = document.pages[0].blocks[0].items.find(
      (item) => item.element.type === 'navigation',
    )!.element;
    const onChange = vi.fn();
    const onEditNavigation = vi.fn();
    const { rerender } = render(
      <BlockInspector
        block={block}
        document={document}
        onChange={onChange}
        onEditNavigation={onEditNavigation}
      />,
    );
    fireEvent.change(screen.getByLabelText('Navigation design'), { target: { value: second.id } });
    expect(onChange).toHaveBeenCalledWith({ ...block, navigationDesignId: second.id });
    rerender(
      <BlockInspector
        block={{ ...block, navigationDesignId: second.id } as typeof block}
        document={document}
        onChange={onChange}
        onEditNavigation={onEditNavigation}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit in Navigation Designer' }));
    expect(onEditNavigation).toHaveBeenCalledWith(second.id);
    expect(screen.queryByRole('group', { name: 'About' })).not.toBeInTheDocument();
  });
  it('offers all People styles while keeping legacy leadership selections', () => {
    const initial = allBlocks.find((block) => block.type === 'people')!;
    render(<ControlledInspector initial={{ ...initial, variant: 'leadership' }} />);
    const style = screen.getByLabelText('Layout style');
    expect(style).toHaveValue('leadership');
    for (const name of ['Standard People', 'Vertical Grid', 'Horizontal Grid']) {
      expect(screen.getByRole('option', { name })).toBeInTheDocument();
    }
    const selected = screen
      .getAllByRole('checkbox')
      .map((input) => (input as HTMLInputElement).checked);
    fireEvent.change(style, { target: { value: 'horizontal' } });
    expect(style).toHaveValue('horizontal');
    expect(screen.getByText(/16:9 landscape frames/)).toBeVisible();
    expect(
      screen.getAllByRole('checkbox').map((input) => (input as HTMLInputElement).checked),
    ).toEqual(selected);
    fireEvent.change(style, { target: { value: 'standard' } });
    expect(screen.getByText(/Whole photos fit without cropping/)).toBeVisible();
  });
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

  it('keeps placement-specific presentation separate from shared menu editing', () => {
    const navigation = allBlocks.find((item) => item.type === 'navigation')!;
    const onEditNavigation = vi.fn();
    render(
      <BlockInspector
        block={navigation}
        document={defaultSiteDocument}
        onChange={vi.fn()}
        onEditNavigation={onEditNavigation}
      />,
    );

    expect(screen.getByLabelText('Navigation label')).toBeInTheDocument();
    expect(screen.getByLabelText('Navigation alignment')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'About' })).not.toBeInTheDocument();
  });

  it('offers complete horizontal and vertical alignment for Split View text', () => {
    const split = allBlocks.find((item) => item.type === 'splitFeature')!;
    const onChange = vi.fn();
    render(<BlockInspector block={split} document={defaultSiteDocument} onChange={onChange} />);

    expect(
      within(screen.getByLabelText('Horizontal alignment')).getByRole('option', { name: 'Right' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Bottom' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Horizontal alignment'), {
      target: { value: 'right' },
    });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ textAlign: 'right' }));
    fireEvent.change(screen.getByLabelText('Vertical alignment'), { target: { value: 'end' } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ align: 'end' }));
  });

  it('offers the Point page hero style on the existing Hero element', () => {
    const hero = allBlocks.find((item) => item.type === 'hero')!;
    render(<BlockInspector block={hero} document={defaultSiteDocument} onChange={vi.fn()} />);

    expect(screen.getByRole('option', { name: 'Point page hero' })).toBeInTheDocument();
  });

  it('hides Point-only choices in version 12 while displaying an existing legacy selection', () => {
    const document = {
      ...defaultSiteDocument,
      schemaVersion: 12 as const,
      rendererVersion: '12.0.0',
    };
    const hero = allBlocks.find((item) => item.type === 'hero')!;
    const { rerender } = render(
      <BlockInspector block={hero} document={document} onChange={vi.fn()} />,
    );
    expect(
      within(screen.getByLabelText('Layout style'))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Standard hero']);
    rerender(
      <BlockInspector
        block={{ ...hero, variant: 'pageHero' }}
        document={document}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('Layout style')).toHaveValue('pageHero');
    expect(screen.getByRole('option', { name: 'Legacy: page hero' })).toBeDisabled();
  });

  it('uses page-aware destinations for action and standalone button links', () => {
    const actionBlock = allBlocks.find((item) => item.type === 'cta')!;
    const { rerender } = render(
      <BlockInspector block={actionBlock} document={defaultSiteDocument} onChange={vi.fn()} />,
    );
    const actionLink = screen.getByRole('group', { name: 'Button link' });
    fireEvent.change(within(actionLink).getByLabelText('Type'), { target: { value: 'internal' } });
    expect(
      within(actionLink).getByRole('option', { name: 'Contact Us — /contact' }),
    ).toBeInTheDocument();

    const buttonBlock = allBlocks.find((item) => item.type === 'button')!;
    rerender(
      <BlockInspector block={buttonBlock} document={defaultSiteDocument} onChange={vi.fn()} />,
    );
    expect(screen.getByRole('group', { name: 'Button link' })).toBeInTheDocument();
    expect(screen.getByLabelText('Internal page')).toHaveValue('/contact');
  });

  it.each([
    ['FAQ question', allBlocks.find((item) => item.type === 'faq')!, 'Question'],
    ['card title', allBlocks.find((item) => item.type === 'cards')!, 'Title'],
    [
      'hero button link',
      {
        ...allBlocks.find((item) => item.type === 'hero')!,
        type: 'hero' as const,
        actions: [{ label: 'Learn more', href: 'https://example.com', style: 'primary' as const }],
      },
      'External URL',
    ],
    [
      'heading button link',
      {
        ...allBlocks.find((item) => item.type === 'heading')!,
        type: 'heading' as const,
        actions: [{ label: 'Learn more', href: 'https://example.com', style: 'primary' as const }],
      },
      'External URL',
    ],
  ])('retains focus while typing in the repeated %s editor', (_name, block, label) => {
    const { unmount } = render(<ControlledInspector initial={block} />);
    const control = screen.getAllByLabelText(label)[0] as HTMLInputElement;
    control.focus();
    fireEvent.change(control, { target: { value: `${control.value}x` } });
    expect(document.activeElement).toBe(control);
    unmount();
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
      ).filter(
        (control) =>
          !(control as HTMLInputElement).disabled &&
          !(control as HTMLElement).hasAttribute('data-local-control'),
      );
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
