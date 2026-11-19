# Features

Facade core supplies the Orchestrator and its Shell and MCP entry points. The VS Code extension's Rust engine uses
the same Orchestrator. The [product description](../facade-code.md) defines the user experience. The
[daemon protocol](../../core/protocol/PROTOCOL.md) and [MCP contract](../extension/engineering/MCP.md) define the
operations and their results.

Core supports macOS and Linux on x64 and arm64, Windows 11 and Windows Server 2022 or later on x64, and Windows 11 on
arm64. On Windows it uses native pseudo consoles.

## Agents

A managed agent runs a CLI in a terminal the Orchestrator holds. A Guest is an external MCP client's connection and
gets a name and inbox when it first calls a tool. From that point it can receive messages and appear in `list`.

- `facade start [OPTIONS] <CLI> [ARGS]...` starts a built-in CLI or one the settings file adds. Put Facade options
  such as `--machine`, `--folder`, `--worktree`, `--name`, `--prompt`, `--model` and `--effort` before the CLI name.
  Words after the name are the CLI's arguments. Use `-d` to start in the background and receive the address.
  An interactive foreground start attaches to the terminal.
- `facade list` and `facade ls` show running managed agents and connected Guests, newest start or resume first.
  `-q` prints one complete address per line. `--json` includes machine results. `--machine` queries one machine
  and wakes it if needed.
- `facade inspect` shows the agent's address, type, state, machine, CLI, folder, launch options, session, who
  started it, viewers and YOLO setting. Use `--json` for the same facts in a script.
- `facade stop` ends a managed agent and keeps its record, screen and inbox for 30 days. Its helpers keep running.
  `facade remove` or `facade rm` stops a running agent before deleting the record, screen and inbox. Both commands
  accept several references and report individual failures. Git owns the worktree.
- `facade resume` lists stopped agents with sessions and sessions the CLI saved in the chosen folder. `--machine`
  and `--folder` select a location. `--all` shows stopped agents across reachable, awake machines. The list gives
  arguments for `facade resume <REFERENCE>`.
- Resuming attaches in the foreground and keeps the agent's address, folder, session and effective launch options.
  The machine supplies its current YOLO setting. A `<cli>:<session>` reference starts a new agent from a session
  when it is available. A session already in use produces the address of the agent using it. Use `-d` to resume in
  the background.
- `facade rename` updates a managed agent's or Guest's name. A blank name lets the Orchestrator choose one from the
  machine's name pool.

Agent numbers are local to a Facade home and keep their identity after a rename. A command can take a name, a bare
number such as `a3`, or an address such as `a3@devbox`. An unqualified reference searches awake and reachable
machines for agents the caller can use. Multiple matches report their complete addresses. For a qualified reference,
the machine selector can be a name or an ID and may cause that machine to wake.

## Terminals

- `facade attach a3@devbox` opens a running managed agent's terminal. Ctrl-] detaches with exit code 0 and leaves
  the agent running. While attached, a CLI exit returns that CLI's exit code.
- `facade screen [-n <lines>] [--json] <agent>` reads the last lines of the screen and scrollback. It also reads the
  last screen of a stopped agent.
- `facade type <agent> "<text>" [--enter]` types text. Use `--key Esc --key Enter` to press keys in order.
  `facade type --help` lists the key names.
- Viewers share the terminal's current size. The most recent resize wins, including when a viewer attaches. VS Code
  can provide terminal colors with the resize. Shell uses its terminal size and leaves the current colors in place.
- After a lost connection, Attach shows the recovered screen and the amount of input discarded before resuming
  input. `facade inspect` shows the viewers currently attached.

## Messages and tools

`facade send <to> "<text>"` sends as the command line. Managed agents and Guests use `send_message` with their own
identity. The recipient's machine assigns each message a number such as `m17`. Across machines, use its complete
address, such as `m17@devbox`. Use `reply_to` when replying to the sender of an inbox message.

For a managed agent, the Orchestrator waits for an empty input box, pastes the message and presses Enter. A Guest
takes messages with `read_messages`. Both kinds of delivery have a 30-second deadline. An undelivered message is
withdrawn and the sender gets the reason. The Orchestrator applies the same rule to a first prompt and to its results
(🔔). It retains message history for 30 days.

| MCP tool | What it does |
| --- | --- |
| `list_agents` | Lists the same running agents and connected Guests as Shell, within the caller's reach |
| `start_agent` | Starts a CLI with the same machine, folder, worktree, model, effort and first prompt options |
| `stop_agent` | Stops one managed agent while its helpers keep running |
| `send_message` | Sends one text message and reports its delivery with the complete message address |
| `read_messages` | Reads the caller's inbox and can wait for a specific reply |
| `read_screen` | Reads the text on a managed agent's terminal |
| `type_text` | Types text into a running managed agent's terminal |
| `press_keys` | Presses keys in a running managed agent's terminal |

