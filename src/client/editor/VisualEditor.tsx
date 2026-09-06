import { Puck, type ComponentData, type Config, type Data } from '@puckeditor/core';
import '@puckeditor/core/puck.css';
import type { CSSProperties, ReactNode, Ref } from 'react';
import { blockDefinitions, renderBlock } from '../../site-kit/registry';
import { SiteElementSchema } from '../../site-kit/schema';
import type { SectionBlock, SiteElement } from '../../site-kit/types';
import { SiteFrame } from '../../site-kit/SiteRenderer';
import siteCss from '../../site-kit/site.css?inline';
import { BlockInspector } from './BlockInspector';
import { SectionInspector, type SectionSettings } from './SectionInspector';
import { useEditor } from './EditorProvider';

type ElementProps = {
  block: SiteElement;
  span: number;
  align: SectionBlock['items'][number]['align'];
};
type SectionProps = {
  settings: SectionSettings;
  content: (props?: Record<string, unknown>) => ReactNode;
};
type ComposerProps = Record<SiteElement['type'], ElementProps> &
  Record<'Section' | 'TwoColumnSection' | 'ThreeColumnSection' | 'FullWidthSection', SectionProps>;

const sectionTypes = [
  'Section',
  'TwoColumnSection',
  'ThreeColumnSection',
  'FullWidthSection',
] as const;
const elementTypes = Object.keys(blockDefinitions) as SiteElement['type'][];
const gapValues = { none: '0px', small: '0.75rem', medium: '1.5rem', large: '3rem' };

function defaultElement(
  type: SiteElement['type'],
  document: ReturnType<typeof useEditor>['document'],
): SiteElement {
  const id = crypto.randomUUID();
  const mediaId = document.media[0]?.id ?? crypto.randomUUID();
  const formId = document.forms[0]?.id ?? crypto.randomUUID();
  const personId = document.collections.people[0]?.id ?? crypto.randomUUID();
  const defaults: Record<SiteElement['type'], SiteElement> = {
    hero: {
      id,
      type: 'hero',
      heading: 'Welcome to Point',
      body: 'Add a short welcome.',
      align: 'left',
      surface: 'primary',
      actions: [],
    },
    heading: {
      id,
      type: 'heading',
      text: 'Section heading',
      level: 2,
      align: 'left',
      width: 'wide',
    },
    richText: {
      id,
      type: 'richText',
      content: [{ type: 'paragraph', children: [{ text: 'Add your text here.' }] }],
    },
    image: {
      id,
      type: 'image',
      mediaId,
      alt: 'Describe this image',
      aspect: 'natural',
      fit: 'cover',
    },
    splitFeature: {
      id,
      type: 'splitFeature',
      heading: 'Feature heading',
      body: 'Describe this feature.',
      mediaId,
      mediaAlt: 'Describe this image',
      mediaSide: 'left',
      proportion: 'half',
      align: 'center',
      surface: 'canvas',
    },
    cta: {
      id,
      type: 'cta',
      heading: 'Take the next step',
      action: { label: 'Learn more', href: '/', style: 'primary' },
      surface: 'surface',
    },
    cards: {
      id,
      type: 'cards',
      columns: 3,
      items: [{ title: 'Card title', body: 'Card description.' }],
    },
    people: { id, type: 'people', personIds: [personId], layout: 'grid' },
    faq: { id, type: 'faq', items: [{ question: 'Question', answer: 'Answer' }] },
    form: { id, type: 'form', formId },
    map: { id, type: 'map', query: 'Austin, Texas', title: 'Find us' },
    divider: { id, type: 'divider', style: 'line' },
    spacer: { id, type: 'spacer', size: 'medium' },
  };
  return defaults[type];
}

