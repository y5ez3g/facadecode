<div align="center">

<img src="https://raw.githubusercontent.com/y5ez3g/facadecode/main/extension/media/icon.png" alt="Facade Code" width="128">

# Facade Code

**Your coding agents, side by side in VS Code.**

A VS Code extension that runs your native agent CLIs: Claude Code and Codex, with Antigravity, Muse Code and Qwen Code under development.

[Marketplace](https://marketplace.visualstudio.com/items?itemName=facade.facadecode) ·
[Open VSX](https://open-vsx.org/extension/facade/facadecode) ·
[Specs](https://github.com/y5ez3g/facadecode/tree/main/docs/extension) ·
[Report a Bug](https://github.com/y5ez3g/facadecode/issues)

</div>

Facade Code brings coding agents into the VS Code you already use. Each agent runs your own CLI in its own terminal and has a card in one panel, so you can see what every agent is doing and step in at any time.

- 🤖 **Your own CLIs and accounts.** Claude Code and Codex run in VS Code terminals with their own sign-in, plans and interactive experience.
- 🗂️ **Every agent in one panel.** Each card shows the agent's name, where it works and a live status dot. Agents keep running when the window reloads.
- 💬 **Agents that talk to each other.** Agents start and stop other agents, message each other and you, and read and type into each other's terminals when one is stuck, across your Facade windows on your computer.

> **Preview.** This release covers Claude Code and Codex, the agent panel and agents that work together. Features marked *Under development* come in later releases.

## Install

Install **Facade Code** from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=facade.facadecode) or [Open VSX](https://open-vsx.org/extension/facade/facadecode). VS Code also installs its **Window Component** with it. It always runs on your computer, even for remote windows, lets Facade recognize each window after a reload and connects your windows.

Packages are available for macOS (Apple silicon), Linux (x64) and Windows (x64). Other platforms are under development.

**Prerequisites**: Install and sign in to Claude Code or Codex where your workspace runs: on your computer for local folders, or on the remote host for Remote - SSH. Git is required if you use worktrees.

**Agents run without approval prompts by default.** With `facade.yolo` on, the default, Claude Code and Codex can run commands and change files without asking first. Turn it off to use each CLI's normal approvals and supported sandbox; the change applies to agents you start afterwards. **Configure Agents...** in the panel's `...` menu opens the settings. Facade also trusts the folder an agent starts in, as you would by accepting the CLI's own trust question. With `facade.yolo` on, agents can also stop, message and type into every agent in your Facade windows.

## Quick Start

1. **Open a folder**: Use **File > Open Folder...** to open your project.

2. **Start an agent**: Click **Facade Code** in the activity bar, then **New Agent...**, and choose Claude Code or Codex. Before you choose, **Change Name...** renames the agent and **Change Working Location...** starts it in another folder, a worktree or a new worktree.

3. **Work with it**: The agent opens in its own editor terminal. Type to it as you would in any terminal.

4. **Add more**: Start more agents the same way. Click a card to show its terminal, or run **Go to Agent...** to search by name, CLI, title, location or ID.

5. **Reload freely**: Run **Developer: Reload Window**. The agents keep running, and their terminals come back.

6. **Let agents work together**: Ask an agent in your own words, for example: "Start a Codex agent to write the tests, and have it message you when it is done."

## Features

### One panel for every agent

- **Cards**: Each card shows the agent's name, where it works and what its CLI reports. The dot is green while the agent is starting or working, yellow when it is idle, waiting for input, permission or sign-in, and red for an error or when its activity is unavailable. See [`PANEL.md`](https://github.com/y5ez3g/facadecode/blob/main/docs/extension/features/PANEL.md).
- **Card actions**: Rename Agent..., Copy Agent Reference, Move Up, Move Down and Close Agent, from each card's context menu.
- **A terminal for each agent**: Every agent runs in its own editor terminal. Closing a running agent's terminal asks first; Cancel keeps the agent running and opens its terminal again. See [`LIFECYCLE.md`](https://github.com/y5ez3g/facadecode/blob/main/docs/extension/features/LIFECYCLE.md).
- **Filter, Pin and Resume** *(Under development)*: Filter the cards, pin an agent so its conversation returns when you reopen the window, and resume a saved conversation in its original CLI and folder.
- **Show Agent Launch and Show Agents Log** *(Under development)*: See how an agent was started, and Facade's own log.

### Folders and worktrees

- **Any folder**: Start agents in any folder of a single-folder or multi-root workspace. Ordinary folders, repositories and worktrees work alike. See [`WORKTREES.md`](https://github.com/y5ez3g/facadecode/blob/main/docs/extension/features/WORKTREES.md).
- **New Worktree**: Create a Git worktree while starting an agent, or on its own from the panel's `...` menu.
- **Workspace folders and worktrees**: In **Change Working Location...**, add a folder to the workspace, remove one (its files stay on disk), or delete a linked worktree that is not a workspace folder and has no uncommitted changes (its branch is kept).

### Agents keep running

- **Reloads and workspace changes**: Agents keep running when the window reloads, when the extension host restarts, when a folder window becomes a multi-root workspace, and after **Save Workspace As...**.
- **Remote - SSH**: Agents run on the remote host, with the CLIs and accounts there. Facade names the environment as VS Code does, for example `SSH: my-server`.
- **Exits**: An agent whose CLI exits normally leaves the panel; one that exits abnormally keeps a red card until you close it.

### A team that works together

- **Agents start agents**: An agent can start other agents, with Claude Code or Codex, in any folder or new worktree of any Facade window on your computer, and give them their first task. Their cards appear without taking your focus, and their hover says who started them. An agent can also stop the agents it can reach.
- **Messages**: Agents send each other messages. Facade pastes the whole message into the other agent's input box and sends it, but waits while there is unsent text there; if it cannot get in within 15 seconds, the sender is told it was not delivered. Agents can also message you: you get a notification in that agent's window with **Open Message** and **Show Agent**.
- **Message History**: **Message History...** in the panel's `...` menu shows the messages of this window's agents, read-only. Messages are kept for 30 days.
- **Unsticking each other**: An agent can read another agent's terminal, type into it and press keys, to answer a prompt or help a stuck agent continue without interrupting you. Unlike messages, this typing does not wait for unsent text.
- **Across windows**: With `facade.yolo` on, an agent reaches every agent in your Facade windows on your computer, local and Remote - SSH alike; with it off, it reaches only its own group: the agent you started and every agent started from it.
- **No approval prompts for Facade itself**: With `facade.yolo` off, each CLI's own commands and file changes still ask for approval, but starting, stopping and messaging agents and the other actions above do not.
- **Standard MCP**: Facade adds these as standard MCP tools when it starts each agent, without changing your CLI settings. For Codex it also puts `.agents/skills/facade/SKILL.md` in the agent's folder while Codex agents run there. Turn all of this off for new agents with `facade.collaboration.enabled` in **Configure Agents...**.

### More CLIs *(Under development)*

- **More built-in CLIs**: Antigravity, Muse Code and Qwen Code, and CLIs you add yourself.
- **Per-CLI settings**: Turn a CLI off, and set its launch arguments and environment.

### Languages

The interface is in English, 简体中文, 繁體中文, Português (Brasil), Español, Русский, Deutsch, 日本語, Français, 한국어, Türkçe and Polski.

## Two Ways to Work

| Workflow | **Super Engineer** | **Super Team** |
|---|---|---|
| **Your role** | Hands-on engineer | Engineering manager |
| **Who you work with** | Several agents, directly | A lead agent, one to one |
| **Who coordinates agents** | You | The lead agent |
| **Best for** | Work that needs close guidance: exploration, design decisions you want to judge yourself, changing requirements | Large, well-defined features that split cleanly |

These are ways of using Facade, not modes in the interface, and you can move between them freely. Super Engineer: start several agents and direct each one yourself. Super Team: ask one lead agent for a large piece of work, and let it start and coordinate the other agents. Facade does not tell a lead when its agents finish: ask the lead to have its agents message it when they are done.

## Why

You keep your editor, your projects, your CLIs and their accounts. Facade takes over the work of managing agents' terminals, without a new process to learn.

Facade runs the infrastructure, the CLIs do the work, and you decide the goals and permissions: what to ask, what to review, and when to commit or publish. Facade supplies no model service, account, billing or hosted compute.

## Works the VS Code Way

- Agents run in VS Code's own editor terminals. The panel uses VS Code's views, menus, Command Palette, settings and keyboard shortcuts.
- An agent runs where its workspace runs, with that environment's CLIs, settings, Git and files. A local CLI never stands in for a missing remote one.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `facade.yolo` | On | Runs agents without approval prompts. Turn off to use each CLI's normal approvals and supported sandbox. Applies to new agents only. |
| `facade.collaboration.enabled` | On | Lets agents start and stop each other, send messages to each other and to you, and read and type in each other's terminals. Applies to new agents only. |
| `facade.collaboration.waitSeconds` | 120 | How many seconds an agent waits for another agent to start or stop. Past that time, the agent gets the result later in a message. |
| `facade.claude.path` | Empty | Path to Claude Code. Leave empty to use `claude` from the terminal environment's PATH. |
| `facade.codex.path` | Empty | Path to Codex. Leave empty to use `codex` from the terminal environment's PATH. |

These are machine settings: for a remote window, set them in the remote host's settings.

## Status and Known Limitations

- **Tested so far**: macOS (Apple silicon) with local folders, and selected Remote - SSH workflows from a macOS client to Linux (x64) and Windows (x64) hosts.
- **Not yet verified**: Windows or Linux as the local computer, WSL, Dev Containers, other editors compatible with VS Code, the declared minimum VS Code 1.105, complete real conversations with each CLI, messages and actions between local and Remote - SSH windows, installing Facade Code in a remote window for the first time, many agents in one window, and long-running sessions.
- **Window Component**: Facade Code needs its Window Component on your computer; VS Code installs it with Facade Code. If it is missing or turned off, the panel says so and offers **Show Window Component**; install or enable it, then reload the window. Agents that are already running keep running.
- **Updating from 0.0.1**: Agents started before the update keep running. They open in their own terminals, without cards, and cannot use the new features.
- **Remote - SSH reconnects**: If VS Code stops reconnecting to an SSH host and asks you to reload the window, reload it once the network is back. The agents keep running on the host, and the reloaded window shows them again.
- **Closing a window**: Facade ends a window's agents five minutes after that window's extension host disconnects and nothing reconnects, for example after you close the window.

## Building from Source

Hand [`extension/AGENTS.md`](https://github.com/y5ez3g/facadecode/blob/main/extension/AGENTS.md) to your agent, and let it build. For contribution guidelines, see [`CONTRIBUTING.md`](https://github.com/y5ez3g/facadecode/blob/main/CONTRIBUTING.md).

<!-- repository-only:start -->

### Working on it

Read [AGENTS.md](AGENTS.md) before changing anything. The [extension's specification](../docs/extension/README.md) defines
the target; [Verification](../docs/extension/engineering/VERIFICATION.md) defines the required evidence.

Use Node 24 (`.nvmrc`). Install the locked dependencies, then compile, build and test, all inside `extension/`:

```sh
npm ci
npm run compile
npm run bundle
npm run package
npm run test:package
npm test
npm run test:integration
```

`npm run test:package` checks the VSIX that `npm run package` makes, so run that first. Integration tests use an isolated
editor profile, a temporary Facade root, disposable repositories and fake Claude Code and Codex programs, in an official VS Code: set
`VSCODE_EXECUTABLE` to its executable (on macOS the standard `/Applications/Visual Studio Code.app` is used when it is there).
On Linux run them under `xvfb-run -a`; on Windows run them in the signed-in desktop session. `npm run test:remote` runs
them over Remote-SSH to the hosts of an SSH configuration; [AGENTS.md](AGENTS.md) lists its variables.
Never use the owner's live windows as test subjects. Use `npm install` when deliberately changing dependencies and retain the
updated lockfile. `npm run watch` rebuilds the bundles as source changes; `npm run compile` also checks types and builds the
unit tests.

The execution bundle is assembled in `build/extension/`, including its native PTY backend for the build machine's
OS/architecture. The local window dependency is assembled in `build/window/` without native code. Packaging produces
both VSIX files under `build/vsix/`. Install the window component on the client and the execution component where the
workspace runs; unpublished test installations supply both packages. Integration tests load both components and use a
separate `build/extension-it/` for execution fixtures. A local build does not establish support on another platform.

<!-- repository-only:end -->

## Feedback

- **Bugs & ideas**: [GitHub Issues](https://github.com/y5ez3g/facadecode/issues).
- **Security vulnerabilities**: Please report privately according to [`SECURITY.md`](https://github.com/y5ez3g/facadecode/blob/main/SECURITY.md).

## License

MIT. See [`LICENSE.txt`](https://github.com/y5ez3g/facadecode/blob/main/extension/LICENSE.txt). Facade Code builds on Visual Studio Code; inherited source and bundled third-party materials retain their own notices in [`ThirdPartyNotices.txt`](https://github.com/y5ez3g/facadecode/blob/main/extension/ThirdPartyNotices.txt).
