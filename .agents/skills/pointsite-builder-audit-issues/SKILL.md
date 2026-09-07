---
name: pointsite-builder-audit-issues
description: 'Audit and correct PointSite Builder backlog Issue classification. Use when the PM asks to audit, reprioritize, clean up, or validate the backlog without starting implementation.'
---

# Audit the PointSite Builder Backlog

Read `AGENTS.md`, `.agents/pointsite-builder-pipeline-policy.html`, the live Project fields, every Backlog Issue, all open pull requests, live labels, and relevant duplicate or dependency evidence.

- Scope is strictly Project Status Backlog. Do not edit On Hold, In Progress, In Review, Done, closed Issues, or pull requests.
- Check for duplicate, superseded, already-delivered, blocked, or incoherently combined scope using current source, specs, history, Issues, and PRs.
- Verify every Backlog Issue is open, unassigned, has exactly one governed `type:*` label, at least one governed `area:*` label, and populated Priority, Impact, and Effort. Do not invent or create labels, milestones, Projects, fields, statuses, Issues, branches, or PRs.
- Reassess ordering by security, privacy, data integrity, accessibility blockers, and application-blocking defects first, then user impact relative to effort and risk. Treat Priority, Impact, and Effort in the Issue body as planning estimates, not GitHub fields.
- P0 is reserved for urgent security, privacy, data-integrity, or application-blocking work. Apply justified Backlog-only Project and label corrections without a second approval, then read every mutation back and report before/after values and rationale. Propose body or scope corrections for PM approval rather than silently rewriting the Issue.
- Report a no-op audit explicitly and provide the ranked backlog without starting work.
