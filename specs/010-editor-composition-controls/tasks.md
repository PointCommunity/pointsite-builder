# Tasks: Editor composition controls

- [x] T001 Add failing unit and browser acceptance coverage.
  - Acceptance: current code demonstrably lacks each requested behavior.
  - Verify: focused Vitest and desktop Chromium runs fail for the new assertions.
- [x] T002 Simplify save/publish controls and expose Split Feature.
  - Acceptance: Save label is concise, only the real staging Publish remains, and Split Feature is in
    the toolbox.
  - Verify: focused browser controls test passes.
- [x] T003 Add clear drop feedback and eight-direction resize behavior.
  - Acceptance: thick line, accurate moving phantom, cursor-clone handoff, and usable conditional
    cardinal/corner handles.
  - Verify: grid unit and Chromium pointer tests pass.
- [x] T004 Make header/navigation composition optional and portable.
  - Acceptance: v5 drafts preserve headers, pages can hide the built-in header, and Navigation can be
    inserted independently beside an Image or elsewhere.
  - Verify: migration, schema, renderer, and browser tests pass.
- [x] T005 Replace the Preview radio toolbar with Layout-style viewport and zoom controls.
  - Acceptance: Live preview and page choice remain; phone/tablet/desktop and Auto/manual zoom work.
  - Verify: focused Preview browser scenario passes.
- [x] T006 Complete Builder verification.
  - Acceptance: formatting, unit, type, lint, build, and full browser suites are green.
  - Verify: project-native commands complete with zero failures.
- [x] T007 Synchronize and verify PointSite Staging.
  - Acceptance: staging carries the exact schema/renderer contract and canonical baseline; Production
    is untouched.
  - Verify: staging tests, lint, build, and static verification complete locally.
