# Facade Code Framework

Facade Code Framework runs AI coding CLIs, such as Claude Code and Codex, as agents. It starts each CLI in a terminal it keeps,
reads what the CLI shows, types into it, delivers messages between agents, and gives every CLI Facade's tools over MCP.
Clients, such as the `facade` commands and an editor, use it through a local socket, a named pipe on Windows.

This folder is a Rust workspace. It builds two programs:

- `facade`: the commands a person runs, the hooks a CLI runs, and two services. The keeper (`facade keeper`) is the
  parent of every CLI. The daemon (`facade daemon`) keeps the agents and serves clients.
- `facade-mcp`: the relay a CLI runs as Facade's MCP server. It passes each MCP line between the CLI and the daemon.

## Build and test

From the repository root:

```sh
cd framework
cargo build              # target/debug/: facade, facade-mcp, facade-fakecli, facade-stress
cargo test --workspace
```

`rust-toolchain.toml` pins the toolchain. The scenario tests in `tests/` run the built programs in temporary Facade
homes and drive `facade-fakecli`, a test CLI with an input box. To run every test in a temporary folder of its own,
with the home folder there too, then report anything a test wrote to the home folder and any process the run left
behind:

```sh
scripts/test-all.sh        # on Windows, from PowerShell: scripts\test-all.ps1
```

The stress test is a program of its own, not part of `cargo test`:

```sh
CARGO_PROFILE_RELEASE_DEBUG_ASSERTIONS=true cargo run --release -p facade-scenarios --bin facade-stress
```

Framework builds for macOS and for Linux, each on x64 and arm64, and for Windows 11 or Windows Server 2022 and later on x64
and Windows 11 on arm64. Linux needs kernel 5.3 or newer, with process descriptors (`pidfd_open`) allowed. An agent
keeps running when the SSH login that started it ends, except where systemd ends a login's processes when it ends
(`KillUserProcesses=yes`, or `KillOnlyUsers` naming that user), which linger does not prevent: there, an administrator lists the user in
`KillExcludeUsers`. Facade changes no system settings; `facade machine add` and `connect` say when it applies. Windows builds with the MSVC toolchain, and every
Windows build carries the ConPTY package's files for its architecture, from [vendor/conpty](vendor/conpty/), which the
build copies beside the programs.

## Try it in a temporary Facade home

`FACADE_HOME` picks a Facade home: its own services, agents, agent numbers and logs. Without it, the home is
`~/.facade`. These steps use a temporary home and the test CLI, so they touch no real CLI account or session.

Run them from `framework/` after `cargo build`, in a terminal that is not an agent's. In an agent's terminal, `facade` acts
for that agent, which a new home does not list; `unset FACADE_AGENT` first.

```sh
export FACADE_HOME=$(mktemp -d)
export PATH="$PWD/target/debug:$PATH"
facade --help
facade start --help
facade start fake                          # Ctrl-] detaches and leaves the agent running
facade start -d --name two fake            # starts in the background and prints the name and reference
facade list
facade type two "hello" --enter
facade send two "a message"                # confirms the message was saved to the inbox
facade screen -n 20 two
facade status two                          # state, working directory and launch details
facade stop two                            # ends the CLI and keeps the agent record for 30 days
```

`fake` is the test CLI's rule. Only builds with debug assertions, such as `cargo build`'s, have it. A CLI's rule tells
Facade how to start the CLI, read its input box and resume its session. The test CLI reports the session that
`FAKECLI_SESSION` names, so this agent can resume:

```sh
FAKECLI_SESSION=86da4482-2bae-4a45-b193-a5664c19826a facade start -d --name three fake
facade status three
```

Once `status` shows the session ID, stop and resume the agent:

```sh
facade stop three
facade resume -d three                    # continues the session and prints the same agent reference
```

Use an agent's name, a bare ID such as `a2`, or its full reference from the list, such as `a2@laptop`.

`facade status` shows the Facade home and, when it responds, this command's version, the running services and the
agent count. A service using a different build shows its build beside its PID. Status makes one connection attempt
without starting or upgrading Facade. The logs are in `$FACADE_HOME/framework/logs/`. `facade --version` prints the
command's version locally.

To clean up this temporary home, stop all running managed agents and wait for the daemon's socket to close before
deleting the folder. The daemon exits 30 seconds after it has no running agent, client or unfinished work. The
keeper exits with it.

