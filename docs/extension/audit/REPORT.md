# Specification audit

`docs/extension/` is the maintained specification of the Facade Code extension. Its audit checks structure and
references only. The normative set includes CONFIGURATION as the owner of file settings and CLI entries.

## Reproducible checks

Run `python3 -I -B docs/extension/audit/check_spec.py` from the repository root. It prints the outcome, the number of
rules and local links checked, and every error; the extension's pull-request checks run it.

| Check | Scope |
| --- | --- |
| Structure | Thirteen normative documents; numbered groups with each rule inside its group; a bold decision opening every rule; Checks in every document except Product |
| Current state only | No change log, decision log or decision reference: git history records how the specification changed |
| References | Numbered `DOCUMENT-n.m` cross-references, and local Markdown links and anchors in the specification and the repository documents that point into it |

## Current result

The command above returned **PASS** on 2026-11-10: **13 normative documents, 205 numbered rules and 101 local links**,
with no errors. `git diff --check -- docs/extension` also passed. The link count includes repository and extension
README links and can change as those documents change. These results establish structure and references, not
implementation behavior.

## Evidence limits

Specification completion, code completion and product verification remain separate. The audit runs no code, editor,
CLI or platform suite; gates, required journeys and their status are in [Verification](../engineering/VERIFICATION.md).
