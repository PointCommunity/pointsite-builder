---
name: pointsite-builder-pipeline-health
description: 'Perform a read-only health audit of the PointSite Builder Project, Issue pipeline, PR linkage, CI, git identity, Cloudflare deployment, and live production runtime.'
---

# Audit PointSite Builder Pipeline Health

Pipeliner adoption, alignment, updates and requested monitor management use the direct framework-maintenance exception in `AGENTS.md`, without a GitHub Issue or active-slot transition. For product Issues, lead status and approval messages with the owning Issue and retain this specialized Builder workflow. Application QA runs locally; GitHub Quality provides lightweight contract and security evidence only.

Read `AGENTS.md` and `.agents/pointsite-builder-pipeline-policy.html`.

1. Run `node .agents/skills/pointsite-builder-pipeline-health/scripts/audit-pipeline.mjs` from the repository root.
2. Verify the private Project identity, repository link, required fields/options, views, enabled workflows, open-Issue card coverage, complete Project metadata, the one-active-Issue invariant, git branch/head, remote `main`, governed labels, assignment, workflow PR linkage, and exact GitHub Quality state. Dependabot PRs are reported separately and do not consume the active Issue slot.
3. For runtime health, verify the configured Cloudflare account, inspect current deployment history without mutation, and run `node .agents/skills/pointsite-builder-release-production/scripts/verify-live.mjs`.
4. Report Issue pipeline, code/CI, Cloudflare deployment, and production runtime separately. State exact drift and the owning `pointsite-builder-*` skill needed to repair it.

Never change Project fields/cards, Issues, PRs, assignments, labels, Git, Cloudflare, D1, Builder data, or public PointSite state from this skill.
