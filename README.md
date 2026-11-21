<div align="center">

<img src="extension/media/icon.png" alt="Facade Code" width="112">

# Facade Code

**Run AI coding agents across your machines.**

Facade Code runs a group of AI coding CLIs on your own machines. Agents can find and message each other, read screens
and type into terminals. You can direct them from Shell, VS Code or any application that supports MCP. Each machine
runs its own Orchestrator, and your machines connect over SSH.

[![Website: facadecode.com](https://img.shields.io/badge/Website-facadecode.com-335e78?style=flat)](https://facadecode.com)
[![VS Code Marketplace: install](https://img.shields.io/badge/VS%20Code%20Marketplace-install-335e78?style=flat)](https://marketplace.visualstudio.com/items?itemName=facade.facadecode)
[![Open VSX: install](https://img.shields.io/badge/Open%20VSX-install-335e78?style=flat)](https://open-vsx.org/extension/facade/facadecode)
[![Releases](https://img.shields.io/badge/Releases-GitHub-335e78?style=flat)](https://github.com/y5ez3g/facadecode/releases)
[![Issues: report a bug](https://img.shields.io/badge/Issues-report%20a%20bug-335e78?style=flat)](https://github.com/y5ez3g/facadecode/issues)

**English** · [简体中文](docs/locales/zh-CN/README.md) · [繁體中文](docs/locales/zh-TW/README.md) · [Português (Brasil)](docs/locales/pt-BR/README.md) · [Español](docs/locales/es/README.md) · [Русский](docs/locales/ru/README.md) · [Deutsch](docs/locales/de/README.md) · [日本語](docs/locales/ja/README.md) · [Bahasa Indonesia](docs/locales/id/README.md) · [Français](docs/locales/fr/README.md) · [한국어](docs/locales/ko/README.md) · [Türkçe](docs/locales/tr/README.md) · [Tiếng Việt](docs/locales/vi/README.md) · [Polski](docs/locales/pl/README.md)

<p>
  <a href="https://upstar.dev/t/editors/week/2026-11-09">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://upstar.dev/badge/y5ez3g/facadecode/award/editors-dark.svg">
      <img alt="Upstar: #4 Riser Of The Week in Editors &amp; IDEs, November 9–15, 2026" src="https://upstar.dev/badge/y5ez3g/facadecode/award/editors.svg" width="250" height="55">
    </picture>
  </a>
</p>

</div>

[![Watch the 2-minute demo on facadecode.com](docs/assets/readme/demo-poster.jpg)](https://facadecode.com)

## Install

### Shell

The one-line installers cover macOS, Linux and Windows on x64 and arm64. They download the package from GitHub
and use the official website mirror when GitHub is unavailable.

Run this command on macOS or Linux.

```sh
sh -c 'script=$(curl -fsSL "$1") && sh -c "$script" --' facade-install https://facadecode.com/install.sh
```

Run this command in PowerShell on Windows.

```powershell
irm https://facadecode.com/install.ps1 | iex
```

Each GitHub Pre-release includes commands to install that exact candidate version. To select a version in the installer,
use `--version X.Y.Z` on macOS or Linux, or `-Version X.Y.Z` in PowerShell.

The installer adds `facade` and `facade-mcp` to PATH. Open a new terminal to use the updated PATH.

The IDE preview's launcher also uses the name `facade`. If both programs are installed, your shell runs the first
`facade` on PATH. Run `facade --version` and look for a line of the form `facade <version>` to verify that you have
the Shell command. The launcher name belongs to the Orchestrator after the IDE preview is retired.

Run `facade upgrade` for the stable version, or `facade upgrade --version X.Y.Z` to select an exact release.
Install and sign in to the CLIs you want to run on each machine.
The built-in choices are Claude Code, Codex, Antigravity, Muse Code, OpenCode and Pi.

### VS Code

```sh
code --install-extension facade.facadecode
```

The extension includes its own Orchestrator. Open **Facade Code** in the Activity Bar and choose **New Agent**,
**Go to Agent** or **Resume Agent**. Packages are built for macOS, Linux and Windows on x64 and arm64.
[Marketplace](https://marketplace.visualstudio.com/items?itemName=facade.facadecode) · [Open VSX](https://open-vsx.org/extension/facade/facadecode) · [Extension guide](extension/GUIDE.md)

### MCP

Add `facade-mcp` as a stdio MCP server in your app. This example uses an `mcpServers` object.

```json
{
  "mcpServers": {
    "facade": { "command": "facade-mcp" }
  }
}
```

An external connection joins as a Guest on its first tool call. Send a message, then use the `read_messages` call returned by
`send_message` to wait for its reply.

## Work across machines

```sh
facade start --name ada -d codex
facade list
facade attach ada
```

Use the address printed by `facade list`. To work on another machine, register it with your usual SSH target and
options. To reach WSL or a Dev Container from outside, start SSH inside that environment and register it the same
way. You can also run Facade directly inside it.

```sh
facade machine add -p 2222 aaron@devbox.lan
facade start --machine devbox --workdir /work/app --worktree feat-x claude
```

Facade installs the matching version on the remote machine when needed and runs it from its fixed installation
path. If you need to install manually, use the same version as your local Orchestrator. In VS Code, **Go to Agent** can open the
running agent's terminal. The workspace remembers the agents you open, their helpers and your Pins. Closing a
terminal tab leaves the agent running. **Resume Agent** and `facade resume` offer saved work.

> **YOLO defaults to on.** On connected machines, an agent with YOLO on can reach other agents across the network.
> Set `"yolo": false` in that machine's `facade.json` to keep the CLI's own approvals and sandbox and limit MCP reach
> to the caller's creation tree. The setting takes effect on start or resume. Run `facade status` to find the file.

[Product guide](docs/PRODUCT.md) · [Glossary](docs/core/GLOSSARY.md)

## Facade Code IDE (Preview)

**Multiple projects. One window.**

Organize projects, feature worktrees, and agent teams in a dedicated workspace bar. Switch between projects with their relevant files and terminals, while agents continue working in the background.

Download the IDE preview: [macOS (Apple silicon, .dmg)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-darwin-arm64.dmg) · [Windows (x64, .exe)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-win32-x64-user-setup.exe) · [Linux (Ubuntu x64, .deb)](https://github.com/y5ez3g/facadecode/releases/download/facade/0.1.2/facade-code-0.1.2-linux-x64.deb) · [All releases](https://github.com/y5ez3g/facadecode/releases)

The preview IDE installs alongside your editor with its own settings and extensions. Its extensions come from
[Open VSX](https://open-vsx.org). A few proprietary Microsoft extensions, such as Remote Development and C/C++, run
only in official Microsoft builds. Architecture and specifications are in [`docs/ide/`](docs/ide/).

## Building from Source

- **Orchestrator and Shell.** See [`core/README.md`](core/README.md).
- **Extension:** Provide [`extension/AGENTS.md`](extension/AGENTS.md) to your coding agent to build the package.
- **IDE:** Provide [`docs/ide/RELEASE.md`](docs/ide/RELEASE.md) to your coding agent to build the application.

For contribution guidelines and branch discipline, see [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`docs/ide/ENGINEERING.md`](docs/ide/ENGINEERING.md).

## Feedback

- **Bugs & ideas**: [GitHub Issues](https://github.com/y5ez3g/facadecode/issues), or **Help > Report Issue** in the IDE.
- **Security vulnerabilities**: Please report privately according to [`SECURITY.md`](SECURITY.md).

## License

MIT, matching upstream VS Code. See [`LICENSE.txt`](LICENSE.txt) for Microsoft's copyright notice and Facade Code contributors' notices.

<sub>Facade Code is an independent product and is not affiliated with, endorsed by, or sponsored by the providers of the third-party tools shown. All third-party trademarks and logos belong to their respective owners.</sub>
