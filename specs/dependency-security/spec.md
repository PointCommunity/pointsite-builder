# Dependency security repair

Refs #91. This is a supporting maintenance change against main; the pending
composition acceptance candidate and its deployed application stay unchanged.

## Evidence

- Scheduled Quality run 41475757289 failed its dependency audit on main
  d9f3a7fe4de1c6017ce4c612fa828214c6c02113. Production-only Dependabot PR #97
  also fails because its unchanged development graph remains vulnerable.
- The local lockfile audit reproduces 27 findings. Vulnerable direct packages,
  transitive packages and pinned overrides all contribute.
- The repository has weekly split version-update groups, but automated security
  updates are disabled. Independent production and development bumps cannot
  produce a passing complete-graph security check on this baseline.

## Contract

1. Clean installation and the complete dependency audit must pass with no known
   findings at verification time. Include development dependencies; preserve all
   security gates, rule enforcement, integrity hashes and installation safeguards.
2. Use patched upstream releases. Retain the existing Puck, React, TypeScript and
   application behavior. Test the upgraded emulator, native server and build tools.
3. Group future npm security updates across development and production dependencies.
   Keep routine major upgrades outside the minor/patch maintenance group. Security
   fixes may cross major boundaries when required and remain subject to review.
4. CI stays lightweight: dependency-free governance checks and source, secret and
   dependency scans only. Installation continues to use --ignore-scripts.
5. Verify local quality, performance and browser suites before publishing a candidate
   and checking a fresh exact-head Quality run. Do not rerun old failed Actions.
6. Existing merge, deployment, content-publication and Human acceptance gates remain.
   A passing PR alone does not repair scheduled checks on main until it is merged.

## Plan and verification

- Reproduce the audit and add regression coverage for patched glob matching plus
  actual ESLint error enforcement; observe failure against the vulnerable baseline.
- Refresh only affected direct packages and necessary transitive overrides/locks.
  Preserve compatible installed APIs and avoid unrelated product upgrades.
- Add a separate all-dependency security-update group and a combined routine
  minor/patch group. Review CI inputs and update their review ledger after inspection.
- Run clean install, regression tests, repository gates, performance, browser tests,
  audit, workflow validation and diff checks sequentially. Record exact source/tree,
  commands, exits, limitations and test cleanup in the supporting PR.
- Verify provider security-update configuration and fresh exact-head Quality.
  Future advisories still require maintenance; no permanent zero-failure promise.
