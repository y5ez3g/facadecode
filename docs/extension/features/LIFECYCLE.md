# Agent lifecycle

Layer 3. [Experience](../EXPERIENCE.md) explains use; [Rules](../RULES.md) owns identity, state and lifetime. This
document owns launch, terminal and naming interactions. The implementation has not been certified.

| Group | Decides | Implementation evidence |
| --- | --- | --- |
| 1 Launch | Location defaults, pickers, validation and visible start | Pending |
| 2 Identity and terminal | Names, tabs, focus and finding agents | Pending |
| 3 End and continuity | Close, retained errors and window changes | Pending |
| 4 Technical design | Launch transaction, recovery and observation | Pending |

## 1 Launch

### 1.1 The main picker

**New Agent shows the working location, editable suggested name and CLI choices in one native picker.**

With a folder open, use `New Agent · {name} · {location}` as the title; placeholder: `Select a CLI`. In a multi-folder
window, prefix a checkout's location with its workspace folder; do not repeat a plain folder's name. A proposed worktree
appears as `{branch} (new)` in the title, with the folder prefix in a multi-folder window. Append the environment only
when it is remote, named as VS Code's remote indicator names it: `SSH: {host}`, `WSL: {distro}` or `Dev Container`. Only
the local window component sees the remote authority, so it reports it with the window identity; location identities do
not change. This summary remains visible while CLI choices
are filtered or scrolled, including when 1.2 has fallen back to another location. Put the last successfully used CLI
first and preselect it; never execute it without selection. The CLI step lists nothing until the CLIs are found, so an
Enter while they load starts nothing (D71). Other installed/enabled CLIs follow CLIS-1.1 order, then configured
custom CLIs. The bottom items, under a separator labeled `Options`, are
`Change Working Location...` and `Change Name...`; where the location is only a label, that label is the line. The
location item's description shows the full current working location, including `New worktree {branch} from {source}`
for a proposed worktree, and its environment when that is not this machine (D67). The name item's description shows the
full current name. These items edit the values; they are not the only place the current choices appear. A person can
accept the suggested name or leave it empty; an empty name keeps its title segment (`New Agent ·  · main`). Change Name
prefills the current name without a custom prompt; the editor supplies the Enter/Escape instructions.
Invalid configuration shows its reason. With no usable CLI, `Configure Agents...` has the detail
`Install a supported CLI in this environment, or configure its path.` With no folder, use PANEL-1.2's
Open Folder prerequisite picker and its wording instead of the CLI step.
Missing optional Git does not block creation or trigger a Git initialization suggestion. Cancel closes without effects
or changing successful-launch history.

### 1.2 Human location history

**The remembered location is the last human launch whose CLI process successfully started in this workspace.**

On first use, or when that exact location no longer exists/is no longer offered, use the first workspace folder's first
location. WORKTREES-1 keeps the folder as opened first in the catalog; its picker displays the main checkout first
without changing this default. History is a qualified
location ID, never just a branch name. Remember the last successful human CLI choice alongside it.
Picker choices, cancellation, setup completion without CLI start and
failure do not update human launch history. A panel filter does not select a launch location, except that New Agent
from the filtered empty panel (PANEL-1.2) starts at the filtered location, or a filtered folder's own location.
A missing historical location silently uses the default above; the picker
shows the resulting location without an unavailable-location note.

### 1.3 Changing location

**Change Working Location selects folder, then location, and returns to the same CLI picker.**

Use workspace-folder order and skip a single-choice step. Inside a folder, use WORKTREES-1.2's catalog. An ordinary
folder is a normal choice. Offer New Worktree where Git/repository prerequisites exist; where Git is present but a
prerequisite is missing, the location step still shows and says why New Worktree is unavailable. The step shows at once
and adds New Worktree when its check completes. When nothing can be chosen - one folder whose only location is a plain
folder without Git - the picker shows the location as a label, not as an action that does nothing. Retain
Back/selections; Escape cancels the launch. A proposed new branch/location is only created when the person accepts a
CLI. There is no Git initialization or initial-commit path.

The folder step uses `Select a folder`. The repository location step uses `Select a branch or worktree`, without a
folder-name suffix. A location picker without a checkout uses `Select a working location`.

