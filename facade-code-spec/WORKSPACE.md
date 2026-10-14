# Workspace

Facade Code uses a normal VS Code workspace to keep several projects and Git
worktrees in one window. The workspace bar selects the folder to work in. Editors,
folder terminals and the built-in views follow that selection; extensions continue
to see every workspace folder.

This document defines folder membership, navigation, editor and terminal behavior,
and the workspace bar. [ACTIVITY-BAR.md](ACTIVITY-BAR.md) defines the separate view
icon bar, its locations and interaction. [WORKTREE.md](WORKTREE.md) defines Git
worktree discovery, creation, setup and deletion. References beginning with AB and
WT refer to those documents. [IDENTITY.md](IDENTITY.md) defines product branding and
distribution.
[AGENT-LAUNCHER.md](AGENT-LAUNCHER.md) defines agent lifetime and integration.

Each document separates required behavior, implementation guidance and acceptance.
A requirement is not a claim that the current code implements it. L1 requires the
identity, activity-bar, workspace and worktree acceptance cases, plus the integrated
scenario in W17, to pass on the same build. W19 describes how to run and record the
shared workspace, activity-bar and worktree checks.

# Part 1: Specification

## W1. Purpose and boundaries

The person should be able to work on several projects and branches without managing
one window per checkout. Switching folders should bring back the relevant editors
and terminals while background work continues.

**One window, many projects and many versions.** A person needs one window, not many,
to work on several projects and on several versions of each - feature branches, each
in a worktree. The window holds a list: projects, and under each project its
versions; it shows one at a time. "I want to work on this too" is answered by putting
it in this window. A second window is something a person asks for in as many words:
New Window, "in New Window", the new-window modifier, `--new-window`, opening a
`.code-workspace`, or an extension asking for a new window.

**A panel to switch quickly, in VS Code's own look.** Switching is one click on the
workspace bar, or one key. The bar looks and behaves as if VS Code had always had it.
Slow switching, or a panel that looks foreign, would send people back to opening one
window per project.

**The test.** Does this behavior have to differ from VS Code because one window holds
many projects and versions and shows one at a time? If it does, it follows the two
principles above: the explorer shows the active folder only, a terminal opens in it,
Open Folder puts a folder in this window, there is a workspace bar. If it does not, it
is stock VS Code: names, gestures, the meaning of command-line flags, how trees behave,
and the look and interaction - theme colours, codicons, sizes, motion, high contrast,
quick inputs, context menus, keybindings. What only Facade has, like the bar, is built
from those parts. One exception: the forms Facade needs, of a kind VS Code does not
have, take the frame of shadcn/ui's Dialog, with VS Code's font, buttons and inputs in
it; its questions are dialogs as VS Code's are, the operating system's (W10.7).

Three separate facts determine the behavior:

| Fact | Meaning | Source |
| --- | --- | --- |
| Workspace membership | The folders loaded by this window and its extensions | VS Code's `folders[]` |
| Active folder | The folder currently selected for work | Facade's selection, stored per workspace |
| Available worktrees | The other working copies Git knows for a repository | Git's records, whether or not each directory has joined the workspace |

A worktree becomes a workspace folder when opened. Merely listing it does not load
it into the workspace. A repository's main checkout is its top-level row; linked
worktrees are its children. Collapsing that row while a child is active returns to
the main checkout, then collapses the children (WT-1.5).

| ID | Rule |
| --- | --- |
| W1.1 | Use the normal workspace folder list and file format. Do not maintain a second list of loaded projects |
| W1.2 | Change the active folder only through the actions in W6.1. Opening a file or changing a terminal's working directory does not select another folder |
| W1.3 | Give equivalent requests equivalent results. Route requests made inside a window to that window; route external requests using W5. W9.6 defines preservation when membership changes outside an interactive removal |
| W1.4 | Preserve unsaved content and running work through navigation. Obtain the specified confirmation before an interactive removal, deletion or shutdown stops or discards them |
| W1.5 | A folder switch does not reload the window or restart extensions, and settles within W13's limit |

P1 is compatibility with the formats and behavior explicitly preserved in W8.
P2 is a consistent active-folder view with fast switching. Neither means that a
folder is isolated from the rest of the workspace: extensions, language servers,
workspace settings and trust still operate at their normal VS Code scope.

The workspace is extended rather than replaced (W1.1). `getWorkspace().folders` is
read at 174 places in `src/vs`, `onDidChangeWorkspaceFolders` at 71 and
`getWorkspaceFolder()` at 113, and 136 user-visible strings say "Workspace": a private
list would have to earn each of those reads again. Multi-root's standing complaint is
an explorer that flattens every root at once; one folder at a time answers it.

Use VS Code's trees, quick inputs, menus, theme tokens and keyboard conventions.
The workspace bar and folder navigation are intentional additions; W8 lists the
intentional changes to existing behavior. W10 specifies the workspace bar, window
layout and dialog styling; ACTIVITY-BAR.md specifies the view icon bar.

Use "workspace bar" in the UI, `Parts.WORKSPACEBAR_PART` for the part,
`facade.*` for settings and `facadeBar.*` for its theme colors.

## W2. State and where it lives

| State | Kept in | Survives | Changes or ends |
| --- | --- | --- | --- |
| folders[] | the workspace file in WORKSPACE mode; the opened folder URI in FOLDER mode | normal VS Code restoration | an edit, by any path |
| active folder | workspace storage, this machine | reload, restart, Save Workspace As | W6.1 |
| editors per folder | workspace storage, this machine | reload, restart | release or transfer under W9.6 when the folder leaves; dirty content is preserved until saved or explicitly discarded |
| terminals per folder | workspace storage, this machine | reload reconnects surviving processes; restart follows W11 | ended when the folder is removed, after asking; kept running in the panel when it leaves where nothing could ask (W9.6) |
| folder scope | workspace storage, this machine | reload, restart | Show All Folders |
| closed repositories, last git read | workspace storage, this machine | reload, restart | WT-1.10, WT-3.7 |
| display name of a folder in the list | the workspace file, `folders[].name` - VS Code's own field for naming a root | everything; stock VS Code and extensions read it too | Customize, or the file edited by hand (W9.7) |
| display name of a row not in the list, colour, icon | profile storage, by path | every workspace of the profile, and a removal | cleared by the person; a worktree's when it is deleted (WT-8.1) |
| worktree order | profile storage | every workspace of the profile | WT-1.7 |
| bar collapsed, bar width | profile storage | every workspace of the profile | the toggle, a drag |

Facade writes folder membership and names using VS Code's standard fields. Keep its
private navigation state in storage instead of adding a private workspace-file
format. Preserve existing settings, tasks, launch configuration and unknown user
fields; do not sanitize a file the person supplied. A newly generated workspace
must not acquire Facade settings that stock VS Code would flag as unknown.
Workspace storage is keyed by the workspace's id, the hash of the file's path: an edit
to `folders[]` keeps it, and Save Workspace As carries the storage to the new id
(`enterWorkspace`).

| Setting | Default | Section |
| --- | --- | --- |
| `facade.workspaceBar.worktrees` | `true` | WT-9 |
| `terminal.integrated.confirmOnExit` | `hasChildProcesses`, where stock has `never` | W11 |
| `facade.terminal.followFolder` | `true` | W7 |
| `facade.titleBar.showAppIcon` | `false` | W10.1 |

