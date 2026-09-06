# Implementation Plan: Standardized Section Composer

## Technical Context

- TypeScript 5.9, React 19.2, Vite 8, Puck 0.23, Zod 4.5
- Cloudflare Worker + D1 persistence; static site renderer shared by canvas, preview, and staging
- Vitest, Testing Library, Playwright, axe-core, Redocly, project security/performance scripts
- WCAG 2.2 AA target; production repository is a hard exclusion

## Architecture

1. Add schema v2 Section and ElementPlacement contracts plus deterministic v1 migration.
2. Convert the default document into compatibility sections at construction time.
3. Add shared section rendering that is wrapper-free for compatibility and CSS-grid based for new sections.
4. Replace the flat Puck mapping with Section slot components and categorized element components.
5. Add section and placement inspectors; conditionally expose only controls that render.
6. Add default-dark Builder chrome, persistent theme switch, and documented Puck token overrides.
7. Expand unit, migration, renderer, inspector, authoring, accessibility, and visual-parity coverage.
8. Validate locally and in the private live Builder; update staging only after all gates pass.

## Constitution Check

- Static public site remains read-only: compliant.
- Schema migrations/backward compatibility/tests: mandatory and planned.
- Publish remains exact-revision, auditable, staging-first: unchanged.
- Production requires separate exact-candidate approval: unchanged and out of scope.
- Human-facing reports are dark HTML: retained.

## Risks and Controls

- **Parity drift**: compatibility sections render no public wrapper; screenshot comparison gates staging.
- **Draft loss**: deterministic migration, boundary validation, idempotence tests.
- **Invalid nesting**: slot allowlist excludes Section; serializer normalizes accidental root elements.
- **No-op controls**: conditional inspector fields plus observable-output contract tests.
- **Mobile breakage**: authored grid stacks in source order; 320px browser tests.
