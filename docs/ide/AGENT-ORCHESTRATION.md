# Agent Orchestration

An agent can start, find and stop other agents in every Facade Code workspace on the
machine.
It can place a child in an existing checkout or create a worktree for it. These
operations use the same terminal and worktree services as the person's actions,
without opening confirmation dialogs. Background operations preserve the person's
view except for cleanup and view fallback when deleting a worktree under O5, in
the deleting workspace and in any other that showed the worktree.

This specification owns the three management tools and the shared contract used
by all eight tools. [AGENT-LAUNCHER.md](AGENT-LAUNCHER.md) owns identity, launch
configuration, YOLO and lifetime. [AGENT-MESSAGES.md](AGENT-MESSAGES.md) owns tasks
and mailboxes. [AGENT-DEBUGGING.md](AGENT-DEBUGGING.md) owns screen and input tools.
The four documents describe one final behavior, not successive overrides.

# Part 1: Specification

## O1. Reach and behavior

The caller is an agent, or a script authenticated as `@human`.

An agent uses the YOLO mode it received at launch:

- YOLO on: all agents in every workspace on the machine.
- YOLO off: its tree, including ancestors, descendants, siblings and ended runs,
  in whichever workspace each runs.
- `@human`: every agent in every workspace on the machine.

A workspace is one Facade Code window with at least one folder open: one window, one
workspace (AGENT-LAUNCHER.md L2). A window with no folder is no workspace, except one
whose last folder left while its runs were live: it stays their workspace until it
closes, and a reload keeps it one while any of them still runs (WORKSPACE.md W9.6). The
machine means the open workspaces of this Facade version - the same version and
commit - that keep their records under the same Facade home, `~/.facade` (O8),
whichever user data directory and application instance opened them. A workspace of
another version is not part of it: it neither sees nor is seen. A run belongs to the
workspace that started it - its terminal, record and lifetime stay there - and is
reached from another workspace through its own (O8). A child starts in a workspace
that has its folder (O3), so a tree may span workspaces. No workspace can be kept
out of the machine's reach; that is deliberate.

The machine is one virtual window: every rule that held inside one window holds
across it, and the workspace says where a run is, never what a caller may do. YOLO
is the one permission boundary: YOLO off keeps a caller inside its tree. The
workspace is a default view, not a wall: `list_agents` without all lists the
caller's own workspace, and all lists the machine (O6).

Settings belong to an application instance: two instances - two user data
directories - may differ in worktree management, the framework switch, YOLO,
the timeout and configured CLIs. A workspace applies its own, except where O3 and
O8 name the caller's.

Every child inherits its creator's mode. A human-created run uses the current
setting. There is no per-call override that lets a child acquire a broader mode.
The tree root is stored with each run and remains meaningful after a creator ends.

All eight Facade tools follow L4's approval policy. No tool opens a confirmation
dialog. Calls that cannot proceed explain the reason and the next available step.

Starting or manipulating an agent in the background must not activate a terminal,
select a folder, move an editor, add a folder to the workspace or bring a window
forward, in the caller's workspace or the target's, except for O5's deletion
cleanup and view fallback, and WORKTREE.md WT-3.8 in another workspace that showed
the deleted worktree. A newly created worktree appears in the workspace bar while
worktree management is enabled (WORKTREE.md WT-9); selecting it is the person's
decision.

Creator relationships describe provenance and supply a default communication path.
They do not impose a staffing algorithm, automatically reparent orphans, or require
a particular Git workflow. Within its reach, an agent can operate on a sibling,
an ancestor, itself or a human-created root.

## O2. Shared arguments, references and results

The canonical agent reference is `#a7`. Tools also accept `a7`, `#7`, `7`,
`@name` and `@name #a7`, and an agent of another workspace as Facade writes it,
`@name #a7 (workspace lab)`. Resolve a name only when exactly one non-ended agent in
the caller's reach has it. An ended agent is addressed by number. A name with only
ended matches returns their numbers so the caller can choose one.

Numbers are unique on the machine (AGENT-LAUNCHER.md L2), so `#a7` names one run
whichever workspace it is in. A name is resolved across the whole reach: two
workspaces each running an `@claude` make `@claude` ambiguous, and the refusal lists
each candidate with its number and workspace, so the caller can use the number. A
number no higher than the machine's shared mark (L12) may be held by two records;
it is ambiguous in the same way when two workspaces hold it. Facade writes an agent
of another workspace with its workspace's name and the start of its record id,
`@lint #a7 (workspace lab, 1a2b3c4d)`, which no other workspace shares, whatever
parentheses the name holds. A reference that ends in its workspace - by its name,
the start of its record id, both so, or its label - matches that workspace's agents
alone, so the form Facade writes picks one run wherever two records hold its number;
where that workspace has no such agent, it is not found, never taken for one of this
workspace's. A refusal of an ambiguous reference writes each candidate in that form,
for the caller to pass as written.

A workspace is named in arguments by its name, the start of its record id, both as
Facade writes them after a reference (`lab, 1a2b3c4d`), or its label; and in results
by its name, its first folder and the start of its record id. A name whose
parentheses do not pair, or with a character cmd.exe reads as its own - `"`, `%`,
`^`, `&`, `|`, `<`, `>` or `!`, which a first line on a command line could not carry
(AGENT-LAUNCHER.md L10) - is written by the start of its record id alone. A name or
prefix that matches several workspaces is refused, listing each.

Reject an ambiguous reference rather than guessing. In a combined name/number,
both must identify the same run. A bare numeric-looking reference that could also
be an active name is ambiguous. `#m7` is a message, not an agent. `@human` is a
valid communication endpoint but is not a target of management or debugging tools.

Validate the whole request before applying its effects. Unknown arguments,
incorrect types and invalid enum/range values are errors. Optional arguments have
the documented default; an explicitly empty required string is not an omission.

Each tool returns human-readable text and the same facts as structured data.
Text must be sufficient for a model to decide what to do next without interpreting
an opaque code or reading hidden logs.

