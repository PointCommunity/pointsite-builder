# Tasks: PointSite Builder

## Active: Spec 019 isolated draft Staging coordination

- [x] T019-0 Audit the live pipeline, claim Issue #27, and record the approved contract and plan.
- [x] T019-1 Write failing lifecycle, preflight persistence, concurrency, recovery, and privacy tests.
- [x] T019-2 Add the backward-compatible preflight and publication-lease migration.
- [x] T019-3 Implement durable exact-revision preflight and atomic recoverable Staging claims.
- [x] T019-4 Expose sanitized availability and enforce server-side preflight/base/candidate rechecks.
- [x] T019-5 Implement the accessible one-click preflight, waiting, recovery, and republication flow.
- [x] T019-6 Prove multiple-draft isolation and slot coordination in browser and integration tests.
- [ ] T019-7 Run the full repository gates and local hands-on browser QA.
- [ ] T019-8 Push the PR, pass exact-head review and CI, merge identical tree, migrate, deploy, verify production, and present the PM Showcase.

**Review gate:** Issue #27 selected by the PM on 2026-09-08; final completion requires PM testing of the production Showcase.

## Foundation tasks (historical)

**Spec**: `specs/001-pointsite-builder/spec.md`  
**Plan**: `specs/001-pointsite-builder/plan.md`  
**Execution**: dependency order; each task includes acceptance, verification, and a maximum five-file change surface.

## Phase 1: Setup and governance

- [x] T001 Configure strict TypeScript, Vite/Worker, lint, format, Vitest, coverage, and Playwright manifests. (QR-001)
  - Acceptance: exact dependencies install on Node 22 and all empty quality commands run.
  - Verify: `npm ci && npm run typecheck && npm run lint && npm run test -- --run && npm run build`.
  - Files: `package.json`, `package-lock.json`, `tsconfig.json`, `vite.config.ts`, `eslint.config.js`.
- [x] T002 Add safe configuration, ignore rules, example variables, Wrangler environments, and generated bindings.
  - Acceptance: local config contains no secret; production integration is absent; transient browser/media files are ignored.
  - Verify: configuration tests and `git status --ignored` inspection.
  - Files: `.gitignore`, `.dev.vars.example`, `wrangler.jsonc`, `worker-configuration.d.ts`.
- [x] T003 Add CI for format, lint, types, tests/coverage, build, secret/SCA/SAST scans, and artifacts.
  - Acceptance: pull requests cannot pass with a failing required stage and permissions are least privilege.
  - Verify: action syntax validation and first branch run.
  - Files: `.github/workflows/quality.yml`, `.github/dependabot.yml`, `.github/CODEOWNERS`, `.pre-commit-config.yaml`, `docs/security-scanning.html`.
- [x] T004 Record ADRs for repository isolation, visual editor, storage, auth, renderer distribution, and production gates in dark-mode HTML.
  - Acceptance: every architectural decision has context, decision, consequences, and alternatives.
  - Verify: ADR index and link check.
  - Files: `docs/adr/0001-architecture-decisions.html`, `docs/adr/index.html`.

## Phase 2: Foundational contracts

- [x] T005 [US2] Write failing schema tests for strict fields, route uniqueness, URL safety, component discriminators, and bounds. (FR-004-FR-009, FR-017)
  - Acceptance: tests fail because implementation does not exist.
  - Verify: focused Vitest command reports expected failures.
  - Files: `tests/unit/site-document.test.ts`, `tests/fixtures/site-documents.ts`.
- [x] T006 [US2] Implement SiteDocument, theme, navigation, forms, collections, and block schemas.
  - Acceptance: T005 passes and unknown/unsafe data is rejected with field paths.
  - Verify: focused tests plus typecheck.
  - Files: `src/site-kit/schema.ts`, `src/site-kit/types.ts`, `src/site-kit/url-policy.ts`.
- [x] T007 [US2] Write failing canonicalization, checksum, and migration tests.
  - Acceptance: v1 fixtures and unordered equivalent documents specify deterministic behavior.
  - Verify: focused tests fail for missing functions.
  - Files: `tests/unit/document-versioning.test.ts`, `tests/fixtures/v1-document.json`.
