---
name: image-to-code
description: Recreate a selected screenshot or mockup as faithful, responsive, interactive frontend code.
license: MIT
metadata:
  hermes:
    source: openai/role-specific-plugins@fe5608d2512a7d6a7b9821ce8a88c48464ecd6e4 (MIT)
    source_url: https://github.com/openai/role-specific-plugins/tree/main/plugins/product-design/skills/image-to-code
    tags: [image-to-code, screenshot, mockup, frontend, visual-qa]
    related_skills: [awesome-design, design-taste-frontend, playwright-cli, web-design-guidelines]
---

# Image to Code

## Description

Translate one exact visual target into maintainable frontend code while preserving the target repository's stack and design primitives. The image controls visual comparison, but it does not silently authorize backend work, new routes, third-party services, proprietary asset copying, or destructive repository changes.

Use `design-taste-frontend` instead when the input is only a written brief. Use `awesome-design` only as supporting context; do not let a secondary reference override the selected image.

## Prerequisites

- An unambiguous target image and known target repository.
- The target image's pixel dimensions and, when possible, intended viewport dimensions.
- A runnable frontend and a browser or Playwright-based capture path.
- Permission to use or replace each supplied image, font, logo, and icon asset.

## Steps

1. Resolve the exact visual target before editing. If several images are present, identify the selected one by filename, attachment, frame, or explicit position. Stop and ask for selection only when two plausible targets would produce materially different results.

2. Inspect repository policy, stack, existing components, tokens, assets, and quality commands.

   ```bash
   rg --files | rg '(AGENTS|CLAUDE|GEMINI|DESIGN|README|package\.json|src/|app/|components/|styles/|public/)'
   ```

   Expected result: the implementation surface and existing design system are known before code changes begin.

3. Measure and inventory the target:

   - viewport and image dimensions;
   - page sections and alignment anchors;
   - container widths, gutters, gaps, padding, and overlap;
   - typography families, weights, sizes, line heights, and wrapping;
   - colors, borders, radii, shadows, and elevation;
   - every raster asset, logo, icon, texture, and decorative motif;
   - visible interaction, loading, empty, error, selected, and responsive states.

   Separate editable UI text from text embedded in artwork. Do not recreate imagery as arbitrary CSS shapes when the target clearly calls for an image asset.

4. Map the inventory to the existing codebase. Reuse compatible components and tokens. Add dependencies only after checking the manifest and only when they materially improve fidelity or accessibility. Use one coherent icon family and licensed fonts/assets.

5. Implement structure and responsive behavior before polish. Match the reference viewport first, then define how the composition adapts at narrower and wider sizes. Controls central to the shown experience must work; peripheral behavior outside the reference remains out of scope unless requested.

6. Run the app and capture it at the same viewport and state as the target. With Playwright CLI, a typical capture is:

   ```bash
   npx --yes @playwright/cli@0.1.19 open "http://127.0.0.1:<port>"
   npx --yes @playwright/cli@0.1.19 resize <width> <height>
   npx --yes @playwright/cli@0.1.19 screenshot --filename=implementation.png
   npx --yes @playwright/cli@0.1.19 close
   ```

   Expected result: `implementation.png` represents the same viewport and interaction state as the target. Use native browser tooling instead when the environment provides a safer or already-authenticated inspection path.

7. Compare target and implementation in this order: composition, geometry, typography, color/surfaces, assets, then micro-details. Record discrepancies by severity:

   - P0: wrong target, missing major section, unusable primary flow.
   - P1: major layout, asset, responsive, or accessibility mismatch.
   - P2: visible spacing, typography, color, or component-state mismatch.
   - P3: polish that does not materially affect recognition or use.

8. Fix P0–P2 findings, recapture at the same viewport, and repeat until no P0–P2 findings remain or a concrete blocker is documented. Do not hide discrepancies by changing the comparison viewport.

9. Run `web-design-guidelines`, the repository's full required checks, and:

   ```bash
   git diff --check
   ```

   Expected result: visual QA has no open P0–P2 findings, product checks pass, and `git diff --check` exits with status 0.

## Pitfalls

- **Wrong target:** Never infer a selected image from an ambiguous gallery or stale ordinal.
- **Screenshot-only implementation:** A pixel-similar static frame can still fail keyboard, responsive, content, and state behavior.
- **Overlay reconstruction:** Keep text inside artwork when it belongs to the asset; keep genuine UI text semantic and selectable.
- **Placeholder leakage:** Do not claim fidelity while key reference assets remain generic placeholders.
- **Stack replacement:** Matching an image does not authorize rebuilding the app in a preferred framework.
- **Unbounded looping:** Stop and report a blocker when a required asset, font right, viewport, or runnable capture path is unavailable.
- **False validation:** A successful build or HTTP response is not visual comparison evidence.

## Verification

1. The chosen source image is named and its dimensions are recorded.
2. Target and implementation captures use the same viewport and interaction state.
3. No P0, P1, or P2 comparison findings remain; blockers are explicit rather than silently waived.
4. The primary interaction works with keyboard and pointer input.
5. Narrow and wide layouts have no unintended overflow, clipping, or inaccessible controls.
6. Repository checks and `git diff --check` pass.

## Cross-References

- `awesome-design` — supporting design vocabulary when the target leaves a detail unspecified.
- `design-taste-frontend` — brief-led aesthetic direction when no image is authoritative.
- `playwright-cli` — same-viewport capture and interaction inspection.
- `web-design-guidelines` — blocking standards audit before handoff.
- `references/PROVENANCE.md` — source and standalone adaptation notes.
- `references/UPSTREAM-LICENSE.txt` — upstream MIT license.