| Error code | Meaning |
| --- | --- |
| `INVALID` | Arguments cannot describe a valid operation |
| `NOT_FOUND` | The requested agent, folder or message cannot be found |
| `REFUSED` | The object exists but scope, state or capability prevents this operation |
| `UNAVAILABLE` | A required service, executable, connection, terminal or workspace is unavailable |
| `FAILED` | An accepted operation failed |

Errors include a specific explanation and a recovery action. If effects may already
have occurred, include the known agent id and `outcome: "unknown"` or
`outcome: "pending"`, plus the current phase and any resources created.
Do not describe a timed-out accepted call as if nothing happened.

## O3. Starting an agent

```text
start_agent(name, cli, model?, effort?, task?, folder?, new_worktree?, workspace?)
```

| Argument | Contract |
| --- | --- |
| name | Required; follows L2. Also the branch name when creating a worktree |
| cli | Required; claude, codex, muse, agy, qwen, or a configured custom name |
| model | Optional; omitted uses the CLI's own default |
| effort | Optional; omitted uses the CLI's own default |
| task | Optional nonempty text; becomes a message under M7 |
| folder | Optional absolute path of a folder of a workspace on the machine, or an unambiguous branch of the caller's repository; with worktree management off, a folder or recorded launch folder of that workspace |
| new_worktree | Boolean, false by default |
| workspace | Optional; the workspace to start in, by its name or the start of its record id (O2). It must have `folder`, or the caller's own folder when none is given |

A missing folder means the caller's registered launch folder. For `@human`, it
means the selected local folder. The CLI changing its own working directory does
not change the run's registered folder.

While worktree management is on, an agent's child works in a main checkout or a
worktree Facade made (WORKTREE.md WT-1.3): its creator's own when no folder is given
and that is one, another by path or branch - several agents share one as freely as
one - or a new worktree with new_worktree. A folder outside Git and another tool's
worktree are refused before anything is allocated, naming new_worktree and the
workspace's main checkouts and Facade's worktrees. This is where the child is
placed, not what it may reach: with YOLO on it reads and writes any folder, as its
CLI does. The person's own start may use any folder of a workspace.

An absolute folder must be a folder of a workspace or a worktree shown on its
workspace bar: one Facade made of a repository there, or a repository's main
checkout shown as its row (WORKTREE.md WT-1.6). With `workspace`, that workspace
starts the child, and one without the folder is refused, naming the workspaces that
have it. Without it, the caller's own workspace is looked in first: a folder it has
starts the child there, whatever other workspaces have it too. A folder it does not
have is looked for on the machine: one workspace that has it starts the child
there; several are refused, naming each, until `workspace` names one; none, and the
path is refused as no folder of a workspace. Branch shorthand is limited to the
caller's repository in its own workspace - its main checkout and Facade's worktrees;
another tool's worktree is a folder, which no branch names; the caller can pass the
path to start in another workspace. A detached worktree must be named by path. No
branch name, including `main` or `new`, has a special meaning. If a branch is
checked out in multiple worktrees, return the paths and ask the caller to select one.

The workspace that has the folder carries out the start (O8): its worktree
management switch, its admission checks, its configured CLIs, launch settings and
terminal environment, the worktree it creates and its setup, the terminal and the
run's record. A failure there names that workspace. The child's creator, YOLO and
tree are the caller's, wherever each runs, and so is the wait: the call's timeout
is the caller's workspace's.

With worktree management off in that workspace, ordinary starts can use its folders
and recorded launch folders; do not restart Git discovery to resolve a new worktree
path or branch shorthand (WORKTREE.md WT-9).

With new_worktree, apply WT-9's shared admission check before allocating a run,
creating a worktree or injecting configuration. Once accepted, create an additional
worktree of the chosen folder's repository on a new branch named name. Use the
caller checkout's current HEAD when it is the same repository; otherwise use the
target repository's main checkout HEAD.
Resolve the commit when accepting the request; for a start carried out in another
workspace, the caller's workspace resolves its own checkout's HEAD before forwarding
it. Uncommitted edits are not included.
A folder outside Git, an existing branch, an invalid Git branch name or a
repository without a commit is a clear rejection before creation. The caller can
choose another name or folder; Facade does not overwrite branches or silently
change the requested name.

Model and effort are passed through as values, without a maintained model whitelist.
An effort may be supplied without a model. A custom launch without a model/effort
group ignores that particular override with an explicit warning in the result;
the recorded applied value is unknown. Never report an ignored value as applied.

A custom agent without a connect group can be launched, listed, read and stopped,
but cannot receive Facade messages. A task requires both its connect group and its
task argument group. If either is missing, reject a tasked start before allocating
a run and explain the missing configuration. Starting it without a task is valid.
Do not accept a task into a mailbox that the custom agent cannot read.

The result is one of:

| Status | Meaning |
| --- | --- |
| started | Required connection completed, or a launch with no integration has a live process |
| unconfirmed | The accepted start has exceeded its wait budget; preparation or connection continues |
| failed | The start definitively failed or its process ended before readiness |

The result includes id, name, creator, CLI, applied/requested overrides, folder,
worktree, YOLO, effective sandbox, connection capability/state, phase and task
message id when present, and the child's workspace where it is not the caller's.
A start carried out in another workspace sends its id with its first progress line,
so a lost reply still reports it with `outcome: "unknown"`. An unconfirmed/failed result includes the available
diagnostic screen excerpt from D6, or setup/launch diagnostics if no agent terminal
exists. It names created resources and the next action.

Started does not mean the task has been fetched, the chosen model accepted a
request, or the task completed. M7 defines those distinctions. A late connection
finishes the original start, not another run. After an unconfirmed result, inspect
or stop that id; do not call start_agent again just to wait.

## O4. Worktree setup and partial starts

Use the existing New Worktree service, include-file copying and repository setup
configuration. The agent path adds background operation and a completion result;
it does not implement another Git/worktree subsystem.

