import { Puck, type ComponentData, type Config, type Data, type Viewports } from '@puckeditor/core';
import '@puckeditor/core/puck.css';
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { blockDefinitions, renderBlock } from '../../site-kit/registry';
import { SiteElementSchema } from '../../site-kit/schema';
import {
  areaForBreakpoint,
  defaultRowSpan,
  gridAreaFromPoint,
  GRID_COLUMNS,
  nextGridArea,
  resolveGridArea,
} from '../../site-kit/grid-layout';
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
import {
  getDraggedElementType,
  setDraggedElementType,
  setPointerFeedbackHidden,
} from './grid-drag-preview';
import {
  childComponents,
  currentPuckData,
  rememberPuckData,
  siblingComponents,
} from './puck-grid-data';

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
  Section: 'Blank',
  TwoColumnSection: 'Two Columns',
  ThreeColumnSection: 'Three Columns',
  FullWidthSection: 'Full-Width',
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
const editorOverrides = {
  componentOverlay: GridOverlay,
  headerActions: () => <></>,
};

let lastGridPointer:
  | {
      sectionId: string;
      x: number;
      y: number;
      width: number;
      columnGap: number;
      rowGap: number;
      cellSize: number;
    }
  | undefined;
function defaultElement<T extends SiteElement['type']>(
  type: T,
  document: ReturnType<typeof useEditor>['document'],
): Extract<SiteElement, { type: T }> {
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
    mediaEmbed: {
      id,
      type: 'mediaEmbed',
      linkedMediaId: document.linkedMedia[0]?.id ?? crypto.randomUUID(),
      aspect: '16:9',
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
      textAlign: 'left',
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
    text: { id, type: 'text', text: 'Add your text here.', style: 'body', align: 'left' },
    button: {
      id,
      type: 'button',
      label: 'Learn more',
      href: '/',
      style: 'primary',
      width: 'fit',
      align: 'left',
    },
    navigation: {
      id,
      type: 'navigation',
      label: 'Church navigation',
      orientation: 'responsive',
      align: 'right',
      surface: 'transparent',
    },
  };
  return defaults[type] as Extract<SiteElement, { type: T }>;
}

function sectionDefaults(kind: (typeof sectionTypes)[number]): SectionSettings {
  if (kind === 'TwoColumnSection')
    return {
      name: 'Two column section',
      layout: 'grid',
      position: 'flow',
      columns: 12,
      gap: 'medium',
      width: 'shell',
      surface: 'transparent',
      padding: 'medium',
      minRows: 8,
      backgroundPosition: 'center',
      overlay: 'none',
    };
  if (kind === 'ThreeColumnSection')
    return {
      name: 'Three column section',
      layout: 'grid',
      position: 'flow',
      columns: 12,
      gap: 'medium',
      width: 'shell',
      surface: 'transparent',
      padding: 'medium',
      minRows: 8,
      backgroundPosition: 'center',
      overlay: 'none',
    };
  if (kind === 'FullWidthSection')
    return {
      name: 'Full width section',
      layout: 'grid',
      position: 'flow',
      columns: 12,
      gap: 'medium',
      width: 'full',
      surface: 'canvas',
      padding: 'medium',
      minRows: 8,
      backgroundPosition: 'center',
      overlay: 'none',
    };
  return {
    name: 'Blank section',
    layout: 'grid',
    position: 'flow',
    columns: 12,
    gap: 'medium',
    width: 'shell',
    surface: 'transparent',
    padding: 'medium',
    minRows: 8,
    backgroundPosition: 'center',
    overlay: 'none',
  };
}