Activity-bar location and secondary-side-bar defaults are listed in
[ACTIVITY-BAR.md AB3](ACTIVITY-BAR.md#ab3-settings).

## W3. Invariants

These hold after every action and event in this specification, once the window has
settled. Every integration test checks all of them after every step (W15).

| ID | Invariant |
| --- | --- |
| W3.1 | **One active folder.** While `folders[]` is nonempty the active folder is one of its members; while it is empty there is none |
| W3.2 | **One mark, always in sight.** While there is an active folder exactly one row carries the active mark, and it is that folder's own row, never hidden inside a closed repository (WT-1.5, WT-1.10). Otherwise no row does |
| W3.3 | **One answer.** The explorer's root, the SCM Changes list, the status bar's repository, a new terminal's working directory and the file dialogs' default folder are the active folder's. So are search, Go to File, Go to Symbol and Problems while they are not widened. `${rootName}`, the command center and the explorer header call it by the name its row shows |
| W3.4 | **Extensions see everything.** `vscode.workspace.workspaceFolders` equals `folders[]`, in its order |
| W3.5 | **The file is ordinary.** Facade uses standard workspace fields, preserves folder spelling and unrelated user data, and adds no private navigation metadata |
| W3.6 | **One folder, one row.** No two rows name one directory under any two spellings: a symlink, a junction, case on a case-insensitive disk |
| W3.7 | **Rows are a function.** The rows follow from `folders[]`, git's records, the closed repositories, the worktree order and the worktrees setting. Two windows with the same inputs draw the same rows, and so does one window after a reload |
| W3.8 | **Nothing moves by itself.** The active folder changes only by the events in W6.1 |

## W4. Window creation and workspace lifetime

```text
EMPTY       no workspace. The bar says "Drag a folder here or click +."
FOLDER      one folder and no workspace file, as stock. The bar lists that folder
WORKSPACE   a workspace file with 0..N folders: the default workspace, a saved one or an untitled one
```

**The default workspace is the first window**: an empty window that remembers. It is
`<userData>/User/Default.code-workspace`, written as a `file:` URI because
`resolveLocalWorkspace` silently declines every other scheme, and created as
`{ "folders": [] }` the first time it is needed. With no folder it looks like stock's
empty window: the welcome page and an empty explorer. Folders added to it stay, and it
never asks to be saved. It is what a window opened for nothing in particular opens: the
app started with no arguments and nothing to restore; `facade <folder>` with no window
open, which then adds and shows the folder (W5); and on macOS a click on the Dock icon
of an app with no window. `window.restoreWindows` still wins. File > Open Default
Workspace opens it at any time, creating it if it is missing. A remote window never
opens it. If it cannot be written or resolved, the window opens empty and the reason is
logged.

**Any later window is stock's.** New Window opens an empty window, and its list is the
person's to keep: nothing is saved behind their back, because a file saved where nobody
chose is a file nobody finds again. In an empty window the first folder opened opens
the window on that folder, a FOLDER window, as stock. A second folder makes it an
untitled workspace in place, as stock's Add Folder to Workspace does: one
extension-host restart, no reload. Closing that window asks whether to save the
workspace to a file, as stock does; the person reopens it from where they saved it, or
from Open Recent.

**A workspace opened from inside a window opens in a new window.** Open Recent on a
workspace and File > Open Workspace from File... never replace this window's list: it
holds the person's other projects, and their agents.

File > Close Workspace is stock's: the window becomes empty in place.

Within an existing WORKSPACE window, editing `folders[]` does not restart the extension host. Upstream's relauncher restarts it
whenever `folders[0]` changes, for the deprecated `workspace.rootPath`; Facade skips
that, as VS Code's own Agents window does, so adding the first folder, removing the
first row and moving a row through the first position cost nothing. No built-in
extension reads `rootPath` outside its tests; an extension that still does sees the old
first folder until the window reloads (W18). The one restart left is the
FOLDER-to-WORKSPACE transition above, which is stock's.

## W5. Opening and adding folders

The seam is `IWorkspaceBarService`. `show(uri)` puts a folder in the workspace if it is
not there and moves the window onto it. `add(uris)` puts folders in and leaves the
window where it is. `addAndShow(uris)` is one edit and then one move, onto the last
folder. Every arrival goes through the bar's model, which knows that two spellings of
one directory are one row (W9.2). The command line is `facade`; `code` is VS
Code's (IDENTITY.md).

| Way in | Result |
| --- | --- |
| File > Open Folder..., the bar's `+` (Open Folder...), the welcome page, a recent folder on the welcome page | shown. Several picked at once: one edit, then one move, onto the last |
| a directory opened as a file, its empty editor's Open Folder button | shown |
| Open Recent, a folder | shown. With Ctrl/Cmd, a new window |
| Open Recent, a workspace; File > Open Workspace from File... | a new window; this window keeps its list (W4) |
| Open Recent or a dialog, a file | an editor in this window |
| a folder dropped on the bar or on the editor area | shown. Several: one edit, one move, onto the last |
| File > Add Folder to Workspace..., `updateWorkspaceFolders`, the file edited by hand | added; the window stays. Add Folder to Workspace is the way to add a folder without going to it |
| a `.code-workspace` dropped anywhere | a new window. Folders dropped with it are handled as their own drop says |
| a file dropped | an editor in this window |
| `facade <folder>`, while the last active window of that remote authority is on a folder or a workspace | joins that window and is shown. Several folders: one edit, one move |
| `facade <folder>`, when another window already has that folder | that window comes forward, as stock |
| `facade <folder>` with no window open | the default workspace opens, and the folder is added and shown |
| `facade <folder>` into an empty last window, or with `--new-window` | a new window, as stock |
| `facade <folder> <file>` | the folder is shown first, then the file opens among that folder's editors |
| `facade --add <folder>` | added; the window stays, as the flag means in stock |
| `facade --remove <folder>` | removed as W9.6 says, its confirmation included |
| Git: Clone, Git: Initialize Repository | a clone is shown in this window, nothing asked: Facade's default for `git.openAfterClone` is `always`, as Open Folder replaces nothing here. Where git still asks - `prompt`, or a repository initialized outside the workspace - it asks VS Code's question: Open and Open in New Window, and Add to Workspace when the window has folders. Open adds the folder to this window and shows it; Add to Workspace adds it and leaves the window on its folder |
| Switch to Worktree, for a branch checked out in another worktree (WT-5.3) | shown |
| an extension's `vscode.openFolder` on a folder without asking for a new window - git's Open Worktree in Current Window among them | shown, as Open Folder: the stock call would replace the window's whole list |
| an extension's `vscode.openFolder` on a workspace or asking for a new window; New Window; Duplicate Workspace | a new window |
| a folder on a remote this window is not connected to | a window that can reach it |
| a `vscode-vfs://` folder | this window: it carries an authority but is not remote |

A folder already open in another window, picked inside this one - Open Folder, Open
Recent, a drop - joins this window as well: an act inside a window lands in that window
(W1.3).

Arriving at a worktree of a closed repository, by any of these ways, opens the
repository first, so the row the window goes to is in sight (W3.2, WT-1.10).

**Trust.** A window has one trust verdict, so one untrusted folder would put every
project and agent of the window into Restricted Mode. Before folders that are not
trusted join a trusted window, Facade asks once, for everything added together, with
VS Code's own trust question as VS Code draws it (W10.7): the folders that are not
trusted, ten of them named and the rest counted; why it asks; Trust and Add or Cancel;
the box VS Code's question has to trust their parent folder whole, when they share one;
and a link to open everything being added in a new window instead, where only that
window is restricted. What is added together goes together: all of it here, all of it
in the new window, or none of it. A folder that arrives where
nothing can ask first - the file edited by hand, an extension - meets VS Code's own
trust question; answered No, the folder is taken back out of the list, and a
notification offers to open it in a new window. The default workspace's own file is
trusted. Batch additions share one admission decision. On a file or API edit VS
Code's question is asked while the edit waits, but nothing can refuse the edit: a No
leaves the window in Restricted Mode until the folder has been taken back out (W18).
Serialize that removal with other workspace edits; do not overwrite unrelated edits
made while the question was open.

When adding or showing a folder fails, keep the last valid selection, show the
reason and return a failed result. If adding succeeded but activation failed, retain
the added member and identify that partial outcome. A caller must not infer success
from a resolved promise or continue its dependent setup/delete step.

## W6. Moving between folders

### W6.1 What moves the active folder

| Event | Where the window goes |
| --- | --- |
| A row is chosen: one click, or Enter on the focused row | that row's folder |
| `show` (W5) | the folder shown |
| The active folder leaves `folders[]`, by any path | the member at its former `folders[]` index, else the last member, else none. Preserve unsaved editors and processes as W9.6 requires before dropping their ownership |
| The window is on a worktree that is being deleted | its repository's row (WT-8.3) |
| A repository is closed while the window is on one of its worktrees | the repository's row (WT-1.5) |
| The window opens | the folder stored for it; else the root of the last active editor, as upstream guesses, once; else `folders[0]` |

Nothing else moves it. Opening a file of another folder, Go to Definition across
folders, a terminal changing its directory, focus moving, and an extension editing
`folders[]` leave the window where it is.

The editor does not decide, because each folder has its own editors. If opening a
file moved the window, one cross-folder open would put away every tab of the folder
being worked in and restore another. The cost of this rule is a window that can hold
an editor from outside the active folder. That is rare and deliberate: Go to
Definition, Open Recent, a drop. Upstream's `getLastActiveWorkspaceRoot` walks the
editor history, so this differs from stock: with the bar on `gin`, a terminal opened
while `alpha/foo.py` is the active editor starts in `gin`.

### W6.2 What a switch does

All activation requests use one coordinator per window, and the latest request wins:
a request still waiting when a newer one arrives is cancelled without running, and
its caller is told it was superseded; a request already running completes first.
Clicking quickly down the bar ends on the last row clicked without drawing every row
on the way. A switch is complete when its folder, editors, terminal visibility and
focus have settled.
A caller that opens a file or a setup terminal afterwards waits for that operation,
not for an unqualified event or a fixed delay.

1. Resolve the requested directory to the current workspace member. Check that it
   is available. On failure, report the path and reason and keep the current view.
2. Finish the preceding restore. Capture the outgoing folder's editor state and
   focus without saving, reverting or ending anything. If capture fails, stop the
   switch and report the error: nothing has changed yet, so stopping loses nothing,
   while going on would close editors whose state was never kept.
3. Recheck membership after asynchronous preparation. If the destination has left
   the workspace, cancel this activation. Use the current folder objects so a
   rename or reorder during the wait cannot restore stale names or indexes.
4. Activate the destination and restore its editors, or an empty set on the first
   visit. Apply terminal visibility and refresh the scoped views. Publish selection
   changes so the views can redraw.
5. Restore focus to the editor, terminal or view last used in this folder; focus the
   editor on its first visit. Resolve this activation only after the restore settles.

A later request cannot finish before an earlier request and then be overwritten by
it. Repeated requests for the already active folder do nothing. Membership changes
are rechecked before committing state and after restoration. If a folder disappears
in the meantime, reconcile to a valid member using W6.1, preserving its unsaved
editors under W9.6 rather than recapturing them under the wrong folder.

A failed restore reports failure and leaves the window on the destination: the
person chose it, and sending them back would be a second surprise. Nothing is closed
that was not captured, so editors still open stay on screen; both folders' saved sets
are kept for the next visit; and the activation returns a failed result, so a
dependent step - setup, a deletion - does not continue.

A switch keeps terminal processes, working directories and titles. It produces no
workspace-folder event because membership did not change. A renamed active folder
updates labels without performing a switch or restoring editors.

**Unsaved editors.** Text and untitled tabs belong to the folder context in which
they were opened, even if their resource is in another folder. Switching hides
the outgoing tabs without saving, reverting or asking. Returning restores them.
Nothing on the folder's row marks them; VS Code's own count of unsaved files, on the
Explorer's icon, includes them. A new file never saved (Ctrl+N) belongs to the
folder the window was on when it was made.

Keep the actual dirty working copies alive, not just serialized tab locations.
Save All, Revert All, auto save, shutdown handling and backup restoration include
them. Save All may need the normal Save As interaction for an untitled file;
cancellation or a failed save leaves it dirty and retained. After reload, restore
hidden dirty editors to their recorded folder, not whichever folder is visible.
If the same resource is open in two folder contexts, both refer to the same working
copy; saving it updates both, and it is saved only once.

VS Code's existing working-set restoration keeps editors that require a close
confirmation visible. It does not itself implement hidden dirty tabs. Until an
editor type has a verified preservation path, keep it visible through switches.
This applies to notebooks, custom editors and other unsupported editor types.

**Editors opened by a waiting program.** Keep editors opened with `--wait`, and
command-line diff or merge editors, visible through switches. Only the person's
close action should release the waiting program. Do not close and reopen them as a
way of moving between folder sets.

## W7. Scope of each view

| Surface | In Facade | In stock multi-root |
| --- | --- | --- |
| explorer | the active folder only, with no root row - the shape of a single-folder window | every root, each with a root row |
| title, command center, explorer header | the active folder, by its name in `folders[].name` when it has one (`${rootName}`). `${workspaceName}` is new and names the workspace | the workspace |
| editors | a working set per folder, stored on the way out and restored on the way in; dropped when the folder leaves | one set for the window |
| terminals in the editor area | each belongs to the folder it was opened in: leaving puts it away, coming back shows the same shell, and it survives a reload. Its tab names a folder as a window opened on that folder alone would: only once its shell has left the folder. With `facade.terminal.followFolder` off they are the window's and stay on screen | the window's |
| terminals in the panel | the window's. A terminal Facade opened for a folder - an agent's - is that folder's wherever it is. Removing the folder asks before it ends; a folder that leaves where nothing could ask leaves its agents running in the panel (W9.6). Their tabs name the folder each works in, as stock VS Code does in a multi-root workspace: terminals of several folders stand side by side there | the window's |
| new terminal, file dialogs, debug | start in the active folder. Create New Terminal does not ask which folder; Create New Terminal in Another Folder... does. An explicit `cwd`, a variable or a session choice still wins | the last active editor's root, or a question |
| source control | Changes lists the active folder's repositories (`visibleRepositories`). The Graph and the status bar follow the active folder ahead of the editor. A folder without a repository says so | every repository |
| search, Go to File, Go to Symbol | one scope for all three (`IFolderScopeService`): the active folder, or the workspace after Show All Folders in the search view's title or on either picker; kept per workspace. A resource in none of the folders is always covered. Go to Symbol is narrowed where its results land, since its providers run in the extension host | every folder |
| Problems | filtered where the markers land, never at `IMarkerService`; the count follows the scope | every folder |
| "which folder?" pickers | every folder, the active one first: debug configurations, snippets, the settings editor's folder tab, tasks, `_workbench.pickWorkspaceFolder`, `showWorkspaceFolderPick` (whose API caller still sees the workspace's order) | the workspace's order |
| workspace settings, an extension enabled or disabled for the workspace | apply to every folder of the window, as in stock; the settings editor's Workspace tab and the extension's Enable/Disable (Workspace) say "applies to all folders in this window" beside them. Settings for one project are its folder's | the workspace |

