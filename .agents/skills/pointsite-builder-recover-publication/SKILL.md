---
name: pointsite-builder-recover-publication
description: 'Diagnose and recover PointSite Builder Staging or Production publications that are stuck, repeatedly cancelling, returning stale progress, or failing before GitHub Actions reserves a runner.'
---

# Recover PointSite Builder Publications

Use this skill when a Builder publication does not advance, status checks or cancellation retries do nothing, or GitHub Actions fails before the job receives its expected identity. Read `AGENTS.md`, `.agents/pointsite-builder-pipeline-policy.html`, the owning Issue, and the relevant work/review/release skill before mutation.

Do not report that a publication is merely stuck or wait for it to resolve itself. Continue through diagnosis, durable repair, deployment when authorized, and live recovery until publishing is available again or a specific external permission or destructive action blocks further work.

## Diagnose the live incident

1. Use the internal browser against the affected Canary or Production Builder. Preserve the authenticated session. Record the draft, destination, visible phase, status text, available actions, and console errors. Do not ask the PM to repeat actions that can be inspected directly.
2. Read `/api/health` and the exact deployed source/tree. For Canary, verify homelab Argo revision/health, running image digest and pod readiness. For Production, verify the Linode `pointsite-builder.service`, Podman image tag/ID and local health/readiness; do not use the retained homelab `builder` application as Production evidence. Confirm whether the affected environment contains the expected fix before changing data or retrying controls.
3. Inspect the publication row and its transitions with supported read-only access. Correlate repository, workflow, event, ref, SHA, creation window, reserved run/job IDs, build/result/deployment fields, and authorization state.
4. Inspect the complete scoped GitHub Actions run listing, including zero-job failures and runs with generic titles. Trace the UI action through the API, cancellation continuation, provider client, scheduler, and atomic database mutation. A missing expected run name or run ID is evidence to explain, not a reason to stop.

Classify the incident before editing:

- an active exact-identity GitHub run that can be cancelled;
- a terminal named or reserved run whose local state is stale;
- a pre-reservation workflow failure with zero jobs or no dynamic run name;
- incomplete, truncated, unavailable, mismatched, or racing provider evidence;
- an older deployed Builder image that lacks an already reviewed repair.

## Recover safely

- When the exact GitHub run identity is known and publishing has not begun, cancel that run through the existing server-side GitHub client and keep the Builder cancellation action available through the last safely cancellable phase. Never cancel an unrelated or merely similar run.
- For an unreserved cancelled publication, release the slot only after a complete provider listing proves every run in the captured repository, revision, branch, workflow, event, and time scope is terminal. In the same transaction, recheck that no run/job reservation, build, result, deployment, or deployment authorization appeared. Unavailable, truncated, active, mismatched, or racing evidence must remain fail closed.
- Never send a GitHub cancellation request for an unnamed run. Reconcile a proven terminal pre-reservation failure locally instead.
- A retry must be bounded and evidence-driven. Do not keep clicking Check or Retry cancellation without a state change or new provider evidence.
- If source repair is required, continue the owning active Issue. Feedback after a merged PR uses a focused same-Issue remediation PR. Add the narrowest regression test that reproduces the failed state transition.
- If an approved immutable Canary candidate already contains the repair, use `pointsite-builder-release-production`; require its exact candidate approval and deploy the same approved source/tree to Linode with `npm run release:production`. Do not modify Production through Kubernetes or invoke the legacy `scripts/release-native.mjs production` action.

## Prove recovery

Deployment is incomplete until the existing stuck record recovers. Allow the scheduled continuation to process it or invoke one supported status/cancellation retry in the internal browser. Do not start a new publication as a test.

Verify all of the following:

- Canary Argo is Synced and Healthy on the intended revision and exact image digest, or Linode Production runs the intended image tag/ID with `pointsite-builder.service` active;
- `/api/health`, HTML, and derived assets pass;
- the authenticated affected workspace loads in the internal browser;
- the old `Cancelling…`, stale-progress, or retry loop is gone;
- the publication shows a truthful terminal state and the appropriate publish action is available again;
- no new publication was created and browser console errors/warnings are empty;
- the durable source path handles restart and scheduled retry, so recovery does not depend on the current browser tab.

Record concise evidence on the owning Issue or PR: root cause, source/tree, tests, Canary image/GitOps or Production Linode image/service identity, previous and recovered UI states, and whether a GitHub run was cancelled or a terminal unreserved slot was reconciled. Keep the Issue lifecycle and PM gates unchanged.

This skill may cancel only the publication the PM asked to recover. It never authorizes publishing or restoring the public PointSite, destructive data/schema recovery, credential changes, or unrelated GitHub Actions cancellation.
