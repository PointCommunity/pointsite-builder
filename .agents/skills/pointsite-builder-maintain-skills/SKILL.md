---
name: pointsite-builder-maintain-skills
description: 'Create, update, and validate PointSite Builder repository skills, shared pipeline policy, instruction imports, adapters, and deterministic workflow checks without cross-agent drift.'
---

# Maintain PointSite Builder Skills

Use this skill for every change to `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.agents/`, `.claude/skills/`, or skill-workflow validation scripts.

- `.agents/skills/` is canonical. Do not put Builder workflow authority only in user-global skills.
- Keep the eight `pointsite-builder-*` workflow packages separate from the five approved shared design packages. Shared packages may guide implementation or review but must not weaken, replace, or duplicate pipeline authority. There is no Builder Canary or Staging release package.
- Every canonical skill needs valid `name` and `description` frontmatter and focused instructions.
- Every Claude adapter must be a regular file pointing to its canonical relative `SKILL.md`; never duplicate full instructions or use symlinks.
- Keep `CLAUDE.md` and `GEMINI.md` as imports of `AGENTS.md`, not duplicate policies.
- Keep shared invariants in `.agents/pointsite-builder-pipeline-policy.html`, with Dark Mode styling. Preserve the Project schema, agent-owned movement, direct-to-production Builder release, exact-revision verification, rollback, and public PointSite separation.
- Preserve lean closeout: routine Issue completion uses concise Issue or PR evidence plus the final chat handoff. It must not create or open a duplicate acceptance report unless the PM explicitly requests that artifact.
- Validate every changed skill with the current skill validator, run `node .agents/skills/pointsite-builder-maintain-skills/scripts/audit-alignment.mjs`, then run `npm run check`, `npm run test:performance`, and `npm run test:e2e` as applicable.
- Test realistic positive and negative routing prompts when trigger descriptions change. Never weaken exact approval for Issue creation, the active-Issue invariant, full local QA, exact-main deployment, rollback, or production completion gates to make a test pass.
