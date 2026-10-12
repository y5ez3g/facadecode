# Agent Test Plan

The acceptance test of stack 31 - `main..feature/31-agent-tool-names`, 15 commits,
at `ef4fe66c` - against [AGENT-LAUNCHER.md](AGENT-LAUNCHER.md) (L1–L16) and
[AGENT-ORCHESTRATION.md](AGENT-ORCHESTRATION.md) (O1–O13), on this Mac.

It has a black-box part (Part B: what the person and an agent do, and what they must
then see) and a white-box part (Part C: every branch, wait and write of the changed
code). Results go into `AGENT-TEST-RESULTS.md`, one line per case: passed, failed or
not run, with its evidence.

## 0. What passing this plan establishes

A bug is a difference between what the person or an agent observes and what the
specifications promise. It can only hide in one of five places, and each part of the
plan closes one of them:

| Where a bug hides | What closes it |
| --- | --- |
| A situation nobody wrote an expectation for | B0 lists every dimension of the situation and every event. Each class of each dimension, each interacting pair, and each lifecycle phase × event has a written expectation (Part B) |
| A situation the specifications treat as one class but the code splits | Every branch of the changed code is executed by some case: branch coverage of the diff, 100% or each gap justified (C1, C2) |
| A timing: an event landing between two steps | Every `await` on the start, stop, reconcile and injection paths has each disruptive event injected at it (C4) |
| A side effect nobody looked for | The global checks G1–G15 run after every step of every case, whatever the case is about (A3) |
| A test that cannot fail | Seeded faults in the critical predicates must each be caught by some case (C5) |

The two bugs the person found on 2026-10-08 show why all five are needed. An agent's
new worktree joined the workspace, turning a single-folder window into a workspace
(P-1), and Facade then lost every running agent (P-2). P-2 is a cell of B8 and B9 -
any run × the window changing kind - caught by G2, G4 and G11 wherever the window
changes kind; its cause, the record's id kept in workspace storage that VS Code does
not carry into a workspace, is a write site of C3's I-1 (X-01). P-1 is caught by G1
in every case that makes a worktree, and C-WB-01 records which caller joined it.

Where the specifications are silent, Part B derives the expectation from them and
from VS Code's behaviour, and marks it ◇ with its reason. Nothing here waits on a
decision by the person. What this plan cannot establish is listed in section D.

# Part A: Method

## A1. The test instance

- **Build.** The dev build of `ef4fe66c` (later, of the fix commits), checked fresh:
  `out/` and `extensions/facade-agents/out` newer than every changed source file,
  and the `transpile-client` and extension compile run if not.
- **Its own instance.** `./scripts/code.sh --user-data-dir <scratch>/e2e-profile
  --extensions-dir <scratch>/e2e-extensions <folder>`. The profile's only user
  settings are `"window.title": "E2E ${separator}${rootName}${separator}${activeEditorShort}"`, so that every
  screenshot shows it is the test window, and those a case sets.
- **Hands off the person's windows.** The installed Facade Code (PID 73351) and the
  trial window on `~/facade-trial/lab` (PID 1745) are never clicked, typed into,
  reloaded or ended. Before every computer-use action, the frontmost window's title
  must start with `E2E`; if it does not, the step stops (the dev build and the
  installed app share one bundle id, so computer use cannot tell them apart).
- **Record.** The test instance's records live under the real `~/.facade/workspaces/`,
  keyed by its own workspace ids; at the end, exactly the ids it made are removed
  (section E4).

## A2. Drivers

| Driver | What it does | Used for |
| --- | --- | --- |
| UI | Computer use on the real screen: clicks, keys, typing into terminals, native dialogs; a screenshot after each step | Everything the person does |
| LIVE | A real CLI - Claude Code, Codex, Muse Code, Antigravity - logged in, given a plain-language request typed into its terminal | What only a real CLI shows |
| FAKE | The fake CLI (A6) as an agent: tool calls typed into its terminal, or written to its control file | The tool contract's input space, timings and failures, without quota |
| HUMAN | `facade-human <tool> <json>`: the shim run with the workspace's `you.token`, as `@human` | The person's scripts |
| PROBE | Shell reads between steps: `ps`, `lsof`, `git`, file hashes, the record | The global checks and file expectations |
| DEBUG | dap-cli attached to the test instance's extension host and renderer (the `launch` skill's ports): breakpoints at named lines | White-box interleavings (C4) only |

A step's expectation never relies on a driver's own report alone: a tool result is
checked against the window (UI), the processes and the record (PROBE).

## A3. Global checks, after every step

`e2e-check` snapshots the state before a step and compares it after. A difference
the step does not expect fails the case, whatever the case is about.

| ID | Check | How |
| --- | --- | --- |
| G1 | The window's kind and folders are unchanged - a single-folder window stays one, a workspace keeps its folders - unless the step is the person's own folder change | Title bar and Explorer header (UI); the profile's workspace storage entry for the window (PROBE) |
| G2 | The extension host keeps its process, unless the step reloads or restarts it, kills it, changes the window's kind or changes a workspace's first folder | `ps`: the test instance's extension-host process id |
| G3 | Every tool call of the step got exactly one answer, within the timeout plus 5 s. Exceptions, where O5 and O8 allow no answer: a call whose caller ended in the step (a self-stop, the deletion of its own worktree) and a call cut by the step's own reload, restart, crash or quit - those get the shim's `unknown` answer, or none if their CLI ended, and the record has exactly one outcome for each | The fake's printout; the CLI's tool output; the shim's stderr; the ledger |
| G4 | Agreement, by phase: every run the record has in launching_cli, connecting, running or stopping has exactly one agent tab and a live process at the pid it holds; a run in validating, creating_worktree or running_setup has none (its setup terminal is an ordinary one); no agent tab without a run; the button's count = the runs starting, running or stopping | The ledger (PROBE); `list_agents all` as `@human` while the framework is on; UI |
| G5 | No agent's action changed the focused part or terminal, the active editor, the selected bar folder or the panel's visibility | Screenshot before and after (UI) |
| G6 | User settings and every workspace's settings are byte-identical, unless the step sets one | Hashes |
| G7 | Project folders hold Facade-owned files only while a live run of a CLI that needs them is there (Codex's skill, Muse Code's and Antigravity's files, O10); `runs/` holds files only for live runs; each fixture repository's `git status` and `git worktree list` are what the step expects | PROBE |
| G8 | Exactly the notifications and dialogs the step expects; none from an agent's action | UI |
| G9 | `ledger.jsonl` parses; `agents.log` has the step's lines; no token's text in `agents.log`, the ledger, a tool result, Show Agent Launch or the Facade Agents output | PROBE, grep for each live token |
| G10 | No new error in the Facade Agents output, the extension host's log or the renderer's console, unless the step expects one | PROBE |
| G11 | No orphan: no CLI process of this window without a run, no shim waiting for a window ("Waiting for Facade's window"), no run whose terminal is gone while its process lives | PROBE |
| G12 | CLI configuration: `~/.codex/config.toml` and Muse Code's files byte-identical; `~/.claude.json` and Antigravity's `settings.json` changed only by the expected trust entries | Hashes; a JSON diff of the two |
| G13 | Numbers: every `#aN` the step allocated is greater than every earlier one in this record | Ledger |
| G14 | The step took no longer than its expectation says: a start from the menu shows its terminal within 2 s; a refused call answers within 2 s; a disabled framework within 1 s | Timestamps |
| G15 | Every tool result's text and structured data carry the same facts; every error has its code, the reason and the next step | The fake's printout; the CLI's tool output |

## A4. Evidence

For each case: the screenshots, the tool results (text and structured data), the
case's lines of `agents.log` and `ledger.jsonl`, `ps` of its processes with
arguments, environment names and folder, and the `e2e-check` diff, under
`~/facade-e2e-results/run-<n>/<case>/` - kept after cleanup, outside the repository.
Tokens are redacted to their first four characters wherever evidence is kept.

## A5. Fixture

Disposable, under `~/facade-e2e/`. Short names are used in the cases.

| Name | Path | Content |
| --- | --- | --- |
| A | `e2e-alpha/` | Git, 3 commits on `main`; `.gitignore` ignoring `.env` and `*.secret`; `.env` present (so ignored); `.worktreeinclude` naming `.env`; a subfolder `pkg/` |
| Af | `e2e-alpha-feature/` | Worktree of A on branch `feature`, one commit ahead |
| Ad | `e2e-alpha-detached/` | Worktree of A at `main~1`, detached |
| B | `e2e-beta/` | Git, 2 commits; a tracked `.mcp.json` with an unrelated server `other` |
| E | `e2e-empty/` | `git init`, no commit |
| N | `e2e-plain/` | Not Git |
| O | `odd dir/ünï "q"/` | Git, 1 commit: a space, a double quote and non-ASCII in its path |
| S | `e2e-alpha/pkg` | A's subfolder, opened as a folder of its own |
| L | `alpha-link` | A symbolic link to A |
| W2 | `e2e.code-workspace` | A saved workspace of A, B, N and O |
| bin | `bin/` | The fake CLI; links to the real CLIs for the PATH cases |
| home | `home/` | Copies of configuration files for the malformed-file cases |

Window kinds: **W0** a window with no folder; **W1:X** folder X opened on its own;
**W2** the saved workspace; **W3** W1:A after the person's Add Folder of B (an
untitled workspace). Unless a case says otherwise it runs in W1:A, with default
settings, after its fixture is reset (`git reset` of the fixture repositories is
done by recreating them, never in the person's repositories).

Agent worktrees go where the product puts them: `~/.facade/worktrees/<repository>/<name>`.

## A6. The fake CLI

`bin/fake-agent`, configured as custom agents in `facade.agents.custom`, in this
order:

| Custom agent | Launch groups | Behaviour, from its environment |
| --- | --- | --- |
| `fake` | connect, task, model, effort | Connects at once |
| `fake-late` | connect, task | Connects after 20 s |
| `fake-never` | connect, task | Never connects |
| `fake-exit3` | connect | Exits with code 3 at once |
| `fake-slowstop` | connect | Ignores hang-up, termination and interrupt for 30 s, then exits |
| `fake-bare` | none | No Facade connection at all |
| `fake-notask` | connect | No task group |
| `fake-nomodel` | connect, task | No model or effort group |
| `myclaude` | none | Path: the real `claude` |
| `ghost` | none | Path: `/nonexistent/ghost` |

It prints its arguments, folder and Facade's environment, connects as an MCP client
to the server its `--mcp-config` names, and runs each line typed into its terminal
or appended to the file `FAKE_CONTROL` names: `call <tool> <json>` (prints the text,
`isError` and structured content), `list`, `instructions`, `exit <code>`,
`disconnect`, `connect`, `title <text>`, `env [NAME...]`, `cd <dir>`. Typing and
the control file give the same calls; FAKE cases use the control file, and UI-01
checks once that typing gives the same.

# Part B: Black box

Each case reads: **Given** a state, **Do** an action, **Expect** what must then be
observable. The global checks (A3) apply to every step on top of the Expect column.
"Ask «…»" means typing that request, in plain words, into a real CLI's terminal;
`call` is a FAKE tool call; `human` is a HUMAN call.

## B0. The model

The situation a step happens in is the combination of these dimensions. Each row's
classes are the ones the specifications - or, marked ◇, the code (C2) - treat
differently.

| Dimension | Classes |
| --- | --- |
| Window | W0 no folder; W1 single folder; W2 saved workspace; W3 untitled workspace; Restricted Mode on any of them |
| Folder | Main checkout (A, B); worktree in the workspace (Af in W2); worktree only on the bar (an agent's new one); detached worktree (Ad); repository without a commit (E); not Git (N); odd path (O); a repository's subfolder (S) ◇; a symbolic link (L) ◇ |
| Initiator | The person by the button, by Cmd+Alt+A, by Start Agent...; an agent with YOLO on; an agent with YOLO off; `@human` |
| CLI | Claude Code; Codex; Antigravity; Muse Code; each custom agent of A6; a disabled built-in; a built-in not installed |
| Switches | YOLO on/off at the launch; framework on/off; persistent sessions on/off |
| Arguments | model, effort, task: absent / ordinary / odd text / at the size limit; folder: absent / path / branch; new_worktree |
| Run phase | validating; creating_worktree; running_setup; launching_cli; connecting; running, connected; running, disconnected; stopping; ended |
| Terminal place | Panel in front; panel behind; editor area; floating window; one side of a split |

Events that can happen in any situation:

| Source | Events |
| --- | --- |
| Person, on a terminal | Close the tab (confirm, cancel); rename; move; split; Detach Session; attach from another window; Relaunch; an environment change that offers relaunch; drag to another window; Ctrl+C; type |
| Person, on folders | Select a folder; Add Folder (W1 becomes W3); remove a folder; Delete Worktree on the bar; Save Workspace As; open another folder or workspace in the window; open the same folder in a second window |
| Person, on the window | Reload; Restart Extension Host; close the window; quit; force quit; renderer crash and Reopen |
| Person, on settings | YOLO; framework; timeout; a CLI's enabled, path, launch; custom agents; terminal environment; persistent sessions; close confirmation |
| Agent | `start_agent`; `list_agents`; `stop_agent` with and without `delete_worktree`, `discard_changes`; its CLI sets a title, changes directory, exits (0, nonzero), is killed; its MCP server is killed or reconnects |
| Outside | A process killed by pid; a file made immutable; the ledger damaged; the record's lock held; git's lock held |

Coverage rule: every class of every dimension appears in at least one case; every
pair of classes from different dimensions that the specifications relate (marked in
the case groups below) appears together; every run phase meets every event in B8;
every window event meets a full population of agents and calls in flight in B9.

## B1. Casual use (CU) - run first

What the person does in their first minutes, with real CLIs, in a folder opened on its
own. These run before anything else; each one that fails is a blocker.

| ID | Given | Do | Expect |
| --- | --- | --- | --- |
| CU-01 | W1:A | Click the agent button; choose Claude Code; ask «what is 1+1» | The terminal opens in the editor area, its folder's (D17, decided 2026-10-12 by Claude, for the person's review), within 2 s, focused, tab `@claude #a1`; then the CLI's title with the suffix; it answers; no question of any kind (trust, onboarding, tips, permission) |
| CU-02 | W1:A | CU-01 with Codex, Antigravity and Muse Code in turn | As CU-01; Antigravity shows its warm-up reply, then its prompt; numbers `#a2`–`#a4` |
| CU-03 | W1:A; a Claude Code root | Ask «use Facade to start a Codex agent named t1 in a new worktree, and have it write the current time into time.txt there» | The root reports started, `#a2`; the child's tab exists behind the root's, which keeps focus; `~/.facade/worktrees/e2e-alpha/t1` on branch `t1` appears on the bar, not selected; **the window is still W1:A** (G1) and the extension host kept its process (G2); `time.txt` appears in the worktree |
| CU-04 | W1:A; a Claude Code root | Ask «start one Claude Code, Codex, Muse Code and Antigravity agent, each in its own new worktree, with default model and effort; each writes the current time into time.txt» | Four children started, each in its own worktree, each `time.txt` written; every call answered; window still W1:A; extension host unchanged; the button counts 5; the root's «list all agents» shows 5 running |
| CU-05 | After CU-04 | Ask «stop the four and delete their worktrees»; then «stop the four and delete their worktrees, discarding their changes» | First: refused for each, naming `time.txt` as uncommitted work; every child still running. Second: all four stopped and their worktrees removed, branches kept; nothing waits |
| CU-06 | W1:A | CU-03 to CU-05 with Codex, Muse Code and Antigravity as the root | As there, for each root |
| CU-07 | W1:A; root and four children of CU-04 | The person: Developer: Reload Window; then asks the root «list all agents», then «stop t2» | The five terminals come back in their places with the same processes and titles; the list shows the five running and connected; t2 stops |
| CU-08 | As CU-07 | The person: File > Add Folder to Workspace..., B | The window becomes an untitled workspace (the person's action) and its extension host restarts. Afterwards the same record: all five listed, connected, callable; ask the root «start a Claude Code agent in e2e-beta, then list all agents» - it starts in B and the list shows six; no call waits for a window (G11) |
| CU-09 | After CU-08 | The person: Save Workspace As `~/facade-e2e/w3.code-workspace` | As CU-08: the same record, every agent callable |
| CU-10 | W1:A; root and a child | The person closes the child's tab | No confirmation at the default setting; the child ends, stopped by `@human`; no notification; the root's list shows it ended |
| CU-11 | W1:A; root and children | The person quits the app (Cmd+Q, confirming as VS Code asks), starts it again, opens A, starts Claude Code | Every agent process ended at quit; nothing started again on reopening; the new agent's number is above every earlier one; the list shows only it; Show Agents Log has the earlier history |
| CU-12 | W1:A | The person starts Claude Code and Codex; asks Claude Code to start a child t1; asks Codex «list all agents, then stop t1» | Codex sees all three and stops t1 |
| CU-13 | W1:A; YOLO off | The person starts Claude Code; asks it to start a Codex child in a new worktree that writes hello.txt, then to write a file in `~/facade-e2e/outside` | No approval asked for any Facade call; the child writes `hello.txt`; the outside write is asked for or blocked by the CLI's sandbox |
| CU-14 | W2 | The person starts Claude Code in A; asks «start a Claude Code agent in e2e-beta and a Codex agent in e2e-plain» | Each child in its folder; the bar selection, focus and editors unchanged; both rows show their logos |
| CU-15 | W1:A; root with a child in a new worktree | Ask the root «stop yourself» | The root ends, stopped by itself; the child runs on and stays listed |
| CU-16 | W1:A; a child in worktree t1 | The person: Delete Worktree on t1's bar row | VS Code's own confirmation; confirmed: the child stopped by `@human`, the worktree removed |
| CU-17 | W1:A; agents running | The person turns YOLO off; starts Claude Code | The running agents keep YOLO on (Show Active Agents..., `list_agents`); the new one is off |
| CU-18 | W1:A; a root typing a long request | While the person types into the root, the root starts two children (asked earlier) | The person's typing is never interrupted, the root keeps focus, nothing else comes in front |
| CU-19 | W1:A | In an ordinary terminal, the person runs `claude`, then `codex` | Neither is an agent: not counted, not listed; no Facade tools in them; no message from Facade |
| CU-20 | W1:A; a root running | The person turns the framework off; asks the root «list all agents»; starts Codex from the menu | The root's call is refused at once, saying the framework is off; Codex starts as a plain CLI, without Facade's tools; the button counts both |
| CU-21 | W1:N (not Git); W1:Af; W1:L; W1:S | CU-01 and CU-03 in each | CU-01 as there. CU-03: in N refused, saying a worktree needs a Git repository, nothing made; in Af based on Af's HEAD; in L and S ◇ as for A (the repository of the folder) |

## B2. The person's starts (PS)

Every CLI in every folder class, and every entry point in every window kind: PS-02
is these 44 starts (M the menu, K Cmd+Alt+A, P Start Agent...).

| Folder | Window | Claude Code | Codex | Antigravity | Muse Code |
| --- | --- | --- | --- | --- | --- |
| A, main checkout | W2 | M | K | P | M |
| Af, worktree in the workspace | W2 | K | P | M | K |
| A worktree only on the bar | W2 | P | M | K | P |
| Ad, detached | W2 | M | K | P | M |
| B, second repository | W2 | K | P | M | K |
| N, not Git | W2 | M | K | P | M |
| O, odd path | W2 | K | P | M | K |
| E, no commit | W1:E | P | M | K | P |
| S, subfolder | W1:S | M | K | P | M |
| L, symbolic link | W1:L | K | P | M | K |
| B, after Add Folder | W3 | P | M | K | P |

| ID | Given | Do | Expect |
| --- | --- | --- | --- |
| PS-01 | W1:A | Start each built-in from the menu | Terminal within 2 s, focused, in the editor area - its folder's (D17, decided 2026-10-12 by Claude, for the person's review); tab `@<id> #aN` (`claude`, `codex`, `agy`, `muse`) and the CLI's logo; folder A (`lsof -p` cwd); no model, effort or task argument (`ps`); `agents.log`: started, launched, connected, running |
| PS-02 | The matrix above | Each of its 44 starts, the folder selected on the bar first | Each in that folder (`lsof` cwd; L resolved as Facade records it), a new number, its logo, focused; no CLI question anywhere |
| PS-03 | W0 | Click the agent button; run Start Agent... | The menu offers the agents; choosing one says a folder must be opened; nothing starts, no record is made |
| PS-04 | W1:A in Restricted Mode (trust denied at open) | Choose Claude Code; deny the trust request | VS Code's own trust request; denied: no agent, terminal, record entry, project file or CLI trust change |
| PS-05 | As PS-04 | Choose Claude Code; grant trust | The same start continues once trust is granted: exactly one agent |
| PS-06 | W2; B selected on the bar; an editor of A focused | Choose Claude Code | Starts in B, the bar's selection |
| PS-07 | W1:A | Start Agent...; Escape | Asks only which agent, offering what the menu offers; Escape starts nothing |
| PS-08 | W1:A | Choose Claude Code twice within half a second | Two agents, consecutive numbers, two terminals; the second focused |
| PS-09 | W1:A, just reloaded | Choose Claude Code before the extension finished activating | It starts once, when ready; no "try again" message |
| PS-10 | W1:A; the folder A renamed away on disk ◇ | Choose Claude Code | A failure naming the missing folder; no agent, no terminal (L5: checks before allocation) |
| PS-11 | W1:A | Choose `ghost` (path missing); choose `fake-exit3` | `ghost`: the invalid path reported, nothing allocated. `fake-exit3`: one notification, failed with exit code 3, as an error; **Show** only while its terminal is still there (D14) |
| PS-12 | W1:A; `facade.agents.timeout` 5 | Choose `fake-late` | Terminal at once, usable; at 5 s one nonmodal notification with **Show**: the CLI is open, Facade has not connected; at 20 s it is running, with no second notification; **Show** reveals its terminal |
| PS-13 | W1:A | Choose `fake-bare` | Running as soon as its process starts; listed and counted |
| PS-14 | W1:A | Start Antigravity from the menu and type during its warm-up; `a1` starts Antigravity with a task while the person types into it | ◇ The person's text is never merged into Facade's lines; the task notice arrives whole, once |
| PS-15 | W2, A selected | Choose Claude Code, then at once select B on the bar | The window stays on B; the agent's terminal held for A |
| PS-16 | W1:A; Claude Code and Codex with model `no-such-model` (LIVE, by `human start_agent`) | Start | Started: a process, connected; the CLI's own error at its first request; the requested model recorded as given, not as working |
| PS-17 | Claude Code launch `extra: ["--no-such-flag"]` | Start from the menu | It exits at once: failed, with its exit code, one notification, as an error; **Show** only while its terminal is still there (D14) |
| PS-18 | Claude Code with an empty test `CLAUDE_CONFIG_DIR` (not logged in) | Start from the menu | A live process: running, or unconfirmed with the notification - not failed |

## B3. Agent starts (AS)

Run with `fake` as the caller (`a1`, started by the person in A) unless stated.
Every refusal must leave nothing: no number in the ledger's `started`, no terminal,
no worktree, no branch, no file, and answer within 2 s.

| ID | Given | Do | Expect |
| --- | --- | --- | --- |
| AS-01 | `a1` | `list` | Exactly `start_agent`, `list_agents`, `stop_agent` (the other five are section D); arguments, required ones and descriptions as O3, O5, O6 |
| AS-02 | `a1` | One call each: an unknown argument; `name: 5`; `cli: null`; `model: 5`; `effort: true`; `task: {}`; `folder: 1`; `new_worktree: "yes"`; `""` for each of name, cli, model, effort, task, folder | `INVALID` each, naming the argument and the rule; nothing made |
| AS-03 | `a1` | Names `a`, 40 letters, `a.b_c-d`, `7up`; then `""`, 41 letters, `Abc`, `-a`, `.a`, `_a`, `a b`, `ä`, `a/b`; then `human`, `you`, `me`, `facade`, `all`, `everyone`, `init`, `kernel`; then `a` again | The first four start; the next nine and the eight reserved names are `INVALID`, saying the rule; `a` again starts, a second `@a` with its own number |
| AS-04 | `a1` | `cli`: each built-in; `fake`; `nosuch`; Codex disabled (`facade.agents.codex.enabled: false`); `ghost`; a custom agent with an unknown launch key | Built-ins and `fake` start. `nosuch`: `INVALID`, listing the available ids. Disabled: `UNAVAILABLE` naming the setting (LA-02). `ghost`: `UNAVAILABLE` naming the path. Bad configuration: `UNAVAILABLE` naming the setting (LA-07; changed 2026-10-08 with the person: the caller's arguments are valid, the person's setting is not). The last four make nothing |
| AS-05 | `a1` | No `folder`; then `a1` runs `cd /tmp` and starts again; `human start_agent` with no folder while B is selected | `a1`'s children in A both times (the launch folder, not the CLI's directory); `@human`'s in B |
| AS-06 | W2; `a1` | `folder`: A; B; Af; a worktree only on the bar; `/tmp`; `A/pkg`; `e2e-alpha` (relative); a file's path; a path that does not exist | The first four start there. `/tmp`, `A/pkg`, the file: `REFUSED` (not a workspace folder or worktree), saying what to pass. Relative: looked up as a branch (O3: a folder is an absolute path or a branch), `NOT_FOUND`, saying a folder is given by its absolute path (changed 2026-10-08 with the person). Missing: `NOT_FOUND` |
| AS-07 | W2; `a1` in A | `folder` by branch: `feature`; `main`; B's `main` asked from A; the detached worktree's name; a branch checked out in two worktrees; a branch checked out nowhere | `feature`: Af. `main`: A. B's: `NOT_FOUND` (branches only of the caller's repository). Detached: `NOT_FOUND`, saying to name it by path. Two worktrees: `INVALID`, listing both paths, as any ambiguous reference (O2, ID-05). Nowhere: `NOT_FOUND`, listing the worktrees, not suggesting `new_worktree`, which makes a new branch (O3) (both changed 2026-10-08 with the person) |
| AS-08 | `a1` in A with an uncommitted edit to a tracked file | `new_worktree: true`, name `w1` | Branch `w1` at A's HEAD, without the edit; folder `~/.facade/worktrees/e2e-alpha/w1`; `.env` copied; on the bar, not selected, **not among the workspace's folders**; window kind unchanged (G1); ledger: folder, repository, branch, base commit |
| AS-09 | `a1` in Af | `new_worktree`, no folder | Based on Af's HEAD (the caller's checkout, same repository) |
| AS-10 | `a1` in A | `folder` B with `new_worktree` | Based on B's main checkout HEAD |
| AS-11 | `a1` in A | `new_worktree` with: an existing branch's name; `a..b`; `x.lock`; `a.`; folder E; folder N; then a name whose target folder already exists on disk | Each of the first six refused before anything is made, saying why and what to pass instead; no branch, folder or ledger entry. The folder on disk: started on the branch named as asked, its worktree at the path with `-1` (WORKTREE.md WT-2.3), the result saying the path was taken and where the worktree is (changed 2026-10-08 with the person) |
| AS-12 | `a1` | `fake` with model `m1`; effort `e1` alone; both; model `a b`, effort `"x"`; `fake-nomodel` with both | Each value one argument, exact (`ps`); applied values recorded. `fake-nomodel`: started, the result warns that model and effort were ignored; applied model and effort unknown |
| AS-13 | `a1` | Each built-in with model and effort; then effort alone (LIVE) | Each CLI's own argument form; applied values recorded; the CLI shows that model |
| AS-14 | `a1` | `fake` with a task `$(touch /tmp/x) "q" 'q' ünï $HOME`; each built-in with task «write ok into done.txt» (LIVE) | The task stored as `#mN` under `messages/`; the CLI gets the short notice naming that file, never the task's text as an argument; no `/tmp/x`; each built-in reads the task and writes `done.txt` - Antigravity's notice typed after its warm-up |
| AS-15 | `a1` | `fake-bare` with a task; `fake-notask` with a task; `fake-bare` without a task | The first two: `REFUSED` before allocation, naming the missing group. The third: started, listed, stoppable |
| AS-16 | `a1`; timeout 5 | `fake-late` | `unconfirmed` within 6 s: id, phase `connecting`, what was made, what to do next; nothing shown to the person; at 20 s that same id is running; no second run |
| AS-17 | `a1` | `fake-exit3`; `fake-never` with timeout 5 | `fake-exit3`: `failed`, exit code 3, the launch's diagnostics. `fake-never`: `unconfirmed`, phase `connecting`, its process alive |
| AS-18 | `a1` | Any start that succeeds, and one each of unconfirmed and failed | Each result has every field O3 names - id, name, creator, cli, requested and applied overrides, folder, worktree, YOLO, sandbox, connection capability and state, phase where there is one (an unconfirmed or failed start; none once started), task id - in the text and in the structured data (changed 2026-10-08 with the person) |
| AS-19 | The person typing in `a1`'s terminal, an editor open, A selected | `a1` starts children in A and in B | No change of focus, tab, editor, bar selection or panel (G5); the children's tabs behind the one in front |
| AS-20 | `a1` in A | Four `start_agent` with `new_worktree` in A sent at once | Four worktrees, four running children, four distinct numbers; no git lock error |
| AS-21 | `a1` in A | Two `start_agent` named `same` with `new_worktree`, at once | One starts; the other is refused because the branch exists, with nothing half-made |
| AS-22 | YOLO on; `a1` | `a1` starts `c1`; the person sets YOLO off; `c1` starts `c2`; reload | `c1` and `c2` YOLO on, before and after the reload |
| AS-23 | `a1` | `start_agent` with `yolo: false` | `INVALID`: no such argument |
| AS-24 | `a1` | `fake` with model `-x` and effort `--disable-sandbox`; model with a NUL; effort with a lone surrogate | `-x` and `--disable-sandbox` reach the CLI as values (`--model=-x` form) or are refused `INVALID` before allocation ◇ (L10: reject what cannot be preserved) - never read as an option; NUL and the surrogate `INVALID` |
| AS-25 | `a1`; A's setup `sleep 30`; timeout 10 | `start_agent` with `new_worktree` | `unconfirmed` within 11 s of the call (the timeout counts from acceptance, O9), phase `running_setup` |
| AS-26 | W2 with N deleted on disk | `a1`: `start_agent` with `folder` A, and with `folder` N | A: started. N: `NOT_FOUND` naming the missing folder - not a git error |
| AS-27 | `facade.workspaceBar.worktrees: false` | `a1` starts a child with `new_worktree`; later stops it with `delete_worktree` | Both work |
| AS-28 | `facade.terminal.followFolder: false`, the person's shell active in the panel | `a1` starts a child with `new_worktree` and a setup file | The child's and the setup's terminals behind; the active terminal unchanged (G5) |
| AS-29 | A's ignored `x.secret` added to `.worktreeinclude` and made unreadable (`chmod 000`); a failing `post-checkout` hook | `a1` starts a child with `new_worktree` | No notification for the person; the copy failure and the hook failure in the result |
| AS-30 | W2 plus a second repository also named `e2e-alpha` (`~/facade-e2e/other/e2e-alpha`) | `new_worktree` named `same` in both at once | Two distinct worktree folders; both start |
| AS-31 | `a1` | Each built-in without a task (LIVE) | At its input prompt; the person can type into it and it answers |
| AS-32 | A's setup writes `setup.txt` | `new_worktree` | The setup terminal behind, an ordinary terminal with the new worktree; the CLI launched after setup ended; the result says setup succeeded |
| AS-33 | A's setup `exit 7` | `new_worktree` | Failed before any CLI, with the setup's output and the worktree's path; worktree and branch kept |
| AS-34 | Shell integration off (`terminal.integrated.shellIntegration.enabled: false`) | `new_worktree` with a setup | Setup submitted, completion unknown - said in the result and in the child's start notice |
| AS-35 | `a1` in A; a first `new_worktree` start held in creating_worktree (the slow hook) | While a second start from `a1` waits its turn, commit in A; and while a third, into B, waits, check out another branch in B's main checkout | Each child's base is the commit its caller's checkout (or B's main checkout) had when its call was accepted (O3, O9) |

