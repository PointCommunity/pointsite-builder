# Tasks: Structural section toolbox

- [x] T001 Replace the recipe insertion E2E scenario with the structural toolbox contract.
  - Acceptance: the test rejects recipe controls and requires all structural and atomic controls.
  - Verify: focused Chromium test fails before implementation and passes afterward.
- [x] T002 Remove recipe-only component types, defaults, factories, and insertion handling.
  - Acceptance: only four empty structural section types remain; saved data conversion is unchanged.
  - Verify: typecheck and focused browser test pass.
- [x] T003 Complete local regression verification.
  - Acceptance: unit, lint, build, and the full browser matrix pass.
  - Verify: project-native commands and local browser evidence.
