# PointSite Builder development and release governance

## Pipeliner adoption and maintenance

- Pipeliner adoption, alignment, updates, and explicitly requested monitor management are direct framework maintenance. Do not create or require a GitHub Issue, reserve the active Issue slot, move Project cards, or ask for Issue-creation/completion approval. The PM explicitly authorized this exception. Use a focused `codex/` branch and supporting PR, verify local QA and exact-head checks, publish the reviewed tree, and report the installed revision. No application deployment is authorized by framework maintenance.
- Use `pipeliner-adopt` for installation, `pipeliner-update` for updates, and `pipeliner-monitor-updates` only when scheduling is explicitly requested. Preserve unrelated work and existing protection. Do not automatically schedule monitoring.
- Maintenance PRs use `codex/adopt-pipeliner`, `codex/update-pipeliner`, `codex/align-pipeliner`, or `codex/monitor-pipeliner` with an optional descriptive suffix. Include a standalone `Pipeliner maintenance: adoption`, `Pipeliner maintenance: update`, `Pipeliner maintenance: alignment`, or `Pipeliner maintenance: monitor` line matching the operation. The pipeline audit verifies the changed-file scope; application source changes do not qualify for this exception.
- The target repository location is required for adoption. If neither a target nor new-repository intent is specified, ask one concise question and wait before target or Project mutation. An explicit target or previously resolved target remains authorized; do not ask again.
- `pipeliner.config.json` is the machine-readable repository, QA, Project, and release profile. `.agents/pipeliner-policy.html` supplies framework guidance; this file and `.agents/pointsite-builder-pipeline-policy.html` retain Builder-specific authority. Generic Pipeliner product Issue/review/release commands route through the corresponding `pointsite-builder-*` skills. This maintenance exception takes precedence over their Issue intake rules.
- Record reviewed upstream identity in `.agents/pipeliner-source.json`, manual managed-file reconciliation in `.agents/reconciliation.json`, and reviewed Actions command hashes in `.agents/ci-review.json`. Changed content requires fresh semantic review, not blind hash acceptance.

## Issue-based communication

- Lead product-work updates, handoffs and approval requests with the owning Issue; use the Issue number in completion phrases. Framework maintenance instead reports the target, operation and exact revision, without inventing an Issue.

## Local QA and lightweight CI

- Build applications only locally on the configured compatible host. No application, native-package, container-image, browser or performance builds/tests run in GitHub Actions, including through setup hooks, transitive scripts or reusable workflows. Preserve lightweight contract, dependency, source and secret checks. Run dependency installation in Actions with `--ignore-scripts`.
- The configured developer and PM is `brimdor`; local QA runs on macOS arm64 with the complete existing Chromium, Firefox, WebKit and mobile browser suite. No native Windows verification is implied by browser tests.
- Run every `quality.commands` and local `qa.environments[].suite` command against the exact source/tree. Record commands, exit codes and candidate identity in the supporting PR or Issue; GitHub's Pipeline contracts job never substitutes for these results.
- Before setup, run `node scripts/local-qa.mjs prepare` in a fresh task worktree. After tests, run `node scripts/local-qa.mjs cleanup`, including failure paths. Remove only inventoried task-created outputs. Test harnesses must stop their own servers; verify their absence before cleanup. Preserve unrelated processes, files, caches and credentials.
- The single local environment has no QA baton or additional pre-production PM gate. Local suite evidence permits agent review; product PM acceptance remains the post-deployment Production Showcase. The configured completion phrase in the local QA turn is bound to that final candidate; do not fabricate a passing PM record before actual approval. Generic multi-host QA requirements apply only if that topology is explicitly adopted later.
- Framework adoption is source-only maintenance: PM Testing reviews installed config, policy, commands and checks without deploying Builder. Product Issue completion rules below remain unchanged.

## Authority and source of truth

- This file governs the PointSite Builder application in `PointCommunity/pointsite-builder`, which is separate from the public PointSite website. The PM is the human GitHub user `brimdor` (Chris).
- GitHub Project: organization-owned private Project `PointSite Builder`, number `1`.
- Canonical repository skills live under `.agents/skills/`. Always use the relevant `pointsite-builder-*` skill for Issue, review, release, or pipeline work.
- Five shared frontend skills also live under `.agents/skills/`: `design-taste-frontend` for brief-led visual direction, `awesome-design` for reference selection, `image-to-code` for a selected visual target, `web-design-guidelines` for standards review, and `playwright-cli` for CLI-driven browser evidence. They support product work but never replace a `pointsite-builder-*` pipeline skill or override this file, the shared policy, the existing Builder design system, or the current Issue scope.
- `.agents/pointsite-builder-pipeline-policy.html` is the shared workflow policy. Skills may narrow a workflow but must not contradict it.
- `AGENTS.md` is canonical. `CLAUDE.md` and `GEMINI.md` import it; do not duplicate policy into tool-specific instruction files.
- Preserve unknown user-owned changes. Never reset, restore, clean, stash, overwrite, commit, or deploy them without explicit direction.