What is remembered is what the person chose, never what is on screen. Saving SCM's
narrowed list would deselect every other folder's repository for good.

## W8. Compatibility and intentional differences

Keep the complete `folders[]` in the workspace service and extension host. A
switch filters presentation; it does not remove folders, suppress their activation
events or hide them from language servers. An extension can still read or change
another folder while the person works in the active one.

Never pass a filtered folder list into a workspace write. Add, remove, rename and
reorder operate on the complete current list through the workspace editing service.
Keep the original URI spelling and unrelated workspace settings, tasks and launch
configuration. Opening the resulting file in stock VS Code verifies file-format
compatibility; it does not prove behavioral compatibility.

| Preserved behavior | Boundary |
| --- | --- |
| Workspace and folder settings, `tasks.json`, `launch.json`, `mcp.json`, recommendations and variable substitution | The normal VS Code scopes; workspace settings affect all its folders |
| `workspaceFolders`, `workspaceContains:` and extension-owned trees | All workspace folders, unfiltered |
| Save Workspace As, recent items, profiles and workspace storage | Normal VS Code formats and lifetime, with Facade's state migrated alongside |
| Trust | One verdict for the window; W5 changes how untrusted additions are admitted |
| Explicit resource operations such as Find in Folder, Outline and breadcrumbs | Follow their resource, even when it is outside the active folder |
| File > Close Workspace | Empty the current window, subject to W11's shutdown checks |

Intentional differences:

- W5 changes folder opening into add-and-show and workspace opening into a new
  window. Its `vscode.openFolder` routing is a compatibility exception: callers
  cannot assume stock whole-window replacement. Cover the command's option forms
  in integration tests instead of claiming the entire command is unchanged.
- W4 suppresses restarts caused by changes to the first member of an existing
  multi-root workspace. The deprecated `workspace.rootPath` can remain stale
  until reload. The FOLDER-to-WORKSPACE transition still uses upstream's lifecycle.
- W7 narrows the built-in views and changes their default folder. Extension-owned
  UI remains under the extension's control.
- W9.6 adds confirmation before interactive folder removal would stop work or
  discard content. External membership changes use its preservation path.
- W10 and ACTIVITY-BAR.md change the initial layout and custom dialog presentation.
- WT-9 hides Git's duplicate create/delete entries while Facade's worktree UI is on.

`explorer.expandSingleFolderWorkspaces` has no effect on the narrowed Explorer
because it draws no workspace-root row. W18 lists the remaining limitations,
and why there is no switch back to stock behavior.

## W9. Workspace bar interactions

### W9.1 Rows

The rows are `folders[]` in its order. A repository's folders are grouped onto one
row, and its worktrees are listed under it (WT-1). The column's header reads
`WORKSPACE` and holds one button, `+`: Open Folder..., which adds and shows (W5).

### W9.2 One folder, one row

Folders are compared canonically and stored verbatim. `/tmp/x` and `/private/tmp/x`,
a junction and its target, and two cases on a case-insensitive disk are one row; the
row keeps the spelling it arrived with, because the file is the person's and upstream
would have written it that way. A folder that does not exist yet is resolved from its
nearest existing parent, so it still matches once it appears. One add carrying a
folder twice writes it once; upstream checks what is there once, before its loop. A
folder already in the workspace is not added again and costs no edit.

### W9.3 A folder that is not on disk

It is dimmed and struck through, never hidden: its row is the only place to remove
it from. Whether each folder exists is read when the window starts, when `folders[]`
changes, and when a switch to it fails. It is not watched. A folder that comes back
stops being marked at the next read.

### W9.4 Going to a row

One click goes to a row. A double click is one click. Enter goes to the focused row.
Selection is not a concept in this list: the row the window is on carries the active
mark (W10.4), and focus is drawn as a line, not a band.

### W9.5 Reordering

Move Folder Up and Move Folder Down, also Alt+Up and Alt+Down while the list has
focus, move the whole row: a repository moves with every folder on its row. The ends
do not wrap. The edit is `reorderFolders`, queued behind every other workspace edit,
with each entry kept byte for byte; `updateFolders` would write every path out again.
There is no drag to reorder. No reorder restarts the extension host, the first position
included (W4). Worktrees move within their repository (WT-1.7).

### W9.6 Removing

Remove Folder, on the row's menu or from the palette for the focused row, takes the
folder out of `folders[]` and never touches the disk. On a repository's row it takes
every folder on that row: the repository's worktrees in the workspace and any other
spelling of its checkout (WT-8.8).

It asks first only when something would be lost, and removes at once otherwise, as
stock VS Code does: a folder taken out of the list is still on disk and can be added
back. Something would be lost when the folders leaving have:

- agents running, which will be stopped;
- terminals running a process, which will be stopped;
- editors with unsaved changes, shown or put away (W6.2), which will be closed - new
  files never saved (Ctrl+N) among them when the folder leaving is the one the window
  is on, as they are that folder's (W6.2).

One dialog says all of it at once - the path, what will stop, which files are unsaved -
with buttons that say what they do: Remove and Discard Changes, and Cancel; without
unsaved files, Remove and Cancel. Two buttons, as Delete Worktree has: the files are
named, and whoever wants them kept cancels, saves them and removes again. Escape cancels. There is no "do not ask
again" and no setting to turn it off: it only asks when something would be lost.
Remove Folder from Workspace in the palette and `facade --remove` take the same path.

A folder removed by an external workspace-file edit or `updateWorkspaceFolders`
uses a preservation path: keep its unsaved editors available in the active folder,
or as window editors if no folder remains; move its agents and terminals to the
panel and keep them running. Notify the person and offer Stop. Their existing run
identity and working directory are retained; workspace membership alone is not an
agent-exit event.

Changes are thrown away only after the workspace has taken the edit. Cancellation
leaves membership, running work and unsaved changes in place. Revalidate the affected members after asynchronous preparation, and propagate
a failed workspace-file edit. Do not stop processes before admission and save checks
have succeeded. If later steps fail, report the completed effects; do not pretend a
stopped process was restored.

Repository removal includes related agents/terminals in listed worktrees that have
not joined `folders[]`; name them in the same confirmation. External edits affect
only the members actually removed. Afterwards choose the fallback in W6.1. Clean
folder editor sets may be dropped, but preserve any dirty working copy still used
elsewhere. Colors and icons remain available for adding the folder again.

### W9.7 Customizing

Customize..., also F2 while the list has focus, opens a dialog (W10.7) for a display
name, a colour and an icon (W10.6). It is the only way to rename a row: there is no
inline edit. The name of a folder in the list is written to its `folders[].name`, VS
Code's own field for naming a root, so stock VS Code, `${workspaceFolder:name}` and
extensions call it the same; a row not in the list - a worktree that has not joined,
a repository whose checkout has not - keeps its name in the profile until it joins.
Colour and icon are kept per profile, by folder. Clearing every field forgets them
rather than storing an empty record. `folder` is the default icon and is stored as
nothing. A worktree's dialog has a name and a colour and no icon (WT-1.12).

### W9.8 One name

A folder has one name in a window: its `folders[].name` when it has one, else its
directory's name. The row, the title, the command center, the explorer header and
every folder picker use it. Editing `name` in the file by hand renames all of them, as
Customize does. An unnamed worktree is the one exception: its row, the title, the
command center and the explorer header call it by its branch, which follows a checkout
(WT-1.12); VS Code's own pickers read the file and call it by its directory, the branch
spelled with `-` for `/` (WT-2.2). Writing the branch into the file would freeze it.

### W9.9 Collapsing the bar

