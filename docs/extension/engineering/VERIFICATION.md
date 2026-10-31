# Verification and implementation handoff

Layer 4. A target specification and a verified implementation are different deliverables. This document defines the
required evidence and records its status. No code/runtime test has been run by the specification rewrite itself.

| Group | Decides | Evidence state |
| --- | --- | --- |
| 1 Acceptance | What “complete” means and what evidence must contain | Defined; runtime pending |
| 2 Critical gates | Platform/CLI facts that must be proven first | Open; partial native evidence |
| 3 Scenarios | End-to-end behavior and focused failure coverage | Partly run with the handoff |
| 4 Handoff | Work order, reviews and reporting | Ready with spec handoff |

## 1 Acceptance

### 1.1 Three separate claims

**Specification completion, code completion and product verification are reported separately.**

Specification: owner decisions are preserved, layers agree, contracts define outcomes, and references resolve. Code:
required behavior is implemented with relevant automated tests and no knowingly omitted feature. Product: complete
journeys work in supported real editor/environment/CLI combinations, with evidence. A successful type check, mock test
or CLI launch proves only that check. Open critical gates block claiming complete product support, even if all local
unit tests pass. A documented unsupported capability is honest degradation but does not satisfy a required release
promise for a built-in advertised as supporting it.

### 1.2 Evidence format

**Every passed scenario records exactly where, when and how it was checked.**

Evidence entry: scenario ID; spec revision/hash; code revision or working-tree snapshot/hash; date; OS/architecture;
editor/client/server version; CLI and model when relevant; local/SSH/WSL/container environment; isolated data/profile paths;
command/procedure; observed result; assertion/log/screenshot path; pass/fail/blocked/not-run; known limitations. Store
results with the tested build or handoff, without credentials or full private conversations. Screenshots are
needed for visual/focus claims; traces for process/delivery/lifetime claims. Historical source claims stay historical.

### 1.3 Required gates for an implementation milestone

**Run the repository's required checks and the scenarios affected by the change before reporting the milestone complete.**

Use ARCHITECTURE-5.1's type checks, unit suite, bundle, package checks and isolated integration suite. Add failure-injection tests where
behavior involves changed input, lifecycle or result handling; a test that repeats implementation logic is insufficient.
Do not rerun unrelated expensive suites after a docs-only amendment. Re-run relevant checks when the amendment changes
behavior, and full gates at final code handoff. List unrun platform checks explicitly instead of implying a local mock
proves native support.

## 2 Critical gates

### 2.1 Platform and integration proof

**All gates must pass before first-release product completion or full support is claimed.**

