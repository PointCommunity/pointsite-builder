# Spec: Editable Site Header

## Objective

Replace the fixed, non-interactable site header with ordinary canvas content. Every page that
currently shows the built-in header must instead begin with a grid section containing the Point
logo as an Image element and the current site menu as a Navigation element. Editors can select,
move, resize, remove, and reinsert either element using the existing grid composer.

The Navigation element remains backed by the site's shared navigation collection. Its inspector
must expose the menu editor so labels, links, dropdown children, and item order can be changed while
the element is selected.

## Tech Stack

- React 19 and TypeScript 5.9
- Puck 0.23 visual composer
- Zod SiteDocument schema and deterministic migrations
- Vitest, Testing Library, and Playwright

## Commands

- Focused unit tests: `npm test -- tests/unit/document-versioning.test.ts tests/unit/renderer.test.tsx`
- Focused browser test: `PLAYWRIGHT_PORT=4185 npx playwright test tests/e2e/authoring.spec.ts --grep "editable header" --project desktop-chromium`
- Type and style checks: `npm run format:check && npm run typecheck && npm run lint -- --max-warnings=0`
- Full verification: `npm run test:coverage && npm run build && PLAYWRIGHT_PORT=4185 npm run test:e2e`

## Project Structure

- `src/site-kit/`: versioned schema, migration, header-section factory, rendering, and styles.
- `src/client/editor/`: Puck section/element editing and page creation.
- `src/client/settings/NavigationEditor.tsx`: shared menu editor reused inside Navigation elements.
- `tests/unit/`: deterministic migration and renderer behavior.
- `tests/e2e/authoring.spec.ts`: editable header, logo, menu, drag, and grid-snap flow.

## Code Style

Use strict parsed document data and small deterministic helpers:

```ts
const page = document.pages.find((candidate) => candidate.id === pageId);
if (!page) return document;
page.blocks.unshift(createEditableHeaderSection(page.id, logoMediaId));
```

Follow repository Prettier and ESLint conventions. Use semantic controls and stable accessible
labels for all editor actions.

## Testing Strategy

- RED: prove a v6 document still renders a fixed header and lacks editable header items.
- GREEN: migrate v6 pages to v7 with no built-in header field and a deterministic header grid.
- Renderer tests assert the logo and Navigation are ordinary grid items, not `.site-header` chrome.
- Browser tests select both items, edit a menu, remove the logo, and drag Navigation to a snapped
  grid location.
- Run the complete repository suite after focused tests pass.

## Boundaries

- Always: preserve all page content and shared menu data; migrate deterministically; keep logo and
  menu independently movable/removable; preserve accessible public navigation.
- Ask first: change staging/production publishing, add dependencies, or make menu links independent
  layout blocks.
- Never: restore non-interactable header chrome, expose repository credentials, or change the public
  PointSite repository from this Builder task.

## Success Criteria

- No page renders the legacy fixed `.site-header`.
- Existing v6 pages that showed the header migrate to an editable full-width grid section.
- That section contains a Point logo Image item and a Navigation item with responsive placements.
- Both items use the existing grid drag, drop-preview, snapping, move, remove, and resize behavior.
- Selecting Navigation exposes editing for top-level links and dropdown children.
- New pages start with the same editable header composition.
- Pages whose built-in header was disabled remain without an injected header.
- Existing content and navigation survive migration unchanged.

## Open Questions

None. The menu group is one grid element; individual links are content within it.
