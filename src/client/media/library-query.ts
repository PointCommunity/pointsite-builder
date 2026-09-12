import type { LibraryItem } from '../../shared/library';

export const librarySorts = {
  'added-desc': 'Date Added: newest first',
  'added-asc': 'Date Added: oldest first',
  'updated-desc': 'Date Updated: newest first',
  'updated-asc': 'Date Updated: oldest first',
  'name-asc': 'Name: A–Z',
  'name-desc': 'Name: Z–A',
  'usage-desc': 'Most Used',
  'usage-asc': 'Least Used',
} as const;
export type LibrarySort = keyof typeof librarySorts;

export function libraryResults(
  items: LibraryItem[],
  archived: boolean,
  keyword: string,
  sort: LibrarySort,
): LibraryItem[] {
  const query = keyword.trim().toLocaleLowerCase();
  const date = (value: string) => Date.parse(value) || 0;
  return items
    .filter(
      (item) =>
        Boolean(item.archivedAt) === archived &&
        [
          item.displayName,
          item.filename,
          item.sourcePath,
          item.url,
          item.altText,
          ...item.tags,
          item.mediaType,
        ]
          .join(' ')
          .toLocaleLowerCase()
          .includes(query),
    )
    .sort((left, right) => {
      let difference = 0;
      if (sort.startsWith('name'))
        difference = left.displayName.localeCompare(right.displayName, undefined, {
          sensitivity: 'base',
        });
      else if (sort.startsWith('added')) difference = date(left.createdAt) - date(right.createdAt);
      else if (sort.startsWith('updated'))
        difference = date(left.updatedAt) - date(right.updatedAt);
      else difference = (left.usageCount || 0) - (right.usageCount || 0);
      return (sort.endsWith('desc') ? -difference : difference) || left.id.localeCompare(right.id);
    });
}

export function libraryTags(value: string): string[] {
  return [
    ...new Set(
      value
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ].slice(0, 20);
}