function SectionComponent({
  id,
  kind,
  settings,
  content: Content,
  document,
}: SectionProps & {
  id?: string;
  kind: (typeof sectionTypes)[number];
  document: ReturnType<typeof useEditor>['document'];
}) {
  const isDragging = usePointPuck((state) => state.appState.ui.isDragging);
  const isGridInteracting = useGridInteraction(id);
  const gridRef = useRef<HTMLElement | null>(null);
  const [dropPreview, setDropPreview] = useState<{
    label: string;
    style: CSSProperties;
  } | null>(null);
  const clearDropPreview = () => {
    setDropPreview(null);
    const ownerDocument = gridRef.current?.ownerDocument;
    if (ownerDocument) setPointerFeedbackHidden(ownerDocument, false);
  };
  const trackGridPointerCoordinates = (clientX: number, clientY: number) => {
    if (!id || !gridRef.current || settings.layout !== 'grid') return;
    const rect = gridRef.current.getBoundingClientRect();
    const withinGrid =
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom;
    if (!withinGrid) {
      clearDropPreview();
      return;
    }
    const computed = getComputedStyle(gridRef.current);
    const columnGap = Number.parseFloat(computed.columnGap) || 0;
    const rowGap = Number.parseFloat(computed.rowGap) || 0;
    const cellSize = Number.parseFloat(computed.getPropertyValue('--point-grid-cell')) || 24;
    lastGridPointer = {
      sectionId: id,
      x: clientX - rect.left,
      y: clientY - rect.top,
      width: rect.width,
      columnGap,
      rowGap,
      cellSize,
    };
    const draggedType = getDraggedElementType();
    if (!isDragging || !draggedType) {
      clearDropPreview();
      return;
    }
    const defaultSpan = kind === 'TwoColumnSection' ? 6 : kind === 'ThreeColumnSection' ? 4 : 12;
    const items = childComponents(currentPuckData(), id)
      .map((item) => item.props.grid as SectionBlock['items'][number]['grid'])
      .filter(Boolean);
    const fallback = nextGridArea(
      items.map((grid) => ({ grid })),
      defaultSpan,
      defaultRowSpan(draggedType),
    );
    const pointed = gridAreaFromPoint(lastGridPointer, defaultSpan, defaultRowSpan(draggedType));
    const area = resolveGridArea(
      pointed,
      fallback,
      items.map((grid) => areaForBreakpoint(grid, 'desktop')),
    ).area;
    const sectionRect = gridRef.current.closest('section')?.getBoundingClientRect() ?? rect;
    const columnSize = (rect.width - columnGap * (GRID_COLUMNS - 1)) / GRID_COLUMNS;
    const columnStep = columnSize + columnGap;
    const rowStep = cellSize + rowGap;
    setDropPreview({
      label: blockDefinitions[draggedType].label,
      style: {
        left: rect.left - sectionRect.left + (area.column - 1) * columnStep,
        top: rect.top - sectionRect.top + (area.row - 1) * rowStep,
        width: area.columnSpan * columnSize + (area.columnSpan - 1) * columnGap,
        height: area.rowSpan * cellSize + (area.rowSpan - 1) * rowGap,
      },
    });
    setPointerFeedbackHidden(gridRef.current.ownerDocument, true);
  };
  const forwardGridPointer = useEffectEvent(trackGridPointerCoordinates);
  useLayoutEffect(() => {
    const element = gridRef.current;
    if (!element || settings.layout !== 'grid') return;
    let animationFrame = 0;
    let lastCell = 0;
    const measure = () => {
      const gap = Number.parseFloat(getComputedStyle(element).columnGap) || 0;
      const cell = Math.max(24, (element.clientWidth - gap * (GRID_COLUMNS - 1)) / GRID_COLUMNS);
      if (Math.abs(cell - lastCell) < 0.01) return;
      lastCell = cell;
      element.style.setProperty('--point-grid-cell', `${cell}px`);
    };
    measure();
    const ResizeObserverClass = element.ownerDocument.defaultView?.ResizeObserver;
    if (!ResizeObserverClass) return;
    const observer = new ResizeObserverClass(() => {
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(measure);
    });
    observer.observe(element);
    return () => {
      cancelAnimationFrame(animationFrame);
      observer.disconnect();
    };
  }, [settings.gap, settings.layout]);
  useEffect(() => {
    if (isDragging) return;
    const ownerDocument = gridRef.current?.ownerDocument;
    if (ownerDocument) setPointerFeedbackHidden(ownerDocument, false);
  }, [isDragging]);
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid || !isDragging || settings.layout !== 'grid') return;
    const frameWindow = grid.ownerDocument.defaultView;
    const frame = frameWindow?.frameElement as HTMLIFrameElement | null;
    const hostDocument = frame?.ownerDocument;
    if (!frameWindow || !frame || !hostDocument || hostDocument === grid.ownerDocument) return;
    const forwardPointer = (event: globalThis.PointerEvent) => {
      if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
      const frameRect = frame.getBoundingClientRect();
      const scale = frameRect.width ? frameWindow.innerWidth / frameRect.width : 1;
      forwardGridPointer(
        (event.clientX - frameRect.left) * scale,
        (event.clientY - frameRect.top) * scale,
      );
    };
    hostDocument.addEventListener('pointermove', forwardPointer, true);
    return () => hostDocument.removeEventListener('pointermove', forwardPointer, true);
  }, [isDragging, settings.layout]);
  if (settings.layout === 'compatibility')
    return <Content className="point-compatibility-slot" minEmptyHeight={48} />;
  const style = {
    '--point-section-columns': settings.layout === 'flow' ? 1 : GRID_COLUMNS,
    '--point-section-gap': gapValues[settings.gap],
    '--point-section-total-gap': totalGapValues[settings.gap],
    '--point-section-min-rows': settings.minRows,
  } as CSSProperties;
  const background = settings.backgroundMediaId
    ? document.media.find((item) => item.id === settings.backgroundMediaId)
    : undefined;
  return (
    <section
      className={`point-layout-section point-layout-section--${settings.layout} point-layout-section--position-${settings.position} point-layout-section--${settings.width} point-layout-section--${settings.surface} point-layout-section--pad-${settings.padding} point-layout-section--overlay-${settings.overlay}`}
      aria-label={settings.name}
      data-point-section-id={id}
      onPointerMoveCapture={(event: PointerEvent<HTMLElement>) =>
        trackGridPointerCoordinates(event.clientX, event.clientY)
      }
      onPointerLeave={clearDropPreview}
    >
      {background ? (
        <img
          className={`point-layout-section__background point-layout-section__background--${settings.backgroundPosition}`}
          src={background.sourcePath}
          alt=""
        />
      ) : null}
      {settings.overlay !== 'none' ? (
        <div className="point-layout-section__overlay" aria-hidden="true" />
      ) : null}
      <Content
        ref={gridRef}
        className={`point-layout-section__grid${isDragging || isGridInteracting ? ' point-layout-section__grid--active' : ''}`}
        data-grid-drop-preview={dropPreview ? 'true' : undefined}
        style={style}
        minEmptyHeight={96}
      />
      {isDragging && dropPreview ? (
        <div className="point-grid-drop-preview" style={dropPreview.style} aria-hidden="true">
          <span>{dropPreview.label}</span>
        </div>
      ) : null}
    </section>
  );
}

