# Feature Specification: PointSite Builder

**Feature Branch**: `codex/001-pointsite-builder`  
**Created**: 2026-09-05  
**Status**: Accepted for implementation  
**Input**: Build a private, highly usable visual website builder for PointSite with drafts, preview, staging validation, and safe production publishing.

## Product Boundary

The builder is a collaborator-only maintenance tool. Public PointSite remains a
static, read-only website. The system edits validated site data and approved
components; it does not execute arbitrary administrator-provided code. Every
candidate is proven in a separate staging repository and environment before any
production capability is enabled.

## Cost and Identity Boundary

The deployed system MUST use only hard-limited free services that stop serving or
writing when an allowance is exhausted. It MUST NOT require a paid subscription,
new payment method, or usage-based overage billing. Cloudflare Zero Trust Access
and R2 are excluded because their onboarding requires payment details or a
billable subscription. GitHub App OAuth authenticates approved staging-repository
collaborators; D1 stores drafts, roles, sessions, and chunked private media.

## User Scenarios & Testing

### User Story 1 - Safely author and preview a page (Priority: P1)

An Editor signs in, creates or opens a draft, arranges approved content blocks,
edits copy and images, previews common device widths, and returns later without
losing work.

**Why this priority**: Safe, nontechnical authoring is the core product value.

**Independent Test**: An Editor can build a page, reload the application, restore
an earlier revision, and preview the exact saved data without any Git write.

**Acceptance Scenarios**:

1. **Given** an approved Editor, **When** they change a block, **Then** the draft autosaves and a recoverable revision is recorded.
2. **Given** an unsaved network failure, **When** the connection returns, **Then** the interface retries safely and clearly reports the final save state.
3. **Given** two Editors on one draft, **When** the second saves a stale revision, **Then** the system refuses to overwrite newer work and offers reload or copy recovery.
4. **Given** a draft, **When** the Editor selects mobile, tablet, or desktop preview, **Then** the same validated page data renders at that viewport.
5. **Given** the seeded PointSite, **When** an Editor opens any page in the visual canvas, **Then** the canvas includes the same header, page chrome, modules, footer, typography, spacing, imagery, and responsive layout that staging will publish.

### User Story 2 - Manage the whole site without code (Priority: P1)

An Editor manages pages, navigation, organization details, theme tokens, reusable
presets, forms, people, groups, and media using bounded controls.

**Independent Test**: Starting from a seeded copy of PointSite, an Editor can
change every currently published content surface and can create a visually
different page using only approved modules and design controls.

**Acceptance Scenarios**:

1. **Given** the seeded PointSite, **When** an Editor changes organization details, navigation, page content, and theme, **Then** preview reflects all changes without source editing.
2. **Given** a new page, **When** an Editor selects a preset and rearranges modules, **Then** the page is accessible through a unique validated route.
3. **Given** invalid or unsafe content, **When** an Editor attempts to save, **Then** validation identifies the exact field and prevents unsafe output.
4. **Given** uploaded media, **When** it lacks required alternative text or exceeds policy, **Then** it cannot be attached to publishable content.
5. **Given** the production PointSite baseline, **When** it is imported into a fresh draft and published to staging, **Then** every current route is visually equivalent to production at 360, 768, and 1280 CSS pixels before any redesign is applied.

### User Story 3 - Deploy an exact candidate to staging (Priority: P1)

A Publisher promotes a selected immutable draft revision to staging, observes its
build and deployment, and receives route, asset, accessibility, and smoke-test
evidence tied to an exact commit.

**Independent Test**: A Publisher can stage a revision twice without duplicate or
divergent commits, while an Editor cannot invoke the action.

**Acceptance Scenarios**:

