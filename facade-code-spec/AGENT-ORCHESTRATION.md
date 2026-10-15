# Agent Orchestration

An agent can start, find and stop other agents in the same Facade Code window.
It can place a child in an existing checkout or create a worktree for it. These
operations use the same terminal and worktree services as the person's actions,
without opening confirmation dialogs. Background operations preserve the person's
view except for cleanup and view fallback when deleting a worktree under O5.

This specification owns the three management tools and the shared contract used
by all eight tools. [AGENT-LAUNCHER.md](AGENT-LAUNCHER.md) owns identity, launch
configuration, YOLO and lifetime. [AGENT-MESSAGES.md](AGENT-MESSAGES.md) owns tasks
and mailboxes. [AGENT-DEBUGGING.md](AGENT-DEBUGGING.md) owns screen and input tools.
The four documents describe one final behavior, not successive overrides.

# Part 1: Specification

## O1. Reach and behavior

The caller is an agent, or a script authenticated as `@human`.

An agent uses the YOLO mode it received at launch:

- YOLO on: all agents in its window.
- YOLO off: its tree, including ancestors, descendants, siblings and ended runs.
- `@human`: every agent in the window.

Every child inherits its creator's mode. A human-created run uses the current
setting. There is no per-call override that lets a child acquire a broader mode.
The tree root is stored with each run and remains meaningful after a creator ends.

All eight Facade tools follow L4's approval policy. No tool opens a confirmation
dialog. Calls that cannot proceed explain the reason and the next available step.

Starting or manipulating an agent in the background must not activate a terminal,
select a folder, move an editor or add a folder to the workspace, except for O5's
deletion cleanup and view fallback. A newly created worktree appears in the
workspace bar while worktree management is enabled (WORKTREE.md WT-9); selecting
it is the person's decision.

Creator relationships describe provenance and supply a default communication path.
They do not impose a staffing algorithm, automatically reparent orphans, or require
a particular Git workflow. Within its reach, an agent can operate on a sibling,
an ancestor, itself or a human-created root.

## O2. Shared arguments, references and results

The canonical agent reference is `#a7`. Tools also accept `a7`, `#7`, `7`,
`@name` and `@name #a7`. Resolve a name only when exactly one non-ended agent in
the caller's reach has it. An ended agent is addressed by number. A name with only
ended matches returns their numbers so the caller can choose one.

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
| `UNAVAILABLE` | A required service, executable, connection or terminal is unavailable |
| `FAILED` | An accepted operation failed |

Errors include a specific explanation and a recovery action. If effects may already
have occurred, include the known agent id and `outcome: "unknown"` or
`outcome: "pending"`, plus the current phase and any resources created.
Do not describe a timed-out accepted call as if nothing happened.

## O3. Starting an agent

```text
start_agent(name, cli, model?, effort?, task?, folder?, new_worktree?)
```

| Argument | Contract |
| --- | --- |
| name | Required; follows L2. Also the branch name when creating a worktree |
| cli | Required; claude, codex, muse, agy, or a configured custom name |
| model | Optional; omitted uses the CLI's own default |
| effort | Optional; omitted uses the CLI's own default |
| task | Optional nonempty text; becomes a message under M7 |
| folder | Optional absolute folder path, or an unambiguous branch of the caller's repository. For an agent's child while worktree management is on, a worktree Facade made |
| new_worktree | Boolean, false by default |

A missing folder means the caller's registered launch folder. For `@human`, it
means the selected local folder. The CLI changing its own working directory does
not change the run's registered folder.

While worktree management is on, an agent's child works in a worktree Facade made
(WORKTREE.md WT-1.3): its creator's own when no folder is given and that is one,
another of Facade's by path or branch - several agents share one as freely as
one - or a new one with new_worktree. A main checkout, a folder outside Git and
another tool's worktree are refused before anything is allocated, naming Facade's
worktrees in the window and new_worktree. This is where the child is placed, not
what it may reach: with YOLO on it reads and writes any folder, as its CLI does.
The person's own start may use any folder of the window.

