# Daemon

The daemon manages one Facade home's agents. It serves the shell, the editor, MCP relays and other
machines. The crate is `facade-daemon` in `framework/crates/daemon/`. The command `facade daemon` runs its
public `run()` entry point.

## Owns

- The local agent list, indexed by the running machine's agent number. A client can follow records
  from the local daemon and reachable peers in one subscription.
- `framework/facade.db`, including the record and message counters, run identity, launch options, creation
  source, Guest snapshots, saved SSH arguments and remembered routes. Earlier window and membership
  records stay in the store. The extension owns current workspace membership and Pins.
- The transactions that commit a start with its prompt, record a run's exit with its local creator
  notice, settle a message, and remove an agent with its inbox. A record removal keeps the reason
  needed to distinguish expiry from explicit removal.
- The target and checked reply reference for a send with an internal request ID. The origin
  recovers both after a restart. The recipient looks for the original receipt before it checks
  whether a new message can be sent.

## Keeps

- The parts receive their dependencies on construction and report back through returns, events,
  traits or closures. A part takes its own lock. The agent list lock comes first when it is needed
  with a part's lock.
- An addressed Agent is a stable machine ID and agent ID. The daemon projects a copyable
  `aN@machine` from the same rules it uses to match an address. Bare numbers and names search
  machines that are already connected. A named operation that needs to start or use an Agent can
  follow a saved route and wake the target. Reachable `list` and scoped `stop` wait for parallel
  no-start probes and collect each machine's result. Explicit reachable resume uses the same
  probes. An omitted resume scope selects the local machine. Remote stops in those
  scopes use exact references on live routes. The machine table, local scopes and local removal
  send no SSH.
- The source establishes the caller. The running machine checks the caller's creation-tree root,
  YOLO and the operation's requirements. A stop, input or Attach uses a running managed agent.
  The screen reader can also read the last screen of an ended agent.
- A start on a peer loads that peer's login environment and resolves its CLI and directory there.
  A worktree starts from the selected checkout's HEAD. The start checks its requirements
  before creating the branch or CLI process. An existing Agent resumes from its stored directory, CLI arguments,
  model and effort. During upgrade, a record without launch options takes the selected CLI's
  configured model and effort once and keeps an empty list of CLI arguments.
- When a CLI rule requires a saved conversation, the holder checks the recorded session ID in the
  CLI's native history using the effective launch environment and working folder. The check applies
  to ended managed Resume candidates even without labels, and to exact or named resume before run
  preparation. A saved conversation may have no title.
- A start writes the record and any initial prompt before the run becomes available. It reserves
  the prompt result's number on its creator's machine. That machine accepts a result while the
  creator is present. Shell and editor launches have no Agent to receive such a result.
- The launch transaction and a resumed run's commit save the displayed executable and arguments
  formatted by the running machine. Runs redacts the injected credential before the display
  text goes to the store or actor. Inspection reads this value from the same run as its screen
  facts. For a Terminal caller, inspection also reads the native session name or preview within the roster deadline.
  A recovered keeper run with no committed launch has no displayed command.
- A start or resume takes the private launch context off its caller's environment. Shell supplies
  the terminal colors it sampled. A managed MCP start samples the caller's terminal colors through
  actor inspection. Launch colors reach the agent's screen before it reads the run's first output.
  A forwarded launch's environment carries only the launch context. The daemon keeps terminal
  colors in memory. A new agent without launch colors, including one started by a Guest, uses its
  CLI's default theme. A resume with launch colors replaces all terminal colors. A resume without
  them keeps the agent's terminal colors, including any colors supplied by an editor.
- On Windows a stop releases the actor's copy of the pseudo console's signal pipe, then the
  keeper link's copy, before it asks the keeper to stop. Batch stop uses that same path and reports
  each selected Agent's outcome. Scope stops report connected Guests as skipped.
- The service opens after recovery has listed the readable agents. Thirty consecutive idle seconds
  allow it to exit. A running Agent, a connected Guest, an ordinary client or current work keeps
  it active. Foreground SSH, in-flight calls, live terminal watches and machine table sync count
  as machine work.

## Interface

- [Daemon operations and topics](../../../framework/protocol/DAEMON.md) use JSON-RPC API v1. Each
  connection negotiates its supported version and gets the operation and topic directory for its
  client kind. MCP calls use a typed asynchronous dispatch with the same operation registry and
  the actor proved by the relay connection. The caller's permissions come from the installed run
  record verified for that call.
- On Windows, the daemon keeps two Tokio workers for asynchronous work. The blocking pool has
  up to ten threads and returns idle threads after 150 ms. Its SQLite connection uses a 128 KiB
  page cache target with WAL and FULL synchronization.
- A terminal can request takeover by a newer build. The daemon checks the target daemon's
  supported API separately from the version negotiated with the keeper holding its CLIs.
  A compatible takeover hands each PTY back to the new daemon through `agent.sync`.
  Recovery reads the original SQLite counters and screen records before it accepts business calls.
  A keeper protocol refusal of a local terminal's takeover names the live managed agents holding
  that keeper, with their stable references and labels.
- A machine hello or a foreground `machine.connect` transfers its flushed connection to the network
  session. Authentication, probe, installation when needed and serve use that same SSH session.
  A saved connect verifies any explicit or inferred expected machine ID during the handshake.
  An ordinary v1 Terminal save can update settings for the ID learned on that authenticated
  session. The daemon commits the saved arguments, destination, remote home and machine name
  before publishing the route. The `connected` notification carries the peer's SSH cleanup
  observation when its admitted hello reported one.
- A guarded `machine.remove` uses the supplied full machine ID as the store key under the machine
  mutation lock. It returns the full normalized transport from the deleted row. An absent saved
  route gives not-found for that ID. Requests without a guard use the published machine selector.
