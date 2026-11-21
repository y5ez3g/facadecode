# VS Code extension specification

[Facade Code](../PRODUCT.md) defines the product, including the Orchestrator and its Shell, MCP and VS Code entry
points. These specifications describe the editor's part. The old engine remains selectable during the transition.

## Read by responsibility

| Document | Owns |
| --- | --- |
| [Product](PRODUCT.md) | VS Code scope within Facade Code |
| [Experience](EXPERIENCE.md) | Complete editor journeys |
| [Shared rules](RULES.md#6-the-vs-code-entry-point) | Workspace visibility, references, Attach, Pin, starts and settings |
| [Interaction and interface](UX.md#6-orchestrator-backed-commands-and-labels) | Commands, settings, presentations and language |
| [Lifecycle](features/LIFECYCLE.md#5-start-attach-and-resume) | New Agent, Go to Agent, Stop, Hide, Resume and Pin |
| [Locations and worktrees](features/WORKTREES.md#5-worktrees-at-start) | Choosing locations and starting in a worktree |
| [Panel](features/PANEL.md#4-orchestrator-backed-cards) | Cards, labels, title, details and actions |
| [Collaboration](features/COLLABORATION.md#5-collaboration-through-the-orchestrator) | Visible helpers and terminal access |
| [Configuration](features/CONFIGURATION.md#7-orchestrator-settings) | Access to the machine's settings and the settings read at start |
| [Architecture](engineering/ARCHITECTURE.md) | Editor host, workspace state, Window Component, packaging and working safeguards |
| [CLI integrations](engineering/CLIS.md) | CLI integration boundaries and old-engine adapters |
| [MCP](engineering/MCP.md) | Tool boundary and old-engine MCP contract |
| [Verification](engineering/VERIFICATION.md) | Required journeys, checks and evidence |

[Core protocol](../../core/protocol/PROTOCOL.md) owns the Orchestrator wire contract. The product's
[CLI table](../PRODUCT.md#cli-differences) summarizes CLI differences. Detailed rules belong with the
corresponding adapters.

## Changing a rule

Amend the rule that owns a behavior, then dependent schemas, scenarios and code. Keep rule identifiers stable for
existing references. Normative documents begin with an overview and group rules as `## n Group` and
`### n.m Rule`, with a bold decision opening each rule and Checks at the end except in Product. Where a file retains
old-engine rules, its overview identifies their scope.

## Evidence and development

Run `python3 -I -B docs/extension/audit/check_spec.py` from the repository root to verify structure and references.
[Verification](engineering/VERIFICATION.md) tracks implementation and product evidence. Use isolated editor profiles
and Facade homes as described in [extension development guidance](../../extension/AGENTS.md).
