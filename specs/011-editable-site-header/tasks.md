# Tasks: Editable Site Header

- [x] T001 Reproduce the fixed-header defect in unit tests.
  - Acceptance: tests require ordinary Image and Navigation placements and fail on v6 behavior.
  - Verify: focused Vitest command fails for the expected assertions.
- [x] T002 Migrate v6 pages to editable header content.
  - Acceptance: v7 removes `showHeader`, injects deterministic responsive header grids only where
    the legacy header was enabled, and preserves all existing content.
  - Verify: focused migration and renderer tests pass.
- [x] T003 Make new-page and menu editing behavior complete.
  - Acceptance: new pages include the same header composition and Navigation selection exposes the
    shared menu editor.
  - Verify: focused unit/component tests pass.
- [x] T004 Verify the complete authoring interaction.
  - Acceptance: an editor can select and remove the logo, edit menu entries, and drag/snap/resize the
    Navigation element.
  - Verify: focused Playwright test and full repository suite pass.
