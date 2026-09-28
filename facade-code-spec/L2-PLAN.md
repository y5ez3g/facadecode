# L2 plan — agents

L1 built the window: identity, the workspace bar, worktree rows, agent terminals that survive a
reload. L2 makes the agents in that window work together, and makes them manageable. M0 to M7 build
the offices of [`OFFICES.md`](./OFFICES.md), from coarse to fine; M8 to M10 come after:

```
M0   a clean slate            what the offices replace is gone; what stays still works
M1   parent and child         Claude only, and roughly: children beside or in offices of their own;
                              a child's report wakes its parent
M2   Codex                    Claude and Codex, parents and children either way
M3   delivery done right      every message once, in order, at the first moment it can, never over
                              the person
M4   knowing and remembering  driver data, list_agents and the model check; the charter
M5   facade-superpowers       a way of working the person may choose, with the staffing in the
                              charter
M6   more vendors             Antigravity, Muse and Grok
M7   the office popup         the offices and their agents, drawn and run from one place
M8   manage every agent       one place for all agents, work, usage, budgets and schedules
M9   polish and onboarding    status at a glance on every worktree row; five minutes to a first task
M10  distribution             positioning, demo, benchmarks, launch
```

Each milestone ends with a test the person runs in a Facade window, and is finished - reviewed and
merged - before the next begins. M1 to M7 are one branch each, `feature/<n>-<name>` from `main` with
the next free number, merged `--no-ff` as ENGINEERING.md says; M0 is `feature/20` itself; M8 to M10
take a branch per item.

Research and designs behind this plan (private pages):

```
collaboration primitives     https://claude.ai/artifact/DmsYaJZHT15fQMZrAdnZct   (the second pass; superseded below)
program engine, first pass   https://claude.ai/artifact/7wRQeo5uEorQUA9XSmhBat
harness orchestration        https://claude.ai/artifact/HGqjtGCZL8mxy41Z3cfcr6
competitor teardown          https://claude.ai/artifact/9oEpPhWUnBQPvwVKZUg14j   (JetBrains Air, Paperclip, Orca)
```

## Names, settled once

```
the surfaces   "office" for a git worktree, the repository's own checkout being the first, main;
               "agent" for a vendor's agent CLI running in its own UI, in one office; "parent" and
               "child" for who started whom; "the person" for whoever is at the keyboard. Roles such
               as lead or reviewer are words agents use, not Facade's.
the charter    the person's memory for their agents: one file every agent loads and may change
skills         "facade", how to use Facade; "facade-superpowers", a way of working the person may
               choose
driver data    what Facade knows of each CLI, kept as data
tools          spawn, send, stop, ide
settings       facade.orchestration.*
switch         facade.orchestration.enabled; off means the Facade of L1, which is stock VS Code plus
               the workspace bar
```

## Rules that hold for every milestone

```
✓ drive only the official, unmodified CLI of each vendor, under the user's own login, in its own
  interactive UI
✓ reach an agent only through what every CLI has: its documented flags and configuration, its
  documented hooks, and the terminal the person types in; no vendor's own messaging channel
✓ Facade is the hardware: it provides mechanisms and reads no content - not the charter, a message
  or a plan. How to work is a skill, and the person chooses it
✓ the charter is the person's: kept on their machine, sent nowhere
✓ usage comes only from sanctioned channels: Claude's statusLine `rate_limits`, Codex app-server
  `account/rateLimits/read`, and the agents' own local transcripts and output
✓ agent configuration is injected per launch (flags, files inside the agent's worktree, a launcher
  under ~/.facade/hooks), never written into the user's global agent config - but for a vendor's
  record that the person trusts a folder, written only once the person agreed (OFFICES.md §8)
✓ an agent may do what the person may do: Facade adds no limits of its own, and adds a fence only
  when a real problem shows one is needed
✓ every message carries its author

✗ reading, copying, refreshing or storing any vendor credential or session token
✗ calling a vendor's undocumented endpoints, or spoofing a CLI's User-Agent
✗ telemetry that is on by default
```

⚠️ **Why the credential rule is written down.** Orca copies Claude.ai OAuth credentials, refreshes
them with Claude Code's own client ID, calls `api.anthropic.com/api/oauth/usage` with a spoofed
`claude-code` User-Agent, and swaps accounts by overwriting `~/.claude/.credentials.json`. Anthropic's
terms forbid third parties from collecting, storing or intermediating Claude.ai credentials, and they
explicitly allow what Facade already does: an end user signing in to the unmodified `claude` binary.
Being the tool that never touches a token is part of the product.

