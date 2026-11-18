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

On the Rust engine, offer a Machine step when the Facade network has another machine. Preselect This machine and show
its name. The current window's Facade machine determines which machine is local. For another machine, offer the working
locations its connected windows supply and allow an absolute path on that machine. With no selected path, use its login
home. List only the CLIs available in its login environment. Allow returning to Machine while a query is pending, with a
three-second bound on querying other machines. Changing machines clears the prior location and CLI choices. On confirmation,
preflight the location and CLI before starting. A preflight failure preserves the choices and shows its reason.

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
added entries (CONFIGURATION-2.1). All CLI icons follow CONFIGURATION-2.4. CLIs that cannot start here - a configuration
error, a configured program that is not found, a version Facade does not start - follow under a separator labeled
`Unavailable`, each with its reason as detail and a
gear button labeled `Open Settings`; choosing the row also runs Open Settings. It follows CONFIGURATION-1.2:
show Facade Code's Settings section on the Remote tab in a remote window, or User tab locally; its
Edit in facade.json link opens or creates the file. Remote windows whose Settings open as JSON open facade.json
directly. On a migration conflict, that link shows the error and opens the old editor settings JSON (CONFIGURATION-6.2).
There is no gear at the picker's upper right. File-level errors
show the file path and available line/column information, with Open Settings. Check configuration errors before
`enabled`: a valid disabled entry is not listed; an invalid disabled entry still appears under Unavailable with its
error. An uninstalled built-in with no configuration error is not listed.
The bottom items,
under a separator labeled `Options`, are `Change Working Location...` and `Change Name...`; where nothing can be chosen
(1.3) `Change Name...` is alone there. The location item's description shows the full current working location,
including `New worktree {branch} from {source}` for a proposed worktree, and its environment when that is not this
machine. The name item's description shows the full current name. These items edit the values; they are not the only
place the current choices appear. A person can accept the suggested name or leave it empty; an empty name keeps its
title segment (`New Agent ·  · main`). Change Name uses the title `New Agent · Change Name` and the placeholder
`Leave blank for an unused name, or its ID`. It prefills the current name with no prompt of its own; the editor
supplies the Enter/Escape instructions. With no usable CLI, `Open Settings` has the detail `Install a supported CLI in this environment, or configure its
path.`; where the CLIs cannot be listed at all, it carries that failure as its detail. A configuration error also
offers this item. It follows the same Open Settings flow. With no folder, a local launch uses PANEL-1.2's
Open Folder prerequisite picker and its wording instead of the CLI step. Missing optional Git does not block creation or
trigger a Git initialization suggestion. Cancel closes without effects or changing successful-launch history.

### 1.2 Human location history

**The remembered location is the last human launch whose CLI process successfully started in this workspace.**

On first use, or when that exact location does not exist or is not offered now, use the first workspace folder's first
location; one remembered in a Resume cwd recorded within a location - a resumed conversation's own - normalizes to that
anchor location (WORKTREES-1.2), no separate choice. WORKTREES-1 keeps the folder as opened first in the catalog; its picker displays the main checkout first
without changing this default. History is a qualified location ID, never just a branch name. Remember the last
successful human CLI choice alongside it. Picker choices, cancellation, setup completion without CLI start, failure and
automatic Pin restoration (3.4) do not update human launch history. A panel filter does not select a launch location,
except that New Agent from the filtered empty panel (PANEL-1.2) starts at the filtered location, or a filtered folder's
own location. A missing historical location silently uses the default above; the picker shows the resulting location
without an unavailable-location note.

### 1.3 Changing location

**Change Working Location selects folder, then location, and returns to the same CLI picker.**

Use workspace-folder order and skip a single-choice step. Inside a folder, use WORKTREES-1.2's catalog. An ordinary
folder is a normal choice. In a folder inside a Git repository, the location step offers New Worktree, its row
`New Worktree...` naming its source as `from {branch}` (WORKTREES-2.1); where a prerequisite is missing - no commit yet,
no native creation - that row shows why as its detail and cannot be chosen (WORKTREES-2.3). The step shows at once and
adds the row when its check completes. A folder in no repository, or where Git is missing, is a plain folder and has no
New Worktree row; when nothing can be chosen - one folder whose only location is a plain folder - the picker offers no
location change, as an action that does nothing would be. Once Git found no repository there, or is missing, that folder
is the window's one place to work, which goes without saying: the title does not name it, nor does a Resume Agent line
(3.2), and where every agent works there neither do Go to Agent rows (2.3), and the panel offers no filter (PANEL-2.3);
details keep it, and cards show no location anywhere (PANEL-1.3). A second folder, a repository found there or a worktree
ends it, and an agent working elsewhere ends it for the panel and Go to Agent: each
names its location again. Retain Back/selections; Escape cancels the launch. A proposed new branch/location is only
created when the person accepts a CLI. There is no Git initialization or initial-commit path.

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
Both confirmations add `Its agent will be stopped.` or `{0} associated agents will be stopped.` to the detail where
agents would close, counting for a worktree the agents of every location inside it and of every Resume cwd within them,
recorded or not yet (WORKTREES-1.2); the worktree detail separates this consequence with a blank line. Cancel changes nothing. A removed folder's
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

