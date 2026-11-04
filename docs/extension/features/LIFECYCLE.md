# Agent lifecycle

Layer 3. [Experience](../EXPERIENCE.md) explains use; [Rules](../RULES.md) owns identity, state and lifetime. This
document owns launch, naming, terminal, finding, closing, Resume and Pin interactions.

| Group | Decides |
| --- | --- |
| 1 Launch | Location defaults, pickers, validation and visible start |
| 2 Identity and terminal | Names, tabs, focus and finding agents |
| 3 End and continuity | Close, Resume, Pin, retained errors and window changes |
| 4 Technical design | Launch transaction, recovery and observation |

## 1 Launch

### 1.1 The main picker

**New Agent shows the working location, editable suggested name and CLI choices in one native picker.**

With a folder open, use `New Agent · {name} · {location}` as the title, or `New Agent · {name}` in the window's one
place to work (1.3); placeholder: `Select a CLI`. In a multi-folder window, prefix a checkout's location with its
workspace folder; do not repeat a plain folder's name. A proposed worktree appears as `{branch} (new)` in the title,
with the folder prefix in a multi-folder window. Append the environment only when it is remote, named as VS Code's
remote indicator names it: `SSH: {host}`, `WSL: {distro}` or `Dev Container`; another remote is named by its remote
authority's kind. Only the local window component sees the remote authority, so it reports it with the window identity;
location identities do not change. This summary remains visible while CLI choices are filtered or scrolled, including
when 1.2 has fallen back to another location. Put the last successfully used CLI first and preselect it; never execute
it without selection. The CLI step lists nothing until the CLIs are found, so an Enter while they load starts nothing:
the editor keeps the focused position as items change. Other installed/enabled CLIs follow CLIS-1.1 order, then
configured custom CLIs. CLIs that cannot start here - a configuration error, a configured program that is not found, a
version Facade does not start - follow under a separator labeled `Unavailable`, each with its reason as detail and a
`Configure Agents` button; choosing one opens Configure Agents too. Errors of `facade.custom` that belong to no CLI are
listed there under their setting. A built-in that is not installed, or is turned off, is not listed. The bottom items,
under a separator labeled `Options`, are `Change Working Location...` and `Change Name...`; where nothing can be chosen
(1.3) `Change Name...` is alone there. The location item's description shows the full current working location,
including `New worktree {branch} from {source}` for a proposed worktree, and its environment when that is not this
machine. The name item's description shows the full current name. These items edit the values; they are not the only
place the current choices appear. A person can accept the suggested name or leave it empty; an empty name keeps its
title segment (`New Agent ·  · main`). Change Name uses the title `New Agent · Change Name` and the placeholder `Agent
name`, and prefills the current name with no prompt of its own; the editor supplies the Enter/Escape instructions. With
no usable CLI, `Configure Agents...` has the detail `Install a supported CLI in this environment, or configure its
path.`; where the CLIs cannot be listed at all, it carries that failure as its detail. With no folder, use PANEL-1.2's
Open Folder prerequisite picker and its wording instead of the CLI step. Missing optional Git does not block creation or
trigger a Git initialization suggestion. Cancel closes without effects or changing successful-launch history.

### 1.2 Human location history

**The remembered location is the last human launch whose CLI process successfully started in this workspace.**

On first use, or when that exact location does not exist or is not offered now, use the first workspace folder's first
location. WORKTREES-1 keeps the folder as opened first in the catalog; its picker displays the main checkout first
without changing this default. History is a qualified location ID, never just a branch name. Remember the last
successful human CLI choice alongside it. Picker choices, cancellation, setup completion without CLI start, failure and
automatic Pin restoration (3.4) do not update human launch history. A panel filter does not select a launch location,
except that New Agent from the filtered empty panel (PANEL-1.2) starts at the filtered location, or a filtered folder's
own location. A missing historical location silently uses the default above; the picker shows the resulting location
without an unavailable-location note.

### 1.3 Changing location

**Change Working Location selects folder, then location, and returns to the same CLI picker.**