The branch Input Box uses the placeholder `Branch name` and the initial prompt `Starts from {source}`, with
the checkout source label from WORKTREES-2.1. After a valid plan is read, WORKTREES-2.1's shared destination/base preview
and Copy Path action replace that prompt. A field that holds only `git.branchPrefix` is where typing starts: nothing is
said of it until it is edited, and the prefix alone asks `Enter a branch name.` (D130).
The editor supplies the Enter/Escape instructions; Git branch validation remains in effect.

The folder step, shown only in a multi-folder window, ends with `Add Folder to Workspace...`, which runs the editor's
own Add Folder to Workspace command; the folder step then shows again with the first added folder active, and Cancel
returns to it unchanged. While two or more folders are open, each folder row has a `close` button
`Remove Folder from Workspace`; in the location step, each worktree WORKTREES-3.2 can delete has a `close` button
`Delete Worktree`. Each asks first in a modal warning. Folder removal uses
`Remove "{0}" from this workspace? Files stay on disk.` with `Remove`. Worktree deletion uses the short message
`Delete worktree "{0}"?` with `Delete`; its detail is `Folder {0} will be deleted; branch {1} is kept.`, or
`Folder {0} will be deleted (detached HEAD).` for a detached one. The path is complete and untruncated in that detail,
so a long absolute path remains inspectable without turning the decision question into a block of bold text.
Both confirmations add `Its agent will be closed.` or `{0} associated agents will be closed.` to the detail where
agents would close, counting for a worktree the agents of every location inside it, such as a resumed conversation's
subfolder (D130); the worktree detail separates this consequence with a blank line. Cancel changes nothing. A removed folder's agents close under
WORKTREES-3.3, and the folder step shows again, or with one folder left that folder's location step; removing the first
folder restarts the extensions and ends the picker. A confirmed deletion shows the location step again at once without
that worktree, busy until it ends; a refusal is the person's error (RULES-1.8) (D73).

### 1.4 Shared launch entries

**The toolbar, empty state and Command Palette invoke the same New Agent flow; agents start agents through MCP.**

There is no separate New Agent Here entry or public scripted-start command. Missing prerequisites are explained in
the same flow. Agent starts use MCP-2 without human pickers; RULES-4.3 owns YOLO. UI and MCP call the same internal
launch service. Human starts show the new terminal; agent starts remain in the background. All create normal panel
entries in their destination window.
The current filter stays unchanged even when it hides a newly created agent.

### 1.5 Accepted launch and failure

**An accepted launch immediately creates one card and editor terminal before process or tool readiness.**

Reject malformed requests first. Once accepted, keep one pair throughout `creating_worktree`, `launching_cli` and
`running`; tool connection is independent. Do not create a second terminal at transition. An actual creation/process
failure retains that pair red and reports the error to its initiator. A usable CLI whose Facade tools fail remains
usable with the reason in the second line. Native Git post-create setup is not a required phase and does not gate CLI
start. Native login/permission prompts stay in the terminal without a separate popup. An actual tool-connection failure
is distinct from process launch failure and does not terminate a usable CLI.

## 2 Identity and terminal

### 2.1 Names and references

**Names are display-label strings, may be empty, may contain spaces and may repeat; IDs identify runs.**

Trim leading/trailing whitespace and preserve an empty result as `name: ""`, not as an absent field. Do not impose a
uniqueness requirement or add arbitrary
length/character restrictions. `human` is an allowed agent name, including during rename. The person has the distinct
identity `#human`; an agent uses its own run ID, including when named `human`. A display name never overrides an ID.
Human creation provides an editable random name, a short machine word such as `Bolt` or
`Pixel`; agent creation supplies its own `name` under MCP-2.2. A name is not a filesystem path, branch or shell argument
template. Rename uses a native Input Box and changes no run/session/location identity. Copy Agent Reference copies
`@name #aN` without a toast. APIs accept an exact ID or an unambiguous name under RULES-2.3, which also decides
`#human` and `@human`. The name plus ID is descriptive; stale display text must not redirect the run.

### 2.2 Terminal placement and focus

**Each visible agent has one terminal in an editor group; no terminal-panel placement option is provided.**