Preparation phases exposed to the caller are validating, creating_worktree,
running_setup, launching_cli and connecting.

- Serialize Git creation and include-file copying for the same repository, across
  the machine: under a short lock per repository in the Facade home, as L12's
  counters are, so two workspaces never race for one worktree directory.
  Release that queue before a potentially long setup command.
- Associate the setup terminal with the new worktree and the accepted start.
  Keep it in the background. It remains an ordinary setup terminal, not an agent.
- With shell integration, wait for the configured setup lines to finish and
  retain their exit results. A known nonzero result fails the start before launching
  the CLI and returns the setup diagnostics and worktree path.
- Without shell integration, preserve the existing setup behavior: submit the lines,
  then proceed. Report setup as submitted with completion unknown, and include that
  fact in the child's startup context. Do not claim dependencies are ready.
- If setup has not finished by the call's timeout, return unconfirmed with phase
  running_setup. The original operation keeps waiting. A long-running setup does
  not block another worktree's creation or the UI.
- stop_agent can cancel a start in any phase. Stop its owned setup terminal if one
  exists, prevent later CLI creation, and retain its worktree unless deletion was
  requested. A Git operation already in flight may finish; record its actual result.

A definitive preparation failure retains a worktree and branch already created,
with their paths in the result. The creator can repair the folder with its own
tools and start a new run in that existing folder. Facade does not automatically
delete useful partial work or retry the launch.

## O5. Stopping and deleting

```text
stop_agent(agent, delete_worktree?, discard_changes?)
```

Both booleans default to false. discard_changes without delete_worktree is invalid.

Stopping targets exactly one run, unless deleting its worktree also requires ending
other runs in that folder. It may target a human-created agent, an ancestor or the
caller itself, subject to O1. Descendants in other folders continue.

Without worktree deletion, record the stop request, terminate the run's process
or cancel its pending start, and finish when it has ended. A stop already in progress
joins the existing operation. A stop of an ended run reports its recorded outcome.
It does not fail merely because the process is already gone.

With delete_worktree, apply WORKTREE.md WT-9's shared admission check before
stopping any run, including requests for main checkouts or non-Git folders.
For an additional worktree, use the shared Delete Worktree operation in WT-8;
that section owns the execution order. Do not stop agents ahead of that operation.

Its preflight checks the caller's reach over every live or starting agent that
would be stopped, before stopping any of them. Unless discard_changes is true,
refuse any loss of user work, including ignored files and unsaved editor content,
and leave all agents running. delete_worktree authorizes removal; discard_changes
authorizes discarding user content inside that worktree. WT-8.10 applies these
choices without a dialog. Return every stopped agent and the actual deletion
outcome, retaining the branch.

A worktree may be deleted while selected or included in the workspace, subject to
the same preflight above. If deletion removes the person's current worktree view,
switch to its owning folder's view. If that folder no longer exists, switch to
the previous folder. Otherwise keep the current folder selection.

Changes consisting solely of Facade's recorded configuration additions are not user
work. A file that was already dirty or has additional edits still is. Detect the
simple unchanged-owned-content case; ambiguous edits remain visible changes.

For a main checkout, a folder outside Git or a worktree Facade did not make, stop
the requested agent and report that no worktree was deleted. Never delete the main
checkout or another tool's worktree, which Facade takes for a folder (WORKTREE.md
WT-1.3); the workspace's shared deletion refuses that deletion step too, before
doing anything, while the stop this tool asked for still happens.

If stopping exceeds the timeout, return pending and do not delete the worktree.
Termination may continue, but deletion requires a later explicit stop_agent call
after that pending result. If a later loss check or deletion fails, report the
reason, remaining folder path and completed effects, including membership removal
and stopped agents. Do not imply that they were rolled back. A retry against the
ended agent can finish deletion.

No dialog appears for this tool: delete_worktree and discard_changes are explicit
choices in its arguments. Do not add an extra confirmation round.

For an agent of another workspace, that workspace carries out the whole call (O8):
its worktree management switch, its preflight, its deletion and its view fallback.
The caller's workspace does not move.

A worktree can be open in several workspaces and hold work of each. A deletion
treats the machine as one window: its preflight, confirmation and stopping cover
every workspace's work inside the directory, its subfolders included - live or
starting agents, terminals and setup terminals working there, and unsaved editors -
under the same rules as the deleting workspace's own. The caller's reach is checked
over every agent, whichever workspace runs it; an unsaved editor of another
workspace is a loss that discard_changes, or the person's Delete and Discard
Changes, authorizes like a local one. Each workspace stops and discards its own
authorized work at WT-8 step 6. WT-8 owns the order: the machine-wide question,
the deletion mark that holds new starts into the directory and a second deletion of
it in every workspace, and the recheck before removal. A workspace with its
framework off still answers, since the question protects the person's work, not
the agent tools. A workspace that does not answer within O8's short wait refuses
the deletion before anything is stopped, naming it. A workspace that only shows the
deleted worktree follows WT-3.8 afterwards, as its row is gone, without being
brought forward.

Self-stop and deletion of the caller's own worktree may disconnect its tool call
before a result reaches it. The record still reports the actual outcome.

## O6. Listing and discovery

```text
list_agents(all?)
```

The list is every run that both boundaries let through (O1): the caller's reach,
and, without all, the caller's own workspace - with all, every workspace on the
machine that answers.

| Caller | Without all | With all |
| --- | --- | --- |
| YOLO off | Its tree's runs in its own workspace | Its tree's runs in every workspace |
| YOLO on | Every run in its own workspace | Every run in every workspace |
| `@human` | Every run in its own workspace | Every run in every workspace |

Ended runs still in the current list are included. A reload keeps the list; an
ordinary fresh app start removes ended entries as L12 specifies. A workspace that
does not answer within O8's query limit - reloading, hung, its framework off - does
not fail or delay the list further: the result names it and why, and lists the
rest. A closed workspace's runs ended with it (AGENT-LAUNCHER.md L6) and are not
listed. Without all, the result also says how many of the caller's children run in
other workspaces, from its own workspace's record of them (O11), and that all lists
them.

