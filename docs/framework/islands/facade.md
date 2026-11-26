# facade

The shell client, managed CLI hooks, and service entry points in `framework/crates/facade`. The `facade` program connects
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
waits for the named machine and can wake it. `resume` shows ended agents with resumable sessions and lists
independent CLI sessions from the current folder. A named `resume --machine` lists managed agents on that
machine and provides references that include its selector. `list --local` and `resume --local` stay on this
machine and open zero SSH connections even if they start the local daemon.
Both tables show the latest native session name or the existing session preview in `SESSION`. A missing session name
or preview displays as `-`. `facade status <AGENT>` shows the session name or preview from the same daemon lookup in
`Session` and the full native session ID in `Session ID`. Each field shows `-` when its value is absent. A saved session's `REFERENCE`
shows the daemon's selector for resuming it from the current folder, or the full session ID if the reply has no selector.

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
The installer's `facade daemon --takeover` entry selects an eligible program set in a sleeping home and leaves
services asleep. For a running service, it applies the build order and the existing daemon and Keeper admission,
then waits for a compatible hello from the installed build. `--install-only` can select while the services sleep.
`facade upgrade` checks stable build metadata against the current home's selection. `facade upgrade --version X.Y.Z`
uses that release's BUILD marker and the same replacement order. Both pass the complete BUILD to the installer
and report the selected build and launcher folder when available. An SSH installation pins the complete local BUILD.

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
stable identity and begins with a fresh redraw. Each watch requests the visible screen and up to
`REDRAW_SCROLLBACK_ROWS` preceding rows.

After connecting to the local daemon for a start or resume, Shell enters raw mode and asks the terminal app for its
default foreground, background and cursor colors with OSC 10, 11 and 12, and for the ANSI palette with one OSC 4 query
per color. It ends with the Device Attributes query DA1, which terminal apps answer in order, so its reply says that
every color reply arrived. Shell waits up to one second for that reply. The launch passes the colors that arrived as
display context, and the agent's screen answers the CLI's color queries with them. A color without a readable reply
stays absent. A background launch asks as well when Shell reads the terminal as its foreground job. A process started
with `&`, a redirected console, `TERM=dumb` and ordinary Attach ask nothing. Keys typed while a background launch
asks go back to the terminal's input for the next program.

Every reply to those queries belongs to Shell, including one with a value it cannot use. `attach/palette.rs` takes
complete replies out of the input and hands Attach the same console reader, the remaining input in order, the queries
still unanswered and any unfinished reply. Attach takes late replies out the same way and forwards the rest in order,
including a held prefix that turns out to be other input. A read in Attach that ends in ESC or ESC ] counts as Escape
or Alt+], so a late reply split there goes through to the CLI. Late replies leave the launch's colors as they were.
One console mode lease keeps echo off from the first query through the launch and first watch snapshot. Shell pauses
console reads while the daemon calls are in flight, then Attach resumes with the same reader after displaying the
snapshot. Shell restores the original console modes before reporting a failure or an ended run without a view.
Replies arriving after that handback belong to the host shell.

The console sends key and resize notifications through the current connection. It drops queued input when a
connection ends and counts keys typed while disconnected. It leaves keys already handed to that connection there.
During a planned takeover, any write already in progress completes before Attach acknowledges `closing`. The
reconnect shows the current screen before it resumes sending input. It shows a bottom-line notice on stderr when
any bytes could not be sent. The same policy applies to a local or remote terminal. The Orchestrator chooses the
smallest active viewer size in each dimension. Shell seeds a local `Screen` and its scrollback from each watch's
snapshot. It feeds new output into that Screen and reflows its history at the confirmed shared size on redraws.
An empty initial main viewport leaves the shell page visible, even if the snapshot contained history. Attach
forwards title changes and native activity while waiting for visible content.
The first frame with main-screen content or the first alternate frame enters the host's alternate screen.
Attach keeps that view through screen switches, resizes and
reconnects. Full frames use `Screen::redraw_for_attach` and carry the known native title. During ordinary output,
an equally sized console accepts native bytes and a larger console rewrites the shared rows in place with
`Screen::redraw_in_viewport_update`. A new connection, geometry change or output containing a screen switch or
terminal reset takes the full draw path. A full frame includes what an open synchronized update holds back, because
the console then receives only the rest of that update. An undersized console reports the current layout size in the
alternate screen. Screen carries the CLI's native activity bytes through derived draws.

Attach keeps the host terminal's title until the CLI sets its own. When the attachment ends, Attach clears
the title only if it showed a CLI title. It always uses the terminal's title stack, where supported, to
restore the host's previous title.

Attach leaves the CLI's mouse modes, its cursor key mode and its erase-saved-lines command out of what the host
receives, and sets the host's mouse and cursor key modes itself when they change. The active mode of each group goes
last, since a terminal can take a reset as turning the whole group off. Repeating the modes could end a drag in
progress, so Attach writes them once. A CLI that tracks the mouse keeps the modes it asked for, and receives the reports
the terminal sends. The terminal app has the mouse while the connection is lost and when the attachment ends.

