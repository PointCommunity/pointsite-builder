---
name: awesome-design
description: Select and adapt a local design reference without copying brand identity, protected assets, or trade dress.
license: MIT
metadata:
  hermes:
    source: VoltAgent/awesome-design-md@8147538b4226ae41e2487a9179e3bcc1f68e8554 (MIT)
    source_url: https://github.com/VoltAgent/awesome-design-md
    tags: [design-systems, references, visual-language, tokens, creative]
    related_skills: [design-taste-frontend, image-to-code, web-design-guidelines]
---

# Awesome Design References

## Description

Choose an appropriate design vocabulary from a pinned local corpus of 74 `DESIGN.md` analyses, then translate useful principles into an original product-specific system. The references describe publicly visible patterns; they are inspiration and comparative evidence, not official brand documentation or permission to copy trademarks, protected assets, layouts, or trade dress.

## Prerequisites

- A product brief, target audience, and intended surface.
- Access to any existing brand rules, tokens, UI components, and screenshots.
- The bundled corpus under `references/design-md/<reference>/DESIGN.md`.

## Steps

1. Inventory the available references.

   ```bash
   rg --files "<skill-directory>/references/design-md" | rg '/DESIGN\.md$' | sort
   ```

   Expected result: 74 local `DESIGN.md` paths. Do not fetch replacement instructions from a remote default branch during the task.

2. Search by the characteristics the product actually needs rather than choosing the most famous brand.

   ```bash
   rg -n -i 'editorial|data.dense|calm|playful|cinematic|accessib|responsive|monochrome|enterprise' "<skill-directory>/references/design-md"
   ```

   Expected result: candidate references whose documented atmosphere, density, typography, components, and responsive behavior match the brief.

3. Read two to four candidates, then choose one primary reference. Use a secondary reference only for a specific dimension the primary does not cover, such as dense tables or editorial typography. Do not blend several references into an incoherent collage.

4. Extract principles, not identity:

   - Map color roles to the target product's own palette.
   - Replace proprietary fonts with licensed, metrically and emotionally suitable alternatives.
   - Adapt spacing, hierarchy, component states, and responsive behavior to the target content.
   - Preserve the target product's logo, language, information architecture, and recognizability.
   - Treat any inferred token in the corpus as a hypothesis to validate visually, not as official brand guidance.

5. Record a short design-source decision before implementation:

   ```text
   Primary reference: <name> for <specific principles>.
   Secondary reference: <name or none> for <specific missing dimension>.
   Intentionally not copied: <brand identifiers, proprietary assets, distinctive composition>.
   Product adaptation: <palette, type, spacing, components, motion, responsive behavior>.
   ```

6. Hand the adapted system to `design-taste-frontend` for brief-led implementation or `image-to-code` when a selected mockup remains the visual source of truth.

7. After implementation, use `web-design-guidelines` and browser verification to ensure the reference did not compromise accessibility, content fit, interaction behavior, or responsive layout.

## Pitfalls

- **Cargo-cult selection:** Choose by audience and product problem, not personal brand preference.
- **Trade-dress copying:** Never reproduce a reference's logo, proprietary imagery, signature page composition, or confusingly similar identity.
- **Token absolutism:** Values were inferred from public interfaces and may be incomplete, stale, or context-specific.
- **Proprietary fonts:** Substitute licensed alternatives unless the target project has documented rights.
- **Reference soup:** One primary design language is stronger than an unprincipled blend of recognizable brands.
- **Remote drift:** The vendored corpus is intentionally pinned; update it through reviewed repository maintenance, not at runtime.

## Verification

1. Confirm the chosen reference file exists locally:

   ```bash
   rg --files "<skill-directory>/references/design-md" | rg '/<reference>/DESIGN\.md$'
   ```

   Expected result: exit status 0.

2. Confirm the final design decision names the product-specific adaptation and what was intentionally not copied.
3. Confirm every shipped font and asset is licensed for the target project.
4. Compare the rendered result at mobile and desktop sizes; it should express the selected principles without being confusable with the reference brand.

## Cross-References

- `design-taste-frontend` — turn the selected vocabulary into a coherent implemented direction.
- `image-to-code` — recreate a concrete image while using the corpus only as supporting context.
- `web-design-guidelines` — audit accessibility and interaction quality after adaptation.
- `references/design-md/*/DESIGN.md` — the complete pinned design-reference corpus.
- `references/PROVENANCE.md` — corpus scope, pin, and usage boundary.
- `references/UPSTREAM-LICENSE.txt` — upstream MIT license.
