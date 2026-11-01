# Facade Code extension specification

**This is the active product specification, revised from the owner's completed reviews on 2026-10-28.**
It is an implementation target, not a claim that the installed build or every integration already meets it.
`docs/extension/` contains only this specification. The owner's completed reviews are incorporated in the current
rule bodies and [Decisions](DECISIONS.md); historical task records and review files are not required to use the specification.

## 1 Read from the product to implementation

| Layer | Document | Owns |
| --- | --- | --- |
| 1 Product | [PRODUCT](PRODUCT.md) | Users, ways of working, access to every agent, responsibilities, priorities and first-release scope |
| 2 Experience | [EXPERIENCE](EXPERIENCE.md) | Complete human journeys |
| 2 Shared rules | [RULES](RULES.md) | Messages, identity, client network, locations, state, error ownership, lifetime, reach, YOLO and retention |
| 3 Common interaction | [UX](UX.md) | Native surfaces, fixed presentation, accessibility, commands/settings and languages |
| 3 Features | [LIFECYCLE](features/LIFECYCLE.md) | Display names, editor terminals, local finding and immediate close |
| 3 Features | [WORKTREES](features/WORKTREES.md) | Folder/worktree discovery, native creation and observing external removal |
| 3 Features | [PANEL](features/PANEL.md) | Cards, count, stack order, local filters and webview |
| 3 Features | [COLLABORATION](features/COLLABORATION.md) | Cross-window agent operations, messages, human contact and Message History |
| 4 Engineering | [ARCHITECTURE](engineering/ARCHITECTURE.md) | Runtime, window components, processes, data, packaging and working safeguards |
| 4 Engineering | [CLIS](engineering/CLIS.md) | Native configuration, input readers, Facade tool files, capability evidence and trust |
| 4 Engineering | [MCP](engineering/MCP.md) | The nine agent tools, results, waits, injection and protocol |
| 4 Verification | [VERIFICATION](engineering/VERIFICATION.md) | G1, G2, G3 and G5, required journeys/scale and actual evidence |

Read Product, then Experience for the whole product in plain terms. Shared Rules defines cross-feature behavior. Lower
layers supply implementation details without adding work management, security services, rare features or extra approval
workflows.

## 2 Authority and revisions

Higher layers constrain lower ones. Every behavior has one owning rule with a stable DOCUMENT-n.m identifier.
That owner holds exact conditions and values. Other documents reference it and describe only their own interaction,
schema or acceptance role; they do not copy a second permission/restoration/configuration policy. Acceptance scenarios
can name a concrete test case without becoming another owner. Decision/migration records explain amendments and
historical dispositions, not an additional current product contract. No specification-generation system is required.
Normative files begin with an overview and contain numbered rules with bold decisions; non-product files include Checks.
Every changed document has a final Change log. Historical change-log entries describe the contract on their own date
and do not reinstate a requirement explicitly superseded by the current body.

[Decisions](DECISIONS.md) records current owner calibration and withdrawn Codex deductions. A prior test written for
deleted behavior must change its expectation; it is not evidence that the deleted feature should be restored.

The Facade Code extension is committed in additive steps, and each commit carries only the specification its step needs.
This is the subset for the owner-tested steps so far. Step 1 shipped Claude Code and Codex with the whole user interface
that serves them, as the 0.0.1 preview; Antigravity, Muse Code, OpenCode and Pi join them at the same level (D77). Step 2
adds agents that work together, with every built-in CLI: the nine MCP tools, messages and their results, contact with the
person, Message History, and control of agents in every Facade window on this computer, local and remote alike. The integrated steps also include panel display filters, built-in launch settings, Show Agent Launch, Show Agents Log
and custom CLIs. Every rule keeps its final number; Resume and Pin remain later steps.

## 3 Coverage and evidence limits

The set contains **12 normative documents and 179 numbered rules**. The [audit report](audit/REPORT.md) records
structural and reference checks; the migration ledger joins in the last step. These do not constitute a runtime pass.

Required product evidence includes native/compatible-editor installation, routing between local and remote windows,
true close versus reload/disconnect, each supported CLI's activity and message-input capabilities, 100-agent window
usability and a real user's walkthrough. Unknown CLI versions can start interactively and are attempted for messages;
only verified capabilities/version/platform combinations are advertised as supported.
Browser-only editors are outside this release. The current review does not manufacture evidence for an unavailable
environment or close a platform gate by declaration.

## 4 Implementation handoff

Assignments, pauses and authorization follow the current user instructions. This specification defines the product;
it does not authorize resuming a paused task, publishing or unrelated changes.

Implement shared contracts and the full journeys, using the owner-reviewed simple choices. Preserve the dirty working
tree, isolated test profiles and the prohibition on real Qwen probes. Never use the owner's existing windows as tests.
Resolve routine engineering details within scope; raise concrete rule/scenario/evidence conflicts rather than asking
the owner to repeatedly approve speculative edge cases. Verification states remain separate for spec, code and product.

## Change log

- 2026-10-31: Integrate the MCP feature and current main: 12 normative documents, 179 rules, with all local links and numbered references checked.

- 2026-10-31: The step summary includes custom CLIs; CLIS-3.4 makes 128 rules.

- 2026-10-30: The step summary includes the agent settings and diagnostics; CLIS-4.1 makes 127 rules.

- 2026-10-30: The step summary includes the panel's display filters; PANEL-2.3 makes 126 rules.

- 2026-10-30: Step 2 of the Facade Code extension: added COLLABORATION and MCP; 12 documents and 175 rules.
- 2026-10-30: The step summary includes the step adding Antigravity, Muse Code, OpenCode and Pi (D77).

- 2026-10-30: Corrected the stale step summary to include the owner's already-authorized Codex addition to step 1.

- 2026-10-29: The lifecycle entry reflects the owner's decision that name labels may be empty.

- 2026-10-29: Owner-approved: the step note no longer fixes the number of steps; 125 rules with ARCHITECTURE-4.2.
- 2026-10-29: Step 1 of the Facade Code extension, carried from the Facade Dots specification: lists the documents
  present in this step and explains the step subset and its numbering gaps.
