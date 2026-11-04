# Verification and implementation handoff

Layer 4. A target specification and a verified implementation are different deliverables. This document defines the
evidence each claim needs, the critical gates with their current status and the scenarios that prove the product. The
results themselves accompany the tested build or handoff (1.2).

| Group | Decides |
| --- | --- |
| 1 Acceptance | What “complete” means and what evidence must contain |
| 2 Critical gates | Platform and integration proof, coverage and each gate's status |
| 3 Scenarios | End-to-end behavior and focused failure coverage |
| 4 Handoff | Work order, MCP reliability review and reporting |

## 1 Acceptance

### 1.1 Three separate claims

**Specification completion, code completion and product verification are reported separately.**

Specification: owner decisions are kept in their owning rules, layers agree, contracts define outcomes, and references
resolve. Code: required behavior is implemented with relevant automated tests and no knowingly omitted feature.
Product: complete journeys work in supported real editor/environment/CLI combinations, with evidence. A successful type
check, mock test or CLI launch proves only that check. Open critical gates block claiming complete product support,
even if all local unit tests pass. A documented unsupported capability is honest degradation but does not satisfy a
required release promise for a built-in advertised as supporting it.

### 1.2 Evidence format

**Every passed scenario records exactly where, when and how it was checked.**

Evidence entry: scenario ID; spec revision/hash; code revision or working-tree snapshot/hash; date; OS/architecture;
editor/client/server version; CLI and model when relevant; local/SSH/WSL/container environment; isolated data/profile
paths; command/procedure; observed result; assertion/log/screenshot path; pass/fail/blocked/not-run; known limitations.
Store results with the tested build or handoff, without credentials or full private conversations; this document keeps
only each gate's current status. Screenshots are needed for visual/focus claims; traces for process/delivery/lifetime
claims.

A result certifies only the build it ran on: a result of another build, of the code before a merge or of part of a
suite certifies no other build, and a queued or incomplete pull-request check is not a pass. A claim from another
product's source is not evidence for this one. Editor journeys with fake CLIs prove Facade's side, not a vendor CLI's
native integration, which native probes record separately (CLIS-5.1). A failed or interrupted attempt is kept as such
and never counted as a pass.

An MCP change is measured as fixed whole journeys against a frozen build of the code before it, recording UTF-8
context/result bytes, calls, effects, duplicates, false conclusions and recovery choices. Bytes are not token counts.
Deterministic contract faults, native clients with controlled providers and real-model choices are separate evidence
classes. Keep all attempts and denominators; small repeated model samples establish observations, not universal
reliability. Timing in fakes is harness timing only. `npm run measure:mcp` (`scripts/measure-mcp.mjs`) checks the same
scenarios against a chosen compiled tree; baseline failures remain in its report rather than being omitted to improve a
size comparison.

### 1.3 Required gates for an implementation milestone

**Run the repository's required checks and the scenarios affected by the change before reporting the milestone complete.**

Use ARCHITECTURE-5.1's type checks, unit suite, bundle, package checks and isolated integration suite, together with the
translation check `node scripts/l10n.mjs check` and the specification audit (audit/REPORT.md); the extension's
pull-request checks run all of them on Linux x64, Windows x64 and macOS arm64. Add failure-injection tests where
behavior involves changed input, lifecycle or result handling; a test that repeats implementation logic is
insufficient. A fix to a test tool keeps every product assertion. A docs-only amendment needs the specification audit;
nobody needs to rerun the code suites for it, while the pull-request checks run their own. Re-run relevant checks when
an amendment changes behavior, and full gates at final code handoff. List unrun platform checks explicitly instead of
implying a local mock proves native support.

## 2 Critical gates

### 2.1 Platform and integration proof

**All gates must pass before complete product support is claimed; each gate states its current status.**