Use workspace-folder order and skip a single-choice step. Inside a folder, use WORKTREES-1.2's catalog. An ordinary
folder is a normal choice. In a folder inside a Git repository, the location step offers New Worktree, its row `New
Worktree...` naming its source as `from {branch}` (WORKTREES-2.1); where a prerequisite is missing - no commit yet, no
native creation - that row shows why as its detail and cannot be chosen (WORKTREES-2.3). The step shows at once and adds
the row when its check completes. A folder in no repository, or where Git is missing, is a plain folder and has no New
Worktree row; when nothing can be chosen - one folder whose only location is a plain folder - the picker offers no
location change, as an action that does nothing would be. Once Git found no repository there, or is missing, that folder
is the window's one place to work, which goes without saying: the title does not name it, nor does a Resume Agent line
(3.2), and where every agent works there neither do cards (PANEL-1.3) or Go to Agent rows (2.3), and the panel offers no
filter (PANEL-2.3); hovers keep it. A second folder, a repository found there, a worktree or a location Resume
remembered ends it, and an agent working elsewhere ends it for the panel and Go to Agent: each names its location again.
Retain Back/selections; Escape cancels the launch. A proposed new branch/location is only created when the person
accepts a CLI. There is no Git initialization or initial-commit path.

The creation substeps use `New Agent · Select Folder`, `New Agent · Working Location`, and
`New Agent · New Worktree` as titles. A plain folder is still a working location. The main CLI picker retains
1.1's name/location context. Titles do not add steps or change Back/Escape behavior.

The folder step uses `Select a folder`. The repository location step uses `Select a branch or worktree`, without a
folder-name suffix. A location picker without a checkout uses `Select a working location`. A folder row shows the
folder's name, the folder that holds it (the home folder as `~`) and the icon of the location it opened - folder,
repository or worktree; a location row shows the location's label, its path from the home folder and its kind's icon.

The branch Input Box uses the placeholder `Branch name` and the initial prompt `Starts from {source}`, with
the checkout source label from WORKTREES-2.1. After a valid plan is read, WORKTREES-2.1's shared destination/base preview
and Copy Path action replace that prompt. A field that holds only `git.branchPrefix` is where typing starts: nothing is
said of it until it is edited, and the prefix alone asks `Enter a branch name.`
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
subfolder; the worktree detail separates this consequence with a blank line. Cancel changes nothing. A removed folder's
agents close under WORKTREES-3.3, and the folder step shows again, or with one folder left that folder's location step;
removing the first folder restarts the extensions and ends the picker. A confirmed deletion shows the location step
again at once without that worktree and the locations inside it, busy until it ends; one deletion runs at a time, so
meanwhile no row offers Delete Worktree. A refusal is the person's error (RULES-1.8). Where the folder of the current
location was removed, or its worktree deleted, during the flow, Back to the CLI picker starts at the first folder's first
location (1.2).

### 1.4 Shared launch entries

**The toolbar, empty state and Command Palette invoke the same New Agent flow; agents start agents through MCP.**

Missing prerequisites are explained in the same flow; there is no public scripted-start command. Agent starts use MCP-2
without human pickers; RULES-4.3 owns YOLO. UI and MCP call the same internal launch service. Human starts show the new
terminal; agent starts remain in the background. All create normal panel entries in their destination window.
The current filter stays unchanged even when it hides a newly created agent.

### 1.5 Accepted launch and failure

**An accepted launch immediately creates one card and its terminal before process or tool readiness.**

Reject malformed requests first. A human launch refused before acceptance - its location gone meanwhile, its workspace
owned by another window - creates no card and says why with WORKTREES-2.2's `Could not start {name}: {reason}.`, the
CLI's name standing for an empty name. Once accepted, keep one pair throughout `creating_worktree`, `launching_cli` and
`running`; tool connection is independent. A person's launch opens the terminal's editor tab; an agent's start leaves it
hidden until the person opens the agent (2.2). Do not create a second terminal at transition. An actual creation/process
failure retains that pair red, its terminal stating the reason in a dim line of Facade's own, and reports the error to
its initiator; a process that ends leaves a dim line with its exit code or signal in the same way. A usable CLI whose
Facade tools fail remains usable with the reason in the second line. Native Git post-create setup is not a required
phase and does not gate CLI start. Native login/permission prompts stay in the terminal without a separate popup. An
actual tool-connection failure is distinct from process launch failure and does not terminate a usable CLI.

## 2 Identity and terminal

### 2.1 Names and references

**Names are display-label strings, may be empty, may contain spaces and may repeat; IDs identify runs.**

Trim leading/trailing whitespace and preserve an empty result as `name: ""`, not as an absent field. Do not impose a
uniqueness requirement or add arbitrary length/character restrictions. `human` is an allowed agent name, including
during rename. The person has the distinct identity `#human`; an agent uses its own run ID, including when named
`human`. A display name never overrides an ID. Human creation suggests an editable random name from at least 100 short
machine words such as `Bolt`, `Pixel` or `Servo`, preferring one no agent of the window has (ignoring case) without
requiring uniqueness; agent creation supplies its own `name` under MCP-2.2. A name is not a filesystem path, branch or
shell argument template. CLI titles, activity and task progress never rename the agent; the creation name stays until
the person explicitly renames it. Rename uses a native Input Box prefilled with the current name and changes no
run/session/location identity. An agent's reference is `@name #aN`, or `#aN` alone for an agent with an empty name,
wherever Facade shows it to a person or an agent; Go to Agent's copy button copies it without a toast. APIs accept an
exact ID or an unambiguous name under RULES-2.3, which also decides `#human` and `@human`. The name plus ID is
descriptive; stale display text must not redirect the run.

### 2.2 Terminal placement and focus

**Each agent has one terminal, shown in at most one editor tab; a group shows at most one unpinned agent tab, and
closing a tab hides it.**

An agent's card is the agent; its terminal's editor tab is a view of it, opened where the person wants to see it, and
the panel is where the person switches between agents. The person's New Agent and Resume open the new agent's tab in the
active editor group and focus it; an agent another agent starts has its card alone, its tab hidden, taking no focus and
covering nothing. A card's click or Enter, Go to Agent and a notification's Show open the agent's tab in the active
group and focus it, or focus it where it is open already, without moving it. Each editor group shows at most one
unpinned agent tab, beside any number of pinned agents' tabs, their pin marks shown or still to follow (3.4), and the
person's other editors: opening an unpinned agent's tab in a group hides that group's other unpinned agent tab, its
agent running on. Closing an agent's tab - its close button, Close Editor, Close All, Close Others, Close Editors and
Group, Kill All Terminals - hides it, without a question: the agent runs on and its card opens it again; ending an agent
is Close Agent's (3.1). The person's close of a tab showing its pin mark Unpins its agent as well (3.4). Hiding keeps
the agent's screen, its draft and its Facade tools, and a starting agent hidden goes on starting. A hidden agent keeps
the size its tab last had, and one whose tab never opened has 120 columns and 30 rows. Where an editor operation leaves
two unpinned agent tabs in one group, the group keeps one and hides the others: after an Unpin, its active one, else the
one just unpinned; after a tab is moved in - dragged, by a Move Editor command or from another window - the one moved;
where groups join, a Close Group that moves its tabs into another included, or a reload restores tabs of groups gone
into one (3.5), its active one, else the one last active. A pinned agent's tab moved in hides none, and an Unpin whose
save is undone hides nothing. Facade knows which agent a tab shows from the editor's own reports - the tab that opens
with a terminal Facade opened, the tab that becomes active with its terminal, and, where one tab closes while its
terminal stays open and one opens, those two as one tab moved - never from Tab objects, which the editor may replace
without a report. A tab those leave unknown, as several moved at once can, counts for no agent until it next becomes
active with its terminal: it hides nothing and Unpins nothing, and its agent keeps its last known group for a reload. A
terminal shows in one tab at a time. Where the editor copies an agent's tab - a split in any direction, a copying drag,
Copy into New Window - the agent stays where it is. The editor reports a copy as a new terminal with neither a shell nor
a pseudoterminal of its own, under the name the copied tab was opened with - a terminal with either is never a copy: the
copy is of the agent whose open tab Facade opened under that name, where exactly one was, and in its place Facade starts
a new agent of the same CLI and location, with the model and effort the first was started with where it had any and its
CLI's defaults otherwise, under a new name, in a new conversation with no prompt, its tab focused and its start, failure
and location history as New Agent's (1.2, 1.5); the copy, which has no process, closes once the new tab is open, or as
the launch is refused before acceptance (1.5), the person told why as New Agent's would; a copy whose agent Facade
cannot tell - a name two open agent tabs bear, or several copies at once, as Copy into New Window makes of a whole group
- closes, starting nothing; the first agent stays as it was throughout. A reload brings the open tabs back (3.5). At
most one unpinned agent terminal per group draws, besides the pinned ones, while ptyd keeps every agent's process and
screen (ARCHITECTURE-2.3).

The tab shows only the agent name beside the CLI's theme-appropriate logo; custom CLIs use a terminal icon. While its
card's dot is green (RULES-3.2), a spinner frame turns between the logo and the name every 100 ms, for every CLI: the
braille frames `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`. Editor tabs draw no icon in a label, so the frame is text before the name in the tab's
title; the spinner's frames are never taken for a rename. When the agent is not busy the tab shows its name alone,
keeping no blank space for the frame. Under reduced motion - `workbench.reduceMotion` `on`, or `auto` with the system
asking for it - the tab keeps one frame still (UX-2.2). Built-in tab logos use contributed native icons, with their
brand colors and theme foreground for monochrome marks. They remain recognizable in light, dark and high-contrast
themes, including after a theme change or terminal restoration. This uses the public icon API; it does not patch editor
styles or change the person's theme. CLI titles and other status remain in PANEL-1.4's second line, never appended to
the tab name. Do not add a name length limit or change the editor's tab-width settings. Native tab renames synchronize
the complete display name when valid, without removing text that resembles a CLI title. Match terminals by actual
identity, never by a duplicate title. Facade never offers panel placement as an alternative. An agent's terminal passes
the person's input to its CLI as typed, except a mouse report the editor could not measure. The editor reports a click's
release after it opens a clicked link, and a link opened over an editor terminal takes the terminal out of the page
first: the release then has no position (`ESC[<0;NaN;NaNm` in the SGR encoding), which a CLI shows as typed text. Such a
report, in any mouse encoding, takes the position of the report before it - for a release, its press; one with none
before it is left out. An Enter the person types waits briefly for the CLI's input reader to read what it submits
(CLIS-2.1, PANEL-1.4); a CLI without an input reader takes it at once. A file dropped onto an agent's terminal gives it
its path only with Shift held, as the editor requires of every terminal in the editor area; an extension cannot change
that.

### 2.3 Finding an agent

**Go to Agent searches and opens agents in the current window only.**

Match name, CLI, title, state, working location and run ID. Accept the existing short ID and a copied agent reference as
search input; an ID in a copied reference matches that run even if its descriptive name is stale. Use one native picker
line: CLI icon, prominent name, then quieter short ID, current state, working location - none where every agent works in
the window's one place to work (1.3), which search still matches - and CLI title, in that order. An empty name uses the
short ID as the prominent identifier, with state/location/title after it. The icon identifies the CLI; its name stays
searchable without being repeated in the row. Keep name and title even when equal; omit only missing fields. Native
width clipping never changes the stored or searchable text. Include starting/running and retained-error cards in panel
order, whatever the panel's filter shows; rows follow changes while the picker is open. Choosing a row closes the picker
and reveals that terminal. Each row's buttons copy its reference (2.1) and close that exact run, both keeping the picker
open. No cross-window picker, focus transfer or proxy card is provided. The person switches editor windows to manage
another window; agents can use MCP across windows.

## 3 End and continuity

### 3.1 Close Agent

**Close Agent is the single human action for removing a starting, live or retained-ended agent.**

Card menus, Go to Agent's close button and the Command Palette use the lifecycle effect in RULES-4.1: immediate pair
removal and Unpin, with process cleanup in the background where a process exists. There is no separate human Stop Agent
command. MCP keeps `stop_agent` under MCP-3.2 and uses the same close service. Return actual cleanup status to the
initiator without recreating a closed card or claiming an unreachable process is dead: a person whose close - from a
card menu, Go to Agent or the Command Palette - could not end the process is told `{0} was closed, but its process could
not be terminated.`, and an unconfirmed cleanup is reported as neither. A close while the process is being started
answers how that start's cleanup ended. A close ptyd has not confirmed is recorded, so that a reload ends that run
rather than showing it again. No worktree/files/history deletion is attached. Closing an agent does not close the agents
it started. Unsolicited exits follow RULES-3.3. A close whose Unpin cannot be saved keeps the agent (RULES-4.1); from
the card, the palette or Go to Agent the person is told `Could not close {0}: {1}`.