- [x] T008 [US2] Implement canonical serialization, SHA-256 checksum, schema migration registry, and renderer version identity.
  - Acceptance: equivalent content has one checksum; supported old drafts migrate once; unknown future versions fail closed.
  - Verify: T007 plus deterministic repeat run.
  - Files: `src/site-kit/canonicalize.ts`, `src/site-kit/migrations.ts`, `src/site-kit/version.ts`.
- [x] T009 [US2] Build the exact initial PointSite document and asset mapping.
  - Acceptance: every existing route, navigation entry, organization field, form, collection, and asset reference is represented.
  - Verify: fixture coverage test against production source inventory.
  - Files: `src/site-kit/default-site.ts`, `tests/unit/default-site.test.ts`, `scripts/audit-production-content.mjs`.
- [x] T010 [US2] Write failing renderer registry and safe-output tests for all required blocks. (FR-005, FR-006)
  - Acceptance: tests cover unknown block rejection, escaping, links, headings, images, forms, maps, and non-drag metadata.
  - Verify: focused tests fail for missing registry/renderer.
  - Files: `tests/unit/renderer.test.tsx`, `tests/fixtures/block-data.tsx`.
- [x] T011 [US2] Implement public block registry, explicit variants, token mapping, renderer, and public styles.
  - Acceptance: all required blocks render from validated data using semantic tokens and native controls.
  - Verify: T010, component tests, and build.
  - Files: `src/site-kit/registry.tsx`, `src/site-kit/SiteRenderer.tsx`, `src/site-kit/site.css`, `src/site-kit/tokens.ts`.

## Phase 3: Persistence and authorization slice

- [x] T012 Add failing migration and repository contract tests for roles, drafts, revisions, idempotency, jobs, approvals, audit, and media.
  - Acceptance: constraints and atomic compare-and-swap behavior are specified before SQL.
  - Verify: migration/repository tests fail as expected.
  - Files: `tests/integration/repositories.test.ts`, `tests/fixtures/database.ts`.
- [x] T013 Implement D1 migrations with indexes, retention fields, immutable revision constraints, and rollback notes.
  - Acceptance: fresh and repeat migration succeed; invalid references/duplicates fail.
  - Verify: local D1 migration and T012 database constraint cases.
  - Files: `migrations/0001_initial.sql`, `docs/rollback/0001_initial.sql`, `migrations/meta.json`.
- [x] T014 Implement typed D1 repositories and in-memory test adapters.
  - Acceptance: draft save atomically inserts a revision and advances only the expected pointer; all writes emit audit records.
  - Verify: T012 passes at least once against D1-compatible local storage and fakes.
  - Files: `src/server/repositories/d1.ts`, `src/server/repositories/memory.ts`, `src/server/repositories/contracts.ts`.
- [x] T015 Write failing authentication and role matrix tests. (FR-001, FR-002, FR-003)
  - Acceptance: missing, forged, expired, revoked-collaborator, inactive-role, and insufficient-role cases are represented.
  - Verify: focused tests fail before middleware exists.
  - Files: `tests/unit/auth.test.ts`, `tests/unit/github-oauth.test.ts`.
- [x] T016 Implement GitHub App OAuth, signed HttpOnly sessions, live collaborator verification, local-only auth adapter, actor context, and role middleware.
  - Acceptance: T015 passes; development bypass cannot activate outside local environment.
  - Verify: auth tests, typecheck, and production-config negative test.
  - Files: `src/server/auth/github.ts`, `src/server/auth/roles.ts`, `src/server/config.ts`.
- [x] T017 Implement consistent API errors, request IDs, security headers, same-origin/Fetch-Metadata controls, JSON bounds, and per-actor rate policy. (FR-017, FR-027)
  - Acceptance: every endpoint returns one safe error shape; mutations reject cross-site or oversized input.
  - Verify: middleware contract tests and header probe.
  - Files: `src/server/http/errors.ts`, `src/server/http/security.ts`, `tests/unit/http-security.test.ts`.
