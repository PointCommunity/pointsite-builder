import {
  Puck,
  type ComponentData,
  type Config,
  type Data,
  type PuckAction,
  type Viewports,
} from '@puckeditor/core';
import '@puckeditor/core/puck.css';
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  memo,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { blockDefinitions, renderBlock } from '../../site-kit/registry';
import { SiteElementSchema } from '../../site-kit/schema';
import {
  areaForBreakpoint,
  defaultRowSpan,
  GRID_COLUMNS,
  independentGridArea,
  independentResponsiveValue,
  nextGridArea,
  updateGridArea,
} from '../../site-kit/grid-layout';
import type { SectionBlock, SiteElement } from '../../site-kit/types';
import { SiteFrame } from '../../site-kit/SiteRenderer';
import siteCss from '../../site-kit/site.css?inline';
import editorCanvasCss from './editor-canvas.css?inline';
import { BlockInspector } from './BlockInspector';
import { GridOverlay } from './GridOverlay';
import { getGridBreakpoint, setGridBreakpoint, useGridBreakpoint } from './GridBreakpointContext';
import { breakpointForWidth } from './grid-breakpoint';
import { GridPlacementInspector } from './GridPlacementInspector';
import { SectionInspector, type SectionSettings } from './SectionInspector';
import { draftDisplayDocument } from '../media/draft-display-document';
import { useEditorDocument, type useEditor } from './EditorProvider';
import { usePointPuck } from './puck-store';
import { useGridInteraction } from './grid-interaction-store';
import { mutationForContext } from './action-attribution';
import { consumePuckActionIntent, setPuckActionIntent } from './puck-action-intent';
import {
  getDraggedElementType,
  deriveGridDropIntent,
  getGridDropIntent,
  setGridDropIntent,
  setDraggedElementType,
  setPointerFeedbackHidden,
} from './grid-drag-preview';
import {
  childComponents,
  currentPuckData,
  rememberPuckData,
  siblingComponents,
} from './puck-grid-data';
import { adjustHeroTextWidth, clampHeroTextWidth, heroTextWidthFromDrag } from './hero-text-resize';

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

type HeroTextKind = 'heading' | 'body';

