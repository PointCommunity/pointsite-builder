# PointSite Builder Delivery Plan

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
