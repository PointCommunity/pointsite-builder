# Spec: Structural section toolbox

## Objective

Make the Layout toolbox describe the builder's actual composition model. The Sections category
contains only empty structural containers. Designers assemble those containers from atomic
elements instead of inserting Point-authored preset recipes.

## Assumptions

- The existing recipe contents (heading, text, button, and image) are already available as atomic
  elements, so no replacement element types are required.
- Existing drafts remain compatible because recipe identity is insertion-only and is not stored in
  the site document.
- Saving reusable user-created recipes is a separate future feature and is not exposed in this
  change.

## Commands

- Focused browser test: `PLAYWRIGHT_PORT=4174 npx playwright test tests/e2e/authoring.spec.ts --grep "keeps the Sections toolbox structural" --project=desktop-chromium`
- Tests: `npm test`
- Types: `npm run typecheck`
- Lint: `npm run lint -- --max-warnings=0`
- Build: `npm run build`
- Full browser suite: `npm run test:e2e`

## Project structure

- `src/client/editor/VisualEditor.tsx`: Puck component registration and toolbox categories.
- `tests/e2e/authoring.spec.ts`: user-visible toolbox and composition behavior.
- `specs/007-structural-sections/`: requirements and implementation record.

## Code style

Use the existing strict TypeScript component registry and readonly section-name tuple:

```ts
const sectionTypes = [
  'Section',
  'TwoColumnSection',
  'ThreeColumnSection',
  'FullWidthSection',
] as const;
```

## Testing strategy

- Prove the old behavior by first asserting that preset recipe controls are absent.
- Verify all four structural section controls and every recipe constituent remain available.
- Run the full unit, type, lint, build, and cross-browser suites after the focused test passes.

## Boundaries

- Always: preserve existing draft data and the production rendering model.
- Ask first: introduce persisted recipe schemas, recipe CRUD, or a recipe library.
- Never: modify or deploy the public Production PointSite from this change.

## Success criteria

- The Sections category contains only blank grid, two-column, three-column, and full-width sections.
- Hero, image-and-text, and call-to-action preset recipe controls are absent.
- Heading, Text, Button, and Image remain available so every former recipe can be assembled manually.
- Existing drafts and staging rendering remain compatible without a schema migration.

## Open questions

None. User-created reusable recipes are deliberately deferred.