- The daemon reads the persisted Facade home and follows the [daemon API compatibility policy](../../../framework/protocol/DAEMON.md#daemon-takeover).
- The person's diagnostics read up to 200 lines of `framework/logs/daemon.log`, with the home written
  as `~`. Only the daemon writes and prunes this log.
- After a passive probe finds the service sleeping, Shell can call `offline_machine_name()`
  to read the committed local machine name through Store. A read-only connection uses a
  retained WAL and SQLite's shared memory. A checkpointed database is opened as immutable.
- Shell's `status` calls `offline_clis(environment, folder)` for the CLIs a start there can run. It
  reads the settings and looks for the programs as `cli.list` does.

## Storage format and migrations

### Current design

During recovery, the daemon holds the home's service lock and opens `$FACADE_HOME/framework/facade.db`.
It owns one mutex-protected SQLite write connection in WAL mode with `synchronous=FULL`. Table
handles share that connection. Shell's offline machine-name reader opens a separate read-only
connection. [Store::open](../../../framework/crates/daemon/src/store/mod.rs#L231-L303) ·
[Offline name reader](../../../framework/crates/daemon/src/store/mod.rs#L211-L228)

| Tables and keys | What they keep |
|---|---|
| `machine` singleton, `numbers` and `message_numbers` counters | The local machine UUID and name, and the next Agent and message numbers. Counters only advance. A machine UUID and local `aN` or `mN` identify the record across homes. A new store seeds the Agent counter above IDs held by the keeper. [Identity SQL](../../../framework/crates/daemon/src/store/mod.rs#L49-L88) · [Initialization](../../../framework/crates/daemon/src/store/mod.rs#L871-L894) |
| `agents`, `guests` and `agent_removals` by `agent_id` | Managed run and launch facts, session and creation-tree scope. A start receipt within its retention hour matches the request ID, starter machine, creator and nullable legacy window scope. Current v1 starts leave that window field absent. Guest rows retain their session, last-heard time and YOLO snapshot. Removal rows distinguish expiry from explicit removal. [Agent SQL](../../../framework/crates/daemon/src/store/mod.rs#L52-L86) · [Start receipt](../../../framework/crates/daemon/src/store/mod.rs#L423-L448) · [Guest SQL and saved YOLO](../../../framework/crates/daemon/src/store/guests.rs#L56-L73) · [Removal SQL](../../../framework/crates/daemon/src/store/mod.rs#L649-L671) |
| `saved_connections`, `known_machines` and `remembered_routes` by `machine_id` | SSH destination, optional remote Facade home and normalized argument vector, last advertised name and contact time, and remembered hop IDs. Old SSH rows without arguments read as a one-element vector containing the destination. Reachability comes from the live network and query results. [Machine SQL and readers](../../../framework/crates/daemon/src/store/machines.rs#L10-L61) |
| `messages` by number, `send_routes` by `(sender, request_id, target)` | Messages keep inbox, delivery, paste and result facts, including the reply marker on an original command-line request. A repeat send matches the sender and its machine, recipient and request ID within an hour. The origin keeps its resolved recipient and checked reply for that window plus the maximum send budget. Withdrawals, eligible removed-inbox receipts and confirmed command-line reply receipts are private. [Message and route SQL](../../../framework/crates/daemon/src/store/messages.rs) · [Cutoffs](../../../framework/crates/daemon/src/lib.rs) |

The persisted launch choices are encoded in `agents.launch_options`. Run authentication has its
own retained format marker, `run_auth_version`, alongside process birth and the credential digest.
New runs record marker 3. Recovery can identify a retained live run with marker 2 using the keeper's
held process. Relay authentication checks the saved process identity and the evidence for that marker.
[Launch and authentication fields](../../../framework/crates/daemon/src/store/mod.rs#L845-L865) ·
[Retained run adoption](../../../framework/crates/daemon/src/store/mod.rs#L517-L533) ·
[Relay authentication](../../../framework/crates/daemon/src/relays.rs#L403-L487)

The extension keeps current members, hidden members and Pins in
`$FACADE_HOME/extension/workspaces/<key>/orchestrator-workspace.json`. SQLite preserves the earlier
window descriptions in `windows` by logical window ID, memberships in `agent_windows` by
`(agent_id, machine_id, window_id)`, and the `legacy_machines` import snapshot. It also retains
the older `integration_files` table keyed by `(cli, file)`. The prior workspace import used
`legacy_machines`. The current code still creates and populates that table during old-format
migration, including fresh initialization, and has no production reader for it.
[Workspace file](../../../extension/src/host/framework/workspace.ts#L34-L87) ·
[Workspace path](../../../extension/src/record/workspace.ts#L80-L97) ·
[Roster v1 reader and invalid format refusal](../../../extension/src/host/framework/workspace.ts#L214-L229) ·
[Window SQL](../../../framework/crates/daemon/src/store/windows.rs#L16-L29) ·
[Membership SQL](../../../framework/crates/daemon/src/store/membership.rs#L6-L16) ·
[Legacy machine snapshot](../../../framework/crates/daemon/src/store/machines.rs#L24-L31) ·
[Integration file SQL](../../../framework/crates/daemon/src/store/integrations.rs#L6-L17)

The [agent screen](#screen) and [state](#state) own their durable files. The
[screen log reader](../../../framework/crates/daemon/src/agent/screen/codec.rs#L167-L193) accepts the plain
header and the header requiring the same generation's checkpoint. Recovery can
[fall back to the preceding generation](../../../framework/crates/daemon/src/agent/screen/tests.rs#L377).
The [Keeper](../../../framework/protocol/KEEPER.md#clis-and-terminal-resources) and daemon hold live native
resources during execution and recovery. They exchange native copies on authenticated links.

An Agent takes its number before launch. Its record and initial prompt commit before publication.
An ordinary message takes its number in its insert transaction. A cross-machine start can reserve
a result number at the origin before sending the start. Prompt settlement can write its owed result
in the same transaction. Agent and Guest deletion pair the record and inbox writes. A managed
Agent's removal commits before its roster change. Saved SSH changes commit before the daemon updates
the live route. [Start transaction](../../../framework/crates/daemon/src/store/mod.rs#L381-L420) ·
[Message insertion](../../../framework/crates/daemon/src/store/messages.rs#L670-L700) and
[result reservation](../../../framework/crates/daemon/src/store/messages.rs#L559-L581) ·
[Message settlement](../../../framework/crates/daemon/src/store/messages.rs#L782-L839) ·
[Managed removal](../../../framework/crates/daemon/src/operations.rs#L980-L1001) ·
[Saved SSH admission](../../../framework/crates/daemon/src/machine_service.rs#L245-L276)

### Opening and upgrading a store

The current database schema is `user_version = 7`. SQLite reserves this number for the application.
The daemon and Keeper negotiate their API versions independently.

Fresh stores initialize in their own transaction. The open path first refuses a nonempty development
schema missing `saved_connections` before normal WAL setup. It disables checkpoint-on-close for that
connection to preserve the existing database and WAL.

Versions below 7 enter one migration transaction. For a version below 3, the daemon first snapshots known
machine names, adds normalized SSH arguments and last-seen timestamps, and creates the remembered-route and
send-route tables and private receipt field. It adds Guest YOLO at version 0. Below 2 it adds the message
withdrawal field and replaces the request index. Then it adds the agent start, launch, authentication and
removal fields. For agents missing launch choices it snapshots configured model and effort where available,
with empty original arguments.

Below 4 it adds nullable `agents.launch_command`. Below 5 it adds `messages.command_line_reply` with
default false. Below 6 it adds `messages.notify_failure` with default false. Below 7 it adds nullable
`agents.creator_stop`, `messages.paste_header` and `messages.paste_draft`. The daemon uses
`creator_stop` to keep an older Keeper's positive acknowledgement for the installed process ID and
birth. A supporting Keeper saves its own acceptance in the run folder. When recovery adopts an
uncommitted resume, it saves the Keeper's process ID and birth together so a later recovery can
match that run's stop receipt. Relay credentials continue to require their own evidence.
Version 6 reads and writes its known columns and can reopen a stopped version 7 home. It uses
version 6 notice behavior.
The migration writes `user_version` in the same transaction. A failed migration rolls back and open fails.
Version 7 or higher proceeds to normal reads. A newer layout may reach the ordinary writers if those reads succeed.
Recovery keeps unreadable agent rows and reserves their IDs. Keep a consistent backup of the whole stopped home
and its workspace state before a format change. Opening a migrated store with older code has no general rollback
guarantee. Use the backup if the change's approved rollback procedure requires it.
[Open guard](../../../framework/crates/daemon/src/store/mod.rs#L231-L272) ·
[Migration SQL](../../../framework/crates/daemon/src/store/mod.rs#L898-L965) ·
[Agent row reads](../../../framework/crates/daemon/src/store/mod.rs#L981-L1003)

Existing fixtures cover [development DB and WAL preservation](../../../framework/crates/daemon/src/store/mod.rs#L1212),
[pre-snapshot launch choices](../../../framework/tests/tests/resume.rs#L762),
[v4 saved routes, sessions and receipts](../../../framework/tests/tests/upgrade.rs#L2535),
[send replay after restart](../../../framework/tests/tests/reliability.rs#L343) and
[repeated starts](../../../framework/tests/tests/reliability.rs#L507). The pre-snapshot and v4
scenarios open their fixture in the Framework directory with the current executable.

Changes to the stored contract follow the [compatibility review](../ENGINEERING.md#compatibility-contracts).

## Depends on

- [Base](base.md) for protocol types and framing, addresses, paths, settings, process identity,
  file permissions, service locks and the instructions given to models.
- [Screen](screen.md) for the terminal grid and [Rules](rules.md) for launches, input, state,
  private tool configuration and the CLI's saved sessions.

## Inside

| File | Responsibility |
|---|---|
| `api.rs` | Projects typed API v1 values around the daemon's existing records and errors. |
| `lib.rs` | Starts and serves this home, schedules the hourly sweep and owns shared saved-connection, numbering and receipt policy. |
| `store/` | Owns SQLite schema, migrations, table handles and transactions. The daemon publishes saved connections after the store commits. |
| `operations.rs` | Starts, stops, resumes, renames and removes runs and records their exits. |
| `resume.rs` | Finds stopped Agents and saved sessions and routes a chosen resume target. A local listing reads this machine and the supplied folder. A saved candidate carries an eight-character selector if it uniquely matches across the folder's saved sessions, including hidden ones, or the full ID. A named Shell listing reads managed Agents on the selected machine. The holder reads native names or previews using the recorded session ID and launch choices. |
| `delivery.rs`, `command_replies.rs` | Deliver typed input, messages, initial prompts and results. A send keeps its typed target and reply reference through routing and replays receipts by request ID. The daemon serving a command-line request owns its in-memory reply waiter. |
| `presence.rs` | Recovers Guests, retires their inboxes, validates an editor's terminal colors and maps those of a launch. |
| `topics.rs`, `remote_agents.rs` | Maintain subscriptions, terminal viewers and each reachable peer's roster contribution. |
| `machine_service.rs`, `network_operations.rs` | Authorize and register machine streams, track routes and resolve requests to stable targets. |
| `relays.rs`, `service.rs` | Establish relay actors and serve both local and forwarded operations. `service.rs` takes the launch context off the caller's environment and uses launch colors from Shell and managed MCP starts. |
| `recovery.rs` | Reconnects to keeper-held runs, restores screens and recovers pending deliveries. |
| `command_line.rs` | Resolves launch environment, settings and program. `cli.list` uses the same resolver as start. |
| `waits.rs` | Reports a managed run's trouble to its live agent creator, including across machines. |

The daemon holds the service lock while it recovers. It reconnects to the keeper, opens and migrates
SQLite, rebuilds the agents and screens, restores Guests and pending deliveries, and serves the socket
once recovery is complete. The hourly sweep removes expired ended records and their inboxes, expires
old messages and receipts, and prunes the daemon log.

A managed agent with an agent creator earns one notice after the serving daemon observes a continuous
30-second wait for permission, an answer or login, or a continuous 30-second error. A replacement daemon
starts a fresh observation interval. A natural exit, a crash or a stop from another caller earns a notice
for the live creator. The exit and the local inbox notice commit together. A failed first prompt that
reports the exit writes the same exit with its reserved result. When recovery first discovers an exit,
it settles any first prompt and uses the same exit transaction. Recovery uses the Keeper's receipt
for that process or an older Keeper's saved acknowledgement to attribute a stop to the creator. An
exit without that evidence earns the usual notice. A Guest receives its notices through `read_messages`.

### agent

One tokio task per agent, the actor, that owns the agent's terminal and screen, and the handle the rest of the daemon reaches it through.

- **Owns:** one actor per agent the daemon started (a guest has a handle with no actor). The actor holds the terminal (a `PtyIo`), the input waiting for it, the screen and its screen log, the state, the typist, the viewers and the start of each run. The agent's record (`AgentInfo`) is shared with its handles under a leaf lock; only the actor changes it while it runs. `framework/screens/<id>/`: one folder per agent, deleted through `Screens`.
- **Keeps:**
  - Input and exits reach only the run they name. Each run has a number, starting at `FIRST_RUN`; `WriteInput`, `ProcessExited` and `StartPrompt` for any other run are refused as ended or dropped. An exit of a run whose terminal is not installed yet waits until it is.
  - Automatic input never interleaves (RULES 1.10). Messages wait behind the start prompt and
    tool startup. Calls wait while the startup watches for a usable input box. Keys also wait
    once the startup owns the input ([readiness](#readiness)). Held keys and calls go on in the
    order they came, after prior startup strokes, ordered sequences and the person's Enter.
    Enter can hold later input until the terminal shows where it went.
  - An ordered input sequence enters the typist once. Earlier accepted input runs first. Later calls and raw Attach input wait until the sequence's last write.
  - The person's keys wait for a message from its paste until a complete reading shows the paste has
    left, and while it is erased. A menu or question of the CLI's own takes the keys immediately.
    Before the submission key reaches the terminal, the hold budget is the time to read the paste,
    the settle time and `SLOWEST_DRAW`. Once the submission key reaches the terminal, a hold still
    in effect lasts up to the CLI's `submit_clear_ms`. A rule without this value uses `SLOWEST_DRAW`.
    Held keys go on as far apart as they came, for at most `ESCAPE_DELAY`. Mouse events, focus
    changes, key releases and standalone modifiers do not wait for a message.
  - A current-run `Blocked` report or a completed interaction frame releases the delivery hold
    on the person's keys and suspends automatic paste, submission, retry and erasure. An active
    report must be withdrawn before a completed ordinary input frame can reopen delivery. The
    frame shows an empty box or the same owned draft. The actor observes reports and frames in
    output order, even when one read contains several of them.
  - A message's paste, probe, submission key and erasing wait for the person's queued keys, the rest of a paste or escape sequence they started, and what the input has yet to show of their keys in order. Text leaves a draft. Enter or another key that can clear it leaves an empty input. A slow CLI that still shows an earlier line has yet to show the next one. What never shows is waited for until neither a key went in nor the input changed for `SLOWEST_DRAW`.
  - A person's Enter can prove delivery from two frames in output order. After the paste is issued,
    a complete frame shows the whole message. A complete frame on the Enter's side of the output
    then writes or erases cells on the input cursor's row and reads empty. Buffered frames can prove
    this sequence after reads resume. An interaction frame discards a pending draft as evidence.
    A new complete draft can start another sequence before the delivery deadline. Missing evidence
    at that deadline leaves delivery unconfirmed.
    Base samples the readable prefix on issue of the paste, Enter and first following edit.
    Terminal splits its reads at those positions. The actor applies all output. Screen carries a
    pending character, sequence or synchronized frame across the Enter boundary. The write receipt
    accounts for the key even when its frames arrived before it. The first following edit ends the
    interval that can confirm the Enter. Frames already in that prefix still count, including an
    empty frame waiting to be read. Issued Enters retain their output boundaries in input order
    as later Enters wait or go on. An incomplete control sequence has a provisional boundary
    until it is classified. A completed terminal report removes that boundary, and any editing
    key that follows it has its own byte position. An unclassified escape sequence in the input box
    defers probes, automatic submission and cleanup. The actor preserves the sequence's original
    input context through later frames, including menus. An active probe keeps arriving keys and
    calls in their original order until it settles. The actor then gives the released keys to
    Person for classification. A confirmed editing key disowns the paste. A completed terminal
    report lifts the provisional restriction. A sequence still incomplete at the input wait
    bound counts as an edit. A subsequent empty input allows new delivery. Messages waiting
    during classification still reach their original deadlines.
    An already visible interaction takes the Escape itself. The actor offers confirmed frames
    to the typist before retiring their Enter. Later keys wait within the paste's hold limit.
    A native wait also interrupts an unfinished proof. A complete frame after withdrawal must show
    the original draft again. A report that began after the most recent edit's write boundary, or a
    complete menu frame whose anchor was printed after that boundary, can establish where that
    edit went. A subsequent Enter can start another proof for the same delivery.
  - Every screen change goes into the screen log before the screen takes it.
  - Input and state readings can reuse screen-view row allocations. The daemon keeps up to four
    reusable views, each with up to 160 KiB of storage. It refreshes a borrowed view before a read
    and drops its cell contents before returning the storage.
  - The actor releases an ended run's terminal engine and closes its screen log after output has
    drained and the last viewer has left. Released screens share a read-only blank screen until
    a caller needs their saved content.
    When the last managed run settles, the daemon releases its unused view storage and SQLite
    pager memory.
  - A question taller than the screen, such as Kiro's trust-all-tools warning, pushes its top into
    the scrollback, where the CLI's redraw after the answer cannot reach. When the person or Facade
    answers a question of the CLI's own before anything was said in a new session, the actor erases
    the scrollback (`CSI 3 J`, logged and shown) if it holds at most a screenful.
  - The record shows a run's end before anything waiting on the run learns it. The installed run
    number changes when its terminal is installed. Input is fenced from the previous run as soon
    as restart preparation begins.
  - Restart preparation reserves the next run and its requested size, waits for screen log room,
    and keeps the ended screen. Once the replacement run is committed and its terminal opens,
    the actor finishes the old viewer frame, logs an empty screen with fresh terminal modes,
    and applies the requested size and any supplied colors before reading the new run's output.
    The native title carries across the reset.
  - Recovery of a running record continues its replayed screen. When recovery adopts a Keeper
    run for an ended record with a different PID, the actor clears the replayed screen before
    reading output and uses the replacement terminal's size when available, or the replayed size.
    The replacement run's state reading starts without evidence from the old grid.
  - An admitted Attach reports its viewer name for the life of its watch. The actor reads the CLI
    title from the terminal and restores the last title from the screen log.
  - Shared Attach uses the minimum column and row counts of live viewers with a valid capacity.
    The actor recomputes on join, resize and detach. It applies PTY size and the logged screen
    size before delivering a full redraw. The grid stays at its last size when the last viewer
    leaves.
  - After validating a viewer resize, the actor applies any supplied editor color sample to the
    named foreground, background and cursor slots. The indexed ANSI palette stays in use.
  - A screen snapshot carries the agent name, process state and any recorded exit from the actor.
    An exact final snapshot waits for the existing exit drain and admits no live viewer.
    A dedicated Shell viewer signals the watched run's terminal exit independently of queued screen changes.
    Inspect includes the authenticated client kind and source machine of shell and editor viewers.
  - A CLI waiting for the person or reporting an error is published at once; other changes of the record within 200 ms go out together.
  - At most `MAX_INPUT_BYTES` (1 MiB) of input waits, counted as the CLI's terminal takes it.
    The first prompt reserves room for its rendered text before the agent is listed. Later
    messages use the remaining room. The actor gives back input that must wait for room and
    refuses input that is too large to fit on its own.
  - Quiet replies once issued input has drained and the last reads have gone through the screen
    log. At clean takeover, a first paste still awaiting issue releases its durable reservation.
    Recovery can offer that message again under its original deadline. `LetGoBeforeStop` releases
    the signal pipe.
- **Never does:** touch the database; know other agents; decide when a run starts or ends; type into a terminal that is not Facade's.
- **Interface:**
  - `spawn(ActorStart, rx, tx, changes) -> anyhow::Result<AgentHandle>`. `ActorStart` carries the
    record, `PtyMaster`, `ScreenStart`, rule name, `DeliveryHandle`, `StateStart` and initial colors.
    `InstallRun` carries `Option<TerminalColors>`. `None` leaves the screen's colors in use and `Some`
    replaces all of them, before the actor reads the run's terminal.
  - `AgentHandle` provides the current `info()`, `title()`, `rule()`, `exit()` and `installed_record()`.
    `lock_run_change()` serializes run transitions. `send(AgentCommand)` addresses the actor.
    `hold_tools_connection(run: u64, stage: ToolsStage) -> Option<ToolsConnection>` counts a verified
    connection for the current installed run until its guard drops. A Guest has methods for
    applying its committed name and updating its online state.
  - `AgentCommand` includes `WriteInput` and `ResizeTerminal`, `AttachViewer`, `ResizeViewer` and `RemoveViewer`,
    `ReadScreen` and `Inspect`, along with run transitions and paste settlement. `Input` is `Raw`
    keys, `Typed` text or keys, a `Message`, or a `BegunPaste` to finish.
  - `Screens`: `new(folder)`, `folder(id)`, `remove(id)`, `delete_without_records(kept)`.
  - For recovery: `recover`, `recover_after_clean_end`, `saved_size`, `screen_writes`, `state_file`, `read_kept`, `instant_of`.

The agent layer is `agent/mod.rs` (the interface above), `agent/actor.rs` (the task's loop) and
`agent/person.rs` (the person's keys). The seven child islands are plain values the actor owns.
They have no task or lock. The actor passes what each child learns to the next. Its loop waits on
commands, the terminal, tools connections and timers. Output goes from the terminal into the screen, then to
viewers, state, readiness and the typist. Readiness hands the keys it wants pressed to a closure
that turns them into typist calls. The typist's output goes into the terminal's input queue.
The actor feeds each state reading to the status glyph and sends any title update through viewers.
Only the actor publishes the record.

#### terminal

The terminal, as a `PtyIo`, and the input waiting for it.

- **Owns:** the `PtyIo` (none between runs or once the run's output ended), the input queue, the last output read, the bytes written so far and when.
- **Keeps:** Input is written in order, at most 64 KiB at a time; a read takes at most 64 KiB. The count of bytes written never resets, across runs too: the typist finds its own bytes by it. Letting go of the terminal, as a read that finds the end of its output does, drops the queued input and the last output. `ready` can be cancelled safely. A write under way is given the same head of the queue until it returns; clearing the queue keeps those bytes. `stop_reading` leaves no read under way.
- An automatic intent can reach the system after earlier accepted input drains. Before the first
  write attempt, the terminal advances through the ready output prefix and returns it to the actor
  for revalidation. The actor owns the unissued intent and its original deadline. `DeliveryIssued`
  registers the system's delivery range. `ToolWriteIssued` gives the actual offset of a startup
  stroke at system handoff, and `ToolWriteExpired` identifies an unissued stroke that reached
  its deadline. `Wrote` confirms
  pending writes. Framed input keeps its ordered suffix. Independent
  erase keys beyond the range accepted by the system return to the typist for admission again.
- **Never does:** parse output, decide what input may wait, or select a submission key.
- **Interface**
  - Lifecycle — `new(Option<PtyMaster>)`, `install(PtyMaster)`, `detach()`,
    `stop_reading()` (async), `let_go_before_stop()`, `is_open()`, `is_closed()`
    and `set_size(cols, rows)`.
  - `ready` and `ready_with_input` return `Read`, `Closed`, `Wrote`, `DeliveryIssued`,
    `ToolWriteIssued`, `ToolWriteExpired`, `ReadFailed` or `WriteFailed`, or request a probe check.
    Read the last output with `read_now() -> Option<usize>` and `output() -> &[u8]`.
    Input methods are `push(&[u8])`, `clear()`, `queued()`, `written()` and `written_at()`.

#### screen

`LoggedScreen`: the agent's screen and its screen log, in memory or left in its files.

- **Owns:** the `Screen`, the open screen log, the checkpoint being written and the count of checkpoints being written. The files in `framework/screens/<id>/`: `<g>.checkpoint` (size, a redraw with scrollback, a SHA-256 checksum), `<g>.log` (output, resize and synchronized-update-end records), and `current`, which names the published generation.
- **Keeps:** Every change is logged before the screen takes it. After 4 MiB of output a checkpoint is taken at a clean point; at the log's 64 MiB cap one is forced, and the log says what a recovery from it loses. A full log reads no output until its checkpoint is written; a failed checkpoint is tried again later. A checkpoint is synced before `current` names it, and the folder is synced before older generations are deleted. Recovery starts from the published checkpoint or a valid older one. Folders and files are private through base (0700 and 0600 on Unix); a folder is synced through base, which needs nothing on Windows.
- **Never does:** touch the terminal; read CLI rules; know viewers; delete the agent's folder.
- **Interface:** `create(folder, id, cols, rows)` (async), `recovered(folder, id, screen, log)`, `released(folder, id)`; changes: `feed(bytes) -> ParsedOutput`, `resize(cols, rows)`, `end_synchronized_update()`, `set_colors(TerminalColors)` (for the screen it holds and every screen it holds later); reads: `screen() -> &Screen`, `is_held()`; checkpoints: `checkpoint_if_due()`, `is_full()`, `checkpoint_running()`, `checkpoint_written()` (async), `finish_checkpoint(written)`; memory: `let_go()`, `hold()`, `hold_with_log()`, `finish()` (async). Recovery uses `recover`, `recover_after_clean_end` and `saved_size`; the daemon's lifecycle waits for `screen_writes()` to reach 0 before it exits or a newer build takes over.
- `set_named_colors(&mut self, colors: TerminalColors)` replaces the three named slots, including
  any absent slot, and retains all indexed ANSI slots. Like `set_colors`, it updates the held Screen
  and the sample used when the same Logged Screen opens a Screen again.
- `set_status_glyph(Option<String>) -> Vec<u8>` forwards to the held screen and returns the title
  bytes for viewers. The screen log and checkpoints keep the CLI's own title.

#### state

`StateTracker`: which of the 8 states the agent is in, from what its CLI reports and shows and from Facade's own facts.

- **Owns:** what the CLI reported and its screen showed, the turn, a question the CLI asks, the tools' connection, how the run ended, what was last said to the agent, and the file `framework/screens/<id>/state`.
- **Keeps:**
  - One state, by a fixed order: `Ended`; the CLI's own `WaitingForYou` or `Error`; a question in place of the input box (`WaitingForYou`); tools unavailable (`Error`); `JustDone`; `Working`; `Starting`; `Idle`; a failed start (`Error`); else `Unknown`.
  - A recognized input interaction supplies its wait kind when known. Other input interactions use `unknown`.
  - Work that stops reads `Working` for 1 more second; a turn someone asked for that ends unwatched reads `JustDone` until a terminal shows the agent.
  - Under `background_report`, a `working` report with matching words becomes idle evidence.
  - Under `background_correction`, a `working` report is narrowed to idle evidence while the screen
    matches the rule's idle anchors. The rule applies regardless of the CLI's installed version.
  - Under `answers_ask`, a reported question becomes done when a complete frame prints the
    ordinary composer's borders, prompt and visible text after the report and input boundary.
    The actor supplies reports and frames in output order. State keeps the completed report as
    done across handover. For an `answers_ask` run with native reports, recovery uses the same
    whole-composer evidence before delivery. The actor puts replayed paint and any open frame on
    the earlier side of the boundary before consuming live output. A question still awaiting
    composer evidence after recovery requests one redraw. Permission reports keep their own wait.
  - A start and the tools' connection get 30 seconds each. Time the CLI spends asking a question does not count.
  - For a CLI that defers its tool catalog, a live authenticated initializer keeps the tools `Connecting`
    without adding a startup overlay or tools timeout. Native startup keeps its own deadline. The initial
    prompt can proceed when native startup is shown and no question is open, or after the existing
    native startup deadline if it fails. The typist still checks whether it can write the prompt safely.
  - Only `keep` writes the state file, through a private temporary file and a rename. What the screen shows is read again, never kept.
- **Never does:** touch the terminal; change the agent's record; publish.
- **Interface:** `new(rule, started, kept, exit, screen)`; evidence: `take_event(event, sync_open)`, `reads_screen()`, `has_report_evidence()`, `observe(&Screen)`, `asks(kind: Option<WaitKind>, now)`, `observe_question_composer(redrawn)`, `native_wait()`; run: `ended(exit, stopped)`, `restarted(started, tools)`, `recovered(now)`; people: `said(Submission)`, `asked()`, `seen()`; tools: `tools_connections(connections: ToolsConnections)`, `tools_not_started()`; reads: `read(now, Viewing) -> StateReading`, `said_line()`, `kept()`, `started()`, `works()`, `start_bound()`, `tools_given()`. The actor runs `keep(file, changes)`. Start and recovery use `Kept::new_run`, `state_file`, `read_kept` and `instant_of`.

#### glyph

`Glyph` selects the status glyph from the run's rule and reported state. Each run starts with no
glyph. `Working` starts with the last working glyph frame shown, or the first frame when work
begins for the first time. Only the glyph timer advances the frame. With report evidence,
`Starting`, `Idle`, `JustDone`, `WaitingForYou` and `Error` share the resting glyph. Other states,
reports taken back, and screen evidence leave the glyph hidden.

The actor arms the glyph timer `frame_ms` ahead while the glyph is working and a viewer is watching
or waiting for a redraw. Output leaves the armed deadline in place. The timer disarms when it fires
or either condition stops holding. The actor sends title changes through `Viewers::show` and the
current glyph also appears in the next viewer redraw. When the actor ends a synchronized update
at its deadline, it sends any title bytes returned by the screen.

The actor uses `new(rule)`, `restart()`, `update(state, has_report)`, `frame_interval()` and
`advance()`. The screen composes the viewer's title.

#### typist

`Typist`: types calls and messages into the input box, one at a time, and settles each message.

- **Owns.** The calls and messages waiting, the paste in the input until the input holds none of it,
  where its bytes are in the terminal, its pauses, and what it submitted. It also owns the probe
  under way and the findings for the rows probed in this run (`probed`).
- The actor allows unstyled hint probes for automatic delivery to a freshly launched input. Up,
  Down and a final Enter sent through Attach or a named key call to a recognized startup menu before
  the input box appears keep the probe available. A complete ordinary box drawn over that menu
  lets the first probe run. Terminal reports, including reports received in pieces, preserve this
  eligibility. Other keys, starting with a session, recovery, resume and an unconfirmed paste
  leave plain writing on the normal draft path.
- **Keeps:**
  - Each call goes in whole and in order; a pause counts from when its bytes reached the terminal.
  - `DeliveryHandle::begin_paste` records the paste before the typist writes the complete message in one paste.
    Automatic delivery takes its paste brackets from the CLI rule, including after a daemon restart.
    A direct text call follows the screen's bracketed paste mode.
  - The actor holds a revocable intent for each automatic paste, Kiro's expansion Tab, submission
    and erase. A native wait or complete interaction frame pauses those writes and releases the
    delivery hold on human keys. A later ordinary composer frame reopens the input after the native
    wait clears.
    Under `answers_ask`, a fresh complete ordinary frame can settle the native question itself.
    The terminal reads the finite prefix of output already available before it tries an automatic
    write. The actor uses those bytes to check the intent again.
    The typist changes the delivery phase only when the system takes the first write.
  - An ordinary message paste carries one trailing ASCII space when the message ends in a non-whitespace
    character. The stored message and initial prompt use their original text.
  - The submission key goes over a complete reading of the draft once it has shown for the CLI's settle
    time. A live paste into a verified empty input owns what appears while the typist is its only writer.
    Console input needs the visible draft painted after the first paste write, with a logical
    ending or a paste marker. The typist takes that evidence from Rules, including the written
    tail when a changed last glyph needs a following space or line break. Recovery matches
    the text or paste placeholder. An external edit ends automatic submission and cleanup authority.
    A person's Enter can still prove that they submitted the whole message. Unread frames keep
    settle time running. A readable change restarts the wait.
    Codex queues an ordinary message with Tab while Working. The start prompt and recovered pastes use Enter.
  - For Kiro's collapsed paste, the typist can press Tab once after writing its fresh bracketed
    paste, with the same person-input generation and the native disclosure visible. The CLI must
    draw after each write and earlier person input must be settled. The typist applies the normal
    whitespace comparison to the full revealed draft before Enter. An unconfirmed reveal leaves
    the draft to the person. Recovered collapsed pastes retain the existing refusal.
  - What the typist put into the input box is its own from the paste through submission or cleanup.
    No other paste or probe begins meanwhile. After the submission key goes in, the typist keeps
    that ownership until a complete frame reads as an empty input. A menu, question, unread frame
    or cropped draft keeps the paste under the typist's care.
    Cleanup keeps the last paste number it observed through a menu or an ambiguous row.
  - Automatic Enter, Tab and erase keys use the terminal's output boundary at write issue. A complete
    empty frame after the submission boundary and before any external editing key can confirm
    delivery. Before settling, the actor drains the finite PTY prefix sampled when the empty frame
    is considered. A disconnected peer is read through EOF, with write boundaries retained until
    the receipt has been settled. A read error stops input and the pending receipt fails. The actor
    waits through an unfinished update. A redraw of this draft or its same-numbered paste marker
    invalidates the pending empty frame. When a CLI shows its working footer, Rules can recognize
    its empty editor for an already issued submission. That editor stays unavailable for automatic
    input. A person's Enter applies the same finite-prefix check to the whole-message evidence
    described under the actor. Evidence established before an edit remains available.
  - Repeating the submission key requires the current draft to have been drawn after that key's
    write boundary and still belong to the typist. The CLI rule can allow up to three submission keys
    at its retry interval. A fully readable changed draft with an established erase range can be
    erased once and pasted again after a complete frame drawn empty after the erase write boundary.
    Both actions use the original deadline and hold limit.
  - A native Question report that begins after the paste or submission key reached the terminal,
    or a complete question or menu frame after that write, records `interaction_after_write`
    when it precedes proof of delivery. The receipt says the paste or key may have answered the
    CLI's question and tells the sender to check the terminal.
  - After its deadline the typist can erase only a draft whose ownership and erase range it can
    establish. It follows the erase until a complete reading shows that the paste left the input.
    Short writes leave their unsent keys under the same gate. A key that may edit the draft
    suspends the tail until a report or fully redrawn menu accounts for it. After withdrawal, a
    fresh composer frame must show the owned remainder before the tail can pass the gate.
    Before passing a possible edit, the actor revokes persisted recovery evidence. When the
    CLI is waiting, the live cleanup stays available for revalidation by later output.
    A deadline in an unread frame can wait for a complete frame within the existing grace.
    A receipt is given
    once, by two `RESPONSE_GRACE` after the deadline, and says what is known then; erasing later changes none.
  - The start prompt is pasted alone; a paste an earlier daemon began is never typed again.
  - With console typing, characters above U+FFFF go as key-down records, a text's line breaks as presses of the rule's line break key, a key-down and a key-up record each, where it names one, and the wait before a call's Enter adds `per_char` for each UTF-16 code unit.
  - An input whose row may be a hint or a draft (it reads unsure) is probed once a run by its child
    `probe`. The probe types a Space where the input starts. Space and Backspace pass the same
    output check at system handoff. The actor reads the available prefix, compares the current
    complete ordinary box with the probe's input, and checks for native waits. A complete ordinary
    input drawn after withdrawal of a native wait can authorize a probe while delivery still needs
    a proved empty box. A frame already open at withdrawal cannot supply that probe's evidence.
    A confirmed hint provides the empty reading.
  - From the write receipt for Space or Backspace, the probe checks the row every 100 ms and waits
    up to two seconds for that key's redraw. Two matching complete readings can establish whether
    the original row was a hint or a draft. The probe settles when the input is restored or the
    key's echo budget expires, releasing the person's queued input. Backspace requires evidence of
    the space while the probe is active.
  - An open synchronized update cannot authorize a write. A resize clears pending approval so an
    unissued key uses the new box. An unissued Space that loses its box is withdrawn, and the row
    can still be probed when the ordinary box returns. Backspace needs a complete frame drawn after
    Space that shows its original position and the space, with no question, menu or intervening
    external edit. The probe checks that Backspace restored the input before offering delivery.
    An unread draw or menu supplies no authority to erase. New output sends an unissued erase
    back to the actor for a fresh reading of the available prefix. The row's verdict stays with
    this run.
- **Never does:** write the terminal (it hands its bytes to the actor); read the screen except through the reading the actor gives it; take the person's keys; touch the database.
- **Interface.** The daemon builds `Typing::text(text, enter, sender)`, `Typing::keys(names)` and
  `MessageTyping::{new, start_prompt}(text, number, deadline, submission)`. The actor uses
  `new(agent, rule, console_typing, DeliveryHandle)`, `push`, `deliver`, `deliver_first`, `finish_paste`,
  `fail_prompt(prompt, reason)`, `fail_all(written, why)`, `hold_pastes()`, and
  `step(now, written, queued, modes, writes, observe) -> Step { write, wake, delivery, tool_start_deadline }`.
  The startup deadline accompanies the stroke that the actor will offer to the terminal.
  `tool_write_issued(offset)` establishes the stroke's receipt position at handoff. A terminal
  query reply can use the queue while the stroke awaits handoff. `note_tool_write(written, written_at)`
  uses Terminal's byte progress to return the write time once for that stroke. The actor gives
  Readiness this time before the typist advances to another receipt. `withdraw_tool_writes` drops
  startup calls still waiting in the typist and the receipt for a revoked actor intent.
  The `writes` argument (`BoxWrites`) tells the typist whether it may write into the input box on
  its own. The `observe`
  callback gives the current reading, the current native wait and complete-frame requirements
  in `InputObservation`. It also gives the draft proved submitted by the person's Enter in
  output order. Evidence can come from earlier frames in the same read. A pending observation
  after an interaction can retain the original delivery deadline. The actor calls
  `input_edited()` where the person's keys may change the input. For probes, `recall(reading)`
  uses a prior probe's result, `want_probe()`
  requests a probe and `clear_probes()` starts a run with fresh probe evidence. The actor reads
  `take_submitted()`, `take_entered()`, `held_bytes()`, `console()`, `paste_rule()`, `busy()`,
  `pasting()`, `occupies_input()`, `paste_hold_until()`, `types_calls()`, `reads_input()` and
  `probing()`. Through `DeliveryHandle` it asks `still_to_type(number)`, records
  `begin_paste(numbers)` and settles a delivery with `settle(numbers, outcome)`.

#### viewers

`Viewers`: sends the agent's screen changes to the clients watching it.

- **Owns:** the viewers and those waiting for their first snapshot, each shared viewer's capacity,
  the bytes queued for each, the redraws and exits they are owed, and the signal that drops a viewer too far behind.
- **Keeps:** At most 1 MiB of output waits for a viewer; past that it is marked behind and later gets one redraw instead. Snapshots and redraws wait for a synchronized update to end. A viewer behind gets its redraw before the exit. When the new terminal is installed on resume, a viewer still over 1 MiB is dropped and its client told to reconnect. `Removed` comes last.
- **Never does:** change the screen; read the terminal; decide when the exit goes out.
- **Interface:** the actor: `new()`, `request(ViewerRequest)`, `admit(&Screen, exit, process)`, `remove(viewer)`, `show(&ParsedOutput)`, `redraw_all()`, `catch_up(&Screen, exit) -> bool`, `send_exit(&Screen, exit)`, `finish_run(&Screen, exit)`, `finish(&Screen, exit)`, `is_watched()`, `is_behind()`. The server's screen watches: `viewer_channel()`, `ViewerReceiver::{recv, stalled}`, `ViewerSnapshot`, `ViewerChange`.

#### readiness

`Readiness`: decides which keys ready the CLI's tools. The daemon permits an automatic trust answer on an
authenticated Agent start when the target home has YOLO on. On a person's start or resume, the CLI's trust
question stays available for the person.

The tool startup has two parts, the same for every rule with `ReadyTools`.

- **Before it owns the input** it watches for the composer. Person classifies complete keys,
  focus and mouse reports, key releases and standalone modifiers, and holds incomplete sequences
  for classification. Up or Down from a terminal app's mouse wheel arrives as a key. The actor
  yields passive startup to the first complete key when no recognized question owns the input.
  Calls and messages wait while startup watches the composer. A recognized question takes keys
  and calls, and startup can go on after it. The actor releases held input in its accepted order.
  The tools count as not started after the person takes over, and become available once the
  relay connects. The next run tries startup again.
- **Once it owns the input** the actor holds keys and calls through the startup strokes. The
  startup pastes its command into the complete, empty input of a CLI at rest. When the startup
  finishes or yields, the actor releases held input in its accepted order.

- **Owns:** the rule's `ReadyTools` and `TrustQuestion`, how far each has got, and when each wait ends.
- **Keeps:** The startup deadline for a usable box also bounds the command echo and panel phases. The command must show alone in a complete input frame before Enter. The open panel must show the tools ready in a complete frame before Escape. The actor validates the current complete composer for the command and Enter, and the open ready panel for Escape. It reads the available terminal output before attempting each stroke. A question releases the person and withdraws unissued startup strokes. The same deadline fences each handoff. At the deadline the typist and actor withdraw unissued startup strokes, and the start reports any possible remaining command and that the first turn may lack the tools. An issued close key's interval starts at the write time recorded by Terminal. The actor waits for confirmation and releases the person's input as soon as that interval has elapsed. Each key of the trust answer waits for the screen to be still for 1 second. The trusting answer goes once per run while it is selected.
- **Never does:** type (it hands each `Press` to the actor, which gives it to the typist); read the terminal; hold input; change the state.
- **Interface:** `new(rule, id)`, `begin(started, tools, allow_auto_trust) -> Option<Instant>`, `end()`,
  `step(now, &StartView, press) -> StartStep`, `tool_write_matches(screen, input, draft, composer_allowed)`,
  `tool_write_issued()`, `tool_write_arrived(written_at)`, `holds_input(InputState)`,
  `waiting_for_input()`, `yield_to_input(InputState)`, `readies_tools()` and `is_under_way()`.
  The actor gives the composer to the person's complete key using Person's classification.

### messages

Post assigns a message number in the SQLite transaction that keeps it. The receiving machine owns
delivery state. A managed terminal confirms delivery when the CLI takes the message out of the
input after submission. A Guest confirms delivery by taking the message from its inbox.
Both use the same deadline.

A managed terminal sees `📨 Message mN from <sender>` above the body. Replies append
` · in reply to mN`, with a machine selector when the original message is remote. A command-line
sender has a `#c` address only while waiting for a reply. A notice begins with `🔔` followed by its
text. Its record number is available in the inbox.

At paste start, the daemon records the header version alongside the paste number. Version 1 puts the
message number before the sender and omits the number on notices. Recovery uses the stored format
to compare the rendered draft with the paste. Older or revoked observations provide no authority
to press a key. A Claude draft from an older run can show a typed header prefix before its
paste placeholder. The recovery reader recognizes the prefix and matching placeholder as one
draft for comparison with the saved proof.

Recovery requires a matching digest of the full draft the original typist saw after writing it.
The digest includes the logical text in Unicode NFC, the placeholder number where shown, and
the caret's byte offset in that text. Reads also recognize existing v7 raw-byte proofs. Moving or
rewrapping the box preserves the proof. Final horizontal padding maps to a single caret position
at the end of the text. The typist counts cleanup keys from the original paste using the editor's
deletion unit from Rules. A matching draft may be submitted within its original deadline or
cleared afterward if the cleanup count is known. The actor revokes the observation before
allowing other input to write.

The local `paste_draft` blob keeps its 32-byte digest and appends five bytes when cleanup begins,
including when the confirmed Backspace count is zero. Before a PTY write that could contain
cleanup keys, the actor commits a marker for the outstanding write. A checked offer releases its
marker if the final check defers the write or the offer is canceled before system issue. The
terminal's returned byte count advances the confirmed count. After a confirmed partial write,
the remaining Backspaces require a complete repaint of the current draft after the write
boundary. The typist checks the saved digest and the exact literal prefix and caret left by the
confirmed keys.
Canonical spellings of a combining character match at the same logical caret. Without a
recorded deletion unit, the typist issues at most one Backspace per grapheme before reading
again. Each additional batch needs the confirmed write progress and a complete repaint
showing the exact remaining prefix at its end. Reading the cleared box ends cleanup.
A recovered plan with zero confirmed writes also needs a current complete input frame. The actor
drains available terminal output within its existing bounds before checking the box. An outstanding
write or an unreadable box leaves the cleanup intent waiting for more evidence.
At takeover, a live drain that shows a freshly painted empty input can also finish cleanup.
When a saved cleanup needs a redraw, the actor temporarily changes the row count. This lets a
bottom-aligned input move so a terminal that emits only changed cells can send the current box.
First the actor reads the output already available. A read stopped by its bound or by a full
log leaves the resize and paint tracking to a later step, so a frame drawn earlier cannot
authorize cleanup. The actor then saves the size it requests for that paste, sends the resize,
and tracks fresh paint. Another daemon recovering the same paste chooses a different size.
The changed size stays in effect until the first cleanup write goes out, recovery of the draft
ends, or the requested terminal size changes. An edit that revokes cleanup restores the requested
size before the actor releases the person's keys. A complete painted frame and the saved draft
proof authorize cleanup in either case.

The delivery receipt settles on its original deadline and graces. An unresolved cleanup stays
in the v7 field across receipt settlement, inbox history expiry, and daemon takeover. A complete
reading that shows the paste has left the input, an edit from another writer, or the end of the
run retires its cleanup. Recovery resumes the cleanup of a settled message without reopening its
receipt or repasting the message.

An explicit inbox-only send returns after storage commits, and delivery continues on its background deadline.
For a send from an authenticated agent, the original admission stores `notify_failure` with the sender and
delivery deadline. Pending rows carry that ownership through daemon recovery. Schema version 6 gives existing
rows a false value. Receipt replay uses the original decision. Delivery and result waits share the caller's
remaining budget. A v1 send with no wait field uses a delivery wait.

For a forwarded Shell delivery or result wait, the origin gives the holder a shorter delivery budget
in the send arguments. Settlement and the receipt use the remaining peer exchange time.

A command-line result wait belongs to the source daemon and closes with its request. The holder stores the
reply marker with the original message. Only its verified recipient can answer the associated `#c`
address. The holder assigns a reply number and the source accepts only the first reply that matches the live
request. If the source is a peer, confirmation goes back along an authenticated route before the sender gets
the private reply receipt. The persisted original remains identifiable after the waiter ends.

- Post serializes the first terminal paste, inbox settlement and withdrawal under its delivery
  lock. A read takes pending messages whose paste has yet to begin and Facade notices proved
  unsubmitted. That proof can be a known unissued submission key or a confirmed erase of the
  original draft. The daemon records a completed erase and makes the notice readable in the same
  transaction, including when the automatic delivery receipt already settled. An explicit history
  page can also include delivered messages and unconfirmed notices. The selector and optional
  reply filter run before applying the limit. The client projects complete messages and returns the prefix Post
  must settle. Post commits that prefix and the results it owes together.
- A send without a reply reference can overlap a Guest waiting for a specific reply. When the
  deadline withdraws that send, its receipt can carry the reference. The sending machine checks
  that the original message is in the sender's inbox and came from that Guest.
- A start's prompt reserves a result number and settles by the same delivery rules. Start results
  and wait notices follow a creator's stable reference. A reply identifies the original message
  by its machine and number and must name the original sender.
- A retry uses the stable caller, the originally resolved recipient and the internal request ID.
  The recipient retains the original receipt, including withdrawals and settlements from removed
  inboxes, for one hour. The origin retains the stable target for that hour plus the delivery
  budget, so the earlier binding covers a receipt dated at the destination.
  A local MCP send commits its route and message number in the same transaction. Cross-machine
  sends keep their route before forwarding.
  A private receipt is available to retry lookup. Inbox and history queries only see visible mail.
- `MessageTable` gives Post the stored records and the settlement transaction. The actor submits
  paste and delivery facts through `DeliveryHandle`, and relays read through `Messages::read_inbox`.

### runs

Every run Facade starts, from its start or resume until its exit is saved: the keeper behind the
runs, each run's terminal and exit, its files and plugin, and the session its CLI reports.
`framework/crates/daemon/src/runs/`.

- **Owns:** the connection to the keeper; the registry of runs whose terminal the daemon holds;
  starts not yet registered; each run's exit-saving task; run folders in `framework/runs/`; Facade's
  plugin in project folders; session following.
- **Keeps:** a run keeps only its first exit, and an exit carries its run number, so an old run's
  exit never reaches a new one. A run is registered before `start` returns, before the daemon
  commits it. No lock is held while a handle, an `ExitSink` or the event sender is called.
- **Never does:** touch the database; know an agent's actor; interpret a CLI (asks `facade_rules`);
  end the keeper.
- **Interface** (the daemon layer, `lib.rs`, `operations.rs`, `recovery.rs`):
  - Created once: `Runs::new(framework, Arc<Held>, UnboundedSender<RunEvent>)`.
  - Events up: `RunEvent::Exited { id, exit }`; `RunEvent::Session { id, run, session, committed }`,
    where the daemon commits the session first and replies on `committed: oneshot::Sender<bool>`.
  - Exits to the actor: `ExitSink = Arc<dyn Fn(RunExit) + Send + Sync>`, given per run;
    `RunExit { run, exit, stopped }`.
  - Startup: `find_keeper_at_startup(startup) -> FoundKeeper` (`Absent` or `Connected { build, held }`),
    then `serve_keeper()`.
  - Start and resume, in this order: `reserve_start() -> StartReservation`,
    `reservation.wait_for_keeper()` and `prepare_managed(RunRequest, address, context)`.
    `RunRequest` carries the launch options and any CLI session. The address and context supply the
    managed instructions for both start and resume. A resume uses
    `previous_run_ended(id, timeout)` and `replace_folders(id, &prepared)`, then
    `start(reservation, id, number, &prepared, cols, rows, ExitSink)`. `StartedRun` returns the
    process identity, terminal and optional relay verifier for the daemon to commit.
    Once listed or resumed, `installed_run(id, number)` returns any early exit. The caller then invokes
    `prepared.let_go_of_plugin()`.
  - Stop and end: `stop(id) -> Result<bool, ErrorBody>` (true: it was running and the keeper was
    asked); `record_exit(id, exit) -> ExitRecorded { known, committed }`, called with the agent list
    locked; `keep_exit_task(id, task, listed)`; `release(id)`; `abandon(id)`; `remove(id)`;
    `remove_folders(id)`.
  - Sessions: `follow_session(id, run, committed, output, FirstRead::{Now, AfterOutput})`,
    `end_session_following(id)`, `read_session(id)`, `has_unsaved_session(id)`, `captures(id)`.
  - Recovery: `take_back(&HeldAgent) -> PtyMaster`, `register_recovered(..)`,
    `take_keeper_only(HeldAgent, KeeperOnly::{Unreadable, NoRecord})`,
    `delete_folders_without_records(&kept)`, `let_go_of_unused_plugins(agents)`.
  - Other: `environment_of(id)` (the running CLI's environment, blocking), `busy()` (why the
    daemon may not exit), `keeper_info()`, `keeper_api_version()`.

`runs/mod.rs` joins its two child islands and calls them one after the other, never holding a lock
of one while calling the other. `start` has keeper_link register the run, then tells preparation
the run uses the plugin of its folder. `record_exit` records the exit in keeper_link, then tells
preparation the run ended, so its session is read once more. A run let go of by `release`,
`remove` or its exit as a cleanup run is let go of as a plugin user too. `previous_run_ended` waits,
under one deadline, for the exit-saving task, the last session read, and keeper_link letting go of
the run. The daemon holds the agent list lock while `keep_exit_task` checks the list and keeps
the exit-saving task. Removal first takes the agent off the list, then `remove` releases any
task already kept for it. The task can still finish saving the exit.

#### keeper_link

The keeper connection, the run registry, and starts not yet registered.
`runs/keeper_link/` (`mod.rs`, `client.rs`, `registry.rs`).

- **Owns:** the keeper connection and its state (absent, connecting, ready); the client socket
  (base's `ClientSocket`) with its requests, pings and the terminals its lines carry (`LineSender`,
  `LineReceiver`); the registry: per run its process identity, a copy of
  its terminal (`PtyMaster`), its first exit, its role (agent, unreadable record, cleanup), whether Facade is
  stopping it, its run number and `ExitSink`, and whether the daemon has committed it; the pending
  starts, which hold an exit that comes before registration.
- **Keeps:** a keeper becomes ready only after `agent.sync` has given it every terminal the daemon
  holds, runs only the keeper holds are stopped or held, and pending stops are sent again. Only a
  ready keeper gets `agent.start` and `agent.stop`. A closed connection is fenced before the daemon
  reconnects, at once while runs need a keeper; a failed restart backs off from 0.5 to 30 seconds.
  A start or stop waits up to 10 seconds for a ready keeper, and each request up to 10 seconds for
  its response. The keeper is pinged every second. Lock order: the registry, then pending starts;
  the connection lock is a leaf. Runs proves the keeper's process and birth against its lock before
  offering its supported API versions. For the first connection, reaching the Keeper socket,
  proving it and completing hello on that connection share the daemon's startup deadline.
  The first session is admitted, and starts pinging, after the daemon rechecks the deadline and the
  Keeper's lock identity. Running calls use their ordinary response timers.
  It rejects the whole frame if a required terminal is absent or
  a terminal arrives on a reply or notification that cannot carry one. The registry's copy
  of a run's terminal lets go before any `agent.stop` for that run (a stop, an abandoned start, a stop
  sent again); `agent.sync` passes each copy as it is.
- **Never does:** end a keeper; touch folders, plugins or sessions.
- **Interface** (runs only): `KeeperLink::new(framework, events)`, `find_at_startup`, `serve`,
  `reserve_start`, `send_start(.., RunKind)`, `stop`, `record_exit -> RecordedExit::{Unknown,
  Repeated, Kept(ExitRecorded), Dropped}`, `installed`, `release`, `abandon`, `remove`,
  `ended_run_released(id, deadline)`, `running_process`, the recovery calls (`take_back ->
  PtyMaster`, `register_recovered(&HeldAgent, &PtyMaster, ..)`), `busy`,
  `keeper_info`, `keeper_api_version`. `busy` says, in this order: runs are being handed to the
  keeper; an unreadable record's exit cannot be saved; an agent is running; an exit is being saved
  or its output drained; the keeper is being started or a start is waiting.

#### preparation

A run's command line, environment, folder, plugin, workspace configuration and session following.
`runs/preparation/` (`mod.rs`, `environment.rs`, `folder.rs`, `plugin.rs`, `projection.rs`, `session.rs`).

- **Owns:** composing a run's command line from its rule (`facade_rules::start_managed_launch_command`,
  `resume_managed_launch_command`) with a fresh credential for the private relay and the managed
  instructions. It starts the program directly where the program found on the run's `PATH` is a
  wrapper (`facade_rules::direct_command`). It builds the run's environment from the client's by the
  rule of `env` in
  [`StartArgs`](../../../framework/protocol/DAEMON.md#startargs) and `FACADE_HOME`. It owns private
  run folders `framework/runs/<agent>/<random>/`, with the session file, the tool files, aliases to retained
  configuration entries, and a `plugin-folder` note naming the project whose plugin a start placed;
  Facade's plugin in a project's `.agents/plugins/facade/`, the starts holding it and the runs
  using it; one session follower per running run.
- **Keeps:** an agent has at most one run folder, and a folder name is never used again; a resume
  removes the earlier folders before it creates its own. A plugin is written only where it is
  missing, this version's, or an earlier version's or changed one no run uses; a plugin that is not
  Facade Code Framework's, or a later version's, is never changed. Once the last start holding it and the last
  run using it have ended, preparation removes a plugin that matches the current template or has an
  earlier version. A plugin with the current version and different contents is logged and left in place.
  A new run can register its own relay credential while a same-version Antigravity plugin is still
  in use if the plugin has the old skill file and every current template file is a regular file with
  matching bytes.
  The files stay in place during the hold. Once the folder is free, the next start replaces the plugin.
  Only CLIs for which `facade_rules::uses_folder_plugin` holds use it. A run-owned workspace file has
  a private ownership record with its canonical workspace, relative path and content digest. Preparation
  publishes a complete file without replacing existing content. It removes the owned file, and the folders
  that leaves empty, on exit, failed launch, replacement and orphan cleanup. Edits or substitutions leave the
  file alone.
  The session file is checked by its modified time and size a second after the run's terminal gives
  output, as a CLI saves its
  session while it works: at most once a second while output goes on, once more a quiet second
  after it, and nothing while the run is idle. It is read when they change, when it names a session
  its CLI has not saved yet, and once more after the run ends; a session that failed to commit is
  sent again a second later.
- **Never does:** touch the registry or the keeper; commit a session itself.
- **Interface** (runs only): `Preparation::new(folders, Arc<Held>, events)`,
  `prepare(RunRequest, managed_instructions: String) -> Result<PreparedRun, ErrorBody>`,
  `replace_folders`, `plugin_used`, `plugin_released`, `remove_folders`,
  `delete_folders_without_records`, `let_go_of_unused_plugins`, `follow_session`, `run_ended`,
  `session_followed(id, deadline)`, `end_session_following`, `read_session`, `has_unsaved_session`, `captures`; the types
  `RunFiles`, `PluginHold`, `FirstRead`. The test gate `before-plugin-let-go` is passed only when a
  run that used the plugin lets go of it.

### records

Records owns agent numbers, default names and target lookup within the caller's reach.

- The SQLite number is committed before a start can use it. Removing a record never lowers the
  counter. The running machine chooses a default from its configured pool using the same roster
  as `list`, plus its own pending reservations. It can reuse a name when the pool is full. A
  person's explicit name may repeat.
- `lookup` consumes Base's parsed number or name and applies the operation's capability and the
  caller's reach. A name selects a live match in preference to an ended one among eligible records.
  Identical eligible names and numbers across machines can be ambiguous. Diagnostic labels
  describe only reachable records. `human`, `@Pixel` and a bare digit are names. A stable
  reference retains its machine ID and still passes the same operation checks.
- An unqualified number or name and the literal reading of a name containing `@` use the same
  reachable machines as `list_agents`. The lookup probes saved routes without waking them and
  includes ended records. A numbered address with a machine goes directly to that machine.
- `list_row` projects the shared `AgentListEntry`. Its public row contains the canonical address,
  name, kind, state, CLI, title, folder and latest start time. Shell, MCP and the editor use that row.

### windows and locations

The location reader checks the requested directory on the selected machine and returns its repository,
checkouts or ordinary folder. A query without explicit folders can show the login home and recent
Agent directories. The editor can get a hand-entered remote directory's Git kind from `location.list`.
The same start preflight checks the folder and optional worktree branch for every entry point.
Worktree creation serializes writers to the repository's `.worktrees` directory. It uses the current
checkout's HEAD and preserves the branch's path segments.

Workspace membership and Pins persist across restarts.

### network

The network owns machine handshakes, routes, forwarded calls and saved SSH transport. It advertises
the local machine and observes the table from each authenticated session. At startup it restores
saved connections and remembered routes. An operation dials on demand and concurrent requests for
the same saved connection share its attempt slot. A passive probe uses `--no-start` at each hop.
An explicit waking operation can start a remote service along a saved route.

A saved connection without a live session or an observed failure is `Disconnected`. Exit 3 from a
no-start probe or an authenticated idle-exit notice records `Sleeping` in memory. SSH login and
transport failures have distinct states. Queries report their own outcomes, including the hop that
failed. An idle session can close while its saved connection remains available for a later call.

Explicit temporary SSH connect keeps work on both daemons. Calls and live terminal watches hold each
participating session, including the forwarding hops. Machine table sync over an open session
counts as work on each end. The sender holds the session while queuing the sync, and the receiver
holds it while processing the table. At each end, the session and daemon restart their own
30-second idle timers when their last work ends. SSH keepalives, roster sync and local `daemon.ping`
let the timers keep running.

### guests

The relay boundary uses its socket peer PID and process birth. A relay joins as a Guest on its first
tool call when it cannot establish a current managed run. The daemon commits its ID and this machine's
YOLO snapshot before publishing it. It keeps the relay's environment for a Guest's starts and uses the
running machine's login home when that Guest supplies no folder.

A surviving relay keeps its Guest ID and inbox across takeover. A sufficiently old record that lacks
the YOLO snapshot takes the machine's migration-time setting once. A Guest's exit closes its online
record and retires its inbox. Its sends use the same creation-tree and delivery rules as managed Agents.

### lifecycle

`lifecycle/` owns work counts and guards, idle exit, a newer build's takeover, the decision that
terminal output has drained cleanly, and `framework/logs/daemon.log`. The keeper points the
daemon's standard error at the log. `log_file.rs` prunes lines after 30 days and returns up to 200
lines to the person's clients. Base owns the shared `framework/clean-end` note.
[Base ownership](base.md#owns)

- `begin(Work)` counts the work until its guard drops. The idle decision uses the same lock to
  exclude new work. After 30 idle seconds it asks the server to pause acceptance, informs compatible
  machines of the idle exit, and waits for screen writers and exit commits before removing the socket.
  A long-lived machine watch or foreground connection counts while active. Takeover settlement
  waits for the existing calls and run changes it can complete.
- `take_over(UpgradeArgs, activity)` checks and stages the build. It freezes MCP effects and waits
  for the relay connections to confirm `closing` and settle earlier cancellations. Each `closing`
  follows committed read and input responses in the same outbox. The daemon allows three seconds
  for this preparation. If it expires, the original launcher stays selected and the daemon resumes
  admitting effects. Once a connection queues `closing`, it stays sealed until it reconnects.
  After confirmation, takeover selects the launcher, settles pastes and work, asks the actors to go
  quiet, records the clean end through Base's `programs::mark_clean_takeover` when all actors
  quiesce, and sends `closing` to ordinary API clients. The keeper holds the terminals throughout.
- The parent implements `LifecycleActivity` to report activity, screen writes and keeper details,
  and to send paste and quiet commands to actors. The new daemon consumes the clean-end note
  through Base's `programs::take_clean_end` after taking `daemon.lock` and before connecting to the
  keeper. The result selects how it recovers screens.
- The Windows MSVC executable requests the segment heap in its embedded manifest so the heap can
  return idle pages after message bursts and groups of terminal exits.

### server

The daemon protocol on its socket: it reads requests, hands them to the daemon through the `Service`
trait and writes responses and watch changes back, without knowing what any operation means.

- **Owns:** the listening socket (base's `DaemonListener`); each connection with its outbox, its call slots, the calls a
  `cancel` can name, its lanes and its watches; the watch and viewer numbers.
- **Keeps:**
  - Every request with an ID gets exactly one response; a relay's MCP request too.
  - A connection that has not said `hello` within 10 seconds is closed; before `hello` it gets
    nothing but responses.
  - At most 8 MiB of responses and changes wait per connection; senders wait for room.
  - At most 16 calls run at once per connection.
  - `agent.type` and `attach.resize` for one agent from one connection run in the order sent.
    Typing waiting in a lane is at most 1 MiB of requests. A resize takes no
    room. Without room, a call with a request ID is refused with `capacity_exceeded`; a
    notification waits, and so does the connection's reading, until there is room or the client
    closes.
  - Once the client closes while its input waits, nothing more from it runs.
  - A watch's response, with its snapshot, is sent before any of its changes.
  - `attach.shell` is the first operation after a Terminal hello on a fresh connection. Its watch owns the
    connection. It accepts the exact target's raw input, the watch's resize and unwatch, and connection controls.
    The run's independent exit signal starts a one-second grace for final screen changes and `Exit`. At its
    deadline the server cuts both halves, stops a blocked writer and releases the watch and connection work.
    The origin observes a forwarded `Exit` on the ordinary peer `attach` before it enters the incoming queue.
  - An `attach.resize` uses the watch ID from the requesting connection and runs in received order.
    The source binds a remote viewer to the authenticated caller, viewer number and holder daemon
    start ID. Each shared resize checks that binding at the holder. Unwatch, disconnect and
    terminal end release that viewer.
  - A machine hello or connect hands the same buffered reader and writer to the machine session
    after its response is flushed. The old connection releases its watches before the handoff.
  - During takeover, ordinary API clients get `closing` and have up to 0.2 seconds to answer. An
    MCP relay shares one outbox for its responses and `closing`. Reads reserve room for the full
    response before recording delivery. Text and keys reserve room before typing and retain it
    through the full or partial input receipt. The relay connection continues reading through the
    acknowledgement so the daemon can settle cancellations that arrived before it.
  - While the daemon decides to exit, arriving connections are closed before `hello`.
  - Once base reports `termination_requested`, it removes the daemon socket and exits.
- **Never does:** decide what a hello, operation, topic or relay means; call the agent list,
  messages, guests, windows or mcp; count calls as the daemon's work (each call counts its own).
- **Interface:**
  - `bind() -> Result<DaemonListener>`; `serve(listener: DaemonListener, service: Arc<S>, closing:
    watch::Receiver<bool>, paused: watch::Sender<bool>)`: accepts clients, pausing while
    `closing` is true and saying so in `paused`; `serve_connection(service, socket: ServerSocket)`: one
    connection.
  - `trait Service`, implemented by the daemon:
    - `hello(HelloParams, api_version, peer_pid) -> (HelloResult, Client, Hold)` runs after the
      server selects a supported API version and checks the client kind.
    - `call(&Client, DaemonCall, WhenFull, Cancel) -> Result<Value>`
    - `watch(&Client, DaemonWatch, viewer) -> Result<Watch>` and `unwatch(&Client, topic, viewer)`
    - `watch_shell(&Client, AttachArgs, viewer) -> Result<ShellWatch>` returns the snapshot and changes with
      the independent terminal-exit receiver.
    - `resize_viewer(&Client, viewer, Size, Option<TerminalColors>) -> Result<()>` receives
      only the viewer number resolved by the server from the connection's watch.
    - `relay(params, peer_pid) -> Result<RelayHandshake>` provides the hello response, the MCP line
      handler and the connection's takeover state.
    - `machine_hello` and `machine_connect` authorize a session and return its response and
      handoff state. `serve_machine` takes that state with the stream's existing halves.
    - `closing() -> watch::Receiver<Option<String>>`: the build taking over.
    - `draining() -> Option<ErrorBody>`: the error a new hello, call or watch gets during a
      takeover; an attached terminal's keys and size, and `daemon.upgrade`, still run.
    - `work() -> Option<Work>`: counts a connection; None closes it.
  - `RelayLines::take(line, arrived, outbox)` decodes a line, applies cancellations in receive order,
    and supplies async response work. A relay's local sends reach save, a previous receipt or refusal
    in receive order. Local delivery continues if the relay connection closes, and delivery and
    reply waits can proceed independently. A forwarded send keeps its relay's turn until the peer's
    final answer. That wait leaves the local save and handover permits free. A cancelled send can
    check its existing receipt and settle the withdrawal while an earlier send still owns the turn.
  - The original relay arrival bounds new effects. A start or send can still answer an existing
    receipt. A forwarded start with a request ID and zero `time_left_ms` checks that ID's receipt
    at the destination, within a separate transport budget. An older peer may reject the expired
    forward, in which case the original start's outcome remains unknown. An inbox uses its granted
    reply room after reselecting the page and checks its deadline just before marking it read. A
    terminal call checks its deadline before the typist queues its first bytes.
  - `Client` carries the kind and selected API version of an ordinary daemon API connection.
  - `Watch { snapshot, changes }`. `WatchChange::Ended(ErrorBody)` reports a remote watch failure.
    `WatchChange::Disconnect` cuts off a client that fell too far behind.
  - `WhenFull::{Refuse, Wait}`: input without room fails at once (a request ID) or waits until its
    `Cancel`, which the server triggers when the client closes (a notification).

### mcp

The relay and the daemon's MCP server form Facade API v1's MCP entry point. The local relay opens
its daemon connection with the `relay:1` handshake. MCP negotiates its own date-format
`protocolVersion` during `initialize`. Initialization and tool discovery are available before a
Guest is listed. The first tool call locks the identity of its connection.
Runs generate a private, unpredictable credential for each new run and Rules put it in that launch's
MCP arguments. Authentication, initialization and tool discovery await that run's installation on
the daemon runtime and verify its keeper PID, birth and run generation. A verified CLI-native
session can also identify a matching live run. A run recovered
from protocol 2 may keep its earlier recognition rules until that run ends. Resume has a new
credential scope even when it uses the same Agent ID.

At initialization the parent can verify a managed run and consult its installed CLI rule. A run
whose rule supplies the managed instructions through a hook receives the general connection text,
as does a connection whose run is still unknown. For other verified runs the parent renders the
managed instructions from the installed record and checks the run again before returning the text.
It uses the same address, creation source and run context as launch preparation.

The daemon dispatches tools for the verified actor through its typed operation registry. The
validated process brings a run's tools online. The daemon rechecks the run for each new request.
A waiting inbox read ends with its bound run, and Post checks the bound actor while it settles
the available page. When a run ends, the daemon releases its tools readiness guard.

One table defines the eight tools served by `tools/list` and dispatched by `tools/call`. The
catalog is sent as shipped, and a verified connection reports tools ready when it serves the list.
When a CLI defers its tool catalog, the holder tracks a live, credentialed initializer independently of
the verified catalog response. Both refer to the current installed run and end with their relay connection.
A reconnect or a tool-call routing connection supplies no catalog evidence for that CLI. After Daemon
replacement the holder waits for fresh verified evidence and reports tools available after `tools/list`.
The tools use the same targets, machine routing and operation requirements as other daemon clients. `list_agents`
adds available CLI names on answered, reachable machines within the roster deadline.
Local Managed discovery uses the verified run environment and working directory. Guest discovery and remote
discovery use the target login context. Local Guest start still validates its authenticated relay environment.

`start_agent` returns the agent's address, name, folder and machine ID. If the first prompt fails
while the caller's inbox is available, the notice uses the message number reserved by the daemon's
start receipt.

`read_messages` filters its page before delivery and commits only complete returned messages. `reply_to`
includes retained, delivered replies. Guests and agents without terminal message delivery can wait for matches
under the call's deadline. A positive `timeout_seconds` for a managed agent with terminal message delivery is
refused before its inbox is read.
`send_message` saves by default. A result wait uses confirmed delivery and the first matching reply in the
sender's own inbox, under the same budget. On timeout the reply can still be read through `read_messages`
with the original send ID. An unconfirmed managed submission names the recipient's full address
from the receipt and points to its screen for any text left in its input. A withdrawn send says it
can be sent again. A `#c` answer returns `returned_to_request` after the active command accepts it.

## Reading the code

1. `lib.rs`: `run`, `start_and_serve` and the `Daemon` value.
2. `service.rs` dispatches protocol operations and projects public records.
3. `operations.rs` starts a run in `start_in` and handles `resume` and `remove`.
4. `delivery.rs` routes sends in `route_send` and hands terminal input to the actor in `hand_input`.
5. `store/mod.rs`: `Store::open` and the cross-table transactions.
6. `recovery.rs`: `recover`, which lists the agents before clients are served.