### Borrowed code

MIT projects cover much of the groundwork. Reuse keeps their copyright notices in
`ThirdPartyNotices.txt` and never uses their names or logos, but for one: `facade-superpowers`
carries Superpowers' name, as credit for the process it adapts.

```
Orca (Lovecast Inc.)            src/main/agent-trust-presets.ts            the trust records of Codex (config.toml,
                                                                           by repository root, under a lock) and
                                                                           of Antigravity (trustedWorkspaces)
                                src/shared/tui-agent-config.ts             per-CLI launch and input quirks: how text
                                                                           typed into each TUI gets submitted, as
                                                                           driver data
                                its terminal readiness patterns            the screen text that shows a CLI's input
                                                                           box is ready, per CLI, as driver data
                                src/shared/agent-hook-listener/**          hook payload normalising
                                src/main/claude-usage, codex-usage, usage  costs from local transcripts
                                claude/statusline-script.ts                rate limits (M8)
Paperclip (Paperclip Labs, Inc) packages/adapters/*, adapter-utils         adapter shape, output parsing
                                packages/mcp-server                        tool-surface template
Superpowers (Jesse Vincent)     skills/* (6.4.1)                           the process skills, adapted into
                                                                           facade-superpowers (M5)
cross-spawn (MIT)               lib/util/escape.js                         cmd.exe argument escaping
```

Orca had to learn each of those the hard way; its issues record the pastes that were never submitted
and the Claude workers that ignored a pasted brief. What stays out, and why:

```
Orca       hooks written into each agent's global config       the rule above: Facade passes its hooks per
                                                               launch
           idle read from the terminal title and screen text   it never turns idle once a CLI's title is
                                                               switched off; Facade reads state from hooks
                                                               (OFFICES.md OA-4.5)
           the orchestration CLI: workers run `orca            agents call `send`, and Facade delivers
           orchestration send`, the coordinator blocks on      (OFFICES.md §6)
           `check --wait`, heartbeats
           Claude's trust pre-written into ~/.claude.json      not merged there: a running Claude rewrites that
                                                               file; Facade answers Claude's question
                                                               (OFFICES.md §8)
           OAuth credentials and the usage endpoint            the credential rule
Paperclip  Claude with --dangerously-skip-permissions, Gemini  Facade allows file edits and shell commands,
           in yolo mode, Codex with approvals and sandbox      inside each vendor's own sandbox (OFFICES.md §7)
           bypassed
```

### Where the code runs

The workbench renderer is sandboxed and cannot spawn processes. Work that needs a process goes into a
built-in extension, **`extensions/facade-agents`**:

```
extensions/facade-agents (Node)   the ledger, the MCP server behind the pipe, the driver data, spawn,
                                  hooks, delivery, the charter, the skills, usage, the office popup
shim (ELECTRON_RUN_AS_NODE)       each agent's stdio MCP server and hook handler; forwards every call
                                  to the window over a per-window named pipe and holds no state
workbench (renderer)              the dialog-free _facade.* commands below; agent terminals held
                                  under their office's row
```

The `_facade.*` commands, in the shape of `_git.*`, onto which `ide` maps its actions, and onto
`executeCommand` for any other command:

```
_facade.folder.show / remove           add a folder to the workspace and go to it; remove one
_facade.worktree.create / delete       the flows of New Worktree and Delete Worktree, without dialogs
_facade.terminal.create / read / list  a terminal of a given folder; its last lines; every terminal
                                       and where it is
_facade.terminal.reveal / lastInput    put one in front, through its folder's row; when the person
                                       last typed in it
_facade.row.set                        a row's name and colour
```

⚠️ Keeping it in one extension also keeps upstream merges cheap: nothing in upstream files but
optional hooks. If the extension host turns out too narrow, a utility process like upstream's
`agentHost` is the fallback.

---

## The offices

**Where M0 to M7 end.** In a Facade window the person starts an agent in `main`. That agent, in its
own UI, takes the goal, splits it as it sees fit, and starts other agents, naming the CLI and the
model of each: beside it in its office, or sent out to an office of their own, a git worktree
branched from its office. Any agent may do the same. Parent and child talk, and Facade delivers each
message into the other's session. Every agent has the person's charter loaded, and may change it. The
person walks into any office and talks to any agent there, in its own UI. Nothing stops on a question
nobody sees.

