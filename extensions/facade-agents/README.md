# Facade Agents

**Notice:** This extension is bundled with Facade Code. It can be disabled but not uninstalled.

Vendors' agent CLIs in their own terminal UIs, in the folders of a Facade window, each with Facade's MCP server to drive the IDE. The design is `facade-code-spec/WORKTREE-AGENTS.md`; `facade-code-spec/L2-PLAN.md` builds it milestone by milestone.

## The switch

```
facade.orchestration.enabled
```

Off, which is the default, this extension starts no server, writes nothing under `~/.facade/workspaces` and launches no agents.

## What it does

- **Facade: Start Agent** starts Claude Code in the folder on screen, on the model the person picks, with a first message if they give one. It runs in its own UI, in a terminal held under the folder's row of the workspace bar, and takes the name of its worktree: `main` for a repository's own checkout, a worktree's branch otherwise.
- **Its MCP server** is Facade's shim, started by Claude with a token of its own. It has one tool, `ide`, with five actions: open a file, open a terminal in a folder, read a terminal, type into one, and run any VS Code command.
- **Across a reload**, and a folder window becoming a workspace, the agents keep running: their ledger, the pipe's name and their terminals' process ids sit under `~/.facade/workspaces/<first folder>-<hash>/`, not in the extension's storage.

## Layout

Six layers, a folder each, with imports only pointing down (`facade-code-spec/WORKTREE-AGENTS.md`, section 18):

- `src/contract/` is what the model sees: the tools, their arguments, the result text, the error codes and the instructions.
- `src/core/` is Facade itself: its operations and its rules, and the ports through which it asks the window for things.
- `src/record/` is what a workspace keeps on disk: the ledger, the tokens, the agents' states and the window's state.
- `src/clis/` is how each agent CLI is launched.
- `src/transport/` carries a call from an agent's CLI to the window and back: the shim, MCP over stdio, and HTTP over a named pipe.
- `src/host/` is the only layer that imports `vscode`: the service that puts the layers together, Start Agent, and the ports.
- `src/extension.ts` turns the service on and off with the switch.

`src/test/` has a suite per layer, and `layers.test.ts`, which reads every import and holds the code to these rules.
