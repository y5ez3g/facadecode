# Agent Launcher

Facade Code runs coding agents in their vendors' interactive terminal interfaces.
Choosing an agent opens its terminal, ready for a conversation. Agents created by
other agents use the same launch path and appear in the workspace whose folder they
work in, which is usually their creator's (AGENT-ORCHESTRATION.md O3).

This document is one of four specifications for a single product:

| Document | Owns |
| --- | --- |
| [AGENT-LAUNCHER.md](AGENT-LAUNCHER.md) | Human entry points, identity, launch configuration, permissions and lifetime |
| [AGENT-ORCHESTRATION.md](AGENT-ORCHESTRATION.md) | Starting, listing and stopping agents; worktrees; the shared tool contract |
| [AGENT-MESSAGES.md](AGENT-MESSAGES.md) | Mailboxes, tasks, terminal doorbells and communication with the person |
| [AGENT-DEBUGGING.md](AGENT-DEBUGGING.md) | Reading agent screens, typing, keys and final screen snapshots |

Together they specify the final behavior. Later documents do not replace rules in
earlier ones. Each subject has one owner; references use section identifiers such
as L4, O3, M5 and D3. All four files belong together when published.

The words **must** and **must not** identify requirements. Technical sections
describe the intended implementation within the existing architecture. Acceptance
sections define evidence required to claim the implementation works; they are not
a record of tests already passed.

# Part 1: Specification

## L1. Scope and principles

The first release supports local desktop windows on Windows, macOS and Linux,
with Claude Code, Codex, Muse Code, Antigravity, Qwen Code and configured custom agents.
Remote SSH, containers and WSL windows are outside this release's scope.

The complete agent framework exposes exactly eight tools:

| Management | Communication | Debugging |
| --- | --- | --- |
| `start_agent` | `send_message` | `read_screen` |
| `list_agents` | `read_messages` | `type_text` |
| `stop_agent` | | `press_keys` |

Ordinary terminals, file editing, IDE commands, debugger control and a new chat UI
are outside this framework. Agents continue to use their own CLI tools and scripts
for their normal work.

The product follows these principles:

- Starting a configured agent is immediate and asks no launch questionnaire.
- Background agent activity does not move the person's focus, selected tab or
  selected folder, except for cleanup and view fallback when deleting a worktree
  under O5, in any workspace that showed it. A person's explicit navigation does,
  Show on a notification included (M9).
- Routine cooperation proceeds automatically. The person normally stays in the
  terminal of the agent they are directing.
- Facade provides capabilities and clear results. Project workflow, staffing,
  review and commit policy belong in the person's skills and instructions.
- Use VS Code's existing terminals, commands, Quick Pick, settings, notifications
  and workspace services. Add small hooks where the extension API is insufficient.

The framework switch disables the eight tools and their integration. Human
launching, navigation, agent identity, lifecycle tracking and final screens remain
available. This is the launcher feature's behavior with the framework disabled.

## L2. Terms and identity

An **agent** is one run of a CLI launched by Facade, in its own terminal. A CLI
typed manually into an ordinary terminal is not registered as an agent.

A **creator** is the person or agent that started a run. It never changes.
A **child** is a run created by an agent. A **tree** consists of one human-created
root and all its descendants, including ended ancestors.

The person is `@human`. An agent is displayed as `@name #a7`. Its number is unique
on the machine - across every workspace and its record - and never reused,
including after restarting the app. Numbers distinguish agents with the same name.
Message numbers use a separate sequence and prefix, such as `#m42`, unique on the
machine in the same way. A workspace's own numbers may therefore skip. Numbers given
before machine numbering, or by an older version still running beside this one,
stay as they were, and two records may share one; L12's shared mark bounds them,
and O2 treats such a number as ambiguous where two workspaces hold it, unless the
reference names its workspace.

Names contain 1–40 lowercase ASCII letters, digits, dots, underscores or hyphens,
starting with a letter or digit. Reserved names are `human`, `you`, `me`,
`facade`, `all`, `everyone`, `init` and `kernel`. Built-ins started from the UI
default to `claude`, `codex`, `muse`, `agy` or `qwen`; custom agents use their configured
name. Runs started through `start_agent`, including the person's scripts as
`@human`, use the supplied `name`. Names may repeat. Reference resolution is
specified in O2.

A **workspace** is one VS Code window with the folders it has open: one window, one
workspace, and these specifications name them as one - the window is the workspace's,
which opens, reloads and closes. A window with no folder is none, except one whose
last folder left while its runs were live (O1). A run belongs to
the workspace that started it. The **machine** is every open workspace of this
Facade version that shares one Facade home (O1): one virtual window, which Facade's
tools reach across. A **worktree** in
these specifications means an additional Git worktree; the repository's primary
working folder is its **main checkout**.
Folder paths identify checkouts; branch names are useful labels, not identities.