| Gate | Required proof | Current evidence / status |
| --- | --- | --- |
| G1 Client network and packaging | Install the workspace component and its window component through the extension pack in clean local and Remote-SSH profiles; register windows, including windows with no agents or no folder; route every tool local→SSH, SSH→local, SSH→SSH and between two local windows; recover from stale registry entries; replace a window component on update with messages in flight; prove native backend packaging | 2026-10-30, official VS Code with isolated profiles and fake CLIs - 1.143.1 on macOS arm64, 1.144.0 on Linux x64 (Ubuntu 26.04, under xvfb) and Windows x64 (10.0.26200, in the desktop session): between two local windows on each, an agent listed the other window, started an agent there, messaged it, read its screen and stopped it. Over Remote-SSH 0.128.0 from macOS (`npm run test:remote`, each host's server in a folder of the run's own) the same journey passed local→SSH, SSH→local and SSH→SSH on Linux x64 and on Windows x64, and between an SSH window on Linux and one on Windows; the single-window journeys passed in an SSH window on each. The 0.2.0 packages were built natively for darwin-arm64, linux-x64 and win32-x64 with node-pty 1.2.0-beta.15 (D88), each passing `test:package`, and installed with the window component in clean profiles, where both parts started and registered the window under its name. Unit tests cover registry staleness, protocol mismatch, timeouts, a window not yet served and the name a window publishes. Installation through the extension pack from the Marketplace and window-component replacement with messages in flight not run; OPEN |
| G3 Draft-safe ordinary input | For Claude Code and Codex, on the current version and at least one earlier one, prove input box versus menu, actual empty versus history/paste/multiline draft, working-CLI submission, full text + Enter, uncertain effects and an unrecognized layout left untouched; macOS, Linux and Windows terminals | Facade Dots recorded Claude Code 2.1.312 and Codex 0.165.0 on macOS arm64 on 2026-10-29 with owner-authorized accounts (Dots D56); those screens are the readers' first fixtures. On 2026-10-30 the integration suite proved the paste, draft protection, Enter, deadline failure and read delivery against a fake CLI drawing Claude Code's input frame, in macOS and Linux terminals and Windows ConPTY, in local and SSH windows. Real Claude Code 2.1.314, started by Facade on macOS with YOLO off and a test configuration the owner signed in: no trust question, and a typed task was submitted; the agent journey (`FACADE_IT_ONLY=real`) stopped at the account's usage limit. Codex 0.166.0 not run (no usage left); real CLIs on Linux and Windows not run; OPEN |
| G2 True window lifetime | Distinguish reload, extension-host restart, remote loss, close-one, close-last and immediate reopen without mistaken replay/restart | Owner-accepted five-minute policy (D75) implemented in place of a close detector. Candidate 4/5 native evidence on a macOS VS Code 1.143.1 client with Remote-SSH to Linux x64 and Windows x64: reload and remote extension-host restart keep the original runs; close-last then immediate reopen keeps the original processes; no takeover ends them at about 300 s. Evidence stays with the handoff. True close detection remains OPEN |
| G5 Native environment matrix | Native macOS/Windows/Linux, SSH, WSL and containers, compatible editor, native PTY ABI, paths/quoting/Unicode/keys and package install | Exercised: macOS arm64 local and Remote-SSH to Linux x64 and Windows x64, packages installed for those three targets, Unicode input. 2026-10-30, 0.2.0 natively on Linux x64 (under xvfb) and Windows x64 (in the desktop session): the unit, package and integration suites, which on Windows run ptyd's named pipes and ConPTY. They found and fixed two crashes of ptyd on Windows - a second kill of an ended console, and node-pty 1.1.0's unlocked console list (D88) - after which ptyd's terminal tests passed 20 runs in a row where they had crashed 2 of 10. Not run: Linux and Windows as Remote-SSH clients, WSL, containers, a compatible editor, the declared minimum VS Code 1.105, other architectures. OPEN |

The implementer investigates concrete mechanisms and brings engineering changes with evidence to the assigned reviewer.
A failed proof cannot be disguised as an implemented heuristic or automatic product-scope reduction. If it cannot be solved in
the available environment, complete independent work and record the exact missing evidence and required next action.

### 2.2 Coverage matrix

**Every execution environment runs the same core contracts; unsupported capability evidence is explicit.**

| Dimension | Required samples |
| --- | --- |
| Client | macOS, Windows, Linux; VS Code minimum/current; one declared compatible editor |
| Execution | Local; Remote SSH Linux plus another supported host OS where available; WSL; Dev Container |
| Workspace | Plain folder without Git executable; ordinary nonrepository with Git; main checkout; opened worktree; mixed multi-folder; nested/duplicate repo folders; no folder |
| CLI | Each built-in, current and an earlier version for input readers; missing/disabled/invalid CLI |
| UI | Themes/widths/zoom/languages/reduced motion/keyboard/accessibility from UX |

Use pairwise sampling for routine presentation combinations, but exercise every critical G1–G3 boundary directly.

Three required product exercises are local plus two remote environments messaging/stopping each other, first launch
from the empty-panel explanation and usable panel/search/order with 100 agents in one window. Test CLIs may supply the scale load; vendor capability evidence still uses the actual supported
CLI. More than 100 remains allowed, without implying tested usability at that scale. A real VS Code user must walk the
common flow before public use; automated tests do not replace this check. Do not create a full combinatorial matrix or
repeatedly rerun unrelated suites for small changes. Missing environments are recorded as not run, not fabricated
passes.

## 3 Scenarios

### 3.1 Core journeys and lifecycle

**Acceptance exercises complete journeys, including their failure exits.**

