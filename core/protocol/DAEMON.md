<!-- Generated from core/crates/base/src by core/crates/base/tests/protocol_files.rs: do not edit. -->

# Facade daemon API

## Connect to the daemon

`api_versions` offers [1] in this build. The daemon selects the highest
offered positive integer it supports and returns it as `api_version`. Send a nonempty array of
enabled versions. The receiver treats repeated values as one version. An invalid offer returns
`-32602 invalid_argument`. A valid offer with no common version returns
`-32000 protocol_incompatible` and includes the endpoint's `details.supported_api_versions`.
The client checks the selection against its offer and uses the selected contract for the entire
connection. The software build and keeper API have independent versioning.
See [the keeper reference](KEEPER.md).

`FACADE_HOME` selects the home. By default it is `.facade` in `HOME`, or `USERPROFILE`
when `HOME` is unset. On macOS and Linux the socket is
`/tmp/facade-core-<uid>/daemon-<key>.sock`. On Windows use
`\\.\pipe\facade-core-daemon-<key>`. The endpoints admit the owning user. Core's Windows
clients also look up the server PID and check its user SID. The editor relies on the pipe DACL.

To calculate `key`, use the home path exactly as passed to Facade. Encode it as UTF-8, replacing
invalid path bytes with U+FFFD. Write the first five bytes of its SHA-256 digest as ten lowercase
hexadecimal digits.

When the daemon is asleep, a local client that intends to wake it can run
`facade daemon --detach` with the same home. The daemon accepts connections after recovering
its agents and screens. Wait for a successful `hello` and report a decoded refusal or
permission failure. With no agents, clients or unfinished work the daemon exits after 30 seconds.

### Messages

Send one UTF-8 JSON-RPC 2.0 object per line, at most 64 MiB including the newline. Give outstanding
requests distinct IDs from 0 through the maximum unsigned 64-bit integer, using exactly
representable integers in JavaScript. Each response echoes the ID and has one of `result` or
`error`. Notifications omit the ID and receive no reply. An oversized request produces
`capacity_exceeded` with a null ID and closes the stream.

A terminal or editor supplies its own kind and build. An internal MCP session acts with verified
actor identity. `hello.result.ops` and `topics` list the supported operations and subscriptions
for that session. Send arguments as an object every time, using `{}` for an empty set. Unknown
input fields and discriminants fail before the operation runs. An API consumer can ignore newly
added optional output and notification fields and skip unknown event kinds.

```jsonl daemon-local
{"jsonrpc":"2.0","id":1,"method":"hello","params":{"api_versions":[1],"build":"1.0.0+example","kind":"terminal"}}
{"jsonrpc":"2.0","id":1,"result":{"api_version":1,"build":"1.0.0+example","machine_id":"11111111-1111-4111-8111-111111111111","pid":4321,"agent_count":1,"ops":["agent.list","agent.start","agent.stop","agent.resume_list","agent.resume","agent.inspect","agent.screen","agent.type","agent.send","agent.remove","agent.rename","attach.resize","cli.list","location.list","machine.list","machine.connect","machine.remove","machine.rename","daemon.status","daemon.log","daemon.upgrade"],"topics":["agents","machines","attach","attach.shell"],"keeper":{"pid":4320,"build":"1.0.0+example"}}}
{"jsonrpc":"2.0","id":2,"method":"call","params":{"op":"agent.list","args":{"scope":{"kind":"local"}}}}
{"jsonrpc":"2.0","id":2,"result":{"agents":[],"machines":[{"machine_id":"11111111-1111-4111-8111-111111111111","short_id":"11111111","name":"laptop","selector":"laptop","state":"online","status":"answered"}]}}
```

### Agent and machine addresses

A target is a nonempty selector string or an exact `{machine_id,agent_id}` pair. A selector can
be a local name or ID, or an address such as `a2@devbox`. Keep the full exact reference for a Pin,
a terminal reconnect, and forwarded requests against an already resolved agent. Display
the returned address. Ambiguous references return candidates in the error details. The
entry daemon derives caller identity and the holder checks permissions before acting.

### Listing and inspecting

`agent.list` defaults to `reachable`. The local scope performs zero SSH, including on cold start.
The machine scope selects one machine and can wake it. Reachable reuses active connections,
probes saved routes concurrently without waking them, waits for the query and returns the local
and answered records. `machines[].status` is the outcome of this query and `state` is the
observed connection state. A failure against a named machine is an outer error. In a reachable
query the failed machine appears alongside the records obtained.

Terminal roster rows from `agent.list` can include `session_name`, the CLI's native session
name or preview. The holder can supply it through the existing authenticated Terminal query
to `internal.agent_records` with `active:true`. If the label is unavailable within the roster
budget or the holder is older, the field may be absent. `title` still describes the terminal.

`agent.inspect` returns the agent, current input observation, session tracking and viewers.
For a managed run it can include the recorded launch command with Facade's run credential
redacted. `agent.screen` returns the tail of the logical screen and scrollback. Its default
is 50 lines, and it accepts 1–2,000. Ended records can still be inspected and their final
screens read.

### States

An active managed agent reports `starting`, `working`, `waiting_for_you`, `just_done`,
`idle`, `error` or `unknown`. A finished process reports `ended`. A connected Guest
reports `online`. State can reflect a CLI's own Program Status Protocol reports (OSC 7501)
or recognized screens. A wait's detail can identify permission, questions or authentication.
`said` records the latest observed submission with its sender. Changes to wait and error
states are published immediately and other state changes are coalesced.

`watch agents` sends a snapshot and ordered changes. A `machine_state` event describes sync
state and may include v1 agent records. A `removed` event contains `machine_id`, `agent_id`
and `cause`. When checking a pinned record, also accept `not_found.details.record_removal`
when its value is `expired` or `removed`.

```jsonl daemon-local
{"jsonrpc":"2.0","id":15,"method":"watch","params":{"topic":"agents","args":{}}}
{"jsonrpc":"2.0","id":15,"result":{"watch":2,"snapshot":{"agents":[],"machines":[]}}}
{"jsonrpc":"2.0","method":"changed","params":{"watch":2,"change":{"kind":"machine_state","machine":{"machine_id":"22222222-2222-4222-8222-222222222222","state":"synced","agents":[]}}}}
{"jsonrpc":"2.0","method":"changed","params":{"watch":2,"change":{"kind":"removed","machine_id":"22222222-2222-4222-8222-222222222222","agent_id":"a2","cause":"removed"}}}
```

### Starts, stops, and removal

`agent.start` validates launch settings, permissions, CLI availability and the folder before
creating a worktree or starting a process. A `worktree` names the new branch created from
HEAD. Set `folder_is_default` for an implicit folder so that a remote start can use the
executing machine's default. The executing machine uses its own environment and default folder
for a forwarded start. The result returns the agent and any applicable prompt receipt.
A worktree error can identify a surviving branch or path under `details.kept`.

`agent.stop` accepts a nonempty list of targets or a scope. It resolves and deduplicates by
exact reference and preserves the order of the first occurrence. Scope stops never wake
remote daemons from query through dispatch. The result contains per-target settlements,
plus machine outcomes for a scoped stop. Explicit Guests receive an `unsupported` error.
Guests found by scope are skipped. A stopped managed agent keeps its record and final screen.
`agent.remove` stops a running managed agent before removing its record. If the stop fails,
the record remains.

```jsonl daemon-local
{"jsonrpc":"2.0","id":50,"method":"call","params":{"op":"agent.stop","args":{"selection":{"kind":"targets","targets":["a2@devbox","missing"]}}}}
{"jsonrpc":"2.0","id":50,"result":{"items":[{"target":"a2@devbox","agent":{"reference":{"machine_id":"22222222-2222-4222-8222-222222222222","agent_id":"a2"},"address":"a2@devbox","type":"managed","name":"Nova","cli":"codex","state":"ended","resumable":true},"status":"stopped","exit":{"signal":"SIGHUP","at":"2026-11-20T17:03:00.000Z"}},{"target":"missing","status":"failed","error":{"code":-32000,"message":"No active agent matches missing.","data":{"reason":"not_found"}}}]}}
```

### Resume, locations and status

`agent.resume_list` defaults to local. Reachable waits for passive queries as in `agent.list`.
A named machine can be woken. `folder_scope` chooses the current directory or all managed
record folders and does not broaden the saved session directory. Pass the returned
`target` unchanged to `agent.resume` with its runtime `size` and optional environment.
A full saved-session target includes the machine, CLI, session ID and absolute folder.
The resume list can also include `session_name` for a managed record or saved session.

`location.list`, `cli.list` and `daemon.status` select one machine and default to local.
Locations describe known work folders. CLI discovery uses the specified folder and
environment. Daemon status gives the home, settings path, build, PIDs and local agent count.

### Agent messages

`agent.send` delivers to an eligible managed agent or Guest.
The public receipt identifies the assigning machine in a message address such as
`m42@devbox`. Replies can carry an address or a full message reference. Each reply target
is verified at entry. A managed agent's delivery is confirmed when its terminal takes
the submission. A Guest can read complete messages inline.

