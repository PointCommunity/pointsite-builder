import {
  Puck,
  legacySideBarPlugin,
  type ComponentData,
  type Config,
  type Data,
  type PuckAction,
  type Viewports,
} from '@puckeditor/core';
import '@puckeditor/core/no-external.css';
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
import {
  blockDefinitions,
  CompositionFrame,
  LayoutItem,
  LayoutSection,
  renderBlock,
} from '../../site-kit/registry';
import { SiteDocumentSchema, SiteElementSchema } from '../../site-kit/schema';
import { upgradeComposition } from '../../site-kit/migrations';
import {
  areaForBreakpoint,
  defaultRowSpan,
  GRID_COLUMNS,
  GRID_BREAKPOINTS,
  independentGridArea,
  independentResponsiveValue,
  nextGridArea,
  requiredSectionRows,
  textWrapForItem,
  updateGridArea,
  type GridBreakpoint,
} from '../../site-kit/grid-layout';
import type { SectionBlock, SiteDocument, SiteElement } from '../../site-kit/types';
import { SiteFrame } from '../../site-kit/SiteRenderer';
import {
  documentRegions,
  FOOTER_REGION,
  layoutSections,
  replaceLayoutSections,
} from '../../site-kit/document-sections';
import siteCss from '../../site-kit/site.css?inline';
import editorCanvasCss from './editor-canvas.css?inline';
import { BlockInspector } from './BlockInspector';
import { GridOverlay } from './GridOverlay';
import { getGridBreakpoint, setGridBreakpoint, useGridBreakpoint } from './GridBreakpointContext';
import { breakpointForWidth } from './grid-breakpoint';
import { GridPlacementInspector } from './GridPlacementInspector';
import { SectionInspector, type SectionSettings } from './SectionInspector';
import { siteViewports } from '../preview/viewports';
import { draftDisplayDocument } from '../media/draft-display-document';
import { useEditorDocument, type useEditor } from './EditorProvider';
import { usePointPuck } from './puck-store';
import { CompactEditorHeader, EditorPagePanel, EditorPanelsProvider } from './EditorPanels';
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
  documentComponentId,
  rememberPuckData,
  siblingComponents,
} from './puck-grid-data';
import {
  dataToSection,
  placementToData,
  rootElementToSection,
  sectionToData,
} from './editor-section-data';
import {
  compositionPreset,
  compositionPresetNames,
  type CompositionPresetName,
} from './composition-presets';
import { adjustHeroTextWidth, clampHeroTextWidth, heroTextWidthFromDrag } from './hero-text-resize';

type ElementProps = {
  block: SiteElement;
  span: number;
  align: SectionBlock['items'][number]['align'];
  grid: SectionBlock['items'][number]['grid'];
  layer?: number;
  content?: (props?: Record<string, unknown>) => ReactNode;
};
type ElementDataProps = Omit<ElementProps, 'content'> & { content?: ComponentData[] };
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
      const element = documentRegions(pending)
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
const presetComponents = compositionPresetNames.map((name) => ({
  name,
  key: `Preset${name.replaceAll(' ', '')}`,
}));
const presetNameByKey = new Map(presetComponents.map(({ key, name }) => [key, name]));
const paletteTypes = [...elementTypes, ...presetComponents.map(({ key }) => key)];
let draggedPresetName: CompositionPresetName | null = null;
const editorViewports: Viewports = Object.values(siteViewports);
const editorDnd = { behavior: 'auto' as const };
const editorIframe = { enabled: true, waitForStyles: false, syncHostStyles: false };
function EditorViewport({ children }: { children: ReactNode }) {
  const height = usePointPuck((state) => state.appState.ui.viewports.current.height);
  return <div style={{ height }}>{children}</div>;
}
const editorOverrides = {
  componentOverlay: GridOverlay,
  header: CompactEditorHeader,
  preview: EditorViewport,
};
const editorPlugins = [{ ...legacySideBarPlugin(), render: EditorPagePanel }];

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
let lastSectionPointer: string | null = null;
function sectionAtPointer(canvas: Document, x: number, y: number): string | null {
  const section = Array.from(
    canvas.querySelectorAll<HTMLElement>('[data-point-section-id]'),
  ).findLast((candidate) => {
    const bounds = candidate.getBoundingClientRect();
    return x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom;
  });
  return section?.dataset.pointSectionId ?? null;
}
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
      heading: 'Welcome',
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
      ...(document.schemaVersion >= 10
        ? { navigationDesignId: document.navigationDesigns?.[0]?.id }
        : {}),
      label: 'Site navigation',
      orientation: 'responsive',
      align: 'right',
      surface: 'transparent',
    },
    socialLinks: {
      id,
      type: 'socialLinks',
      heading: 'Follow us',
      links: structuredClone(document.site.socialLinks),
      align: 'center',
      appearance: 'icons',
    },
    composition: { id, type: 'composition', name: 'Group', items: [] },
  };
  return defaults[type] as Extract<SiteElement, { type: T }>;
}

