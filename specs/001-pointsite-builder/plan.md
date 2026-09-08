# Implementation Plan: PointSite Builder

**Branch**: `codex/001-pointsite-builder` | **Date**: 2026-09-05 | **Spec**: `spec.md`

## Summary

Deliver a private full-stack visual site builder whose typed, versioned JSON
document controls all PointSite content, pages, modules, navigation, and theme.
GitHub App OAuth authenticates every deployed request and current staging
collaboration is rechecked server-side; D1 stores role mappings, drafts, immutable
revisions, jobs, approvals, audit records, and chunked private draft media. The
same least-privilege GitHub App promotes exact candidates to an isolated staging
repository, then only after separate gates opens a production pull request.

## Technical Context

**Language/Version**: TypeScript 5.9 on Node.js 22; Cloudflare Workers runtime  
**Primary Dependencies**: React 19, Puck 0.23, Vite 8, Cloudflare Vite plugin, Hono 4, Zod 4, jose 6  
**Storage**: Cloudflare D1 only; chunked BLOB media and in-memory adapters for deterministic tests
**Testing**: Vitest 4 with V8 coverage, Testing Library, Playwright, axe-core, TypeScript, ESLint, npm audit  
**Target Platform**: Cloudflare Workers Free; evergreen Chromium, Firefox, WebKit  
**Project Type**: Full-stack web application plus shared site-kit package  
**Performance Goals**: API p95 below 500 ms at 10 admin sessions; editor feedback below 100 ms  
**Constraints**: 100,000 Worker requests/day; 5 million D1 rows read/day; 100,000 D1 rows written/day; 500 MB per D1 database; private media warning at 250 MB; one-second text-action completion; serialized action autosave; one publish job/environment
**Scale/Scope**: One church site, up to 50 pages, 18,250 expected action revisions/year (50/day), 1,000 media assets, 10 simultaneous administrators

## Constitution Check

| Principle                | Status | Evidence                                                           |
| ------------------------ | ------ | ------------------------------------------------------------------ |
| Spec-first traceability  | Pass   | Requirements and task coverage are explicit                        |
| Production isolation     | Pass   | No production configuration in initial deployment; hard allowlists |
| Controlled design system | Pass   | Typed Puck registry and schema; no code fields                     |
| Security and privacy     | Pass   | Signed GitHub sessions, live collaboration checks, server roles    |
| Test before promotion    | Pass   | Exact-candidate gates and complete test matrix                     |
| Recoverable operations   | Pass   | Immutable revisions, idempotency, audit, rollback                  |
| Free-first controls      | Pass   | Debounce, quotas, retention, concurrency limits                    |

No constitutional exception is required.

## Architecture

```text
Authenticated browser
        |
GitHub App OAuth
        |
pointsite-builder Worker + static UI
   |                        |
  D1                 GitHub App installation
 drafts + roles       staging repository only
 jobs + audit                 |
 private media            staging Worker
                                |
                       acceptance evidence
                                |
                    production gate (disabled)
                                |
                  production branch + reviewed PR
```

### Trust boundaries

1. GitHub OAuth establishes identity; signed HttpOnly sessions and current
   staging-repository collaboration are revalidated server-side.
2. D1 role lookup authorizes every request; client state never grants permission.
3. Media is private and served through authorized, bounded endpoints.
4. GitHub installations issue short-lived tokens and targets are hard-allowlisted.
5. Production variables, repository ID, installation ID, and UI actions are absent
   until the production-preparation gate.
6. Workers and D1 remain on hard-limited free plans. R2 and Zero Trust are absent;
   no deployment step may add a subscription or payment method.

## Project Structure

```text
src/
├── client/                 # React shell, routes, editor, admin views
├── server/                 # Worker API, auth, persistence, publish services
├── site-kit/               # schema, defaults, registry, renderer, styles
└── shared/                 # transport contracts and errors
migrations/                 # D1 migrations
scripts/                    # seed, packaging, quota and verification tools
tests/
├── unit/
├── integration/
├── contract/
├── e2e/
├── accessibility/
└── reports/
specs/001-pointsite-builder/
```

The staging repository adds a vendored `site-kit` snapshot, canonical
`content/builder-site.json`, static rendering integration, and a Worker static
assets deployment configuration. The production repository is not modified before
staging acceptance.

## Delivery Gates

### G0 — Specification and governance

- Repositories exist privately.
- Constitution, specification, research, model, contracts, tasks, and audit pass.

### G1 — Staging baseline

- Production source is copied into independent staging.
- Current site verifies unchanged before migration.
- Staging protections and deployment configuration exist without production writes.

