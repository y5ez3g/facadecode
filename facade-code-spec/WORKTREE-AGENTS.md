# Agents in worktrees

How agents work together in a Facade window. Each agent is its vendor's own CLI, in its own
interactive UI, in a terminal. It sits in a git worktree, and may start other agents, beside it or
sent out to a worktree of their own. It talks only with its parent and its children, and Facade
delivers every message into the recipient's session. The person goes to any worktree and talks to
any agent there. Built on [`WORKSPACE.md`](./WORKSPACE.md) and [`WORKTREE.md`](./WORKTREE.md),
changing nothing they promise. [`L2-PLAN.md`](./L2-PLAN.md) builds it in milestones M0 to M7, from
coarse to fine.

Facade is the hardware: it gives agents worktrees, starts and stops them, delivers their messages,
loads and stores the person's charter, and lets them drive the IDE. It reads no content - not the
charter, not a message, not a plan. How to use the hardware is a skill; how to work with it is
another, which the person may choose.

Rules are numbered (WA-x.y) so that code and tests can cite them. §18 lays out the code: six
layers, what each offers, and the pipe and the workbench commands between them.

---

## 1 The model

```
worktree    one of the git worktrees of a repository in the workspace. The repository's own
            checkout, which git calls its main worktree, is main; the others go by their branches
agent       a vendor's agent CLI (Claude Code, Codex, Antigravity, Muse, Grok) running in its own
            interactive UI, in one worktree. Antigravity is Google's, running Gemini
parent      the agent that started an agent - or the person, for the ones they start
child       an agent some agent or the person started
the person  whoever is at the keyboard: they can type into any agent's terminal
message     text from a parent to a child or from a child to its parent, delivered by Facade
charter     the person's memory for their agents: one file every agent loads and may change
```

One thing grows the picture: an agent starting a child, beside it or in a new worktree branched from
its own.

```
main                                  the repository's own checkout
  @main      claude:sonnet            started by the person
  @review    claude:haiku             started by @main, beside it
clamp                                 a worktree @main sent a child out to, branched from main
  @clamp     agy:gemini-3.1-pro-high  started by @main
slugify                               another, branched from main
  @slugify   muse:muse-spark-1.3      started by @main
  @tests     claude:haiku             started by @slugify, beside it
```

The worktrees form a tree, from each to the one it was branched from, and the agents form a
tree, from each child to its parent. The two need not match: @review is @main's child in @main's own
worktree.

On top of the hardware sit three things Facade does not read:

```
facade               a skill every agent loads: how to use the hardware (§12)
facade-superpowers   a skill the person may choose: a way of working (§12)
the charter          the person's file: whatever they and their agents keep there (§11)
```

---

## 2 Decisions

```
Facade                  the hardware: mechanisms only; it reads no content
tools                   spawn, send, stop, ide - nothing else
who talks               a parent and its children, both ways; nobody else
delivery                Facade's: the agent's hooks while it works or stops, its terminal when it
                        is idle; agents never poll
spawning                the parent names the CLI and the model; Facade checks both exist and
                        starts it
how agents work         theirs, or facade-superpowers' when the person chose it; the tools enforce
                        neither
the charter             the person's own file, loaded into every agent and changed through ide;
                        never in the cloud
a worktree              main to begin with, then one branched from a parent's worktree
agents in a worktree    any number; they share its files and its branch
the agent's UI          always the vendor's own interactive CLI; there is no headless mode
the person              types into any agent's terminal; hears from the agents they started
first-run questions     answered by Facade for its own worktrees, once the person agreed, per vendor
permissions             file edits and shell commands without asking, inside each vendor's sandbox
what Facade knows of    driver data, a file shipped with Facade (§13)
each CLI
channels                only what every CLI has: documented flags and configuration, documented
                        hooks, and the terminal; no vendor's own messaging channel
the code                six layers, a folder each, imports only pointing down (§18)
```

---

## 3 Worktrees

- **WA-3.1** A worktree here is one of the git worktrees of a repository whose main checkout, or one
  of whose worktrees, is a folder of the workspace. The repository's own checkout - git's main
  worktree - is `main`, whatever branch it is on. Every other worktree is named by its branch.
- **WA-3.2** A new worktree is made only by `spawn` with `worktree: "new"`: on a new branch, named
  after the child, starting at the parent worktree's HEAD. It is made through the window's New
  Worktree, without its dialog (WORKTREE.md §7), so it lands under
  `~/.facade/worktrees/<repo>/<branch>` with its row, its `.worktreeinclude` files and its setup.
  The window stays where it is: the worktree joins the workspace when somebody goes to its row. Such
  a spawn names the child, since the branch is named after it.
- **WA-3.3** Facade records each worktree's parent worktree when it makes one. A worktree made by
  the person or by git counts as well, with no parent.
- **WA-3.4** A worktree may hold any number of agents, or none. They share its files and its branch;
  Facade does not coordinate them.
