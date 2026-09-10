# Pipeliner framework refresh

Update baseline e9b3c976c2112ca5293cd547fd219b9f734f5234 to reviewed upstream d07653633104e632ebeeb25a3ab67ce32b973382 under the framework-maintenance exception.

## Requirements and resolved choices

- Refresh all upstream-managed framework files, preserving Builder-specific skills, approval phrases, Issue selection, direct Cloudflare Production, local full QA, Project identity and existing controls.
- Human PM confirmed Agent Dev ID `Dev`, accountable GitHub login `brimdor`, and Human PM ID `brimdor`. Retain the single Apple Silicon macOS environment. No optional release cycle applies to the existing direct-Production topology.
- Keep configured completion approval after the Production Showcase; do not add paired pre-production PM gates. Framework updates require agent testing, not PM Testing.
- Distinguish source/tree identity before release from deployment ID after release. Preserve human choice of Backlog Issue and structured clarification controls requested by the PM.
- Upstream's installer forces all approval phrases to `Approved`, conflicting with the PM's explicit preservation instruction. Reconcile that assertion narrowly for the verified Builder profile and record this source-tool exception; preserve validation and fail-closed installation behavior.

## Plan and acceptance

1. Review upstream differences and all managed paths; inventory removals. Prepare isolated target and reviewed source checkouts.
2. Refresh canonical skills, references, adapters, schema and tooling. Reconcile Builder authority, question controls and approval semantics. Migrate only confirmed participant and identity fields.
3. Preview and apply the reconciled adoption plan; repeat with no changes. Verify home resolution, local references, Project pagination, routing and approval/QA regression cases.
4. Review complete lightweight Actions chains and refresh covered hashes. Run every configured quality command locally, including performance and all browser projects. Remediate failures and rerun affected checks.
5. Record provenance only after verification, publish through a maintenance PR, verify exact destination tree and checks, then clean task-owned resources.

No application source change, deployment, schedule, Issue mutation, protection change or auxiliary repository work is authorized. Risks are generic policies overriding Builder, installer incompatibility, stale CI review coverage and generated test outputs; address them through explicit precedence, regression checks, semantic review and inventoried cleanup.
