# Grid Workbench Research Decisions

## Adopted patterns

- Wix Studio's CSS-grid model: column/row placement and handle-based sizing.
- Wix Studio's breakpoint cascade: desktop values are the default and narrower breakpoints may
  override them.
- Canva's approachable element library, selection affordances, and contextual editing pattern.

## PointSite-specific decisions

- Preserve Point branding and site rendering; borrow interaction principles only.
- Use twelve columns at every breakpoint so stored placement stays predictable.
- Use square row units for explicit positioning and expose exact numeric controls as the accessible
  equivalent of dragging.
- Keep legacy compatibility sections out of the free-positioning renderer so Production parity is
  not disturbed by migration.

## Primary references

- Wix Studio: Working with an Advanced CSS Grid
  https://support.wix.com/en/article/studio-editor-working-with-an-advanced-css-grid
- Wix Studio: Designing Across Breakpoints
  https://support.wix.com/en/article/studio-editor-designing-across-breakpoints
- Wix Studio: Setting the Size of Elements
  https://support.wix.com/en/article/studio-editor-setting-the-size-of-your-elements
- Canva Help: Layer, Group and Align
  https://www.canva.com/help/layer-group-align/
