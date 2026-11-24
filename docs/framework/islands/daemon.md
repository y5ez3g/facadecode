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
- The transactions that commit a start with its prompt, settle a message, and remove an agent with
  its inbox. A record removal keeps the reason needed to distinguish expiry from explicit removal.
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
- A start writes the record and any initial prompt before the run becomes available. It reserves
  the prompt result's number on its creator's machine. That machine accepts a result while the
  creator is present. Shell and editor launches have no Agent to receive such a result.
- The launch transaction and a resumed run's commit save the displayed executable and arguments
  formatted by the running machine. Runs redacts the injected credential before the display
  text goes to the store or actor. Inspection reads this value from the same run as its screen
  facts. For a Terminal caller, inspection also reads the native session name or preview within the roster deadline.
  A recovered keeper run with no committed launch has no displayed command.
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
  client kind. Internal MCP calls use the actor proved by the independent relay connection.
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

The current database schema is `user_version = 6`. SQLite reserves this number for the application.
The daemon and Keeper negotiate their API versions independently.

Fresh stores initialize in their own transaction. The open path first refuses a nonempty development
schema missing `saved_connections` before normal WAL setup. It disables checkpoint-on-close for that
connection to preserve the existing database and WAL.

Versions below 6 enter one migration transaction. For a version below 3, the daemon first snapshots known
machine names, adds normalized SSH arguments and last-seen timestamps, and creates the remembered-route and
send-route tables and private receipt field. It adds Guest YOLO at version 0. Below 2 it adds the message
withdrawal field and replaces the request index. Then it adds the agent start, launch, authentication and
removal fields. For agents missing launch choices it snapshots configured model and effort where available,
with empty original arguments.

Below 4 it adds nullable `agents.launch_command`. Below 5 it adds `messages.command_line_reply` with
default false. Below 6 it adds `messages.notify_failure` with default false. Both additions preserve existing
messages, numbers and receipt keys. The migration writes `user_version` in the same transaction. A failed
migration rolls back and open fails. Version 6 or higher proceeds to normal reads. A newer layout may reach
the ordinary writers if those reads succeed.
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
| `presence.rs` | Recovers Guests, retires their inboxes and validates editor terminal colors. |
| `topics.rs`, `remote_agents.rs` | Maintain subscriptions, terminal viewers and each reachable peer's roster contribution. |
| `machine_service.rs`, `network_operations.rs` | Authorize and register machine streams, track routes and resolve requests to stable targets. |
| `relays.rs`, `service.rs` | Establish relay actors and serve both local and forwarded operations. |
| `recovery.rs` | Reconnects to keeper-held runs, restores screens and recovers pending deliveries. |
| `command_line.rs` | Resolves launch environment, settings and program. `cli.list` uses the same resolver as start. |
| `waits.rs` | Reports a managed run's trouble to its live agent creator, including across machines. |

The daemon holds the service lock while it recovers. It reconnects to the keeper, opens and migrates
SQLite, rebuilds the agents and screens, restores Guests and pending deliveries, and serves the socket
once recovery is complete. The hourly sweep removes expired ended records and their inboxes, expires
old messages and receipts, and prunes the daemon log.

A managed agent with an agent creator earns one notice after the serving daemon observes a continuous
30-second wait for permission, an answer or login, or a continuous 30-second error. A replacement daemon
starts a fresh observation interval. A natural exit, a crash or a stop
from another caller earns a notice at once. The creator must still be live. Recovery allows the next
incident to earn a notice. An initial message failure and its startup trouble share one receipt.
A Guest receives its notices through `read_messages`.

### agent

One tokio task per agent, the actor, that owns the agent's terminal and screen, and the handle the rest of the daemon reaches it through.

