# Spec: Editor focus retention

## Objective

Keep the active text control focused while controlled Builder data rerenders after each keystroke.
The reported FAQ Question field and every other repeated inspector editor must accept uninterrupted
typing.

## Root-cause hypothesis

Repeated inspector rows use editable values such as question text, card title, and button URL as
React keys. Each change therefore replaces the row DOM node and discards focus. Other Builder lists
use stable IDs or non-editable keys and do not share this failure mode.

## Commands

- Focused unit test: `npm test -- tests/unit/block-inspector.test.tsx`
- Focused browser test: `PLAYWRIGHT_PORT=4174 npx playwright test tests/e2e/authoring.spec.ts --grep "retains focus while typing" --project=desktop-chromium`
- Full gates: `npm test && npm run typecheck && npm run lint -- --max-warnings=0 && npm run build && PLAYWRIGHT_PORT=4174 npm run test:e2e`

## Project structure

- `src/client/editor/BlockInspector.tsx`: repeated content editors and their React identity.
- `tests/unit/block-inspector.test.tsx`: controlled-rerender focus regression coverage.
- `tests/e2e/authoring.spec.ts`: real Puck inspector typing flow.

## Code style

Use stable positional keys only for fixed-order lists that have no reordering behavior:

```tsx
{
  block.items.map((item, index) => <Row key={index}>...</Row>);
}
```

## Testing strategy

- Reproduce focus loss in a controlled rerender for FAQ questions, card titles, and repeated action
  links.
- Type a multi-character FAQ question through the real visual editor and assert the complete value
  plus retained focus.
- Audit every client-side mapped key; all text-editable repeated rows must use immutable IDs or a
  stable position.

## Boundaries

- Always: keep user-visible values and ordering unchanged.
- Ask first: add persistent IDs that require a schema migration.
- Never: suppress document updates or autosave merely to retain focus.

## Success criteria

- FAQ Question accepts continuous multi-character typing without another click.
- Card Title and repeated Button link controls retain focus during controlled rerenders.
- No mapped client editor is keyed by a text value edited inside that mapped row.
- Full unit and browser suites remain green.

## Open questions

None.