The title bar's first button collapses the bar to a column of icons and opens it
again. Collapsed, it is the same tree without its words (WT-1.10): each row keeps its
icon in its colour - the one chosen for it, else the folder icon - and a worktree its
dot. Pointing at a row names it at once, in a card to the right of the icon. The state and the open width are kept per profile. A profile that has never
touched the toggle starts open. Dragging its edge resizes the bar alone: the side bar keeps
its width, and the editor area gives or takes the difference, as it does when the bar is
collapsed or opened.

### W9.10 Zen Mode

Zen Mode hides the bar with the rest of the workbench and hides the toggle. Nothing is
persisted. The bar has no hide command of its own.

### W9.11 Keyboard and commands

| Key or command | Effect |
| --- | --- |
| Workspace: Switch Folder... | a quick pick of every row of the bar - projects and worktrees - most recently used first, the folder before this one selected; type to filter, Enter to go. Pressed again while its modifier is held, it moves down the list, as Open Recent does. It is on the terminal's list of commands that skip the shell, because the person is usually in a terminal. Its key is one that no default VS Code binding, common shell or agent CLI, or AltGr layout uses (W18) |
| Workspace: Focus on Workspace Bar | focuses the list |
| Up, Down, Home, End, type to find | move focus, matching names as displayed |
| Enter, one click | go to the row |
| Left, Right | close or open a repository with worktrees |
| F2 | Customize... |
| Alt+Up, Alt+Down | Move Folder Up/Down; on a worktree, Move Worktree Up/Down |
| Shift+F10, the context menu key | the row's menu |

Remove Folder has no key: it is a dialog away from a stray keystroke, and anybody can
bind it with `facadeWorkspaceBarFocus` as the condition. A command run from the
palette acts on the focused row, and with no focused row on the active folder.

### W9.12 The row's menu

The menu follows the row: a plain folder, a repository and a worktree each have their
own (WT-1.11).

### W9.13 Drops on the bar

The whole column takes a drop from outside the application and shows an overlay while
something is over it. A folder is added and shown, a file opens, a `.code-workspace`
opens a new window (W5). Over the editor area a document takes the drop as a place to go unless Shift
says otherwise; the terminal always takes it as a path to type.

### W9.14 Accessibility

The list is labelled "Workspace folders". A row reads its displayed name, then what it
shows: `lab, 1 worktree, 3 agents`. A folder not on disk adds "not on disk"; a worktree
adds "worktree".

## W10. Layout and appearance

### W10.1 The grid and the title bar row

The workspace bar is column 0 of the middle row, between the title bar and the status
bar. Otherwise the grid is upstream's: title, banner, middle row, status bar.
`adjustPartPositions`' `[2, 0]` becomes `[2, MIDDLE_FIRST_COLUMN]` (1): at 0 the
auxiliary bar lands left of the workspace bar. `verifyWorkspaceBarIsFirstInMiddleRow`
logs if the shape ever differs.

The title bar contains the workspace toggle, menu, command center, view-container
icons and layout controls. The toolbar host and placement are specified below.

The activity-bar locations, toolbar interaction and secondary-side-bar default are
specified in [ACTIVITY-BAR.md](ACTIVITY-BAR.md).

| Thing | Value |
| --- | --- |
| widths | 220 open, which is also the minimum; 480 at most; 36 collapsed, with both constraints pinned to it |
| the toggle | the title bar's first button, main window only, glyph ☰ (`menu`, registered as `workspace-bar-toggle`). A 36px cell at the window's left edge on Windows and Linux, so `File` starts at x=36 where the collapsed column ends. After the traffic lights on macOS (70 + 8), at the edge in full screen. Its tooltip says what a click will do. Not in Zen Mode |
| the custom title bar | kept, since it holds the toggle. `customTitleBarVisibility` `never` and `windowed` still remove it; the palette is then the way |
| the menu bar's overflow | `···` in every state, drawn as the row's other 22x22 icon buttons (radius 6). Upstream swaps it to ☰ when no menu fits; ☰ is the toggle's |
| the header | 28px, one row of the list, open and collapsed. `WORKSPACE` at x=10 on the icons' line and `+` at the right; collapsed, `+` alone |
| dragging | the command center's margin is 40 on each side, so the window can be moved by the title bar however full the row is (not in full screen, not in a browser) |
| the splash | draws the title bar and status bar across the window, and the bar between them |
| the app icon | `facade.titleBar.showAppIcon`, off: that corner is the toggle's |

### W10.2 Rows

A row is 28px, the compact activity bar's item height. The column is one 28px grid
from its top, level with a compact activity bar beside it. Collapsed to 36, every icon
stays where it was: an icon's centre sits at x=18 in both columns.

### W10.3 Text and icon colors

Use `facadeBar.foreground` for names, folder icons and the empty-state text, against
the activity-bar background. Keep that foreground in active and hover states. Do not
combine sidebar foregrounds with activity-bar backgrounds: themes may use different
contrast pairs. Earlier checks found the inactive icon color insufficient for 13px
labels in eleven of nineteen themes.

### W10.4 Active, hover and keyboard states

| Row | Drawn as |
| --- | --- |
| the folder the window is on | `modernActivityBarItem.activeBackground` and a 2px line down the leading edge in `facadeBar.activeBorder`. One line in the column, ever |
| hovered | `modernActivityBarItem.hoverBackground`: the same chip, lighter |
| the keyboard's row | the hover chip, only while the list has focus and the keyboard moved last. Never a second line |
| high contrast | no fill: a solid outline for the marked row, dashed for hover and keyboard, as `activityBar.css` does |

The foreground does not change on active or hover backgrounds. Kimbie Dark (3.59) and Quiet Light (4.26) fall
short of 4.5 on the marked row: the price of one ink rather than a name that changes
colour as it is marked.

### W10.5 Buttons and motion

The header's `+` and a row's `+` stand in one column: a 24px box, a 16px glyph,
`facadeBar.inactiveForeground`, and on hover the ink only, no chip. The `+` is nudged
half a pixel right and down, since the codicon's cross is not centred in its square.
Everything in a row that changes takes `--facade-motion`, 150 ms standard easing, and
0 with reduced motion (WT-1.14).

### W10.6 Folder colours and icons

- **Colours** are ten of Facade's own, one value each: a folder's colour is a tag, not
  a surface, and does not follow the theme.

  ```text
  red #DD443F   orange #C26016   yellow #9A760A   lime #618720    green  #2C8C46
  teal #208986  blue   #277CDC   indigo #7B6CD8   purple #A15FC7  pink   #CA4A9B
  ```

  Evenly spaced hues. Each lightness maximises the worst contrast across the nineteen
  backgrounds and the marked chip: 2.90. It cannot reach 3.0, as the surfaces fall in
  two clusters that no one value is darker and brighter than at once. `charts.*` was
  tried first and was wrong: `charts.orange` aliases a translucent find fill that high
  contrast leaves undefined. They are registered as `facadeBar.folder<Name>`, so a
  theme can still change them. The colour paints the icon only, never the name or the
  row.
- **Icons** are ten, chosen to survive 16px, to be told apart at a glance, and to say
  what a folder is rather than what it is doing: `folder rocket beaker server database
  globe device-mobile book tools package`. `folder` is the default, so choosing it is
  choosing none. A worktree's icon is a dot, not chosen (WT-1.12).
- **Collapsed**, each row keeps its icon in its colour (W9.9).

Every distance, radius and size in `workspacebarpart.css` is a registered token,
except the header's height, which is `ROW_HEIGHT`. The bar's own colours are
registered as `facadeBar.*`; upstream is free to add `workspaceBar.*` of its own.

### W10.7 Dialogs

Facade's two forms - New Worktree and Customize - take their frame from
shadcn/ui's Dialog as its own site draws it (`facade-dialog`; measured on
ui.shadcn.com/docs/components/radix/dialog), and what is in the frame from VS Code.

The frame is shadcn's. The box is 384 px, padded 16, rounded 14, with a hairline ring
and no shadow, over the window dimmed by a tenth and blurred. Its layout: the title, the
description 8 under it, the fields 16 under that and 20 apart - a label, its control 8
under it, a hint 8 under the control - and the buttons on a band of their own across the
foot of the box, a hairline above it and a muted fill under it, as wide as their labels,
8 apart at the trailing end with the primary last on every platform; the close button a
28 px square 8 in from the corner. Its title is 16 px; its controls are 32 px high. A
note above the fields is an alert - bordered, rounded 10, padded 8 by 10. The choice of
a colour and of an icon is the frame's too: 24 px swatches and 28 px icon squares, 8
apart, each row on one line.

What is in it is VS Code's. The font is VS Code's on each platform, in VS Code's weights:
the title and the labels semibold, the rest regular - the alert's every line, its first
too, is body text. Its sizes
are VS Code's but for the title's: VS Code's body size, 13 px, for the description, the
labels, the hints, the inputs and the alert, and VS Code's 12 px for the buttons. The
buttons are VS Code's - the primary and the secondary as VS Code draws them, their
colours, corners and focus outline - and so are the inputs. Every colour is the theme's,
so every theme, high contrast included, draws the forms; `facadeDialog.*` names those of
the frame's parts VS Code has no colour for: its lines, its band and its choices.

VS Code has no form of their kind - stock has one, an input box for proxy
authentication - and `IDialogService` takes no fields like theirs. They are built on VS
Code's dialog widget, both through `IWorkspaceBarDialogService`. Agent launch and
configuration use the menu, Quick Pick and ordinary Settings editor defined in
AGENT-LAUNCHER.md L3 and L7.

