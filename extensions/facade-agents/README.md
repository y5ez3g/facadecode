# Facade Agents

**Notice:** This extension is bundled with Facade Code. It can be disabled but not uninstalled.

Coding agents' CLIs - Claude Code, Codex, Antigravity, Muse Code, and the person's own custom agents - each in its own terminal UI, in the folders and worktrees of a Facade window. Each agent has a name and a number, as `@claude #a1`, the person or agent that started it, and a tree: the agent the person started that it comes from. Through Facade's MCP server an agent starts, lists and stops other agents. The design is `facade-code-spec/AGENT-LAUNCHER.md` (L1-L16) and `facade-code-spec/AGENT-ORCHESTRATION.md` (O1-O13).

## What it does

- **One click, no questions.** The agent menu, on the title bar's agent button, lists the built-ins this machine has and the person offers, then their custom agents. Choosing one starts it at once in the folder on screen, named after its CLI's id or the custom agent's name, with the CLI's own model and effort and no task. Its tab reads `@claude #a1`, then the CLI's own title before that. **Agents: Start Agent...** asks only which agent. In Restricted Mode, VS Code's own trust question comes first.
- **YOLO** (`facade.agents.yolo`, on by default). On, an agent's CLI runs with its sandbox off and asks for nothing. Off, its sandbox is on where it has one, and it asks before its own commands and edits - never before a call of Facade's tools; a CLI that cannot let Facade's server alone through asks for nothing, its sandbox still on. An agent keeps the YOLO it started with, and the agents it starts take it. With YOLO off an agent reaches only its own tree.
- **Trust.** Wherever an agent starts, its CLI is given the person's trust in the whole repository - every worktree - or in the folder outside one, so that it does not stop to ask.
- **Facade's tools.** `start_agent` starts an agent - in any folder of the window, or a new worktree on a branch named after it - on the model and effort given, else the CLI's own; a task is kept as a message (`#m1`), and the CLI is told where to read it. `list_agents` lists the caller, its creator and the agents it started, or every agent it reaches, with the CLIs it can start. `stop_agent` stops an agent it reaches, and with `delete_worktree` deletes its worktree, refusing while work would be lost unless told `discard_changes`. No call asks anyone; a failure says what is wrong and what to do.
- **What Facade knows** is only what is certain: an agent is starting, running, stopping, or ended - exited, stopped, failed or lost - with how, by whom and with what exit code. Whether a running agent works or waits, its terminal and its worktree show. The person is told of an agent of theirs that ends unexpectedly: an exit code other than 0, or 130 from the keyboard, or a stop by an agent.
- **Lifetime.** Closing an agent's tab stops it. A reload keeps the agents running; quitting, closing the window or opening another workspace ends them, and they are never run again. An agent's terminal can move between the panel, the editor area and floating windows of its window, never into another.
- **The agent framework's switch** (`facade.orchestration.enabled`, on by default) takes away only what agents do to agents: off, every tool call answers at once that it is off, and new launches get no MCP server, skill or file; the person's agents start, run and end as ever.
- **What goes into a folder** for a CLI that reads its MCP server or skills from there is merged beside what the folder has - a file git tracks shows the change in `git diff` while agents use it - and taken back once no agent there may run: what nobody changed is as it was, byte for byte.
- **Agents: Show Agents Log** opens the workspace's `agents.log`, each start and end, kept for good. **Agents: Show Agent Launch** shows what each agent is started with now: the program, its launch, its sandbox with YOLO on and off, whether Facade's tools are asked for, and the trust it gets and where.

## Settings

Three groups. **Agents**: `facade.agents.yolo`, `facade.orchestration.enabled` and, for whoever asks for advanced settings, `facade.agents.timeout` (seconds, 1-3600). **Each built-in** (`claude`, `codex`, `antigravity`, `muse`): `facade.agents.<cli>.enabled`, `.path`, and, advanced, `.launch` - its arguments group by group (`warmUp`, `connect`, `quiet`, `questions`, `messages`, `yoloOn`, `yoloOff`, `model`, `effort`, `extra`, `task`), environment, trust, Claude Code's settings and two delays. A launch holds only what you change; `null` takes one of Facade's parts out. **Custom Agents**: `facade.agents.custom`, `{ "<name>": { "path": "...", "launch": { ... } } }`, whose launch has the same parts and none of Facade's: `${mcpConfig}` names a file with Facade's server for its `connect` group.

## Known limits

- Messages between agents, reading another agent's screen and typing into it belong to AGENT-MESSAGES.md and AGENT-DEBUGGING.md, which are still to be written: until then a task reaches an agent as a message file whose path its CLI is given.
- Whether Muse Code and Antigravity can let Facade's server alone through with YOLO off, and how the CLIs' sandboxes behave with it off, are still to be measured: until then those two ask for nothing with YOLO off.
- Tested live on macOS with Claude Code and Codex; Windows and Linux have their unit tests.

## Layout

Seven layers, a folder each, with imports only pointing down (`facade-code-spec/AGENT-LAUNCHER.md`, L8):

- `src/host/` is the only layer that imports `vscode`: the service that puts the layers together, the settings, Start Agent, Show Agent Launch, and the ports.
- `src/contract/` is what the model sees: the tools, their arguments, the result text, the error codes and the instructions.
- `src/core/` is Facade itself: starting, listing and stopping agents, their reach and ends, the files put into folders, and the ports through which it asks the window for things.
- `src/record/` is what a workspace keeps on disk: the ledger of its agents, their tokens, task messages, the log, and where records are.
- `src/clis/` is how each agent CLI - and each custom agent - is found, launched with its YOLO, and given the person's trust.
- `src/transport/` carries a call from an agent's CLI to the window and back: the shim, MCP over stdio, and HTTP over a named pipe.
- `src/base/` is what any layer may use: files written in one step, locks every window takes, waits.
- `src/extension.ts` starts the service, and registers the commands.

`src/test/` has a suite per layer, with fakes for the ports and a clock the tests move, and `layers.test.ts`, which reads every import and holds the code to these rules.