**Names are trimmed display labels; blank names are filled in, and IDs identify runs.**

Names may contain spaces and repeat. Do not impose uniqueness or arbitrary length/character restrictions. `human`
is allowed, including during rename; the person has the distinct identity `#human`, and an agent keeps its own ID.
A display name never overrides an ID.

New Agent and Resume without a saved name suggest an editable random name from `facade.json`'s `names`, or the 140
built-in names when that field is absent (CONFIGURATION-1.4). Choose only names no agent in this window uses, ignoring
case and surrounding spaces. A blank name at start or rename is filled the same way. When the list is empty or every
name is taken, use the new agent's ID, such as `#a1`. Invalid `names` blocks every start with its file position.
Agent creation supplies `name` under MCP-2.2 and applies the same blank-name rule.

A name equal to the agent's ID is not saved for Resume or Pin: the next agent gets a new name. A name is not a
filesystem path, branch or shell argument template. CLI titles, activity and task progress never rename an agent.
Rename uses a native Input Box prefilled with the current name, with the placeholder
`Leave blank for an unused name, or its ID`, and changes no run/session/location identity.
An agent's reference is `@name #aN`, or `#aN` alone when an older record has no name.
Go to Agent's copy button copies it without a toast. APIs accept an exact ID or unambiguous name under RULES-2.3,
which also decides `#human` and `@human`. Stale display text never redirects a run.

### 2.2 Terminal placement and focus

**Each window shows an agent's terminal in at most one tab. Closing the tab hides its view.**

An agent's card is the agent; its terminal's editor tab is a view of it, opened where the person wants to see it, and
the panel is where the person switches between agents. The person's New Agent and Resume open the new agent's tab in the
active editor group and focus it; an agent another agent starts has its card alone, its tab hidden, taking no focus and
covering nothing. A card's click or Enter, Go to Agent and a notification's Show open the agent's tab in the active
group and focus it, or focus it where it is open already, without moving it, its group then the active one through the
editor's focus commands, past the eighth group by group, each step checked, the agents' terminals it passes taking none of
the person's keys meanwhile (3.4): the editor shows an extension's terminal in its own group without always making that
group active, and the person's next command acts on the active group's front tab. A group shows any number of agent tabs, pinned or not, beside the person's other
editors, as it shows any editors: opening one hides no other, because a tab is a view the person chose to open, and
no other tab's opening closes it. Closing an agent's tab - its close button, Close Editor, Close All, Close Others, Close Editors and
Group, Kill All Terminals - hides it, without a question: the agent runs on and its card opens it again. The card's Stop Agent and
Dismiss Agent actions follow 3.1. The person's close of a tab showing its pin mark Unpins its agent as well (3.4). Hiding keeps
the agent's screen, its draft and its Facade tools, and a starting agent hidden goes on starting. A hidden agent keeps
the size its tab last had, and one whose tab never opened has 120 columns and 30 rows. Tabs moved, dragged, joined into
one group or restored there stay open as they are. Facade knows which agent a tab
shows from the editor's own reports - the tab that opens
with a terminal Facade opened, the tab that becomes active with its terminal, and, where one tab closes while its
terminal stays open and one opens, those two as one tab moved - never from Tab objects, which the editor may replace
without a report. A tab those leave unknown, as several moved at once can, counts for no agent until it next becomes
active with its terminal: a change of its mark acts once it is known (3.4), the person's close of it
Unpins as 3.4 says, and its agent keeps its last known group for a reload. A
terminal shows in one tab at a time. Where the editor copies an agent's tab - a split in any direction, a copying drag,
Copy into New Window - the agent stays where it is. The editor reports a copy as a new terminal with neither a shell nor
a pseudoterminal of its own, under the name the copied tab was opened with - a terminal with either is never a copy.
Each copy, one of several at once as Copy into New Window makes of a whole group included, becomes at once an ordinary
terminal in its place - the editor's default terminal profile, its icon and title the editor's own - in the folder of
the agent whose open tab Facade opened under that name: where several open tabs bear it, the folder their agents share,
and where their folders differ the editor's default folder, as a name alone cannot tell which was copied and the editor
tells an extension nothing more. That is what the editor's own split of a terminal tab gives. Facade starts no agent for it. A split is a layout gesture, and a new
agent - a process, a card, a number and a conversation - is too lasting a thing for a gesture to leave behind; New Agent
starts one beside on purpose. The copy, which has no process, closes as that terminal comes to the front, so that its
group never goes empty; the editor draws the copy before Facade hears of it, so it shows for a moment, which no
extension can prevent. The agent stays as it was throughout. A reload or an extension-host restart is the one exception to
a tab staying open (3.5): every agent's process and card survive it, but only the pinned agents' tabs open again; every other agent's
tab stays hidden until the person opens it from its card, and once the pinned tabs are open the last one opened
successfully is in front, its group the active one, and its card selected. Rust member windows can show the same
agent's screen at once. The last resize determines its dimensions, including a resize from a terminal attach. Core uses
the last resizing member editor for the CLI's colors and follows its theme updates (ARCHITECTURE-2.3). Each window
keeps its own tab position and focus. The old engine keeps the process and screen in ptyd.