| Gate | Required proof | Status |
| --- | --- | --- |
| G1 Client network and packaging | Install the workspace component and its window component through the extension pack in clean local and Remote-SSH profiles; register windows, including windows with no agents or no folder; route every tool local→SSH, SSH→local, SSH→SSH and between two local windows; recover from stale registry entries; replace a window component on update with messages in flight; prove native backend packaging for each target | Proven: two local windows on macOS, Linux and Windows; Remote-SSH from a macOS client to Linux and Windows hosts in each direction, and between SSH windows on the two hosts; WSL and container windows working with a local window; each target's native package installed with the window component in a clean profile, both parts registering the window. Open: installation through the extension pack from the Marketplace; window-component replacement with messages in flight; across windows, real editors exercise list, start, message, screen and stop, and the other tools only contract tests |
| G2 Window lifetime | Under RULES-4.1's grace policy, reload, extension-host restart, remote loss and an update keep the original runs. Closing a local window ends them about 90 seconds later, and reopening its workspace within that time keeps them, as a reload does, whose claim comes well within that time on a machine as busy as J14's, its time measured; runs that ended restore their Pins' exact sessions in new processes once their exit is confirmed - never beside a run whose end is not confirmed, which shows a red card until its exit is heard, a window claiming while the grace ends runs waiting for those ends; no claim of another window ends a window's runs, two windows of one workspace reloading together keeping them all, shown in the one that claims last; runs a released build's ptyd holds keep its five minutes; a remote window's end about five minutes later, and a reopened window within that time keeps them. Close-one, close-last and reopen replay nothing and restart only Pins. The policy is timed with the production timer; a forced process exit proves exact restoration only. No public editor signal tells a close from a reload: that platform limitation is the reason for the policy, not an open gate | Proven: reload, remote extension-host restart, network loss with the remote host connected, an update and folder-to-workspace conversion keep the original runs; under the earlier five-minute policy for every window, closing and at once reopening a local window kept run, process, saved session and one terminal for every built-in, natively on macOS too, and without a reopen the process ended about five minutes after the close and its Pin restored the exact session in a new process. Open: the local window's end after 90 seconds and its reopen within them, a reload's time to claim under load, two windows of one workspace reloading together, an uncertain end's red card, on every platform; a remote window's reopen; close-one has no separate record |
| G3 Draft-safe ordinary input | For every built-in, on the current version and at least one earlier one, prove input box versus menu, actual empty versus history/paste/multiline draft, working-CLI submission, full text + Enter, uncertain effects and an unrecognized layout left untouched, in macOS, Linux and Windows terminals. A reader tells usable input and drafts by its box around the cursor alone: changed or unknown rows outside it - footers, hints, status, warnings, Codex's passive transcript footers - leave its reading as it was; a screen without its box reads as a native interaction where one of its CLI's recorded questions or menus shows, and unknown otherwise; Codex's transcript browsing, search and selection read as unavailable, and each reader reads as unknown every other CLI's recorded screens but where their boxes are drawn alike, as Claude Code's emptied box and Muse Code's empty one are; `node scripts/capture-inputs.mjs <cli>` records a built-in's pastes, tall and wide ones included, without submitting, against each built-in's newest version before a release and whenever the CLI updates. Codex's multiline message arrives whole on Windows, where it reads console input records; Antigravity's initial mode hints read as usable while the same text typed or pasted stays a draft (CLIS-2.1) | Proven: recorded screens of every built-in's current version, and of an earlier version for Claude Code and Codex; fake CLIs drawing each built-in's input pass paste, draft wait, Enter, the deadline failure, read delivery and a slow or missed Enter in macOS, Linux and Windows (ConPTY) terminals; real agents with YOLO off work together, messages pasted and submitted and no approval asked for Facade's tools, for Claude Code, Codex, Antigravity, OpenCode and Pi on macOS and Windows and for Claude Code and Codex on Linux, and Muse Code with YOLO on in all three. Open: readers that read the box alone, with recorded screens of Codex's transcript browsing, search and selection; earlier versions of Antigravity, Muse Code, OpenCode and Pi; Codex's multiline input on Windows; real Antigravity, OpenCode and Pi agents on Linux; Muse Code with YOLO off; input captures in Linux and Windows terminals |
| G5 Native environment matrix | Native macOS, Windows and Linux clients; SSH, WSL and containers; compatible editors (PRODUCT-5.2); the native PTY ABI; paths/quoting/Unicode/keys and package install | Proven: macOS arm64, Linux x64 and Windows x64 clients pass the unit, package and integration suites and install the packages; Remote-SSH from a macOS client to Linux and Windows hosts; a WSL window and an attached container window working with a local window; VS Code 1.105, the declared minimum, on Linux; Unicode input. Open: Linux and Windows as Remote-SSH clients; suites running inside a container window; other architectures; the minimum VS Code on macOS and Windows; compatible editors, of which none is verified and so none is claimed |

The integration suite, `npm run test:integration`, runs in isolated official VS Code profiles with fake CLIs: the
journeys of each built-in and of a custom CLI, two local windows, Pin and Unpin across reload and folder-to-workspace
conversion, a local window's close and immediate reopen, and its expiry on the production timer. `FACADE_IT_ONLY`
selects `journeys`, `cross`, `conversion`, `reopen` or `expiry`; `real` and `real-lifecycle` run real CLIs, only when
asked. `npm run test:remote` runs the journeys over Remote-SSH - `ssh`, `ssh-ssh`, `local-ssh` and `ssh-local` on each
host, `hosts` between two - and with a container of the local Docker attached as Dev Containers attaches. WSL and
installation from the Marketplace are checked by hand.

The implementer investigates concrete mechanisms and brings engineering changes with evidence to the assigned reviewer.
A failed proof cannot be disguised as an implemented heuristic or automatic product-scope reduction. If it cannot be
solved in the available environment, complete independent work and record the exact missing evidence and required next
action.

### 2.2 Coverage matrix

**Every execution environment runs the same core contracts; unsupported capability evidence is explicit.**

| Dimension | Required samples |
| --- | --- |
| Client | macOS, Windows, Linux; VS Code 1.105 (the declared minimum) and current; a compatible editor before support for it is claimed (PRODUCT-5.2) |
| Execution | Local; Remote SSH Linux plus another supported host OS where available; WSL; Dev Container |
| Workspace | Plain folder without Git executable; ordinary nonrepository with Git; main checkout; opened worktree; mixed multi-folder; nested/duplicate repo folders; no folder |
| CLI | Each built-in, current and an earlier version for input readers; valid custom definition with required Resume but unverified runtime capabilities; missing Resume rejected; missing/disabled/invalid CLI |
| UI | Themes/widths/zoom/languages/reduced motion/keyboard/accessibility from UX |

Use pairwise sampling for routine presentation combinations, but exercise every critical G1–G3 boundary directly.

Three required product exercises are local plus two remote environments messaging/stopping each other (J15), first
launch from the empty-panel explanation (J13) and usable panel/search/order with 100 agents in one window (J14). Test
CLIs may supply the scale load; vendor capability evidence still uses the actual supported CLI. More than 100 remains
allowed, without implying tested usability at that scale. A real VS Code user must walk the common flow before public
use (J16); automated tests do not replace this check. Do not create a full combinatorial matrix or repeatedly rerun
unrelated suites for small changes. Missing environments are recorded as not run, not fabricated passes.

Status: J15 is proven between a local window and SSH windows on Linux and Windows hosts. J14 is proven on Windows with
fake CLIs - panel, search and order usable, a further start, and every start of a burst - and open on macOS and Linux.
J13 and J16 are open: no walkthrough is recorded. The two dots, the last-message second line, the tab spinner, the two
queues, tab-close questions and Pin before a conversation is named are proven only by unit tests and the pull-request
checks.

## 3 Scenarios

### 3.1 Core journeys and lifecycle

**Acceptance exercises complete journeys, including their failure exits.**

