# PointSite Builder

Private, collaborator-only visual authoring for the Point Community Church website.

The builder stores private drafts, previews the same controlled components used by
PointSite, and promotes validated candidates through GitHub review. It never runs
inside the public website and never gives public visitors a write path.

## Safety boundary

- `PointCommunity/pointsite` remains the production source of truth.
- `PointCommunity/pointsite-staging` receives and proves candidates first.
- Production access is absent until a separately approved production gate.
- Published changes are commits and pull requests, never direct browser writes.
- Authentication uses a staging-only GitHub App and current collaborator checks.
- Hosting uses hard-limited Workers Free and D1 Free only; Zero Trust, R2,
  paid plans, payment setup, and usage-based overages are excluded.

Implementation and operating instructions are developed under `specs/`.