The tab shows only the agent name beside the entry's icon from CONFIGURATION-2.4: a built-in logo glyph
(`facade-cli-<id>`) or a robot glyph (`facade-robot-<color>`). It shows
` #aN` after the name where PANEL-1.3's cards show it, `#aN` alone for an empty name. An open tab follows as a duplicate
appears or goes, in any group; a hidden one is not opened for it, and its next opening has the current title. A native
tab keeps its own font and width, which may clip it. While its card's dot is green (RULES-3.2), a spinner frame turns
between the logo and the name every 100 ms, for every CLI: the braille frames `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`. Editor tabs draw no icon in
a label, so the frame is text before the name in the tab's title; the spinner's frames are never taken for a rename.
When the agent is not busy the tab shows its name alone, keeping no blank space for the frame. Under reduced motion -
`workbench.reduceMotion` `on`, or `auto` with the system asking for it - the tab keeps one frame still (UX-2.2).
Built-in tab logos use contributed native icons, with their brand colors and theme foreground for monochrome marks. They
remain recognizable in light, dark and high-contrast themes, including after a theme change or terminal restoration.
This uses the public icon API; it does not patch editor styles or change the person's theme. Neither a CLI's terminal
title, shown nowhere (CLIS-2.3), nor other status - PANEL-1.4's second line's - is appended to the tab name. Do not add
a name length limit or change the editor's tab-width settings. Native tab renames synchronize the complete display name
when valid, without removing text that resembles a CLI title, apart from the tab's own short ID: on `#a12`'s tab,
`auditor` and `auditor #a12` both mean the name `auditor`, and `#a12` alone an empty name - at most one trailing
occurrence of its own ID, whatever the duplicates are by then; no other `#aN` is touched. A name that is to end in that
tab's own ID is given through Rename Agent, whose input holds the stored name alone. Facade's own title changes never
become a rename. Match terminals by actual identity, never by a duplicate title. Facade never offers panel placement as
an alternative. An agent's terminal passes the person's input to its CLI as typed, except a mouse report the editor
could not measure, and keys that reach it while Facade steps through groups to show a chosen tab or holds the focus
there for a mark of its own (3.4). The editor reports a click's release after it opens a clicked link, and a link opened
over an editor terminal takes the terminal out of the page first: the release then has no position (`ESC[<0;NaN;NaNm` in
the SGR encoding), which a CLI shows as typed text. Such a report, in any mouse encoding, takes the position of the
report before it - for a release, its press; one with none before it is left out. The terminal shows what its CLI
writes as written, except mouse tracking and encoding settings (modes 9, 1000, 1002, 1003, 1005, 1006, 1015 and 1016)
that, taken with those written right beside them, leave the terminal's mouse as it was: set to a protocol that reports
no drag, 1000's among them, the editor's terminal stops reporting the drag in progress, and 1002 or 1003 set right after
does not take it up again. Claude Code sets 1000, 1002, 1003 and 1006 again with its first input after five seconds
without any - often the press that starts a selection, which then never follows the pointer. Facade follows the
terminal's mouse, as the editor's terminal reads them, from what it wrote there since the terminal opened, resets
included; once it cannot, it leaves nothing out until the terminal is reset. An Enter the person types waits
briefly for the CLI's input reader to read what it submits (CLIS-2.1, PANEL-1.4); a CLI without an input reader takes it
at once. A file dropped onto an agent's terminal gives it its path only with Shift held, as the editor requires of every
terminal in the editor area; an extension cannot change that.

### 2.3 Finding an agent

**Go to Agent opens this window's agents and, on the Rust engine, lets the person adopt reachable running agents.**

