# PointSite Builder Delivery Plan

## Active plan: Spec 013 editable page elements

The approved plan is recorded in dark-mode HTML at
[`specs/013-editable-page-elements/plan.html`](../specs/013-editable-page-elements/plan.html).
The user approved the assumptions and scope in
[`spec.html`](../specs/013-editable-page-elements/spec.html) on 2026-09-07. The dependency order is:

1. Verify and commit the pending Spec 012 Builder increment separately.
2. Write failing version-8 migration and page-ownership tests.
3. Implement deterministic page Hero migration and element rendering while preserving the centralized Footer.
4. Integrate Page Manager and the existing Hero catalog/inspector workflow.
5. Run full local and cross-browser verification.
6. Commit, push exact head, wait for GitHub Quality, deploy Builder production, and verify live.

The public PointSite repository and content-publishing workflow are out of scope.

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
