import { Puck, type ComponentData, type Config, type Data, type Viewports } from '@puckeditor/core';
import '@puckeditor/core/puck.css';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from 'react';
import { blockDefinitions, renderBlock } from '../../site-kit/registry';
import { SiteElementSchema } from '../../site-kit/schema';
import { defaultRowSpan, GRID_COLUMNS, nextGridArea } from '../../site-kit/grid-layout';
import type { SectionBlock, SiteElement } from '../../site-kit/types';
import { SiteFrame } from '../../site-kit/SiteRenderer';
import siteCss from '../../site-kit/site.css?inline';
import { BlockInspector } from './BlockInspector';
import { GridOverlay } from './GridOverlay';
import { setGridBreakpoint } from './GridBreakpointContext';
import { breakpointForWidth } from './grid-breakpoint';
import { GridPlacementInspector } from './GridPlacementInspector';
import { SectionInspector, type SectionSettings } from './SectionInspector';
import { useEditor } from './EditorProvider';
import { usePointPuck } from './puck-store';
import { useGridInteraction } from './grid-interaction-store';

type ElementProps = {
  block: SiteElement;
  span: number;
  align: SectionBlock['items'][number]['align'];
  grid: SectionBlock['items'][number]['grid'];
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
const sectionLabels: Record<(typeof sectionTypes)[number], string> = {
  Section: 'Blank grid section',
  TwoColumnSection: 'Two columns (50 / 50)',
  ThreeColumnSection: 'Three columns (equal)',
  FullWidthSection: 'Full-width section',
};
const elementTypes = Object.keys(blockDefinitions) as SiteElement['type'][];
const gapValues = { none: '0px', small: '0.75rem', medium: '1.5rem', large: '3rem' };
const totalGapValues = { none: '0px', small: '8.25rem', medium: '16.5rem', large: '33rem' };
const editorViewports: Viewports = [
  { width: 360, height: 'auto', label: 'Phone', icon: 'Smartphone' },
  { width: 768, height: 'auto', label: 'Tablet', icon: 'Tablet' },
  { width: 1280, height: 'auto', label: 'Desktop', icon: 'Monitor' },
];
const editorDnd = { behavior: 'auto' as const };
const editorIframe = { enabled: true, waitForStyles: false, syncHostStyles: false };
const editorOverrides = { componentOverlay: GridOverlay };

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
      columns: 12,
      gap: 'medium',
      width: 'shell',
      surface: 'transparent',
      padding: 'medium',
    };
  if (kind === 'ThreeColumnSection')
    return {
      name: 'Three column section',
      layout: 'grid',
      columns: 12,
      gap: 'medium',
      width: 'shell',
      surface: 'transparent',
      padding: 'medium',
    };
  if (kind === 'FullWidthSection')
    return {
      name: 'Full width section',
      layout: 'grid',
      columns: 12,
      gap: 'medium',
      width: 'full',
      surface: 'canvas',
      padding: 'medium',
    };
  return {
    name: 'Blank section',
    layout: 'grid',
    columns: 12,
    gap: 'medium',
    width: 'shell',
    surface: 'transparent',
    padding: 'medium',
  };
}

function SectionComponent({ id, settings, content: Content }: SectionProps & { id?: string }) {
  const isDragging = usePointPuck((state) => state.appState.ui.isDragging);
  const isGridInteracting = useGridInteraction(id);
  const gridRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const element = gridRef.current;
    if (!element || settings.layout !== 'grid') return;
    const measure = () => {
      const gap = Number.parseFloat(getComputedStyle(element).columnGap) || 0;
      const cell = Math.max(24, (element.clientWidth - gap * (GRID_COLUMNS - 1)) / GRID_COLUMNS);
      element.style.setProperty('--point-grid-cell', `${cell}px`);
    };
    measure();
    const ResizeObserverClass = element.ownerDocument.defaultView?.ResizeObserver;
    if (!ResizeObserverClass) return;
    const observer = new ResizeObserverClass(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [settings.gap, settings.layout]);
  if (settings.layout === 'compatibility')
    return <Content className="point-compatibility-slot" minEmptyHeight={48} />;
  const style = {
    '--point-section-columns': settings.layout === 'flow' ? 1 : GRID_COLUMNS,
    '--point-section-gap': gapValues[settings.gap],
    '--point-section-total-gap': totalGapValues[settings.gap],
  } as CSSProperties;
  return (
    <section
      className={`point-layout-section point-layout-section--${settings.layout} point-layout-section--${settings.width} point-layout-section--${settings.surface} point-layout-section--pad-${settings.padding}`}
      aria-label={settings.name}
    >
      <Content
        ref={gridRef}
        className={`point-layout-section__grid${isDragging || isGridInteracting ? ' point-layout-section__grid--active' : ''}`}
        style={style}
        minEmptyHeight={96}
      />
    </section>
  );
}