Human New shows the terminal; agent creation preserves focus. Card/Go to Agent reveals the same terminal without
launching another. Tab title uses the
agent name and, when present, the native tabs separator plus CLI title. Use the CLI's theme-appropriate logo; custom CLIs use a terminal icon. Do not put
status in the name. Native tab renames synchronize the display name when valid. Match terminals by actual identity,
never by a duplicate title. Facade never offers panel placement
as an alternative.

### 2.3 Finding an agent

**Go to Agent searches and opens agents in the current window only.**

Match name, CLI, title, working location and run ID. Accept the existing short ID and a copied agent reference as search
input; an ID in a copied reference matches that run even if its descriptive name is stale. Show the short ID in picker
detail alongside status/location so duplicate names are distinguishable. Include starting/running and retained-error
cards. Copy Reference and Close Agent actions target that exact run. No cross-window picker, focus transfer or proxy
card is provided. The person switches editor windows to manage another window; agents can use MCP across windows.
Terminal-tab context actions require accurate public context; do not substitute the foreground terminal when unknown.

## 3 End and continuity

### 3.1 Close Agent

**Close Agent is the single human action for removing a starting, live or retained-ended agent.**

Card menus, Go to Agent, Command Palette and terminal closure use the lifecycle effect in RULES-4.1: immediate pair
removal and Unpin, with process cleanup in the background where a process exists. There is no separate human Stop Agent command.
MCP keeps `stop_agent` under MCP-3.2 and uses the same close service. Return actual cleanup status to the initiator
without recreating a closed card or claiming an unreachable process is dead; a close while the process is being started
answers how that start's cleanup ended. A close ptyd has not confirmed is recorded, so that a reload ends that run rather
than showing it again (D126). No worktree/files/history deletion is
attached. Closing an agent does not close the agents it started. Unsolicited exits follow RULES-3.3.

Closing a live agent's terminal tab, alone or together with other editors (Close All, Close Others, Close Saved), first
asks once in a modal warning for every tab closed together: `Close {0}?` or `Close {0} agents?`, with `Close Agent` or
`Close Agents`, the detail saying their processes will end. Cancel keeps the agents running and opens their terminals
again with their current screens. `terminal.integrated.confirmOnKill` set to `never` or `panel` closes without asking, as
the editor does for its own terminals. A starting or ended agent's tab closes it without asking. The editor cannot be
stopped from closing the tab itself, so the question follows the close. Messages name an agent with an empty name by its
`#aN`. A tab close whose Unpin cannot be saved keeps the agent, opens its terminal again and tells the person (D126).

### 3.2 Resume picker

**Resume searches vendor histories for this window's folders, subfolders and all associated worktrees.**

Open from panel, empty state or Command Palette; the picker shows at once, busy while the window's locations and
running conversations are read (D130). Read only list metadata, recent activity first, paginated in batches
of 100; search continues beyond the first page. Reuse already read metadata during the picker session rather than
rescanning every log on each page or keystroke. Prefer vendor discovery; do not build a new conversation store.
There is no 30-day age cutoff. A scan limit must not silently make older matching history permanently unreachable.
Deduplicate by environment/CLI/session ID. Each conversation is one line: its CLI's icon and its title, then activity
time and original location; the icon names the CLI, so no CLI name is repeated as text, and search covers title and
location. Use the vendor's saved display title and conversation activity time, including native renames; file maintenance
does not make an old conversation recently active. Ordering remains correct across page boundaries. Omit superseded
history segments when the vendor's continuation points to an existing resumable conversation.
A conversation that cannot be resumed now - its working directory gone, or its CLI turned off or not installed
in this environment - is not listed, nor is one an agent already holds, in this window or another (CLIS-2.4). Do not list
unrelated projects, or provide delete, hide or show-hidden controls. The panel's display filter does not change this history scope.
When a vendor records a set of workspace folders without identifying the original cwd, use Facade's recorded cwd if known.
Otherwise, choosing that conversation opens a native working-location picker for its folders in this window. Do not infer
the original cwd from directory order. Cancellation starts nothing.
If that exact conversation already runs in Facade, do not start it again; reveal it only when it belongs to this window,
otherwise indicate that it is already running. Do not build cross-window navigation. External activity is not a gate:
call vendor resume and return its result. No external-writer scan, lease or concurrency guarantee is required.

### 3.3 Resume execution

**Resume starts an exact saved conversation in its original CLI and location using current CLI startup settings.**