Start the result with counts by lifecycle state and the caller's identity/scope,
its own workspace named once. Each row includes:

- Canonical number/name, creator and tree root, each with its workspace where that
  is not the row's.
- Its workspace - its name, its first folder and the start of its record id -
  where it is not the caller's.
- Lifecycle and current start/stop phase, if any.
- CLI; requested and applied model/effort, with unknown where not observable.
- Folder and branch/worktree label.
- YOLO, effective sandbox, whether it has Facade integration and whether it is connected.
- Start time, task message id and the mailbox summary defined in M3.
- End time, kind, actor, reason and exit code for an ended run.

Connection loss is visible without inventing an idle, busy or done state.
Completion is communicated by the agent, not inferred from a quiet terminal.

Include a compact available-CLI list with each id and whether its configured launch
supports Facade integration, a task, model and effort. This is launcher discovery,
not a model catalog or a ninth tool. Refresh it from current configuration and
executable detection. It is the caller's workspace's; with all, a workspace of
another application instance whose list differs adds its own, named, since a start
there uses that workspace's (O3).

A creator ending does not transfer its children to another owner. Children retain
their identity, tools and message history. M8 specifies how they seek help when
their creator is no longer available.

## O7. Instructions and framework switch

The MCP server instructions identify the caller, creator, tree, folder, its
workspace - name, first folder and the start of its record id - YOLO and available
tools. The Facade skill, where supported by the CLI, explains the same
contract with short examples. The first task notice identifies the run as M7 defines.

Technical guidance must explain:

- Facade-created children are separate CLI terminals, distinct from a CLI's internal
  subagents.
- With YOLO on, the reach is every workspace on the machine; `list_agents` lists
  the caller's own workspace unless all is set. start_agent starts a child in the
  workspace that has its folder, the caller's own first, or in the one `workspace`
  names. Names repeat across workspaces; refer to another workspace's agent by its
  number.
- send_message/read_messages are the normal communication path.
- Runs started through `start_agent`, including `@human` scripts, ask through
  messages and apply L4's supported question-tool suppressions. UI-started agents
  keep their normal CLI questions; M8 defines the escalation path.
- Tasks and ordinary messages may be retrieved again with the same number.
- Worktrees start at a commit; uncommitted changes are not copied.
- Facade-owned project configuration is temporary and should not be committed.
- Read the result before retrying a start, stop or terminal input.

Do not mandate commits, merges, a review hierarchy, automatic worktree deletion or
self-termination after a task. Those are workflow choices. A child normally reports
its result and ends its conversational turn while its CLI remains available.

When the framework is disabled, all eight tools return UNAVAILABLE with
framework_disabled, without waiting for the normal timeout. Operations accepted
before the switch changed retain their original launch snapshot and complete or
report their partial outcome. New calls have no effects. L13 owns re-enable behavior.

# Part 2: Technical Design

## O8. MCP transport and workbench boundary

Retain the existing architecture:

```text
agent CLI -- MCP over stdio --> shim.js -- HTTP over local pipe --> extension host
                                                                  contract -> core
                                                                            -> record
                                                                            -> host ports
```

Each CLI launches a small, stateless MCP shim using Facade's executable with
ELECTRON_RUN_AS_NODE=1. The extension owns all run state. The shim can reconnect
after the extension host or window reloads without restarting the agent.

The window writes its endpoint and enabled state into window.json. Use a named
pipe on Windows and a Unix-domain socket elsewhere, with no listening TCP port.
Requests are at most 1 MiB of encoded JSON. Responses carry progress followed by one
result/error, using the existing newline-delimited protocol.

Authenticate with a random per-run token, passed by token-file path. Revoke it when
the run ends. The person's scripts use the workspace's you.token and act as @human.
Tokens identify callers; YOLO and reach come from the record, not caller arguments.

On connection loss, reread window.json and retry connection once per second up to
the configured timeout. After that, return unavailable promptly and continue
discovery in the background. A successfully reconnected call resets the outage wait.

A call already forwarded to the window must not be automatically forwarded again.
If its reply is lost, report unknown and instruct the caller to inspect the record.
An accepted operation is not cancelled merely because its MCP client disappears.
Read-only calls can be repeated by the caller. M4 owns message retrieval retries;
D5 owns terminal-input uncertainty.

### Between workspaces

```text
agent in workspace A -- pipe --> A: authenticate, resolve, check reach
                                  |
                                  +-- local target --> core, as before
                                  +-- target in workspace B -- pipe, with the machine's key --> B: core
```

Each workspace keeps its own runs, record, terminals and doorbells. Nothing central
runs: no broker process, no shared run table, no election. What the machine shares
are files in the Facade home, each written under its own short lock or created
exclusively - the counters (L12), the key, the notice outbox, the chat rooms
(AGENT-MESSAGES.md M9) and the deletion marks (WORKTREE.md WT-8). An agent's shim
still talks only to its own workspace; launch configuration does not change. The
files below keep the names they have - window.json, window.key - as a workspace is
its window.

- **Finding workspaces.** Each workspace's window.json also carries Facade's
  version and commit, its name, its first folder, its record id, the identity of
  its window's current load and the identity of its application instance - the
  instance's main process id and start time. A workspace keeps its window.json
  through a reload or an extension host restart, marks it closing as its window
  closes and then removes it (L6). A build without a commit is the same version
  only as the very same build. A live workspace is a record whose window.json
  pipe answers with that record id and the same version and commit; a workspace of
  another version is passed over.
