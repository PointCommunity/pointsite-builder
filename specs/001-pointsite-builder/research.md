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
Worker with static assets. Use D1 for relational metadata, revisions, and chunked
private draft media. Deploy staging as a separate Worker with static assets.

**Rationale**: One origin simplifies sessions, CSRF protection, previews, and the
free-plan request budget. D1 supports transactional metadata, optimistic
concurrency, and hard free-plan failure instead of overage billing. One-megabyte
chunks remain below D1's two-megabyte BLOB/row limit; a 250 MB application cap
leaves room inside the 500 MB Free database limit.

**Alternatives considered**: Pages Functions (equivalent billing but less explicit
Worker boundary), external database/storage (cost and more credentials), browser
local storage (not collaborative or durable).

## Authentication and authorization

**Decision**: Use the staging-only GitHub App's OAuth web flow with state and
PKCE. Issue signed, Secure, HttpOnly, SameSite cookies; verify the signed session,
stable GitHub user ID, current staging-repository collaboration, and D1 role on
every request. Local development uses an explicit development-auth mode that
cannot be enabled in deployed environments.

**Rationale**: Cloudflare documents Zero Trust Free as $0 for up to 50 users but
still requires payment details during onboarding, which violates the no-payment
boundary. GitHub App OAuth requires no Cloudflare subscription, reuses the
least-privilege staging integration, and lets collaboration or role removal take
effect on the next request.

**Alternatives considered**: Cloudflare Access (payment details required),
application passwords (new credential surface), email one-time PIN (cannot enforce
repository collaboration), and broad OAuth App scopes (less granular than a
GitHub App).

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
and quota warnings at 70 percent. Only Workers Free and D1 Free are allowed;
exhaustion returns errors until reset or space is reclaimed.

**Rationale**: Current Cloudflare documentation lists 100,000 Worker requests/day,
5 million D1 rows read/day, and 100,000 D1 rows written/day on Free. This workload
is far below those thresholds while leaving room for tests and operations. Limits
are rechecked before deployment because platform pricing can change.

**Alternatives considered**: any paid plan or subscription (rejected), R2 (requires
a billing subscription), no limits (unexpected failure risk), save on every
keystroke (wasteful writes).

## Accessibility and browser support

**Decision**: Target WCAG 2.2 AA and current stable Chromium, Firefox, and WebKit
engines; support 360, 768, and 1280 CSS-pixel layouts. Test keyboard editing and
non-drag alternatives.

**Rationale**: Church administrators may use different devices and assistive
technology. Drag-only authoring would exclude keyboard users.

## Sources reviewed 2026-09-05

- Cloudflare Workers pricing: https://developers.cloudflare.com/workers/platform/pricing/
- Cloudflare Zero Trust onboarding and payment-detail requirement: https://developers.cloudflare.com/cloudflare-one/setup/
- Cloudflare D1 pricing: https://developers.cloudflare.com/d1/platform/pricing/
- Cloudflare D1 limits: https://developers.cloudflare.com/d1/platform/limits/
- GitHub App user access tokens: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app
- GitHub collaborator permissions: https://docs.github.com/en/rest/collaborators/collaborators
- GitHub forks: https://docs.github.com/en/pull-requests/reference/forks
- GitHub App permissions: https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app
- GitHub protected branches: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches
- Puck documentation: https://puckeditor.com/docs
- Puck data model: https://puckeditor.com/docs/api-reference/data-model