Every other dialog is a question, shown as VS Code shows its own: the operating system's
dialog, `window.dialogStyle` left at stock's `native`. VS Code's own questions - "Save
changes?", deleting a file - and the questions Facade asks: Remove Folder, Delete
Worktree, Delete Chat Rooms. Facade's are worded as VS Code words its own, in its shape:
a question, then under it what it lists one to a line, when it lists anything, and one
paragraph. The message is the question, naming what it is about in single quotes as its
row names it, and what goes with it: "Are you sure you want to remove 'lab' and its
worktree from the workspace?", "Are you sure you want to delete the worktree 'w2'?". The
paragraph says what stops and what is lost - agents by name, terminals by title, files
by name as VS Code names them - and then what is not, or that it cannot be undone:
"Pinger and terminal 'PING' will be terminated, and unsaved changes in note.txt will be
discarded. Files on disk will not be deleted." The primary button is the verb, beside Cancel.
A question about losing something has the warning icon, whether or not anything is lost
this time, as VS Code's delete does. It is plain text, so it reads the same in a system
dialog. Facade does not ask what VS Code already asks: closing an agent's
terminal from the list of active agents is VS Code's question for closing a terminal, and
closing the window with work running is VS Code's question before shutdown (W11), which
names an agent by the name it was started under, not by its terminal's title. What VS
Code itself always draws in the window - its trust questions - stays so, and Facade's own
trust question, for folders that are not trusted joining the window (W5), is drawn as
those are: in the window, with the shield, its paths as code, VS Code's docs linked, and
no sound. `custom` draws every question in the window, in VS Code's look.

The questions' buttons follow the platform's order, as the system's dialogs and VS
Code's in-window ones do: on Windows the primary button first, on macOS and Linux last.

## W11. Reload, restart and other windows

| Event | Required result |
| --- | --- |
| Reload Window | Restore the active folder, row layout, editor sets including hidden dirty editors, scope and bar state. Reconnect terminals whose processes survived. Agents reconnect to those same processes; do not ask to stop them |
| Close window or quit | Ask once before stopping agents or terminals running a process, including hidden ones: VS Code's own question (`terminal.integrated.confirmOnExit`, `hasChildProcesses` by Facade's default), Terminate or Cancel. Facade has it count the terminals kept in the background for folders the window is not on, which stock does not see, and name under it the agents and terminals that would stop, each with its folder (`terminalShutdownQuestion`). Use normal unsaved-file handling, including hidden dirty editors. Any cancellation cancels shutdown |
| Start the app again with `window.restoreWindows` | Restore folders, editor state, scope and layout. Terminal scrollback or a revived shell is not proof the old process survived. End agent runs whose processes ended; never label a replacement shell as the previous live agent |
| Renderer crash with surviving processes | Reconnect using the recorded process/run identities. Preserve unsaved backups; do not relaunch an agent or replay setup merely because its UI was restored |
| Save Workspace As | Transfer active folder, editor sets, scope and collapsed repositories to the new workspace storage; keep the file in the ordinary format |
| Open the same workspace from another window | Bring the existing window forward, as stock |
| Switch profile | Use that profile's colors, icons, worktree order, width and collapsed state; retain workspace membership, names and active folder |
| File > Close Workspace | Apply the same checks before disposing this workspace, then make the window EMPTY |
| Use a remote window | Match folder and terminal URIs by scheme and authority. A caller needing a local path must not receive a remote folder |

Closing, quitting and replacing a workspace use the same lifetime checks. A folder
switch or repository collapse never counts as closing a workspace. Agent lifetime
and final-screen handling follow AGENT-LAUNCHER and AGENT-DEBUGGING.

# Part 2: Technical Design

## W12. Implementation boundaries

Use the existing service layers and keep Facade code together. Changes in upstream
files are optional hooks (ENGINEERING). The workspace bar renders the model; it must
not be the only owner of operations needed by command-line and agent callers.

| Component | Responsibility |
| --- | --- |
| Workspace edits: `WorkspaceService` (`services/configuration/browser/configurationService.ts`) through `IWorkspaceEditingService` | Serialized edits to the complete folder list. `reorderFolders` and `renameFolder` (W9.7, to be added) keep unrelated JSONC contents and original path spellings byte for byte |
| `IActiveFolderService` (`services/activeFolder`) | Current selection, restoration and membership reconciliation; `activeFolderFor(scheme, authority)` for default-directory callers. Name changes notify label consumers without restoring editors |
| `WorkspaceBarSwitcher` (`browser/parts/workspacebar`) | The switch coordinator: the complete W6.2 operation - latest-wins queue, capture, revalidation, restore, focus - with an explicit success, cancel or failure result |
| `WorkspaceBarEditors` | Folder working sets plus retained dirty working copies and their backup ownership. Never prune a dirty model just because its folder left |
| `IFolderTerminalsService` (`contrib/folderTerminals`) | Folder ownership, background terminals, visibility and promotion to the panel under W9.6 |
| `IFolderScopeService` (`services/folderScope`) | One shared search/picker/Problems scope; filter presentation rather than markers or extension-host data |
| `WorkspaceBarModel`, `WorkspaceBarView`, `WorkspaceBarGit` | Canonical directory comparison and availability; rows, selection, ordering and collapsed state; git's records read and watched (WT-3) |
| `IWorkspaceBarService` (`workspaceBarService.ts`), `openOrShow` | `show`, `add`, `addAndShow`, `remove` and the other entry points every caller uses - row, palette, command line, agents |
| `workspaceBarCustomization.ts`, `IWorkspaceBarDialogService` (`workspaceBarCustomize.ts`), `IWorkspaceBarAgentsService` | Colours, icons and names of rows not in the list, worktree order, per profile; the New Worktree and Customize forms; what runs on each row |
| `IWorktreeService` (`contrib/worktrees`), `extensions/git/src/worktreeAt.ts` | The create, setup and delete operations of WORKTREE.md; git and the filesystem in the git extension |
| `windowsMainService.joinsTheOpenWindow`, the hook in `WorkspaceChangeExtHostRelauncher`, the trust gate | W4/W5 routing for dialogs, drops, the command line and extension commands; no restart on a `folders[0]` change; W5's trust question |

Keep the active-folder query available to default-directory consumers. A query with
scheme/authority requirements returns the selected matching folder, else the first
matching member. It must never return a folder from an incompatible filesystem.

Call the coordinator directly for a requested activation and await its result.
Change events announce facts for views; they do not substitute for completion of a
particular request. If an existing will-change joiner participates in state capture,
its failure must abort that preparation rather than be swallowed as lost state.
Include the target URI in any editor-restored notification retained for observers.

Retaining dirty editors requires integration with working-copy lifetime, Save All,
Revert All and backup restoration. A stored working-set id is not sufficient. Store
folder ownership alongside editor state, deduplicate working copies by resource,
and retain them through cancellation, failed saves and membership reconciliation.
When ownership is missing or corrupt, expose recovered dirty editors in the window
rather than dropping them. Do not manipulate another component's private storage
keys to accomplish this; add a narrow API where required.

Keep worktree setup in a contribution because it uses terminals. The workspace bar's
browser layer must not import terminal contributions. Git execution stays in the
Git extension. Profile customization and repository reads remain separate from
workspace-file membership.

## W13. Performance

Keep loaded folders resident in the extension host. Switching only the visible
folder avoids repeatedly rebuilding language-server project state. The cost is
that inactive folders can still activate extensions and use memory or CPU, as they
do in stock multi-root workspaces. Do not promise that adding folders is free.

The first design kept the list private and swapped one folder in and out of
`folders[]` on each switch. A folder swapped back rebuilt its project graph every
time (19237 and 18688 ms against 1750 ms resident), and changing `folders[0]`
restarted the extension host on every switch (about 1 s, whatever the folder's
size). Withholding a folder from the extension host until it is needed was not
chosen either: it would save the memory a language server takes - one Java folder
nobody opened costs 1.2 GB, because `workspaceContains:` starts jdt.ls - but
extensions would see a list the workbench does not have, and `${workspaceFolder}`
would drift from it.

Earlier measurements reported switches of 49-86 ms over six switches and substantial
extra memory for some language servers. Those observations explain the direction;
they are not a portable acceptance threshold or evidence for a new build.

Measure from input to a settled active-folder view, including editor restoration
and focus. On the reference machine a warm switch settles within 100 ms at p95: past
that a switch stops feeling immediate, and people go back to one window per project.
A build also stays within the comparison gate against the build before it, so it
cannot drift slower one release at a time. Report cold first visits separately from
repeated switches. Use the fixed fixture, sampling procedure and comparison gate in
W19.
Record the machine, OS, build, extensions and repository sizes with the result.
Always verify zero extension-host restarts during switching. Local results do not
establish latency for disconnected or remote filesystems.

## W14. Measuring a running window

Each of these produced a wrong answer before it was known.

```text
out/ behind the source      transpile, kill by --user-data-dir, fresh profile, every run
two windows open            a CDP driver must refuse to guess which one it is reading
.click()                    does not drive a VS Code list or action bar: real mouse events
a virtualised list          has DOM for visible rows only; scroll with real wheel events
an HTML5 drag               CDP's dispatchDragEvent needs several dragOver events before the
                            overlay is up; on macOS CDP cannot drive one at all - neither a
                            row nor an activity icon can be reordered there without real
                            OS mouse events
an OS-level drag            needs the window in front, or the first mouse-down only activates it
drag regions                are decided by the window manager: ask Windows (WM_NCHITTEST), or
                            drag for real - a synthesised event proves nothing
contrast                    composite alpha onto the real background first
themes                      workbench.colorTheme takes a settingsId, not a label, and the switch
                            must be asserted
a negative result           needs a control that produced the positive somewhere
a language server           verify actual activation; workspaceContains can start it
                            before any file is opened
the pointer                 a hovered row is painted differently: park it before measuring
```

# Part 3: Acceptance

## W15. Test levels and evidence

| Level | Evidence |
| --- | --- |
| U | Automated service/model tests; deterministic delays and faults. The existing Git-extension suite also includes real temporary Git repositories, which must be identified in the run record |
| I | A real development window, fresh isolated profile and real repositories. Probe both workbench state and what an ordinary installed extension observes |
| H | A visible interaction/accessibility check at a recorded OS, theme and zoom, with screenshots where relevant |
| S | The same supported action in the pinned upstream build, with each expected difference listed in W8 |

Run the W3 invariant probe after each settled integration step. Compare the selected
folder, active row, Explorer, SCM, scope, title, extension-visible folders and the
actual workspace file. Also record unsaved content and terminal/process identity
when the case concerns preservation. A successful command result alone is not proof.