## L3. Starting and finding agents

The title bar's agent button opens a menu containing installed, enabled built-ins
in this order: Claude Code, Codex, Antigravity, Muse Code, Qwen Code; then custom agents in
configuration order. Below a separator are **Show Active Agents...** and
**Configure Agents...**. An item's action does not change with the framework switch.

Detection runs whenever the menu opens, using the environment a terminal would
receive. Built-ins use their configured path, or their command on PATH. Detection
does not write discovered values to settings or run the CLI to install or update it.
Custom entries remain visible even if their executable is missing; choosing one
reports the invalid path. If no agents are available, show an empty-state hint and
Configure Agents; do not present an apparently broken empty menu.

Choosing an agent:

1. Uses the folder selected in the workspace bar.
2. Uses the CLI's own model and effort defaults, and supplies no task.
3. Creates and focuses its terminal immediately after launch preparation.
4. Shows its connection outcome as specified in L5.

There is no name, model, task or permissions picker. **Start Agent...** asks only
which configured agent to start. To start elsewhere, the person selects that folder
or worktree first. Without a local folder, report that one must be opened.
In Restricted Mode, use VS Code's Workspace Trust request, then continue the same
start if trust is granted. A denied request creates no agent.

Before the CLI supplies a title, the terminal reads `@claude #a1`. Afterwards it
reads, for example, `Fix the login bug - @claude #a1`: the CLI's title, then the agent,
joined as every terminal tab joins its parts (`terminal.integrated.tabs.separator`,
` - ` by default). A user-renamed terminal keeps the agent suffix; renaming its display
title does not change the agent's identity.
A built-in agent uses its CLI's logo; every custom agent uses the standard robot icon,
whatever program it runs.

The button counts all starting, running and stopping agents in the window.
Workspace rows display their agents' logos using the existing workspace bar
conventions, including a marker on collapsed rows. **Show Active Agents...** is a
live Quick Pick in workspace bar order, with the folder, terminal title and agent
number, and a close action. Selecting a row reveals that agent, selecting its
folder first if necessary. Ended agents remain in the record, not this active list.
The button, row markers and Show Active Agents show the workspace's own agents.
That is a deliberate choice for this release: other workspaces' agents are reached
through Facade's tools and their own windows, and a later change may list them in
Show Active Agents by workspace. Closing a workspace ends its agents (L6), so
WORKSPACE.md W11's question names, for each agent whose creator runs in another
workspace, that creator and its workspace - closing ends that tree's children here.

## L4. YOLO, approvals and questions

YOLO is enabled by default. It controls the CLI sandbox and the reach of Facade
tools; it is not an extra approval dialog.

| Launch mode | CLI sandbox | Reach of Facade tools |
| --- | --- | --- |
| YOLO on | Disabled | All agents in every workspace on the machine |
| YOLO off | Enabled where the CLI and operating system support it | The caller's tree, ended agents included, in whichever workspace each runs |

Every agent can address `@human`. The person's scripts can address every agent in
every workspace. Reach is checked against the caller's mode, not the target's mode.
A YOLO-on caller can therefore reach an agent in a YOLO-off tree.

A human-created agent snapshots the setting at launch. A child inherits its
creator's mode, regardless of later changes to the setting. A reload preserves it.

The launch entry point also controls interaction. An agent started from the UI -
the agent menu or Start Agent - keeps its normal CLI questions, updates and,
subject to YOLO, approval prompts. Facade adds its integration and instructions.
An agent started through `start_agent` - by another agent or by the person's
scripts as `@human` - runs unattended. Use the CLI's supported settings to avoid
waiting for an answer.

| | Started from the UI | Started through `start_agent` |
| --- | --- | --- |
| YOLO on | Approvals off; sandbox off | Approvals off; sandbox off |
| YOLO off | Supported sandbox on; Facade's tools exempt where possible; other approvals use the CLI's normal interaction | Supported sandbox on; Facade's tools exempt where possible; configure other approval requests to be denied without prompting where supported |

YOLO off applies the restrictions the CLI and operating system support, with
availability taking priority. Missing controls for sandboxing, approvals, hooks
or questions do not prevent launch. Report the effective behavior and limitations;
Facade does not guarantee complete containment or a prompt-free CLI.

1. Where the CLI cannot exempt Facade's tools alone, use its all-tool approvals-off
   setting when available and keep its supported sandbox on.
2. With YOLO off, disable commands outside the sandbox for `start_agent` runs
   where the CLI supports that restriction. UI-started runs use the CLI's normal
   approval behavior for those commands.
3. If project hooks or settings require review, UI-started runs keep the CLI's
   normal prompt. For `start_agent`, use the CLI's per-run trust switch with YOLO
   on; with YOLO off, use its switch to disable unreviewed hooks/settings where
   available. Otherwise continue with the CLI's available behavior and report the
   limitation.
