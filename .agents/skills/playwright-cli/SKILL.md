---
name: playwright-cli
description: Inspect and automate web interfaces with Microsoft's Playwright CLI using revision-pinned, safe workflows.
license: Apache-2.0
metadata:
  hermes:
    source: microsoft/playwright-cli@v0.1.19 (Apache-2.0)
    source_url: https://github.com/microsoft/playwright-cli/tree/v0.1.19/skills/playwright-cli
    tags: [playwright, browser, cli, testing, visual-qa]
    related_skills: [image-to-code, web-design-guidelines]
---

# Playwright CLI

## Description

Use Microsoft's Playwright CLI for browser inspection, interaction, screenshots, console and request diagnosis, interactive Playwright-test debugging, test generation, tracing, storage-state workflows, and video capture. Prefer an environment's native browser-control tool when it provides the required capability or an already-authorized session; use this skill when the CLI is requested or materially improves local, repeatable browser work.

The command and workflow references are vendored from v0.1.19. Keep actions within the user's authorized sites, accounts, data, and mutation scope.

## Prerequisites

- Node.js 18 or newer and npm/npx.
- An authorized URL and, for local applications, a running development server.
- Playwright CLI v0.1.19, either installed globally or invoked through pinned `npx`.

## Steps

1. Select a deterministic invocation path.

   ```bash
   playwright-cli --version
   ```

   Expected result: `0.1.19`. If the global command is unavailable or reports another version, use the pinned form for every command:

   ```bash
   npx --yes @playwright/cli@0.1.19 --version
   ```

   Expected result: `0.1.19`. First use may download the package or browser runtime.

2. Read `references/official-cli-reference.md` for the command surface. Load only the workflow-specific reference needed for advanced work:

   - `element-attributes.md` — inspect DOM attributes and computed styles.
   - `playwright-tests.md` — attach to and debug Playwright tests.
   - `request-mocking.md` — intercept or simulate network behavior.
   - `running-code.md` — execute advanced Playwright functions.
   - `session-management.md` — isolate or reuse browser sessions.
   - `storage-state.md` — cookies and browser storage.
   - `test-generation.md` — plan, generate, and heal Playwright tests.
   - `tracing.md` — collect diagnostic traces.
   - `video-recording.md` — capture an authorized demonstration.

3. Open the target and capture a fresh snapshot.

   ```bash
   npx --yes @playwright/cli@0.1.19 open "<authorized-url>"
   npx --yes @playwright/cli@0.1.19 snapshot
   ```

   Expected result: the CLI reports the page URL/title and writes a snapshot containing current element references.

4. Interact using references from the latest snapshot. Re-snapshot after navigation, modal changes, rerenders, or any action that can invalidate references.

   ```bash
   npx --yes @playwright/cli@0.1.19 click <element-ref>
   npx --yes @playwright/cli@0.1.19 snapshot
   ```

   Expected result: the requested state change appears in the new snapshot. Use role locators or stable test IDs when a ref is unsuitable.

5. Gather evidence appropriate to the task rather than collecting every artifact.

   ```bash
   npx --yes @playwright/cli@0.1.19 console
   npx --yes @playwright/cli@0.1.19 requests
   npx --yes @playwright/cli@0.1.19 screenshot --filename=playwright-evidence.png
   ```

   Expected result: relevant console/network state and an optional screenshot. Do not capture or publish secrets, session tokens, personal data, or unrelated authenticated content.

6. Close sessions created for the task.

   ```bash
   npx --yes @playwright/cli@0.1.19 close
   ```

   Expected result: the task-created browser session exits. Do not close a user-owned browser or shared session unless requested.

7. For repository changes, run the focused browser scenario, the repository's required suite, and:

   ```bash
   git diff --check
   ```

   Expected result: the observed behavior matches the requested outcome and all required checks pass.

## Pitfalls

- **Version drift:** Unpinned `latest` can change commands or behavior. Use v0.1.19 until a reviewed skill update advances the pin.
- **Stale references:** Snapshot element refs are ephemeral after DOM changes; capture a fresh snapshot.
- **Authorization expansion:** Browser access does not authorize purchases, submissions, messages, uploads, account changes, or destructive actions.
- **Sensitive state:** Cookie, local-storage, trace, request, and screenshot output may contain secrets or private data. Minimize collection and never commit it.
- **Production mutation:** Prefer local, test, preview, or disposable environments. Confirm scope before mutating a live service.
- **Shared session damage:** Do not clear storage, delete profiles, kill all browsers, or close user-owned sessions without explicit authorization.
- **Artifact pollution:** CLI output commonly lands under `.playwright-cli/`; keep transient evidence ignored unless the user requests a durable artifact.
- **False visual confidence:** Accessibility snapshots validate structure, not visual fidelity. Use same-viewport screenshots for design work.

## Verification

1. Confirm the executable and version:

   ```bash
   npx --yes @playwright/cli@0.1.19 --version
   ```

   Expected result: `0.1.19` and exit status 0.

2. Confirm the task's target URL, viewport, state, and expected behavior were explicitly identified.
3. Confirm the final snapshot or screenshot shows the requested outcome.
4. Confirm relevant console errors, failed requests, and browser-side exceptions were reviewed.
5. Confirm task-created sessions are closed and sensitive/transient artifacts are not staged accidentally.

## Cross-References

- `image-to-code` — same-viewport implementation comparison.
- `web-design-guidelines` — standards checklist to apply to the inspected UI.
- `references/official-cli-reference.md` — complete pinned CLI reference.
- `references/element-attributes.md`, `references/playwright-tests.md`, `references/request-mocking.md`, `references/running-code.md`, `references/session-management.md`, `references/storage-state.md`, `references/test-generation.md`, `references/tracing.md`, and `references/video-recording.md` — workflow-specific official references.
- `references/PROVENANCE.md` — version pin and standalone adaptation notes.
- `references/UPSTREAM-LICENSE.txt` — upstream Apache License 2.0.
