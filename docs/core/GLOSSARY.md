# Glossary

One meaning, one word. New code, documentation comments, logs, error messages, test names and the text Facade core gives
people and models use the words below. Where a person sees a word, in a command, `--help`, an MCP tool, the settings
file or a model's instructions, the code uses that word too. Some older names in the code still differ; [Names not yet
changed](#names-not-yet-changed) lists them, and a change that touches one renames it.

Each table gives the word to use, what it means, and the words not to use for that meaning. A word in "Not these" may still
have a meaning of its own elsewhere in this glossary.

Other programs and protocols keep their own words: the standard library's `spawn` and `create_dir`, JSON-RPC's `id` and
`result`, alacritty's `scrolling_history`, Antigravity's `conversationId`. Names already on the wire keep their spelling for
now; [Names on the wire](#names-on-the-wire) lists those that differ from this glossary.

## Agents and runs

| Use | Means | Not these |
|---|---|---|
| agent | A CLI session Facade knows, with its own ID such as `#a3`: a run Facade started, or a guest | — |
| run | One CLI run Facade started, from a start or a resume until it ends | process, child, session (for this) |
| process | An operating system's process: its ID, its group (on Windows, its job), its exit | run (for this) |
| session | A CLI's own session, the one it can resume | conversation |
| guest | A CLI session a person started that joined Facade through an integration | — |
| MCP member | An MCP client that neither Facade started nor a CLI's hooks report, listed as a guest through its relay | — |
| CLI | One of the coding CLIs Facade runs, such as Claude Code or Codex; `facade` itself is not one | tool, client (for this) |
| rule | A CLI's built-in knowledge file, `core/rules/<cli>.json` | — |
| entry | An item of `clis` in the settings file, named by its CLI's name, as `ErrorData.entry` gives the entry that caused an error | setup |
| not installed | A built-in CLI whose entry has no problem and names no program of its own, and whose program is not found where a start would run, `CliInfo.not_installed` | missing, absent |
| command line | The program, arguments and environment a CLI starts with, `CommandLine` in code | launch |
| record | An agent's record: its ID, name, CLI, folder and reach, kept in the store | — |
| numbers given | The highest agent and message numbers an editor gave before it used core, `NumbersGiven`; core's next numbers are above them | — |

## Starting and ending

| Use | Means | Not these |
|---|---|---|
| start | Start a new agent; also start Facade's keeper or daemon | create, launch |
| spawn | Create an operating system process, as `std::process::Command::spawn` does | — |
| resume | Run an ended agent again in its session, keeping its ID: a new run of the same agent | restart |
| continue | Run a CLI in one of its sessions again: `agent.resume` continues an ended agent's session as the same agent, `agent.start` with `session` continues a session as a new agent | resume (for a new agent) |
| stop | Facade ending a running agent: a hangup, then a kill at the deadline | terminate |
| remove | Delete an agent's record, stopping it first if it runs | delete, forget (for this) |
| end, ended | A run that no longer runs, for any reason | finish, gone |
| exit | A process's own exit code or signal | — |
| kill | Send SIGKILL; on Windows, end the CLI's job (`TerminateJobObject`) | — |
| hang up | Send SIGHUP; on Windows, close every copy of the pseudo console's signal pipe, so that the console host ends it | — |

## Messages

| Use | Means | Not these |
|---|---|---|
| message | A Facade message, with its number such as `#m12` | mail, letter, note |
| send | Put a message on its way | post |
| deliver, delivery | Bring a message to its recipient: type it into the CLI's input, or let the recipient take it | hand over |
| take | A guest's hook or a reader collecting the messages that wait | — |
| inbox | The messages waiting for one agent | mailbox |
| settle | A delivery getting its outcome: delivered or failed | — |
| withdraw | Take a message out of the inbox before its paste began: its send was cancelled, or it failed before a byte was typed | retract |
| result | A message Facade itself sends about a delivery, shown with 🔔 | notice |
| person | The one using Facade; the person's ID is `human`, written `#human` | user |
| sender, recipient | Who sent a message and who it is for | from, to (outside the wire fields) |
| first prompt | The task an agent is started with, delivered once its CLI is ready | — |

Public `facade` help and the text the command line writes call the person "the human". Where a command prints the
identity itself, it uses `human`, as in `Started by: human`. Help addresses the reader as "you".

## Input

| Use | Means | Not these |
|---|---|---|
| input | The bytes written into a terminal | — |
| input box | The CLI's field where text is typed before Enter | — |
| draft | The text in the input box that was not entered yet | — |
| hint | Text a CLI draws in its empty input box that is not a draft, dim or colored, such as a suggestion | placeholder (for this) |
| probe | A space typed into the input box and taken back, to tell a hint from a draft where a reading cannot | — |
| type | Write text or keys into a terminal, as `agent.type` does | — |
| typist | The one writer of an agent's automatic input: messages, the first prompt, typed calls | — |
| paste | The typist putting a message's text into the input box as a bracketed paste | — |
| confirm | The CLI showing it accepted a paste, as in `submission_unconfirmed` | settle (for this) |
| said | The text last entered into the input box | — |
| readiness | Everything between a run's start and its first prompt: answering the trust question, waiting for the tools | warmup, boot |
| answer | Respond to a CLI's own question on screen, such as its trust question | — |

## Screens and viewers

| Use | Means | Not these |
|---|---|---|
| screen | What an agent's terminal shows, and the `Screen` that computes it | view (for this) |
| terminal | A terminal without a display; the pseudo-terminal an agent's CLI runs in, on Windows a pseudo console | tty |
| terminal app | The program a person sees terminals in, such as Terminal or iTerm, named by `TERM_PROGRAM` | — |
| output | The bytes a terminal writes | — |
| scrollback | The lines that scrolled off the top of a screen | history |
| redraw | Draw a whole screen again for a viewer | repaint, refresh |
| screen log | An agent's screen changes, logged on disk before the screen takes them | — |
| checkpoint | A saved screen in the screen log, which a recovery replays from | snapshot (for this) |
| replay | Rebuild a screen from its log | — |
| query, reply | A terminal's question, such as a cursor position request or a color query (OSC 10, 11 and 12), and the terminal's answer to it | answer (for this) |
| terminal colors | The foreground, background and cursor colors an editor window's terminals draw with, `TerminalColors`; its agents' screens reply to color queries with them | theme, palette (for this) |
| client | A program connected to the daemon: a `facade` command, the relay, an editor | — |
| viewer | A client showing an agent's screen | subscriber, watcher |
| watch, topic, snapshot, change | A client's subscription to a topic, what it gets first, and each change after | — |

## Calls, responses and errors

| Use | Means | Not these |
|---|---|---|
| operation | One of a protocol's operations, such as `agent.start` | — |
| response | What a protocol request gets back from the daemon, the keeper or an MCP server | answer |
| reply | What a command inside a process gets back, through a oneshot channel | answer |
| notification, notify | A request that gets no response | tell, told |
| request ID | The ID a caller gives a call so that it can repeat the call safely | call ID, idempotency key |
| repeat | A call that comes again with the same request ID; the response says `repeated` | again |
| retry | Facade trying again on its own | again |
| cancel | A caller calling off a call that is under way | abort |
| refuse | The daemon not taking a call, and saying why | reject, deny |
| fail, failure | Something done that did not succeed | — |
| reason | The kind of a failure on the wire, such as `not_found` | code (for this) |
| error | A Rust error, or a JSON-RPC error object | — |

## States

| Use | Means | Not these |
|---|---|---|
| state | What an agent is doing: one of eight, such as `working` or `waiting_for_you` | status (for this) |
| waiting | The state of an agent that needs the person; its kind is `WaitKind` | blocked (for this) |
| tools | Whether an agent's CLI can use Facade's tools, and why not | — |

## Windows, locations and folders

| Use | Means | Not these |
|---|---|---|
| window | An editor window that connects to the daemon | — |
| logical window | The daemon's stable identity for a window. An editor instance can reconnect to it, and a reopened workspace can bind a new instance to it | instance, workspace (for this) |
| window reference | The pair `{machine_id, window_id}` identifying a logical window on its machine, `WindowRef` in code | window ID alone, instance ID |
| instance | One opening of an editor window. Its ID is `WindowDescription.id` in `hello`. A reload keeps the instance and reopening uses a new one | logical window, connection (for this) |
| terminal window | The window with ID `terminal` on each machine. It is the default member when the person starts an agent from a plain terminal | — |
| member, membership | A member is a logical window an agent belongs to. A membership is that relationship. `AgentInfo.windows` lists the agent's member window references | owner, ownership (for this) |
| adopt | Add the calling editor's logical window as another member of an existing agent, through `agent.adopt` | take over, move, attach |
| location | A place a window offers to start agents in: a checkout, a worktree or a folder; an agent's location is the innermost one that holds its folder | place |
| location source window | The window on the running machine that supplied the start's location, recorded as the optional window reference `location_source_window`. A start from a direct path can omit it | member window (for this) |
| folder | A folder on disk | directory, dir |
| checkout | A Git working copy | working copy |
| worktree | A further working copy Git made from a checkout | — |
| grace | On the old engine, the time runs keep going after their owning extension host disconnects, giving the workspace time to reconnect. On the Rust engine, agents keep running after their window disconnects | — |
| take over | A newer build taking over the running Facade. On the old engine, a window taking over the runs of another window of the same workspace | hand over |
| Rust engine | The editor extension running its agents on core, as its setting `facade.rustEngine` chooses; a word of the extension's, which core's code does not use | — |
| old engine | The editor extension's own back end, from before core | original engine, legacy engine |

## Settings

| Use | Means | Not these |
|---|---|---|
| settings file | `facade.json` in the Facade home | configuration file, config file |
| settings | What the settings file holds | configuration, config |
| problem | One thing wrong in the settings file, with where it is | issue |
| home | The folder `FACADE_HOME` names, `~/.facade` by default | root, base (for this) |
| home folder | The operating system user's own home: `HOME` on macOS and Linux, `USERPROFILE` on Windows; Facade's is the Facade home | home (for this) |

## Reach

| Use | Means | Not these |
|---|---|---|
| creation tree | An agent and every agent it started, directly or not | family, lineage |
| creator | The agent that started an agent | parent |
| root | The first agent of a creation tree | — |
| reach | The agents a caller's tools act on: everyone with YOLO, otherwise its creation tree | access, scope |
| YOLO | Running a CLI without its own permission questions; with it, an agent's reach is everyone | — |

## Wiring, integrations and hooks

| Use | Means | Not these |
|---|---|---|
| wiring | Facade's way into each CLI: the MCP server entry, hooks and plugins a run gets, and the format of integrations | — |
| integration | What Facade writes into a CLI's user settings so that sessions a person starts join as guests | — |
| hook | A command a CLI runs when something happens, such as `facade hook session-start` | — |
| hook output | What a hook prints for the CLI to read; functions that make it are `*_output` | answer |
| plugin, extension | A CLI's own way to extend it, by that CLI's own name | — |
| skill | How to use Facade, written for each CLI's model | — |
| instructions | What the MCP server or a hook tells a model about Facade | — |
| guide | The protocol's description for client authors, `PROTOCOL.md` | — |

## Services, builds and takeover

| Use | Means | Not these |
|---|---|---|
| keeper | The process that holds every agent's terminal and starts the daemon | service (for this) |
| daemon | The process that runs agents, messages and the protocol | service (for this) |
| relay | `facade-mcp`: forwards MCP lines between an MCP client and the daemon, line by line | proxy, bridge, shim |
| link | A reconnecting connection between local Facade services, such as the relay's `DaemonLink` or the daemon's keeper link | — |
| program | An executable file | binary, executable |
| launcher | One of the two programs in `core/bin/` that run the current build's: a symbolic link on macOS and Linux, a copy on Windows | shim, wrapper |
| build | The programs of one build, in `core/bin/<build>/`, with its ConPTY folder on Windows | — |
| install | Copy a build's programs, and on Windows its ConPTY folder, into `core/bin/<build>/` | — |
| version | A three-part version number | — |
| sync | The daemon giving a keeper the terminals it lacks, with `agent.sync` | hand over |
| drain | The daemon letting calls under way finish before a newer build takes over | — |
| closing | Telling clients that a newer build takes over | — |
| quiet | An agent that neither types nor reads during a takeover | paused, frozen |
| roll back | Go back to the build before | revert |
| upgrade | A person installing a newer version; in text for people only | — |

In public `facade` diagnostics, "upgrade the running Facade" means switching the running services to the newer
command's build. Installation instructions use "upgrade" for installing a newer version. Code and protocol call the
service switch a takeover.

## Machines and connections

| Use | Means | Not these |
|---|---|---|
| machine | One Facade home and the core that manages it. Two Facade homes on the same computer are two machines. Use `facade machine`, `machine.*` and the `machines` topic | node, peer, host (for this) |
| machine ID | The persistent ID of a machine, stored in its home's database as a lowercase UUID v4 with hyphens and given as `machine_id` | host name, OS machine ID, node ID, peer ID |
| short ID | The first eight hexadecimal digits of a machine ID after removing hyphens, used for display. An `id:` selector uses a unique prefix of 8 to 32 hexadecimal digits. The ID column in `facade machine list` prints the shortest such selector | machine ID, machine name (for this) |
| machine name | The name a machine stores for itself, initially derived from its host name. A person can rename it, and machines can share a name | machine ID, host name (for this) |
| daemon start ID | A random UUID v4 generated each time the daemon starts and kept in memory. Machine introductions and tables carry it as `boot_id` to recognize the same running daemon on several connections | machine ID, OS boot ID |
| connection | A direct, bidirectional channel between two machines. A live connection carries one machine session over SSH or a bridge | link, route (for this) |
| saved connection | An SSH connection whose destination, remote home and machine ID the daemon keeps for background reconnects. `facade machine add` saves it once the background hello verifies the machine ID | — |
| temporary connection | A connection held by a foreground `facade machine connect` command or by one Remote-SSH window. It closes when the command exits or the window closes or reloads | saved connection (for this) |
| machine session | The two-way JSON-RPC exchange on a live connection. The daemons introduce themselves with `hello` before exchanging requests, responses, notifications and cancellations | CLI session, SSH login (for this) |
| route | The ordered machine IDs a call passes through. The forwarded `route` gives the remaining machines and ends with the destination | connection, link (for this) |
| forward, forwarding | Carry a call or subscription through an intermediate machine. The original caller and payload travel intact, and responses follow the request's path back | relay (for this) |
| bridge | The temporary transport for a Remote-SSH window. VS Code commands carry bytes, EOF and stderr between the local window component and the remote `facade machine serve` over the existing editor connection | relay, tunnel (for this) |
| unreachable | A machine currently has no route from here. A remote agent's `unreachable` flag reports that its running machine cannot be reached | offline, ended, removed (for this) |
| disconnected | The display state of a remote card or attached terminal after its live feed is lost. It keeps the last view until a fresh snapshot arrives | unreachable (for a view), ended, removed |
| SSH interaction required | The state of a saved connection when background SSH needs a person to authenticate or verify the host. Retries pause until the person runs the supplied `facade machine add` command. The reason is `ssh_interaction_required`; the command line says `needs SSH login` | unreachable (for this reason) |
| machine ID conflict | Two live daemons claim the same machine ID with different daemon start IDs. Facade refuses the conflicting connection and reports both paths with `machine_id_conflict` | duplicate machine name, alternate route (for this) |

## Agent and message addresses

| Use | Means | Not these |
|---|---|---|
| structured identity | An agent or message number paired with its full machine ID for storage, protocol and forwarding. In an `AgentRef` the ID names the running machine. In a `MessageRef` it names the machine that stores the message | display label, copyable address |
| display label | The text shown for an agent or message. A local label uses its number alone, such as `#a17`. A remote label adds the machine, such as `#a17@gpu`, and uses a unique `id:` prefix if the machine name is shared. The command line writes labels bare, as `a17@gpu` and `m42@gpu`; message headers and MCP keep the `#` | copyable address (for this) |
| copyable address | The `address` text for an agent or message, always qualified by a machine, even on its own machine. Use a unique machine name or `id:` prefix, such as `#m42@gpu` or `#m42@id:3f9a2c1d` | display label, bare number |

## Core's parts

| Use | Means | Not these |
|---|---|---|
| island | A part of core that owns its data and offers a few interfaces: a crate, a module or a file | — |
| parent, child, sibling | Of islands: the island that contains another, the islands it contains, and islands with the same parent. An agent that started another is its creator, not its parent | — |
| base | The crate of shared contracts and small tools, `facade-base` | common, shared, utils |
| handle | What a part gets at creation to reach another part's data: a small type, a channel's sender, or a closure | — |
| table | A handle to one database table, `<Thing>Table`, with that table's methods and nothing else | — |

## Operating systems

| Use | Means | Not these |
|---|---|---|
| Windows | The operating system, with a capital W; an editor window is a window | — |
| socket | Where the keeper or the daemon listens and its clients connect: a Unix socket on macOS and Linux, a named pipe on Windows. `ClientSocket` is the end that connects, `ServerSocket` the end that accepts | — |
| named pipe | A Windows pipe with a name, such as `\\.\pipe\facade-core-daemon-<key>` | — |
| pipe instance | One client's connection to a named pipe, on the server's side | — |
| console | The terminal a person runs a `facade` command in, which `attach` sets into raw and VT modes: a Windows console, or a tty on macOS and Linux | terminal (for this) |
| pseudo console | An agent's terminal on Windows, made through ConPTY; always written in full | console (for this) |
| console host | The program behind a pseudo console: `OpenConsole.exe`, from the ConPTY package every Windows build carries | — |
| signal pipe | The pipe through which a pseudo console is resized; while any copy of its write end is open, the pseudo console stays | — |
| let go before a stop | A service closing its copies of a terminal's signal pipe before `agent.stop`, so that the stop's hang-up can end the pseudo console | — |
| job | The Windows job object a CLI runs in, one per CLI, in place of the process group | — |
| completion port | A Windows I/O completion port: one wait for the I/O of many pipes and the ends of many processes | — |
| wait completion packet | A process's end, delivered to a completion port as an I/O completion is | — |
| binding | A pipe end's tie to the completion port it was first registered with | — |
| terminal I/O thread | The daemon's one thread on Windows that reads and writes every terminal and takes guests' process ends | — |
| win32-input-mode | The console host's input mode, `CSI ?9001h`, in which keys travel as key records | — |
| key-down record | A key press in win32-input-mode's form, `CSI <vk>;<sc>;<char>;1;<cs>;<rc>_` | — |
| console input record | An input event as a Windows console holds it: a key, or a change of size | — |
| console typing | What a CLI that reads console input records needs: a wait for each UTF-16 code unit before Enter, and key-down records for characters above U+FFFF | — |
| wrapper | A script that starts a CLI's real program, such as npm's `.cmd` shim, Pi's `pi.cmd` or Muse Code's PowerShell script; Facade starts the program directly where it can | launcher |

## Naming rules

### Names in code

- Follow the Rust API Guidelines: `UpperCamelCase` types and variants, `snake_case` functions and modules,
  `SCREAMING_SNAKE_CASE` constants; conversions `as_`, `to_`, `into_`; no `get_` on getters; `new` and `with_*` to build;
  `is_` and `has_` for questions.
- A type's name reads on its own, because callers often import only the type: `AgentHandle`, not `Handle`, `Data`, `Info`
  or `Manager`.
- An actor's handle is `<Thing>Handle` and its commands `<Thing>Command`. What a part reports to the part above it is a
  `<Thing>Event` sent on a channel it was given. What a watch sends is a `Change`.
- A file or module says what it holds. Not `utils`, `helpers`, `common`, `misc`, `types` or `manager`.
- A `bool` argument whose meaning the call site does not show becomes a two-variant enum.
- The store's methods use SQL's verbs: `insert_`, `update_`, `delete_`. The domain uses its own verbs: remove, withdraw,
  settle.

### Constants

| Kind | Name | Not these |
|---|---|---|
| An upper limit, with its unit | `MAX_<thing>_<unit>`, such as `MAX_LINE_BYTES` | `MOST_`, `_LIMIT`, `_AT_MOST` |
| A lower limit | `MIN_<thing>_<unit>` | — |
| The longest one wait lasts before Facade gives up | `_TIMEOUT` | `_WITHIN`, `_TIME`, `_WAIT` |
| A fixed period | `_INTERVAL` | `_EVERY` |
| How long Facade waits before it acts | `_DELAY` | `_AFTER`, `AFTER_` |
| Time given on purpose to the other side before Facade acts | `_GRACE` | — |
| An absolute point in time | deadline | until |

### Text for people

- Use the person's words from the tables above: agent, run, message, inbox, settings file, folder.
- American spelling: color, not colour.
- Short sentences that say what happened and what to do next.
- Error messages start in lower case, end without a period, and name what failed and on what.
- Logs state facts in English, one fact a line. They never hold prompts, screen contents, full arguments or a person's
  environment.

## Names on the wire

These names are part of the daemon protocol, the keeper protocol, MCP or the settings file. They keep their spelling, and
code that mirrors them keeps it too.

| On the wire | Means, in this glossary's words |
|---|---|
| `daemon.upgrade`, reason `upgrading` | A newer build taking over: take over |
| `status`: the MCP result's field, the `facade status` command, the Program Status Protocol (OSC 7501) | The outcome of a call; Facade's own state; a CLI reporting its state |
| reason `configuration_invalid` | The settings file has problems |
| `process` in an agent's record | The state of the run's operating system process |
| the rule file keys `launch` and `status` | The rule's command line and state sections |
| `BlockKind` and the value `blocked` of the Program Status Protocol | What a CLI reports it waits for; Facade's word is waiting, `WaitKind` |
| `answer` in `PROTOCOL.md`'s prose | response |
| `HandOver`, the result of `hook.prompt` and `hook.turn-end` | The messages a guest takes at its next turn: take |

## Names from elsewhere

| Name | Comes from |
|---|---|
| `dir`, `directory` | The standard library and libc, such as `create_dir`, `read_dir` and `DirEntry` |
| `tty` | The standard library and libc, such as `isatty` and `ttyname` |
| `history` | alacritty, such as `scrolling_history` |
| `abort` | tokio's `JoinHandle::abort`; `io::ErrorKind::ConnectionAborted` |
| `conversation` | Antigravity's fields, such as `conversationId` |
| `launchd` | macOS |
| `forget` | `std::mem::forget` |
| `HANDLE`, `OwnedHandle`, `BorrowedHandle`; "a Windows handle" in text | Windows, and the standard library's `std::os::windows::io`; Facade's own handle is an island's (above) |
| `sync_all`, `sync_data`; to sync a file or folder | The standard library: written through to disk, as `files::sync_folder` does. Facade's own sync is `agent.sync` |
| ConPTY, `conhost`, `OpenConsole` | Windows and Microsoft's ConPTY package |
| shim, `pi-launcher.js`, `.muse-launcher.ps1` | npm's name for its wrappers, and the files Pi's and Muse Code's installers write |

## Names not yet changed

These names in the code still differ from this glossary. Each is renamed when a change touches it; the wire names above
stay.

| Rule | Names in the code |
|---|---|
| start, not launch | `service::launch`, `Supervisor::launch`, `launch_with_settings` |
| send, not post | `Messages::post`, `Posted` |
| folder, not dir | `paths::core_dir`, `socket_dir` |
| take over or drain, not hand over | `hand_over` (takeover), `handed_over_cleanly`, `HANDOVER_TIME` |
| ended, not gone | `daemon_gone` (keeper) |
| response or reply, not answer | `TypingAnswer`, `StartAnswer`, `hello_answer`, `closing_answered`, `answer_to`, `settled_answer` |
| scrollback, not history | `HistoryKeeper` (screen) |
| remove or `delete_`, not forget | `forget_integration_file` |
| commands, not mailbox | an actor's `mailbox` |
| resume, not restart | screen's `restart.rs`, `leave_for_restart`, `reset_for_restart` |
| one meaning for settle | rules' `settle_time`, how long a draft must stay still |
| a name that reads alone | `programs::Held` (the programs a daemon holds open); the daemon's `Sender` (who said something), which shares its name with channel senders |
| `_TIMEOUT`, not `_TIME`, `_WAIT` or `_WITHIN` | `QUIET_TIME`, `DRAIN_TIME`, `CLOSING_TIME`, `HANDOVER_TIME`, `COMMAND_TIME`, `DELIVERY_TIME`, `READY_WAIT`, `RESPONSE_WAIT`, `SAID_WAIT`, `CLOSING_ANSWERED_WITHIN` |
| `MAX_`, not `_LIMIT` or `MOST_` | `READ_LIMIT`, `ADD_LIMIT`, `TURN_LIMIT`, `OUTBOX_LIMIT`, `SESSION_FILE_LIMIT`, `OPENCODE_ID_LIMIT`, `MAX_MESSAGES_LIMIT`, `MOST_SAID`, `MOST_PARTS`, `MOST_RETRY_DELAY` |
| `_DELAY` or a threshold, not `_AFTER` or `AFTER_` | `ENTER_DRAWN_AFTER`, `HEALTHY_AFTER`, `AFTER_REPEATS`, `CHECKPOINT_AFTER_BYTES` |
| `_INTERVAL`, not `_EVERY` | `FOLLOW_EVERY` |
| process, not one system's name, for code on every system | `unix_process` |
| console, not terminal, for the person's | facade's `terminal_size`, `restore_terminal`, `RESTORE_TERMINAL_SEQUENCE` |
