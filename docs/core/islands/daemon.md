# Daemon

The daemon manages one Facade home's agents. It serves the shell, the editor, MCP relays and other
machines. The crate is `facade-daemon` in `core/crates/daemon/`. The command `facade daemon` runs its
public `run()` entry point.

## Owns

- The local agent list, indexed by the running machine's agent number. A client can follow records
  from the local daemon and reachable peers in one subscription.
- `core/facade.db`, including the record and message counters, run identity, launch options, creation
  source, Guest snapshots, saved SSH arguments and remembered routes. The original window and
  membership records remain available for workspace import.
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
  machines that are already connected. A request with a machine can follow a saved route and wake
  the target. A connecting machine stays visible without blocking an ordinary list.
- The source establishes the caller. The running machine checks the caller's creation-tree root,
  YOLO and the operation's requirements. A stop, input or Attach uses a running managed agent.
  The screen reader can also read the last screen of an ended agent.
- A start on a peer loads that peer's login environment and resolves its CLI and directory there.
  A worktree starts from the selected checkout's HEAD. Preflight checks the same requirements
  without creating a branch. An existing Agent resumes from its stored directory, CLI arguments,
  model and effort. During upgrade, a record without launch options takes the selected CLI's
  configured model and effort once and keeps an empty list of CLI arguments.
- A start writes the record and any initial prompt before the run becomes available. It reserves
  the prompt result's number on its creator's machine. That machine accepts a result while the
  creator is present. Shell and editor launches have no Agent to receive such a result.
- The launch transaction and a resumed run's commit save the displayed executable and arguments
  formatted by the running machine. Runs redacts the injected credential before the display
  text goes to the store or actor. Inspection reads this value from the same run as its screen
  facts. A recovered keeper run with no committed launch has no displayed command.
- On Windows a stop releases the actor's copy of the pseudo console's signal pipe, then the
  keeper link's copy, before it asks the keeper to stop. An IDE resize can carry terminal colors.
- The service opens after recovery has listed the readable agents. Five consecutive idle seconds
  allow it to exit. A running Agent, a connected Guest or current work keeps it active. Idle peer
  links and their topology and roster subscriptions do not count as work.

## Interface

- [Daemon operations and topics](../../../core/protocol/PROTOCOL.md) use protocol 3 in normal
  connections. The editor and shell identify their client kind. Internal MCP calls use the actor
  established by the relay connection.
- A protocol 2 terminal can request a compatible takeover. The keeper and relay protocols stay
  at their existing versions. A takeover hands the PTY back to the daemon holding the new build.
  Recovery reads the original SQLite counters and screen records before it accepts business calls.
  A keeper protocol refusal of a local terminal's takeover names the live managed agents holding
  that keeper, with their stable references and labels.
- A machine hello or a foreground `machine.connect` transfers its flushed connection to the network
  session. Authentication, probe, installation when needed and serve use that same SSH session.
- The person's diagnostics read up to 200 lines of `core/logs/daemon.log`, with the home written
  as `~`. Only the daemon writes and prunes this log.

## Depends on

- [Base](base.md) for protocol types and framing, addresses, paths, settings, process identity,
  file permissions, service locks and the instructions given to models.
- [Screen](screen.md) for the terminal grid and [Rules](rules.md) for launches, input, state,
  private tool configuration and the CLI's saved sessions.

## Inside

| File | Responsibility |
|---|---|
| `lib.rs` | Starts and serves this home and schedules the hourly sweep. |
| `store/` | Owns SQLite schema, migrations, table handles and cross-table transactions. |
| `operations.rs` | Starts, stops, resumes, renames and removes runs and records their exits. |
| `resume.rs` | Finds stopped Agents and saved sessions and routes a chosen resume target. |
| `delivery.rs` | Delivers typed input, messages, initial prompts and results. Replays receipts by request ID. |
| `presence.rs` | Recovers Guests, retires their inboxes and validates editor terminal colors. |
| `topics.rs`, `remote_agents.rs` | Maintain subscriptions, terminal viewers and each reachable peer's roster contribution. |
| `machine_service.rs`, `network_operations.rs` | Authorize and register machine streams, track routes and resolve requests to stable targets. |
| `relays.rs`, `service.rs` | Establish relay actors and serve both local and forwarded operations. |
| `recovery.rs` | Reconnects to keeper-held runs, restores screens and recovers pending deliveries. |
| `command_line.rs` | Resolves launch environment, settings and program. `cli.list` uses the same resolver as start. |
| `waits.rs` | Sends a wait notice to the creator, including when the creator is on a peer. |

The daemon holds the service lock while it recovers. It reconnects to the keeper, opens and migrates
SQLite, rebuilds the agents and screens, restores Guests and pending deliveries, and serves the socket
once recovery is complete. The hourly sweep removes expired ended records and their inboxes, expires
old messages and receipts, and prunes the daemon log.

A managed Agent that waits continuously for 20 seconds on permission, a question or sign-in reports
one notice to its creator. A different run or an interruption of the wait resets that period. The
recipient gets the same delivery deadline as for other notices. A Guest receives it when it reads
its inbox within that deadline.

### agent

One tokio task per agent, the actor, that owns the agent's terminal and screen, and the handle the rest of the daemon reaches it through.

- **Owns:** one actor per agent the daemon started (a guest has a handle with no actor). The actor holds the terminal (a `PtyIo`), the input waiting for it, the screen and its screen log, the state, the typist, the viewers and the start of each run. The agent's record (`AgentInfo`) is shared with its handles under a leaf lock; only the actor changes it while it runs. `core/screens/<id>/`: one folder per agent, deleted through `Screens`.
- **Keeps:**
  - Input and exits reach only the run they name. Each run has a number, starting at `FIRST_RUN`; `WriteInput`, `ProcessExited` and `StartPrompt` for any other run are refused as ended or dropped. An exit of a run whose terminal is not installed yet waits until it is.
  - Automatic input never interleaves (RULES 1.10): messages wait behind the start prompt; while the start readies the tools, keys and calls wait and then go in the order they came; the person's Enter waits, with the keys after it, until the input can be read.
  - Every screen change goes into the screen log before the screen takes it.
  - The record shows a run's end before anything waiting on the run learns it. The installed run
    number changes when its terminal is installed. Input is fenced from the previous run as soon
    as restart preparation begins.
  - An admitted Attach reports its viewer name for the life of its watch. The actor reads the CLI
    title from the terminal and restores the last title from the screen log.
  - A screen snapshot carries the agent name, process state and any recorded exit from the actor.
    An exact final snapshot waits for the existing exit drain and admits no live viewer.
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
  - `AgentCommand` includes `WriteInput` and `ResizeTerminal`, `AttachViewer` and `RemoveViewer`,
    `ReadScreen` and `Inspect`, along with run transitions and paste settlement. `Input` is `Raw`
    keys, `Typed` text or keys, a `Message`, or a `BegunPaste` to finish.
  - `Screens`: `new(folder)`, `folder(id)`, `remove(id)`, `delete_without_records(kept)`.
  - For recovery: `recover`, `recover_after_clean_end`, `saved_size`, `screen_writes`, `state_file`, `read_kept`, `instant_of`.

The agent layer is `agent/mod.rs` (the interface above), `agent/actor.rs` (the task's loop) and `agent/person.rs` (the person's keys). The six child islands are plain values the actor owns: no task, no lock, and none calls another. The actor's loop waits on its commands, the terminal, the tools connections and its timers, and passes what one child learns to the next: output goes from the terminal into the screen, then to the viewers, the state, readiness and the typist; what the typist and readiness write goes back into the terminal's queue. Readiness hands the keys it wants pressed to a closure the actor gives it, which turns them into typist calls. Only the actor publishes the record.

#### terminal

The terminal, as a `PtyIo`, and the input waiting for it.

- **Owns:** the `PtyIo` (none between runs or once the terminal closed), the input queue, the last output read, whether the CLI's side closed, the bytes written so far and when.
- **Keeps:** Input is written in order, at most 64 KiB at a time; a read takes at most 64 KiB. The count of bytes written never resets, across runs too: the typist finds its own bytes by it. Letting go of the terminal drops the queued input. `ready` can be cancelled safely. A write under way is given the same head of the queue until it returns; clearing the queue keeps those bytes. `stop_reading` leaves no read under way.
- **Never does:** parse output; decide what input may wait or how much; press Enter.
- **Interface:** `new(Option<PtyMaster>)`, `install(PtyMaster)`, `detach()`, `stop_reading() -> Option<usize>` (async), `let_go_before_stop()`; `ready(TerminalWait) -> TerminalEvent` (`Read`, `Closed`, `Wrote`, `WriteFailed`), `read_now() -> Option<usize>`, `output() -> &[u8]`; `push(&[u8])`, `clear()`, `queued()`, `written()`, `written_at()`; `is_open()`, `is_closed()`, `set_size(cols, rows)`.

#### screen

`LoggedScreen`: the agent's screen and its screen log, in memory or left in its files.

- **Owns:** the `Screen`, the open screen log, the checkpoint being written and the count of checkpoints being written. The files in `core/screens/<id>/`: `<g>.checkpoint` (size, a redraw with scrollback, a SHA-256 checksum), `<g>.log` (output, resize and synchronized-update-end records), and `current`, which names the published generation.
- **Keeps:** Every change is logged before the screen takes it. After 4 MiB of output a checkpoint is taken at a clean point; at the log's 64 MiB cap one is forced, and the log says what a recovery from it loses. A full log reads no output until its checkpoint is written; a failed checkpoint is tried again later. A checkpoint is synced before `current` names it, and the folder is synced before older generations are deleted. Recovery starts from the published checkpoint or a valid older one. Folders and files are private through base (0700 and 0600 on Unix); a folder is synced through base, which needs nothing on Windows.
- **Never does:** touch the terminal; read CLI rules; know viewers; delete the agent's folder.
- **Interface:** `create(folder, id, cols, rows)` (async), `recovered(folder, id, screen, log)`, `released(folder, id)`; changes: `feed(bytes) -> ParsedOutput`, `resize(cols, rows)`, `end_synchronized_update()`, `set_colors(TerminalColors)` (for the screen it holds and every screen it holds later); reads: `screen() -> &Screen`, `is_held()`; checkpoints: `checkpoint_if_due()`, `is_full()`, `checkpoint_running()`, `checkpoint_written()` (async), `finish_checkpoint(written)`; memory: `let_go()`, `hold()`, `hold_with_log()`, `finish()` (async). Recovery uses `recover`, `recover_after_clean_end` and `saved_size`; the daemon's lifecycle waits for `screen_writes()` to reach 0 before it exits or a newer build takes over.

#### state

`StateTracker`: which of the 8 states the agent is in, from what its CLI reports and shows and from Facade's own facts.

- **Owns:** what the CLI reported and its screen showed, the turn, a question the CLI asks, the tools' connection, how the run ended, what was last said to the agent, and the file `core/screens/<id>/state`.
- **Keeps:**
  - One state, by a fixed order: `Ended`; the CLI's own `WaitingForYou` or `Error`; a question in place of the input box (`WaitingForYou`); tools unavailable (`Error`); `JustDone`; `Working`; `Starting`; `Idle`; a failed start (`Error`); else `Unknown`.
  - Work that stops reads `Working` for 1 more second; a turn someone asked for that ends unwatched reads `JustDone` until a terminal shows the agent.
  - A start and the tools' connection get 60 seconds each; time the CLI spends asking a question does not count.
  - Only `keep` writes the state file, through a private temporary file and a rename. What the screen shows is read again, never kept.
- **Never does:** touch the terminal; change the agent's record; publish.
- **Interface:** `new(rule, started, kept, exit, screen)`; evidence: `take(events)`, `reads_screen()`, `observe(&Screen)`, `asks(asking, now)`; run: `ended(exit, stopped)`, `restarted(started, version, tools)`, `recovered(now)`; people: `said(Submission)`, `asked()`, `seen()`; tools: `tools_connection(open)`, `tools_not_started()`; reads: `read(now, Viewing) -> StateReading`, `said_line()`, `kept()`, `started()`, `works()`, `start_bound()`, `tools_given()`. The actor runs `keep(file, changes)`. Start and recovery use `Kept::new_run`, `state_file`, `read_kept` and `instant_of`.

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
  - Enter goes only once the input box shows this paste alone and stays still for the CLI's settle time.
  - A message is delivered once Enter reaches the terminal. When the deadline expires before
    Enter, the typist can withdraw the message after the screen confirms it cleared its own draft.
  - The start prompt is pasted alone; a paste an earlier daemon began is never typed again.
  - The wait before Enter counts the paste rate from `PASTE_BYTES_PER_MS`. With console typing, characters above U+FFFF go as key-down records, and a paste's Enter and a message's time add `per_char` for each UTF-16 code unit.
  - An input whose row may be a hint or a draft (it reads unsure) is probed once a run, by its child `probe`: a space where the input starts, then, once the input is drawn still, Backspace, and a check that the input is as it was. Nothing else is typed meanwhile. The input is read every 100 ms; still means two equal readings in a row that show the row, for at most a second after each key. Backspace goes only where the space went in, no menu or question shows, and the person typed nothing since the probe read the input; after a failed check nothing more is pressed. What a probe finds, a hint, a draft or neither for sure, is kept for the row until the CLI's next run, so a row is never probed twice in a run.
- **Never does:** write the terminal (it hands its bytes to the actor); read the screen except through the reading the actor gives it; take the person's keys; touch the database.
- **Interface:** the daemon builds `Typing::text(text, enter, sender)`, `Typing::keys(names)` and `MessageTyping::{new, start_prompt}(text, number, deadline, submission)`. The actor uses `new(agent, paste_rule, console_typing, DeliveryHandle)`, `push`, `deliver`, `deliver_first`, `finish_paste`, `fail_ended`, `fail_all(written, why)`, `hold_pastes()`, and `step(now, written, queued, modes, typed, read, read_screen) -> Step { write, wake }`, where `typed` counts the person's writes and `read_screen` reads the input as the screen shows it; for probes, `recall(reading)` (a row a probe found a hint reads as an empty input, a draft as a draft), `want_probe()` (the start waits on an unsure input) and `clear_probes()` (a new run starts); it reads `take_submitted()`, `take_entered()`, `held_bytes()`, `paste_rule()`, `busy()`, `pasting()`, `types_calls()`, `reads_input()`, `probing()`. Through `DeliveryHandle` it asks `still_to_type(number)`, records `begin_paste(numbers)` and `settle(numbers, outcome)`.

#### viewers

`Viewers`: sends the agent's screen changes to the clients watching it.

- **Owns:** the viewers and those waiting for their first snapshot, the bytes queued for each, the redraws and exits they are owed, and the signal that drops a viewer too far behind.
- **Keeps:** At most 1 MiB of output waits for a viewer; past that it is marked behind and later gets one redraw instead. Snapshots and redraws wait for a synchronized update to end. A viewer behind gets its redraw before the exit. Before a resume, a viewer still over 1 MiB is dropped and its client told to reconnect. `Removed` comes last.
- **Never does:** change the screen; read the terminal; decide when the exit goes out.
- **Interface:** the actor: `new()`, `request(ViewerRequest)`, `admit(&Screen, exit, process)`, `remove(viewer)`, `show(&ParsedOutput)`, `redraw_all()`, `catch_up(&Screen, exit) -> bool`, `send_exit(exit)`, `finish_run(&Screen, exit)`, `finish(&Screen, exit)`, `is_watched()`, `is_behind()`. The server's screen watches: `viewer_channel()`, `ViewerReceiver::{recv, stalled}`, `ViewerSnapshot`, `ViewerChange`.

#### readiness

`Readiness`: decides which keys a run's start presses to ready its CLI's tools and, with YOLO on, to answer its CLI's question about trusting the folder.

- **Owns:** the rule's `ReadyTools` and `TrustQuestion`, how far each has got, and when each wait ends.
- **Keeps:** No wait goes past the start's 60 seconds. Enter goes only once the rule's text shows alone in the input box. Each key of the trust answer waits for the screen to be still for 1 second, the answer goes only while the selection shows on the answer that trusts, and it is given once per run.
- **Never does:** type (it hands each `Press` to the actor, which gives it to the typist); read the terminal; hold input; change the state.
- **Interface:** `new(rule, id)`, `begin(started, tools, yolo) -> Option<Instant>`, `end()`, `step(now, &StartView, press) -> StartStep { wake, release_held, tools_not_started }`, `holds_input(InputState)`, `readies_tools()`, `is_under_way()`.

### messages

Post assigns a message number in the SQLite transaction that keeps it. The receiving machine owns
delivery state. A managed terminal confirms delivery when its Enter is written. A Guest confirms
delivery by taking the message from its inbox. Both use the same deadline.

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
`core/crates/daemon/src/runs/`.

- **Owns:** the connection to the keeper; the registry of runs whose terminal the daemon holds;
  starts not yet registered; each run's exit-saving task; run folders in `core/runs/`; Facade's
  plugin in project folders; session following.
- **Keeps:** a run keeps only its first exit, and an exit carries its run number, so an old run's
  exit never reaches a new one. A run is registered before `start` returns, before the daemon
  commits it. No lock is held while a handle, an `ExitSink` or the event sender is called.
- **Never does:** touch the database; know an agent's actor; interpret a CLI (asks `facade_rules`);
  end the keeper.
- **Interface** (the daemon layer, `lib.rs`, `operations.rs`, `recovery.rs`):
  - Created once: `Runs::new(core, Arc<Held>, UnboundedSender<RunEvent>)`.
  - Events up: `RunEvent::Exited { id, exit }`; `RunEvent::Session { id, run, session, committed }`,
    where the daemon commits the session first and replies on `committed: oneshot::Sender<bool>`.
  - Exits to the actor: `ExitSink = Arc<dyn Fn(RunExit) + Send + Sync>`, given per run;
    `RunExit { run, exit, stopped }`.
  - Startup: `find_keeper_at_startup() -> FoundKeeper` (`Absent` or `Connected { build, held }`),
    then `serve_keeper()`.
  - Start and resume, in this order: `reserve_start() -> StartReservation`,
    `reservation.wait_for_keeper()` and `prepare_managed(RunRequest, address, context)`.
    `RunRequest` carries the launch options and any CLI session. A resume uses
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
    daemon may not exit), `keeper_info()`, `keeper_protocol()`.

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
  the connection lock is a leaf. The keeper is proved (`authenticate_server`) before its hello. The registry's copy
  of a run's terminal lets go before any `agent.stop` for that run (a stop, an abandoned start, a stop
  sent again); `agent.sync` passes each copy as it is.
- **Never does:** end a keeper; touch folders, plugins or sessions.
- **Interface** (runs only): `KeeperLink::new(core, events)`, `find_at_startup`, `serve`,
  `reserve_start`, `send_start(.., RunKind)`, `stop`, `record_exit -> RecordedExit::{Unknown,
  Repeated, Kept(ExitRecorded), Dropped}`, `installed`, `release`, `abandon`, `remove`,
  `ended_run_released(id, deadline)`, `running_process`, the recovery calls (`take_back ->
  PtyMaster`, `register_recovered(&HeldAgent, &PtyMaster, ..)`), `busy`,
  `keeper_info`, `keeper_protocol`. `busy` says, in this order: runs are being handed to the
  keeper; an unreadable record's exit cannot be saved; an agent is running; an exit is being saved
  or its output drained; the keeper is being started or a start is waiting.

#### preparation

A run's command line, environment, folder, plugin and session following.
`runs/preparation/` (`mod.rs`, `environment.rs`, `folder.rs`, `plugin.rs`, `session.rs`).

- **Owns:** composing a run's command line from its rule (`facade_rules::start_command_line`,
  `resume_command_line`) with Facade's tools and the CLI's installed version, its program started
  directly where the program found on the run's `PATH` is a wrapper (`facade_rules::direct_command`); the run's
  environment, made from the client's by the rule of `env` in
  [`StartArgs`](../../../core/protocol/PROTOCOL.md#startargs) and `FACADE_HOME`. It owns private
  run folders `core/runs/<agent>/<random>/`, with the session
  file, the tool files and a `plugin-folder` note naming the project whose plugin a start placed;
  Facade's plugin in a project's `.agents/plugins/facade/`, the starts holding it and the runs
  using it; one session follower per running run.
- **Keeps:** an agent has at most one run folder, and a folder name is never used again; a resume
  removes the earlier folders before it creates its own. A plugin is written only where it is
  missing, this version's, or an earlier version's or changed one no run uses; a plugin that is not
  Facade core's, or a later version's, is never changed. It goes when the last start holding it
  and the last run using it have ended, and only if it is still this version's or an earlier one's.
  Only CLIs for which `facade_rules::uses_folder_plugin` holds use it. The session file is checked
  by its modified time and size a second after the run's terminal gives output, as a CLI saves its
  session while it works: at most once a second while output goes on, once more a quiet second
  after it, and nothing while the run is idle. It is read when they change, when it names a session
  its CLI has not saved yet, and once more after the run ends; a session that failed to commit is
  sent again a second later.
- **Never does:** touch the registry or the keeper; commit a session itself.
- **Interface** (runs only): `Preparation::new(folders, Arc<Held>, events)`, `prepare`,
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
- `list_row` projects the shared `AgentListEntry`. Its public row contains the canonical address,
  name, kind, state, CLI, title, folder and latest start time. Shell, MCP and the editor use that row.

### windows and locations

The location reader checks the requested directory on the selected machine and returns its repository,
checkouts or ordinary folder. A query without explicit folders can show the login home and recent
Agent directories. The editor can get a hand-entered remote directory's Git kind from `location.list`.
The same start preflight checks the folder and optional worktree branch for every entry point.
Worktree creation serializes writers to the repository's `.worktrees` directory. It uses the current
checkout's HEAD and preserves the branch's path segments.

Workspace migration reads the old SQLite descriptions and memberships. The editor identifies the
legacy machine and exactly one workspace key, logical window ID or instance ID. A workspace key can
name several logical windows. Their full references select members on each Agent's running machine.
The editor retains partial results and continues migration when a known source reaches the network.
An old temporary bridge may require a saved SSH route before its contribution can be read.

### network

The network owns machine handshakes, peer routes, forwarded calls and saved SSH transport. It
advertises the local machine and peers, and observes updates from each authenticated connection.
The parent layer commits the original SSH arguments and remembered routes after verification.
One foreground SSH session runs the remote probe, any needed install and the authenticated stream.
Discovery probes already awake services. An explicit target follows a saved route hop by hop and can
wake the service. Concurrent requests to the same saved hop use its shared attempt.

Online, connecting, sleeping and failed links are distinct. The machine view carries the last
observed time and any raw SSH error. An attempted query can report its own failure separately.
A forwarded operation holds work while it executes, including
when relayed through another machine. Passive subscriptions share the existing links.

### guests

The relay boundary uses its socket peer PID and process birth. A relay joins as a Guest on its first
tool call when it cannot establish a current managed run. The daemon commits its ID and this machine's
YOLO snapshot before publishing it. It keeps the relay's environment for a Guest's starts and uses the
running machine's login home when that Guest supplies no folder.

A surviving relay keeps its Guest ID and inbox across takeover. A sufficiently old record that lacks
the YOLO snapshot takes the machine's migration-time setting once. A Guest's exit closes its online
record and retires its inbox. Its sends use the same creation-tree and delivery rules as managed Agents.

### lifecycle

`lifecycle/` owns work counts and guards, idle exit, a newer build's takeover, the `core/clean-end`
note and `core/logs/daemon.log`. The keeper points the daemon's standard error at the log.
`log_file.rs` prunes lines after 30 days and returns up to 200 lines to the person's clients.

- `begin(Work)` counts the work until its guard drops. The idle decision uses the same lock to
  exclude new work. After five idle seconds it asks the server to pause acceptance, then waits for
  the server, screen writers and exit commits before removing the socket and exiting.
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
  - `agent.type` and `agent.resize` for one agent from one connection run in the order sent, in
    that agent's lane. Typing waiting in a lane is at most 1 MiB of requests; a resize takes no
    room. Without room, a call with a request ID is refused with `capacity_exceeded`; a
    notification waits, and so does the connection's reading, until there is room or the client
    closes.
  - Once the client closes while its input waits, nothing more from it runs.
  - A watch's response, with its snapshot, is sent before any of its changes.
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
    - `hello(HelloParams, peer_pid) -> (HelloResult, Client, Hold)` runs after the server checks the
      applicable protocol range and client kind.
    - `call(&Client, operation, args, WhenFull, Cancel) -> Result<Value>`
    - `watch(&Client, topic, args, viewer) -> Result<Watch>`; `unwatch(&Client, topic, viewer)`
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
  - `Client` carries the connection's client kind and the actor verified by the daemon's private
    MCP connection.
  - `Watch { snapshot, changes }`. `WatchChange::Ended(ErrorBody)` reports a remote watch failure.
    `WatchChange::Disconnect` cuts off a client that fell too far behind.
  - `WhenFull::{Refuse, Wait}`: input without room fails at once (a request ID) or waits until its
    `Cancel`, which the server triggers when the client closes (a notification).

### mcp

The MCP server speaks over the existing version 1 relay handshake. Initialization and tool discovery
are available before a Guest is listed. The first tool call locks the identity of its connection.
Runs generate a private, unpredictable credential for each new run and Rules put it in that launch's
MCP arguments. The verifier waits for that run's installation and uses its keeper PID, birth and run
generation. A verified CLI-native session can also identify a matching live run. A run recovered
from protocol 2 may keep its earlier recognition rules until that run ends. Resume has a new
credential scope even when it uses the same Agent ID.

At initialization the parent can verify a managed run and render its instructions from the installed
record. It uses the same address, creation source and run context as launch preparation. The parent
checks the run again before returning the text. Connections whose run is still unknown receive the
general tool instructions.

The parent hands the verified actor to the private daemon connection. Only the validated process
can bring a run's tools online. The connection rechecks the run when it sends a new request. A
waiting inbox read also ends with its bound run, and Post checks the bound actor while it settles
the available page.

There are eight tools. They use the same targets, machine routing and operation requirements as
other daemon clients. `list_agents` returns the complete working roster, and `read_screen` includes
the requested lines. `read_messages` filters its page before delivery and commits only the complete
messages that the reply includes. `after` and `last` read history, and `wait` can wait up to the shared
delivery deadline, including for a specified reply. A successful send by a Guest returns the
`read_messages` arguments it can use to wait for that reply.

## Reading the code

1. `lib.rs`: `run`, `start_and_serve` and the `Daemon` value.
2. `service.rs` dispatches protocol operations and projects public records.
3. `operations.rs` starts a run in `start_in` and handles `resume` and `remove`.
4. `delivery.rs` routes sends in `route_send` and hands terminal input to the actor in `hand_input`.
5. `store/mod.rs`: `Store::open` and the cross-table transactions.
6. `recovery.rs`: `recover`, which lists the agents before clients are served.
