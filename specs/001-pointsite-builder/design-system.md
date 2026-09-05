# Design System Contract

## Design read

Reading this as an internal visual-authoring application for nontechnical church
administrators, with a calm, direct, high-trust product language grounded in the
existing Point green, warm neutral surfaces, strong typography, and real church
content.

The builder is a dense product interface, so the marketing-oriented taste playbook
does not control its shell. Design-system and accessibility guidance do. The taste
guidance applies to the public page presets administrators compose.

## Working dials

| Surface              | Variance | Motion |                                                    Density | Reason                                                       |
| -------------------- | -------: | -----: | ---------------------------------------------------------: | ------------------------------------------------------------ |
| Builder shell        |        3 |      2 |                                                          6 | Predictable controls, restrained feedback, efficient editing |
| Current Point preset |        5 |      2 |                                                          3 | Brand-preserving photography and generous public layout      |
| Overhaul presets     |      6-8 |    2-5 | More expressive public layouts within accessibility bounds |

## Token layers

### Primitive

- Neutral scale from warm white to charcoal; no pure black.
- Point green scale anchored at `#3e522c`.
- Status palettes for info, success, warning, and danger.
- Four-pixel spacing base with 4, 8, 12, 16, 24, 32, 48, and 64 steps.
- Radius scale of 2, 4, 8, and full; controls default to 4.
- Motion durations of 0, 120, and 200 ms; only transform and opacity animate.

### Semantic

- Text: primary, secondary, muted, inverse, link.
- Surface: canvas, panel, raised, selected, inverse.
- Border: default, strong, focus, error.
- Action: primary, secondary, quiet, destructive.
- Status: saving, saved, offline, warning, error, accepted.

### Component

Component-level tokens exist only for editor canvas scale, Puck panel width,
sticky command bar, overlay layers, and public preview isolation.

## Builder component contracts

- `AppShell`: skip link, site header, route navigation, main region, status region.
- `DraftPicker`: searchable summaries, explicit empty/loading/error states.
- `EditorWorkspace`: structure panel, isolated preview canvas, inspector, command bar.
- `SaveStatus`: text plus icon for saving/saved/offline/conflict/error; polite live region.
- `ViewportSelector`: radio group for 360, 768, and 1280 previews.
- `PublishPanel`: exact revision identity, validation checklist, typed confirmation,
  permission-aware actions, progress, retry, and evidence link.
- `RevisionHistory`: paginated timeline, label action, restore confirmation.
- `MediaLibrary`: paginated grid/list, upload status, alt text, validation, orphan state.
- `RoleAdmin`: tabular identities and roles with inline validation and audit attribution.

Each contract includes default, hover, focus-visible, active, selected, disabled,
loading, empty, error, success, long-content, and permission-denied states where
applicable.

## Public block registry

- Hero: image or color surface, eyebrow, heading, body, up to two actions.
- Heading: level, alignment, width, and optional supporting text.
- Rich text: safe structured paragraphs, lists, emphasis, links, and quotations.
- Image: local/private media, aspect, fit, caption, and required alternative.
- Split feature: media/content side, proportions, vertical alignment, tone.
- Call to action: heading, body, action, surface.
- Cards: two to four structured items; intentional uneven layouts are preset-owned.
- People: named records with role, photo, and accessible alternative.
- FAQ: native details/summary with controlled initial state.
- Form: approved mailto form definition; no private response storage.
- Map: approved location/query only, lazy load, descriptive title.
- Divider and spacer: semantic section separation and bounded spacing.

Blocks use discriminated union types. Structural variants are explicit components,
not boolean-prop matrices. Unknown types or fields are rejected.

## Responsive behavior

- Builder supports 320, 360, 768, 1024, and 1280 CSS-pixel widths.
- Below 768, structure and inspector become modal sheets and the preview fills the
  viewport. Every drag/reorder operation also has Move Up, Move Down, Move Into,
  and Move Out controls.
- Touch targets are at least 44 by 44 CSS pixels.
- Safe-area insets are applied to fixed controls; no horizontal page scroll.
- Public high-variance layouts collapse to an intentional single-column order.

## Theme behavior

- Builder follows system light/dark preference and offers a persisted non-sensitive
  local preference under a versioned key. No identity or draft data enters local storage.
- Public site theme is an explicit site setting. Presets define both light and dark
  token mappings if an automatic theme is offered.
- Native controls declare `color-scheme`; focus, form, and CTA contrast is checked in
  every supported theme.

## Performance rules

- Puck and media-management code load only on editor routes.
- Preview updates use deferred rendering when document changes are expensive.
- Components are declared at module scope; effect dependencies are primitive and narrow.
- Images have dimensions/aspect reservation; below-fold media is lazy.
- No barrel import from large icon/component packages without measured tree shaking.

## Evidence

- Component tests for supported states and explicit variants.
- Keyboard walkthrough for every primary flow and non-drag alternative.
- Axe runs plus manual WCAG matrix at all supported viewports.
- Deterministic screenshots for current Point and overhaul presets.
- At least one staging consumer build for the exact site-kit snapshot.