Match name, CLI, title, working location and run ID. Accept the existing short ID and a copied agent reference as
search input; an ID in a copied reference matches that run even if its descriptive name is stale. Use one native picker
line: CLI icon, prominent name, then quieter short ID, working location - none where every agent works in the window's
one place to work (1.3), which search still matches - and its conversation's title (CLIS-2.4), in that order, joined
with ` · `. The card's dot and second line carry agent status (PANEL-1.4). An empty name uses the short ID as the
prominent identifier, with location/title after it. The icon
identifies the CLI; its name stays searchable without being repeated in the row. Keep name and title even when equal;
omit only missing fields. Native width clipping never changes the stored or searchable text. Include starting/running
and retained-error cards in panel order, whatever the panel's filter shows; rows follow changes while the picker is
open. Choosing a row closes the picker and reveals that terminal. Each row's buttons copy its reference (2.1) and offer Stop Agent or Dismiss Agent for that exact agent (3.1).
Both keep the picker open.

Rust adds one row per other reachable running non-guest agent, including ordinary terminal starts and agents of
disconnected windows. Show this window's agents first while querying other machines, with a three-second bound.
Each outside row appends the member window names in window-reference order and adds
`Window disconnected` after each disconnected member. Window names and the status label are display fields. The search
fields above also accept the full reference of a remote agent. Selecting an outside row adds the current window under RULES-4.1,
then opens its card and terminal here using the normal reveal path. Its other windows keep presenting it. Copy and Stop Agent
act on the row's exact numbered agent without adding this window. On the old engine the picker stays within the
current window. For ended Rust agents, Resume uses the records of this window under 3.2.

## 3 End and continuity

### 3.1 Stop and dismiss

**Stop Agent stops a starting or running agent. Dismiss Agent removes an ended pair from this window.**

The card menu, Go to Agent and the Command Palette resolve the exact run and check its current state before acting.
Stop Agent on a run already known to have ended leaves the retained pair available for dismissal. Dismiss Agent
requires a confirmed end or a failed launch known to have created no process.

Stop Agent uses RULES-4.1's lifetime rules. A local card and terminal tab close immediately, with cleanup in the
background where a process exists. On the Rust engine, Stop Agent calls `agent.stop`, including for a launch whose
number arrives after the card closes. A remote pair stays until core confirms the stop or reports its exit. A
successful stop closes the pairs in its connected member windows, keeping the record, conversation and Rust Pins.
Resume Agent can restore that record by number even when its card is gone (3.2). MCP keeps `stop_agent` under MCP-3.2.

Dismiss Agent closes the current window's retained card and paired terminal. The workspace records dismissal for
an abnormal exit recorded by core. A card for a failed restoration call is dismissed for the current activation.
A subsequent Rust restoration clears the dismissal. On the old engine, Stop Agent and Dismiss Agent also unpin.
A refused Pin save leaves the pair in place and reports the failure to the initiator.

The initiator sees a refusal or unknown result as `Could not stop {0}: {1}`. A known failure after the local pair
has already closed reports `{0}'s card and terminal were closed, but its process could not be stopped.` The
initiator sees a dismissal failure as `Could not dismiss {0}: {1}`. A running Rust agent whose stop failed can
reattach at the next opening or reload. The old engine records an unconfirmed cleanup so that a reload ends that
run. A stop during launch waits for its cleanup result. Worktrees, files, conversation history and child agents
stay. Unsolicited exits follow RULES-3.3.

Closing an agent's terminal tab hides it (2.2) and keeps its card. Its own exit, location removal and window
closure follow RULES-3.3, 2.4 and 4.1. Messages use an agent's `#aN` when it has no name.

### 3.2 Choosing an agent or session

**Resume Agent selects an ended Rust member record. Continue Session selects a session from CLI history.**

Resume Agent opens from the Rust panel title or the Command Palette. It lists confirmed ended records with a saved session,
including stopped or dismissed agents, by recent activity. Each row identifies its exact numbered agent. A session held by
another running agent is unavailable. With no eligible records the picker says `No agents to resume in this window`.

Continue Session opens from the Command Palette or the empty panel on both engines. It also opens from the old engine's
panel title. It reads CLI history from the window's folders, subfolders and associated worktrees. With no folder, its
`Open Folder...` row runs the editor's Open Folder as PANEL-1.2 describes. Both pickers show at once, busy while they
prepare their sources. Check facade.json before reading the sources. A file-level problem shows one row per problem: the file as label, its reason as detail and a
gear icon and an Open Settings gear button, as in New Agent. Choosing the row or its button runs Open Settings.
No conversations are read, and the picker does not claim there are no saved conversations. An entry's own error omits that entry's conversations (CONFIGURATION-4.1).