1. **Given** a valid draft revision, **When** a Publisher deploys it, **Then** a uniquely identified job writes only the staging repository and records the exact commit.
2. **Given** the same revision and idempotency key, **When** deployment is retried, **Then** the original result is returned without a duplicate release.
3. **Given** a failed build or probe, **When** the job completes, **Then** staging is not marked accepted and the failure is actionable.
4. **Given** a user without Publisher permission, **When** staging deployment is requested, **Then** it fails server-side and is audited.
5. **Given** a Publisher or Administrator whose current GitHub permission for the staging repository is read or triage, **When** staging deployment or acceptance is requested, **Then** it fails server-side even though draft authoring remains available.

### User Story 4 - Review and approve staging (Priority: P2)

A Publisher reviews a protected staging site and a complete acceptance report,
then records acceptance for the exact draft, schema, commit, and site-kit version.

**Independent Test**: Acceptance becomes invalid if any candidate identity changes.

**Acceptance Scenarios**:

1. **Given** all mandatory evidence passes, **When** a Publisher accepts staging, **Then** the immutable candidate identity and approver are recorded.
2. **Given** content, schema, renderer, or commit drift after acceptance, **When** production preparation is requested, **Then** the acceptance is rejected as stale.

### User Story 5 - Promote through a production pull request (Priority: P2)

After staging acceptance and production preparation authorization, a Publisher
creates a production branch and pull request containing the exact accepted
candidate. A separately authorized merge is verified on the live site.

**Independent Test**: Without production configuration, permission, fresh staging
acceptance, and exact-candidate approval, every production operation fails closed.

**Acceptance Scenarios**:

1. **Given** no production capability, **When** any production route is called, **Then** it returns a hard disabled response without contacting production.
2. **Given** fresh acceptance and production preparation approval, **When** promotion is requested, **Then** the system opens a reviewable production PR and never pushes to production `main`.
3. **Given** an approved exact PR, **When** publication is separately authorized, **Then** the protected merge is followed through deployment and cache-busted live verification.
4. **Given** failed production verification, **When** rollback is invoked, **Then** a revert path restores the previous known-good candidate and records evidence.

### User Story 6 - Administer access and operations (Priority: P2)

An Administrator maps authenticated identities to application roles, reviews audit
history and capacity, manages retention, and follows tested runbooks.

**Independent Test**: Removing a role takes effect on the next request and cannot
be bypassed with client state or a forged header.

**Acceptance Scenarios**:

1. **Given** an authenticated identity without an active role, **When** it calls an API, **Then** access is denied.
2. **Given** a role change, **When** the user makes another request, **Then** server-side authorization uses the new role.
3. **Given** quota warning thresholds, **When** capacity approaches a free-plan limit, **Then** Administrators see a clear warning before service failure.

## Edge Cases

- GitHub collaboration or a Builder role is removed during an active session.
- A stale browser edits a deleted or renamed page.
- Two drafts attempt to claim the same route.
- A publish job is retried after a network timeout or Worker restart.
- Staging changed outside the builder after a candidate was prepared.
- Production changed after staging acceptance.
- Uploaded media is corrupt, deceptively typed, excessively large, or orphaned.
- A theme combination fails contrast or text remains unreadable over an image.
- A schema or component version cannot render an old draft.
- Cloudflare, GitHub, or D1 is temporarily unavailable.
- Daily free-tier capacity is exhausted.

## Requirements

### Functional Requirements