- **WA-3.5** A worktree stays until it is deleted, by the person or through `ide`. Stopping its
  agents leaves it as it is; deleting it stops the agents in it (WORKTREE.md §10).
- **WA-3.6** `spawn` names a worktree only of the caller's own repository. An agent in a folder with
  no repository can start children beside it only.
- **WA-3.7** Which worktree each one branched from is Facade's record: git keeps worktrees flat. The
  popup draws it (§9); the workspace bar keeps its two levels (WT-1.1).

⚠️ A branch starts at the parent worktree's HEAD - its last commit. Work the parent has not
committed does not go with the child.

---

## 4 Agents

- **WA-4.1** An agent is its vendor's own CLI in its interactive UI, started directly - never
  through a shell - in a terminal held under its worktree's row (§9).
- **WA-4.2** Its name is unique in the workspace. Unless it is given one, it takes its worktree's
  name; a second agent in the same worktree takes `<worktree>-2`, then `-3`. A name takes the rules
  of `names.ts`: lower case, letters, digits, `.`, `_` and `-`.
- **WA-4.3** Its parent is fixed when it starts: the calling agent, or the person.
- **WA-4.4** Each start under a name is a new incarnation, with a token of its own, heard while it
  runs: once it stops or fails, or a new incarnation takes its name, its calls are refused. Only a
  caller's own child, or an agent that has stopped, may be started again under its name; the running
  one is stopped first.
- **WA-4.5** Its state comes from its hooks (§7):

  ```
  starting   started, not heard from yet
  working    in a turn
  waiting    at a question or a permission prompt in its terminal
  idle       its turn ended; at its input box
  stopped    its process ended, or it was stopped
  failed     it could not start
  ```

- **WA-4.6** `stop` ends a child's terminal. The person ends any agent by closing its terminal.
- **WA-4.7** The person may type into any agent's terminal at any moment. Facade never types into a
  terminal the person typed into in the last few seconds (WA-6.4).

---

## 5 The tools

An agent reaches Facade through one MCP server, `facade`, started per launch by the shim (§18).

```
spawn    cli       the CLI, as `claude`, `codex`, `agy`, `muse`, `grok`
         model     one of that CLI's models, as `sonnet`, `gemini-3.1-pro-high`, `muse-spark-1.3`
         prompt    its first message, passed as the CLI takes one (§7)
         worktree  omitted: the caller's own; "new": a new one (WA-3.2); a name: that worktree
         name      optional (WA-4.2); required with "new", whose branch it names
         →         its name, worktree, folder and branch

send     to        the caller's parent or one of its children, as @name
         text      the message
         →         sent; REFUSED naming the caller's parent and children when `to` is neither,
                   or when it has stopped (WA-6.8)

stop     name      one of the caller's children
         →         stopped; REFUSED naming the caller's children when it is not one

ide      action    one of the actions of WA-9.5
         args      the action's arguments, an object
         →         what the action did, or what it read
```

Every result is text the model reads whole, with the same facts as data. A failure is a result too,
marked as an error: its text says what is wrong and what would be right, and its data carries one
code:

```
INVALID       an argument is missing or wrong: the result says which, and what the tool takes
NOT_FOUND     what it names is not there: an agent, a worktree, a terminal
REFUSED       not the caller's to do: an agent that is not its parent or child, or one that has
              stopped
UNAVAILABLE   Facade cannot do it here and now: a CLI not installed, the window reloading
FAILED        it was tried, and did not work: the result says what went wrong
```

From M1, every result ends with the messages the caller has not had yet, and a message from Facade
itself is one of them (WA-6.11):

```
Opened the terminal checks in C:\lab.

Messages for you:
[from @clamp] Done: clamp() and its tests are on the branch clamp.
[from facade] @slugify stopped: its process exited with code 1
```

- **WA-5.1** The window decides the tools and the server's instructions (`hello`); the shim holds no
  logic of its own.
- **WA-5.2** The server's instructions say who the agent is, who started it, where it runs and what
  the tools do. Nothing about how to work:

  ```
  You are @main, a Claude Code agent in Facade Code, started by the person.
  You run in C:\lab: the worktree main. You are in that folder already: run commands there without cd.
  spawn starts a child agent; send messages your parent or a child; stop stops a child; ide does what the person can do in the IDE.
  Messages to you arrive by themselves. Never wait or poll for them: when you have nothing to do, end your turn.
  ```

  Until M1 brings the other tools, the third line speaks of `ide` alone, and the fourth is not
  there.
- **WA-5.3** Every result carries the messages not yet delivered to the caller (WA-6.9), after its
  own text, and as data.
- **WA-5.4** The person starts agents through the popup (§9), as a caller whose children are the
  agents they start.
