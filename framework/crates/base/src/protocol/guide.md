## Connect to the daemon

`api_versions` offers @DAEMON_API_VERSIONS@ in this build. The daemon selects the highest
offered positive integer it supports and returns it as `api_version`. Send a nonempty array of
enabled versions. The receiver treats repeated values as one version. An invalid offer returns
`-32602 invalid_argument`. A valid offer with no common version returns
`-32000 protocol_incompatible` and includes the endpoint's `details.supported_api_versions`.
The client checks the selection against its offer and uses the selected contract for the entire
connection. The software build and keeper API have independent versioning.
See [the keeper reference](KEEPER.md).

`FACADE_HOME` selects the home. By default it is `.facade` in `HOME`, or `USERPROFILE`
when `HOME` is unset. On macOS and Linux the socket is
`/tmp/facade-framework-<uid>/daemon-<key>.sock`. On Windows use
`\\.\pipe\facade-framework-daemon-<key>`. The endpoints admit the owning user. Framework's Windows
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
{"jsonrpc":"2.0","id":1,"method":"hello","params":{"api_versions":@DAEMON_API_VERSIONS@,"build":"1.0.0+example","kind":"terminal"}}
{"jsonrpc":"2.0","id":1,"result":{"api_version":1,"build":"1.0.0+example","machine_id":"11111111-1111-4111-8111-111111111111","pid":4321,"agent_count":1,"ops":@TERMINAL_OPS@,"topics":@TERMINAL_TOPICS@,"keeper":{"pid":4320,"build":"1.0.0+example"}}}
{"jsonrpc":"2.0","id":2,"method":"call","params":{"op":"agent.list","args":{"scope":{"kind":"local"}}}}
{"jsonrpc":"2.0","id":2,"result":{"agents":[],"machines":[{"machine_id":"11111111-1111-4111-8111-111111111111","short_id":"11111111","name":"laptop","selector":"laptop","state":"online","status":"answered"}]}}
```

### Agent and machine addresses

A target is a nonempty selector string or an exact `{machine_id,agent_id}` pair. A selector can
be an agent name, number or address such as `a2@devbox`. A bare name or number searches the
machines in the reachable list, probing saved routes without waking their daemons. The lookup
can find ended agents for operations that accept them. `Pixel@gpu` can select `Pixel` on `gpu`
or a reachable agent named `Pixel@gpu`. Both readings follow the operation's eligibility and reach.
For a name, running candidates take precedence over ended ones. Multiple remaining candidates
return an ambiguity error. Keep the full exact reference for a Pin, a terminal reconnect, and
forwarded requests against an already resolved agent. Display the
returned address. Ambiguous references return candidates in the error details. The entry daemon
derives caller identity and the holder checks permissions before acting.

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
For a managed agent and a Terminal caller, it can include `session_name`, the same native
session name or session preview as in `agent.list`.
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
A saved-session candidate can include `session_selector`, which gives the first eight
characters of its session ID when they select that session alone among the saved sessions
`agent.resume` searches in that folder, including those of managed agents, and gives the
full ID otherwise.

`location.list`, `cli.list` and `daemon.status` select one machine and default to local.
Locations describe known work folders. CLI discovery uses the specified folder and
environment. Daemon status gives the home, settings path, build, PIDs and local agent count.

### Agent messages

`agent.send` delivers to an eligible managed agent or Guest.
The public receipt identifies the assigning machine in a message address such as
`m42@devbox`. Replies can carry an address or a full message reference. Each reply target
is verified at entry. Terminal delivery is confirmed when the submission key reaches
the terminal. The receipt field `delivery.enter_written` reports that write.
Codex uses Tab to queue ordinary messages while Working. Initial prompts and recovered
drafts use Enter, as does ordinary delivery outside that Codex path. A Guest can read
complete messages inline.

Omitting `wait_for` keeps the released delivery wait, 30-second cap and receipt replay.
Explicit `wait_for:"inbox"` returns once the message is saved in the recipient's inbox.
Background delivery keeps its ordinary limit. A delivery failure from the original Inbox
admission is reported as a Facade message to its live authenticated agent sender. A replay
keeps the original send's notification behavior. A pending send keeps that decision through
daemon takeover. `"delivery"` waits for the managed
terminal's submission or the Guest's read. `"result"` waits for delivery and the first
explicit reply to the original message from its recipient. Explicit delivery and result
waits report their outcome in the call.

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

An agent start returns when launch is recorded. An initial message can reserve a result
number at launch. Failed delivery uses that number and carries the agent's observed state
and the input facts. Successful delivery leaves the number unused. A managed agent with
an agent creator can also report 30 seconds of continuous waiting or Error, or an observed
end, through the creator's Facade inbox. An effective stop by the creator is reported in
the stop call. A startup delivery failure and its watchdog incident share one notification.

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
For a text input call, `details.enter_written` reports its requested Enter.

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
{"jsonrpc":"2.0","id":1,"method":"hello","params":{"api_versions":@DAEMON_API_VERSIONS@,"build":"1.0.0+example","kind":"machine","machine":{"machine_id":"11111111-1111-4111-8111-111111111111","boot_id":"33333333-3333-4333-8333-333333333333","name":"laptop"}}}
{"jsonrpc":"2.0","id":1,"result":{"api_version":1,"build":"1.0.1+example","machine_id":"22222222-2222-4222-8222-222222222222","pid":4322,"agent_count":1,"ops":@MACHINE_OPS@,"topics":@MACHINE_TOPICS@,"machine":{"boot_id":"55555555-5555-4555-8555-555555555555","name":"devbox","ssh_cleans_processes":true}}}
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

Forwarded Facade notifications use `internal.deliver_wait_notice`,
`internal.deliver_start_result` and `internal.deliver_notice`. The machine hello response lists
the receiving daemon's supported operations. The recipient daemon and each forwarding hop decode
calls through their operation registry. Older builds return their ordinary unknown-operation error
for `internal.deliver_notice` and continue serving existing operations on the same link.
`internal.deliver_notice` carries error, exit and failed-send facts.
Its caller is a verified Terminal for the source machine, and the exact recipient belongs
to the receiving daemon. The source agent, or both the failed message and its target,
belong to that source machine. The receiving daemon checks that the recipient is live
and formats addresses in its machine view before posting the notice.

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
{"jsonrpc":"2.0","id":3,"error":{"code":-32000,"message":"No common daemon API version.","data":{"reason":"protocol_incompatible","details":{"supported_api_versions":@DAEMON_API_VERSIONS@}}}}
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
{"jsonrpc":"2.0","id":70,"method":"call","params":{"op":"daemon.upgrade","args":{"program":"/opt/facade/1.0.1/facade","build":"1.0.1+example","daemon_api_versions":@DAEMON_API_VERSIONS@,"keeper_api_versions":@KEEPER_API_VERSIONS@}}}
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