function HeroTextResizeHandle({
  componentId,
  kind,
  align,
}: {
  componentId: string;
  kind: HeroTextKind;
  align: Extract<SiteElement, { type: 'hero' }>['align'];
}) {
  const { document, stageDocument } = useEditorDocument();
  const getItemById = usePointPuck((state) => state.getItemById);
  const getSelectorForId = usePointPuck((state) => state.getSelectorForId);
  const dispatch = usePointPuck((state) => state.dispatch);
  const breakpoint = useGridBreakpoint();
  const [status, setStatus] = useState('');
  const cancelActiveResize = useRef<(() => void) | null>(null);
  const widthKey = kind === 'heading' ? 'headingWidth' : 'bodyWidth';
  const label = kind === 'heading' ? 'heading' : 'body';

  useEffect(() => () => cancelActiveResize.current?.(), []);

  const renderedWidth = (button: HTMLButtonElement): number => {
    const box = button.closest<HTMLElement>('.point-hero-text-box');
    const container = box?.parentElement;
    if (!box || !container) return 100;
    const containerWidth = container.getBoundingClientRect().width;
    if (containerWidth <= 0) return 100;
    return clampHeroTextWidth((box.getBoundingClientRect().width / containerWidth) * 100);
  };

  const commit = (width: number) => {
    const selector = getSelectorForId(componentId);
    const current = getItemById(componentId) as unknown as ComponentData | null;
    const currentProps = current?.props as unknown as Record<string, unknown> | undefined;
    const parsed = SiteElementSchema.safeParse(currentProps?.block);
    if (
      !selector?.zone ||
      !current ||
      !currentProps ||
      !parsed.success ||
      parsed.data.type !== 'hero'
    )
      return;
    const nextWidth = clampHeroTextWidth(width);
    setPuckActionIntent({
      category: 'resize',
      context: 'element-layout',
    });
    dispatch({
      type: 'replace',
      destinationIndex: selector.index,
      destinationZone: selector.zone,
      data: {
        ...current,
        props: {
          ...currentProps,
          id:
            typeof currentProps.id === 'string' || typeof currentProps.id === 'number'
              ? String(currentProps.id)
              : componentId,
          block: {
            ...parsed.data,
            [widthKey]: { ...parsed.data[widthKey], [breakpoint]: nextWidth },
          },
        },
      },
      recordHistory: true,
    });
    setStatus(`Hero ${label} width set to ${nextWidth} percent.`);
  };

  const beginResize = (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    cancelActiveResize.current?.();
    const button = event.currentTarget;
    const box = button.closest<HTMLElement>('.point-hero-text-box');
    const container = box?.parentElement;
    if (!box || !container) return;
    const ownerDocument = button.ownerDocument;
    const startX = event.clientX;
    const startWidth = renderedWidth(button);
    const containerWidth = container.getBoundingClientRect().width;
    const originalInlineWidth = box.style.getPropertyValue('--point-hero-text-width');
    const sourceProps = getItemById(componentId)?.props as unknown as
      Record<string, unknown> | undefined;
    const source = SiteElementSchema.safeParse(sourceProps?.block);
    if (!source.success || source.data.type !== 'hero') return;
    const elementId = source.data.id;
    let latest = startWidth;
    const move = (nextEvent: globalThis.PointerEvent) => {
      latest = heroTextWidthFromDrag(
        startWidth,
        nextEvent.clientX - startX,
        containerWidth,
        align === 'center',
      );
      box.style.setProperty('--point-hero-text-width', `${latest}%`);
      const pending = structuredClone(document);
      const element = pending.pages
        .flatMap((page) =>
          page.blocks.flatMap((section) => section.items.map((item) => item.element)),
        )
        .find((item) => item.id === elementId);
      if (element?.type === 'hero') {
        element[widthKey] = { ...element[widthKey], [breakpoint]: latest };
        // Keep the DOM gesture alive; changing Puck's document here remounts its resize handle.
        stageDocument(pending, { category: 'resize', context: 'element-layout' }, false);
      }
    };
    const cleanup = () => {
      ownerDocument.removeEventListener('pointermove', move);
      ownerDocument.removeEventListener('pointerup', finish);
      ownerDocument.removeEventListener('pointercancel', finish);
      cancelActiveResize.current = null;
    };
    const restore = () => {
      stageDocument(document, { category: 'resize', context: 'element-layout' }, false);
      if (originalInlineWidth)
        box.style.setProperty('--point-hero-text-width', originalInlineWidth);
      else box.style.removeProperty('--point-hero-text-width');
    };
    const cancel = () => {
      cleanup();
      restore();
    };
    const finish = (nextEvent: globalThis.PointerEvent) => {
      cleanup();
      if (nextEvent.type === 'pointercancel') return restore();
      commit(latest);
    };
    cancelActiveResize.current = cancel;
    ownerDocument.addEventListener('pointermove', move);
    ownerDocument.addEventListener('pointerup', finish, { once: true });
    ownerDocument.addEventListener('pointercancel', finish, { once: true });
  };

  const resizeWithKeyboard = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    event.stopPropagation();
    const current = getItemById(componentId) as unknown as ComponentData | null;
    const parsed = SiteElementSchema.safeParse(current?.props.block);
    const storedWidth =
      parsed.success && parsed.data.type === 'hero' ? parsed.data[widthKey][breakpoint] : undefined;
    commit(
      adjustHeroTextWidth(
        storedWidth ?? renderedWidth(event.currentTarget),
        event.key,
        event.shiftKey,
      ),
    );
  };

  return (
    <>
      <button
        type="button"
        className="point-hero-text-resize"
        aria-label={`Resize Hero ${label} width`}
        title="Drag horizontally or use Left and Right arrow keys. Hold Shift for a larger keyboard step."
        onPointerDown={beginResize}
        onKeyDown={resizeWithKeyboard}
      >
        <span aria-hidden="true">↔</span>
      </button>
      <span className="sr-only" role="status" aria-live="polite">
        {status}
      </span>
    </>
  );
}

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
      headingWidth: independentResponsiveValue(100),
      bodyWidth: independentResponsiveValue(100),
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
  const breakpoint = useGridBreakpoint();
  const gridRef = useRef<HTMLElement | null>(null);
  const [dropPreview, setDropPreview] = useState<{
    label: string;
    valid: boolean;
    style: CSSProperties;
  } | null>(null);
  const [dropAnnouncement, setDropAnnouncement] = useState('');
  const announcementTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearDropPreview = () => {
    setDropPreview(null);
    setDropAnnouncement('');
    if (announcementTimer.current) clearTimeout(announcementTimer.current);
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
    const renderedAreas = Array.from(
      gridRef.current.querySelectorAll<HTMLElement>('.point-layout-item--grid'),
    )
      .filter(
        (item) => !item.closest('[data-dnd-dragging]') && !item.closest('[data-dnd-placeholder]'),
      )
      .map((item) => {
        const rendered = getComputedStyle(item);
        const prefix = `--point-grid-${breakpoint}`;
        return {
          column: Number.parseInt(rendered.getPropertyValue(`${prefix}-column`), 10),
          row: Number.parseInt(rendered.getPropertyValue(`${prefix}-row`), 10),
          columnSpan: Number.parseInt(rendered.getPropertyValue(`${prefix}-column-span`), 10),
          rowSpan: Number.parseInt(rendered.getPropertyValue(`${prefix}-row-span`), 10),
        };
      })
      .filter((area) => Object.values(area).every(Number.isFinite));
    const intent = deriveGridDropIntent({
      type: draggedType,
      label: blockDefinitions[draggedType].label,
      sectionId: id,
      breakpoint,
      metrics: lastGridPointer,
      columnSpan: defaultSpan,
      rowSpan: defaultRowSpan(draggedType),
      occupied: renderedAreas.length
        ? renderedAreas
        : items.map((grid) => areaForBreakpoint(grid, breakpoint)),
    });
    setGridDropIntent(intent);
    const sectionRect = gridRef.current.closest('section')?.getBoundingClientRect() ?? rect;
    setDropPreview({
      label: intent.label,
      valid: intent.valid,
      style: {
        left: rect.left - sectionRect.left + intent.bounds.left,
        top: rect.top - sectionRect.top + intent.bounds.top,
        width: intent.bounds.width,
        height: intent.bounds.height,
      },
    });
    if (announcementTimer.current) clearTimeout(announcementTimer.current);
    announcementTimer.current = setTimeout(() => setDropAnnouncement(intent.label), 350);
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
  useEffect(
    () => () => {
      if (announcementTimer.current) clearTimeout(announcementTimer.current);
    },
    [],
  );
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
        <div
          className={`point-grid-drop-preview point-grid-drop-preview--${dropPreview.valid ? 'valid' : 'invalid'}`}
          data-drop-valid={dropPreview.valid}
          style={dropPreview.style}
          aria-hidden="true"
        >
          <span>{dropPreview.label}</span>
        </div>
      ) : null}
      <p className="sr-only" role="status" aria-live="polite">
        {dropAnnouncement}
      </p>
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
      setGridDropIntent(null);
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

