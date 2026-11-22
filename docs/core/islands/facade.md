# facade

The shell client, managed CLI hooks, and service entry points in `core/crates/facade`. The `facade` program connects
to the Orchestrator and presents its results. It owns the local terminal during an attachment and the foreground SSH
session during a machine connection.

## Shell commands

| Group | Commands |
| --- | --- |
| Agents | `start`, `stop`, `list`, `resume`, `rename` |
| Interact | `attach`, `send`, `screen`, `type` |
| System | `status`, `machine`, `upgrade` |

Help and `--version` run without starting services. `-h`, `--help` and `facade help <command>` show the same
command page. The root and `machine` show their help when called on their own. Bare `start`, `attach`, `stop`,
`screen`, `rename`, `send`, `type`, `machine add`, `machine connect`, `machine remove` and `machine rename`
also show help. Calls with options or operands use the command's normal argument validation. Bare `list`, `status`,
`resume`, `upgrade` and `machine list` run their default actions.

Put Facade startup options before the CLI name. Arguments after it go to the selected CLI. The Orchestrator validates
the CLI, target machine, working directory and worktree.

Ordinary commands use a Terminal connection. A `facade` invocation from an agent's terminal has the same identity as
any other invocation. The Orchestrator records the command line as the sender of `send`.

Results and receipts go to stdout. Empty results, guidance, diagnostics, progress and attachment messages go to
stderr. Command success is 0, an operation failure is 1, and invalid usage is 2. After a foreground `start`, `resume`
or `attach` opens the agent's terminal, Ctrl+] detaches and returns 0. When the agent exits first, the command returns
the agent's exit code or 128 plus its signal number. A closed stdout pipe ends the command quietly. The layer uses the
platform's SIGPIPE behavior or handles a failed write.

The Orchestrator supplies copyable agent references such as `a5@laptop` and message IDs such as `m42@laptop`.
An unqualified `list` queries reachable machines on demand and leaves sleeping machines idle. `list --machine`
waits for the named machine and can wake it. `resume` shows stopped agents with resumable sessions and lists
independent CLI sessions from the current folder. A named `resume --machine` lists managed agents on that
machine and provides references that include its selector. `list --local` and `resume --local` stay on this
machine and open zero SSH connections even if they start the local daemon.
Both tables show the latest native session name or the existing conversation preview in `SESSION`. A missing
label displays as `-`. The tables use the daemon's session lookup on the agent's machine. `facade status <AGENT>`
shows the full session ID. A saved session uses its displayed `REF` for resume.

`stop <AGENT>...` accepts one or more references. `stop --local`, `stop --machine <MACHINE>` and `stop --all`
are exclusive alternatives. Scope stops skip connected Guests. A remote scope stop leaves sleeping machines
idle. Shell prints confirmed stops before reporting failed items and machines. A partial failure returns 1.

`send` confirms that Facade saved the message in the recipient's inbox. With `-w` or `--wait-delivery`, it
confirms delivery to the managed terminal or a Guest's inbox read. With `-r` or `--wait-reply`, it writes
the first linked reply from the original recipient, preserving the reply's text and line endings.
`-t` or `--timeout` sets the total wait from 1 to 300 seconds, with a default of 30. The budget starts
after argument validation and applies to connection startup, target resolution, delivery, reply, and receipt
as applicable to the selected wait.

During a planned takeover, `send` retries a pre-admission refusal with the same request ID and the remaining
time. After the retiring daemon announces closing, an unanswered inbox or delivery call can replay once by
request ID. An admitted reply wait belongs to its original connection.

`type` validates the full input before it connects. Text operands are pasted as separate segments and
`-k` or `--key` inserts a key press at its position in the command. Shell sends the ordered input in one
call and prints a receipt after the terminal receives it. The single-text `--enter` form still submits
that paste with Enter.

## Connections and installation

`main.rs` parses arguments, opens a connection when the operation needs one, and passes it to the command handler.
When `start` or `resume` returns an agent for a foreground command, the layer passes the connection and the agent's
stable reference to Attach. `cli.rs` owns command parsing, `help.rs` owns the examples and groups, and `errors.rs`
adds Shell guidance to the Orchestrator's diagnostics.