Omitting `wait_for` keeps the released delivery wait, 30-second cap and receipt replay.
Explicit `wait_for:"inbox"` returns once the message is saved in the recipient's inbox.
Background delivery keeps its ordinary limit. `"delivery"` waits for the managed
terminal's submission or the Guest's read. `"result"` waits for delivery and the first
explicit reply to the original message from its recipient.

Explicit waits use `time_left_ms` as the remaining total budget. The cap is 300 seconds
for Terminal and 30 seconds for a verified MCP actor. Each forward carries the explicit
wait mode and only the remaining budget. Older v1 decoders reject `wait_for` with
`invalid_argument` before admission. A forwarding hop that only relays preserves the
field. The caller receives the refusal and the operation is never downgraded.

For a Shell result wait, the recipient receives a command address such as `#c42@devbox`.
Reply through send with that address as `to` and the original `m42` as `reply_to`.
The holder checks the original command request and the replying actor. An authenticated
peer can hand off the reply to the origin with `internal.command_reply`. Once the origin
accepts the first matching handoff, the reply sender can receive `returned_to_request`.
The original Shell receives the optional `reply:{reference,text}` after confirmed delivery.
An expired wait after confirmed delivery returns `reply_timeout`. Once the waiter closes,
a new reply to that command returns `ended`. A verified MCP actor instead waits for its
result in its own inbox.

```jsonl daemon-local
{"jsonrpc":"2.0","id":20,"method":"call","params":{"op":"agent.send","args":{"to":"a2","text":"Run the checks and reply.","wait_for":"result","request_id":"send-20","time_left_ms":29900}}}
{"jsonrpc":"2.0","id":20,"result":{"id":"m42@devbox","message":{"message_id":"m42","message_ref":{"machine_id":"11111111-1111-4111-8111-111111111111","message_id":"m42"},"from":"command_line","to":"a2","text":"Run the checks and reply.","at":"2026-11-20T17:00:00.000Z","delivery":{"status":"success","text_written":"full","enter_written":true,"delivered_via":"terminal"}},"reply":{"reference":{"machine_id":"11111111-1111-4111-8111-111111111111","message_id":"m43"},"text":"Checks passed.\n"}}}
```

Automatic retries of `agent.start` and `agent.send` use the original business
`request_id`, arguments and destination. Its 1–200 Unicode code points identify the
request for one hour from its first execution. An expired or different ID may execute again.
Shell gives an explicit wait call the same absolute deadline used for its connection.
This call uses one exchange and discards the connection on a transport timeout. A replay
or takeover cannot reopen the original Shell reply waiter.
`cancel {id}` addresses the original transport request on the same connection. Only an
`agent.send` that has yet to start pasting can be cancelled. Once the original request
finishes it reports its actual outcome.

### YOLO and creation trees

A managed agent reads YOLO from the executing machine's settings on start or resume. A Guest
keeps the value recorded when it joined. With YOLO off, an actor's reach is its creation tree.
With YOLO on it can reach other agents, subject to the target's supported operations. The daemon
verifies callers before reading their records or delivering their operations.

### The relay

The shared local socket accepts a separate relay handshake before daemon API admission.
It identifies the verified local process using relay contract 1. Once accepted, the stream
carries MCP JSON-RPC. A verified internal `kind:"mcp"` actor negotiates the daemon API
independently. Direct external `kind:"mcp"` hello is refused.

```jsonl relay
{"jsonrpc":"2.0","id":1,"method":"hello","params":{"relay":1,"args":["--guest","codex"],"env":{},"cwd":null,"reconnect":false}}
{"jsonrpc":"2.0","id":1,"result":{"relay":1}}
{"jsonrpc":"2.0","method":"closing","params":{"build":"1.0.1+example"}}
{"jsonrpc":"2.0","method":"closing","params":{}}
```

### Text and keys

`agent.type` uses `input.kind` to select text, named keys or raw bytes. A text call can set
`enter:true`, and empty text with `enter:true` presses Enter alone. Text uses the terminal's
bracketed paste mode when enabled. Keys use the active terminal modes. A successful text or
keys receipt means the input reached the terminal. If only part was written, `partial_input`
reports `details.text_written` with optional `enter_written`, or `details.keys_sent`.

Raw bytes use standard Base64 with padding and require a full agent reference. They can be
sent without an ID. A raw call with an ID acknowledges entry into the daemon's memory queue.

`input.kind:"sequence"` carries ordered `steps` of `{kind:"text",text}` or `{kind:"key",key}`.
The daemon checks the complete batch with the existing input size and key limits before
admitting it once. Other input waits until the batch finishes. An older v1 decoder
rejects the sequence with `invalid_argument` before any input reaches the terminal.
A transparent forward preserves the batch. Text, keys and raw remain available in their
existing forms. Shell preflight and daemon admission count each nonempty paste's UTF-8
bytes and paste delimiters and each key's terminal bytes against the same 1 MiB limit.

```jsonl daemon-local
{"jsonrpc":"2.0","id":21,"method":"call","params":{"op":"agent.type","args":{"target":"a2","input":{"kind":"sequence","steps":[{"kind":"text","text":"hello"},{"kind":"key","key":"Enter"}]}}}}
{"jsonrpc":"2.0","id":21,"result":{}}
```

### Screen text

`agent.screen` joins wrapped rows into logical lines. `older_lines` tells whether additional
lines precede the requested tail and `trimmed` reports discarded scrollback. In `text`,
`[[…]]` marks inverse text and `{{…}}` marks dim text. A backslash escapes the brackets,
braces and backslashes that occur literally on the screen.

### Viewers and queue limits

`watch attach` returns a connection-local `watch` number and snapshot. Apply its actual
`size` before decoding `redraw` into terminal bytes. Feed subsequent `output` and `redraw`
bytes to the same parser in arrival order. A `redraw` replaces the visible screen and may
supply a new size. `report_activity` requests the `working` flag and activity changes.
`allow_ended` with an exact reference reads a final terminal snapshot without an active view.

`watch attach.shell` uses the same arguments, snapshot and changes as `attach`. To open a
dedicated watch, send it as the first operation after Terminal hello when `hello.topics`
advertises it. The daemon refuses the watch if the connection already carried another
operation. After foreground start or resume on a daemon advertising `attach.shell`, release
the command connection and open a fresh Terminal connection. Preserve the exact target and
`allow_ended` setting, and select the watch using the new hello. Use ordinary `attach` when
the dedicated topic is absent, reusing the command connection if it is still open.

Admission dedicates the connection to one watch. The connection accepts raw input to its
exact target, resize or unwatch for its own view, and connection controls. A failed watch
can be retried on a fresh connection.
The daemon sends final screen output before `exit` and closes the dedicated connection
after a drain grace of up to one second. An already-ended exact snapshot is itself final.
Remote holders are watched through ordinary `attach`, which remains available to IDEs,
older terminals and authenticated peers.

```jsonl daemon-local
{"jsonrpc":"2.0","id":44,"method":"watch","params":{"topic":"attach.shell","args":{"target":{"machine_id":"11111111-1111-4111-8111-111111111111","agent_id":"a2"}}}}
{"jsonrpc":"2.0","id":44,"result":{"watch":8,"snapshot":{"reference":{"machine_id":"11111111-1111-4111-8111-111111111111","agent_id":"a2"},"address":"a2","size":{"cols":100,"rows":30},"redraw":"G1sySg=="}}}
{"jsonrpc":"2.0","method":"changed","params":{"watch":8,"change":{"kind":"output","data":"ZG9uZQ=="}}}
{"jsonrpc":"2.0","method":"changed","params":{"watch":8,"change":{"kind":"exit","exit":{"code":0,"at":"2026-11-20T17:01:00.000Z"},"exit_status":0}}}
```

Report initial capacity in the watch and subsequent changes via `attach.resize`. The shared
grid takes the smallest columns and smallest rows of the active views. `unwatch` releases
the view and acknowledges the request. A lost remote subscription sends `watch_ended`.
Start a new watch to get a new snapshot. The last active view leaves the grid at its current size.

```jsonl daemon-local
{"jsonrpc":"2.0","id":40,"method":"watch","params":{"topic":"attach","args":{"target":{"machine_id":"22222222-2222-4222-8222-222222222222","agent_id":"a2"},"viewer":"editor","size":{"cols":120,"rows":40}}}}
{"jsonrpc":"2.0","id":40,"result":{"watch":7,"snapshot":{"reference":{"machine_id":"22222222-2222-4222-8222-222222222222","agent_id":"a2"},"address":"a2@devbox","name":"Nova","size":{"cols":80,"rows":24},"redraw":"G1sySg==","process":"running"}}}
{"jsonrpc":"2.0","method":"call","params":{"op":"agent.type","args":{"target":{"machine_id":"22222222-2222-4222-8222-222222222222","agent_id":"a2"},"input":{"kind":"raw","raw":"aGk="}}}}
{"jsonrpc":"2.0","method":"call","params":{"op":"attach.resize","args":{"watch":7,"size":{"cols":100,"rows":30}}}}
{"jsonrpc":"2.0","method":"changed","params":{"watch":7,"change":{"kind":"redraw","size":{"cols":100,"rows":30},"data":"G1sySmhp"}}}
{"jsonrpc":"2.0","id":42,"method":"unwatch","params":{"watch":7}}
{"jsonrpc":"2.0","id":42,"result":{}}
```