Run restart checks in a normal development window. Upstream explicitly skips the
workspace relauncher when `extensionTestsLocationURI` is set, so a test launched
only in that mode cannot prove that ordinary windows avoid restarts. Use a small
probe extension loaded normally and record its process identity and activation
count. First demonstrate the upstream restart as the positive control.

A test's title begins with the id of the case it holds: `WS-17 an unsaved editor is
never closed by a switch`. A table check lists every case id - WS, WTA and ID - with
the tests that name it, and fails on an id that no test names unless the id is listed
with the manual procedure that holds it instead. A name shows where a case is held,
not that it passes.
Record PASS, FAIL, BLOCKED, NOT RUN or ACCEPTED DEVIATION, the build and evidence.
Only the person can accept a deviation. Specs contain requirements, not run results.

For each regression test, demonstrate that the relevant fault or old behavior makes
it fail. Use real Git for checkout/removal/file semantics; mocks are appropriate for
coordinator ordering and injected failures. Match validation to the change under
ENGINEERING and the Copilot instructions: CSS changes need stylelint, layer changes
need the layer check, and a documentation-only change needs document consistency
checks rather than a client build.

W19 gives the fixture, test order, failure cases and release gate.

## W16. Acceptance matrix

The activity-bar cases WS-45 through WS-47 are in
[ACTIVITY-BAR.md AB5](ACTIVITY-BAR.md#ab5-acceptance-matrix). Existing case ids remain
unchanged across both documents.

### W16.1 The workspace

| ID | Level | Setup and action | Required observation |
| --- | --- | --- | --- |
| WS-01 | U, I | Start with no arguments and nothing to restore; again with windows to restore; New Window; macOS Dock with no window | The default workspace is created as `{ "folders": [] }` and opened; restored windows win; New Window is empty; the Dock opens the default workspace |
| WS-02 | U, I | Open Default Workspace from another workspace; with the file missing; with a directory in its place; in a remote window | Use W4 workspace routing to open it in a new window or focus its existing window; create it if missing. A directory in its place produces an empty target window with a logged reason. Never open it remotely |
| WS-03 | U, I | Open Folder with a new folder, with a folder already listed under another spelling (link, junction, case), and with three folders | Added verbatim and shown; no second row, the window moves to the existing row; one edit and one move, onto the last |
| WS-04 | I | New Window; open a folder in it, then a second; close that window while another is open | The first folder opens the window on it, as stock; the second makes an untitled workspace in place with one extension-host restart and no reload; closing asks to save, as stock; nothing is saved unasked |
| WS-05 | I | Open Recent: a folder, a folder with Ctrl/Cmd, a workspace, a file; File > Open Workspace from File | Shown; a new window; a new window, this one keeping its list; an editor here; a new window |
| WS-06 | U, I | Add through Add Folder to Workspace, `updateWorkspaceFolders`, and the file by hand | Added at the end; the active folder does not change; the bar redraws without a reload |
| WS-07 | U, I | Drop on the bar and on the editor area: a folder, three folders, a file, a `.code-workspace`, a mix; the bar's `+` with one folder and with three | Folders, on either target and through `+`: added, then one move to the last. A file opens. A workspace file opens a new window and its folders are not added |
| WS-08 | U | Drop on text-like targets: a document with and without Shift, the terminal, a text field the editor owns and one it does not | Each takes or leaves the drop as W9.13 says |
| WS-09 | I | `facade <folder>` with a workspace window open; with a FOLDER window open; with the folder in another window; with an empty last window; with no window open; with `--new-window` | Joins and shows; joins and shows, the FOLDER window entering an untitled workspace; that window forward; a new window; the default workspace opens with the folder added and shown; a new window. No other second window appears |
| WS-10 | I | `facade <a> <b> <file>` with a workspace window open | One edit, one move to `b`; the file opens among `b`'s editors and is not captured into the previous folder's set |
| WS-11 | I | `facade --add <folder>`; `facade --remove <folder>` with an agent running in it | Added, the window stays; the removal asks first, as W9.6 says |
| WS-12 | U, I | A folder on an unconnected remote; a `vscode-vfs://` folder; an extension's `vscode.openFolder` on a folder, on a workspace, and with `forceNewWindow`; git's Open Worktree in Current Window and in New Window | A window; this window; shown here, a new window, a new window; shown here, a new window. The window's list is never replaced |
| WS-13 | I | Open a directory as a file and press its Open Folder | Shown in this window |
| WS-14 | U, I, H | Git: Clone with `openAfterClone` unset, `always` and `prompt`; Git: Initialize Repository on a folder outside the workspace | Unset or `always`: the clone is shown in this window, nothing asked. `prompt`, and the initialized repository: VS Code's question, word for word - Open, Open in New Window, and Add to Workspace when the window has folders; Open shows it in this window, Add to Workspace adds it without leaving the folder the window is on |
| WS-15 | U, I | Click a row, press Enter, choose the row the window is on, double click | Moves once; the active row does nothing and fires nothing; a double click is one move |
| WS-16 | I | Switch between two folders whose editors include split groups, a preview tab, a pinned tab and an auxiliary window | Each folder's editors come back as they were left; a never-seen folder starts with none |
| WS-17 | I | Hide dirty text and untitled editors by switching folders; reload before saving, then return. In a separate run use Save All from another folder | Leaving asks nothing and nothing marks the row. Reload restores the exact dirty contents to their owner folders. Save All includes hidden editors and uses normal Save As handling; a successful save clears dirty state without changing folder ownership |
| WS-18 | U, I | Switch while a terminal in the editor area runs a process, with `followFolder` on and off; `cd` it out of its folder; open a terminal in the panel | On: put away and brought back with the same process and scrollback; its tab names no folder until its shell leaves the folder, then the one it went to. Off: stays on screen and its tab names its folder; the process never restarts. The panel's names its folder |
| WS-19 | I | Switch to a folder deleted from disk while the window was open | Error notification naming the path; the row is struck through; the window stays; W3 holds |
| WS-20 | I | Open a file of another folder by Go to Definition, Quick Open widened, and a drop; open a terminal; change a terminal's directory | The active folder never changes; the new terminal starts in the active folder |
| WS-21 | U, I | Remove the active member at the first, middle, last and only position through each supported path | Choose the member at its former folders[] index, else the last, else none; W9.6 governs the different interactive/external preservation paths |
| WS-22 | U, I | Rename the active folder's `name` in the file; give it a display name in Customize; reorder rows around it | The row, title, command center and explorer header show one name - the display name when there is one - without restoring editors; a reorder is not a change of folder |
| WS-23 | U, I | Start a workspace with a stored active folder, a stale stored folder, no stored folder with an active editor, and none | Stored wins; stale falls back; the editor's root is taken once; else the first folder |
| WS-24 | I, H | Read every W7 surface after a switch and with no editor open | Each names the active folder (W3.3) |
| WS-25 | U, I | Search, Go to File and Go to Symbol narrowed and widened; switch while widened; a file outside every folder; reload | One scope for all three; widened survives a switch and a reload; the outside file is always found |
| WS-26 | U, I | Problems with markers in two folders, narrowed and widened | Count and list follow the scope; nothing is removed from `IMarkerService` |
| WS-27 | U, I | SCM with two repositories in two folders; a folder without a repository; switch; reload | Changes lists the active folder's; the status bar follows; the other folder's repository is still selected after switching back |
| WS-28 | U, I | Every "which folder?" picker of W7 | Every folder listed, the active one first; the API caller of `showWorkspaceFolderPick` still gets the workspace's order |
| WS-29 | I | Add a folder, remove one, reorder through the first position, switch, and widen, with an extension logging `workspaceFolders` and its events and a debug session running | The extension sees every folder in order; no event on a switch; no extension-host restart at any step; the debug session survives |
| WS-30 | U, I | Add one folder twice in one call; add it under two spellings; add a folder that does not exist yet, then create it | One row each; the spelling given is the one written; the missing folder matches once it appears |
| WS-31 | U, I | Delete a listed folder on disk, start the window, then restore the folder | Struck through, never hidden, still removable; unmarked after it returns and the list is read |
| WS-32 | U, I | Move Folder Up/Down through the middle, the ends and the first position, on a repository with worktrees in the workspace; edit the file meanwhile | Whole rows move; ends do not wrap; every entry stays byte for byte; no extension-host restart |
| WS-33 | U, I | Remove Folder - from the row, from the palette's Remove Folder from Workspace, and by `facade --remove` - on a plain idle folder, a repository with worktrees, a folder running an agent, a folder with a running terminal, a folder holding unsaved files shown and put away, and the folder the window is on with a new file never saved (Ctrl+N) on screen | Idle: removed at once. Otherwise one dialog naming everything that would be lost, the Ctrl+N file among it; with Remove and Discard Changes / Cancel when files are unsaved; the same from all three paths; nothing on disk changes; the repository takes its row's folders; no "do not ask again" and no setting |
| WS-34 | U, I | Customize name, colour and icon; clear them; reload; switch profile; remove and re-add the folder; open the file in stock VS Code | The name is in `folders[].name`, and stock VS Code, `${workspaceFolder:name}` and the folder pickers show it; colour and icon kept per profile and through removal; cleared means forgotten |
| WS-35 | U, I, H | Collapse and open the bar, drag its width, reload, switch profile, enter Zen Mode; collapsed, look at folders with and without icons | Pinned at 36 collapsed; width and state per profile; instant name card collapsed; every row keeps its icon in its colour; Zen hides bar and toggle and persists nothing |
| WS-36 | I, H | Every key and command of W9.11, and Shift+F10, with the list focused and unfocused | Each does what W9.11 says; palette commands act on the focused row, else the active folder |
| WS-37 | I | A screen reader's labels for a plain folder, a missing folder, a worktree, and a closed repository with agents | W9.14's labels |
| WS-38 | I | Reload, then separately quit and restart, with editors, terminals, scope and collapsed state | Restore workspace/editor state in both cases. Reload reconnects surviving processes; restart never presents a revived shell as the old live agent. The first drawing groups cached worktrees |
| WS-39 | I | Save Workspace As from the default workspace and from an untitled one | Active folder, editor sets, scope and closed repositories carried; the file is ordinary |
| WS-40 | I | Open the same workspace from a second window; switch profile | W11 |
| WS-41 | S | Open the written workspace in the pinned upstream build; exercise every W8 preserved behavior in both products | File format is accepted; settings/tasks/launch data survive. Runtime differences match the explicit W8 exceptions; file readability alone does not establish parity |
| WS-42 | I, H | Measure the grid, widths, toggle position on Windows and macOS, header, overflow glyph and title bar drag regions | W10.1, with drag regions asked of the window manager |
| WS-43 | H | Every W10 mark, ink and folder colour in Dark Modern, Light Modern, HC Dark, HC Light and the nineteen themes | W10.3-W10.6: the marks and ink as specified, contrast composited onto the real background; folder colours are W10.6's ten, none under 2.90 on the nineteen backgrounds |
| WS-44 | I | Run the cold/warm performance procedure in W19.6 on the pinned fixture and baseline | Report distributions, not six selected timings; warm p95 within 100 ms and within the comparison gate; no extension-host restart during switches |
| WS-48 | U, I | With trust on, add an untrusted folder through Open Folder, a drop, `facade <folder>` and the file by hand; drop several at once, trusted and not, in one parent folder and in two, and twelve; answer each choice, the box ticked and not, and follow the link | Facade's paths ask first, once, with VS Code's trust question in the window: the shield, the folders not trusted - ten named, the rest counted - two buttons, the parent-folder box only when they share one, and the link. Trust and Add adds them all, those listed trusted (their parent, ticked); the link opens all of them in one new window and adds none here; Cancel adds none. The file's path meets VS Code's question; No takes the folder back out and offers a new window. Facade's own paths never put the window in Restricted Mode; the file's path does only until the folder is out again |
| WS-49 | I | Close the window and quit with an agent running in a folder not on screen, then with a running terminal, then with nothing running; reload with an agent running | One question, VS Code's, Terminate or Cancel, naming what will stop when something runs - the agent in the folder not on screen too - none when nothing does; the reload asks nothing and the agent reconnects |
| WS-50 | I | Set git's editor to `facade --wait`, start `git commit` in a terminal, switch folders before saving the message, switch back; the same with a merge editor opened from the command line | The waited-on editor stays open through the switches; git waits until the person closes it |
| WS-51 | I, H | Open the settings editor's Workspace tab and an extension's Enable/Disable (Workspace) in a window of three folders | Each says it applies to all folders in this window |
| WS-52 | I | Leave a folder with focus in a terminal, another with focus in an editor; switch back to each by mouse and by Switch Folder...; enter a folder for the first time | Focus returns where it was left; the first visit focuses the editor; the next keystroke reaches it, not the bar |
| WS-53 | I | In an agent's terminal, press Switch Folder...'s key; pick by typing; press it again with its modifier held | The quick pick opens over the terminal, rows most recent first with the previous folder selected; typing filters; held, the key moves down the list; the shell receives nothing |
| WS-54 | I, H | Close an unsaved file, delete a file, remove a folder, delete a worktree, open Customize and New Worktree, on Windows and macOS; then set `window.dialogStyle` to `custom` | The questions are the system's dialogs, Facade's in plain text as VS Code's are, the trust questions in the window as stock has them; the two forms in Facade's look in the window with the primary button last under W10.7; questions use the platform's button order (primary first on Windows, last on macOS); with `custom` every question is drawn in the window in VS Code's look |
| WS-55 | I | Remove an active or inactive folder with dirty editors and agents through the file and API; repeat for the last member | Preserve exact dirty contents and agent process identity; expose retained work in editors/the panel, including when no active folder remains; notify and offer Stop |
| WS-56 | I | Close Workspace from default and saved workspaces, with dirty editors and running work; cancel, then confirm | Cancellation retains the workspace and its work; completion makes the current window EMPTY after W11 checks, without quitting the app |
| WS-57 | U, I | On A, request B and delay it; request C, then D, while B runs; separately remove, rename or reorder the destination during capture/restore | B completes, C never runs and its caller is told it was superseded, the window ends on D; no earlier request overwrites a later one; the final active folder is a current member and editors belong to the correct context |
| WS-58 | U, I | Fail outgoing capture; separately fail incoming restore; invoke a dependent file/setup operation | Capture failure: the window stays where it was and says why. Restore failure: the window stays on the destination and says why, editors still open stay on screen and both saved sets are kept. Callers receive failure and do not continue as if activation completed |
| WS-59 | U, I | Save All with hidden untitled content; cancel Save As, fail a write, share one resource across two folder sets, corrupt ownership metadata | Dirty contents survive; save once per working copy; both contexts reflect a save; unknown ownership exposes recovered editors rather than dropping them |
| WS-60 | U, I | Remove a folder holding unsaved files and press Cancel; then Remove and Discard Changes with the membership edit failing; externally edit the file while confirmation is open | Two buttons. Cancel removes, stops and throws away nothing; a failed edit leaves the changes there; unrelated edits survive; membership and any stopped work are reported truthfully |
| WS-61 | U, I | Fail an add/show after membership was written; open a mixed folder/file request | Report the added-but-not-activated state and the path; no file is silently placed in the outgoing folder's saved editor set |
| WS-62 | I | Run folder-change restart checks in a normal dev window and a test-host window, with the upstream build as control | The ordinary-window probe detects upstream restarts and verifies Facade's declared exceptions; test-host suppression cannot supply the only evidence |
| WS-63 | U, I | Make a remote/provider read unavailable during navigation; restore it; use two authorities with the same path | Correct authority throughout; an unavailable read is reported accurately, never silently treated as successful activation or proof of deletion |
| WS-64 | I | With agents running in the folder on screen and in a folder kept in the background, end the window's renderer process and choose Reopen | The same processes come back in the same terminals, under their titles; none is relaunched or recorded as ended; unsaved backups are kept |

