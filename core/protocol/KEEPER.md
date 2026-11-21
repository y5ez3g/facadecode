<!-- Generated from core/crates/base/src by core/crates/base/tests/protocol_files.rs: do not edit. -->

# Facade keeper API

## Connect to the keeper

`api_versions` offers [1] in this build. The keeper selects the highest
common positive integer and returns `api_version` with its build and held-agent snapshot.
The daemon checks the version against its offer. A malformed offer returns
`-32602 invalid_argument`. A valid disjoint offer returns `-32000 protocol_incompatible`
with `details.supported_api_versions` from the keeper's independent support set.

The keeper control link uses the keeper socket or named pipe beside the daemon's, with the
same home key. See [the daemon reference](PROTOCOL.md#connect-to-the-daemon). The keeper
checks the peer's user, PID and birth against `core/daemon.lock`. The daemon authenticates
the keeper against `core/keeper.lock`. A newly admitted connection replaces the old one
and performs its own handshake. Calls require one successful hello and carry request IDs.
The line format, size limit and error envelopes are shared with the daemon API.

## CLIs and terminal resources

The keeper is the parent of the CLIs. It holds each CLI's terminal so the terminal and
process can survive a daemon replacement. Its hello lists live agents using local
`agent_id`, `pid`, `birth` and optional `stopping`. Omitted `stopping` means false.
A birth token is an opaque string used for process identity equality. It is checked with
the PID before acquiring or transferring a terminal.

`agent.start` accepts a nonempty command, complete environment, resolved absolute
working directory and initial size. It starts a CLI with a new terminal, retains one copy,
and returns the process identity and a terminal copy. When a daemon comes back it uses
`agent.sync` to get the terminal for each live CLI. When a keeper comes back the daemon
uses the same operation to give the replacement keeper the terminal it still holds.

| Sync request carries a terminal | Keeper already holds the CLI | Result |
|---|---|---|
| No | Yes | The keeper verifies identity and returns its terminal copy. |
| Yes | No | The keeper verifies identity and takes the terminal. If the CLI already exited, it answers before sending the exit notification. |
| Yes | Yes | The keeper verifies identity and closes the duplicate it received. |
| No | No | The keeper returns `not_found`. |

At most one terminal accompanies a line. It is carried on a successful start response, a
sync request or a sync success returning a terminal. On macOS and Linux an `SCM_RIGHTS`
message attaches a single PTY master to the first byte of the line. On Windows the sender
duplicates the handles into the authenticated receiving process and puts their unsigned
values in the top-level `terminal` object. It requires `input`, `output` and `job`, with
optional `signal`. Once delivery succeeds, the receiver owns the duplicates and closes
any that it does not use. The ordinary JSON-RPC decoder receives the frame after the
transport extracts the handles.

The next exchange uses Unix PTY copies on the successful replies to start and sync.

```jsonl keeper
{"jsonrpc":"2.0","id":1,"method":"hello","params":{"api_versions":[1]}}
{"jsonrpc":"2.0","id":1,"result":{"api_version":1,"build":"1.0.0+example","agents":[{"agent_id":"a1","pid":5113,"birth":"123456789"}]}}
{"jsonrpc":"2.0","id":2,"method":"call","params":{"op":"daemon.ping","args":{}}}
{"jsonrpc":"2.0","id":2,"result":{}}
{"jsonrpc":"2.0","id":3,"method":"call","params":{"op":"agent.start","args":{"agent_id":"a2","command":["/usr/local/bin/codex","--model","gpt-6.2-sol"],"env":{"HOME":"/home/alice","PATH":"/usr/local/bin:/usr/bin","TERM":"xterm-256color"},"cwd":"/work/app","size":{"cols":120,"rows":40}}}}
{"jsonrpc":"2.0","id":3,"result":{"pid":5114,"birth":"123456910"}}
{"jsonrpc":"2.0","id":4,"method":"call","params":{"op":"agent.sync","args":{"agent_id":"a1","pid":5113,"birth":"123456789"}}}
{"jsonrpc":"2.0","id":4,"result":{}}
{"jsonrpc":"2.0","id":5,"method":"call","params":{"op":"agent.stop","args":{"agent_id":"a2"}}}
{"jsonrpc":"2.0","id":5,"result":{}}
{"jsonrpc":"2.0","method":"changed","params":{"kind":"exit","agent_id":"a2","exit":{"signal":"SIGHUP","at":"2026-11-20T17:03:00.000Z"}}}
{"jsonrpc":"2.0","id":6,"method":"call","params":{"op":"agent.sync","args":{"agent_id":"a2","pid":5114,"birth":"123456910"}}}
{"jsonrpc":"2.0","id":6,"error":{"code":-32000,"message":"Keeper no longer holds a2.","data":{"reason":"not_found"}}}
```

This sync request runs after the Windows link has been authenticated and has negotiated an
API version. The example numbers represent duplicated handles in the receiving process.

```jsonl keeper-windows
{"jsonrpc":"2.0","id":7,"method":"call","params":{"op":"agent.sync","args":{"agent_id":"a1","pid":5113,"birth":"134292990000000000"}},"terminal":{"input":796,"output":800,"job":804,"signal":808}}
{"jsonrpc":"2.0","id":7,"result":{}}
```

A valid offer outside the keeper's supported set gets a refusal under the original request ID.

```jsonl keeper
{"jsonrpc":"2.0","id":1,"method":"hello","params":{"api_versions":[2]}}
{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"No common keeper API version.","data":{"reason":"protocol_incompatible","details":{"supported_api_versions":[1]}}}}
```

## Exit and replacement

Keeper stop acknowledges the stop request. A later id-less `changed` with `kind:"exit"`
reports the actual exit. On Unix the keeper signals the verified process group with SIGHUP
then sends SIGKILL when the CLI exits or three seconds pass, whichever comes first. Repeated
stops keep the original deadline. On Windows the daemon and keeper release their ConPTY
signal pipe copies and the keeper terminates the corresponding job.

On Unix only the keeper that started a CLI can read its exit code or signal. A replacement
keeper that observes the end of a CLI can give the observation time without either field.
On Windows a keeper holding the process handle can read its exit code. The daemon reconciles
its records against the held agents from the next hello after a disconnect.

```jsonl keeper
{"jsonrpc":"2.0","method":"changed","params":{"kind":"exit","agent_id":"a1","exit":{"at":"2026-11-20T17:04:00.000Z"}}}
```

## The daemon

The daemon sends a ping once per second after hello. If 15 seconds pass without a ping, the
keeper ends the daemon. A keeper holding CLIs starts the daemon again from the launcher.
The restart delay starts at 0.5 seconds, doubles up to 30 seconds, and resets after the
daemon ran for 60 seconds. A keeper holding no CLIs exits when the daemon ends.

## Methods

| Name | Description |
|---|---|
| `hello` | Selects the highest common keeper API version and lists the CLIs the keeper holds. |
| `call` | Runs a keeper operation. Params are `op`, a name from the table below, and `args`, that operation's argument object. |
| `changed` | Reports that a CLI ended (`AgentChange`). |

## Operations

Operations available to `call`. Set `op` to the name and `args` to its arguments. Types are defined below.

| Name | Arguments | Result | Audience | Description |
|---|---|---|---|---|
| `agent.start` | `StartArgs` | `StartResult` | authenticated daemon | Starts the agent's CLI in a new terminal, as its parent: on Unix a PTY, in a session and process group of its own; on Windows a pseudo console, in a job of its own. Answers once the program runs, with the terminal. Fails with `invalid_argument` for an empty command or an agent it holds, and `unavailable` where the terminal, the program, the folder or the CLI's birth cannot be had. |
| `agent.stop` | `StopArgs` | `EmptyResult` | authenticated daemon | Hangs up and answers, then kills once the CLI ends or 3 seconds pass, whichever comes first; a repeated stop keeps the first deadline. On Unix it sends SIGHUP, then SIGKILL, to the CLI's process group; a group whose leader cannot be proved gets no signal, and the stop still answers. On Windows it closes the keeper's copy of the signal pipe, after the daemon let go of its own, then calls `TerminateJobObject` on the CLI's job. Fails with `not_found` for an agent it does not hold. |
| `agent.sync` | `SyncArgs` | `EmptyResult` | authenticated daemon | Gives the terminal to the side that lacks it. A request without one is answered with the keeper's; one with a terminal for a CLI the keeper lacks is held, and watched until it ends: without its exit code on Unix, with it on Windows. A CLI that has already ended is answered as held and reported ended at once. Both sides holding one, the process ID and birth must match (`invalid_argument` otherwise); neither, `not_found`. |
| `daemon.ping` | `PingArgs` | `EmptyResult` | authenticated daemon | Tells the keeper the daemon is alive; send it once a second from hello on. After 15 seconds without one, the keeper kills the daemon: SIGKILL on Unix, `TerminateProcess` on Windows. |

## Error reasons

| Reason | When |
|---|---|
| `invalid_argument` | Invalid framing, handshake order, API versions, parameters or terminal resource. |
| `not_found` | The target is missing, or neither side has its terminal. |
| `unavailable` | The keeper could not start, identify or acquire the CLI or its terminal. |
| `protocol_incompatible` | No common keeper API version. Details give supported_api_versions. |
| `capacity_exceeded` | The line exceeded the 64 MiB limit. |

## Types

### AgentChange

`{ readonly kind: 'exit'; readonly agent_id: string; readonly exit: ProcessExit }`

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
| `state` | `V3AgentState` | yes |  |
| `resumable` | `boolean` | yes |  |

### AgentRef

| Field | Type | Required | Description |
|---|---|---|---|
| `machine_id` | `string` | yes |  |
| `agent_id` | `string` | yes |  |

### ApiVersions

`number[]`

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

### HeldAgent

| Field | Type | Required | Description |
|---|---|---|---|
| `agent_id` | `string` | yes | The local agent's opaque ID. |
| `pid` | `number` | yes |  |
| `birth` | `string` | yes | The operating system's process birth value, compared for equality. |
| `stopping` | `boolean` | no |  |

### HelloParams

| Field | Type | Required | Description |
|---|---|---|---|
| `api_versions` | `ApiVersions` | yes |  |

### HelloResult

| Field | Type | Required | Description |
|---|---|---|---|
| `api_version` | `number` | yes |  |
| `build` | `string` | yes |  |
| `agents` | `HeldAgent[]` | yes |  |

### PingArgs

`Record<string, never>`

### ProcessExit

A recorded CLI exit. Without a code or signal, its status is unavailable; do not treat it as exit code zero.

| Field | Type | Required | Description |
|---|---|---|---|
| `code` | `number` | no | The exit code, if the CLI exited normally and its status is known. On Windows every exit has one: the process's 32-bit exit code carried as an `i32`, so that 0xC000013A is -1073741510. |
| `signal` | `string` | no | The terminating signal name, such as `SIGKILL`. Signal numbers vary by system. Never on Windows. |
| `reason` | `EndReason` | no | Why no code or signal is available, if known. If all three fields are absent, the exit status is unavailable. |
| `at` | `string` | yes | The exit time in UTC ISO 8601 format with milliseconds. For an exit without a code or signal, the time Facade noticed it. |

### ProtocolMismatchDetails

| Field | Type | Required | Description |
|---|---|---|---|
| `offered_api_versions` | `ApiVersions` | no |  |
| `supported_api_versions` | `ApiVersions` | yes |  |
| `agents` | `AgentLabel[]` | no |  |

### StartArgs

| Field | Type | Required | Description |
|---|---|---|---|
| `agent_id` | `string` | yes |  |
| `command` | `string[]` | yes | The program followed by its arguments. |
| `env` | `{ readonly [key: string]: string }` | yes | The CLI's complete environment. |
| `cwd` | `string` | yes | The resolved working directory. |
| `size` | `{ readonly cols: number; readonly rows: number }` | yes |  |

### StartResult

| Field | Type | Required | Description |
|---|---|---|---|
| `pid` | `number` | yes |  |
| `birth` | `string` | yes |  |

### StopArgs

| Field | Type | Required | Description |
|---|---|---|---|
| `agent_id` | `string` | yes |  |

### SyncArgs

| Field | Type | Required | Description |
|---|---|---|---|
| `agent_id` | `string` | yes |  |
| `pid` | `number` | yes |  |
| `birth` | `string` | yes |  |

### V3AgentState

The agent's current state.

`'starting' \| 'working' \| 'waiting_for_you' \| 'just_done' \| 'idle' \| 'error' \| 'ended' \| 'unknown' \| 'online'`

### WindowsTerminal

| Field | Type | Required | Description |
|---|---|---|---|
| `input` | `number` | yes |  |
| `output` | `number` | yes |  |
| `job` | `number` | yes |  |
| `signal` | `number` | no |  |