The layers share the terminal formatters, the selected client's connection and the display name and address returned
by the Orchestrator. Persistent Agent, machine and message records belong to the Orchestrator.

`daemon_client.rs` opens the socket for the selected `FACADE_HOME`. For an ordinary command, it starts a keeper when
neither service is running. The keeper starts the daemon. Local `status` probes without starting or upgrading
services. When they sleep, local status and start help use the committed machine name through the daemon's offline
reader. Agent status uses the normal connection and the Orchestrator routes that query. The caller can cancel an
Attach reconnect while the socket opens or while the Orchestrator answers hello.

The Terminal client offers its supported daemon API versions in `hello` and uses the selected version for
that connection. A warm replacement sends `daemon.upgrade` with the new program's absolute path, build ID,
and the independent daemon and keeper API version sets. The running Orchestrator checks the target daemon
set and the live keeper's negotiated version before replacement. A refusal can identify running agents that
block replacement. After acceptance, Facade waits for the requested build to answer a fresh hello.

`facade daemon --detach` is the background entry for an editor or relay. The caller confirms readiness with hello.
The installer's `facade daemon --takeover` entry checks the selected Facade home and exits 0 if the services are idle.
For a running service, it waits for the installed build to answer a compatible daemon hello. The installer activates
the public `facade` and `facade-mcp` paths after this check succeeds. `facade upgrade` checks stable release metadata
first. It prints the up-to-date receipt when the current version is at or above the stable channel without
running an installer or asking for takeover. `facade upgrade --version X.Y.Z` runs the installer pinned to
that release, including a candidate available under the exact version. The pinned path bypasses the stable
check and can install an older release when services are idle. A running newer daemon may refuse the takeover.
Both forms report the actual version and installed launcher folder when available. Machine connections pin
the installer to the local release.

## Modules

### commands

`commands.rs` runs the agent commands and status. It submits the configured CLI, working directory and native
arguments to the Orchestrator. Each operation uses the common protocol for target resolution, permission checks
and delivery. The module uses the resolved references and operation results for the Shell's tables, details and
receipts. `status <AGENT>` uses `agent.inspect` for launch details and authenticated attachment facts.

Start passes the current folder and environment as local defaults. The remote Orchestrator uses the
target machine's login environment and uses its login home when the command omits a folder. A resumed stored
agent keeps its original folder. The start command keeps its business request ID and arguments across an
eligible reconnect. The command-line reply uses the lifetime of the original bounded call. Shell reports
the facts the daemon supplies when the result cannot be confirmed.

### attach

`attach.rs` owns the console until the attachment ends. It reports itself as a Shell client on its machine.
On every connection, the console chooses `watch attach.shell` if the Terminal hello advertises it, and
`watch attach` otherwise. A foreground start or resume opens a fresh Terminal connection for the
dedicated watch and keeps the launch connection when using ordinary Attach. The console sends capacity
with the watch and sends `attach.resize` on the connection that owns it. The Orchestrator authorizes
the managed agent and supplies its name, public reference and stable identity. Foreground start and
resume, or a reconnect, can read the final snapshot of the exact run. Each reconnect watches that same
stable identity and begins with a fresh redraw. Only the first watch asks for scrollback.

The console sends key and resize notifications through the current connection. It drops queued input when a
connection ends and counts keys typed while disconnected. It leaves keys already handed to that connection there.
During a planned takeover, any write already in progress completes before Attach acknowledges `closing`. The
reconnect shows the current screen before it resumes sending input. It shows a bottom-line notice on stderr when
any bytes could not be sent. The same policy applies to a local or remote terminal. The Orchestrator chooses the
smallest active viewer size in each dimension. Shell keeps a `Screen` at the confirmed shared size and updates it
from snapshots, redraws and output. An empty initial main frame leaves the host page visible until the CLI
draws. The first main-screen draw makes room from the current shell position by ordinary terminal scrolling.
An alternate-screen draw switches buffers before it paints. Full frames use
`Screen::redraw_for_attach` and carry the known native title. During ordinary output, an equally sized console
accepts native bytes and a larger console rewrites the shared rows in place with `Screen::redraw_in_viewport_update`.
A new connection, geometry change or screen switch takes the full draw path. An undersized console reports the
current layout size. Screen carries the CLI's native activity bytes through derived draws. While the shell
page is held, Attach can still display the native title and activity from the CLI.

