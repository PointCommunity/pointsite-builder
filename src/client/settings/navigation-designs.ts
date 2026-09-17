import type { NavigationEntry, SiteDocument } from '../../site-kit/types';
import { documentRegions } from '../../site-kit/document-sections';

export function navigationUsage(document: SiteDocument, designId: string) {
  return documentRegions(document).flatMap((page) =>
    page.blocks.flatMap((section) =>
      section.items.flatMap(({ element }) =>
        element.type === 'navigation' && element.navigationDesignId === designId
          ? [
              {
                pageId: page.id,
                pageTitle: page.title,
                elementId: element.id,
                label: element.label,
              },
            ]
          : [],
      ),
    ),
  );
}

/** Destination index is in the final sibling list, after removing the moved item. */
export function moveNavigationItem(
  items: NavigationEntry[],
  id: string,
  parentId: string | null,
  index: number,
): NavigationEntry[] {
  const parent = parentId ? items.find((item) => item.id === parentId) : undefined;
  const sourceParent = items.find((item) => item.children.some((child) => child.id === id));
  const top = items.find((item) => item.id === id);
  const item = top ?? sourceParent?.children.find((child) => child.id === id);
  if (!item || (parentId && !parent) || id === parentId || !Number.isInteger(index) || index < 0)
    return items;
  if (parent && top?.children.length) return items;
  const siblings = parent ? parent.children : items;
  const sameParent = (sourceParent?.id ?? null) === parentId;
  if (siblings.length - (sameParent ? 1 : 0) >= (parent ? 12 : 20)) return items;
  if (index > siblings.length - (sameParent ? 1 : 0)) return items;
  const next = items
    .filter((entry) => entry.id !== id)
    .map((entry) => ({ ...entry, children: entry.children.filter((child) => child.id !== id) }));
  if (parentId) {
    const target = next.find((entry) => entry.id === parentId)!;
    target.children.splice(index, 0, { id: item.id, label: item.label, href: item.href });
  } else next.splice(index, 0, { ...item, children: top?.children ?? [] });
  return next;
}