## B4. Identity, titles and references (ID)

| ID | Given | Do | Expect |
| --- | --- | --- | --- |
| ID-01 | Fresh record | Start Claude Code twice; end both; reload; start one; quit and start the app; start one; give two of them tasks | `#a1`, `#a2`, `#a3` after the reload, `#a4` after the restart - never a used number; tasks `#m1`, `#m2`, numbered on their own |
| ID-02 | A Claude Code agent | Watch its tab while the CLI sets its title, then changes it (LIVE), and `title Fix it` in `fake` | Before: `@claude #aN`. After: the CLI's title, the terminal's separator, `@claude #aN` ◇ (L3's `·` is an example; VS Code's separator is the convention); each change keeps the suffix |
| ID-03 | An agent | Terminal: Rename... its tab to `mine`; then `human stop_agent` by its number | The tab reads `mine` with the suffix `@claude #aN`; the stop finds it by number |
| ID-04 | Agents of each built-in, `fake`, `myclaude` | Look at their tabs and bar rows | Each built-in's logo; every custom agent the robot - `fake`, and `myclaude` though it runs the real `claude` (AGENT-LAUNCHER.md: "every custom agent uses the standard robot icon, whatever program it runs"; changed 2026-10-09 with the person) |
| ID-05 | `@lead #a1` running; `@w` running as `#a3` and ended as `#a2`; `@x` ended as `#a4`; an agent named `7` (`#a5`); `#a7` running | `call stop_agent` / `list` style lookups with: `#a1`, `a1`, `#1`, `1`, `@lead`, `@lead #a1`, `@lead #a2`, `@w`, `@x`, `#a2`, `7`, `#m1`, `@human`, `@nobody` | The first six find `#a1`. `@lead #a2`: `NOT_FOUND` (mismatch). `@w`: `#a3` (the only live one). `@x`: `NOT_FOUND`, listing `#a4`. `#a2`: the ended `@w`. `7`: `INVALID`, ambiguous between `#a7` and `@7`. `#m1`: `INVALID`, a message. `@human`: `INVALID`, not a target. `@nobody`: `NOT_FOUND` |
| ID-06 | YOLO-off caller in tree B; `@lead` in tree A only | `@lead` | `NOT_FOUND`, exactly as for an unknown name: nothing outside reach is revealed |

## B5. Listing (LS)

Trees: the person starts `r1`; `r1` starts `c1`, `c2`; `c1` starts `g1`; `c2` exits.

| ID | Given | Do | Expect |
| --- | --- | --- | --- |
| LS-01 | The tree | `c1`: `list_agents` | `c1`, its creator `r1`, its child `g1`; not `c2`, not other trees |
| LS-02 | The tree | `r1`: `list_agents` | `r1`, `c1`, the ended `c2`; not `g1` |
| LS-03 | The tree | `human list_agents` | The roots only |
| LS-04 | The tree | `list_agents all` from `c1` (YOLO on) and from `@human` | Every run of the window, ended ones included |
| LS-05 | The tree | The head of any list | Counts by lifecycle; the caller's identity and its reach |
| LS-06 | A running, an unconfirmed (`fake-never`) and an ended run | Their rows | Every O6 field: number, name, creator, root, lifecycle and phase, CLI, requested and applied model and effort (unknown where not observable), folder and branch, YOLO, sandbox, integration, connected, start time, task id; ended: end time, kind, actor, reason, exit code. No idle, busy or done |
| LS-07 | Any list | Its CLI list; then disable Codex, add a custom agent, put a new `codex` on the terminal's PATH (`terminal.integrated.env.osx`) | Each id with integration, task, model and effort capability; each change shows at the next call |
| LS-08 | `fake` running | `disconnect`; `list_agents all` from another agent; `connect`; list again | Running and not connected; then connected |
| LS-09 | Ended runs in the list | Reload; then quit and start the app | The reload keeps them; the fresh start leaves them out; the numbers go on |

## B6. Reach (RCH)

Tree A with YOLO on: the person starts `a1`, `a1` starts `a2`, `a2` starts `a3`.
Tree B with YOLO off: the person starts `b1`, `b1` starts `b2`, `b3`, `b4`; `b4` exits.

| ID | Given | Do | Expect |
| --- | --- | --- | --- |
| RCH-01 | Both trees | `a2`: `list_agents all`; stop `b2` | Both trees listed; `b2` stopped (on reaches off) |
| RCH-02 | Both trees | `b3`: `list_agents all`; stop `a1` by number, then by name | Only tree B, the ended `b4` included; `a1` by number `NOT_FOUND` or `REFUSED` without revealing it ◇ (same answer for both forms); by name `NOT_FOUND` |
| RCH-03 | Both trees | `b3` stops its sibling `b2`, its creator `b1` (the root), then itself | Each allowed |
| RCH-04 | Both trees | `@human` lists all and stops one agent in each tree | Allowed |
| RCH-05 | Both trees; `b1` ended | `b3`: `list_agents`; start a child | `b3` keeps root `b1` (ended); the child joins tree B, YOLO off |
| RCH-06 | Both trees | `b3`: `stop_agent` of `a3` with `delete_worktree` | Refused before anything is stopped |