- **Owns:** one actor per agent the daemon started (a guest has a handle with no actor). The actor holds the terminal (a `PtyIo`), the input waiting for it, the screen and its screen log, the state, the typist, the viewers and the start of each run. The agent's record (`AgentInfo`) is shared with its handles under a leaf lock; only the actor changes it while it runs. `framework/screens/<id>/`: one folder per agent, deleted through `Screens`.
- **Keeps:**
  - Input and exits reach only the run they name. Each run has a number, starting at `FIRST_RUN`; `WriteInput`, `ProcessExited` and `StartPrompt` for any other run are refused as ended or dropped. An exit of a run whose terminal is not installed yet waits until it is.
  - Automatic input never interleaves (RULES 1.10): messages wait behind the start prompt; while the start readies the tools, keys and calls wait and then go in the order they came; the person's Enter waits, with the keys after it, until the input can be read.
  - An ordered input sequence enters the typist once. Earlier accepted input runs first. Later calls and raw Attach input wait until the sequence's last write.
  - Every screen change goes into the screen log before the screen takes it.
  - The record shows a run's end before anything waiting on the run learns it. The installed run
    number changes when its terminal is installed. Input is fenced from the previous run as soon
    as restart preparation begins.
  - Restart preparation reserves the next run and its requested size, waits for screen log room,
    and keeps the ended screen. Once the replacement run is committed and its terminal opens,
    the actor finishes the old viewer frame, logs an empty screen with fresh terminal modes,
    and applies the requested size before reading the new run's output. The native title carries
    across the reset.
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
  - A screen snapshot carries the agent name, process state and any recorded exit from the actor.
    An exact final snapshot waits for the existing exit drain and admits no live viewer.
    A dedicated Shell viewer signals the watched run's terminal exit independently of queued screen changes.
    Inspect includes the authenticated client kind and source machine of shell and editor viewers.
  - A CLI waiting for the person or reporting an error is published at once; other changes of the record within 200 ms go out together.
  - At most `MAX_INPUT_BYTES` (1 MiB) of input waits; more is refused with the input given back.
  - Quiet replies only once no read is under way and what the last reads brought went through the screen log; `LetGoBeforeStop` lets go of the signal pipe and nothing else.
- **Never does:** touch the database; know other agents; decide when a run starts or ends; type into a terminal that is not Facade's.
- **Interface:**
  - `spawn(ActorStart, rx, tx, changes) -> anyhow::Result<AgentHandle>`. `ActorStart` carries the
    record, `PtyMaster`, `ScreenStart`, rule name, `DeliveryHandle`, `StateStart` and initial colors.
  - `AgentHandle` provides the current `info()`, `title()`, `rule()`, `exit()` and `installed_record()`.
    `lock_run_change()` serializes run transitions. `send(AgentCommand)` addresses the actor.
    `tools_connected()` holds the tools connection until its guard drops. A Guest has methods for
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

- **Owns:** the `PtyIo` (none between runs or once the terminal closed), the input queue, the last output read, whether the CLI's side closed, the bytes written so far and when.
- **Keeps:** Input is written in order, at most 64 KiB at a time; a read takes at most 64 KiB. The count of bytes written never resets, across runs too: the typist finds its own bytes by it. Letting go of the terminal drops the queued input. `ready` can be cancelled safely. A write under way is given the same head of the queue until it returns; clearing the queue keeps those bytes. `stop_reading` leaves no read under way.
- **Never does:** parse output, decide what input may wait, or select a submission key.
- **Interface:** `new(Option<PtyMaster>)`, `install(PtyMaster)`, `detach()`, `stop_reading() -> Option<usize>` (async), `let_go_before_stop()`; `ready(TerminalWait) -> TerminalEvent` (`Read`, `Closed`, `Wrote`, `WriteFailed`), `read_now() -> Option<usize>`, `output() -> &[u8]`; `push(&[u8])`, `clear()`, `queued()`, `written()`, `written_at()`; `is_open()`, `is_closed()`, `set_size(cols, rows)`.

#### screen

`LoggedScreen`: the agent's screen and its screen log, in memory or left in its files.

