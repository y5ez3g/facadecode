<div align="center">

<img src="resources/linux/code.png" alt="Facade Code" width="128">

# Facade Code

**One IDE for you and your AI team.**

Built on VS Code. Runs your native agent CLIs, like Claude Code, Codex, Antigravity, and Muse Code.

[Download](https://github.com/y5ez3g/facadecode/releases) ·
[Specs](facade-code-spec/) ·
[Report a Bug](https://github.com/y5ez3g/facadecode/issues)

**English** · [简体中文](locales/zh-CN/README.md) · [繁體中文](locales/zh-TW/README.md) · [Português (Brasil)](locales/pt-BR/README.md) · [Español](locales/es/README.md) · [Русский](locales/ru/README.md) · [Deutsch](locales/de/README.md) · [日本語](locales/ja/README.md) · [Bahasa Indonesia](locales/id/README.md) · [Français](locales/fr/README.md) · [한국어](locales/ko/README.md) · [Türkçe](locales/tr/README.md) · [Tiếng Việt](locales/vi/README.md) · [Polski](locales/pl/README.md)

</div>

https://github.com/user-attachments/assets/35e2c317-8040-49c6-bb56-ab81196e8ebc

Facade Code is a fork of VS Code where native agents from every vendor collaborate on your projects and features, while you review code and steer any agent in the same window.

- 🧑‍💻 **Full VS Code, organized by projects and features.** Develop multiple projects and features in one window. Every feature is a git worktree, staffed with a dedicated team of agents.
- 🤖 **A cross-vendor team of native agent CLIs.** Agents run on your own coding plans. In Facade Code, agents launch, message, and help unstick each other.
- 👥 **Super Engineer or Super Team.** Direct multiple agents yourself, or designate a lead model to coordinate specialists in parallel.

## Install

Download the latest release from [Releases](https://github.com/y5ez3g/facadecode/releases): a `.dmg` for macOS (Apple silicon), an installer for Windows (x64), or a `.deb` for Ubuntu (x64).

**Prerequisites**: Install and log into the agent CLIs you want to use (any combination of Claude Code, Codex, Antigravity, or Muse Code). Facade Code runs them directly using their native authentication and subscriptions.

Facade Code installs alongside VS Code and shares nothing with it: settings, extensions, and the `facade` command-line tool are completely separate.

## Quick Start

1. **Open a project**:
   ```sh
   facade ~/code/space-shooter
   ```
   Or use **File > Open Folder**, or drop a folder onto the workspace bar. The folder must be a git repository (worktrees require git; run `git init` first if starting fresh).

2. **Launch a tech lead**:
   Click the robot icon in the title bar (Agent menu), or run **Agents: Start Agent...** in the Command Palette, and select Claude Code or Codex. Launching from within Facade Code equips the agent with its MCP tools.

3. **Give it the lead prompt**:
   ```text
   You're the tech lead. Use Facade to build a neon space shooter for the browser
   (desktop) for a demo, with a PD on GPT Sol 6 (gpt-6-sol, max) via Codex who owns
   the look and feel, and three Muse 1.3 engineers (muse-spark-1.3, max) working in
   parallel. Keep it small, about a half-hour build: one level, three enemy types,
   a two-phase boss, power-ups, score and combos. Finished and polished beats more
   features. Engineers merge their own work and you review after. Send me one HTML
   page with a short plan, a swimlane diagram, and the PD's mockup, then wait for my
   approval before you start.
   ```

4. **Watch the team collaborate**:
   The spawned PD and engineers appear in the workspace bar under their project and feature. Once you approve the HTML plan, they start building. You can click into any agent's terminal at any time to inspect output or talk to them directly.

*(Note: This sample prompt spawns 5 agents on max effort. Adjust the CLIs, models, effort levels, and worker counts to match your available plans.)*

## Features

### Projects and features, not sessions

https://github.com/user-attachments/assets/bf93be03-1c75-4d35-86ca-c2a62a62ea95

Most agent tools create a worktree for each agent session. Facade Code works the other way around: each worktree is a feature, listed under its repository, and you assign agents to it.

A feature often needs more than one agent. The one that writes the code may not explain its work clearly or have a good eye for design, so other agents help with documentation, design, and review, all in the same worktree. Agents come and go; the feature stays.

- **Workspace bar**: Lists every repository and feature in one column. Click one to switch the whole window (explorer, editors, terminals, and source control), restored as you left it. Projects never mix together. See [`WORKSPACE.md`](facade-code-spec/WORKSPACE.md).
- **Worktree lifecycle**: **New Worktree** creates the branch, syncs local files in `.worktreeinclude`, and runs setup. **Delete Worktree** details what would be lost before removing. See [`WORKTREE.md`](facade-code-spec/WORKTREE.md).
- **Parallel subtasks**: Independent tasks can branch into separate worktrees.

### A team from every vendor

- **Native CLIs on your own plans**: Claude Code, Codex, Muse Code, and Antigravity run in their own integrated terminals, using your existing subscriptions.
- **Agents launch agents**: An agent can start other agents (using any vendor CLI or model) in the current feature or a new worktree, and assign tasks. See [`AGENT-LAUNCHER.md`](facade-code-spec/AGENT-LAUNCHER.md) and [`AGENT-ORCHESTRATION.md`](facade-code-spec/AGENT-ORCHESTRATION.md).
- **Messaging**: Agents send messages to each other, report results back to their caller, and notify you when a decision needs human approval. See [`AGENT-MESSAGES.md`](facade-code-spec/AGENT-MESSAGES.md).
- **Unsticking each other**: An agent can read another agent's terminal, answer prompts, and send keystrokes to help a blocked worker without interrupting you. See [`AGENT-DEBUGGING.md`](facade-code-spec/AGENT-DEBUGGING.md).
- **You can intervene in every one**: Every agent has its own terminal row under its feature. You see what it is doing and can type directly into it at any time.
- **Standard MCP**: All orchestration tools are exposed through a standard MCP server.

## Two Ways to Work

Developer attention is the bottleneck. The two modes represent two levels of delegation:

| | **Super Engineer** | **Super Team** |
|---|---|---|
| **Your role** | Hands-on engineer | Engineering manager |
| **Who you interface with** | Multiple agents directly | A tech lead agent, 1:1 |
| **Who coordinates agents** | You | The tech lead |
| **Best for** | Features requiring close guidance: exploratory work, design decisions you want to judge yourself, changing requirements | Large, well-defined features that split cleanly |

You can mix both in the same window: keep close control over sensitive features while delegating well-scoped work to a lead.

- **Super Engineer**: You open worktrees, assign tasks to agents across repositories, and review code as each one finishes.
- **Super Team**: You hand a feature to an agent as tech lead. It breaks down tasks, defines interface contracts, starts workers, and reviews their output.
  - A strong model leads; faster, lower-cost models on your existing plans implement in parallel; and models from different vendors review each other's work.
  - A prompt is enough to set it up (see [Quick Start](#quick-start)); team workflows you reuse can be written as skills.

*(This README was written the same way: one agent analyzed, one drafted, and a person made the final call.)*

## Why

Most AI coding tools fall into two camps: Copilot-style IDEs where a human must follow along line-by-line, and Agent IDEs where code review and debugging are delegated to an external editor. Neither brings a cross-vendor team of native agents together inside your primary IDE.

We believe the future is one developer driving multiple projects and features with a team of agents. Different models excel at different tasks, so the team should span vendors. And because agents write the code you review, that team belongs in your IDE.

## Still VS Code

Facade Code modifies only what multi-project and agent management requires:

- The **workspace bar** takes the first column; the **activity bar** moves to the top right of the title bar (restorable with `workbench.activityBar.location`).
- Upstream Copilot and chat are disabled by default (a single setting re-enables them).
- Everything else is stock VS Code: editor, settings, keybindings, `.vscode/`, and `.code-workspace` files.
- Extensions install from [Open VSX](https://open-vsx.org). A few proprietary Microsoft extensions, like Remote Development and C/C++, are licensed only for official Microsoft builds and cannot run in forks.

## Building from Source

Hand [`facade-code-spec/RELEASE.md`](facade-code-spec/RELEASE.md) to your agent, and let it build.

For contribution guidelines and branch discipline, see [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`facade-code-spec/ENGINEERING.md`](facade-code-spec/ENGINEERING.md).

## Feedback

- **Bugs & ideas**: [GitHub Issues](https://github.com/y5ez3g/facadecode/issues) or **Help > Report Issue** in the editor.
- **Security vulnerabilities**: Please report privately according to [`SECURITY.md`](SECURITY.md).

## License

MIT, matching upstream VS Code. See [`LICENSE.txt`](LICENSE.txt) for Microsoft's copyright notice and Facade Code contributors' notices.
