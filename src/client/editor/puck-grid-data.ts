import type { ComponentData, Data } from '@puckeditor/core';

let latestData: Data | undefined;

export function rememberPuckData(data: Data): void {
  latestData = data;
}

export function currentPuckData(): Data | undefined {
  return latestData;
}

function isComponentData(value: unknown): value is ComponentData {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'type' in value &&
    'props' in value &&
    typeof (value as ComponentData).props === 'object',
  );
}

function findComponent(items: ComponentData[], componentId: string): ComponentData | undefined {
  for (const item of items) {
    if (String(item.props.id) === componentId) return item;
    for (const value of Object.values(item.props)) {
      if (!Array.isArray(value)) continue;
      const children = value.filter(isComponentData);
      const found = findComponent(children, componentId);
      if (found) return found;
    }
  }
  return undefined;
}

export function childComponents(
  data: Data | undefined,
  parentId: string,
  slotName = 'content',
): ComponentData[] {
  if (!data) return [];
  const parent = findComponent(data.content, parentId);
  const parentProps = parent?.props as unknown as Record<string, unknown> | undefined;
  const value = parentProps?.[slotName];
  return Array.isArray(value) ? value.filter(isComponentData) : [];
}

export function siblingComponents(data: Data | undefined, componentId: string): ComponentData[] {
  if (!data) return [];
  const search = (items: ComponentData[]): ComponentData[] | undefined => {
    if (items.some((item) => String(item.props.id) === componentId)) return items;
    for (const item of items) {
      for (const value of Object.values(item.props)) {
        if (!Array.isArray(value)) continue;
        const found = search(value.filter(isComponentData));
        if (found) return found;
      }
    }
    return undefined;
  };
  return search(data.content) ?? [];
}
