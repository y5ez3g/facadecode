# Facade Agents

**Notice:** This extension is bundled with Facade Code. It can be disabled but not uninstalled.

The person and the coding agents in a Facade workspace work together through twelve primitives (L2-PLAN, milestone 1):

```
identity   whoami, who
messages   send, recv, join, leave
notebook   read, write, list
agents     spawn, stop
IDE        ide
```

Every agent Facade starts gets them as the tools of an MCP server named `facade`; the person is the participant `@you`. How a team runs - who leads, how work is split, checked and merged - is not built in: it is written in seven skills (`team`, `work`, `review`, `supervise`, `notebook`, `resume`, `etiquette`), kept as `protocol/<skill>` pages in the notebook, given to every Claude as a plugin, and pointed to by the server's instructions.

Nothing runs unless `facade.orchestration.enabled` is on.

## How it fits together

- `src/common/kernel/` imports nothing from `vscode` and runs under plain mocha:
  - the workspace's ledger (`~/.facade/workspaces/<name>-<hash>/ledger.jsonl`, one event per line, appended only) and the state it replays into;
  - the notebook, one Markdown file per page under `notes/`, with versions, authors, conditional writes, and a notice to whoever read a page when someone else changes it;
  - the MCP tools and the window's end of the pipe;
  - `spawn` and `stop` through each vendor's adapter: every agent is its own interactive UI in a terminal under its folder's row, and the questions it asks as it starts (trust this folder, these hooks) are answered once the person let Facade answer them;
  - delivery: an idle agent gets one line typed into its terminal, only between turns;
  - the process skills.
- `src/shim.ts` is Facade's helper process, run under `ELECTRON_RUN_AS_NODE`: each agent's MCP server, which forwards every call to the window over a per-window named pipe, and the handler of agents' command hooks. Its `run` mode is the first pass's, for the program engine's headless workers.
- `src/host/` connects it to the window: terminals, the git extension, the person's trust decisions, and the `ide` tool.
- `src/common/engine.ts` and the files around it are the program engine of the first pass (steps 20 to 25). The window no longer starts it; it goes once that pass is committed (step 33).

A script can act as the person: `window.json` next to the ledger names the pipe, and `you.token` holds @you's token, readable only by the user.

## Not yet

- The workbench's `_facade.*` commands behind parts of `ide` (step 31) and the views (step 32).
- Claude's cross-session inbox as a way to wake an idle Claude: it needs the session's messaging token, which the credential rule of L2-PLAN keeps Facade from reading.
- Live runs of Antigravity, Muse and Grok as participants.

## Tests

Compile with `npm run gulp compile-extension:facade-agents` from the repository root, then run `npm test` here.
