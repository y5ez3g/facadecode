# Extension islands

This guide assigns engineering ownership within the current architecture. The extension owns VS Code interaction and workspace presentation. Framework owns agent processes and records.
Each island owns its state and the operations that change it. The organization follows the
[Framework island model](../../framework/ARCHITECTURE.md#islands) and its [engineering roles](../../framework/ENGINEERING.md#roles).
[Architecture](ARCHITECTURE.md) gives the current module layout and host contracts.

## Ownership

### Root and child islands

**The root activates the hosts and gives the six medium islands their dependencies.**

The root owns activation, disposal, and the routing of an explicitly planned legacy cutover. It composes public
interfaces, including the separate VS Code workspace and UI hosts. The fifteen small islands below belong to one
medium island each. Shared value types, presentation helpers and generated protocol bindings follow their owner.

| Medium island | Small islands | Owns |
| --- | --- | --- |
| Framework connection | Connection and reconnect, Typed queries and subscriptions | The selected endpoint and live connection, capability negotiation, request outcomes and event delivery. Reports distinguish an unavailable source from a confirmed removal. |
| Workspace agents | Roster and Pins, Agent operations, Pin recovery | Remembered agents, saved Pins and their recovery order, plus the observed records that supply running cards. One recovery round for the windows sharing a workspace. |
| Terminal view | Editor tabs, Terminal data and input | A tab's view lifetime and the associated Attach subscription, frame, input and capacity. Closing a tab releases its view. |
| Launch and locations | Directory catalog and history, Git worktrees, New Agent flow | The selected machine and directory, its catalog and history, standalone Git effects, and the launch selection up to the exact request. |
| Panel and pickers | Card model and filtering, Webview, Agent pickers | Card order, filters and selection preferences, the host/page contract, and native selection of exact agent and session targets. |
| Local Window Component | Window identity, Stale tab cleanup | Identity, window registration and legacy routes on the UI host, plus native handles and cleanup across workspace-host generations. |

### Public interfaces and effects

**An island changes its own state and asks the next owner for every other effect.**

The Panel sends a selected target or view action to the workspace or launch owner. Launch resolves a destination
through Framework queries and gives the workspace owner a confirmed launch request. Workspace operations use the
typed Framework and terminal interfaces. An Attach or Resume result carries the full identity. A short token, UI
index or name does not replace it. The terminal view obtains live IO through the Framework connection. Workspace
identity and terminal retirement may call the Local Window Component through its native command contract.

Roster and Pins is the sole writer of the workspace roster. Its Pin-order input is a sequence of Pin IDs from
the Panel's existing move operation. The Panel keeps visual card order in editor workspace preferences. Workspace
agent operations project the watch's running records and classify temporary unavailability before reconciliation.
A workspace change synchronizes the roster and Pin intent. The root's temporary legacy cutover uses
`host/implementation.ts` and `host/legacyCutover.ts`; Workspace agents owns the migration record for each workspace.
A terminal view close leaves workspace membership and
agent lifetime to their owners. Framework stop and resume results come from the exact target operation. An ordinary
compatible upgrade reconnects to the existing process. A planned cutover confirms the affected legacy stops before
asking the Pin owner to recover any saved session. The worktree action hands the observed result to the location
catalog after Git has created it.

### Changes in the current layout

**Use the island boundary for changed behavior and the existing layer rules for imports.**

One logical island can use files in multiple current layers. An island's owner names its current paths and the
input and output of each cross-island change before implementation. Keep the current host/page separation,
one-directional imports, and independent test seams under ARCHITECTURE-1.3. Physical directory moves and a complete
island import check belong to their own change. Bar Raiser reviews each delivery against its declared ownership and
the public interface rules.

## Team workflow

### Horizontal roles and island owners

**The General TL integrates the affected islands with independent boundary, correctness and verification reviews.**

| Role | Responsibility |
| --- | --- |
| Owner | Product decisions, acceptance, and authorization to merge, push or release. |
| General TL | Work breakdown, parent-level interfaces and wiring, coordination, and the integrated result. |
| Bar Raiser TL | Reviews new boundaries and the integrated diff for ownership, types, dependency direction, and changes to frozen interfaces. Reports must-fix violations before handoff. |
| Review TL | Independently reviews the integrated behavior, correctness and maintainability, and returns actionable findings to the responsible owner. |
| QA Lead | Owns verification scenarios and evidence. Uses isolated editor profiles, Facade state and fake CLIs, and distinguishes checks that pass from checks with missing inputs. |
| Island owner | Implements its assigned behavior within owned paths and checks its public contract. Coordinates shared wiring or an interface change with the General TL and Bar Raiser. |

### Worktrees and handoff

**Start only the affected owners and horizontal roles, with one integration base and independent worktrees.**

The General TL records the affected paths, interface decisions and acceptance cases. Start workers through Facade
in their own numbered worktrees from the integration base. Keep writes and tests within the assigned scope.
The Bar Raiser checks contracts ahead of integration. Integrate through the parent after review of each change.
Use the repository's authorization rules for staging, commits, merges, pushes and releases.

The Review TL and Bar Raiser read the integrated code. The QA Lead records commands, revisions, artifacts and
remaining limits under VERIFICATION-1.2. Changes to persisted state and upgrade behavior include prior-build
evidence. The General TL returns unresolved findings to the responsible owner before final acceptance.
