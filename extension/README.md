<div align="center">

<img src="https://raw.githubusercontent.com/y5ez3g/facadecode/main/extension/media/icon.png" alt="Facade Code" width="128">

# Facade Code

**Your coding agents, side by side in VS Code.**

A VS Code extension that runs your native agent CLIs: Claude Code, Codex, Antigravity, Muse Code, OpenCode and Pi, with Qwen Code under development.

[Marketplace](https://marketplace.visualstudio.com/items?itemName=facade.facadecode) ·
[Open VSX](https://open-vsx.org/extension/facade/facadecode) ·
[Specs](https://github.com/y5ez3g/facadecode/tree/main/docs/extension) ·
[Report a Bug](https://github.com/y5ez3g/facadecode/issues)

</div>

Facade Code brings coding agents into the VS Code you already use. Each agent runs your own CLI in its own terminal and has a card in one panel, so you can see what every agent is doing and step in at any time.

- 🤖 **Your own CLIs and accounts.** Each CLI runs in a VS Code terminal with its own sign-in, plans and interactive experience.
- 🗂️ **Every agent in one panel.** Each card shows the agent's name, where it works and a live status dot. Agents keep running when the window reloads.
- 💬 **Agents that talk to each other** *(Under development)*. Agents launch other agents, message each other and you, and inspect and unstick each other when blocked.

> **Preview.** This release covers Claude Code, Codex, Antigravity, Muse Code, OpenCode and Pi with the whole panel. Features marked *Under development* come in later releases.

## Install

Install **Facade Code** from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=facade.facadecode) or [Open VSX](https://open-vsx.org/extension/facade/facadecode). VS Code also installs its **Window Component** as a dependency. It always runs on your computer, also for remote windows, and lets Facade recognize each window after a reload.

Packages are available for macOS (Apple silicon), Linux (x64) and Windows (x64). Other platforms are under development.

**Prerequisites**: Install and sign in to at least one supported CLI where your workspace runs: on your computer for local folders, or on the remote host for Remote - SSH. For OpenCode, use version 2.x (`@opencode/cli`): agents also start with 1.x (`opencode-ai`), but their status dot stays red because 1.x does not report its activity. Git is required if you use worktrees.

**Agents run without approval prompts by default.** With `facade.yolo` on, the default, agents can run commands and change files without asking first. Turn it off to use each CLI's normal approvals and supported sandbox; the change applies to agents you start afterwards. Pi has no approvals or sandbox, so it runs without asking even with `facade.yolo` off. OpenCode's default permissions allow every tool, so it also runs without asking unless you configure its permissions. **Configure Agents...** in the panel's `...` menu opens the settings. Facade also trusts the folder an agent starts in, as you would by accepting the CLI's own trust question.

## Quick Start

1. **Open a folder**: Use **File > Open Folder...** to open your project.

2. **Start an agent**: Click **Facade Code** in the activity bar, then **New Agent...**, and choose an installed CLI. Before you choose, **Change Name...** renames the agent and **Change Working Location...** starts it in another folder, a worktree or a new worktree.

3. **Work with it**: The agent opens in its own editor terminal. Type to it as you would in any terminal.

4. **Add more**: Start more agents the same way. Click a card to show its terminal, or run **Go to Agent...** to search by name, CLI, title, location or ID.

5. **Reload freely**: Run **Developer: Reload Window**. The agents keep running, and their terminals come back.

## Features

### One panel for every agent

- **Cards**: Each card shows the agent's name, where it works and what its CLI reports. The dot is green while the agent is starting or working, yellow when it is idle, waiting for input, permission or sign-in, and red for an error or when its activity is unavailable. See [`PANEL.md`](https://github.com/y5ez3g/facadecode/blob/main/docs/extension/features/PANEL.md).
- **Card actions**: Rename Agent..., Copy Agent Reference, Move Up, Move Down and Close Agent, from each card's context menu.
- **A terminal for each agent**: Every agent runs in its own editor terminal. Closing a running agent's terminal asks first; Cancel keeps the agent running and opens its terminal again. See [`LIFECYCLE.md`](https://github.com/y5ez3g/facadecode/blob/main/docs/extension/features/LIFECYCLE.md).
- **Filter**: Show only the agents in one working location or workspace folder with **Filter by Working Location...** in the panel's title bar, or with **Filter by This Location** or **Filter by This Folder** in a card's context menu. **Clear Filter** shows every agent again; the panel's badge always counts them all.
- **Pin and Resume** *(Under development)*: Pin an agent so its conversation returns when you reopen the window, and resume a saved conversation in its original CLI and folder.
- **Show Agent Launch and Show Agents Log** *(Under development)*: See how an agent was started, and Facade's own log.

### Folders and worktrees

- **Any folder**: Start agents in any folder of a single-folder or multi-root workspace. Ordinary folders, repositories and worktrees work alike. See [`WORKTREES.md`](https://github.com/y5ez3g/facadecode/blob/main/docs/extension/features/WORKTREES.md).
- **New Worktree**: Create a Git worktree while starting an agent, or on its own from the panel's `...` menu.
- **Workspace folders and worktrees**: In **Change Working Location...**, add a folder to the workspace, remove one (its files stay on disk), or delete a linked worktree that is not a workspace folder and has no uncommitted changes (its branch is kept).

### Agents keep running

- **Reloads and workspace changes**: Agents keep running when the window reloads, when the extension host restarts, when a folder window becomes a multi-root workspace, and after **Save Workspace As...**.
- **Remote - SSH**: Agents run on the remote host, with the CLIs and accounts there. Facade names the environment as VS Code does, for example `SSH: my-server`.
- **Exits**: An agent whose CLI exits normally leaves the panel; one that exits abnormally keeps a red card until you close it.

### A team that works together *(Under development)*

- **Agents launch agents**: An agent can start other agents, in any supported CLI, and give them tasks.
- **Messaging**: Agents send each other messages, report results to whoever started them, and contact you when a decision needs you.
- **Unsticking each other**: An agent can read another agent's terminal, answer prompts and send keystrokes to help a blocked worker continue without interrupting you.
- **Standard MCP**: All of this goes through a standard MCP server.

### More CLIs *(Under development)*

- **Qwen Code and your own CLIs**: Qwen Code as a built-in CLI, and CLIs you add yourself.
- **Per-CLI settings**: Turn a CLI off, and set its launch arguments and environment.

### Languages

The interface is in English, 简体中文, 繁體中文, Português (Brasil), Español, Русский, Deutsch, 日本語, Français, 한국어, Türkçe and Polski.

## Two Ways to Work

| Workflow | **Super Engineer** | **Super Team** *(Under development)* |
|---|---|---|
| **Your role** | Hands-on engineer | Engineering manager |
| **Who you work with** | Several agents, directly | A lead agent, one to one |
| **Who coordinates agents** | You | The lead agent |
| **Best for** | Work that needs close guidance: exploration, design decisions you want to judge yourself, changing requirements | Large, well-defined features that split cleanly |

These are ways of using Facade, not modes in the interface, and you can move between them freely. Super Engineer works today: start several agents and direct each one yourself. Super Team needs agents that start and message other agents, which is under development.

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
| `facade.claude.path` | Empty | Path to Claude Code. Leave empty to use `claude` from the terminal environment's PATH. |
| `facade.codex.path` | Empty | Path to Codex. Leave empty to use `codex` from the terminal environment's PATH. |
| `facade.antigravity.path` | Empty | Path to Antigravity. Leave empty to use `agy` from the terminal environment's PATH. |
| `facade.muse.path` | Empty | Path to Muse Code. Leave empty to use `muse` from the terminal environment's PATH. |
| `facade.opencode.path` | Empty | Path to OpenCode. Leave empty to use `opencode` from the terminal environment's PATH. |
| `facade.pi.path` | Empty | Path to Pi. Leave empty to use `pi` from the terminal environment's PATH. |

These are machine settings: for a remote window, set them in the remote host's settings.

## Status and Known Limitations

- **Tested so far**: macOS (Apple silicon) with local folders, and selected Remote - SSH workflows from a macOS client to Linux (x64) and Windows (x64) hosts. Antigravity, Muse Code, OpenCode and Pi have also been started from the panel with Windows (x64) as the local computer, and with the command lines Facade gives them on macOS (Apple silicon); Antigravity and Muse Code on Linux (x64) too. Antigravity on Windows, and OpenCode and Pi on macOS, have each answered one short request.
- **Not yet verified**: a complete walkthrough with Windows or Linux as the local computer, WSL, Dev Containers, other editors compatible with VS Code, the declared minimum VS Code 1.105, complete real conversations with each CLI, many agents in one window, and long-running sessions.
- **Muse Code on Windows**: Muse Code does not report its activity on Windows, so Facade reads it from Muse Code's own screen: working while it shows *esc to interrupt*, ready for input when its input is empty or holds a draft, and waiting at its sign-in screen. While it asks for approval, with `facade.yolo` off, its dot keeps the state it showed before. On Linux it reports as the other CLIs do.
- **First installation in a remote window**: VS Code installs Facade Code on the remote host first and its Window Component on your computer a moment later, so Facade Code may not start and VS Code may report that the Window Component is disabled. Reload the window once (**Developer: Reload Window**); Facade Code then starts normally. Installing **Facade Code Window Component** in a local window first avoids this.
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
editor profile, a temporary Facade root, disposable repositories and a fake program for each built-in CLI, in an official VS Code: set
`VSCODE_EXECUTABLE` to its executable (on macOS the standard `/Applications/Visual Studio Code.app` is used when it is there).
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
