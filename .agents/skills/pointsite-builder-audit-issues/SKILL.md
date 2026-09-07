---
name: pointsite-builder-audit-issues
description: 'Audit and correct PointSite Builder backlog Issue classification. Use when the PM asks to audit, reprioritize, clean up, or validate the backlog without starting implementation.'
---

# Audit the PointSite Builder Backlog

Read `AGENTS.md`, `.agents/pointsite-builder-pipeline-policy.html`, every open unassigned Issue, all open pull requests, live labels, and relevant duplicate or dependency evidence.

- Backlog scope is strictly open unassigned Issues with no active implementation PR. Do not edit the active assigned Issue, closed Issues, or pull requests.
- Check for duplicate, superseded, already-delivered, blocked, or incoherently combined scope using current source, specs, history, Issues, and PRs.
- Verify each backlog Issue has exactly one appropriate primary classification from the live repository and only directly applicable supplemental labels. Do not invent or create labels, milestones, Projects, fields, Issues, branches, or PRs.
- Reassess ordering by security, privacy, data integrity, accessibility blockers, and application-blocking defects first, then user impact relative to effort and risk. Treat Priority, Impact, and Effort in the Issue body as planning estimates, not GitHub fields.
- When invoked, apply justified label corrections without a second approval, then read every mutation back and report before/after values and rationale. Propose body or scope corrections for PM approval rather than silently rewriting the Issue.
- Report a no-op audit explicitly and provide the ranked backlog without starting work.
