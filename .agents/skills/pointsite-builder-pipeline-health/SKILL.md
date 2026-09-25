---
name: pointsite-builder-pipeline-health
description: 'Perform a read-only audit of PointSite Builder Project state, PRs, CI, homelab Canary, Linode Production, and both public routes.'
---

# Audit PointSite Builder Pipeline Health

Pipeliner adoption, alignment, updates and requested monitor management use the direct framework-maintenance exception in `AGENTS.md`, without a GitHub Issue or active-slot transition. For product Issues, lead status and approval messages with the owning Issue and retain this specialized Builder workflow. Application QA runs locally; GitHub Quality provides lightweight contract and security evidence only.

Read `AGENTS.md` and `.agents/pointsite-builder-pipeline-policy.html`.

1. Run `node .agents/skills/pointsite-builder-pipeline-health/scripts/audit-pipeline.mjs` from the repository root.
2. Verify the private Project identity, repository link, required fields/options, views, enabled workflows, open-Issue card coverage, complete Project metadata, the one-active-Issue invariant, git branch/head, remote `main`, governed labels, assignment, workflow PR linkage, and exact GitHub Quality state. Dependabot PRs are reported separately and do not consume the active Issue slot.
3. For Canary, inspect homelab Gitea revision, `builder-canary` Argo health, image digest, PVC ownership and readiness. For Production, inspect the Linode `pointsite-builder.service`, Podman image tag/ID and source revision, `/opt/pointsite-builder` state and backup mounts, local health/readiness, and the Cloudflare rule that sends Production to Linode before the wildcard sends Canary to homelab. Do not treat the retained homelab `builder` Argo application as live Production.
4. Run `npm run verify:live -- --environment canary` and `npm run verify:live -- --environment production`. Report Issue pipeline, code/CI, Canary GitOps, Linode Production, route and each public health result separately. State exact drift and the owning `pointsite-builder-*` skill needed to repair it.

Never change Project fields/cards, Issues, PRs, assignments, labels, Git, Cloudflare, D1, Builder data, or public PointSite state from this skill.