Continue Session reads only list metadata, most recent first, paginated in batches of 100: the next batch is read when the person comes within 10 rows of the end, and on to the last
while a search is typed. A batch that has taken 1,000 conversation records ends early and the next goes on, so no scan
limit makes older matching history unreachable. Reuse already read metadata during the picker session rather than
rescanning every log on each page or keystroke. Reading the histories keeps the window's agents responsive: the stores
are read together, each folder's real path is resolved once per reading rather than per conversation, and no long
synchronous read holds the extension host that draws their terminals. Prefer vendor discovery; do not build a new
conversation store. There is no 30-day age cutoff. Deduplicate by environment/CLI/session ID. Each conversation uses the
same single-line native presentation as Go to Agent: its entry's icon (CONFIGURATION-2.4) and prominent
conversation title, then quieter
activity time, original location - none for the window's one place to work itself (1.3), which search still matches, a
subfolder of it still named - and saved Facade name, in that order. A session without a title is `Untitled session`.
Omit a missing or empty name without generating one while browsing. Keep the saved name even when it equals the
title. The icon names the CLI, so no CLI name is repeated as text; search covers title, saved name, CLI and
location, including beyond the first page. Use the vendor's saved display title and conversation activity time,
including native renames; file maintenance does not make an old conversation recently active. Ordering remains correct
across page boundaries. Omit a history segment whose vendor continuation points to an existing resumable conversation.
With nothing to list, the placeholder says `No saved sessions in this window's folders`. If the histories or the
window's state cannot be read, a notification says `Could not read the saved sessions: {0}`. Omit a CLI history
entry whose working directory is gone, whose CLI is turned off or unavailable in this environment, or whose
conversation a running agent already holds (CLIS-2.4). Do not list unrelated projects, or
provide delete, hide or show-hidden controls. The panel's display filter does not change this history scope. When a
vendor records a set of workspace folders without identifying the original cwd, use Facade's recorded cwd if known.
Otherwise, choosing that conversation opens a native working-location picker for its folders in this window, each
with its full path. Each choice must find the conversation's store with that folder's launch settings
(CONFIGURATION-3.4). Do not infer the original cwd from directory order. Cancellation starts nothing. If that exact
conversation already runs in Facade, do not start it again; reveal it only when it belongs to this window, otherwise say
`{0} is already running in another window.` For a Rust member agent the same running record is already in this window's
scope. External activity is not a gate: call vendor resume and return its result. No external-writer scan, lease or
concurrency guarantee is required.

### 3.3 Restoring agents and continuing sessions

**Resume Agent restores the chosen number. Continue Session starts an exact saved session under a new number.**

Restore RULES-4.2's conversation context and CONFIGURATION-3.4's original entry name and type. Use current entry
settings and RULES-4.3's current destination YOLO; model and effort follow CONFIGURATION-3.3. A removed, disabled or
changed-type entry refuses restoration with the reason, without selecting a built-in instead.
Continue Session keeps a nonempty saved Facade name. A missing or empty saved name uses New Agent's suggestions (2.1),
or the new agent's ID when no name is free. Save the chosen name with the conversation, except when it equals the
agent's ID. Never derive it from the conversation title or CLI ID. Existing saved names, including long ones, remain
unchanged. An ordinary reload preserves the running agent's name. Automatic Pin restoration keeps a recorded
nonempty name; a blank one follows 2.1.
Missing original session, location or configuration fails with its actual reason. For a vendor's ambiguous workspace-folder
set under 3.2, the person's explicit location choice supplies the missing cwd. On the Rust engine core uses a retained
agent's original cwd with the restoring window's execution environment and current startup settings, even when that
window does not list the location. Resume waits for core to confirm success before opening the card and terminal.
Concurrent resumes of the same retained number share a process under RULES-4.2. If a Resume call errors and core
already reports the same member running, the window reattaches to it. A manual failure says
`Could not resume {0}: {1}` with the saved title. Continue Session uses the session ID and starts a new agent even if
an ended record has the same session. Its failure says `Could not continue {0}: {1}`. On the old engine an accepted
continuation creates its pair immediately and retains actual launch failure. On Rust the pair opens after core confirms startup. Do not acquire an external
conversation-writer lease or replay the original creation prompt.
On process start, register the successful cwd under WORKTREES-1.2 and update human launch history under 1.2.

### 3.4 Pin and native editor pins

**Native terminal-tab Pin and Facade Pin express the same exact-conversation restoration intent in both directions.**

