# Research: Standardized Section Composer

## Nested composition

**Decision**: Use Puck 0.23 slot fields for section-owned element lists.  
**Rationale**: Official Puck documentation supports nested and multi-column drag-and-drop across CSS grid/flex layouts, slot allowlists, and default slot content.  
**Source**: https://puckeditor.com/docs/integrating-puck/multi-column-layouts

## Builder information architecture

**Decision**: Make sections the page-level structure, with blank/preset insertion and categorized elements.  
**Rationale**: Wix Studio and Hostinger both use sections as primary page structure, offer blank/preset sections, and place elements within sections.  
**Sources**: https://support.wix.com/en/article/studio-editor-adding-and-managing-sections ; https://support.hostinger.com/en/articles/6475040-website-builder-how-to-add-and-customize-website-sections

## Responsive layout

**Decision**: Use a bounded 12-column desktop grid with predictable single-column mobile stacking rather than free placement or overlap.  
**Rationale**: Wix uses cells/grids to avoid overlap, Squarespace uses a grid with separate mobile considerations, and WCAG 2.2 reflow requires content remain available at 320 CSS pixels.  
**Sources**: https://support.wix.com/en/article/studio-editor-about-cells-and-grids ; https://support.squarespace.com/hc/en-us/articles/206543987-Moving-blocks-to-customize-layouts ; https://www.w3.org/WAI/WCAG22/Understanding/reflow.html

## Theme isolation

**Decision**: Theme Builder chrome with documented Puck CSS tokens and keep preview iframes isolated.  
**Rationale**: Puck 0.23 exposes supported theming tokens, while the existing integration already disables host-style synchronization.  
**Source**: https://puckeditor.com/docs/extending-puck/theming

## Accessibility

**Decision**: Retain outline/move-button alternatives to dragging and targets of at least 24 CSS pixels.  
**Rationale**: WCAG 2.2 adds Dragging Movements and Target Size requirements; structure controls provide equivalent non-spatial operations.  
**Sources**: https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/ ; https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum
