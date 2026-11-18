# Daemon

The daemon manages the agents of one Facade home and serves its clients: the editor, the `facade`
commands, the hooks and the relays of the CLIs' MCP servers. It is the crate `facade-daemon`
(`core/crates/daemon/`). `facade daemon` runs it through its one public function, `run`. This layer
joins the child islands and serves calls and subscriptions for this home from other machines.

## Owns

- The local agent list, by agent ID, with a handle for each record. The editor's view adds records
  from the machines where its windows' other agents run.
- `core/facade.db`, its schema and its one connection. It keeps this machine's ID, logical
  windows, agent memberships, each run's location source, saved SSH connections, and the IDs and
  names of machines this home has seen. The parts get handles of their own tables. The first open
  creates the schema and counters in one transaction. Each write across tables is one transaction.
- The `agents` topic's changes, which every listed agent's record goes out on.
- The starts under way with a request ID, so that a repeated start waits for the first one's response.
- What each open watch lets go of when it ends: a screen viewer, or a window's watch that lets Facade
  tell the person.

## Keeps

- The parts never call each other or this layer. Each gets what it needs when it is made, and reports
  back through return values, event channels, a trait or a closure.
- Lock order: the agent list's lock first, then at most one part's lock, taken inside that part's
  method. The parts' locks never nest; the keeper link's lock and each actor's record are leaf
  locks.
- A start writes its record, initial members, location source and any prompt together. Removal
  deletes an agent's record, members and inbox together. An agent starting on another machine
  binds its prompt result to a number reserved on its creator's machine. A result reaches that
  inbox only while the creator's record has no exit or its guest record is still kept.
- The source daemon resolves addresses and establishes the caller from its local connection.
  The running machine decides reach from the caller's complete creation-tree root and YOLO.
- A person message has one number on its sender's machine. That machine records which member
  windows accepted the change, declined it or have an unknown outcome. Replies use the original
  message's machine ID and number.
- The cross-island orders (start, paste, session, output, removal and window binding, guest join
  and end) are kept as [ARCHITECTURE](../ARCHITECTURE.md) states them.
- Clients are accepted only once recovery has listed every readable agent.
- A stop lets go of the actor's copy of the terminal's signal pipe, then keeper_link's, before the keeper
  is asked to stop: on Windows the pseudo console hangs up only once every copy is closed.
- The most recent member editor to resize an agent supplies its terminal colors. A run can start
  with colors from its creating window, the parent's member source, or the first member with
  known colors. The source's theme changes apply while it is the source. In-memory colors survive
  disconnect and resume, and a restarted daemon restores them from a member description or resize.
- A window's `env` stays in windows' memory: never in the store, a log or a response. From it and the
  window's first folder, an `ide` client's `windows` watch lists the CLIs each window can start, worked
  out for each snapshot and change, as an agent client's are.
- An `ide` client's `numbers_given` raises the agent counter through records and the message counter
  through messages before `hello` responds; a counter is never lowered.
- The daemon exits only after five idle seconds in a row, decided under the lock that accepts work.
  A running agent, a listed guest, a machine session or a saved connection keeps the daemon active.
- `impl Daemon` exists only in this layer's files.
- One actor task per agent, on a multi-thread tokio runtime; blocking work goes to blocking workers
  or runs in place.

## Never does

- Branch by operating system: base's platform does.
- Name a CLI or branch by one outside tests: rules does.
- Change the daemon protocol, the MCP tool definitions or their golden files.

## Interface

- **`facade daemon`**: `facade_daemon::run() -> anyhow::Result<()>`. The keeper starts it in the
  background; it also runs in the foreground. It reports a failed start on the startup channel.
- **Clients**: the daemon protocol on the daemon socket, as
  [PROTOCOL](../../../core/protocol/PROTOCOL.md) describes it: operations and the agents, machines,
  windows, messages and screen topics. `daemon.log` gives the person's clients the log's last 200
  lines at most, the home folder written `~`; a call for an agent or a guest is refused.
- **Relays**: a hello with `relay` makes the connection a relay's; its lines are MCP, which the mcp
  island responds to.
- **Machines**: a machine hello or a terminal person's `machine.connect` hands the connection to
  the machine session layer after the server flushes the authorization response.
- **The keeper**: the keeper protocol, as [KEEPER](../../../core/protocol/KEEPER.md) describes it,
  through runs' keeper link.
- **Files** under the home's `core/`: `facade.db`, `screens/<id>/`, `runs/`, `results/`,
  `logs/daemon.log`, `clean-end`.

## Depends on

- [base](base.md): the protocol types and framing, the daemon client (the MCP tools use it in
  process), paths, settings, the service lock and startup channel, programs and launchers, process
  observation, private files, the texts given to models.
- [screen](screen.md): an agent's terminal grid.
- [rules](rules.md): the rule files; command lines; input, state and session reading; wiring and
  integrations.
- Third-party: tokio, rusqlite, serde.

## Inside

The layer's files:

| File | What it does |
|---|---|
| `lib.rs` | `run`, startup and serving, the `Daemon` value, the values the parts share, the hourly sweep. |
| `store/` | `facade.db`: the schema, the cross-table transactions, the table handles. |
| `operations.rs` | Start, resume, stop, remove, rename, a run's exit, the environment of an agent's CLI. Resume distinguishes a session the CLI has not saved yet from one never reported. |
| `delivery.rs` | `agent.send`, start prompts, results, and input handed to an agent. |
| `presence.rs` | Joins and ends guests, handles window binding, and stops runs whose location source reports their folder gone. |
| `topics.rs` | Watch snapshots, changes, resyncs, and what a watch's end lets go of. |
| `remote_agents.rs` | One member subscription for each reachable machine, with pending, synced and unreachable states. A synced event carries that machine's complete records. |
| `machine_service.rs` | Machine authorization, saved connections, names and the machines view. |
| `network_operations.rs` | Address resolution, one-time queries, and routing and dispatch of machine calls and watches. |
| `relays.rs` | Relay hellos, the in-process connection the MCP tools use, MCP members. |
| `service.rs` | The server's `Service` trait for the daemon: hello, calls, watches, relays. |
| `recovery.rs` | Recovery at startup: agents, their runs and screens, messages left pending. |
| `command_line.rs` | Which CLI a start or resume runs, from the settings file and rules. |
| `waits.rs` | A started agent's long waits, sent to its creator. |

**Values the parts share**: `HUMAN` (the person's ID), `Sender` (an agent and its name then, or the
person), `Caller` (the authenticated identity carried across machines), `Cancel` (a call's
cancellation), `ToolsGiven` (how a run's CLI got Facade's tools), `SavedConnection` (the machine
ID, SSH destination and optional Facade home shared by store and network), and the test gates and
`blocking_in_place`.

**Table handles**: `NumberTable` to records (agent numbers), `MessageTable` to messages,
`GuestTable` and `IntegrationTable` to guests, `WindowTable` to windows. A handle holds the store and
offers only its table's methods.

**Startup** (`start_and_serve`) takes the home's daemon lock and exits if it cannot get it. It takes
the clean-end note, holds this build's programs open, makes runs, finds the keeper, opens the store,
makes the other parts and sweeps. It recovers agents, guests and pending messages, then restores
every persisted window as disconnected. It releases plugins no run uses and serves the keeper
link. It starts the tasks that follow runs, guests, results, long waits, machine sessions and
routes, restores saved connections, and starts the hourly sweep. It then binds the socket,
reports the start and serves until idle.

**What each part gets and how it reports back**:

| Part | Gets when made | Reports back |
|---|---|---|
| agent | per actor: its terminal's `PtyMaster`, screen start, messages' delivery handle, the `agents` topic's sender | its handle's methods and replies; changes on the topic |
| messages | `MessageTable` | return values; a receiver of the results it wrote |
| runs | the home, the held programs, a `RunEvent` sender; per run, an `ExitSink` | `RunEvent::Exited`, `RunEvent::Session` (acknowledged once committed) |
| records | `NumberTable` | return values |
| windows | the machine ID and `WindowTable` | return values and changes on the `windows` topic |
| network | the local machine introduction, the SSH control directory and an event sender | session events, new routes, and calls and subscriptions addressed to this machine |
| guests | `GuestTable`, `IntegrationTable`, the held programs, a `GuestEvent` sender | `GuestEvent::Ended`, `GuestEvent::TurnIdle` |
| lifecycle | the `LifecycleActivity` implementation and the idle pause channels | work guards, draining refusals, `closing`, the clean-end fact |
| server | the `Service` implementation, the idle exit's `closing` and `paused` | trait calls into this layer |
| mcp | per relay: a `Connect` closure and a `JoinMember` closure | return values |

**Tasks**: the server's accept loop and one task per connection and call; one actor per agent; the
tasks that follow `RunEvent`s and `GuestEvent`s; the result deliveries; the long-wait
follower; the hourly sweep; the idle exit.

**The hourly sweep**: guests not heard from for 30 days end; messages older than 30 days go; result
files no one can use go; log lines older than 30 days go.

**Long waits** (`waits.rs`): the layer follows the `agents` topic. An agent another agent of the
same window started, that has waited 20 seconds in a row on its permission, question or sign-in,
is reported to that creator once each time it starts waiting, as a Facade result, while the
creator runs. Nothing wakes the follower but a change of the agents or the twentieth second of
the next such wait. A guest creator finds it in its inbox at its next turn. The person never gets
a message from it ([RULES](../../extension/RULES.md) 1.8).

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
  - The actor applies a committed member set, publishes its current record and then answers the
    daemon through `UpdateWindows`.
  - A CLI waiting for the person or reporting an error is published at once; other changes of the record within 200 ms go out together.
  - At most `MAX_INPUT_BYTES` (1 MiB) of input waits; more is refused with the input given back.
  - Quiet replies only once no read is under way and what the last reads brought went through the screen log; `LetGoBeforeStop` lets go of the signal pipe and nothing else.