4. An explicit conflicting override must be visible in Show Agent Launch and the
   launch diagnostics; it is never reported as a working exemption.

A CLI without a native sandbox does not acquire one from Facade. Show Agent Launch
and agent metadata must identify the effective sandbox as on, off or unavailable.
Do not silently turn a supported sandbox off to implement YOLO off. Platform
capabilities and the supported launch configuration must be verified in L14.

An agent started through `start_agent` is launched with blocking question tools
disabled wherever the CLI provides a launch setting for them - Claude Code's
`AskUserQuestion` and equivalent tools that wait for someone to select an answer.
Apply available launch settings to disable update prompts and self-update,
surveys, onboarding, tips and input-box helpers. An agent started from the UI
keeps these as the CLI has them: its questions are the person's to answer.
This uses launch configuration, not a vendor-specific message driver.

Where a CLI cannot remove a question tool, the startup instructions of a
`start_agent` run explicitly tell it to ask through Facade messages instead.
A CLI-specific limitation is documented in its verified launch record. An
unexpected prompt is handled through the debug tools; the normal recovery is
not a notification asking the person to visit a child terminal and click an answer.

Children ask their creator by message. Unresolved decisions move up the creator
chain. A UI-started agent asks the person through its normal CLI interaction.
A root started through `start_agent` asks `@human` by message, as may a child with
no available creator in its chain. This default communication guidance does not
remove any agent's ability to send to `@human`; team-specific policy belongs in
skills.

Facade tools themselves display no confirmation dialogs. Messaging remains
automatic with either YOLO mode, including terminal doorbells. Debugging does not
add a separate approval gate.

## L5. Launch outcomes and visible failures

A launch snapshots its resolved settings and effective environment once. Checks
for an executable, valid configuration, local folder and required integration files
happen before allocating a run where possible. Rejection before acceptance leaves
no agent, terminal, worktree or integration change.

Facade distinguishes these facts:

| Fact | Meaning |
| --- | --- |
| Process launched | VS Code has started the CLI process |
| Connected | The run's Facade MCP server has identified itself to the window |
| Running | The launch has reached its readiness condition |
| Task fetched | The recipient has retrieved its task message; it does not prove completion |

A launch expecting Facade reaches running when it connects. A launch with no Facade
integration reaches running when its process starts. This is the same rule for
human-created and agent-created runs. Message delivery is specified in M3 and M7.

While connecting, the terminal remains usable. If the launch timeout expires,
retain the process and mark the start unconfirmed, with its current phase.
For a human-created agent, show one nonmodal notification with **Show**, explaining
that the CLI is open but Facade has not connected. A later connection clears that
condition without a second success toast. For a child, return the outcome to the
creator as O3 specifies.

A failure says what failed and what the person or caller can do next. Do not
silently substitute an executable, model, effort or malformed launch setting.
A CLI that rejects a model or encounters an expired login after connecting may
still have a running process. Report observable process and connection facts;
use the screen and messages for diagnosis, not a guessed "working" state.

A failed launch or unexpected exit offers **Show** to reveal the live terminal or
its saved final screen. If no terminal ever existed, show the launch error instead.
An agent-created launch reports to its creator rather than producing a duplicate
notification for the person.

## L6. Lifetime and ownership

The lifecycle is `starting -> running -> stopping -> ended`. Starting can also end
as failed. Ended runs record one of `exited`, `stopped`, `failed` or `lost`, plus
the reason, actor, time and exit code when known. A disconnected running agent
remains running; connection is a separate fact.

- Closing an agent terminal stops that run, using the person's existing VS Code
  terminal-close confirmation setting. Cancelling that confirmation changes nothing.
- A CLI process exiting ends the run and closes the live terminal. D6 keeps its
  final screen when available.
- Stopping one run does not stop its descendants. Worktree deletion is the explicit
  exception described in O5.
- A reload reconnects surviving processes when terminal persistent sessions are
  enabled. With that VS Code setting disabled, agents end on reload as terminals do.
- Closing the owning window, quitting, or closing/replacing its workspace ends
  its agents only after WORKSPACE.md W11's checks succeed. Opening another workspace
  in a new window leaves them running. Folder-window conversion and Save Workspace
  As preserve the runs through storage migration. The next launch of the app does
  not replay their command lines.