- **FR-001**: Every builder, API, preview, and staging request MUST be authenticated through the PointSite GitHub App; the server MUST verify the signed session, current staging-repository collaboration and exact repository permission, and active application role, and fail closed when any evidence is missing, invalid, expired, or revoked.
- **FR-002**: Server-side authorization MUST enforce Viewer, Editor, Publisher, and Administrator capabilities independently from client controls.
- **FR-003**: Administrators MUST be able to grant, change, disable, and audit application roles for exact authenticated identities.
- **FR-004**: Editors MUST be able to create, duplicate, rename, archive, restore, reorder, and delete draft pages with validated unique routes.
- **FR-005**: Editors MUST be able to visually add, configure, reorder, duplicate, and remove approved modules using pointer and keyboard interactions.
- **FR-006**: The module catalog MUST include hero, heading, rich text, image, split feature, call-to-action, cards, people, FAQ, form, map, divider, and spacer capabilities.
- **FR-007**: Editors MUST be able to manage global identity, contact, service, giving, social, navigation, footer, and search/social metadata.
- **FR-008**: Editors MUST be able to manage theme colors, typography choices, spacing density, button treatment, section surfaces, and reusable presets within validated bounds.
- **FR-009**: The initial data set MUST reproduce every current PointSite route, navigation item, organization setting, form, content collection, and public asset reference.
- **FR-010**: Draft changes MUST autosave after no more than five seconds of idle time and expose saving, saved, conflict, offline, and error states.
- **FR-011**: Every successful draft save MUST create an attributable immutable revision, with at least 90 days of recoverable automatic history.
- **FR-012**: Stale saves MUST be rejected using optimistic concurrency and MUST NOT overwrite newer work.
- **FR-013**: Editors MUST be able to name a revision, compare revision metadata, and restore an earlier revision as a new revision.
- **FR-014**: Preview MUST render the same schema and component version used by staging at mobile, tablet, and desktop widths.
- **FR-015**: Media uploads MUST validate authentication, role, size, MIME signature, extension, dimensions, and required alternative text before use.
- **FR-016**: Draft media MUST remain private in chunked D1 storage, total private media MUST be capped below the D1 Free database limit, and unreferenced media MUST be lifecycle-deleted after 30 days.
- **FR-017**: The system MUST sanitize or reject unsafe URLs and content and MUST NOT accept arbitrary JavaScript or unrestricted HTML.
- **FR-018**: A Publisher MUST be able to deploy an exact immutable revision to staging through an idempotent, auditable job.
- **FR-019**: Staging deployment MUST write only to the configured staging repository and MUST reject any repository outside a compile-time and runtime allowlist.
- **FR-020**: Every staging job MUST record actor, source revision, schema version, renderer version, commit, workflow/deployment identity, status, timestamps, and evidence.
- **FR-021**: Staging acceptance MUST require successful build, route, asset, schema, accessibility, responsive, security, and primary-flow checks for the exact candidate.
- **FR-022**: Any change to draft revision, schema, renderer, staging commit, or production base after acceptance MUST invalidate production eligibility.
- **FR-023**: Production integration MUST be absent and disabled by default, including absence of production repository identifiers and credentials.
- **FR-024**: After separately authorized preparation, promotion MUST create a production branch and pull request; it MUST NOT directly update production `main`.
- **FR-025**: Production publication MUST require exact-candidate approval, protected required checks, and separate authorization for the merge/deployment action.
- **FR-026**: Every state-changing operation MUST create an append-only audit event without secrets or private content payloads.
- **FR-027**: State-changing APIs MUST enforce origin, content type, request-size, authorization, rate, and idempotency controls appropriate to the action.
- **FR-028**: The system MUST expose actionable health, quota, publish, storage, and audit views to Administrators.
- **FR-029**: The system MUST provide documented and tested backup, restore, credential rotation, failed-publish recovery, and production rollback procedures.
- **FR-030**: Public PointSite MUST remain a static export with no public authentication, draft storage, database, or mutation endpoint.
- **FR-031**: Deployment MUST NOT activate a paid Cloudflare plan, R2 subscription, usage-based overage billing, or require a new payment method; free-tier exhaustion MUST fail closed and surface an actionable capacity message.
- **FR-032**: Draft creation and editing MUST be available to active Builder Editors who currently hold at least GitHub read access to the staging repository; staging publication and acceptance MUST additionally require current GitHub write, maintain, or admin permission on every request, independent of the Builder role.
- **FR-033**: The Point Classic baseline MUST use one canonical data-driven renderer in the editing canvas, preview, and staging, and MUST reproduce the current production header, footer, page chrome, route content, typography, responsive behavior, and public asset placement without relying on production source at runtime.
- **FR-034**: Every visible baseline content surface MUST be represented by an editable page, global setting, collection, form, media record, or approved module field; no baseline-only hard-coded copy may become uneditable in the builder.