```sh
facade stop --all
socket=/tmp/facade-framework-$(id -u)/daemon-$(printf %s "$FACADE_HOME" | shasum -a 256 | cut -c1-10).sock
while [ -e "$socket" ]; do sleep 0.2; done
rm -rf "${FACADE_HOME:?}"
```

On Windows, run the same commands in PowerShell with a temporary home:

```powershell
$env:FACADE_HOME = Join-Path ([IO.Path]::GetTempPath()) "facade-try-$(Get-Random)"
$env:PATH = "$PWD\target\debug;$env:PATH"
facade --help
facade start --help
facade start fake                          # Ctrl-] detaches and leaves the agent running
facade start -d --name two fake
facade list
facade type two "hello" --enter
facade send two "a message"
facade screen -n 20 two
facade status two
facade stop two
$env:FAKECLI_SESSION = '86da4482-2bae-4a45-b193-a5664c19826a'
facade start -d --name three fake
Remove-Item Env:FAKECLI_SESSION
facade status three                       # check for the session ID before stopping
```

Once the session ID appears:

```powershell
facade stop three
facade resume -d three
```

To clean up the temporary home, stop all running managed agents and wait for the keeper's named pipe to close
before deleting the folder:

```powershell
facade stop --all
$sha = [Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($env:FACADE_HOME))
$pipe = "\\.\pipe\facade-framework-keeper-" + (-join ($sha[0..4] | ForEach-Object { $_.ToString('x2') }))
while ([IO.Directory]::GetFiles('\\.\pipe\') -contains $pipe) { Start-Sleep -Milliseconds 200 }
Remove-Item -LiteralPath $env:FACADE_HOME -Recurse -Force
```

## What is in this folder

| Folder | Crate | What it is |
| --- | --- | --- |
| `crates/base` | `facade-base` | What every part shares: both protocols and their framing, the daemon client, what Facade asks of the operating system, the settings file, and the texts a model reads |
| `crates/screen` | `facade-screen` | A headless terminal for one agent: its screen and scrollback, replies to terminal queries, and full redraws |
| `crates/rules` | `facade-rules` | What Facade knows of each CLI: how it starts and resumes, where its input box is, what its screen says of its state, its session files, and Facade's way into it |
| `crates/keeper` | `facade-keeper` | `facade keeper`: the parent of every CLI. It holds each terminal so the terminal outlives a daemon, and keeps a daemon running |
| `crates/relay` | `facade-relay` | `facade-mcp`: passes each MCP line between a CLI and the daemon |
| `crates/daemon` | `facade-daemon` | `facade daemon`: the agents, their screens, state and messages, windows and guests, the store, and the protocol server |
| `crates/facade` | `facade` | The `facade` program: its commands, `attach`, the hooks, and the entry points of both services |
| `tests` | `facade-scenarios` | Scenario tests, the test CLI `facade-fakecli`, and the stress test `facade-stress` |
| `vendor/alacritty_terminal` | `alacritty_terminal` | The terminal emulator, with the changes [vendor/README.md](vendor/README.md) lists |
| `vendor/conpty` | — | Microsoft's ConPTY package for Windows, `conpty.dll` and `OpenConsole.exe`, which every Windows build carries |
| `protocol` | — | The daemon and keeper protocols, generated from `crates/base` by its test `protocol_files.rs`: do not edit |
| `rules` | — | One rule file for each CLI |
| `scripts` | — | The full test run, the check for leftover processes, the check of each commit, and the check that agents outlive an SSH login |

The crates depend in one direction: base and screen, then rules, then keeper and daemon, then facade. The relay depends
on no other Facade crate.

## Read next

- [Architecture](../docs/framework/ARCHITECTURE.md): the processes and threads, how they talk, and how the code is split
  into islands.
- [Islands](../docs/framework/islands/): each crate's design, from the crate down to its smallest part.
- [Features](../docs/framework/FEATURES.md): what the Framework supports and how to use it.
- [Glossary](../docs/framework/GLOSSARY.md): one word for each thing.
- [Engineering](../docs/framework/ENGINEERING.md): how a team of agents builds the Framework.
- [Daemon protocol](protocol/PROTOCOL.md), [keeper protocol](protocol/KEEPER.md) and
  [Facade's MCP tools](../docs/extension/engineering/MCP.md).
