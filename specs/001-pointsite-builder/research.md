# Research: PointSite Builder

## Repository topology

**Decision**: Use independent private `pointsite-staging` and
`pointsite-builder` repositories. Promotion creates a branch and pull request in
the production repository only after staging acceptance.

**Rationale**: The organization already owns production, so a same-owner fork is
not a reliable promotion boundary. An independent staging repository has separate
visibility, actions, secrets, and permissions. Cross-repository source is promoted
by a controlled GitHub integration rather than an implicit fork relationship.

**Alternatives considered**: staging branch in production (insufficient isolation),
personal-account fork (ownership and continuity risk), manual file copying (weak
auditability).

## Visual editor

**Decision**: Use Puck core 0.23 with a project-owned typed configuration and
renderer. Store Puck-compatible JSON inside a versioned site document.

**Rationale**: Puck supplies accessible React drag-and-drop primitives, field
configuration, nested layouts, responsive viewports, and a renderer while keeping
data and components under project control. The MIT core avoids a hosted-editor
dependency.

**Alternatives considered**: GrapesJS (HTML-centric and harder to constrain to the
existing React design), Craft.js (lower-level authoring burden), a custom canvas
(substantially more risk and accessibility work), a hosted CMS (cost and reduced
control).

## Runtime and hosting

**Decision**: Deploy one React/Vite application and Hono API as a Cloudflare
Worker with static assets. Use D1 for relational metadata/revisions and R2 for
private draft media. Deploy staging as a separate Worker with static assets.

**Rationale**: One origin simplifies Access, CSRF protection, previews, and the
free-plan request budget. D1 supports transactional metadata and optimistic
concurrency. R2 keeps unpublished media private without repository churn.

**Alternatives considered**: Pages Functions (equivalent billing but less explicit
Worker boundary), external database/storage (cost and more credentials), browser
local storage (not collaborative or durable).

## Authentication and authorization

**Decision**: Protect all Worker domains with Cloudflare Access using GitHub as
the identity provider. Validate Access JWTs in the API and map exact email identity
to a D1 application role on every request. Local development uses an explicit
development-auth mode that cannot be enabled in deployed environments.

**Rationale**: Gateway identity and application authorization address different
risks. Server-side role lookup makes removal immediate and prevents hidden client
controls from becoming the security boundary.

**Alternatives considered**: application passwords (new credential surface),
GitHub OAuth implemented in-app (more session/security code), email one-time PIN
as the only identity method (cannot enforce organization/team membership).

## GitHub integration

**Decision**: Use a GitHub App with repository-scoped installations and short-lived
installation tokens. During staging, install it only on `pointsite-staging`.
Production identifiers and installation secrets are absent until the production
gate. Publish jobs use exact base SHAs, deterministic generated files, and
idempotency keys.

**Rationale**: Fine-grained installation permissions, short-lived tokens, and
repository scoping are safer than a long-lived personal token. Exact base checks
make out-of-band drift visible.

**Alternatives considered**: PAT (broad/user-coupled), GitHub Actions repository
dispatch only (still requires a trusted caller and makes branch composition less
direct), direct pushes to main (no review boundary).

## Schema and renderer distribution

**Decision**: Maintain a framework-neutral `site-kit` package inside the builder
repository for schema, validation, defaults, and rendering components. The staging
repository vendors a release snapshot with a recorded renderer version. Publish
jobs update both candidate data and, when needed, the exact site-kit snapshot.

**Rationale**: Preview and staging use the same source and version without relying
on a public package or private registry during an initial free deployment. The
version and checksum are part of candidate identity.

**Alternatives considered**: duplicated renderer (drift), private npm package
(registry credentials and release ceremony), runtime preview calls into staging
(latency, Access, and cross-origin complexity).

## Free-plan operating envelope

**Decision**: Design for at most 10 concurrent administrators, five-second
debounced autosave, revisions only on semantic changes, five-megabyte individual
images, 250-megabyte private media warning threshold, one publish job at a time,
and quota warnings at 70 percent.

**Rationale**: Current Cloudflare documentation lists 100,000 Worker requests/day,
5 million D1 rows read/day, and 100,000 D1 rows written/day on Free. This workload
is far below those thresholds while leaving room for tests and operations. Limits
are rechecked before deployment because platform pricing can change.

**Alternatives considered**: paid plan from day one (unnecessary), no limits
(unexpected failure/cost risk), save on every keystroke (wasteful writes).

## Accessibility and browser support

**Decision**: Target WCAG 2.2 AA and current stable Chromium, Firefox, and WebKit
engines; support 360, 768, and 1280 CSS-pixel layouts. Test keyboard editing and
non-drag alternatives.

**Rationale**: Church administrators may use different devices and assistive
technology. Drag-only authoring would exclude keyboard users.

## Sources reviewed 2026-09-05

- Cloudflare Workers pricing: https://developers.cloudflare.com/workers/platform/pricing/
- Cloudflare Access for Workers: https://developers.cloudflare.com/workers/configuration/cloudflare-access/
- Cloudflare GitHub identity provider: https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/github/
- Cloudflare D1 pricing: https://developers.cloudflare.com/d1/platform/pricing/
- Cloudflare R2 pricing: https://developers.cloudflare.com/r2/pricing/
- GitHub forks: https://docs.github.com/en/pull-requests/reference/forks
- GitHub App permissions: https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app
- GitHub protected branches: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches
- Puck documentation: https://puckeditor.com/docs
- Puck data model: https://puckeditor.com/docs/api-reference/data-model