| ID | Scenario | Expected observation / owner |
| --- | --- | --- |
| J01 | First human launch in plain folder, Git removed from PATH | Same short CLI flow, no Git setup/error; immediate pair; PRODUCT-5.4, LIFECYCLE-1 |
| J02 | Multi-folder defaults, last successful CLI/location, missing-location fallback, edit name, search/scroll CLI choices, cancel | Remembered/opened location stays selected independently of main-first display order; current name and actual location remain visible during search; last successful CLI preselected; editable label allows empty strings, `human` and duplicates; canceled choices not remembered; LIFECYCLE-1 |
| J03 | Open main versus open its worktree, including symlink/case/nested paths | Main checkout first in the picker; the actual opened folder remains the fallback launch location; no duplicate physical lock; WORKTREES-1 |
| J04 | CLI/worktree creation fails; native post-create setup fails; Facade tools fail while the CLI is usable; an agent another agent starts fails with its tab never opened, and one fails after its tab was hidden | Actual startup failures retain pair and report to initiator; setup success is not a launch gate; the CLI stays usable while its card is red and says why in plain words; a failure with the tab hidden shows on the card, and opening the tab shows its reason line; LIFECYCLE-1.5, RULES-3.2 |
| J05 | Startup before the CLI's first report and before its injected Facade tools connect, and past CLIS-2.3's bound; working, idle, native blocker, unknown activity, a native blocker with unusable tools, recovery | RULES-3.2's dots: green and breathing while starting and while working; red with why once the bound passes before the CLI shows activity and its tools connect; idle, blockers and unknown activity show no dot, the hover saying which; work that stops shows a second later; a native question shows no dot and leads the second line even over unusable tools, the hover keeping the other explanation (PANEL-1.4); no idle/turn-end popup |
| J06 | Normal exit 0; Ctrl+C ordinary interruption from the person; unexplained nonzero exit | Actor-independent classification; abnormal retained; unknown cause no popup; RULES-3.3 |
| J07 | Close Agent from the card, Go to Agent and the palette, stop during creation, unreachable remote cleanup; close a starting, live and ended agent's tab by itself, then live agents' tabs with Close All, Close Others and closing their group | Close Agent immediately removes the pair; cleanup background, no fixed five-second wait; created files remain; a closed tab - alone or together - hides its agent with no question, the agent running on with its screen, draft and tools and its card opening it again, a starting one still starting; LIFECYCLE-2.2, 3.1 |
| J08 | Close creator, keep worker in same/other window | Workers remain except those owned by a window actually closed; RULES-4.1 |
| J09 | Reload, extension-host restart, an update from a released build with its agents running, remote loss, close-one, close-last, immediate reopen, close-last without reopen | G2 trace; original process survives reload/disconnect/update; after the update the agents the released build started show and work through its ptyd, which exits once they are gone (ARCHITECTURE-2.4); a local window's reopen within 90 seconds claims the original runs, and without it they end at 90 seconds and its Pins restore at the next opening - a cleanup that fails or is unconfirmed restores none beside it, its run's red card going and its Pin restoring once its exit is heard; two windows of one workspace reloading together keep their runs, all shown in the last to claim; runs held by a released build's ptyd keep its five minutes; a remote window's reopen within five minutes claims them, and without it they end at five minutes (RULES-4.1) |
| J10 | Both EXPERIENCE-4.1 journeys through review/integration and ordinary cleanup | No built-in task/workflow; files accessible without Git |
| J11 | Resume an external and a Facade conversation, missing/empty/saved names, a nested cwd, old history beyond the first page, a disabled CLI and a running session, with every built-in | Exact ID/CLI/cwd and current launch settings; keep a nonempty saved name, otherwise assign and save a short suggestion only on manual Resume; no duplicate process, age cutoff or implicit Pin; LIFECYCLE-3.2, LIFECYCLE-3.3 |
| J12 | Pin/Unpin from a card and native tab with every built-in: a resumed conversation from its start, a new agent before its CLI names its conversation, reopen, failed restoration, session change, a Pin or Unpin that cannot be saved, explicit close by the tab's Close, Close Editors and Group, Close All Groups and Kill All Terminals, Close All and Close Others with a mark still to follow, and normal/abnormal exit; for each built-in a real reload, folder-to-workspace conversion and close/immediate reopen, and the expiry on the production timer | One saved intent and the pinned area's order (PANEL-2.1); a Pin made before its CLI names a conversation takes the one it names, and a window opened before that starts a new conversation of that CLI with the Pin's name and location; a CLI that cannot resume its exact conversation cannot be pinned; the Pin follows its own tab, matched through the exact terminal and never by name or position, also when the editor's tab-group event brings new Tab objects; a Pin or Unpin that cannot be saved is undone and reported; a person's close of a tab showing its pin mark Unpins it and hides the tab, an Unpin that cannot be saved opening the tab again pinned, while the close of a pinned agent's tab whose mark is still to follow, Close All, Close Others, a reload, a move and the window's close leave the Pin; a hidden agent pinned or unpinned from its card stays hidden; restored Pins open their tabs in the background, in the active group, each tab's mark following when it is next active; two background starts at most, no focus theft or retry loop; each failed restoration keeps its own card, and one notification reports the failed restorations of an activation; LIFECYCLE-3.4, RULES-4.2 |
| J13 | New VS Code user follows empty-panel explanation | First agent starts without a separate onboarding wizard |
| J14 | 100 agents in one window, started one after another; 20 started right after closing 20; then request another | Panel/search/manual order remain usable at 100; every requested start starts; no 100-agent hard cap |
| J15 | One local and two remote execution environments on one client | Agent starts, messages, screens, keys and stops work between them within YOLO/tree rules |
| J16 | Real VS Code user completes the common flows, including asking one agent to work with others, before public use | Record observed familiarity/usability; automated tests alone do not pass |
| J17 | An agent starts one agent of every built-in with a prompt; none of their tabs is opened; they are messaged, their screens read and typed into through MCP; then each tab is opened, some hidden again, the window reloaded, and a released build's agent's tab hidden while its CLI asks its terminal a question | Every one starts, takes its prompt, sends and receives messages, and is read and typed into with its tab never opened, at 120 columns by 30 rows, its terminal queries answered by ptyd, its card showing its state throughout; opening a tab shows its current screen, and the window's focus and visible editor never moved before; after the reload open tabs return to their groups and hidden ones stay hidden; the released build's hidden agent has its question answered once, by the window's headless terminal holding its screen, and goes on working, messaged and read as before; LIFECYCLE-2.2, 3.5, CLIS-2.3, ARCHITECTURE-2.3 |