- **Never does:** touch the database; know other agents; decide when a run starts or ends; type into a terminal that is not Facade's.
- **Interface:**
  - `spawn(ActorStart, rx, tx, changes) -> anyhow::Result<AgentHandle>` and
    `spawn_with_color_source(ActorStart, rx, tx, changes, Option<WindowRef>)`. `ActorStart` carries the record, the terminal's `PtyMaster`, a `ScreenStart` (`New(folder)`, `Recovered { screen, log, handed_over_cleanly }`, `Released`), the rule name, the messages' `DeliveryHandle`, a `StateStart`, and the window's `TerminalColors`, which its screen replies to color queries with from the first output on.
  - `AgentHandle`: `guest(info)`, `id()`, `info()`, `is_guest()`, `rule()`, `run()`, `exit()`, `settled()`, `output_seen()` (marked at each output of the terminal), `input_room_changed()`, `send(AgentCommand) -> bool`, `is_closed()`, `mailbox()`, `lock_run_change()`, `installed_record()`, `color_source()`, `tools_connected() -> ToolsConnection` (dropping it closes the connection), and for guests and windows `set_guest_state`, `mark_ended`, `set_yolo`.
  - `AgentCommand`: input (`WriteInput`, `Resize`, `ResizeFromWindow`), viewing (`AddViewer`, `RemoveViewer`, `ReadScreen`, `Inspect`), run events (`ProcessExited`, `RecordSession`, `PrepareRestart`, `InstallRun`, `AwaitPrompt`, `StartPrompt`) and control (`Rename`, `Remove`, `Quiesce`, `LetGoBeforeStop`, `SettlePaste`, `WindowColorsChanged`, `UpdateWindows`). `Input` is `Raw` keys, `Typed` text or keys, a `Message`, or a `BegunPaste` to finish.
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
  - A message counts as delivered only once the input box is usable again after its Enter.
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
Numbers every Facade message (#mN), keeps the deliveries still open, and settles each one once: through the recipient's typist, a read, its deadline or the person's window subscriptions.

- **Owns:** the open deliveries, in memory behind one lock, each with its message, whether its paste began, and the result it owes; the `messages` and `message_numbers` tables, through `MessageTable`; the changes for the `messages` topic; the results start prompts write, until the daemon takes them.
- **Keeps:**
  - Only messages gives out #mN.
  - The table records each fact before anyone acts on it: a message before its send gets a response, a paste before it is typed, a read before its snapshot is returned, a settlement before the send learns it.
  - A message is settled once. A typist and a read never both take it: a read before the paste means it is never typed; a read during the paste delivers it with what reached the terminal unknown.
  - A message is withdrawn only while none of it can have been typed: on `cancel`, or when it fails with nothing typed. A start's prompt is never withdrawn: a first task that times out stays in the inbox.
  - Settling a start's prompt writes the result it owes in the same transaction, and only if the caller is still there.
  - A request ID finds the message it kept for an hour. A person message has one stored number
    and one settlement for all windows, or is withdrawn when no subscription accepts it. A repeat
    can wait for the in-flight settlement, reuse its saved receipt or report an interrupted
    settlement as pending. Window snapshots include the messages delivered to that window.
  - Messages are kept 30 days (`KEPT_FOR`).
- **Never does:** reads the agents or guests tables; types into a terminal; finds an agent; deletes an inbox (the daemon does, in the transaction that removes its owner).
- **Interface:**
  - Daemon layer:
    - `Messages::new(MessageTable)`, `raise_above(given)` (every `#mN` above `given` from then on; blocks), `delivery_handle()`, `take_results() -> Option<Receiver<PostedResult>>`, `subscribe() -> Receiver<Change>`
    - `post(Message, request_id) -> Posted`, `begin_human(Message, request_id) -> PostedHuman`,
      `finish_human(&Message, WindowDelivery) -> SendResult`, `find_request(from, request_id) -> Option<Earlier>`, `withdraw(number) -> bool`
    - `deliver_prompt(Message, Option<OwedResult>)`, `begin_prompt(number, deadline, from_name) -> Option<Message>`
    - `settle(numbers, Outcome)`, `settle_by_deadline(number, &mut settled, deadline)`
    - `read(owner, &MessagesWatchArgs) -> MessagesSnapshot`,
      `read_human(&WindowRef, &MessagesWatchArgs) -> MessagesSnapshot`, `take(owner) -> Vec<Message>`, `inbox(owner)`, `message(id)`, `in_inbox(owner, id)`
    - `drop_inbox(owner, gone)`, `expire(now) -> usize`, `keeps(number) -> bool`
    - At a restart: `pending()`, `paste_messages(paste)`, `take_up(Message, pasted, Option<OwedResult>)`, `decide(&Message, paste, Recipient, now) -> TakeUp`
    - Types: `Settled` (`Kept`, `Withdrawn`, `Cancelled`), `Posted`, `Earlier`, `Change`, `PostedResult`, `Due`, `delivery_limit()`, `number(&Message)`, `KEPT_FOR`. `OwedResult { number, agent }`, where `agent` is a closure the daemon gives that returns the started agent's record as it is when the prompt settles.
  - The agent's typist, through `DeliveryHandle`: `still_to_type(number) -> bool`, `begin_paste(numbers) -> Option<Vec<u64>>` (the numbers it may type; None when the table could not record the paste, so nothing is typed), `settle(numbers, Outcome)`; `Outcome` (`Typed`, `Failed { reason, text_written, enter_written }`, `UNCONFIRMED`, `untyped(reason)`).

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
    `reservation.wait_for_keeper()`, `prepare(RunRequest) -> PreparedRun` (its `location_id` is
    the one its instructions name; its `kind`, `RunKind::{Start, Resume}`, says whether it is the
    agent's first run, whose folders it makes, or a resume; its `session`, the session the command
    line continues, a resume's or a start's), for a resume
    `previous_run_ended(id, timeout)` and `replace_folders(id, &prepared)`, then
    `start(reservation, id, number, &prepared, cols, rows, ExitSink) -> StartedRun { pid, master }`.
    Once the agent is listed, or a resumed run installed:
    `installed(id) -> Option<ProcessExit>` (an exit that came first) and
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
  [`StartArgs`](../../../core/protocol/PROTOCOL.md#startargs), with `FACADE_HOME` and `FACADE_AGENT`
  added; run folders `core/runs/<agent>/<random>/`, readable only by their owner, with the session
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

Agent IDs, default names, and what a reference names within a client's reach (`records.rs`).

- **Owns:** the default names held for starts not yet listed; the IDs of agents whose records this version cannot read; the 140 default names, the same list as `extension/src/base/names.ts`. It reaches the database through `NumberTable` and `MembershipTable`.
- **Keeps:** every `#aN` comes from the number counter, committed before it is used, so no ID is given twice, even after a failed start. A default name is free across the agent's member windows, ignoring case and surrounding spaces, and no other start holds it; when none is free, the name is the ID, such as `#a7`. A reference names one agent or the person, or fails: an ID outside reach is refused, a name only names agents in reach, and a name several agents have is ambiguous. `#human` always names the person; `human` and `@human` name the person unless an agent in reach has that name.
- **Never does:** hold agent handles (it reads only `AgentInfo`); touch any other table; take the agents lock (the daemon passes in what it needs).
- **Interface:**
  - `Records::new(NumberTable, MembershipTable)`; `next_id() -> Result<String, ErrorBody>` (async, `a<N>`); `raise_above(given)`, after which every `#aN` is above `given` (blocks); `reserve_name(windows, listed, id, names) -> String` and `release_name(name)`, where the caller holds the agents lock; `add_window(agent_id, &WindowRef)` returns the committed sorted membership of an existing agent; `keep_unreadable(ids)` once at startup; `is_unreadable(id)` during recovery.
  - `reach_of(caller, info) -> Reach`: the person, or an agent whose run has YOLO on, reaches all agents; an agent whose run has YOLO off reaches its creation tree. `Reach::reaches(&AgentInfo)`.
  - `resolve(agents, reference, reach, running_only) -> Result<Named, ErrorBody>`, with `Named::Agent(id)` or `Named::Person`. With `running_only`, agents that have ended are left out when matching by name.
  - `agent_number(id) -> u64` to sort by; `normalize_agent_reference(reference)`: `a3`, `#a3` and `3` all become `a3`.

### windows
Logical editor windows and their connections, subscriptions and locations. `src/windows/`.

- **Owns:** each logical window's allocation order and latest instance, its current generation,
  connections, person-message subscriptions and location readings. The window table keeps the
  logical ID, instance and description, including the workspace. Environment variables and
  colors stay in memory. The terminal is listed by the daemon.
- **Keeps:**
  - A hello binds to the same known instance, otherwise to the first disconnected logical
    window of the same workspace by allocation order, otherwise to a new logical window. It
    saves the binding before returning its connection guard.
  - A binding gate orders description writes. Inside the gate, the leaf lock protects the
    current generation and connections, and is released for a table write. A new instance
    advances the generation. Late updates, disconnects, subscriptions and Git reads are checked
    against their binding.
  - Closing the last connection clears the window's subscriptions and publishes it as
    disconnected. The saved logical ID and instance remain available to another hello.
  - At startup, before accepting clients, restores each saved window as disconnected, including
    windows without a workspace. An agent that runs elsewhere can still have one as a member.
  - A person message counts a window after a current subscription accepts the queued change.
    Delivery uses the generation and viewers observed before the message took a number.
- **Never does:** stop or move agents; read the agent list; run Git (locations does that).
- **Interface:**
  - `Windows::new(machine_id, WindowTable)`, `restore()`,
    `bind(WindowDescription) -> (WindowConnection, Vec<String>)`, and
    `update(&WindowBinding, WindowDescription) -> Vec<String>`. The folder list is the previous
    description's. The guard's `binding()` identifies the logical window and generation.
  - `is_current(&WindowBinding)` checks that the binding still has a connection.
    `colors_for_binding(&WindowBinding)` checks the binding and reads its colors under one lock.
  - `watch_person(&WindowBinding, viewer, sink) -> PersonWatch`,
    `person_target(&WindowRef) -> PersonTarget`, and `deliver_to_person(&PersonTarget, change)`.
  - `check_member(&WindowRef)`, `label(&WindowRef)`, `colors(&WindowRef)`, `folders(id)`,
    `env(id)`, `infos()` and `subscribe()`.
  - `check_destination(Option<&WindowRef>, cwd)` returns a directory and location ID for a
    start. `create_worktree(WorktreeCreateArgs)` uses the requested logical window or terminal.
    An editor worktree starts at an exact location. `read_locations(&WindowBinding, folders)`
    and the optional read from worktree creation carry their generation to the daemon.

#### locations
A window's locations, read from its folders through Git, and the worktrees made there. `src/windows/locations.rs`.

- **Owns:** `Catalog`, which holds the locations, the folder that brought each one, and the problems of the read. `Creations` holds one turn for each `.worktrees` folder. Both are values that `Windows` holds.
- **Keeps:**
  - For each folder, the locations are the repository's main checkout, then the folder itself where it is another place, then the other worktrees by branch and path. Paths have links resolved, and each place is listed once; folders are compared as the system compares them (`files::folder_key`: on Windows without regard to letter case or `/` against `\`). A folder outside any repository, or a machine without Git, still gives the folder as a location.
  - A folder that cannot be read keeps the locations that the last read gave it, and the failure is a problem. A failed read never proves that a location is gone.
  - Git starts through `programs::command`, which opens no console window. It runs from an argument list, never through a shell, without the 8 variables that point it at another repository or a prompt program, with optional locks off, prompts off and English messages. A read waits at most 10 seconds, and `worktree add` at most 120 seconds.
  - A worktree goes to `<main checkout>.worktrees/<branch folder>`, with the first free suffix. A creation is refused before any change for a folder outside any repository, a repository with no commit, a base that is not a commit, a branch name Git refuses or already has, or a folder name some system cannot hold. Creations into one `.worktrees` folder take turns, waiting at most 120 seconds, and the branch is checked again in the turn. When Git fails partway, the error's `data.kept` says what was left.
- **Never does:** touch windows, send changes or write the table.
- **Interface** (called by `windows`):
  - `async read(folders: &[String], before: &Catalog) -> Catalog`.
  - `Catalog::locations() -> &[LocationInfo]`, `problems() -> &[String]`, `location(path) -> Option<&LocationInfo>`, `holding(path) -> Option<&LocationInfo>` (the innermost location that is `path` or holds it), `left_by(folders) -> Vec<String>` (the paths that only folders no longer in `folders` brought).
  - `async create(source: &Path, worktree: &Worktree, branch_prefix: Option<&str>, creations: &Creations) -> Result<LocationInfo, ErrorBody>`: returns the new location, of kind `Worktree` and labelled with the branch.

### network

The machine sessions, their routes and the SSH processes they use. `src/network/`.

- **Owns:** directly connected machines, saved connections' running SSH processes and retry state, the
  current machine table, and the calls and watches passing over each connection.
- **Keeps:**
  - A session becomes usable once both ends accept the introduction and its first machine table.
    Later tables from a directly connected machine replace its previous table. Routes with the same
    machine and boot IDs may coexist. A machine ID with two live boot IDs is refused.
  - The shortest route wins; equal lengths are ordered by next machine ID. Each call or watch
    uses its original route for its lifetime. A forwarding hop uses the outer route and deadline
    and passes the original caller and payload onward.
  - Closing a session ends its calls, subscriptions and watchers. Saved SSH connections try
    again every ten seconds and pause when SSH needs the person to interact.
- **Interface:** `Network::new`, `local_hello`, `check_peer`, `machines`, `rename_local`,
  `accept` and `connect` for authorized streams, `start_saved` and `remove_saved`, and async
  `call` and `watch`. `Event::Target` delivers a call or subscription with its cancellation and
  response channels. `Event::RoutesChanged` supplies the current machine table.

### guests

The agents the daemon lists but did not start, and the integrations through which they come: `guests/`.

- **Owns:**
  - The in-memory roster, under one lock (`roster.rs`): each guest by CLI and session; the sessions that are part of another (a subagent's); the CLI process whose end ends a session; each guest's environment and current turn; each member by its relay.
  - The `guests` and `integration_files` tables, through the `GuestTable` and `IntegrationTable` handles the daemon gives it.
  - The files Facade writes into a CLI's user settings for its integration, and the CLI's own program run to add or remove Facade's server (`integration/`).
- **Keeps:**
  - A guest is known by CLI and session, a member by its relay process (pid and birth), never by the CLI's processes.
  - One session joins once: the daemon joins under `joining()`.
  - A member's record is a guest record: `cli` is the client's name (`mcp` where it has none fit to list), `session` is `relay-<pid>-<birth>`. No other table or column.
  - One integration is written or taken out at a time. Every file's new text is made before any is written. Taking an integration out puts back, byte for byte, a file nothing changed since; from a changed file it takes only entries certainly Facade's, and says which stay.
- **Never does:** allocate #aN or names (records); build agent handles or list agents (daemon); delete a guest's inbox (the daemon's transaction); know a CLI by name (asks `facade_rules::integration`).
- **Interface:** (called by the daemon layer)
  - `Guests::new(GuestTable, IntegrationTable, Arc<Held>, UnboundedSender<GuestEvent>)`
  - Hooks: `find(&HookSession) -> (HookSession, SessionMatch)`, where `SessionMatch` is `Guest(id)`, `Part(id)` or `New`; `joining()`; `guest_of(cli, session)`; `Guests::info_of(id, name, &HookSession) -> (AgentInfo, GuestRecord)`; `keep(&GuestRecord)` before the daemon lists the guest; `register(id, &HookSession)` after; `heard_from(id, cli, session, pid)`; `follow_turn(id, &HookSession)`; `keep_environment`, `environment(id)`.
  - Members: `member_of(&RelayProcess)`; `Guests::member_info(id, name, client, &RelayProcess, cwd)`; `register_member(id, &RelayProcess)` after listing; `end_member(&RelayProcess) -> Option<id>`.
  - Ending: `end(cli, session) -> Option<id>` lets go of a session and its parts; the daemon then unlists the guest and deletes it with its inbox. `GuestEvent::Ended { cli, session }` asks for that when a watched process ended; `GuestEvent::TurnIdle { id }` says the CLI's status file shows the turn ended without a hook.
  - Start and cleanup: `restore(kept_since) -> Restored { listed, ended }` (guests last heard from before the machine started or before `kept_since` end); `unheard(before) -> Vec<(cli, session)>`; `any_guest()`; `whole_sessions(&[session])`.
  - Integration: `integration_add`, `integration_remove` (`IntegrationArgs -> IntegrationInfo`), `integration_list` (`IntegrationsArgs -> IntegrationsList`), `bring_integrations_up_to_date()`.

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
    - `hello(HelloParams, peer_pid) -> (HelloResult, Client, Hold)`: after the server checked the
      protocol versions and kind. `Hold` (such as a window's presence) is kept until the connection
      closes.
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
  - `Client { identity, window, agent }`: who the connection is, as its hello settled it.
  - `Watch { snapshot, changes }`, `WatchChange::{Change(Value), Disconnect}`: `Disconnect` cuts
    off a client that fell too far behind.
  - `WhenFull::{Refuse, Wait}`: input without room fails at once (a request ID) or waits until its
    `Cancel`, which the server triggers when the client closes (a notification).

### mcp

The MCP server behind each relay connection: it responds to the MCP client's JSON-RPC lines and turns each of the 8 tools ([MCP.md](../../extension/engineering/MCP.md)) into daemon protocol calls. Directory `core/crates/daemon/src/mcp/`.

- **Owns:** each relay connection's state (`Relay`: its hello, the relay's process, the member it serves, its `send_message` calls under way, the connection that shows an agent's tools are there); the result files in `core/results/`, for results longer than 8,000 characters: their names (`screen-…`, `messages-m<first>-…`, `agents-…`), writing them (private, in a private folder) and deleting them.
- **Keeps:**
  - Every tool call reaches the daemon over a protocol connection of its own, opened through `Connect`, so it passes the same checks as any client and a slow send holds up no other call.
  - Every request gets exactly one response, a cancelled `send_message` included.
  - A tool call's request ID is `facade-<pid>-<start time>-<id>`, the same at every daemon, so a call the relay gives the next daemon after a take over repeats what the first did.
  - A relay with neither `--guest` nor `FACADE_AGENT` serves no tools until its MCP client sends `initialize`; it then joins as a member through `JoinMember`, once per relay, and its tools act for that member.
  - A screen's result file is deleted after 30 days; a messages' file once its first message is no longer kept; an agents' file stays.
- **Never does:** holds `Daemon` or calls a sibling; changes the tool definitions (`facade_base::tools::DEFINITIONS`); reads a member's inbox to count its messages, since reading delivers them.
- **Interface** (called by the daemon's relay code and the hourly sweep):
  - `Relay::of(params, pid, birth, connect: Connect, join: JoinMember) -> Result<Relay, ErrorBody>`: checks the hello and its contract version.
  - `Relay::serves() -> Serves` (blocking); `serve_member(id)` after a restart finds the relay's member again; `reconnect() -> bool`; `notice(line) -> bool` as a line is read (notes or cancels a send); `respond(&Serves, line, arrived) -> Option<Value>` (blocking); `hold_presence(agent)`.
  - `enum Serves { Agent(id), Guest(cli), Member(id), Nobody, Aside }`.
  - `type Connect = Box<dyn Fn(&Identity) -> anyhow::Result<Option<DaemonClient>>>`: None while the daemon is taking over.
  - `type JoinMember = Box<dyn Fn(Option<&str>) -> Result<String, ErrorBody>>`: the client's `clientInfo.name` to the member's ID.
  - `RELAY_CONTRACT` (1), the version the relay hello names; `internal_error()`, the response to a line whose answering failed.
  - `results_folder(core) -> PathBuf`; `clean_results(folder, now, kept: &dyn Fn(u64) -> bool)`.


## Reading the code

1. `lib.rs`: `run`, `start_and_serve` and the `Daemon` value.
2. `service.rs`: `call`, which maps every protocol operation to the layer's methods.
3. `operations.rs`: `start_in`, the order a start keeps; then `resume` and `remove`.
4. `delivery.rs`: `send` and `hand_to_typist`.
5. `store/mod.rs`: `Store::open` and the cross-table transactions.
6. `recovery.rs`: `recover`, which lists the agents before clients are served.