function sectionDefaults(kind: (typeof sectionTypes)[number]): SectionSettings {
  if (kind === 'TwoColumnSection')
    return {
      name: 'Two column section',
      layout: 'grid',
      columns: 2,
      gap: 'medium',
      width: 'shell',
      surface: 'transparent',
      padding: 'medium',
    };
  if (kind === 'ThreeColumnSection')
    return {
      name: 'Three column section',
      layout: 'grid',
      columns: 3,
      gap: 'medium',
      width: 'shell',
      surface: 'transparent',
      padding: 'medium',
    };
  if (kind === 'FullWidthSection')
    return {
      name: 'Full width section',
      layout: 'flow',
      columns: 1,
      gap: 'medium',
      width: 'full',
      surface: 'canvas',
      padding: 'medium',
    };
  return {
    name: 'Blank section',
    layout: 'flow',
    columns: 1,
    gap: 'medium',
    width: 'shell',
    surface: 'transparent',
    padding: 'medium',
  };
}

function renderSectionComponent({ settings, content: Content }: SectionProps) {
  if (settings.layout === 'compatibility')
    return <Content className="point-compatibility-slot" minEmptyHeight={48} />;
  const style = {
    '--point-section-columns': settings.layout === 'flow' ? 1 : settings.columns,
    '--point-section-gap': gapValues[settings.gap],
  } as CSSProperties;
  return (
    <section
      className={`point-layout-section point-layout-section--${settings.width} point-layout-section--${settings.surface} point-layout-section--pad-${settings.padding}`}
      aria-label={settings.name}
    >
      <Content className="point-layout-section__grid" style={style} minEmptyHeight={96} />
    </section>
  );
}

function sectionToData(section: SectionBlock): ComponentData {
  return {
    type: 'Section',
    props: {
      id: section.id,
      settings: {
        name: section.name,
        layout: section.layout,
        columns: section.columns,
        gap: section.gap,
        width: section.width,
        surface: section.surface,
        padding: section.padding,
      },
      content: section.items.map((placement) => ({
        type: placement.element.type,
        props: {
          id: placement.id,
          block: placement.element,
          span: placement.span,
          align: placement.align,
        },
      })),
    },
  };
}

function dataToSection(item: ComponentData): SectionBlock {
  const settings = item.props.settings as SectionSettings;
  const content = (item.props.content ?? []) as ComponentData[];
  return {
    id: String(item.props.id),
    type: 'section',
    ...settings,
    items: content.map((child) => ({
      id: String(child.props.id),
      span: Number(child.props.span ?? 12),
      align: (child.props.align ?? 'stretch') as SectionBlock['items'][number]['align'],
      element: SiteElementSchema.parse(child.props.block),
    })),
  };
}

function rootElementToSection(item: ComponentData): SectionBlock {
  return {
    id: crypto.randomUUID(),
    type: 'section',
    ...sectionDefaults('Section'),
    items: [
      {
        id: String(item.props.id || crypto.randomUUID()),
        span: Number(item.props.span ?? 12),
        align: (item.props.align ?? 'stretch') as SectionBlock['items'][number]['align'],
        element: SiteElementSchema.parse(item.props.block),
      },
    ],
  };
}

