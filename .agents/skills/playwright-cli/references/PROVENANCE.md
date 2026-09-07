# Provenance

- Source: `microsoft/playwright-cli`
- Source tag: `v0.1.19`
- Source revision: `397ee39c83a651e1314cfb010b94e8a3aac11261`
- Source path: `skills/playwright-cli`
- Source license: Apache-2.0
- Source URL: https://github.com/microsoft/playwright-cli/tree/v0.1.19/skills/playwright-cli

The upstream `SKILL.md` and its nine Markdown references are vendored under `references/`. The PointSite Builder entrypoint removes tool-specific `allowed-tools` frontmatter, pins the fallback invocation, distinguishes this CLI-specific workflow from the existing environment-neutral `playwright` skill, and adds authorization, sensitive-state, session-ownership, and artifact-handling boundaries.

The vendored files are unmodified copies from the pinned source. The new PointSite Builder entrypoint is an adaptation and is prominently identified as such here.