- **Gone or silent.** A workspace is gone when its window.json is removed or marked
  closing, or names an application instance that is no longer running: its window
  closed, or its app crashed. Any other workspace that does not answer is silent -
  reloading, restarting its extension host, recovering from a renderer crash, or
  hung - for as long as that lasts; silence alone never makes it gone. A gone
  workspace's runs ended with it (AGENT-LAUNCHER.md L6): they are not found, nothing
  is sent to them, and the workspaces that knew them say so (below).
- **Authenticating workspaces.** A workspace calls another with the machine's key, a
  random secret in the Facade home's `window.key` readable by the user only,
  created exclusively by the first workspace that needs it; one refused with the
  key it has reads the file again once. It is the same trust boundary as
  `you.token`: the user's own processes. An agent's token is never sent to another
  workspace. A workspace refuses a forwarded call whose caller claims to be one of
  its own runs. Queries a workspace makes for its own work - a deletion's question,
  a delivery's check - are made as that workspace, not as the agent behind them.
- **What crosses.** A request carries the caller's identity as its workspace knows
  it - number, name, its creator chain, tree root and the root's workspace, YOLO,
  `@human` or not, and its workspace - and one of three kinds:
  - Queries: the workspace's rows for list_agents, the caller's tree alone where its
    YOLO is off; a message by number, with its delivery state; the human mailbox;
    the workspace's folders; the work inside one directory (O5).
  - Calls: start_agent, for a folder of that workspace (O3); send_message's delivery
    to one recipient, a task among them (M7); read_screen, type_text, press_keys
    and stop_agent, for a target already resolved to its number; a deletion's
    stopping of its authorized work (WT-8 step 6); showing a message to @human in
    the workspace M9 names, and revealing an agent's terminal for the person's Show.
  - Notices: a Facade notice for one of the workspace's agents - a return, a delay,
    a child's end or its unfetched task (M6, M8), or the end of a workspace (below).

  The target's workspace checks reach again from the identity it was given and runs
  the call in its own core, as for one of its own agents: a caller with YOLO off
  reaches the runs of its own tree there, its tree known by the root's number and
  the root's workspace together. Its progress lines and result return unchanged. A
  query not answered within three seconds counts as silent; a call ends by its own
  rules and the caller's timeout, which the request carries. A request may exceed
  the 1 MiB call limit by the identity it adds.
- **Notices travel by file.** A notice is written as one file into the Facade home's
  outbox for the target workspace's record, named by a key - its kind, its subject's
  number and the workspace that raised it - and the target is rung through its pipe
  if it answers. A workspace takes its notices when rung, as its window loads and
  once a minute, records each key once and then removes the file, so a notice
  written twice or taken after a reload is recorded once. Nothing is lost while the
  target is silent or reloading, or the sender closes first. A notice for an agent
  that has ended is recorded as not delivered, as M6 records an unreturnable message.
- **Files for the caller.** A file a result hands to the caller - a large screen
  snapshot, a final screen, a long message read by number - lies under the caller's
  own workspace's record, so its CLI reads it with the access its launch gave
  (AGENT-MESSAGES.md M4, AGENT-DEBUGGING.md D1). The caller's workspace copies the
  target workspace's file there before returning the result.
- **Resolving.** The caller's workspace resolves a reference against its own runs
  and the rows of every live workspace in its reach (O2), then sends the call, with
  the resolved number, to the workspace that owns the target. A number above the
  machine's shared mark (L12), in any of the forms `#a7`, `a7`, `#7`, `7` or
  `@name #a7` that cannot be a name, found in any workspace that answers, is settled
  there: it cannot be held elsewhere. Any other reference may be held or used as a
  name in a silent workspace, so a silent workspace is waited for briefly - a reload
  takes seconds - for up to ten seconds; then the call is refused as `UNAVAILABLE`,
  naming it and the way round: the number, or the reference ending in its workspace
  (O2), for which only that workspace is asked.
- **Outage.** A call to a resolved target in a silent workspace - before that
  workspace accepts it - is tried again once a second, up to the call's timeout,
  then is `UNAVAILABLE`, naming the workspace and the reason. Finding a folder or
  checking a recipient in a silent workspace waits as resolving does. A gone
  workspace and one with its framework off are not waited for. A request the target
  workspace may have accepted is never sent again automatically: a lost reply is
  `outcome: "unknown"`, as above; notices are files, which are safe to write again.
  A workspace with its framework off answers that it is off: its agents and folders
  are no candidates, a call to one is `UNAVAILABLE` with framework_disabled, and its
  notices wait in its outbox for re-enable, as M10 keeps its own. Its answer to a
  deletion's question and its stopping of that deletion's work (O5) do not depend
  on either workspace's framework switch, since they protect the person's work, not
  the agent tools.
- **When a workspace is gone or stays silent.** A workspace keeps, for each of its
  agents, the children it started in other workspaces (O11) and the messages it
  sent there that are not yet settled. When it finds such a workspace gone without
  the notices that close would bring - its app crashed - it tells each affected
  agent, as a Facade notice: which children ended with that workspace, and which
  messages to it may never have been fetched. A workspace silent for longer than
  the timeout brings each affected agent one notice saying so, as a fact, not an
  end. When the crashed workspace opens again it records its ends as L6 says; the
  notices it would send carry the same keys as the survivors' facts and add only
  what they did not say.
- **Foreign parties in the record.** A workspace records an agent of another
  workspace - a creator, an ancestor, a tree root, a sender, a recipient, a stop's
  actor, a notice's subject, a child started there - by number, name and workspace.
  A number another workspace gave need only be unused in the record; it may be
  lower than numbers the record already holds (L12).
- **Isolated tests.** `FACADE_HOME`, when set to an absolute path in Facade's
  environment, replaces `~/.facade` as the Facade home for the records, worktrees,
  counters, key, outbox, chat rooms and deletion marks; the workbench and the
  extension read the same variable. The injected-file record stays at
  `~/.facade/injected.json`, since it describes the person's own files, which test
  and personal workspaces may share (O10). Workspaces under different homes do not
  see each other. It exists so a test workspace can run beside the person's own; it
  has no setting and no UI.