The daemon permits up to 16 ordinary concurrent calls per connection. It allows an 8 MiB
outbox, sending a larger frame alone after the queue drains. Each view can queue 1 MiB of
incremental output. A view that fell behind receives a full redraw when available. Terminal
input has a 1 MiB per-agent waiting budget. Calls with IDs can receive `capacity_exceeded`
when input cannot fit, while notifications can wait behind the agent's pending input.

### Terminal queries and redraws

A verified IDE client can report foreground, background and cursor colors on `attach.resize`.
The applied colors answer OSC 10, 11 and 12. Reconnect and render the new snapshot before
sending new terminal input. Discard keys typed while disconnected.

### Machine sessions

An authenticated machine session is a bidirectional daemon API connection over SSH. Each
direction numbers its requests independently. Machine introductions supply the stable
machine ID and the current daemon boot ID. `foreground:true` registers a foreground
connection while it stays open. Peers acknowledge the initial `advertise` request before
using the advertised routes. Later route updates can arrive as an id-less `advertise`
notification. An id-less `machine.sleeping` comes from the verified peer whose daemon is
going idle.

```jsonl daemon-machine
{"jsonrpc":"2.0","id":1,"method":"hello","params":{"api_versions":[1],"build":"1.0.0+example","kind":"machine","machine":{"machine_id":"11111111-1111-4111-8111-111111111111","boot_id":"33333333-3333-4333-8333-333333333333","name":"laptop"}}}
{"jsonrpc":"2.0","id":1,"result":{"api_version":1,"build":"1.0.1+example","machine_id":"22222222-2222-4222-8222-222222222222","pid":4322,"agent_count":1,"ops":["agent.start","agent.stop","agent.resume_list","agent.resume","agent.inspect","agent.screen","agent.type","agent.send","agent.remove","agent.rename","cli.list","location.list","machine.rename","daemon.status","internal.agent_records","internal.resume_records","internal.ensure_route","internal.attach_resize","internal.deliver_start_result","internal.deliver_wait_notice","internal.command_reply"],"topics":["agents","attach"],"machine":{"boot_id":"55555555-5555-4555-8555-555555555555","name":"devbox","ssh_cleans_processes":true}}}
{"jsonrpc":"2.0","id":2,"method":"advertise","params":{"machines":[]}}
{"jsonrpc":"2.0","id":2,"result":{}}
{"jsonrpc":"2.0","method":"advertise","params":{"machines":[]}}
{"jsonrpc":"2.0","id":73,"method":"forward","params":{"route":["22222222-2222-4222-8222-222222222222"],"caller":{"kind":"ide","machine_id":"11111111-1111-4111-8111-111111111111"},"method":"call","params":{"op":"internal.attach_resize","args":{"viewer":81,"boot_id":"55555555-5555-4555-8555-555555555555","size":{"cols":100,"rows":30}}}}}
{"jsonrpc":"2.0","id":73,"result":{}}
{"jsonrpc":"2.0","method":"machine.sleeping","params":{}}
```

`forward` carries a remaining route, verified caller and an inner call or watch. Each hop
checks the next machine and the remaining time budget. Use exact references for resolved
agent targets. An authenticated forwarded Attach can return `view:{viewer,boot_id}` for
the holder's live view. The entry daemon uses that binding and the original caller for
`internal.attach_resize`. The public watch response carries `watch` and `snapshot`.

```jsonl daemon-machine
{"jsonrpc":"2.0","id":74,"method":"forward","params":{"route":["22222222-2222-4222-8222-222222222222"],"caller":{"kind":"agent","agent":{"machine_id":"11111111-1111-4111-8111-111111111111","agent_id":"a2"},"root":{"machine_id":"11111111-1111-4111-8111-111111111111","agent_id":"a2"},"yolo":true},"method":"call","params":{"op":"internal.command_reply","args":{"request_id":"send-20","original":{"machine_id":"11111111-1111-4111-8111-111111111111","message_id":"m42"},"reply":{"reference":{"machine_id":"11111111-1111-4111-8111-111111111111","message_id":"m43"},"text":"Checks passed."}}}}}
{"jsonrpc":"2.0","id":74,"result":{}}
```

An installed remote executable tries its existing serve command and negotiates API
compatibility. Passive queries use `--no-start`. Authenticated exit 3 reports that the
remote daemon is sleeping. A missing executable can be installed only with explicit
permission. Saved or temporary `machine.connect` authorizes the terminal stream and then
hands it over for the machine handshake. The expected machine ID, if explicit or inferred
from an existing matching configuration, is checked against that authenticated stream.
Saved mode commits its normalized SSH arguments before emitting `connected`. With neither
expected ID, the saved connection uses the verified peer ID on that same stream.

A confirmed `connected.machine.ssh_cleans_processes` is the peer's observed logout cleanup
setting and can be omitted when unknown. Shell can use `true` to display the logout warning.

```jsonl daemon-local
{"jsonrpc":"2.0","id":30,"method":"call","params":{"op":"machine.connect","args":{"transport":{"kind":"ssh","ssh_destination":"alice@devbox","ssh_args":["alice@devbox"],"remote_home":"/home/alice/.facade"},"kind":"saved","expected_machine_id":"22222222-2222-4222-8222-222222222222"}}}
{"jsonrpc":"2.0","id":30,"result":{"transport":{"kind":"ssh","ssh_destination":"alice@devbox","ssh_args":["alice@devbox"],"remote_home":"/home/alice/.facade"},"expected_machine_id":"22222222-2222-4222-8222-222222222222"}}
{"jsonrpc":"2.0","method":"connected","params":{"machine":{"machine_id":"22222222-2222-4222-8222-222222222222","boot_id":"55555555-5555-4555-8555-555555555555","name":"devbox","build":"1.0.1+example","ssh_cleans_processes":true},"first_connection":true}}
```

`machine.list` reads the local roster without SSH. Saved SSH transport data is available
only to local people. `machine.remove` removes the local saved route without SSH and can
return the full saved configuration. With `expected_machine_id` it removes only that exact
record, returning `not_found` for a missing record. Reciprocal removal supplies the
authenticated peer ID on each leg.

An SSH entry that needs an interactive login gives a diagnostic in `ssh_interaction.message`
and the corresponding command as an argument array.

```jsonl daemon-local
{"jsonrpc":"2.0","id":32,"method":"call","params":{"op":"machine.list","args":{}}}
{"jsonrpc":"2.0","id":32,"result":{"machines":[{"machine_id":"22222222-2222-4222-8222-222222222222","short_id":"22222222","name":"devbox","selector":"devbox","state":"ssh_interaction_required","connections":[{"machine_id":"22222222-2222-4222-8222-222222222222","initiator_machine_id":"11111111-1111-4111-8111-111111111111","kind":"saved","state":"ssh_interaction_required","ssh_interaction":{"message":"Host key verification failed.","command":["facade","machine","add","alice@devbox"]}}]}]}}
```

```jsonl daemon-local
{"jsonrpc":"2.0","id":31,"method":"call","params":{"op":"machine.remove","args":{"machine":"devbox"}}}
{"jsonrpc":"2.0","id":31,"result":{"machine_id":"22222222-2222-4222-8222-222222222222","name":"devbox","reachable":false,"transport":{"kind":"ssh","ssh_destination":"alice@devbox","ssh_args":["alice@devbox"],"remote_home":"/home/alice/.facade"}}}
```

### Errors and recovery

Outer responses, per-target outcomes and failure notifications share
`{code,message,data:{reason,details?}}`. The codes `-32700`, `-32600`, `-32601`, `-32602`
and `-32000` cover parse errors, invalid requests, unknown methods, invalid arguments or
unknown operations, and Facade failures, respectively. Branch on the reason you recognize
and preserve the message and details for an unknown reason.

An error for an authorized send can include `data.details.message_ref` once the message
is assigned. It identifies the original send by `machine_id` and `message_id`. A failed
result wait, such as `reply_timeout` or an interruption reported as `unavailable`, can
also include `data.details.delivered_via` when the delivery receipt confirms `terminal`
(terminal submission) or `read` (recipient inbox read). If only assignment is known,
report the original reference alone. An MCP inbox continuation can report `reply_timeout`
with just the original message ID.

A failed route can report `unavailable.details.execution`. With `not_executed` the client
can retry subject to the original permissions and wake policy. With `outcome_unknown` it
should read the current state. Retry a start or send with the original business ID within
its receipt window. Retry only batch items that are known to have remained unexecuted.
Terminal input has no replay guarantee.

```jsonl daemon-local
{"jsonrpc":"2.0","id":3,"method":"hello","params":{"api_versions":[2],"build":"example","kind":"terminal"}}
{"jsonrpc":"2.0","id":3,"error":{"code":-32000,"message":"No common daemon API version.","data":{"reason":"protocol_incompatible","details":{"supported_api_versions":[1]}}}}
```

