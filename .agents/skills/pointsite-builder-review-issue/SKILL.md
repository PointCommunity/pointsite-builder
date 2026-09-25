---
name: pointsite-builder-review-issue
description: 'Perform complete agent QA for the active PointSite Builder Issue, deploy Canary, and present the exact candidate for PM testing and approval.'
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
7. Unless the PM requested an earlier stop, build clean pushed source locally for linux/amd64, publish its immutable Zot digest and deploy only homelab Canary through canonical Gitea GitOps. Verify Argo, health, readiness, assets, persistence and affected authenticated behavior. Inspect the Linode baseline with `npm run release:inspect` so the sole PM approval can bind it. Present `https://builder-canary.eaglepass.io` with exact source/tree, image digest, Canary configuration commit, inspected baseline and change-specific PM tests. Require explicit approval of this exact candidate before invoking `pointsite-builder-close-issue` to merge and deploy the approved source/tree to Linode Production.
8. After verified Production, present a `Production Showcase` that links directly to `https://builder.eaglepass.io`. Include the exact released source/tree, Linode image tag/ID, service evidence, verified behavior and any remaining Issue scope. Do not ask for another PM approval.

Use the PR or Issue and concise chat updates for review evidence. Do not create or open a standalone acceptance report or duplicate QA summary unless the PM explicitly requested that artifact.

PM findings require same-Issue remediation: move the card back to In Progress, create and deploy a new reviewed Canary candidate, and obtain approval for that changed candidate before another Production promotion. Never reuse approval after the candidate changes.