- **WA-5.5** `spawn` has no default CLI and no default model. Facade checks that the CLI is
  installed and that the model is one it offers (WA-13.3), and starts it; which CLI and model to
  choose is the caller's, and `list_clis` shows what there is (WA-9.5).
- **WA-5.6** `send` has one recipient, and `stop` one child, per call.
- **WA-5.7** A failure is never a protocol error: it is a result, with one of the five codes. An
  argument a tool or an action does not take is INVALID, and the result names the ones it takes.

⚠️ Codex gives a tool 60 seconds unless `tool_timeout_sec` says otherwise, Muse 300, Grok 6000:
every launch sets 3600, since `spawn` waits for a worktree to be made.

---

## 6 Delivery

MCP calls only go from the agent to Facade. Facade brings each message to its recipient, choosing
the way by the recipient's state (WA-4.5) and its CLI:

```
working           PostToolUse hook: the messages are added to the context of its next step
ending its turn   Stop hook: "block", with the messages as the reason; the agent carries on with them
idle              typed into its terminal (WA-6.4)
no hooks          with the result of its next call to a Facade tool (WA-6.9)
the person        a notification in the window (WA-6.10)
```

- **WA-6.1** Agents never poll. A parent that has sent its children out may end its turn: a child's
  message wakes it.
- **WA-6.2** A message is delivered once, and a recipient's messages in the order they were sent.
  The ledger records how each went (`message.delivered`, with the way).
- **WA-6.3** The hooks answer as each CLI documents:

  ```
  Claude PostToolUse   {"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": <messages>}}
  Claude Stop          {"decision": "block", "reason": <messages>}
  Codex Stop           {"decision": "block", "reason": <messages>}: a continuation prompt, not a refusal
  Codex PostToolUse    a model-visible message (§16)
  ```