A request too long to parse can lose its correlatable ID.

```jsonl daemon-local
{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"The request exceeds the 64 MiB line limit.","data":{"reason":"capacity_exceeded"}}}
```

## Daemon takeover

The daemon and keeper APIs evolve independently. A formal replacement retains interoperable
supported operations for at least three months from that endpoint's replacement release.
Changes to existing operations, topics, fields, defaults, permissions or effects that break
the published contract take effect in a new version of the affected endpoint. Within a
version, additions to existing replies or notifications are optional and omission keeps the
original meaning.

For live daemon takeover, `daemon.upgrade` separately declares the target daemon and keeper
API sets. The current daemon checks daemon overlap and, if a keeper holds active agents,
checks its authenticated selected version against the target keeper set. A refusal leaves
the running services and agents in place. On success the same keeper preserves its CLIs and
terminal handles. The client acknowledges `closing` with an id-less notification and
reconnects to start its watches with new snapshots.

```jsonl daemon-local
{"jsonrpc":"2.0","id":70,"method":"call","params":{"op":"daemon.upgrade","args":{"program":"/opt/facade/1.0.1/facade","build":"1.0.1+example","daemon_api_versions":[1],"keeper_api_versions":[1]}}}
{"jsonrpc":"2.0","id":70,"result":{"from":"1.0.0+example","agent_count":1}}
{"jsonrpc":"2.0","method":"closing","params":{"build":"1.0.1+example"}}
{"jsonrpc":"2.0","method":"closing","params":{}}
```

### Disconnections and recovery

If the keeper ends, the daemon keeps its clients, watches, grids and terminal handles. It
starts a replacement keeper and returns the held terminals with `agent.sync`. On Unix the
replacement may observe an exit without a code or signal. On Windows it can read the exit
code from the process handle. If both services end, the next daemon can recover screens
with an exit reason of `terminal_closed`. This leaves the CLI's exit status unavailable.

## Methods

| Name | Description |
|---|---|
| `hello` | Negotiate a daemon API version and discover this connection's operations and topics. |
| `call` | Invoke a registered operation. Raw agent.type and attach.resize also accept notifications. |
| `watch` | Subscribe to a registered topic and return a connection-local watch ID and snapshot. |
| `unwatch` | Release a watch and acknowledge the request. |
| `cancel` | Request cancellation of an agent.send before the paste starts. |
| `changed` | Deliver a change to a watch. |
| `watch_ended` | Report that a watch lost its subscription. |
| `closing` | Announce a replacement build, or acknowledge the announcement with empty params. |
| `advertise` | Exchange machine routing information on an authenticated peer connection. |
| `forward` | Route a registered call or watch on an authenticated machine connection. |
| `machine.sleeping` | Report an authenticated peer's idle exit. |
| `connected` | Confirm an authorized foreground machine handoff. |
| `connect_failed` | Report a foreground machine handoff failure. |

## Topics

Topics available to `watch`. Their types are defined below.

| Name | Arguments | Snapshot | Change | Audience | Description |
|---|---|---|---|---|---|
| `agents` | `NoArgs` | `AgentsSnapshot` | `AgentsChange` | terminal, ide, MCP actor, machine forward | Watch visible agent records. |
| `machines` | `NoArgs` | `MachineInfo[]` | `MachinesChange` | terminal, ide, MCP actor | Watch the local machine roster. |
| `attach` | `AttachArgs` | `ScreenSnapshot` | `ScreenChange` | terminal, ide, machine forward | Watch an agent's live or final terminal screen. |
| `attach.shell` | `AttachArgs` | `ScreenSnapshot` | `ScreenChange` | terminal | Watch an agent's terminal screen on a dedicated Shell connection. |

## Operations

Operations available to `call`. Set `op` to the name and `args` to its arguments. Types are defined below.

| Name | Arguments | Result | Audience | Description |
|---|---|---|---|---|
| `agent.list` | `AgentListArgs` | `AgentListResult` | terminal, ide, MCP actor | List active agents and Guests. |
| `agent.start` | `StartArgs` | `StartResult` | terminal, ide, MCP actor, machine forward | Start an agent. |
| `agent.stop` | `StopArgs` | `BatchStopResult` | terminal, ide, MCP actor, machine forward | Stop selected agents and report each outcome. |
| `agent.resume_list` | `ResumeListArgs` | `ResumeListResult` | terminal, ide, machine forward | Find agents and sessions that can be resumed. |
| `agent.resume` | `ResumeArgs` | `ResumeResult` | terminal, ide, machine forward | Resume an agent or a saved CLI session. |
| `agent.inspect` | `AgentTargetArgs` | `InspectResult` | terminal, ide, MCP actor, machine forward | Read an agent's status and attachments. |
| `agent.screen` | `ScreenArgs` | `ScreenText` | terminal, ide, MCP actor, machine forward | Read logical lines from an agent's screen. |
| `agent.type` | `AgentTypeArgs` | `TypeResult` | terminal, ide, MCP actor, machine forward | Send terminal input to an agent. |
| `agent.send` | `SendArgs` | `SendResult` | terminal, ide, MCP actor, machine forward | Send a message and report delivery. |
| `agent.remove` | `AgentTargetArgs` | `RemoveResult` | terminal, ide, MCP actor, machine forward | Stop an agent and remove its records. |
| `agent.rename` | `RenameArgs` | `RenameResult` | terminal, ide, MCP actor, machine forward | Change an agent's name. |
| `attach.resize` | `AttachResizeArgs` | `EmptyResult` | terminal, ide | Set the capacity of an attached view. |
| `cli.list` | `CliListArgs` | `CliListResult` | terminal, ide, MCP actor, machine forward | List CLIs available on a machine. |
| `location.list` | `LocationListArgs` | `LocationListResult` | terminal, ide, MCP actor, machine forward | List working locations on a machine. |
| `machine.list` | `NoArgs` | `MachineListResult` | terminal, ide, MCP actor | Read the local roster of known machines. |
| `machine.connect` | `MachineConnectArgs` | `MachineConnectResult` | terminal | Authorize a foreground machine connection. |
| `machine.remove` | `MachineRemoveArgs` | `MachineRemoveResult` | terminal, ide | Remove a saved connection. |
| `machine.rename` | `MachineRenameArgs` | `MachineRenameResult` | terminal, ide, machine forward | Change the name of a machine. |
| `daemon.status` | `StatusArgs` | `StatusResult` | terminal, ide, machine forward | Read a daemon's status. |
| `daemon.log` | `LogArgs` | `LogResult` | terminal, ide | Read the last lines of the local daemon log. |
| `daemon.upgrade` | `DaemonUpgradeArgs` | `DaemonUpgradeResult` | terminal | Arrange for a compatible build to take over. |
| `internal.agent_records` | `InternalAgentRecordsArgs` | `AgentLookupCandidate[]` | machine forward | Read visible agent records at their holder. |
| `internal.resume_records` | `NoArgs` | `ResumeCandidate[]` | machine forward | Read the holder's resumable agent records. |
| `internal.ensure_route` | `InternalEnsureRouteArgs` | `EmptyResult` | machine forward | Open saved connections along a machine route. |
| `internal.attach_resize` | `InternalAttachResizeArgs` | `EmptyResult` | machine forward | Set the capacity of a forwarded view at its holder. |
| `internal.deliver_start_result` | `InternalDeliverStartResultArgs` | `EmptyResult` | machine forward | Deliver a start receipt to its recipient. |
| `internal.deliver_wait_notice` | `InternalDeliverWaitNoticeArgs` | `EmptyResult` | machine forward | Deliver a wait notice to its recipient. |
| `internal.command_reply` | `CommandReplyArgs` | `EmptyResult` | machine forward | Return a reply to the daemon waiting for it. |

## Error reasons

| Reason | When |
|---|---|
| `invalid_argument` | A malformed request or invalid parameters. Details may include available_clis. |
| `not_found` | No matching record. Details may include agents and record_removal (expired or removed). |
| `session_not_found` | No matching saved session. Details may include sessions. |
| `ambiguous_reference` | Several objects match. Details may include candidates, agents, machines or sessions. |
| `ended` | The agent ended. Details may include agents. |
| `partial_input` | Some terminal input was written. Details give text_written and optional enter_written, or keys_sent. |
| `unavailable` | The operation or route is unavailable. Details can describe the execution state and affected targets. The optional `agents: AgentLabel[]` lists only agents already resolved and authorized. |
| `protocol_incompatible` | No usable API version. Details include supported_api_versions and may include offered_api_versions and agents. |
| `machine_id_conflict` | The same machine ID is in use at different paths. Details give machine_id and paths. |
| `machine_id_mismatch` | The authenticated machine ID differs from the expected one. Details give both IDs. |
| `ssh_interaction_required` | SSH needs an interactive repair. Details give message and command. |
| `capacity_exceeded` | The line or a connection budget was exceeded. |
| `internal` | The daemon encountered an internal error. |
| `refused` | The operation was refused. Details may include a settings entry and `agents: AgentLabel[]` for agents already resolved and authorized. Denials outside the caller's creation tree omit agent labels. |
| `configuration_invalid` | The settings are invalid. Details may name an entry. |
| `cancelled` | The send was cancelled before paste started. |
| `worktree_failed` | Worktree creation failed. Details may identify the surviving branch or path under kept. |
| `upgrading` | The daemon is handing over and did not begin the operation. |
| `unsupported` | The target or parameter lacks a required capability. Details may include agents. |

