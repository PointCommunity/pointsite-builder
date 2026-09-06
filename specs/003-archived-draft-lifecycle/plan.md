# Plan: Archived Draft Lifecycle Controls

## Context and Constitution Check

This is a bounded repair to an existing React/Hono/D1 workflow. It preserves the public read-only
site, staging-only publish boundary, server-side authorization, audit trail, and soft-delete model.
No dependency, migration, paid service, staging-content, or Production change is required.

## Implementation Order

1. Add failing UI and API tests for archived controls, exact typed confirmation, and safe transitions.
2. Tighten the lifecycle API contract to require `{ "confirmation": "DELETE" }` and reject deletion
   unless the draft is archived.
3. Add the accessible confirmation dialog and all archived-card controls.
4. Update App state in place after archive/unarchive and remove only successfully deleted drafts.
5. Update the OpenAPI contract and foundational lifecycle documentation.
6. Run focused, full, static, contract, build, security, and cross-browser checks.
7. Validate the deployed Builder flow separately; do not alter staging content or Production.

## Risks and Mitigations

- Accidental deletion: archive-first transition, exact server-validated phrase, disabled submit.
- UI/server drift: shared literal confirmation contract plus unit, integration, contract, and E2E tests.
- Lost card state: callbacks return the server record and replace by stable draft ID.
- Accessibility regression: labeled modal, initial focus, Escape/cancel, focus return, axe/browser test.

## Verification Checkpoints

- Red: new tests fail against current behavior.
- Green: focused UI/API tests pass.
- Regression: full Vitest and Playwright suites pass.
- Release: deployed Builder reproduces archive, unarchive, case rejection, cancellation, and delete.