- **WA-6.4** Typed into the terminal only when all of these hold:

  ```
  its Stop hook fired, and no UserPromptSubmit since
  no permission prompt open: Claude's Notification (permission_prompt), Codex's PermissionRequest
  nobody typed in that terminal in the last 5 seconds
  its screen shows the CLI's input box ready (the driver data's readiness patterns, §13)
  ```

  The text is `[from @name] ` and the message, pasted in bracketed-paste mode when it has more than
  one line, then Enter, in the way each CLI takes it (the driver data's input quirks, §13): Claude
  follows a pasted text only with a typed request ahead of it, and Codex on Windows takes a new line
  as Alt+Enter.
- **WA-6.5** A typed message counts as delivered once the recipient's next UserPromptSubmit hook
  carries it. It is typed again once if none has come within 10 seconds, then reported to the sender
  as not delivered.
- **WA-6.6** A message longer than 2,000 characters is written to
  `~/.facade/workspaces/<id>/messages/<seq>.md` and delivered as its first lines and that file's
  path. Claude is launched with `--add-dir` for that folder, so that reading it asks nothing.
- **WA-6.7** A Stop hook that blocks runs again at the next stop. Facade blocks only while messages
  wait, so it cannot loop.
- **WA-6.8** A message to a parent or a child that has stopped, with no agent running under its
  name, is not delivered and not kept: `send` answers REFUSED and says so. A child whose parent has
  left says it in its own output, where the person sees it; a parent may start its child again with
  `spawn`.
- **WA-6.9** A CLI without hooks in Facade (Muse, Grok) gets its messages only with the result of
  its next call to a Facade tool.
- **WA-6.10** A message to the person is a notification in the window, with the sender and the first
  lines; going to it opens that agent's terminal, where the person answers by typing. It moves to
  MCP later.
- **WA-6.11** Facade tells a parent when its child stops, fails, or waits at a permission prompt, as
  a message from `facade`, delivered like any other:

  ```
  [from facade] @slugify stopped: its process exited with code 1
  [from facade] @clamp failed: claude exited as it started (exit code 1)
  [from facade] @tests waits at a permission prompt in its terminal
  ```

⚠️ Codex cuts a hook's text at about 2,500 tokens and saves the rest to a file; WA-6.6 keeps
messages well under that.

---

## 7 Launching each CLI

Each launch's configuration is its own: flags, files in its run folder
(`~/.facade/workspaces/<id>/runs/`), files injected into its worktree and put back when it stops,
and a hook launcher under `~/.facade/hooks`. Nothing goes into the user's own agent configuration
but the trust records of §8. The driver data (§13) holds what follows; today it reads:

```
                 Claude Code 2.1.283        Codex 0.158                Antigravity 1.2.12       Muse 1.4.0
prompt           the CLI's prompt argument  the CLI's prompt argument  -i <prompt>              the CLI's prompt argument
model            --model                    --model                    --model                  --model
MCP server       --mcp-config <run file>    -c mcp_servers.facade.*    .agents/mcp_config.json  .mcp.json in the worktree
                 --strict-mcp-config
state hooks      UserPromptSubmit, Stop,    UserPromptSubmit, Stop,    PreToolUse, Stop         none
                 Notification               PermissionRequest          (.agents/hooks.json)
delivery hooks   PostToolUse, Stop          PostToolUse, Stop          to verify (§16)          none
opening          SessionStart:              to verify (§16)            to verify (§16)          to verify (§16)
                 additionalContext
permissions      --permission-mode          --sandbox workspace-write  --mode accept-edits      --approval-mode never,
                 acceptEdits; Bash and      --ask-for-approval never                            its sandbox on
                 PowerShell allowed
also             --setting-sources          -c for every hook, the     -                        -
                 project,local              same command each launch
```

Grok keeps its first-pass launch: `.grok/config.toml` in the worktree, `--allow` for Facade's tools,
and no hooks (WA-6.9).

- **WA-7.1** Claude's hooks call Facade's MCP server directly (`mcp_tool` hooks), with no process
  per hook, where a hook's answer can be returned that way (§16). Until then, and for the others, a
  hook runs its launch's launcher under `~/.facade/hooks`, which starts the shim's hook mode.
- **WA-7.2** PostToolUse runs after every tool call, so its handler must return within about 300
  milliseconds when nothing waits. Hooks in the launcher's path are measured on Windows before they
  are relied on (§16).
- **WA-7.3** Codex's hooks are the same command at every launch, so that trusting them once is
  enough; they find Facade through `FACADE_AGENTS_PIPE` and `FACADE_AGENTS_TOKEN`.
- **WA-7.4** The opening - the `facade` skill's opening, `facade-superpowers`' when the person chose
  it, and the charter (§11, §12) - is loaded at SessionStart, which fires at the start, after
  `/clear` and after compaction, as each CLI takes it. Where a CLI has no such hook, it goes ahead
  of the first message, and the `facade` skill tells the agent to read the charter again after a
  compaction.

⚠️ Claude is started with `--strict-mcp-config --setting-sources project,local`: in the first pass's
first smoke run, workers without it loaded the user's own plugins and connectors.

⚠️ Claude asks before a compound shell command that starts with `cd`, whatever is allowed. The
server's instructions tell agents they already run in their worktree's folder (WA-5.2).

⚠️ A program Facade starts in a terminal must be a console program. On Windows Facade's own Electron
binary is not: started in a terminal it prints nowhere, and the window never learns the terminal's
process id. The shim is run over pipes only - as an MCP server and as a hook - where that does not
matter.

---

## 8 First run

An interactive CLI asks questions before it works. Facade answers them for its own worktrees once
the person agreed, in one dialog per vendor:

```
Let Facade start <agent> trusting the worktrees it makes for it?
<what that means for this vendor, from the table below>
Allow   Don't Allow
```

```
Claude Code   asks per folder: "Is this a project you created or one you trust?"
              Facade answers "Yes, I trust this folder" in Claude's own UI, reading its screen and
              pressing the keys a person would - in worktrees Facade made, and nowhere else
Codex         asks whether to trust its hooks: skipped with --dangerously-bypass-hook-trust, for
              that launch only
              asks per repository: "Trust this folder?": the repository root's entry written into
              ~/.codex/config.toml before the launch, under a lock (Orca's code)
Antigravity   asks per exact path: the worktree added to trustedWorkspaces in
              ~/.gemini/antigravity-cli/settings.json before the launch (Orca's code)
Muse          --trust-workspace, for that run only; nothing written
Grok          --trust, which adds the worktree to Grok's trusted folders
```

- **WA-8.1** Without the person's agreement, the agent is not started for them, and `spawn` says
  why.
- **WA-8.2** A trust record is written only for a worktree Facade made, merged into what the file
  holds, and only when it is not there yet. A file that does not parse is left alone.
- **WA-8.3** Facade watches a new agent's screen for its first-run question for 90 seconds. When the
  extension host restarts in that time, the new one watches again for every agent still starting.

⚠️ Codex keeps trust per repository, so the root's entry covers every worktree of the repository,
main included. A `-c projects.<path>.trust_level` override on the command line does not stop its
question; the entry in `config.toml` does.

⚠️ Claude's `--dangerously-skip-permissions` skips its trust question too (2.1.283), and with it
every permission check. Facade does not use it. Writing Claude's own record into `~/.claude.json`
is not done either: a running Claude rewrites that file.

---

## 9 The person and the window

- **WA-9.1** Every agent's terminal is held under its worktree's row: in the background while the
  window is elsewhere, a tab of that worktree when the window goes there - even before the worktree
  has joined the workspace. A terminal is never shown in a worktree it does not belong to.
- **WA-9.2** The person talks to an agent by typing into its terminal, as they would with the CLI on
  its own.
- **WA-9.3** The popup draws the worktrees as a tree from main, the agents in each with their
  vendor, model, state and parent, and each parent's conversation with a child. From it the person
  goes to a worktree, starts an agent there, stops one, or opens its terminal. It is drawn first,
  and reviewed by the person before it is built.
- **WA-9.4** Until the popup lands, one Command Palette command starts an agent in the worktree on
  screen.
- **WA-9.5** The `ide` tool gives agents what the person can do in the IDE, and the charter and the
  installed CLIs. Nine actions, each from the milestone that brings it (L2-PLAN):

  ```
  M0  open_file        path, line?          an editor on a file, at a line
      open_terminal    path, name?          a terminal in a folder, held under its row; its name
      read_terminal    name, lines?         the last lines a terminal shows: 50, at most 2,000
      send_terminal    name, text, enter?   typing into a terminal, then Enter unless enter is false
      command          id, args?            any VS Code command, its arguments as a list
  M1  delete_worktree  name, force?         Delete Worktree without its dialog, stopping the agents
                                            in it (WA-3.5); changes not committed only with force
      read_terminal and send_terminal take @name for the terminal of that agent
  M4  read_charter                          the charter, whole, with its version (§11)
      write_charter    text, version        the whole charter, if that is still its version
      list_clis                             the installed CLIs, their versions and their models
  ```

  A path is absolute. A terminal is named as it was opened, or by the start of that name. Facade's
  own parts of the window are reached through dialog-free workbench commands (§18), the rest through
  VS Code's API. What an agent can do with its own shell - git, the tests, reading files - is not an
  action.
- **WA-9.6** An agent types only into terminals of its own children and terminals that are no
  agent's.

---

## 10 Storage and robustness

What belongs to a workspace sits under `~/.facade/workspaces/<id>/`, where `<id>` is the first
folder's name and a hash of its path:

```
ledger.jsonl         one event per line, only appended; a line a crash cut short is dropped on load
window.json          the pipe the window listens on, and its process
window-state.json    the pipe's id and the agents' terminals' process ids
you.token            the person's token, readable only by the user
runs/                per incarnation: its token, its MCP configuration, its settings, its hook policy
messages/            long messages (WA-6.6)
```

What belongs to the person sits beside it:

```
~/.facade/charter.md           the charter (§11)
~/.facade/charter.history/     the text each write replaced, with its writer and time
~/.facade/drivers.json         a local override of the driver data (WA-13.1), when there is one
```

The ledger's events:

```
agent.started        name, incarnation, cli, model, worktree, folder, parent, token's hash
agent.state          name, incarnation, state, detail
agent.usage          name, incarnation, tokens and cost
worktree.made        name, folder, repository, parent worktree, made by
message.sent         seq, from, to, text or file
message.delivered    seq, way (PostToolUse, Stop, terminal, result)
```

- **WA-10.1** Not in `context.storageUri`: that folder changes when a folder window becomes a
  workspace, and the extension host restarts at that moment while agents keep running.
- **WA-10.2** A new extension host takes the same pipe, waiting up to 10 seconds for the one before
  to let go of it and of the ledger; finds each running agent's terminal again by its name or its
  process id; and marks stopped only the agents whose terminal is gone.
- **WA-10.3** A window reload loses no agent, message, name or token; neither does a folder window
  becoming a workspace. A tool call that finds no window cannot have run, so it waits for the window,
  up to a minute; one the window drops halfway may have run, so it is not made again, and says so.

---

## 11 The charter

The person's memory for their agents: one Markdown file, theirs, kept across workspaces.

```
file      ~/.facade/charter.md, on the person's machine only
content   whatever the person and their agents write there: Facade reads none of it
loaded    into every agent, whole, at the start, after /clear and after compaction (WA-7.4)
changed   by agents through ide (read_charter, write_charter); by the person in any editor
```

- **WA-11.1** Facade guarantees two things of the charter: every agent has it loaded, and every
  agent can change it. What it says, how it is laid out, and who changes it when are for the person
  and the agents to settle; Facade parses none of it.
- **WA-11.2** `write_charter` replaces the whole text only if the version it names is still the
  current one; otherwise it is refused, with the current text and version. The version is the file's
  hash, so an edit made in an editor counts too. Each write keeps the text it replaced under
  `charter.history/`, with the writer and the time.
- **WA-11.3** A charter over 20,000 characters is loaded cut, with a line saying so; `read_charter`
  gives it whole.
- **WA-11.4** The charter is the person's own, and they keep it: Facade keeps it on their machine
  and sends it nowhere.
- **WA-11.5** A repository's own instructions - `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` - are that
  repository's, and each CLI loads them itself. The charter is the person's, across repositories.

⚠️ An agent holds the charter as it was when it started or last compacted. After a change it sees
the new text at its next start or compaction, or when it reads it.

---

## 12 Skills

Two layers, both skills and nothing more: the tools enforce neither.

```
facade               always loaded: how to use the hardware
facade-superpowers   loaded only when the person chose it: a way of working, adapted from
                     Superpowers (obra/superpowers, MIT)
```

- **WA-12.1** `facade` tells an agent who it is - its name, worktree, branch and parent - and how
  the hardware behaves: what the four tools do; that messages arrive on their own and waiting is
  ending its turn; that when its task is done or it is stuck it sends its parent a report, and says
  it in its own output when the parent has left; that it already runs in its worktree's folder; that
  files Facade put in the worktree are not its to commit; that the charter is loaded, and changes go
  through `write_charter` on its latest version, keeping what others wrote; that `spawn` needs a CLI
  and a model, and `list_clis` shows what there is. Nothing about how to work. Its opening (WA-7.4)
  names the agent and its parent, says that a parent sees only what its child sends it, and that the
  agent reports when done or stuck and never waits for a message.
- **WA-12.2** `facade-superpowers` adapts Superpowers' process to worktrees and the four tools:

  ```
  Superpowers                                   in facade-superpowers
  brainstorming, writing-plans                  kept: the lead and the person talk in its terminal;
                                                the plan is a file in the lead's worktree
  dispatching-parallel-agents,                  one skill: a task per child, beside or sent out, its
  subagent-driven-development                   prompt from a template; spawn in place of the CLI's
                                                own subagents; ending the turn in place of waiting
  requesting-code-review,                       kept: a reviewer child in the implementer's worktree,
  receiving-code-review                         findings through send; another vendor may review
  executing-plans                               kept: the lead does the plan itself, when the person
                                                says so
  finishing-a-development-branch                kept: the tests in the child's worktree, merge --no-ff,
                                                stop the child, delete its worktree, ask the person
                                                before main
  test-driven-development,                      kept, for implementers
  verification-before-completion,
  systematic-debugging
  using-git-worktrees                           dropped: every agent already runs in one
  using-superpowers                             replaced by its own opening section
  writing-skills, diagnosing-superpowers        dropped
  ```

  It may speak as firmly as Superpowers does: the person chose it.
- **WA-12.3** `facade-superpowers` keeps its conventions in the charter, as text Facade does not
  read. Its Staffing section says which CLI and model do which kind of work, first choice first.
  The first time a lead runs without one, it asks the person: it lists what `list_clis` shows, asks
  per kind of work, reads the table back, and writes it with `write_charter`. Its plans name each
  task's kind, CLI and model - from the charter, or from what the person said for this run;
  only "remember this" goes into the charter. The lead chooses; `spawn` takes what it is given.
- **WA-12.4** The person chooses `facade-superpowers` when starting the first agent - in the popup,
  and until then in the Command Palette command. Every agent under that one inherits the choice.
- **WA-12.5** Skills reach each CLI per launch, never installed into its own configuration:

  ```
  Claude       as a plugin passed with --plugin-dir
  Codex        .agents/skills/<skill>/ in the worktree
  Antigravity  .agents/skills/<skill>/ in the worktree
  Muse         as project skills, with --trust-workspace (§16)
  ```

  Files put into a worktree are listed in the repository's `info/exclude`, so that no agent commits
  them, and go when the worktree's last agent stops. Skills are versioned by their content: a
  running agent keeps the version it started with.
- **WA-12.6** Superpowers' copyright notice goes into `ThirdPartyNotices.txt`; `facade-superpowers`
  carries its name as credit (L2-PLAN, Borrowed code).

⚠️ A skill in a plugin is loaded when the model chooses to. In M1's first smoke run a Haiku child
never loaded `facade`, finished its task and said so only in its own output, and its parent waited:
the opening is what every agent holds.

---

## 13 Driver data

What Facade knows of each CLI is data, not code. The code is the mechanisms - terminals, hooks,
delivery, reading screens and pressing keys, writing trust records under a lock, checking a spawn -
and the data fills them in.

```
per CLI, per version range (from its --version)
  detection     the command to find on PATH; how its --version reads
  launch        how the prompt, the MCP server, the model and the permissions are passed
  hooks         which events, how they are configured, what each answer looks like
  opening       how the opening is loaded (WA-7.4)
  first run     each question, and its answer or the trust record to write
  input         how typed text is submitted; what the ready input box looks like
  skills        where the CLI reads skills from (WA-12.5)
  models        the models it offers, or the command that lists them
```

- **WA-13.1** The data is a file shipped with Facade, `extensions/facade-agents/drivers.json`. A
  file at `~/.facade/drivers.json` overrides it, to try a new CLI version before the shipped data
  knows it.
- **WA-13.2** The data holds no program to run and no path: the programs are the CLI found on PATH -
  or where the person's settings point - and Facade's own shim, and every path is the code's. The
  data only chooses among what the code does.
- **WA-13.3** `spawn` checks the CLI against detection, and the model against the list the CLI
  gives when it has a command for one, else against the data's list. A model in neither is refused,
  with the models there are. A CLI with neither takes the model as given, and a launch that fails on
  it is `spawn`'s failure.
- **WA-13.4** A CLI newer than the data knows is driven by the newest range, and the log says so.

⚠️ Later: fetched from a GitHub repository at start when online, cached, the shipped file as the
fallback; signed, with the key built into Facade, since the data decides how CLIs are launched and
which questions Facade answers; and a CI that installs each CLI's newest version and checks that the
data still holds. None of it is in M0 to M7.

---

## 14 What Facade borrows

From Orca (Lovecast Inc., MIT; its copyright notice goes into `ThirdPartyNotices.txt`, its name and
logo nowhere):

```
src/main/agent-trust-presets.ts       Codex's and Antigravity's trust records: repository root
                                      resolution, the lock, the merge into what is there (§8)
src/shared/tui-agent-config.ts        how text typed into each CLI gets submitted (§13)
its terminal readiness patterns       the screen text that shows each CLI's input box is ready (§13)
src/shared/agent-hook-listener/**     hook payloads from each CLI in one shape
```

Orca learned these the hard way; its issues record the pastes that were never submitted, the Enter a
CLI swallowed, and the Claude workers that ignored a pasted brief. What stays out:

```
hooks written into each agent's global config          per-launch hooks instead (§7)
idle read from the terminal title and screen text      never idle once a CLI's title is switched off;
                                                       hooks instead (WA-4.5)
the orchestration CLI, `check --wait`, heartbeats      `send`, and Facade delivering (§6)
Claude's trust pre-written into ~/.claude.json         not merged there; Facade answers in the UI (§8)
OAuth credentials and the usage endpoint               L2-PLAN's credential rule
```

From Superpowers (Jesse Vincent, MIT): its process skills, adapted into `facade-superpowers` (§12),
with its copyright notice in `ThirdPartyNotices.txt`.

---

## 15 Not included

- A headless or print mode for agents.
- Any vendor's own channel into a session (`codex queue`, `muse session-message`, Claude's
  cross-session messages): not every CLI has one.