| ID | Scenario | Expected observation / owner |
| --- | --- | --- |
| J01 | First human launch in plain folder, Git removed from PATH | Same short CLI flow, no Git setup/error; immediate pair; PRODUCT-5.4, LIFECYCLE-1 |
| J02 | Multi-folder defaults, last successful CLI/location, missing-location fallback, edit name, search/scroll CLI choices, cancel | Remembered/opened location stays selected independently of main-first display order; current name and actual location remain visible during search; last successful CLI preselected; editable label allows empty strings, `human` and duplicates; canceled choices not remembered; LIFECYCLE-1 |
| J03 | Open main versus open its worktree, including symlink/case/nested paths | Main checkout first in the picker; the actual opened folder remains the fallback launch location; no duplicate physical lock; WORKTREES-1 |
| J04 | CLI/worktree creation fails; native post-create setup fails; Facade tools fail while the CLI is usable | Actual startup failures retain pair and report to initiator; setup success is not a launch gate; usable CLI remains with a plain explanation; LIFECYCLE-1.5 |
| J05 | Working, idle, native blocker, unavailable reliable status, blocker plus unavailable status, recovery | RULES-3 dot meanings; PANEL-1.4 leads with the known blocker before generic unavailable text while retaining that explanation; no idle/turn-end popup |
| J06 | Normal exit 0; Ctrl+C ordinary interruption from the person; unexplained nonzero exit | Actor-independent classification; abnormal retained; unknown cause no popup; RULES-3.3 |
| J07 | Close card/terminal, stop during creation, unreachable remote cleanup; close live agents' tabs alone and with Close All, then Cancel and confirm | Immediately remove pair; cleanup background, no fixed five-second wait; created files remain; one question for tabs closed together, Cancel reopens their terminals, confirm ends them; LIFECYCLE-3.1 |
| J08 | Close creator, keep worker in same/other window | Workers remain except those owned by a window actually closed; RULES-4.1 |
| J09 | Reload, extension-host restart, remote loss, close-one, close-last, immediate reopen, close-last without reopen | G2 trace; original process survives reload/disconnect; reopen within five minutes claims the original runs; without it they end at five minutes (RULES-4.1) |
| J12 | Both EXPERIENCE-4.1 journeys through review/integration and ordinary cleanup | No built-in task/workflow; files accessible without Git |
| J13 | New VS Code user follows empty-panel explanation | First agent starts without a separate onboarding wizard |
| J14 | 100 agents in one window, then request another | Panel/search/manual order remain usable at 100; no 100-agent hard cap |
| J15 | One local and two remote execution environments on one client | Agent starts, messages, screens, keys and stops work between them within YOLO/tree rules |
| J16 | Real VS Code user completes the common flows, including asking one agent to work with others, before public use | Record observed familiarity/usability; automated tests alone do not pass |

### 3.2 Collaboration and contracts

**Message and operation tests assert actual input effects, not just queued records or screenshots.**