- **Owns:** the `Screen`, the open screen log, the checkpoint being written and the count of checkpoints being written. The files in `framework/screens/<id>/`: `<g>.checkpoint` (size, a redraw with scrollback, a SHA-256 checksum), `<g>.log` (output, resize and synchronized-update-end records), and `current`, which names the published generation.
- **Keeps:** Every change is logged before the screen takes it. After 4 MiB of output a checkpoint is taken at a clean point; at the log's 64 MiB cap one is forced, and the log says what a recovery from it loses. A full log reads no output until its checkpoint is written; a failed checkpoint is tried again later. A checkpoint is synced before `current` names it, and the folder is synced before older generations are deleted. Recovery starts from the published checkpoint or a valid older one. Folders and files are private through base (0700 and 0600 on Unix); a folder is synced through base, which needs nothing on Windows.
- **Never does:** touch the terminal; read CLI rules; know viewers; delete the agent's folder.
- **Interface:** `create(folder, id, cols, rows)` (async), `recovered(folder, id, screen, log)`, `released(folder, id)`; changes: `feed(bytes) -> ParsedOutput`, `resize(cols, rows)`, `end_synchronized_update()`, `set_colors(TerminalColors)` (for the screen it holds and every screen it holds later); reads: `screen() -> &Screen`, `is_held()`; checkpoints: `checkpoint_if_due()`, `is_full()`, `checkpoint_running()`, `checkpoint_written()` (async), `finish_checkpoint(written)`; memory: `let_go()`, `hold()`, `hold_with_log()`, `finish()` (async). Recovery uses `recover`, `recover_after_clean_end` and `saved_size`; the daemon's lifecycle waits for `screen_writes()` to reach 0 before it exits or a newer build takes over.
- `set_status_glyph(Option<String>) -> Vec<u8>` forwards to the held screen and returns the title
  bytes for viewers. The screen log and checkpoints keep the CLI's own title.

#### state

`StateTracker`: which of the 8 states the agent is in, from what its CLI reports and shows and from Facade's own facts.

- **Owns:** what the CLI reported and its screen showed, the turn, a question the CLI asks, the tools' connection, how the run ended, what was last said to the agent, and the file `framework/screens/<id>/state`.
- **Keeps:**
  - One state, by a fixed order: `Ended`; the CLI's own `WaitingForYou` or `Error`; a question in place of the input box (`WaitingForYou`); tools unavailable (`Error`); `JustDone`; `Working`; `Starting`; `Idle`; a failed start (`Error`); else `Unknown`.
  - Work that stops reads `Working` for 1 more second; a turn someone asked for that ends unwatched reads `JustDone` until a terminal shows the agent.
  - Under `background_report`, a `working` report with matching words becomes idle evidence.
  - Under `background_correction`, a `working` report is narrowed to idle evidence while the screen
    matches the rule's idle anchors. The rule applies regardless of the CLI's installed version.
  - A start and the tools' connection get 30 seconds each. Time the CLI spends asking a question does not count.
  - Only `keep` writes the state file, through a private temporary file and a rename. What the screen shows is read again, never kept.
- **Never does:** touch the terminal; change the agent's record; publish.
- **Interface:** `new(rule, started, kept, exit, screen)`; evidence: `take(events)`, `reads_screen()`, `has_report_evidence()`, `observe(&Screen)`, `asks(asking, now)`; run: `ended(exit, stopped)`, `restarted(started, tools)`, `recovered(now)`; people: `said(Submission)`, `asked()`, `seen()`; tools: `tools_connection(open)`, `tools_not_started()`; reads: `read(now, Viewing) -> StateReading`, `said_line()`, `kept()`, `started()`, `works()`, `start_bound()`, `tools_given()`. The actor runs `keep(file, changes)`. Start and recovery use `Kept::new_run`, `state_file`, `read_kept` and `instant_of`.

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