- Facade reading the charter, a message or a plan, or enforcing any way of working.
- Agents talking to anyone but their parent and children; groups; broadcasts.
- The vendors' own subagents as Facade agents. An agent may use its own inside itself; Facade does
  not see them.
- Nested rows in the workspace bar: the tree is the popup's (WA-3.7).
- The charter in the cloud: it is the person's, and they keep it.
- Driver data fetched from the network, and its signature (§13, later).
- Deleting worktrees on its own, merging for agents, or budgets (L2-PLAN, M8).

---

## 16 To verify before building

```
Codex PostToolUse           the field that puts text before the model mid-turn
Codex UserPromptSubmit      that its input carries the prompt, for WA-6.5
Antigravity Stop            whether "block" with a reason makes it carry on
Claude mcp_tool hooks       whether a PostToolUse or Stop answer can be returned through them
the opening                 how Codex, Antigravity and Muse take SessionStart context, or MCP server
                            instructions
skills                      that Codex and Antigravity read .agents/skills in the worktree; where Muse
                            reads project skills
models                      where Codex and Muse list their models; what Claude does with a model
                            name it does not know
hook latency on Windows     the launcher's time per call, cold and warm (WA-7.2)
readiness patterns          each CLI's input box on the versions above, on Windows
bracketed paste             each CLI's handling of a multi-line paste through the terminal
```