function draggedPreviewElement(type: SiteElement['type'], document: SiteDocument): SiteElement {
  return type === 'composition' && draggedPresetName
    ? compositionPreset(draggedPresetName, document)
    : defaultElement(type, document);
}

function draggedPreviewRows(
  type: SiteElement['type'],
  document: SiteDocument,
  breakpoint: GridBreakpoint,
): number {
  const block = draggedPreviewElement(type, document);
  return block.type === 'composition'
    ? Math.max(defaultRowSpan(type), requiredSectionRows(1, block.items, breakpoint))
    : defaultRowSpan(type);
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

type DropPreview = {
  type: SiteElement['type'];
  label: string;
  valid: boolean;
  style: CSSProperties;
};

function DropPhantom({
  preview,
  document,
}: {
  preview: DropPreview;
  document: ReturnType<typeof useEditor>['document'];
}) {
  return (
    <div
      className={`point-grid-drop-preview point-grid-drop-preview--${preview.valid ? 'valid' : 'invalid'}`}
      data-drop-valid={preview.valid}
      style={preview.style}
      aria-hidden="true"
    >
      <div className="point-grid-drop-preview__content">
        {(preview.type === 'image' || preview.type === 'splitFeature') && !document.media.length ? (
          <div className="point-grid-drop-preview__media">Image</div>
        ) : preview.type === 'form' && !document.forms.length ? (
          <div className="point-grid-drop-preview__media">Form</div>
        ) : (
          renderBlock(draggedPreviewElement(preview.type, document), document)
        )}
      </div>
      <span>{preview.label}</span>
    </div>
  );
}

function RootDropPhantom({ document }: { document: ReturnType<typeof useEditor>['document'] }) {
  const marker = useRef<HTMLSpanElement>(null);
  const isDragging = usePointPuck((state) => state.appState.ui.isDragging);
  const [preview, setPreview] = useState<{
    type: SiteElement['type'];
    top: number;
    left: number;
    width: number;
  } | null>(null);
  useEffect(() => {
    if (!isDragging) return;
    const owner = marker.current?.ownerDocument;
    const view = owner?.defaultView;
    if (!owner || !view) return;
    const root = owner.querySelector<HTMLElement>('[data-puck-dropzone="root:default-zone"]');
    const host = view.frameElement?.ownerDocument;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const type = getDraggedElementType();
      const line = root?.querySelector<HTMLElement>('[data-puck-line-placeholder]');
      if (
        !type ||
        !line ||
        !root ||
        lastSectionPointer ||
        host?.documentElement.hasAttribute('data-point-grid-preview')
      ) {
        setPreview(null);
        return;
      }
      const target =
        marker.current?.closest<HTMLElement>('.page-body.shell')?.getBoundingClientRect() ??
        root.getBoundingClientRect();
      const top = line.getBoundingClientRect().top;
      setPreview((previous) =>
        previous?.type === type &&
        previous.top === top &&
        previous.left === target.left &&
        previous.width === target.width
          ? previous
          : { type, top, left: target.left, width: target.width },
      );
    };
    const schedule = () => {
      if (!frame) frame = view.requestAnimationFrame(measure);
    };
    const observer = new MutationObserver(schedule);
    if (root)
      observer.observe(root, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['style'],
      });
    owner.addEventListener('pointermove', schedule, true);
    host?.addEventListener('pointermove', schedule, true);
    schedule();
    return () => {
      observer.disconnect();
      owner.removeEventListener('pointermove', schedule, true);
      host?.removeEventListener('pointermove', schedule, true);
      if (frame) view.cancelAnimationFrame(frame);
    };
  }, [isDragging]);
  const type = preview?.type;
  const block = type ? draggedPreviewElement(type, document) : null;
  return (
    <>
      <span ref={marker} hidden />
      {isDragging && preview && block ? (
        <div
          className="point-root-drop-preview"
          style={{ top: preview.top, left: preview.left, width: preview.width }}
          aria-hidden="true"
        >
          <LayoutSection section={sectionDefaults('Section')} document={document}>
            <LayoutItem
              placement={{
                grid: independentGridArea({
                  column: 1,
                  row: 1,
                  columnSpan: 12,
                  rowSpan: draggedPreviewRows(type!, document, getGridBreakpoint()),
                }),
                align: independentResponsiveValue('stretch'),
                span: 12,
              }}
            >
              {(type === 'image' || type === 'splitFeature') && !document.media.length ? (
                <div className="point-grid-drop-preview__media">Image</div>
              ) : type === 'form' && !document.forms.length ? (
                <div className="point-grid-drop-preview__media">Form</div>
              ) : (
                renderBlock(block, document)
              )}
            </LayoutItem>
          </LayoutSection>
        </div>
      ) : null}
      <p className="sr-only" role="status" aria-live="polite">
        {preview ? `${blockDefinitions[preview.type].label} will land in a new grid section.` : ''}
      </p>
    </>
  );
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
  const [dropPreview, setDropPreview] = useState<DropPreview | null>(null);
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
    if (
      Array.from(gridRef.current.querySelectorAll('.point-composition')).some((group) => {
        const bounds = group.getBoundingClientRect();
        return (
          clientX >= bounds.left &&
          clientX <= bounds.right &&
          clientY >= bounds.top &&
          clientY <= bounds.bottom
        );
      })
    ) {
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
        (item) =>
          !item.closest('.point-composition__grid') &&
          !item.closest('[data-dnd-dragging]') &&
          !item.closest('[data-dnd-placeholder]'),
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
      type: draggedType,
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
  }, [settings.gap, settings.gapPixels, settings.layout]);
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
  return (
    <LayoutSection
      section={settings}
      document={document}
      sectionId={id}
      interaction={{
        onPointerMoveCapture: (event) => trackGridPointerCoordinates(event.clientX, event.clientY),
        onPointerLeave: clearDropPreview,
      }}
      renderContent={(className, style) => (
        <Content
          ref={gridRef}
          className={`${className}${isDragging || isGridInteracting ? ' point-layout-section__grid--active' : ''}`}
          data-grid-drop-preview={dropPreview ? 'true' : undefined}
          style={style}
          minEmptyHeight={settings.layout === 'compatibility' ? 48 : 96}
        />
      )}
      controls={
        <>
          {isDragging && dropPreview ? (
            <DropPhantom preview={dropPreview} document={document} />
          ) : null}
          <p className="sr-only" role="status" aria-live="polite">
            {dropAnnouncement}
          </p>
        </>
      }
    />
  );
}

