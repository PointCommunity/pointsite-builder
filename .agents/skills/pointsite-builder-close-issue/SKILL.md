---
name: pointsite-builder-close-issue
description: 'Merge and deploy a PM-approved PointSite Builder Canary candidate, then close fully accepted Issues after Production verification.'
---

# Close a PointSite Builder Issue

Pipeliner adoption, alignment, updates and requested monitor management use the direct framework-maintenance exception in `AGENTS.md`, without a GitHub Issue or active-slot transition. For product Issues, lead status and approval messages with the owning Issue and retain this specialized Builder workflow. Application QA runs locally; GitHub Quality provides lightweight contract and security evidence only.

Read `AGENTS.md`, `.agents/pointsite-builder-pipeline-policy.html`, the sole active Issue, PR, exact review evidence, live checks, and current repository state.

1. Require the Issue to be the sole active card in In Review, open, and assigned only to `brimdor`. Confirm the matching PR targets `main`, contains `Refs #<number>` without auto-close syntax, is current and mergeable, has zero unresolved review findings, and passes every GitHub Quality job for its exact head.
2. Require explicit PM approval of the exact healthy Canary source/tree, image digest, GitOps configuration commit and inspected Linode baseline. Record the reviewed PR head commit and tree, then squash-merge and delete the feature branch when safe. Confirm the resulting `origin/main` tree exactly equals the reviewed image source tree; a changed tree invalidates approval and requires a new Canary candidate before Production.
3. Update local `main` without discarding any user-owned work. Require a clean checkout at the exact remote merge commit and wait for every GitHub Quality job on that `main` commit to succeed.
4. Invoke `pointsite-builder-release-production` with the Issue, PR, reviewed head/tree, merge commit/tree, Quality evidence, exact Canary approval, image digest, GitOps configuration and Linode baseline. Deploy the approved source/tree to Linode Production and record its image tag/ID and fresh backup; do not copy Canary storage, secrets or approvals into Production.
5. After Production deployment and live verification succeed, add concise release evidence and return to `pointsite-builder-review-issue` for the linked Production Showcase. Do not create or open a standalone acceptance report or duplicate closeout document unless the PM explicitly requested that artifact.
6. Re-read source/tree, deployment identity, live health, Issue, and card. If the approved Issue is fully accepted, perform the agent-owned Project transition to Done, verify the enabled automation closes the Issue (or close it directly if the automation does not), remove its assignment, read the Issue and card back, and verify no active Issue remains. Do not ask for separate Production Showcase or completion approval.
7. If Issue scope remains incomplete, keep it open, assigned, and active for same-Issue work. PM findings require In Progress and a new reviewed Canary candidate before further Production deployment. If merge succeeds but deployment fails, keep the Issue open and assigned, restore In Review if needed, verify application rollback, and use a reviewable revert or remediation; never rewrite `main` history.

A merged release alone is not completion. The sole PM approval follows Canary testing; close only after verified Production and full approved Issue acceptance.