---

## 17 Tests

```
unit            ledger replay and repair; incarnations; the four tools' arguments and addresses;
                the worktree rules; the driver data's schema and each CLI's launch from it; first-run
                answers on the screens the CLIs show; trust records written once and merged;
                write_charter refusing a stale version and keeping the history
integration     fake agents calling the four tools through the real shim and pipe; each way of
                delivery - PostToolUse, Stop, the terminal, a result - once per message and in order;
                nothing typed at a prompt or while the person types; a parent that has left; the
                charter and the facade skill loaded at the start and after a compaction
live            Claude and Codex, then Antigravity and Muse, on a throwaway repository in a window,
                each in its own UI: a goal taken to main with children beside the first agent and in
                worktrees of their own, with facade-superpowers and without; a reload and a folder
                window becoming a workspace halfway
windows         every live case on native Windows
```

Unit tests go by layer (§18): the contract word for word, over the real core with fake ports; the
core with fake ports and a temporary folder; the record on disk; each CLI's launch; the transport
through the real shim and pipe, with a fake contract behind them; and every layer's imports.

⚠️ A live run spends real quota. Live suites run on demand, not on every change.

---

## 18 The code

`extensions/facade-agents` is six layers, a folder each. Each answers to a fact that does not
change:

```
contract    what the model sees is the product: the tools, their arguments, the result text, the
            five codes and the instructions (§5) - exact, and tested word for word
core        Facade is the hardware: its operations and its rules - names, incarnations, who may
            start, message or stop whom - in one place, and tested without a window
record      the extension host restarts and the agents do not: the ledger, the tokens, the agents'
            states and the window's state stay on disk (§10)
clis        each CLI is launched its own way, and changes with its versions: its arguments, files,
            hooks and first run (§7, §8), data from M4 (§13)
transport   a CLI speaks MCP only to a process it starts: the shim, MCP over stdio, and HTTP over a
            named pipe back to the window
host        VS Code's API lives in the extension host, and the rows and their terminals in the
            workbench: the switch, Start Agent, and the ports, through that API and the _facade.*
            commands
```

