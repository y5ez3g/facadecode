# Features

What Facade core does today, and how to use it. Exact behavior lives in three places, and this page links to them
instead of repeating them: the [daemon protocol](../../core/protocol/PROTOCOL.md) for every operation, the
[MCP contract](../extension/engineering/MCP.md) for Facade's tools, and the [shared rules](../extension/RULES.md) that
both follow.

Core serves the computer it runs on. The editor extension uses core when its Rust engine is on. It runs on macOS and
on Linux, each on x64 and arm64, and on Windows 11 or Windows Server 2022 and later on x64 and Windows 11 on arm64. On
Windows it is a native program, and each CLI runs in a pseudo console.

## Agents

An agent is a CLI that Facade runs in a terminal it keeps, or a session that joined from outside, a guest.

- **Start**: `facade start [OPTIONS] <PROGRAM> [ARGS]...`. Put Facade's options, such as `--name` and `--prompt`,
  before PROGRAM. The arguments after it go to that program. A CLI of the settings file starts as its entry says:
  the six built-ins, `claude`, `codex`, `agy` (Antigravity), `muse` (Muse Code), `opencode` and `pi`, and each entry
  that the file's `clis` adds. Any other program, a path included, runs as given. In an interactive terminal, Facade
  attaches to the agent. Use `-d` or `--detach` to start it in the background and print its ID. A start with
  redirected input or output also runs in the background.
- **Model and effort**: an entry's `model` and `effort`, unless the CLI's own words choose them.
- **First prompt**: Use `--prompt` to give an agent its first prompt. The CLI must support Facade messages. Facade waits
  until the CLI's tools have connected or will not connect before trying to deliver the prompt.
- **Numbers and names**: every agent gets the next `#aN`, which its home never gives again. An agent without a name gets
  one from the settings file's `names`, else from Facade's own. `facade rename` changes it. An editor window says at
  `hello` the highest agent and message numbers its editor gave before, and core numbers above them from then on.
- **List**: `facade list` or `facade ls` shows one row per visible agent, with its ID, name, CLI, state, age and
  folder. Ended agents stay in the list until removed. A guest's CLI is marked `(guest)`. Use `-q` for one bare ID
  per line or `--json` for the agent records and each machine's answer.