function GridAlignmentField({
  value,
  onChange,
}: {
  value: SectionBlock['items'][number]['align'];
  onChange: (value: SectionBlock['items'][number]['align']) => void;
}) {
  const breakpoint = useGridBreakpoint();
  return (
    <label className="grid-alignment-field">
      <span>{breakpoint[0].toUpperCase() + breakpoint.slice(1)} vertical alignment</span>
      <select
        aria-label={`${breakpoint} vertical alignment`}
        value={value[breakpoint]}
        onChange={(event) => onChange({ ...value, [breakpoint]: event.target.value })}
      >
        {['start', 'center', 'end', 'stretch'].map((option) => (
          <option key={option} value={option}>
            {option[0].toUpperCase() + option.slice(1)}
          </option>
        ))}
      </select>
    </label>
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
      align: (child.props.align ??
        independentResponsiveValue('stretch')) as SectionBlock['items'][number]['align'],
      grid: (child.props.grid ??
        independentGridArea({
          column: 1,
          row: 1,
          columnSpan: 12,
          rowSpan: 4,
        })) as SectionBlock['items'][number]['grid'],
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
        align: (item.props.align ??
          independentResponsiveValue('stretch')) as SectionBlock['items'][number]['align'],
        grid:
          (item.props.grid as SectionBlock['items'][number]['grid']) ??
          independentGridArea({ column: 1, row: 1, columnSpan: 12, rowSpan: 4 }),
        element: SiteElementSchema.parse(item.props.block),
      },
    ],
  };
}

