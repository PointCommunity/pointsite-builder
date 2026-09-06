# Atomic Grid Composer Implementation Plan

## Technical context

- Runtime: Node.js 22+, React 19, TypeScript 5.9, Puck 0.23.
- Rendering: shared React site-kit and native CSS Grid in Builder and PointSite staging.
- Persistence: versioned `SiteDocument` JSON saved through the existing draft API.
- Tests: Vitest, Testing Library, Playwright across the existing browser matrix.
- Constraints: staging-only publishing, backward-compatible schema migration, WCAG 2.2 AA target,
  no new paid service or runtime dependency.

## Implementation order

1. Add collision, containment, drop-coordinate, and minimum-section-row pure functions with failing
   unit tests.
2. Add schema v4 section sizing plus atomic Text and Button elements and deterministic v3 migration.
3. Replace conflicting placed-element dragging with one canvas move/resize controller and section
   resize controls.
4. Offer only empty structural sections and normal atomic children in the toolbox.
5. Update toolbox categories and inspectors; hide legacy visual-composition blocks from insertion.
6. Render atomic elements and contained sections identically in Builder and staging.
7. Correct the draft-card grid to fixed responsive one/two/three tracks.
8. Add a canonical Builder button to the unauthenticated staging gate without changing its access
   decision.
9. Run focused red/green checks, the full repository suite, hands-on browser scenarios, staging
   checks, and production-parity comparison.

## Architecture decisions

- Puck owns selection, fields, slots, history, and section ordering.
- The Point grid controller exclusively owns coordinates for already-placed grid elements.
- Placement is committed only through a shared resolver that clamps bounds and rejects collisions.
- Reusable recipes are deferred; no recipe type or recipe identity is persisted.
- Legacy composite blocks remain in the discriminated union solely for backward compatibility.

## Compatibility and rollout

- Schema 3 migrates to schema 4 by adding section minimum rows and preserving every existing block.
- The shared staging site-kit is updated before any schema-4 publish is enabled.
- Production is not changed or deployed.