- [x] T018 Implement Worker routing, health, identity, paginated draft list, create, read, and save APIs from the OpenAPI contract. (FR-004, FR-010-FR-012)
  - Acceptance: Viewer reads; Editor mutates; stale `If-Match` fails; idempotent retry returns prior result.
  - Verify: API integration and contract tests.
  - Files: `src/server/index.ts`, `src/server/routes/drafts.ts`, `tests/integration/draft-api.test.ts`.
- [x] T019 Implement revision list, label, restore, archive, recover, and delete APIs. (FR-011-FR-013)
  - Acceptance: restore creates a new revision; history is immutable and paginated.
  - Verify: revision API integration tests.
  - Files: `src/server/routes/revisions.ts`, `tests/integration/revision-api.test.ts`.

## Phase 4: Authoring UI slice

- [x] T020 Build application shell, routing, identity loading, skip link, error boundary, loading/empty/denied states, and responsive navigation.
  - Acceptance: role-appropriate navigation is semantic and keyboard reachable at 320-1280 widths.
  - Verify: component tests and initial axe checks.
  - Files: `src/client/App.tsx`, `src/client/app.css`, `src/client/main.tsx`, `index.html`.
- [x] T021 Build draft picker and create/duplicate/archive flows against the API.
  - Acceptance: Editor can manage drafts; Viewer gets read-only affordances; long/empty/error states are usable.
  - Verify: component and API-backed browser tests.
  - Files: `src/client/drafts/DraftList.tsx`, `src/client/drafts/DraftActions.tsx`, `src/client/api.ts`, `tests/unit/draft-list.test.tsx`.
- [x] T022 Build EditorProvider state/actions/meta contract, five-second autosave, offline retry, unload guard, and conflict recovery.
  - Acceptance: saving state is announced; acknowledged data survives reload; stale data is never overwritten.
  - Verify: fake-timer and integration tests for saved/offline/conflict flows.
  - Files: `src/client/editor/EditorProvider.tsx`, `src/client/editor/useAutosave.ts`, `tests/unit/autosave.test.tsx`.
- [x] T023 Integrate Puck as a lazy editor canvas with typed registry, explicit viewports, inspector, outline, and preview.
  - Acceptance: required modules can be added/configured/reordered without shipping Puck on non-editor routes.
  - Verify: build chunk inspection and editor browser test.
  - Files: `src/client/editor/VisualEditor.tsx`, `src/client/editor/puck-config.tsx`, `src/client/editor/EditorRoute.tsx`.
- [x] T024 Add non-drag structure controls, focus management, status announcements, and mobile sheets.
  - Acceptance: every block operation works by buttons/keyboard without drag and focus remains predictable.
  - Verify: keyboard Playwright test and manual accessibility matrix.
  - Files: `src/client/editor/StructurePanel.tsx`, `src/client/editor/MobilePanels.tsx`, `tests/e2e/editor-keyboard.spec.ts`.
- [x] T025 Build global site, metadata, navigation, footer, forms, collections, and theme editors. (FR-007-FR-008)
  - Acceptance: every seeded current PointSite surface is editable through bounded fields.
  - Verify: coverage audit and whole-site authoring E2E.
  - Files: `src/client/settings/SiteSettings.tsx`, `src/client/settings/NavigationEditor.tsx`, `src/client/settings/ThemeEditor.tsx`, `src/client/settings/CollectionsEditor.tsx`.
- [x] T026 Build responsive same-renderer preview and preset gallery. (FR-014, QR-005)
  - Acceptance: preview uses the exact document/renderer identity at 360, 768, 1280; current Point and overhaul presets are available.
  - Verify: deterministic component snapshots and browser screenshots.
  - Files: `src/client/preview/Preview.tsx`, `src/site-kit/presets.ts`, `tests/e2e/preview.spec.ts`.
- [x] T027 Build revision history, labeling, comparison metadata, and restore confirmation UI.
  - Acceptance: an Editor can inspect paginated history and restore as a new revision without losing the current revision.
  - Verify: browser restore flow and focus-return test.
  - Files: `src/client/revisions/RevisionHistory.tsx`, `src/client/revisions/RestoreDialog.tsx`, `tests/e2e/revisions.spec.ts`.

## Phase 5: Private media and administration

