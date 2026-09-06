# Plan: Editor focus retention

1. Add controlled-rerender unit regressions and a real visual-editor typing regression.
2. Confirm the regressions fail because editable values are used as React keys.
3. Replace only unstable row keys, audit every Builder list key, and rerun focused checks.
4. Run the complete quality and browser gates before Builder deployment.