Closing an agent's terminal tab, alone or with other editors, never ends it: the tab is hidden (2.2), with no question,
whether the agent is starting, running or ended, and its card stays until the person closes it here. These are a
person's ways to end an agent by hand; its own exit, a removed location and a closed window still end it as RULES-3.3,
2.4 and 4.1 say. Messages name an agent with an empty name by its `#aN`.

### 3.2 Resume picker

**Resume searches vendor histories for this window's folders, subfolders and all associated worktrees.**

Open from panel, empty state or Command Palette; the picker shows at once, busy while the window's locations and running
conversations are read. With no folder open, its one item `Open Folder...`, detail `Open a folder to resume its
conversations.`, runs the editor's Open Folder as PANEL-1.2's does. Read only list metadata, recent activity first,
paginated in batches of 100: the next batch is read when the person comes within 10 rows of the end, and on to the last
while a search is typed. A batch that has taken 1,000 conversation records ends early and the next goes on, so no scan
limit makes older matching history unreachable. Reuse already read metadata during the picker session rather than
rescanning every log on each page or keystroke. Reading the histories keeps the window's agents responsive: the stores
are read together, each folder's real path is resolved once per reading rather than per conversation, and no long
synchronous read holds the extension host that draws their terminals. Prefer vendor discovery; do not build a new
conversation store. There is no 30-day age cutoff. Deduplicate by environment/CLI/session ID. Each conversation uses the
same single-line native presentation as Go to Agent: its CLI icon and prominent conversation title, then quieter
activity time, original location - none for the window's one place to work itself (1.3), which search still matches, a
subfolder of it still named - and saved Facade name, in that order. A conversation without a title is `Untitled
conversation`. Omit a missing or empty name without generating one while browsing. Keep the saved name even when it
equals the title. The icon names the CLI, so no CLI name is repeated as text; search covers title, saved name, CLI and
location, including beyond the first page. Use the vendor's saved display title and conversation activity time,
including native renames; file maintenance does not make an old conversation recently active. Ordering remains correct
across page boundaries. Omit a history segment whose vendor continuation points to an existing resumable conversation.
With nothing to list, the placeholder says `No saved conversations in this window's folders`; where the histories or the
window's state cannot be read, a notification says `Could not read the saved conversations: {0}`. A conversation that
cannot be resumed now - its working directory gone, or its CLI turned off or not installed in this environment - is not
listed, nor is one an agent already holds, in this window or another (CLIS-2.4). Do not list unrelated projects, or
provide delete, hide or show-hidden controls. The panel's display filter does not change this history scope. When a
vendor records a set of workspace folders without identifying the original cwd, use Facade's recorded cwd if known.
Otherwise, choosing that conversation opens a native working-location picker for its folders in this window, each with
its full path. Do not infer the original cwd from directory order. Cancellation starts nothing. If that exact
conversation already runs in Facade, do not start it again; reveal it only when it belongs to this window, otherwise say
`{0} is already running in another window.` Do not build cross-window navigation. External activity is not a gate: call
vendor resume and return its result. No external-writer scan, lease or concurrency guarantee is required.

### 3.3 Resume execution

**Resume starts an exact saved conversation in its original CLI and location using current CLI startup settings.**

Restore RULES-4.2's conversation context, use RULES-4.3's launch-time YOLO and leave model/effort to the native session
and current launch arguments.
Manual Resume keeps a nonempty saved Facade name. A missing or empty saved name receives a random short name from
New Agent's suggestions (2.1) only when the launch is accepted, avoiding current-window names where possible; it is
saved with the conversation once the process starts, for subsequent Resume. Never derive the name from the conversation
title or CLI ID. Existing saved names, including long ones, remain unchanged. Ordinary reload and automatic Pin
restoration preserve their recorded names, including empty ones.
Missing original session/location/configuration fails honestly without selecting another session or folder; a Resume
refused before acceptance says `Could not resume {0}: {1}` with the conversation's title.
For a vendor's ambiguous workspace-folder set under 3.2, the person's explicit location choice supplies the missing cwd.
An accepted Resume creates its pair immediately and retains actual launch failure. Do not acquire an external
conversation-writer lease or replay the original creation prompt.
On process start, register the successful cwd under WORKTREES-1.2 and update human launch history under 1.2.

