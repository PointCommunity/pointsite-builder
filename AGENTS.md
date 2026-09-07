# PointSite Builder Development Instructions

- This file governs the PointSite Builder application, which is separate from the public PointSite website.
- Preserve the public PointSite as a static, read-only website.
- Never put credentials, GitHub or session tokens, draft data, or private media in source or logs.
- All schema changes require migrations, backward compatibility, and tests.
- The Builder has one deployment environment: production at `https://builder.pointatx.org`. It has no staging or canary environment, and none should be introduced unless the user explicitly requests one.
- Complete and fully test every authorized Builder change before release. Once verified, commit all and only task-owned changes, push the exact commit to `origin/main`, deploy that exact revision with the repository's production deployment command, and verify the live Builder plus `/api/health`.
- Do not leave completed Builder work uncommitted, unpushed, or undeployed unless the user explicitly asks. Never commit or deploy partially completed or unverified work.
- Routine Builder application deployment does not require a separate staging or production approval. If deployment fails, diagnose it without discarding the last known-good deployment and report any unresolved blocker.
- Roll back a bad Builder release with a reviewable revert commit followed by the same push, deploy, and live-verification sequence; never rewrite shared history.
- Builder deployments must be auditable and tied to an exact source revision. These direct-deployment rules do not authorize changing the separate public PointSite content-publishing workflow.
- Use Node.js 22 or later, strict TypeScript, project-native lint/type/test/build checks, and WCAG 2.2 AA as the interface target.
- Human-facing reports and diagrams must be dark-mode HTML. Markdown under `specs/` and `.specify/` is internal workflow metadata.
- Use `apply_patch` for hand-authored edits and preserve unrelated work.
