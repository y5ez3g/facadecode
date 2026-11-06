<div align="center">

<img src="extension/media/icon.png" alt="Facade Code" width="112">

# Facade Code

**The multi-agent orchestrator for VS Code.**

Run native agent CLIs, edit code, and review changes in the same IDE window. Use your own accounts and coding plans, and let agents collaborate across windows and machines.

[![Website: facadecode.com](https://img.shields.io/badge/Website-facadecode.com-335e78?style=flat)](https://facadecode.com)
[![VS Code Marketplace: install](https://img.shields.io/badge/VS%20Code%20Marketplace-install-335e78?style=flat)](https://marketplace.visualstudio.com/items?itemName=facade.facadecode)
[![Open VSX: install](https://img.shields.io/badge/Open%20VSX-install-335e78?style=flat)](https://open-vsx.org/extension/facade/facadecode)
[![Releases: download the IDE](https://img.shields.io/badge/Releases-download%20the%20IDE-335e78?style=flat)](https://github.com/y5ez3g/facadecode/releases)
[![Issues: report a bug](https://img.shields.io/badge/Issues-report%20a%20bug-335e78?style=flat)](https://github.com/y5ez3g/facadecode/issues)

**English** · [简体中文](docs/locales/zh-CN/README.md) · [繁體中文](docs/locales/zh-TW/README.md) · [Português (Brasil)](docs/locales/pt-BR/README.md) · [Español](docs/locales/es/README.md) · [Русский](docs/locales/ru/README.md) · [Deutsch](docs/locales/de/README.md) · [日本語](docs/locales/ja/README.md) · [Bahasa Indonesia](docs/locales/id/README.md) · [Français](docs/locales/fr/README.md) · [한국어](docs/locales/ko/README.md) · [Türkçe](docs/locales/tr/README.md) · [Tiếng Việt](docs/locales/vi/README.md) · [Polski](docs/locales/pl/README.md)

</div>

[![Watch the 2-minute demo on facadecode.com](docs/assets/readme/demo-poster.jpg)](https://facadecode.com)

## Install

```sh
code --install-extension facade.facadecode
```

Or install **Facade Code** from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=facade.facadecode) or [Open VSX](https://open-vsx.org/extension/facade/facadecode). It runs on macOS (Apple silicon), Linux (x64), and Windows (x64).

Next, install and sign in to any supported agent CLIs you plan to use: Claude Code, Codex, Antigravity, Muse Code, OpenCode, or Pi. Facade Code starts each CLI using its own sign-in and account plans.

> **Agents run without approval prompts by default.** With `facade.yolo` enabled by default, agents can run commands and change files without asking first. Turn it off to restore each CLI's standard approval prompts. See the [extension README](extension/README.md#install).

## Agent Panel

**Your agents and your IDE, in the same window.**

Facade Code runs native agent CLIs (Claude Code, Codex, Antigravity, Muse Code, OpenCode, and Pi) in editor terminal tabs beside your files, using each CLI's own commands, tools, accounts, and coding plans. A card in the panel tracks each agent's status.

- **Work beside your code.** Each agent runs in its own terminal tab in the editor area. Closing a tab hides it while the agent keeps running; clicking its card opens it again.
- **Track status across agents.** Cards show who started each agent, what it is doing, and whether it is ready for input, needs permission, or encountered an error. Agents keep running through window reloads and extension restarts.
- **Folders and worktrees.** Run agents in any workspace folder or create a Git worktree on the fly to keep code changes separate. Pin a conversation to restore it when you open the workspace again, or resume past sessions from history.

## Agent Use

**Let agents operate other agents, just like you.**

Through MCP and a terminal protocol, agents can start, stop, find, and message other agents, read their terminal screens, type text, and press keys.

- **Start and stop agents.** An agent can start other agents with any of the six CLIs, in any folder or new worktree of your Facade windows on this computer, and give them their first task. A retried request with the same request ID never starts a second agent.
- **Send messages.** Agents exchange messages with each other and can message you. Facade pastes the whole message once and sends it. If unsent text or a prompt question is in the way, delivery waits until the input is clear.
- **Terminal control.** An agent can read another agent's screen, type commands, and press keys to answer prompts or help a stuck peer. When a child agent waits 20 seconds for input or permission, the agent that started it is notified.

## Agent Mesh

**Connect agents across windows, machines, and locations.**

Facade Code connects agents across your Facade windows on this computer into one network. Open a [VS Code Remote SSH](https://code.visualstudio.com/docs/remote/ssh) window to extend that collaboration to another machine.

- **Across windows.** With `facade.yolo` on, an agent reaches every agent across your Facade windows on this computer, local and Remote - SSH alike. With it off, an agent reaches only its own group: the agent you started and those started from it.
- **Extend over SSH.** In a [VS Code Remote SSH](https://code.visualstudio.com/docs/remote/ssh) window, agents run directly on the remote machine with the tools, files, and accounts there. Local agents can start and message agents in Remote - SSH windows directly.
- **Coordinate from your phone.** Connect the Claude mobile app to a Claude Code session on your computer using [Claude Code Remote Control](https://code.claude.com/docs/en/remote-control). That session can coordinate other agents through Facade and report progress back to your phone.

<sub>Remote Control requires a supported Claude Code version, an eligible plan, and full-scope sign-in. See its [setup requirements](https://code.claude.com/docs/en/remote-control#requirements).</sub>

## Facade Code IDE (Preview)

**Multiple projects. One window.**

Organize projects, feature worktrees, and agent teams in a dedicated workspace bar. Switch between projects with their relevant files and terminals, while agents continue working in the background.

Download the IDE preview: [macOS (Apple silicon, .dmg)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-darwin-arm64.dmg) · [Windows (x64, .exe)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-win32-x64-user-setup.exe) · [Linux (Ubuntu x64, .deb)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-linux-x64.deb) · [All releases](https://github.com/y5ez3g/facadecode/releases)

The IDE is a fork of VS Code that installs alongside your existing editor and shares nothing with it: settings, extensions, and the `facade` command are completely separate. Its extensions come from [Open VSX](https://open-vsx.org); a few proprietary Microsoft extensions, such as Remote Development and C/C++, run only in official Microsoft builds. Architecture and specifications are in [`docs/ide/`](docs/ide/).

## Building from Source

- **Extension:** Provide [`extension/AGENTS.md`](extension/AGENTS.md) to your coding agent to build the package.
- **IDE:** Provide [`docs/ide/RELEASE.md`](docs/ide/RELEASE.md) to your coding agent to build the application.

For contribution guidelines and branch discipline, see [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`docs/ide/ENGINEERING.md`](docs/ide/ENGINEERING.md).

## Feedback

- **Bugs & ideas**: [GitHub Issues](https://github.com/y5ez3g/facadecode/issues), or **Help > Report Issue** in the IDE.
- **Security vulnerabilities**: Please report privately according to [`SECURITY.md`](SECURITY.md).

## License

MIT, matching upstream VS Code. See [`LICENSE.txt`](LICENSE.txt) for Microsoft's copyright notice and Facade Code contributors' notices.

<sub>Facade Code is an independent product and is not affiliated with, endorsed by, or sponsored by the providers of the third-party tools shown. All third-party trademarks and logos belong to their respective owners.</sub>