An external app can register the `facade-mcp` program as a stdio server. For an app that uses `mcpServers`, the
local configuration looks like this.

```json
{"mcpServers": {"facade": {"command": "facade-mcp"}}}
```

Pass `FACADE_HOME` in that server's environment to use a different home. A Guest sends first, then uses the
`next` call returned by `send_message` to read the reply. That call sets `wait` and the complete message address
in `reply_to`. A read with `wait` can wait up to 30 seconds. Use `after` and `last` for pages of inbox messages.
Tool results include the requested content directly. See the [MCP contract](../extension/engineering/MCP.md).

## Access and settings

`facade.json` in the Facade home holds YOLO, the name pool and CLI entries. Each managed agent reads its machine's
settings at start or resume. A Guest reads YOLO from its machine's settings and appears in `list` at its first MCP
tool call. With YOLO on, an agent can reach any agent the Orchestrator can reach. With YOLO off, it can act within
its creation tree. Shell and VS Code have full reach for the actions they offer. Each CLI's rules describe how it
handles tool approval, trust and sandbox settings. See the [product description](../facade-code.md) and
[configuration](../extension/features/CONFIGURATION.md).

## Folders and machines

- A start on this machine uses the caller's folder and environment. If no caller folder applies, the running machine
  uses its login home. A start on another machine uses that machine's login environment.
- `--worktree <BRANCH>` creates a worktree beside the repository from its current `HEAD`. The branch and path must
  be available. In VS Code, the local location picker shows workspace folders and worktrees. The picker for another
  machine offers its login home, recent folders and manual path entry.
- `facade machine add [--home <PATH>] <SSH ARGS>...` connects and saves the SSH arguments. For example, use
  `facade machine add -p 2222 aaron@devbox.lan`. `machine connect` uses the same arguments for a foreground
  connection that lasts while the command runs. SSH prompts appear in that command's terminal.
- A saved machine without running work can sleep. An operation that names it wakes it through the saved SSH route.
  An unqualified operation sees the machines that are awake and reachable. The route may run through another machine.
- The SSH connection uses the installed program at its fixed path. It installs or upgrades an older remote copy
  as needed to match the local version. If a newer remote version is already installed, upgrade the local copy.
- `facade machine list` reports machines that are awake, connecting, sleeping, unreachable or needing an SSH login.
  It gives the saved `add` command when a person needs to sign in again. `facade machine rename` gives a machine a
  new name, and `facade machine remove` forgets a saved connection.
- A Remote SSH VS Code window uses the Orchestrator on its extension host machine. Connect other machines through
  `facade machine add` on that host.
- WSL and Dev Containers each act as machines. Inside them, Facade connects directly to the local Orchestrator. To
  connect from another machine, start SSH inside the environment and add it from that machine.

On Linux, systemd settings that end a login's processes can end the services with the SSH login. The connection warns
when `KillUserProcesses` or `KillOnlyUsers` applies. An administrator can configure `KillExcludeUsers` for that user.
See [Machine sessions](../../core/protocol/PROTOCOL.md#machine-sessions).

## Restarts and diagnostics

- The Orchestrator starts on demand. It exits after its idle interval when there are no running agents, local entry
  points or unfinished calls. A forwarded operation keeps it active while the work is in progress.
- The keeper holds the CLI terminals during a daemon restart. The daemon keeps the terminals during a keeper restart.
  A newer build uses the same takeover to keep running CLIs and reconnect clients. For an agent already running
  before an upgrade, the Orchestrator keeps recognizing its MCP connection the old way until that run ends. Later
  starts and resumes use the new way.
- `facade upgrade` runs the published installer for the latest stable version. Its build then takes over the running
  Orchestrator while agents keep running, or says why it cannot.
- `facade status` reports the home, settings file, build, daemon and keeper process IDs, number of active agents and
  connected machines. It can inspect one other machine with `--machine`. When the local Orchestrator is sleeping,
  status says so without starting it.
- The logs are `core/logs/daemon.log` and `core/logs/keeper.log` inside the home. Each service keeps 30 days. VS Code
  can read recent daemon log lines for diagnostics.
- `facade --help` shows the command groups. `facade version` and `facade completion` report the version and generate
  shell completion. See [Shell completion](../../core/README.md#shell-completion).
- Query commands accept `--json`. Output goes to stdout and diagnostics go to stderr. Command failures return 1 and
  usage errors return 2.
