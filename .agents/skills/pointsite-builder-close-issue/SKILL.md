---
name: pointsite-builder-close-issue
description: 'Merge and deploy a verified PointSite Builder candidate, then complete the Issue only after PM testing and approval of the production Showcase.'
---

# Close a PointSite Builder Issue

Read `AGENTS.md`, `.agents/pointsite-builder-pipeline-policy.html`, the sole active Issue, PR, exact review evidence, live checks, and current repository state.

1. Require the Issue to be the sole active card in In Review, open, and assigned only to `brimdor`. Confirm the matching PR targets `main`, contains `Refs #<number>` without auto-close syntax, is current and mergeable, has zero unresolved review findings, and passes every GitHub Quality job for its exact head.
2. Record the reviewed PR head commit and tree, then squash-merge and delete the feature branch when safe. Confirm the resulting `origin/main` tree exactly equals the reviewed tree; stop before deployment if it differs.
3. Update local `main` without discarding any user-owned work. Require a clean checkout at the exact remote merge commit and wait for every GitHub Quality job on that `main` commit to succeed.
4. Invoke `pointsite-builder-release-production` with the Issue, PR, reviewed head/tree, merge commit/tree, and Quality evidence. Routine Builder deployment needs no additional staging, Canary, or production approval.
5. After production deployment and live verification succeed, add concise release evidence, keep the Issue open, assigned, and In Review, and return to `pointsite-builder-review-issue` for the linked production Showcase and PM testing steps. Do not create or open a standalone acceptance report or duplicate closeout document unless the PM explicitly requested that artifact.
6. On a later invocation, require the exact phrase `Approved to complete Issue #<number>` from the PM for the currently deployed, unchanged Showcase candidate. Re-read source/tree, deployment identity, live health, Issue, and card; any changed candidate invalidates approval.
7. Only after that readback succeeds, perform the agent-owned Project transition to Done, verify the enabled automation closes the Issue (or close it directly if the automation does not), remove its assignment, read the Issue and card back, and verify no active Issue remains.
8. PM findings require In Progress and same-Issue remediation through a new PR and full review/deploy/Showcase cycle. If merge succeeds but deployment fails, keep the Issue open and assigned, restore In Review if needed, verify application rollback, and use a reviewable revert or remediation; never rewrite `main` history.

A merged and healthy production release is not completion. Never close the Issue before PM testing and exact approval of its current production Showcase.
