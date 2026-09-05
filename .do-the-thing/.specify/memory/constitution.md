# PointSite Builder Constitution

## Core Principles

### I. Spec-first, traceable delivery

Every capability must map from a testable requirement to an implementation task
and acceptance evidence. Specifications define behavior; plans define technology.

### II. Production isolation by construction

The builder, its default configuration, credentials, and GitHub installation must
have no production write capability before staging acceptance and a separate
production-preparation gate. Public PointSite remains static and read-only.

### III. Controlled design system

Administrators compose validated components, content, navigation, and design
tokens. Arbitrary JavaScript, unrestricted HTML, and direct source editing are not
part of the visual editor.

### IV. Security and privacy by default

All builder, API, preview, and staging traffic fails closed behind Cloudflare
Access. Authorization is enforced server-side. Secrets and unpublished data never
enter public artifacts, logs, or production history.

### V. Test before promotion

Core logic maintains at least 80 percent statement coverage. Required unit,
integration, contract, accessibility, responsive, build, and security checks must
pass for the exact candidate before promotion.

### VI. Recoverable, auditable operations

Drafts autosave with immutable revision history. Publish jobs are idempotent,
conflict-aware, attributable to an authenticated actor, and recoverable through a
documented rollback path.

### VII. Free-first with explicit capacity controls

The initial service stays within Cloudflare and GitHub free allowances by limiting
autosave frequency, media size, retention, and publish concurrency. Exceeding a
defined warning threshold must fail visibly or trigger an explicit upgrade choice;
it must not silently incur cost.

## Mandatory Gates

1. No implementation without an accepted specification and consistency audit.
2. No staging deployment without local validation and a clean candidate commit.
3. No production credential or repository permission before staging acceptance.
4. No production merge without exact-head approval and successful required checks.
5. No completion report without live verification or a truthful external blocker.

## Governance

Constitution amendments require a documented rationale, semantic version change,
and a renewed consistency audit. Principle changes are major; capabilities are
minor; wording corrections are patch updates.

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2026-09-05 | Initial PointSite Builder governance |

**Version**: 1.0.0 | **Ratified**: 2026-09-05 | **Last Amended**: 2026-09-05