### 3.2 Collaboration and contracts

**Message and operation tests assert actual input effects, not just queued records or screenshots.**

| ID | Scenario | Expected observation / owner |
| --- | --- | --- |
| M01 | List current state with empty/folderless windows, multiple folders/worktrees, location-specific CLIs, invalid configuration and unreachable windows; target one agent | One snapshot supplies launch/communication destinations and current CLI availability, counts cover responding scope, unavailable is not empty, retained ended state is targeted only and does not scan CLIs; MCP-2.1, 3.1 |
| M02 | Omit name/window/location/CLI; omit model/effort; pass unsupported field/type | Required fields fail together before effects; omitted model/effort add no per-call override under CLIS-1.4; optional request_id on start/send alone; no permissions/task fields |
| M03 | Create across windows/remotes, plain folder or external-created checkout; native/post-start prompt still pending after process success, Antigravity's after its tools' preparation included; a message sent right after the start answers; a group of starts in a row | Actual destination, creator's tree and background focus; YOLO per RULES-4.3; separate process and delivery results; the start answers once the process runs, with `call_id` and `result_message_id` while its prompt is pending, and one later result settles the prompt with the same message ID/target under MCP-2.3, its budget starting after Antigravity's preparation; a message sent right after the answer goes after the prompt, its input held for that prompt from its stage's start, its accepted deadline ten minutes on; native path invents no Enter effect; the destination shows each card at once with its tab hidden |
| M04 | Send full multiline content while recipient working; busy queue observable/unobservable | One full paste + Enter; success without waiting; no unsupported queued claim |
| M05 | Existing draft via typing/paste/history, then clear it | No append/overwrite/Enter; next eligible attempt without typing cooldown |
| M06 | Login/permission/menu, missing activity, unknown input, an input box of a version the reader does not recognize, a CLI with no reader | No blind Enter probe and nothing typed; working status not eligibility; `input_unknown` at the deadline names CLI and version; no reader fails at once as `unsupported`; RULES-1.4 |
| M07 | Direct success, permanent failure, slow input after 2 s; delayed shim/window forwarding | Exactly three initial outcomes and one accepted operation; measure monotonic elapsed time from RULES-1.2's first Facade ingress to response handoff, with internal hops consuming one budget; record client round-trip separately; MCP-4.1 |
| M08 | Draft clears on attempt four; another draft remains throughout; a long paste; queued behind another send | RULES-1.5's budget: a slot every 3 s; an input never held fails at 15 s; once another draft or a native question holds it, the stage ends 10 minutes after its start; a long paste adds its paste time; serialized whole writes; no extra attempts |
| M09 | Lose acknowledgement after partial/full input or Enter; repeat a new send with identical text; reopen windows | RULES-1.1's ID scope/reuse holds; retries retain ID, a new call gets another; skill explicitly teaches ID deduplication and separates results from instructions; no platform exactly-once guarantee |
| M10 | Repeat start after lost response, with and without request_id, also while its prompt is pending; attempt get_operation | The same request ID reuses the first start under MCP-1.1, a pending prompt answered as it stands with the first call's IDs; a new ID or an invocation without one can create another run; inspect with list_agents; get_operation is rejected |
| M11 | B delivered/not delivered while A is absent, busy, drafted or unreachable | A result for both outcomes; original outcome unchanged; finite handoff if possible, otherwise end; no report to B unless B actually sends, and no human notification |
| M12 | Failure returned to A; A does nothing or replies | No automatic human escalation or instruction to A |
| M13 | Only A closes while delivery pending; B still open; then B closes | Delivery already owned by B may finish; work left on closing side may end; no special takeover or future-open replay |
| M14 | Disconnect/reload over attempt slots and after deadline | No catchup burst/late Enter; no new budgets; reconcile recorded effects |
| M15 | Read messages before, during and after delivery; read after a failure result; lookup sent or another agent's message by ID | Own inbox only including YOLO; a read delivers immediately, cancels an unstarted paste, and lets an already-issued owned draft finish without submitting a person's edits; its sender's result says read_messages and keeps uncertain input effects uncertain; a record read after its failure result gets no second result; reads by ID or all:true never paste again |
| M16 | One recipient by ID, unique name, ambiguous name, recipient array, `#human`, `@human` with and without an agent named `human`; a name or `@human` while another window cannot be listed | ID/unique name resolves once; ambiguity requests ID; `#human` always reaches the person; while a window cannot be listed, a name or `@human` fails as unavailable rather than resolving among the windows that answered (RULES-2.3); arrays refused before effects; one independent message/result |
| M17 | Direct multiline/large/whitespace text, ESC/other control characters, empty text without Enter, a short text and its Enter to Muse Code, existing draft, menu, unknown layout, key sequence, stop | No input_policy, draft guard or artificial text cap; exact serialized input and true partial/unknown effects; controls other than tab/LF/CR and empty no-Enter text fail INVALID before writing; Muse Code's Enter, 250 ms after its text, submits it; ordinary messages still protect drafts |
| M18 | Long screen/history local-to-remote and remote-to-remote; one included record expires | Complete file readable by caller; delete whole temporary message file on any included expiry and regenerate remaining records on demand |
| M19 | MCP switch changes during an existing run and before a new start | Existing tools/runs unchanged; only subsequent injection follows setting; no message replay; recipient MCP not needed for terminal delivery |
| M20 | Same-tree sibling/ancestor access, unrelated root, YOLO, duplicate names and stale IDs, across windows | Normal tree scope on reads/writes, YOLO all; ambiguity does not guess; ended ID never retargets; no authentication/token/delegation requirements |
| M21 | Change YOLO before a human start and a child start in another environment; change it again while runs live | Every new run uses the destination's setting at acceptance under RULES-4.3; existing runs keep their value; children retain their tree without inheriting the creator's setting |
| M22 | Concurrent accepted calls, including more than one to the same run, finish out of order | Each result identifies its originating call and exact target under MCP-1.3; existing call context suffices without requiring caller-managed IDs or a query API |
| M23 | YOLO off: an agent calls each Facade tool, then its CLI runs a shell command | No approval prompt for Facade's tools in Claude Code, Codex, Antigravity or OpenCode, and none in Pi, which has no approvals; Muse Code's own approvals and review decide for its tools (RULES-4.3); the CLI's own approval still appears for its command; MCP-6.1, CLIS-2.2 |
| M24 | Facade server cannot start or connect | The CLI starts and stays usable - except Muse Code started through cmd.exe, whose run that server can fail (CLIS-2.2); the card is red and explains in plain words; tools_state unavailable; LIFECYCLE-1.5, RULES-3.2 |
| M25 | Message to the person while its agent's terminal is visible and hidden; long message | Notification in the sender's window names the agent; Open Message and Show Agent open the complete message and the agent; no notification in another window; COLLABORATION-2.3 |
| M26 | Concurrent starts/sends with one request ID; routed delivery with a lost reply; Unicode request IDs; retry after run exit, close, failed start or interrupted startup | One original run/message within the one-hour period; receiver deduplicates before input and returns the original ID; metadata survives reload without restoring closed cards; an unrecorded startup outcome stays unknown; MCP-1.1 |
| M27 | list_agents from a folder or worktree, unfiltered and with window, location or agent selections; an unavailable peer window; a start using its startup context's IDs; lists of 1/20/100/200 agents with equal timestamps and a changed cursor selection | Every responding window, empty ones included, with its locations and CLI choices; unavailable windows explicit, never empty; a start needs no discovery call; no guessed location; compact rows with explicit scope/completeness; complete, stable pages and targeted details; a cursor whose selection changed fails before remote reads; MCP-2.1, MCP-3.1 |
| M28 | Repeated activity reports, title changes, reconnection/reload, missing source time and browser/source clock differences | Source state observation stays distinct from query time and panel reconstruction; reliable relative or absolute hover time, no invented recency or elapsed-time warning; RULES-3.1, PANEL-1.5 |
| M29 | Notifications with blank/long/duplicate names, Unicode and literal boundary text; parallel accepted operations; routed duplicate result after reload; a receipt batch partially submitted before reload | The 📨/🔔 English templates, complete original bodies, no terminal JSON/footer; reserved result_message_id matches the final result without a fake inbox item, one result for a start whose process and prompt settle separately; frozen input is not reformatted or pasted twice; success/unknown/partial, input, prompt, process and worktree facts stay distinguishable; COLLABORATION-2.1–2.2, MCP-1.3 |
| M30 | Human/agent creation, two runs in one directory, a newly created worktree, creator closure, no prompt, shim reconnect and restored conversation | Each launch's own identity, creator address, actual location and initial message remain available through private instructions; shared files contain no personalized context; no welcome turn, mandatory report or replay; MCP-6.2 |
| M31 | Current and retained terminal frames, inverse/dim together, blank cursor, literal marker characters, Unicode/combining text and large local/routed output | One reversible styled body with exact text and cues; one complete JSON file uses the same representation; historical frames keep their own time; unavailable source cues explicit; compare payload cost and real-model interpretation without changing raw input; MCP-5.1–5.2 |
| M32 | All six native clients: injection, first task, complete notification/receipt, discovery in one call, screen interpretation, reload and exact restoration; the real-agent journey | Version/platform/provider recorded separately for native input, controlled-provider and real-model checks; a fake CLI or an unauthenticated launch is no model-support claim; isolated state only, with missing login/platform evidence explicit; the real-agent journey sends each message once, starts one agent and stays within ARCHITECTURE-4.1's call bounds; delivery is not model execution, so no valid read is suppressed and no turn ending or hidden retry is forced; VERIFICATION-2.1 |
| M33 | Route connection/queue time, exhausted budgets, lost/malformed/late replies, pure queries versus delivery-confirming inbox reads, and retries after target disappearance | One remaining budget through hops; no request forwarded after expiry; none/unknown/partial remain truthful; original target/request identity preserved; no automatic replay; MCP-1.1–1.3 |
| M34 | Initialize, tools/list, a tool loaded alone, optional skill and native private-context hooks; a project skill beside a run's own | Launch identity and delivery semantics reach the model without mandatory skill reads; titles/annotations preserve names, arguments and approval behavior; the skill's frontmatter parses as YAML and a native skill loader accepts it, which a successful tool call does not prove; Pi loads one Facade skill whether or not an identical project skill exists, across reloads, and a different one still reports its collision; compare each context layer in UTF-8 bytes and retain real-model evidence limits; MCP-6.1–6.2 |
| M35 | Concurrent operations on one agent, routing, reload, rename/close, expired originals and lost receipt delivery | Existing IDs and explicit operation/route facts remain searchable without message bodies in logs; localized summaries never guess missing records; receipt transport and operation outcomes remain separate; COLLABORATION-3.2, ARCHITECTURE-3.3 |
| M36 | Fixed discovery/start/message, long screen, pagination, uncertain input, lost reply and accepted-result journeys before and after an MCP change | Report text/structured/context bytes separately, extra calls and actual effects; zero duplicate writes/starts or false completion in deterministic scenarios; retain all native/model attempts and platform limits; VERIFICATION-1.2 |
| M37 | Launch with defaults or explicit model/effort; inspect structured history, rotation and failures | Requested settings are distinct from effective native settings; request/start/failure/exit share IDs without prompts or argv, bounded JSONL history is readable with ordinary file tools; no model catalog and no separate discovery tool; CLIS-1.4, ARCHITECTURE-3.3 |