The technical design is [`OFFICES.md`](./OFFICES.md), with its rules numbered OA-x.y; the milestones
below build it.

```
offices      main, the repository's own checkout, to begin with; a new one each time an agent sends a
             child out: a worktree branched from the parent's office. An office may be empty, and
             stays until it is deleted
agents       each is its vendor's own interactive CLI, in a terminal held under its office's row; it
             sits in one office, and its name is its office's unless it is given one
parent       whoever started it: an agent, or the person for the first one. Only parent and child
             talk to each other
the person   every agent's terminal is theirs to type in, as the CEO walking the floor
the charter  the person's memory for their agents, on their machine: loaded into every agent,
             changed through ide, read by Facade never
```

The four tools:

```
spawn(agent, model, prompt, office?, name?)   start a child; its prompt is its first message
      agent, model                            both required: Facade checks the CLI is installed and
                                              offers the model, then starts it
      office omitted                          my own office, beside me
      office "new"                            a new office: a worktree branched from my office's
                                              HEAD, on a new branch named after the child
      office "<name>"                         an office of my repository that exists, empty or not
send(to, text)                                to my parent or one of my children; Facade delivers it
stop(name)                                    one of my children
ide(action, args)                             what the person can do in the IDE; the charter
                                              (read_charter, write_charter); the installed CLIs
                                              and their models (list_agents)
```

Facade is the hardware. How agents work together, in one office or across several, whether to send
a child out, and which agent and model do what, is for the agents and the person to decide. Two
skills sit on top, and the tools enforce neither:

```
facade               always: how to use the hardware - the tools, delivery, the charter, reporting
                     to the parent
facade-superpowers   when the person chooses it for the first agent, and then for every agent under
                     it: Superpowers' process, adapted to offices. The first time, the lead asks the
                     person which agent and model do which kind of work and keeps that in the
                     charter; its plans name each task's agent and model
```

There are no roles, no shared notebook and no groups. What an agent can do with its own shell, files
and git - merging, running the tests, reading another office's files - is not a tool.

⚠️ **A parent that has left.** A child's `send` to a parent that stopped is not delivered: the
result says the parent has left, and the child says so in its own output, where the person sees it.

### Vendors

Every vendor already has this inside its own CLI: a parent agent that starts children with a task,
messages between them, and a worktree per child. From each CLI's help and its own tool descriptions:

```
                 Claude Code 2.1.283       Codex 0.158               Antigravity 1.2.12   Muse 1.4.0
own subagents    Agent tool; SendMessage   spawn_agent, send_input,  invoke_subagent,     subagents that share
                 continues one; isolation  wait_agent, close_agent   send_message         the parent's worktree
                 "worktree"                (multi_agent)                                  unless one asks for its
                                                                                          own
own worktrees    -w/--worktree             the worktrees feature     worktree fields,     -w create|existing,
                                                                     unexplained          --worktree-base
```

Facade does it across vendors and in sight: a Claude parent with a Codex child, each a full session
in its own terminal, in offices the person can walk into, that outlive a reload. It uses none of the
vendors' own subagent machinery, and an agent may still use its own inside itself.

What Facade uses of each CLI, kept in the driver data from M4:

```
                 Claude Code               Codex                     Antigravity          Muse
launch           the prompt as argument    the prompt as argument    -i <prompt>          the prompt as argument
model            --model                   --model                   --model, listed by   --model
                                                                     `agy models`
state hooks      UserPromptSubmit, Stop,   UserPromptSubmit, Stop,   PreToolUse, Stop     none
                 Notification              PermissionRequest         (.agents/hooks.json)
push mid-turn    PostToolUse context       PostToolUse message       -                    -
push at a stop   Stop: block and a reason  Stop: block and a reason  to verify            -
opening          SessionStart context      to verify                 to verify            to verify
skills           a plugin, --plugin-dir    .agents/skills            .agents/skills       project skills
first run        trust per folder: Facade  folder trust by           trust per exact      --trust-workspace, for
                 answers in its UI         repository root, written  path, written        the run, not saved
                                           (Orca); hook review:      (Orca)
                                           --dangerously-bypass-
                                           hook-trust
permissions      acceptEdits; Bash and     --sandbox workspace-      --mode accept-edits  --approval-mode never,
                 PowerShell allowed        write, --ask-for-                              its sandbox on
                                           approval never
```

Grok keeps its first-pass adapter: it has no hooks in Facade, so a message reaches it with the
result of its next call to a Facade tool.

