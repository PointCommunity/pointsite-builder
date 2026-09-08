---
name: pointsite-builder-work-issue
description: 'Select, start, and implement one PointSite Builder GitHub Issue through a verified pull request. Use for Work Issue, Work Issue #N, starting backlog work, or continuing the active implementation.'
---

# Work a PointSite Builder Issue

Read `AGENTS.md`, `.agents/pointsite-builder-pipeline-policy.html`, the live Project, all active cards, open Issues and pull requests, git state, the selected Issue, and relevant source/specification evidence before acting.

## Selection gate

- If more than one card has Status In Progress or In Review, stop and report the conflict without changing code or metadata.
- If an active card exists, work only that Issue. Refuse a different Issue unless the PM first resolves the active card.
- If no Issue number and no active card exist, rank the Backlog and recommend the top three with impact, effort, risk, and rationale. Wait for PM selection.
- A requested Issue must be open and in Backlog unless it is the existing active Issue. On Hold may resume only when the PM explicitly requests it. The PM's selection or resume request is the decision gate; the agent performs and verifies Project movement.

## Start and implement

1. As the agent-owned Project transition, move the selected Issue to In Progress, assign it only to `brimdor`, then immediately read back Status, assignment, Priority, Impact, Effort, governed labels, and the one-active-Issue count before editing code.
2. Start from current `origin/main` on `issue/<number>-<short-slug>`. Preserve user-owned work and fail closed if branch creation would mix unrelated changes.
3. Diagnose and research before editing. For medium or larger changes, create or update the repository's spec, plan, and tasks before implementation; obtain clarification only for decisions that evidence cannot resolve.
4. Implement the smallest coherent solution test-first. Keep scope, acceptance criteria, labels, and planning estimates current when evidence materially changes them, obtaining PM approval before changing the Issue body.
5. Run focused checks while iterating, then the complete gates required by `AGENTS.md`.
6. Keep acceptance traceability in the specification, tasks, automated tests, PR, and Issue. Do not create or open a standalone acceptance report or duplicate summary artifact unless the PM explicitly requested it as a deliverable.
7. Commit only task-owned files, push the feature branch, and create or update a PR targeting `main`. The PR body must contain `Refs #<number>` and must not use an auto-closing keyword.
8. Hand off directly to `pointsite-builder-review-issue`. A PR is not completion and does not authorize closing the Issue.

If the PM explicitly pauses work, move the card to On Hold, preserve the Issue, branch, PR, and evidence, remove assignment unless the PM directs otherwise, and verify the active slot is released. On resumption, perform and verify the In Progress transition before editing.
