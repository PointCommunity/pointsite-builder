# PointSite Builder Delivery Plan

## Active plan: Spec 019 isolated draft Staging coordination

The PM-selected Issue #27 plan is recorded in dark-mode HTML at
[`specs/019-isolated-draft-staging/plan.html`](../specs/019-isolated-draft-staging/plan.html).
The approved Issue requirements are specified in
[`spec.html`](../specs/019-isolated-draft-staging/spec.html). The dependency order is:

1. Lock the preflight, availability, lease, privacy, and migration contracts.
2. Prove the absent lifecycle and concurrency behavior with failing tests.
3. Add append-only preflight evidence and a recoverable atomic Staging claim.
4. Expose sanitized server state and require exact preflight before publication.
5. Implement one-click private preflight, busy-slot recovery, and replacement language.
6. Complete browser, migration, full-gate, review, and release verification.

The public PointSite repository and Production publication remain out of scope.

## Foundation plan (historical)

The authoritative implementation plan is
[`specs/001-pointsite-builder/plan.md`](../specs/001-pointsite-builder/plan.md).

Execution uses contract-first, risk-first vertical slices:

1. Schema, deterministic serialization, and renderer contract.
2. Authenticated draft create/read/save/restore through UI and API.
3. Whole-site authoring and private media.
4. Staging-only GitHub publication and exact evidence.
5. Staging acceptance and rollback.
6. Separately authorized production preparation and exact publication.

Every slice follows red, green, refactor, full required checks, and an atomic
commit. Production configuration is not present in slices 1-5.
