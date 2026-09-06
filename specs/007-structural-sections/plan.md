# Plan: Structural section toolbox

1. Replace the existing recipe E2E expectation with the approved structural-only toolbox contract
   and confirm it fails against the current UI.
2. Remove insertion-only recipe component registrations and factories while retaining all four
   structural sections and atomic element controls.
3. Run focused and full verification, then deploy only the Builder if the exact change is green.

Risk is low because recipes are not persisted. The main regression risk is accidentally removing an
atomic constituent or making an existing saved section unrecognizable; browser and full-suite checks
cover both.