- [x] T028 Write failing media validation, quota, access, reference, and retention tests. (FR-015-FR-016)
  - Acceptance: supported signatures and every rejection/orphan path are specified.
  - Verify: focused tests fail before service exists.
  - Files: `tests/unit/media-policy.test.ts`, `tests/integration/media-api.test.ts`.
- [x] T029 Implement private chunked-D1 media service, signature/dimension validation, hard capacity cap, random keys, deduplication, authorized reads, and lifecycle transitions.
  - Acceptance: only ready media with alt text can attach; bytes are never public by default.
  - Verify: T028 passes with chunked D1 and local Worker binding.
  - Files: `src/server/media/policy.ts`, `src/server/media/service.ts`, `src/server/routes/media.ts`.
- [x] T030 Build accessible upload and media library UI with progress, retry, validation, alt text, and selection.
  - Acceptance: empty/upload/rejected/ready/orphan states work at all target widths.
  - Verify: media component and E2E tests with fixture images.
  - Files: `src/client/media/MediaLibrary.tsx`, `src/client/media/MediaUpload.tsx`, `tests/e2e/media.spec.ts`.
- [x] T031 Implement role administration, paginated audit view, and capacity estimates/warnings. (FR-003, FR-026, FR-028)
  - Acceptance: only Administrators mutate roles; role removal applies next request; audit excludes payloads/secrets; 70 percent warnings are visible.
  - Verify: authorization integration tests and admin browser flow.
  - Files: `src/server/routes/admin.ts`, `src/client/admin/AdminRoute.tsx`, `src/client/admin/RoleTable.tsx`, `src/client/admin/AuditView.tsx`.
- [x] T032 Implement revision/media/audit retention maintenance and export-safe reporting.
  - Acceptance: dry-run is default; named/current data is preserved; every deletion is audited.
  - Verify: retention unit/integration tests with fixed clock.
  - Files: `src/server/maintenance/retention.ts`, `tests/unit/retention.test.ts`, `scripts/maintenance.mjs`.

## Phase 6: Staging renderer and deployment

- [x] T033 Add staging governance, production-remote documentation, branch safety, Worker static deployment config, and CI without changing production.
  - Acceptance: staging is independent/private; deployment target is staging-only; current baseline checks pass.
  - Verify: staging repo audit, lint/build, production status check.
  - Files: `pointsite-staging/AGENTS.md`, `pointsite-staging/wrangler.jsonc`, `pointsite-staging/.github/workflows/quality.yml`, `pointsite-staging/.github/workflows/deploy-staging.yml`.
- [x] T034 Vendor exact site-kit snapshot and canonical PointSite document into staging.
  - Acceptance: snapshot version/checksum matches builder; production routes/content are represented.
  - Verify: package checksum and migration tests in both repositories.
  - Files: `pointsite-staging/site-kit/*`, `pointsite-staging/content/builder-site.json`, `pointsite-staging/scripts/sync-site-kit.mjs`.
- [x] T035 Integrate builder document renderer into staging static export while preserving static/read-only forms and base-path safety. (FR-009, FR-030)
  - Acceptance: all routes export from JSON; no API/database/auth code enters public site bundle.
  - Verify: PointSite expert verification plus exported-route/source scan.
  - Files: `pointsite-staging/app/page.tsx`, `pointsite-staging/app/[slug]/page.tsx`, `pointsite-staging/components/BuilderSite.tsx`, `pointsite-staging/app/globals.css`.
- [x] T036 Add exact-candidate staging verification script for routes, assets, content checksum, accessibility, headers, and live probes.
  - Acceptance: one command produces bounded JSON evidence and fails on any mandatory check.
  - Verify: deliberate bad fixture fails, restored candidate passes.
  - Files: `pointsite-staging/scripts/verify-staging.mjs`, `pointsite-staging/tests/staging-contract.test.ts`, `pointsite-staging/package.json`.

## Phase 7: GitHub publishing and staging acceptance