Pin from either surface saves RULES-4.2's context and updates the other; Unpin synchronizes too. Native-to-Facade sync
follows `tabGroups` pin changes on that agent's tab. Facade-to-native sync shows the change on the tab at once,
wherever the tab is, because a Pin the person cannot see on the tab is not one they can trust, and a tab without its mark
is closed by the editor's Close Others and Close All. The documented `workbench.action.pinEditor` and
`workbench.action.unpinEditor` commands act on the active group's front tab alone (ARCHITECTURE-1.2). A Pin or Unpin the
person asks for - from an agent's card, the Command Palette or a key - is their attention to that agent: once saved, its tab
is shown as a click on the card shows it - in front of its group with the focus, that group made the active one through the
editor's focus commands, past the eighth group by group, each step checked, or, where it has no tab open, opened so in the
active group - and its mark goes on there, as the active group's front, nothing given back; an Unpin of an agent with no tab
open keeps it hidden, and a Pin that cannot be saved opens nothing. A tab that is the active group's front is marked where
it is: nothing is taken from the person, and keys pass to its CLI as typed. A pinned agent's tab that 3.5's tab procedure
opens - after a reload, an extension-host restart or Pin restoration - takes its mark as it opens, the newest tab in front of its group - that group made the active one through the
editor's focus commands where the editor did not make it so, the keys its terminal receives meanwhile not passed to its
CLI - and nothing is given back (3.5). Any other tab - such as one whose Pin another card's took, or another agent's whose
mark a mark's command changed - Facade brings to the front of its group - that group made the active one through the
editor's focus commands,
the first eight groups by their own and one past them from the eighth group by group, each step checked, the keyboard's
focus there for a moment - applies the command and checks that the tab took it. It then gives back what the mark took:
its tab's group's front, and the person's group with the focus and its front. A front comes back, in the active
group with the focus, by its place among the group's tabs through the editor's own commands, whatever its kind; else as
the editor shows its kind again - an agent's or the person's own terminal by its terminal, a file by its resource, a text
or notebook diff by its two resources, a notebook or custom editor by its resource and type - and, where that fails in
the active group, by its place; one that opened as another kind instead is closed again, never one with unsaved changes,
and a front shown without the focus leaves the person's group the active one. A tab in a floating editor window, which
no focus command reaches, takes its mark as it next becomes active. The editor tells an extension nothing of a focus
outside its groups and Facade's panel, so such a focus comes back to the person's group. Keys its terminal receives
while Facade holds the focus there are not passed to its CLI. Where the person brings another tab to the front while a
mark goes on, theirs stands, and nothing is given back over it; a mark that the command put on another of their tabs is
undone at once.
Marks go on one tab at a time and only while no tab of Facade's is opening, as an opening tab takes the front a mark
goes on - but for that of a pinned tab 3.5's procedure opens, which goes on as it opens; a mark that lands on
another tab is undone and never taken for the person's Pin or Unpin, and one that does not go on is tried again only
once its tab is known anew, its Pin or Unpin is asked again, or the person brings its tab to the front, where it goes on
as it is - never in a loop. While a mark that borrows the focus goes on, its tab's group may be
the active one and the panel's selection may follow its agent for a moment; what the person had in front, and the focus,
come back after as above - for that borrowing alone, never after the person's Pin or Unpin, whose showing of the tab is
their choice of front, as a click on the card is. Ordinary files
and external terminals do not become agents. A close the editor reports as the person's, of an agent tab showing its pin mark - its Close,
Close Editors and Group, Close All Groups, Kill All Terminals - Unpins the agent and hides its tab, the terminal naming
its agent and the mark being the one its tab last showed, also where a move left that tab unknown; an Unpin that cannot
be saved opens the tab again, pinned, and says `Could not unpin {0}: {1}`. A pinned agent's tab whose mark is still to
follow shows none, and its close hides it alone, keeping the Pin. Closing a floating editor window closes its tabs,
marked ones included, as the person's closes do, so a marked one there Unpins as well. The editor's Close All and Close
Others leave marked tabs open, and a tab gone with a reload, a move, the extensions' restart or the window's close
changes no Pin. A tab Facade cannot tell (2.2) may be pinned or unpinned natively meanwhile: once the tab is known, a
change of its mark that Facade saw after the agent's last Pin or Unpin from its card or Facade is the latest and wins,
Pinning or Unpinning the agent; otherwise - no change seen, or a Pin or Unpin made after it - Facade's Pin stands and
the mark follows it. Match the terminal/run exactly without relying on names. A native Pin or Unpin that cannot be
saved is undone on the tab, and the person is told `Could not pin {0}: {1}` or `Could not unpin {0}: {1}`; a native pin
of an agent that cannot be pinned is undone. The adapter must identify and resume the exact session. Pin and Unpin are
acknowledged only after durable storage succeeds.

The Rust engine creates a Pin once core identifies the agent's saved session. It uses the machine and number
under RULES-4.2. One workspace has one Pin for that identity. Actively pinning an agent with an existing Pin keeps
its saved position. A preexisting session-only Pin for the same conversation takes the new identity in place when
the person pins the agent. Metadata refresh updates the existing entry and preserves an Unpin committed by another
window (ARCHITECTURE-3.1).