Native lifecycle probes use the isolated editor driver, record the actual CLI PID and native session ID, and compare
both across reload and reopening. Ending that test-owned process after window closure can exercise exact restoration
without waiting for the grace timer; this is recorded as forced process exit, never as evidence of the grace policy.

### 3.3 Files, safety and presentation

**Data-loss and visual claims have their own evidence, independent of basic launch success.**

| ID | Scenario | Expected observation / owner |
| --- | --- | --- |
| W01 | Human creation from opened main/linked checkout, subfolder and detached HEAD; branch validation, Copy Path, Back/Escape; programmatic explicit base | Both human entries use their actual source HEAD; standalone accepts a valid branch directly without confirmation/base editing, New Agent waits for CLI choice; title, source and destination previews remain accurate, including after Back; no creation on typing/cancel; programmatic explicit bases still work; fixed sibling destination and no overwrite; WORKTREES-2, 4.3 |
| W02 | Request worktree without Git/repository/commit; ordinary folder launch | Creation reports actual prerequisite; no initialization/initial commit/advice flow; ordinary agent still launches |
| W03 | Native copy/link/preparation delayed or failed; close creation before CLI spawn | Existing recognized worktree permits CLI without waiting; canceled launch does not spawn; no Facade setup job monitor/retry |
| W04 | Delete Worktree on clean, dirty, locked, detached and nesting worktrees with agents; an assumed-unchanged or skipped edit; an agent that does not end; a file written as its agents end; on Windows with a Git older than 2.54, one holding a link to a folder; Git leaving the folder behind | Clean: agents close and end, then `git worktree remove` without `--force`, branch kept; dirty or locked: refused untouched; detached: confirmation says it has no branch; a folder link with Git for Windows older than 2.54: refused untouched, before and after its agents end; a folder Git leaves is reported, never deleted by Facade; no other deletion, discard confirmation or stop-with-delete entrypoints; WORKTREES-3.2 |
| W05 | Actually remove workspace folder or externally delete worktree with agents | Immediately close affected pair(s), background cleanup; other locations continue |
| W06 | Remote temporarily disconnected or Git read fails while location was known | Do not mistake unavailable observation for actual location deletion; no cleanup from that alone |
| U01 | Narrow/high contrast/reduced motion/non-English/keyboard/screen reader; same-named filter folders; full card hover; creation substep navigation | UX/PANEL checks; folder count then parent path without changing filtering; uniform localized Label: value hover fields preserve complete text and source clocks; explicit substep titles; no invented completion/extra badges |
| U02 | Old-page action/reply, unrelated state change before a current-page action, agent rename while menu open | PANEL-3.1 generation isolation and current-target validation; no wrong target or required per-action expected revision |
| U03 | Human operation error, agent operation error, failed message return, explicit `#human` | Error to initiator; no agent message fallback to human; explicit contact shown in related window even when terminal visible |
| U04 | Empty filtered panel; a person's start outside the filter; missing Git | Filter remains unchanged; new card follows normal data/order and only matching entries display; no launch-default change |
| U05 | New card, Pin, Unpin, manual movement, filter | Card-count badge; a new card last among the unpinned cards, a new Pin last among the Pins, an Unpin first below them; Move Up/Down within its area; a card the person started scrolls into view, an agent's start does not move the list; state changes never move a card; PANEL-2.1 |
| U06 | Go to Agent and Resume with empty/equal/long names and titles, CLI searches and later history pages; exact/short IDs and stale-name copied references; terminal placement - a card's click, Enter, Go to Agent and Show opening the tab in the active group, or focusing it in another group without moving it - one unpinned agent tab per group as agents open, are unpinned, moved in - the active tab dragged, several dragged at once, by a Move Editor command - split, copied by a drag or into a new window, and their groups joined, a Close Group that moves its tabs included, as two tabs open at once, as the oldest supported editor replaces Tab objects without a report, and as a reload restores tabs of two groups gone into one, rename, CLI title changes, a busy agent, a reload restoring tabs per group, and Go to Agent and Resume searched by a location the window's one place leaves unsaid | Single-line pickers emphasize name/title respectively, retain equal fields and hidden CLI search, and distinguish duplicate names by short ID; Resume browsing never assigns names; ID selects the intended current-window run; an editor tab shows the CLI icon, a spinner frame while the card's dot is green - one still frame under reduced motion - and the agent name, never a CLI title; native renames keep literal title-like suffixes, and spinner frames are never taken for a rename; no global default shortcut; after an Unpin a group keeps its active unpinned agent tab, else the one just unpinned; after a move, the one moved in; a tab Facade cannot tell hides and Unpins nothing until it next becomes active; where groups join or a reload restores two into one, the active one, else the last active; a pinned one hides none and an undone Unpin nothing; a split or copy leaves the agent where it was and starts, in the copy's place, a new agent of its CLI and location, with its model and effort where it had any, under a new name, focused, leaving no empty tab, and a copy Facade cannot tell closes, starting nothing, and one whose launch is refused before acceptance closes, its reason told, the first agent untouched; a reload reopens each open tab in its group without focus and keeps hidden ones hidden; a location left unsaid still matches a search; LIFECYCLE-2.2, 2.3, 3.2, 3.3 |
| U07 | Command/menu catalog with starting, live and retained-ended records; view a notified source | One Close Agent action for all states; the commands registered are exactly UX-3.1 and UX-3.2's, with no other command or alias; no attention queue or seen state; opening does not clear the error |
| U08 | Activate agent B, switch to a file/unrelated terminal, invoke palette Rename/Pin/Close; hide B's tab and repeat; repeat without a selected run | Available actions target B under UX-3.1; no target picker; unavailable without a valid target; explicit card/tab context still targets its own run |
| U09 | Browse near the 80th card, switch to Explorer, then return; repeat after the navigation target is removed | Restore still-valid scroll position and navigation target without stealing input focus; removed target is discarded; existing PANEL-3.3 scrolling behavior is unchanged |
| U10 | Every new person-facing string - notifications, settings descriptions, cards, opened messages and errors - in English and all eleven languages | Plain words with no internal terms under UX-1.3; reviewed by a content author and two reviewers; complete translations |
| U11 | A message to the person opened from its notification, with a long body, links and command text | Read-only; delivery outcome shown; links and commands rendered as text; COLLABORATION-3.2 |
| U12 | Scrollbar initially idle, hover/leave, wheel and keyboard scrolling, drag outside and release/cancel, window blur, reduced motion, resize and changing card counts; track clicks with both scrollByPage values; Modern UI absent/on/off and live changes; both caps and first/last cards inside a rounded host clip at 100%, 125%, 150% and 200% display scale; native sidebar width sweeps through clipped and unclipped iframe sizes; short and empty content | PANEL-3.3 visibility and fading; native sidebar width, corners, theme colors and matching hit area in both modes; shared content/overlay compensation, dynamic correction removed when no longer needed and a device-pixel guard for rounded cross-origin bounds, absorbed by the cards' right padding so both card sides stay equal; filled cap/card contours retained (shared edge antialiasing allowed), no additional list top/bottom padding and 2 px Modern UI clearance for scrollbar ends only; compare total bottom spacing with native Extensions in the same editor; no traditional decorative inset, full scroll range through wheel, keyboard and dragging, fractional track endpoints and correct empty-padding hit testing; zero scrollbar gutter with and without overflow; no width jump on hover, stuck visibility, lost valid scroll position or hidden keyboard target |
| U13 | Panel widths 180/260/420/720 px, editor zoom -1/0/2, short/long names and folder/worktree pairs, Pin/Unpin, resize and Unicode; the green and red dots and no dot otherwise; a person's Enter, a delivered message and a start task, before and after a reload; title updates and the tab's spinner | Short labels use their natural width; long locations borrow space, both components remain, middle ellipses preserve whole graphemes, full hover/accessibility stay available, no overlap/overflow with the Pin or clipped viewport, and a Pin stands as close to a shortened name as to a whole one; idle and blockers show no dot and the hover tells them apart; the second line shows the last message sent - a Facade message's own text without its 📨 line, a result as typed with its 🔔 line - and keeps it across a reload, the CLI title's words without their state prefix only before any message, and a red dot's reason or a native question while it lasts; native titles never rename an agent; PANEL-1.3–1.5, RULES-3.2 |
| U14 | Native blocked with missing/new kind across every CLI; connecting tools before/after startup and past the start bound; long Unicode titles; decorated terminal titles beside plain report titles; empty/missing/cleared titles; unknown-state reports; Muse soft wraps, hard breaks, clipping, native answer/animation styling, synchronized redraw, resize, reset and recovery | Preserve generic blockers, without a dot, and full hover; Idle makes no input-readiness claim; tools not connected yet are named in the hover, distinct from failure, until the start bound, then red; graphemes stay whole; the latest terminal title wins over a report's title and decoration-only updates show, while each complete report sets the report title anew, empty or omitted included; a cleared title clears the card's, a lost connection alone keeps it; invalid/unknown-state reports are dropped whole; lost screen evidence never invents idle or retains working. Record native client/provider and platform evidence separately; RULES-3.2, PANEL-1.4–1.5, CLIS-2.3 |
| U15 | Each built-in's terminal logo on its tab in Light Modern, Dark Modern, both High Contrast themes, Solarized Light and the Minimal file-icon theme, after a theme change and after a reload, and with file icons turned off | Every logo renders in its icon slot in its brand colors or the theme's foreground; icons stay hidden where the file-icon theme hides them; `node scripts/test-agent-icons.mjs` after compile and package; LIFECYCLE-2.2 |
| U16 | Native Codex 0.166.0 completes with a retained background command; follow-up, streaming, drafts, resize, blocked/error/clear/reset, unknown layouts and versions; old and new supervisors | Only the complete native completed-turn layout narrows aggregate working; real work and native precedence are kept; status events, list and reattach agree; an isolated native regression (`scripts/probe-codex-status.cjs`) fails before and passes after; RULES-3.2, CLIS-2.3, ARCHITECTURE-2.4 |
| U17 | Native Codex passive transcript navigation with empty and multiline draft composers, new activity, earlier messages available, a changed or unknown passive footer, right-aligned warning, active browsing/search/selection and synchronized drawing | The full composer with the cursor in it is usable whatever its passive footer says, a changed or unknown one included, while active browsing, search and selection are not; bracketed paste, own-draft verification and Enter reach native history exactly once (`scripts/probe-codex-input.cjs`); drafts and active interactions are refused with no effect; passive input never establishes idle; CLIS-2.1, 2.3, RULES-1.4, 1.6 |
| C01 | `facade.<cli>.launch` with literal arguments and an environment map; an argument repeating an option Facade sets, in any of its CLI's spellings; an explicit model/effort from start_agent | Arguments and variables pass in the order and shape given; an option Facade sets is refused with its place named; an explicit model/effort replaces only its matching configured arguments; CLIS-3.1, CLIS-1.4 |
| C02 | Executable found only through configured default-profile PATH; null/omitted variables at each env layer; remote and Windows cases | Discovery and launch use the same CLIS-1.2 environment; null removes, omission inherits; no shell-init execution/parser |
| C03 | New worktree with tracked relative executable; missing/nonexecutable file after creation | Static validation before creation; cwd-dependent checks use actual Git destination before spawn; failure retains pair and created worktree; no preparation barrier/rollback |
| C04 | Custom definition missing/empty Resume, lacking exact-session placeholder, containing a capabilities field, a key that cannot be an ID, valid unverified Resume; a valid definition started | Invalid definitions cannot start; only path/launch are configured; a valid one starts with exactly its configured arguments, without Facade tools or an input reader; a valid command alone does not prove Resume/Pin under CLIS-3.4 |
| E01 | Output flood/slow UI, attach snapshot/output race, current/alternate screen | Bounded pressure, no duplicated input/output, readable final evidence |
| E02 | Settings, commands and records of released builds; records/settings from development builds; old MCP calls | Released builds' settings keep working, and their commands that UX-3.1 and UX-3.2 list keep their IDs, with no alias for any other; development-build records ignored with one log line and no aliases; old MCP calls fail explicitly; no kill/replay; ARCHITECTURE-4.2 |
| E03 | Package contents/localization/native ABI/install in isolated profiles | No test probes/secrets, complete strings/notices, verified components; a clean install of both packages activates both components and offers Resume, Pin and Unpin without test commands |
| E04 | Full compile/test/bundle/package/integration milestone | Record actual command/results, no claim of unrun native support |
| E05 | Update from each released build with running agents in local and remote windows, then reload | Those agents retain their cards and terminals, with scrollback, resize, direct terminal input, close and exit handling; their Facade tool calls are answered, or refused as `protocol_incompatible` with no effect where their tool protocol is older; screen/input operations their ptyd lacks fail without sending a request; the update starts no five-minute cleanup, and their ptyd exits once idle; new agents start in the updated build's own ptyd, also after an update that kept ptyd's protocol and on Windows where the editor removed the released build's installation, and a released build's ptyd that holds none of the window's agents is let go as the window finds it; new agent and message numbers continue past the released build's (RULES-2.2); at the first reload their tabs come back hidden, pinned ones' opening in the active group (LIFECYCLE-3.5); a terminal query those agents ask is answered as their ptyd expects - with their tab open, the window passing its terminal's answers on; with it hidden, by the window's headless terminal - and they go on working; ARCHITECTURE-2.3, 2.4 |
| E06 | Window component missing, disabled, installed late after a remote first install, or older than the workspace component | Missing or disabled: the window shows and starts no agents; the panel and one notification say in plain words that it must be installed and enabled on this computer, with an action showing it in the Extensions view, and Facade's commands repeat that explanation; its running agents go on for RULES-4.1's grace - 90 seconds in a local window, five minutes in a remote one or held by a released build's ptyd - so that installing it and reloading within a remote window's five minutes shows them again, a local window's 90 seconds leaving no such time; appearing within the activation wait it needs no reload, later one reload is offered; an older component leaves its window usable and reports other windows unavailable to agents (`complete: false`); ARCHITECTURE-4.3 |