## W17. End-to-end gate

On the primary OS, with a workspace of four folders - a repository that has a
`.worktreeinclude`, a `.facade/worktrees.json` and an LFS file, a second repository, a
plain folder and a missing one - and an extension that logs what it sees:

1. Start with nothing to restore. Open three folders from the dialog, one at a time
   and then two at once. Drop one on the bar and one on the editor area.
2. In each folder open editors, a split, a terminal in the editor area, and an
   unsaved change. Switch through all of them twice, by mouse and by keyboard.
3. Widen and narrow the scope; search, read Problems and SCM in each folder.
4. Make a worktree from the row's `+` with a name and a colour, one from the plain
   folder that has no repository yet, one with `git worktree add` in a terminal and
   one through an agent. Switch through them; close and open the repository; reorder
   two worktrees.
5. Reorder folders through the first position with a debug session running, rename
   one in the file, customize two rows, collapse the bar, switch by Switch Folder...
   from an agent's terminal, remove the active folder while it holds an unsaved file.
6. `facade <folder> <file>` from a terminal outside the window; Open Recent with
   and without the modifier, on a folder and on a workspace; add an untrusted folder.
7. Delete a worktree with uncommitted changes while the window is on it and a shell
   runs inside it; make git refuse a second delete, then let it succeed. Remove the
   repository's folder, turn worktrees off and on, and add it back.
8. Reload, then restart; close the window with an agent running. Then open the
   workspace file in stock VS Code.

The gate passes when W3 holds after each settled step, W16, ACTIVITY-BAR.md AB5 and
WT-12 observations
match, and the probe reports only the documented lifecycle transitions. Switching
and membership edits in an existing WORKSPACE window do not restart extensions;
the stock FOLDER-to-WORKSPACE transition is recorded separately. Preserve unsaved
content and ask before stopping work. Creation adds no unwanted source ignore or
settings entries; expected Git metadata and explicit initialization are allowed.
Normal setup is submitted once. Successful deletion leaves no directory; an injected
cleanup failure is reported as WT-8.6 says. The resulting workspace
opens in the pinned upstream build. Run the additional failure cases in the testing
plan before declaring L1 complete.

## W18. Limits and remaining release decisions

- The legacy workspace.rootPath compatibility exception is intentional (W4/W8).
- Hidden dirty tabs are required for text and untitled editors. Other editor types
  stay visible until their preservation path is verified (W6.2).
- The default Switch Folder shortcut still needs a platform/keymap decision and
  checks against the supported shells, agent CLIs and AltGr layouts. Do not claim
  its keyboard acceptance case has passed before a binding is selected and tested.
- W10's grid, title-bar drag regions, menu glyph and icon-theme alignment require
  a running-window check, especially after an upstream merge.
- W10 retains theme-based folder colors and documents the existing text-contrast
  exceptions. These are visible design limits, not proof of accessibility compliance.
- Remote workspaces, non-TypeScript symbol providers, notebook kernels and edit
  sessions need their actual integration evidence. Record unsupported combinations
  explicitly rather than inferring support from local unit tests.
- A folder refused on VS Code's trust question after a file or API edit has already
  joined: the window is in Restricted Mode until the folder is taken back out.
  Refusing the edit before it applies needs a veto in upstream's workspace service,
  which is not built (W5).
- Merging complete workspace files is out of scope. Their settings, tasks and launch
  configurations cannot be combined by concatenating folders. Any future operation
  that only adds the folders must be described in those words.

There is no switch back to stock VS Code. ENGINEERING gives every feature one and
names the workspace as the exception: the workspace bar is the product, so its off
state is VS Code itself, and comparing with stock uses the pinned upstream build
(WS-41). A switch would double every entry point and every test for a mode that a
person who wants it already has. Implementation and test status belongs in the run
records described by W15.

# Part 4: Test Execution

## W19. Shared test plan

This is the execution plan for this document, [ACTIVITY-BAR.md](ACTIVITY-BAR.md)
and [WORKTREE.md](WORKTREE.md). Their WS and WTA tables define the expected behavior.
This section defines fixtures, observation, fault injection and the release gate.
It is not a record that the implementation has passed.

### W19.1 Start with the highest-risk contracts

Run these groups in order. Keep each regression test near the existing service or
Git test it exercises; do not build a second general-purpose test framework.

