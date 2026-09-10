---
name: pipeliner-pipeline-health
description: Perform a read-only audit of repository, Issue, Project, pull-request, check, candidate, deployment, and runtime pipeline health.
---

# Audit Pipeline Health

Builder specialization: use [the pointsite-builder-pipeline-health skill](../pointsite-builder-pipeline-health/SKILL.md) for this repository. The root operating contract and `pipeliner.config.json` take precedence over the generic reference steps below. Preserve configured approval phrases, structured clarification controls, PM-selected Backlog work, full local QA, direct Cloudflare Production and post-deployment PM acceptance. Do not add a pre-production PM gate or a release cycle. Pipeliner adoption and updates are direct framework maintenance: Do not create or require a GitHub Issue, reserve the active slot, deploy the application or schedule monitoring.

Apply the shared [installed repository home](../pipeliner-maintain/references/home.md) and [message-only questions](../pipeliner-maintain/references/questions.md) contracts. First adoption retains its explicit-target gate. Follow Builder structured clarification rules; after asking, stop task work until the Human replies without polling or a deadline.

Follow [Issue-based communication](../../../AGENTS.md#issue-based-communication): organize work-status findings by owning Issue and its remaining gates, including linked pull-request, check, and deployment evidence. Report unlinked pull requests or missing Issues explicitly without substituting PR numbers for Issue identity.

Read `AGENTS.md`, `pipeliner.config.json`, and [Project operations](references/project-operations.md).

1. Run `node scripts/validate-repository.mjs` from the repository root.
2. Run `node scripts/audit-project.mjs --config <absolute-config-path>` when a live Project number is configured.
3. Inspect Git branch, head, dirty state, remote default branch, open Issues, active cards, open pull requests, linkage, reviews, checks, assignments, and exact candidate records.
4. When runtime health is requested, use only configured read-only verification commands and distinguish application, environment, deployment, and broader platform health.
5. Report each layer separately, identify exact drift and evidence limits, name the owning skill or PM decision required, and state that no changes were made.

Never repair Project fields, Issues, pull requests, Git, artifacts, deployments, or runtime state from this skill.

When `release.cycle` is configured, follow [release scope and phase governance](../pipeliner-maintain/references/release-cycle.md): inspect target/milestone, Release Issue, phase, freeze and blockers without treating phase as Status. Read-only inspection never starts or advances a cycle. Related findings stay on the same Issue; unrelated intake requires exact draft approval.