function GroupComponent({
  id,
  name,
  content: Content,
  document,
}: {
  id: string;
  name: string;
  content: NonNullable<ElementProps['content']>;
  document: ReturnType<typeof useEditor>['document'];
}) {
  const isDragging = usePointPuck((state) => state.appState.ui.isDragging);
  const breakpoint = useGridBreakpoint();
  const gridRef = useRef<HTMLElement | null>(null);
  const [preview, setPreview] = useState<DropPreview | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const clear = () => {
    setPreview(null);
    setAnnouncement('');
    if (gridRef.current) setPointerFeedbackHidden(gridRef.current.ownerDocument, false);
  };
  const track = (clientX: number, clientY: number) => {
    const grid = gridRef.current;
    if (!id || !grid || !isDragging) return;
    const bounds = grid.getBoundingClientRect();
    if (
      clientX < bounds.left ||
      clientX > bounds.right ||
      clientY < bounds.top ||
      clientY > bounds.bottom
    ) {
      clear();
      return;
    }
    const type = getDraggedElementType();
    if (!type) return;
    const computed = getComputedStyle(grid);
    const columnGap = Number.parseFloat(computed.columnGap) || 0;
    const rowGap = Number.parseFloat(computed.rowGap) || 0;
    const cellSize = Math.max(24, (bounds.width - columnGap * 11) / 12);
    const intent = deriveGridDropIntent({
      type,
      label: draggedPresetName ?? blockDefinitions[type].label,
      sectionId: id,
      breakpoint,
      metrics: {
        x: clientX - bounds.left,
        y: clientY - bounds.top,
        width: bounds.width,
        columnGap,
        rowGap,
        cellSize,
      },
      columnSpan: 6,
      rowSpan: draggedPreviewRows(type, document, breakpoint),
      occupied: childComponents(currentPuckData(), id)
        .map((child) => child.props.grid as SectionBlock['items'][number]['grid'])
        .filter(Boolean)
        .map((area) => areaForBreakpoint(area, breakpoint)),
    });
    setGridDropIntent(intent);
    const frame = grid.closest('section')?.getBoundingClientRect() ?? bounds;
    setPreview({
      type,
      label: intent.label,
      valid: intent.valid,
      style: {
        left: bounds.left - frame.left + intent.bounds.left,
        top: bounds.top - frame.top + intent.bounds.top,
        width: intent.bounds.width,
        height: intent.bounds.height,
      },
    });
    setAnnouncement(intent.label);
    setPointerFeedbackHidden(grid.ownerDocument, true);
  };
  const forwardPointer = useEffectEvent(track);
  useEffect(() => {
    if (!isDragging) {
      if (gridRef.current) setPointerFeedbackHidden(gridRef.current.ownerDocument, false);
    }
  }, [isDragging]);
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid || !isDragging) return;
    const frameWindow = grid.ownerDocument.defaultView;
    const frame = frameWindow?.frameElement as HTMLIFrameElement | null;
    const hostDocument = frame?.ownerDocument;
    if (!frameWindow || !frame || !hostDocument || hostDocument === grid.ownerDocument) return;
    const forward = (event: globalThis.PointerEvent) => {
      const frameRect = frame.getBoundingClientRect();
      const scale = frameRect.width ? frameWindow.innerWidth / frameRect.width : 1;
      forwardPointer(
        (event.clientX - frameRect.left) * scale,
        (event.clientY - frameRect.top) * scale,
      );
    };
    hostDocument.addEventListener('pointermove', forward, true);
    return () => hostDocument.removeEventListener('pointermove', forward, true);
  }, [isDragging]);
  return (
    <CompositionFrame name={name}>
      <Content
        ref={gridRef}
        className="point-composition__grid"
        data-grid-drop-preview={preview ? 'true' : undefined}
        minEmptyHeight={96}
        onPointerMoveCapture={(event: PointerEvent<HTMLElement>) =>
          track(event.clientX, event.clientY)
        }
        onPointerLeave={(event: PointerEvent<HTMLElement>) => {
          const bounds = gridRef.current?.getBoundingClientRect();
          if (
            bounds &&
            (event.clientX < bounds.left ||
              event.clientX > bounds.right ||
              event.clientY < bounds.top ||
              event.clientY > bounds.bottom)
          )
            clear();
        }}
      />
      {isDragging && preview ? <DropPhantom preview={preview} document={document} /> : null}
      <p className="sr-only" role="status" aria-live="polite">
        {isDragging ? announcement : ''}
      </p>
    </CompositionFrame>
  );
}

