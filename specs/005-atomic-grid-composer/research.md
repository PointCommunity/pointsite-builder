# Atomic Grid Composer Research

## Puck responsibility boundary

**Decision:** Keep Puck for editor chrome, slots, insertion, selection, history, and section ordering;
disable its `drag` permission only for placed element components and use the Point overlay for grid
movement.

**Rationale:** Puck 0.23 documents separate `insert` and `drag` permissions and identifies
`puck.dragRef` as the opt-in drag surface for inline advanced layouts. The reported behavior comes
from that drag surface competing with the custom coordinate controller.

**Alternative considered:** Replace Puck or introduce another layout library. Rejected because it
would duplicate editor state/history, increase bundle and migration risk, and is unnecessary for
the precise defect.

## Collision policy

**Decision:** Validate rectangle intersection before each move, resize, insert, or inspector commit;
retain the last valid area when a candidate overlaps a sibling.

**Rationale:** Native CSS Grid permits overlapping explicitly positioned items. The product does
not, so collision prevention belongs in the persisted placement model rather than CSS alone.

**Alternative considered:** Automatically push siblings. Rejected because it creates cascading,
hard-to-predict layout changes and complicates responsive overrides.

## Accessible drag equivalent

**Decision:** Keep arrow-key controls on move and resize surfaces plus exact numeric inspector
fields and section-height controls.

**Rationale:** Pointer-only drag is insufficient. WAI guidance calls for an equivalent keyboard or
form-control operation; ordinary buttons and labeled number fields preserve a familiar focus model.

## Atomic elements and recipes

**Decision:** Add standalone Text and Button elements and represent visual patterns as section
recipes that expand to normal children. Keep data-driven widgets (FAQ, forms, people, cards, maps)
as purpose-built elements.

**Rationale:** This removes locked visual arrangements without forcing authors to rebuild the
behavior of a form or accordion one HTML control at a time.

## Draft grid

**Decision:** Use explicit three-column desktop tracks with two- and one-column media queries.

**Rationale:** `auto-fit` expands a single grid item to fill all available tracks; explicit tracks
preserve stable card width and left alignment.

## Sources

- Puck permissions: https://puckeditor.com/docs/api-reference/permissions
- Puck component configuration: https://puckeditor.com/docs/api-reference/configuration/component-config
- Puck slot behavior: https://puckeditor.com/docs/api-reference/fields/slot
- MDN CSS Grid concepts: https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Grid_layout/Basic_concepts
- WAI ARIA grid guidance: https://www.w3.org/WAI/ARIA/apg/patterns/grid/
