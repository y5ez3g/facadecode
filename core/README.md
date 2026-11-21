# Facade core

Facade core supplies the Orchestrator for [Facade Code](../docs/PRODUCT.md). It runs coding CLIs as managed
agents, holds their terminals, delivers messages and serves the tools that agents and Guests use over MCP. Shell,
MCP and the VS Code extension connect over a local socket or a Windows named pipe. Orchestrators communicate over SSH.

This Rust workspace builds two programs.

- `facade`: the commands a person runs, the hooks a CLI runs, and two services. The keeper (`facade keeper`) is the
  parent of every CLI. The daemon (`facade daemon`) keeps the agents and serves clients.
- `facade-mcp` is the stdio server a managed CLI or external MCP client runs. It relays MCP between the client and
  the daemon.

The [installation guide](../README.md) gives the Shell and MCP setup commands. `facade upgrade` checks for a newer
stable version before downloading, and `facade upgrade --version X.Y.Z` runs the installer for an exact release.
The installed build takes over a running Orchestrator when its compatibility checks pass, while agents keep running. The
VS Code extension ships with its own copy of the programs.

## Build and test

From the repository root:

```sh
cd core
cargo build              # target/debug/: facade, facade-mcp, facade-fakecli, facade-stress
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

Core builds for macOS and for Linux, each on x64 and arm64, and for Windows 11 or Windows Server 2022 and later on x64
and Windows 11 on arm64. Linux needs kernel 5.3 or newer, with process descriptors (`pidfd_open`) allowed. An agent
keeps running when the SSH login that started it ends, except where systemd ends a login's processes when it ends
(`KillUserProcesses=yes`, or `KillOnlyUsers` naming that user), which linger does not prevent: there, an administrator lists the user in
`KillExcludeUsers`. Facade changes no system settings; `facade machine add` and `connect` say when it applies. Windows builds with the MSVC toolchain, and every
Windows build carries the ConPTY package's files for its architecture, from [vendor/conpty](vendor/conpty/), which the
build copies beside the programs.

## Try it in a temporary Facade home

Run the examples from `core/` after `cargo build`. They use the test CLI and a new Facade home. The `fake` CLI
entry is available in builds with debug assertions. Set `FACADE_HOME` to choose the home for the services, records
and logs. Commands called from Shell act as the command line, including inside an agent's terminal.

In a new Bash session, set up the temporary home and start the test CLI.

```bash
unset "${!FACADE_@}" "${!CLAUDE_@}"
export FACADE_HOME="$(mktemp -d)"
export PATH="$PWD/target/debug:$PATH"
facade_cmd="$PWD/target/debug/facade"
"$facade_cmd" --help
"$facade_cmd" start -n first fake          # Ctrl+] detaches and leaves the agent running
FAKECLI_SESSION=86da4482-2bae-4a45-b193-a5664c19826a "$facade_cmd" start -d -n two fake
"$facade_cmd" list
"$facade_cmd" send two "a message"
"$facade_cmd" screen -n 20 two
"$facade_cmd" status two
```

Once `status two` shows the session ID, stop the agent, list resumable sessions and resume it.

```bash
"$facade_cmd" stop two
"$facade_cmd" resume
"$facade_cmd" resume -d two
"$facade_cmd" stop first
"$facade_cmd" stop two
"$facade_cmd" status
```

In a new PowerShell session, set up the same isolated home.

```powershell
Get-ChildItem Env: | Where-Object { $_.Name -like "FACADE_*" -or $_.Name -like "CLAUDE_*" } |
    ForEach-Object { Remove-Item -LiteralPath "Env:$($_.Name)" }
$env:FACADE_HOME = (New-Item -ItemType Directory -Path ([IO.Path]::Combine([IO.Path]::GetTempPath(), "facade-try-$([guid]::NewGuid())"))).FullName
$env:PATH = "$(Join-Path $PWD target\debug);$env:PATH"
$facadeCmd = (Resolve-Path -LiteralPath "target\debug\facade.exe").Path
& $facadeCmd --help
& $facadeCmd start -n first fake           # Ctrl+] detaches and leaves the agent running
$env:FAKECLI_SESSION = '86da4482-2bae-4a45-b193-a5664c19826a'
& $facadeCmd start -d -n two fake
Remove-Item Env:FAKECLI_SESSION
& $facadeCmd list
& $facadeCmd send two "a message"
& $facadeCmd screen -n 20 two
& $facadeCmd status two
```

Use the same stop and resume commands once the session ID appears.

```powershell
& $facadeCmd stop two
& $facadeCmd resume
& $facadeCmd resume -d two
& $facadeCmd stop first
& $facadeCmd stop two
& $facadeCmd status
```

Use an agent's name or a reference from `list`, such as `a2@devbox`. `status` shows the selected home, settings file,
service process IDs, active agent count, connected machines and the Guest MCP launcher. When the local Orchestrator
is sleeping, it says so without starting it. The logs are under `core/logs/` in that home. Stop the agents you started
and wait for the temporary Orchestrator to exit before discarding its temporary home.

## What is in this folder

| Folder | Crate | What it is |
| --- | --- | --- |
| `crates/base` | `facade-base` | What every part shares: both protocols and their framing, the daemon client, what Facade asks of the operating system, the settings file, and the texts a model reads |
| `crates/screen` | `facade-screen` | A headless terminal for one agent: its screen and scrollback, replies to terminal queries, and full redraws |
| `crates/rules` | `facade-rules` | What Facade knows of each CLI: how it starts and resumes, where its input box is, what its screen says of its state, its session files, and Facade's way into it |
| `crates/keeper` | `facade-keeper` | `facade keeper`: the parent of every CLI. It holds each terminal so the terminal outlives a daemon, and keeps a daemon running |
| `crates/relay` | `facade-relay` | `facade-mcp`: passes each MCP line between a CLI and the daemon |
| `crates/daemon` | `facade-daemon` | `facade daemon` manages agents, terminals, messages, Guests, SSH routes and the store. It serves the daemon protocol. |
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

- [Architecture](../docs/core/ARCHITECTURE.md): the processes and threads, how they talk, and how the code is split
  into islands.
- [Islands](../docs/core/islands/): each crate's design, from the crate down to its smallest part.
- [Features](../docs/core/FEATURES.md): what core supports and how to use it.
- [Glossary](../docs/core/GLOSSARY.md): one word for each thing.
- [Engineering](../docs/core/ENGINEERING.md): how a team of agents builds core.
- [Daemon protocol](protocol/PROTOCOL.md), [keeper protocol](protocol/KEEPER.md) and
  [Facade's MCP tools](../docs/extension/engineering/MCP.md).