- [x] T037 Write failing GitHub App, allowlist, base-SHA, response-validation, idempotency, and job-state tests. (FR-018-FR-020, FR-023-FR-025)
  - Acceptance: staging success/failure/retry/drift and all production-disabled cases are specified.
  - Verify: focused tests fail before client/service exists.
  - Files: `tests/unit/github-client.test.ts`, `tests/integration/publish-service.test.ts`, `tests/fixtures/github.ts`.
- [x] T038 Implement GitHub App token exchange and strictly validated GitHub client for staging-only file commits. (FR-019)
  - Acceptance: short-lived token, exact installation, response schemas, path allowlist, and base SHA are enforced.
  - Verify: T037 client cases pass without real secrets.
  - Files: `src/server/github/app-auth.ts`, `src/server/github/client.ts`, `src/server/github/schemas.ts`.
- [x] T039 Implement resumable, idempotent staging publish jobs and deterministic candidate package. (FR-018-FR-020)
  - Acceptance: same revision/key creates one result; failed steps resume; one job runs; evidence is exact.
  - Verify: T037 service cases and local fake-GitHub integration.
  - Files: `src/server/publish/candidate.ts`, `src/server/publish/service.ts`, `src/server/routes/publish.ts`.
- [x] T040 Build staging publish panel, exact candidate review, progress, failure recovery, and evidence display.
  - Acceptance: only Publishers act; exact revision/checksum/base are visible; buttons cannot imply production availability.
  - Verify: permission and publish browser tests.
  - Files: `src/client/publish/StagingPublish.tsx`, `src/client/publish/JobStatus.tsx`, `tests/e2e/publish-staging.spec.ts`.
- [x] T041 Implement staging acceptance and invalidation rules bound to the full candidate tuple. (FR-021-FR-022)
  - Acceptance: only complete passing evidence accepts; any tuple or production-base drift invalidates.
  - Verify: approval state-machine unit/integration tests.
  - Files: `src/server/approvals/service.ts`, `src/server/routes/approvals.ts`, `tests/unit/approvals.test.ts`.
- [x] T042 Implement production endpoint as a compile-time and runtime hard-disabled capability with no repository or credential fields. (FR-023)
  - Acceptance: endpoint and UI both report `PRODUCTION_DISABLED`; network spy proves no GitHub production call.
  - Verify: unit, integration, and browser negative tests.
  - Files: `src/server/publish/production-disabled.ts`, `src/client/publish/ProductionLocked.tsx`, `tests/integration/production-lock.test.ts`.

## Phase 8: Quality, security, and staging operations

- [x] T043 Run and remediate the source web-design checklist over all builder UI files.
  - Acceptance: each scoped file has a pass or fixed line-specific finding.
  - Verify: guideline search, lint, component suite, `git diff --check`.
  - Files: `tests/reports/web-design-audit.html`, affected `src/client/*` files only.
- [x] T044 Complete automated and manual WCAG 2.2 AA evidence matrix including keyboard, zoom/reflow, contrast, reduced motion, and screen-reader spot checks. (QR-002, QR-004)
  - Acceptance: no critical/serious automated findings; manual outcomes are recorded without unsupported conformance claims.
  - Verify: Playwright axe suite plus signed evidence report.
  - Files: `tests/accessibility/*.spec.ts`, `tests/reports/accessibility.html`.
- [x] T045 Complete cross-browser, responsive, visual, offline, conflict, permission, and adversarial UX journeys.
  - Acceptance: Chromium, Firefox, and WebKit primary flows pass at target widths; pragmatic UX findings are remediated.
  - Verify: Playwright projects and screenshot review.
  - Files: `tests/e2e/*.spec.ts`, `playwright.config.ts`, `tests/reports/ux.html`.
- [x] T046 Complete performance and free-capacity verification. (QR-003, QR-006)
  - Acceptance: API p95 target passes at expected load; bundle/CWV budgets and 70 percent warnings are evidenced.
  - Verify: repeatable load script, bundle report, Lighthouse on deployed staging.
  - Files: `tests/performance/api-load.mjs`, `tests/reports/performance.html`, `vite.config.ts`.
- [x] T047 Complete threat-model controls, secret/history scan, SCA, SAST, DAST, and least-privilege CI review.
  - Acceptance: no critical/high unresolved vulnerability; all TM-01-TM-12 controls have evidence.
  - Verify: security workflow and dark-mode HTML report.
  - Files: `.github/workflows/security.yml`, `tests/reports/security.html`, affected security code only.
