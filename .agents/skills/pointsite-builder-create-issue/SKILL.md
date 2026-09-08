---
name: pointsite-builder-create-issue
description: 'Research, discuss, draft, prioritize, and create coherent GitHub Issues for PointSite Builder. Use for proposed features, fixes, accessibility work, documentation, maintenance, or a larger request that may need splitting into Issue-sized outcomes.'
---

# Create a PointSite Builder Issue

Read `AGENTS.md` and `.agents/pointsite-builder-pipeline-policy.html`, then inspect the live `PointCommunity/pointsite-builder` repository, private Project `PointSite Builder` number `1`, open and closed Issues, open and merged pull requests, available labels, and milestones before drafting. Treat all GitHub metadata as time-sensitive.

1. Ground the request in the current source, specifications, documentation, tests, and recent history. Clarify only decisions that repository evidence cannot resolve. Split unrelated goals into separate proposed Issues; combine work only when it has one coherent outcome and validation path.
2. Search open and closed Issues and pull requests for duplicate, superseded, or already-delivered scope. Explain any overlap before proposing new work.
3. For medium or larger changes, define the Issue as spec-driven work: require appropriate research, specification, plan, tasks, implementation, and verification without pre-deciding implementation details that still need investigation. Do not require a standalone acceptance report or duplicate closeout artifact unless the PM explicitly requests that artifact as a deliverable.
4. Draft a concise title and a complete HTML body using applicable sections from: Summary, Context and evidence, Scope, Acceptance criteria, Verification, Security and privacy, Accessibility, Dependencies, and Out of scope. Omit empty sections. Keep the Builder distinct from the public PointSite and preserve the public site's read-only boundary.
5. Propose exactly one live `type:*` label, every directly applicable live `area:*` label, Priority, Impact, Effort, assignee, milestone, and Project Status. New Issues default to open, unassigned, no milestone, and Backlog unless the PM approves another currently valid optional value.
6. Show the PM the complete proposed title, body, and metadata before any GitHub mutation. Put each field the PM may copy in its own fenced code block. Creation requires the exact authorization phrase `Approved to create this exact GitHub Issue`; approval applies only to the displayed draft and metadata.
7. After approval, create only the approved Issue with `gh`, add it to Project number `1`, set Status Backlog, populate Priority, Impact, and Effort, and apply only the approved live metadata. The agent performs this transition; never ask the PM to add or move the card.
8. Read the created Issue and Project card back from GitHub. Verify the URL, open state, unassigned Backlog state, title, byte-for-byte body, governed labels, assignee, milestone, Priority, Impact, and Effort against the approved proposal, then run a final duplicate check.

Issue creation does not authorize implementation, branch creation, commits, pull requests, Builder deployment, public PointSite publication, or changes to another Issue. Never expose credentials, tokens, draft content, private media, or sensitive operational values in the Issue or command output.