- **Owns:** the calls and messages waiting, the paste under way, where its bytes are in the terminal, its pauses, and what it submitted; the probe under way, and what this run's probes found of each row they tried (`probed`).
- The actor allows unstyled hint probes for automatic delivery to a freshly launched input. Starting with a
  session, recovery, resume, an unconfirmed paste or accepting external input leaves plain writing on the
  normal draft path. External input that arrives during an unstyled hint probe waits for its Space and
  Backspace to finish.
- **Keeps:**
  - Each call goes in whole and in order; a pause counts from when its bytes reached the terminal.
  - A message's bytes are written only after `DeliveryHandle::begin_paste` recorded the paste.
  - The submission key goes once the input box shows this paste alone and stays still for the CLI's settle time.
    Codex queues an ordinary message with Tab while Working. The start prompt and recovered pastes use Enter.
  - A message is delivered once its submission key reaches the terminal. When the deadline expires before
    submission, the typist can withdraw the message after the screen confirms it cleared its own draft.
  - The start prompt is pasted alone; a paste an earlier daemon began is never typed again.
  - The wait before submission counts the paste rate from `PASTE_BYTES_PER_MS`. With console typing, characters above U+FFFF go as key-down records and the wait adds `per_char` for each UTF-16 code unit.
  - An input whose row may be a hint or a draft (it reads unsure) is probed once a run, by its child `probe`: a space where the input starts, then, once the input is drawn still, Backspace, and a check that the input is as it was. Nothing else is typed meanwhile. The input is read every 100 ms; still means two equal readings in a row that show the row, for at most a second after each key. Backspace goes only where the space went in, no menu or question shows, and the person typed nothing since the probe read the input; after a failed check nothing more is pressed. What a probe finds, a hint, a draft or neither for sure, is kept for the row until the CLI's next run, so a row is never probed twice in a run.
- **Never does:** write the terminal (it hands its bytes to the actor); read the screen except through the reading the actor gives it; take the person's keys; touch the database.
- **Interface:** the daemon builds `Typing::text(text, enter, sender)`, `Typing::keys(names)` and `MessageTyping::{new, start_prompt}(text, number, deadline, submission)`. The actor uses `new(agent, paste_rule, console_typing, DeliveryHandle)`, `push`, `deliver`, `deliver_first`, `finish_paste`, `fail_ended`, `fail_all(written, why)`, `hold_pastes()`, and `step(now, written, queued, modes, typed, read, read_screen) -> Step { write, wake }`, where `typed` counts the person's writes and `read_screen` reads the input as the screen shows it; for probes, `recall(reading)` (a row a probe found a hint reads as an empty input, a draft as a draft), `want_probe()` (the start waits on an unsure input) and `clear_probes()` (a new run starts); it reads `take_submitted()`, `take_entered()`, `held_bytes()`, `paste_rule()`, `busy()`, `pasting()`, `types_calls()`, `reads_input()`, `probing()`. Through `DeliveryHandle` it asks `still_to_type(number)`, records `begin_paste(numbers)` and `settle(numbers, outcome)`.

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

- **Owns:** the rule's `ReadyTools` and `TrustQuestion`, how far each has got, and when each wait ends.
- **Keeps:** A bounded startup wait stays within the start's 30 seconds. Enter goes once the rule's text shows alone in the input box. Each key of the trust answer waits for the screen to be still for 1 second. The trusting answer goes once per run while it is selected.
- **Never does:** type (it hands each `Press` to the actor, which gives it to the typist); read the terminal; hold input; change the state.
- **Interface:** `new(rule, id)`, `begin(started, tools, allow_auto_trust) -> Option<Instant>`, `end()`, `step(now, &StartView, press) -> StartStep { wake, release_held, tools_not_started }`, `holds_input(InputState)`, `readies_tools()`, `is_under_way()`.

### messages

Post assigns a message number in the SQLite transaction that keeps it. The receiving machine owns
delivery state. A managed terminal confirms delivery when the submission key reaches it. A Guest confirms
delivery by taking the message from its inbox. Both use the same deadline.

