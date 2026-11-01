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
- 💬 **Agents that talk to each other.** Agents start and stop other agents, message each other and you, and read and type into each other's terminals when one is stuck, across your Facade windows on your computer.

> **Preview.** This release covers Claude Code, Codex, Antigravity, Muse Code, OpenCode and Pi with the whole panel, and agents that work together. Features marked *Under development* come in later releases.

## Install

Install **Facade Code** from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=facade.facadecode) or [Open VSX](https://open-vsx.org/extension/facade/facadecode). VS Code also installs its **Window Component** with it. It always runs on your computer, even for remote windows, lets Facade recognize each window after a reload and connects your windows.

Packages are available for macOS (Apple silicon), Linux (x64) and Windows (x64). Other platforms are under development.

**Prerequisites**: Install and sign in to at least one supported CLI where your workspace runs: on your computer for local folders, or on the remote host for Remote - SSH. For OpenCode, use version 2.x (`@opencode/cli`): agents also start with 1.x (`opencode-ai`), but their status dot stays red because 1.x does not report its activity. Git is required if you use worktrees.

**Agents run without approval prompts by default.** With `facade.yolo` on, the default, agents can run commands and change files without asking first. Turn it off to use each CLI's normal approvals and supported sandbox; the change applies to agents you start afterwards. Pi has no approvals or sandbox, so it runs without asking even with `facade.yolo` off. OpenCode's default permissions allow every tool, so it also runs without asking unless you configure its permissions. **Configure Agents...** in the panel's `...` menu opens the settings. Facade also trusts the folder an agent starts in, as you would by accepting the CLI's own trust question. With `facade.yolo` on, agents can also stop, message and type into every agent in your Facade windows. A custom CLI is the exception to the launch mapping and folder trust: `facade.yolo` does not change how it starts, and Facade gives it no folder trust.

## Quick Start

1. **Open a folder**: Use **File > Open Folder...** to open your project.

2. **Start an agent**: Click **Facade Code** in the activity bar, then **New Agent...**, and choose an installed CLI. Before you choose, **Change Name...** renames the agent and **Change Working Location...** starts it in another folder, a worktree or a new worktree.

3. **Work with it**: The agent opens in its own editor terminal. Type to it as you would in any terminal.

4. **Add more**: Start more agents the same way. Click a card to show its terminal, or run **Go to Agent...** to search by name, CLI, title, location or ID.

5. **Reload freely**: Run **Developer: Reload Window**. The agents keep running, and their terminals come back.

6. **Let agents work together**: Ask an agent in your own words, for example: "Start a Codex agent to write the tests, and have it message you when it is done."

## Features

### One panel for every agent

- **Cards**: Each card shows the agent's name, where it works and what its CLI reports. The dot is green while the agent is starting or working, yellow when it is idle, waiting for input, permission or sign-in, and red for an error or when its activity is unavailable. See [`PANEL.md`](https://github.com/y5ez3g/facadecode/blob/main/docs/extension/features/PANEL.md).
- **Card actions**: Rename Agent..., Pin or Unpin, Copy Agent Reference, Move Up, Move Down and Close Agent, from each card's context menu.
- **A terminal for each agent**: Every agent runs in its own editor terminal. Closing a running agent's terminal asks first; Cancel keeps the agent running and opens its terminal again. See [`LIFECYCLE.md`](https://github.com/y5ez3g/facadecode/blob/main/docs/extension/features/LIFECYCLE.md).
- **Filter**: Show only the agents in one working location or workspace folder with **Filter by Working Location...** in the panel's title bar, or with **Filter by This Location** or **Filter by This Folder** in a card's context menu. **Clear Filter** shows every agent again; the panel's badge always counts them all.
- **Resume Agent...**: Search Claude Code, Codex, Antigravity, Muse Code, OpenCode 2.x and Pi histories for this workspace, its subfolders and worktrees. Resume the exact conversation in its original CLI and folder, with current launch settings.
- **Pin and Unpin**: Pin a conversation in any of the six built-in CLIs to restore it in the background when this workspace opens again. Pinned cards stay above other agents, and the native terminal tab follows the same Pin/Unpin state. Unpin keeps the agent running; closing an agent removes its Pin. Pin becomes available once the native CLI identifies a saved, resumable conversation. An empty new session is not pinned as if it were saved.
- **Show Agent Launch and Show Agents Log**: In the Command Palette. **Show Agent Launch** shows how each CLI would start in a working location - its program, environment, arguments, YOLO, sandbox, approvals and folder trust - without starting it, with secrets hidden. **Show Agents Log** opens Facade's own log.

### Folders and worktrees

- **Any folder**: Start agents in any folder of a single-folder or multi-root workspace. Ordinary folders, repositories and worktrees work alike. See [`WORKTREES.md`](https://github.com/y5ez3g/facadecode/blob/main/docs/extension/features/WORKTREES.md).
- **New Worktree**: Create a Git worktree while starting an agent, or on its own from the panel's `...` menu.
- **Workspace folders and worktrees**: In **Change Working Location...**, add a folder to the workspace, remove one (its files stay on disk), or delete a linked worktree that is not a workspace folder and has no uncommitted changes (its branch is kept).

### Agents keep running

- **Reloads and workspace changes**: Agents keep running when the window reloads, when the extension host restarts, when a folder window becomes a multi-root workspace, and after **Save Workspace As...**.
- **Remote - SSH**: Agents run on the remote host, with the CLIs and accounts there. Facade names the environment as VS Code does, for example `SSH: my-server`.
- **Exits**: An agent whose CLI exits normally leaves the panel; one that exits abnormally keeps a red card until you close it.

### More CLIs

- **Custom CLIs**: Add any interactive CLI in `facade.custom`: its program, the arguments for a new conversation, and the arguments that resume one by its session ID. The resume arguments are required; a custom CLI also needs a history and live-identity adapter before it can appear in Resume or support Pin. **New Agent** offers it after the built-in CLIs, and its cards show the first letter of its ID in place of a logo. Facade passes its arguments exactly as written: `facade.yolo` does not change them, and Facade adds no sandbox or folder trust. See [`CLIS.md`](https://github.com/y5ez3g/facadecode/blob/main/docs/extension/engineering/CLIS.md).
- **Qwen Code** *(Under development)*: Qwen Code as a built-in CLI.

### A team that works together

- **Agents start agents**: An agent can start other agents, with any of the six CLIs, in any folder or new worktree of any Facade window on your computer, and give them their first task. Their cards appear without taking your focus, and their hover says who started them. An agent can also stop the agents it can reach.
- **Messages**: Agents send each other messages. Facade pastes the whole message into the other agent's input box once and sends it. While someone's unsent text, or a question of that CLI, is in the way, it waits, for up to 10 minutes, and never sends their text with it. If it cannot read the input box within 15 seconds, or the wait runs out, the sender is told the message was not delivered. Facade's notices to an agent that come together arrive in one paste. Agents can also message you: you get a notification in that agent's window with **Open Message** and **Show Agent**.
- **No duplicates on retry**: An agent that retries starting an agent or sending a message, with the same `request_id`, gets the first answer back instead of a second agent or message.
- **A stuck helper is reported**: When an agent started by another agent waits 20 seconds for permission, an answer or a sign-in, the agent that started it is told once, with who can answer.
- **Message History**: **Message History...** in the panel's `...` menu shows the messages of this window's agents, read-only. Messages are kept for 30 days.
- **Unsticking each other**: An agent can read another agent's terminal, type into it and press keys, to answer a prompt or help a stuck agent continue without interrupting you. Unlike messages, this typing does not wait for unsent text.
- **Across windows**: With `facade.yolo` on, an agent reaches every agent in your Facade windows on your computer, local and Remote - SSH alike; with it off, it reaches only its own group: the agent you started and every agent started from it.
- **No approval prompts for Facade itself**: With `facade.yolo` off, each CLI's own commands and file changes still ask for approval, but starting, stopping and messaging agents and the other actions above do not. Muse Code has no setting for this, so there its own approval rules decide.
- **Standard MCP**: Facade adds these as standard MCP tools when it starts each agent, without changing your CLI settings. Some CLIs read them only from the agent's folder, so while such agents run there Facade also puts its files in it: `.agents/skills/facade/SKILL.md` for Codex and Muse Code, `.agents/plugins/facade` for Antigravity, and on Windows a `facade` entry in `.mcp.json` for Muse Code, next to your own entries. It removes them when the last of those agents ends, unless you changed them. Turn all of this off for new agents with `facade.collaboration.enabled` in **Configure Agents...**.
- **Antigravity's first turn**: Antigravity loads Facade's tools only once it is in use. Facade opens and closes its MCP list right after it starts, so that its first task can already use them.
- **Trusting the folder**: So that an agent starts without its CLI's trust question, Facade trusts the folder it starts in, as you would by answering that question: for that start alone with Codex, Muse Code and Pi, and in the CLI's own settings with Claude Code and Antigravity. It never trusts your home folder, a folder above it or a drive's root for Claude Code, which would trust every folder below; Claude Code asks there as usual.
- **Copy Diagnostics**: To report a problem, run **Facade Code: Copy Diagnostics** from the Command Palette. It copies the versions, your agents with the last lines of their terminals, and Facade's log. Nothing is sent anywhere; read it before you share it, since terminals can show code or keys.

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
| `facade.antigravity.path` | Empty | Path to Antigravity. Leave empty to use `agy` from the terminal environment's PATH. |
| `facade.muse.path` | Empty | Path to Muse Code. Leave empty to use `muse` from the terminal environment's PATH. |
| `facade.opencode.path` | Empty | Path to OpenCode. Leave empty to use `opencode` from the terminal environment's PATH. |
| `facade.pi.path` | Empty | Path to Pi. Leave empty to use `pi` from the terminal environment's PATH. |
| `facade.<cli>.enabled` | On | Controls whether the CLI is offered for new agents. Turning it off does not stop agents that are running. |
| `facade.<cli>.launch` | `{}` | Advanced: additional command-line `arguments` and `environment` variables for the CLI. **Show Agent Launch** shows what each agent starts with. |
| `facade.custom` | `{}` | Your own CLIs, by ID, each with a `path` and a `launch`: `start` for a new conversation, `resume` for a saved one (required; it must contain `${sessionId}`), and `environment`. An ID cannot be a built-in one: `claude`, `codex`, `agy`, `muse`, `opencode` or `pi`. |

`<cli>` is `claude`, `codex`, `antigravity`, `muse`, `opencode` or `pi`. These are machine settings: for a remote window, set them in the remote host's settings.

For example, a CLI started as `my-cli --fast` and resumed as `my-cli resume <session ID>`:

```json
"facade.custom": {
  "my-cli": { "path": "my-cli", "launch": { "start": ["--fast"], "resume": ["resume", "${sessionId}"] } }
}
```

## Status and Known Limitations

- **Tested so far**: macOS (Apple silicon), Linux (x64) and Windows (x64) as the local computer, with local folders: each of the six CLIs started from the panel, and its Facade tools and messages, with a stand-in that draws its input box as that CLI does. On macOS, real Claude Code, Codex, Antigravity, OpenCode and Pi agents, with `facade.yolo` off, each started a second agent of the same CLI with a first task and exchanged messages with it. Remote - SSH from a macOS client to Linux (x64) and Windows (x64) hosts, and between windows of both.
- **Resume and Pin on Linux x64**: Native checks cover Claude Code 2.1.316, Codex 0.166.0, Antigravity, Muse Code 1.4.14, OpenCode 2.2.5 and Pi 1.4.0: native histories, exact resume and session changes. The isolated VS Code 1.144.0 suite checks all six adapters' Pin/Unpin, actual window reloads and folder-to-workspace conversion using fake CLIs. These new integrations still need native Windows, macOS and remote regression checks before a full platform-support claim.
- **Antigravity multi-folder conversations**: Its native history saves the workspace folder set, without identifying the original working directory. Facade reuses a directory it previously recorded; otherwise Resume asks you to choose a working location from that conversation's folders in this window.
- **Not yet verified**: Muse Code as a real agent working with others - in particular whether, with `facade.yolo` off, it asks before Facade's own tools run; real CLIs with Linux or Windows as the local computer; WSL, Dev Containers, other editors compatible with VS Code, the declared minimum VS Code 1.105, many agents in one window, and long-running sessions.
- **Muse Code on Windows**: Muse Code does not report its activity on Windows, so Facade reads it from Muse Code's own screen: working while it shows *esc to interrupt*, ready for input when its input is empty or holds a draft, and waiting at its sign-in screen. While it asks for approval, with `facade.yolo` off, its dot keeps the state it showed before. On Linux it reports as the other CLIs do.
- **Window Component**: Facade Code needs its Window Component on your computer; VS Code installs it with Facade Code. If it is missing or turned off, the panel says so and offers **Show Window Component**; install or enable it, then reload the window. Agents that are already running keep running.
- **Updating from 0.0.1**: Agents started before the update keep running. They open in their own terminals, without cards, and cannot use the new features.
- **Remote - SSH reconnects**: If VS Code stops reconnecting to an SSH host and asks you to reload the window, reload it once the network is back. The agents keep running on the host, and the reloaded window shows them again.
- **Closing a window**: Facade ends a window's agents five minutes after that window's extension host disconnects and nothing reconnects, for example after you close the window.
- **Custom CLIs**: Facade knows a custom CLI's activity only if the CLI reports it in its terminal with OSC 7501 sequences, as the built-in CLIs do. Otherwise the agent still starts and works, but its dot turns red with *Activity unavailable* 20 seconds after it starts.

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
