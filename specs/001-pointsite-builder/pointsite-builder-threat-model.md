# PointSite Builder Threat Model

## System Overview

PointSite Builder is an internet-reachable but collaborator-only Cloudflare Worker
application. It stores unpublished website data and media, then writes exact
candidates through a repository-scoped GitHub App. Public PointSite remains a
separate static export with no mutation API.

## Trust Boundaries

1. **Browser to Builder Worker**: HTTPS | Auth: GitHub OAuth plus signed session | Validation: state, PKCE, HMAC, expiry, origin.
2. **Builder Worker to GitHub**: HTTPS | Auth: short-lived App tokens | Validation: stable user ID, current staging collaboration, repository allowlist.
3. **Worker to D1**: Cloudflare binding | Auth: platform binding | Validation: typed repositories, parameterized SQL, chunk and capacity policy.
4. **Worker to GitHub**: HTTPS | Auth: short-lived App installation token | Validation: response schemas, exact owner/repository allowlist, base SHA.
5. **Candidate to Staging Worker**: Git commit/build/static assets | Auth: signed GitHub session for review | Validation: schema, renderer, checks, exact commit.
6. **Accepted staging to Production PR**: GitHub API | Auth: separately installed App | Validation: fresh candidate approval, exact production base, protected branch.

## Assets

1. GitHub App private key and installation tokens (high, credentials).
2. GitHub OAuth client secret and session-signing secret (high, credentials).
3. Unpublished drafts and media (medium, user content).
4. Role mappings and approvals (high, authorization/integrity).
5. Production and staging repository integrity (high, public content/code).
6. Audit and publish evidence (medium, accountability).
7. Worker, D1, and GitHub quotas (medium, availability).

## Entry Points

1. All `/api/*` requests and headers (authenticated HTTP).
2. JSON SiteDocument and draft metadata (authenticated parser input).
3. Multipart media upload and image decoder metadata (authenticated file input).
4. Publish, retry, approval, role, and rollback actions (privileged workflows).
5. GitHub API responses and workflow/deployment state (third-party data).
6. Environment variables, Worker bindings, migrations, and CI workflows (operator/build input).

## Threats

| ID    | Boundary              | Asset                 | Type                   | Goal                                | Priority | Description                                                                          |
| ----- | --------------------- | --------------------- | ---------------------- | ----------------------------------- | -------- | ------------------------------------------------------------------------------------ |
| TM-01 | Browser to Worker     | Roles, drafts         | Spoofing/Elevation     | Bypass identity or role             | Critical | Forged, expired, or revoked GitHub identity data could grant administration.         |
| TM-02 | Worker to GitHub      | Repository integrity  | Tampering/Elevation    | Write production before approval    | Critical | Mis-scoped credentials or target injection could bypass staging.                     |
| TM-03 | JSON to renderer      | Browser/admin session | Tampering              | Stored XSS or unsafe navigation     | High     | Rich text, links, embeds, or fields could execute or exfiltrate.                     |
| TM-04 | Media upload          | D1, browser           | Tampering/DoS          | Store active or oversized content   | High     | Deceptive MIME, image bombs, and repeated uploads consume resources.                 |
| TM-05 | Draft save            | Revision integrity    | Tampering              | Silently overwrite another editor   | High     | Stale clients could erase acknowledged changes without concurrency control.          |
| TM-06 | Publish workflow      | Git integrity         | Repudiation/Tampering  | Duplicate or ambiguous release      | High     | Retry or timeout could create divergent commits without idempotency and exact bases. |
| TM-07 | Browser to API        | State operations      | CSRF                   | Trigger privileged action           | High     | A signed-in browser could be induced to call a mutation endpoint.                    |
| TM-08 | Worker to GitHub      | Secrets               | Information disclosure | Steal App token/key                 | Critical | Logs, error bodies, bundles, or source could expose credentials.                     |
| TM-09 | External dependencies | Builder supply chain  | Tampering              | Ship malicious package/action       | High     | Compromised npm package or unpinned action can alter code or exfiltrate secrets.     |
| TM-10 | Internet to Worker    | Quotas                | DoS                    | Exhaust free allowances             | Medium   | Authenticated abuse or accidental autosave loops can halt D1/Worker operations.      |
| TM-11 | Audit store           | Accountability        | Repudiation            | Hide or forge privileged activity   | Medium   | Mutable/incomplete audit records weaken incident investigation.                      |
| TM-12 | Production PR         | Public site           | Tampering              | Merge stale or unreviewed candidate | High     | Production drift or stale acceptance can invalidate staging evidence.                |

## Mitigations

### Planned and required

- Validate OAuth state and PKCE, signed-cookie HMAC and expiry, stable GitHub ID,
  current staging collaboration, and D1 role on every request.
- Keep production variables and installation absent until G6; enforce compile-time and runtime repository allowlists.
- Use Zod strict schemas, structured rich text, safe URL protocols, React escaping, CSP, and no custom code field.
- Enforce image magic bytes, MIME, extension, byte and dimension bounds; random
  D1 object keys, one-megabyte chunks, private reads, and a hard 250 MB cap.
- Use immutable revisions and compare-and-swap pointer updates with `If-Match` checksums.
- Persist job/idempotency state before GitHub calls; check exact base SHA and validate every GitHub response.
- Enforce same-origin mutation requests, exact content types, Fetch Metadata, bounded bodies, and per-actor action rates.
- Redact credentials and content payloads; use Worker secrets; scan source/history and CI logs.
- Lock dependency versions, review lockfile changes, audit packages, pin Actions by commit where practical, produce SBOM.
- Debounce autosave, cap publish concurrency, expose 70 percent warnings, and fail visibly at limits.
- Append audit events transactionally with state changes and export before retention purge.
- Bind approvals to the full candidate tuple and production base; protected PR checks and separate merge authorization.

## Assumptions

- [Confirmed by user decision] Builder access is limited to approved PointCommunity GitHub collaborators with active roles.
- [Confirmed] Production must remain untouched until staging is proven.
- [Confirmed] Expected usage is a small church admin team, far below 100,000 daily Worker requests.
- [Confirmed] Drafts and preview are required before publication.
- [Confirmed] Public PointSite remains read-only and static.
- [Confirmed by selected design] Arbitrary code is outside the visual editor.
- [Confirmed external state] PointSite Cloudflare account ID is pinned in configuration; no Zero Trust or R2 subscription may be activated.

## Open Questions

No product question blocks implementation. Cloudflare account identity and approved
login identities are deployment inputs and will be resolved during the external
setup checkpoint without changing the architecture or threat ranking.