A managed terminal sees `📨 Message mN from <sender>` above the body. Replies append
` · in reply to mN`, with a machine selector when the original message is remote. A command-line
sender has a `#c` address only while waiting for a reply. A notice begins with `🔔` followed by its
text. Its record number is available in the inbox.

When a daemon recovers an already begun paste, it checks the draft against the message formats
before and after the header change. The matching format determines the paste lead and settling
time. Recovery keeps the original deadline and submits the existing draft once. If both formats
still match at the deadline and their lengths differ, recovery leaves the text in the input and
reports unconfirmed submission.

An explicit inbox-only send returns after storage commits, and delivery continues on its background deadline.
For a send from an authenticated agent, the original admission stores `notify_failure` with the sender and
delivery deadline. Pending rows carry that ownership through daemon recovery. Schema version 6 gives existing
rows a false value. Receipt replay uses the original decision. Delivery and result waits share the caller's
remaining budget. A v1 send with no wait field uses a delivery wait.

A command-line result wait belongs to the source daemon and closes with its request. The holder stores the
reply marker with the original message. Only its verified recipient can answer the associated `#c`
address. The holder assigns a reply number and the source accepts only the first reply that matches the live
request. If the source is a peer, confirmation goes back along an authenticated route before the sender gets
the private reply receipt. The persisted original remains identifiable after the waiter ends.

- Post serializes the first terminal paste, inbox settlement and withdrawal under its delivery
  lock. A read takes only pending messages whose paste has yet to begin. An explicit history page
  can also include previously delivered messages. The selector and optional reply filter run
  before applying the limit. The client projects complete messages and returns the prefix Post
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
  - Startup: `find_keeper_at_startup() -> FoundKeeper` (`Absent` or `Connected { build, held }`),
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
    locked; `keep_exit_task(id, task)`; `release(id)`; `abandon(id)`; `remove(id)`;
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
the run.

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
  offering its supported API versions. It rejects the whole frame if a required terminal is absent or
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

A run's command line, environment, folder, plugin and session following.
`runs/preparation/` (`mod.rs`, `environment.rs`, `folder.rs`, `plugin.rs`, `session.rs`).