function CanvasBreakpointReporter({
  restoreSelection,
}: {
  restoreSelection?: { zone: string; index: number };
}) {
  const marker = useRef<HTMLSpanElement>(null);
  const width = usePointPuck((state) => state.appState.ui.viewports.current.width);
  const data = usePointPuck((state) => state.appState.data);
  const dispatch = usePointPuck((state) => state.dispatch);
  useEffect(() => {
    if (restoreSelection) dispatch({ type: 'setUi', ui: { itemSelector: restoreSelection } });
  }, [dispatch, restoreSelection]);
  useEffect(() => rememberPuckData(data), [data]);
  useEffect(() => {
    if (typeof width === 'number') setGridBreakpoint(breakpointForWidth(width));
  }, [width]);
  useLayoutEffect(() => {
    const canvasDocument = marker.current?.ownerDocument;
    const frame = canvasDocument?.defaultView?.frameElement;
    const canvasRoot = frame?.closest<HTMLElement>('#puck-canvas-root');
    if (!canvasDocument || !canvasRoot) return;
    const locateSection = (event: globalThis.PointerEvent) => {
      if (getDraggedElementType())
        lastSectionPointer = sectionAtPointer(canvasDocument, event.clientX, event.clientY);
    };
    canvasDocument.addEventListener('pointermove', locateSection, true);
    canvasDocument.addEventListener('pointerup', locateSection, true);
    const updateTargetSize = () => {
      const scale = new DOMMatrixReadOnly(canvasRoot.style.transform).a || 1;
      canvasDocument.documentElement.style.setProperty('--point-touch-target', `${44 / scale}px`);
      canvasDocument.documentElement.style.setProperty('--point-touch-font', `${14 / scale}px`);
    };
    updateTargetSize();
    const observer = new MutationObserver(updateTargetSize);
    observer.observe(canvasRoot, { attributes: true, attributeFilter: ['style'] });
    return () => {
      observer.disconnect();
      canvasDocument.removeEventListener('pointermove', locateSection, true);
      canvasDocument.removeEventListener('pointerup', locateSection, true);
    };
  }, []);
  return <span ref={marker} hidden />;
}