function CanvasBreakpointReporter() {
  const width = usePointPuck((state) => state.appState.ui.viewports.current.width);
  const data = usePointPuck((state) => state.appState.data);
  useEffect(() => rememberPuckData(data), [data]);
  useEffect(() => {
    if (typeof width === 'number') setGridBreakpoint(breakpointForWidth(width));
  }, [width]);
  return null;
}

function DrawerDragReporter() {
  useEffect(() => {
    const track = (event: globalThis.PointerEvent) => {
      const target = event.target as HTMLElement | null;
      const drawerItem = target?.closest<HTMLElement>('[data-testid^="drawer-item:"]');
      const testedType = drawerItem?.dataset.testid?.replace('drawer-item:', '') as
        SiteElement['type'] | undefined;
      const buttonLabel = target?.closest('button')?.textContent?.trim();
      const labeledType = elementTypes.find(
        (candidate) => blockDefinitions[candidate].label === buttonLabel,
      );
      const type = testedType ?? labeledType;
      setDraggedElementType(type && elementTypes.includes(type) ? type : null);
    };
    globalThis.document.addEventListener('pointerdown', track, true);
    return () => globalThis.document.removeEventListener('pointerdown', track, true);
  }, []);
  return null;
}

function GridPlacementField({
  value,
  onChange,
}: {
  value: SectionBlock['items'][number]['grid'];
  onChange: (value: SectionBlock['items'][number]['grid']) => void;
}) {
  const getParentById = usePointPuck((state) => state.getParentById);
  const data = usePointPuck((state) => state.appState.data);
  const selectedItem = usePointPuck((state) => state.selectedItem);
  const selectedProps = selectedItem?.props as unknown as Record<string, unknown> | undefined;
  const rawComponentId = selectedProps?.id;
  const componentId =
    typeof rawComponentId === 'string' || typeof rawComponentId === 'number'
      ? String(rawComponentId)
      : '';
  const parent = componentId
    ? (getParentById(componentId) as unknown as ComponentData | null)
    : null;
  const occupied = (
    siblingComponents(data, componentId).length
      ? siblingComponents(data, componentId)
      : (((parent?.props as Record<string, unknown> | undefined)?.content ?? []) as ComponentData[])
  )
    .filter((item) => String(item.props.id) !== componentId)
    .map((item) => item.props.grid as SectionBlock['items'][number]['grid'])
    .filter(Boolean);
  return <GridPlacementInspector value={value} occupied={occupied} onChange={onChange} />;
}

