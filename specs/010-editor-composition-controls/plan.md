# Plan: Editor composition controls

1. Write failing unit and browser expectations for the user-visible toolbar, toolbox, grid preview,
   edge resize, header visibility, navigation element, migration, and Preview controls.
2. Deliver the small command/toolbox slice: rename Save, suppress only Puck's publish action, expose
   Split Feature, and thicken the Puck drop indicator.
3. Deliver grid interaction improvements: share the snapped insertion calculation with a visible
   in-grid phantom, hide the cursor clone only over the grid, and add collision-safe cardinal resize
   handles alongside corners.
4. Deliver header composition: schema v6, deterministic v5 migration, per-page built-in-header
   visibility, and a responsive Navigation element backed by global navigation data.
5. Deliver the read-only Preview toolbar with responsive viewport buttons and fitted/manual zoom.
6. Run focused checks after each slice, then complete the full local quality and browser matrix.
7. Synchronize the versioned site-kit and canonical baseline into PointSite Staging and verify its
   static build; do not deploy or modify Production.

The highest-risk area is Puck's cross-frame drag feedback. The implementation will use the pinned
Puck DOM contract only for detecting a toolbox drag and will keep final placement authoritative in
the existing collision-checked grid resolver.