### How the offices got here

The first pass built a program engine on `feature/20-program-skeleton`: a lead plans features,
Facade runs the workers, verifies them, merges them through a queue, reviews and ships. The second
pass replaced it with twelve primitives - identity, messages to @names and #groups, a shared
notebook, process skills and a set of views - built on the same branch and run in a window with
Claude and Codex, headless and then in their own UIs. Those runs narrowed it to the offices and
agents above. From both passes:

```
kept      the pipe and the shim, the per-launch injection, hooks, trust decisions, usage and prices,
          the ledger, spawn and stop, worktrees made through the window, terminals held under the
          rows, the IDE commands, the first-run answers, skills delivered per launch, and robustness
          across a reload and a folder window becoming a workspace
reworked  the per-vendor adapters, whose vendor facts become driver data (M4); the seven process
          skills, which become facade (M1) and facade-superpowers (M5)
replaced  the plan, lead and worker tools, the program state machine, the merge queue, the checks
          runner, the review ledger, ship, headless runs; whoami, who, recv, join, leave, read,
          write, list, groups, the notebook, the Facade views
```

⚠️ `feature/20` is committed as it stands, once the person has looked, before anything is removed
(M0), so both passes stay in history.

### Testing a milestone

Every milestone ends with the person's test: what the person does in a Facade window, and what they
see. It is run:

```
where     a dev window of the milestone's branch, built as ENGINEERING.md says, with a short
          --user-data-dir, on a throwaway repository with a few files and a test command
agents    the person's own CLIs, signed in as they are; a run spends real quota
after     the offices it made deleted with Delete Worktree, and its folders under ~/.facade removed
```

A milestone is done when the person's test passes, its automated tests pass on Windows, and it is
reviewed and merged. The next one starts from `main` after that.

---

## M0 — A clean slate

**The outcome.** What the offices replace is gone - the first pass's program engine and the second
pass's extras - and what stays works as it did.

On `feature/20` itself:

1. **Commit it as it stands**, once the person has looked: both passes, so that history keeps them.
2. **Delete** what nothing in the offices uses:

   ```
   the program engine   the plan, lead and worker tools; the program state machine; the merge
                        queue; the checks runner; the review ledger; ship; the scheduler; the
                        headless workers and the shim's run mode; the program commands, settings
                        and strings
   the second pass      whoami, who, join, leave, read, write and list; groups; the notebook, its
                        pages, notices and file watcher; the seven process skills and their
                        protocol pages; the Facade view container (Needs You, Participants,
                        Messages, Notebook) with its Message, Reply, Mark All Read and New Page
                        commands; the notes on rows
   ```

3. **Keep**, working as before: the ledger, the pipe and the shim, spawn and stop with the first-run
   answers and trust, `send` to @names, `recv` and the nudge that points to it, `ide` and the
   `_facade.*` commands, terminals held under their rows, the window's state across a reload, usage
   from transcripts, and the skills' per-launch delivery, empty until M1. `recv` and `spawn`'s
   `where` go in M1, when delivery and offices take their place.
4. **One command**, Facade: Start Agent, takes the New Agent flow's place: the CLI, a model and the
   first message, for the office on screen.

Code cites OFFICES.md's rules, OA-x.y, rather than this plan's steps; the extension's README says
what is left.

**The person's test**

```
1  Facade: Start Agent in main, Claude: it starts in its own UI, as a tab of main
2  ask it to start a Claude child in a new worktree, and another beside it: each starts in its own
   UI under its office's row, with no question left on screen
3  ask a child to send @main a line: main, idle, is nudged, calls recv, and reads it
4  reload the window: all three are still there, and still talk
5  gone: the Facade views, the notebook, the program commands, the notes on rows; the only setting
   left is facade.orchestration.enabled
6  switch it off: no pipe, and nothing written under ~/.facade/workspaces
```

Automated: the extension's tests that stay; the workbench's tests of the Facade commands, folder
terminals, worktrees and the workspace bar; eslint, hygiene and layers.

---

## M1 — Parent and child

**The outcome.** Claude only, and roughly: an agent starts children beside it or in offices of their
own, parent and child message each other, and a child's report wakes a parent that ended its turn.

- **The four tools** (OFFICES.md §5): `spawn(agent, model, prompt, office?, name?)`, the model passed
  as given and checked only from M4; `send` to the caller's parent or children, and "your parent has
  left" (OA-6.8); `stop` of the caller's children; `ide`, typing only into the caller's children's
  terminals and terminals that are no agent's (OA-9.6). `recv` and `spawn`'s `where` go.