| ID | Scenario | Expected observation / owner |
| --- | --- | --- |
| M01 | Query destination with zero agents; open window with no folder; disconnected runtime; missing/unknown catalogs | Include the folderless window with zero locations; selecting it returns an empty catalog and launch has no effects; distinguish known absence from unavailable windows; no invented CLI/model; MCP-2.1 |
| M02 | Omit name/window/location/CLI; omit model/effort; pass unsupported field/type | Required fields fail together before effects; omitted model/effort add no per-call override under CLIS-1.4; no permissions/request_id/task fields |
| M03 | Create across windows/remotes, plain folder or external-created checkout; native/post-start prompt still pending after process success | Actual destination, creator's tree and background focus; YOLO per RULES-4.3; separate process and delivery results; pending prompt later returns its outcome with the same message ID/target under MCP-2.3; native path invents no Enter effect |
| M04 | Send full multiline content while recipient working; busy queue observable/unobservable | One full paste + Enter; success without waiting; no unsupported queued claim |
| M05 | Existing draft via typing/paste/history, then clear it | No append/overwrite/Enter; next eligible attempt without typing cooldown |
| M06 | Login/permission/menu, missing activity, unknown input, an input box of a version the reader does not recognize, a CLI with no reader | No blind Enter probe and nothing typed; working status not eligibility; `input_unknown` at the deadline names CLI and version; no reader fails at once as `unsupported`; RULES-1.4 |
| M07 | Direct success, permanent failure, slow input after 2 s; delayed shim/window forwarding | Exactly three initial outcomes and one accepted operation; measure monotonic elapsed time from RULES-1.2's first Facade ingress to response handoff, with internal hops consuming one budget; record client round-trip separately; MCP-4.1 |
| M08 | Draft clears on attempt four; remains throughout; queued behind another send | At most 5 slots, deadline 15 s, serialized whole writes, no extension |
| M09 | Lose acknowledgement after partial/full input or Enter; repeat a new send with identical text; reopen windows | RULES-1.1's ID scope/reuse holds; retries retain ID, a new call gets another; skill explicitly teaches ID deduplication and separates results from instructions; no platform exactly-once guarantee |
| M10 | Repeat start after lost response; attempt get_operation or caller request_id | A new valid invocation can create another run; inspect with list_agents; removed tool/field is rejected, no hidden idempotency contract |
| M11 | B delivered/not delivered while A is absent, busy, drafted or unreachable | A result for both outcomes; original outcome unchanged; finite handoff if possible, otherwise end; no report to B unless B actually sends, and no human notification |
| M12 | Failure returned to A; A does nothing or replies | No automatic human escalation or instruction to A |
| M13 | Only A closes while delivery pending; B still open; then B closes | Delivery already owned by B may finish; work left on closing side may end; no special takeover or future-open replay |
| M14 | Disconnect/reload over attempt slots and after deadline | No catchup burst/late Enter; no new budgets; reconcile recorded effects |
| M15 | Read messages before, during and after delivery; read after a failure result; lookup sent or another agent's message by ID | Own inbox only including YOLO; a read without IDs returns undelivered records and delivers them; a record read while being pasted is not pasted again and its sender's result says read_messages; a record read after its failure result gets no second result; reads by ID or all:true never resubmit content |
| M16 | One recipient by ID, unique name, ambiguous name, recipient array, `#human`, `@human` with and without an agent named `human` | ID/unique name resolves once; ambiguity requests ID; `#human` always reaches the person; arrays refused before effects; one independent message/result |
| M17 | Direct multiline/large/whitespace text, ESC/other control characters, empty text without Enter, existing draft, menu, unknown layout, key sequence, stop | No input_policy, draft guard or artificial text cap; exact serialized input and true partial/unknown effects; controls other than tab/LF/CR and empty no-Enter text fail INVALID before writing; ordinary messages still protect drafts |
| M18 | Long screen/history local-to-remote and remote-to-remote; one included record expires | Complete file readable by caller; delete whole temporary message file on any included expiry and regenerate remaining records on demand |
| M19 | MCP switch changes during an existing run and before a new start | Existing tools/runs unchanged; only subsequent injection follows setting; no message replay; recipient MCP not needed for terminal delivery |
| M20 | Same-tree sibling/ancestor access, unrelated root, YOLO, duplicate names and stale IDs, across windows | Normal tree scope on reads/writes, YOLO all; ambiguity does not guess; ended ID never retargets; no authentication/token/delegation requirements |
| M21 | Change YOLO before a human start and a child start in another environment; change it again while runs live | Every new run uses the destination's setting at acceptance under RULES-4.3; existing runs keep their value; children retain their tree without inheriting the creator's setting |
| M22 | Concurrent accepted calls, including more than one to the same run, finish out of order | Each result identifies its originating call and exact target under MCP-1.3; existing call context suffices, without caller-managed IDs or a query API |
| M23 | YOLO off: an agent calls each Facade tool, then its CLI runs a shell command | No approval prompt for Facade's tools in Claude Code or Codex; the CLI's own approval still appears for its command; MCP-6.1, CLIS-2.2 |
| M24 | Facade server cannot start or connect | The CLI starts and stays usable; the card explains in plain words; tools_state unavailable; LIFECYCLE-1.5 |
| M25 | Message to the person while its agent's terminal is visible and hidden; long message | Notification in the sender's window names the agent; Show Agent and Open Message open the agent and the complete message; no notification in another window; COLLABORATION-2.3 |


### 3.3 Files, safety and presentation

**Data-loss and visual claims have their own evidence, independent of basic launch success.**