| Order | Contract | Existing test area | Acceptance coverage |
| --- | --- | --- | --- |
| 1 | Activation ordering, membership and recovery | activeFolderService.test.ts; workspaceBarSwitcher.test.ts | WS-15, WS-19, WS-21..23, WS-57..58, WS-61, WS-63 |
| 2 | Dirty editor ownership, save/cancel and backup restore | workspaceBarEditors.test.ts plus real workbench editor/working-copy tests | WS-16..18, WS-33, WS-38..39, WS-49..50, WS-55..60 |
| 3 | Git effects and file preservation | extensions/git/src/test/worktreeAt.test.ts, using real Git | WTA-12..20, WTA-22..24, WTA-28, WTA-31..35, WTA-38 |
| 4 | Workbench create/delete coordination and setup | contrib/worktrees/test/browser/worktrees.test.ts plus a real dev window | WTA-13..18, WTA-21..27, WTA-30, WTA-33..37 |
| 5 | Entrances, compatibility and cross-document lifetime | workspace bar/model/drop tests plus a normally loaded probe extension | WS-01..14, WS-20..41, WS-48..56, WS-61..64; WTA-01..11, WTA-25..27 |
| 6 | Visible interaction, accessibility and performance | Real mouse/keyboard input, screenshots and timing records | WS-35..37, WS-42..47, WS-51..54; WTA-06, WTA-08..09, WTA-13, WTA-29, WTA-37 |

The ranges identify test groups. Test titles begin with their case id, and W15's
table check lists each id's tests, or the manual procedure that holds it. A group
running is not evidence that every id in its range passed.

### W19.2 Reproducible fixture

Use a short temporary root on the filesystem being tested. Verify resolved paths
stay within that root before recursive fixture cleanup. Never use the person's real
checkout, Git configuration, credentials, hooks or agent conversations as fixtures.
Record Node, Git, OS and tested app versions. Use Node 24 as ENGINEERING requires.

Create the following with real Git and a local test identity:

- repo-a with two commits, a local branch, a local bare remote with a remote-tracking
  branch, and two linked worktrees. One worktree is initially absent from folders[].
- repo-b with a different main checkout, plus a plain folder and a missing folder.
- Tracked files, an untracked file, ignored .env and local/ files, and include rules
  for a single descendant and an excluded subtree. All contents are test sentinels.
- Separate variants for detached HEAD, a bare repository's worktree, submodules,
  separate Git directories, relative worktree links, locks and reftable when supported.
- Setup commands that append unique markers to a test log outside the repository.
  This allows independent checks of order and duplicate submission.
- A workspace file containing relative/absolute paths, comments, display names,
  settings, tasks and launch data. Include a duplicate spelling via a supported
  link/junction and two repositories with the same directory name.
- A deterministic long-running test process that reports its PID and accepts input;
  use registered agent fixtures for agent lifetime checks. Add a real supported CLI
  smoke check where the agent specifications require it.

Before destructive cases, record file contents, refs, worktree records, membership,
working-copy contents and process identities. Assert those facts afterwards rather
than trusting a notification or a command result.

### W19.3 Tests that must fail against the old behavior

| Scenario | Controlled action | Required assertion |
| --- | --- | --- |
| Stale activation | Hold A-to-B capture; remove B before releasing it | B never becomes the final active folder; remaining content is preserved |
| Out-of-order activation | Request B then C; delay the first operation | Final selection and editors are C; B cannot finish later and overwrite C |
| Superseded request | Request B and delay it; request C, then D, while B runs | C never runs and its caller is told; the window ends on D |
| Capture/restore failure | Fail capture, then independently fail restore | Capture: the window stays where it was. Restore: it stays on the destination. Either way the failure is visible, no captured state is lost and dependent work is not started |
| Hidden dirty state | Hide dirty text and untitled files; reload before saving | Exact sentinel contents and folder ownership survive, even when the visible folder differs |
| Save cancellation | Save All reaches a cancelled Save As or failed write | Dirty content survives |
| Shared resource | Open one resource from two folder contexts, edit it and save | One working copy and one save; both contexts observe the result |
| Ignored-only deletion | Put only an ignored .env in an otherwise clean worktree | Empty Git status is not represented as proof that no local file will be lost |
| Partial deletion | Let Git remove the record, then make directory cleanup fail | A notification names the path and the completed effects, with Reveal in File Explorer and Retry; Retry revalidates the target |
| Include descendant | Ignore local/ and include only local/settings.json | That file is copied even if Git lists only local/; unrelated descendants are absent |
| Include exclusion | Include local/ then exclude local/private/ | Excluded descendants are absent; both source and destination links are skipped |
| Create aftereffects | Git succeeds; fail trust, discovery, membership or activation | Worktree remains with an accurate result; no duplicate create or premature setup |
| Setup uncertainty | Interrupt after setup intent/submission and reload | No automatic duplicate commands; uncertain execution is identified for inspection |
| Collapse failure | Active child; main checkout unavailable or its admission cancelled | Child stays active and visible; repository remains expanded |
| Target replacement | Replace a leftover directory before Retry | Automatic cleanup refuses the replacement instead of trusting the old path string |

Use controllable promises for service tests. Inject a failure at each asynchronous
boundary, not just at the first Git call. For filesystem semantics, use real Git and
files. Exercise a real held-open Windows file and a bounded fault injection for the
specific record-removed/cleanup-failed state. Report which mechanism produced it.

### W19.4 A real-window probe

Load the probe as an ordinary extension in an isolated development window. Do not
use extensionTestsLocationURI as the only environment for restart tests: upstream
suppresses the folder-change relauncher in that mode.

The extension records a process identity, activation counter, workspaceFolders,
folder-change events, trust and representative configuration/variable resolution.
The workbench-side probe records active folder, editor groups and ownership, dirty
contents, Explorer root, SCM repositories, scope, title, visible/hidden terminals
and focus. Read the workspace file and Git separately as external evidence.

At each settled operation, compare these observations with W3. During a controlled
in-flight operation, check preservation and ordering, then wait for that particular
operation's result. Do not use an arbitrary sleep or the next global restore event
as proof that the requested operation finished.

Demonstrate the upstream first-folder restart in the pinned upstream build, using the
same normal-window probe. Then verify Facade's declared restart exceptions. Record
the FOLDER-to-WORKSPACE transition separately.

Drive a navigation request through the row, keyboard, palette, dialog, drop, CLI
and supported extension API forms. Observe effects in the intended window, including
when a second window already holds the directory. Test an external membership edit
while an interactive confirmation or activation is still pending.

### W19.5 Commands and build preparation

Inspect existing build/watch output first. Install dependencies and prepare dev
assets only when absent, as ENGINEERING and the Copilot instructions describe.
Use fresh compiled output after source changes. A documentation-only change does
not require an application build or a passing implementation test run.

From the repository root on Windows, the current runners support:

```powershell
./scripts/test.bat --grep "Active folder|Workspace bar|Worktrees"
./scripts/test-integration.bat --suite git --grep "worktreeAt"
```

The corresponding .sh runners are available on macOS/Linux; inspect their help for
the same filters. These commands cover existing suites, not the entire acceptance
matrix. New real-window procedures and probes must be implemented and mapped before
claiming their corresponding cases pass.

When a dev launch is needed, use the repository launcher with an isolated profile;
follow the launch skill for debug-port/profile setup. Do not drive the person's
existing work window. Keep screenshots/logs associated with the tested build.

### W19.6 Interaction and performance

Check the full-size and collapsed bar using mouse, keyboard and a screen reader.
In particular, collapse of the active repository selects main only after success;
collapse of another repository and expansion do not change the active folder.
Verify focus, not just selection: the next keystroke must reach the expected editor
or terminal. Also test a missing main checkout and cancellation of its admission.

Use Dark Modern, Light Modern and both high-contrast themes on every supported OS.
Record zoom and reduced-motion settings. Check names, dirty indicators, branch
identification, keyboard focus and dialog button order. Screenshots do not replace
screen-reader or keyboard interaction. Compare alternatives with the same user task
when a UX choice is disputed; fewer ambiguous outcomes matter more than click count
alone.

For performance, pin a reference machine, extension set and fixture revision. Run
the baseline and candidate on that same setup. Measure cold first visits separately.
After warm-up, make 100 sequential folder switches in each of three runs, recording
input-to-settled-view p50, p95, p99 and maximum. Repeat with 2, 8 and 32 loaded roots;
record startup, process counts, memory and language-server activation separately.

Two warm local gates apply. The limit: p95 at most 100 ms in every run (W13). The
comparison: no p95 increase greater than the larger of 20 ms or 20 percent of the
baseline, reproduced in two of three runs. A failure of either requires
investigation; it is not excused by the old six-switch measurement. A necessary
tradeoff needs an explicitly recorded accepted deviation. Until a valid baseline is
recorded, the comparison is NOT RUN, not PASS; the limit applies from the first run. Remote timings need a separate
matched baseline; they cannot inherit the local result. Switching always requires
zero extension-host restarts.

### W19.7 Results and release gate

For each WS/WTA id record: build and fixture revision, OS and tool versions, test or
procedure location, required evidence levels, observed result, artifact paths and
status. Status is PASS, FAIL, BLOCKED, NOT RUN or ACCEPTED DEVIATION. Include the
person's words for an accepted deviation. Keep these records with the run, outside
the normative specification.

The workspace/worktree gate requires:

1. Every acceptance id covered at its stated levels; no unexplained failures or
   unexecuted required cases.
2. The W17 continuous scenario on the primary OS, plus the controlled failure cases
   above. Inspect content and process identity after every preservation boundary.
3. Platform-specific deletion, path, terminal and UI cases on each advertised OS.
   Remote support requires an actual supported remote setup and its tests; do not
   infer it from local URI mocks.
4. The stock comparison (WS-41) against the pinned upstream build.
5. Performance evidence under W19.6 and the separate IDENTITY acceptance gate
   on the same release build for an L1 release.

Retain proof that successful cleanup leaves no fixture worktrees or processes.
An intentionally injected cleanup failure passes only when its notification is
correct and the fixture is subsequently cleaned through a verified path.
