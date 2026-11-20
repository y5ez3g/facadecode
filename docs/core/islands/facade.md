# facade

The shell client, managed CLI hooks, and service entry points in `core/crates/facade`. The `facade` program connects
to the Orchestrator and presents its results. It owns the local terminal during an attachment and the foreground SSH
session during a machine connection.

## Shell commands

| Group | Commands |
| --- | --- |
| Agents | `start`, `list`, `resume`, `stop`, `rename` |
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
An unqualified `list` uses current connections. `list --machine` waits for the named machine and can wake it.
`resume` shows stopped agents with resumable sessions and CLI sessions in a common table. After a send, Shell
prints a delivery receipt once a managed agent receives it or a Guest takes it from its inbox. The editor and
other structured callers use the daemon protocol.

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

The normal daemon hello offers protocol 3. A dedicated upgrade client can negotiate protocol 2 with an older
Orchestrator or protocol 3 with a compatible build. It requests `daemon.upgrade` using the new program's absolute
path, build ID, supported takeover range and keeper range. If the old daemon rejects an incompatible keeper upgrade
without giving agent addresses, a read-only v2 roster request supplies the running managed agents on that machine.
The refusal remains a failed upgrade. After an accepting response, Facade closes the upgrade connection and waits
for the requested build to answer a new v3 hello.

`facade daemon --detach` is the background entry for an editor or relay. The caller confirms readiness with hello.
The installer's `facade daemon --takeover` entry checks the selected Facade home and exits 0 if the services are idle.
For a running service, it waits for the installed build to answer with protocol 3. The installer activates the
public `facade` and `facade-mcp` paths after this check succeeds. `facade upgrade` runs the published stable
installer. `facade upgrade --version X.Y.Z` runs the installer pinned to that release, including a candidate
available under the exact version. Both report the actual installed version and launcher directory. Machine
connections pin the installer to the local release.

In debug builds, `FACADE_TEST_DAEMON_PROTOCOL` and `FACADE_TEST_KEEPER_PROTOCOL` take a `low,high` range for
testing compatibility decisions. Release builds advertise the supported protocol ranges.

## Modules

### commands

`commands.rs` runs the agent commands and status. It submits the configured CLI, working directory and native
arguments to the Orchestrator. Each operation uses the common protocol for target resolution, permission checks
and delivery. The module uses the resolved references and operation results for the Shell's tables, details and
receipts. `status <AGENT>` uses `agent.inspect` for launch details and authenticated attachment facts.

Start passes the current folder and environment as local defaults. The remote Orchestrator uses the
target machine's login environment and uses its login home when the command omits a folder. A resumed stored
agent keeps its original folder. Start and send carry the same request ID when a takeover requires reissuing
the call.

### attach

`attach.rs` owns the console until the attachment ends. It reports itself as a Shell client on its machine and follows
a `screen` watch. The Orchestrator authorizes the managed agent and supplies its name, public reference and stable
identity. Foreground start and resume, or a reconnect, can read the final snapshot of the exact run. Each reconnect
watches that same stable identity and begins with a fresh redraw. Only the first watch asks for scrollback.

The console sends key and resize notifications through the current connection. It drops queued input when a
connection ends and counts keys typed while disconnected. It leaves keys already handed to that connection there.
During a planned takeover, any write already in progress completes before Attach acknowledges `closing`. The
reconnect shows the current screen before it resumes sending input. It shows a bottom-line notice on stderr when
any bytes could not be sent. The same policy applies to a local or remote terminal. Shell resize reports the current
rows and columns. A pane too small for a shared redraw reports the layout size and waits for a frame it can draw.
A resize refreshes the pane even if its new size already matches the shared layout.

The terminal is restored before the final diagnostic. A detach, an agent exit, a removal, and a permanent connection
failure use their corresponding status and message. Detach closes an alternate-screen view or moves the main-screen
view into scrollback. At normal exit it does the same when the daemon supplies the CLI's resume instructions, which
can be empty. The instructions are shown with the exit receipt.
Windows uses deferred wrapping during Attach so relative cursor moves after a full row use the same geometry as
the agent's screen.
Attach requests the agent's activity with its screen watch and sends terminal progress while the agent is starting
or working. It clears progress when it reconnects or hands the terminal back.

### hooks

`hooks.rs` handles the CLI's four managed hooks. `session-start <file> [--skill]` and `title <file> [command]`
write the session report only to the current run's private session file. `title` also passes the same input to the
configured title command. `instructions <cli>` reads the managed run's instructions through its local run hint.
`approve <cli>` uses the rule for approval of Facade tools. Rules owns the CLI-specific input and output.

Hooks read up to 1 MiB of input and wait up to one second for it. Hooks always exit 0. They read local run artifacts
and write only the run's own session file. The inherited run hint is separate from the Orchestrator's MCP identity.

### machine

`machine.rs` runs the foreground machine commands. `add` and `connect` accept the person's login SSH arguments in
order, with a Facade `--home` prefix when supplied. SSH can ask for credentials or host keys in the person's terminal.
`add` uses a local `machine link` process that keeps the authenticated SSH connection. It reports success and
returns after the Orchestrator confirms the saved connection. The same process carries traffic until either end
closes the link. `connect` stays open for the lifetime of that command. Machine state and the original SSH error
come from the Orchestrator's machine view.

The hidden `machine serve` validates the first machine hello, opens the daemon socket for the selected home and
relays the machine protocol. A passive `machine serve --no-start` returns 3 when the Orchestrator is sleeping.
SSH runs the installed program at its fixed path. The platform commands live in Base and the installer contract is
shared with the background connection path. Both probe that program with `--version`. Older initiating builds
query a different entry point, so update the machines that initiate connections before their remote targets.

## Dependencies

- [base](base.md) supplies the shared protocol, socket and console operations, shell process arguments and installers.
- [rules](rules.md) supplies managed hook formats and session reporting.
- [keeper](keeper.md) and [daemon](daemon.md) supply their service entry points.

See [PROTOCOL.md](../../../core/protocol/PROTOCOL.md) for the wire types and [FEATURES.md](../FEATURES.md) for the
product commands.