## Types

### AdvertiseParams

| Field | Type | Required | Description |
|---|---|---|---|
| `machines` | `MachineInfo[]` | yes |  |

### AgentCreator

The source of an agent's start, as displayed to the caller.

`{ readonly kind: 'agent'; readonly address: string } \| { readonly kind: 'command_line' } \| { readonly kind: 'vs_code' }`

### AgentInfo

| Field | Type | Required | Description |
|---|---|---|---|
| `reference` | `AgentRef` | yes |  |
| `address` | `string` | yes |  |
| `type` | `AgentKind` | yes |  |
| `label` | `string` | no |  |
| `unreachable` | `boolean` | no |  |
| `name` | `string` | yes |  |
| `cli` | `string` | yes |  |
| `args` | `string[]` | yes |  |
| `model` | `string` | no |  |
| `effort` | `string` | no |  |
| `title` | `string` | no |  |
| `cwd` | `string` | yes |  |
| `pid` | `number` | no |  |
| `process` | `ProcessState` | yes |  |
| `size` | `Size` | no |  |
| `created_at` | `string` | yes |  |
| `started_at` | `string` | yes |  |
| `creator_kind` | `CreatorKind` | no |  |
| `creator` | `AgentRef` | no |  |
| `root` | `AgentRef` | yes |  |
| `yolo` | `boolean` | yes |  |
| `exit` | `ProcessExit` | no |  |
| `session` | `string` | no |  |
| `state` | `AgentState` | yes |  |
| `state_detail` | `StateDetail` | no |  |
| `said` | `Said` | no |  |
| `tools_state` | `ToolsState` | yes |  |
| `tools_reason` | `ToolsReason` | no |  |

### AgentKind

`'managed' \| 'guest'`

### AgentLabel

| Field | Type | Required | Description |
|---|---|---|---|
| `reference` | `AgentRef` | yes |  |
| `address` | `string` | yes |  |
| `type` | `AgentKind` | yes |  |
| `name` | `string` | yes |  |
| `cli` | `string` | yes |  |
| `state` | `AgentState` | yes |  |
| `resumable` | `boolean` | yes |  |

### AgentListArgs

| Field | Type | Required | Description |
|---|---|---|---|
| `scope` | `Scope` | no |  |

### AgentListEntry

| Field | Type | Required | Description |
|---|---|---|---|
| `reference` | `AgentRef` | yes |  |
| `address` | `string` | yes |  |
| `name` | `string` | yes |  |
| `type` | `AgentKind` | yes |  |
| `state` | `AgentState` | yes |  |
| `cli` | `string` | yes |  |
| `folder` | `string` | yes |  |
| `started_at` | `string` | yes |  |
| `title` | `string` | no |  |
| `session_name` | `string` | no |  |

### AgentListResult

| Field | Type | Required | Description |
|---|---|---|---|
| `agents` | `AgentListEntry[]` | yes |  |
| `machines` | `MachineQuery[]` | yes |  |

### AgentLookupCandidate

| Field | Type | Required | Description |
|---|---|---|---|
| `agent` | `AgentInfo` | yes |  |
| `has_rule` | `boolean` | yes |  |
| `session_name` | `string` | no |  |

### AgentMachineState

| Field | Type | Required | Description |
|---|---|---|---|
| `machine_id` | `string` | yes |  |
| `state` | `AgentSyncState` | yes |  |
| `agents` | `AgentInfo[]` | no |  |

### AgentRef

| Field | Type | Required | Description |
|---|---|---|---|
| `machine_id` | `string` | yes |  |
| `agent_id` | `string` | yes |  |

### AgentRemoval

The recorded cause of an agent record's removal.

`'expired' \| 'removed'`

### AgentState

The agent's current state.

`'starting' \| 'working' \| 'waiting_for_you' \| 'just_done' \| 'idle' \| 'error' \| 'ended' \| 'unknown' \| 'online'`

### AgentSyncState

`'synced' \| 'pending' \| 'unreachable'`

### AgentTarget

`string \| { readonly machine_id: string; readonly agent_id: string }`

### AgentTargetArgs

| Field | Type | Required | Description |
|---|---|---|---|
| `target` | `AgentTarget` | yes |  |

### AgentTypeArgs

| Field | Type | Required | Description |
|---|---|---|---|
| `target` | `AgentTarget` | yes |  |
| `input` | `TerminalInput` | yes |  |

### AgentsChange

`{ readonly kind: 'updated'; readonly agent: AgentInfo } \| { readonly kind: 'removed'; readonly machine_id: string; readonly agent_id: string; readonly cause: AgentRemoval } \| { readonly kind: 'machine_state'; readonly machine: AgentMachineState }`

### AgentsSnapshot

| Field | Type | Required | Description |
|---|---|---|---|
| `agents` | `AgentInfo[]` | yes |  |
| `machines` | `AgentMachineState[]` | yes |  |

### ApiVersions

`number[]`

### AttachArgs

| Field | Type | Required | Description |
|---|---|---|---|
| `target` | `AgentTarget` | yes |  |
| `size` | `{ readonly cols: number; readonly rows: number }` | no |  |
| `viewer` | `string` | no |  |
| `keep_scrollback` | `boolean` | no |  |
| `include_scrollback` | `boolean` | no |  |
| `allow_ended` | `boolean` | no |  |
| `report_activity` | `boolean` | no |  |

### AttachBinding

| Field | Type | Required | Description |
|---|---|---|---|
| `viewer` | `number` | yes |  |
| `boot_id` | `string` | yes |  |

### AttachResizeArgs

| Field | Type | Required | Description |
|---|---|---|---|
| `watch` | `number` | yes |  |
| `size` | `{ readonly cols: number; readonly rows: number }` | yes |  |
| `colors` | `TerminalColors` | no |  |

### AttachmentInfo

| Field | Type | Required | Description |
|---|---|---|---|
| `kind` | `AttachmentKind` | yes |  |
| `machine_id` | `string` | yes |  |

### AttachmentKind

`'shell' \| 'vs_code'`

### BatchStopResult

| Field | Type | Required | Description |
|---|---|---|---|
| `items` | `StopItem[]` | yes |  |
| `machines` | `MachineQuery[]` | no |  |

### CallParams

`{ readonly op: 'agent.list'; readonly args: AgentListArgs } \| { readonly op: 'agent.start'; readonly args: StartArgs } \| { readonly op: 'agent.stop'; readonly args: StopArgs } \| { readonly op: 'agent.resume_list'; readonly args: ResumeListArgs } \| { readonly op: 'agent.resume'; readonly args: ResumeArgs } \| { readonly op: 'agent.inspect'; readonly args: AgentTargetArgs } \| { readonly op: 'agent.screen'; readonly args: ScreenArgs } \| { readonly op: 'agent.type'; readonly args: AgentTypeArgs } \| { readonly op: 'agent.send'; readonly args: SendArgs } \| { readonly op: 'agent.remove'; readonly args: AgentTargetArgs } \| { readonly op: 'agent.rename'; readonly args: RenameArgs } \| { readonly op: 'attach.resize'; readonly args: AttachResizeArgs } \| { readonly op: 'cli.list'; readonly args: CliListArgs } \| { readonly op: 'location.list'; readonly args: LocationListArgs } \| { readonly op: 'machine.list'; readonly args: NoArgs } \| { readonly op: 'machine.connect'; readonly args: MachineConnectArgs } \| { readonly op: 'machine.remove'; readonly args: MachineRemoveArgs } \| { readonly op: 'machine.rename'; readonly args: MachineRenameArgs } \| { readonly op: 'daemon.status'; readonly args: StatusArgs } \| { readonly op: 'daemon.log'; readonly args: LogArgs } \| { readonly op: 'daemon.upgrade'; readonly args: DaemonUpgradeArgs } \| { readonly op: 'internal.agent_records'; readonly args: InternalAgentRecordsArgs } \| { readonly op: 'internal.resume_records'; readonly args: NoArgs } \| { readonly op: 'internal.ensure_route'; readonly args: InternalEnsureRouteArgs } \| { readonly op: 'internal.attach_resize'; readonly args: InternalAttachResizeArgs } \| { readonly op: 'internal.deliver_start_result'; readonly args: InternalDeliverStartResultArgs } \| { readonly op: 'internal.deliver_wait_notice'; readonly args: InternalDeliverWaitNoticeArgs } \| { readonly op: 'internal.command_reply'; readonly args: CommandReplyArgs }`

### Caller

