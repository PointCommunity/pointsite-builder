---
name: design-taste-frontend
description: Choose distinctive frontend aesthetics from a brief while respecting the product's existing design system.
license: MIT
metadata:
  hermes:
    source: Leonxlnx/taste-skill@ccbc15639c97057cbfcf32ecebc38ef716e4bb37 (MIT)
    source_url: https://github.com/Leonxlnx/taste-skill
    tags: [design, frontend, visual-direction, typography, motion]
    related_skills: [awesome-design, image-to-code, web-design-guidelines]
---

# Design Taste for Frontends

## Description

Turn a written product brief into a deliberate visual direction, then carry that direction through implementation. Use this for aesthetic judgment and design coherence; use `image-to-code` when a concrete screenshot or mockup is the source of truth, and preserve an existing product design system unless the user explicitly requests a redesign.

The full upstream taste playbook is vendored at `references/taste-playbook.md`. Its rules are heuristics, not authority over the user's brief, repository policy, accessibility requirements, product constraints, or established stack.

## Prerequisites

- A concrete page or interface brief.
- Access to the target repository and its existing UI, tokens, brand assets, and project instructions.
- A way to render and inspect the result at the viewports relevant to the product.

## Steps

1. Inspect the product before choosing an aesthetic.

   ```bash
   rg --files | rg '(AGENTS|CLAUDE|GEMINI|DESIGN|README|package\.json|tailwind|theme|tokens|styles|css)'
   ```

   Expected result: the command identifies the project's instructions, design-system sources, styling entrypoints, and dependency manifest. Read the relevant files and inspect the current rendered interface when it exists.

2. Write one concise design read before implementation:

   ```text
   Reading this as: <surface> for <audience>, with a <visual character> language, grounded in <existing system or chosen foundation>.
   ```

   Infer three working dials—design variance, motion intensity, and visual density—on a 1–10 scale. Do not ask the user to tune numbers unless the brief genuinely supports incompatible directions.

3. Load only the relevant parts of the vendored playbook.

   ```bash
   rg -n '^## ' "<skill-directory>/references/taste-playbook.md"
   ```

   Expected result: a section index. Always use brief inference, design-system selection, accessibility, responsive behavior, and preflight guidance. Load specialized motion, material, landing-page, or redesign sections only when they match the task.

4. Establish a coherent system before styling individual components.

   - Preserve existing tokens and component primitives unless replacement is in scope.
   - Choose one typography system, one spacing rhythm, one radius logic, one surface hierarchy, and one restrained accent strategy.
   - Make hierarchy visible through scale, contrast, alignment, and whitespace before adding decoration.
   - Avoid habitual AI motifs unless the brief calls for them: purple mesh gradients, indiscriminate glass, centered hero plus three equal cards, decorative charts, and motion without meaning.
   - Use real assets and an established icon family. Do not improvise brand marks or pretend an aesthetic imitation is an official design system.

5. Implement the complete responsive experience in the project's existing stack. Include meaningful hover, focus, active, loading, empty, error, and reduced-motion states where the product can reach them. Keep primary actions obvious and make mobile composition intentional rather than merely stacked.

6. Render and compare at representative desktop, tablet, and phone viewports. Use `web-design-guidelines` for the standards audit and `playwright-cli` or the environment's native browser tooling for interaction and screenshot verification.

7. Run the repository's actual quality commands, followed by:

   ```bash
   git diff --check
   ```

   Expected result: project checks pass and `git diff --check` exits with status 0.

## Pitfalls

- **Aesthetic before context:** A fashionable treatment can still be wrong for the audience, product, or trust level. Read the product first.
- **Playbook literalism:** The upstream playbook contains React, Next.js, and Tailwind defaults. They do not authorize changing the repository's stack or dependencies.
- **Erasing product identity:** A redesign should refine recognizable brand assets unless replacement is explicitly requested.
- **Decorative complexity:** Asymmetry, motion, glass, and large type need a communicative purpose and accessible fallback.
- **Static-only polish:** A beautiful success-state screenshot is incomplete when the real interface has loading, failure, focus, long-content, or empty states.
- **Unlicensed typography or assets:** Verify that fonts and media can legally ship; name proprietary references only as comparison points.

## Verification

Confirm all of the following:

1. The implementation can be traced to the stated design read and consistent visual tokens.
2. Existing project policy and design primitives were preserved or intentionally changed within scope.
3. Primary flows work with pointer and keyboard input.
4. Mobile and desktop captures show no unintended overflow, clipping, or hidden primary actions.
5. Reduced motion, focus visibility, contrast, and semantic control checks pass.
6. The repository's tests/build and `git diff --check` pass.

## Cross-References

- `awesome-design` — choose a local reference vocabulary before establishing the design read.
- `image-to-code` — use when a selected image, not a written brief, is authoritative.
- `web-design-guidelines` — audit the result against concrete interface rules.
- `references/PROVENANCE.md` — pinned source and adaptation notes.
- `references/UPSTREAM-LICENSE.txt` — upstream MIT license.