- **Offices** (§3): beside the caller; `"new"`, a worktree branched from the parent office's HEAD and
  named after the child, made through the window's New Worktree; or one that exists. Names as
  OA-4.2. The ledger's events become §10's.
- **Delivery, roughly** (§6): Claude's Stop hook blocks with the messages (OA-6.3, OA-6.7); an idle
  agent gets them typed in as `[from @name] ...`, on the guards the nudge has today; every result
  carries what has not been delivered (OA-5.3); a message to the person is a notification (OA-6.10).
- **The `facade` skill**, first version (OA-12.1 without the charter): who the agent is, the four
  tools, that messages arrive on their own and waiting is ending the turn, a report to the parent
  when done or stuck, that it already runs in its folder, that files Facade put there are not its to
  commit. Claude gets it as a plugin.
- **Start Agent** asks for the model too, since `spawn` needs one.

**The person's test**

```
1  Start Agent in main: Claude on a model you pick, with a goal such as "add clamp, slugify and
   words to this repository, each with tests, each by its own Claude child in an office of its
   own, and merge them into main"
2  the children come up in new offices, each under its row, in its own UI; the parent ends its
   turn while they work
3  each child reports, and the report wakes the parent; it merges; main has all three
4  type into a child while it works: it answers you, and nothing is typed over you
5  ask a child to message a sibling: refused, naming its parent and its children
6  stop the parent, then have a child report: it says in its own output that its parent has left
7  reload halfway: no agent, message or name is lost
```

Automated: the four tools' arguments and addresses, through the real shim; the office rules - beside,
new from the parent's HEAD, one that exists, another repository's refused; delivery at a stop and
when idle, with a fake agent; the `facade` skill in Claude's launch.

---

## M2 — Codex

**The outcome.** A second vendor, both ways: Claude parents with Codex children, and a Codex parent
with Claude children.

- **Codex's launch** (§7): its hooks through `-c`, the same command at every launch;
  `--sandbox workspace-write --ask-for-approval never`; a tool timeout of 3600 seconds.
