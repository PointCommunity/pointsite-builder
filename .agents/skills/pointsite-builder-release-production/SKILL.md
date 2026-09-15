---
name: pointsite-builder-release-production
description: 'Promote an explicitly approved PointSite Builder Canary image unchanged through homelab GitOps, verify Production, and retain the previous image for recovery.'
---

# Release PointSite Builder Production

Pipeliner adoption, alignment, updates and requested monitor management use the direct framework-maintenance exception in `AGENTS.md`, without a GitHub Issue or active-slot transition. For product Issues, lead status and approval messages with the owning Issue and retain this specialized Builder workflow. Application QA runs locally; GitHub Quality provides lightweight contract and security evidence only.

Read `AGENTS.md`, `.agents/pointsite-builder-pipeline-policy.html`, the active Issue, merged PR, exact Canary approval and candidate evidence, canonical homelab instructions, current git state, Argo deployment history and migration/backup plan. Run only from `pointsite-builder-close-issue` unless the PM explicitly requests a standalone Builder deployment; standalone requests still require the explicit exact-candidate approval gate.

1. Require a clean local `main` with `HEAD == origin/main`, the expected reviewed image source tree, and successful GitHub Quality for that exact commit. Verify explicit PM approval is tied to the unchanged healthy Canary source/tree, image digest and configuration commit. A merge-tree difference or any candidate change invalidates approval.
2. Record the current Production image digest, GitOps revision and healthy storage/backup state. Resolve active registry references and retain the previous Production digest as the application rollback target. On first installation, preserve the old Worker and D1 data as the existing fallback.
3. For SQLite migrations, require native fresh/upgrade tests, backward compatibility, consistent backup and a disposable deletion-safe restore rehearsal. Never attempt destructive data or schema restoration without scoped PM approval.
4. Copy only the approved image/configuration into the Production chart in `/Users/chris/Documents/Github/homelab`. Preserve Production hostname, secrets, session identity and independent persistent storage. Render/lint, commit and push to Gitea `ops/homelab` master, then let Argo reconcile. Promote the same digest without rebuilding or live Kubernetes edits.
5. Run `npm run verify:live -- --environment production`. Verify Argo source revision and health, running image digest, `/api/health`, workspace readiness, production origin/version, cache-busted HTML and derived assets. Verify affected authenticated behavior and persistence with supported access, without weakening authentication or mutating unrelated drafts.
6. Add concise release evidence to the PR or Issue: reviewed source/tree, merge source/tree, GitHub Quality, exact approval, prior/new image digests, GitOps revision, migrations/backups, live verifier and browser evidence or its supported-access limitation. Keep the Issue open, assigned, and In Review; production health does not replace PM testing. Do not duplicate this evidence into a standalone report or open a local summary artifact unless the PM explicitly requested that artifact.
7. Return the released identity and production hyperlink to `pointsite-builder-review-issue` for its required Showcase. Do not set Done or close the Issue without exact PM approval of the unchanged released candidate.
8. If deployment or live verification fails, restore the recorded previous image/configuration through Gitea GitOps and verify Argo and live recovery. Keep the Issue open and assigned; use a reviewable source revert or same-Issue remediation. Stop for PM authorization before destructive schema or data recovery. After verified Production, clean up only task-owned tests and unreferenced images, protecting every active digest and the retained rollback digest.

This skill never deploys or publishes the public PointSite and never writes to `PointCommunity/pointsite` or `PointCommunity/pointsite-staging`.