## 4 Handoff and review

### 4.1 Implementation order

**Build shared contracts first, then the human journey, then the full compatibility matrix.**

1. Read PRODUCT, EXPERIENCE, RULES and this document; inspect current dirty-tree baseline before edits.
2. Investigate window lifetime (G2) with small isolated traces/fixtures; raise concrete spec feasibility problems to the
   assigned reviewer early.
3. Implement run records/state and execution adapters.
4. Implement human lifecycle and direct terminal journey, then agent discovery/start/message/result journey.
5. Complete location/worktree, panel and commands/settings using the same services, then the client network across
   windows and environments.
6. Run relevant suites and required behavioral scenarios; inspect real isolated UI; report rule-to-code/test coverage
   under 4.3.
7. The assigned reviewer checks evidence/diffs and resolves defects with the implementer; report completion levels
   under 1.1 separately.

Task assignments and current status follow the user's current instructions; they are not product rules. Raise a
concrete rule/scenario/evidence issue when needed; do not repeatedly ask the owner to approve routine engineering
choices. Apply the specification's simple contract rather than preserving requirements that old tests assumed.

### 4.2 MCP reliability review

**An MCP reliability claim rests on reproduced faults, fixed measured journeys and separately recorded native and model
evidence; local passes do not close the platform or real-model gates.**

