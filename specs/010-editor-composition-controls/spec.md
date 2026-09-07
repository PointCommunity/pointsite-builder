# Spec: Editor composition controls

## Objective

Make PointSite Builder's authoring controls match the page composition model: remove the redundant
Puck publish action, clarify saving, expose every current composition element, show an accurate grid
drop preview, make grid items resize from usable edges and corners, allow the built-in site header to
be removed and rebuilt from ordinary Image and Navigation elements, and bring Layout-style viewport
and zoom controls to the read-only Preview workspace.

## Assumptions

- "Publish" in the supplied screenshot is Puck's inner publish action. The Builder's separate
  staging-only Publish control remains because it opens the reviewed staging workflow.
- Existing drafts keep their built-in site header after migration. A per-page "Show built-in site
  header" control can remove it, after which ordinary Section, Image, and Navigation items can be
  composed in any page position.
- Navigation continues to read the globally edited link collection. The new element controls its
  local presentation, not a second copy of link data.
- The in-grid phantom applies while inserting an element from the toolbox. Existing placed elements
  continue to use the dedicated grid move surface.
- Manual preview zoom ranges from 25% to 200%; Auto fits the selected viewport to the available
  preview width without enlarging it beyond 100%.

## Tech stack

- React 19 and strict TypeScript
- Puck 0.23.0 visual editor
- Vitest and Testing Library
- Playwright cross-browser tests
- Zod versioned SiteDocument schema

## Commands

- Focused unit tests: `npm test -- tests/unit/grid-layout.test.ts tests/unit/document-versioning.test.ts tests/unit/renderer.test.tsx`
- Focused browser tests: `PLAYWRIGHT_PORT=4174 npx playwright test tests/e2e/authoring.spec.ts --project=desktop-chromium`
- Full tests: `npm test`
- Types: `npm run typecheck`
- Lint: `npm run lint -- --max-warnings=0`
- Build: `npm run build`
- Full browser suite: `PLAYWRIGHT_PORT=4174 npm run test:e2e`

## Project structure

- `src/client/editor/`: Puck registration, grid insertion preview, resize controls, page header toggle.
- `src/client/preview/`: read-only page/viewport/zoom toolbar and isolated renderer frame.
- `src/site-kit/`: versioned document schema, migrations, navigation renderer, grid behavior, styles.
- `tests/unit/`: schema, migration, renderer, and resize behavior.
- `tests/e2e/authoring.spec.ts`: real toolbar, drag/drop, resize, and header composition flows.
- `specs/010-editor-composition-controls/`: this implementation contract and execution record.

## Code style

Use explicit discriminated unions and shared pure grid functions:

```ts
export type GridResizeHandle =
  'north' | 'north-east' | 'east' | 'south-east' | 'south' | 'south-west' | 'west' | 'north-west';
```

## Testing strategy

- Add failing unit coverage for cardinal-edge resize and the v5-to-v6 header-visibility migration.
- Add renderer coverage for a hidden built-in header and an independently placed Navigation element.
- Add Chromium interaction coverage for the toolbar labels, visible drop phantom, pointer-following grid
  position, and cardinal resize handles.
- Update the existing cross-browser Preview scenario to exercise semantic viewport and zoom controls.
- Run all unit, type, lint, build, and cross-browser gates after focused tests pass.

## Boundaries

- Always: preserve static/read-only public rendering, staging-only publishing, exact draft data, safe
  links, keyboard alternatives, responsive output, and backward compatibility.
- Ask first: replace global navigation data, change the staging/production workflow, add dependencies,
  or convert all page chrome to page blocks.
- Never: expose repository credentials, enable Production publishing, or modify the Production
  PointSite repository as part of this work.

## Success criteria

- Puck's inner Publish button is absent; the outer staging Publish control remains for authorized
  roles; "Save now" is labeled "Save".
- Split Feature is visible and draggable from the left toolbox.
- Puck's insertion edge indicator is at least 6 CSS pixels thick and high contrast.
- Hovering a toolbox element over a grid hides the cursor clone and shows a labeled phantom at the
  actual snapped drop area; it follows the pointer and disappears when the pointer leaves the grid.
- Selected grid items have usable north, east, south, west, and corner resize handles. Cardinal
  handles are omitted only when the corresponding element dimension is too small to avoid overlap.
- Each page can hide the built-in header. Navigation is an ordinary element, and the existing Image
  element can be used for a logo in any section and page position.
- Existing v5 drafts migrate with the built-in header visible and retain all content.
- Preview keeps Live preview and page selection while adding phone, tablet, desktop, zoom out, zoom
  in, and Auto/manual percentage controls in one organized toolbar.

## Open questions

None. A future conversion of all page-level hero chrome into ordinary blocks is outside this request.