The internal workbench surface extends L8 with:

| Operation | Required behavior |
| --- | --- |
| _facade.worktree.create | Existing worktree flow with explicit commit, background setup, phase/result reporting and cancellation |
| _facade.worktree.delete | Existing delete flow with explicit discard choice and no picker/dialog |
| _facade.terminal.type | Send to the registered run's current process, with paste/Enter policy and an effect result |
| _facade.work.in | The workspace's terminals, setup terminals and unsaved editors inside one directory, for a deletion's question (O5) |
| _facade.work.release | Stop those terminals and discard those editors, as a deletion authorized them (WT-8 step 6) |
| _facade.window.reveal | Show one registered run's terminal and bring the window forward, for the person's Show (M9) |

The workbench calls the extension's:

| Operation | Required behavior |
| --- | --- |
| _facade.agents.windowClosing | Once the window's shutdown can no longer be vetoed, its reason: closing, quitting, replacing its workspace or reloading. The workbench waits for it, and stops the extension host only afterwards; closing work ends its runs and sends its notices then (L6) |
| _facade.agents.workIn | Ask every other workspace of the machine for its work inside one directory: agents, terminals, setup terminals and unsaved editors, by workspace (O5, WORKTREE.md WT-8) |
| _facade.agents.workMark | Place the directory's deletion mark, or remove it as the deletion settles (WT-8) |
| _facade.agents.workRelease | Have every workspace holding authorized work inside the directory stop and discard it (WT-8 step 6) |

D8 owns terminal reading, keys and the shared input queue. M10 owns the notification
operations. Use the same workbench service for human and agent worktree operations;
background behavior is an explicit option, not a duplicate implementation.

## O9. Launch sequence and connection configuration

Start in this order:

1. Validate caller, scope, configuration, model/effort encoding, folder, branch and
   known integration-file conflicts. Snapshot HEAD and launch settings.
2. Allocate an id and record agent.started. Persist the plan and token. If there is
   a task, record its message now under M7.
3. Create the worktree and run setup under O4 when requested.
4. Prepare CLI trust and project integration; write per-run launch files.
5. Recheck cancellation, create/register the terminal behind the foreground tab,
   and record agent.launched with its process identity.
6. On authenticated MCP hello, record connected and running. Without integration,
   record running when the process launches.
7. Return started, or the unconfirmed/failed outcome defined in O3. Message fetching
   is independent and may occur after the result.

The configured timeout bounds the call's wait from acceptance, not each phase
separately. It does not prove the process failed. A start cancelled before terminal
creation must never later create that terminal. Check cancellation at phase
boundaries; do not require rollback of a completed Git creation.

Provide these connection placeholders to launch configuration in addition to L9:

| Placeholder | Value |
| --- | --- |
| `${executable}` | Facade executable used as the Node host |
| `${shimFile}` | Installed shim entry point |
| `${recordDir}` | This workspace's record directory |
| `${tokenFile}` | The run's credential file |
| `${waitMs}` | The launch's connection wait budget in milliseconds |

For a CLI that reads shared project MCP configuration, use one identical
`shim.js mcp --agent` entry and resolve FACADE_AGENTS_RECORD, FACADE_AGENTS_TOKEN
and FACADE_AGENTS_WAIT_MS from each process's environment. FACADE_AGENTS_TOKEN is
a path, not a token value. Without those variables, a manually launched CLI gets
no Facade tools and no startup noise.

Keep existing per-CLI startup methods: launch arguments for Claude Code/Codex/Qwen Code,
project configuration where required by Muse Code/Antigravity, and Antigravity's
warm-up. Do not add hook delivery, native conversation APIs or per-vendor message
queues. Launch settings and terminal timing are the only vendor-specific inputs
to the messaging path.

## O10. Project integration ownership

Prefer arguments and per-run files. Write into a project only when its CLI requires
MCP/plugin or skill discovery there.

An existing tracked configuration file is not, by itself, a reason to refuse launch.
Merge a distinct Facade-owned server/plugin entry alongside existing content.
It may temporarily appear in git diff. Do not conceal a tracked change using index
flags, and do not alter unrelated keys.

Keep the implementation local and explicit:

1. Validate that the format can be merged and that Facade's intended key/path is
   either absent or already owned with identical content. An unrelated conflicting
   entry produces a named configuration error.
2. Under a short local mutation lock, record the original content and the exact
   entries/files Facade will own, then write the changes atomically where possible.
3. Register each run using that content. Compatible runs in one folder share it.
4. When the last using run definitely ends, remove only unchanged Facade-owned
   entries/files. Restore an otherwise untouched file byte-for-byte.
5. Preserve edits to other fields. If someone changed Facade's own entry or a
   nonmergeable file, leave that content and retain its backup with one diagnostic.

Use the existing injected-file record under ~/.facade for cross-window ownership
of a shared folder. It needs original content, applied content, owned keys/paths and
using run identities. No time-based lease or distributed transaction protocol is
required. A simple incomplete-write marker supports rollback after an interrupted
file update; recovery never overwrites a user's subsequent edit.

Generated untracked files should stay out of ordinary git status where a narrow
ignore entry can do so without hiding unrelated user content. Existing files are
never hidden by a broad directory ignore. If a safe narrow ignore is unavailable,
leave the change visible and identify it as Facade-owned. Do not scan or redesign
every other worktree's configuration just to guarantee a pristine status.

Reload, framework off and elapsed time do not release files still used by a run.
A cleanup failure is logged and retried on normal reconciliation. It does not stop
unrelated agents or turn a successful task into a failure.

## O11. Minimal record additions

Alongside L12's lifecycle fields, retain:

- creator and tree root, immutable for each run;
- requested/applied launch overrides, YOLO, effective sandbox and integration capability;
- current preparation phase and setup outcome;
- token identity, connection state and the task message id;
- worktrees created by a run, including folder, repository, branch and base commit;
- stop actor/reason and worktree-removal results;
- a creator, tree root, actor or party of another workspace by number, name and
  workspace (O8); for a run whose creator is of another workspace, the creator's
  chain of ancestors as that workspace gave it, so M8's nearest available ancestor
  can still be found when a workspace between them closes;
