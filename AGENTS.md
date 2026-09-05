# PointSite Builder Development Instructions

- Preserve the public PointSite as a static, read-only website.
- Never put credentials, Cloudflare Access tokens, GitHub tokens, draft data, or private media in source or logs.
- All schema changes require migrations, backward compatibility, and tests.
- All publish operations must be idempotent, auditable, and tied to an exact source revision.
- Staging must pass every required check before production preparation.
- Production publishing requires an exact-candidate approval and may not bypass a pull request.
- Use Node.js 22 or later, strict TypeScript, project-native lint/type/test/build checks, and WCAG 2.2 AA as the interface target.
- Human-facing reports and diagrams must be dark-mode HTML. Markdown under `specs/` and `.specify/` is internal workflow metadata.
- Use `apply_patch` for hand-authored edits and preserve unrelated work.