### 3.4 Pin and native editor pins

**Native terminal-tab Pin and Facade Pin express the same exact-conversation restoration intent in both directions.**

Pin from either surface saves RULES-4.2's context and updates the other; Unpin synchronizes too. Native-to-Facade sync
follows `tabGroups` pin changes on that agent's tab. Facade-to-native sync applies the documented
`workbench.action.pinEditor` or `workbench.action.unpinEditor` command when that agent's tab next becomes the active
editor, never stealing focus or revealing a tab just to pin it (ARCHITECTURE-1.2). Ordinary files and external terminals
do not become agents. A close the editor reports as the person's, of an agent tab showing its pin mark - its Close,
Close Editors and Group, Close All Groups, Kill All Terminals - Unpins the agent and hides its tab; an Unpin that cannot
be saved opens the tab again, pinned, and says `Could not unpin {0}: {1}`. A pinned agent's tab whose mark is still to
follow shows none, and its close hides it alone, keeping the Pin. Closing a floating editor window closes its tabs,
marked ones included, as the person's closes do, so a marked one there Unpins as well. The editor's Close All and Close
Others leave marked tabs open, and a tab gone with a reload, a move, the extensions' restart or the window's close
changes no Pin. A tab Facade cannot tell (2.2) may be pinned or unpinned natively meanwhile: once the tab is known, a
change of its mark that Facade saw after the agent's last Pin or Unpin from its card or Facade is the latest and wins,
Pinning or Unpinning the agent; otherwise - no change seen, or a Pin or Unpin made after it - Facade's Pin stands and
the mark follows it. Pinning or unpinning a hidden agent from its card keeps its tab hidden; the tab, once opened, shows
its Pin. Match the terminal/run exactly without relying on names or stealing focus. A native Pin or Unpin that cannot be
saved is undone on the tab, and the person is told `Could not pin {0}: {1}` or `Could not unpin {0}: {1}`; a native pin
of an agent that cannot be pinned is undone. The adapter must identify and resume the exact session. A run whose CLI
does can be pinned from its start, and across a reload: a conversation Facade resumed is saved already, and a new one
can be pinned before its CLI names it - before its first message for CLIs that name it then. Such a Pin takes the
conversation the CLI names; a window opened before that starts a new conversation of the same CLI with the Pin's name
and location in its place. If a CLI changes that session, update the Pin only after its new identity is known; never
substitute a folder's latest conversation. Keep the run's link to its saved Pin through a session switch even when
saving the new identity fails. Report that failure; reattachment reconciles the linked Pin before restoration, so a
stale saved key cannot start a second, old conversation. Pin and Unpin are acknowledged only after durable storage
succeeds. If a normal exit cannot remove its Pin, retain an ended failure card with the reason, tell the person
`Could not unpin {0}: {1}`, and allow Unpin or Close to retry; do not silently restore that stale intent on reload. A
conversation has one Pin: pinning a card whose conversation is already pinned takes that Pin, moved last among the Pins
(PANEL-2.1), and a pinned card whose CLI switches to a pinned conversation replaces that conversation's other Pin. Each
activation, after reattachment (3.5), restores in the background the Pins no run holds, in saved order and at most two
at a time (RULES-4.2), each with its tab open in the active group, without focus, its pin mark following when it is next
active - pinned agents' tabs never hide one another (2.2); a reload therefore restarts none that still run or were
retained as failures. A session already running in Facade is skipped by later windows. A failure keeps its own red card,
which holds its Pin and says why, without auto-looping; closing it Unpins. One notification for the restoration says
what failed, with Show: `Could not restore {0}: {1}` for one Pin,
`Could not restore {0} pinned agents. Their cards show why.` for several. A Pin refused before any card - its window
cannot number agents (RULES-2.2), or `facade.yolo` holds neither true nor false (UX-4.1) - has no card and is kept for
the next opening; the notification then names it with its reason, which holds for the others too. Explicit agent
close/normal exit removes Pin; whole-window close preserves it.

