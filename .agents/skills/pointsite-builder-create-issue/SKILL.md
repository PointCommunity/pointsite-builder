---
name: pointsite-builder-create-issue
description: 'Research, discuss, draft, prioritize, and create coherent GitHub Issues for PointSite Builder. Use for proposed features, fixes, accessibility work, documentation, maintenance, or a larger request that may need splitting into Issue-sized outcomes.'
---

# Create a PointSite Builder Issue

Read `AGENTS.md` and `.agents/pointsite-builder-pipeline-policy.html`, then inspect the live `PointCommunity/pointsite-builder` repository, its open and closed Issues, open and merged pull requests, available labels, milestones, and any connected GitHub Projects before drafting. Treat all GitHub metadata as time-sensitive.

1. Ground the request in the current source, specifications, documentation, tests, and recent history. Clarify only decisions that repository evidence cannot resolve. Split unrelated goals into separate proposed Issues; combine work only when it has one coherent outcome and validation path.
2. Search open and closed Issues and pull requests for duplicate, superseded, or already-delivered scope. Explain any overlap before proposing new work.
3. For medium or larger changes, define the Issue as spec-driven work: require appropriate research, specification, plan, tasks, implementation, and verification artifacts without pre-deciding implementation details that still need investigation.
4. Draft a concise title and a complete HTML body using applicable sections from: Summary, Context and evidence, Scope, Acceptance criteria, Verification, Security and privacy, Accessibility, Dependencies, and Out of scope. Omit empty sections. Keep the Builder distinct from the public PointSite and preserve the public site's read-only boundary.
5. Propose metadata using only live repository options. Prefer exactly one primary classification label such as `bug`, `enhancement`, `documentation`, or `question`, plus directly applicable supplemental labels such as `accessibility`. Include relative Priority, Impact, and Effort in the HTML planning section for discussion, not as invented GitHub fields. Leave assignee, milestone, and Project placement unset unless the PM approves a currently available value.
6. Show the PM the complete proposed title, body, and metadata before any GitHub mutation. Put each field the PM may copy in its own fenced code block. Creation requires the exact authorization phrase `Approved to create this exact GitHub Issue`; approval applies only to the displayed draft and metadata.
7. After approval, create only the approved Issue with `gh`, apply only the approved live metadata, and do not silently repair or reorganize unrelated GitHub state.
8. Read the created Issue and any Project item back from GitHub. Verify the URL, open state, unassigned backlog state, title, byte-for-byte body, labels, assignee, milestone, and Project fields against the approved proposal, then run a final duplicate check.

Issue creation does not authorize implementation, branch creation, commits, pull requests, Builder deployment, public PointSite publication, or changes to another Issue. Never expose credentials, tokens, draft content, private media, or sensitive operational values in the Issue or command output.
