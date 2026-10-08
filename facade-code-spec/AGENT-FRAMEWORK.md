# Facade agents

Facade runs vendors' coding-agent CLIs - Claude Code, Codex, Muse Code and Antigravity - in their own
terminal UIs inside the window, and gives each one an MCP server through which agents start, list and
end each other. The model is borrowed from operating-system processes, not their words: an agent has
a name and a number, as `@main #1`, a parent and children; the person, `@you`, has no number, starts
the first agents, and takes in the children of an agent that exits. A number is Facade's own, never
an operating system's process id. Facade records what it did and what it knows for certain - a
launch, an MCP server's hello, a terminal that ended - and never reads a screen to decide anything,
nor guesses whether an agent works.

Chapter 1 is starting, listing and ending agents. Looking into an agent's terminal - reading its
screen, typing and pressing keys there - is [AGENT-DEBUGGING.md](AGENT-DEBUGGING.md). The messages
agents send each other and the person are [AGENT-MESSAGES.md](AGENT-MESSAGES.md), which replaces what
this chapter says of a child's task: the task file, the line typed to tell of it, `task.typed` and the
opening are gone - a task is the first message in the child's mailbox, and the child's first line names
it (M7). A creator learns of its children's ends by a message as well as from `ps` (M8). The ledger is
version 5, reading version 3 (M11). The launch groups gain `questions` and `messages`, and the timeout
also times the notices of a task or of messages left unfetched (M6). Where this chapter and
AGENT-MESSAGES.md differ, AGENT-MESSAGES.md holds.

## Architecture

```
terminal                   shim.js, a Node process       the window
--------                   -----------------------       ----------
the agent's CLI  --MCP over stdio-->  MCP server  --HTTP over a named pipe-->  extension host:
                                                                               PipeEndpoint
                                                                               Contract   the tools
                                                                               Facade     the core
                                                                               AgentTable, Injections
                                                                               ports --> VS Code API, git,
                                                                                         _facade.* commands
```

- **The shim** is the MCP server every agent's CLI starts: Facade's own executable with
  `ELECTRON_RUN_AS_NODE=1` runs `shim.js mcp`. It is a process of its own so that an agent's tools
  outlive a window reload: the CLI stays connected to the shim, and the shim waits for the window -
  Facade's timeout, two minutes unless the person sets otherwise (1.9), tried every second. It keeps
  no state. At MCP `initialize` it says hello to the window
  (`POST /hello`) and hands the CLI the window's tools and instructions; each `tools/call` becomes a
  `POST /call`. A call cut off halfway is not made again, and says it may have run. A window that is
  away, or does not answer, is waited for once: after that the shim says at once that it is away.
- **Who calls** is said by a bearer token on every request. An agent's token is 32 random bytes in
  `runs/<number>.token`, passed as `--pipe <pipe> --token-file <file>`; a CLI that reads one server
  configuration for all its agents in a folder starts `shim.js mcp --agent`, and the shim reads
  `FACADE_AGENTS_PIPE` and `FACADE_AGENTS_TOKEN` from the agent's environment. A script holding the
  person's token in `you.token` acts as the person.
- **The pipe** is HTTP on `\\.\pipe\facade-agents-<id>` (a Unix socket elsewhere), so that nothing
  listens on TCP. `/call` answers in newline-delimited JSON: progress lines, then one result or error
  line. A body is at most 1 MB. A call runs to its end even when its caller has gone.
- **One window** has a workspace's agents at a time. The ledger is only appended to, so a reload
  replays it and a crash loses at most the line being written. The pipe's id is kept, so a reloaded
  window listens where the running agents' shims call: while the window before still holds it, it is
  waited for - as long as their shims wait for the window, while agents run - and only then is a new
  one taken, the person told that the agents still running lost Facade's tools.