### 3.5 Reload and remote loss

**Reload and temporary disconnection reuse existing runs; reopening restores saved Pins whose runs ended.**

RULES-4.1 keeps runs for its grace after disconnect. Reattach those runs before restoring Pins, never duplicating a
conversation still held by Facade: Pins are restored only once the conversations every ptyd of the window holds are
known, and one that does not answer yet delays them. A run that exits between the listing and its reattachment shows
that exit. A failure to clean up a kept record never stops the window's agents from showing. A retained failed
restoration is not retried on reload. A reload brings each agent's open tab back (2.2) in its group - the last group
where theirs is gone - pinned or not, in the background without focus, and hidden ones stay hidden; a run or retained
failure from a build that kept no tab record comes back hidden, a pinned one's tab opening in the active group. A run
keeps whether its tab is open, and in which group, with its process (ARCHITECTURE-3.1); a retained failure and a start
waiting its turn keep them with their records.

Reconnect output, process/run identity and location before accepting further input. Do not infer closure from terminal
silence or a remote disconnect; RULES-4.1's grace after the extension host disconnects is the only time-based cleanup.
Reconcile actual process state; never restart an unknown original run as a replacement: a window that claims the
workspace while the grace is ending its runs waits for those ends, within the five seconds cleanup takes (4.2), before
it restores Pins. A run whose end is not confirmed stays listed as uncertain, holding its conversation, its Pin not
restored beside it, and shows a red card whose second line says `Could not confirm that it stopped`, where Close Agent
ends it again; once its exit is heard the card goes and its Pin is restored as an ended run's. Proven folder/worktree
removal closes affected agents, whereas a temporary Git/read/remote failure does not; a removal found as the extensions
restart closes and unpins as one heard while running does.

## 4 Technical design

### 4.1 One launch transaction

**UI uses one launch service and one run record for the accepted launch.**

Record destination, name, CLI, run YOLO, current effective plan and process facts. Keep the same pair through startup;
restore output by sequence on reload. There is no Facade-managed native Git setup transaction. Without a request_id
(MCP-1.1), repeating a start is a new request. Keep sufficient facts to report actual effects. The modules are
core/agents, ui/pickers, host/execution, host/locations (worktree creation), host/clis and clis (planning), and ptyd.

### 4.2 Observation and deadlines

**Process cleanup is independent of immediate UI removal and reports its actual result.**

Use the owning environment's process handle/group; never signal a process already reaped, whose PID may be another's
now. Cleanup hangs up the process group, as a closed terminal would, and kills it where it has not ended 3 s later, its
end confirmed once its exit is heard within 2 s of the kill and unconfirmed otherwise; on Windows the console is ended
once. No UI waits for it.

## Checks

| Rules | Acceptance |
| --- | --- |
| 1.1–1.5 | Plain/no-Git/multi-folder flow, name and actual location visible while searching - the window's one place to work left unsaid -, editable name, last CLI/location, filter unchanged, agent starts in the background, immediate pair, usable CLI after a tool failure and initiator-owned errors |
| 2.1–2.3 | Empty/duplicate/spaced names and `human`, icon plus name-only tabs through CLI title updates and reloads, a busy tab's spinner, literal native renames, editor-only terminals, one unpinned agent tab per group, hidden tabs and agent-started agents without one, tabs known by the editor's reports and unknown ones acting on none, a copied tab starting a new agent of its CLI and location where exactly one open tab bears its name, tabs restored per group, ID/copied-reference search, distinguishable picker details |
| 3.1–3.5 | One human Close action shared with `stop_agent`, a closed tab hiding its agent, children kept, reload/disconnect reuse, exact Resume, linked Pins and the person's close of a marked tab Unpinning, bounded restoration with pinned tabs, marks following when active, a mark changed on a tab Facade could not tell winning once it is known only where no Pin or Unpin came after it, no restoration beside an uncertain end, an uncertain end's red card, proven folder/worktree removal |
| 4.1–4.2 | One service, truthful effects, current startup configuration, bounded cleanup without UI wait |

Evidence: [Verification](../engineering/VERIFICATION.md).
