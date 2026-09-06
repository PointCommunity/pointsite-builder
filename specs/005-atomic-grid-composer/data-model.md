# Atomic Grid Composer Data Model

## SiteDocument v4 additions

### SectionBlock

- `minRows`: integer 1-100; minimum grid height controlled by the author.
- Existing `items` remain the only children. Sections remain ordered page blocks and therefore
  cannot overlap one another.

### TextElement

- `id`, `type: text`, `text`, `style: body | lead | eyebrow | small`, `align: left | center`.

### ButtonElement

- `id`, `type: button`, `label`, `href`, `style: primary | secondary | quiet`,
  `width: fit | full`, `align: left | center | right`.

### Grid area invariant

For every breakpoint, an area is valid only when it is in bounds and does not intersect any sibling
area. Section rendered rows are `max(minRows, max(item.row + item.rowSpan - 1))`.

## Migration

- v3 to v4 adds `minRows` equal to the occupied rows for grid sections and `1` otherwise.
- All legacy element payloads remain unchanged and valid.
- Recipe identity is never persisted; recipe insertion returns an ordinary section with ordinary
  child placements.