**Rust Pin restoration** starts from the first complete `agents` snapshot of the bound machine under RULES-4.2.
If needed, add this window to the agent before reattaching or calling `agent.resume` for the original number. Pin
restoration keeps the saved order and opens pinned tabs after the runs are reconciled (3.5). A failed restoration's
red card gives the actual reason, including a missing saved session. Dismiss Agent closes that card for this activation.
For an actual abnormal exit, the workspace remembers its dismissal until the agent runs again or the record is removed.
The workspace's Pin intent stays independent of Pin intent in another workspace.

On the old engine, a run whose CLI can identify and resume an exact session can be pinned from its start and across
a reload. A conversation Facade resumed is saved already, and a new one
can be pinned before its CLI names it - before its first message for CLIs that name it then. Such a Pin takes the
conversation the CLI names; a window opened before that starts a new conversation of the same CLI with the Pin's name
and location in its place. If a CLI changes that session, update the Pin only after its new identity is known; never
substitute a folder's latest conversation. Keep the run's link to its saved Pin through a session switch even when
saving the new identity fails. Report that failure; reattachment reconciles the linked Pin before restoration, so a
stale saved key cannot start a second, old conversation. If a normal exit cannot remove its Pin, retain an ended failure card with the reason, tell the person
`Could not unpin {0}: {1}`, and allow Unpin or Dismiss Agent to retry; do not silently restore that stale intent on reload. A
conversation has one Pin: pinning a card whose conversation is already pinned takes that Pin, moved last among the Pins
(PANEL-2.1), and a pinned card whose CLI switches to a pinned conversation replaces that conversation's other Pin. **Old engine Pin restoration** is
each activation's start, after reattachment (3.5), of new runs for the saved Pins no run holds, their earlier processes
having ended: in saved order, their processes started in the background at most two at a time; a reload therefore
restarts none that still run or were retained as failures. An extension-host restart, as a reload, instead reattaches
the runs ptyd still holds (3.5). Only the processes start in the background: the restored Pins' tabs then take the
front by 3.5's tab procedure, in the active group, each once its process has started, in the one sequence of the
activation's pinned tabs - the reattached ones' too - whatever starts at once. Every run that is no longer eligible
when its turn comes drops out of that tab opening, its tab hidden, and then takes its own lifecycle's outcome: a failed
start or an abnormal exit keeps its red card and its Pin; Dismiss Agent removes both (3.1); a normal exit removes both as
RULES-3.3 and 4.2 say, a Pin it cannot remove keeping its ended card with the reason, as above. A session already
running in Facade is skipped by later windows. A failure keeps its own red card, which holds its Pin and says why, without auto-looping;
Dismiss Agent on it Unpins. One notification for the restoration says
what failed, with Show: `Could not restore {0}: {1}` for one Pin,
`Could not restore {0} pinned agents. Their cards show why.` for several. A Pin refused before any card - its window
cannot number agents (RULES-2.2), or the settings file has a global error (CONFIGURATION-4.1) - has no card and is kept for
the next opening; the notification then names it with its reason, which holds for the others too. Edit in facade.json
is offered for a file error before any card, and for a restored card whose launch fails because its CLI entry
refuses it or its program cannot start. A failure elsewhere, such as a missing working location, has no file action.
Stop Agent, Dismiss Agent and a normal exit remove the Pin; whole-window close preserves it.

### 3.5 Reload and remote loss

**Reload and temporary disconnection reuse existing runs. Reopening can restore ended agents through saved Pins.**

On the Rust engine, reconnect to core after a reload, window closure or extension-host restart. The logical reference
selects this window's agents (RULES-4.1), which reattach by their original numbers and screens. A complete `agents`
snapshot drives Pin restoration under 3.4.
The core record keeps an actual abnormal exit across activation. The workspace keeps the user's dismissal of that exit.
A failed restoration call keeps the red card for the current activation. A later opening or reload can attempt that
Pin once again. Normal exit or a successful stop in an open window does not trigger automatic restoration there.

On the old engine, RULES-4.1 keeps runs for its grace after disconnect. Reattach those runs before restoring Pins, never duplicating a
conversation still held by Facade: Pins are restored only once the conversations every ptyd of the window holds are
known, and one that does not answer yet delays them. A run that exits between the listing and its reattachment shows
that exit. A failure to clean up a kept record never stops the window's agents from showing. A retained failed
restoration is not retried on reload.

A reload, an extension-host restart and Pin restoration (3.4) bring back the tabs of pinned agents alone (2.2): every
other agent's process runs on and its card stays, its tab hidden - though it was open, even in front, before - until the
person opens it from its card as usual. A retained failure without a Pin comes back with its tab hidden too, and so,
always, does an agent that cannot be pinned, such as a custom program (CONFIGURATION-2.3) or a run whose
session integration failed. The pinned tabs open by one procedure, in one sequence for the whole activation, whichever
of these brought each run back:

