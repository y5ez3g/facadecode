# Specification audit report

The maintained documentation of the Facade Code extension is `docs/extension/`. This revision is the subset for step 1
of its sequence of owner-tested additive steps, carried from the Facade Dots specification with each rule's final number.

## Reproducible checks

Run `python3 -I -B docs/extension/audit/check_spec.py` from the repository root.
The [saved result](review-2026-10-29.json) records the latest outcome and local-link count.

| Check | Scope |
| --- | --- |
| Structure | Ten normative documents, 125 rules, bold decisions, Checks and change logs |
| References | Local Markdown links/anchors and numbered cross-references |
| Source coverage and migration | Run only when `audit/source-inventory.json`, `audit/migration.json` and `MIGRATION.md` are present; they join in the last step |

[Decisions](../DECISIONS.md) records current owner calibration. These checks establish structure and references, not
runtime behavior or performance.

## Evidence limits

Specification completion, code completion and product verification remain separate. G2, G5 and all runtime acceptance
requirements remain in [Verification](../engineering/VERIFICATION.md). Deleted historical test logs do not close a gate;
new implementation claims need evidence from the actual build. No code, editor, CLI or platform suite ran for this spec
revision.

## Change log

- 2026-10-29: 125 rules, with the owner-approved ARCHITECTURE-4.2.
- 2026-10-29: Step 1 of the Facade Code extension, carried from the Facade Dots audit report: structure and reference
  checks, with the migration checks deferred until the ledger files are added.
