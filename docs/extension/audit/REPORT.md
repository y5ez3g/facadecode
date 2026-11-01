# Specification audit report

The maintained documentation of the Facade Code extension is `docs/extension/`. This revision is the subset for step 2
of its sequence of owner-tested additive steps, carried from the Facade Dots specification with each rule's final number.

## Reproducible checks

Run `python3 -I -B docs/extension/audit/check_spec.py` from the repository root.
The [saved result](review-2026-10-31-mcp-merge.json) records the latest outcome and local-link count.

| Check | Scope |
| --- | --- |
| Structure | Twelve normative documents, 179 rules, bold decisions, Checks and change logs |
| References | Local Markdown links/anchors and numbered cross-references |
| Source coverage and migration | Run only when `audit/source-inventory.json`, `audit/migration.json` and `MIGRATION.md` are present; they join in the last step |

[Decisions](../DECISIONS.md) records current owner calibration. These checks establish structure and references, not
runtime behavior or performance.

## Evidence limits

Specification completion, code completion and product verification remain separate. G2, G5 and all runtime acceptance
requirements remain in [Verification](../engineering/VERIFICATION.md). Deleted historical test logs do not close a gate;
new implementation claims need evidence from the actual build. This audit runs no code, editor, CLI or platform suite; merged-build results are recorded separately in Verification.

## Change log

- 2026-10-31: Integrate the MCP feature and current main: 12 normative documents, 179 rules, with all local links and numbered references checked.

- 2026-10-31: 128 rules, with CLIS-3.4.
- 2026-10-30: 127 rules, with CLIS-4.1.
- 2026-10-30: 126 rules, with PANEL-2.3.
- 2026-10-30: Step 2: COLLABORATION and MCP join the checked documents; 12 documents and 175 rules.

- 2026-10-29: 125 rules, with the owner-approved ARCHITECTURE-4.2.
- 2026-10-29: Step 1 of the Facade Code extension, carried from the Facade Dots audit report: structure and reference
  checks, with the migration checks deferred until the ledger files are added.