`{ readonly kind: 'terminal'; readonly machine_id: string } \| { readonly kind: 'ide'; readonly machine_id: string } \| { readonly kind: 'agent'; readonly agent: { readonly machine_id: string; readonly agent_id: string }; readonly root: { readonly machine_id: string; readonly agent_id: string }; readonly yolo: boolean }`

### CancelParams

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | `number` | yes |  |

### ChangedParams

| Field | Type | Required | Description |
|---|---|---|---|
| `watch` | `number` | yes |  |
| `change` | `AgentsChange \| MachinesChange \| ScreenChange` | yes |  |

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

| Field | Type | Required | Description |
|---|---|---|---|
| `scope` | `SingleMachineScope` | no |  |
| `folder` | `string` | no |  |
| `env` | `{ readonly [key: string]: string }` | no |  |

### CliListResult

| Field | Type | Required | Description |
|---|---|---|---|
| `clis` | `CliInfo[]` | yes |  |
| `settings_problem` | `string` | no |  |

### ClientKind

`'terminal' \| 'ide' \| 'mcp' \| 'machine'`

### ClosingParams

| Field | Type | Required | Description |
|---|---|---|---|
| `build` | `string` | yes |  |

### CommandReply

| Field | Type | Required | Description |
|---|---|---|---|
| `reference` | `MessageRef` | yes |  |
| `text` | `string` | yes |  |

### CommandReplyArgs

| Field | Type | Required | Description |
|---|---|---|---|
| `request_id` | `string` | yes |  |
| `original` | `{ readonly machine_id: string; readonly message_id: string }` | yes |  |
| `reply` | `CommandReplyInput` | yes |  |

### CommandReplyInput

| Field | Type | Required | Description |
|---|---|---|---|
| `reference` | `{ readonly machine_id: string; readonly message_id: string }` | yes |  |
| `text` | `string` | yes |  |

### ConnectFailedParams

| Field | Type | Required | Description |
|---|---|---|---|
| `error` | `ErrorBody` | yes |  |

### ConnectedMachine

| Field | Type | Required | Description |
|---|---|---|---|
| `machine_id` | `string` | yes |  |
| `boot_id` | `string` | yes |  |
| `name` | `string` | yes |  |
| `build` | `string` | yes |  |
| `ssh_cleans_processes` | `boolean` | no |  |

### ConnectedParams

| Field | Type | Required | Description |
|---|---|---|---|
| `machine` | `ConnectedMachine` | yes |  |
| `first_connection` | `boolean` | yes |  |

### ConnectionKind

`'saved' \| 'temporary'`

### ConnectionState

`'connected' \| 'disconnected' \| 'ssh_interaction_required'`

### CreatorKind

`'agent' \| 'command_line' \| 'vs_code'`

### DaemonHelloParams

`HelloParams`

### DaemonHelloResult

`HelloResult`

### DaemonUpgradeArgs

| Field | Type | Required | Description |
|---|---|---|---|
| `program` | `string` | yes |  |
| `build` | `string` | yes |  |
| `daemon_api_versions` | `ApiVersions` | yes |  |
| `keeper_api_versions` | `ApiVersions` | yes |  |

### DaemonUpgradeResult

| Field | Type | Required | Description |
|---|---|---|---|
| `from` | `string` | yes |  |
| `agent_count` | `number` | yes |  |

### DeliveredVia

How a message was delivered.

`'terminal' \| 'read' \| 'notified' \| 'returned_to_request'`

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

| Field | Type | Required | Description |
|---|---|---|---|
| `code` | `number` | yes |  |
| `message` | `string` | yes |  |
| `data` | `ErrorData` | yes |  |

### ErrorData

| Field | Type | Required | Description |
|---|---|---|---|
| `reason` | `string` | yes |  |
| `details` | `{ readonly [key: string]: unknown }` | no |  |

### FolderScope

`'cwd' \| 'all'`

### ForwardParams

`{ readonly route: string[]; readonly caller: Caller; readonly time_left_ms?: number; readonly from_name?: string; readonly start_result?: { readonly machine_id: string; readonly message_id: string } } & ({ readonly method: 'call'; readonly params: CallParams } \| { readonly method: 'watch'; readonly params: WatchParams })`

### ForwardWatchResult

| Field | Type | Required | Description |
|---|---|---|---|
| `watch` | `number` | yes |  |
| `snapshot` | `AgentsSnapshot \| MachineInfo[] \| ScreenSnapshot` | yes |  |
| `view` | `AttachBinding` | no |  |

### HelloParams

| Field | Type | Required | Description |
|---|---|---|---|
| `api_versions` | `ApiVersions` | yes |  |
| `build` | `string` | yes |  |
| `kind` | `ClientKind` | yes |  |
| `machine` | `MachineHelloParams` | no |  |
| `foreground` | `boolean` | no |  |

### HelloResult

| Field | Type | Required | Description |
|---|---|---|---|
| `api_version` | `number` | yes |  |
| `build` | `string` | yes |  |
| `machine_id` | `string` | yes |  |
| `pid` | `number` | yes |  |
| `agent_count` | `number` | yes |  |
| `ops` | `string[]` | yes |  |
| `topics` | `string[]` | yes |  |
| `keeper` | `KeeperInfo` | no |  |
| `machine` | `MachineHelloResult` | no |  |

### HiddenRows

Rows of a draft scrolled out of the CLI's input, as the CLI marks them.

| Field | Type | Required | Description |
|---|---|---|---|
| `above` | `number` | yes | Rows hidden above the visible input. |
| `below` | `number` | yes | Rows hidden below the visible input. |

### HowEnded

How an agent's process ended.

`'normal' \| 'stopped' \| 'crashed'`

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

### InputStep

`{ readonly kind: 'text'; readonly text: string } \| { readonly kind: 'key'; readonly key: string }`

### InspectResult

| Field | Type | Required | Description |
|---|---|---|---|
| `agent` | `AgentInfo` | yes |  |
| `input` | `InputInfo` | yes |  |
| `session_tracking` | `boolean` | yes |  |
| `viewers` | `string[]` | yes |  |
| `rule` | `string` | no |  |
| `started_by` | `AgentCreator` | no |  |
| `attachments` | `AttachmentInfo[]` | no |  |
| `launch_command` | `string` | no |  |

### InternalAgentRecordsArgs

| Field | Type | Required | Description |
|---|---|---|---|
| `active` | `boolean` | yes |  |

### InternalAttachResizeArgs

| Field | Type | Required | Description |
|---|---|---|---|
| `viewer` | `number` | yes |  |
| `boot_id` | `string` | yes |  |
| `size` | `{ readonly cols: number; readonly rows: number }` | yes |  |
| `colors` | `TerminalColors` | no |  |

### InternalDeliverStartResultArgs

| Field | Type | Required | Description |
|---|---|---|---|
| `recipient` | `{ readonly machine_id: string; readonly agent_id: string }` | yes |  |
| `message` | `{ readonly message_id: string; readonly message_ref?: { readonly machine_id: string; readonly message_id: string }; readonly from: string; readonly from_machine_id?: string; readonly from_name?: string; readonly to: string; readonly text: string; readonly reply_to?: string; readonly reply_to_machine_id?: string; readonly call_id?: string; readonly result?: { readonly agent: { readonly reference: { readonly machine_id: string; readonly agent_id: string }; readonly address: string; readonly type: AgentKind; readonly label?: string; readonly unreachable?: boolean; readonly name: string; readonly cli: string; readonly args: string[]; readonly model?: string; readonly effort?: string; readonly title?: string; readonly cwd: string; readonly pid?: number; readonly process: ProcessState; readonly size?: { readonly cols: number; readonly rows: number }; readonly created_at: string; readonly started_at: string; readonly creator_kind?: CreatorKind; readonly creator?: { readonly machine_id: string; readonly agent_id: string }; readonly root: { readonly machine_id: string; readonly agent_id: string }; readonly yolo: boolean; readonly exit?: ProcessExit; readonly session?: string; readonly state: AgentState; readonly state_detail?: StateDetail; readonly said?: Said; readonly tools_state: ToolsState; readonly tools_reason?: ToolsReason }; readonly prompt: PromptOutcome }; readonly at: string; readonly delivery: Delivery }` | yes |  |

### InternalDeliverWaitNoticeArgs

| Field | Type | Required | Description |
|---|---|---|---|
| `recipient` | `{ readonly machine_id: string; readonly agent_id: string }` | yes |  |
| `waiting` | `{ readonly machine_id: string; readonly agent_id: string }` | yes |  |
| `name` | `string` | yes |  |
| `kind` | `WaitKind` | yes |  |

### InternalEnsureRouteArgs

| Field | Type | Required | Description |
|---|---|---|---|
| `wake` | `boolean` | yes |  |

### JsonRpc

`'2.0'`

### KeeperInfo

| Field | Type | Required | Description |
|---|---|---|---|
| `pid` | `number` | yes |  |
| `build` | `string` | yes |  |

### LocationInfo

