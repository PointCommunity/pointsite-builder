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

Drafts serialize completed authoring actions into immutable revision history with
content-free action attribution, stable idempotency, bounded retries, and visible
recovery states. Publish jobs are idempotent, conflict-aware, attributable to an
authenticated actor, and recoverable through a documented rollback path.

### VII. Free-first with explicit capacity controls

The initial service stays within Cloudflare and GitHub free allowances by limiting
autosave frequency, media size, retention, and publish concurrency. Exceeding a
defined warning threshold must fail visibly or trigger an explicit upgrade choice;
it must not silently incur cost.

## Project Capabilities

### Action-based draft autosave

- The browser coalesces active text until a one-second pause or blur and queues
  each other completed authoring action immediately.
- Exactly one save request is in flight. Each queued snapshot retains order and a
  stable idempotency key across bounded retries.
- Revision rows may carry finite `action_category` and `action_context` values;
  legacy rows remain readable with null attribution.
- `PUT /api/drafts/{draftId}` requires content-free action metadata and rejects a
  canonical draft document above 1,500,000 bytes.

## Code Patterns

### Established patterns

- Action boundaries are derived at the authoring surface; transient pointer frames
  update local preview state, while only the final pointer action enters autosave.
- D1 revision, draft-pointer, audit, and idempotency writes are one guarded batch.
  A losing compare-and-swap writes no partial audit or idempotency record.
- Save status uses one restrained live region. Conflict and terminal states retain
  the pending document and require a successful recovery copy before discard or
  loading a newer server revision.

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

| Version | Date       | Changes                                |
| ------- | ---------- | -------------------------------------- |
| 1.1.0   | 2026-09-07 | Added action-based autosave capability |
| 1.0.0   | 2026-09-05 | Initial PointSite Builder governance   |

**Version**: 1.1.0 | **Ratified**: 2026-09-05 | **Last Amended**: 2026-09-07
