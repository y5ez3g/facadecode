# Specification audit

`docs/extension/` specifies the VS Code entry point described in [Facade Code](../../facade-code.md). The audit
checks rule structure and references.

## Reproducible checks

Run `python3 -I -B docs/extension/audit/check_spec.py` from the repository root. It prints the outcome, the number of
rules and local links checked, and every error; the extension's pull-request checks run it.

| Check | Scope |
| --- | --- |
| Structure | Thirteen normative documents; numbered groups with each rule inside its group; a bold decision opening every rule; Checks in every document except Product |
| Current state only | No change log, decision log or decision reference: git history records how the specification changed |
| References | Numbered `DOCUMENT-n.m` cross-references, and local Markdown links and anchors in the specification and the repository documents that point into it |

## Current result

The command above returned **PASS** on 2026-11-19 with **13 normative documents, 228 numbered rules and
123 local links**. `git diff --check -- docs/extension` also passed. The link count includes repository documents
and the extension README.

## Evidence limits

Specification completion, code completion and product verification remain separate. The audit runs no code, editor,
CLI or platform suite; gates, required journeys and their status are in [Verification](../engineering/VERIFICATION.md).