| Field | Type | Required | Description |
|---|---|---|---|
| `location_id` | `string` | yes | `loc-` followed by 16 hexadecimal digits of the SHA-256 of the location's path: the same in every window that lists it. |
| `label` | `string` | yes | The checkout's branch, or else the folder's name. |
| `path` | `string` | yes | The absolute path, with symbolic links resolved. |
| `kind` | `LocationKind` | yes | What the location is: a folder, a repository's main checkout, or a linked worktree. |
| `source_folder` | `string` | no | The requested workspace folder that produced this local result. |

### LocationKind

What a location is.

`'folder' \| 'main' \| 'worktree'`

### LocationListArgs

| Field | Type | Required | Description |
|---|---|---|---|
| `scope` | `SingleMachineScope` | no |  |
| `folders` | `string[]` | no |  |

### LocationListResult

| Field | Type | Required | Description |
|---|---|---|---|
| `locations` | `LocationInfo[]` | yes |  |

### LogArgs

| Field | Type | Required | Description |
|---|---|---|---|
| `lines` | `number` | no |  |

### LogResult

| Field | Type | Required | Description |
|---|---|---|---|
| `lines` | `string[]` | yes |  |

### MachineConnectArgs

| Field | Type | Required | Description |
|---|---|---|---|
| `transport` | `MachineTransportInput` | yes |  |
| `kind` | `ConnectionKind` | yes |  |
| `expected_machine_id` | `string` | no |  |

### MachineConnectResult

| Field | Type | Required | Description |
|---|---|---|---|
| `transport` | `MachineTransport` | yes |  |
| `expected_machine_id` | `string` | no |  |

### MachineConnection

| Field | Type | Required | Description |
|---|---|---|---|
| `machine_id` | `string` | yes |  |
| `initiator_machine_id` | `string` | yes |  |
| `kind` | `ConnectionKind` | yes |  |
| `state` | `ConnectionState` | yes |  |
| `transport` | `SshTransport` | no |  |
| `ssh_interaction` | `SshInteraction` | no |  |

### MachineHelloParams

| Field | Type | Required | Description |
|---|---|---|---|
| `machine_id` | `string` | yes |  |
| `boot_id` | `string` | yes |  |
| `name` | `string` | yes |  |
| `ssh_cleans_processes` | `boolean` | no |  |

### MachineHelloResult

| Field | Type | Required | Description |
|---|---|---|---|
| `boot_id` | `string` | yes |  |
| `name` | `string` | yes |  |
| `ssh_cleans_processes` | `boolean` | no |  |

### MachineInfo

| Field | Type | Required | Description |
|---|---|---|---|
| `machine_id` | `string` | yes |  |
| `short_id` | `string` | yes |  |
| `name` | `string` | yes |  |
| `selector` | `string` | yes |  |
| `state` | `MachineState` | yes |  |
| `boot_id` | `string` | no |  |
| `build` | `string` | no |  |
| `last_seen` | `string` | no |  |
| `ssh_error` | `string` | no |  |
| `route` | `string[]` | no |  |
| `connections` | `MachineConnection[]` | yes |  |

### MachineListResult

| Field | Type | Required | Description |
|---|---|---|---|
| `machines` | `MachineInfo[]` | yes |  |

### MachineQuery

| Field | Type | Required | Description |
|---|---|---|---|
| `machine_id` | `string` | yes |  |
| `short_id` | `string` | yes |  |
| `name` | `string` | yes |  |
| `selector` | `string` | yes |  |
| `state` | `MachineState` | yes |  |
| `status` | `QueryStatus` | yes |  |
| `build` | `string` | no |  |
| `last_seen` | `string` | no |  |
| `ssh_error` | `string` | no |  |
| `error` | `string` | no |  |

### MachineRemoveArgs

| Field | Type | Required | Description |
|---|---|---|---|
| `machine` | `string` | yes |  |
| `expected_machine_id` | `string` | no |  |

### MachineRemoveResult

| Field | Type | Required | Description |
|---|---|---|---|
| `machine_id` | `string` | yes |  |
| `reachable` | `boolean` | yes |  |
| `transport` | `SshTransport` | no |  |
| `name` | `string` | no |  |
| `via` | `string` | no |  |

### MachineRenameArgs

| Field | Type | Required | Description |
|---|---|---|---|
| `machine` | `string` | yes |  |
| `name` | `string` | yes |  |

### MachineRenameResult

| Field | Type | Required | Description |
|---|---|---|---|
| `machine_id` | `string` | yes |  |
| `name` | `string` | yes |  |
| `previous_name` | `string` | no |  |

### MachineSleepingParams

`Record<string, never>`

### MachineState

`'online' \| 'connecting' \| 'disconnected' \| 'sleeping' \| 'unreachable' \| 'ssh_interaction_required'`

### MachineTransport

`{ readonly kind: 'bridge' } \| SshTransport`

### MachineTransportInput

`{ readonly kind: 'ssh'; readonly ssh_destination: string; readonly ssh_args?: string[]; readonly remote_home?: string } \| { readonly kind: 'bridge' }`

### MachinesChange

`{ readonly kind: 'updated'; readonly machine: MachineInfo } \| { readonly kind: 'removed'; readonly machine_id: string }`

### Message

| Field | Type | Required | Description |
|---|---|---|---|
| `message_id` | `string` | yes |  |
| `message_ref` | `MessageRef` | no |  |
| `from` | `string` | yes |  |
| `from_machine_id` | `string` | no |  |
| `from_name` | `string` | no |  |
| `to` | `string` | yes |  |
| `text` | `string` | yes |  |
| `reply_to` | `string` | no |  |
| `reply_to_machine_id` | `string` | no |  |
| `call_id` | `string` | no |  |
| `result` | `StartOutcome` | no |  |
| `at` | `string` | yes |  |
| `delivery` | `Delivery` | yes |  |

### MessageRef

| Field | Type | Required | Description |
|---|---|---|---|
| `machine_id` | `string` | yes |  |
| `message_id` | `string` | yes |  |

### NoArgs

`Record<string, never>`

### Notification

| Field | Type | Required | Description |
|---|---|---|---|
| `jsonrpc` | `JsonRpc` | yes |  |
| `method` | `string` | yes |  |
| `params` | `unknown` | yes |  |

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

`'running' \| 'ended' \| 'unknown'`

### PromptOutcome

A start prompt's message ID and what became of it.

| Field | Type | Required | Description |
|---|---|---|---|
| `message_id` | `string` | yes |  |
| `delivery` | `Delivery` | yes |  |

### ProtocolMismatchDetails

| Field | Type | Required | Description |
|---|---|---|---|
| `offered_api_versions` | `ApiVersions` | no |  |
| `supported_api_versions` | `ApiVersions` | yes |  |
| `agents` | `AgentLabel[]` | no |  |

### QueryStatus

`'answered' \| 'unavailable' \| 'timed_out' \| 'error'`

### RemoveResult

| Field | Type | Required | Description |
|---|---|---|---|
| `reference` | `AgentRef` | yes |  |
| `address` | `string` | yes |  |

### RenameArgs

| Field | Type | Required | Description |
|---|---|---|---|
| `target` | `AgentTarget` | yes |  |
| `name` | `string` | yes |  |

### RenameResult

| Field | Type | Required | Description |
|---|---|---|---|
| `agent` | `AgentInfo` | yes |  |
| `previous_name` | `string` | no |  |

### ReplyTo

`string \| { readonly machine_id: string; readonly message_id: string }`

### Request

| Field | Type | Required | Description |
|---|---|---|---|
| `jsonrpc` | `JsonRpc` | yes |  |
| `id` | `number` | no |  |
| `method` | `string` | yes |  |
| `params` | `unknown` | yes |  |

### Response

`{ readonly jsonrpc: JsonRpc; readonly id: number; readonly result: unknown } \| { readonly jsonrpc: JsonRpc; readonly id: number \| null; readonly error: ErrorBody }`

### ResumeArgs

| Field | Type | Required | Description |
|---|---|---|---|
| `target` | `ResumeTarget` | yes |  |
| `size` | `{ readonly cols: number; readonly rows: number }` | yes |  |
| `env` | `{ readonly [key: string]: string }` | no |  |

### ResumeCandidate

| Field | Type | Required | Description |
|---|---|---|---|
| `target` | `ResumeCandidateTarget` | yes |  |
| `machine_id` | `string` | yes |  |
| `cli` | `string` | yes |  |
| `folder` | `string` | yes |  |
| `session` | `string` | yes |  |
| `agent` | `AgentRef` | no |  |
| `name` | `string` | no |  |
| `stopped` | `boolean` | no |  |
| `title` | `string` | no |  |
| `at` | `string` | no |  |
| `session_name` | `string` | no |  |

### ResumeCandidateTarget

`{ readonly kind: 'agent'; readonly reference: AgentRef } \| { readonly kind: 'session'; readonly machine_id: string; readonly cli: string; readonly session: string; readonly folder: string }`

### ResumeListArgs

| Field | Type | Required | Description |
|---|---|---|---|
| `scope` | `Scope` | no |  |
| `folder` | `string` | no |  |
| `folder_scope` | `FolderScope` | no |  |