- **States**: The table describes an agent's state in words such as `working`, `waiting for you: question`,
  `turn finished`, `stopped` or `exited: code 0`. A state comes from what the CLI reports and what Facade reads
  from its screen. JSON keeps the protocol values. See [States](../../core/protocol/PROTOCOL.md#states).
- **A started agent that waits**: when an agent that another agent of the same window started waits 20 seconds in a row
  on a permission, a question or a sign-in, its creator gets one message saying so. The person gets no message.
- **Stop and remove**: `facade stop` ends the CLI and keeps the agent listed. On Unix it sends SIGHUP to its process
  group, then SIGKILL 3 seconds later to anything left. On Windows its pseudo console closes, which sends
  `CTRL_CLOSE_EVENT` to every program in it, and its job ends 3 seconds later. `facade remove` (alias `rm`) stops the
  agent if it runs, then removes it and its saved screen and inbox. Both accept several IDs or names and handle them
  in order. Each success prints the ID or name as you gave it. They continue after an individual failure and exit 1
  if any failed.
- **Resume**: `facade resume` starts an ended agent's CLI again, continuing the session the CLI reported. The agent
  keeps its ID, name and screen. An agent can resume when Facade started it with a CLI that supports resuming and
  saved a session. Use `-d` or `--detach` to resume in the background and print the same ID.
  See [Resume](../../core/protocol/PROTOCOL.md#resume).
- **Continue a session**: a start can continue a CLI's session as a new agent, with its own `#aN`, with the arguments
  its rule gives to continue it: an editor does this to bring back a pinned or recent session. See `StartArgs.session` in
  [PROTOCOL](../../core/protocol/PROTOCOL.md#startargs).
- **Inspect**: `facade inspect` shows an agent's state, process, Facade tools, input box, last submitted text and saved
  session. Its times include UTC. `--json` prints the full inspection.

The command line prints bare IDs such as `a3`, and an agent of another machine with its machine, as `a17@gpu`. It
accepts those forms, a quoted `'#a3'` or `'#a17@gpu'`, a number or an agent name, alone or as `Pixel@gpu`.
Message headers continue to use IDs such as `#a3` and `#m42`.

## Terminals

- **Show and type**: `facade attach <agent>` shows the agent's terminal for you to watch and use. Ctrl-] detaches and
  leaves the agent running. An interactive `facade start` or `facade resume` attaches the same way. Attach to an ended
  agent to see its saved screen. The command exits with the agent's exit code when the agent ends or after showing
  its saved screen.
- **One size**: every viewer of an agent sees the same terminal size, and the last resize wins. Each viewer then gets a
  full redraw.
- **Reconnect**: when the daemon goes away, an attachment reconnects by agent ID, and starts Facade if needed. Keys
  typed meanwhile wait, up to 1 MiB, and go after the redraw.
- **Type from a script**: `facade type <agent> "<text>" [--enter]` pastes text; `facade type <agent> --key Esc --key
  Enter` presses keys.
- **Read**: `facade screen [-n <lines>] <agent>` prints the last lines of the screen and its scrollback.
- **Colors**: an agent in an editor window replies to its CLI's color queries (OSC 10, 11 and 12) with the colors the
  window's terminals draw with, so a CLI that picks its colors by the background suits the editor's theme.

## Messages

- **Send**: `facade send <to> "<text>" [--reply-to <mN>]`, or the `send_message` tool. In an agent's terminal, the
  message comes from that agent; elsewhere, from the person. Every message gets the next `#mN`.
- **Delivery**: the recipient's typist waits until its input box is empty, pastes the message under a header that names
  its sender and number, such as `📨 Message from Ada (#a1) · #m5`, and presses Enter. It never types over a draft. The
  send responds within 30 seconds with what happened: typed, read, or failed and why.
- **Withdrawal**: a message that could not be typed within its 30 seconds, none of it typed, goes back out of the
  inbox, so that its sender can simply send it again. An agent's first prompt stays in its inbox even then. Cancelling
  a send also withdraws its message while the paste has not begun.
- **Inbox**: `facade messages` in an agent's terminal, or the `read_messages` tool, reads the messages waiting for that
  agent and so delivers them.
- **To the person**: a message to `human` from an agent goes to each of the agent's editor windows that shows Facade
  messages, and the command reports each window. If an agent is also named human, quote `'#human'` for the human or use the agent's ID. The command line
  says 'the human' for the person using Facade. The ID is `human`. Message headers show it as `#human`.
- **Kept**: messages and their deliveries are kept 30 days, across daemon restarts. A delivery under way goes on after a
  restart, within its 30 seconds. A send that repeats its request ID gets the first send's response, and nothing is sent
  again.

See [Agent messages](../../core/protocol/PROTOCOL.md#agent-messages) and section 1 of the
[shared rules](../extension/RULES.md).

## Facade's tools

Every CLI that runs by a built-in's rule gets Facade's MCP server for its run, `facade-mcp`, with a skill that explains
it. It has eight tools:

| Tool | What it does |
| --- | --- |
| `list_agents` | Lists the windows, their folders and CLIs, and the agents in reach |
| `start_agent` | Starts an agent: a CLI in a folder of a window, in a new worktree if asked, with a first prompt if given |
| `stop_agent` | Stops an agent's CLI; the agents it started keep running |
| `send_message` | Sends one message to an agent or to `#human`, and responds with its delivery |
| `read_messages` | Reads the caller's own inbox |
| `read_screen` | Reads the text on an agent's terminal |
| `type_text` | Types text into an agent's terminal |
| `press_keys` | Presses keys in an agent's terminal |

Each tool responds `{status, data}` when it succeeds and `{status, reason, message}` when it fails. Golden files in the
scenario tests hold every tool's responses. An agent's record says whether its CLI can use the tools (`tools_state`).
The [MCP contract](../extension/engineering/MCP.md) gives every tool's arguments and responses.

## YOLO and reach

- **YOLO**: each start or resume reads `yolo` from the settings file, and keeps it for its run. With YOLO on, the
  default, the CLI runs without asking: approvals bypassed, sandbox off, the folder trusted. With YOLO off, the CLI asks
  as it natively does.
- **Reach**: an agent whose run has YOLO on reaches every agent. With YOLO off, it reaches its creation tree, the agents
  with its root. The person reaches every agent. A start can go anywhere, and the new agent joins its starter's tree.
- **Across machines**: the machine that holds the target checks the caller, as its first machine filled it in. A tree
  spans machines, and an agent with YOLO on reaches the agents of every machine it has a route to. A new agent's YOLO
  comes from the settings file of the machine it runs on. Only the person adds, connects, removes or renames machines.

See [YOLO and creation trees](../../core/protocol/PROTOCOL.md#yolo-and-creation-trees).

## Windows and folders

- Every agent is in one or more windows. The person's start from an editor window puts it in that window, and from a
  terminal in the terminal window, `terminal`. An agent's start puts the new agent in every window its starter is in,
  connected or not, or in the one window it names. Go to Agent adds windows; an agent stays in a window once it is
  there.
- Where an agent runs is apart from its windows: its folder, and the window that gave the folder, its location source,
  where one did.
- Go to Agent in an editor window adopts an agent of this machine that is running, is not a guest and is not in this
  window yet: the window joins its windows, and every member editor window shows the same process.
- An editor window's locations are its folders and every worktree of their repositories. A start that names a location
  source window must use one of that window's locations or a folder inside one, and can make a new worktree from one
  of its locations; a start without one runs in the folder it gives, or makes a worktree from that folder's repository
  and runs there.
- An editor window describes its terminals' environment, and core lists the CLIs a start there can run, each found on
  that environment's `PATH` or not, and whether a built-in is not installed.
- When an editor window's last connection closes, as when it is closed or reloaded, its agents go on running and the
  window is listed as not connected. A reload gets its window back while that window is still bound to it: another
  editor may have taken the window meanwhile. A window is kept once made, since an agent on another machine may name
  it. Reopening a workspace takes back its earliest window that no editor holds, or else gets a new one; a second
  editor window of the same workspace gets a window of its own.
- A message to the person is handed to the current `messages` watch of each connected window the sending agent is in;
  a watch that takes it counts as delivered, and the send says which windows took it and why the others did not. When
  no window can take it, the send fails and keeps nothing.
- An agent answers its CLI's color queries with the colors of the member editor window that resized it last; a resize
  to the same size counts, and a terminal's `attach` changes only the size. Before any resize, the colors are those of
  the window it was started from, its starter's, or a member editor window that has colors.
- Each Facade home has a machine ID, made once and kept in its store.

See [Editor windows](../../core/protocol/PROTOCOL.md#editor-windows).

## Machines

- Each Facade home is a machine, with an ID made once and a name made once from the host name: the part before the
  first dot, lowercase, with every other character than `a-z`, `0-9` and `-` made `-`, runs of `-` made one, and `-`
  at either end dropped; an empty result is `machine`. Names may repeat;
  `facade machine rename <machine> <name>` renames a machine from any machine with a route to it.
- `facade machine add <DESTINATION> [--home <PATH>]` connects this machine with another and keeps the connection:
  the daemon reconnects every 10 seconds, and a computer that restarted connects back the next time Facade runs. The
  first connection, and any repair, runs in the terminal, where SSH asks for passwords, MFA and host keys; running add
  again for a saved machine repairs it. `facade machine connect` stays connected only while the command runs. No port
  is opened: SSH runs `facade machine serve` on the other machine. Once connected, both machines find each other's
  agents.
- A saved connection that needs a person stops retrying; `facade machine list` shows `needs SSH login` and a
  `warning:` with the command that repairs it. A failed connection says why: SSH's own error, `facade` not found
  there, a startup file that writes to standard output, versions that do not match, or two homes with one machine ID
  (a copied home: give the copy a new empty home).
- A connection that succeeds warns when the other machine is Linux and systemd will end that login's processes when
  SSH ends (`KillUserProcesses` or `KillOnlyUsers` applying to the user): an administrator lists the user in
  `KillExcludeUsers` there. Facade changes no system settings.
- The first connection to a machine says what it trusts: agents with YOLO on, on any machine with a route to this one,
  can operate this machine's agents.
- `facade machine list` shows a table of the machines this one connects to and those it saved but cannot connect to
  now: name, ID, version, route and the SSH connection saved here; `--json` adds every connection and its state;
  `facade machine remove <machine>` removes a saved connection only.
- Calls go through other machines when no direct connection exists, by the route that passes the fewest machines.
  When a connection ends, only the routes through it go, and a machine is unreachable only when no route is left.
- An agent's address names its machine: `#a17@gpu`, or `#a17@id:3f9a2c1d` when names repeat; a message's is `#m42@gpu`.
  Numbers without a machine mean this machine. A name alone, `@Pixel`, is looked up on every machine with a route from
  here and every saved one, and only a single match among machines that all answered is used; otherwise the call says
  which machines did not answer, or lists every match. `@Pixel@gpu` asks gpu only; when an agent here is literally named
  `Pixel@gpu`, that meaning counts too, and finding both is an error that lists them.
- `facade list` and `list_agents` ask every machine at once and answer when all have, or after 3 seconds, saying of
  each machine whether it answered, is unreachable, timed out or failed.
- `facade start --machine <MACHINE> [--cwd <PATH>]` and New Agent's machine step start an agent on another machine, in
  that machine's login environment, in the folder given or else that machine's user's home folder; with
  `start_agent`, `machine` names the machine and `path` must be an absolute path on it. Send,
  screen, type, keys, stop, resume and `attach` work on agents of other machines. A remote `attach` pauses input when
  the connection drops, and shows the screen again before it takes keys when it returns.
- A message to an agent is kept, and numbered, on its recipient's machine; a sender on another machine is named with
  `on <machine>`. A message to the person is kept on the sending agent's machine under one number and handed to the
  windows the agent is in, on every machine; one window that took it is enough. A call that never
  left says it was not run; one that left without an answer says its outcome is unknown. Nothing is kept to send later.
- An editor window shows the agents of other machines that are in it, with a remote icon where the Pin would be; when
  Facade cannot connect to their machine they stay, marked disconnected.
- A Remote-SSH window connects this computer's Facade with the remote one by itself, through a bridge over the
  editor's existing connection: no second SSH login and no open port. Reloading or closing one window leaves another's connection alone.

See [Machine sessions](../../core/protocol/PROTOCOL.md#machine-sessions).

## Guests

- **Sessions you start yourself**: `facade integration add <cli>` writes Facade's entries into that CLI's user
  settings: Facade's MCP server, the approval of its own tools, and the hooks that report each session. Every
  session you then start with that CLI joins as a guest: it gets an ID, shows in `facade list` and takes its
  messages at its next turn. `facade integration remove <cli>` takes the entries out, and a file nothing else changed
  goes back byte for byte. `facade integration list` shows what is written. It works for `claude`, `codex`, `opencode`,
  `pi`, `muse` and `agy`.
- **Any MCP client**: an MCP client that Facade did not start joins with one line in its MCP settings, Facade's relay
  as its server:

  ```json
  {"mcpServers": {"facade": {"command": "/Users/you/.facade/core/bin/facade-mcp"}}}
  ```

  The path is `core/bin/facade-mcp` in your Facade home, where Facade installs it the first time it runs; write it out
  in full where the client does not expand `~`. For a home other than `~/.facade`, add
  `"env": {"FACADE_HOME": "/path/to/home"}`. When the client sends `initialize`, it joins as a guest with its own `#aN`,
  an inbox and all eight tools, and reads its messages with `read_messages`. It stays listed while its relay is
  connected, and keeps its number and inbox across a daemon restart. If Facade is not running, the relay starts it.

See [Guests](../../core/protocol/PROTOCOL.md#guests) and [Integrations](../../core/protocol/PROTOCOL.md#integrations).

## The settings file

`facade.json` in the Facade home holds `yolo`, `names`, and `clis`, the CLI entries: program, arguments, environment,
model, effort, and whether each is enabled. A file that cannot be read stops every start and resume, with a message
naming each problem and where it is. See [Configuration](../extension/features/CONFIGURATION.md).

## Restarts and new builds

- **Nothing runs at login.** A command starts the keeper, and the keeper starts the daemon. The daemon exits 5 seconds
  after it has no running agent, client or unfinished work, and the keeper exits with it.
- **Either service can restart.** The keeper holds every CLI's terminal, so when the daemon ends, the keeper starts
  another, which takes the agents back with their screens. When the keeper ends, the daemon keeps every terminal and
  starts another keeper. The CLIs run on throughout.
- **A newer build takes over** while agents run: a `facade` command of a newer build asks the running daemon to hand
  over. Every client gets `closing` and reconnects, and the new daemon serves the same agents.
- **Screens survive a crash.** Each agent's screen is logged on disk, up to 64 MiB, with checkpoints. In memory, each
  agent keeps 10,000 rows of scrollback in at most 2 MiB.

See [Disconnections and recovery](../../core/protocol/PROTOCOL.md#disconnections-and-recovery).

## Diagnostics

- `facade --help` groups the commands. Use `facade <command> --help` for the options and examples of one command.
- `facade status` makes one connection attempt. It shows the Facade home and, when the daemon responds, this
  command's version, the services' process IDs and the agent count. Services using a different build show it beside
  their PID. Status leaves the running services as it finds them.
- `facade version` and `facade --version` show the version of the command.
- `facade completion <shell>` prints completion for Bash, Zsh, Fish or PowerShell. See
  [Shell completion](../../core/README.md#shell-completion) for setup.
- The logs are `core/logs/daemon.log` and `keeper.log` in the Facade home. The daemon's log is also the agents' log:
  which agents started and ended, and who sent whom a message. It is kept 30 days.
- The person's clients, such as the editor, can read the daemon log's last lines, up to 200, with the protocol's
  `daemon.log`. A client that acts for an agent cannot.
- `list`, `inspect`, `status`, `version`, `machine list` and each `integration` subcommand accept `--json`. Data goes
  to stdout and diagnostics go to stderr. CLI failures return 1, while usage errors return 2.
