---
name: pointsite-builder-review-issue
description: 'Perform complete agent QA for the active PointSite Builder Issue, remediate findings, deploy the exact candidate, and prepare the production Showcase for PM testing.'
---

# Review a PointSite Builder Issue

Pipeliner adoption, alignment, updates and requested monitor management use the direct framework-maintenance exception in `AGENTS.md`, without a GitHub Issue or active-slot transition. For product Issues, lead status and approval messages with the owning Issue and retain this specialized Builder workflow. Application QA runs locally; GitHub Quality provides lightweight contract and security evidence only.

Read `AGENTS.md`, `.agents/pointsite-builder-pipeline-policy.html`, the sole active Issue, PR diff and history, acceptance criteria, relevant specifications, and current test guidance.

1. Require the Issue to be the sole active card in In Progress, assigned only to `brimdor`, with exactly one matching open PR whose body contains `Refs #<number>` without auto-close syntax. Keep it In Progress throughout agent QA.
2. Review correctness, regressions, security, privacy, authorization, error paths, migrations, operations, accessibility, responsive behavior, documentation, and repository instructions in proportion to the diff.
3. Run focused tests, `npm run check`, `npm run test:performance`, `npm run test:e2e`, and `git diff --check`. Rehearse migrations locally when applicable. Use hands-on browser testing against a local instance for every affected flow at relevant desktop, tablet, and phone widths.
4. Remediate every finding on the same Issue branch. Repeat the affected review surface until there are zero unresolved findings.
5. Ensure the PR is current with `main`, ready for review, and the exact committed head passes every GitHub Quality job. Record the Issue, PR URL, head commit, head tree, test evidence, and Quality run.
6. As the agent-owned Project transition, move the Issue to In Review and immediately read back the card, assignment, metadata, and sole-active count.
7. If the PM requested a pre-deployment stop, report the verified candidate and stop. Otherwise invoke `pointsite-builder-close-issue` to merge and deploy the exact candidate; there is no Builder Canary or Builder Staging deployment and no separate pre-production approval gate.
8. After verified production, present a `Production Showcase` that links directly to `https://builder.pointatx.org`. Include the exact released source/tree and Worker identity plus numbered `PM testing steps` derived from the actual diff: prerequisites, exact actions, expected results, and relevant baseline/regression checks.
9. End the Showcase with `Approved to complete Issue #<number>` in its own standalone fenced code block for direct copying. Wait for that exact approval for the unchanged released candidate; agent testing, CI, deployment, silence, or an earlier approval is not PM acceptance.

Use the PR or Issue and concise chat updates for review evidence. Do not create or open a standalone acceptance report or duplicate QA summary unless the PM explicitly requested that artifact.

PM findings are blocking even after production deployment: move the card back to In Progress before remediation, create and deploy a new reviewed candidate, and present a replacement Showcase. Never reuse approval after the released candidate changes.