function DrawerDragReporter() {
  useEffect(() => {
    const locateSection = (event: globalThis.PointerEvent) => {
      if (!getDraggedElementType()) return;
      const frame = globalThis.document.querySelector<HTMLIFrameElement>('.visual-editor iframe');
      const canvas = frame?.contentDocument;
      const frameRect = frame?.getBoundingClientRect();
      if (!canvas || !frameRect?.width || !frameRect.height) return;
      const x =
        ((event.clientX - frameRect.left) * (frame.contentWindow?.innerWidth ?? 0)) /
        frameRect.width;
      const y =
        ((event.clientY - frameRect.top) * (frame.contentWindow?.innerHeight ?? 0)) /
        frameRect.height;
      lastSectionPointer = sectionAtPointer(canvas, x, y);
    };
    const track = (event: globalThis.PointerEvent) => {
      setGridDropIntent(null);
      lastSectionPointer = null;
      const target = event.target as HTMLElement | null;
      const drawerItem = target?.closest<HTMLElement>('[data-testid^="drawer-item:"]');
      const testedType = drawerItem?.dataset.testid?.replace('drawer-item:', '');
      const buttonLabel = target?.closest('button')?.textContent?.trim();
      draggedPresetName =
        presetNameByKey.get(testedType ?? '') ??
        compositionPresetNames.find((name) => name === buttonLabel) ??
        null;
      const labeledType = elementTypes.find(
        (candidate) => blockDefinitions[candidate].label === buttonLabel,
      );
      const type = draggedPresetName
        ? 'composition'
        : (elementTypes.find((candidate) => candidate === testedType) ?? labeledType);
      setDraggedElementType(type ?? null);
    };
    globalThis.document.addEventListener('pointerdown', track, true);
    globalThis.document.addEventListener('pointermove', locateSection, true);
    globalThis.document.addEventListener('pointerup', locateSection, true);
    return () => {
      globalThis.document.removeEventListener('pointerdown', track, true);
      globalThis.document.removeEventListener('pointermove', locateSection, true);
      globalThis.document.removeEventListener('pointerup', locateSection, true);
    };
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
  const selectedBlock = selectedProps?.block as { type?: string; wrap?: boolean } | undefined;
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
  return (
    <GridPlacementInspector
      value={value}
      occupied={occupied}
      allowOverlap={
        Number(selectedProps?.layer ?? 0) !== 0 ||
        (selectedBlock?.type === 'image' && selectedBlock.wrap === true)
      }
      onChange={onChange}
    />
  );
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

function GroupPresetControls({
  block,
  document,
}: {
  block: Extract<SiteElement, { type: 'composition' }>;
  document: ReturnType<typeof useEditor>['document'];
}) {
  const selectedItem = usePointPuck((state) => state.selectedItem) as ComponentData | null;
  const getSelectorForId = usePointPuck((state) => state.getSelectorForId);
  const dispatch = usePointPuck((state) => state.dispatch);
  const componentId = String(selectedItem?.props.id ?? '');
  const empty = ((selectedItem?.props.content ?? []) as ComponentData[]).length === 0;
  if (!empty) return null;
  return (
    <fieldset className="inspector-group">
      <legend>Starting layouts</legend>
      <p className="field-help">Add independent grid elements. Every part stays editable.</p>
      {compositionPresetNames.map((name) => (
        <button
          key={name}
          type="button"
          className="button"
          onClick={() => {
            const selector = getSelectorForId(componentId);
            if (!selectedItem || !selector?.zone) return;
            const preset = compositionPreset(name, document);
            const currentGrid = selectedItem.props.grid as SectionBlock['items'][number]['grid'];
            const expandedGrid = GRID_BREAKPOINTS.reduce(
              (grid, breakpoint) =>
                updateGridArea(grid, breakpoint, {
                  rowSpan: Math.max(
                    areaForBreakpoint(grid, breakpoint).rowSpan,
                    requiredSectionRows(1, preset.items, breakpoint),
                  ),
                }),
              currentGrid,
            );
            setPuckActionIntent({ category: 'add', context: 'page-content' });
            dispatch({
              type: 'replace',
              destinationIndex: selector.index,
              destinationZone: selector.zone,
              data: {
                ...selectedItem,
                props: {
                  ...selectedItem.props,
                  block: { ...preset, id: block.id },
                  grid: expandedGrid,
                  content: preset.items.map((item) => {
                    const child = placementToData(item, 12);
                    return { ...child, props: { ...child.props, layer: item.layer } };
                  }),
                },
              },
              recordHistory: true,
            });
          }}
        >
          {name}
        </button>
      ))}
    </fieldset>
  );
}

function EditorTextLayoutItem({
  id,
  block,
  grid,
  align,
  span,
  layer,
  dragRef,
  children,
}: {
  id: string;
  block: Extract<SiteElement, { type: 'text' }>;
  grid: ElementProps['grid'];
  align: ElementProps['align'];
  span: number;
  layer?: number;
  dragRef: Ref<HTMLDivElement>;
  children: ReactNode;
}) {
  const data = usePointPuck((state) => state.appState.data);
  const siblings = siblingComponents(data, id).flatMap((item) => {
    const parsed = SiteElementSchema.safeParse(item.props.block);
    return parsed.success
      ? [{ grid: item.props.grid as ElementProps['grid'], element: parsed.data }]
      : [];
  });
  return (
    <LayoutItem
      dragRef={dragRef}
      placement={{ grid, align, span }}
      layer={layer}
      wrap={textWrapForItem({ grid, element: block }, siblings)}
    >
      {children}
    </LayoutItem>
  );
}

function VisualEditorImpl({
  draftId,
  pageId,
  structureRevision,
  onEditFooter,
  onEditNavigation,
  onPageIdChange,
  onStructureChange,
  toolbar,
  propertiesOpen,
  onPropertiesChange,
}: {
  draftId: string;
  pageId: string;
  structureRevision: number;
  onEditFooter: () => void;
  onEditNavigation: (id: string) => void;
  onPageIdChange: (id: string) => void;
  onStructureChange: () => void;
  toolbar: HTMLElement | null;
  propertiesOpen: boolean;
  onPropertiesChange: (open: boolean) => void;
}) {
  const { document, stageDocument, completeDocument } = useEditorDocument();
  const displayDocument = useMemo(
    () => draftDisplayDocument(document, draftId),
    [document, draftId],
  );
  const [interactionRevision, setInteractionRevision] = useState(0);
  const remountSelection = useRef<{
    revision: number;
    pageId: string;
    selector: { zone: string; index: number };
  } | null>(null);
  const pendingSelection = useRef<{
    pageId: string;
    selector: { zone: string; index: number };
  } | null>(null);
  useEffect(() => {
    const pending = pendingSelection.current;
    if (!pending || pending.pageId !== pageId) return;
    const sections =
      pageId === 'footer'
        ? document.footer
        : document.pages.find((page) => page.id === pageId)?.blocks;
    const section = sections?.find((entry) => `${entry.id}:content` === pending.selector.zone);
    if (!section || section.items.length <= pending.selector.index) return;
    pendingSelection.current = null;
    setInteractionRevision((value) => {
      remountSelection.current = { revision: value + 1, pageId, selector: pending.selector };
      return value + 1;
    });
  }, [document, pageId]);
  const [touchWorkspace, setTouchWorkspace] = useState(
    () => window.matchMedia('(pointer: coarse)').matches,
  );
  useEffect(() => {
    const media = window.matchMedia('(pointer: coarse)');
    const update = () => setTouchWorkspace(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const editingFooter = pageId === FOOTER_REGION && document.footer !== undefined;
  const page =
    document.pages.find((candidate) => candidate.id === pageId) ??
    (editingFooter ? document.pages[0] : undefined);
  const data = useMemo<Data>(
    () => ({
      content: (layoutSections(document, pageId) ?? []).map(sectionToData),
      root: { props: {} },
    }),
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
        content: { type: 'slot', allow: paletteTypes },
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
          <>
            <BlockInspector
              block={value}
              document={document}
              onChange={onChange}
              onEditNavigation={onEditNavigation}
            />
            {value.type === 'composition' ? (
              <GroupPresetControls block={value} document={document} />
            ) : null}
          </>
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
      layer: {
        type: 'select',
        label: 'Layer',
        options: Array.from({ length: 41 }, (_, index) => ({
          label: String(index - 20),
          value: index - 20,
        })),
      },
      content: {
        type: 'slot',
        allow: elementTypes.filter((candidate) => candidate !== 'composition'),
      },
    };
    components[type] = {
      label: blockDefinitions[type].label,
      inline: true,
      fields:
        type === 'composition'
          ? fields
          : { block: fields.block, span: fields.span, grid: fields.grid, align: fields.align },
      ...(type === 'mediaEmbed' && document.linkedMedia.length === 0
        ? { permissions: { insert: false } }
        : {}),
      resolveFields: (_data: unknown, { parent }: { parent: ComponentData | null }) => {
        const groupFields = type === 'composition' ? { content: fields.content } : {};
        const layerFields =
          document.schemaVersion >= 12 &&
          (parent?.type === 'composition' ||
            presetNameByKey.has(parent?.type ?? '') ||
            (parent?.props.settings as Partial<SectionSettings> | undefined)?.layout === 'grid')
            ? { layer: fields.layer }
            : {};
        const parentProps = parent
          ? (parent.props as unknown as Record<string, unknown>)
          : undefined;
        const parentSettings = parentProps?.settings as Partial<SectionSettings> | undefined;
        if (parentSettings?.layout === 'compatibility')
          return { block: fields.block, ...groupFields };
        if (parentSettings?.layout === 'flow' && document.schemaVersion < 11)
          return { block: fields.block, align: fields.align, ...groupFields };
        if (parentSettings?.layout === 'flow') {
          return {
            block: fields.block,
            span: {
              ...fields.span,
              label: 'Width in row',
              options: Array.from({ length: parentSettings.columns ?? 1 }, (_, index) => ({
                value: index + 1,
                label:
                  index + 1 === parentSettings.columns
                    ? 'Full row'
                    : `${index + 1} column${index ? 's' : ''}`,
              })),
            },
            align: fields.align,
            ...groupFields,
          };
        }
        return {
          block: fields.block,
          grid: fields.grid,
          align: fields.align,
          ...groupFields,
          ...layerFields,
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
        ...(type === 'composition'
          ? { settings: { layout: 'grid', columns: 12 }, content: [] }
          : {}),
        ...(document.schemaVersion >= 12 ? { layer: 0 } : {}),
      },
      resolveData: (
        data: { props: ElementProps },
        { trigger, parent }: { trigger: string; parent: ComponentData | null },
      ) => {
        if (trigger !== 'insert') return data;
        if ((data.props as ElementProps & { presetPlacement?: boolean }).presetPlacement) {
          const props = { ...data.props } as ElementProps & { presetPlacement?: boolean };
          delete props.presetPlacement;
          return { props };
        }
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
          parent?.type === 'TwoColumnSection' ||
          parent?.type === 'composition' ||
          presetNameByKey.has(parent?.type ?? '')
            ? 6
            : parent?.type === 'ThreeColumnSection'
              ? 4
              : 12;
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
            span:
              parentSettings?.layout === 'flow'
                ? 1
                : parentSettings?.layout === 'grid'
                  ? defaultSpan
                  : 12,
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
        span,
        layer,
        content: Content,
        puck,
      }: ElementProps & { id: string; puck: { dragRef: Ref<HTMLDivElement> } }) => {
        const parsed = SiteElementSchema.safeParse(block);
        const hero = parsed.success && parsed.data.type === 'hero' ? parsed.data : null;
        const content = parsed.success ? (
          parsed.data.type === 'composition' && Content ? (
            <GroupComponent
              id={id}
              name={parsed.data.name}
              content={Content}
              document={displayDocument}
            />
          ) : (
            renderBlock(
              parsed.data,
              displayDocument,
              undefined,
              hero
                ? (kind) => <HeroTextResizeHandle componentId={id} kind={kind} align={hero.align} />
                : undefined,
            )
          )
        ) : (
          <p>Configure this element.</p>
        );
        return parsed.success && parsed.data.type === 'text' ? (
          <EditorTextLayoutItem
            id={id}
            block={parsed.data}
            grid={grid}
            align={align}
            span={span}
            layer={layer}
            dragRef={puck.dragRef}
          >
            {content}
          </EditorTextLayoutItem>
        ) : (
          <LayoutItem dragRef={puck.dragRef} placement={{ grid, align, span }} layer={layer}>
            {content}
          </LayoutItem>
        );
      },
    };
  }

  const groupComponent = components.composition as Record<string, unknown> & {
    defaultProps: ElementDataProps;
    resolveData: (
      data: { props: ElementDataProps },
      context: { trigger: string; parent: ComponentData | null },
    ) => { props: ElementDataProps };
  };
  for (const { key, name } of presetComponents) {
    const initial = compositionPreset(name, document);
    const presetData = (item: (typeof initial.items)[number]) => {
      const data = placementToData(item, 12);
      return { ...data, props: { ...data.props, presetPlacement: true } };
    };
    components[key] = {
      ...groupComponent,
      label: name,
      defaultProps: {
        ...groupComponent.defaultProps,
        block: initial,
        content: initial.items.map(presetData),
      },
      resolveData: (
        data: { props: ElementDataProps },
        context: { trigger: string; parent: ComponentData | null },
      ) => {
        if (context.trigger !== 'insert') return groupComponent.resolveData(data, context);
        const preset = compositionPreset(name, document);
        const resolved = groupComponent.resolveData(
          {
            ...data,
            props: {
              ...data.props,
              block: preset,
              content: preset.items.map(presetData),
            },
          },
          context,
        );
        const grid = GRID_BREAKPOINTS.reduce(
          (current, breakpoint) =>
            updateGridArea(current, breakpoint, {
              rowSpan: Math.max(
                areaForBreakpoint(current, breakpoint).rowSpan,
                requiredSectionRows(1, preset.items, breakpoint),
              ),
            }),
          resolved.props.grid,
        );
        return { ...resolved, props: { ...resolved.props, grid } };
      },
    };
  }

  const config = {
    categories: {
      sections: { title: 'Sections', components: [...sectionTypes] },
      site: {
        title: 'Site elements',
        components: ['navigation', ...(document.schemaVersion >= 11 ? ['socialLinks'] : [])],
      },
      content: {
        title: 'Text and buttons',
        components: [
          ...presetComponents.slice(0, 3).map(({ key }) => key),
          'hero',
          'heading',
          'text',
          'richText',
          'button',
          'cta',
        ],
      },
      media: {
        title: 'Images and media',
        components: ['image', 'mediaEmbed', 'splitFeature'],
      },
      collections: {
        title: 'Lists and people',
        components: [...presetComponents.slice(3, 6).map(({ key }) => key), 'cards', 'people'],
      },
      engagement: {
        title: 'Interactive',
        components: [presetComponents[6].key, 'faq', 'form', 'map'],
      },
      spacing: {
        title: 'Layout helpers',
        components: ['divider', 'spacer', 'composition'],
      },
      other: { visible: false },
    },
    components,
    root: {
      render: ({ children }: { children: ReactNode }) => (
        <>
          <style>{`${siteCss}\n${editorCanvasCss}`}</style>
          <CanvasBreakpointReporter
            restoreSelection={
              remountSelection.current?.revision === interactionRevision &&
              remountSelection.current.pageId === pageId
                ? remountSelection.current.selector
                : undefined
            }
          />
          <SiteFrame
            document={displayDocument}
            page={page}
            editing
            onEditFooter={editingFooter ? undefined : onEditFooter}
            footerContent={
              editingFooter ? (
                <>
                  {children}
                  <RootDropPhantom document={displayDocument} />
                </>
              ) : undefined
            }
          >
            {editingFooter ? null : (
              <>
                {children}
                <RootDropPhantom document={displayDocument} />
              </>
            )}
          </SiteFrame>
        </>
      ),
    },
  } as unknown as Config<ComposerProps>;
  return (
    <div
      className="visual-editor"
      aria-label={`Visual canvas for ${editingFooter ? 'Footer' : page.title}`}
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
        const key = event.key.toLowerCase();
        if (
          !(event.metaKey || event.ctrlKey) ||
          event.altKey ||
          (key !== 'z' && (key !== 'y' || event.shiftKey))
        )
          return;
        setPuckActionIntent({
          category: key === 'y' || event.shiftKey ? 'redo' : 'undo',
          context: 'page-content',
        });
      }}
    >
      <DrawerDragReporter />
      <EditorPanelsProvider
        pageId={pageId}
        onPageIdChange={onPageIdChange}
        onStructureChange={onStructureChange}
        toolbar={toolbar}
      >
        <Puck
          key={`${pageId}:${structureRevision}:${interactionRevision}`}
          config={config}
          data={data}
          ui={{
            rightSideBarVisible: propertiesOpen,
            ...(remountSelection.current?.revision === interactionRevision &&
            remountSelection.current.pageId === pageId
              ? { itemSelector: remountSelection.current.selector }
              : {}),
          }}
          dnd={editorDnd}
          overrides={editorOverrides}
          plugins={editorPlugins}
          _experimentalFullScreenCanvas={touchWorkspace}
          onAction={(action: PuckAction, nextState) => {
            if (action.type === 'setUi' && nextState.ui.rightSideBarVisible !== propertiesOpen)
              queueMicrotask(() => onPropertiesChange(nextState.ui.rightSideBarVisible));
            if (['setUi', 'registerZone', 'unregisterZone'].includes(action.type)) return;
            const dropIntent = getGridDropIntent();
            const rejectedInsert =
              (action.type === 'insert' &&
                dropIntent?.valid === false &&
                action.destinationZone === `${dropIntent.sectionId}:content`) ||
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
            else if (action.type === 'move')
              mutation = { category: 'move', context: 'page-content' };
            else if (action.type === 'replace') {
              const context = sectionTypes.includes(
                action.data.type as (typeof sectionTypes)[number],
              )
                ? 'section-settings'
                : 'element-settings';
              mutation = mutationForContext(context, undefined);
            } else {
              mutation = mutationForContext('page-content');
            }

            let content = nextState.data.content as ComponentData[];
            let insertSelector: { zone: string; index: number } | null = null;
            if (
              action.type === 'insert' &&
              action.destinationZone === 'root:default-zone' &&
              lastSectionPointer
            ) {
              const inserted = content[action.destinationIndex];
              const target = content.find(
                (item) =>
                  sectionTypes.includes(item.type as (typeof sectionTypes)[number]) &&
                  String(item.props.id) === lastSectionPointer &&
                  (item.props.settings as SectionSettings).layout === 'flow',
              );
              if (inserted?.type === action.componentType && target) {
                const children = (target.props.content ?? []) as ComponentData[];
                content = content
                  .filter((_, index) => index !== action.destinationIndex)
                  .map((item) =>
                    item === target
                      ? {
                          ...item,
                          props: {
                            ...item.props,
                            content: [...children, inserted],
                          },
                        }
                      : item,
                  );
                insertSelector = {
                  zone: `${documentComponentId(target)}:content`,
                  index: children.length,
                };
              }
            }
            lastSectionPointer = null;
            const hasRootElement = content.some(
              (item) => !sectionTypes.includes(item.type as (typeof sectionTypes)[number]),
            );
            const previousSections = layoutSections(document, pageId) ?? [];
            const sections = content.map((item) =>
              sectionTypes.includes(item.type as (typeof sectionTypes)[number])
                ? dataToSection(item)
                : rootElementToSection(
                    item,
                    sectionDefaults('Section'),
                    previousSections.find(
                      (section) =>
                        section.items.length === 1 &&
                        section.items[0].id === documentComponentId(item),
                    )?.id,
                  ),
            );
            if (
              !insertSelector &&
              (action.type === 'insert' || action.type === 'replace') &&
              action.destinationZone === 'root:default-zone' &&
              !sectionTypes.includes(
                content[action.destinationIndex]?.type as (typeof sectionTypes)[number],
              ) &&
              (action.type === 'replace' ||
                content[action.destinationIndex]?.type === action.componentType)
            )
              insertSelector = {
                zone: `${sections[action.destinationIndex].id}:content`,
                index: 0,
              };
            let changed =
              document.schemaVersion < 12 &&
              action.type === 'insert' &&
              action.componentType === 'composition'
                ? upgradeComposition(document)
                : structuredClone(document);
            replaceLayoutSections(changed, pageId, sections);
            if (changed.schemaVersion < 12 && !SiteDocumentSchema.safeParse(changed).success) {
              const upgraded = upgradeComposition(document);
              replaceLayoutSections(upgraded, pageId, sections);
              if (SiteDocumentSchema.safeParse(upgraded).success) changed = upgraded;
            }
            queueMicrotask(() => {
              if (mutation.transient) stageDocument(changed, mutation);
              else {
                if (insertSelector) pendingSelection.current = { pageId, selector: insertSelector };
                if (!completeDocument(changed, mutation)) pendingSelection.current = null;
                else if (!insertSelector && hasRootElement)
                  setInteractionRevision((value) => value + 1);
              }
            });
          }}
          onPublish={undefined}
          headerTitle={page.title}
          viewports={editorViewports}
          iframe={editorIframe}
        />
      </EditorPanelsProvider>
    </div>
  );
}

export const VisualEditor = memo(VisualEditorImpl);
