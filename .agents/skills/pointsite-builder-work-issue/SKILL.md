---
name: pointsite-builder-work-issue
description: 'Select, start, and implement one PointSite Builder GitHub Issue through a verified pull request. Use for Work Issue, Work Issue #N, starting backlog work, or continuing the active implementation.'
---

# Work a PointSite Builder Issue

Read `AGENTS.md`, `.agents/pointsite-builder-pipeline-policy.html`, the live repository, all open Issues and pull requests, git state, the selected Issue, and relevant source/specification evidence before acting.

## Selection gate

- If more than one open Issue is assigned to `brimdor`, stop and report the conflict without changing code or metadata.
- If an active assigned Issue exists, work only that Issue. Refuse a different Issue unless the PM explicitly changes the active work.
- If no Issue number and no active Issue exist, rank the open unassigned backlog and recommend the top three with impact, effort, risk, and rationale. Wait for PM selection.
- A requested new Issue must be open and unassigned. The PM's selection authorizes the agent to assign it to `brimdor` and execute the complete Builder pipeline unless the PM sets an earlier stopping point.

## Start and implement

1. Assign the selected Issue only to `brimdor`, then immediately read back the Issue and verify it is the sole active assigned Issue.
2. Start from current `origin/main` on `issue/<number>-<short-slug>`. Preserve user-owned work and fail closed if branch creation would mix unrelated changes.
3. Diagnose and research before editing. For medium or larger changes, create or update the repository's spec, plan, and tasks before implementation; obtain clarification only for decisions that evidence cannot resolve.
4. Implement the smallest coherent solution test-first. Keep scope, acceptance criteria, labels, and planning estimates current when evidence materially changes them, obtaining PM approval before changing the Issue body.
5. Run focused checks while iterating, then the complete gates required by `AGENTS.md`.
6. Commit only task-owned files, push the feature branch, and create or update a PR targeting `main`. The PR body must contain `Refs #<number>` and must not use an auto-closing keyword.
7. Hand off directly to `pointsite-builder-review-issue`. A PR is not completion and does not authorize closing the Issue.

If the PM explicitly pauses work, preserve the branch, PR, and evidence. Keep the Issue assigned so the active slot remains unambiguous; do not begin another Issue unless the PM explicitly changes the active work.