- **WA-18.1** Imports point down only, and a test reads every import to hold the code to it:

  ```
  host        any layer
  contract    core; record's names for callers and agents
  core        record, clis
  record      nothing of Facade's
  clis        nothing of Facade's
  transport   nothing of Facade's: the host hands the endpoint what to answer
  ```

- **WA-18.2** Only `host` imports `vscode`. The other five run in plain Node, and so do their tests.
- **WA-18.3** `transport` knows no tool: a new tool changes neither the shim nor the pipe.
- **WA-18.4** `contract` checks the arguments and writes the result; for everything Facade does, it
  calls `core`, never the window.
- **WA-18.5** `core` reaches the window only through its ports: interfaces that `host` implements
  and tests fake.
- **WA-18.6** A workbench command exists only for what the extension host cannot do, and each one
  has a caller.

What each layer offers, by the milestone that brings it:

```
contract   Contract       hello(caller): its name, tools and instructions; call(caller, tool, args)
           the tools      ide, M0; spawn, send and stop, M1; ide's actions as WA-9.5 lists them
core       Facade         startAgent, recover and ide's actions, M0; spawn, send, stop, delivery and
                          the parents' notices, M1; the charter and the CLIs, M4
           Terminals      launch, isAlive and a terminal's end, M0; stop, type, read, lastInputAt
                          and reveal, M1
           Ide            openFile, openTerminal, readTerminal, sendTerminal and runCommand, M0;
                          deleteWorktree, M1
           Git            worktreeOf, M0; makeWorktree, M1
           Person         a notification, and the consent for a first run, M1
record     AgentRegistry  open, authenticate, agent, nameFor, add and setState, M0; worktrees and
                          messages, M1
           window state   the pipe's id and the terminals' process ids, M0
clis       each CLI       launch, M0; hooks and the first run, M1; read from drivers.json, M4
           the list       installedClis and terminalName, M0
transport  shim           shim.js mcp --pipe <pipe> --token-file <file>, M0; shim.js hook <event>, M1
           pipe           POST /hello and /call, M0; POST /hook, M1
           endpoint       the window's end of the pipe, and window.json, M0
host       service        the switch: opens the record, starts the endpoint, wires the layers
           Start Agent    the Command Palette's questions, then core
           the ports      HostTerminals, HostIde and HostGit; HostPerson from M1
```