- The workspace's runs end with its window, and their unread mail is returned as for
  any end. Once W11's checks can no longer cancel the window's shutdown, the
  workbench tells the extension the reason - closing, quitting, replacing its
  workspace or reloading - and stops the extension host only after the extension
  has done its closing work. For a close, quit or replacement it then, in order:
  1. marks its window.json closing, so other workspaces take it for gone and send
     it nothing more (O8);
  2. records, in one write, each run ended with the window's close as the reason;
  3. writes, into the outbox of each other workspace concerned, the returns of
     unread mail from its senders there (M6) and the ends of their children (M8),
     and rings those workspaces, without waiting for their answer: the window closes
     no later for them, and one the ring does not reach takes its notices as it
     answers again (O8);
  4. removes its window.json.
  Notices are files, so a workspace that is reloading or silent takes them when it
  answers again, and no other workspace's state - its reloading, its own closing -
  changes what is written. A reload, an extension host restart and a storage
  migration are no close and end nothing; the extension is told of a reload, which
  ends nothing. A CLI recorded ended this way whose process outlives the close is
  still found and ended at the next start. A close whose reason never reached the
  extension - its host hung - ends nothing then: the workspace stays silent while
  its application instance runs, and once that instance ends it is gone, as after
  an app crash. After an app crash, the next open of the workspace records the ends
  as before, and the other workspaces have told their agents meanwhile (O8).
- After a renderer crash, reconnect any surviving terminal process. A run whose
  process is gone without an observed exit is lost.
- Interactive Remove Folder follows WORKSPACE.md W9.6's confirmed stop; external
  workspace-file edits and `updateWorkspaceFolders` keep affected agents running
  in the panel with the same run identity and working directory. Delete Worktree
  follows WORKTREE.md WT-8's ordered removal. Membership changes alone must not
  independently stop a run. Switching the selected folder does not stop agents,
  including those in worktrees not yet added to the workspace.
- Framework off leaves processes and lifecycle tracking running. Existing Facade
  calls become unavailable; new launches receive no framework integration.

A registered terminal can move between the panel, editor area and floating windows
of its owning window. Relaunch, process revival, cross-window transfer and Detach
Session are unavailable for it, including automatic environment-triggered relaunch.
Splitting it creates an ordinary shell, not another registered run.

The person's notification of an unexpected end is limited to agents they created:
nonzero exit, or a stop not requested by them. Suppress duplicate launch-failure
notices, known user interrupts, normal exit, shutdown and lost-after-crash notices.
Do not infer human intent from exit code 130 alone when Facade knows another actor
sent the interrupt. Child lifecycle messages are specified in M8.

## L7. Settings and commands

Settings are machine-scoped. Only explicit overrides are persisted; detecting an
installed CLI never creates a setting.

| Setting | Default | Purpose |
| --- | --- | --- |
| `facade.agents.yolo` | `true` | Mode for the next human-created run |
| `facade.orchestration.enabled` | `true` | Enable the eight framework tools |
| `facade.agents.timeout` | `120` | Wait budget in seconds, integer 1–3600 |
| `facade.agents.<cli>.enabled` | `true` | Offer a built-in |
| `facade.agents.<cli>.path` | Empty | Executable override |
| `facade.agents.<cli>.launch` | `{}` | Overrides of the built-in launch |
| `facade.agents.custom` | `{}` | Named custom launch definitions |

The built-in setting keys are `claude`, `codex`, `antigravity`, `muse` and `qwen`;
Antigravity's tool-facing CLI id is `agy`. This mapping is fixed.

Group the settings under Agents, then each built-in, then Custom Agents.
Describe launch overrides and timeout as advanced settings, while keeping them
available in the ordinary Settings editor and settings.json; no custom editor is
required. Configure Agents opens the same settings search every time.

Commands in the **Agents** category:

| Command | Action |
| --- | --- |
| Start Agent... | Pick an agent, then start it |
| Show Agent Menu | Open the title bar menu; Cmd+Alt+A / Ctrl+Alt+A |
| Show Active Agents... | Find or close a live agent |
| Configure Agents... | Open agent settings |
| Show Agents Log | Open this workspace's lifecycle and debug audit log |
| Show Agent Launch | Read the effective launch configurations and validation errors |

Message-history commands are owned by M9. Terminal close is the human stop action;
there is no additional Stop Agent dialog.

# Part 2: Technical Design

## L8. Keep the existing architecture

Keep the built-in `facade-agents` extension and the existing workbench integration.

```text
workbench                              facade-agents extension host
agent menu, terminals, workspace bar   host adapters -> core -> record
             <--- _facade.* commands --->
                                       CLI launch configuration
                                       MCP transport (O8)
```

The workbench owns terminal processes, screen buffers, focus and folder association.
The extension owns run identity, policy, launch planning, the ledger and tools.
Use VS Code APIs first, and narrow internal commands for capabilities they lack.

Retain the existing layer boundaries: host adapters may import VS Code and assemble
the other layers; contract maps tool arguments/results; core applies behavior;
record persists it; clis describes launches; transport carries requests.
Do not create a second terminal manager or a vendor conversation engine.
Changes to upstream terminal code should be optional metadata/hooks that leave
ordinary terminals unchanged.