export function VisualEditor({ pageId }: { pageId: string }) {
  const { document, updateDocument } = useEditor();
  const page = document.pages.find((candidate) => candidate.id === pageId);
  if (!page) return <p>Choose a page to edit.</p>;

  const components: Record<string, unknown> = {};
  for (const kind of sectionTypes) {
    components[kind] = {
      label:
        kind === 'Section'
          ? 'Blank section'
          : kind
              .replace(/([A-Z])/g, ' $1')
              .replace(' Section', '')
              .trim(),
      fields: {
        settings: {
          type: 'custom',
          label: 'Section settings',
          render: ({
            value,
            onChange,
          }: {
            value: SectionSettings;
            onChange: (value: SectionSettings) => void;
          }) => <SectionInspector settings={value} onChange={onChange} />,
        },
        content: { type: 'slot', allow: elementTypes },
      },
      defaultProps: { settings: sectionDefaults(kind), content: [] },
      render: renderSectionComponent,
    };
  }
  for (const type of elementTypes) {
    const fields = {
      block: {
        type: 'custom',
        label: 'Content and style',
        render: ({
          value,
          onChange,
        }: {
          value: SiteElement;
          onChange: (value: SiteElement) => void;
        }) => <BlockInspector block={value} document={document} onChange={onChange} />,
      },
      span: {
        type: 'select',
        label: 'Desktop width',
        options: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((value) => ({
          label: value === 12 ? 'Full width' : `${value} of 12 columns`,
          value,
        })),
      },
      align: {
        type: 'select',
        label: 'Vertical alignment',
        options: ['start', 'center', 'end', 'stretch'].map((value) => ({
          label: value[0].toUpperCase() + value.slice(1),
          value,
        })),
      },
    };
    components[type] = {
      label: blockDefinitions[type].label,
      inline: true,
      fields,
      resolveFields: (_data: unknown, { parent }: { parent: ComponentData | null }) => {
        const parentProps = parent
          ? (parent.props as unknown as Record<string, unknown>)
          : undefined;
        const parentSettings = parentProps?.settings as Partial<SectionSettings> | undefined;
        if (parentSettings?.layout === 'compatibility') return { block: fields.block };
        if (parentSettings?.layout === 'flow') {
          return { block: fields.block, align: fields.align };
        }
        return fields;
      },
      defaultProps: { block: defaultElement(type, document), span: 12, align: 'stretch' },
      resolveData: (data: { props: ElementProps }, { trigger }: { trigger: string }) =>
        trigger === 'insert'
          ? { props: { ...data.props, block: { ...data.props.block, id: crypto.randomUUID() } } }
          : data,
      render: ({
        block,
        span,
        align,
        puck,
      }: ElementProps & { puck: { dragRef: Ref<HTMLDivElement> } }) => {
        const parsed = SiteElementSchema.safeParse(block);
        return (
          <div
            ref={puck.dragRef}
            className={`point-layout-item point-layout-item--${align} point-layout-item--span-${Number(span)}`}
          >
            {parsed.success ? renderBlock(parsed.data, document) : <p>Configure this element.</p>}
          </div>
        );
      },
    };
  }

  const config = {
    categories: {
      sections: { title: 'Sections', components: [...sectionTypes] },
      content: { title: 'Text & actions', components: ['heading', 'richText', 'hero', 'cta'] },
      media: { title: 'Media', components: ['image', 'splitFeature'] },
      collections: { title: 'Collections', components: ['cards', 'people'] },
      engagement: { title: 'Engagement', components: ['faq', 'form', 'map'] },
      spacing: { title: 'Spacing', components: ['divider', 'spacer'] },
      other: { visible: false },
    },
    components,
    root: {
      render: ({ children }: { children: ReactNode }) => (
        <>
          <style>{siteCss}</style>
          <SiteFrame document={document} page={page} editing>
            {children}
          </SiteFrame>
        </>
      ),
    },
  } as unknown as Config<ComposerProps>;
  const data: Data = { content: page.blocks.map(sectionToData), root: { props: {} } };

  return (
    <div className="visual-editor" aria-label={`Visual canvas for ${page.title}`}>
      <Puck
        key={page.id}
        config={config}
        data={data}
        dnd={{ behavior: 'auto' }}
        onChange={(next) => {
          const sections = next.content.map((item) =>
            sectionTypes.includes(item.type as (typeof sectionTypes)[number])
              ? dataToSection(item)
              : rootElementToSection(item),
          );
          updateDocument((draft) => {
            const target = draft.pages.find((candidate) => candidate.id === pageId);
            if (target) target.blocks = sections;
            return draft;
          });
        }}
        onPublish={() => undefined}
        headerTitle={page.title}
        iframe={{ enabled: true, waitForStyles: false, syncHostStyles: false }}
      />
    </div>
  );
}
