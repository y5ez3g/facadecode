# Facade Code extension specification

**Version 1. This specification is the authority for the Facade Code extension.**
It says what a person and their agents can do, how each feature behaves and how the extension is built and verified.
Where the code disagrees with it, the code is fixed, or the owning rule is amended first.

## 1 Read from the product to implementation

| Layer | Document | Owns |
| --- | --- | --- |
| 1 Product | [PRODUCT](PRODUCT.md) | Users, ways of working, access to every agent, responsibilities, priorities and scope |
| 2 Experience | [EXPERIENCE](EXPERIENCE.md) | Complete human journeys |
| 2 Shared rules | [RULES](RULES.md) | Messages, identity, client network, locations, state, error ownership, lifetime, reach, YOLO and retention |
| 3 Common interaction | [UX](UX.md) | Native surfaces, fixed presentation, accessibility, commands/settings and languages |
| 3 Features | [LIFECYCLE](features/LIFECYCLE.md) | Launch, names, editor terminals, finding, closing, Resume and Pin |
| 3 Features | [WORKTREES](features/WORKTREES.md) | Folder/worktree discovery, native creation, deletion and observing external removal |
| 3 Features | [PANEL](features/PANEL.md) | Cards, count, order, local filters and webview |
| 3 Features | [COLLABORATION](features/COLLABORATION.md) | Cross-window agent operations, messages, human contact and message records |
| 3 Features | [CONFIGURATION](features/CONFIGURATION.md) | `facade.json`, agent names, named CLI entries and icons, errors, native API setup and migration |
| 4 Engineering | [ARCHITECTURE](engineering/ARCHITECTURE.md) | Runtime, window components, processes, data, packaging and working safeguards |
| 4 Engineering | [CLIS](engineering/CLIS.md) | Native configuration, input readers, Facade tool files, conversations and trust |
| 4 Engineering | [MCP](engineering/MCP.md) | The eight agent tools, results, waits, injection and protocol |
| 4 Verification | [VERIFICATION](engineering/VERIFICATION.md) | Gates G1, G2, G3 and G5, required journeys and scale, and their status |

Read Product, then Experience, for the whole product in plain terms. Shared Rules defines behavior that crosses
features. Lower layers supply exact details without adding work management, security services, rare features or extra
approval workflows.

## 2 Authority and amendments

Higher layers constrain lower ones. Every behavior has one owning rule with a stable `DOCUMENT-n.m` identifier. That
rule holds the exact conditions and values. Other documents refer to it and describe only their own interaction, schema
or acceptance role; they do not copy a second policy. An acceptance scenario can name a concrete test case without
becoming another owner.

Normative documents begin with an overview and group their rules as `## n Group` and `### n.m Rule`. Each rule opens
with its bold decision; every document except Product ends with Checks. Rules state the current product in the present
tense, with a reason where it helps. The specification keeps no change history or decision log: git history records
how it changed. Rule identifiers are stable because code and tests cite them. A change amends the owning rule first,
then the rules, scenarios and references that depend on it, then the code. A test written for behavior the
specification no longer has changes its expectation; it is not a reason to restore that behavior.

## 3 Coverage and evidence limits

The set contains **13 normative documents and 205 numbered rules**. `python3 -I -B docs/extension/audit/check_spec.py`,
run from the repository root, checks their structure and references ([audit report](audit/REPORT.md)). It runs no code.

Specification, code and product verification are separate claims. Required product evidence includes
native/compatible-editor installation, routing between local and remote windows, the window-lifetime policy across
reload, disconnect and close, each supported CLI's activity and message-input capabilities, 100-agent window usability
and a real user's walkthrough; [Verification](engineering/VERIFICATION.md) owns the gates and their status. Unknown CLI
versions can start interactively and are attempted for messages; only verified capability/version/platform combinations
are advertised as supported. Browser-only editors are not supported. No evidence is manufactured for an unavailable
environment, and no platform gate is closed by declaration.

## 4 Working on the extension

Assignments, pauses and authorization follow the current user instructions. This specification defines the product;
it does not authorize resuming a paused task, publishing or unrelated changes.

Implement shared contracts and complete journeys with the simple choices the rules make. Preserve the dirty working
tree, isolated test profiles and the prohibition on real Qwen probes. Never use the owner's existing windows as tests.
Resolve routine engineering details within scope; raise a concrete conflict between rules, scenarios or evidence rather
than asking the owner to approve speculative edge cases. Verification states remain separate for spec, code and product.