### ResumeListResult

| Field | Type | Required | Description |
|---|---|---|---|
| `items` | `ResumeCandidate[]` | yes |  |
| `machines` | `MachineQuery[]` | yes |  |

### ResumeResult

| Field | Type | Required | Description |
|---|---|---|---|
| `agent` | `AgentInfo` | yes |  |
| `from_saved_session` | `boolean` | no |  |

### ResumeTarget

`{ readonly kind: 'agent'; readonly reference: { readonly machine_id: string; readonly agent_id: string } } \| { readonly kind: 'session'; readonly machine_id: string; readonly cli: string; readonly session: string; readonly folder: string } \| { readonly kind: 'selector'; readonly selector: string; readonly scope?: SingleMachineScope; readonly folder?: string }`

### Said

What last went into an agent's message input with Enter: what the person submitted in its terminal and its CLI took, text typed with `agent.type` and `enter`, or a message delivered through the terminal.

| Field | Type | Required | Description |
|---|---|---|---|
| `text` | `string` | yes | The text on one line, at most 1,024 characters. |
| `from` | `string` | yes | Who said it: an agent ID, or `human` for the person. |
| `from_name` | `string` | no | The agent's name when it said it. Omitted for the person. |
| `at` | `string` | yes | When, in UTC ISO 8601 format with milliseconds. |

### Scope

`{ readonly kind: 'local' } \| { readonly kind: 'machine'; readonly machine: string } \| { readonly kind: 'reachable' }`

### ScreenArgs

| Field | Type | Required | Description |
|---|---|---|---|
| `target` | `AgentTarget` | yes |  |
| `lines` | `number` | no |  |

### ScreenBuffer

The screen buffer a CLI shows.

`'normal' \| 'alternate'`

### ScreenChange

`{ readonly kind: 'output'; readonly data: string } \| { readonly kind: 'redraw'; readonly size: Size; readonly data: string } \| { readonly kind: 'activity'; readonly working: boolean } \| { readonly kind: 'exit'; readonly exit: ProcessExit; readonly exit_status?: number; readonly resume_hint?: string } \| { readonly kind: 'removed' }`

### ScreenSnapshot

| Field | Type | Required | Description |
|---|---|---|---|
| `reference` | `AgentRef` | yes |  |
| `address` | `string` | yes |  |
| `size` | `Size` | yes |  |
| `redraw` | `string` | yes |  |
| `name` | `string` | no |  |
| `exit` | `ProcessExit` | no |  |
| `exit_status` | `number` | no |  |
| `resume_hint` | `string` | no |  |
| `process` | `ProcessState` | no |  |
| `working` | `boolean` | no |  |

### ScreenText

| Field | Type | Required | Description |
|---|---|---|---|
| `reference` | `AgentRef` | yes |  |
| `address` | `string` | yes |  |
| `name` | `string` | no |  |
| `process` | `ProcessState` | yes |  |
| `observed_at` | `string` | yes |  |
| `buffer` | `ScreenBuffer` | yes |  |
| `text` | `string` | yes |  |
| `line_count` | `number` | yes |  |
| `older_lines` | `boolean` | yes |  |
| `trimmed` | `boolean` | yes |  |

### SendArgs

| Field | Type | Required | Description |
|---|---|---|---|
| `to` | `AgentTarget` | yes |  |
| `text` | `string` | yes |  |
| `reply_to` | `ReplyTo` | no |  |
| `request_id` | `string` | no |  |
| `time_left_ms` | `number` | no |  |
| `allow_unsupported_receipt` | `boolean` | no |  |
| `wait_for` | `SendWait` | no |  |

### SendResult

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | yes |  |
| `message` | `Message` | yes |  |
| `recipient` | `AgentLabel` | no |  |
| `repeated` | `boolean` | no |  |
| `withdrawn` | `boolean` | no |  |
| `expected_reply_to` | `MessageRef` | no |  |
| `reply` | `CommandReply` | no |  |

### SendWait

`'inbox' \| 'delivery' \| 'result'`

### SingleMachineScope

`{ readonly kind: 'local' } \| { readonly kind: 'machine'; readonly machine: string }`

### Size

| Field | Type | Required | Description |
|---|---|---|---|
| `cols` | `number` | yes |  |
| `rows` | `number` | yes |  |

### SshInteraction

A diagnostic and the command that repairs the saved SSH connection.

| Field | Type | Required | Description |
|---|---|---|---|
| `message` | `string` | yes |  |
| `command` | `string[]` | yes |  |

### SshTransport

Normalized SSH arguments, including an empty argv when no options are required.

| Field | Type | Required | Description |
|---|---|---|---|
| `ssh_destination` | `string` | yes |  |
| `ssh_args` | `string[]` | yes |  |
| `remote_home` | `string` | no |  |
| `kind` | `'ssh'` | yes |  |

### StartArgs

| Field | Type | Required | Description |
|---|---|---|---|
| `cli` | `string` | yes |  |
| `size` | `{ readonly cols: number; readonly rows: number }` | yes |  |
| `args` | `string[]` | no |  |
| `scope` | `SingleMachineScope` | no |  |
| `folder` | `string` | no |  |
| `folder_is_default` | `boolean` | no |  |
| `worktree` | `string` | no |  |
| `model` | `string` | no |  |
| `effort` | `string` | no |  |
| `name` | `string` | no |  |
| `prompt` | `string` | no |  |
| `env` | `{ readonly [key: string]: string }` | no |  |
| `request_id` | `string` | no |  |
| `call_id` | `string` | no |  |

### StartOutcome

| Field | Type | Required | Description |
|---|---|---|---|
| `agent` | `AgentInfo` | yes |  |
| `prompt` | `PromptOutcome` | yes |  |

### StartResult

| Field | Type | Required | Description |
|---|---|---|---|
| `agent` | `AgentInfo` | yes |  |
| `prompt` | `Message` | no |  |
| `result_message_id` | `string` | no |  |
| `result_message_machine_id` | `string` | no |  |
| `repeated` | `boolean` | no |  |

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
| `scope` | `SingleMachineScope` | no |  |

### StatusResult

| Field | Type | Required | Description |
|---|---|---|---|
| `home` | `string` | yes |  |
| `settings_file` | `string` | yes |  |
| `build` | `string` | yes |  |
| `daemon_pid` | `number` | yes |  |
| `keeper_pid` | `number` | no |  |
| `agent_count` | `number` | yes |  |
| `machines` | `MachineQuery[]` | yes |  |

### StopArgs

| Field | Type | Required | Description |
|---|---|---|---|
| `selection` | `StopSelection` | yes |  |

### StopItem

`{ readonly target: string \| AgentRef; readonly agent?: AgentLabel } & ({ readonly status: 'stopped'; readonly exit: ProcessExit } \| { readonly status: 'failed'; readonly error: ErrorBody } \| { readonly status: 'skipped' })`

### StopSelection

`{ readonly kind: 'targets'; readonly targets: AgentTarget[] } \| { readonly kind: 'all'; readonly scope: Scope }`

### TerminalColors

| Field | Type | Required | Description |
|---|---|---|---|
| `foreground` | `string` | no |  |
| `background` | `string` | no |  |
| `cursor` | `string` | no |  |

### TerminalInput

`{ readonly kind: 'text'; readonly text: string; readonly enter?: boolean } \| { readonly kind: 'keys'; readonly keys: string[] } \| { readonly kind: 'raw'; readonly raw: string } \| { readonly kind: 'sequence'; readonly steps: InputStep[] }`

### TextWritten

How much of a message reached the recipient's terminal.

`'none' \| 'partial' \| 'full' \| 'unknown'`

### ToolsReason

Why an agent's CLI cannot use the Facade tools it was given.

`'not_given' \| 'not_connected' \| 'not_started' \| 'disconnected' \| 'ended'`

### ToolsState

Whether an agent's CLI can use Facade's tools: `facade-mcp`, the MCP server that a CLI started by its rule is given for its run.

`'not_injected' \| 'connecting' \| 'available' \| 'unavailable'`

### TypeResult

| Field | Type | Required | Description |
|---|---|---|---|
| `agent` | `AgentLabel` | no |  |

### UnwatchParams

| Field | Type | Required | Description |
|---|---|---|---|
| `watch` | `number` | yes |  |

### WaitKind

What a CLI waits for.

`'permission' \| 'question' \| 'auth' \| 'unknown'`

### WatchEndedParams

| Field | Type | Required | Description |
|---|---|---|---|
| `watch` | `number` | yes |  |
| `error` | `ErrorBody` | yes |  |

### WatchParams

`{ readonly topic: 'agents'; readonly args: NoArgs } \| { readonly topic: 'machines'; readonly args: NoArgs } \| { readonly topic: 'attach'; readonly args: AttachArgs } \| { readonly topic: 'attach.shell'; readonly args: AttachArgs }`

### WatchResult

| Field | Type | Required | Description |
|---|---|---|---|
| `watch` | `number` | yes |  |
| `snapshot` | `AgentsSnapshot \| MachineInfo[] \| ScreenSnapshot` | yes |  |