1. Reconstruct the runs. On the Rust engine, read core's snapshot and attempt eligible Pin restores (3.4). On the old
   engine, reattach every run the window's ptyds hold. Pin restoration then starts its new runs (3.4), once
   the tabs ahead of the first saved Pin no run holds have opened. Those need no listing of the conversations; every tab
   after that Pin, and the final selection, wait for it, a ptyd that does not answer delaying them as it delays the Pins.
2. Choose the eligible Pins in their workspace's saved order (PANEL-2.1), each pinned agent's tab once - a reattached run's,
   a retained failure's with a Pin, a restored Pin's once its process has started; a run no longer eligible when its turn
   comes drops out (3.4).
3. Open and mark each in its group, one at a time: the group its record names - the last group where theirs is gone, so
   that one of a floating editor window, which the editor opens again after Facade's tabs, comes back in the main
   window - else, hidden or from a build that kept no record, in the active group. It comes to the front of its group as it
   opens, the newest tab there, and its mark is put on there before the next opens (3.4); one whose terminal does not
   open within ARCHITECTURE-2.2's ten seconds is passed over.
4. Keep the last one active: nothing is given back, after any tab or at the end - no group's recorded front, no file or
   editor of the person's that was in front, no active group. The last tab opened stays in front of its group, that
   group the active one.
5. Finalize the selection once: it does not move while they open; once they are open it is on the last one opened, and
   where none opened it stays as it was (PANEL-2.1).

Each logical Rust window keeps its own tab placement (ARCHITECTURE-3.1). The old engine keeps it with the run.
The record follows the person's changes, including for retained failures and starts waiting their turn.
Facade's own showing of a tab for its mark leaves the recorded placement alone. A pinned agent's tab opens in its
remembered group on reload.

Reconnect output, process/run identity and location before accepting further input. Do not infer closure from terminal
silence or a remote disconnect. Reconcile actual process state before restoring a run. On the old engine, RULES-4.1's
grace after the extension host disconnects is the only time-based cleanup. A window that claims the
workspace while the grace is ending its runs waits for those ends, within the five seconds cleanup takes (4.2), before
it restores Pins. A run whose end is not confirmed stays listed as uncertain, holding its conversation, its Pin not
restored beside it, and shows a red card whose second line says `Stop unconfirmed · check process`, where Stop Agent
retries the stop; once its exit is heard the card goes and its Pin is restored as an ended run's. On the old engine, proven
folder or worktree removal closes and unpins affected agents, including when removal is found on restart. On the Rust
engine, Delete Worktree follows WORKTREES-3.2's source-window and stop checks. Location loss discovered elsewhere
keeps the Pin. If restoration fails because the location is gone, the person can unpin from the red card.

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
| 1.1–1.5 | Plain/no-Git/multi-folder flow, current Settings tab and Change Name placeholder, name and actual location visible while searching - the window's one place to work left unsaid -, editable name, last CLI/location, filter unchanged, agent starts in the background, immediate pair, usable CLI after a tool failure and initiator-owned errors |
| 2.1–2.3 | Configured/default names, trimming and case-insensitive exclusions, empty/exhausted lists, blank starts/renames, invalid names blocking starts, ID names omitted from Resume/Pin, duplicate/spaced names and `human`, icon plus name-only tabs through CLI title updates and reloads, a busy tab's spinner, literal native renames, editor-only terminals, agent tabs that stay open where opened, hidden tabs and agent-started agents without one, tabs known by the editor's reports and unknown ones acting on none, a copied tab becoming an ordinary terminal in its agent's folder, a reload's pinned tabs alone back in their groups as 3.5 says, every other tab hidden, ID/copied-reference search, distinguishable picker details |
| 3.1–3.5 | Separate Stop Agent and Dismiss Agent actions, a closed tab hiding its agent, children kept, reload/disconnect reuse, exact Resume, linked Pins and the person's close of a marked tab Unpinning, bounded restoration, the pinned tabs of a reload, an extension-host restart and Pin restoration opening one at a time in one sequence in the Pins' order, each marked as it opens before the next, the last in front of the active group with nothing given back and the selection on it, the other agents' tabs hidden, Resume file-problem rows and gear buttons before history reads, Edit in facade.json on Pin file errors and restored-card launch failures but not missing locations, a restored Pin whose start fails dropping out, the person's Pin or Unpin - card, Command Palette or key - showing its tab as a click on the card does and marking it there, a hidden agent's Pin opening its tab, marks that borrow the focus put on at once one tab at a time and the person's front given back, a mark changed on a tab Facade could not tell winning once it is known only where no Pin or Unpin came after it, Rust agent continuity after window close and original-number restoration, the old engine's uncertain-end red card and restoration after the confirmed end, proven folder/worktree removal |
| 4.1–4.2 | One service, truthful effects, current startup configuration, bounded cleanup without UI wait |

Evidence: [Verification](../engineering/VERIFICATION.md).