- [x] T048 Create and verify dark-mode HTML operator handbook, backup/restore, credential rotation, failed-publish, quota, staging rollback, and production rollback runbooks. (FR-029)
  - Acceptance: each procedure has prerequisites, safe command, expected result, stop condition, and recovery.
  - Verify: link/HTML validation and non-destructive drill.
  - Files: `docs/operator-handbook.html`, `scripts/verify-runbooks.mjs`.

## Phase 9: Remote staging and production gates

- [x] T049 Authenticate Cloudflare, retain Workers Free and D1 only, apply migrations, seed the GitHub administrator identity, register a staging-only GitHub App, and store secrets.
  - Acceptance: resources exist in the intended church account; no R2/Zero Trust subscription, payment action, production installation, or production secret exists; local secret scan remains clean.
  - Verify: Wrangler resource listings, role readback, GitHub installation readback.
  - Files: remote resources plus `wrangler.jsonc` IDs only.
- [x] T050 Deploy builder and staging Workers to non-public temporary state, then enable only custom hosts protected by GitHub App authentication before testing content.
  - Acceptance: anonymous, wrong-identity, revoked-collaborator, expired-session, and alternate-host probes fail closed; approved admin succeeds.
  - Verify: curl/browser authentication matrix and Worker deployment readback.
  - Files: remote Cloudflare configuration only.
- [x] T051 Deploy an exact candidate through the builder and complete staging acceptance/rollback drill.
  - Acceptance: exact revision to exact staging commit passes every required check; retry is idempotent; rollback restores known-good.
  - Verify: job/audit/evidence records and live protected browser run.
  - Files: staging candidate commit and evidence records.
- [x] T052 Add protected custom hostnames only after authentication tests pass.
  - Acceptance: `builder.pointatx.org` and `staging.pointatx.org` are protected, HTTPS-valid, and direct Worker hosts remain protected.
  - Verify: DNS/API readback and anonymous/authenticated probes.
  - Files: remote Cloudflare DNS/Worker/Access configuration only.
- [ ] T053 Prepare production only after G5 evidence: reconcile head, configure protections/minimal App installation, and create exact candidate PR. (FR-024)
  - Acceptance: production was untouched before G5; PR matches candidate; no direct main push; drift forces restaging.
  - Verify: GitHub settings, PR diff, required checks, candidate checksum.
  - Files: production branch/PR only after separate gate.
- [ ] T054 Publish only after exact-candidate approval; watch exact Pages run, verify cache-busted live routes/assets/metadata, and preserve rollback evidence.
  - Acceptance: approved SHA is live and all production acceptance checks pass; rollback remains tested and ready.
  - Verify: GitHub Actions, Pages API, public route/CSS/media probes, browser suite.
  - Files: approved production merge and audit evidence.

## Phase 10: Production-parity recovery (staging only)

- [x] T055 Specify and test the canonical Point Classic page chrome and module variants. (FR-033, FR-034)
  - Acceptance: failing tests identify every production route/content surface and require production-compatible structure in both canvas and renderer.
  - Verify: focused Vitest tests fail before implementation and pass afterward.
  - Files: `src/site-kit/schema.ts`, `src/site-kit/default-site.ts`, `tests/unit/default-site.test.ts`, `tests/unit/renderer.test.tsx`, `tests/unit/foundation.test.tsx`.
- [x] T056 Replace the approximate canvas/preview renderer with one canonical responsive SiteFrame.
  - Acceptance: editor canvas, preview, and staging use the same header, page hero, modules, footer, semantic tokens, typography, and responsive behavior.
  - Verify: focused component tests, typecheck, build, and browser screenshots.
  - Files: `src/site-kit/SiteRenderer.tsx`, `src/site-kit/registry.tsx`, `src/site-kit/site.css`, `src/site-kit/tokens.ts`, `src/client/editor/VisualEditor.tsx`.