Where `host_tells_the_wheel` holds, the terminal app keeps the mouse for every CLI: selecting, copying and the right
click are the app's. On its alternate screen the app sends the wheel as Up and Down: the Windows terminals with
alternate scroll, which Attach turns on, and macOS Terminal only with application cursor keys, which Attach keeps on.
`attach/mouse.rs` takes a key that Base's `desktop::arrows` finds up as the wheel, which browses the scrollback of a
CLI that leaves the mouse alone and reaches one that tracks it as its own wheel report. It gives the CLI the other
cursor keys as it asked for them. A Win32 record with the enhanced
flag comes from the keyboard whatever its state is by then. The reader asks the keyboard before it waits for anything,
because a key can be up again soon. A key's last repeat within 150 ms of a press is still that key. All this needs the
keyboard the person types on, so it applies in macOS Terminal and VS Code on macOS, and in every terminal on Windows.

In macOS Terminal, where Base's `desktop::clicks` holds, a CLI that tracks the mouse also gets its clicks
(`lends_the_mouse`). Its reports come to Attach, which holds a left press and gives it to the CLI with its release as
a click. For a drag or a right click Attach lends the mouse back: it writes the host's modes without the CLI's mouse,
waits for Terminal's answer to a status report, then presses the left button again where the drag began, so that
Terminal selects from there, or clicks the right button where the person did, so that Terminal shows its menu. It takes
the mouse back once the button is up or the menu is open. Without Terminal's answer within 500 ms, or with the
attachment ended by then, nothing is posted. Typing or a click for the CLI leaves Terminal's selection behind by drawing in
a new alternate buffer. VS Code and Windows terminals keep the CLI's clicks off.
VS Code's first alternate buffer keeps the size from before the terminal was resized, and holds the rows beyond the
screen as scrollback. Attach enters it twice there.

Elsewhere Attach takes the mouse of such a CLI and requests SGR button, drag and wheel reports. A drag selects from the
viewport Shell painted. Releasing the button copies the selection, and Ctrl+C and a right press copy it again. Attach
accepts legacy ETX, Kitty Ctrl+C presses and the ordinary Win32 Ctrl+C key record. When Attach copies on a Kitty press,
it consumes that key's repeats and release. A Control-only repeat copies again while the selection is visible. A click
clears the selection, and Shift still lets terminals with a native selection override handle the gesture. A selection of
blank cells copies nothing. Copying uses the computer's own clipboard through Base and OSC 52, which some terminals
ignore. Over SSH only OSC 52 applies. `attach/mouse.rs` holds a report that a read cut off until the rest arrives, for
up to 50 ms, so no part of a report reaches the CLI as text.

The wheel browses the main grid's scrollback: one row for each report or key in macOS Terminal, which sends one for each
row, and three rows elsewhere. On an alternate grid without mouse reporting, the wheel presses Up and Down as the
terminal app would: in macOS Terminal if the CLI turned on application cursor keys, elsewhere always. Shell holds the
exact viewport that it painted, so the text stays still and selectable even as history ages out.

The live Screen continues to receive output while browsing or selecting. The host keeps receiving the CLI's input
mode changes, title and activity. Wheel steps start from the browsed row while it remains in history, or from the
oldest retained row after it falls out. Scrolling clears the selection. Typing, scrolling to the bottom, clearing
history, a full redraw or a change in mouse ownership brings back the live view. Focus reports are not typing.

Base captures native Windows wheel events for local browsing and CLI mouse tracking, and reports native pointer
actions for local selection. When the CLI tracks mouse input, Attach forwards its raw mouse reports and
Screen encodes native wheels in the CLI's mouse format. Windows uses deferred wrapping during
Attach so cursor moves after a full row follow the same geometry as the agent's screen.

At the end of an attachment, Attach leaves the alternate screen if it entered it, returning to the shell page,
cursor and scrollback. It restores the terminal modes and prints the receipt and any unsent-input warning after
the opening line. A normal exit returns the status in the daemon's final event or exact ended snapshot. The daemon
lets an active dedicated watcher receive the final output and exit in order, then closes that connection within its
post-exit grace period. A removal or lost connection uses the corresponding Shell diagnostic.

### hooks

`hooks.rs` handles the CLI's four managed hooks. `session-start <file> [--skill]` and `title <file> [command]`
write the session report only to the current run's private session file. `session-start` accepts and ignores the
old `--skill` flag. `title` also passes the same input to the configured title command. `instructions <cli>` uses
the local run hint to read only the managed instructions file. `approve <cli>` uses the rule for approval of
Facade tools. Rules owns the CLI-specific input and output.

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

SSH probes the program in the selected remote home. A missing or lower-ranked installation uses the pinned
installer when that operation permits it. A higher-ranked installation asks the person to upgrade the local
home. The machine hello still verifies the daemon API and identity. The platform commands live in Base and
the installer contract is shared with the background connection path. A hidden SSH
administration entry handles enrollment and reciprocal removal over an already authenticated login. Add and
Connect take their logout warning from the verified peer flag in the confirmed `connected` notification.

## Dependencies

- [base](base.md) supplies the shared protocol, socket and console operations, shell process arguments and installers.
- [screen](screen.md) redraws the canonical agent grid within a larger Shell console.
- [rules](rules.md) supplies managed hook formats and session reporting.
- [keeper](keeper.md) and [daemon](daemon.md) supply their service entry points.

See [DAEMON.md](../../../framework/protocol/DAEMON.md) for the wire types and [FEATURES.md](../FEATURES.md) for the
product commands.
