# Tasks: Standardized Section Composer

## Phase 1 - Contract and migration

- [ ] T001 [US2] Add schema v2 section/placement contracts in `src/site-kit/schema.ts`.
- [ ] T002 [US2] Add deterministic v1-to-v2 migration in `src/site-kit/migrations.ts`.
- [ ] T003 [US2] Convert the canonical default document to compatibility sections in `src/site-kit/default-site.ts`.
- [ ] T004 [US2] Add migration and default-document tests in `tests/unit/`.

## Phase 2 - Shared renderer

- [ ] T005 [US2] Add shared section renderer in `src/site-kit/registry.tsx` and `SiteRenderer.tsx`.
- [ ] T006 [US3] Add responsive section/grid tokens and embedded-element rules in `src/site-kit/site.css`.
- [ ] T007 [US2] Extend renderer/parity tests in `tests/unit/renderer.test.tsx` and Playwright.

## Phase 3 - Visual composer

- [ ] T008 [US1] Rebuild Puck data/config mapping around Section slots in `src/client/editor/VisualEditor.tsx`.
- [ ] T009 [US1] Add categorized Section and Element toybox groups in `VisualEditor.tsx`.
- [ ] T010 [US3] Add functional section and placement inspectors in `src/client/editor/`.
- [ ] T011 [US1] Update structure controls for sections and nested elements in `StructurePanel.tsx`.
- [ ] T012 [US5] Hide inapplicable legacy-variant fields and make remaining fields observable.

## Phase 4 - Builder theme

- [ ] T013 [US4] Add persistent default-dark theme state and switch in `src/client/`.
- [ ] T014 [US4] Add dark Builder and Puck design tokens without preview leakage in `app.css`.
- [ ] T015 [US4] Add default/persistence/isolation tests.

## Phase 5 - Verification and staging

- [ ] T016 Run formatting, lint, typecheck, contract, unit/integration, coverage, build, security, and performance checks.
- [ ] T017 Run Chromium/Firefox/WebKit authoring, responsive, accessibility, interaction, and visual-parity tests.
- [ ] T018 Perform internal-browser hands-on validation of the deployed private Builder.
- [ ] T019 Update and deploy staging only after Builder gates pass; verify against Production without changing Production.
- [ ] T020 Produce a dark-mode HTML verification report and record exact revisions/deployments.