- **Codex's first run** (§8): once the person agreed, the repository root's trust written into
  `~/.codex/config.toml` under a lock (Orca's code), and the hook review skipped with
  `--dangerously-bypass-hook-trust`, for each launch.
- **Delivery to Codex**: its Stop hook blocks, as a continuation prompt; text is typed the way Codex
  takes it, a new line as Alt+Enter on Windows.
- **The `facade` skill for Codex**, in `.agents/skills/` in the office, listed in the repository's
  `info/exclude` and gone when the office's last agent stops.

⚠️ Codex's `workspace-write` sandbox keeps `.git` read-only, so a Codex child cannot commit; the
`facade` skill tells it to leave its changes for its parent.

**The person's test**

```
1  a Claude lead in main sends Codex children out to offices of their own; a Codex lead in main
   starts a Claude child beside it
2  no first-run question is left on any screen; ~/.codex/config.toml gains one entry, the
   repository's, and nothing else
3  a message reaches Codex while it works, as its turn ends, and when it is idle
4  the goal reaches main
```

Automated: Codex's launch arguments; the trust record written once, merged into what is there, under
a lock; Codex's hook answers.

---

## M3 — Delivery done right

**The outcome.** Every message arrives once, in order, at the first moment it can, and never over
what the person is doing: OFFICES.md §6 in full.

- **Mid-turn**: PostToolUse adds the messages to a working agent's next step, Claude's and Codex's
  (§16 settles Codex's field).
- **Typing safely**: only once the screen shows the input box ready (Orca's readiness patterns),
  never while a permission prompt is open, and text of more than one line pasted in bracketed-paste
  mode, with each CLI's quirks (OA-6.4).
- **Confirmed**: a typed message counts once the next UserPromptSubmit carries it; it is typed again
  once after 10 seconds, then reported to the sender as not delivered (OA-6.5).
- **Long messages** go to a file, delivered as their first lines and its path; Claude gets
  `--add-dir` for the folder (OA-6.6).
- **Once and in order**, the way recorded in `message.delivered` (OA-6.2).
- **Fast enough**: the hooks' time per call measured on Windows, and PostToolUse back within about
  300 milliseconds when nothing waits (OA-7.2).

**The person's test**

```
1  message a child in the middle of a long task: it takes the message in its next step, not at the
   end of the task
2  bring a child to a permission prompt, then message it: nothing is typed until the prompt is
   answered
3  type slowly into an idle child as a message comes: it waits until you have been quiet 5 seconds
4  send a 5,000-character message: the child gets its first lines and a path, and reads the file
   without being asked
5  send three messages in a row: each arrives once, in order, and the ledger says how
```

Automated: each way with a fake agent through the real shim; each guard; the retry and the
not-delivered report; the file; the order.

---

## M4 — Knowing and remembering

**The outcome.** Facade knows each CLI from data rather than code, checks what `spawn` is given, and
every agent carries the person's charter.

- **Driver data** (§13): `extensions/facade-agents/drivers.json`, with `~/.facade/drivers.json` over
  it. The adapters become one driver that reads it; a CLI newer than the data takes the newest range,
  and the log says so.
- **`list_agents`**, and `spawn` checking the agent and the model (OA-5.5, OA-13.3), refusing with
  what there is.
- **The charter** (§11): `~/.facade/charter.md`, loaded at SessionStart - the start, `/clear`,
  compaction - as each CLI takes it (§16), otherwise ahead of the first message; `read_charter`, and
  `write_charter(text, version)` with the version a hash of the file, a stale write refused with the
  current text, and what each write replaced kept in `charter.history/`; loaded cut past 20,000
  characters.
- **The `facade` skill** gains the charter and the model: the charter is loaded, and changed on its
  latest version, keeping what others wrote; `spawn` needs an agent and a model, and `list_agents`
  shows them.

⚠️ Later, not in M0 to M7: the data fetched from a GitHub repository, signed, and checked by a CI
(OFFICES.md §13).

**The person's test**

```
1  ask an agent what it can start: list_agents shows each installed CLI, its version and its models
2  have it start a child on a model that does not exist: refused, with the models there are
3  write a rule into ~/.facade/charter.md, then start an agent: it follows the rule, and still does
   after /clear and after a compaction
4  ask an agent to add a rule: the file has it, and charter.history has what it replaced; edit the
   file yourself while it works: its write is refused, and it writes again on your version
5  change a flag in ~/.facade/drivers.json: the next launch carries it
```

Automated: the data's schema; each CLI's launch from the data equal to M2's; the override; a newer
version; the charter loaded at the start and after a compaction; a stale write refused; the history.

---

## M5 — facade-superpowers

**The outcome.** A way of working the person may choose for a tree of agents, with who does what
asked once and kept in the charter.

- **The skill** (§12): Superpowers 6.4.1 adapted to offices and the four tools (OA-12.2), its opening
  loaded with the charter, delivered to each CLI per launch.
- **Chosen** for the first agent in Start Agent; every agent under it inherits the choice (OA-12.4).
- **Staffing** (OA-12.3): the first time, the lead asks the person which agent and model do which
  kind of work, reads it back, and writes it into the charter; its plans name each task's agent and
  model, from the charter or from what the person said for this run; only "remember this" changes
  the charter.
- **Credit**: Superpowers' copyright notice in `ThirdPartyNotices.txt`; `facade-superpowers` keeps its
  name.

**The person's test**

```
1  with an empty charter, start a lead with facade-superpowers: it asks you which agent and model
   do which kind of work, reads it back, and writes it into the charter
2  give it a goal: it talks the design through with you, writes a plan naming each task's agent and
   model, starts the children by it, has the work reviewed, and asks you before main
3  say "this time, Codex for everything": the plan follows, and the charter does not change; say
   "remember: reviews by Claude on opus": the charter changes
4  a second lead reads the staffing from the charter and asks nothing
5  a lead started without it: none of this, only the facade skill
```

Automated: the skill in each CLI's launch; the choice inherited by children; the staffing written
through `write_charter`.

---

## M6 — More vendors

**The outcome.** Antigravity, Muse and Grok as parents and children, each by the ways it has.

- **Antigravity** (§7, §8): `-i` for the prompt; its MCP server and hooks in `.agents/`; the office
  added to `trustedWorkspaces` (Orca's code); `--mode accept-edits`; its Stop answer as §16 finds it;
  skills in `.agents/skills/`; models from `agy models`.
- **Muse**: the prompt as argument, `.mcp.json` in the office, `--trust-workspace` and
  `--approval-mode never`; no hooks, so its messages come with its tool results (OA-6.9); skills
  where §16 finds.
- **Grok**: its first-pass launch and `--trust`; its messages with its tool results.

**The person's test**

```
1  a Claude lead sends an Antigravity child and a Muse child out to offices of their own: each
   starts with no question left on screen, does its task and reports
2  a message reaches each: Antigravity by its hooks or its terminal, Muse with its next tool result
3  a Grok child does the same, its messages coming with its tool results
4  an Antigravity lead starts a Claude child
```

Automated: each launch from the data; Antigravity's trust record written once and merged.

---

## M7 — The office popup

**The outcome.** One popup shows what the offices are, and runs them (OA-9.3).

- **Drawn first**, reviewed by the person, and built only once approved.
- **It shows** the offices as a tree from `main`, the agents in each with their vendor, model, state
  and parent, and each parent's conversation with a child.
- **From it** the person goes to an office, starts an agent there - its CLI, its model and, for a
  first agent, `facade-superpowers` - stops one, opens its terminal, or opens the charter. Start
  Agent opens it at the office on screen.

**The person's test**: the popup matches the approved drawing; every action in it works; it stays
right through a reload and a folder window becoming a workspace.

---

## M8 — Manage every agent

**The outcome.** One board shows every agent and every piece of work across all folders: state,
cost, quota left, what is blocked, what is scheduled.

⚠️ M8 to M10 were written before the offices. Their words - tasks, lead, worker - are revisited when
M7 closes: work is what a parent's prompt gives a child, and an office is a worktree.

It benchmarks Paperclip at developer scale. It deliberately leaves out companies, org charts,
multi-tenancy and enterprise permissions. If a user wants those, Facade can later connect to a
Paperclip instance as its desktop client.

| # | Item | Size |
|---|------|------|
| M8.1 | Agent registry and accounts | M |
| M8.2 | Task board | L |
| M8.3 | Usage and quota | M |
| M8.4 | Budgets and policies | M |
| M8.5 | Dependencies and routines | M |
| M8.6 | Session history | M |

- **M8.1 — Agent registry and accounts**: installed agents, versions and login state, read through
  each CLI's own status command. Several accounts per vendor are separate config homes (a
  `CLAUDE_CONFIG_DIR` or `CODEX_HOME` each), each signed in through the vendor's own flow. Which
  agent and model do which work stays in the person's charter (M4, M5).
- **M8.2 — Task board**: every task, grouped by folder, agent or state. Filters; bulk pause, cancel
  and archive. A task page shows the plan, timeline, checks, review, diff and cost.
- **M8.3 — Usage and quota**:
  - Claude: forward `rate_limits` from a statusLine injected only into sessions Facade launches.
  - Codex: `account/rateLimits/read` through app-server.
  - Costs: from local transcripts against a pricing table.
  - One gauge per subscription; routing prefers agents with quota left.
- **M8.4 — Budgets and policies**: caps per agent, task or day. A soft cap warns; a hard cap
  pauses the agent. An activity log records every spawn, message and merge.
- **M8.5 — Dependencies and routines**: blocked-by links between tasks. When all of a task's
  children finish, its lead is woken, as in Paperclip. Scheduled routines create tasks; a morning
  digest summarises the night.
- **M8.6 — Session history**: a local, redacted index of agent transcripts. Resume any past session
  in a terminal.

The person's test:

```
twenty tasks across three repositories and four agents, managed from one board
a hard budget pauses an agent mid-run, cleanly
a routine runs overnight, and the digest is waiting in the morning
switch off: no board, no ledger reads, no transcript indexing
```

---

## M9 — Polish and onboarding

**The outcome.**
- **Status at a glance** on every worktree row, the way the reference card shows it (M9.1).
- **A first task in five minutes**: from install to the first reviewed task, on Windows first.

| # | Item | Size |
|---|------|------|
| M9.1 | Agents on the worktree row | M |
| M9.2 | Composer and review | L |
| M9.3 | Onboarding | M |
| M9.4 | Attention | S |

### M9.1 — Agents on the worktree row

Reference: Orca's worktree card (`WorktreeCard.tsx`, `WorktreeCardAgents.tsx`).

```
line 1   status dot · folder name · "primary" chip on the repository's main worktree
line 2   branch
line 3   one pill: state glyph (✓ done · spinner working · ! waiting or blocked) · a glyph per
         agent · "+N" overflow · chevron
```

- **Expanding the pill** gives one row per agent: state, elapsed time, and actions (focus its
  terminal, send it a message).
- **Unread**: a row stays marked unread until visited.

⚠️ Follow WORKSPACE.md §7, the column's look: one ink, the row says which one it is with a chip,
`facadeBar.*` tokens only, no root-anchored `:has()`.

⚠️ Vendor logos are trademarks. Use each vendor's published brand assets under its brand terms, or
neutral glyphs with the agent's name.

### M9.2 — Composer and review

- **Composer**: folder, environment, branch, agent, model and mode; `@` mentions for files,
  branches, commits and local changes.
- **Contextual nudges**: trust this folder; add a setup recipe; add an AGENTS.md.
- **Per-worktree review**: an All Changes view built on the upstream multi-diff editor. Line
  comments (upstream Comments API) are sent back to the agent in a batch. "Review with <agent>",
  Apply and Check out sit alongside.
- **Toasts** carry the next step ("Ready for review", "Changes applied locally").

⚠️ Air's rough edges not to repeat: Apply offered on a task with no branch; the generated commit
message not landing in the box; stale diff statistics after a second apply; label text broken
mid-word in a narrow column.

### M9.3 — Onboarding

A first-run flow:

1. Detect installed agents.
2. Check each login with the CLI's own status command.
3. Explain subscription versus API key in one sentence each.
4. Set up the repository's recipe and AGENTS.md.
5. Offer a sample goal on a sample repository.

Windows gets checks for execution policy and `.cmd` shims, and must never trigger a firewall
prompt. The target is the first reviewed change under five minutes.

### M9.4 — Attention

- **States that notify**: needs input, done, failed.
- **Where**: operating-system notifications, badge counts, and quiet hours.

The person's test:

```
a new Windows user reaches a first reviewed change in under five minutes
the state of every agent is readable from the workspace bar without opening anything
the rows hold up in a running window with real agents on them, as WORKSPACE.md §8.2 reads them
```

---

## M10 — Distribution

**The outcome.** A launch that people pass along because of what it shows, not what it claims.

| # | Item | Size |
|---|------|------|
| M10.1 | Positioning and license | S |
| M10.2 | Site, docs, cadence | M |
| M10.3 | Demo and build in public | M |
| M10.4 | Benchmark harness | L |
| M10.5 | Claude Code plugin | M |
| M10.6 | Launch | M |

- **M10.1 — Positioning and license**:
  - The line: "All your agents, in the real VS Code."
  - Decide on open source. Both competitors are MIT, so it is close to the entry ticket for this
    category.
  - No competitor or vendor names in product names or logos.
- **M10.2 — Site, docs, cadence**: a landing page, docs, a changelog, and a frequent release channel.
- **M10.3 — Demo and build in public**:
  - A weekly clip from M1 onward.
  - The launch video: four agents in the real VS Code, with a breakpoint hit halfway through.
    That shot is one Orca cannot record.
  - Chinese long-form posts, and polished Windows builds for that audience.
- **M10.4 — Benchmark harness**: open-source, with the protocol published before any run.
  - A reviewer matrix: who reviews whom, and whether pass rates rise or fall.
  - Verified versus self-reported results.
  - One subscription stretched further, measured from real usage logs.
  - The same score at a fraction of the cost.
  - Runs use API keys.
- **M10.5 — Claude Code plugin**: exposes Facade's tools inside Claude Code and ships through its
  plugin marketplace, as a funnel into Facade.
- **M10.6 — Launch**:
  - Channels: Show HN, Product Hunt, and Chinese communities (知乎, V2EX, 即刻, B 站, WeChat).
  - Metrics come from opt-in telemetry only, with a public privacy page.

The person's test: targets for downloads, weekly active users and changes shipped are set at M10.1
and reviewed after the launch.

---

## Tests, across milestones

```
unit            ledger replay and repair, incarnations, tool schemas and addresses, the driver data
                and each CLI's launch from it, the first-run answers on the screens the CLIs show,
                the charter's versioned writes
integration     fake agents calling the four tools through the real shim and pipe; delivery through
                hooks and through the terminal; the charter and the skills loaded at the start and
                after a compaction
live            real agents (claude, codex, agy, muse) on a throwaway repository, in a window, each in
                its own UI; never against the person's own repositories
windows         every live case runs on native Windows before a milestone closes
```

⚠️ A live agent run spends real quota. Live suites run on demand, not on every change.

## Order and overlap

Milestones run in order, each finished before the next begins. Two things overlap: M7's popup is
drawn and reviewed while M3 to M6 are built, and M10's weekly clips start from M1.
