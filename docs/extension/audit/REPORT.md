# Specification audit

`docs/extension/` is the maintained specification of the Facade Code extension. Its audit checks structure and
references only.

## Reproducible checks

Run `python3 -I -B docs/extension/audit/check_spec.py` from the repository root. It prints the outcome, the number of
rules and local links checked, and every error; the extension's pull-request checks run it.

| Check | Scope |
| --- | --- |
| Structure | Twelve normative documents; numbered groups with each rule inside its group; a bold decision opening every rule; Checks in every document except Product |
| Current state only | No change log, decision log or decision reference: git history records how the specification changed |
| References | Numbered `DOCUMENT-n.m` cross-references, and local Markdown links and anchors in the specification and the repository documents that point into it |

## Evidence limits

Specification completion, code completion and product verification remain separate. The audit runs no code, editor,
CLI or platform suite; gates, required journeys and their status are in [Verification](../engineering/VERIFICATION.md).
