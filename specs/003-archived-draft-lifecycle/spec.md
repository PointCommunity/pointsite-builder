# Spec: Archived Draft Lifecycle Controls

## Objective

Restore complete, safe lifecycle controls to archived draft cards so an Editor can continue using
an archived draft without losing visibility or accidentally deleting it. Archived cards remain in
the workspace and expose Open editor, Duplicate, Unarchive, and Delete actions. Delete is available
only after archive and requires the exact case-sensitive confirmation text `DELETE`.

## User Scenarios and Acceptance

### US1 - Recover an archived draft (P1)

Given an Editor sees an archived draft, when they activate Unarchive, then the same card becomes
active without a page reload and again exposes Archive.

### US2 - Safely delete an archived draft (P1)

Given an Editor sees an archived draft, when they activate Delete, then an accessible confirmation
dialog identifies the draft and requires the exact text `DELETE`. Lowercase or mixed-case input
does not enable confirmation. A successful confirmation removes the soft-deleted draft from the
visible workspace.

### US3 - Preserve normal card actions (P1)

Given an archived draft, its Open editor and Duplicate actions remain available. Given a Viewer,
mutation actions remain absent and the card offers preview access only.

## Functional Requirements

- **FR-001**: Active editable cards MUST expose Open editor, Duplicate, and Archive.
- **FR-002**: Archived editable cards MUST expose Open editor, Duplicate, Unarchive, and Delete.
- **FR-003**: Archiving and unarchiving MUST update the card in place without requiring reload.
- **FR-004**: Delete MUST be visually destructive while retaining the existing PointSite Builder
  design system.
- **FR-005**: Delete MUST open an accessible confirmation dialog that names the target draft.
- **FR-006**: Delete confirmation MUST require the exact case-sensitive value `DELETE`; the server
  MUST independently reject missing or mismatched confirmation.
- **FR-007**: Only archived drafts MAY transition to deleted; active drafts MUST first be archived.
- **FR-008**: Delete remains a recoverable soft delete under the existing 30-day retention policy.
- **FR-009**: Server authorization, origin, content type, rate, idempotency, and audit controls MUST
  continue to apply to every lifecycle mutation.
- **FR-010**: Public PointSite, staging content, Production source, and Production deployment MUST
  remain unchanged.

## Tech Stack

React 19, TypeScript, Hono, Zod, D1/in-memory repositories, Vitest, Testing Library, and Playwright.

## Commands

- Focused unit/integration: `npx vitest run tests/unit/draft-list.test.tsx tests/integration/revision-api.test.ts`
- Full tests: `npm test`
- Static checks: `npm run format:check && npm run lint && npm run typecheck`
- Contract: `npm run contract:lint`
- Build: `npm run build`
- Browser flow: `npx playwright test tests/e2e/authoring.spec.ts`

## Project Structure

- `src/client/drafts/` - draft-card and confirmation-dialog presentation.
- `src/client/App.tsx` - lifecycle state orchestration.
- `src/client/api.ts` - typed lifecycle requests.
- `src/server/routes/revisions.ts` - validated lifecycle API.
- `src/server/repositories/` - allowed state transitions and audit persistence.
- `tests/unit/`, `tests/integration/`, `tests/e2e/` - behavior evidence.

## Code Style

Use strict TypeScript, semantic buttons/forms, async callbacks that return updated records, and
design tokens instead of ad-hoc colors. Example: `setDrafts(items => items.map(item => item.id ===
updated.id ? updated : item))`.

## Testing Strategy

Start with failing UI and API regression tests. Cover card action visibility, case-sensitive dialog
validation, cancel behavior, server input validation, active-delete rejection, lifecycle persistence,
and the full browser flow. Finish with the complete repository test and build gates.

## Boundaries

- Always: preserve authentication/authorization, audit events, soft-delete retention, and staging-only publishing.
- Ask first: changing retention duration or adding permanent-delete behavior.
- Never: modify or deploy Production PointSite, weaken confirmation, expose deleted drafts publicly,
  or add paid infrastructure.

## Success Criteria

- Every archived card displays four actions for Editors: Open editor, Duplicate, Unarchive, Delete.
- Unarchive immediately restores active state.
- Delete cannot be confirmed for any value except exact `DELETE` in both UI and API.
- Deleted cards disappear from the default draft list and remain soft-deleted for retention.
- Focused, full, contract, static, build, accessibility, and browser checks pass.

## Open Questions

None. The user supplied the interaction, confirmation text, casing rule, and visual intent.
