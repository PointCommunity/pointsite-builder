import type { ComponentData } from '@puckeditor/core';
import type { ElementPlacement, SectionBlock, SiteElement } from '../../site-kit/types';
import { SiteElementSchema } from '../../site-kit/schema';
import { independentGridArea, independentResponsiveValue } from '../../site-kit/grid-layout';
import { documentComponentId } from './puck-grid-data';
import type { SectionSettings } from './SectionInspector';

function placementToData(placement: ElementPlacement, columns: number): ComponentData {
  const block = placement.element;
  return {
    type: block.type,
    props: {
      id: placement.id,
      block,
      span: Math.min(placement.span, columns),
      align: placement.align,
      grid: placement.grid,
      ...(block.type === 'composition'
        ? {
            settings: { layout: 'grid', columns: 12 },
            content: block.items.map((child) => {
              const data = placementToData(child, 12);
              return { ...data, props: { ...data.props, layer: child.layer } };
            }),
          }
        : {}),
    },
  };
}

function elementFromData(child: ComponentData): SiteElement {
  const block = SiteElementSchema.parse(child.props.block);
  if (block.type !== 'composition') return block;
  const content = (child.props.content ?? []) as ComponentData[];
  return SiteElementSchema.parse({
    ...block,
    items: content.map((item) => ({
      ...placementFromData(item, 'grid'),
      layer: Number(item.props.layer ?? 0),
    })),
  });
}

function placementFromData(child: ComponentData, layout: SectionBlock['layout']): ElementPlacement {
  return {
    id: documentComponentId(child),
    span: Number(
      layout === 'flow'
        ? (child.props.span ?? 1)
        : ((child.props.grid as ElementPlacement['grid'])?.desktop.columnSpan ??
            child.props.span ??
            12),
    ),
    align: (child.props.align ??
      independentResponsiveValue('stretch')) as ElementPlacement['align'],
    grid: (child.props.grid ??
      independentGridArea({
        column: 1,
        row: 1,
        columnSpan: 12,
        rowSpan: 4,
      })) as ElementPlacement['grid'],
    element: elementFromData(child),
  };
}

export function sectionToData(section: SectionBlock): ComponentData {
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
        ...(section.gapPixels === undefined ? {} : { gapPixels: section.gapPixels }),
        ...(section.paddingPixels === undefined ? {} : { paddingPixels: section.paddingPixels }),
        ...(section.border === undefined ? {} : { border: section.border }),
        ...(section.stackAt === undefined ? {} : { stackAt: section.stackAt }),
        ...(section.backgroundMediaId ? { backgroundMediaId: section.backgroundMediaId } : {}),
        backgroundPosition: section.backgroundPosition,
        overlay: section.overlay,
      },
      content: section.items.map((placement) =>
        placementToData(placement, section.layout === 'grid' ? section.columns : 12),
      ),
    },
  };
}

export function dataToSection(item: ComponentData): SectionBlock {
  const settings = item.props.settings as SectionSettings;
  const content = (item.props.content ?? []) as ComponentData[];
  return {
    id: documentComponentId(item),
    type: 'section',
    ...settings,
    items: content.map((child) => placementFromData(child, settings.layout)),
  };
}

export function rootElementToSection(
  item: ComponentData,
  settings: SectionSettings,
  id: string = crypto.randomUUID(),
): SectionBlock {
  return {
    id,
    type: 'section',
    ...settings,
    items: [placementFromData(item, settings.layout)],
  };
}