The required internal operations are active-folder lookup, window/load identity,
terminal environment, create, process reconciliation, stop, reveal and restoration
completion. O8 and D8 define the additional operations. Commands identify a terminal
by registered run, not by its display title or a guessed foreground terminal.

## L9. Launch configuration

A custom entry has a unique nonreserved name, a required executable `path`, and a
`launch` object. Built-in ids cannot be custom names. Custom entries inherit no
vendor-specific behavior just because their executable resembles a built-in.

A built-in launch setting is an override object over maintained defaults.
Argument groups replace whole groups; `null` removes a default group. An empty
override remains empty when defaults change in a future release.

| Launch field | Meaning |
| --- | --- |
| `arguments` | Ordered groups: warmUp, connect, quiet, questions, messages, yoloOn, yoloOff, model, effort, extra, task |
| `environment` | Per-variable overrides; null removes Facade's override, not the inherited variable |
| `trust` | Launch arguments, or a file and structured merge describing CLI trust; null disables it |
| `settings` | Per-launch settings, recursively merged: Claude Code's settings file, and Qwen Code's settings in its highest scope, which go over the administrator's as Qwen Code merges one scope over another. A Qwen Code value that is exactly `${model}` or `${effort}` takes the given value and is omitted when none is given; such a value is how that CLI accepts a model or an effort |
| `taskDelay` | Delay before the first typed task notification after connection, integer 0–60000 ms |
| `enterDelay` | Delay between a paste and Enter, integer 0–60000 ms |
| `unattended` | What an agent started through `start_agent` runs with in place of parts of the launch (L4): its own `arguments` groups, each replacing the launch's group of the same name (an empty or null one leaves that group out), and `environment` and `settings` merged over the launch's (null removes the launch's key too). UI-started agents run with the launch alone |

A group of the launch that the person changes does not reach an agent started through
`start_agent` where the unattended part has a group of that name: they change it there
too. This keeps the unattended group's supported prompt suppressions separate from
changes to the UI launch.

The questions group, and what keeps updates, surveys, tips and input-box helpers from
a run, are part of the unattended part of each built-in's launch: they apply to agents
started through `start_agent` only (L4). An agent started that way with no task, of a
CLI whose question tool no launch removes and that takes its notice as an argument, is
given its opening line alone as that argument - who it is, and to ask through
Facade messages; Antigravity's warm-up says the same. The messages group grants
access to message and snapshot files when necessary, including with a sandbox.
warmUp, connect and messages apply only with the framework enabled. Exactly one of
yoloOn/yoloOff applies. model and effort apply only when supplied; task contains
M7's short task notice, not the task's text. The optional trust arguments are
inserted before extra and task.

Expand placeholders once as data. Supported values are the fields needed by the
maintained launch: `${model}`, `${effort}`, `${task}`, `${folder}`,
`${repository}`, `${home}`, `${settingsFile}`, `${mcpConfig}`,
`${messagesDir}`, `${screensDir}`, `${configFile}` and the connection values
defined in O9. Unknown placeholders or missing values in an applicable group are
configuration errors. Inapplicable groups are not expanded.

Expose the full supported object schema and completion in settings.json. Reject
unknown keys, wrong types and invalid delays before launch. Show Agent Launch
shows defaults plus overrides, effective sandbox/approval behavior - for an agent
the person starts and for one started through `start_agent`, each - persistent
trust effects and configuration errors, without tokens or inherited secrets.

The default enterDelay is 250 ms and taskDelay is 0 ms. A built-in may override
these with a measured value in its maintained configuration; Show Agent Launch
shows that value and its verified CLI version. Delay changes are configuration,
not a message adapter.

## L10. Built-in launches and executable handling

Maintain small data-oriented launch definitions for the five CLIs. The following
are the launch mechanisms to verify, not a claim of acceptance on every version.

| CLI | Connection and startup mechanism |
| --- | --- |
| Claude Code | Per-run MCP configuration and settings; plugin directory for Facade instructions; initial task notice as an argument |
| Codex | Per-launch configuration overrides for the MCP server; Facade skill; initial task notice as an argument |
| Muse Code | Project MCP configuration where required; Facade skill; initial task notice as an argument |
| Antigravity | Project plugin configuration where required; a harmless warm-up prompt to establish MCP; task notice typed afterwards |
| Qwen Code | Per-run MCP configuration, its servers connected before the first prompt; Facade skill; per-run settings over the administrator's in its highest scope; initial task notice as an argument |

Qwen Code has a precise control for Facade's tools but no setting that denies
other approvals without asking. With YOLO off, an agent started through
`start_agent` keeps the CLI's approval prompts; its launch record says so. It runs
without the project MCP servers the person has not approved for its folder, which
Qwen Code would stop to ask about: they are rejected for that run in a per-run copy
of Qwen Code's MCP server approvals, the person's own left unchanged. With YOLO on,
its launch turns off the sandbox the person's own Qwen Code settings may turn on;
with YOLO off it leaves that sandbox as configured and reports it.

With the framework disabled, remove those connection additions and Antigravity's
warm-up. A human launch otherwise leaves the CLI at its normal input prompt.

The maintained definitions must implement L4 and use each vendor's supported
launch configuration. Claude Code's allowed/disallowed tool arguments and Codex's
server approval settings are examples of precise controls. A CLI without a precise
control uses the all-tools approval fallback. Do not invent unsupported flags.

An executable is resolved in the effective terminal environment, including
terminal.integrated.env, extension environment contributions and launch overrides.
Trust/config paths use that environment as well.

Prefer direct executable plus argument-array process launch. On Windows, a standard
npm .cmd shim that only invokes a Node entry point can run through that Node
executable directly, and so can a vendor installer's own launcher that Facade
knows - Qwen Code's - with the variables that launcher sets. Other .cmd launchers
use the existing platform quoting path.
Generated notices must be quoted as data; arbitrary message/task content never
enters cmd.exe. Reject arguments the fallback cannot preserve instead of rewriting
their meaning - before anything is made for the agent, its first line checked as it
will be given, naming its creator as it will. Parentheses it preserves, quoted or not.
Test paths with spaces, quotes and non-ASCII characters.

Configuration values embedded in TOML or JSON must be encoded with the corresponding
serializer. Facade neither validates model names against a hardcoded catalog nor
installs or updates a CLI as a side effect of starting one.

## L11. Trust and integration files

In a VS Code trusted workspace, preconfigure the CLI's folder trust where supported
so it does not repeat the same startup question. Prefer per-launch arguments or
run files.
Where a CLI only persists trust in its user configuration, merge that entry using
the CLI's file conventions. Show Agent Launch explains the persistent effect.
A custom trust override is applied as configured.

For repository-based trust, cover the main checkout and worktrees according to the
vendor's actual trust representation; folder-keyed formats require each launched
folder to be covered. Resolve real paths and platform casing as the CLI does.
Do not promise that one root entry covers all worktrees unless measured.

Use the CLI's compatible lock where available and preserve unrelated values.
Malformed user configuration must not be overwritten. Report the specific problem
and keep the existing file intact. Failure to apply a supported, configured trust
step is a clear launch preparation failure. A missing vendor control follows L4's
best-effort policy and does not prevent launch.

Project MCP and skill files are owned by O10. Their ownership and cleanup use the
same policy for human and agent launches.

## L12. Record and recovery

Retain the workspace record under `workspaces/<id>/` in the Facade home and the append-only
ledger. The workspace id is kept in VS Code workspace storage. It follows the live
workspace when folders change or Save Workspace As migrates storage. If another
workspace subsequently presents the same id but a different identity, allocate a
new id there; two independent workspaces must not share a live record.

| Record item | Lifetime |
| --- | --- |
| identity metadata, counters, agents.log | Across app starts |
| ledger and current run state | Through reload and recovery; ended entries leave the active list at a fresh start |
| run launch files and credentials | Until the run ends |
| message history and message files | M10 |
| final and large screen snapshots | D6 |

Agent and message numbers come from the machine's counters, `counters.json` in the
Facade home (`~/.facade`, or `FACADE_HOME`, O8), taken under its lock; each
workspace record keeps the last numbers it used as well, as before. A workspace
takes the next number above both the counter and its own record's last, and writes
the counter before using it. The lock records its holder's process id and that
process's start time, and is taken over only from a holder that is gone - its
process ended, or its id now another process's, by that start time - never from a
live one for its age: a paused holder stops the machine's numbering while it is
paused, the accepted cost of never giving a number twice, and a live holder that
keeps it too long fails the call that waited, which gives no number. Waiting for the
lock never blocks the extension host's other work.

The counters start above the highest number any existing record has used, found by
reading the records while holding the lock; a missing or unreadable counters file is
rebuilt the same way, an unreadable one kept aside. The counters file also keeps the
machine's **shared mark** of each kind: the highest number that two records may both
hold. Each record notes when it first took a machine number; a record that has
none yet - one written before machine numbering, or by an older version running
beside this one - raises the shared mark to its own last numbers as this version
first opens it. A number above the shared mark is held by one record only; one at or
below it may be held by two (O2). Skipped numbers are acceptable.

Agents of other workspaces in a record (O8) need the next ledger version: a creator,
ancestor, tree root, sender, recipient, actor or child of another workspace recorded
by number, name and workspace, a number another workspace gave that is lower than
the record's last, and the keys of notices taken from the outbox.

Record intent before starting/stopping a process and record its observed result.
Typical lifecycle events are started, launched, connected, running, stopping and
ended. M10 adds message events. Use a supported versioned reader; do not introduce
a separate format version for each document.

Use one serialized writer per workspace record and ordinary local file locking.
For shared CLI/project configuration, hold a short mutation lock. Do not build
lease elections, distributed fencing or a new process supervisor. A reload from
the owning window can reclaim its record once the previous writer is gone.
Conflicting live ownership produces one actionable error and prevents a second
writer; it does not kill agents or steal ownership based only on elapsed time.

On activation, wait for terminal restoration, then reconcile registered run ids:

- Present process: retain it; resume a requested stop if necessary.
- Known exit: record its outcome.
- Definitely absent process: end as failed, stopped or lost according to recorded intent.
- Unknown because restoration is incomplete: retain state and retry reconciliation.

A restore timeout does not itself prove an agent ended. Never automatically replay
a launch whose process might already exist. A partially written final ledger line
may be discarded; other corruption is reported, with no blind mutation of a live
record. When no run can survive, preserve the bad file and begin a fresh list while
retaining valid counters and human-readable history.

At an ordinary fresh app start, remove ended agents from the current list and
discard their short-lived screen files. Retain any ancestor identity required by
a surviving run after renderer-crash recovery. Numbers never reset.

## L13. Framework switch

`facade.orchestration.enabled` applies immediately.

Off: stop accepting tool work, stop doorbells, mark the endpoint disabled, and
continue observing every process. Two duties to other workspaces remain, since they
protect the person's work and the record, not the agent tools: answering a
deletion's question and stopping its authorized work (AGENT-ORCHESTRATION.md O5),
and keeping notices other workspaces write for it until re-enable (O8). The switch
is the application instance's, so a workspace with it off beside one with it on
means two instances. Operations already accepted finish or report
their partial outcome; do not start a second copy on re-enable. Newly launched
agents receive no server, skill, project injection or warm-up.

On: reconnect shims belonging to agents launched with integration, reconcile
pending messages and continue. Agents launched without integration require a new
launch to gain it. Do not inject commands into their existing conversations.

Lifecycle, navigation, final screens and the person's input remain available
throughout. Files used by surviving runs are not removed merely because the
framework is disabled.

# Part 3: Acceptance

## L14. Evidence and release gate

The four specifications are accepted as one feature. A passing unit suite alone
does not establish that an interactive CLI can start, receive a doorbell or take
keys. The release evidence must contain:

- Commit/build, OS, architecture and exact CLI versions.
- Effective launch configuration, including sandbox, approval exemption/fallback,
  question-tool suppression, connection method and timing.
- Automated test results and reproducible live steps with observed outcomes.
- Screenshots for human interaction, plus terminal/log/ledger evidence for behavior.
- Explicit failed, skipped and unsupported cases with reasons.

Reuse runs and evidence across the four documents' acceptance journeys. Verify
each CLI's capabilities and representative mixed-vendor cooperation; exhaustive
vendor pairing is not required. Add pair-specific regressions for observed failures.

For each supported desktop OS, run the live cases on every built-in advertised on
that OS. A supported built-in's failure is not a skip. An unavailable vendor/OS
combination must be documented and not advertised there. Use real authenticated
CLIs and models in disposable repositories; never infer cross-CLI success from one
vendor. A missing restriction allowed under L4 is an accepted limitation, not a
failed launch or a reason to mark the CLI unsupported. These suites run on demand
because live runs consume quota.

Use the repository's existing build and test commands. Prefer targeted tests.
Run the relevant layering/hygiene/style checks when implementation changes affect
them. Documentation review and link checking do not count as live feature tests.

## L15. Launcher acceptance matrix

Test modes: U = unit, I = extension/workbench integration, V = live vendor run,
H = human-visible verification. Each row defines an observable outcome.

| ID | Scenario | Required outcome | Mode |
| --- | --- | --- | --- |
| LA-01 | Fresh settings; install/remove a built-in between menu opens | Correct menu and order; settings remain unchanged | I,V,H |
| LA-02 | Disabled built-in; missing custom executable; empty catalog | Disabled agent unavailable to both human and tool; clear custom error and empty state | I,H |
| LA-03 | Start each CLI in main checkout, worktree, detached worktree, second repository and non-Git folder | Correct cwd, unique id, logo and focused terminal; no launch questionnaire | V,H |
| LA-04 | No folder, remote window, untrusted workspace; grant and deny trust | Explicit supported flow; denial/rejection creates no run or side effects | I,H |
| LA-05 | UI launch names; named start_agent call as @human; duplicate names; CLI title changes; user renames a tab | UI defaults and supplied tool names follow L2; stable distinct numbers; title updates preserve agent identity | I,V,H |
| LA-06 | Agents across folders, including an unjoined worktree | Accurate count, row markers and live Quick Pick; navigation reveals the right run | I,H |
| LA-07 | Invalid launch field, placeholder, path or delay | Named configuration error before acceptance; no silent fallback | U,I |
| LA-08 | Change settings while agents run | Existing launch unchanged; next launch uses new snapshot | I,V |
| LA-09 | YOLO on/off for each supported CLI/OS, including unavailable restrictions | Supported restrictions applied; limitations reported; a missing control does not prevent launch | V |
| LA-10 | Precise MCP exemption and all-tools fallback available/unavailable | Available exemption/fallback applied without disabling a supported sandbox; missing controls follow L4 | U,V |
| LA-11 | Question, update and trust interruptions in UI and start_agent launches, including @human scripts | UI keeps normal interaction subject to YOLO; tool-started runs apply supported suppressions; unsupported controls are reported without refusing launch | V,H |
| LA-12 | Missing login, invalid model, unknown flag, delayed connection | Correct distinction between launch failure and live-but-unconfirmed; useful Show/result | V,H |
| LA-13 | Agent exits, user closes/cancels close, agent interrupts, interactive folder removal or worktree deletion; external membership removal | Correct outcome and actor; W9.6/WT-8 govern stops; external removal preserves process, run identity and cwd in the panel; only the intended notification; final screen accessible for ended runs | I,V,H |
| LA-14 | Reload with persistence on/off, including background/editor/floating terminals | Reconnect the same processes when supported; otherwise record their ends | I,V,H |
| LA-15 | Quit/reopen, renderer crash, unavailable process information | No command replay; reconnect survivors; unknown is not prematurely ended | I,V |
| LA-16 | Relaunch, split, detach and cross-window transfer attempts | Agent restrictions hold through UI and command paths; split is an ordinary shell | I,H |
| LA-17 | Framework off/on with running agents and a new launch | L13 holds; no duplicate run, lost lifecycle event or newly injected conversation | I,V,H |
| LA-18 | Folder-window conversion, Save As, open another workspace in a new window; cancel then complete Close Workspace | Migration and a new window preserve existing runs; Close Workspace ends them only after W11 checks succeed; independent records do not collide | I |
| LA-19 | Truncated ledger tail, invalid ledger, duplicate live owner | Defined recovery or actionable refusal; no second writer or duplicate process | U,I |
| LA-20 | Windows shims; spaces, Unicode and quoting; environment overrides | Correct executable, arguments, cwd and configuration paths | U,V |
| LA-21 | Trust file contains unrelated settings or is malformed | Preserve unrelated content; malformed file remains intact with a useful failure | U,I |
| LA-22 | Show Agent Launch and all commands | Effective values and errors readable; no tokens exposed; keyboard and mouse paths agree | I,H |
| LA-23 | Two workspaces starting agents and sending messages at once; the first start after an upgrade with existing records; an older version beside this one keeps numbering, and its record is then opened by this version; the counters file missing or unreadable, rebuilt while another workspace takes numbers; the lock's holder paused or gone | No agent or message number given twice on the machine; the counters continue above every existing record; the older record raises the shared mark to its last numbers and its numbers are then ambiguous where two workspaces hold them; a paused holder keeps its lock, a gone one loses it, one whose process id another process now has included; waiting for the lock does not stop the workspace answering others | U,I |
| LA-24 | Workspace B, with agents running - one holding unread mail from an agent of workspace A, one a child of an agent of A: closes alone; quits with A in the same application instance, A cancelling its own close; quits while A reloads; quits with A in another instance; reloads with persistent sessions on and off; reloads after a vetoed close; its extension host restarts while its close question is open; its renderer crashes with terminals surviving; the app crashes | Every close: B's agents end at once, A no longer finds them, its sender receives the return and the child's creator its end - A takes them after its own reload too, and keeps them when it cancelled its close; reload, the vetoed close and the extension host restart end nothing; the renderer crash follows L6's rule; after the app crash A's agents are told by A (O8) and B's reopen records the ends without repeating A's notices | I,V |

Run the unmodified ordinary-terminal scenarios beside LA-14, LA-16 and LA-17.
Agent integration must not change their lifecycle, movement, titles or approvals.

## L16. Integrated user journey

For each built-in as the human's root agent:

1. Start it from the menu and give it a small coding task.
2. Have it launch a child in a new worktree, send a correction, receive a report,
   inspect a deliberately blocked child and continue it with debug tools.
3. While that happens, type in the root terminal and navigate to another folder.
4. Verify that automatic work preserves the view except for O5's deletion cleanup
   and fallback, human input follows the ten-second rule, and decisions return
   through the root's normal conversation.
5. Reload during the collaboration, complete the task, stop the child and remove
   its worktree using the specified tools. When that worktree is selected, verify
   the folder fallback in O5.
6. Check that UI, processes, messages, final screens and record agree.

Also run the mixed-vendor and failure journeys in M13 and D11. Implementation
defects that block these journeys must be fixed and their targeted regressions
rerun before acceptance; report L4's allowed vendor limitations as L14 requires.
