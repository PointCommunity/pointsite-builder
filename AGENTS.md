# PointSite Builder development and release governance

## Authority and source of truth

- This file governs the PointSite Builder application in `PointCommunity/pointsite-builder`, which is separate from the public PointSite website. The PM is the human GitHub user `brimdor` (Chris).
- GitHub Project: organization-owned private Project `PointSite Builder Development`, number `1`.
- Canonical repository skills live under `.agents/skills/`. Always use the relevant `pointsite-builder-*` skill for Issue, review, release, or pipeline work.
- Five shared frontend skills also live under `.agents/skills/`: `design-taste-frontend` for brief-led visual direction, `awesome-design` for reference selection, `image-to-code` for a selected visual target, `web-design-guidelines` for standards review, and `playwright-cli` for CLI-driven browser evidence. They support product work but never replace a `pointsite-builder-*` pipeline skill or override this file, the shared policy, the existing Builder design system, or the current Issue scope.
- `.agents/pointsite-builder-pipeline-policy.html` is the shared workflow policy. Skills may narrow a workflow but must not contradict it.
- `AGENTS.md` is canonical. `CLAUDE.md` and `GEMINI.md` import it; do not duplicate policy into tool-specific instruction files.
- Preserve unknown user-owned changes. Never reset, restore, clean, stash, overwrite, commit, or deploy them without explicit direction.

## Pipeline invariant

- Exactly one Issue may be active. Active means Project Status `In Progress` or `In Review`. Dependabot pull requests are maintenance automation and do not consume the active Issue slot.
- Before Issue or code work, read the live Project, all open Issues, open pull requests, current branch/head, available labels, and the selected Issue. Fail closed on missing or conflicting metadata.
- The agent owns all Project Status movement: `Backlog`, `On Hold`, `In Progress`, `In Review`, `Done`. Never ask the PM to move a Project card or repair pipeline metadata.
- The Project's `Pull request merged` workflow stays disabled because merge alone is not completion. The agent sets Done only after verified production; the enabled Done automation may then close the Issue.
- At each transition, update Status and related metadata together, immediately read the live card back, and verify the one-active-Issue invariant.
- `On Hold` is inactive and may be used only when the PM explicitly requests it.
- Keep Status, Priority, Impact, Effort, governed labels, assignee, Issue state, branch, and PR reference aligned. Active Issues are assigned only to `brimdor`; Backlog Issues are open and unassigned.
- With no requested Issue and no active Issue, rank and recommend the top three Backlog Issues, then wait for PM selection.
- A request to work an Issue authorizes the complete Builder pipeline through production unless the PM explicitly sets an earlier stopping point. Routine Builder deployment does not require a separate staging, Canary, or production approval.

## Required workflow

- New work: use `pointsite-builder-create-issue`. Show the complete HTML Issue draft and Project metadata, then require `Approved to create this exact GitHub Issue` before creating it as an unassigned Backlog card.
- Backlog audit: use `pointsite-builder-audit-issues`. It may correct only justified Backlog metadata and must preserve every other lane and all active work.
- Implementation: use `pointsite-builder-work-issue`. Move the selected Issue to In Progress, assign it, create `issue/<number>-<slug>`, implement spec-first and test-first, and create or update a PR containing `Refs #<number>` without an auto-close keyword.
- Agent QA: use `pointsite-builder-review-issue`. Complete code review, full repository gates, local browser interaction testing for affected flows, and exact-head GitHub Quality; then move the verified candidate to In Review.
- Closure: use `pointsite-builder-close-issue`. From In Review, squash-merge the verified PR, confirm the merge tree equals the reviewed tree, wait for GitHub Quality on the exact `main` commit, invoke `pointsite-builder-release-production`, and only after live production verification move the card to Done, verify Issue closure, and unassign it.
- Production: use `pointsite-builder-release-production`. Record the previous Cloudflare version, deploy the exact clean `origin/main` revision with `npm run deploy`, verify the new Cloudflare deployment, `/api/health`, HTML-derived assets, and relevant live behavior, and roll back safely if required.
- Pipeline audit: use `pointsite-builder-pipeline-health` for read-only Project, Issue, PR, CI, git, Cloudflare, and live-runtime health.
- Skill changes: use `pointsite-builder-maintain-skills` and run the repository alignment audit before committing.

## Builder production boundary

- The Builder has exactly one deployment environment: production at `https://builder.pointatx.org`. It has no Builder staging or Canary environment, and none may be introduced unless the PM explicitly requests one.
- The Builder product can publish public-site candidates to `PointCommunity/pointsite-staging`; that content workflow is not a staging deployment of the Builder application and does not alter this direct-to-production pipeline.
- Preserve the public PointSite as a static, read-only website. Builder deployment never authorizes public PointSite publication or changes to `PointCommunity/pointsite` or `PointCommunity/pointsite-staging`.
- Builder deployments must be auditable and tied to an exact source revision. Never deploy a dirty tree, an unpushed commit, a failing commit, or a different tree from the reviewed PR.
- When schema changes are included, require migrations, backward compatibility, tests, local rehearsal, and an explicit recovery plan. Never perform destructive data or schema restoration without PM approval.
- Record the active Cloudflare version before release. If a new Builder version fails, roll back to that recorded version and verify recovery; use a reviewable revert commit for the durable source fix and never rewrite shared history.

## Quality, security, and documentation

- Use Node.js 22 or later, strict TypeScript, project-native format/lint/type/contract/runbook/test/coverage/build/performance/browser gates, and WCAG 2.2 AA as the interface target.
- GitHub currently rejects branch-protection and repository-ruleset configuration for this private repository at the organization plan level. Enforce PR, exact-tree, and Quality gates through the repository workflow and audit scripts, and report this limitation; never claim unavailable GitHub branch rules are active.
- Local hands-on browser QA is required for changed user flows before release. After deployment, verify live health and assets plus affected authenticated behavior when supported access is already available; never request credentials or weaken authentication to manufacture evidence.
- Never put credentials, GitHub or session tokens, draft data, private media, or sensitive operational values in source, Issues, PRs, logs, artifacts, or responses.
- Human-facing reports, diagrams, policies, and standalone documents must be HTML with Dark Mode. Markdown under `specs/` and `.specify/` is internal workflow metadata.
- Use `apply_patch` for hand-authored edits and preserve unrelated work.