The CLI's mouse mode controls when the console captures wheel input. Base converts Windows console records
into viewport coordinates, and Screen encodes them as terminal input in the shared grid. Host scrolling applies
when the CLI leaves mouse reporting off. Windows uses deferred wrapping during Attach so cursor moves after
a full row follow the same geometry as the agent's screen.

Attach restores the buffer, cursor and input modes before printing a normal detach or exit receipt. A normal
exit returns the status in the daemon's final event or exact ended snapshot. The daemon lets an active
dedicated watcher receive the final output and exit in order, then closes that connection within its post-exit
grace period. A removal or lost connection uses the corresponding Shell diagnostic.

### hooks

`hooks.rs` handles the CLI's four managed hooks. `session-start <file> [--skill]` and `title <file> [command]`
write the session report only to the current run's private session file. `title` also passes the same input to the
configured title command. `instructions <cli>` reads the managed run's instructions through its local run hint.
`approve <cli>` uses the rule for approval of Facade tools. Rules owns the CLI-specific input and output.

Hooks read up to 1 MiB of input and wait up to one second for it. Hooks always exit 0. They read local run artifacts
and write only the run's own session file. The inherited run hint is separate from the Orchestrator's MCP identity.

### machine

`machine.rs` runs the machine commands. `add` and `connect` accept the person's login SSH arguments in order,
with Facade options before the SSH arguments. SSH can ask for credentials or host keys in the person's console.
`machine list` reads the local machine table without opening SSH. A saved connection with no live session or
observed error displays `Disconnected`. The Orchestrator reports a confirmed sleeping machine, a connection
error or a need for SSH login as distinct states.

`add` reuses working batch credentials. If password login is needed, it uses the authenticated login to confirm
the remote Facade identity and install the local dedicated public key. It verifies that key on an independent,
noninteractive SSH connection, confirms the same machine ID and only then saves the verified connection. A
second add for the same machine ID can update its credentials. Explicit `add --bidirectional` also verifies and
saves a return connection using the source address seen by the remote SSH service. It rolls back authorization
and host trust added for a return that fails, keeping the confirmed forward connection. A temporary `connect`
carries traffic in both directions for as long as the foreground command stays open. It also works where only
one side can initiate SSH.

`remove` deletes the local saved connection and revokes Facade-marked local authorization for the other machine
with zero SSH. `remove --bidirectional` first uses the saved SSH login to confirm the remote machine ID and
request reciprocal cleanup. The remote side checks authorization even when a saved return connection is absent.
Shell performs local cleanup after the remote attempt, reports each side's outcome and returns 1 when it cannot
confirm both sides. Removal matches authorization to a machine ID so a machine rename does not interfere.

The hidden `machine serve` validates the first machine hello and its daemon API offer before opening the
daemon socket. Invalid and incompatible offers receive a structured reply on the original request ID.
A valid hello and its reply cross the relay byte for byte, and the session continues in both directions.
A passive `machine serve --no-start` returns 3 when the Orchestrator is sleeping. The relay carries the
authenticated peer's idle notification for the Orchestrator to handle.

SSH attempts the installed program at its fixed path and negotiates the daemon API independently of the
software build. A missing install uses the pinned installer when the entry permits installation. The platform
commands live in Base and the installer contract is shared with the background connection path. A hidden SSH
administration entry handles enrollment and reciprocal removal over an already authenticated login. Add and
Connect take their logout warning from the verified peer flag in the confirmed `connected` notification.

## Dependencies

- [base](base.md) supplies the shared protocol, socket and console operations, shell process arguments and installers.
- [screen](screen.md) redraws the canonical agent grid within a larger Shell console.
- [rules](rules.md) supplies managed hook formats and session reporting.
- [keeper](keeper.md) and [daemon](daemon.md) supply their service entry points.

See [DAEMON.md](../../../core/protocol/DAEMON.md) for the wire types and [FEATURES.md](../FEATURES.md) for the
product commands.
