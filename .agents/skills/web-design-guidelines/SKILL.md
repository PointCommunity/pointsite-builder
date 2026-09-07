---
name: web-design-guidelines
description: Audit web interfaces against a pinned accessibility, interaction, content, and performance checklist.
license: MIT
metadata:
  hermes:
    source: vercel-labs/web-interface-guidelines@e3d624baaf29dc1fc645aff3e38f03e564d2d6b1 (MIT)
    source_url: https://github.com/vercel-labs/web-interface-guidelines
    tags: [web-design, accessibility, usability, audit, frontend]
    related_skills: [playwright-cli]
---

# Web Design Guidelines

## Description

Review web UI source and rendered behavior against a concrete, locally pinned checklist covering accessibility, focus, forms, motion, typography, content handling, images, performance, navigation, touch, safe areas, theming, internationalization, hydration, interaction states, and copy. Report findings by exact file and line; change code only when the user asked for remediation.

## Prerequisites

- The target source files or route.
- Repository instructions and the project's actual framework conventions.
- For interaction-dependent checks, a runnable local app and browser inspection capability.

## Steps

1. Resolve the review scope and read project policy before reviewing generated or vendor files.

   ```bash
   rg --files "<target>" | sort
   ```

   Expected result: the exact source files in scope. Exclude dependencies, generated output, and vendored code unless the user explicitly included them.

2. Read `references/web-interface-guidelines.md` completely. It is the pinned Vercel checklist used for this audit; do not replace it with a runtime download from `main`.

3. Inspect the source with line numbers and search for high-signal anti-patterns.

   ```bash
   rg -n 'transition:\s*all|outline:\s*none|outline-none|onPaste|autoFocus|user-scalable=no|maximum-scale=1|<img|onClick' "<target>"
   ```

   Expected result: candidate locations for manual review. A search match is not automatically a defect; evaluate semantics and surrounding code.

4. Inspect rendered behavior where a source-only judgment is insufficient. Exercise keyboard focus, long and empty content, form errors, loading states, narrow viewports, reduced motion, theme changes, navigation state, and touch alternatives as applicable.

5. Report only actionable findings, grouped by file:

   ```text
   ## path/to/File.tsx

   path/to/File.tsx:42 - icon-only button needs an accessible name
   path/to/File.tsx:67 - transition: all -> list the animated properties
   ```

   Use a checkmark for an inspected file with no findings. Explain only when the fix is not obvious. Distinguish a verified defect from a risk that needs runtime confirmation.

6. If fixes were authorized, implement the smallest project-consistent remediation, run focused checks, then repeat the audit over changed files. If fixes were not requested, stop after the evidence-backed report.

7. Run the repository's required checks and:

   ```bash
   git diff --check
   ```

   Expected result for remediation work: all project checks pass and `git diff --check` exits with status 0.

## Pitfalls

- **Remote instruction drift:** Never fetch the guideline body from a mutable upstream branch during execution.
- **Regex as verdict:** Searches identify candidates, not context-aware findings.
- **Framework mismatch:** Respect the target framework's supported patterns and local conventions.
- **Source-only confidence:** Focus order, overlays, animation, responsive overflow, and hydration often require a running page.
- **Scope creep:** An audit request does not authorize code changes.
- **Noise:** Avoid generic praise, style preferences presented as rules, and findings without a location or observable consequence.

## Verification

1. Every finding includes a valid repository-relative path and line number.
2. Every finding maps to a rule in `references/web-interface-guidelines.md` or is clearly identified as an additional project rule.
3. Every scoped file is either represented by findings or explicitly marked as passing.
4. Runtime-only claims were observed in a browser or labeled as unverified.
5. If remediation occurred, focused tests, the repository's full required checks, and `git diff --check` pass.

## Cross-References

- `playwright-cli` — rendered interaction, screenshot, console, and network verification.
- `references/web-interface-guidelines.md` — pinned audit checklist.
- `references/PROVENANCE.md` — source pin and adaptation details.
- `references/UPSTREAM-LICENSE.txt` — upstream MIT license.
