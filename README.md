# PointSite Builder

PointSite Builder is a visual content-management app for the Point Community Church website. Authorized church collaborators can edit drafts, preview pages, manage media and site settings, review revision history, and publish changes through GitHub-backed workflows.

The builder is a separate application, not part of the public website. Visitors can browse the published site but cannot access the builder. Builder sign-in checks current GitHub repository collaboration, and application roles control administrative and publishing actions.

## Capabilities

- Edit page content and layout in a visual canvas, with responsive previews.
- Manage drafts, revisions, media, navigation, theme, forms, and site settings.
- Publish to staging and verify the resulting deployment.
- Publish to or roll back production only when the deployment enables it and the user is authorized. Production operations are implemented, not universally disabled.
- Run as a Cloudflare Worker or a native Node.js service. The native build and local QA server support development and operations.

## Publication boundaries

- `PointCommunity/pointsite` is the production site repository; `PointCommunity/pointsite-staging` is the staging destination.
- Published changes are recorded in GitHub; the public website does not provide a write path into the builder.
- Deployment targets and credentials are configured by operators. Follow the runbooks before remote setup or publication.

## Local development

Requirements: Node.js 22.18 or newer (see `package.json`), npm, and Git. Remote integration and deployment also require authorized GitHub and Wrangler access.

```sh
npm ci
cp .dev.vars.example .dev.vars
# Set non-production local values in .dev.vars; never commit it.
npm run db:migrate:local
npm run dev
```

Local authentication requires `ENVIRONMENT=local` and `DEV_AUTH_EMAIL`. The [quickstart](specs/001-pointsite-builder/quickstart.md) describes database setup, seeding, and safe integration steps. Do not use production credentials for local development.

## Checks

GitHub Actions runs governance checks, dependency and secret scanning, and source security scans. Full application checks are available locally:

```sh
npm run format:check
npm run typecheck
npm run lint -- --max-warnings=0
npm run test:coverage
npm run test:e2e
npm run build
npm run build:native
```

`npm run check` is the aggregate check command; see `package.json` for its constituent steps.

## Further documentation

- [Local setup and safe integration quickstart](specs/001-pointsite-builder/quickstart.md)
- [Operator handbook](docs/operator-handbook.html)
- [Architecture decisions](docs/adr/index.html)
- [Security scanning](docs/security-scanning.html)