## B7. Stopping and deleting worktrees (SP)

| ID | Given | Do | Expect |
| --- | --- | --- | --- |
| SP-01 | `a1` with a running child `c` | `a1` stops `c` | Answered once `c` ended: stopped, actor `a1`; ledger `stopping` then `ended`; `c`'s tab closed; no notification |
| SP-02 | `a1` | `a1` stops itself | The record has the stop, by `a1`, even if the reply never reaches it |
| SP-03 | An ended `c` | Stop it | Its recorded outcome; not an error |
| SP-04 | `fake-slowstop` | Two stops at once, by `a1` and `@human` | One stop; the second joins it; the first's actor and reason kept |
| SP-05 | `fake-late` connecting; `fake-never` | Stop each | Ended; no terminal or connection appears later |
| SP-06 | `a1` → `c` → `g`, `g` in another folder | Stop `c` | Only `c` ends; `g` runs on |
| SP-07 | Timeout 5; `fake-slowstop` in a new worktree | Stop it with `delete_worktree` | `pending` within 6 s, the worktree kept; Facade goes on stopping it, as the result says, and records the end without another call; then a second call deletes the worktree |
| SP-08 | Worktree `w` with two agents, one of them Muse Code (its project files untouched) | Stop one with `delete_worktree` | Both stopped; Facade's files released; `w` removed, its branch kept; the result lists both, deleted |
| SP-09 | YOLO-off caller; `w` also holds an agent of another tree | `delete_worktree` | Refused before anyone is stopped |
| SP-10 | `w` with a tracked change and an untracked file | Without, then with, `discard_changes` | Refused, naming both files, every agent still running; then deleted, branch kept |
| SP-11 | `w` with an unsaved editor of one of its files | Without, then with, `discard_changes` | Refused, naming the unsaved file; then deleted and that editor closed without saving |
| SP-12 | Muse Code in `w`, its `.mcp.json` untouched; then edited by the person | `delete_worktree` without discard | Untouched: deleted. Edited: refused as the person's work |
| SP-13 | Agents in A (main checkout) and in N | `delete_worktree` for each | Each agent stopped; nothing deleted, and the result says why; A and N intact |
| SP-14 | `w` with a file made immutable (`chflags uchg`) | `delete_worktree` | Agents stopped; deletion fails with git's reason and the folder left; after `chflags nouchg`, a call against the ended agent deletes it |
| SP-15 | `fake-slowstop` with `FAKE_WRITE_ON_EXIT` into `w` | `delete_worktree` | The file appearing after the preflight makes it refuse, as an error that lists the agents already stopped and the file; nothing deleted |
| SP-16 | A deletion of `w` in progress (SP-07's slow stop) | `start_agent` into `w` | Refused |
| SP-17 | `discard_changes: true` without `delete_worktree` | Stop | `INVALID`; nothing stopped |
| SP-18 | `w` holds an agent of this window and one of a second window (W1:A and W2 both use A's worktree `w`) | `delete_worktree` from the first | ◇ Refused while the other window's agent runs in it |
| SP-19 | Muse Code in `w` merged into an untracked `.mcp.json` of the person's | `delete_worktree` without discard | Refused before anyone is stopped, naming `.mcp.json` |
| SP-20 | `w` with agents | Two `delete_worktree` at once | One deletion, the second joins it; no start accepted into `w` until it is over |
| SP-21 | An ended agent whose worktree folder was removed by hand | `delete_worktree` | Its recorded outcome, and the folder reported gone - not a git error |
| SP-22 | W2 with Af as its first folder, an agent in Af | Another agent: `delete_worktree` of Af | The call answers with its outcome; the extension host's restart (the first folder changed) cuts no other call; every agent keeps working (I-1) |
| SP-23 | W1:Af, an agent in Af | Another agent: `delete_worktree` of Af | ◇ Refused, naming Af as the window's folder: deleting it would make an agent change the window's folders (O1); nothing stopped |
| SP-24 | `w` holds a submodule with an unpushed commit | `delete_worktree` without discard | Refused, naming the submodule |
| SP-25 | `w` with an unsaved notebook, and an editor of one of its files opened through `L` | `delete_worktree` without discard | Refused, naming both |
| SP-26 | `w` with an agent; its deletion held after the last check (DEBUG at `worktrees.ts:888` and at `terminalsInside`) | Meanwhile the person types into an open editor of a file in `w` without saving; then, held again, another program changes a file in `w` and Facade's own `.mcp.json` in it | ◇ The editor takes nothing while the deletion runs - read-only, saying why; nothing the person typed is lost; no save dialog appears. A change made outside the editor meanwhile refuses the deletion - git's own refusal of a worktree with changes, or a last check right before git removes it - and the worktree stays, its row back (decided 2026-10-09 by the person, D7) |
| SP-27 | Tree A (YOLO on): `x` registered in A, its CLI `cd`'d into `w`. Tree B (YOLO off): `b1` registered in `w` | `b2` stops `b1` with `delete_worktree`; then the same by a YOLO-on caller | ◇ The YOLO-off call is refused before anyone is stopped, naming `x` as working inside `w` beyond its reach. The YOLO-on call stops `x` too and lists it in the result - no terminal is closed that the result does not name |
| SP-28 | `y` registered in `w`, its CLI `cd`'d to `/tmp` | Its creator deletes `w` | `y` stopped (registered in `w`, O3) and listed; its terminal closed |

## B8. Lifecycle: every phase meets every event (LC)

A child of `a1` started with `new_worktree`, held in each phase:

| Phase | Held by |
| --- | --- |
| Φ2 creating_worktree | A `post-checkout` hook in A that sleeps 30 s |
| Φ3 running_setup | A's worktree setup `sleep 600` |
| Φ5 connecting | `fake-late`, or `fake-never` |
| Φ6 running, connected | `fake` |
| Φ7 running, disconnected | `fake` after `disconnect` |
| Φ8 stopping | `fake-slowstop` after a stop |
| Φ9 ended | `fake` after `exit 0` |

validating and launching_cli last milliseconds; their cells run in C4 with the
debugger. Each cell is one case, `LC-<event>-<phase>`, run with `a1` waiting on its
`start_agent` wherever the phase is before running. A dash means the event cannot
happen in that phase.

| Event | Φ2 creating_worktree | Φ3 running_setup | Φ5 connecting | Φ6 / Φ7 running | Φ8 stopping | Φ9 ended |
| --- | --- | --- | --- | --- | --- | --- |
| **stop** - `a1` stops it | Ended, stopped by `a1`; git's creation may finish; no setup, no CLI later; the worktree kept and named in the result | Ended, stopped; the setup terminal stopped; no CLI later; the worktree kept | Ended, stopped; its process gone; no later connection | Ended, stopped | Joins the stop in progress | Its recorded outcome |
| **close** - the person closes its tab | - | ◇ The setup terminal is an ordinary one: closing it ends setup; the start fails before the CLI with the setup's end and the worktree's path | Ended, stopped by `@human` | Ended, stopped by `@human` | Ends; the first stop's actor kept | - |
| **exit** - the CLI exits 0, 3, or is killed | - | - | Failed, with the exit code; `a1`'s call answers failed | Ended, exited, with the code; a notification only if the person started it and the code is nonzero | Ended, stopped, with the code | - |
| **caller gone** - `a1`'s CLI exits while it waits | The start goes on; the child starts and is recorded once, creator `a1` | Same | Same | - | - | - |
| **reply lost** - `a1`'s MCP server killed while it waits | No second launch; `a1`, reconnected, finds the run in `list_agents` | Same | Same | - | - | - |
| **framework off** | The start finishes or reports its partial outcome, once; switching back on makes no second copy | Same | Same; it may still connect | Running; its calls `UNAVAILABLE framework_disabled` at once | The stop finishes | Unchanged |
| **reload** (persistent sessions on) | Failed after the reload, the worktree reported if made; no CLI ever; `a1`'s call `unknown` with the id | Same; the setup terminal comes back as an ordinary terminal ◇ | The same process kept; it connects to the reloaded window and runs; `a1`'s call `unknown` with the id | The same process kept, reconnected; its next call works | The stop resumes and finishes | Kept in the list |
| **reload** (persistent sessions off) | As with them on | As with them on; the setup terminal ends | Ended with the reload, recorded; nothing relaunched | Same | Ended, stopped | Kept |
| **extension host restart** | ◇ Exactly one outcome: started, or failed with the worktree reported; no CLI appears after its run was ended | Same | The process kept; it connects; running | Kept; calls work after the restart, the CLI not restarted | The stop finishes | Kept |
| **folder → workspace** (the person's Add Folder in W1) | As extension host restart, and the same record | Same | Same | Same | Same | Same |
| **Save Workspace As** | As folder → workspace | Same | Same | Same | Same | Same |
| **folder removed** - Delete Worktree on its row | ◇ The start ends, stopped by `@human`; no CLI later | Same; the setup terminal stopped | Ended, stopped by `@human` | Same | Same | - |
| **quit** and start again | No CLI ever; on the next start the run is ended, failed, with its worktree named | Same | Ended at quit; not relaunched | Same | Same | Gone from the list after the fresh start |
| **renderer crash** and Reopen | As reload | As reload | The process reconnected | Reconnected; one killed meanwhile ends as lost, with no notification | The stop finishes | Kept |
| **timeout** (5 s) | `unconfirmed`, phase `creating_worktree`, within 6 s; the start goes on | `unconfirmed`, phase `running_setup`; the start goes on; another worktree can be made meanwhile | `unconfirmed`, phase `connecting`; a late connection makes the same id running | - | The stop answers `pending` | - |
| **retry** - `a1` starts the same name again | Refused: the branch exists | Same | Same | Same | Same | Same |

Each cell also checks: the ledger's events are in order (`started` before
`launched`, `stopping` before `ended`), the run ends exactly once, and the global
checks hold.

## B9. Window events with a full population (WIN)

The population, in the window under test: a Claude Code root (LIVE) that started a
Codex child (LIVE); `fake` children running in a new worktree, connecting
(`fake-late`), stopping (`fake-slowstop`), disconnected and ended; one `start_agent`
waiting in `running_setup`; one `stop_agent` pending; an ordinary terminal; agent
terminals in the panel (front and behind), the editor area and a floating window.
Each WIN case runs in W1:A and in W2, unless its event defines the window.

| ID | Do | Expect |
| --- | --- | --- |
| WIN-01 | Developer: Reload Window | The same record; every live process kept (same pids), its terminal back in the same place with its title; running agents connected again and callable; the connecting one runs; the stopping one ends; the waiting start ends failed with its worktree reported and never gets a CLI; the pending stop's caller learns the outcome from `list_agents`; the ordinary terminal as upstream |
| WIN-02 | Reload with `terminal.integrated.enablePersistentSessions: false` | Every agent ends with the reload, recorded; nothing relaunched; the ordinary terminal ends as upstream |
| WIN-03 | Developer: Restart Extension Host | Terminals untouched; the same record; every call afterwards works; every start and stop in flight has exactly one recorded outcome; G11 |
| WIN-04 | W1 only: Add Folder B | The window becomes an untitled workspace, its extension host restarts; the same record id; everything as WIN-03 |
| WIN-05 | After WIN-04: Save Workspace As | As WIN-04 |
| WIN-06 | W2: Save Workspace As `w2b.code-workspace`; then open the old W2 file in a new window | The renamed workspace keeps the record and its agents; the old file's new window gets a new, empty record - the two never share a live record |
| WIN-07 | W2 with agents in B and in a worktree of B: remove B from the workspace | B's agents stop, by `@human`; the worktree's agents ◇ stop too (a worktree of a removed folder is no longer on the bar); the others run on |
| WIN-08 | W2: remove A, the first folder (VS Code restarts the extension host when the first folder changes) | A's agents stop; the others run on and stay callable; the same record |
| WIN-09 | Open another folder in the window (File > Open Recent, this window) | Added and shown (WORKSPACE.md §2, §3.7): W1 becomes a workspace of A and the folder, in W2 the folder already there is shown; the same record; every agent runs on, on its process, connected, nothing relaunched; their terminals stay in place; no notification (changed 2026-10-09 with the person) |
| WIN-09b | Open another workspace file in this window (File: Open Workspace from File..., this window) - the one way left that replaces a window (WORKSPACE.md §3.7) | Every agent ends, recorded; no notification; reopening the first one later shows none active, and numbers go on (added 2026-10-09 with the person) |
| WIN-10 | Close the window | Every agent ends, recorded; no notification; reopening A later shows none active, and numbers go on |
| WIN-11 | Quit (Cmd+Q) | Every agent ends, recorded; no notification; reopening A later shows none active, and numbers go on |
| WIN-12 | Force quit: `kill -9` of the test instance's main process (its checked pid) | Its agents end with it; on the next start they are ended as lost, with no notification and no relaunch |
| WIN-13 | Renderer crash (`kill -9` of the test window's renderer, its checked pid), then Reopen | Surviving processes reconnected; a `fake` killed meanwhile ends as lost, with no notification; nothing relaunched |
| WIN-14 | W1:A and W2 (which holds A) open together, an agent in A in each | Two records; each window lists, counts and stops only its own; Muse Code files in A shared (B14) |
| WIN-15 | Add Folder, then at once Reload | As WIN-04, then as WIN-01 |
| WIN-16 | Reload twice in 2 s | As WIN-01, once |
| WIN-17 | After WIN-04, the person opens folder A on its own in a new window | The new window gets a new, empty record; nothing of the converted window's agents ends or loses its files; no call reaches the wrong window |
| WIN-18 | `kill -9` of the extension host (its checked pid); VS Code restarts it | As WIN-03; ended agents stay listed |
| WIN-19 | W1:A open; then A again by File > Open Recent in a new window, by `code -n <A>`, and by a second test instance with its own profile; then the same for the W2 file | VS Code brings the existing window forward, or the new window gets its own record; the first window's agents keep working; closing either leaves the other's agents working; a duplicate owner of one record gets one actionable error and never a second writer (LA-19) |

## B10. Terminal operations (TM)

Each TM case runs on an agent's terminal and then, as TM-20 says, on an ordinary one.

| ID | Given | Do | Expect |
| --- | --- | --- | --- |
| TM-01 | An agent in the panel; default `terminal.integrated.confirmOnKill` | Close its tab | No confirmation; ended, stopped by `@human`; no notification |
| TM-02 | An agent in the editor area | Close it; Cancel in the confirmation; close again and confirm | Cancel: nothing changes. Confirm: stopped by `@human` |
| TM-03 | `confirmOnKill: always` | Close an agent in the panel | VS Code's confirmation first |
| TM-04 | An agent | Terminal: Kill the Active Terminal Instance; then Kill All Terminals with two agents and a shell | As closing: stopped by `@human`, each |
| TM-05 | An agent | Move it to the editor area, to a floating window, back to the panel; call a tool from each place | One run throughout: same pid and number; its calls work everywhere; its title kept |
| TM-06 | An agent | Split it; type in the new pane; close the pane; then close the agent | The pane is an ordinary shell: not counted, not listed, its own title; closing it leaves the agent; closing the agent leaves the pane |
| TM-07 | An agent; a second window | Detach Session (palette and tab menu); Attach to Session in the other window, also while the first window is reloading; drag its tab onto the other window | Detach not offered or refused; never offered for attaching; the drag leaves it in its own window |
| TM-08 | An agent | Relaunch Active Terminal; then change `terminal.integrated.env.osx`; then an extension's environment change | Never relaunched; no **Relaunch Terminal** in its status; its CLI never runs again |
| TM-09 | The person's own Claude Code | Ctrl+C until it exits | Ended, exited with the code its CLI gives (Claude Code: 0, its own exit on a second Ctrl+C); no notification (L6: a normal exit and a known user interrupt notify nobody) |
| TM-10 | The person's own `fake` | `exit 2` | Ended, exited 2; one notification, shown as a failure (UI-17), with **Show** only while its terminal is still there - a closed terminal's saved final screen comes with D6 (AGENT-DEBUGGING.md, Part D) |
| TM-11 | The person's own `fake`; `a1` | `a1` stops it | One notification naming `a1`, whatever the exit code |
| TM-12 | A child of `a1` | It exits 2 | Ended in the record; no notification |
| TM-13 | An agent | Hide the panel; maximize it; switch terminal tabs; clear it | Nothing ends or changes in the record |
| TM-14 | Agents in the panel, the editor area and a floating window | Reload | Each back where it was (WIN-01) |
| TM-15 | An agent whose terminal is behind | The person clicks its row in Show Active Agents... | Its folder selected first if needed, then its terminal in front |
| TM-16 | An agent | Change Icon to a shell icon; quit and start the app | Still counted and listed while it runs; after the restart its CLI is not run again |
| TM-17 | Agents and an ordinary terminal | Terminal: Restart Pty Host | ◇ The agents end, recorded, and their CLIs are not run again (L6: no revival); the ordinary terminal as upstream |
| TM-20 | An ordinary terminal | TM-01 to TM-08 and TM-13, TM-14 | Upstream VS Code behaviour: Detach, Attach, Relaunch and the drag all available; nothing in the record |

## B11. YOLO, approvals and questions (YO)

| ID | Given | Do | Expect |
| --- | --- | --- | --- |
| YO-01 | Claude Code, YOLO on; started by the person, and through `start_agent` | Ask «run touch ~/facade-e2e/outside-claude, then list all Facade agents» | Both: neither asks; the file is made; Show Agent Launch and its list row: sandbox off |
| YO-02 | Claude Code, YOLO off | The same, for an agent the person started, then one started through `start_agent` | Started by the person (`acceptEdits`): `list_agents` unasked; an edit inside its folder unasked; the touch outside asks the person, its sandbox's way out asking too. Through `start_agent` (`dontAsk`, the way out closed): `list_agents` unasked; an edit inside its folder done unasked; the touch outside refused unasked, nothing waiting. Sandbox on both times (L4, D12) |
| YO-03 | Codex, YOLO on; both starters | The same | Both: neither asks; the file made; sandbox off |
| YO-04 | Codex, YOLO off | The same, for an agent the person started, then one started through `start_agent` | Started by the person (`--ask-for-approval on-request`): `list_agents` unasked; the write outside asks the person. Through `start_agent` (`--ask-for-approval never`): `list_agents` unasked; the write outside refused unasked, nothing waiting. Sandbox on both times |
| YO-05 | Muse Code, YOLO on, then off; both starters | The same | On: nothing asks, sandbox off. Off: nothing asks (no precise exemption: all approvals off), its sandbox still on and blocking; Show Agent Launch says so |
| YO-06 | Antigravity, YOLO on, then off; both starters | The same | Nothing asks either way; "no sandbox" both times |
| YO-07 | Each CLI started by the person, and started through `start_agent` (a root as `@human`, and a child) | Ask it to put a multiple-choice question to you: once without naming a tool, once with its question tool | Through `start_agent`: no question that waits for a selection, both times; it asks in plain text - Claude Code and Codex without the tool, Muse Code and Antigravity told by their instructions; Show Agent Launch says how each is kept from asking. Started by the person: its question tool kept - it may put the question up, the person answers it (L4, D12). At start: through `start_agent`, no onboarding, tip, survey or update prompt; started by the person, as the CLI usually starts |
| YO-08 | Each CLI, YOLO on, as a child with task «create hello.txt containing hi» | - | Done without any click anywhere |
| YO-09 | Claude Code launch `settings.permissions.deny: ["mcp__facade"]`; Codex's connect group without its approval line | Show Agent Launch; start each | The exemption shown as overridden, not as working; the start's diagnostics say the same |
| YO-10 | Every case of the run | Watch the window | No dialog from Facade, ever |
| YO-11 | Claude Code `launch.arguments.quiet: null`, YOLO off | Start; ask it to write outside its folder | Its sandbox still on, or Show Agent Launch, the start and `list_agents` all say off - never on while it is off |
| YO-12 | Antigravity, YOLO off | Ask it to edit a file in its folder | No approval asked (L4 fallback: approvals off, sandbox as supported) |
| YO-13 | Codex through `start_agent`, YOLO off; a project with a hook Codex has not reviewed | Start it | Its hooks neither run nor wait: the switch that runs none this time where Codex has one, or the start refused - saying the project's hooks are not trusted yet and how to trust them. Through `start_agent` with YOLO on: the hooks trusted for the run, nothing waits. Started by the person: Codex's own review, as it usually asks (L4 rule 3) |
| YO-14 | Each CLI, started by the person and through `start_agent` | Show Agent Launch; start each | Through `start_agent`: self-update and update prompts, surveys and tips off (Claude Code `DISABLE_AUTOUPDATER` and its survey switch, Codex `check_for_update_on_startup=false`, Muse Code `MUSE_NO_AUTO_UPDATE=1`, Antigravity `AGY_CLI_DISABLE_AUTO_UPDATE=true`). Started by the person: none of these of Facade's - the CLI's own (L4, D12) |

## B12. Trust (TRU)

| ID | Given | Do | Expect |
| --- | --- | --- | --- |
| TRU-01 | Claude Code | Start in A, in Af, in L | `~/.claude.json` gains each folder's entry as Claude Code keys it (A's real path; L resolved to A) with `hasTrustDialogAccepted: true`, and nothing else changes; no trust question |
| TRU-02 | Codex | Start in A, Af, O | Trust passed per launch; `~/.codex/config.toml` byte-identical; no question |
| TRU-03 | Antigravity | Start in A, Af | Its `settings.json` gains each real path in `trustedWorkspaces`; other keys unchanged; no question |
| TRU-04 | Muse Code | Start in A, Af | Trust per launch; no file written; no question |
| TRU-05 | A malformed `.claude.json` in a test `CLAUDE_CONFIG_DIR`; a malformed Antigravity `settings.json` under a test HOME; `fake` with a malformed trust file | Start each | Each fails before its CLI runs, naming the file and the problem; each file byte-identical |
| TRU-06 | - | Show Agent Launch | For each CLI: trust per launch, or the file and entry it keeps |
| TRU-07 | `fake` whose trust merges into a test file with unrelated values | Two starts at once | Both entries there; the unrelated values intact; the file valid JSON |
| TRU-08 | Restricted Mode | Any start | No CLI trust is written before VS Code's trust is granted |
| TRU-09 | A malformed `.claude.json` in a test `CLAUDE_CONFIG_DIR` | `start_agent` Claude Code with `new_worktree` | Refused before the worktree is made: no branch, no folder (L5) |

## B13. Settings and launch configuration (CFG)

| ID | Given | Do | Expect |
| --- | --- | --- | --- |
| CFG-01 | Fresh profile | Open the Settings editor at Agents | L7's defaults; groups Agents, Claude Code, Codex, Antigravity, Muse Code, Custom Agents; timeout and launches described as advanced |
| CFG-02 | W2 | `facade.agents.yolo: false` in the workspace's settings | Not applied (machine scope), and VS Code says so |
| CFG-03 | - | Every menu open and start of the run | The user settings file changes only where the tester set it |
| CFG-04 | settings.json | Type inside `facade.agents.claude.launch` and a custom agent's `launch` | Completion for the fields and argument groups; unknown keys, wrong types and bad delays underlined |
| CFG-05 | One at a time, started from the menu and by a tool | An unknown launch key; an unknown argument group; a group that is not a list of strings; `enterDelay` -1, 60001, 1.5, `"300"`; `${hostname}` in `extra`; `${model}` in `extra` with no model | A configuration error naming the setting, before anything is made, also in Show Agent Launch |
| CFG-06 | `${model}` only in the model group, no model given | Start | Starts: an inapplicable group is not expanded |
| CFG-07 | Claude Code with `quiet: null`; `extra: ["--verbose"]`; `model: ["--model=${model}"]`; then launch `{}` | Start each (LIVE) | `ps`: the quiet group gone; extra added; the model group replaced whole; `{}` gives the defaults |
| CFG-08 | Terminal environment `DISABLE_AUTOUPDATER=7`; `fake` launch environment `{ "DISABLE_AUTOUPDATER": null, "FOO": "bar" }` | Start | Facade's value removed, the inherited 7 kept; `FOO=bar` |
| CFG-09 | Claude Code `trust: null` with a test `CLAUDE_CONFIG_DIR`; `fake` with `trust: { "arguments": ["--trusted"] }` | Start each | Claude Code's trust not written, and it asks its own question; `fake` gets `--trusted` |
| CFG-10 | Claude Code `settings: { "spinnerTipsEnabled": true, "permissions": { "allow": ["Bash(ls)"] } }` | Start | The run's settings file merges them deeply into Facade's |
| CFG-11 | `fake` in O, task `$(touch /tmp/x) "q" 'q' ünï $HOME`, model `a b`, effort `"x"` | Start | Each value one argument, exact and unexpanded; no `/tmp/x` |
| CFG-12 | `fake` with every group filled, YOLO on then off, with and without model, effort and task | Start each | Order warmUp, connect, quiet, questions, messages, yoloOn or yoloOff, model, effort, trust, extra, task; one YOLO group; model and effort only when given |
| CFG-13 | An agent running | Change YOLO, its launch and the timeout | Its recorded launch and process unchanged; the next start takes the new values |
| CFG-14 | - | Show Agent Launch | `enterDelay` and `taskDelay`: each built-in's own, 250 and 0 for a custom agent |
| CFG-15 | `terminal.integrated.env.osx` sets PATH and a test `CLAUDE_CONFIG_DIR`; the git extension's environment contribution present | Start Claude Code | The program found on that PATH; trust written in that directory; the contribution's variables in the agent's environment |
| CFG-16 | Codex model `gpt"x`, effort `low"` plus a line break; Claude Code settings with a quote | Start (LIVE) | Passed as encoded TOML and JSON; nothing else changes; the CLI's own answer is what is reported |
| CFG-17 | Custom names `Bad`, `human`, `claude`, `a b` | Open the menu; Show Agent Launch | Each a configuration error; none starts |
| CFG-18 | Custom `myclaude` with launch `{}` | Start | No argument at all: no MCP, YOLO, trust or task part; no trust file written |
| CFG-19 | `facade.agents.claude.path` set to the real `claude` with a PATH lacking it; then to a missing file, then to a path of only spaces, while `claude` is on PATH | Start Claude Code each time | The configured file is started. A missing configured path: Claude Code unavailable, named in Show Agent Launch - never PATH's `claude` instead |
| CFG-20 | User settings holding the old `facade.agents` list | Start the app | The old list removed; every other setting byte-identical |
| CFG-21 | `facade.agents.timeout` 0, 3601, 1.5, `"5"` | Start `fake-late` | The invalid value flagged in settings; the default 120 used ◇ (VS Code's handling of an out-of-range setting) |
| CFG-22 | `facade.orchestration.enabled: "false"`; `facade.agents.timeout: "30"` | Start agents | Each flagged in settings as a wrong type; ◇ neither silently read as on or as 120 without saying so (L5: no silent substitution) |

## B14. Project integration files (INJ)

| ID | Given | Do | Expect |
| --- | --- | --- | --- |
| INJ-01 | A, no `.mcp.json` | Start Muse Code; it ends | `.mcp.json` and `.agents/skills/facade/SKILL.md` made; the skill hidden by a narrow ignore line, `.mcp.json` visible in `git status` with its `facade` entry - no ignore line for it, which would hide every worktree's (O10; changed 2026-10-08 with the person); after the end, A byte-identical and the ignore lines gone |
| INJ-02 | B, tracked `.mcp.json` with `other` | Start Muse Code; it ends | Not refused; `facade` beside `other`, the layout kept; visible in `git diff`; no index flag (`git ls-files -v`); after the end, byte-identical |
| INJ-03 | An untracked `.mcp.json` of the person's | Start Muse Code; it ends | Merged; not hidden from `git status`; restored exactly |
| INJ-04 | A tracked `.mcp.json` the person changed already | Start Muse Code; it ends | Merged; restored to the person's content exactly |
| INJ-05 | `.mcp.json` with another `facade` entry; `.mcp.json` that is not JSON | Start Muse Code | A configuration error naming the file, before launch; the file untouched |
| INJ-06 | A | Two Muse Code agents; the first ends; the person edits another field; the last ends | The files stay until the last ends; the person's edit kept; only Facade's entry removed |
| INJ-07 | A, Muse Code running | The person edits Facade's own entry; the agent ends | Left as it is, its backup kept, one diagnostic in the log |
| INJ-08 | A, Muse Code running | Reload; framework off | The files kept while the agent lives |
| INJ-09 | W1:A and W2 (holding A), a Muse Code agent in A in each | One ends | The files stay for the other (`~/.facade/injected.json`) |
| INJ-10 | A folder whose `.agents/` holds the person's files | Start Antigravity; it ends | Plugin files added with narrow ignore lines; the person's files not hidden; only Facade's removed at the end |
| INJ-11 | A Muse Code child in a new worktree whose base commit has a conflicting `.mcp.json` | `start_agent` | A configuration error, as in an existing folder |
| INJ-12 | An injected file made immutable | The agent ends | Cleanup failure logged; retried at reconciliation after `chflags nouchg`; no agent stopped, no result failed |
| INJ-13 | Claude Code and Codex agents | Start each; they end | Claude Code: nothing written into the project. Codex: only the Facade skill (its skill discovery is in the project, O10), under INJ-01's rules - hidden narrowly, removed at the end |
| INJ-14 | A, Muse Code running | `kill -9` the test instance's extension host in the middle of the injection (C4 places it) and restart | Recovery never overwrites a later edit; the files consistent with the live runs |
| INJ-15 | Muse Code in a worktree of A | It ends | The ignore lines are in the worktree's own exclude, or A's shared one, and are removed; A's `git status` never shows Facade's files |
| INJ-16 | B's tracked `.mcp.json` merged by a running Muse Code | The person edits Facade's `facade` entry; the agent ends | The edited entry left as it is, the backup kept, one diagnostic |
| INJ-17 | Muse Code running in a worktree of A | The person creates their own `.mcp.json` in A's main checkout | It shows in A's `git status` and the Source Control view |
| INJ-18 | A previous build's `injected.json`, its files in A | Start Muse Code in A | The old record kept aside, its files taken back or reported; the start works |
| INJ-19 | A `.mcp.json` with a non-UTF-8 byte, a number above 2^53 and `\u00e9` | Start Muse Code; it ends | Byte-identical afterwards |
| INJ-20 | `.mcp.json` a symbolic link to a file outside the project; then a dangling link | Start Muse Code; it ends | Nothing written outside the project ◇ (refused, naming the link); the links intact |

## B15. Framework switch (FW)

| ID | Given | Do | Expect |
| --- | --- | --- | --- |
| FW-01 | Agents of each CLI running | `facade.orchestration.enabled: false`; each calls a tool; `@human` calls one | Each `UNAVAILABLE framework_disabled` within 1 s, with no effect |
| FW-02 | Off | An agent exits; Show Active Agents...; the person types into an agent; read `window.json` | The end recorded; navigation and typing work; the endpoint marked disabled |
| FW-03 | Off | Start each built-in from the menu | No MCP or plugin argument, skill, project file or Antigravity warm-up; running when its process starts |
| FW-04 | A `start_agent` of `fake-late` accepted | Switch off while it waits; switch on | It finishes or reports its partial outcome, once; no second copy after switching on |
| FW-05 | Off, then on | Agents launched with integration call tools again | They work without a restart; agents launched while off still have none, and nothing is typed into them |
| FW-06 | A Muse Code agent using its `.mcp.json` | Switch off | The file stays until that agent ends |

## B16. Transport and authentication (TR)

| ID | Given | Do | Expect |
| --- | --- | --- | --- |
| TR-01 | Each CLI running | `ps` its Facade server | Facade's executable with `ELECTRON_RUN_AS_NODE=1`, running `shim.js` |
| TR-02 | The test window | `lsof` | A Unix-domain socket, the one `window.json` names; no TCP port listening for Facade |
| TR-03 | - | Read `window.json` | The endpoint and the enabled state |
| TR-04 | `@human` | A task just under 1 MiB of encoded JSON; one just over | Under: accepted. Over: refused, nothing done |
| TR-05 | `@human` | `start_agent` of `fake-late` | Progress, then one result |
| TR-06 | A running agent | Its environment and arguments; its token file after it ended; `you.token`; a call naming another identity in its arguments | The token passed as a file path, never as a value in the environment or arguments; the old token refused; `you.token` acts as `@human`; YOLO and reach from the record |
| TR-07 | Agents running | Restart Extension Host; reload; W1 → W3 | Each agent's next call works without restarting its CLI (WIN-01, WIN-03, WIN-04) |
| TR-08 | An agent | Calls while the extension host is stopped (DEBUG pause); then after a reload that changes the pipe | Retried each second up to the timeout, then `UNAVAILABLE` at once; working once back; the new pipe found through `window.json` |
| TR-09 | `fake` | Kill its MCP server just after its `start_agent` is sent | No second launch; `list_agents` finds the run; the agent's instructions say a call that got no answer may have happened, and to look with `list_agents` before calling again - nothing of Facade's can reach a call whose server is dead (changed 2026-10-08 with the person) |
| TR-10 | `fake` | Kill the caller while its `start_agent` waits | The child starts and is recorded once, creator the caller |
| TR-11 | A custom launch using `${executable}`, `${shimFile}`, `${recordDir}`, `${tokenFile}`, `${waitMs}` | Start | Expanded; shared-configuration CLIs get `FACADE_AGENTS_RECORD`, `FACADE_AGENTS_TOKEN` (a path) and `FACADE_AGENTS_WAIT_MS` |
| TR-12 | Facade's `.mcp.json` in A | Run `muse` by hand in an ordinary terminal | No Facade tools; no error, no waiting, no noise |
| TR-13 | `@human` | A made-up token; a revoked token | Refused; no effect |
| TR-14 | A workspace folder holding Facade's injected `.mcp.json`; VS Code's own MCP discovery on | Open the window | VS Code's MCP client gets no Facade tools and changes nothing in the record; no error shown; no shim left waiting |
| TR-15 | The test instance started with a `TMPDIR` of 90 characters | Start an agent | The socket path stays within macOS's 104 bytes (a short fallback), or one clear error naming the limit - not "could not start" |
| TR-16 | A `fake` whose MCP server started while the window was away | The window comes back | Facade's tools offered and working, without restarting the CLI |
| TR-17 | A call accepted, then the extension host frozen (`kill -STOP` of its checked pid for 150 s, then `kill -CONT`) | - | The call answers within the timeout plus 5 s, with `outcome: unknown` |
| TR-18 | A Codex agent starting while the extension host is paused for 40 s | - | Codex has Facade's tools afterwards |

## B17. Record (REC)

| ID | Given | Do | Expect |
| --- | --- | --- | --- |
| REC-01 | The test workspace | List its record | `~/.facade/workspaces/<id>/` with identity, `ledger.jsonl`, `agents.log`, `you.token`, `window.json`, `runs/`, `messages/`; the id in VS Code's workspace storage |
| REC-02 | A run | Its files while it runs and after it ends; a call with its old token | Its files in `runs/` while it runs, gone after; the old token refused |
| REC-03 | Starts, stops and worktrees done | Read the ledger | `started` before `launched`, `stopping` before `ended`; connection events; worktree made and removed; creator, root, overrides, YOLO, sandbox, integration, phase, token identity, task id, stop actor and reason - never a token |
| REC-04 | App quit | Append half a JSON line to the ledger; start | The partial line dropped quietly; the record works |
| REC-05 | App quit | Break a line in the middle; start | One error saying what to do; the bad file kept aside; a fresh list; numbers go on; `agents.log` intact |
| REC-06 | A live process holding the record's lock | Reload; wait 3 minutes | One error saying what to do; no second writer; still refused after 3 minutes; no agent killed |
| REC-07 | Reload with (a) a live agent; (b) a stop asked for and not finished; (c) an agent that exits during the reload; (d) an agent killed while the window was away | Reload | (a) kept; (b) the stop finishes; (c) recorded with its code; (d) ended as its recorded intent says |
| REC-08 | A workspace whose earlier-build record reached `#a5` | Start one | ◇ `#a6` or above: L2's "never reused" covers the person's earlier agents too |
| REC-09 | A record id in the workspace storage whose identity names another workspace (copied storage) | Open | A new id; the other record untouched |
| REC-10 | Ended agents in the list | `kill -9` the extension host (VS Code restarts it) | The ended agents still listed: a crash is not a fresh start |
| REC-11 | `r` → `c` → `g` → `gg`; all but `gg` ended | A renderer crash, then Reopen: a new list that `gg` outlives (quitting ends every agent, L-spec; changed 2026-10-08 with the person) | `gg`'s creator chain still named (`@c #aN`), not bare numbers |
| REC-12 | `b3` stopping by its sibling `b2`; `b2` ends; renderer crash and Reopen; then `b3` ends | Reopen again | The ledger reads; no fresh list |
| REC-13 | W2's file opened through a path differing only in letter case | Open | The same record |
| REC-14 | An agent exits with code 3 during Restart Extension Host | After the restart | Ended, exited, code 3 - not lost |

## B18. Menu, button, Quick Pick and commands (UI)

| ID | Given | Do | Expect |
| --- | --- | --- | --- |
| UI-01 | `fake` running | Type `call list_agents {}` into its terminal; then write the same line to its control file | The same result both ways (A6) |
| UI-02 | Fresh profile; the four CLIs on PATH | Open the agent menu; read the user settings file | Claude Code, Codex, Antigravity, Muse Code; a separator; Show Active Agents...; Configure Agents.... The settings file unchanged |
| UI-03 | The custom agents of A6 | Open the menu | After the built-ins, in the setting's order |
| UI-04 | `terminal.integrated.env.osx` PATH = `~/facade-e2e/bin:/usr/bin:/bin:/usr/sbin:/sbin` | Open the menu; link the real `codex` into `bin/`; open; remove the link; open | No built-in; then Codex; then none - each at the first open after the change |
| UI-05 | `facade.agents.codex.enabled: false` | The menu; Start Agent...; `human start_agent` with Codex | Codex in neither; the call refused, naming the setting |
| UI-06 | PATH as UI-04, no CLI, no custom agent | Open the menu | An empty-state hint with Configure Agents..., which opens the agent settings |
| UI-07 | Framework off | Open the menu; choose Claude Code | The same items; it starts, without Facade (FW-03) |
| UI-08 | - | Cmd+Alt+A; Agents: Show Agent Menu; choose with the keyboard | The button's menu; the same start as by mouse |
| UI-09 | Nothing; `fake-late` starting; two running; `fake-slowstop` stopping; one ended; an ordinary terminal running `claude`; an ordinary terminal given the robot icon; an agent given a shell icon; a child still in `creating_worktree` | The button's count at each point | Starting, running and stopping agents only - by run, not by icon |
| UI-10 | Agents in A, B, Af and a worktree only on the bar; rows collapsed | Look at the bar | Each row shows its agents' logos; a collapsed row its marker; the new worktree on the bar with its agent |
| UI-11 | Agents in several folders, one in a worktree only on the bar; then the same in W1:A | Show Active Agents... from the menu and the palette; start and end agents while it is open; pick an agent of an unselected folder; pick the one in the unjoined worktree; use a row's close action | A live list in bar order with folder, terminal title and number; no ended agent; picking selects the folder, then reveals the terminal; picking the unjoined worktree's agent selects its row, which in W1 makes the window a workspace (the person's choice, O1) and every agent keeps working through it (I-1); close stops it as closing its tab does |
| UI-12 | - | Configure Agents... twice, the second time after typing another search | The same settings search both times |
| UI-13 | - | Command Palette: «Agents:» | Start Agent..., Show Agent Menu, Show Active Agents..., Configure Agents..., Show Agents Log, Show Agent Launch, in title case; no Stop Agent |
| UI-14 | Agents started and ended | Show Agents Log | This workspace's log: each start with its command line and settings ◇ (the person's request of 2026-10-08), each end with actor, reason and code; no token |
| UI-15 | A launch override; a broken custom agent; a custom agent named `a.b` with a launch; `GITHUB_TOKEN` in the terminal environment | Show Agent Launch | For each CLI: program, launch as defaults plus overrides, sandbox with YOLO on and off, approvals, whether Facade's tools are asked, trust and where, delays, verified CLI version, configuration errors; no token or secret |
| UI-16 | - | Each command by the keyboard and by the mouse where it has a place | The same outcome |
| UI-17 | Every notification of the run | Read its words and severity | It says what failed and what to do; a failure shows as a warning or an error, not as information |

## B19. Non-interference (NI)

| ID | Given | Do | Expect |
| --- | --- | --- | --- |
| NI-01 | Before any agent | An ordinary terminal: title, icon, move to the editor area and a floating window and back, split, Detach Session, Relaunch, reload with persistent sessions on and off, the close confirmation | Recorded as the baseline |
| NI-02 | After all agent cases | NI-01 again | Identical to the baseline |
| NI-03 | The run | The person's settings, `~/.codex`, Muse Code's files, the fixture repositories outside agents' worktrees | Only the changes the cases expect (G6, G12) |
| NI-04 | The run | The person's other windows (installed Facade Code, the trial window) | Untouched: same pids, no new file in their records |
| NI-05 | A git repository opened with the git extension | Agents make and delete worktrees | The Source Control view lists repositories as VS Code does; no stale entry for a deleted worktree |
| NI-06 | An ordinary terminal given the robot icon by Change Icon | Quit and start the app | Restored as upstream; not counted or listed as an agent |

## B20. Journeys (J)

| ID | Do | Expect |
| --- | --- | --- |
| J-01 | Each built-in as the person's root: start it from the menu with a small coding task; it starts a child in a new worktree; meanwhile the person types in the root and selects another folder; reload midway; the root finishes, stops the child and deletes the worktree with the tools | Agents never move the view; the work survives the reload; window, processes and record agree (the messaging and debugging steps of L16: section D) |
| J-02 | All 16 ordered pairs: each built-in starts a child of each built-in with a task, checks it with `list_agents` and stops it | The child's identity, task, folder and YOLO right in every pair; results, terminals, processes and record agree |
| J-03 | A three-generation tree of mixed CLIs | Creators and roots right; each stop leaves the others |
| J-04 | Work across A and B in W2 | The right folders and worktrees |
| J-05 | A child repaired after an unconfirmed start (timeout 5) | The creator looks at, waits for or stops the same id; no duplicate |
| J-06 | RCH with real CLIs and YOLO off: precise approvals (Claude Code, Codex) and the fallback (Muse Code, Antigravity) | RCH's outcomes |

## B21. Instructions (INS)

| ID | Given | Do | Expect |
| --- | --- | --- | --- |
| INS-01 | `fake` | `instructions` | The caller, its creator, its tree, its folder, its YOLO and the tools |
| INS-02 | Codex, Muse Code and Antigravity's Facade skill; Claude Code's plugin | Read them | O7's seven points; no commit, merge, review, worktree deletion or self-termination demanded |
| INS-03 | A child started with a task (each built-in, LIVE) | Read its first notice | Who it is, who started it, where its task is |
| INS-04 | A CLI whose question tool cannot be turned off | Read its instructions | It is told not to wait on a question tool and to ask in plain text (messages: section D) |

# Part C: White box

## C1. Unit suites and coverage

The stack's own suites, each run on its own and recorded with its counts:

| Suite | Command |
| --- | --- |
| Extension: CLIs, Contract, Core, Host, Layers, Record, Transport, Base | `npm run gulp compile-extension:facade-agents`, then in `extensions/facade-agents`: `npx c8 --reporter=lcov --reporter=text-summary --exclude 'out/test/**' node ../../node_modules/mocha/bin/mocha --ui tdd --timeout 30000 "out/test/**/*.test.js"`; every test file reports more than zero tests run |
| Workbench: every test file under `facadeCommands`, `terminalLaunchers` (its suites include Agent menu, Agent picker, Agent launchers), `worktrees`, `folderTerminals` and `terminal` | `npm run transpile-client`, then `scripts/test.sh --runGlob "vs/workbench/contrib/{facadeCommands,terminalLaunchers,worktrees,folderTerminals,terminal}/test/**/*.test.js" --coverage --coverageFormats lcov` - selected by file, not by suite name; every file reports more than zero tests run |
| Hygiene | eslint on the changed files; `npm run valid-layers-check` (the stack adds workbench imports) |

Coverage is measured on the live run as well: the test instance is started with
the extension host's and the renderer's inspector ports open (the `launch` skill).
Every reload, restart, conversion and crash makes new processes, so precise V8
coverage is switched on in each new extension-host and renderer process as it
starts, and taken from every live one after every step - and before any step that
ends a process. A process killed with `kill -9` loses only what ran since the
previous step's take; its step is repeated once without the kill to cover it.

**Gate.** For every line the stack changed (`git diff -U0 main..HEAD` over non-test
sources), every branch is executed by a unit test or by a live case, counted over
the union of the three coverage reports. Each branch neither reaches gets a written
reason why it cannot be reached on this Mac (for example a Windows-only path, then
covered by its unit test) or a new case. A branch reached only by a unit test whose
fakes differ from the real collaborator in that branch's condition is listed for a
live case too (C2 names them).

## C2. White-box tests by module

Each module was read branch by branch on 2026-10-08. Its tests below reach what no
existing test reaches, or force an order Part B cannot. "Today" names the existing
test that covers the row, `-` for none, or the test whose assertion must be inverted
once the defect (C6) is fixed. Holds use the fakes in `test/fakes.ts`, with the
additions C4 lists.

### C2.1 Orchestration core (`core/facade.ts`, `core/ports.ts`, `contract/*`)

| ID | Given | Do | Expect | Today |
| --- | --- | --- | --- | --- |
| C-CORE-01 | Framework off | `hello`, then a call | The call `framework_disabled`; hello records nothing as connected | contract.test 147 (calls only) |
| C-CORE-02 | - | `stop_agent {discard_changes:false}`; `{delete_worktree:"yes"}`; `list_agents {x:1}`; arguments `null` | Valid; `INVALID`; `INVALID`; `INVALID` | - |
| C-CORE-03 | A pending stop | Read the structured data | `code`, `outcome: pending`, the agent | core.test 689 (text only) |
| C-CORE-04 | Only ended `@w` | Stop `@w` | `NOT_FOUND` listing their numbers | - |
| C-CORE-05 | An agent named `7`, no `#a7`; an ended `a7` | `7`; `a7`; `#a0`; `A7`; `@human #a1` | `INVALID`; by number; `NOT_FOUND`; lower-cased; `INVALID` | core.test 665 (part) |
| C-CORE-06 | YOLO-off caller; `#a4 @other` in another tree | `@x #a4`; `#a4` | Not found or refused without the name | core.test 635 (asserts the leak) |
| C-CORE-07 | A built-in with `task: null`, framework on | Start with a task | `REFUSED` naming the task group | - |
| C-CORE-08 | A workspace folder missing on disk | Start with an absolute folder; stop with deletion an agent whose worktree is gone | `NOT_FOUND` naming it; the outcome, folder gone - never git's stderr | - |
| C-CORE-09 | `new_worktree`, `makeHold` | During the hold: `list_agents all`; `stop_agent` | A starting run, phase `creating_worktree`; cancellable | - |
| C-CORE-10 | As C-CORE-09 | Dispose the world during the hold, then release | The worktree and the run recorded before any interruption | - |
| C-CORE-11 | Timeout 10 s; `makeHold` 30 s | Start | `unconfirmed` 10 s after acceptance, phase `running_setup` | - |
| C-CORE-12 | Terminal `hold` 8 s; timeout 10 s | Stop during the hold | Answered by 10 s | core.test 1445 (no timing) |
| C-CORE-13 | A worktree with an agent; `changesHold` | Delete; during the hold start into it | The start `REFUSED` | - |
| C-CORE-14 | `terminals.hold` on a start into `F` | Delete `F` during the hold | The start refused or cancelled; `F` not deleted under a live run | - |
| C-CORE-15 | Two deletions of `F`, `deleteHold` on the second | Start into `F` between their ends | `REFUSED`; the second deletion joins the first | - |
| C-CORE-16 | `stubborn` terminal; pending returned | Advance 5 minutes | The stop retried (counter above 0) | core.test 689 (asserts only the words) |
| C-CORE-17 | `new_worktree`; `failNext` on the terminal | Call through the contract | `data.agent`, outcome and the worktree's folder | core.test 363 (text only) |
| C-CORE-18 | `new_worktree`; the ledger closed after `makeWorktree` | Start | The error names the worktree | - |
| C-CORE-19 | A told CLI, `taskDelay` 2000 | hello, stop at 1000 ms | Nothing typed after the stop | core.test 396 (no stop) |
| C-CORE-20 | A starting run after `recover`; timeout 5 s | Wait 10 s | Unconfirmed recorded; the person told for their own | core.test 849 (asserts the opposite) |
| C-CORE-21 | New changes appear while the agents stop | Delete without discard | An error listing the stopped agents | core.test 1428 (asserts a success shape) |
| C-CORE-22 | Mixed rows | `list_agents` data | Caller identity, counts, stop actor, phase | contract.test 104 (part) |
| C-CORE-23 | hello, then a custom agent added | Start it | Accepted: the schema's CLI list is current or open | contract.test 58 (static) |
| C-CORE-24 | An agent in a worktree's subfolder; a child at its root | Delete through the subfolder agent | Both stopped and deleted, or refused before any stop | - |
| C-CORE-25 | Two worlds sharing `injected.json`, agents of both in `W` | World A deletes `W` | Refused while B's agent runs | - |
| C-CORE-26 | Two agents in `W`, one `stubborn` | Delete | Pending data lists the one already stopped | - |
| C-CORE-27 | - | `task: "  a\n"` | The message file holds the exact text | - |
| C-CORE-28 | `table.end` throws once | The terminal ends | The end recorded later, or the run reported unknown | - |
| C-CORE-29 | The caller's own folder being deleted | It starts with no folder | `REFUSED` | - |
| C-CORE-30 | `isAlive` held during `recover` | `stop_agent` | One end; no unexpected notice | - |
| C-CORE-31 | A script's start: its timer fired, then the process exits | - | One channel only: the script's answer, no notice | - |
| C-CORE-32 | `new_worktree`, `makeHold` on an earlier start in the same repository | FakeGit's HEAD moves while the start waits its turn | The worktree is made at the commit of acceptance | - |

Never reached today, reached by the rows above: `facade.ts` 358, 368, 372, 378, 450,
666 through `startAgent`, 760-762, 776, 799, 805, 821, 996, 335-337 for built-ins;
`launch.ts` 241 alone; every concurrent call but two stops joining.

### C2.2 Launch composition, settings and trust (`core/launch.ts`, `clis/*`, `host/settings.ts`, `host/showLaunch.ts`, `host/startAgent.ts`)

| ID | Given | Do | Expect | Today |
| --- | --- | --- | --- | --- |
| C-LAUNCH-01 | A custom agent, every group a marker, trust arguments | Launch over YOLO × framework × model, effort, task present or absent | L9's order; trust before extra; one YOLO group; framework groups only with it | clis.test 166, 192; core.test 1522 (part) |
| C-LAUNCH-02 | `yoloOff: ["${nope}"]` | Start with YOLO on, then off | On: starts. Off: refused before allocation | - |
| C-LAUNCH-03 | `extra`: `${}`, `${ model }`, `${model`; model `$&`; model containing `${task}` | Expand | Error, error, literal, literal, no second expansion | clis.test 363 (unknown names) |
| C-LAUNCH-04 | Terminal environment HOME=/tmp/h; `extra: ["${home}"]`; trust file `${home}/t.json` | Start | Both use /tmp/h | - |
| C-LAUNCH-05 | Claude Code `quiet: null`, YOLO off | Launch; read the record | The sandbox still given, or recorded off | clis.test 270 (groups only) |
| C-LAUNCH-06 | A malformed trust file | `start_agent` with `new_worktree`; then in an existing folder | Refused with no git step; refused with no agent; the file intact | - |
| C-LAUNCH-07 | Two OS processes merging into one trust file, 50 rounds each | `writeTrust` | Both entries; valid JSON; no `.next` left | base.test 306-388 (lock only) |
| C-LAUNCH-08 | `~/.claude.json` a symbolic link | Merge | The link kept, its target updated; locked where Claude Code locks | base.test 142 (link only) |
| C-LAUNCH-09 | A trust file with `12345678901234567890`, a duplicate key, minified | Merge | Unrelated text kept | - |
| C-LAUNCH-10 | `effort: "--disable-sandbox"`; `model: "-x"` | Start a fake CLI parsing with yargs and with clap | Read as values, never as options | - |
| C-LAUNCH-11 | Codex effort with a lone surrogate, with U+007F; a folder name with U+007F | `codexCli.launch` | Every `-c` value valid TOML 1.0 | clis.test 495 (quote, newline) |
| C-LAUNCH-12 | `model` with a NUL, through the contract | `start_agent` | `INVALID` | - |
| C-LAUNCH-13 | Folders with space, `"`, `'`, `$HOME`, `[x]`, `;`, NFD `ünï` | The fake CLI prints argv and cwd | Exact; the notice's path exact; Codex's folder TOML valid | - |
| C-LAUNCH-14 | `path`: `"  "`, a 0644 file, a directory, a dangling link, a link to an executable, `bin/x`, `~/x`; PATH containing `.` | `locateCli` | Missing or found as the terminal would; never PATH's when a path is set | clis.test 904, 914 (part) |
| C-LAUNCH-15 | Disabled and wrong at once | Start | "turned off" | core.test 459 (part) |
| C-LAUNCH-16 | A built-in with wrong settings; a custom agent with a missing path | `list_agents` CLI list | Both left out, or both marked | - |
| C-LAUNCH-17 | `task: null` on a built-in; a custom agent with both groups, framework off | Start with a task | The message names the real cause | core.test 1553 (no connect) |
| C-LAUNCH-18 | `facade.orchestration.enabled: "false"`; `timeout: "30"` | Read the settings | An error, or a stated substitution | - |
| C-LAUNCH-19 | Custom `a.b` with a launch; `${hostname}` in extra; Claude Code `permissions.deny: ["mcp__facade"]`; Codex connect without its approval line | Show Agent Launch | `a.b`'s launch shown; the placeholder error shown; the exemption shown as overridden | clis.test 450 (document only) |
| C-LAUNCH-20 | A told CLI; its terminal ends during `taskDelay` | hello | Unconfirmed; no Enter typed | - |
| C-LAUNCH-21 | `launch.json` deleted before hello | hello | Unconfirmed, with the reason | - |
| C-LAUNCH-22 | Two hellos in a row | - | One notice | - |
| C-LAUNCH-23 | hello while `terminals.hold` is pending | Release | One start; typed once | - |
| C-LAUNCH-24 | `noProcessIds`; a told CLI with project files | Start, then end | Files released at the end | - |
| C-LAUNCH-25 | FakeGit `excludeOf` delayed | Stop during `inject` | Failed, "stopped before its terminal opened"; no terminal; files released | - |
| C-LAUNCH-26 | Antigravity, YOLO off | Ask it to edit a file (LIVE) | No prompt | - |
| C-LAUNCH-27 | Muse Code, YOLO off, a task | LIVE start | The task file read without a prompt | - |
| C-LAUNCH-28 | A test `CODEX_HOME` with `[mcp_servers.facade] url=…` | Start Codex | A named conflict | - |
| C-LAUNCH-29 | An environment provider counting its calls | One start | One environment fetch | - |
| C-LAUNCH-30 | Timing changed while `makeWorktree` is held | Start | The values of acceptance used | - |
| C-LAUNCH-31 | The same configuration | Launch twice | Identical but for slug and id | - |
| C-LAUNCH-32 | Custom `path=/x/claude` | Its terminal's and menu row's icon | The robot | terminalLaunchers.test 104 (asserts the opposite) |
| C-LAUNCH-33 | Claude Code `settings: {sandbox: null}`; Codex `trust: {}` | Read and launch | No sandbox key; a correct message | - |
| C-LAUNCH-34 | Trust `${folder}` for Claude Code, `${repository}` for Antigravity, `${folder}` in Codex's file | `trustTarget` | The values L9 lists, for each CLI | clis.test 714 (unknown only) |
| C-LAUNCH-35 | A shared-server agent | Its terminal's and a subprocess's environment | A token path, never the value | core.test 415 (asserts the value) |

Never reached today: `launch.ts` 241-243, 252-253, 343-346 (only `unsafeForCmd`),
422-423, 427-429, 438-439, 540-546; `config.ts` 196; the trust failure at the core
level; all of `host/settings.ts`, `host/showLaunch.ts`, `host/startAgent.ts`; `which`
with relative and `~` values.

### C2.3 Record (`record/*`, `base/lock.ts`, `base/files.ts`, the identity in `host/service.ts`)

| ID | Given | Do | Expect | Today |
| --- | --- | --- | --- | --- |
| C-REC-01 | Record X, lock `closed lab S1`; workspace storage without the id | `recordFor(root, undefined, 'untitled:1', closedIn === 'S1')` | X reused, its identity `untitled:1` | - (record.test 954-976 always passes the id) |
| C-REC-02 | `Ledger.open(d, {owner:'A', session:'S'}).close()` | Open with owner `B`, session `S` | Opens at once; this window's own close | - |
| C-REC-03 | A held lock `424242 0123456789ab`, its pid dead | Open with the session that held it | `lastClose` names this load | - |
| C-REC-04 | An agent started and ended | An extension-host crash (dead-pid lock, same session), then `recover` | The ended agent still listed | - |
| C-REC-05 | #1 lead; #2, #3 its children | `stopping(3,by 2)`; `end(2)`; `clearList()`; `end(3,by 2)`; reopen | Opens | - |
| C-REC-06 | As C-REC-05 through `crash()` and FakeTerminals | `recover`, then #3 ends; reopen | Opens; #3 stopped by #2 | - |
| C-REC-07 | An open table | `start({… worktree: ''})` | Refused before any write | - |
| C-REC-08 | #1→#2→#3→#4; #1–#3 ended | `clearList()` | #2 kept | record.test 578 (depth 2) |
| C-REC-09 | Byte `0xFF` in line 1; torn tail `{"v":5,"se` | Open, append, reopen | Bytes before the last newline unchanged; opens | record.test 370 (text only) |
| C-REC-10 | A complete JSON tail with no newline | Open | Dropped | record.test 370 (part) |
| C-REC-11 | An exit with code 3 while the extension host restarts | `recover` | Exited, 3 | - (FakeTerminals cannot say it) |
| C-REC-12 | A live process holds the lock and never touches it | Wait past 90 s | Still refused | record.test 681 (asserts the takeover) |
| C-REC-13 | Holder touched now; `Date.now` +120 s | Open | Refused | - |
| C-REC-14 | Lock mtime a day ahead; holder alive | `lockWait` | A bounded error | - |
| C-REC-15 | A stale lock | Four child processes open at once | One succeeds, three `LedgerLockedError` | - |
| C-REC-16 | `last-id` = `nine`; the ledger moved aside | Start | No number reused | - |
| C-REC-17 | `identity.json` unreadable | `recordFor` with its own id | An error, not a new record | - |
| C-REC-18 | Identity `…/W.code-workspace`, workspace `…/w.code-workspace` | `recordFor` | The same record | - |
| C-REC-19 | `window-state.json` unreadable, agents running | Service start | The same pipe, or one loud error | - |
| C-REC-20 | An earlier build's record that reached 5, and its storage key | First start | `#a6` | - |
| C-REC-21 | 200 000 valid lines | Time `AgentTable.open` | Within 1 s | - |
| C-REC-22 | An unreadable ledger; restoration unfinished after 60 s | Start | Not moved aside | - |
| C-REC-23 | A cut write whose truncate throws | Then a tool call | The person told; the lock released | record.test 413 (ledger level) |
| C-REC-24 | A mutation lock with foreign content, 3 s old | `withFileLock` | Waits | base.test 294 |
| C-REC-25 | An open table | The write of `last-id` fails | Refused; no run, no file; the next start works | - |
| C-REC-26 | An open table | The token file's write fails | No run; a skipped number allowed; no stray file, now or after reopening | - |
| C-REC-27 | An open table | `last-message-id` or the task's message file fails | No run; no stray token or message; the next start works | - |
| C-REC-28 | An open table | The `agent.started` append fails at its fsync | No run; no `runs/<n>.token` and no task file left, now or after reopening (the review reproduced both left today) | record.test 413 (the ledger alone) |
| C-REC-29 | A child process starting an agent | SIGKILL after each of the writes of C-REC-25–28 | At the next open: no run, no stray file, no number reused | - |
| C-REC-30 | A run allocated | The write of `runs/<n>.launch.json` or a CLI's run file fails | The run ends failed; its files removed; its token revoked | - |

Never reached today: `ledger.ts` 414-416, 428, 248-252; all of `host/service.ts`
74-193 (`handedOver`, `wasThisWindows`, move-aside retry, the pipe fallback, `owner`,
`agentsLogOf`); `identity.ts` 68 with no identity; `list.cleared` below two levels;
`agents.ts` 259-261 (unreachable).

### C2.4 Transport and activation (`transport/*`, `extension.ts`, `host/service.ts`)

| ID | Given | Do | Expect | Today |
| --- | --- | --- | --- | --- |
| C-TR-01 | An agent's shim connected | Dispose the endpoint; start it on another pipe in the same record; call | Succeeds through `window.json` | - |
| C-TR-02 | `FACADE_AGENTS_WAIT_MS=700`, window away | Call, call again at once, restart, call | ~700 ms; under 100 ms; works | transport.test 755 (first call) |
| C-TR-03 | Hello answered; a `/call` accepted and never answered | Call | `unknown` within the wait | transport.test 924 (hello only) |
| C-TR-04 | A shim started with no window, wait 500 ms | `initialize`; start the endpoint; call | The tools available, or `list_changed` sent | - |
| C-TR-05 | Server A on path p | B listens on p; A disposed; call p | B reachable | - |
| C-TR-06 | A cut call | Structured data | `outcome: unknown` | transport.test 720 (asserts its absence) |
| C-TR-07 | A fake server answering an error line with code `UNREACHABLE` | Call | Sent once | - |
| C-TR-08 | `TMPDIR` of 90 characters | `pipePath` | A short path, or a clear error | transport.test 517 (folder only) |
| C-TR-09 | Facade's `.mcp.json`; a shim with no pipe or token | `tools/list` | No tools | transport.test 773 (asserts `facade_status`) |
| C-TR-10 | A log channel that throws after dispose; a throwing disposable | `AgentsService.dispose()` | The lock ends `closed <owner> <load>` | - |
| C-TR-11 | `chmodSync` fails on the socket | Listen | Disposed, one error | - |
| C-TR-12 | Another pid's `window.json` | Dispose this endpoint | That file kept | - |
| C-TR-13 | A body of exactly 1 MiB, and one byte more | Call | Accepted; `TOO_LARGE` on both sides alike | transport.test 346, 743 (boundary unasserted) |
| C-TR-14 | Revoked and made-up tokens | hello, then call | `facade_status`; `REFUSED`; no effect | transport.test 305, 710, 876 |

Never reached today: `pipe.ts` 82, 84-89, 217-221; `endpoint.ts` 102-104; `shim.ts`
121, 201-209; all of `host/service.ts` (C2.3); `extension.ts` 43-52.

### C2.5 Project integration (`core/injections.ts`)

| ID | Given | Do | Expect | Today |
| --- | --- | --- | --- | --- |
| C-INJ-01 | A `writing` journal whose `before` is the person's bytes; the file holds the new hash | `recover` | The person's bytes back | - |
| C-INJ-02 | `writing` with a previous record | `check`, then start | Not refused; the previous record back | - |
| C-INJ-03 | A merged file; killed after its write (child process, SIGKILL in `log`) | The person edits it; `recover` | Backup kept, the person told | - |
| C-INJ-04 | A merged file; killed after its restore, before the record write | `recover` | No "changed" notice | - |
| C-INJ-05 | No file; a run live; the person adds a server | A second start; both end | The second shares; only `facade` removed | - |
| C-INJ-06 | The person's file merged; the person edits `facade.args` | It ends | Kept, backup, one diagnostic | - |
| C-INJ-07 | The person's `{"x":1}` merged; the person adds a server | It ends | `{"x":1,"mcpServers":{their server}}` | - |
| C-INJ-08 | The person removes `facade` from the merged file | It ends | Kept and told | - |
| C-INJ-09 | The person deletes the merged file; a second start; both end | - | The original backup kept | core.test 1216 (one start) |
| C-INJ-10 | A Facade-created file edited | It ends | Left, logged | - |
| C-INJ-11 | `.mcp.json` in cp1252; with 2^60, `1.0`, `é` | Start and end, with and without an edit | Byte-identical without an edit; values kept with one | - |
| C-INJ-12 | `uchg` on the merged file | End; `chflags nouchg`; 15 s on the fake clock | Retried and restored | - |
| C-INJ-13 | `uchg` on SKILL.md inside a made folder | End | The made folders kept; logged | - |
| C-INJ-14 | `chmod 000` on `.mcp.json`; a folder named `.mcp.json`; a file named `.agents` | Start | Refused, naming the file and why | - |
| C-INJ-15 | `injected.json` in the previous build's format, or with an invalid user | Start or release | Kept aside; files and backups taken back | - |
| C-INJ-16 | The lock held by a live pid | Start; release | A clear error; release retried | - |
| C-INJ-17 | Runs in two worktrees, one shared exclude | The first ends | The line kept until the last | core.test 1232 (one folder) |
| C-INJ-18 | Real git: a run in worktree `W` | The person makes `.mcp.json` in main; `git status`; check out a branch that tracks it | Visible; not overwritten | - |
| C-INJ-19 | A file created during `gitOf` (a hold in FakeGit) | Start | No exclude line for it | - |
| C-INJ-20 | The person's untracked `.mcp.json` merged in `W` | `stop_agent` with deletion | Refused before any stop | - |
| C-INJ-21 | A start held at the terminal, then the window disposed | Reload, `recover` | Files kept while starting; released once it is found gone | - |
| C-INJ-22 | `terminals.failNext` with a told CLI | Start | Failed, files released | core.test 364 (no injection) |
| C-INJ-23 | `noProcessIds`; a second workspace; the holder's pid killed | The other window recovers | Files kept | - |
| C-INJ-24 | A folder opened through a link; a dangling `.mcp.json` link; `.agents` linking outside | Start, end | Lines added; one shared entry; links intact; nothing written outside | - |
| C-INJ-25 | A base commit with a JSONC `.mcp.json` | `new_worktree` | Refused, no worktree | - |
| C-INJ-26 | `info/exclude` without a final newline; absent | Start, end | Byte-identical; absent again | core.test 1042 (asserts `''`) |
| C-INJ-27 | A custom injector's path `../x` | `check` | "leads out" | - |

Never reached today: `injections.ts` 221 with `writing`, 311-318, 381-390, 420-423,
476-486, 518-549, 580-586, 599-601, 620-623, 634-642, 672-681, 790; `facade.ts`
835 → 870-884; `launch.ts` 252-253.

### C2.6 Workbench, terminals and worktrees (`src/vs/workbench/contrib/{facadeCommands,terminal,terminalLaunchers,worktrees,folderTerminals}`, `host/terminals.ts`, `host/git*.ts`)

| ID | Given | Do | Expect | Today |
| --- | --- | --- | --- | --- |
| C-WB-01 | A single folder; a child held under an unjoined row | Reveal it (Show Active Agents, a row click, `_facade.terminal.reveal`) | The window's change is the person's choice and every run survives it (I-1); a logpoint at `WorkspaceBarModel.add` records each caller in every B case | folderTerminals.test 745 (asserts the join) |
| C-WB-02 | A single-folder window on worktree `W`, an agent in it | `stop_agent` with deletion | No `show(main)` that adds a folder; refused (SP-23) | - |
| C-WB-03 | `W` the first folder of a workspace | An agent deletes it | Answered; every agent still works | - |
| C-WB-04 | An agent's `makeWorktree` with a failing copy and hook | Make | No notification; diagnostics returned; progress in the window | - (`progressShown` asserted for deletion only) |
| C-WB-05 | Folders not followed, or the row not read yet | A child with `new_worktree` and setup | Both terminals behind; the active instance unchanged | folderTerminals.test 606 (placement only) |
| C-WB-06 | An agent's terminal | The backend fires `onPtyHostRestart` | Not relaunched; the run ends | - |
| C-WB-07 | An agent's terminal with a pending environment collection | Its status actions | No Relaunch | - |
| C-WB-08 | An agent's terminal whose icon was changed | Restart (NewWindow) | Not revived | - |
| C-WB-09 | Window A crashed with agents; window B | Attach to Session in B | No agent listed | - |
| C-WB-10 | Stored names; orphan agent processes; NewWindow | Both services restore | The taken-back terminal reads `@x #aN` | facadeRuns.test 198 and terminalLauncherService.test 150 (each alone) |
| C-WB-11 | An orphan whose cwd is a subfolder | Take back | Held for the run's folder | facadeRuns.test 198 (cwd = folder) |
| C-WB-12 | `check` gives `{files: [], submodules: true}` | `removeWorktree` without discard | Refused | worktrees.test 849 (the person's path) |
| C-WB-13 | A detection result changed | Open the menu once | The new result at that opening | - |
| C-WB-14 | Worktrees hidden on the bar | `_facade.worktree.delete` | Deleted | facadeCommands.test 230 (fake service) |
| C-WB-15 | The person's start; a folder switch at `_facade.terminal.create` | - | The window stays on the new folder | facadeCommands.test 297 (fake reveal) |
| C-WB-16 | An editor-area run killed with no exit code | `_closed` | Not by the person | facadeRuns.test 133 (part) |
| C-WB-17 | `makeWorktree` for `/tmp/x` and `/private/tmp/x`; two repositories with one basename | Make both at once | Serialized; distinct folders | worktrees.test 497 (one spelling) |
| C-WB-18 | `HostTerminals` | `launch` of a closed terminal; `isAlive` unknown; `lookForEnds` overlapping | As specified for each | - |
| C-WB-19 | A renamed agent tab | - | `mine` with `@x #aN` | - |
| C-WB-20 | `git status` of a worktree during a commit in it | `changedFilesIn` | No `index.lock` clash (`GIT_OPTIONAL_LOCKS=0`) | - |
| C-WB-21 | `removeWorktree` held after `check` | A new file and a changed owned file (`.mcp.json`) appear; an editor of the worktree turns dirty | Refused before git removes it; no save dialog; nothing lost | - |
| C-WB-22 | A terminal not registered in the worktree whose cwd is inside it; a run registered in it whose cwd is outside | The agent path's deletion | The sweep closes only what the caller was told about: no agent outside the request is ended unnamed | - |

Never reached today: `facadeRuns.ts` 195-197, 213-215; `facadeCommands.contribution.ts`
237-240 (Windows); `worktrees.ts` 919-922 when main is not a folder, and a failure
after `remove`; `terminalLauncherDetection.ts` 45-53; `terminalLauncherService.ts`
272-282; all of `HostTerminals`.

## C3. Invariants and every place that can break them

Each invariant is a promise of the specifications stated as a property of the state.
For each, the code locations that write the state it is about (from the six module
reviews of 2026-10-08), and the cases that exercise each location. A location with
no case is a gap in this plan and gets one.

| ID | Invariant | Write sites (extensions/facade-agents/src unless `src/vs/`) | Cases |
| --- | --- | --- | --- |
| I-1 | A window keeps one record through reload, extension-host restart or crash, folder → workspace and Save As; two live windows never share one | host/service.ts:84-97 (record id and owner from workspace storage), record/identity.ts:61-76, record/ledger.ts:396-429 (lock), host/windowState.ts:24-32 (pipe id), `src/vs/…/facadeRuns.ts:251-254` (take-back by VS Code's workspace id) | CU-08, CU-09, WIN-01–08, WIN-17, WIN-18, REC-09, REC-13 |
| I-2 | Every live agent's MCP server reaches the window's current endpoint within a second of it listening | transport/endpoint.ts:67, 94-96 (path fixed at launch); transport/shim.ts:39-55, 82-113 (never rereads `window.json`); host/service.ts:341-361 (pipe id); transport/pipe.ts:71, 188-196 (unlink on listen and close) | WIN-01, WIN-03, WIN-04, TR-07, TR-08, TR-16 |
| I-3 | Every call answers within the timeout, counted from acceptance | core/launch.ts:212, 367 (timer from allocation); core/facade.ts:354 (worktree and setup unbounded), 617-631 (stop deadline after the launch); transport/pipe.ts:282-345 (no timer once connected); transport/shim.ts:125 (a new wait per call); host/gitCli.ts:13 (10 s per git call, in series); base/lock.ts:24 (synchronous 5 s) | LC timeout row, AS-16, AS-17, SP-07, TR-08, TR-17, G3, G14 |
| I-4 | An accepted operation has exactly one recorded outcome, and every answer whose effects may have happened names the run and `outcome: unknown` or `pending` | core/facade.ts:351-360 (the worktree made before the run exists), core/launch.ts:194, 255-264, 548; record/agents.ts:219-264 (allocation's writes, not atomic together); host/service.ts:212-216 (ledger closed under calls in flight); core/facade.ts:760-762, 776; transport/shim.ts:156-158 | B8 reload, restart, transition rows; WIN-03; TR-09; TR-10 |
| I-5 | A refusal leaves nothing behind, and a stop with deletion either stops nobody or deletes | core/facade.ts:346 (file conflicts not checked for a new worktree), 370 (trust read after the worktree), 455-458 (stops, then refuses); core/injections.ts:303-321 (a person's merged file counted as Facade's) | AS-11, INJ-11, TRU-09, SP-10–12, SP-19 |
| I-6 | Nothing outside the caller's reach is listed, resolved, stopped, ended or named | core/facade.ts:435-436, 938-950, 966, 982; `src/vs/…/worktrees.ts`:933-935, 978-1001 (the deletion's sweep closes terminals by their cwd, whoever registered them) | RCH-01–06, ID-06, SP-27 |
| I-7 | No agent action moves the person's view, notifies the person or changes the workspace's folders | core/launch.ts:246 (reveal only for the person); host/git.ts:36 (`show` false); `src/vs/…/folderTerminals.ts`:480-487 (panel fallback), 551-552 (revealing a held run joins its row); `src/vs/…/worktrees.ts`:656-678, 694, 762-764 (notifications, expansion), 919-935 (`show(main)`, folder removal, terminals closed) | CU-03, CU-04, AS-08, AS-19, AS-28, AS-29, SP-22, SP-23, UI-11, G1, G5, G8 |
| I-8 | Agent and message numbers only grow | record/agents.ts:221-236; every new record (I-1); earlier builds' records | ID-01, REC-08, G13 |
| I-9 | The ledger is always readable: the writer appends only what the reader accepts | record/ledger.ts:214-236 (no validation on append), 296, 335 (repair offset from decoded text); record/events.ts:355 with 467-476 (`list.cleared` drops a stopper); core/facade.ts:276, 298, 690 (`worktree: ''`) | REC-04, REC-05, REC-12, C-REC-07–09 |
| I-10 | Project files: restored byte-identical; the person's edits never lost; nothing of the person's hidden from git | core/injections.ts:230-295, 377-413, 438-608, 629-652; base/files.ts:86-130 | INJ-01–20 |
| I-11 | CLI configuration: only the intended trust entries change; never malformed; unrelated content kept | clis/trust.ts:29-122; base/files.ts:189-235; base/lock.ts | TRU-01–09, G12 |
| I-12 | The sandbox and approvals reported are the effective ones | core/launch.ts:203; clis/describe.ts:59, 89; clis/claude.ts:66, 118 | YO-01–06, YO-09, YO-11, CFG-07 |
| I-13 | Each value is one argument with its meaning kept | clis/cli.ts:102-109; the model and effort groups of claude.ts, codex.ts, muse.ts, antigravity.ts; clis/codex.ts:10-18 (TOML) | CFG-11, CFG-16, AS-12, AS-24 |
| I-14 | No token in any environment, argument, log, result or Show Agent Launch | transport/endpoint.ts:94-96; core/launch.ts:239; record/agents.ts:229, 256 | TR-06, TR-11, G9 |
| I-15 | One run, one terminal, one process, run once; it ends once; its files go with it | `src/vs/…/facadeRuns.ts`:190-260; `terminalProcessManager.ts`:552-580 (relaunch after a pty host restart); `environmentVariableInfo.ts`:43; `terminalService.ts`:535, 552 and `terminalEditorSerializer.ts`:41 (restore by icon); `terminalActions.ts`:838 (attach); `terminalLauncherService.ts`:222-225 (count by icon); host/terminals.ts:90-105; record/agents.ts:321, 362-366 | G4, G7, G11, TM-01–17, UI-09, NI-06, REC-14 |
| I-17 | A worktree deletion never loses work nobody decided on | `src/vs/…/worktrees.ts`:887 (Facade's owned files excluded by name), 875-939 (submodules ignored; awaits between the check and the forced removal); host/git.ts:42-44 (unsaved editors by exact path); core/injections.ts:303-321 | SP-10–12, SP-15, SP-19, SP-24–26, C-WB-21 |
| I-16 | Framework off answers at once with no effect | contract/tools.ts:52-54 (hello not gated), 62-64; transport/endpoint.ts:50 (no enabled state) | FW-01–06, TR-03 |

## C4. Interleavings

Every `await` on the start, stop, deletion, activation and recovery paths, with the
events that can land there. A cell passes when the B8 rule holds: one recorded
outcome, nothing appears after its run ended, no orphan (G11), the global checks.

How each point is held, in order of preference: **U** a unit test with a fake that
holds (`FakeGit.hold`, `FakeTerminals.hold`, the fake clock - adding `makeHold`,
`changesHold`, `deleteHold` and a stop counter to `test/fakes.ts`); **L** a natural
live hold (a slow `post-checkout` hook, a slow setup, `fake-late`, `fake-slowstop`);
**D** a dap-cli breakpoint in the extension host or the renderer, the event made
while it is paused, then continued.

| Point | Where | Events landing there | Hold |
| --- | --- | --- | --- |
| Folder and branch lookup | core/facade.ts:329 (`placeOf`, git per workspace folder) | stop of the caller; a workspace folder removed; reload | U, D |
| CLI lookup and environment | core/facade.ts:331, 340 | setting changed (enabled, path, launch); reload | U |
| Worktree creation and setup | core/facade.ts:354 → `_facade.worktree.create` | stop by name or number; delete_worktree of the folder; a second start of the same name; reload; restart; folder → workspace; framework off; the caller exits | L, U |
| Trust write | core/facade.ts:370 (synchronous lock) | another window's start merging the same file | L (two instances), U |
| Allocation | core/launch.ts:194 | delete_worktree begins (D3 of the core review); ledger taken | U, D |
| Project files | core/launch.ts:236 (`gitOf`, then `put`) | stop; delete_worktree; the person creates the same file; reload; extension host killed | U, D |
| Terminal creation | core/launch.ts:246 → `_facade.terminal.create` (waits for the process up to 5 s) | stop; the person closes the new tab; reload; restart | U, D (renderer) |
| Connection wait | core/launch.ts:286 | stop; CLI exits; timeout; reload; restart; framework off | L |
| Task typing | core/launch.ts:433-445 (taskDelay, enterDelay) | stop; the person types; CLI exits | U, L (Antigravity) |
| Stop wait | core/facade.ts:617 (`whenOpened`), 622-631 | a second stop; the process exits; the person closes the tab; reload | U, L |
| Deletion preflight | core/facade.ts:427-443 | a start into the folder; a file appears; a second deletion; reload | U |
| Deletion stops and recheck | core/facade.ts:446-461 | a file appears; a start into the folder; another window's agent in it | U, L |
| Deletion's last check to removal | `src/vs/…/worktrees.ts`:887-939 | the person types into an editor of the worktree; edits an owned file; a file appears | D (renderer), U |
| Allocation's writes | record/agents.ts:219-264 | a failed write; a kill | U (`replaceFsFunction`), a child process |
| Activation | host/service.ts:84-101 (load, handover, lock wait, process check) | the old extension host still closing; a second window on the same record; Start Agent clicked | D, L |
| Endpoint serving before recovery | host/service.ts:172-187 | tool calls and hellos from surviving agents during `recover` | D |
| Recovery | core/facade.ts:502 (`isAlive` per agent), 545-595 (`goOn`, `findAgain`) | an agent exits; a stop arrives; the window is disposed | U, D |
| Deactivation | extension.ts:72-78, host/service.ts:199-218 | a start or stop in flight; a throwing disposable | U |

## C5. Seeded faults

Each fault is applied alone in a scratch worktree of the commit under test, rebuilt,
and the named cases run. A fault no case catches means a case is missing.

| ID | Fault | Must be caught by |
| --- | --- | --- |
| M1 | `reaches` always true (core/facade.ts:938) | RCH-02 |
| M2 | `assertNotDeleting` does nothing | SP-16 |
| M3 | The deletion preflight ignores changes | SP-10 |
| M4 | Names allow uppercase | AS-03 |
| M5 | Agent-started terminals revealed (core/launch.ts:246) | AS-19 (G5) |
| M6 | Worktree created with `show: true` (host/git.ts:36) | AS-08 (G1) |
| M7 | `recordFor` always makes a new record | WIN-01 |
| M8 | No framework check in `Contract.call` | FW-01 |
| M9 | A token not revoked at its run's end | REC-02 |
| M10 | The next number from the ledger only, not `last-id` | the unit test of a crash between `last-id` and the append |
| M11 | A second stop writes `stopping` again | SP-04 |
| M12 | The start timer never fires | AS-16 |
| M13 | A child takes the current YOLO setting | AS-22 |
| M14 | Release ignores other users of a project file | INJ-06, INJ-09 |
| M15 | The trust merge replaces the file | TRU-01 (G12) |
| M16 | A tab the person closed recorded as exited | TM-01 |
| M17 | A child's nonzero exit notifies the person | TM-12 |
| M18 | The torn-tail repair disabled | REC-04 |
| M19 | `isFacadeRunTerminal` false | TM-07 |
| M20 | The button counts ended agents | UI-09 |

## C6. Defects found by reading

Found by the six module reviews and the review of this plan, before any case ran. Each is expected to fail its
case today; each is fixed and its case passes before the stack is accepted (E2).
**S1**: an agent loses Facade, the person's work or files are lost, a CLI runs again,
or a sandbox is off unannounced. **S2**: a wrong or missing outcome, an unbounded
wait, or a visible break of the specifications. **S3**: minor or latent.
CONFIRMED unless marked (s), suspected.

| ID | Sev | Defect | Where | Cases |
| --- | --- | --- | --- | --- |
| X-01 | S1 | **P-2.** The record's id and owner live in workspace storage, which VS Code does not carry into a workspace (`switchToWorkspace` ignores `preserveData`). Add Folder in a folder window, or Save Workspace As, makes a new record, owner and pipe; the running agents lose Facade; numbers restart at `#a1`. Confirmed on disk by the 11:08 records | host/service.ts:34-36, 84-97, 261-269; record/identity.ts:61-76 | CU-08, CU-09, WIN-04, WIN-05, C-REC-01, C-REC-02 |
| X-02 | S1 | Each shim is pinned to the pipe path it was launched with and never rereads `window.json` (RT-28): any pipe change cuts it off for good | transport/endpoint.ts:67, 94-96; transport/shim.ts:39-113 | TR-08, WIN-04, C-TR-01 |
| X-03 | S1 | After X-01, opening the original folder again re-adopts the old record: the converted window's live agents are recorded stopped and their run and project files removed under them; their shims reach the wrong window, then are told to stop working | core/facade.ts:500-531; host/service.ts:172-187 | WIN-17 |
| X-04 | S1 | **P-1's path.** Revealing a child held for a worktree that has not joined (Show Active Agents, a row click, `_facade.terminal.reveal`) joins it; in a folder window that makes a workspace and restarts the extension host. Reading did not establish which caller fired at 11:08:44; C-WB-01's logpoint records it | folderTerminals.ts:551-552; workspaceBarPart.ts:300-321 | CU-03, CU-04, UI-11, C-WB-01 |
| X-05 | S1 | An agent's `delete_worktree` of the window's own folder runs `show(main)`, adding the main checkout, then removes the folder; of a workspace's first folder, it restarts the extension host - cutting its own call | worktrees.ts:919-922, 929 | SP-22, SP-23, C-WB-02, C-WB-03 |
| X-06 | S1 | An agent's CLI runs again in its terminal: relaunch after a pty host restart; **Relaunch Terminal** in the environment status; revival after an app restart when its icon was changed (restore filters by icon) | terminalProcessManager.ts:552-580; environmentVariableInfo.ts:43; terminalService.ts:535, 552; terminalEditorSerializer.ts:41 | TM-08, TM-16, TM-17, C-WB-06–08 |
| X-07 | S1 | Claude Code's YOLO-off sandbox is carried only by the `quiet` group; `quiet: null` turns it off while the record, the list and Show Agent Launch say on | clis/claude.ts:66, 118; core/launch.ts:203; clis/describe.ts:89 | YO-11, C-LAUNCH-05 |
| X-08 | S1 (s) | A `model` or `effort` starting with `-` is a separate argument after its option: a CLI may read it as an option (a YOLO-off child passing `--disable-sandbox`) | the model and effort groups of claude.ts:73, codex.ts:61, muse.ts:29, antigravity.ts:40 | AS-24, C-LAUNCH-10 |
| X-09 | S1 | The worktree is made before the run exists: it cannot be listed or stopped meanwhile, and an interruption leaves a worktree nobody recorded (O9's order is allocate, then create) | core/facade.ts:351-360; core/launch.ts:194 | LC creating_worktree column, C-CORE-09, C-CORE-10 |
| X-10 | S1 | A start can race `delete_worktree` into the same folder and be deleted under; the guard is a set a second deletion clears; other windows' agents in the folder are not seen | core/facade.ts:435-469, 666, 687; core/injections.ts:303-321 | SP-16, SP-18, SP-20, C-CORE-13–15, C-CORE-25 |
| X-11 | S1 | The previous build's `injected.json` is not migrated: read as empty, then rewritten or deleted - its files and the person's backups orphaned, later starts refused | core/injections.ts:97, 629-652 | INJ-18, C-INJ-15 |
| X-12 | S1 | Exclude lines go to the repository's shared `info/exclude`: the person's new `.mcp.json` or skill in any worktree is hidden from git (and so expendable to checkout and clean) | core/injections.ts:416-432; host/gitCli.ts:155 | INJ-17, C-INJ-18 |
| X-13 | S1 | The ledger can be made unreadable by ordinary paths: a stop by a sibling that `list.cleared` dropped; `worktree: ''`; the tail repair counting decoded text | record/ledger.ts:214-236, 296, 335; record/events.ts:355, 467-476; core/facade.ts:276, 298, 690 | REC-12, C-REC-05–07, C-REC-09 |
| X-14 | S1 | An agent's deletion ignores submodules and forces removal: unpushed submodule commits lost without `discard_changes` | worktrees.ts:887-893, 914 | SP-24, C-WB-12 |
| X-15 | S2 | The wait budget starts at allocation, not acceptance; worktree creation and setup have no bound (RT-5); a stop's deadline starts after the launch it waits for | core/launch.ts:212, 367; core/facade.ts:354, 617; worktrees.ts:374 | AS-25, LC timeout row, C-CORE-11, C-CORE-12 |
| X-16 | S2 | A call the window accepted has no bound: a frozen extension host hangs the caller | transport/pipe.ts:282-345 | TR-17, C-TR-03 |
| X-17 | S2 | During an outage every call waits the full timeout; no background discovery | transport/shim.ts:125 | TR-08, C-TR-02 |
| X-18 | S2 | A shim that missed the window at its start only ever offers `facade_status`, which then fails as unknown; Codex gives up on the server after 30 s while the shim may wait 120 s | transport/shim.ts:115-123; transport/mcpServer.ts:167; clis/codex.ts:47 | TR-16, TR-18, C-TR-04 |
| X-19 | S2 | Answers after allocation carry no id, outcome or phase in their data; a lost reply has no `outcome: unknown` (RT-22) | core/launch.ts:548; core/facade.ts:358; transport/shim.ts:156-158 | AS-18, TR-09, C-CORE-17, C-TR-06 |
| X-20 | S2 | Operations in flight are cut when the window goes: the ledger is closed under them | host/service.ts:212-216 | B8 reload and restart rows, WIN-03 |
| X-21 | S2 | After a reload a starting run has no timer: never unconfirmed, the person never told | core/launch.ts:313-322 | B8 reload × connecting, C-CORE-20 |
| X-22 | S2 | A pending stop is not continued though its answer says it is; SIGHUP is never escalated | core/facade.ts:627; facadeCommands.contribution.ts:243-246 | SP-07, C-CORE-16 |
| X-23 | S2 | A deletion stops every agent, then refuses with a success-shaped answer (late changes, or the person's merged file counted as Facade's) | core/facade.ts:455-458; core/injections.ts:311-318 | SP-15, SP-19, C-CORE-21, C-INJ-20 |
| X-24 | S2 | An extension-host crash clears the ended agents as if the app had started fresh | core/facade.ts:539; record/ledger.ts:178-182 | REC-10, C-REC-04 |
| X-25 | S2 | A known exit seen at reconciliation is recorded as lost | host/terminals.ts:90-105; core/facade.ts:524-531 | REC-14, C-REC-11 |
| X-26 | S2 | `list.cleared` drops intermediate ancestors | record/events.ts:467-476 | REC-11, C-REC-08 |
| X-27 | S2 | A live holder's lock is taken over after 90 s untouched, by the wall clock (RT-30) | record/ledger.ts:28-30, 419, 82-97 | REC-06, C-REC-12–14 |
| X-28 | S2 | A Facade-created project file the person edited keeps Facade's entry for good, and a second compatible start is refused | core/injections.ts:574-586, 396-406 | INJ-06, C-INJ-05 |
| X-29 | S2 | The person's edit to Facade's own entry in a merged file is dropped | core/injections.ts:688-695 | INJ-16, C-INJ-06 |
| X-30 | S2 | A new worktree's integration-file conflicts and a malformed trust file are found only after the worktree is made (RT-23) | core/launch.ts:168-170; core/facade.ts:346, 370 | INJ-11, TRU-09, C-INJ-25, C-LAUNCH-06 |
| X-31 | S2 | Agents taken back after a renderer crash lose `@name #aN`, are held by their current folder, and those from before a conversion are skipped | terminalLauncherService.ts:196-208; facadeRuns.ts:249-258 | WIN-13, C-WB-10, C-WB-11 |
| X-32 | S2 | Attach to Session in another window offers a reloading or crashed window's agents | terminalActions.ts:838 | TM-07, C-WB-09 |
| X-33 | S2 | An agent's worktree creation shows notifications; the panel fallback makes its terminals active | worktrees.ts:656-678, 762-764; folderTerminals.ts:480-487 | AS-28, AS-29, C-WB-04, C-WB-05 |
| X-34 | S2 (s) | The person's start reveals into the folder it was asked from, after they moved on | facadeCommands.contribution.ts:191; folderTerminals.ts:551 | PS-15, C-WB-15 |
| X-35 | S2 | The token is passed by value in the environment of shared-configuration CLIs, inherited by their subprocesses (RT-20) | transport/endpoint.ts:94-96; core/launch.ts:239 | TR-06, TR-11, C-LAUNCH-35 |
| X-36 | S2 | `window.json` has no enabled state; hello ignores the switch (RT-31) | transport/endpoint.ts:14-18, 50; contract/tools.ts:52-54 | FW-02, TR-03, C-CORE-01 |
| X-37 | S2 | A workspace folder missing on disk turns every start with a folder, and a deletion retry, into git's raw `FAILED` | host/gitCli.ts:42-60; core/facade.ts:274-279, 427 | AS-26, SP-21, C-CORE-08 |
| X-38 | S2 | Show Agent Launch and run metadata: sandbox static, overrides undetected (RT-15), no verified version (RT-29), placeholder errors not shown, a custom `a.b` shows `{}` | clis/describe.ts:59, 89; host/showLaunch.ts:77, 102-121 | UI-15, YO-09, C-LAUNCH-19 |
| X-39 | S2 | CLI discovery uses the extension host's PATH (RT-16); the schema's CLI list is frozen at hello; broken entries listed inconsistently | host/service.ts:151; contract/startAgent.ts:39-51; clis/registry.ts:28-31 | LS-07, C-CORE-23, C-LAUNCH-16 |
| X-40 | S2 (s) | Ends caused by git or a deletion's terminal sweep are recorded as the person's | facadeRuns.ts:239 | C-WB-16 |
| X-41 | S2 | With worktrees hidden on the bar, `delete_worktree` always fails | worktrees.ts:379-385 | AS-27, C-WB-14 |
| X-42 | S2 (s) | Antigravity with YOLO off drops `--mode accept-edits`: it may ask before every edit | clis/antigravity.ts:36-37 | YO-12, C-LAUNCH-26 |
| X-43 | S2 (s) | The typed task notice can merge with the person's typing; a stop does not stop the typing | core/launch.ts:433-447, 479 | PS-14, C-CORE-19 |
| X-44 | S2 | A shim with no connection (a hand-run `muse`, VS Code's own MCP discovery) offers `facade_status` | transport/shim.ts:115-123 | TR-12, TR-14, C-TR-09 |
| X-45 | S2 | The log is disposed before the service: a throwing dispose skips the lock's release, so the next host sees a crash | extension.ts:25, 72-78 | C-TR-10 |
| X-46 | S2 | A closing server unlinks a socket another server re-bound | transport/pipe.ts:71, 188-196 | C-TR-05 |
| X-47 | S2 (s) | Codex's `-c mcp_servers.facade.*` merges into the person's own `[mcp_servers.facade]` | clis/codex.ts | C-LAUNCH-28 |
| X-48 | S2 (s) | Trust files: JSONC read as unreadable; large integers and duplicate keys lost; minified files re-indented | base/files.ts:145-204 | C-LAUNCH-09 |
| X-49 | S2 | Earlier builds' records are not continued: numbers restart (RT-34) | host/service.ts; record/agents.ts:22-23, 114 | REC-08, C-REC-20 |
| X-50 | S2 | The menu shows the previous detection (RT-25) | terminalLauncherActions.ts:86-89 | UI-04, C-WB-13 |
| X-51 | S2 | The button and Show Active Agents count terminals by icon, not by run (RT-26) | terminalLauncherService.ts:222-225 | UI-09, NI-06 |
| X-52 | S2 | A renamed tab loses `@name #aN` (RT-24) | terminalInstance.ts:2177, 2823 | ID-03, C-WB-19 |
| X-53 | S2 | `list_agents` data lacks the caller, counts, phase and stop actor; "not connected yet" for ended runs | contract/listAgents.ts:39, 96; core/facade.ts:1011-1034 | LS-05, LS-06, C-CORE-22 |
| X-54 | S3 | Errors name agents outside the caller's reach | core/facade.ts:948, 982 | ID-06, C-CORE-06 |
| X-55 | S3 | The task refusal names the framework when the cause is a removed group | core/facade.ts:335-337 | C-CORE-07, C-LAUNCH-17 |
| X-56 | S3 | The task is trimmed | contract/args.ts:42 | C-CORE-27 |
| X-57 | S3 | A git timeout reads as "not a branch name"; a `name/…` clash fails late as `FAILED` | host/gitCli.ts:239-246 | AS-11 |
| X-58 | S3 | `${home}` is the extension host's in arguments, the terminal's in trust; trust placeholders differ by CLI | clis/cli.ts:292; clis/trust.ts:35 | C-LAUNCH-04, C-LAUNCH-34 |
| X-59 | S3 | Settings coerced silently; a path of spaces falls back to PATH; relative and `~` paths resolved against the extension host | host/settings.ts:74; clis/config.ts:18-20, 45; clis/executable.ts:39 | CFG-19, CFG-22, C-LAUNCH-14, C-LAUNCH-18 |
| X-60 | S3 | A custom agent running a built-in's program gets its logo | core/launch.ts:246; terminalLaunchers.ts:42-50 | ID-04, C-LAUNCH-32 |
| X-61 | S3 | Codex's TOML encoding is `JSON.stringify` | clis/codex.ts:10-18 | C-LAUNCH-11 |
| X-62 | S3 | Project files lose non-UTF-8 bytes and number forms through a parse round trip | core/injections.ts:479, 567, 664 | INJ-19, C-INJ-11 |
| X-63 | S3 | Symbolic links: writes outside the project; a dangling link destroyed; a linked folder gets its own entry | core/injections.ts:733-736 | INJ-20, C-INJ-24 |
| X-64 | S3 | Backups lost after a crash and an edit, or a later start; a false diagnostic; project writes not stamp-checked | core/injections.ts:261, 475-489, 567-578 | C-INJ-03, C-INJ-04, C-INJ-09 |
| X-65 | S3 | Leftovers: an empty `info/exclude`, a dropped newline, `.next` temp files, new files 0600, `kept/` copies 0644 and never cleaned | core/injections.ts:611-626, 780-805; base/files.ts:101-120 | INJ-01, C-INJ-26 |
| X-66 | S3 | An unreadable identity, a case variant of the workspace file, or an unreadable `window-state.json` silently starts a new record or pipe | record/identity.ts:38-45, 65; host/windowState.ts:24-32 | REC-13, C-REC-17–19 |
| X-67 | S3 | Show Agents Log finds the record through workspace storage (shows nothing after X-01) | extension.ts:86-93 | UI-14 |
| X-68 | S3 | The ledger is never compacted | record/ledger.ts:292-338 | C-REC-21 |
| X-69 | S3 | Facade's `git status` takes the index lock | host/gitCli.ts:254 | C-WB-20 |
| X-70 | S3 | Window error codes share the transport's names; the socket path can exceed 104 bytes with a long `TMPDIR` | transport/pipe.ts:25, 333 | TR-15, C-TR-07, C-TR-08 |
| X-71 | S3 (s) | The unsaved-changes preflight misses notebooks and other spellings of a path | host/git.ts:42-44 | SP-25 |
| X-72 | S3 (s) | The worktree queue is keyed by path spelling; repositories with one basename share a parent folder | worktrees.ts:369 | AS-30, C-WB-17 |
| X-73 | S1 | The workbench excludes Facade's owned files by name only, then forces the removal after several awaits: the person's edit to an owned `.mcp.json`, or a file or unsaved edit made after the check, is deleted though nobody decided on it | worktrees.ts:887, 912-939 | SP-26, C-WB-21 |
| X-74 | S1 | The deletion's sweep closes every terminal whose current or first folder is inside the worktree - an agent registered elsewhere, or outside a YOLO-off caller's reach, is ended unasked and unreported | worktrees.ts:933-935, 978-1001; core/facade.ts:435 | SP-27, C-WB-22 |
| X-75 | S2 | Allocation is not atomic across its files: a failed `agent.started` append leaves `runs/<n>.token` and the task file (reproduced by the review) | record/agents.ts:219-264 | C-REC-25–30 |

# Part D: Not run here

| What | Spec | Why |
| --- | --- | --- |
| Windows and Linux; Windows `.cmd` shims | L1, L10, L14, LA-20, O13 | Only this Mac. The Windows launch path has unit tests (C1) |
| Remote windows: SSH, containers, WSL | L1, LA-04 | Outside this release (L1) |
| `send_message`, `read_messages`, mailboxes, doorbells, "task fetched", messages to `@human`, lifecycle messages to creators | L4, L5, L6, L13, O6, O7, OR-05 | AGENT-MESSAGES.md is not written, and none of it is built. Until then a task is a `#m` file whose path the launch notice gives (AS-14) |
| `read_screen`, `type_text`, `press_keys`, final screens, screen excerpts in results | L4, L5, L6, L9, L12, O3 | AGENT-DEBUGGING.md is not written, and none of it is built |
| The journeys' corrections, reports, debug steps and ten-second rule; the M12 and D11 journeys | L16, O13 | As above; the rest of each journey runs (J-01, J-02) |

# Part E: Running it

## E0. Steps

The campaign runs as numbered steps; progress is reported as "step N of 20". Nothing
is committed during it: the fixes stay in the working tree, and each batch's diff is
saved as a patch under `~/facade-e2e-results/patches/`. How to commit is decided with
the person once step 20 is done.

| Step | What | Produces | The person's screen |
| --- | --- | --- | --- |
| 1 | The person grants computer use; a safety snapshot: `~/.facade` listed, CLI configuration hashed, Antigravity's `settings.json` backed up, the person's window pids noted | Snapshot in the results | Granting only |
| 2 | Fresh build of the dev build and the extension at HEAD; commit, macOS, architecture and CLI versions recorded | Build log, versions | - |
| 3 | The fixture recreated (A5) | `~/facade-e2e` | - |
| 4 | Tools: the fake CLI's additions (A6), `facade-human`, `e2e-check` (G1–G15), the runner for scripted cases, the results file and evidence folders | Tools, `AGENT-TEST-RESULTS.md` | - |
| 5 | The test instance (A1) with inspector ports, coverage and the `WorkspaceBarModel.add` logpoint; `e2e-check` idle; NI-01 | Baseline of ordinary terminals | Briefly |
| 6 | Unit suites with coverage (C1) | Run 0 | - |
| 7 | Baseline: B1 and every scripted case; each C6 defect marked reproduced, not reproduced or not reachable yet; new failures numbered N-01 on | Run 1 | Yes, about 3 h |
| 8 | Batches of about twenty from what step 7 confirmed, sent to the person as a short list | Batch list | - |
| 9 | Batch 1 fixed, each fix with its failing-then-passing unit test | Patch 1 | - |
| 10 | Regression 1 (E3) | Run 2 | Yes |
| 11 | Batch 2 fixed | Patch 2 | - |
| 12 | Regression 2 | Run 3 | Yes |
| 13 | Batch 3 fixed | Patch 3 | - |
| 14 | Regression 3 | Run 4 | Yes |
| 15 | Batch 4 fixed | Patch 4 | - |
| 16 | Regression 4 | Run 5 | Yes |
| 17 | Acceptance, part 1: the whole of Part B, B8, B9 and the journeys included | Run 6 | Yes, about 8 h |
| 18 | Acceptance, part 2: C4 interleavings, C5 seeded faults, C1's coverage gate | Run 6, continued | Partly |
| 19 | What 17–18 found fixed, then 17–18 again, until E2 holds | Runs 7… | Yes |
| 20 | Cleanup (E4), NI-02, the final summary; then commits discussed with the person | Final results | - |

## E1. Order

1. Pre-flight: build freshness (A1); the unit suites and their coverage (C1); the
   fixture; the fake CLI as A6 describes it (its control file and `cd` are additions
   to the one in `~/facade-e2e/bin`); `~/.facade` listed; the test instance started
   with its inspector ports, live coverage on and a logpoint at
   `WorkspaceBarModel.add` that stays for the whole run (C-WB-01); `e2e-check`
   against the idle window; NI-01.
2. B1 casual use. A failure here is fixed before going on, because later cases
   build on starting agents in a folder window.
3. B2–B7 and B21 in a single-folder window, then again in W2.
4. B8 and B9, then C4 (the debugger's interleavings).
5. B10–B19.
6. B20 journeys.
7. C2's unit and integration tests; C5 seeded faults; C1's coverage of the whole run.
8. NI-02, cleanup (E4).

## E2. Exit criteria

The stack passes when all of these hold on one state of the working tree - HEAD plus
the fixes, saved as one patch whose hash the results name:

- Every case in Part B passed, in each window kind it names, with its global checks.
- Every test in C2 passes, with the assertions C2 marks as inverted.
- Diff branch coverage (C1) is 100%, or each uncovered branch has a written reason
  that it cannot be reached.
- Every invariant write site in C3 has a passing case.
- Every interleaving in C4 passed.
- Every seeded fault in C5 is caught.
- Every defect in C6 is fixed and its case passes.

## E3. Failures and fixes

1. **Baseline (run 1).** B1 and every scripted case on the commit under test. A defect
   of C6 that does not reproduce is struck out with its evidence; one that does, and
   every new failure, gets its root cause from the code and, where needed, the
   debugger.
2. **Fix batches of about twenty.** The defects are fixed in batches grouped by what
   they break, about twenty to a batch. Each fix comes with the unit test that fails
   before it and passes after it (its C2 row); that is part of the fix, not a
   regression run. A failure that blocks the cases after it is fixed at once, in the
   batch under way.
3. **One regression per batch (runs 2…N).** After each batch: every unit suite (C1),
   every scripted case, B1, and the UI and LIVE cases of the batch's areas.
4. **Acceptance (last run).** Once every batch is in, the whole of Part B, C4, C5 and
   C1's coverage on one commit - not only the cases that failed, since a fix to a
   shared path can break a case that passed.

Nothing is committed during the campaign (E0).

## E4. Cleanup

- Agents the run started: ended through the product; any left are ended by their
  checked pids.
- `~/.facade/worktrees/e2e-*`, the test instance's records under
  `~/.facade/workspaces/` (exactly the ids it made, listed in the results), the
  fixture folders' entries in `~/.facade/injected.json`.
- `~/.claude.json`: the trust entries for fixture folders, listed in the results, are
  left (Claude Code writes that file itself; removing entries risks the person's
  live changes). Antigravity's `settings.json`: backed up before. At the end, once no
  Antigravity runs: if it differs from the backup only by the run's trust entries, it
  is restored byte-identical; if anything else changed meanwhile - the person's or
  the CLI's own writes - only the run's entries are removed, under the file's lock,
  and the results say so. `~/.codex/config.toml` and Muse Code's
  files: hashes before and after, equal.
- Never touched: records the test instance did not make - the installed build's
  `FacadeCode-3f5a9433ce8d`, the trial window's `7d65559d…` and `d6e9a532…` (with
  their orphaned agents, the person's to end) - and anything of the person's windows.
  `~/.facade` is listed before the run and compared after it.
- The test profile, its extensions folder and `~/facade-e2e`.
- Quota: the LIVE cases start roughly 100 agents across the four vendors, most with
  a one-line task.

# Part F: Coverage index

## F1. Sections

| Section | Cases |
| --- | --- |
| L1 | AS-01, CU-20, FW-03, AS-19, YO-10; section D |
| L2 | ID-01–06, AS-03, CFG-17, REC-08, CU-19 |
| L3 | CU-01, CU-02, PS-01–15, UI-02–13, ID-02–04, TM-15 |
| L4 | YO-01–12, RCH-01–06, AS-22, AS-23, CU-13, CU-17, INS-04 |
| L5 | PS-10–18, AS-16–18, CFG-05, CFG-19, UI-17, TM-10 |
| L6 | TM-01–17, B8, B9, CU-10, CU-15, CU-16, SP-06, LS-08, FW-02 |
| L7 | CFG-01–03, CFG-21, CFG-22, UI-08, UI-11–16 |
| L8 | C1 (layers), NI-01, NI-02 |
| L9 | CFG-04–14, CFG-17, CFG-18, UI-15 |
| L10 | PS-01, CFG-07, CFG-11, CFG-15, CFG-16, CFG-19, UI-04, FW-03, AS-24 |
| L11 | TRU-01–09, CFG-09 |
| L12 | REC-01–14, WIN-01–19, CU-08, CU-09, CU-11, LS-09 |
| L13 | FW-01–06, CU-20, UI-07 |
| L14 | A4, C1, E2 |
| L15 | F2; NI-01, NI-02, NI-06, TM-20 |
| L16 | J-01 |
| O1 | RCH-01–06, AS-08, AS-19, AS-22, AS-23, CU-03, CU-04, YO-10, SP-23, UI-11 |
| O2 | ID-05, ID-06, AS-02, AS-18, LS-05, G15 |
| O3 | AS-01–35 |
| O4 | B8 (creating_worktree, running_setup), AS-08–11, AS-20, AS-21, AS-25, AS-28–30, AS-32–35 |
| O5 | SP-01–28, CU-05, CU-15 |
| O6 | LS-01–09 |
| O7 | INS-01–04, FW-01, FW-04 |
| O8 | TR-01–18, WIN-01–04 |
| O9 | B8, C4, TR-11, TR-12, TR-14, AS-19 |
| O10 | INJ-01–20, SP-12, SP-19, FW-06 |
| O11 | REC-03, AS-08, LS-06 |
| O12 | F2 |
| O13 | J-02–06 |

## F2. Acceptance rows

| Row | Cases | Row | Cases |
| --- | --- | --- | --- |
| LA-01 | UI-02, UI-04 | OR-01 | AS-01, AS-02 |
| LA-02 | UI-05, UI-06, PS-11, AS-04 | OR-02 | ID-05 |
| LA-03 | PS-01, PS-02, CU-21 | OR-03 | LS-01–04 |
| LA-04 | PS-03–05; remote: D | OR-04 | AS-12, AS-13 |
| LA-05 | ID-01–03 | OR-05 | AS-14, AS-31; messaging: D |
| LA-06 | UI-09–11 | OR-06 | AS-22 |
| LA-07 | CFG-05, CFG-17, CFG-19 | OR-07 | RCH-01, RCH-02 |
| LA-08 | CFG-13, CU-17 | OR-08 | AS-19 |
| LA-09 | YO-01–06, YO-11 | OR-09 | AS-08–10, AS-35 |
| LA-10 | YO-02, YO-04, YO-05, YO-12 | OR-10 | AS-04, AS-06, AS-07, AS-11, UI-05 |
| LA-11 | PS-01, YO-07, YO-08 | OR-11 | AS-20, B8 timeout × running_setup, C-WB-17 |
| LA-12 | PS-11, PS-12, PS-16–18, AS-16, AS-17 | OR-12 | AS-32–34, B8 running_setup |
| LA-13 | TM-01–04, TM-09–12, CU-16, SP-08 | OR-13 | B8 stop row |
| LA-14 | WIN-01, WIN-02, TM-05, TM-14, TR-07 | OR-14 | AS-16, AS-17, PS-12, B8 exit and timeout rows |
| LA-15 | CU-11, WIN-11–13, REC-07, C-REC-11 | OR-15 | TR-09 |
| LA-16 | TM-06–08, TM-17 | OR-16 | AS-12, AS-15 |
| LA-17 | FW-01–06 | OR-17 | SP-01–03, SP-06, RCH-03 |
| LA-18 | WIN-04–06, WIN-17, WIN-19, CU-08, CU-09 | OR-18 | SP-08, SP-09, SP-27, RCH-06 |
| LA-19 | REC-04–06, WIN-19, C-REC-25–30 | OR-19 | SP-10–12, SP-19, SP-24–26 |
| LA-20 | CFG-11, CFG-15, PS-02, C-LAUNCH-13; Windows: D | OR-20 | SP-13 |
| LA-21 | TRU-05, TRU-07, C-LAUNCH-07–09 | OR-21 | SP-07, SP-14 |
| LA-22 | UI-08, UI-15, UI-16 | OR-22 | INJ-01–05, INJ-10 |
| | | OR-23 | INJ-06 |
| | | OR-24 | INJ-08, INJ-14, C-INJ-01–04 |
| | | OR-25 | FW-01, TR-08, TR-13 |
| | | OR-26 | RCH-05, TR-10, B8 caller-gone row |
