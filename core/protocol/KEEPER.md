<!-- Generated from core/crates/base/src by core/crates/base/tests/protocol_files.rs: do not edit. -->

# Facade keeper protocol

Protocol version 1 (oldest accepted: 1). Version 1 is frozen: later versions only add optional fields, and every
daemon keeps speaking version 1.

The keeper protocol connects the daemon and the keeper over JSON-RPC 2.0, one message per line, on the keeper's socket,
`keeper-<key>.sock` beside the daemon's, its key reckoned as in the [daemon protocol](PROTOCOL.md). Framing and error reasons are
the same as there. Unknown fields are ignored; an unknown operation is `invalid_argument`.

The keeper is the parent of the CLIs, holds a copy of each CLI's PTY master so a terminal outlives any daemon, and watches the
daemon, which it starts from the launcher and starts again. It runs on one thread.

## Connect

The keeper checks its peer through the kernel as it accepts the connection: its user ID must be this user's, and its process ID
and birth must match the daemon lock's record (`core/daemon.lock`). Any other peer is closed at once. A connection it accepts
replaces the one before. Send `hello` first with the daemon's version range; the keeper answers with its own range and the CLIs
it holds, and each side speaks the highest version both ranges share.

`agent.start` answers with the CLI's PTY master, passed with `SCM_RIGHTS`. `agent.sync` passes a master from the side that has it
to the side that lacks it, one agent at a time: after the daemon restarts, it asks for each CLI's; after a keeper ends, the
daemon gives each to the keeper it starts next.

## CLIs

Once a CLI ends, the keeper sends `changed` where a daemon is connected, reaps the CLI, closes its master and forgets it. Only
the keeper that started a CLI has its exit code or signal; a CLI it holds from `agent.sync` ends without either, and a daemon
that misses the notification finds the agent gone from the next hello.

`agent.stop` sends SIGHUP to the CLI's process group and answers. Once the CLI ends or 3 seconds pass, whichever comes first,
the group gets SIGKILL; a repeated stop keeps the first deadline. A signal needs the group's leader proved by its process ID,
birth and group: an unreaped leader keeps its IDs, and a group whose leader cannot be proved gets no signal. A CLI that ends by
itself leaves alone the processes it left behind, as closing a terminal does. On SIGTERM or SIGINT, the keeper sends SIGKILL to
the groups it is stopping, and exits.

## The daemon

The daemon pings once a second from its hello on. After 15 seconds without a ping, the keeper ends it with SIGKILL. Once the
daemon ends, a keeper holding CLIs starts the launcher's daemon again after a delay that starts at 0.5 seconds and doubles up to
30 seconds, starting over after a daemon that ran 60 seconds; a keeper holding none exits.

For example, to stop agent `a1`:

```json
{"jsonrpc":"2.0","id":2,"method":"call","params":{"op":"agent.stop","args":{"agent":"a1"}}}
```

## Methods

| Name | Description |
|---|---|
| `hello` | Starts the connection (`HelloParams`), answered with the keeper's range and the CLIs it holds (`HelloResult`). |
| `call` | Runs a keeper operation and returns its result. `params` contains `op`, an operation name from the table below, and `args`, that operation's argument object. |
| `changed` | Reports that a CLI ended (`AgentChange`). |

## Operations

Operations available to `call`. Set `op` to the name and `args` to its arguments. Types are defined below.

| Name | Arguments | Result | Description |
|---|---|---|---|
| `agent.start` | `StartArgs` | `StartResult` | Starts the agent's CLI in a new PTY, in a session and process group of its own, as its parent. Answers once the program runs, with the PTY master. Fails with `invalid_argument` for an empty command or an agent it holds, and `unavailable` where the PTY, the program, the folder or the CLI's birth cannot be had. |
| `agent.stop` | `AgentArgs` | `EmptyResult` | Sends SIGHUP to the CLI's process group and answers. Sends SIGKILL to the group once the CLI ends or 3 seconds pass, whichever comes first; a repeated stop keeps the first deadline. A group whose leader cannot be proved gets no signal, and the stop still answers. Fails with `not_found` for an agent it does not hold. |
| `agent.sync` | `SyncArgs` | `EmptyResult` | Gives the PTY master to the side that lacks it. A request without one is answered with the keeper's; one with a master for a CLI the keeper lacks is held, and watched until it ends, without its exit code. A CLI that has already ended is answered as held and reported ended at once. Both sides holding one, the process ID and birth must match (`invalid_argument` otherwise); neither, `not_found`. |
| `daemon.ping` | `NoArgs` | `EmptyResult` | Tells the keeper the daemon is alive; send it once a second from hello on. After 15 seconds without one, the keeper ends the daemon with SIGKILL. |