The pipe is HTTP over a named pipe on Windows, `\\.\pipe\facade-agents-<id>`, and over a Unix socket
elsewhere: nothing listens on TCP, so no firewall asks. Every request carries its caller's token as
`Authorization: Bearer <token>`, and a token Facade no longer accepts gets 401:

```
POST /hello                    → {name, tools, instructions}
POST /call {tool, args}        → newline-delimited JSON: {type: "progress", message} while it works,
                                 then {type: "result", result}
POST /hook {event, payload}    → what the CLI's hook prints (M1)
```

The workbench's commands, kept out of the Command Palette like the git extension's `_git.*`:

```
M0  _facade.folder.active        the folder the window is on, for Start Agent
    _facade.terminal.create      a terminal for a folder, held under its row; an agent's with the
                                 robot icon, and its name as its title across a reload
    _facade.terminal.read        a terminal's last lines, for read_terminal
M1  _facade.worktree.create      New Worktree's flow without its dialog, for spawn
    _facade.worktree.delete      Delete Worktree's, for delete_worktree
    _facade.terminal.reveal      a terminal put in front through its folder's row, from a
                                 notification
    _facade.terminal.lastInput   when the person last typed into a terminal (WA-6.4)
```

The files:

```
extensions/facade-agents/src/
  extension.ts    the switch
  contract/       instructions.ts  tools.ts  ide.ts; args.ts  spawn.ts  send.ts  stop.ts  skill.ts
                  from M1
  core/           facade.ts  ports.ts  errors.ts; delivery.ts  firstRun.ts from M1
  record/         ledger.ts  events.ts  registry.ts  names.ts  paths.ts  windowState.ts
  clis/           cli.ts  claude.ts  index.ts  which.ts
  transport/      shim.ts  stdio.ts  pipe.ts  endpoint.ts
  host/           service.ts  startAgent.ts  terminals.ts  ide.ts  git.ts; person.ts from M1
  test/           a suite per layer, and layers.test.ts for WA-18.1
```
