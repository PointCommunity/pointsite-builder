# Data Model: PointSite Builder

## Candidate identity

Every deployable candidate is the tuple:

`site_id + revision_id + revision_checksum + schema_version + renderer_version + staging_base_sha`

Approvals and jobs reference the entire tuple. A change to any member invalidates
the approval.

## SiteDocument

- `schemaVersion`: positive integer
- `rendererVersion`: semantic version
- `site`: organization identity, mission, address, service, email, external links
- `theme`: bounded colors, fonts, spacing, radii, buttons, surfaces
- `navigation`: ordered entries with zero or more children
- `pages`: ordered page documents with route, metadata, status, and component data
- `forms`: public mailto form definitions; no submitted form data
- `collections`: people, beliefs, groups, events, and reusable structured records

Validation rules:

- Unknown top-level or component fields are rejected.
- Routes are lowercase, unique, slash-prefixed, and exclude reserved API/admin paths.
- URLs allow only `https`, `mailto` where appropriate, same-site paths, and approved map embedding.
- Colors are six-digit hex values and foreground/background pairs must meet defined contrast checks for text roles.
- Page and block identifiers are UUIDs; titles and copy have explicit size bounds.
- Component types must exist in the renderer version's registry.

## UserRole

| Field        | Type              | Rule                                     |
| ------------ | ----------------- | ---------------------------------------- |
| email        | canonical string  | Primary key; `github:<stable-user-id>`   |
| github_login | normalized string | Unique administrator-facing login        |
| role         | enum              | viewer, editor, publisher, administrator |
| active       | boolean           | False denies all application operations  |
| created_at   | timestamp         | Immutable                                |
| updated_at   | timestamp         | Changes on role/status mutation          |
| updated_by   | string            | Authenticated administrator identity     |

## Draft

| Field                   | Type      | Rule                      |
| ----------------------- | --------- | ------------------------- |
| id                      | UUID      | Primary key               |
| site_id                 | string    | Initial value `pointsite` |
| name                    | string    | 1–100 characters          |
| latest_revision_id      | UUID      | References Revision       |
| status                  | enum      | active, archived, deleted |
| created_by              | string    | Authenticated identity    |
| created_at / updated_at | timestamp | Server assigned           |

State transitions: `active → archived → active`; `active|archived → deleted`.
Deleted drafts remain recoverable for 30 days before purge.

## Revision

| Field                   | Type          | Rule                             |
| ----------------------- | ------------- | -------------------------------- |
| id                      | UUID          | Primary key                      |
| draft_id                | UUID          | Parent draft                     |
| sequence                | integer       | Monotonic per draft              |
| parent_revision_id      | UUID/null     | Optimistic concurrency base      |
| checksum                | SHA-256       | Canonical document checksum      |
| document_json           | JSON text     | Validated immutable SiteDocument |
| label                   | string/null   | Optional human name              |
| schema_version          | integer       | Copied from document             |
| renderer_version        | string        | Copied from document             |
| created_by / created_at | identity/time | Immutable                        |

Unique constraints: `(draft_id, sequence)`, `(draft_id, checksum)`.

## MediaAsset

| Field                   | Type           | Rule                                            |
| ----------------------- | -------------- | ----------------------------------------------- |
| id                      | UUID           | Primary key                                     |
| object_key              | string         | Random key for private D1 chunks                |
| filename                | string         | Sanitized display name                          |
| content_type            | enum           | image/jpeg, image/png, image/webp, image/avif   |
| byte_size               | integer        | 1–5,242,880                                     |
| width / height          | integer        | 1–8000                                          |
| checksum                | SHA-256        | Deduplication and integrity                     |
| alt_text                | string         | Required before attachment                      |
| status                  | enum           | uploading, ready, rejected, published, orphaned |
| created_by / created_at | identity/time  | Immutable                                       |
| last_referenced_at      | timestamp/null | Retention input                                 |

Media bytes are stored in `media_object_chunks` using ordered chunks of at most
1,000,000 bytes. The `(object_key, chunk_index)` pair is unique, each recorded
size must match the BLOB length, and the application refuses uploads above a
250 MB total-media cap.

## PublishJob

| Field                       | Type           | Rule                                               |
| --------------------------- | -------------- | -------------------------------------------------- |
| id                          | UUID           | Primary key                                        |
| idempotency_key             | string         | Unique per environment/action                      |
| environment                 | enum           | staging, production-pr, production-merge, rollback |
| status                      | enum           | queued, running, succeeded, failed, cancelled      |
| candidate_json              | JSON text      | Immutable candidate tuple                          |
| repository                  | string         | Must equal environment allowlist                   |
| base_sha / result_sha       | string         | Exact Git identities                               |
| external_url                | string/null    | Workflow, deployment, or PR URL                    |
| evidence_json               | JSON text      | Bounded structured evidence only                   |
| requested_by / requested_at | identity/time  | Immutable                                          |
| completed_at                | timestamp/null | Terminal-state timestamp                           |

Only one running job per environment is allowed.

## Approval

| Field              | Type          | Rule                                                               |
| ------------------ | ------------- | ------------------------------------------------------------------ |
| id                 | UUID          | Primary key                                                        |
| gate               | enum          | staging-acceptance, production-preparation, production-publication |
| candidate_checksum | string        | Exact candidate tuple checksum                                     |
| decision           | enum          | approved, rejected, revoked                                        |
| actor / created_at | identity/time | Immutable                                                          |
| note               | string/null   | Bounded rationale                                                  |

Only the latest non-revoked approval for an unchanged candidate is effective.

## AuditEvent

- `id`, `occurred_at`, `actor`, `action`, `target_type`, `target_id`
- `outcome`, `request_id`, `ip_hash`, `metadata_json`

Audit metadata contains identifiers and outcomes, never tokens, private keys,
full site documents, uploaded media bytes, or public form submissions.

## Retention

- Automatic revisions: 90 days minimum; named revisions retained with draft.
- Deleted drafts: 30-day recovery window.
- Unreferenced draft media: orphan after 7 days, delete after 30 days.
- Audit and publish records: 400 days initially, export before purge.
- Public candidate data follows Git history and production retention policy.
