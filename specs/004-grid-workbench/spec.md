# PointSite Grid Workbench Specification

## Goal

Make the Content canvas an intuitive website workbench: authors drag categorized sections and
elements from a toolbox, position them on a responsive 12-column grid, resize them with visible
handles, and edit the footer directly without changing the established PointSite appearance.

## Non-negotiable boundaries

- Production PointSite is read-only during development and acceptance.
- Existing compatibility sections render byte-for-byte equivalent markup and styling.
- Builder publishing remains staging-only.
- Grid dots appear only while inserting, moving, or resizing.
- Every pointer action has an inspector control for keyboard and assistive-technology users.
- The canvas remains vertically extensible; no page-level scrollbar traps the toolbox or inspector.

## Functional requirements

### FR-001 Element toolbox

- Present friendly, categorized section and element names.
- Explain that elements must be dropped into a section.
- Provide useful presets: blank, two-column, three-column, and full-width.
- A newly inserted element receives a sensible size and the first available grid position.

### FR-002 Twelve-column workbench

- Every new grid section uses twelve equal columns.
- Selected grid elements expose a move handle and four corner resize handles.
- Pointer movement and resizing snap to column and square-row increments.
- The grid surface may grow downward as elements are moved or added.
- Selection, movement, and resizing must not activate links or forms in the site preview.

### FR-003 Responsive layout

- Store desktop, tablet, and mobile placement overrides independently.
- Tablet and mobile initially inherit the desktop placement.
- Editing a non-desktop viewport creates or changes only that viewport's override.
- Renderer breakpoints match the editor viewports and fall back to desktop values when no override
  exists.

### FR-004 Inspector and accessibility

- The inspector exposes column, row, width, height, and vertical alignment.
- Values are constrained so an item cannot extend past column twelve.
- The inspector never requires horizontal scrolling at supported editor widths.
- Move and resize handles have accessible names, focus indicators, and keyboard arrow behavior.

### FR-005 Footer editing

- The footer is selectable in the canvas.
- Selecting its edit affordance opens and focuses the footer settings.
- Footer content continues to be global across pages.

### FR-006 Compatibility and staging

- Schema v2 drafts migrate deterministically to schema v3.
- Compatibility sections remain visually identical after migration.
- The staging renderer accepts schema v3 before any schema v3 draft can be published.

## Acceptance criteria

1. Dragging an image into a two-column preset occupies six of twelve columns, not the full row.
2. An element can be moved and resized by pointer; its persisted coordinates match the snapped
   result after reload.
3. The same element can have distinct desktop, tablet, and mobile coordinates.
4. Grid dots are absent while idle and visible during insert, move, and resize.
5. Inspector fields remain fully visible with no horizontal overflow.
6. Footer selection opens its editable global settings.
7. Existing Production-parity pages remain visually unchanged in Builder preview and staging.
8. Unit, integration, accessibility, browser, schema migration, build, and staging verification pass.
