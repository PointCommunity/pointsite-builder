# Plan: Editable Site Header

1. Add failing migration and renderer tests for converting the fixed v6 header to ordinary grid
   content.
2. Introduce SiteDocument v7, a deterministic editable-header section factory, and v6-to-v7
   migration while preserving disabled-header pages.
3. Remove the fixed SiteHeader render path and create new pages with the editable header section.
4. Reuse the shared Navigation editor inside the selected Navigation element.
5. Add browser coverage for selecting, editing, removing, dragging, snapping, and resizing header
   items; then run the full verification suite.

Risk controls: deterministic IDs prevent migration drift, the prior `showHeader: false` state avoids
unwanted injection, and the existing validated navigation collection remains the single menu source.
