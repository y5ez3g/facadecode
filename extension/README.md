# Facade Code

The Facade Code extension brings interactive coding agents into VS Code. Use your own CLI and account, and run several agents
side by side, each in its own terminal. Facade provides the infrastructure; you choose the workflow.

**Development status:** unreleased, step 1 of an incremental build. This step is the whole panel for Claude Code and Codex:

- New Agent starts Claude Code or Codex in the window's working location, with a suggested name you can change, or in another folder,
  worktree or a new Git worktree you choose. The selected CLI trusts that folder as if you had accepted its question.
- Every agent has a card and its own editor terminal. Cards show the agent's name, where it works and what its CLI reports;
  the dot is green, yellow or red from actual evidence only. Rename, Copy Agent Reference, Move Up/Down and Close Agent work on
  cards, and Go to Agent finds an agent by its name, ID, CLI, state or location. The panel's view menu creates a standalone worktree
  with New Worktree..., adds a folder to the workspace with Add Folder to Workspace..., and opens settings with Configure Agents.
- Agents keep running when the window reloads, and when a folder window becomes a multi-root workspace; an agent whose CLI exits
  abnormally keeps a red card until you close it.

Not in this step: other CLIs (Antigravity, Muse Code, Qwen Code, custom CLIs), turning a CLI off and its launch
arguments and environment, Show Agent Launch and Show Agents Log, Filter, Resume, Pin, the agents' MCP tools and messages. They
are added in later steps. macOS local workspaces and selected Linux and Windows SSH workflows have been exercised; complete remote verification and real vendor CLI conversations remain incomplete. Long-duration soak testing has not been run.

## Requirements

- Desktop VS Code: the declared minimum is 1.105. Other editors and platforms require their own verification.
- Claude Code or Codex and its account in the environment where the workspace runs.
- Git for worktree operations. Starting agents in ordinary folders does not require Git.
- Remote workspaces: packaging produces companion components of the same product. Install the universal Window Component on the local client first to coordinate window identity; install the platform-specific execution package in the environment where the workspace runs.

## Known limitations

- If VS Code stops reconnecting to an SSH host and asks you to reload the window, reload it once the network is back. The agents keep running on the host, and the reloaded window shows them again. Facade ends a window's agents five minutes after that window's extension host on the host disconnects and nothing reconnects.

<!-- repository-only:start -->

## Working on it

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
Never use the owner's live windows as test subjects. Use `npm install` when deliberately changing dependencies and retain the
updated lockfile. `npm run watch` rebuilds the bundles as source changes; `npm run compile` also checks types and builds the
unit tests.

The execution bundle is assembled in `build/extension/`, including its native PTY backend for the build machine's
OS/architecture. The local window dependency is assembled in `build/window/` without native code. Packaging produces
both VSIX files under `build/vsix/`. Install the window component on the client and the execution component where the
workspace runs; unpublished test installations supply both packages. Integration tests load both components and use a
separate `build/extension-it/` for execution fixtures. A local build does not establish support on another platform.

<!-- repository-only:end -->

## License

MIT. See [LICENSE.txt](LICENSE.txt). Facade Code builds on Visual Studio Code; inherited source and bundled third-party
materials retain their own notices in [ThirdPartyNotices.txt](ThirdPartyNotices.txt).
