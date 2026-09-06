# Atomic Grid Composer Specification

## Goal

Finish the visual-composer foundation so an author can reconstruct every current PointSite body
area from editable sections, atomic content elements, and purpose-built interactive widgets. The
canvas must use one predictable, collision-safe drag and resize model.

## Product boundaries

- Production PointSite remains untouched and publishing remains staging-only.
- Existing schema-v3 drafts remain readable and migrate without losing content.
- Existing production-compatible blocks remain renderable for backward compatibility, but visual
  composition blocks are not offered as new indivisible toolbox elements.
- Repeated-data and interactive widgets such as cards, people, FAQ, forms, and maps may remain
  purpose-built elements; visual arrangements such as heroes, split features, and calls to action
  must be composed from atomic elements.
- Pointer actions have keyboard and inspector equivalents.

## User stories

### US1 - Predictable section workbench (P1)

An author can size a section, place an element at a chosen grid location, drag the selected element
from anywhere inside its box, and resize it from any corner without Puck list reordering competing
with the grid interaction.

**Acceptance scenarios**

1. Given two non-overlapping elements, when one is moved toward the other, then the last valid
   non-overlapping position is retained.
2. Given a selected element, when its body is dragged one row upward, then its stored row decreases
   by one and its height is unchanged.
3. Given a selected element, when a north resize handle is dragged upward, then its row decreases
   and its height increases by the same snapped row count.
4. Given a section, when its bottom resize control is dragged or operated by keyboard, then the
   section's minimum row count changes and following sections remain in normal document flow.

### US2 - Atomic visual composition (P1)

An author can build a hero, split image-and-copy area, or call to action from a section plus atomic
heading, text, image, and hyperlink-button elements.

**Acceptance scenarios**

1. The toolbox offers Heading, Text, Image, and Button as independently insertable elements.
2. The Sections category contains only empty structural containers; authors create call-to-action,
   split-feature, and hero arrangements from independent atomic elements.
3. A Button exposes label, validated hyperlink, visual style, and width settings.
4. Existing compatibility content continues to render after schema migration.

### US3 - Safe containment and responsive placement (P1)

An author cannot accidentally overlap elements or bleed content outside its owning section.

**Acceptance scenarios**

1. Move, resize, inspector edit, and insertion all reject overlapping areas.
2. Every area remains within columns 1 through 12 and rows 1 through the configured limit.
3. Section height is never less than the lowest occupied row.
4. Element visual content is contained by its allocated grid rectangle.
5. Desktop, tablet, and phone placements use the same collision rules independently.

### US4 - Draft workspace density (P2)

Draft cards occupy at most three equal columns and never stretch across unused columns.

**Acceptance scenarios**

1. One desktop draft occupies the first column of a three-column grid.
2. Four desktop drafts occupy three columns on the first row and one on the second.
3. The grid collapses to two and one columns at content-driven tablet and phone widths.

### US5 - Staging sign-in handoff (P2)

An unauthenticated visitor to staging sees the protected-access message and a clear button that
opens `https://builder.pointatx.org` without granting any additional access.

## Functional requirements

- **FR-001** Placed grid elements MUST use custom grid movement rather than Puck list dragging.
- **FR-002** The full selected element rectangle MUST act as its move surface, excluding resize
  handles, with clear cursor and accessible instructions.
- **FR-003** Move, resize, insertion, and inspector updates MUST share one collision validator.
- **FR-004** Invalid placement MUST preserve the last valid area and announce why it was rejected.
- **FR-005** Every grid section MUST store an editable minimum row count and render at least the
  greater of that value or its occupied row count.
- **FR-006** Grid sections and grid items MUST contain visual overflow.
- **FR-007** The schema MUST add independently editable Text and Button elements.
- **FR-008** Button hyperlinks MUST use the existing safe-link policy.
- **FR-009** New visual composition MUST use atomic elements; legacy composite elements MUST be
  hidden from the new-element toolbox while remaining readable.
- **FR-010** Point-authored preset recipes MUST NOT appear in the Sections category. Reusable
  user-created recipes are a separate future feature.
- **FR-011** Drop placement MUST use the pointer's snapped grid position when available and fall
  back to the first collision-free area.
- **FR-012** Draft cards MUST use fixed one-, two-, or three-column responsive tracks.
- **FR-013** Builder and staging MUST use the same schema, renderer, and CSS implementation.
- **FR-014** The staging authentication gate MUST link to the canonical Builder URL and MUST retain
  the existing authorization check.

## Success criteria

- All four acceptance scenarios from the reported drag and resize defects pass in a real browser.
- Zero overlaps are present after any supported placement operation in automated property cases.
- Atomic Button links render and remain editable at desktop, tablet, and phone sizes.
- A single draft card is no wider than one third of the desktop draft grid, within one CSS pixel.
- Existing production-parity pages have no unintended visual regression before any author changes.
- Unit, integration, cross-browser E2E, build, security, and staging contract checks pass.

## Clarifications

- The current request defines atomic visual elements as the default authoring model. Purpose-built
  data/interactive widgets remain elements because decomposing their internal behavior would make
  them less usable, not more composable.
- Invalid collision moves use last-valid-position behavior rather than automatically pushing other
  content, which keeps placement deterministic and avoids surprising layout changes.
