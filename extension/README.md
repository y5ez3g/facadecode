<div align="center">

<img src="https://raw.githubusercontent.com/y5ez3g/facadecode/main/extension/media/icon.png" alt="Facade Code" width="128">

# Facade Code

**The VS Code entry point for Facade Code.**

Start coding agents in your workspace or on another machine. Open their terminals alongside your files and continue their work from VS Code or Shell.

[![Website: facadecode.com](https://img.shields.io/badge/Website-facadecode.com-335e78?style=flat)](https://facadecode.com)
[![GitHub: y5ez3g/facadecode](https://img.shields.io/badge/GitHub-y5ez3g%2Ffacadecode-335e78?style=flat)](https://github.com/y5ez3g/facadecode)
[![Feature guide: read](https://img.shields.io/badge/Feature%20guide-read-335e78?style=flat)](https://github.com/y5ez3g/facadecode/blob/main/extension/GUIDE.md)
[![Issues: report a bug](https://img.shields.io/badge/Issues-report%20a%20bug-335e78?style=flat)](https://github.com/y5ez3g/facadecode/issues)

</div>

[![Watch the 2-minute demo on facadecode.com](https://raw.githubusercontent.com/y5ez3g/facadecode/main/docs/assets/readme/demo-poster.jpg)](https://facadecode.com)

## Install

Install **Facade Code** from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=facade.facadecode)
or [Open VSX](https://open-vsx.org/extension/facade/facadecode). The extension includes the Orchestrator for the machine
where its VS Code workspace host runs. The accompanying Window Component cleans up stale terminal tabs after reconnect
or extension restart.

Packages are built for macOS, Linux and Windows on x64 and arm64. Install and sign in to the CLI you want to run on its
machine. Facade Code can start **Claude Code, Codex, Antigravity, Muse Code, OpenCode and Pi**. Worktree
creation uses Git.

## Quick Start

1. Open a project folder and select **Facade Code** in the Activity Bar.
2. Choose **New Agent**. Use **Change Working Location** to choose a folder or worktree, or select a saved machine and
   one of its folders. Select the CLI and begin in its terminal.
3. Choose **Go to Agent** to open a running managed agent, including one started in Shell. Agents in your workspace and
   their helpers appear in the Panel. Click a card to open its terminal.
4. Use **Resume Agent** to resume an ended agent, or a saved CLI session as a new agent. Use **Pin** on a card to
   restore it when the workspace reopens.

Cards show the agent's state and the CLI's title. The information button shows the machine and address. Closing a
terminal tab detaches that view. **Hide** removes the card from the workspace and clears its Pin. **Stop** ends the
agent's run and leaves its card available for Resume. **Remove** also removes the agent's record.

In a Remote-SSH workspace, the extension uses the Orchestrator on the remote machine. Register other machines using
`facade machine add` and the SSH options you normally use. For standalone Shell installation and connecting an MCP app
as a Guest, see the [repository README](https://github.com/y5ez3g/facadecode#install).

## Settings

Choose **Open Settings** to access the execution machine's `facade.json`. The Orchestrator uses `FACADE_HOME`, defaulting to
`~/.facade`; `facade status` shows the file's location. Edit the file on that machine. Changes apply to later starts and
resumes. Already-running agents keep the settings they read at start.

**YOLO defaults to on.** With YOLO on, an agent can reach other agents across your connected machines. Set
`"yolo": false` to use the CLI's own permissions and sandbox and limit MCP reach to the caller's creation tree.
The CLI still asks you its own questions in the terminal. A start on this machine uses the starter's environment;
a start on another machine uses its SSH login environment.

```jsonc
{
  "yolo": false,
  "clis": {
    "Codex · work": { "type": "codex", "args": ["--profile", "work"] },
    "aider": { "type": "custom", "program": "aider" }
  }
}
```

A named entry can use a built-in CLI with its own arguments, environment, model and effort where the CLI supports them.
Use `${env:NAME}` to read a value from the launch environment. A custom program can be started and attached to,
and its terminal accepts direct input. Its lack of a managed CLI session means it has no MCP messaging, Resume or Pin.
The [product's CLI table](https://github.com/y5ez3g/facadecode/blob/main/docs/facade-code.md#各个-cli-不一样的地方)
lists the differences between CLIs.

## Old engine transition

Set **Facade: Rust Engine** to `off` and reload to use the old engine. Its window lifetime, settings and Window Component
requirements follow the [transition guidance](https://github.com/y5ez3g/facadecode/blob/main/extension/GUIDE.md#old-engine-transition).

## Status and Known Limitations

For tested configurations and known limitations, see the [feature guide](https://github.com/y5ez3g/facadecode/blob/main/extension/GUIDE.md#status-and-known-limitations).

## Building from Source

Provide [`extension/AGENTS.md`](https://github.com/y5ez3g/facadecode/blob/main/extension/AGENTS.md) to your coding agent to build the extension. For contribution guidelines, see [`CONTRIBUTING.md`](https://github.com/y5ez3g/facadecode/blob/main/CONTRIBUTING.md).

<!-- repository-only:start -->

### Working on it

Read [AGENTS.md](AGENTS.md) before changing anything. The [product documentation](../docs/facade-code.md) defines the product and the
[extension's specification](../docs/extension/README.md) defines the editor's behavior; [Verification](../docs/extension/engineering/VERIFICATION.md) defines the required evidence.

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

Extension CI builds packages for macOS x64 and ARM64, Linux x64 and ARM64, and Windows x64 and ARM64 on native
runners. All six targets passed the 0.1.1 checks, including package tests and isolated editor journeys with fake CLIs;
the archive catalog records the source, CI run and original published bytes. Real-model and remote checks remain
separate evidence. Each target uploads its tested VSIX and the universal Window Component.

### Releases

A release starts from a pushed tag `extension/<version>` that names `package.json`'s version. The `Extension release`
workflow builds and tests that tag on all six native runners. It puts every platform VSIX, the universal Window Component,
the standalone installers, native archives, version marker and `SHA256SUMS` on the tag's GitHub Release, with the
changelog's section as its notes. The newest extension version is
marked Latest. It downloads the Release again and checks every file. Only then, after approval in the `extension-stores`
environment, it publishes the Release's own files to VS Code Marketplace and Open VSX, the Window Component first, skipping
files a store already has, and waits until both stores serve the same bytes. Rerunning it for a tag whose Release is
complete finishes the stores without rebuilding. The environment holds the `VSCE_PAT` and `OVSX_PAT` secrets.

An existing Release keeps its files: a file of the same name with other bytes stops the run, and only missing files are
added. `node scripts/release.mjs` does the work: `github --tag <tag> --input-dir <dir>`, `stores --tag <tag>`, and
`github --backfill`, which puts the versions first published to the stores (listed in `archive/catalog.json` with their
original Marketplace files and SHA-256) on Releases of their own, byte for byte. Catalog validation requires the
historical three-platform set before 0.1.1 and all six platforms from 0.1.1, with one Window Component.

Historical backfills preserve the published bytes. In particular, `0.0.2`'s original CI source used version `0.2.0`;
the shipped VSIX files say `0.0.2`, with matching runtime bundles and platform native files. Its catalog entry records
that version override and the original CI commit rather than claiming a newly rebuilt historical release.

<!-- repository-only:end -->

## Feedback

- **Bugs & ideas**: [GitHub Issues](https://github.com/y5ez3g/facadecode/issues).
- **Security vulnerabilities**: Please report privately according to [`SECURITY.md`](https://github.com/y5ez3g/facadecode/blob/main/SECURITY.md).

## License

MIT. See [`LICENSE.txt`](https://github.com/y5ez3g/facadecode/blob/main/extension/LICENSE.txt). Facade Code builds on Visual Studio Code; inherited source and bundled third-party materials retain their own notices in [`ThirdPartyNotices.txt`](https://github.com/y5ez3g/facadecode/blob/main/extension/ThirdPartyNotices.txt).

<sub>Facade Code is an independent product and is not affiliated with, endorsed by, or sponsored by the providers of the third-party tools shown. All third-party trademarks and logos belong to their respective owners.</sub>