## Error reasons

The `data.reason` values the keeper sends.

| Reason | When |
|---|---|
| `invalid_argument` | A malformed request, an unknown operation, a second hello or a call before hello, an empty command, an agent the keeper already holds a CLI for, or a sync whose process is not the one held. |
| `not_found` | The keeper holds no CLI for the agent. |
| `unavailable` | The PTY, the program, the folder, the CLI's birth, or a copy of the master could not be had. |
| `protocol_incompatible` | The daemon's version range and the keeper's share no version. |
| `capacity_exceeded` | A line is longer than the protocol allows. |

## Types

### AgentArgs

Arguments for an operation on one agent's CLI.

| Field | Type | Required | Description |
|---|---|---|---|
| `agent` | `string` | yes | The agent's ID. |

### AgentChange

A change the keeper reports. The daemon skips kinds it does not know.

`{ readonly kind: 'exit'; readonly agent: string; readonly exit: ProcessExit }`

### EmptyResult

An empty success result: `{}`.

`Record<string, never>`

### EndReason

Why an exit has no code or signal.

`'terminal_closed'`

### HeldAgent

A CLI the keeper holds, as `hello` reports it.

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | yes | The agent's ID, an opaque string. |
| `pid` | `number` | yes | The CLI's process ID. |
| `birth` | `string` | yes | The CLI's birth: an opaque string, compared for equality alone. On macOS it is the process's start time as `<seconds>.<6-digit microseconds>`; on Linux, the starttime field, the 22nd, of `/proc/<pid>/stat`, in decimal. |
| `stopping` | `boolean` | no | The keeper is stopping it. Absent means false. |

### HelloParams

Parameters for `hello`.

| Field | Type | Required | Description |
|---|---|---|---|
| `protocol` | `[number, number]` | yes | The oldest and newest keeper protocol versions the daemon speaks. |

### HelloResult

The result of `hello`.

| Field | Type | Required | Description |
|---|---|---|---|
| `protocol` | `[number, number]` | yes | The oldest and newest keeper protocol versions the keeper speaks. Each side speaks the highest version both ranges share. |
| `build` | `string` | yes | The keeper's build. |
| `agents` | `HeldAgent[]` | yes | The CLIs the keeper holds, in no particular order: every one that has not ended. |

### NoArgs

Empty arguments: `{}`. May be omitted for topics that take no arguments.

`Record<string, never>`

### ProcessExit

A recorded CLI exit. Without a code or signal, its status is unavailable; do not treat it as exit code zero.

| Field | Type | Required | Description |
|---|---|---|---|
| `code` | `number` | no | The exit code, if the CLI exited normally and its status is known. |
| `signal` | `string` | no | The terminating signal name, such as `SIGKILL`. Signal numbers vary by system. |
| `reason` | `EndReason` | no | Why no code or signal is available, if known. If all three fields are absent, the exit status is unavailable. |
| `at` | `string` | yes | The exit time in UTC ISO 8601 format with milliseconds. For an exit without a code or signal, the time Facade noticed it. |

### StartArgs

Arguments for `agent.start`.

| Field | Type | Required | Description |
|---|---|---|---|
| `agent` | `string` | yes | The agent's ID, an opaque string. |
| `command` | `string[]` | yes | The program followed by its arguments; not empty. The program is an absolute path, or a name looked up in `env`'s `PATH`. |
| `env` | `{ readonly [key: string]: string }` | yes | The CLI's whole environment. The keeper adds no variable. |
| `path` | `string` | yes | The CLI's working folder, an absolute path. |
| `cols` | `number` | yes | The terminal's first width in columns. Below 2 is 2. |
| `rows` | `number` | yes | The terminal's first height in rows. Below 1 is 1. |

### StartResult

The result of `agent.start`. Its response carries the PTY master.

| Field | Type | Required | Description |
|---|---|---|---|
| `pid` | `number` | yes | The CLI's process ID. |
| `birth` | `string` | yes | The CLI's birth, as [`HeldAgent::birth`]. |

### SyncArgs

Arguments for `agent.sync`: the CLI the daemon knows for the agent. The request carries the daemon's PTY master where it has one.

| Field | Type | Required | Description |
|---|---|---|---|
| `agent` | `string` | yes | The agent's ID. |
| `pid` | `number` | yes | The CLI's process ID. |
| `birth` | `string` | yes | The CLI's birth, as [`HeldAgent::birth`]. |