| ID | Scenario | Expected observation / owner |
| --- | --- | --- |
| W01 | Native Git creation, selected checkout/base, occupied destination, invalid branch | Source labels name the selected checkout's branch rather than a subfolder; fixed sibling path and current native Git result; no overwrite; WORKTREES-2 |
| W02 | Request worktree without Git/repository/commit; ordinary folder launch | Creation reports actual prerequisite; no initialization/initial commit/advice flow; ordinary agent still launches |
| W03 | Native copy/link/preparation delayed or failed; close creation before CLI spawn | Existing recognized worktree permits CLI without waiting; canceled launch does not spawn; no Facade setup job monitor/retry |
| W04 | Delete Worktree on clean, dirty, locked and detached worktrees with agents | Clean: agents close and end, then `git worktree remove` without `--force`, branch kept; dirty or locked: refused untouched; detached: confirmation says it has no branch; no other deletion, discard confirmation or stop-with-delete entrypoints; WORKTREES-3.2 |
| W05 | Actually remove workspace folder or externally delete worktree with agents | Immediately close affected pair(s), background cleanup; other locations continue |
| W06 | Remote temporarily disconnected or Git read fails while location was known | Do not mistake unavailable observation for actual location deletion; no cleanup from that alone |
| U01 | Narrow/high contrast/reduced motion/non-English/keyboard/screen reader | UX/PANEL checks, no invented completion/extra badges |
| U02 | Old-page action/reply, unrelated state change before a current-page action, agent rename while menu open | PANEL-3.1 generation isolation and current-target validation; no wrong target or required per-action expected revision |
| U03 | Human operation error, agent operation error, failed message return, explicit `#human` | Error to initiator; no agent message fallback to human; explicit contact shown in related window even when terminal visible |
| U05 | New card, manual movement | Card-count badge, stack insertion and stable state changes |
| U06 | Go to Agent with duplicate names, exact/short IDs and stale-name copied references; terminal placement | ID selects the intended current-window run; picker detail/hover distinguish duplicates; editor-only terminals; no global default shortcut |
| U07 | Command/menu catalog with starting, live and retained-ended records; view a notified source | One Close Agent action for all states; no attention queue/seen state, nextAgent, human stopAgent or startAgent registration; opening does not clear the error |
| U08 | Activate agent B, switch to a file/unrelated terminal, invoke palette Rename/Copy/Close; repeat without a selected run | Available actions target B under UX-3.1; no target picker; unavailable without a valid target; explicit card/tab context still targets its own run |
| U09 | Browse near the 80th card, switch to Explorer, then return; repeat after the navigation target is removed | Restore still-valid scroll position and navigation target without stealing input focus; removed target is discarded; existing PANEL-3.3 scrolling behavior is unchanged |
| U10 | Every new person-facing string - notifications, settings descriptions, cards, Message History and errors - in English and all eleven languages | Plain words with no internal terms under UX-1.3; reviewed by a content author and two reviewers; complete translations |
| U11 | Message History with conversations from this and other windows, long bodies, links and command text | Only messages involving this window's agents; read-only; delivery outcome shown; links and commands rendered as text; COLLABORATION-3.2 |
| C02 | Executable found only through configured default-profile PATH; null/omitted variables at each env layer; remote and Windows cases | Discovery and launch use the same CLIS-1.2 environment; null removes, omission inherits; no shell-init execution/parser |
| C03 | New worktree with tracked relative executable; missing/nonexecutable file after creation | Static validation before creation; cwd-dependent checks use actual Git destination before spawn; failure retains pair and created worktree; no preparation barrier/rollback |
| E01 | Output flood/slow UI, attach snapshot/output race, current/alternate screen | Bounded pressure, no duplicated input/output, readable final evidence |
| E02 | Settings, commands and records of 0.0.1; records/settings from Facade Dots development builds; old MCP calls | 0.0.1 settings and commands keep working; development-build records ignored with one log line and no aliases; old MCP calls fail explicitly; no kill/replay; ARCHITECTURE-4.2 |
| E03 | Package contents/localization/native ABI/install in isolated profiles | No test probes/secrets, complete strings/notices, verified components |
| E04 | Full compile/test/bundle/package/integration milestone | Record actual command/results, no claim of unrun native support |
| E05 | Update from 0.0.1 with running agents in local and remote windows, then reload | 0.0.1's agents stay visible and usable, each in its own terminal without a card or Facade tools, with one plain notification; closing a terminal asks first; the update starts no five-minute cleanup; ARCHITECTURE-2.4 |
| E06 | Window component missing, disabled, installed late after a remote first install, or older than the workspace component | Existing agents keep running; plain explanation with an Extensions action; New Agent unavailable until it appears, then works without a manual reload where the editor allows; an older component leaves the window usable and other windows unavailable to agents; ARCHITECTURE-4.3 |