Restore RULES-4.2's conversation context, use RULES-4.3's launch-time YOLO and leave model/effort to the native session and current launch arguments.
Missing original session/location/configuration fails honestly without selecting another session or folder.
For a vendor's ambiguous workspace-folder set under 3.2, the person's explicit location choice supplies the missing cwd.
An accepted Resume creates its pair immediately and retains actual launch failure. Do not acquire an external conversation-writer lease or replay the original creation prompt.
On process start, register the successful cwd under WORKTREES-1.2 and update human launch history under 1.2.

### 3.4 Pin and native editor pins

**Native terminal-tab Pin and Facade Pin express the same exact-conversation restoration intent in both directions.**

Pin from either surface saves RULES-4.2's context and updates the other; Unpin synchronizes too. Native-to-Facade
sync follows `tabGroups` pin changes on that agent's tab. Facade-to-native sync applies the documented
`workbench.action.pinEditor` or `workbench.action.unpinEditor` command when that agent's tab next becomes the active
editor, never stealing focus or revealing a tab just to pin it (ARCHITECTURE-1.2). Ordinary files and external
terminals do not become agents. Match the terminal/run exactly without relying on names or stealing focus.
The adapter must identify and resume the exact session. If a CLI changes that session, update the Pin only after its
new identity is known; never substitute a folder's latest conversation.
Keep the run's link to its saved Pin through a session switch even when saving the new identity fails. Report that failure;
reattachment reconciles the linked Pin before restoration, so a stale saved key cannot start a second, old conversation.
Pin and Unpin are acknowledged only after durable storage succeeds. If a normal exit cannot remove its Pin, retain an ended
failure card with the reason and allow Unpin or Close to retry; do not silently restore that stale intent on reload.
A conversation has one Pin: pinning a card whose conversation is already pinned takes that Pin, moved to the top, and a
pinned card whose CLI switches to a pinned conversation replaces that conversation's other Pin (D126).
Restore Pins once per true opening in saved order in the background, with at most two concurrent launches. A session
already running in Facade is skipped by later windows. Failures retain their individual entries without auto-looping.
Explicit agent close/normal exit removes Pin; whole-window close preserves it.

### 3.5 Reload and remote loss

**Reload and temporary disconnection reuse existing runs; reopening restores saved Pins whose runs ended.**

RULES-4.1 keeps runs for five minutes after disconnect. Reattach those runs before restoring Pins, never duplicating a
conversation still held by Facade: Pins are restored only once the conversations every ptyd of the window holds are
known, and one that does not answer yet delays them. A run that exits between the listing and its reattachment shows
that exit. A failure to clean up a kept record never stops the window's agents from showing (D126). A retained failed
restoration is not retried on reload.

Reconnect output, process/run identity and location before accepting further input. Do not infer closure from terminal
silence or a remote disconnect; RULES-4.1's five minutes after the extension host disconnects is the only time-based
cleanup. Reconcile actual process state; never restart an unknown original run as
a replacement. Proven folder/worktree removal closes affected agents, whereas a temporary Git/read/remote failure does
not; a removal found as the extensions restart closes and unpins as one heard while running does (D126).

## 4 Technical design

### 4.1 One launch transaction

**UI uses one launch service and one run record for the accepted launch.**

Record destination, name, CLI, run YOLO, current effective plan and process facts. Keep the same pair through startup;
restore output by sequence on reload. There is no Facade-managed native Git setup transaction. Repeating a new start is
a new request. Keep sufficient facts to report actual effects. The modules are core/agents, ui/pickers, host/execution and
ptyd.

### 4.2 Observation and deadlines

**Process cleanup is independent of immediate UI removal and reports its actual result.**

Use the owning environment's process handle/group; never kill an unrelated reused PID. Cleanup can escalate directly
when needed and does not impose a mandatory five-second wait. True window-lifetime detection remains required
integration evidence, not a fact established by this document.

## Checks

| Rules | Acceptance |
| --- | --- |
| 1.1–1.5 | Plain/no-Git/multi-folder flow, name and actual location visible while searching, editable name, last CLI/location, filter unchanged, agent starts in the background, immediate pair, usable CLI after a tool failure and initiator-owned errors |
| 2.1–2.3 | Empty/duplicate/spaced names and `human`, editor-only terminals, ID/copied-reference search, distinguishable picker details |
| 3.1–3.5 | One human Close action shared with `stop_agent`, children kept, reload/disconnect reuse, exact Resume, linked Pins, bounded restoration, proven folder/worktree removal |
| 4.1–4.2 | One service, truthful effects, current startup configuration, bounded cleanup without UI wait |