An absolute folder must be a workspace folder or a worktree shown on the workspace
bar: one Facade made of a repository in the window. Branch shorthand is limited to
the caller's repository - its main checkout and Facade's worktrees; another tool's
worktree is a folder, which no branch names. A detached worktree must be named by
path. No branch name, including `main` or `new`, has a special meaning. If a
branch is checked out in multiple worktrees, return the paths and ask the caller
to select one.

With worktree management off, ordinary starts can use existing workspace folders
and recorded launch folders; do not restart Git discovery to resolve a new worktree
path or branch shorthand (WORKTREE.md WT-9).

With new_worktree, apply WT-9's shared admission check before allocating a run,
creating a worktree or injecting configuration. Once accepted, create an additional
worktree of the chosen folder's repository on a new branch named name. Use the
caller checkout's current HEAD when it is the same repository; otherwise use the
target repository's main checkout HEAD.
Resolve the commit when accepting the request. Uncommitted edits are not included.
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
message id when present. An unconfirmed/failed result includes the available
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

- Serialize Git creation and include-file copying for the same repository.
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
WT-1.3); the window's shared deletion refuses one too.

If stopping exceeds the timeout, return pending and do not delete the worktree.
Termination may continue, but deletion requires a later explicit stop_agent call
after that pending result. If a later loss check or deletion fails, report the
reason, remaining folder path and completed effects, including membership removal
and stopped agents. Do not imply that they were rolled back. A retry against the
ended agent can finish deletion.

No dialog appears for this tool: delete_worktree and discard_changes are explicit
choices in its arguments. Do not add an extra confirmation round.

Self-stop and deletion of the caller's own worktree may disconnect its tool call
before a result reaches it. The record still reports the actual outcome.

## O6. Listing and discovery

```text
list_agents(all?)
```

Without all, list the caller, its creator and its immediate children, including
ended runs still in the current list. For `@human`, list its immediate children.
With all, list every run in the caller's reach. A reload keeps the list; an ordinary
fresh app start removes ended entries as L12 specifies.

Start the result with counts by lifecycle state and the caller's identity/scope.
Each row includes:

- Canonical number/name, creator and tree root.
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
executable detection.

A creator ending does not transfer its children to another owner. Children retain
their identity, tools and message history. M8 specifies how they seek help when
their creator is no longer available.

## O7. Instructions and framework switch

The MCP server instructions identify the caller, creator, tree, folder, YOLO and
available tools. The Facade skill, where supported by the CLI, explains the same
contract with short examples. The first task notice identifies the run as M7 defines.

Technical guidance must explain:

- Facade-created children are separate CLI terminals, distinct from a CLI's internal
  subagents.
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

The internal workbench surface extends L8 with:

| Operation | Required behavior |
| --- | --- |
| _facade.worktree.create | Existing worktree flow with explicit commit, background setup, phase/result reporting and cancellation |
| _facade.worktree.delete | Existing delete flow with explicit discard choice and no picker/dialog |
| _facade.terminal.type | Send to the registered run's current process, with paste/Enter policy and an effect result |

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

Keep existing per-CLI startup methods: launch arguments for Claude Code/Codex,
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
- stop actor/reason and worktree-removal results.

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
| OR-29 | With worktree management on, an agent starts a child with no folder from a main checkout, a plain folder and a worktree Facade made; in another of Facade's worktrees by path and by branch; in the main checkout, a plain folder and another tool's worktree; with new_worktree from each; the person starts in each folder | The child shares its creator's Facade worktree, or the one named; the main checkout, the plain folder and another tool's worktree are refused before allocation, naming Facade's worktrees and new_worktree; new_worktree works from the main checkout and Facade's worktree, and from the plain folder is refused, naming the same; the person's starts go where asked | U,I |
| OR-30 | stop_agent with delete_worktree on an agent in another tool's worktree; the window's deletion command called for it | The agent stopped, nothing deleted, the reason given; the window refuses the deletion before doing anything | U,I |

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

Run one three-generation tree, one collaboration across two repositories, and one
child repaired after an unconfirmed start. Repeat the tree-scope cases with YOLO
off and the available precise/fallback approval modes.

Acceptance requires agreement among tool text/data, visible terminals, actual
processes and records. Record discrepancies as failures even if the coding task
eventually succeeds.