### Quality Requirements

- **QR-001**: Core domain, validation, authorization, persistence, and publishing logic MUST maintain at least 80 percent statement coverage.
- **QR-002**: Required interfaces MUST meet WCAG 2.2 AA with no automated critical or serious violations in primary flows.
- **QR-003**: At 10 simultaneous administrative sessions, save and read APIs MUST remain below 500 ms p95 excluding third-party publish operations.
- **QR-004**: The editor MUST remain usable at 360, 768, and 1280 CSS-pixel widths and all controls MUST be keyboard reachable.
- **QR-005**: A validated draft MUST render identically from the same schema and renderer version in editor preview and staging, excluding environment chrome.
- **QR-006**: Free-plan controls MUST warn at 70 percent of hard allowances and fail visibly rather than generating cost; no configured service may automatically bill overages.
- **QR-007**: Automated parity checks MUST compare production and staging route screenshots in a deterministic browser at 360, 768, and 1280 CSS pixels, with reviewed masks limited to documented environment-only differences and no unreviewed baseline updates.

### Key Entities

- **User Role**: Active mapping from authenticated identity to application capability.
- **Site**: Global organization, navigation, theme, page index, and version metadata.
- **Draft**: Mutable working pointer to the latest immutable site revision.
- **Revision**: Immutable validated site document with actor, checksum, schema, and renderer identity.
- **Media Asset**: Private object metadata, validation state, references, and published location.
- **Publish Job**: Idempotent staging or production operation and its exact evidence.
- **Approval**: Actor decision bound to an immutable candidate identity and gate.
- **Audit Event**: Append-only record of a security- or state-relevant action.

## Success Criteria

- **SC-001**: A first-time nondeveloper can change homepage copy, replace an image, reorder a section, preview mobile, and save a draft in under 15 minutes without assistance.
- **SC-002**: Every currently published content surface can be changed through the builder without editing source.
- **SC-003**: Reload, revision restore, and concurrent-edit tests recover all acknowledged saves with zero silent data loss.
- **SC-004**: One exact revision can be deployed repeatedly to staging with one logical result and a complete audit trail.
- **SC-005**: All production mutation attempts fail before the production gate; after the gate, promotion only produces a protected pull request.
- **SC-006**: All specified local, contract, integration, browser, accessibility, responsive, build, security, staging, and live verification gates pass for their exact candidates.
- **SC-007**: Normal operation for the expected church administrator workload remains within configured free allowances.
- **SC-008**: A documented rollback drill restores the last known-good candidate without losing draft history.
- **SC-009**: All current production routes pass structural, content-inventory, and reviewed visual-parity comparisons against the builder-authored staging candidate at all required viewports.
- **SC-010**: Hands-on browser testing proves page selection, field editing, module add/reorder/duplicate/delete, global settings, preview, save/reload, staging publication, navigation, forms, responsive menus, links, and GitHub permission denial paths.

## Clarifications

- The existing PointSite look is the initial preset, not a permanent visual restriction.
- “Fully customize” means broad layout, content, page, navigation, theme, and approved-module control; arbitrary code is excluded.
- Staging and builder repositories are private independent repositories. Production promotion uses a branch and PR in production, not a same-owner fork.
- Drafts are private service data; only reviewed candidate data is committed to staging.
- Production preparation and exact publication remain separate gates even though the overall implementation is authorized.
- “Login” means GitHub App OAuth plus live PointCommunity staging-collaborator verification and a Builder role; it does not require Cloudflare Zero Trust enrollment.
- The accepted zero-cost failure mode is temporary Builder unavailability when a hard free-tier limit is reached; the public PointSite remains unaffected.
- Visual equivalence means the same public layout and appearance from the same content at the required viewports; builder controls and staging authentication chrome are excluded.
- Builder roles never elevate GitHub repository authority: read/triage collaborators can author drafts, while write/maintain/admin is mandatory for staging publication and acceptance.
