# Facade Agents

**Notice:** This extension is bundled with Facade Code. It can be disabled but not uninstalled.

Vendors' agent CLIs - Claude Code, Codex, Antigravity and Muse Code - in their own terminal UIs, in the folders and worktrees of a Facade window, run as processes: each has a PID, a parent and children, and the person is PID 1. An agent starts children beside it or in a worktree of their own, lists them, and ends them, through Facade's MCP server. The design is `facade-code-spec/AGENT-FRAMEWORK.md`.

## The switch

```
facade.orchestration.enabled
```

On by default. Off, this extension listens for no agent, writes nothing under `~/.facade/workspaces` and launches no agents.

## Settings

Ten settings. Shown to everyone: the switch, and where each CLI is - `facade.orchestration.<cli>.path` for `claude`, `codex`, `antigravity` and `muse`. For whoever asks for advanced settings: `facade.orchestration.timeout`, how long Facade waits for a new agent to come up and an agent waits for the window, and each CLI's `launch` - its arguments group by group, what Facade sets in its environment, how it is given the person's trust, Claude Code's settings, and two typing delays. A launch holds only what you change: in settings.json, pick a part inside its braces and completion fills in Facade's own, for you to change; `null` takes one of Facade's out. **Facade: Show Agent Launch** shows what each CLI is started with now. A change applies to the next agent started. `facade-code-spec/AGENT-FRAMEWORK.md`, 1.9, has them all.

## What it does

- **Facade: Start Agent** starts an agent CLI in the folder on screen, on the model and at the effort the person types, with a first message if they give one. It runs in its own UI, in a terminal held under the folder's row of the workspace bar, called `@<name> (<pid>) · <CLI>`, its name its worktree's: `main` for a repository's own checkout, a worktree's branch otherwise.
- **Full access.** Every CLI starts at full access - every command and edit without asking, outside any sandbox - and nothing asks the person first: an agent works with nobody at the keyboard. In the worktrees Facade makes, and nowhere else, Facade also gives the CLI the person's trust, so that it does not stop to ask about the folder. Both are parts of a CLI's launch, which the person can change.
- **Facade's MCP server**, which each agent's CLI starts, gives it three tools: `spawn` starts a child - beside it, in a worktree of its repository, or in a new worktree on a branch of its own - on a model and at an effort the CLI takes, and answers with its PID once it is up; `ps` lists the agent, its parent and its children, with their states; `kill` ends one of its children. A failure says what is wrong and what would be right. Facade passes the model and the effort to the CLI as they are: the CLI is the one that knows which it has.
- **What Facade knows of a process** is only what is certain: it is starting, running once its MCP server said hello, or exited - its CLI ended, it was killed, or it did not come up within the timeout, two minutes by default - with how and why. Whether a running agent works or waits, its terminal and its worktree show. The children of an agent that exits are the person's from then on, and the person is told; so are they of a child of theirs that exited without their doing.
- **What goes into a folder** for an agent - its MCP server, Facade's skill - for a CLI that reads them from there, is taken back once no agent runs there: what nobody changed meanwhile is as it was, byte for byte, and a file of the person's own that held Facade's part is theirs again, any change of theirs kept.
- **Across a reload**, and a folder window becoming a workspace, the agents keep running: the record of a workspace's processes, the pipe's name and their terminals' process ids sit under `~/.facade/workspaces/<first folder>-<hash>/`, not in the extension's storage. The window that comes back finds each process again; one whose terminal is gone has exited.
- **One window at a time** has a workspace's agents. Another window on the same workspace says so, and starts none.
- **Facade: Show Agents Log** shows what Facade did: each launch, each exit, and why.

## Known limits

- Tested live on Windows only. The code paths for macOS and Linux have their unit tests, but are not claimed to work there.
- Agents run at full access: an agent can read and change anything the person can.
- A model or an effort a CLI does not have is the CLI's to refuse: some refuse it as they start, some only at their first step, in their terminal, and some take a level of their own.
- Agents do not message each other yet: a child is given a task it can finish on its own, and its result is in its worktree.
- After an app restart the agents' terminals are gone with the app: the window that comes back records their processes as exited.
- A window that cannot take back the pipe its running agents call - the window before still holding it after the timeout - listens on a new one, and the person is told that those agents cannot use Facade's tools any more.

## Layout

Seven layers, a folder each, with imports only pointing down (`facade-code-spec/AGENT-FRAMEWORK.md`, Code):

- `src/host/` is the only layer that imports `vscode`: the service that puts the layers together, the settings, Start Agent, Show Agent Launch, and the ports.
- `src/contract/` is what the model sees: the tools, their arguments, the result text, the error codes and the instructions.
- `src/core/` is Facade itself: spawn, ps, kill and exits, the files put into folders, and the ports through which it asks the window for things.
- `src/record/` is what a workspace keeps on disk: the ledger of its processes, their tokens, and where records are.
- `src/clis/` is how each agent CLI is found, launched at full access, and given the person's trust.
- `src/transport/` carries a call from an agent's CLI to the window and back: the shim, MCP over stdio, and HTTP over a named pipe.
- `src/base/` is what any layer may use: files written in one step, locks every window takes, waits.
- `src/extension.ts` turns the service on and off with the switch.

`src/test/` has a suite per layer, with fakes for the ports and a clock the tests move, and `layers.test.ts`, which reads every import and holds the code to these rules.