## Pipeline invariant

- Exactly one Issue may be active. Active means Project Status `In Progress` or `In Review`. Dependabot pull requests are maintenance automation and do not consume the active Issue slot.
- Before Issue or code work, read the live Project, all open Issues, open pull requests, current branch/head, available labels, and the selected Issue. Fail closed on missing or conflicting metadata.
- The agent owns all Project Status movement: `Backlog`, `On Hold`, `In Progress`, `In Review`, `Done`. Never ask the PM to move a Project card or repair pipeline metadata.
- The Project's `Pull request merged` workflow stays disabled because merge and deployment are not completion. The agent sets Done only after verified production plus PM testing and exact approval of the current Showcase candidate; the enabled Done automation may then close the Issue.
- At each transition, update Status and related metadata together, immediately read the live card back, and verify the one-active-Issue invariant.
- `On Hold` is inactive and may be used only when the PM explicitly requests it.
- Keep Status, Priority, Impact, Effort, governed labels, assignee, Issue state, branch, and PR reference aligned. Active Issues are assigned only to `brimdor`; Backlog Issues are open and unassigned.
- With no requested Issue and no active Issue, rank and recommend the top three Backlog Issues, then wait for PM selection.
- A request to work an Issue authorizes implementation, agent QA, merge, and direct Builder production deployment unless the PM explicitly sets an earlier stopping point. It does not authorize declaring the Issue complete: PM review and testing of the production Showcase are mandatory before Done and closure.

## Required workflow

- New work: use `pointsite-builder-create-issue`. Show the complete HTML Issue draft and Project metadata, then require `Approved to create this exact GitHub Issue` before creating it as an unassigned Backlog card.
- Backlog audit: use `pointsite-builder-audit-issues`. It may correct only justified Backlog metadata and must preserve every other lane and all active work.
- Implementation: use `pointsite-builder-work-issue`. Move the selected Issue to In Progress, assign it, create `issue/<number>-<slug>`, implement spec-first and test-first, and create or update a PR containing `Refs #<number>` without an auto-close keyword.
- Agent QA and Showcase: use `pointsite-builder-review-issue`. Complete code review, full repository gates, local browser interaction testing for affected flows, and exact-head GitHub Quality; move the verified candidate to In Review, merge and deploy it through the closure and release skills, then present a production Showcase hyperlink with numbered, change-specific PM testing steps.
- PM review: keep the deployed Issue open, assigned, and In Review until the PM tests the production Showcase and explicitly approves the current released candidate. PM findings move it back to In Progress; remediate, review, merge, deploy, and Showcase a new candidate before requesting approval again.
- Closure: use `pointsite-builder-close-issue`. It may merge and deploy a verified In Review candidate without a separate pre-production approval, but it may set Done, close, and unassign only after the PM states `Approved to complete Issue #<number>` for the unchanged production Showcase candidate.
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
- The repository is public and branch protection is intentionally disabled in the adopted profile, matching the PM-selected recommendation and current GitHub state. Enforce PR, exact-tree, full local QA and lightweight Quality gates through the repository workflow and audit scripts. Do not enable protection or rulesets unless explicitly requested, and always inspect live settings before reporting them.
- Local hands-on browser QA is required for changed user flows before release. After deployment, verify live health and assets plus affected authenticated behavior when supported access is already available; never request credentials or weaken authentication to manufacture evidence.
- Never put credentials, GitHub or session tokens, draft data, private media, or sensitive operational values in source, Issues, PRs, logs, artifacts, or responses.
- Routine Issue completion evidence belongs in the existing Issue or PR plus a concise final chat handoff. Do not create or open a standalone acceptance report, duplicate closeout document, or other summary artifact unless the PM explicitly requests that artifact as a deliverable. Specifications, tests, CI, deployment output, and live verification remain the evidence sources.
- Every production Showcase handoff must link directly to `https://builder.pointatx.org`, identify the exact released candidate, provide prerequisites, numbered actions, expected results, and focused regression checks, and end with `Approved to complete Issue #<number>` in its own fenced code block for easy copying. Agent QA and live verification never substitute for PM review and testing.
- Human-facing reports, diagrams, policies, and standalone documents must be HTML with Dark Mode. Markdown under `specs/` and `.specify/` is internal workflow metadata.
- Use `apply_patch` for hand-authored edits and preserve unrelated work.