### G2 — Shared schema and renderer

- SiteDocument schema, migration, registry, default PointSite document, and renderer
  reproduce current routes and styling.
- Old drafts remain renderable through explicit migrations.

### G3 — Private authoring

- Access-aware role enforcement, draft CRUD, autosave, revision restore, preview,
  theme/navigation/page editor, media, quota, audit, and admin views work.

### G4 — Staging publishing

- GitHub App creates deterministic staging candidates only.
- Exact build/deploy/probe evidence returns to the job.
- Protected staging passes usability, a11y, responsive, failure, and rollback drills.

### G5 — Staging acceptance

- Every requirement through staging has evidence for one immutable candidate.
- Production remains unchanged and builder has no production access.

### G6 — Production preparation (separate gate)

- Reconcile production head and protect `main`.
- Add minimal production GitHub App installation and environment allowlist.
- Generate exact branch/PR from accepted candidate; rerun checks.

### G7 — Publication (exact-candidate gate)

- Merge only the approved PR/head through required checks.
- Watch exact Pages workflow and verify cache-busted live routes/assets.
- Record evidence and retain tested rollback.

## Testing Strategy

- Unit: schema, sanitization, checksums, permissions, reducer/state, quota math.
- Integration: D1 repositories and media lifecycle, GitHub OAuth/session, GitHub client,
  concurrency, idempotency, rollback state.
- Contract: OpenAPI request/response validation and permission matrix.
- Component: editor controls, saving states, errors, keyboard alternatives.
- E2E: sign-in boundary, create/edit/reload/restore, conflicts, preview widths,
  media, staging job, disabled production.
- Accessibility: axe plus manual keyboard/focus and contrast checks.
- Visual: Point preset and redesigned preset at 360, 768, 1280 widths.
- Security: dependency audit, secret scan, unsafe input/upload tests, origin/rate tests.
- Performance: bundle budget, Lighthouse, and API load at expected concurrency.
- Deployment: exact staging commit/workflow/URL/assets and exact production Pages run.

## Failure and rollback design

- Saves are append-only revisions followed by an atomic draft-pointer update.
- GitHub writes use the expected base SHA; mismatch creates a visible conflict.
- Publish jobs persist before external calls and resume from recorded step state.
- Staging rollback redeploys the previously accepted candidate.
- Production rollback is a reviewed revert of the exact release PR followed by live
  verification; drafts and staging history are unaffected.

## Deployment prerequisites

- Interactive Cloudflare authentication or scoped API token.
- Zone access for `pointatx.org` and an active Zero Trust organization.
- Approved administrator identities or team for Access.
- GitHub App registration and staging-only installation.
- Production preparation and publication approvals at their exact gates.

## Complexity Tracking

No constitution violations. Separate repositories, database, object storage, and
GitHub integration are required by isolation, recoverability, media, and review
requirements rather than speculative scale.

## Parity Recovery Plan

1. Record the production route/content/style inventory and add failing renderer,
   seed, canvas, and GitHub-permission tests.
2. Extend the backward-compatible SiteDocument presentation contract so page
   chrome and approved module variants are explicit editable data.
3. Make the editing canvas, preview, and staging consume one SiteFrame and one
   Point Classic stylesheet; remove the approximate parallel rendering path.
4. Rebuild the default document from every current production content surface,
   then sync the exact site-kit snapshot to staging.
5. Add deterministic production-versus-staging screenshot comparison at 360,
   768, and 1280 pixels, plus hands-on interaction coverage for every editor
   surface and the GitHub read-versus-write publication boundary.
6. Deploy Builder first, create a new immutable parity-baseline draft, publish it
   through Builder to staging, and run the full local, CI, live, security, and
   browser acceptance matrix. Production remains read-only throughout.

## Preview and Workspace Repair Plan

1. Add failing browser checks for Builder-to-site style leakage, true responsive
   preview widths, final-control reachability, independent pane scrolling, and the
   provisional 720-pixel authoring warning.
2. Isolate Builder chrome styles from every rendered `.point-site` subtree and
   keep Puck's iframe synchronized only with renderer-safe host styles.
3. Render the standalone live preview in a same-origin isolated frame so its CSS
   media queries use the selected 360, 768, or 1280 pixel viewport.
4. Constrain the editor shell to one visible viewport and give the outer page
   panel plus Puck's catalog, canvas, and inspector their own scroll containers.
5. Run focused red-green browser checks, the complete local quality matrix, then
   deploy only the Builder and repeat authenticated hands-on checks. Staging and
   Production content remain unchanged.