- **The workbench** gives the extension what its API cannot, as commands with no dialog:
  `_facade.folder.active`, `_facade.worktree.create` (WORKTREE.md, WT-5.11), `_facade.terminal.create`
  (a terminal held under a folder's row, its name kept across a reload), `_facade.terminal.reveal`,
  `_facade.terminal.whenRestored` (once the window has its terminals back after a reload: reconnected
  to their processes, the editor area restored) and `_facade.window.loaded` (an id of this load of the
  window's own, and whether a reload of the window before loaded it, as VS Code tells itself).

## Code

`extensions/facade-agents/src`, in layers. A file imports only from its own layer and the layers listed
for it, and only `host` imports `vscode`; a test reads every import to hold the code to that.

```
layer        may import                                 is
extension.ts host base                                  activation
host         contract core record clis transport base   VS Code: one adapter per port, and the wiring
contract     core record transport base                 what the model sees
core         record clis base                           the rules: spawn, ps, kill, exits
record       base                                       what a workspace keeps on disk
clis         base                                       what differs between CLIs
transport    base                                       between an agent's CLI and the window
base         -                                          what any layer may use
```

```
extension.ts       the switch facade.orchestration.enabled; Start Agent; Show Agents Log; Show Agent Launch
host/
  service.ts       puts it together at start - record, ports, core, tools, pipe - and finds the running
                   agents again; stops as the window goes, or as Facade lets go of its agents
  settings.ts      the person's settings as the window has them now: each CLI's, and the timeout
  terminals.ts     Terminals: launches through _facade.terminal.create, finds a terminal again by name or
                   process id once the window has its terminals back, reports its end
  terminalEnd.ts   what a terminal's end is to Facade: the person closed one that ended for the user
                   with no exit code
  terminalMatch.ts which of the window's terminals is an agent's: the one running its process, else the
                   one of its name - while its process runs, and unless that one runs another
  git.ts           Git: reads git's records with gitCli.ts; makes worktrees through
                   _facade.worktree.create
  gitCli.ts        git's records, read by running git
  person.ts        Person: notifications
  startAgent.ts    Start Agent: the person picks the CLI, and types the model, the effort and the first
                   message
  showLaunch.ts    Show Agent Launch: what each CLI is started with now, read-only
  windowState.ts   the window's own state beside the ledger: the pipe's id, the terminals' process ids
contract/
  tools.ts         Contract: the hello, and a tool call turned into a result whatever happens
  spawn.ts ps.ts kill.ts   one tool each: its schema, its arguments, its result's text and data
  args.ts          arguments, checked one by one
  prompts.ts       the hello's instructions, the first message's opening, the facade skill
core/
  facade.ts        Facade: spawn, ps, kill, connected (an MCP server's hello), recover; exits
  launch.ts        one launch, from its LaunchSpec to the child up: run files, files in the folder, the
                   terminal, the wait for the hello, the task line
  injections.ts    the files put into folders for agents, and taken back
  ports.ts         Terminals, Git, Person; CliCatalog, AgentSetup
  errors.ts        FacadeError and its five codes
clis/
  cli.ts           AgentCli, CliConfig, TrustConfig, LaunchInput, LaunchSpec, InstalledCli; a launch's
                   arguments from its groups, each ${name} given its value
  config.ts        how the person has Facade start a CLI: the CLI's launch with theirs over it, each value
                   checked
  claude.ts codex.ts muse.ts antigravity.ts
                   one CLI each: its launch, and the values of its trust
  trust.ts         a trust written into the file a CLI keeps: merged in, under the CLI's own lock
  describe.ts      what Show Agent Launch shows
  executable.ts    a CLI's executable: found on PATH; an npm shim run as its script with Node; what
                   cmd.exe must not be given
  registry.ts      the CLIs Facade knows, and those this machine has
transport/
  protocol.ts      what crosses the pipe - the hello, a tool's result, the lines of a call - and reading
                   it with every field checked
  pipe.ts          HTTP over a named pipe: PipeServer, PipeClient
  endpoint.ts      the window's end: listens, writes window.json, says how to start the shim
  mcpServer.ts     an MCP server over stdio
  shim.ts          the shim: the MCP server that forwards to the pipe
record/
  events.ts        Agent, the ledger's events, and the state they replay to
  ledger.ts        ledger.jsonl and ledger.lock
  agents.ts        AgentTable: numbers, names, tokens, run files; what the core asks and records
  paths.ts         where records are, under ~/.facade
base/              async, errors, files (one-step replace, JSON written back in its layout), json,
                   lock (a lock every window takes), system
```

What the core is built on, in outline:

```
interface Agent {
    id: number; name: string; parent?: number; cli: string; model: string; effort: string;
    worktree: string; folder: string; taskFile?: string; taskTyped?: boolean;
    state: 'starting' | 'running' | 'exited';
    exit?: { kind: 'exited' | 'killed' | 'failed'; reason: string; time: number };
    startTime: number;
}
interface AgentCli {
    id; displayName; section; command;         // section: its settings' names, facade.orchestration.<section>.*
    defaults: CliConfig;                       // how Facade starts it unless the person sets otherwise
    trustValues?(worktree, env);               // what ${name} stands for in a trust kept in a file
    sharedServer?: boolean;                    // one server file for all its agents in a folder
    task: 'argument' | 'terminal';
    launch(input, executable): LaunchSpec;     // executable, args, env, cwd; files for its run
}                                              // folder; injected, for the agent's folder
interface CliConfig {                          // 1.9
    path;
    launch: { arguments: { [group]: string[] }; environment; trust?: { arguments } | { file; merge };
              settings?; enterDelay; taskDelay };
}
interface FacadeOptions {
    table: AgentTable;
    ports: {
        terminals: { launch; isAlive; onDidEnd(name, { exitCode?, byThePerson }); stop; type };
        git: { repositoryOf; worktreesOf; makeWorktree(main, branch, startPoint); excludeOf; tracks;
               untrackedAnywhere };
        person: { tell(text, terminal?) };
    };
    clis: { known; installed(); configOf(cli); environment() };  // CliCatalog
    setup: { mcpServer(tokenFile); sharedMcpServer(); agentEnv(token); skills(); opening(agent, parent) };
    timing?(): { startTimeoutMs };             // the person's timeout, read at each use
    log(message): void;
}
```

Each layer has its own tests, with fakes for the ports and a clock the tests move.

## 1 Agents

### 1.1 The model

```
number       per workspace, from 1 up, never given twice, written #1; Facade's own, not a process id
parent       the agent that spawned it while that one runs; then the person, @you, who has no number
name         a label: lower case, [a-z0-9][a-z0-9._-], at most 40; not you, facade, all, everyone,
             me, init, kernel. Agents may share it: @name names one where one running agent has it
state        starting from its launch; running once its MCP server said hello; exited once its
             terminal ended, it was killed, or it did not come up - with how and why, kept for good
terminal     @<name> #<number> · <CLI>, under the row of its folder, a worktree that has not joined the
             workspace included. It opens without moving the window or taking the focus: behind the
             tab in front on the folder on screen, else held for its folder until the window goes
             there. An agent the person starts comes up in front.
```

### 1.2 The tools

The MCP server `facade` has three tools. Each result is text the model reads whole, with the same
facts as structured data; a failure is a result marked as an error, its data `{ code }`, one of
`INVALID`, `NOT_FOUND`, `REFUSED`, `UNAVAILABLE`, `FAILED`, its text what is wrong and what would be
right. An argument a tool does not take is refused.

```
spawn(cli, model, effort, prompt, worktree?, name?)
    model      as the CLI's --model takes it; effort, how hard it thinks, as the CLI takes a level
    worktree   omitted: the caller's folder; "new": a new worktree on the branch name, at the
               caller's worktree's HEAD; a name: that worktree of the caller's repository
    name       omitted: the worktree's name; required with "new"
    answers    once the child is up: id, name, cli, model, effort, worktree, folder, newWorktree
ps(all?)       the caller, its parent and its children - those it spawned, exited ones too, and
               those that are its own now - or every agent; per row id, parent (its parent now; none
               for the person), name, state, cli, model, effort, worktree, folder, startTime, exit
kill(agent)    one of the caller's children, by its number - #7, or 7 - by @name, or as Facade writes
               it, @name #7; the person kills any. Its terminal closes, its folder stays, its children
               are the person's
```

The hello's instructions tell the model who it is, who started it, where it runs and what the tools
do. An agent's first message starts the same way - `[facade] You are @<name> #<number>, a <CLI> agent
in Facade Code, started by <@parent #n | the person, @you>. Your task:` - for a CLI whose model never
sees the instructions. Every agent is handed the `facade` skill: the tools, and
the CLIs this machine has.

The model and the effort are the CLI's to take: Facade passes them on as they are and checks neither.
A CLI is the one that knows what it has - Claude Code and Codex send a model missing from their own
catalogs to their service all the same - and a list of Facade's would go stale with each release, and
refuse what a CLI takes. No CLI checks the model as it starts: given one it does not have, Claude
Code, Codex and Muse Code come up and fail at the first step, on their screens, and Antigravity works
on its own default model without a word; an effort a CLI does not have it may ignore, or take a level
of its own. A spawn's answer does not tell: the child's screen does.

### 1.3 Spawn, step by step

1. Checked before anything is made: the CLI is on PATH (`UNAVAILABLE`), the model and the effort
   are given and the name valid (`INVALID`); the place - a folder with no repository has no worktrees
   (`REFUSED`), a worktree that is not there is `NOT_FOUND` with the names there are, "new" needs a
   commit at HEAD; the launch as the person set it - a `${name}` with no value in its arguments or its
   trust is `UNAVAILABLE`, naming the setting.
2. A new worktree is made from the caller's HEAD and recorded (`worktree.made`).
3. In a worktree Facade made, the CLI gets the person's trust (1.6).
4. `agent.started`: the next number and a token. The first message - the opening, then the task - is
   the CLI's argument, or for a CLI told of its task in its terminal, `runs/<number>.task.md`.
5. The launch: the CLI's `LaunchSpec`, as the person sets it (1.9); its run files written, readable
   by the user only; its files put into the folder (1.7); its terminal launched, with
   `FACADE_AGENTS_PIPE`, `FACADE_AGENTS_TOKEN` and `FACADE_AGENTS_WAIT_MS` for a shared server.
6. Its MCP server's hello makes it running (`agent.running`). A CLI told of its task in its
   terminal gets, after its task delay, `[facade] Your task is in <file>: read that file, then do
   what it says.` and Enter after its enter delay; then `task.typed`. Then spawn answers.

Nothing asks the person first: an agent works with nobody at the keyboard, and a spawn that waited for
an answer would stall its parent. A spawn once begun is carried through: no cancellation, and a caller
that exits meanwhile leaves its child to the person, who is told. Anything that fails from step 4 on
ends the child as failed and closes its terminal; spawn fails with `<CLI> did not start as @<name>
#<number>: <why>`. With no hello within the timeout - two minutes unless the person sets otherwise
(1.9) - the child is failed so: its CLI may be waiting for an answer on its screen. A window that
closes meanwhile does nothing more, and the call is `UNAVAILABLE`.

### 1.4 Exits, kill, reload

```
its terminal ended by itself    exited - with its CLI's exit code where not 0 - or failed, while starting
the person closed its terminal  killed, by the person: VS Code says the user ended it, and its CLI left
                                no exit code - VS Code closes a tab whose process exited as if the
                                user had, its exit code kept
the person closed its window,   killed, by the person: the window before was closed, not reloaded, and
quit Facade, or opened another  none of its agents came back with the next
workspace in it
its folder or its repository    killed, by the person, wherever its terminal is - a tab, held for its
taken out of the workspace; its folder, or the panel - and whether or not the person ever went there. A
worktree deleted, with Delete   folder of the workspace git emptied stays in the workspace, as VS Code
Worktree or by git              leaves a folder that is gone
kill                            killed, by its parent or the person: recorded, then its terminal closed
no hello within the timeout,    failed, and its terminal closed
a launch or a task line that
failed
```

On every exit its run files go, and the files Facade put into its folder are let go once no agent of
the window runs there. The person is told of a child of theirs that exited without their doing -
not of a Start Agent of theirs that failed, which tells them itself - and of the children that are
theirs because their parent exited. An agent learns of its children's exits from `ps`.

Facade that comes back - with a reload, a restart, or turned on again - finds each agent that has not
exited, once the window has its terminals back: reconnected to their processes, the editor area
restored, the window given a minute at most. An agent's terminal is the one running its process: a tab
whose process VS Code could not reconnect to comes back as a new shell under the old title, and is not
the agent's: once its agent is found gone, it is closed, as the agent's terminal would have been, so
that no shell under an agent's name outlives it, or comes back with the next restart. One starting is
given the timeout again for its hello;
one running but not yet told of its task is told. One whose terminal is gone went with the window when
the window before was closed - another workspace's, or this workspace's and not reloaded - and none of
its agents came back: killed, by the person, who is not told. After a reload, while Facade was off,
when only the extension host started again, after a crash, or beside others that came back, it ended
by itself - exited, or failed if it was starting - and the person is told of theirs. That the window
was reloaded, VS Code records for itself; the ledger's lock says whether the window went or Facade let
go of its agents, the window staying, and which window: its owner and its load. Those gone are recorded
children first, so that no parent's exit leaves one of them to tell of as the person's. A worktree
Facade made that is gone is forgotten, and what windows that closed left in folders is taken back.

### 1.5 Starting each CLI

As Facade starts each CLI where the person sets nothing else (1.9):

```
              Claude Code             Codex                    Muse Code              Antigravity
server        --mcp-config <run file> -c mcp_servers.facade.*  .mcp.json in the       plugin
              --strict-mcp-config     --no-daemon              folder, shared         .agents/plugins/
                                                                                      facade, shared
skills        --plugin-dir <run dir>  .agents/skills           .agents/skills         the plugin's
full access   --dangerously-skip-     --dangerously-bypass-    --disable-approval     --mode accept-edits
              permissions             approvals-and-sandbox    --disable-sandbox      --dangerously-skip-
                                      --dangerously-bypass-                           permissions
                                      hook-trust
trust, in a   projects[<repository    -c projects={<folder> =  --trust-workspace,     trustedWorkspaces in
worktree      root>].hasTrust-        {trust_level="trusted"}} for the launch         ~/.gemini/antigravity-
Facade made   DialogAccepted in       for the launch                                  cli/settings.json
              .claude.json
nothing that  in its environment:     update check, tooltips,  its launcher's update  its background update
stops it      prompt suggestions,     model nudge off          off                    off
              survey, recap, IDE
              connection, updates
              off; in its settings:
              tips, emoji, its
              full-access warning
the model     --model <model>         --model <model>          --model <model>        --model <base name>
the effort    --effort <level>        -c model_reasoning_      --reasoning-effort     --effort <level>,
                                      effort="<level>"         <level>                which picks the
                                                                                      model's variant
the task      its argument            its argument             typed (1.3)            typed (1.3), after
                                                                                      its warm-up turn
```

Claude Code's settings file is the weakest of these channels: one value of a kind it does not take
makes it drop the whole file, unsaid. So what an environment variable does is done there - a variable
a version no longer knows leaves the others as they are - and the settings hold only what no variable
does. Facade runs a CLI only to start an agent, always in its launch's environment, so that nothing
Facade does updates a CLI under its agents.

A CLI that is npm's shim (`.cmd`) for a script Node runs as it is, with no options of its own, is run
as that script, by a Node that is a program of its own: the one beside the shim, else the one on PATH.
Any other `.cmd` goes through cmd.exe, so it is told of its task in its terminal, and an argument that
cmd.exe would read as its own - `" % ^ & | < > ! ( )` or a line break - refuses the launch.

### 1.6 Full access and trust

Every CLI starts at full access, and nothing asks the person first: an agent works with nobody at the
keyboard. Its launch's `fullAccess` arguments give it (1.5), and a person who wants a CLI to ask sets
them to null (1.9).

In a worktree Facade made, the CLI is given the person's trust in it, so that it does not stop to ask
whether they trust the folder: as the `trust` part of its launch says, arguments for that launch
(Codex, Muse Code), or an entry merged into the file the CLI keeps, as it writes the person's answer
(Claude Code, Antigravity). Trust is given only there, and not taken back. Claude Code keeps it for the
whole repository, keyed by its root's real path with forward slashes and an upper-case drive;
Antigravity for the worktree, by its real path; Codex for the launch, keyed by the real path with its
ASCII letters lower-cased on Windows, as Codex keys it; Muse Code for the launch.

An entry is merged as the CLI writes it: objects key by key, a list given each item it lacks - a path
it has in another case or with other slashes is one it has - any other value set. The rest of the file
is kept, and its layout too; a file that is not a JSON object, or a value of another kind than what
would be merged there, is left alone, and the CLI asks the person itself. It is merged under a lock
every window takes, the one Claude Code takes on its own file, `<file>.lock`, so the two take turns,
and what a CLI writes between Facade's read and its write is read again and kept. A CLI's file is the
one it reads in the environment its launch starts with - the window's, as
`terminal.integrated.env.<platform>` changes it, with the launch's own over it, `CLAUDE_CONFIG_DIR`
say - and Claude Code's is an older version's `.config.json` in its folder where there is one.

### 1.7 Files Facade puts into a folder

A CLI that reads its MCP server or skills from its folder gets them there before its launch:
- All or none. A file git tracks, one of the person's that cannot take Facade's part, or one another
  open window wrote for its own agents, which would change under them, refuses the launch with why.
- A file of the person's that git does not track gets Facade's entries merged in beside theirs.
- Each file gets a line in the repository's `info/exclude`, unless some worktree of the repository has
  a file of the person's at that place that git neither tracks nor ignores. A folder Facade makes gets
  a `.gitignore` of `*`.
- `~/.facade/injected.json`, under a lock every window takes, records for each folder what was
  written (a hash, and the person's file it replaced), the folders made, the exclude lines, and the
  windows holding it - a window holds while open and for a minute after it closed, for a reload.
- Once no window holds a folder, each file is taken back: as it was before, byte for byte, where
  nothing changed; a JSON file the person changed meanwhile keeps their change and loses Facade's
  part, an agent started there after the change taking it for theirs without that part; one with
  nothing of Facade's left is left, the person's old content kept in `~/.facade/kept/` and the person
  told. A folder a process still has in use is removed later.

### 1.8 The record

`~/.facade/workspaces/<first folder's name>-<12 hex of its path's hash>/`, kept for a workspace
whose folders move while its agents run:

```
ledger.jsonl       the events, one JSON line each: { v: 3, seq, time, type, ... }; a parent or a
                   maker left out is the person
                   agent.started   id name parent? cli model effort worktree folder taskFile? tokenHash
                   agent.running   id          task.typed  id
                   agent.exited    id kind reason
                   worktree.made   name folder repository parentWorktree madeBy?
                   worktree.gone   folder
ledger.lock        the window that has the agents: its process id and a mark of its own, touched
                   every 30 s; once it closed them as it went, "closed", the id its workspace keeps and
                   the id of the window's load; once Facade let go of them, the window staying - turned
                   off, a start that failed, a write the disk refused - "released" and those ids
you.token          the person's token
last-id            the highest number given, which a ledger begun anew counts on from; an older
                   Facade's last-pid where there is none
runs/<number>.*    an agent's token, task and launch files: gone once it exits
window.json        the pipe the window listens on
window-state.json  the pipe's id, and the process ids of the agents' terminals
```

The state is what replaying the ledger gives. A ledger another version wrote is moved aside and a new
one begins, its numbers counting on from `last-id`; a last line a crash cut short is dropped, and an
event the disk took only part of is cut back; any other line that cannot be read, or that does not fit
those before it, stops the window from loading the agents, and says which. A lock untouched for 90 s
is another window's to take: the window that stood still that long writes nothing more, lets go of the
agents and tells the person. A closed or released lock is its workspace's window's to take back at
once, as it reloads or turns Facade on again, and another window's once it is a minute old. A window that finds the lock held waits while
the window before lets go of it, then while nobody touches it - its window ended, and its process id
is another program's now - until it may take it over; a lock touched again is a running window's, and
the window says so and starts nothing.

### 1.9 Settings

Everything a launch gives a CLI is the person's to change, so that a CLI that changes can be followed
without a new Facade. Ten settings: shown to everyone, the switch and where each CLI is; for whoever
asks for advanced settings, the timeout and each CLI's launch.

```
facade.orchestration.enabled         whether Facade runs agents: on by default
facade.orchestration.timeout         seconds, 120 by default: how long a new agent has to come up, how long
                              an agent's MCP server waits for the window, and how long a window that
                              reloads waits for the pipe its running agents call
facade.orchestration.<cli>.path      the file to start, or a command PATH finds; empty: the CLI's command on
                              PATH
facade.orchestration.<cli>.launch    what the person changes of how Facade starts the CLI: empty by default
```

`<cli>` is one of `claude`, `codex`, `antigravity`, `muse`. A launch holds only the person's changes,
over Facade's own (1.5): VS Code copies an object setting's default whole into settings.json the first
time the person edits it there, and a launch Facade fixed in a later version would then never reach
them. So, as `workbench.colorCustomizations` holds only what is changed over a theme, a launch is empty
by default; completion in settings.json fills in Facade's own value of a part, or of a group of
arguments, as the person picks it; and **Facade: Show Agent Launch** shows, read-only, what each CLI is
started with now - its program, its launch, and the person's changes - following the settings as they
change.

```
arguments     the groups, in this order: warmUp, connect, quiet, fullAccess, model, effort, extra
              (the person's own), task (where the task is an argument); a group the person sets
              replaces Facade's, null leaves it out
environment   what Facade sets in its environment, variable by variable; null takes one of Facade's out
trust         what Facade does in a worktree it made (1.6): { arguments } for the launch, or { file,
              merge } merged into the CLI's file; a file or an entry the person sets replaces
              Facade's, and null gives no trust - the CLI asks
settings      Claude Code's settings for each launch, key by key down through objects; null takes one
              of Facade's out
enterDelay    ms between typing a line into its terminal and pressing Enter, at most a minute
taskDelay     ms after its MCP server's hello before its task line is typed, at most a minute
```

In an argument, `${name}` stands for a value of the launch: `${model}`, `${effort}`, `${task}`; Claude
Code's run files `${mcpConfig}`, `${settingsFile}`, `${pluginDir}`; Codex's `${mcpCommand}`,
`${mcpArgs}`, `${mcpEnv}` and `${folder}`, in TOML. In a trust's file and entry: `${home}`, and what the
CLI names - Claude Code's `${configFile}` and `${repository}`, Antigravity's `${folder}`. A `${name}`
with no value refuses the spawn before anything is made, naming the setting; a value not of its part's
kind counts as unset. Each setting is read at each use, so a change applies to the next launch, and
belongs to the machine, never to a workspace. Where Facade's files go, and how an agent's token
reaches its MCP server, are not settings.

### 1.10 Acceptance

This chapter is done when each case below holds in a development window built from its branch, on
a test workspace - a repository `lab` and a folder `notes` - run as the person runs it: driven from
inside the window and through the pipe, as @you or as an agent, with the four CLIs on real models.
A case is seen where the person and the agents would see it - the screen, the terminals' text, ps,
the processes and the disk - and holds when those agree. What is Facade's own - the ledger's
replay, the merging of files, the reading of settings - is the unit tests', with mutants; the cases
are where Facade meets what it does not control: VS Code, the CLIs, git and the operating system. A
case marked *seen* is the person's to judge as well, on its screenshots or live.

**Starting agents**

1. The person's Start Agent of Claude Code in `lab`: its terminal comes up in front, focused, and
   takes what the person types; Facade asks nothing, and Claude Code's own question, whether to
   trust the person's folder, is the person's to answer; ps has it as the person's child, on the
   model and the effort given. *Seen.*
2. The lead spawns a child in a new worktree: the window does not move and the focus stays; the
   worktree's row, not joined to the workspace, shows the child, and the agent list has it under
   that row; the child asks nothing and opens with `[facade] You are @...`; the ledger has
   `worktree.made`, `agent.started` and `agent.running`, in that order.
3. The lead spawns a child in its own folder, the one on screen: the child's tab opens behind the
   one in front, and what the person types meanwhile goes on where it went. *Seen.*
4. The lead spawns a child into a worktree of its repository, by name.
5. A child, asked to, spawns a child of its own, lists them and kills it: three generations in ps.
6. Claude Code spawned into a new worktree: it trusts the worktree without asking; its task reaches
   it as its argument; its status line shows the model and the effort given; ps lists it; kill
   ends it.
7. Codex, as Claude Code in 6, with Facade's files in its folder and their `info/exclude` lines,
   which kill takes back.
8. Muse Code, as Codex in 7, its task typed.
9. Antigravity, as Muse Code in 8, its task typed after its warm-up turn.

**ps and kill**

10. ps in the caller's view - itself, its parent, its children, exited and adopted ones too - and
    with `all`: each row as the ledger, the screen and the CLIs' processes have it, each agent by
    the number its tab's title has.
11. kill by number, #7 or 7; by @name; as Facade writes it, @name #7, and with a name not that
    number's (`INVALID`); by a name two running agents share (`INVALID`); of an agent not the
    caller's child (`REFUSED`); of @you (`REFUSED`); of none (`NOT_FOUND`); of one that exited,
    saying how; and the person's kill of any: its terminal, its row's logo, its run files and the
    files put into its folder go.
12. An agent with running children killed: they are the person's, with no parent's number in ps,
    and the person is told, a Show Terminal taking them to one. *Seen.*

**Wrong calls**

13. A spawn of each kind refused before anything is made: a CLI not on PATH, no model or no effort,
    a bad or a reserved name, "new" without a name, an argument spawn does not take, a worktree
    that is not there, a folder with no repository, a repository with no commit, a `${name}` the
    launch cannot fill.

**Ends and failures**

14. An agent of the person's exits by itself in a tab on screen: exited, its exit code said where it
    is not 0; the person is told; its tab goes.
15. The person closes an agent's tab: killed, by the person, and nothing told.
16. A CLI that ends as it starts, given an option it does not take: spawn fails at once, with the
    exit code.
17. A CLI that never connects, the timeout set short: spawn fails once it is over, and the parent
    waits until then.
18. The person's Start Agent of a CLI that cannot start: its own error alone tells them.
19. A spawn into a worktree git still lists whose folder is gone, or left empty: refused before
    anything is made (`NOT_FOUND`), as one that is not there. A terminal that cannot start, opened for
    the folder on screen: its tab goes without a word, as VS Code's own does in the editor area.

**Folders and worktrees**

20. The folder on screen removed with an agent in it: the question says the agent will stop; it
    does, killed by the person, and no tab of it is left. *Seen.*
21. Another folder removed, its worktrees holding agents, joined to the workspace and not: each
    stops.
22. A folder with no agent removed: asked as always. One with agents removed once the question is
    turned off: nothing asked, and they stop.
23. A worktree an agent works in, deleted with Delete Worktree: the question says something runs in
    it and will be stopped; the agent stops, killed by the person, and the worktree and its row go.
    One removed with git in a terminal: its row goes, and the agent stops - on Windows too, where git
    cannot delete the folder the agent is in: it deletes what is in it, asks whether to try again,
    and told no leaves the folder empty. One joined to the workspace, removed so: its agent stops,
    and the folder stays in the workspace, as VS Code leaves a folder that is gone.
24. Going to another folder and back: the agents' terminals are where they were, their processes
    the same. *Seen.*
25. Two spawns into new worktrees of one repository at once, a New Worktree of the person's between
    them: each is made, one after another. A spawn into a new worktree while the person is on
    another folder: the window stays there.

**The window**

26. A reload, with agents in the folder on screen, in another folder and in a worktree not joined:
    all running, where they were, under their titles - a title Claude Code sets itself put back -
    however long, up to a minute, the window takes to give their terminals back. One whose CLI ended
    while the window reloaded: exited, by itself, and the person is told.
27. A reload just after a spawn, before its child said hello: the child comes up.
28. Facade quit and started again: the agents were killed by the person, and nothing is told; the
    rows stay; the files put into folders are taken back.
29. A crash, the app's process ended: the agents exited, and the person is told once of each child
    of theirs.
30. A second window on the workspace: it says another window has its agents, and starts none; once
    the first has closed, a reload takes them.

**Settings**

31. `facade.orchestration.enabled` turned off: Start Agent is not offered, and an agent's tools say
    Facade is not there; turned on, all is back, and an agent whose CLI ended meanwhile exited by
    itself, the person told. *Seen.*
32. A launch changed - a group of arguments replaced, one set to null, a variable added, trust set
    to null: the next agent starts so, given no trust by Facade - none on its command line, none
    written for it - so that its CLI asks wherever it does not trust the folder already, as
    Antigravity does in a new worktree; Show Agent Launch follows; the settings read as they mean.
    *Seen.*
33. `facade.terminal.followFolder` turned off: a child's terminal opens in the panel, without taking
    the focus, and the child is on its folder's row; a terminal in the editor area - an agent's come
    back with a reload, an idle shell - stays on screen as the window moves between folders and onto a
    worktree's row and back, one tab of it, its process running. The child's folder taken out of the
    workspace, it stops. Turned on again, each goes back to the folder it was opened in.

Left to the unit tests: what a live window cannot time - a terminal opened while the folder
switches, one coming back halfway through a restore, a lock handed over - and what touches nothing
outside Facade: a ledger's broken or cut lines, a CLI writing its file between Facade's read and its
write, npm's shims and cmd.exe's quoting, macOS and Linux paths, the workbench commands' arguments.