- each child a run started in another workspace, by number, name and workspace,
  recorded once its id is known, with its end once a notice tells it (O8).

The ledger records worktree creation/removal and connection events. The run plan
contains resolved arguments, explicitly set environment and timing. Do not expose
credentials in tool results or the human-readable log.

After reload, reconcile the process before deciding what to resume. A surviving
process is reattached, not relaunched. A definitely absent pre-launch run is failed,
with retained resources reported. A pending task remains a message; there is no
second task-text injection path to recover.

# Part 3: Acceptance

## O12. Management acceptance matrix

Use L14's evidence requirements and its U/I/V/H test modes. The fixture contains
two repositories with commits, additional and detached worktrees, a non-Git folder,
two agent trees and a configurable fake CLI.

| ID | Scenario | Required outcome | Mode |
| --- | --- | --- | --- |
| OR-01 | All eight tool descriptions and schemas | Exact documented names, required arguments and actionable errors | U,I,V |
| OR-02 | Canonical/alias references, duplicate names, ended names, mismatched kind/name | Deterministic resolution; no guessed target; ended ids remain usable | U,I |
| OR-03 | Default and all lists for agent and @human | Correct membership, counts, creator/tree and launcher capabilities | U,I |
| OR-04 | Start each built-in with omitted model/effort and with explicit values | CLI defaults when omitted; correct encoding and recorded applied values | U,V |
| OR-05 | Start without task, then message it | Interactive prompt followed by working message reception | V,H |
| OR-06 | Child/grandchild, then change global YOLO | Both existing and later descendants retain inherited mode across reload | U,I,V |
| OR-07 | Two trees, each mode, ended ancestors | Scope enforced on every management target; on can reach off; off cannot leave its tree | U,I |
| OR-08 | Background start in current folder and another folder | Correct association; no focus, tab or selected-folder change | I,V,H |
| OR-09 | New worktree from same repository and another repository | Correct accepted HEAD, branch, include files, row and child folder | I,V |
| OR-10 | Detached/ambiguous branch, missing folder/CLI, disabled CLI, bad configuration, existing branch, no commit | Clear rejection before allocation/creation where checkable | U,I |
| OR-11 | Two worktree starts plus human creation | Git creation serialized; setup does not hold the repository creation queue | I |
| OR-12 | Setup success, known failure, no shell integration and long-running setup | O4's distinct outcomes; diagnostics available; no false readiness claim | I,V |
| OR-13 | Cancel a start during creation, setup and connection | No late unrequested CLI; setup stopped; completed resources accurately reported | I |
| OR-14 | Early exit, delayed connection and connection after timeout | Failed/unconfirmed/late-start outcomes agree with process, screen and ledger | I,V |
| OR-15 | Reply lost after accepted start | No automatic second launch; caller finds the original through list_agents | I |
| OR-16 | Custom agent with/without connect/task/model/effort groups | Capability-aware behavior; impossible task rejected; ignored overrides reported | U,I,V |
| OR-17 | Stop child, sibling, root, ancestor, self and already-ended run | Correct reach and actor; only specified processes stop | I,V |
| OR-18 | Delete worktree containing several agents, including an out-of-scope run | Whole preflight; out-of-scope rejection stops nothing | I |
| OR-19 | Dirty files, ignored files, unsaved editor, owned configuration; discard off/on; new loss after stopping | Preflight refusal stops/discards nothing; only authorized content is discarded; late refusal reports completed effects; branch retained | I,V |
| OR-20 | Main checkout deletion requested | Requested agent stopped; main checkout retained and result explains it | I |
| OR-21 | Slow termination and filesystem deletion failure | Pending/error reports real remaining work; retry can finish deletion | I,V |
| OR-22 | Project configuration absent, tracked, untracked, already dirty or conflicting | Merge only owned content; preserve user content; useful conflict error | U,I |
| OR-23 | Two compatible runs share configuration; user edits it; final run ends | Shared ownership; no premature removal; user's edits survive cleanup | U,I |
| OR-24 | Interrupted injection/cleanup; reload; framework off | Recovery preserves live ownership and later edits; no silent overwrite | U,I |
| OR-25 | Disabled framework, invalid/revoked token, pipe outage and reconnect | Prompt correct error; no unauthorized mutation or replay | I,V |
| OR-26 | Parent ends before child, or caller disappears during start | Child ownership remains; accepted work has one recorded outcome | I,V |
| OR-27 | Delete the selected worktree, including one added to the workspace; owning folder present/absent; fail the fallback or membership edit | WT-8 orders the shared operation; view returns to the owning folder, or the previous folder if it is gone; failed prerequisites preserve processes and dirty contents | I,H |
| OR-28 | Worktree management off: request new_worktree or delete_worktree, including deletion for a main checkout; ordinary start/stop in a known folder | WT-9 rejects the whole worktree request before allocation, injection or stopping; ordinary start/stop and discovery of live agents remain available | U,I |
| OR-29 | With worktree management on, an agent starts a child with no folder from a main checkout, a plain folder, another tool's worktree added to the workspace and a worktree Facade made; by path in each of those; by branch, `main` included; with new_worktree from each; the person starts in each folder | The child starts in its creator's main checkout or Facade's worktree, or the one named, the main checkout included; the plain folder and another tool's worktree are refused before allocation, naming new_worktree and the workspace's main checkouts and Facade's worktrees; new_worktree works from the main checkout and Facade's worktree, and from the plain folder is refused with the reason; the person's starts go where asked | U,I,V |
| OR-30 | stop_agent with delete_worktree on an agent in another tool's worktree; the workspace's deletion command called for it | The agent stopped, nothing deleted, the reason given; the workspace refuses the deletion before doing anything | U,I |
| OR-31 | Two workspaces, each with a tree in each YOLO mode, one tree spanning both; list_agents with and without all from each, and as @human | Without all, the caller's own workspace alone, named once, with the count of its children elsewhere; with all, every workspace, each row of another workspace naming it; YOLO off sees only its tree, across workspaces with all | U,I,V |
| OR-32 | References across workspaces: a number of the other workspace, the same number written `#7`, `7` and `@name #a7`, a name unique on the machine, a name in both workspaces, `7` where A has #a7 and B an agent named `7`, a number below the shared mark two records hold, called from one of those workspaces and from a third, an ended run of the other workspace | Same resolution as in one workspace; a number above the shared mark settles where it is found; each ambiguous reference lists its candidates with their workspaces | U,I |
| OR-33 | Workspace A deletes a worktree also open in B, by stop_agent and by the person: B has an agent there in and out of the caller's reach, an agent in a subfolder, an ordinary terminal there, an unsaved editor; B's framework off; B silent; discard off and on | The preflight lists B's work with A's, named by workspace; an out-of-reach agent refuses the whole call; the person's confirmation lists B's agents, terminals and editors; with authorization B stops its agents and terminals and discards its editors, then the worktree is removed; without discard the unsaved editor refuses; B answers with its framework off; a silent B refuses after the short wait, naming B, with nothing stopped; B's view moves only by WT-3.8 | I,V,H |
| OR-34 | Deletion marks: the person leaves A's confirmation open while B starts an agent there; cancels it; A reloads after authorizing; B deletes the same worktree meanwhile; a workspace opening during the deletion starts an agent there | B's start goes ahead while the confirmation is open and is listed by the recheck; cancelling leaves no mark; after authorization new starts and B's deletion are refused naming A; a mark whose window load ended is stale and ignored; the new workspace's start is refused too | U,I |
| OR-35 | Workspaces started under different `FACADE_HOME` homes, one of them creating and deleting a worktree and injecting configuration into a folder both have open | Neither lists, resolves nor reaches the other's agents; the worktree, counters, key, outbox, chat rooms and marks stay under its own home; the shared folder's injected configuration is owned once, through `~/.facade/injected.json` | I |
| OR-36 | With worktree management off, an agent starts a child with no folder, by path in a workspace folder and a recorded launch folder, by branch and with new_worktree | Workspace and recorded launch folders work, the main checkout included; new_worktree is refused as OR-28; branch shorthand is refused, since no Git discovery runs | U,I |
| OR-37 | A workspace of another Facade version runs beside two of this version; two development builds without a commit; a deletion while the other version's window is open | It is not listed, resolved or reached, and does not reach them; the two development builds are one machine only if they are the same build; the deletion's confirmation and result say that a window of the other version was not asked | I |
| OR-38 | An agent of workspace A starts children by path in a folder A has that B has too - with and without `workspace: B` - one only B has, one B and C have, with and without workspace, a workspace named ambiguously, one no workspace has, with new_worktree from B's repository and from A's, and with a task; B in another application instance with other CLIs and its worktree management off; B's reply lost after it gave the id | The shared folder starts in A, or in B when named; B's alone starts in B under B's admission, setup, CLIs and environment, the child's creator, tree and YOLO A's agent's, its workspace in the result; B and C's is refused naming both until workspace picks one; the ambiguous workspace name is refused with candidates; no workspace's is refused; a new worktree of A's repository starts from A's HEAD; the task is in the child's mailbox in B, its copy in A; with B's management off, its known folders alone; the lost reply reports the child's id as unknown | U,I,V |
| OR-39 | A tree spanning workspaces A and B, its root in A and a YOLO-off child in B, a grandchild back in A; the child lists, messages and stops its tree; a root with a shared older number elsewhere; it ends, and its task is not fetched in time; B closes; A closes with the grandchild running | The child reaches its tree in A, nothing outside it, the old shared number included; its creator in A is told of its task and of its end, also as B closes; the grandchild keeps its ancestor chain and reports to its nearest live ancestor | U,I,V |
| OR-40 | Workspace B is silent - reloading, its extension host restarting, its renderer crashed, hung - or gone - closed, its app crashed - while A lists, resolves by name and number, finds a folder and calls into it; a stale window.json; a pipe answering with another record id; a request without the machine's key | The list waits one query limit and names B; a number above the shared mark found elsewhere does not wait; a name waits up to ten seconds, then is refused naming B with the way round; a call to B's run waits through the reload or ends UNAVAILABLE at the timeout; a gone B is never waited for and its runs are not found; an accepted call's lost reply is unknown, never resent; stale and foreign endpoints are not workspaces; the unauthenticated request does nothing | U,I |
| OR-41 | B's app crashes while A's agents have children in B and unfetched mail there; B silent past the timeout; B then opens again | A's agents are told which children ended with B and which messages may not have been fetched; the silent B brings one fact notice each; B's reopen adds only what A's notices did not say | U,I |

Use fakes and a controllable clock for ordering, timeouts and cancellation.
Test ordinary overlap points; exhaustive scheduling of every possible filesystem
race is not a release requirement.

## O13. End-to-end orchestration gate

On a supported test OS, cover each built-in at least once as a creator and as a
child, using representative mixed-vendor combinations. Verify the child's identity,
task, folder and mode, then send a correction, obtain a report and stop it.
Reuse these runs for the communication and debugging journeys. Other supported
operating systems must cover each CLI at least once in both roles and repeat the
platform-specific launch/worktree cases. L14 defines the shared coverage policy.

Run one three-generation tree, one collaboration across two repositories, one
collaboration between agents of two workspaces - each built-in on at least one side,
one of them started by an agent of the other - and one child repaired after an
unconfirmed start. Repeat the tree-scope cases with YOLO off and the available
precise/fallback approval modes.

Acceptance requires agreement among tool text/data, visible terminals, actual
processes and records. Record discrepancies as failures even if the coding task
eventually succeeds.
