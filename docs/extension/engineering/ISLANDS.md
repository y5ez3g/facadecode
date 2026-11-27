# Extension islands

This guide assigns engineering ownership within the current architecture. The extension owns VS Code interaction and workspace presentation. Facade Code Framework owns agent processes and records.
Each island owns its state and the operations that change it. The organization follows the
[Facade Code Framework island model](../../framework/ARCHITECTURE.md#islands) and its [engineering roles](../../framework/ENGINEERING.md#roles).
[Architecture](ARCHITECTURE.md) gives the current module layout and host contracts.

## Ownership

### Root and child islands

**The root activates the hosts and gives the six medium islands their dependencies.**

The root owns activation, disposal, and the routing of an explicitly planned legacy cutover. It composes public
interfaces, including the separate VS Code workspace and UI hosts. The fifteen small islands below belong to one
medium island each. Shared value types, presentation helpers and generated protocol bindings follow their owner.

| Medium island | Small islands | Owns |
| --- | --- | --- |
| Facade Code Framework connection | Connection and reconnect, Typed queries and subscriptions | The selected endpoint and live connection, capability negotiation, request outcomes and event delivery. Reports distinguish an unavailable source from a confirmed removal. |
| Workspace agents | Roster and Pins, Agent operations, Pin recovery | Remembered agents, saved Pins and their recovery order, plus the observed records that supply running cards. One recovery round for the windows sharing a workspace. |
| Terminal view | Editor tabs, Terminal data and input | A tab's view lifetime and the associated Attach subscription, frame, input and capacity. Closing a tab releases its view. |
| Launch and locations | Directory catalog and history, Git worktrees, New Agent flow | The selected machine and directory, its catalog and history, standalone Git effects, and the launch selection up to the exact request. |
| Panel and pickers | Card model and filtering, Webview, Agent pickers | Card order, filters and selection preferences, the host/page contract, and native selection of exact agent and session targets. |
| Local Window Component | Window identity, Stale tab cleanup | Session-validated native identity, predecessor records, terminal handles and cleanup across workspace-host generations. |

### Public interfaces and effects

**An island changes its own state and asks the next owner for every other effect.**

The Panel sends a selected target or view action to the workspace or launch owner. Launch resolves a destination
through Facade Code Framework queries and gives the workspace owner a confirmed launch request. Workspace operations use the
typed Facade Code Framework and terminal interfaces. An Attach or Resume result carries the full identity. A short token, UI
index or name does not replace it. The terminal view obtains live IO through the Facade Code Framework connection. Workspace
identity and terminal retirement may call the Local Window Component through its native command contract.

Roster and Pins is the sole writer of the workspace roster. Its Pin-order input is a sequence of Pin IDs from
the Panel's existing move operation. The Panel keeps visual card order in editor workspace preferences. Workspace
agent operations project the watch's running records and classify temporary unavailability before reconciliation.
A workspace change synchronizes the roster and Pin intent. The root wires activation to a migration adapter.
The adapter owns the read-only released supervisor queries and home-level cutover journal. Roster
and Pins owns each workspace's migration sidecar and final roster write.
A terminal view close leaves workspace membership and
agent lifetime to their owners. Facade Code Framework stop and resume results come from the exact target operation. An ordinary
compatible upgrade reconnects to the existing process. A planned cutover confirms the matching legacy exit before
asking the Pin owner to recover its saved session. The worktree action hands the observed result to the location
catalog after Git has created it.

### Changes in the current layout

**Every production module belongs to exactly one owner and exposes only declared cross-island interfaces.**

[The source ownership map](../../../extension/islands.json) assigns modules to the root, small islands, migration
adapter or shared contracts. A foreign import names a public export and its permitted consumer. Shared contracts carry
data and low-level functions. State and product effects stay with the corresponding island. The map follows the existing
layer rules and names public entry modules even when an island spans more than one layer.

The extension checks ownership, permitted imports and cycles through its TypeScript source graph, including type
imports, re-exports and directory entrypoints. The package check inspects the emitted workspace host, window host
and page graphs and their packaged contents. The Bar Raiser reviews state writers, public interface changes and
entrypoint wiring as part of each delivery.

## Team workflow

### Horizontal roles and island owners

**The General TL integrates the affected islands with independent boundary, correctness and verification reviews.**

| Role | Responsibility |
| --- | --- |
| Owner | Product decisions, acceptance, and authorization to merge, push or release. |
| General TL | Work breakdown, parent-level interfaces and wiring, coordination, and the integrated result. |
| Bar Raiser TL | Reviews new boundaries and the integrated diff for ownership, types, dependency direction, and changes to frozen interfaces. Reports must-fix violations before handoff. |
| Review TL | Independently reviews the integrated behavior, correctness and maintainability, and returns actionable findings to the responsible owner. |
| QA Lead | Owns verification scenarios and evidence. Uses isolated editor profiles, Facade Code Extension state and fake CLIs, and distinguishes checks that pass from checks with missing inputs. |
| Island owner | Implements its assigned behavior within owned paths and checks its public contract. Coordinates shared wiring or an interface change with the General TL and Bar Raiser. |

### Worktrees and handoff

**Start only the affected owners and horizontal roles, with one integration base and independent worktrees.**

The General TL records the affected paths, interface decisions and acceptance cases. Start workers through Facade Code Extension
in their own numbered worktrees from the integration base. Keep writes and tests within the assigned scope.
The Bar Raiser checks contracts ahead of integration. Integrate through the parent after review of each change.
Use the repository's authorization rules for staging, commits, merges, pushes and releases.

The Review TL and Bar Raiser read the integrated code. The QA Lead records commands, revisions, artifacts and
remaining limits under VERIFICATION-1.2. Changes to persisted state and upgrade behavior include prior-build
evidence. The General TL returns unresolved findings to the responsible owner before final acceptance.
