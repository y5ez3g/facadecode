<!-- Generated from core/crates/base/src by core/crates/base/tests/protocol_files.rs: do not edit. -->

# Facade daemon protocol

Ordinary daemon protocol version 3 (oldest ordinary version 3). See `protocol.schema.json` for JSON Schema and `protocol.ts` for TypeScript types.

[Version 2 takeover and old data](#version-2-takeover-and-old-data) describes the separate compatibility connection.

## Connect to the daemon

The Facade home is the absolute path in `FACADE_HOME`. If unset, use `HOME/.facade`, or `USERPROFILE/.facade` if `HOME` is
unset. On macOS and Linux the daemon socket is `/tmp/facade-core-<uid>/daemon-<key>.sock`, where `uid` is the process's real
user ID. Only that user can access the socket folder. On Windows the daemon listens on the named pipe
`\\.\pipe\facade-core-daemon-<key>`, and the keeper on `\\.\pipe\facade-core-keeper-<key>`. The pipes let in their owner
alone (DACL `D:P(A;;GA;;;OW)`). Before its `hello`, a Windows client checks that the server process runs as its own user
(`GetNamedPipeServerProcessId`, then that process's token's user SID), and closes the connection otherwise. An `ide`
client is the exception: Node.js, which runs the editor's extension, has no API for that check, so it relies on the
daemon pipe's DACL alone. Lines, framing and every operation are the same on every system.

To compute `key`, encode the home's path string as UTF-8. Replace invalid path bytes with U+FFFD, as Rust's
`Path::to_string_lossy` does. Take the first five bytes of its SHA-256 digest and write them as ten lowercase hexadecimal
digits. Use the path exactly as it was used to start Facade; do not resolve symlinks or normalize it before hashing.

If the socket does not answer, run `facade daemon --detach` with the same `FACADE_HOME`. It starts the keeper, which starts the
daemon, and returns code 0 when the daemon starts or another daemon holds the daemon lock. If the daemon is still starting after 10 seconds, it prints
`facade: Facade is still starting; see {home}/core/logs` and also returns 0. Startup failure returns code 1 with the reason.
Connect to the socket and retry `hello` for up to 10 seconds. A successful `hello` proves readiness; the `--detach` result
alone does not.

The daemon accepts connections after recovering its agents and screens. Recovery can take longer than one connection
attempt. A client can retry temporary transport failures. Report a decoded refusal, invalid response, permission error,
or settings problem.

Nothing runs at login. A command starts the keeper, and the keeper starts the daemon; `hello.keeper` is absent while no keeper
runs. The daemon exits after 5 seconds with no running agent, connected client, or unfinished work, and the keeper, holding no
CLI, exits with it. Ended records and screens stay in the home. The next command starts them again and reads them. Linux needs
kernel 5.3 or newer, with process descriptors (`pidfd_open`) allowed.

### Messages

Send one UTF-8 JSON-RPC 2.0 object per newline. The 64 MiB line limit includes the newline.
An oversized request receives `capacity_exceeded` with a null ID and closes the connection.
Give outstanding requests distinct non-negative integer IDs. JavaScript clients use exactly
representable integers. A notification omits the ID and receives no response.

Ordinary terminal, editor and machine sessions offer `[3,3]`. Wait for a successful `hello`.
Its `ops` and `topics` list the operations and watches available to the client. Shell and IDE
introduce their client kind and build. The daemon supplies verified actor identity on its private
MCP connection. The machine introduction carries a stable machine ID and a boot ID.

A watch gives its number and first snapshot before its ordered changes. End it with `unwatch`.
Use the watch number to interpret each change in the type for that topic. Ignore unrecognized
fields and skip unknown change kinds. The Rust types supply `Unknown` or `Unrecognized`.

To request cancellation on the same connection, send
`{"jsonrpc":"2.0","method":"cancel","params":{"id":7}}`. The named call reports what happened.
An `agent.send` can be withdrawn before its text starts entering the terminal.

In this exchange `→` marks a client message and `←` marks a daemon message. The redraw
contains only a short example terminal sequence.

```text
→ {"jsonrpc":"2.0","id":1,"method":"hello","params":{"protocol":[3,3],"build":"1.4.2","kind":"terminal"}}
← {"jsonrpc":"2.0","id":1,"result":{"protocol":3,"build":"1.4.2","machine_id":"3f2504e0-4f89-41d3-9a0c-0305e82c3301","pid":4321,"agents":0,"topics":["agents","screen","machines"],"ops":["agent.list","agent.inspect","agent.start","agent.start_preflight","agent.resume_list","agent.resume","location.list","cli.list","agent.stop","agent.remove","agent.rename","agent.type","agent.send","agent.resize","agent.screen","daemon.status","workspace.import_legacy","machine.list","machine.add","machine.connect","machine.remove","machine.rename","daemon.log","daemon.upgrade"]}}
→ {"jsonrpc":"2.0","id":2,"method":"call","params":{"op":"agent.start","args":{"cli":"claude","folder":"/Users/me/project","env":{"HOME":"/Users/me","PATH":"/usr/bin:/bin"},"cols":120,"rows":30}}}
← {"jsonrpc":"2.0","id":2,"result":{"agent":{"agent_id":"a1","address":"a1@devbox","type":"managed","name":"Pixel","cli":"claude","args":[],"cwd":"/Users/me/project","machine_id":"3f2504e0-4f89-41d3-9a0c-0305e82c3301","pid":1234,"process":"running","cols":120,"rows":30,"created_at":"2026-11-09T17:25:00.000Z","started_at":"2026-11-09T17:25:00.000Z","root":"a1","yolo":true,"state":"starting","tools_state":"connecting"}}}
→ {"jsonrpc":"2.0","id":3,"method":"watch","params":{"topic":"screen","args":{"reference":{"machine_id":"3f2504e0-4f89-41d3-9a0c-0305e82c3301","agent_id":"a1"}}}}
← {"jsonrpc":"2.0","id":3,"result":{"watch":1,"snapshot":{"agent_id":"a1","address":"a1@devbox","name":"Pixel","machine_id":"3f2504e0-4f89-41d3-9a0c-0305e82c3301","cols":120,"rows":30,"redraw":"G1s/MjAyNmw=","process":"running"}}}
← {"jsonrpc":"2.0","method":"changed","params":{"watch":1,"change":{"kind":"output","data":"aGVsbG8="}}}
→ {"jsonrpc":"2.0","method":"call","params":{"op":"agent.type","args":{"reference":{"machine_id":"3f2504e0-4f89-41d3-9a0c-0305e82c3301","agent_id":"a1"},"raw":"aGk="}}}
→ {"jsonrpc":"2.0","id":4,"method":"call","params":{"op":"agent.type","args":{"reference":{"machine_id":"3f2504e0-4f89-41d3-9a0c-0305e82c3301","agent_id":"a1"},"text":"run the tests","enter":true}}}
← {"jsonrpc":"2.0","id":4,"result":{"agent":{"reference":{"machine_id":"3f2504e0-4f89-41d3-9a0c-0305e82c3301","agent_id":"a1"},"address":"a1@devbox","name":"Pixel","cli":"claude","state":"idle","resumable":false}}}
→ {"jsonrpc":"2.0","id":5,"method":"call","params":{"op":"agent.stop","args":{"agent":"a1@devbox"}}}
← {"jsonrpc":"2.0","method":"changed","params":{"watch":1,"change":{"kind":"exit","exit":{"signal":"SIGHUP","at":"2026-11-09T17:25:40.017Z"}}}}
← {"jsonrpc":"2.0","id":5,"result":{"reference":{"machine_id":"3f2504e0-4f89-41d3-9a0c-0305e82c3301","agent_id":"a1"},"address":"a1@devbox","signal":"SIGHUP","at":"2026-11-09T17:25:40.017Z"}}
→ {"jsonrpc":"2.0","id":6,"method":"unwatch","params":{"watch":1}}
← {"jsonrpc":"2.0","id":6,"result":{}}
```

An exact screen watch may set `allow_ended` to read the final redraw of a managed run. The
snapshot includes the process state and the exit if known. The ended snapshot and the exit
change can also include `exit_status`: the original exit code, or 128 plus the running machine's
number for the recorded signal. An ended snapshot admits no viewer.
Ordinary watches require a running managed agent. Inspection lists the verified client kind and
origin of each shell or editor attachment alongside the viewer names supplied by earlier clients.

### Agent and machine addresses

The daemon presents copyable addresses such as `a1@devbox`. A bare `a1` is an agent number.
An agent can also be found by name. `Pixel@devbox` can be both a qualified name and a literal
name. A machine selector matches both its spelling as a name and as an eight-digit ID or full
UUID. A selector that matches two different machines is ambiguous. The daemon presents a machine
name, short ID, or full ID only after checking it can locate the intended machine uniquely.
When no public spelling is unique, the daemon reports `ambiguous_reference` with a rename hint.

An `AgentRef` contains the full `machine_id` and `agent_id`. Clients retain it for stored
workspace membership and to reconnect a terminal to the same agent. Calls taking `AgentTarget`
supply exactly one of `agent` or `reference`. The same target's permissions and capabilities
apply on both paths. A specified machine can be woken for the requested operation. An unspecified
machine uses the routes already available to the caller.

For a name, lookup prefers live records among the matches that support the operation. An ambiguous
number can still match several machines. Receipts and error labels carry a stable reference and
the copyable address in the requesting daemon's view. Agent error labels are limited to records
within the caller's reach. Machine queries can report the current query failure separately from
the last known SSH error.

### Listing and inspecting

`agent.list` returns active agents and Guests in the permitted view, newest start first. Each
entry contains a stable `reference` and the public row including its copyable `id`, `type`,
`state`, CLI, working folder and start time. The `agents` watch also includes ended records
and the synchronization state of remote contributors. A synced contribution can be an empty
list. A removal change carries the machine, agent ID and confirmed cause. Inspect returns the
agent record, input information, current terminal viewers, and recorded startup source when known.

The list's machine connection state and its query status are separate facts. A normal bare list
reports an unfinished connection as `connecting` and returns the currently available records.
An online machine can still fail or time out in this query.

### States

`state` in an agent record says what the agent is doing: the first that holds of `waiting_for_you`, `error`, `just_done`,
`working`, `starting`, `idle`, and `unknown`, or `ended` once its process ended. A connected Guest reports `online`.
`state_detail` says more:

- `waiting_for_you`: `kind` is `permission`, `question`, `auth`, or `unknown` where the CLI did not say, and `text` holds the
  CLI's own words, if any. A menu or question the CLI draws in place of its input counts, also while it starts, and the bounds
  on its start and its tools run again once it is answered.
- `error`: the CLI reported an error, or its screen shows that the turn it reported ended failed, and `text` holds its own
  words, if any; its CLI cannot use the Facade tools it was
  given, and `reason` is `tools_unavailable`; or a CLI that runs by a built-in's rule showed nothing of what it does within 60
  seconds of its start or resume, and `reason` is `not_ready`. A program without a rule is `unknown` instead: nothing
  promises it reports.
- `just_done`: a turn ended while no `screen` watch showed the agent. It stays until one does; `agent.screen` does not count.
  Work before the CLI is asked to do anything is no turn: an Enter typed into it asks, unless it answers a question the CLI
  shows. Words after the CLI's name at its start are the CLI's own and ask nothing.
- `working`: the CLI works, or stopped working less than a second ago.
- `starting`: the CLI has shown nothing of what it does yet, or its Facade tools have not connected yet, within 60 seconds of
  the start or resume of its process.
- `unknown`: nothing shows what the CLI does now, though it did before, or a program without a rule has shown nothing yet.
  `reason` says why: `not_shown`, `asked` (to report, without reporting since), `taken_back`, or `unrecognized` (a screen
  its rule does not recognize).
- `ended`: `how` is `stopped` where Facade stopped the agent, otherwise `normal` for exit code 0 and `crashed` for another
  code or a signal. It is omitted where neither is known; `exit.reason` says what is known.

States come from what the CLI reports of itself, the Program Status Protocol (OSC 7501, revision 0.4): a CLI that asks whether
the terminal takes reports is answered that it does, and viewers see neither the question nor the reports. A full reset takes
a report back, and so does a shell's new prompt (OSC 133 A) after work or a wait. Reports about a part of the CLI (`id=`) and
report titles are not read. Where a CLI's rule reads its screen, the screen speaks for the CLI too: Muse Code's, until the CLI
asks or reports, and Codex 0.166.0's and 0.167.0's, whose finished turn narrows a `working` report to idle while commands it
left running continue. Codex's version is read from the `codex-package.json` its installation keeps above its program; other
versions keep their own reports.

`said` is the last text that went into the agent's input with Enter, on one line, and who said it, as messages name their
sender: what the person submits in an attached terminal, once the CLI takes it, with each paste the CLI shows as a
placeholder said as the text pasted; `agent.type` text with `enter`, from the agent
the verified actor, or from the command line; and a message delivered through the terminal, from its sender. An Enter the person
types reaches the CLI once the CLI has drawn the keys before it and the daemon has read the draft they make, at most 150 ms
later, and keys sent meanwhile follow it; if the CLI drew nothing of them by then, the Enter goes and nothing is said.
`waiting_for_you` and `error` are published on the `agents` topic at once; other state changes and `said` follow within
200 ms. The facts states rest on and `said` are kept beside the agent's screen, so a daemon that starts again shows the same
states before it serves clients.

### Starts, stops, and removal

The start and preflight operations take `StartArgs`. The selected machine checks its CLI
entries, availability, working folder and permissions. Set `folder_is_default` only for
the entry's implicit folder so a remote start can use the running machine's default. A
`worktree` names the new branch made from the current HEAD. Preflight checks without creating
a worktree or starting a process. A Git error can describe what was kept in `data.kept`.

A start can include an initial prompt. A start result gives the agent record and prompt
information. An automatic retry uses the same request ID and returns the original outcome.

`agent.stop` returns the stable reference, current public address, recorded process exit and
agent label. A stop of an already ended process returns `ended`. A typed input receipt gives the
agent label after its terminal accepts the input. Rename returns the renamed record's fields and
the name it replaced. `agent.remove` returns the removed record's stable reference and address.
A confirmed expiry or explicit removal also appears as
`record_removal` in a precise missing-record error.

### Resume, locations and status

`agent.resume_list` gives resumable agent records and CLI sessions in the requested scope. Use
the returned `ResumeTarget` unchanged with `agent.resume`, adding `env`, `cols` and `rows`.
For a remote CLI session the target includes its machine and actual folder. A client using a
saved Pin may instead provide the exact `machine_id`, mutually exclusive with `machine`.
`at` records when a managed run ended or when a saved session file changed. A saved session can
also be selected by its full ID or eight-character prefix in the requested directory. The resume
receipt indicates when it created a new agent from a saved session.
`session_not_found` means the selected running machine confirmed the session is absent.

`location.list` returns the working locations and Git kinds known on the selected machine.
Local results can identify their requested workspace roots as `source_folder`. `cli.list`
uses the selected machine's working folder and launch environment. `daemon.status` returns the
home, settings path, version, process IDs, active count and machine results of the live service.
A local Shell observation that the service is sleeping is reported locally without starting it.
`agent.inspect` includes the current or last managed run's recorded display command when
available. The running machine formats the executable and arguments and redacts Facade's
injected run credential before saving the command. The environment is excluded.

### Agent messages

`agent.send` delivers to an eligible managed agent or Guest. A public receipt's `id` contains the
assigning machine, such as `m42@devbox`. The recipient's inbox uses the local `m42`. A reply to a
message stored on another machine can carry that machine. Agent senders have copyable addresses.
The command line and Orchestrator use `command_line` and `facade`, respectively.

The request ID, verified sender and resolved target identify automatic retries. The daemon
can return the original settlement after withdrawal from a private receipt. The withdrawn
message is absent from the inbox and history. A managed agent's delivery is confirmed when its
terminal takes the submission. A Guest reads complete messages inline. The `next_cursor` of an
inbox page is passed as `after` to continue reading with the same reply filter.

A terminal can set `allow_unsupported_receipt` to receive a numbered delivery failure if the
selected managed program has no input rule. That outcome confirms no input was sent. By default
such requests fail before the message receives a number.

A send without `reply_to` that times out and is withdrawn may carry `expected_reply_to`, the
message the Guest was waiting for the sender to answer. The sender can use the original message's
local ID as `reply_to` when sending the reply again.

### YOLO and creation trees

A managed agent reads YOLO from its running machine's settings on each start or resume. A Guest
keeps the value recorded when it joined. A managed agent keeps its original creator and the root
of its creation tree. The verified actor can reach agents in the same tree with YOLO off.
With YOLO on it can reach other agents too. Local Shell and editor clients act with their own
client kind. The daemon checks reach and the operation's capability before exposing an address.

### The relay

The relay contract remains 1. The initial `hello` carries `relay: 1`, `args`, `env`, `cwd` and
`reconnect`. Once accepted, the connection carries MCP requests and responses. MCP's date
versions are independent of both daemon and relay versions. The daemon binds the relay actor
using verified run or session information. The keeper speaks its separate version 1 protocol.

### Text and keys

`agent.type` takes one of `raw`, `text`, or `keys`. `facade attach` sends `raw`: the bytes a person types, queued as they come.
Programs send `text` or `keys`. The agent's typist types them one call at a time, each call whole:

- Text goes in as one paste. When the CLI turned on bracketed paste, the text goes between the paste brackets with each line
  break as a carriage return; otherwise it goes as given. Text takes printable characters, tabs, and line breaks; send Escape
  and other control keys as `keys`.
- With `enter`, Enter goes in a write of its own after the text. Empty text with `enter` presses Enter alone.
- Keys go as a terminal sends them in the CLI's modes, including application cursor keys.
- The typist pauses before its next stroke, even when that stroke belongs to the next call: after a paste reached the
  terminal, 0.1 seconds and the settle time the CLI's rule gives the paste, because a CLI that reads a paste's end and an Enter
  together may drop the Enter or take it as a line break; after an Escape, 50 ms, so the CLI does not read the two as Alt with
  that key.

A text or keys call is answered once its input reached the terminal. If the agent ends first, the call fails with `ended`
when nothing of it was typed. Otherwise it fails with `partial_input` and says what was typed, for example `a3@devbox ended; the
text was typed but not its Enter`; the error's data has `text_written` and `enter_written` for text, or `keys_sent` for keys.
Raw bytes can go in between a text and its Enter.

### Screen text

`agent.screen` returns the last logical lines of the screen and scrollback, each wrapped row joined into its line, with
`line_count`, `older_lines` when output lies above them, and `trimmed` when the scrollback let go of its oldest lines. In
`text`, inverse text is between `[[` and `]]` and dim text between `{{` and `}}`, inverse outside dim, and each backslash,
bracket, and brace of the screen's own text is escaped with a backslash: removing the marks and the escapes gives the text
exactly, as `facade screen` prints it. An ended agent's screen is the one it left; `process` says it ended, and
`observed_at` is when it ended. Text and keys have no draft protection: they can edit or submit a draft the person is typing.

### Viewers and queue limits

`snapshot.redraw`, `output.data`, and `redraw.data` contain standard base64 with padding. Decode them to bytes and feed those
bytes to the viewer's terminal parser. Process changes for each watch in arrival order. Apply `output` as continuation bytes;
`redraw` supplies a terminal sequence that replaces the visible screen. Preserve parser state between messages. Do not treat
the decoded bytes as plain text; use `agent.screen` when you want plain text.

An agent has one terminal size. Set the viewer to `snapshot.cols` columns and `snapshot.rows` rows before applying
`snapshot.redraw`. `agent.resize` changes the size for every viewer, and the last resize wins. When the size changes, every
viewer receives a `redraw` with its own `cols` and `rows`. Resize the viewer to those dimensions before applying its `data`.
These dimensions may differ from the snapshot, so a screen viewer does not need the `agents` topic to learn the redraw's size.

A successful `agent.resize` response accepts the request. If the screen log is full while its checkpoint is being written,
only the latest requested size is kept. It takes effect when the checkpoint writer finishes, whether publication succeeded
or failed. Input sent to that agent afterward, on any connection, waits for the size: calls with IDs fail with
`capacity_exceeded`, while notifications wait. Snapshots and agent records show the applied size. A daemon failure before
application loses the request.

Each viewer queues up to 1 MiB of incremental screen output. Output beyond that is dropped for that viewer. When the viewer
has room, it receives a full `redraw`, which may exceed the output budget. The agent does not wait for a viewer. Returning
from the alternate screen also causes a redraw. If an agent is removed while a viewer is behind, the viewer receives the
last screen, any exit it missed, and then `removed`.

A connection's outbox holds up to 8 MiB of responses and changes. When it is full, the daemon waits for the client to read.
A line larger than 8 MiB is sent alone once the outbox is empty. Up to 16 calls can run at once on a connection, with or without
an ID. If another call has to wait for one to finish, the daemon stops reading further requests from that connection, keys
included. `agent.type` and `agent.resize` do not count toward the 16.

Each agent's waiting input holds up to 1 MiB: queued bytes, including terminal-query replies, and text and keys waiting in its
typist. Kernel PTY buffers are separate. A connection holds up to 1 MiB more for each agent: input waiting behind that agent's
earlier input from the connection. One `agent.type` message carries at most 1 MiB as written, a paste counted with its
brackets and Enter. A call with an ID fails with `capacity_exceeded` if its input does not fit or a resize is waiting to take
effect. A notification waits; while its connection holds 1 MiB for its agent, the daemon reads no further requests from that
connection. If the connection closes while input waits, the input is dropped and nothing else from that connection runs.
Terminal-query replies that do not fit are dropped.

A successful `agent.type` result means that raw bytes entered the daemon's memory queue, or that text and keys reached the
terminal. It does not confirm that the CLI processed them. Daemon failure can lose input not yet written. Notifications
provide no response.

### Terminal queries and redraws

A screen snapshot has the stable reference fields and current address. Reconnect and draw the
new snapshot before sending input again. Keys typed while disconnected are discarded. A v3
`agent.resize` can supply foreground, background and cursor colors for a verified IDE client.
The applied colors answer OSC 10, 11 and 12. `agent.screen` reads the requested tail of the
logical screen and scrollback as text, including for an ended agent.

### Disconnections and recovery

A lost response can leave the call's outcome unknown. Do not replay terminal input. A call
refused as `upgrading` can be repeated on the new daemon. When a start or send is retried after
a cut, reuse its original request ID. A watch is connection-scoped and starts with a new snapshot
after reconnecting. A keeper preserves running agents and terminals during daemon replacement.

A daemon that a newer build takes over drains accepted work, sends `closing`, and ends after clients have had a
chance to answer it and stop sending keys. A replacement daemon recovers records and screens.
A newer build joins normal operations only after a v3 hello from that build. A build unable to
speak the running keeper's protocol receives a refusal before taking over.

#### Keeper replacement

If the keeper ends, the daemon keeps its clients, watches, screens, input queues, sizes, and terminal descriptors. It starts
a replacement keeper and gives it the runs with `agent.sync`. Screens and input continue throughout. Stops keep their original SIGKILL time.
Keeper replacement uses the same 0.5-to-30-second delay, reset after 60 healthy seconds.

For the separate waits on starts and stops, see [Starts, stops, and removal](#starts-stops-and-removal). A keeper that
disconnects before replying leaves the request's outcome unknown; Facade returns `unavailable`.
An unresponsive keeper that is still alive is never ended by the daemon. The daemon logs how to end that keeper process so
Facade can replace it; screens, input, and resizes continue. A broken connection to a living keeper is reconnected.

Only the keeper that started a CLI can report its exit code or signal. After that keeper ends, the keeper that the daemon
starts next holds the CLI and watches it through Linux process descriptors or macOS kqueue. When it ends, the agent is `ended`
with an exit that has neither `code` nor `signal`. Show `exit status is unavailable`. End of terminal output does not prove
exit.

On SIGTERM or SIGINT, the keeper sends SIGKILL to the groups it is stopping, and exits. A daemon that holds runs starts
another.

#### Both services ending

If both services end, the terminals close and most CLIs exit on SIGHUP. The next daemon recovers the screens and lists agents
without a recorded exit as `ended`. Their exit has `reason: "terminal_closed"`, no `code` or `signal`, and `at` set to the time
recovery found them. Show `the terminal closed; the CLI may still be running`.

A CLI that ignores hangup can keep running outside Facade. Facade never signals a process ID read from a saved agent record.
`agent.stop` returns the recorded exit; `agent.type` fails with `ended`; `agent.resize` succeeds without changing
anything; `agent.remove` removes the record; `agent.resume` starts its CLI again if it has a recorded session.

An exit without `code` or `signal` is not a zero exit code. Show its reason if recognized; otherwise show that its status is
unavailable.

### Machine sessions

A machine session is a bidirectional daemon v3 connection over SSH. Each direction numbers
requests independently. After the machine hello, each daemon verifies the other and completes
its first `advertise` exchange before the route is ready. Later advertisements replace the
sending machine's table. A boot ID distinguishes concurrent uses of the same saved machine ID.
On Linux, `ssh_cleans_processes` records a known login cleanup policy.

The `forward` route lists remaining machine IDs through the destination. Each hop removes its
own receiver ID and preserves the verified originating `Caller`. A forwarded `call` uses
`V3ForwardCall`. A send carries the resolved recipient's `AgentRef` so retries keep the same
target. Internal `agent.deliver_start_result` is for authenticated machine sessions.
An unsent call can be reported as `not_executed`. A sent call that loses its reply can report
`outcome_unknown`. A watch that loses its route ends with `watch_ended`.

The local `machine.connect` response authorizes the foreground stream before the machine
handshake. Its result is followed by `connected` or `connect_failed`. A save with `machine.add`
records the verified SSH destination and its raw SSH arguments.

## Version 2 takeover and old data

A dedicated takeover client offers `[2,3]` as a terminal. It sends `daemon.upgrade` with daemon
range `[2,3]` and normally uses keeper range `[1,1]`. If the v2 daemon replies with
`protocol_incompatible` and a message containing `the running keeper speaks`, the client may
make one local `agent.list` call to report the addresses of running managed agents. Other
refusals end the attempt immediately. The keeper diagnostic still ends in a failed takeover and
the client closes the connection. After a successful takeover the client also closes the old
connection and waits for the target build over v3 before sending ordinary calls.

This isolated example uses a debug candidate build advertising keeper range `[2,2]` to show
the refusal from a running version 1 keeper and the optional read. The advertised operations
describe the old daemon.

```text
→ {"jsonrpc":"2.0","id":1,"method":"hello","params":{"protocol":[2,3],"build":"1.4.3","kind":"terminal"}}
← {"jsonrpc":"2.0","id":1,"result":{"protocol":2,"build":"1.4.2","machine_id":"3f2504e0-4f89-41d3-9a0c-0305e82c3301","pid":4321,"agents":1,"topics":["agents","screen","messages","windows","machines"],"ops":["agent.start","agent.resume","agent.adopt","agent.stop","agent.remove","agent.inspect","agent.type","agent.screen","agent.resize","agent.rename","agent.send","hook.session-start","hook.prompt","hook.turn-end","hook.idle","hook.session-end","integration.add","integration.remove","integration.list","window.update","worktree.create","daemon.upgrade","daemon.log","machine.connect","machine.add","machine.list","machine.remove","machine.rename","agent.list","cli.list","location.list","agent.start_preflight"]}}
→ {"jsonrpc":"2.0","id":2,"method":"call","params":{"op":"daemon.upgrade","args":{"program":"/opt/facade/bin/facade","build":"1.4.3","daemon_protocol":[2,3],"keeper_protocol":[2,2]}}}
← {"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"1.4.3 speaks keeper protocol 2 to 2, and the running keeper speaks 1 to 1: this new build needs every agent closed first; close them and try again","data":{"reason":"protocol_incompatible"}}}
→ {"jsonrpc":"2.0","id":3,"method":"call","params":{"op":"agent.list","args":{"machine":"id:3f2504e04f8941d39a0c0305e82c3301"}}}
← {"jsonrpc":"2.0","id":3,"result":{"agents":[{"agent_id":"a1","address":"a1@devbox","name":"Pixel","cli":"claude","cwd":"/Users/me/project","machine_id":"3f2504e0-4f89-41d3-9a0c-0305e82c3301","windows":[{"machine_id":"3f2504e0-4f89-41d3-9a0c-0305e82c3301","window_id":"terminal"}],"location_id":"loc-8779b387e6b0f90a","pid":1234,"process":"running","cols":120,"rows":30,"created_at":"2026-11-09T17:25:00.000Z","root":"a1","yolo":true,"state":"idle","tools_state":"available"}],"machines":[{"machine_id":"3f2504e0-4f89-41d3-9a0c-0305e82c3301","short_id":"3f2504e0","name":"devbox","build":"1.4.2","status":"answered","answered_at":"2026-11-09T17:25:49.008Z"}]}}
```

The compatibility hello and diagnostic types have `V2` names, including `V2HelloParams`,
`V2HelloResult` and `V2AgentListResult`. The isolated legacy editor fixtures also use named
v2 start, window-watch and machine records. A restored v3 workspace uses `workspace.import_legacy`
to read verified members from existing records. It gives exactly one of `workspace_key`,
`window_id` or `instance_id` for the specified source machine. An answered source can contribute
zero agents. A failed or unavailable source leaves the import incomplete. Mark the import
complete after all required contributions have answered and the workspace has saved the result.

## Methods

| Name | Description |
|---|---|
| `hello` | Starts the connection (`HelloParams`). The result (`HelloResult`) describes the daemon. |
| `call` | Runs an operation (`CallParams`) and returns its result. |
| `watch` | Follows a topic (`WatchParams`). The result (`WatchResult`) contains its snapshot; `changed` notifications follow. |
| `unwatch` | Ends a watch (`UnwatchParams`). |
| `cancel` | Cancels a call still under way on this connection, by that call's request ID (`CancelParams`), and answers `{}`. It withdraws only an `agent.send` whose message's paste has not begun, which then answers `cancelled` and is not kept; every other call goes on, and its own answer says what it did. Closing the connection withdraws nothing. |
| `changed` | Reports a change for one watch (`ChangedParams`). |
| `watch_ended` | Ends a forwarded watch (`WatchEndedParams`). |
| `advertise` | Replaces the directly connected machine's table (`AdvertiseParams`). |
| `forward` | Forwards a request to its destination (`ForwardParams`). |
| `connected` | Reports the foreground connection's successful handshake to the local CLI (`ConnectedParams`). |
| `connect_failed` | Reports a foreground connection failure to the local CLI (`ConnectFailedParams`). |
| `closing` | From the daemon, a notification: a newer Facade takes over (`ClosingParams`). Every answer this connection waits for has been written. The client sends nothing more but `closing` back, a notification without params, and connects again; the new daemon answers within seconds. A client that does not answer within 0.2 seconds is cut. |

## Topics

Topics available to `watch`. Their types are defined below.

| Name | Arguments | Snapshot | Change | Description |
|---|---|---|---|---|
| `agents` | `NoArgs` | `V3AgentsSnapshot` | `V3AgentsChange` | Agent records and synchronization state of their running machines. |
| `screen` | `V3ScreenWatchArgs` | `V3ScreenSnapshot` | `ScreenChange` | The managed agent's terminal redraw and subsequent output. |
| `machines` | `NoArgs` | `V3MachineInfo[]` | `V3MachinesChange` | Changes to the machine table in the daemon's view. |

## Operations

Operations available to `call`. Set `op` to the name and `args` to its arguments. Types are defined below.

| Name | Arguments | Result | Description |
|---|---|---|---|
| `agent.list` | `MachineQueryArgs` | `V3AgentListResult` | Lists reachable agents and machine query outcomes. |
| `agent.inspect` | `V3AgentArgs` | `V3InspectResult` | Describes an agent and its terminal viewers. |
| `agent.start` | `V3StartArgs` | `V3StartResult` | Starts a new managed agent. |
| `agent.start_preflight` | `V3StartArgs` | `EmptyResult` | Checks the arguments of an agent start. |
| `agent.resume_list` | `ResumeListArgs` | `ResumeListResult` | Lists resumable agents and CLI sessions. |
| `agent.resume` | `V3ResumeArgs` | `ResumeResult` | Resumes an agent or a CLI session. |
| `location.list` | `LocationListArgs` | `V3LocationListResult` | Lists working locations on a machine. |
| `cli.list` | `CliListArgs` | `CliListResult` | Lists CLIs available in the selected launch environment. |
| `agent.stop` | `V3AgentArgs` | `V3StopResult` | Stops the agent's CLI and keeps the agent record. |
| `agent.remove` | `V3AgentArgs` | `RemoveResult` | Removes a managed agent. |
| `agent.rename` | `V3RenameArgs` | `RenameResult` | Changes an agent's name. |
| `agent.type` | `V3TypeArgs` | `TypeResult` | Sends input to a managed agent's terminal. |
| `agent.send` | `V3SendArgs` | `V3SendResult` | Sends a message to an agent. |
| `agent.resize` | `V3ResizeArgs` | `EmptyResult` | Resizes a managed agent's terminal. |
| `agent.screen` | `V3ScreenArgs` | `V3ScreenText` | Reads the last logical lines of an agent's screen. |
| `daemon.status` | `StatusArgs` | `StatusResult` | Reports the daemon's status on a machine. |
| `workspace.import_legacy` | `LegacyWorkspaceArgs` | `LegacyWorkspaceResult` | Reads the verified members of a legacy workspace. |
| `machine.list` | `NoArgs` | `V3MachineListResult` | Lists known machines and routes. |
| `machine.add` | `V3MachineAddArgs` | `MachineAddResult` | Saves a verified SSH connection. |
| `machine.connect` | `V3MachineConnectArgs` | `V3MachineConnectResult` | Authorizes a foreground machine connection. |
| `machine.remove` | `MachineRemoveArgs` | `MachineRemoveResult` | Removes the local saved connection and reports remaining reachability. |
| `machine.rename` | `MachineRenameArgs` | `MachineRenameResult` | Changes the name on the selected machine. |
| `daemon.log` | `DaemonLogArgs` | `DaemonLogResult` | Reads the daemon's log, `core/logs/daemon.log`, which Facade keeps for 30 days: its last `lines` lines, oldest first. For the person's clients alone: the log names every agent and who sent whom a message, so a call that acts for an agent or a guest answers `refused`, YOLO or not. More than 200 lines answers `invalid_argument`. |
| `daemon.upgrade` | `UpgradeArgs` | `UpgradeResult` | Hands the running Facade over to a newer build, `program`, while every agent runs on, and answers once the handover is under way; `closing` follows on every connection past `hello`. The build must be of a higher version than this daemon's and speak its daemon protocol version; while agents run, it must also speak the running keeper's protocol, as the keeper never changes build while it holds CLIs. This daemon installs the build, points the launchers at it, drains and exits; the keeper then starts the launcher's daemon, the new build, and starts it again with its restart delay where it does not come up. Nothing rolls back. Calls that arrive meanwhile answer `upgrading` and did nothing. A second request while a handover is under way answers when the first does. |

## Error reasons

The `data.reason` values of the daemon protocol.

| Reason | When |
|---|---|
| `invalid_argument` | An argument is missing, malformed, or out of range, or the request is unsupported. |
| `not_found` | The agent, run, message, or watch does not exist. |
| `session_not_found` | The selected machine confirmed that the requested CLI session does not exist. |
| `ambiguous_reference` | A reference names more than one agent, or the person and an agent: select one by its ID. |
| `ended` | The agent ended: it takes no more input or messages. |
| `partial_input` | A text or keys call stopped partway: the agent ended, or its terminal stopped taking input, after part of the call reached the terminal. The error's data says what went in. |
| `unavailable` | The operation cannot complete: for example, a stop or a screen watch's snapshot timed out, or the keeper disconnected. |
| `protocol_incompatible` | The two sides share no protocol version, or a required client kind, operation, or field is unsupported. |
| `machine_id_conflict` | Two running daemons introduced themselves with the same machine ID. |
| `ssh_interaction_required` | A saved SSH connection needs a foreground login or verification. |
| `capacity_exceeded` | A message exceeds the line limit, or input exceeds the per-call limit or available queue room. |
| `internal` | An internal Facade error. |
| `refused` | The caller is not allowed to perform this operation. The keeper accepts only the daemon holding the daemon lock. |
| `configuration_invalid` | Facade's settings file, `facade.json` in the Facade home, cannot be read as it must, which stops every launch until it is fixed. The message says each problem, with the file's path and, where known, its line and column. |
| `cancelled` | The call was withdrawn by its `cancel` before it took effect: a message whose paste had not begun, which is not kept. |
| `worktree_failed` | Git could not make a worktree it was asked for: `data.kept` says what it made, which stays. |
| `upgrading` | A newer Facade is taking over: the call did nothing, and a client repeats it once the new daemon answers. |
| `unsupported` | The CLI cannot do what the call asks of it: take a model or an effort it has no way to set, or resume a session that a CLI of another type had. |

## Types

### AdvertiseParams

`V3AdvertiseParams`

### AgentArgs

`V3AgentArgs`

### AgentCreator

The source of an agent's start, as displayed to the caller.

`{ readonly kind: 'agent'; readonly address: string } \| { readonly kind: 'command_line' } \| { readonly kind: 'vs_code' }`

### AgentInfo

`V3AgentInfo`

### AgentKind

`'managed' \| 'guest'`

### AgentLabel

The identity and state of the reachable agent selected by an operation or offered as a match.

| Field | Type | Required | Description |
|---|---|---|---|
| `reference` | `AgentRef` | yes |  |
| `address` | `string` | yes | The agent's address in the requesting daemon's machine view. |
| `name` | `string` | yes |  |
| `cli` | `string` | yes |  |
| `state` | `V3AgentState` | yes |  |
| `resumable` | `boolean` | yes | The managed agent has a recorded session that Facade can resume. |

### AgentListEntry

A roster row and the exact reference to use for later operations.

| Field | Type | Required | Description |
|---|---|---|---|
| `reference` | `AgentRef` | yes |  |
| `id` | `string` | yes |  |
| `name` | `string` | yes |  |
| `type` | `AgentKind` | yes |  |
| `state` | `V3AgentState` | yes |  |
| `cli` | `string` | yes |  |
| `title` | `string` | no |  |
| `folder` | `string` | yes |  |
| `started_at` | `string` | yes |  |

### AgentListResult

`V3AgentListResult`

### AgentListRow

A public roster row. The ID is the agent's copyable address.

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | yes |  |
| `name` | `string` | yes |  |
| `type` | `AgentKind` | yes |  |
| `state` | `V3AgentState` | yes |  |
| `cli` | `string` | yes |  |
| `title` | `string` | no |  |
| `folder` | `string` | yes |  |
| `started_at` | `string` | yes |  |

### AgentMachineState

`V3AgentMachineState`

### AgentRef

An agent's durable identity, independently of names and routes.

| Field | Type | Required | Description |
|---|---|---|---|
| `machine_id` | `string` | yes |  |
| `agent_id` | `string` | yes |  |

### AgentRemoval

The recorded cause of an agent record's removal.

`'expired' \| 'removed'`

### AgentState

`V3AgentState`

### AgentSyncState

`'synced' \| 'pending' \| 'unreachable'`

### AgentTarget

`{ readonly agent: string; readonly reference?: never } \| { readonly agent?: never; readonly reference: AgentRef }`

### AgentsChange

`V3AgentsChange`

### AgentsSnapshot

`V3AgentsSnapshot`

### AttachmentInfo

| Field | Type | Required | Description |
|---|---|---|---|
| `kind` | `AttachmentKind` | yes |  |
| `machine_id` | `string` | yes |  |

### AttachmentKind

`'shell' \| 'vs_code'`

### CallParams

Parameters for `call`.

`{ readonly op: 'agent.list'; readonly args: MachineQueryArgs } \| { readonly op: 'agent.inspect'; readonly args: V3AgentArgs } \| { readonly op: 'agent.start'; readonly args: V3StartArgs } \| { readonly op: 'agent.start_preflight'; readonly args: V3StartArgs } \| { readonly op: 'agent.resume_list'; readonly args: ResumeListArgs } \| { readonly op: 'agent.resume'; readonly args: V3ResumeArgs } \| { readonly op: 'location.list'; readonly args: LocationListArgs } \| { readonly op: 'cli.list'; readonly args: CliListArgs } \| { readonly op: 'agent.stop'; readonly args: V3AgentArgs } \| { readonly op: 'agent.remove'; readonly args: V3AgentArgs } \| { readonly op: 'agent.rename'; readonly args: V3RenameArgs } \| { readonly op: 'agent.type'; readonly args: V3TypeArgs } \| { readonly op: 'agent.send'; readonly args: V3SendArgs } \| { readonly op: 'agent.resize'; readonly args: V3ResizeArgs } \| { readonly op: 'agent.screen'; readonly args: V3ScreenArgs } \| { readonly op: 'daemon.status'; readonly args: StatusArgs } \| { readonly op: 'workspace.import_legacy'; readonly args: LegacyWorkspaceArgs } \| { readonly op: 'machine.list'; readonly args: NoArgs } \| { readonly op: 'machine.add'; readonly args: V3MachineAddArgs } \| { readonly op: 'machine.connect'; readonly args: V3MachineConnectArgs } \| { readonly op: 'machine.remove'; readonly args: MachineRemoveArgs } \| { readonly op: 'machine.rename'; readonly args: MachineRenameArgs } \| { readonly op: 'daemon.log'; readonly args: DaemonLogArgs } \| { readonly op: 'daemon.upgrade'; readonly args: UpgradeArgs }`

### Caller

`V3Caller`

### ChangedParams

A `changed` notification for one watch.

| Field | Type | Required | Description |
|---|---|---|---|
| `watch` | `number` | yes | The watch number returned on this connection. |
| `change` | `V3AgentsChange \| ScreenChange \| V3MachinesChange` | yes | A change with the type defined by the watched topic. |

### CliInfo

A CLI a start can run: an entry of Facade's settings file (CONFIGURATION-2.1).

| Field | Type | Required | Description |
|---|---|---|---|
| `cli` | `string` | yes | The name a start gives: a built-in's, such as `claude`, or the name of a CLI the settings file adds. |
| `display_name` | `string` | yes | The name people know it by: a built-in's, such as `Claude Code`, or an added CLI's own. |
| `available` | `boolean` | yes | Whether it can be started: its entry is right and its program is found. |
| `problem` | `string` | no | Why it cannot be started: what is wrong with its entry, or that its program cannot run where it would start, each said by its setting. Omitted where it can. |
| `not_installed` | `boolean` | no | A built-in CLI whose entry has no problem and names no program of its own, and whose program is not found where the start would run: not installed. Only with `available` false. A client may leave it out of its list instead of showing it as one that cannot start. Omitted otherwise. |
| `overrides` | `Overrides` | yes | Whether a start can choose its model and its effort (CLIS-1.4). |

### CliListArgs

Lists CLIs using the selected machine's launch environment and working folder.

| Field | Type | Required | Description |
|---|---|---|---|
| `machine` | `string` | no |  |
| `folder` | `string` | no |  |
| `env` | `{ readonly [key: string]: string }` | no | The client's launch environment for a local query. |

### CliListResult

| Field | Type | Required | Description |
|---|---|---|---|
| `clis` | `CliInfo[]` | yes |  |
| `settings_problem` | `string` | no |  |

### ClientKind

The kind of client connecting to the daemon.

`'terminal' \| 'mcp' \| 'ide' \| 'machine'`

### ConnectFailedParams

Foreground handshake failed after local authorization.

| Field | Type | Required | Description |
|---|---|---|---|
| `error` | `ErrorBody` | yes |  |

### ConnectedParams

Connection verified on the foreground stream.

| Field | Type | Required | Description |
|---|---|---|---|
| `machine` | `MachineHello` | yes |  |
| `first_connection` | `boolean` | yes |  |

### ConnectionKind

`'saved' \| 'temporary'`

### ConnectionState

`'connected' \| 'unavailable' \| 'ssh_interaction_required'`

### CreatorKind

`'agent' \| 'command_line' \| 'vs_code'`

### DaemonLogArgs

Arguments for `daemon.log`.

| Field | Type | Required | Description |
|---|---|---|---|
| `lines` | `number` | no | How many of the log's last lines to read: 200 where absent, and at most 200. |

### DaemonLogResult

The result of `daemon.log`.

| Field | Type | Required | Description |
|---|---|---|---|
| `lines` | `string[]` | yes | The last lines of `core/logs/daemon.log`, oldest first, the home folder written as `~`. Empty where there is no log. |

### DeliverStartResultArgs

`V3DeliverStartResultArgs`

### DeliveredVia

How a message was delivered.

`'terminal' \| 'read' \| 'notified'`

### Delivery

What became of a message.

| Field | Type | Required | Description |
|---|---|---|---|
| `status` | `DeliveryStatus` | yes | `pending` while the message is being delivered, then `success` or `failure`. |
| `reason` | `DeliveryFailure` | no | Why it was not delivered. Omitted unless it failed. |
| `text_written` | `TextWritten` | yes | How much of the message reached the recipient's terminal. |
| `enter_written` | `boolean` | no | Whether the Enter that submits it reached the recipient's terminal. Omitted when that is not known: the recipient read the message while its typist was typing it, its typist did not say by the deadline, what it typed was still queued then, or the daemon before a restart had begun its paste. |
| `deadline` | `string` | no | When a pending delivery fails if the message is not delivered by then. Omitted once it is settled. |
| `delivered_via` | `DeliveredVia` | no | How the message was delivered. Omitted unless it was. |
| `delivered_at` | `string` | no | When the message was delivered. Omitted unless it was. |

### DeliveryFailure

Why a message was not delivered.

`'ended' \| 'input_draft' \| 'input_interaction' \| 'input_unknown' \| 'timeout' \| 'submission_unconfirmed' \| 'unsupported'`

### DeliveryStatus

The state of a message's delivery.

`'pending' \| 'success' \| 'failure'`

### EmptyResult

An empty success result: `{}`.

`Record<string, never>`

### EndReason

Why an exit has no code or signal.

`'terminal_closed'`

### ErrorBody

A request error.

| Field | Type | Required | Description |
|---|---|---|---|
| `code` | `number` | yes | The JSON-RPC error code: -32700 for invalid JSON, -32600 for an invalid request, -32601 for an unknown method, -32602 for invalid arguments, and -32000 for other failures. |
| `message` | `string` | yes | A plain-language explanation of the error. |
| `data` | `ErrorData` | yes | Structured error details. |

### ErrorData

Error details for clients to inspect.

| Field | Type | Required | Description |
|---|---|---|---|
| `reason` | `Reason` | yes | The error reason for clients to inspect. |
| `text_written` | `TextWritten` | no | With `partial_input` for text: how much of the text reached the agent's terminal. |
| `enter_written` | `boolean` | no | With `partial_input` for text: whether its Enter reached the agent's terminal. |
| `keys_sent` | `number` | no | With `partial_input` for keys: how many keys reached the agent's terminal whole. |
| `kept` | `Kept` | no | With `worktree.create`, or `agent.start` with a `worktree`, that failed after Git made part or all of the worktree: what it made, which stays. |
| `entry` | `string` | no | With a refused start or resume that an entry of the settings file caused - its program not found, the entry turned off or wrong, or a model or effort the entry gives that its CLI cannot take - the entry's name, such as `claude`. A client offers to open the settings file. |
| `protocol` | `ProtocolMismatch` | no |  |
| `available_clis` | `string[]` | no | CLIs that can start here when the requested CLI is not configured. |
| `message_ref` | `MessageRef` | no | The original kept message, where its delivery outcome is unknown. |
| `record_removal` | `AgentRemoval` | no | A confirmed reason the addressed agent record was removed. |
| `machine_id_conflict` | `MachineIdConflict` | no |  |
| `ssh_interaction` | `SshInteraction` | no |  |
| `unavailable` | `Unavailable` | no |  |
| `candidates` | `string[]` | no | Complete references that matched a name or machine ID prefix. |
| `agents` | `AgentLabel[]` | no | Reachable matches or the reachable agent whose operation failed. |
| `machines` | `V3MachineQueryResult[]` | no | Matching machines or the selected machine whose connection failed. |
| `sessions` | `SessionMatch[]` | no | Saved sessions matching the requested ID. |

### ExecutionOutcome

`'not_executed' \| 'outcome_unknown'`

### ForwardCall

`V3ForwardCall`

### ForwardParams

`V3ForwardParams`

### HelloParams

`V3HelloParams`

### HelloResult

The result of `hello`: daemon details and supported topics and operations.

| Field | Type | Required | Description |
|---|---|---|---|
| `protocol` | `number` | yes | The highest protocol version shared by the client and daemon. |
| `build` | `string` | yes | The daemon's build. |
| `machine_id` | `string` | yes | The daemon's Facade machine ID. |
| `machine` | `MachineHello` | no | The answering daemon's introduction on a machine session. |
| `ops` | `string[]` | yes | Operation names accepted by `call`. |
| `pid` | `number` | yes | The daemon's process ID. |
| `topics` | `string[]` | yes | Topic names accepted by `watch`. |
| `agents` | `number` | yes | The number of agent records when `hello` runs. Watch `agents` to receive changes. |
| `keeper` | `KeeperInfo` | no | The keeper holding the agents' terminals. Omitted while no keeper runs; the daemon starts one for the first agent. |

### HiddenRows

Rows of a draft scrolled out of the CLI's input, as the CLI marks them.

| Field | Type | Required | Description |
|---|---|---|---|
| `above` | `number` | yes | Rows hidden above the visible input. |
| `below` | `number` | yes | Rows hidden below the visible input. |

### HowEnded

How an agent's process ended.

`'normal' \| 'stopped' \| 'crashed'`

### InboxMessage

A complete inbox message as the receiving MCP client reads it.

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | yes |  |
| `from` | `string` | yes |  |
| `at` | `string` | yes |  |
| `text` | `string` | yes |  |
| `reply_to` | `string` | no |  |

### InputInfo

An agent's message input as its screen shows it now.

| Field | Type | Required | Description |
|---|---|---|---|
| `state` | `InputState` | yes |  |
| `evidence` | `string` | yes | What on the screen the state rests on, such as `the input frame at row 22 is empty`. Never the draft's text. |
| `mechanism` | `InputMechanism` | no | The layout the agent's CLI rule reads. Omitted without a rule. |
| `hidden` | `HiddenRows` | no | Draft rows scrolled out of the input. Omitted unless the CLI marks such rows. |

### InputMechanism

The layout a CLI's rule reads its input from.

`'frame' \| 'prompt' \| 'editor' \| 'box' \| 'prompt_row'`

### InputState

How an agent's message input reads on its screen. A reading never means input may be typed.

`'usable' \| 'draft' \| 'interaction' \| 'unknown'`

### InspectResult

`V3InspectResult`

### KeeperInfo

The keeper holding the agents' terminals.

| Field | Type | Required | Description |
|---|---|---|---|
| `pid` | `number` | yes | The keeper process ID. |
| `build` | `string` | yes | The keeper build identifier. |

### Kept

What a worktree creation that failed partway made, which stays: its branch, its folder, or both.

| Field | Type | Required | Description |
|---|---|---|---|
| `branch` | `string` | no | The branch it made. |
| `path` | `string` | no | The folder it made, an absolute path. |

### LegacyWorkspaceArgs

One legacy workspace selector from the specified machine.

`{ readonly machine_id: string; readonly workspace_key?: string; readonly window_id?: string; readonly instance_id?: string } & ({ readonly workspace_key: string; readonly window_id?: never; readonly instance_id?: never } \| { readonly workspace_key?: never; readonly window_id: string; readonly instance_id?: never } \| { readonly workspace_key?: never; readonly window_id?: never; readonly instance_id: string })`

### LegacyWorkspaceResult

| Field | Type | Required | Description |
|---|---|---|---|
| `agents` | `AgentRef[]` | yes |  |
| `machines` | `V3MachineQueryResult[]` | yes |  |

### LocationInfo

`V3LocationInfo`

### LocationKind

What a location is.

`'folder' \| 'main' \| 'worktree'`

### LocationListArgs

| Field | Type | Required | Description |
|---|---|---|---|
| `machine` | `string` | no |  |
| `folders` | `string[]` | no |  |

### LocationListResult

`V3LocationListResult`

### MachineAddArgs

`V3MachineAddArgs`

### MachineAddResult

The saved connection is ready.

| Field | Type | Required | Description |
|---|---|---|---|
| `machine` | `MachineHello` | yes |  |
| `first_connection` | `boolean` | yes |  |

### MachineConnectArgs

`V3MachineConnectArgs`

### MachineConnectResult

`V3MachineConnectResult`

### MachineConnection

`V3MachineConnection`

### MachineHello

The introduction on each side of a machine hello.

| Field | Type | Required | Description |
|---|---|---|---|
| `machine_id` | `string` | yes |  |
| `boot_id` | `string` | yes | Changes each time the daemon starts. Distinguishes concurrent uses of a machine ID. |
| `name` | `string` | yes |  |
| `build` | `string` | yes |  |
| `protocol` | `[number, number]` | yes |  |
| `ssh_cleans_processes` | `boolean` | no | On Linux, whether the system clears this user's processes at the end of the SSH session. |

### MachineIdConflict

| Field | Type | Required | Description |
|---|---|---|---|
| `machine_id` | `string` | yes |  |
| `paths` | `[string, string]` | yes | Both conflicting connection paths, including their sources. |

### MachineIdentity

A machine's persistent identity and current display name.

| Field | Type | Required | Description |
|---|---|---|---|
| `machine_id` | `string` | yes |  |
| `name` | `string` | yes |  |

### MachineInfo

`V3MachineInfo`

### MachineListResult

`V3MachineListResult`

### MachineMessage

A frame from either direction of a machine session. A request without an ID is a notification.

`Request \| Response`

### MachineQueryArgs

Selects a machine for a query. An omitted selector uses the operation's default.

| Field | Type | Required | Description |
|---|---|---|---|
| `machine` | `string` | no |  |

### MachineQueryResult

`V3MachineQueryResult`

### MachineQueryStatus

`'answered' \| 'unavailable' \| 'timed_out' \| 'error'`

### MachineRemoveArgs

| Field | Type | Required | Description |
|---|---|---|---|
| `machine` | `string` | yes | An input machine selector. |

### MachineRemoveResult

| Field | Type | Required | Description |
|---|---|---|---|
| `machine_id` | `string` | yes |  |
| `name` | `string` | no | The machine whose saved connection was removed. |
| `ssh_destination` | `string` | yes |  |
| `remote_home` | `string` | no |  |
| `reachable` | `boolean` | yes |  |
| `via` | `string` | no | The next machine on a remaining indirect route, in the client's machine view. |

### MachineRenameArgs

| Field | Type | Required | Description |
|---|---|---|---|
| `machine` | `string` | yes | An input machine selector. |
| `name` | `string` | yes |  |

### MachineRenameResult

| Field | Type | Required | Description |
|---|---|---|---|
| `machine_id` | `string` | yes |  |
| `name` | `string` | yes |  |
| `previous_name` | `string` | no |  |

### MachineState

`'online' \| 'connecting' \| 'sleeping' \| 'unreachable' \| 'ssh_interaction_required'`

### MachineTransport

`V3MachineTransport`

### MachinesChange

`V3MachinesChange`

### Message

`V3Message`

### MessageRef

A message's identity on the machine that assigned its number.

| Field | Type | Required | Description |
|---|---|---|---|
| `machine_id` | `string` | yes |  |
| `message_id` | `string` | yes |  |

### NoArgs

Empty arguments: `{}`. May be omitted for topics that take no arguments.

`Record<string, never>`

### Notification

A message without an ID or response, such as `changed`.

| Field | Type | Required | Description |
|---|---|---|---|
| `jsonrpc` | `string` | no | Always `2.0`. |
| `method` | `string` | yes | The notification method, such as `changed`. |
| `params` | `unknown` | no | Parameters for the notification method. |

### Overrides

Whether a start can choose a CLI's model and its effort.

| Field | Type | Required | Description |
|---|---|---|---|
| `model` | `boolean` | yes |  |
| `effort` | `boolean` | yes |  |

### ProcessExit

A recorded CLI exit. Without a code or signal, its status is unavailable; do not treat it as exit code zero.

| Field | Type | Required | Description |
|---|---|---|---|
| `code` | `number` | no | The exit code, if the CLI exited normally and its status is known. On Windows every exit has one: the process's 32-bit exit code carried as an `i32`, so that 0xC000013A is -1073741510. |
| `signal` | `string` | no | The terminating signal name, such as `SIGKILL`. Signal numbers vary by system. Never on Windows. |
| `reason` | `EndReason` | no | Why no code or signal is available, if known. If all three fields are absent, the exit status is unavailable. |
| `at` | `string` | yes | The exit time in UTC ISO 8601 format with milliseconds. For an exit without a code or signal, the time Facade noticed it. |

### ProcessState

The reported process state of an agent.

`'running' \| 'ended'`

### PromptOutcome

A start prompt's message ID and what became of it.

| Field | Type | Required | Description |
|---|---|---|---|
| `message_id` | `string` | yes |  |
| `delivery` | `Delivery` | yes |  |

### ProtocolMismatch

| Field | Type | Required | Description |
|---|---|---|---|
| `local_build` | `string` | yes |  |
| `local_protocol` | `[number, number]` | yes |  |
| `remote_build` | `string` | yes |  |
| `remote_protocol` | `[number, number]` | yes |  |

### ReadMessagesArgs

The public MCP inbox request.

| Field | Type | Required | Description |
|---|---|---|---|
| `after` | `string` | no |  |
| `last` | `number` | no |  |
| `wait` | `boolean` | no |  |
| `reply_to` | `string` | no |  |

### ReadMessagesResult

| Field | Type | Required | Description |
|---|---|---|---|
| `messages` | `InboxMessage[]` | yes |  |
| `next_cursor` | `string` | no | Continue the page by passing this value as `after`. |

### Reason

Error reasons shared by both protocols.

`'invalid_argument' \| 'not_found' \| 'session_not_found' \| 'ambiguous_reference' \| 'ended' \| 'partial_input' \| 'unavailable' \| 'protocol_incompatible' \| 'machine_id_conflict' \| 'ssh_interaction_required' \| 'capacity_exceeded' \| 'internal' \| 'refused' \| 'configuration_invalid' \| 'cancelled' \| 'worktree_failed' \| 'upgrading' \| 'unsupported'`

### RemoveResult

| Field | Type | Required | Description |
|---|---|---|---|
| `reference` | `AgentRef` | yes |  |
| `address` | `string` | yes |  |

### RenameArgs

`V3RenameArgs`

### RenameResult

An agent's details.

| Field | Type | Required | Description |
|---|---|---|---|
| `agent_id` | `string` | yes | The stable ID is `a` followed by a number. It is unique within its Facade home while that home's SQLite database (`core/facade.db`) retains the agent number counter. |
| `address` | `string` | yes | The copyable address, including a machine selector. The serving daemon fills client views. |
| `type` | `AgentKind` | yes |  |
| `label` | `string` | no | The label in the serving client's machine view. |
| `unreachable` | `boolean` | no | The running machine is currently unreachable. |
| `name` | `string` | yes | The display name. Names are nonempty but may repeat. |
| `cli` | `string` | yes | The CLI: the name of its entry in Facade's settings file, a built-in's such as `claude` or an added one such as `Codex · work` (CONFIGURATION-2.1), or the program's file name for a program started by its path or name. |
| `args` | `string[]` | yes |  |
| `model` | `string` | no |  |
| `effort` | `string` | no |  |
| `title` | `string` | no |  |
| `cwd` | `string` | yes | The CLI's working folder at startup. |
| `machine_id` | `string` | yes | The ID of the Facade machine that runs the agent. |
| `pid` | `number` | no | The CLI's process ID. Omitted for a guest, whose process Facade does not know. |
| `process` | `ProcessState` | yes | Whether the CLI is running or ended. |
| `cols` | `number` | no | Terminal width in columns. Omitted for a guest, which has no terminal of Facade's. |
| `rows` | `number` | no | Terminal height in rows. Omitted for a guest. |
| `created_at` | `string` | yes | When the agent was first created, in UTC ISO 8601 format with milliseconds. |
| `started_at` | `string` | yes | The latest start or resume time, in UTC ISO 8601 format with milliseconds. |
| `creator_kind` | `CreatorKind` | no |  |
| `creator` | `string` | no | The agent whose client started it. Omitted where the person started it, and for a guest. |
| `creator_machine_id` | `string` | no | The creator's machine ID. Omitted when it is the record's own machine. |
| `root` | `string` | yes | The first agent of its creation tree: itself where it has no creator, or else its creator's root. It stays when agents of the tree end or go. |
| `root_machine_id` | `string` | no | The root agent's machine ID. Omitted when it is the record's own machine. |
| `yolo` | `boolean` | yes | Whether its run has YOLO on: its CLI runs without asking, and it reaches every agent. With YOLO off, its CLI runs as it natively does, and it reaches only the agents of its creation tree. A launch takes it from Facade's settings file, `facade.json`, as it is accepted; a guest as it joins. |
| `exit` | `ProcessExit` | no | The recorded exit. Omitted while the agent is running. |
| `session` | `string` | no | The ID of the CLI session the agent's CLI last reported, which `agent.resume` continues. Omitted until one is reported. |
| `state` | `V3AgentState` | yes | What the agent is doing. |
| `state_detail` | `StateDetail` | no | More about the state: what the CLI waits for, its own words, how its process ended, or why the state is unknown. |
| `said` | `Said` | no | The last thing that went into the agent's message input. Omitted until something has. |
| `tools_state` | `ToolsState` | yes | Whether the agent's CLI can use Facade's tools. |
| `tools_reason` | `ToolsReason` | no | Why the agent's CLI cannot use Facade's tools. Omitted unless they are unavailable. |
| `previous_name` | `string` | no | The name this operation replaced. |

### Request

A method call. Calls with an ID receive a response; calls without an ID are notifications.

| Field | Type | Required | Description |
|---|---|---|---|
| `jsonrpc` | `string` | no | Always `2.0`. |
| `id` | `number` | no | A non-negative integer request ID, at most u64::MAX. Omit it for a notification. The response repeats this ID. |
| `method` | `string` | yes | The method name, such as `hello` or `call`. |
| `params` | `unknown` | no | Parameters for the named method. |

### ResizeArgs

`V3ResizeArgs`

### Response

A response containing either a result or an error.

| Field | Type | Required | Description |
|---|---|---|---|
| `jsonrpc` | `string` | no | Always `2.0`. |
| `id` | `number \| null` | yes | The request ID, or `null` for a malformed request. |
| `result` | `unknown` | no | The success result, with the type defined by the method or operation. |
| `error` | `ErrorBody` | no | The error on failure. Omitted when the response contains a result. |

### ResumeArgs

`V3ResumeArgs`

### ResumeCandidate

| Field | Type | Required | Description |
|---|---|---|---|
| `target` | `ResumeTarget` | yes |  |
| `cli` | `string` | yes |  |
| `folder` | `string` | yes |  |
| `machine_id` | `string` | yes |  |
| `session` | `string` | yes |  |
| `agent` | `AgentRef` | no |  |
| `name` | `string` | no | The name of a managed agent. Omitted for a saved session. |
| `stopped` | `boolean` | no | The managed run ended because Facade stopped it. |
| `title` | `string` | no |  |
| `at` | `string` | no | The managed run's exit time or the saved session's modification time. |

### ResumeListArgs

| Field | Type | Required | Description |
|---|---|---|---|
| `machine` | `string` | no |  |
| `folder` | `string` | no |  |
| `all` | `boolean` | no |  |

### ResumeListResult

| Field | Type | Required | Description |
|---|---|---|---|
| `items` | `ResumeCandidate[]` | yes |  |
| `machines` | `V3MachineQueryResult[]` | yes |  |

### ResumeResult

| Field | Type | Required | Description |
|---|---|---|---|
| `agent` | `V3AgentInfo` | yes |  |
| `from_saved_session` | `boolean` | no | The call created a new agent to open a saved CLI session. |

### ResumeTarget

The copyable agent address or the CLI session and its working location.

| Field | Type | Required | Description |
|---|---|---|---|
| `reference` | `string` | yes |  |
| `machine` | `string` | no |  |
| `folder` | `string` | no |  |

### Said

What last went into an agent's message input with Enter: what the person submitted in its terminal and its CLI took, text typed with `agent.type` and `enter`, or a message delivered through the terminal.

| Field | Type | Required | Description |
|---|---|---|---|
| `text` | `string` | yes | The text on one line, at most 1,024 characters. |
| `from` | `string` | yes | Who said it: an agent ID, or `human` for the person. |
| `from_name` | `string` | no | The agent's name when it said it. Omitted for the person. |
| `at` | `string` | yes | When, in UTC ISO 8601 format with milliseconds. |

### ScreenArgs

`V3ScreenArgs`

### ScreenBuffer

The screen buffer a CLI shows.

`'normal' \| 'alternate'`

### ScreenChange

A change to the `screen` topic. `exit` follows all output the CLI wrote before ending; processes still holding its terminal may write afterward. On macOS, the terminal is taken from those processes when the CLI ends. `removed` is the watch's last change. Skip unknown change kinds.  `snapshot.redraw`, `output.data`, and `redraw.data` contain standard base64 with padding. Decode them to bytes and feed those bytes to the viewer's terminal parser. Set the viewer to `snapshot.cols` by `snapshot.rows` before the initial redraw. Each redraw change carries its own `cols` and `rows`; use that size before applying its `data`. Process changes for each watch in arrival order. Apply `output` as continuation bytes; `redraw` supplies a replacement terminal sequence. Preserve parser state between messages. Do not treat the decoded bytes as plain text; use `agent.screen` for plain text.

`{ readonly kind: 'output'; readonly data: string } \| { readonly kind: 'redraw'; readonly data: string; readonly cols: number; readonly rows: number } \| { readonly kind: 'exit'; readonly exit: ProcessExit; readonly exit_status?: number } \| { readonly kind: 'removed' }`

### ScreenSnapshot

`V3ScreenSnapshot`

### ScreenText

`V3ScreenText`

### ScreenWatchArgs

`V3ScreenWatchArgs`

### SendArgs

`V3SendArgs`

### SendResult

`V3SendResult`

### ServerMessage

A response or notification received from a server.

`Notification \| Response`

### SessionMatch

A saved session that matched the requested session ID.

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | yes | The full CLI session ID. |
| `cli` | `string` | yes |  |
| `title` | `string` | no |  |

### SshInteraction

| Field | Type | Required | Description |
|---|---|---|---|
| `reason` | `string` | yes |  |
| `command` | `string[]` | yes | The complete command and arguments with which to repair the saved connection. |

### StartArgs

`V3StartArgs`

### StartOutcome

`V3StartOutcome`

### StartResult

`V3StartResult`

### StateDetail

More about an agent's state.

| Field | Type | Required | Description |
|---|---|---|---|
| `kind` | `WaitKind` | no | What the CLI waits for, on `waiting_for_you`. |
| `text` | `string` | no | The CLI's own words where it gave any, on `waiting_for_you` and on an `error` the CLI reported. Untrusted text on one line. |
| `how` | `HowEnded` | no | How the process ended, on `ended`. Omitted when its exit status is unavailable and Facade did not stop it; `exit.reason` says what is known. |
| `reason` | `StateReason` | no | Why nothing shows what the CLI is doing, on `unknown`, or what Facade found wrong, on an `error` it found: a start that showed nothing, or tools the CLI cannot use. |

### StateReason

Why nothing shows what an agent's CLI is doing, or what Facade found wrong with it.

`'not_shown' \| 'asked' \| 'taken_back' \| 'unrecognized' \| 'not_ready' \| 'tools_unavailable'`

### StatusArgs

| Field | Type | Required | Description |
|---|---|---|---|
| `machine` | `string` | no |  |

### StatusResult

| Field | Type | Required | Description |
|---|---|---|---|
| `home` | `string` | yes |  |
| `settings_file` | `string` | yes |  |
| `build` | `string` | yes |  |
| `daemon_pid` | `number` | yes |  |
| `keeper_pid` | `number` | no |  |
| `agents` | `number` | yes |  |
| `machines` | `V3MachineQueryResult[]` | yes |  |

### StopResult

`V3StopResult`

### TerminalColors

The colors an editor window's terminals draw with, each `#rrggbb`. An agent of the window replies to its CLI's OSC 10, 11 and 12 queries with them; a color left out gets no reply.

| Field | Type | Required | Description |
|---|---|---|---|
| `foreground` | `string` | no |  |
| `background` | `string` | no |  |
| `cursor` | `string` | no |  |

### TextWritten

How much of a message reached the recipient's terminal.

`'none' \| 'partial' \| 'full' \| 'unknown'`

### ToolsReason

Why an agent's CLI cannot use the Facade tools it was given.

`'not_given' \| 'not_connected' \| 'not_started' \| 'disconnected' \| 'ended'`

### ToolsState

Whether an agent's CLI can use Facade's tools: `facade-mcp`, the MCP server that a CLI started by its rule is given for its run.

`'not_injected' \| 'connecting' \| 'available' \| 'unavailable'`

### TypeArgs

`V3TypeArgs`

### TypeResult

| Field | Type | Required | Description |
|---|---|---|---|
| `agent` | `AgentLabel` | no | The target that took the input. Raw terminal input keeps the empty receipt. |

### Unavailable

| Field | Type | Required | Description |
|---|---|---|---|
| `execution` | `ExecutionOutcome` | yes |  |
| `machine` | `MachineIdentity` | no |  |
| `unanswered` | `MachineIdentity[]` | no |  |
| `matches` | `string[]` | no | Complete addresses returned before a name lookup could finish. |

### UnwatchParams

Parameters for `unwatch`.

| Field | Type | Required | Description |
|---|---|---|---|
| `watch` | `number` | yes | The watch number returned by `watch` on this connection. |

### UpgradeArgs

Arguments for `daemon.upgrade`: the program of a newer build that takes over, as the command that asks runs it.

| Field | Type | Required | Description |
|---|---|---|---|
| `program` | `string` | yes | The program, a `facade`, with its `facade-mcp` beside it. |
| `build` | `string` | yes | Its build, as its `hello` says it. |
| `daemon_protocol` | `[number, number]` | yes | The daemon protocol range accepted for this takeover, lowest and highest. |
| `keeper_protocol` | `[number, number]` | yes | The keeper protocol versions it speaks, lowest and highest. |

### UpgradeResult

The result of `daemon.upgrade`.

| Field | Type | Required | Description |
|---|---|---|---|
| `from` | `string` | yes | The build that hands over. |
| `agents` | `number` | yes | The agents that keep running through the takeover: those whose run runs. |

### V3AdvertiseParams

| Field | Type | Required | Description |
|---|---|---|---|
| `machines` | `V3MachineInfo[]` | yes |  |

### V3AgentArgs

`{ readonly agent: string; readonly reference?: never } \| { readonly agent?: never; readonly reference: AgentRef }`

### V3AgentInfo

An agent's details.

| Field | Type | Required | Description |
|---|---|---|---|
| `agent_id` | `string` | yes | The stable ID is `a` followed by a number. It is unique within its Facade home while that home's SQLite database (`core/facade.db`) retains the agent number counter. |
| `address` | `string` | yes | The copyable address, including a machine selector. The serving daemon fills client views. |
| `type` | `AgentKind` | yes |  |
| `label` | `string` | no | The label in the serving client's machine view. |
| `unreachable` | `boolean` | no | The running machine is currently unreachable. |
| `name` | `string` | yes | The display name. Names are nonempty but may repeat. |
| `cli` | `string` | yes | The CLI: the name of its entry in Facade's settings file, a built-in's such as `claude` or an added one such as `Codex · work` (CONFIGURATION-2.1), or the program's file name for a program started by its path or name. |
| `args` | `string[]` | yes |  |
| `model` | `string` | no |  |
| `effort` | `string` | no |  |
| `title` | `string` | no |  |
| `cwd` | `string` | yes | The CLI's working folder at startup. |
| `machine_id` | `string` | yes | The ID of the Facade machine that runs the agent. |
| `pid` | `number` | no | The CLI's process ID. Omitted for a guest, whose process Facade does not know. |
| `process` | `ProcessState` | yes | Whether the CLI is running or ended. |
| `cols` | `number` | no | Terminal width in columns. Omitted for a guest, which has no terminal of Facade's. |
| `rows` | `number` | no | Terminal height in rows. Omitted for a guest. |
| `created_at` | `string` | yes | When the agent was first created, in UTC ISO 8601 format with milliseconds. |
| `started_at` | `string` | yes | The latest start or resume time, in UTC ISO 8601 format with milliseconds. |
| `creator_kind` | `CreatorKind` | no |  |
| `creator` | `string` | no | The agent whose client started it. Omitted where the person started it, and for a guest. |
| `creator_machine_id` | `string` | no | The creator's machine ID. Omitted when it is the record's own machine. |
| `root` | `string` | yes | The first agent of its creation tree: itself where it has no creator, or else its creator's root. It stays when agents of the tree end or go. |
| `root_machine_id` | `string` | no | The root agent's machine ID. Omitted when it is the record's own machine. |
| `yolo` | `boolean` | yes | Whether its run has YOLO on: its CLI runs without asking, and it reaches every agent. With YOLO off, its CLI runs as it natively does, and it reaches only the agents of its creation tree. A launch takes it from Facade's settings file, `facade.json`, as it is accepted; a guest as it joins. |
| `exit` | `ProcessExit` | no | The recorded exit. Omitted while the agent is running. |
| `session` | `string` | no | The ID of the CLI session the agent's CLI last reported, which `agent.resume` continues. Omitted until one is reported. |
| `state` | `V3AgentState` | yes | What the agent is doing. |
| `state_detail` | `StateDetail` | no | More about the state: what the CLI waits for, its own words, how its process ended, or why the state is unknown. |
| `said` | `Said` | no | The last thing that went into the agent's message input. Omitted until something has. |
| `tools_state` | `ToolsState` | yes | Whether the agent's CLI can use Facade's tools. |
| `tools_reason` | `ToolsReason` | no | Why the agent's CLI cannot use Facade's tools. Omitted unless they are unavailable. |

### V3AgentListResult

| Field | Type | Required | Description |
|---|---|---|---|
| `agents` | `AgentListEntry[]` | yes |  |
| `machines` | `V3MachineQueryResult[]` | yes |  |

### V3AgentMachineState

| Field | Type | Required | Description |
|---|---|---|---|
| `machine_id` | `string` | yes |  |
| `state` | `AgentSyncState` | yes |  |
| `agents` | `V3AgentInfo[]` | no | For a synced machine, its complete records, including an empty list. |

### V3AgentState

The agent's current state.

`'starting' \| 'working' \| 'waiting_for_you' \| 'just_done' \| 'idle' \| 'error' \| 'ended' \| 'unknown' \| 'online'`

### V3AgentsChange

`{ readonly kind: 'updated'; readonly agent: V3AgentInfo } \| { readonly kind: 'removed'; readonly machine_id: string; readonly agent_id: string; readonly cause: AgentRemoval } \| { readonly kind: 'machine_state'; readonly machine: V3AgentMachineState }`

### V3AgentsSnapshot

| Field | Type | Required | Description |
|---|---|---|---|
| `agents` | `V3AgentInfo[]` | yes | Records on the machine that serves this view. |
| `machines` | `V3AgentMachineState[]` | yes |  |

### V3CallParams

`{ readonly op: 'agent.list'; readonly args: MachineQueryArgs } \| { readonly op: 'agent.inspect'; readonly args: V3AgentArgs } \| { readonly op: 'agent.start'; readonly args: V3StartArgs } \| { readonly op: 'agent.start_preflight'; readonly args: V3StartArgs } \| { readonly op: 'agent.resume_list'; readonly args: ResumeListArgs } \| { readonly op: 'agent.resume'; readonly args: V3ResumeArgs } \| { readonly op: 'location.list'; readonly args: LocationListArgs } \| { readonly op: 'cli.list'; readonly args: CliListArgs } \| { readonly op: 'agent.stop'; readonly args: V3AgentArgs } \| { readonly op: 'agent.remove'; readonly args: V3AgentArgs } \| { readonly op: 'agent.rename'; readonly args: V3RenameArgs } \| { readonly op: 'agent.type'; readonly args: V3TypeArgs } \| { readonly op: 'agent.send'; readonly args: V3SendArgs } \| { readonly op: 'agent.resize'; readonly args: V3ResizeArgs } \| { readonly op: 'agent.screen'; readonly args: V3ScreenArgs } \| { readonly op: 'daemon.status'; readonly args: StatusArgs } \| { readonly op: 'workspace.import_legacy'; readonly args: LegacyWorkspaceArgs } \| { readonly op: 'machine.list'; readonly args: NoArgs } \| { readonly op: 'machine.add'; readonly args: V3MachineAddArgs } \| { readonly op: 'machine.connect'; readonly args: V3MachineConnectArgs } \| { readonly op: 'machine.remove'; readonly args: MachineRemoveArgs } \| { readonly op: 'machine.rename'; readonly args: MachineRenameArgs } \| { readonly op: 'daemon.log'; readonly args: DaemonLogArgs } \| { readonly op: 'daemon.upgrade'; readonly args: UpgradeArgs } \| { readonly op: 'agent.deliver_start_result'; readonly args: V3DeliverStartResultArgs }`

### V3Caller

An identity verified by the daemon that accepted the original request.

`{ readonly kind: 'terminal'; readonly machine_id: string } \| { readonly kind: 'ide'; readonly machine_id: string } \| { readonly kind: 'agent'; readonly agent: AgentRef; readonly root: AgentRef; readonly yolo: boolean }`

### V3DeliverStartResultArgs

A start outcome with the message number already reserved on the recipient's machine.

| Field | Type | Required | Description |
|---|---|---|---|
| `recipient` | `AgentRef` | yes |  |
| `message` | `V3Message` | yes |  |

### V3ForwardCall

A forwarded call and the facts verified by the originating machine.

| Field | Type | Required | Description |
|---|---|---|---|
| `call` | `V3CallParams` | yes |  |
| `by_model` | `boolean` | yes |  |
| `from_name` | `string` | no |  |
| `recipient` | `AgentRef` | no | The resolved destination of `agent.send`, used again on retry. |

### V3ForwardParams

Parameters of `forward`. The outer JSON-RPC ID identifies this hop.

| Field | Type | Required | Description |
|---|---|---|---|
| `route` | `string[]` | yes | Remaining machine IDs, from this hop's receiver to the destination. |
| `caller` | `V3Caller` | yes |  |
| `time_left_ms` | `number` | no |  |
| `request_id` | `string` | no |  |
| `method` | `string` | yes |  |
| `params` | `unknown` | yes |  |

### V3HelloParams

Introduces a daemon client or a machine. Actor identity is supplied by the daemon.

| Field | Type | Required | Description |
|---|---|---|---|
| `protocol` | `[number, number]` | yes |  |
| `build` | `string` | yes |  |
| `kind` | `ClientKind` | yes |  |
| `machine` | `MachineHello` | no |  |

### V3InspectResult

| Field | Type | Required | Description |
|---|---|---|---|
| `agent` | `V3AgentInfo` | yes |  |
| `rule` | `string` | no | The CLI rule the agent was started by: its CLI's name, such as `claude`. Omitted for an agent started by a program path or a name without a rule. |
| `input` | `InputInfo` | yes |  |
| `session_tracking` | `boolean` | yes | Whether the running CLI reports its session to Facade. False for an ended agent. |
| `started_by` | `AgentCreator` | no | The recorded startup source, where it is known. |
| `viewers` | `string[]` | yes | The viewers currently attached to the terminal. |
| `attachments` | `AttachmentInfo[]` | no | The verified client kinds and originating machines of those attachments. |
| `launch_command` | `string` | no | The actual launch command formatted by the running machine, with run credentials redacted. Omitted if this run's launch command was not recorded. |

### V3LocationInfo

| Field | Type | Required | Description |
|---|---|---|---|
| `location_id` | `string` | yes | `loc-` followed by 16 hexadecimal digits of the SHA-256 of the location's path: the same in every window that lists it. |
| `label` | `string` | yes | The checkout's branch, or else the folder's name. |
| `path` | `string` | yes | The absolute path, with symbolic links resolved. |
| `kind` | `LocationKind` | yes | What the location is: a folder, a repository's main checkout, or a linked worktree. |
| `source_folder` | `string` | no | The requested workspace folder that produced this local result. |

### V3LocationListResult

| Field | Type | Required | Description |
|---|---|---|---|
| `locations` | `V3LocationInfo[]` | yes |  |

### V3MachineAddArgs

| Field | Type | Required | Description |
|---|---|---|---|
| `ssh_destination` | `string` | yes |  |
| `ssh_args` | `string[]` | no |  |
| `remote_home` | `string` | no |  |
| `machine_id` | `string` | yes |  |

### V3MachineConnectArgs

| Field | Type | Required | Description |
|---|---|---|---|
| `transport` | `V3MachineTransport` | yes |  |
| `kind` | `ConnectionKind` | yes | A bridge is always temporary. |

### V3MachineConnectResult

| Field | Type | Required | Description |
|---|---|---|---|
| `ssh_destination` | `string` | no |  |
| `ssh_args` | `string[]` | no |  |
| `remote_home` | `string` | no |  |
| `expected_machine_id` | `string` | no |  |

### V3MachineConnection

| Field | Type | Required | Description |
|---|---|---|---|
| `machine_id` | `string` | yes | The other end of the connection. |
| `initiator_machine_id` | `string` | yes |  |
| `kind` | `ConnectionKind` | yes |  |
| `ssh_destination` | `string` | no |  |
| `ssh_args` | `string[]` | no |  |
| `remote_home` | `string` | no |  |
| `state` | `ConnectionState` | yes |  |
| `ssh_interaction` | `SshInteraction` | no |  |

### V3MachineInfo

| Field | Type | Required | Description |
|---|---|---|---|
| `machine_id` | `string` | yes |  |
| `boot_id` | `string` | no | The running daemon, where observed. Every advertised route carries it. |
| `name` | `string` | yes |  |
| `selector` | `string` | yes |  |
| `state` | `MachineState` | yes |  |
| `last_seen` | `string` | no |  |
| `ssh_error` | `string` | no |  |
| `build` | `string` | no |  |
| `route` | `string[]` | no | The remaining hops, ending at this machine. Empty for the table's own machine. Absent for a saved destination without a route. |
| `connections` | `V3MachineConnection[]` | yes |  |

### V3MachineListResult

| Field | Type | Required | Description |
|---|---|---|---|
| `machines` | `V3MachineInfo[]` | yes |  |

### V3MachineQueryResult

| Field | Type | Required | Description |
|---|---|---|---|
| `machine_id` | `string` | yes |  |
| `short_id` | `string` | yes |  |
| `name` | `string` | yes |  |
| `selector` | `string` | yes |  |
| `build` | `string` | no |  |
| `state` | `MachineState` | yes |  |
| `status` | `MachineQueryStatus` | yes | Whether this query obtained the machine's contribution. |
| `last_seen` | `string` | no |  |
| `ssh_error` | `string` | no |  |
| `error` | `string` | no | The reason this query failed, when known. |

### V3MachineTransport

`{ readonly kind: 'ssh'; readonly ssh_destination: string; readonly ssh_args?: string[]; readonly remote_home?: string } \| { readonly kind: 'bridge' }`

### V3MachinesChange

`{ readonly kind: 'updated'; readonly machine: V3MachineInfo } \| { readonly kind: 'removed'; readonly machine_id: string }`

### V3Message

| Field | Type | Required | Description |
|---|---|---|---|
| `message_id` | `string` | yes | `m` followed by a number, unique within the Facade home. |
| `message_ref` | `MessageRef` | no | The full reference, when a remote message receipt needs it. |
| `from` | `string` | yes | The sender: an agent ID, `command_line` or `facade`. |
| `from_machine_id` | `string` | no | The sender's machine, when different from the one that stored the message. |
| `from_name` | `string` | no | The sender's name when it sent the message. Omitted for `command_line` and `facade`. |
| `to` | `string` | yes | The recipient's agent ID. |
| `text` | `string` | yes | The complete text as sent. |
| `reply_to` | `string` | no | The message this one answers. |
| `reply_to_machine_id` | `string` | no | The replied-to message's machine, when different from the one that stored this message. |
| `call_id` | `string` | no | A result's call: the ID of the MCP `tools/call` it answers later. On a start's prompt, the call its result answers. |
| `result` | `V3StartOutcome` | no | A result's facts, which its text words. Omitted for any other message. |
| `at` | `string` | yes | When Facade received it, in UTC ISO 8601 format with milliseconds. |
| `delivery` | `Delivery` | yes |  |

### V3RenameArgs

`{ readonly name: string } & ({ readonly agent: string; readonly reference?: never } \| { readonly agent?: never; readonly reference: AgentRef })`

### V3ResizeArgs

`{ readonly cols: number; readonly rows: number; readonly colors?: TerminalColors } & ({ readonly agent: string; readonly reference?: never } \| { readonly agent?: never; readonly reference: AgentRef })`

### V3ResumeArgs

The copyable agent address or the CLI session and its working location.

`{ readonly reference: string; readonly machine?: string; readonly folder?: string; readonly machine_id?: string; readonly env?: { readonly [key: string]: string }; readonly cols: number; readonly rows: number } & ({ readonly machine_id?: never } \| { readonly machine?: never })`

### V3ScreenArgs

| Field | Type | Required | Description |
|---|---|---|---|
| `agent` | `string` | yes | The agent's address or name. |
| `lines` | `number` | no | The number of lines to return, from 1 to 2000. Defaults to 50. |

### V3ScreenSnapshot

| Field | Type | Required | Description |
|---|---|---|---|
| `agent_id` | `string` | yes | The ID of the agent being viewed. |
| `address` | `string` | yes |  |
| `name` | `string` | no |  |
| `machine_id` | `string` | yes | The agent's running machine, for reconnecting to its exact reference. |
| `cols` | `number` | yes | Terminal width required to apply the redraw. |
| `rows` | `number` | yes | Terminal height required to apply the redraw. |
| `redraw` | `string` | yes | Base64-encoded terminal bytes that redraw the screen at this size. Restores cursor state, charsets, and modes. On the main screen, up to 1,000 rows of agent scrollback come first unless `include_scrollback` is false. `keep_scrollback` controls whether the viewer's existing scrollback is cleared before the redraw. |
| `exit` | `ProcessExit` | no | The recorded exit, if the agent has ended. |
| `exit_status` | `number` | no | The shell exit status calculated on the machine that ran the agent, if known. |
| `process` | `ProcessState` | no | The agent's process state captured with this snapshot. |

### V3ScreenText

| Field | Type | Required | Description |
|---|---|---|---|
| `agent_id` | `string` | yes |  |
| `address` | `string` | yes |  |
| `name` | `string` | no |  |
| `process` | `ProcessState` | yes | Whether the agent's CLI is running. An ended agent's screen is the one it left. |
| `observed_at` | `string` | yes | When the screen was read, in UTC ISO 8601 format with milliseconds; for an ended agent, when it ended, as its screen is the one it left. |
| `buffer` | `ScreenBuffer` | yes |  |
| `text` | `string` | yes | The lines, joined by line feeds, each wrapped row joined into its line. Inverse text is between `[[` and `]]` and dim text between `{{` and `}}`, inverse outside dim. Each backslash, bracket, and brace of the screen's own text is escaped with a backslash, so removing the marks and the escapes gives the text exactly; see [`crate::daemon::plain`]. |
| `line_count` | `number` | yes | How many lines `text` holds. |
| `older_lines` | `boolean` | yes | Whether output lies above the lines read. |
| `trimmed` | `boolean` | yes | Whether the scrollback let go of its oldest lines. |

### V3ScreenWatchArgs

`{ readonly keep_scrollback?: boolean; readonly include_scrollback?: boolean; readonly viewer?: string; readonly allow_ended?: boolean } & ({ readonly agent: string; readonly reference?: never } \| { readonly agent?: never; readonly reference: AgentRef })`

### V3SendArgs

| Field | Type | Required | Description |
|---|---|---|---|
| `to` | `string` | yes | The recipient's address or name. |
| `text` | `string` | yes | The complete message: at most 8,000 characters and 540 lines of text, tabs, and line breaks, not blank. |
| `reply_to` | `string` | no | The message this one answers, by ID or address such as `m4@gpu`. |
| `reply_to_machine_id` | `string` | no | The storage machine of the reply's reference, after the originating daemon verified it. |
| `request_id` | `string` | no | The caller's own ID of this send, 1 to 200 characters. A retry within an hour with the same sender, sender machine, target, and ID joins its ongoing delivery or returns its original result. A withdrawn message keeps only a private record of the outcome for retries. |
| `time_left_ms` | `number` | no | What is left of the send's 30 seconds as it leaves the client, in milliseconds: its delivery's deadline counts that from the daemon's receipt, at most 29,500. Omitted, 29,500. |
| `allow_unsupported_receipt` | `boolean` | no | A terminal can request a numbered delivery outcome for a target without an input rule. |

### V3SendResult

The receipt of a send, with the address that can be used to wait for a reply.

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | yes |  |
| `message` | `V3Message` | yes |  |
| `recipient` | `AgentLabel` | no | The recipient selected for this send, including when delivery fails. |
| `repeated` | `boolean` | no |  |
| `withdrawn` | `boolean` | no |  |
| `expected_reply_to` | `MessageRef` | no | The original message the Guest was waiting for this sender to answer. It can be included when a send without `reply_to` timed out and was withdrawn. |

### V3StartArgs

Shared arguments for start and preflight.

| Field | Type | Required | Description |
|---|---|---|---|
| `cli` | `string` | yes |  |
| `args` | `string[]` | no |  |
| `folder` | `string` | no |  |
| `folder_is_default` | `boolean` | no | The entry's default folder, which is discarded when forwarding to another machine. |
| `machine` | `string` | no |  |
| `worktree` | `string` | no | A branch to create as a worktree from the repository's current HEAD. |
| `model` | `string` | no |  |
| `effort` | `string` | no |  |
| `name` | `string` | no |  |
| `prompt` | `string` | no |  |
| `env` | `{ readonly [key: string]: string }` | no |  |
| `cols` | `number` | yes |  |
| `rows` | `number` | yes |  |
| `call_id` | `string` | no |  |
| `result_message_id` | `string` | no |  |
| `result_message_machine_id` | `string` | no |  |
| `request_id` | `string` | no |  |

### V3StartOutcome

| Field | Type | Required | Description |
|---|---|---|---|
| `agent` | `V3AgentInfo` | yes | The started agent as it was when its prompt was settled. |
| `prompt` | `PromptOutcome` | yes |  |

### V3StartResult

| Field | Type | Required | Description |
|---|---|---|---|
| `agent` | `V3AgentInfo` | yes | The agent's record. |
| `prompt` | `V3Message` | no | The prompt, kept and pending, where one was given. |
| `result_message_id` | `string` | no | The ID of the result the prompt owes the agent the client acts for, a message from `facade` once the prompt is settled. Omitted where no result is owed. |
| `result_message_machine_id` | `string` | no | The machine that assigned `result_message_id`, when a result is owed. |
| `repeated` | `boolean` | no | The call repeated an earlier one by its request ID: the agent is that call's, as it stands now. Omitted otherwise. |

### V3StopResult

A recorded CLI exit. Without a code or signal, its status is unavailable; do not treat it as exit code zero.

| Field | Type | Required | Description |
|---|---|---|---|
| `reference` | `AgentRef` | yes |  |
| `address` | `string` | yes |  |
| `agent` | `AgentLabel` | no | The record whose run this call stopped. |
| `code` | `number` | no | The exit code, if the CLI exited normally and its status is known. On Windows every exit has one: the process's 32-bit exit code carried as an `i32`, so that 0xC000013A is -1073741510. |
| `signal` | `string` | no | The terminating signal name, such as `SIGKILL`. Signal numbers vary by system. Never on Windows. |
| `reason` | `EndReason` | no | Why no code or signal is available, if known. If all three fields are absent, the exit status is unavailable. |
| `at` | `string` | yes | The exit time in UTC ISO 8601 format with milliseconds. For an exit without a code or signal, the time Facade noticed it. |
| `already_ended` | `boolean` | no | The CLI had ended before this stop, so the stop signaled nothing. Omitted when false. |

### V3TypeArgs

`{ readonly raw?: string; readonly text?: string; readonly enter?: boolean; readonly keys?: string[] } & ({ readonly agent: string; readonly reference?: never } \| { readonly agent?: never; readonly reference: AgentRef })`

### WaitKind

What a CLI waits for.

`'permission' \| 'question' \| 'auth' \| 'unknown'`

### WatchEndedParams

A forwarded watch ended. A new watch starts with a fresh snapshot.

| Field | Type | Required | Description |
|---|---|---|---|
| `watch` | `number` | yes |  |
| `error` | `ErrorBody` | yes |  |

### WatchParams

Parameters for `watch`.

`{ readonly topic: 'agents'; readonly args?: NoArgs } \| { readonly topic: 'screen'; readonly args: V3ScreenWatchArgs } \| { readonly topic: 'machines'; readonly args?: NoArgs }`

### WatchResult

The result of `watch`, sent before any changes for that watch.

| Field | Type | Required | Description |
|---|---|---|---|
| `watch` | `number` | yes | The watch number used by `changed` notifications and `unwatch`. |
| `snapshot` | `V3AgentsSnapshot \| V3ScreenSnapshot \| V3MachineInfo[]` | yes | The topic snapshot. Later changes arrive as ordered `changed` notifications. |