- **Owns:** composing a run's command line from its rule (`facade_rules::start_managed_launch_command`,
  `resume_managed_launch_command`) with a fresh credential for the private relay and the managed
  instructions. It starts the program directly where the program found on the run's `PATH` is a
  wrapper (`facade_rules::direct_command`). It builds the run's environment from the client's by the
  rule of `env` in
  [`StartArgs`](../../../framework/protocol/DAEMON.md#startargs) and `FACADE_HOME`. It owns private
  run folders `framework/runs/<agent>/<random>/`, with the session
  file, the tool files and a `plugin-folder` note naming the project whose plugin a start placed;
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
  Only CLIs for which `facade_rules::uses_folder_plugin` holds use it. The session file is checked
  by its modified time and size a second after the run's terminal gives output, as a CLI saves its
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

`lifecycle/` owns work counts and guards, idle exit, a newer build's takeover, the `framework/clean-end`
note and `framework/logs/daemon.log`. The keeper points the daemon's standard error at the log.
`log_file.rs` prunes lines after 30 days and returns up to 200 lines to the person's clients.

- `begin(Work)` counts the work until its guard drops. The idle decision uses the same lock to
  exclude new work. After 30 idle seconds it asks the server to pause acceptance, informs compatible
  machines of the idle exit, and waits for screen writers and exit commits before removing the socket.
  A long-lived machine watch or foreground connection counts while active. Takeover settlement
  waits for the existing calls and run changes it can complete.
- `take_over(UpgradeArgs, activity)` checks and installs the new build before marking the daemon
  as draining. It settles pastes and work, asks the actors to go quiet, records a clean end when
  they all do, and sends `closing`. After connections drain it settles work and asks the actors
  to go quiet again before exiting. The keeper holds the terminals throughout.
- The parent implements `LifecycleActivity` to report activity, screen writes and keeper details,
  and to send paste and quiet commands to actors. The parent takes the clean-end note at startup
  and uses that fact to select how it recovers screens.

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
  - Once a newer Facade takes over, every connection past `hello` gets a `closing` notification;
    what the client sent before its response, or within 0.2 seconds, still runs; then its reading
    ends.
  - While the daemon decides to exit, arriving connections are closed before `hello`.
  - Once base reports `termination_requested`, it removes the daemon socket and exits.
- **Never does:** decide what a hello, operation, topic or relay means; call the agent list,
  messages, guests, windows or mcp; count calls as the daemon's work (each call counts its own).
- **Interface:**
  - `bind() -> Result<DaemonListener>`; `serve(listener: DaemonListener, service: Arc<S>, closing:
    watch::Receiver<bool>, paused: watch::Sender<bool>)`: accepts clients, pausing while
    `closing` is true and saying so in `paused`; `serve_connection(service, socket: ServerSocket)`: one
    connection, also the daemon's own in-process MCP server's.
  - `trait Service`, implemented by the daemon:
    - `hello(HelloParams, api_version, peer_pid) -> (HelloResult, Client, Hold)` runs after the
      server selects a supported API version and checks the client kind.
    - `call(&Client, DaemonCall, WhenFull, Cancel) -> Result<Value>`
    - `watch(&Client, DaemonWatch, viewer) -> Result<Watch>` and `unwatch(&Client, topic, viewer)`
    - `watch_shell(&Client, AttachArgs, viewer) -> Result<ShellWatch>` returns the snapshot and changes with
      the independent terminal-exit receiver.
    - `resize_viewer(&Client, viewer, Size, Option<TerminalColors>) -> Result<()>` receives
      only the viewer number resolved by the server from the connection's watch.
    - `relay(params, peer_pid) -> Result<(Value, Arc<dyn RelayLines>)>`: the relay hello's response
      and what serves its MCP lines.
    - `machine_hello` and `machine_connect` authorize a session and return its response and
      handoff state. `serve_machine` takes that state with the stream's existing halves.
    - `closing() -> watch::Receiver<Option<String>>`: the build taking over.
    - `draining() -> Option<ErrorBody>`: the error a new hello, call or watch gets during a
      takeover; an attached terminal's keys and size, and `daemon.upgrade`, still run.
    - `work() -> Option<Work>`: counts a connection; None closes it.
  - `trait RelayLines`: `notice(line) -> bool`, `respond(line, arrived) -> Option<Value>` (blocking,
    run on a blocking thread), `failed() -> Value` (the response when answering panicked),
    `ended(closing_answered)`.
  - `Client` carries the connection's client kind, selected API version and the actor verified
    by the daemon's private MCP connection.
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
MCP arguments. The verifier waits for that run's installation and uses its keeper PID, birth and run
generation. A verified CLI-native session can also identify a matching live run. A run recovered
from protocol 2 may keep its earlier recognition rules until that run ends. Resume has a new
credential scope even when it uses the same Agent ID.

At initialization the parent can verify a managed run and consult its installed CLI rule. A run
whose rule supplies the managed instructions through a hook receives the general connection text,
as does a connection whose run is still unknown. For other verified runs the parent renders the
managed instructions from the installed record and checks the run again before returning the text.
It uses the same address, creation source and run context as launch preparation.

The parent hands the verified actor to the private daemon connection. Only the validated process
can bring a run's tools online. The connection rechecks the run when it sends a new request. A
waiting inbox read also ends with its bound run, and Post checks the bound actor while it settles
the available page.

One table defines the eight tools served by `tools/list` and dispatched by `tools/call`. The
catalog is sent as shipped, and a verified connection reports tools ready when it serves the list.
The tools use the same targets, machine routing and operation requirements as other daemon clients. `list_agents`
adds available CLI names on answered, reachable machines within the roster deadline.
Local Managed discovery uses the verified run environment and working directory. Guest discovery and remote
discovery use the target login context. Local Guest start still validates its authenticated relay environment.

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