See [Verification](../engineering/VERIFICATION.md). Runtime results remain unverified.

## Change log

- 2026-11-01: From the owner-requested release review: 1.3 counts a worktree's subfolder agents and leaves a branch
  prefix unjudged; 3.1 answers a close during a start, records an unconfirmed close and keeps a tab whose Unpin failed;
  3.2 shows the picker at once; 3.4 keeps one Pin per conversation; 3.5 restores Pins once every ptyd answered (D126, D130).
- 2026-10-31: A native workspace set with no recorded cwd uses an observed Facade cwd or asks for a working location; no directory-order guess (D123).

- 2026-10-31: Added the owner-authorized Resume and linked Pin/Unpin step, using Facade Dots as the reference.

- 2026-10-30: Step 2 of the Facade Code extension: 1.4 and 2.2 add agent starts through MCP in the background; 1.5
  keeps a usable CLI when its Facade tools fail; 2.1 adds agent-supplied names and RULES-2.3's references; 2.3 and 3.1
  add MCP across windows and `stop_agent`.
- 2026-10-31: 1.1 offers configured custom CLIs after the built-ins; 2.2 gives their tabs a terminal icon.

- 2026-10-30: 1.2 starts New Agent from the filtered empty panel at the filtered location; 1.4 leaves the filter as
  it is when a new agent starts (PANEL-2.3).

- 2026-10-30: 1.1's detail with no usable CLI names no CLI, as six built-ins are offered (D77); the settings Configure
  Agents opens list each of them.

- 2026-10-30: Owner-approved after a native reproduction that Close All, Close Others and Close Saved closed every agent
  terminal without a question: 3.1 asks once before ending live agents whose tabs were closed, Cancel reopens their
  terminals, and `terminal.integrated.confirmOnKill` is followed. 1.1 names a remote environment as VS Code's remote
  indicator does. Copy approved by the content author and both reviewers. 3.5 refers to RULES-4.1's five-minute policy
  (D75); 4.1 names the current modules.

- 2026-10-30: Native screenshot review exposed long paths in a bold deletion message. The content author and both
  reviewers approved a short decision question and separate full-path/consequence detail; deletion behavior is unchanged.

- 2026-10-30: Apply the three-reviewer approved IA wording for status, location actions and failure feedback; behavior and deletion safeguards remain unchanged.

- 2026-10-29: The owner approves the shared compact worktree preview and current-plan-only Copy Path action in
  WORKTREES-2.1; New Agent keeps its existing CLI-selection acceptance point.

- 2026-10-29: The owner confirms New Agent's branch input as `Branch name` with `Starts from {source}` below it;
  the editor continues to supply the Enter/Escape hint.

- 2026-10-29: The owner's latest confirmed screenshots use `Select a branch or worktree` without a folder suffix and
  remove Change Name's custom prompt. This supersedes the repeated-name explanation below; naming rules are unchanged.

- 2026-10-29: The owner adopts the content review's `Branch name` placeholder and shorter source prompt, and restores
  `Agent names may repeat; each keeps a unique ID.` Empty names and `human` remain valid under 2.1.

- 2026-10-29: Clarified that main-first picker presentation does not change the remembered/opened launch default.

- 2026-10-29: Owner-approved IA-03: compact titles retain folder/worktree context; proposed worktrees use `(new)` in
  the title and keep their source in the location row. Removed fallback and repeated-name explanations, made the
  no-CLI guidance actionable, and allowed empty names and `human`, with `#human` as the person's distinct identity.

- 2026-10-29: IA-01 retires New Agent Here in favor of the shared launch entry; IA-02 gives the no-folder prerequisite
  its own approved English wording in PANEL-1.2. The regular CLI-selection placeholder is unchanged.

- 2026-10-29: Owner-approved `Options` separator in 1.1; 1.3 adds and removes folders and deletes a worktree (D73).
- 2026-10-29: Step 1 of the Facade Code extension, carried from the Facade Dots specification: the rules step 1
  needs, each with its final number. Later steps add the others.
