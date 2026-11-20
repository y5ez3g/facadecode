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