function VisualEditorImpl({
  draftId,
  pageId,
  structureRevision,
  onEditFooter,
}: {
  draftId: string;
  pageId: string;
  structureRevision: number;
  onEditFooter: () => void;
}) {
  const { document, updateDocument, stageDocument, completeDocument } = useEditorDocument();
  const displayDocument = useMemo(
    () => draftDisplayDocument(document, draftId),
    [document, draftId],
  );
  const [interactionRevision, setInteractionRevision] = useState(0);
  const page = document.pages.find((candidate) => candidate.id === pageId);
  const data = useMemo<Data>(
    () => ({ content: (page?.blocks ?? []).map(sectionToData), root: { props: {} } }),
    // Puck owns page-content state until an explicit structure reset changes its instance key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pageId, structureRevision, interactionRevision],
  );
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
        <SectionComponent {...props} kind={kind} document={displayDocument} />
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
              }, mutationForContext('navigation'))
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
        type: 'custom',
        label: 'Vertical alignment',
        render: ({
          value,
          onChange,
        }: {
          value: SectionBlock['items'][number]['align'];
          onChange: (value: SectionBlock['items'][number]['align']) => void;
        }) => <GridAlignmentField value={value} onChange={onChange} />,
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
        align: independentResponsiveValue('stretch'),
        grid: independentGridArea({
          column: 1,
          row: 1,
          columnSpan: 12,
          rowSpan: defaultRowSpan(type),
        }),
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
        const startingGrid = {
          desktop: nextGridArea(parentItems, defaultSpan, defaultRowSpan(type), 'desktop'),
          tablet: nextGridArea(parentItems, defaultSpan, defaultRowSpan(type), 'tablet'),
          mobile: nextGridArea(parentItems, defaultSpan, defaultRowSpan(type), 'mobile'),
        };
        const intent = getGridDropIntent();
        const applies =
          parentSettings?.layout === 'grid' &&
          intent?.sectionId === parentId &&
          intent.type === type;
        const activeBreakpoint = intent?.breakpoint ?? getGridBreakpoint();
        const grid = applies
          ? updateGridArea(startingGrid, activeBreakpoint, intent.area)
          : startingGrid;
        return {
          props: {
            ...data.props,
            block: { ...data.props.block, id: crypto.randomUUID() },
            span: parentSettings?.layout === 'grid' ? defaultSpan : 12,
            grid,
            ...(applies && !intent.valid ? { gridDropRejected: true } : {}),
          },
        };
      },
      render: ({
        id,
        block,
        align,
        grid,
        puck,
      }: ElementProps & { id: string; puck: { dragRef: Ref<HTMLDivElement> } }) => {
        const parsed = SiteElementSchema.safeParse(block);
        const hero = parsed.success && parsed.data.type === 'hero' ? parsed.data : null;
        const desktop = grid.desktop;
        const tablet = grid.tablet;
        const mobile = grid.mobile;
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
          '--point-align-desktop': align.desktop,
          '--point-align-tablet': align.tablet,
          '--point-align-mobile': align.mobile,
        } as CSSProperties;
        return (
          <div
            ref={puck.dragRef}
            className="point-layout-item point-layout-item--grid"
            style={style}
          >
            {parsed.success ? (
              renderBlock(
                parsed.data,
                displayDocument,
                undefined,
                hero
                  ? (kind) => (
                      <HeroTextResizeHandle componentId={id} kind={kind} align={hero.align} />
                    )
                  : undefined,
              )
            ) : (
              <p>Configure this element.</p>
            )}
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
        components: ['hero', 'heading', 'text', 'richText', 'button'],
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
          <style>{`${siteCss}\n${editorCanvasCss}`}</style>
          <CanvasBreakpointReporter />
          <SiteFrame document={displayDocument} page={page} editing onEditFooter={onEditFooter}>
            {children}
          </SiteFrame>
        </>
      ),
    },
  } as unknown as Config<ComposerProps>;
  return (
    <div
      className="visual-editor"
      aria-label={`Visual canvas for ${page.title}`}
      data-interaction-revision={interactionRevision}
      onClickCapture={(event) => {
        const button = (event.target as Element).closest('button');
        const cue =
          `${button?.getAttribute('aria-label') ?? ''} ${button?.getAttribute('title') ?? ''}`.toLowerCase();
        if (cue.includes('undo'))
          setPuckActionIntent({ category: 'undo', context: 'page-content' });
        else if (cue.includes('redo'))
          setPuckActionIntent({ category: 'redo', context: 'page-content' });
      }}
      onKeyDownCapture={(event) => {
        if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z') return;
        setPuckActionIntent({
          category: event.shiftKey ? 'redo' : 'undo',
          context: 'page-content',
        });
      }}
    >
      <DrawerDragReporter />
      <Puck
        key={`${page.id}:${structureRevision}:${interactionRevision}`}
        config={config}
        data={data}
        dnd={editorDnd}
        overrides={editorOverrides}
        onAction={(action: PuckAction, nextState) => {
          if (['setUi', 'registerZone', 'unregisterZone'].includes(action.type)) return;
          const rejectedInsert =
            (action.type === 'insert' && getGridDropIntent()?.valid === false) ||
            (action.type === 'replace' && action.data.props.gridDropRejected === true);
          if (rejectedInsert) {
            setGridDropIntent(null);
            queueMicrotask(() => setInteractionRevision((value) => value + 1));
            return;
          }
          const explicit = consumePuckActionIntent();
          if (action.type === 'setData' || (action.type === 'set' && !explicit)) return;
          let mutation: ReturnType<typeof mutationForContext> & { transient?: boolean };
          if (explicit) {
            mutation = explicit;
          } else if (action.recordHistory === false) {
            mutation = {
              category: 'control-change',
              context: 'page-content',
              transient: true,
            };
          } else if (action.type === 'insert')
            mutation = { category: 'add', context: 'page-content' };
          else if (action.type === 'duplicate')
            mutation = { category: 'duplicate', context: 'page-content' };
          else if (action.type === 'remove')
            mutation = { category: 'remove', context: 'page-content' };
          else if (action.type === 'reorder')
            mutation = { category: 'reorder', context: 'page-content' };
          else if (action.type === 'move') mutation = { category: 'move', context: 'page-content' };
          else if (action.type === 'replace') {
            const context = sectionTypes.includes(action.data.type as (typeof sectionTypes)[number])
              ? 'section-settings'
              : 'element-settings';
            mutation = mutationForContext(context, undefined);
          } else {
            mutation = mutationForContext('page-content');
          }

          const sections = nextState.data.content.map((item) =>
            sectionTypes.includes(item.type as (typeof sectionTypes)[number])
              ? dataToSection(item)
              : rootElementToSection(item),
          );
          const changed = structuredClone(document);
          const target = changed.pages.find((candidate) => candidate.id === pageId);
          if (target) target.blocks = sections;
          queueMicrotask(() => {
            if (mutation.transient) stageDocument(changed, mutation);
            else completeDocument(changed, mutation);
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

export const VisualEditor = memo(VisualEditorImpl);
