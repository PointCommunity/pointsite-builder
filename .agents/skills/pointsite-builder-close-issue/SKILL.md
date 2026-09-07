---
name: pointsite-builder-close-issue
description: 'Complete a verified PointSite Builder Issue by squash-merging its PR, deploying the exact main revision directly to Builder production, verifying live health, and closing the Issue.'
---

# Close a PointSite Builder Issue

Read `AGENTS.md`, `.agents/pointsite-builder-pipeline-policy.html`, the sole active Issue, PR, exact review evidence, live checks, and current repository state.

1. Require the Issue to be open and assigned only to `brimdor`. Confirm the matching PR targets `main`, contains `Refs #<number>` without auto-close syntax, is current and mergeable, has zero unresolved review findings, and passes every GitHub Quality job for its exact head.
2. Record the reviewed PR head commit and tree, then squash-merge and delete the feature branch when safe. Confirm the resulting `origin/main` tree exactly equals the reviewed tree; stop before deployment if it differs.
3. Update local `main` without discarding any user-owned work. Require a clean checkout at the exact remote merge commit and wait for every GitHub Quality job on that `main` commit to succeed.
4. Invoke `pointsite-builder-release-production` with the Issue, PR, reviewed head/tree, merge commit/tree, and Quality evidence. Routine Builder deployment needs no additional staging, Canary, or production approval.
5. Only after production deployment and live verification succeed, comment concise completion evidence, close the Issue, remove its assignment, read the Issue back, and verify that no active assigned Issue remains.
6. If merge succeeds but deployment fails, keep the Issue open and assigned. Verify application rollback, then use a reviewable revert commit or same-Issue remediation; never rewrite `main` history.

A merged PR is not completion. Never close the Issue before verified Builder production.
