# Data Model: Standardized Section Composer

## SiteDocument v2

Each page keeps `blocks` for additive compatibility, but every v2 top-level entry is a `section`.

## Section

- `id`: UUID
- `type`: `section`
- `name`: editor-facing label
- `layout`: `compatibility | flow | grid`
- `columns`: `1 | 2 | 3 | 4 | 6 | 12`
- `gap`: `none | small | medium | large`
- `width`: `full | shell | narrow`
- `surface`: `transparent | canvas | surface | primary`
- `padding`: `none | small | medium | large`
- `items`: 0-60 ElementPlacements

## ElementPlacement

- `id`: UUID, independent from the element id
- `span`: integer 1-12
- `align`: `start | center | end | stretch`
- `element`: one of the thirteen existing element schemas

## Migration

Schema v1 page blocks are wrapped one-for-one in deterministic compatibility sections. The element payload and id remain unchanged. Section/placement ids are deterministically derived from the element UUID so repeated migrations produce byte-equivalent results.
