# Features

Facade core supplies the Orchestrator, its Shell entry point and Facade API v1's MCP entry point. The VS Code
extension's Rust engine uses the same Orchestrator. The [product description](../PRODUCT.md) defines the user
experience. The
[daemon API](../../core/protocol/DAEMON.md) and [MCP contract](../extension/engineering/MCP.md) define the
operations and their results.

Core supports macOS and Linux on x64 and arm64, Windows 11 and Windows Server 2022 or later on x64, and Windows 11 on
arm64. On Windows it uses native pseudo consoles.

## Install the standalone Shell

Use the archive for your operating system and architecture, its installer and `SHA256SUMS` from a
[release](https://github.com/y5ez3g/facadecode/releases) whose notes identify daemon and Keeper API v1.
Keep the checksum file beside the archive. While the matching release is unpublished, build the packages
from your checkout with the steps below. Use the release notes or artifact revision to identify the build
when two candidates report the same version.

| Host | Package | Install from the download directory |
| --- | --- | --- |
| macOS or Linux | `facade-core-darwin-<arch>.tar.gz` or `facade-core-linux-<arch>.tar.gz` | `sh ./install.sh --package /absolute/path/to/archive.tar.gz` |
| Windows | `facade-core-win32-<arch>.zip` | `.\install.ps1 -Package C:\path\to\archive.zip` |

The installers check the package hash and install `facade` and `facade-mcp` together. The default bin directory is
`~/.local/bin` on macOS and Linux and `%LOCALAPPDATA%\Facade\bin` on Windows. Open a new terminal if needed,
then run `facade --version` and `facade status` to confirm the executable and Facade home. If the IDE launcher
uses the same name, invoke the standalone executable by its full path.

The installer keeps one build per version in an install root. If it reports different programs at the same version,
use a distinct version or follow the selected build's replacement instructions. Keep the Facade home when
replacing installed programs.

The [VS Code extension](../../extension/GUIDE.md#install-for-your-workspace-host) ships Core for its workspace host. When using it with Shell,
use compatible builds and the same Facade home. See [compatible takeover and planned restarts](#restarts-and-diagnostics)
before replacing services in a home that already has agents.

### Build matching packages from source

Use Node 24, the pinned Rust toolchain and the target's native C toolchain. The
[packaging requirements](../extension/engineering/ARCHITECTURE.md#43-packaging-and-version-support)
describe the native targets. On Linux, install `musl-tools` and run these commands from `core/` so
the target is added to the pinned toolchain. Keep the compiler setting in the shell you use for packaging.

```sh
rustup target add "$(uname -m)-unknown-linux-musl"
export "CC_$(uname -m)_unknown_linux_musl=musl-gcc"
```

Run the following from `extension/`, substituting the host target and the workspace VSIX filename
printed by packaging. This example uses Windows x64.

```sh
npm ci
npm run package -- --target win32-x64
node ../core/scripts/package-core.mjs --target win32-x64 --vsix build/vsix/facadecode-win32-x64-X.Y.Z.vsix --out-dir build/core
```

Use the VSIX files in `build/vsix/` and the native archive and checksum file in `build/core/`. For Shell,
run the installer from `../core/` with the absolute path to that archive. The source packages are local test
artifacts. See the [editor setup](../../extension/GUIDE.md#install-for-your-workspace-host).

## Agents

A managed agent runs a CLI in a terminal the Orchestrator holds. A Guest is an external MCP client's connection and
gets a name and inbox when it first calls a tool. From that point it can receive messages and appear in `list`.

- `facade start [OPTIONS] <CLI> [CLI_ARGS]...` starts a built-in or configured CLI. Put `--name`, `--machine`,
  `--workdir`, `--worktree` and `-d` before the CLI name. Arguments after that name go to the CLI, including its own
  options for models and prompts. A foreground start opens the terminal. A background start prints the name and
  reference, and the new worktree's path when requested.
- `facade list` shows running managed agents and connected Guests, newest start or resume first. It probes saved
  connections on demand without starting a sleeping daemon. `--local` queries this machine with zero SSH, and
  `--machine <MACHINE>` queries the named machine and wakes it if needed. The `SESSION` column shows the latest
  saved native session name, the session preview when unnamed, or `-` when neither is available.
  Use `facade status <AGENT>` for the full session ID, working directory and attached viewers.
- `facade stop <AGENT>...` ends one or more managed agents and keeps their records, screens and inboxes for 30 days.
  Their helpers keep running. Use `--local`, `--machine <MACHINE>` or `--all` to stop running managed agents in one
  scope. Scope stops skip Guests and probe remote machines without waking them. A partial failure returns 1 after
  stopping the other targets.
- `facade resume` lists resumable agents on reachable machines and CLI sessions in the current directory. `--local`
  lists this machine's candidates with zero SSH. `--machine <MACHINE>` lists the named machine's resumable managed
  agents. The `SESSION` column uses the same native name or preview as `list`. The state is `Ended` for a managed
  agent whose run ended, however it ended, or `Saved` for a session from the CLI's history. Copy a reference from
  the `REF` column to `facade resume <REFERENCE>` in the same directory. A `Saved` row's `REF`, its session selector,
  is the first eight characters of its ID when they match no other session in the CLI histories `facade resume`
  searches in that directory, including sessions that managed agents use, and its full ID otherwise.
- `facade status <AGENT>` shows the same Agent State as `list` while the agent runs, with the reason for
  `Waiting for you` and `Error`. For an ended agent it shows `Ended (stopped by Facade)`, `Ended (code N)`,
  `Ended (signal <SIGNAL>)`, or `Ended` when the way it ended is unknown. Its `Session` line shows the same native
  name or preview as `list`, and `Session ID` the CLI's full session ID.
- Resuming an `Ended` agent keeps its reference, directory and session. Resuming a `Saved` session creates an agent.
  A session already in use produces the reference of the agent using it. Use `-d` to resume in the background.
- `facade rename <AGENT> <NAME>` changes the name of a running or ended agent or connected Guest. The reference
  stays the same.

Agent numbers are local to a Facade home. Commands accept a reference such as `a3@devbox`, an ID such as `a3`, or a
name. For duplicate names, an eligible running agent takes priority over stopped records. Multiple eligible matches
show copyable references. Use the machine name or ID from `facade machine list` to target a specific machine and
wake it when needed.

## Terminals

- `facade attach a3@devbox` opens a running managed agent's terminal. Ctrl+] detaches with exit code 0 and leaves
  the agent running. A CLI exit returns its actual exit status. The attached view uses the terminal app's alternate
  screen, as any full-screen program does. Every end returns to the shell page and scrollback from before the attach
  and prints one receipt; nothing the agent showed stays, including what a CLI prints as it exits. While attached,
  the CLI's own screens, title and mouse mode control the view, and the terminal app keeps no history of the agent's
  output: `facade screen -n <lines> <agent>` reads it. The Facade Code editor labels the terminal with the CLI's
  title while it is attached, and the terminal's own title returns when the attachment ends.
- `facade screen [-n <lines>] <agent>` reads the last lines of the screen and scrollback as text. It also reads the
  last screen of an ended agent.
- `facade type <agent> "hello" -k Enter "again" -k Enter` pastes text and presses keys in the given order.
  Quote each text argument that contains spaces. Facade queues the sequence as one input operation.
  `facade type --help` lists the key names.
- Attach viewers share the smallest open terminal width and height. A larger Shell displays the shared grid in its
  top-left corner and updates rows in place. The shared grid changes as viewers resize or leave. VS Code can provide
  terminal colors.
- After reconnecting, Attach redraws the current screen. It reports discarded input in bytes when any was lost.

## Messages and tools

`facade send <RECIPIENT> <TEXT>` sends as the command line and prints a receipt when Facade saves the message in the
recipient's inbox. Add `-w` to wait for delivery or `-r` to print the first linked reply from the recipient. `-t` sets
the total command budget from 1 to 300 seconds, with a default of 30. Each invocation takes a recipient and text.
When a reply wait expires, the command reports the outcome and exits with status 1.

Managed agents and Guests use `send_message` with their own identity. The recipient's machine assigns each message
an address such as `m17@devbox`. To answer a message, copy the sender address into `to` and the inbox message number
into `reply_to`. A Shell request waiting for a reply has a sender address such as `#c17@devbox`. The original recipient
can send one linked reply while that invocation waits.

For a managed agent, the Orchestrator waits for an empty input box, pastes the message and presses Enter. A Guest
takes messages with `read_messages`. Background delivery has a 30-second deadline. When Shell explicitly waits,
delivery uses the remaining command budget. Facade withdraws undelivered messages at their deadline and retains
message history for 30 days.

| MCP tool | What it does |
| --- | --- |
| `list_agents` | Lists running agents, connected Guests and available CLI names for machines within reach |
| `start_agent` | Starts a CLI with machine, folder, worktree, model, effort and first prompt options |
| `stop_agent` | Stops one managed agent while its helpers keep running |
| `send_message` | Saves one message, with optional waiting for delivery or a linked reply |
| `read_messages` | Reads the caller's inbox, with optional waiting for new messages or a linked reply |
| `read_screen` | Reads the text on a managed agent's terminal |
| `type_text` | Types text into a running managed agent's terminal |
| `press_keys` | Presses keys in a running managed agent's terminal |

An external app can register the `facade-mcp` program as a stdio server. `facade status` shows the fixed launcher
path under `Guest MCP`. In apps that use `mcpServers`, set `mcpServers.facade.command` to that path. For example,
this is the configuration when using `facade-mcp` on PATH.

```json
{"mcpServers": {"facade": {"command": "facade-mcp"}}}
```

Pass `FACADE_HOME` in that server's environment to use a different home. For both message tools, `timeout_seconds`
defaults to 0 and accepts up to 30 seconds. A send with a positive timeout requires `wait_for` set to `delivery`
or `result`. After `reply_timeout`, an agent can call `read_messages` with the original full message address in
`reply_to` and a positive timeout. Read pages with `after` or `last`. Tool results carry complete message text inline.
See the [MCP contract](../extension/engineering/MCP.md#7-mcp-through-the-orchestrator).

## Access and settings

`facade.json` in the Facade home holds YOLO, the name pool and CLI entries. Each managed agent reads its machine's
settings at start or resume. A Guest reads YOLO from its machine's settings and appears in `list` at its first MCP
tool call. With YOLO on, an agent can reach any agent the Orchestrator can reach. With YOLO off, it can act within
its creation tree. Shell and VS Code have full reach for the actions they offer. Each CLI's rules describe how it
handles tool approval, trust and sandbox settings. See the [product description](../PRODUCT.md) and
[configuration](../extension/features/CONFIGURATION.md).

## Folders and machines

- A start on this machine uses the caller's folder and environment. If no caller folder applies, the running machine
  uses its login home. A start on another machine uses that machine's login environment.
- `--worktree <BRANCH>` creates a worktree beside the repository from its current `HEAD`. The branch and path must
  be available. `--workdir` may name the repository root or one of its subdirectories. It can also select an existing
  worktree. In VS Code, the local location picker shows workspace folders and worktrees. The picker for another
  machine offers its login home, recent folders and manual path entry.
- `facade machine add [--home <PATH>] [--bidirectional] <SSH_ARGS>...` connects and saves the verified SSH
  arguments. Facade options come before SSH arguments. If a password login is required, the command installs
  and verifies a dedicated Facade SSH key for reconnects. `--bidirectional` also authorizes, verifies and saves
  a return connection when the remote machine can reach the source address on SSH port 22.
- `facade machine connect [--home <PATH>] <SSH_ARGS>...` opens a two-way connection while the foreground command
  runs. SSH prompts appear in the command's terminal.
- Saved connections are opened on demand. A saved machine without running work can sleep. Explicit operations
  such as a named agent start can wake it through a saved route, including any needed intermediate machines.
- The SSH connection first uses the remote program at its installed path. The daemon API handshake decides
  compatibility, so the builds can have different software versions. A permitted explicit connection can install
  a program on an uninstalled peer through the regular installer. A passive connection uses the installed
  `machine serve --no-start`. It leaves sleeping services idle and reports a missing installation without installing.
- To prepare an SSH machine offline, keep its release archive and `SHA256SUMS` together. Run the installer with
  `--package <ARCHIVE>` on macOS or Linux or `-Package <ARCHIVE>` on Windows before connecting.
- `facade machine list` reads the local machine table with zero SSH. It distinguishes a disconnected saved
  connection, a confirmed sleeping machine, a connection failure and a machine that needs SSH login. Login
  guidance gives the saved `add` command. `facade machine rename` gives a machine a new name.
- `facade machine remove [--bidirectional] <MACHINE>` removes the local saved connection and revokes local
  Facade SSH authorization for the remote machine. The default is offline. `--bidirectional` also tries to
  remove the return connection and revoke Facade authorization on the remote machine. A partial failure
  reports the completed removal and the side that still needs attention.
- A Remote SSH VS Code window uses the Orchestrator on its extension host machine. Connect other machines through
  `facade machine add` on that host.
- WSL and Dev Containers each act as machines. Inside them, Facade connects directly to the local Orchestrator. To
  connect from another machine, start SSH inside the environment and add it from that machine.

On Linux, systemd settings that end a login's processes can end the services with the SSH login. The connection warns
when `KillUserProcesses` or `KillOnlyUsers` applies. An administrator can configure `KillExcludeUsers` for that user.
See [Machine sessions](../../core/protocol/DAEMON.md#machine-sessions).

## Restarts and diagnostics

- The Orchestrator starts on demand and exits after 30 idle seconds. Saved SSH sessions also close after 30 idle
  seconds. A foreground machine connection, an active Attach or a call in progress keeps its session active.
- The keeper holds the CLI terminals during a daemon restart. The daemon keeps the terminals during a keeper restart.
  An API-compatible takeover replaces the daemon. The live keeper retains its CLIs and terminals while clients
  reconnect. See [Daemon takeover](../../core/protocol/DAEMON.md#daemon-takeover) for the compatibility checks.
- If the installed and target builds cannot take over, first complete any pending legacy workspace import in the
  prerelease editor that reads it. Restore pending machine routes there and confirm that local and remote members
  and Pins are saved. Then close the clients, let the agents finish and wait for both services to exit. Switch
  Shell, VS Code and the participating SSH hosts to compatible builds before reconnecting. Reuse the same Facade
  homes and editor profile and workspace storage. Check the builds' [storage compatibility](islands/daemon.md#storage-format-and-migrations).
- `facade upgrade` checks the stable version before downloading the installer. It skips installation when
  already up to date. `facade upgrade --version X.Y.Z` runs the regular installer for the `extension/X.Y.Z` release.
  The installed build takes over a running Orchestrator when its compatibility checks pass, keeping agents running.
- `facade status` reports the local home, settings file, versions, daemon and keeper process IDs, active agent count,
  connected machines and Guest MCP launcher. When the local Orchestrator is sleeping, status says so without
  starting it.
- The logs are `core/logs/daemon.log` and `core/logs/keeper.log` inside the home. Each service keeps 30 days. VS Code
  can read recent daemon log lines for diagnostics.
- `facade` shows the command groups. `facade <COMMAND> --help` shows examples, arguments and options.
  `facade --version` prints the CLI version.
- Query results and completion receipts go to stdout. Empty-result guidance, diagnostics, warnings and progress go
  to stderr. Command failures return 1 and usage errors return 2.