Each reliability fix comes with a regression test that reproduces its fault through the production start, message or
input service and fails without the fix: concurrent starts and sends with one request ID, a lost route reply, a read
during a paste, result batches and their paste time, and name resolution against an incomplete window list (M15, M16,
M26). M36's fixed journeys run against the code before and after the change, with no duplicate effect or false
completion. Initialization, the tool list and the skill are compared in UTF-8 bytes, each layer apart; a smaller payload
is no claim that a client's model context or token cost shrank, as clients load, omit, transform or repeat these
layers. A successful MCP call does not prove the optional skill loaded: its frontmatter must parse as YAML and a native
skill loader must accept it (M34). Native clients with controlled providers prove transport, tools and context, not
model reasoning. Real-model runs keep every attempt, a failure included, which a later success does not erase (1.2,
M32). Successful delivery is not model execution: the product neither suppresses valid reads nor forces turn endings or
hidden retries. Every probe runs in isolated state under ARCHITECTURE-5.2 and 5.3.

### 4.3 Review output

**The final implementation report states what works, what was tested and what remains, with no hidden partial completion.**

Provide changed areas, rule-to-code/test coverage, required-check results, critical-gate evidence, pending platform/CLI
validation, relevant risks and exact reproduction for unresolved defects. Leave unrelated work intact, and commit only
when the owner asks (ARCHITECTURE-5.4). The spec stays authoritative after agreed amendments; git history records why. A
model saying it is done is a prompt for review, not acceptance evidence.

## Checks

| Rules | How checked |
| --- | --- |
| 1.1–1.3 | Report separates spec/code/runtime and includes actual evidence entries |
| 2.1–2.2 | Each critical gate has a reproducible result and a current status line; no inferred native/remote pass |
| 3.1–3.3 | Each scenario has its own ID and, at acceptance, a recorded result and artifacts with the tested build |
| 4.1–4.3 | Handoff, amendments made in the owning rule, MCP reliability evidence and independent review |