function sectionToData(section: SectionBlock): ComponentData {
  return {
    type: 'Section',
    props: {
      id: section.id,
      settings: {
        name: section.name,
        layout: section.layout,
        position: section.position,
        columns: section.columns,
        gap: section.gap,
        width: section.width,
        surface: section.surface,
        padding: section.padding,
        minRows: section.minRows,
        ...(section.backgroundMediaId ? { backgroundMediaId: section.backgroundMediaId } : {}),
        backgroundPosition: section.backgroundPosition,
        overlay: section.overlay,
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
          }) => <SectionInspector settings={value} document={document} onChange={onChange} />,
        },
        content: { type: 'slot', allow: elementTypes },
      },
      defaultProps: {
        settings: sectionDefaults(kind),
        content: [],
      },
      render: (props: SectionProps & { id?: string }) => (
        <SectionComponent {...props} kind={kind} document={document} />
      ),
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
        }) => (
          <BlockInspector
            block={value}
            document={document}
            onChange={onChange}
            onNavigationChange={(navigation) =>
              updateDocument((next) => {
                next.navigation = navigation;
                return next;
              })
            }
          />
        ),
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
        }) => <GridPlacementField value={value} onChange={onChange} />,
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
      ...(type === 'mediaEmbed' && document.linkedMedia.length === 0
        ? { permissions: { insert: false } }
        : {}),
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
        const parentId = String(parent?.props.id ?? '');
        const storedParentItems = childComponents(currentPuckData(), parentId);
        const parentItems = (
          storedParentItems.length
            ? storedParentItems
            : ((parent?.props.content ?? []) as ComponentData[])
        )
          .filter((item) => item.props.id !== (data.props as ElementProps & { id?: string }).id)
          .map((item) => ({
            grid: item.props.grid as SectionBlock['items'][number]['grid'],
          }));
        const defaultSpan =
          parent?.type === 'TwoColumnSection' ? 6 : parent?.type === 'ThreeColumnSection' ? 4 : 12;
        const fallback = nextGridArea(parentItems, defaultSpan, defaultRowSpan(type));
        const pointed =
          lastGridPointer?.sectionId === parentId
            ? gridAreaFromPoint(lastGridPointer, defaultSpan, defaultRowSpan(type))
            : fallback;
        const resolved = resolveGridArea(
          pointed,
          fallback,
          parentItems.map((item) => areaForBreakpoint(item.grid, 'desktop')),
        );
        const grid = { desktop: resolved.area };
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
      sections: { title: 'Sections', components: [...sectionTypes] },
      site: { title: 'Site elements', components: ['navigation'] },
      content: {
        title: 'Text and buttons',
        components: ['heading', 'text', 'richText', 'button'],
      },
      media: {
        title: 'Images and media',
        components: ['image', 'mediaEmbed', 'splitFeature'],
      },
      collections: { title: 'Lists and people', components: ['cards', 'people'] },
      engagement: { title: 'Interactive', components: ['faq', 'form', 'map'] },
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
      <DrawerDragReporter />
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
        onPublish={undefined}
        headerTitle={page.title}
        viewports={editorViewports}
        iframe={editorIframe}
      />
    </div>
  );
}
