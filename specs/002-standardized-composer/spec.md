# Feature Specification: Standardized Section Composer

> This foundational specification remains valid for compatibility rendering. Its span-only layout
> is superseded by the schema v3 responsive grid workbench in `specs/004-grid-workbench/spec.md`.

**Feature**: 002-standardized-composer  
**Created**: 2026-09-05  
**Status**: Approved by implementation request

## User Scenarios & Testing

### US1 - Compose pages from sections and elements (P1)

An editor can add a blank or preset section, then drag supported elements into that section, reorder them, and edit every visible setting with immediate canvas feedback.

- **Given** a blank page, **when** a section and elements are inserted, **then** the saved draft and preview retain the same section hierarchy, content, and order.
- **Given** an element in a section, **when** its content or layout setting changes, **then** the editing canvas changes immediately and the standalone preview matches it.
- **Given** pointer dragging is inconvenient, **when** the editor uses the outline or move controls, **then** the same composition operations remain available.

### US2 - Preserve the current PointSite exactly (P1)

Every production-derived page is represented with the standardized section model while retaining the current rendered markup, styling, routes, content, and behavior.

- **Given** the canonical version-one document, **when** it is migrated, **then** every top-level legacy module becomes a standardized compatibility section without data loss.
- **Given** the migrated default document, **when** it is rendered, **then** production-parity screenshots stay within the existing visual threshold.

### US3 - Build responsive grid sections (P1)

An editor can choose a safe responsive section layout, set section width/background/spacing, and set each element's desktop span and vertical alignment. Mobile content stacks in document order.

- **Given** a grid section, **when** columns, gap, width, padding, or element span changes, **then** the canvas and preview update visibly.
- **Given** a phone viewport, **when** a multi-column section is viewed, **then** elements remain readable in one column without lost functionality or horizontal page scrolling.

### US4 - Use a dark Builder interface (P2)

The private Builder opens in dark mode by default. A user can switch to light mode, and that local preference persists without changing the authored site's theme.

### US5 - Trust every control (P1)

Every enabled inspector control has an observable effect on rendered output or composition. Controls that do not apply to a selected preset are not displayed.

## Requirements

- **FR-001**: Pages MUST persist standardized top-level sections containing ordered elements.
- **FR-002**: A migration MUST convert schema v1 documents to schema v2 deterministically and idempotently.
- **FR-003**: Compatibility sections MUST render their single migrated element without a visual wrapper.
- **FR-004**: New sections MUST support flow and 12-column responsive grid layouts with bounded presets.
- **FR-005**: Elements MUST support desktop spans of 1-12 columns and MUST stack to 12 columns below the site breakpoint.
- **FR-006**: The element library MUST group Sections, Content, Media, Collections, Engagement, and Spacing consistently.
- **FR-007**: Sections MUST accept elements but MUST NOT accept nested sections.
- **FR-008**: The Builder MUST default to dark mode and persist an optional light-mode preference locally.
- **FR-009**: Builder theme changes MUST NOT leak into the isolated site canvas or standalone preview.
- **FR-010**: Every enabled inspector control MUST alter output; variant-inapplicable controls MUST be hidden.
- **FR-011**: Dragging MUST have non-drag alternatives through the outline and existing structure controls.
- **FR-012**: Builder editing MUST be replaced by a width warning at 720 CSS pixels or less; authored sites remain responsive to 320 CSS pixels.
- **FR-013**: Drafts MUST remain backward compatible and validate at all API/storage boundaries.
- **FR-014**: Staging MAY be updated only after Builder validation passes; Production MUST remain unchanged.

## Key Entities

- **Section**: page-level container with layout, width, surface, spacing, and ordered element placements.
- **Element placement**: one existing content element plus desktop column span and vertical alignment.
- **Compatibility section**: deterministic one-element section that preserves legacy output exactly.
- **Builder preference**: local, non-sensitive dark/light UI selection independent of site theme.

## Success Criteria

- **SC-001**: 100% of default pages use standardized top-level sections after migration.
- **SC-002**: All thirteen existing element types can be inserted inside a blank section and survive save/reload.
- **SC-003**: Automated tests exercise every section setting, element placement setting, and visible inspector field.
- **SC-004**: Default migrated pages satisfy the existing production visual-parity threshold at desktop and mobile sizes.
- **SC-005**: No critical automated accessibility violations; all composition actions have keyboard-operable alternatives.
- **SC-006**: Full lint, type, unit/integration, contract, build, and cross-browser suites pass before staging deployment.

## Explicit Exclusions

- Arbitrary absolute positioning and overlap.
- Nested sections inside sections.
- Production repository, DNS, or Production deployment changes.
- Paid services or features requiring a payment card.