## 4 Handoff and review

### 4.1 Implementation order

**Build shared contracts first, then the human journey, then the full compatibility matrix.**

1. Read PRODUCT, EXPERIENCE, RULES and this document; inspect current dirty-tree baseline before edits.
2. Investigate G2 with small isolated traces/fixtures; raise concrete spec feasibility problems to the assigned reviewer early.
3. Implement run records/state and execution adapters.
4. Implement human lifecycle and direct terminal journey, then agent discovery/start/message/result journey.
5. Complete location/worktree, panel and commands/settings using the same services, then the client network across
   windows and environments.
6. Run relevant suites and required behavioral scenarios; inspect real isolated UI; update the implementation-to-rule matrix.
7. The assigned reviewer checks evidence/diffs and resolves defects with the implementer; report completion levels under 1.1 separately.

Task assignments and current status follow the user's current instructions; they are not product rules. Raise a concrete rule/scenario/evidence issue when needed; do not repeatedly ask the owner to approve routine
engineering choices. Apply the owner-reviewed simple contract rather than preserving invalid requirements for old tests.

### 4.3 Review output

**The final implementation report states what works, what was tested and what remains, with no hidden partial completion.**

Provide changed areas, rule-to-code/test coverage, required-check results, critical-gate evidence, pending platform/CLI
validation, relevant risks and exact reproduction for unresolved defects. Leave the workspace intact and uncommitted.
The spec stays authoritative after agreed amendments; audit history records why. A model saying it is done is a prompt
for review, not acceptance evidence.

## Checks

| Rules | How checked |
| --- | --- |
| 1.1–1.3 | Report separates spec/code/runtime and includes actual evidence entries |
| 2.1–2.2 | Each critical gate has a reproducible result; no inferred native/remote pass |
| 3.1–3.3 | Scenario matrix has recorded result and artifacts at acceptance |
| 4.1, 4.3 | Handoff, spec-amendment log and independent review |

## Change log

- 2026-10-30: G1, G3 and G5 record 0.2.0 run natively on Linux and Windows and over Remote-SSH to both, the real Claude Code
  attempt, and the two Windows crashes of ptyd found and fixed.

- 2026-10-30: Step 2 of the Facade Code extension: G1 covers the client network and extension-pack installation; G3
  proves layout-based input readers on current and earlier versions and three platforms instead of a version list (D78);
  2.2 adds local plus two remote environments messaging and stopping each other; 3.1 adds J08, J12 and J15; 3.2 carries
  M01–M22 with the one-state read (M15, D77) and `#human` (M16, D80) and adds M23–M25; 3.3 adds U10, U11, E02, E05 and
  E06.

- 2026-10-30: J07 covers LIFECYCLE-3.1's confirmation when live agents' tabs are closed alone or together; J09 and G2
  follow the five-minute policy (D75); G2 and G5 record the candidate 4/5 native evidence and what was not run; C01 waits
  for the `.launch` setting's later step.

- 2026-10-29: J02/J03 separate picker order from launch defaults; W01 includes the checkout source label for a subfolder.

- 2026-10-29: J02 follows the owner's IA-03 naming rule: empty and `human` labels are valid; IDs identify agents.

- 2026-10-29: W04 tries Delete Worktree on clean, dirty, locked and detached worktrees with agents (D73).
- 2026-10-29: Step 1 of the Facade Code extension, carried from the Facade Dots specification: the rules step 1
  needs, each with its final number. Later steps add the others.
  Gates G2 and G5 and the scenarios step 1 needs keep their IDs.
