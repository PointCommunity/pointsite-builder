# Accessibility Evidence Matrix

**Target**: WCAG 2.2 AA engineering evidence, not legal certification.

| Route/state                                       | Viewports      | Inputs                   | Automated | Manual evidence                                     |
| ------------------------------------------------- | -------------- | ------------------------ | --------- | --------------------------------------------------- |
| Draft list: loading, empty, populated, error      | 320, 768, 1280 | Keyboard, pointer        | axe       | landmarks, headings, focus, long names              |
| Editor: saved, saving, offline, conflict, invalid | 721, 768, 1280 | Keyboard, pointer, touch | axe       | non-drag reorder, status announcements, zoom/reflow |
| Editor: widen-window warning                      | 320, 360, 720  | Keyboard, pointer, touch | axe       | authoring controls hidden; draft remains safe       |
| Preview: Point and overhaul presets               | 360, 768, 1280 | Keyboard, pointer        | axe       | reading order, contrast, image alternatives         |
| Revision restore dialog                           | 320, 1280      | Keyboard, pointer        | axe       | focus entry, trap, Escape, focus return             |
| Media: empty, upload, rejection, library          | 320, 768, 1280 | Keyboard, pointer        | axe       | labels, progress, errors, alt-text workflow         |
| Publish: denied, ready, running, failed, success  | 320, 1280      | Keyboard, pointer        | axe       | confirmation, live status, recovery path            |
| Roles and audit                                   | 768, 1280      | Keyboard, pointer        | axe       | table semantics, filtering, validation              |

## Manual acceptance

- One `h1`, logical headings, skip link, header/nav/main/status landmarks.
- Native button, link, form, table, details, and dialog semantics where possible.
- All functions keyboard-operable with visible, unobscured focus and correct return.
- Dragging has button and keyboard alternatives with equivalent outcomes.
- Persistent labels, autocomplete/input purpose, inline errors, error summary, and first-error focus.
- Saving, errors, conflicts, uploads, and publish progress announce without noisy duplication.
- Content survives 200 percent text zoom and applicable 400 percent reflow.
- Text, controls, focus, and graphics meet contrast requirements in supported themes.
- No information depends only on color, position, shape, sound, or motion.
- Reduced motion disables nonessential transitions; no flashing or autoplay.
- Targets meet minimum size or spacing and pointer cancellation expectations.
- Page language, titles, image alternatives, link purpose, and status roles are correct.

## Evidence limits

Automated checks cannot establish full conformance. Screen-reader announcement
quality, meaningful alternatives, reading order, conflict recovery, cognitive
clarity, and real keyboard usability require manual observation and remain
explicitly unverified until the running application is available.
