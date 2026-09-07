---
name: pointsite-builder-review-issue
description: 'Perform complete agent QA for the active PointSite Builder Issue, remediate findings, and hand the exact verified pull request to direct production closure.'
---

# Review a PointSite Builder Issue

Read `AGENTS.md`, `.agents/pointsite-builder-pipeline-policy.html`, the sole active Issue, PR diff and history, acceptance criteria, relevant specifications, and current test guidance.

1. Require one open Issue assigned only to `brimdor` and exactly one matching open PR whose body contains `Refs #<number>` without auto-close syntax.
2. Review correctness, regressions, security, privacy, authorization, error paths, migrations, operations, accessibility, responsive behavior, documentation, and repository instructions in proportion to the diff.
3. Run focused tests, `npm run check`, `npm run test:performance`, `npm run test:e2e`, and `git diff --check`. Rehearse migrations locally when applicable. Use hands-on browser testing against a local instance for every affected flow at relevant desktop, tablet, and phone widths.
4. Remediate every finding on the same Issue branch. Repeat the affected review surface until there are zero unresolved findings.
5. Ensure the PR is current with `main`, ready for review, and the exact committed head passes every GitHub Quality job. Record the Issue, PR URL, head commit, head tree, test evidence, and Quality run.
6. If the PM requested a review-only or pre-deployment stop, report the verified candidate and stop. Otherwise invoke `pointsite-builder-close-issue`; there is no Builder Canary, Staging deployment, or separate routine production-approval gate.

PM findings before release are blocking and create a new reviewed candidate. Never deploy a changed or failing head.
