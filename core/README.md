# Facade core

Facade core runs AI coding CLIs, such as Claude Code and Codex, as agents. It starts each CLI in a terminal it keeps,
reads what the CLI shows, types into it, delivers messages between agents, and gives every CLI Facade's tools over MCP.
Clients, such as the `facade` commands and an editor, use it through a local socket.

This folder is a Rust workspace. It builds two programs:

- `facade`: the commands a person runs, the hooks a CLI runs, and two services. The keeper (`facade keeper`) is the
  parent of every CLI. The daemon (`facade daemon`) keeps the agents and serves clients.
- `facade-mcp`: the relay a CLI runs as Facade's MCP server. It passes each MCP line between the CLI and the daemon.

## Build and test

From the repository root:

```sh
cd core
cargo build              # target/debug/: facade, facade-mcp, facade-fakecli, facade-stress
cargo test --workspace
```

`rust-toolchain.toml` pins the toolchain. The scenario tests in `tests/` run the built programs in temporary Facade
homes and drive `facade-fakecli`, a test CLI with an input box. To run every test in a temporary folder of its own,
with the home folder there too, then report anything a test wrote to the home folder and any process the run left
behind:

```sh
scripts/test-all.sh
```

The stress test is a program of its own, not part of `cargo test`:

```sh
CARGO_PROFILE_RELEASE_DEBUG_ASSERTIONS=true cargo run --release -p facade-scenarios --bin facade-stress
```

Core builds for macOS and Linux. Linux needs kernel 5.3 or newer, with process descriptors (`pidfd_open`) allowed.
An agent keeps running when the SSH login that started it ends, except where systemd ends a user's processes at
logout (`KillUserProcesses=yes`): there, run `loginctl enable-linger` first.

## Try it in a temporary Facade home

`FACADE_HOME` picks a Facade home: its own services, agents, agent numbers and logs. Without it, the home is
`~/.facade`. These steps use a temporary home and the test CLI, so they touch no real CLI account or session.

Run them from `core/` after `cargo build`, in a terminal that is not an agent's. In an agent's terminal, `facade` acts
for that agent, which a new home does not list; `unset FACADE_AGENT` first.

```sh
export FACADE_HOME=$(mktemp -d)
export PATH="$PWD/target/debug:$PATH"
facade start fake                          # shows the agent here; Ctrl-] detaches and it keeps running
facade start --name two fake </dev/null    # starts in the background and prints "#a2 pid …"
facade list
facade type two "hello" --enter
facade send two "a message"                # typed once its input is empty; prints how it went
facade screen two --lines 20
facade inspect two                         # its rule, state, tools, input as its screen shows it, session
facade stop two                            # ends it; its record stays
facade remove two
```

`fake` is the test CLI's rule. Only builds with debug assertions, such as `cargo build`'s, have it. A CLI's rule tells
Facade how to start the CLI, read its input box and resume its session. The test CLI reports the session that
`FAKECLI_SESSION` names, so this agent can resume:

```sh
FAKECLI_SESSION=86da4482-2bae-4a45-b193-a5664c19826a facade start --name three fake </dev/null
facade stop three
facade resume three        # the same agent, a new run of its CLI, continuing its session
```

The logs are `$FACADE_HOME/core/logs/daemon.log` and `keeper.log`. `facade status` shows both services' process IDs,
and starts them when they are not running.

To clean up, remove every agent. The daemon exits 5 seconds after it has no running agent, client or unfinished work,
and the keeper exits with it. The daemon's socket goes when it exits. Then delete the home:

```sh
for agent in $(facade list --json | sed -n 's/^ *"agent_id": "\(.*\)",$/\1/p'); do facade remove "$agent"; done
socket=/tmp/facade-core-$(id -u)/daemon-$(printf %s "$FACADE_HOME" | shasum -a 256 | cut -c1-10).sock
while [ -e "$socket" ]; do sleep 0.2; done
rm -rf "$FACADE_HOME"
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
