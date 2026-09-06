# Complete asset library specification

## Boundary

Builder and PointSite staging only. PointSite production remains unchanged and locked.

## Requirements

- Library shows every image in the active draft's managed `media` collection, including the 19
  assets inherited from the production-parity baseline.
- Each managed site image shows its thumbnail, display name, source file path, alternative text,
  organizing tags, and current site usage.
- Display name, alternative text, and tags are editable without changing the asset ID or source
  path, so every existing page reference remains valid.
- Private uploads remain visible in the same workspace and can be attached to the draft.
- Empty-state language must distinguish an empty private-upload collection from the complete site
  image inventory.
- Tests prove all baseline image references resolve to managed records and that Library exposes all
  of those records.

## Acceptance

- The default draft Library lists 19 site images rather than claiming the Library is empty.
- Editing site-image metadata updates the document without changing its ID or source path.
- Unit, integration, browser, type, lint, build, and staging verification gates pass.