function CanvasBreakpointReporter() {
  const width = usePointPuck((state) => state.appState.ui.viewports.current.width);
  useEffect(() => {
    if (typeof width === 'number') setGridBreakpoint(breakpointForWidth(width));
  }, [width]);
  return null;
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
          span:
            section.layout === 'grid' ? Math.min(placement.span, section.columns) : placement.span,
          align: placement.align,
          grid: placement.grid,
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
      span: Number(
        (child.props.grid as SectionBlock['items'][number]['grid'])?.desktop.columnSpan ??
          child.props.span ??
          12,
      ),
      align: (child.props.align ?? 'stretch') as SectionBlock['items'][number]['align'],
      grid: child.props.grid as SectionBlock['items'][number]['grid'],
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
        grid: (item.props.grid as SectionBlock['items'][number]['grid']) ?? {
          desktop: { column: 1, row: 1, columnSpan: 12, rowSpan: 4 },
        },
        element: SiteElementSchema.parse(item.props.block),
      },
    ],
  };
}

export function VisualEditor({
  pageId,
  structureRevision,
  onEditFooter,
}: {
  pageId: string;
  structureRevision: number;
  onEditFooter: () => void;
}) {
  const { document, updateDocument } = useEditor();
  const page = document.pages.find((candidate) => candidate.id === pageId);
  if (!page) return <p>Choose a page to edit.</p>;

  const components: Record<string, unknown> = {};
  for (const kind of sectionTypes) {
    components[kind] = {
      label: sectionLabels[kind],
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
      render: SectionComponent,
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
      grid: {
        type: 'custom',
        label: 'Grid position',
        render: ({
          value,
          onChange,
        }: {
          value: SectionBlock['items'][number]['grid'];
          onChange: (value: SectionBlock['items'][number]['grid']) => void;
        }) => <GridPlacementInspector value={value} onChange={onChange} />,
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
        return {
          block: fields.block,
          grid: fields.grid,
          align: fields.align,
        };
      },
      defaultProps: {
        block: defaultElement(type, document),
        span: 12,
        align: 'stretch',
        grid: {
          desktop: { column: 1, row: 1, columnSpan: 12, rowSpan: defaultRowSpan(type) },
        },
      },
      resolveData: (
        data: { props: ElementProps },
        { trigger, parent }: { trigger: string; parent: ComponentData | null },
      ) => {
        if (trigger !== 'insert') return data;
        const parentSettings = parent?.props.settings as Partial<SectionSettings> | undefined;
        const parentItems = ((parent?.props.content ?? []) as ComponentData[])
          .filter((item) => item.props.id !== (data.props as ElementProps & { id?: string }).id)
          .map((item) => ({
            grid: item.props.grid as SectionBlock['items'][number]['grid'],
          }));
        const defaultSpan =
          parent?.type === 'TwoColumnSection' ? 6 : parent?.type === 'ThreeColumnSection' ? 4 : 12;
        const grid = {
          desktop: nextGridArea(parentItems, defaultSpan, defaultRowSpan(type)),
        };
        return {
          props: {
            ...data.props,
            block: { ...data.props.block, id: crypto.randomUUID() },
            span: parentSettings?.layout === 'grid' ? defaultSpan : 12,
            grid,
          },
        };
      },
      render: ({
        block,
        align,
        grid,
        puck,
      }: ElementProps & { puck: { dragRef: Ref<HTMLDivElement> } }) => {
        const parsed = SiteElementSchema.safeParse(block);
        const desktop = grid.desktop;
        const tablet = grid.tablet ?? desktop;
        const mobile = grid.mobile ?? desktop;
        const style = {
          '--point-grid-desktop-column': desktop.column,
          '--point-grid-desktop-row': desktop.row,
          '--point-grid-desktop-column-span': desktop.columnSpan,
          '--point-grid-desktop-row-span': desktop.rowSpan,
          '--point-grid-tablet-column': tablet.column,
          '--point-grid-tablet-row': tablet.row,
          '--point-grid-tablet-column-span': tablet.columnSpan,
          '--point-grid-tablet-row-span': tablet.rowSpan,
          '--point-grid-mobile-column': mobile.column,
          '--point-grid-mobile-row': mobile.row,
          '--point-grid-mobile-column-span': mobile.columnSpan,
          '--point-grid-mobile-row-span': mobile.rowSpan,
        } as CSSProperties;
        return (
          <div
            ref={puck.dragRef}
            className={`point-layout-item point-layout-item--grid point-layout-item--${align}`}
            style={style}
          >
            {parsed.success ? renderBlock(parsed.data, document) : <p>Configure this element.</p>}
          </div>
        );
      },
    };
  }

  const config = {
    categories: {
      sections: { title: '1. Start with a section', components: [...sectionTypes] },
      content: {
        title: '2. Add text and buttons',
        components: ['heading', 'richText', 'hero', 'cta'],
      },
      media: { title: 'Add images and features', components: ['image', 'splitFeature'] },
      collections: { title: 'Show lists and people', components: ['cards', 'people'] },
      engagement: { title: 'Add interactive content', components: ['faq', 'form', 'map'] },
      spacing: { title: 'Layout helpers', components: ['divider', 'spacer'] },
      other: { visible: false },
    },
    components,
    root: {
      render: ({ children }: { children: ReactNode }) => (
        <>
          <style>{siteCss}</style>
          <CanvasBreakpointReporter />
          <SiteFrame document={document} page={page} editing onEditFooter={onEditFooter}>
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
        key={`${page.id}:${structureRevision}`}
        config={config}
        data={data}
        dnd={editorDnd}
        overrides={editorOverrides}
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
        viewports={editorViewports}
        iframe={editorIframe}
      />
    </div>
  );
}
