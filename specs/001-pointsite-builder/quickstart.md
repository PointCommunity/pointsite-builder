# Quickstart: PointSite Builder

## Prerequisites

- Node.js 22.13 or newer
- npm 10 or newer
- GitHub CLI authenticated as an authorized PointCommunity member
- Wrangler 4 authentication for remote resources and deploys

## Local application

1. Copy `.dev.vars.example` to `.dev.vars` and use only non-production local values.
2. Install exact dependencies with `npm ci`.
3. Apply local D1 migrations with `npm run db:migrate:local`.
4. Seed the first local administrator with `npm run db:seed:local -- --email <email>`.
5. Start with `npm run dev`; local development authentication is accepted only when
   `ENVIRONMENT=local` and `DEV_AUTH_EMAIL` is configured.

## Validation

- `npm run format:check`
- `npm run lint`
- `npm run typecheck`
- `npm run test:coverage`
- `npm run test:e2e`
- `npm run build`
- `npm audit --audit-level=high`

## Safe integration scenario

1. Create a draft from the seeded PointSite document.
2. Change a hero heading and theme accent.
3. Confirm save state, reload, and restore the previous revision.
4. Preview at mobile, tablet, and desktop widths.
5. Publish the exact revision to staging.
6. Confirm the staging job records source checksum, staging base/result SHA, and
   verification evidence.
7. Confirm production actions remain absent and the API returns `PRODUCTION_DISABLED`.

## Remote setup order

1. Confirm the account remains on Workers Free; use the existing D1 database only.
2. Apply remote migrations and seed the exact GitHub administrator ID/login.
3. Register/install the GitHub App on staging only and store its OAuth, installation,
   and session-signing values as Worker secrets.
4. Deploy builder and staging Workers with `workers.dev` and preview URLs disabled.
5. Verify anonymous, forged, expired, revoked-collaborator, and inactive-role requests fail closed.
6. Add `builder.pointatx.org` and `staging.pointatx.org` only after the GitHub authentication matrix passes.
7. Never activate Zero Trust, R2, a Workers Paid plan, or any payment method for this system.
8. Do not configure production integration until G6.

## Recovery drills

- Restore a draft revision and verify checksum changes as a new revision.
- Interrupt and retry a publish with the same idempotency key.
- Create an out-of-band staging commit and verify base-SHA conflict.
- Remove a user role and verify the next request is denied.
- Remove staging collaboration and verify the next request is denied.
- Roll staging back to its previous known-good candidate.