- [x] T057 Enforce live GitHub repository permission independently from Builder roles. (FR-001, FR-032)
  - Acceptance: read/triage collaborators can create and edit drafts; only write/maintain/admin plus Publisher/Admin can publish or accept.
  - Verify: auth, route, and permission E2E tests including permission revocation on the next request.
  - Files: `src/server/auth/github.ts`, `src/server/auth/roles.ts`, `src/server/routes/publish.ts`, `src/server/routes/approvals.ts`, `tests/unit/auth.test.ts`.
- [x] T058 Sync the exact renderer/default document to staging and add deterministic parity gates.
  - Acceptance: all current routes build from builder JSON and production/staging screenshots match at 360, 768, and 1280 pixels with only documented environment exclusions.
  - Verify: staging unit/E2E suite, screenshot comparison, and exact site-kit checksum.
  - Files: `pointsite-staging/site-kit/*`, `pointsite-staging/content/builder-site.json`, `pointsite-staging/tests/e2e/staging.spec.ts`, `pointsite-staging/tests/e2e/parity.spec.ts`.
- [ ] T059 Complete hands-on staging acceptance through the deployed Builder.
  - Acceptance: every editor surface/control and public route/navigation/form/menu/link works; staging was published from an immutable Builder revision; Production is unchanged.
  - Verify: full Builder and staging suites, CI, live browser matrix, security scans, and production repository SHA/status comparison.
  - Files: staging candidate/evidence only; no production files.

## Dependencies and completion rule

- T001-T004 establish governance and tooling.
- T005-T011 block all persisted authoring.
- T012-T019 block the application UI.
- T020-T027 complete the primary authoring journey.
- T028-T032 add media and administration.
- T033-T036 complete staging's renderer/deployment consumer.
- T037-T042 complete staging publication and the production lock.
- T043-T048 are mandatory remediation/evidence gates.
- T049-T052 require authenticated external Cloudflare/GitHub setup.
- T053 requires fresh G5 acceptance and production-preparation approval.
- T054 requires approval for the exact PR/head produced by T053.

The builder is ready for protected staging testing when T001-T052 are checked.
T053-T054 remain a separate, explicitly approved production promotion gate.

## Phase 11: Builder preview and workspace repair

- [x] T060 Reproduce and guard Builder-to-site style leakage. (FR-035, SC-011)
  - Acceptance: regression checks prove Point Classic text, background, and button colors are not overridden by Builder light/dark or form-control rules.
  - Verify: focused Playwright test fails before implementation and passes afterward.
  - Files: `tests/e2e/authoring.spec.ts`, `src/client/app.css`, `src/client/main.tsx`.
- [x] T061 Build a true isolated responsive live preview. (FR-014, FR-036, QR-005)
  - Acceptance: the selected 360, 768, or 1280 width is the rendered document viewport, uses the canonical SiteRenderer, and reaches the complete footer.
  - Verify: focused component and Playwright tests at all three widths.
  - Files: `src/client/preview/Preview.tsx`, `src/client/preview/SitePreviewFrame.tsx`, preview tests.
- [x] T062 Constrain the editor and make all four authoring panes independently scrollable. (FR-037, FR-038, QR-004)
  - Acceptance: no document-level authoring scroll; page panel, module catalog, canvas, and inspector independently reach their final content; widths at or below 720 show only the warning.
  - Verify: focused Playwright geometry, scrolling, keyboard, 720/721 boundary, and axe checks.
  - Files: `src/client/editor/EditorRoute.tsx`, `src/client/editor/VisualEditor.tsx`, `src/client/app.css`, `tests/e2e/authoring.spec.ts`.
- [x] T063 Complete the repair validation and Builder-only rollout. (SC-006, SC-011)
  - Acceptance: full unit, integration, contract, lint, type, build, browser, accessibility, security, and authenticated live checks pass; staging and Production repository heads/content are unchanged.
  - Verify: local quality matrix, exact-head CI/deploy, authenticated internal-browser screenshots and measurements, and repository SHA comparison.
  - Files: Builder implementation/evidence only; no staging or Production files.

The Builder and staging feature is complete when every applicable staging task,
including T059-T063, has current evidence. T053-T054 remain an intentionally
separate production-promotion gate and are never implied by Builder completion.
