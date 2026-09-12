import { libraryResults, type LibrarySort } from '../../src/client/media/library-query';
import type { LibraryItem } from '../../src/shared/library';

const item = (id: string, change: Partial<LibraryItem> = {}): LibraryItem => ({
  id,
  mediaType: 'image',
  sourceType: 'managed',
  displayName: id,
  filename: `${id}.png`,
  sourcePath: `/assets/${id}.png`,
  url: `/assets/${id}.png`,
  altText: 'Austin skyline',
  tags: ['City'],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-02-01T00:00:00Z',
  archivedAt: null,
  usageCount: 0,
  deleteBlockers: [],
  ...change,
});

it('searches every safe field with trimmed case-insensitive keywords in both archive views', () => {
  const items = [item('a'), item('b', { archivedAt: '2026-03-01T00:00:00Z' })];
  for (const keyword of ['  AUSTIN  ', 'CITY', '.png', '/assets/', 'IMAGE']) {
    expect(libraryResults(items, false, keyword, 'name-asc').map((entry) => entry.id)).toEqual([
      'a',
    ]);
    expect(libraryResults(items, true, keyword, 'name-asc').map((entry) => entry.id)).toEqual([
      'b',
    ]);
  }
  expect(libraryResults(items, false, 'missing', 'name-asc')).toEqual([]);
});

it.each<[LibrarySort, string[]]>([
  ['added-desc', ['b', 'a']],
  ['added-asc', ['a', 'b']],
  ['updated-desc', ['a', 'b']],
  ['updated-asc', ['b', 'a']],
  ['name-asc', ['a', 'b']],
  ['name-desc', ['b', 'a']],
  ['usage-desc', ['b', 'a']],
  ['usage-asc', ['a', 'b']],
])('supports %s ordering', (sort, expected) => {
  const items = [
    item('b', { createdAt: '2026-02-01', updatedAt: '2026-01-01', usageCount: 2 }),
    item('a'),
  ];
  expect(libraryResults(items, false, '', sort).map((entry) => entry.id)).toEqual(expected);
});

it('keeps ties deterministic and never truncates inventories beyond 100 items', () => {
  const items = Array.from({ length: 130 }, (_, index) =>
    item(String(index).padStart(3, '0')),
  ).reverse();
  const result = libraryResults(items, false, '', 'usage-desc');
  expect(result).toHaveLength(130);
  expect(result[0]?.id).toBe('000');
  expect(
    libraryResults(
      [item('b', { createdAt: '' }), item('a', { createdAt: '' })],
      false,
      '',
      'added-desc',
    ).map((entry) => entry.id),
  ).toEqual(['a', 'b']);
});
