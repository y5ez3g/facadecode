# The workspace

What Facade Code does to VS Code's workspace, why, and how it is proved.

Everything here is about one thing: **the workspace someone already has, made worth using.**
There is no new layer above it and no second list beside it. `folders[]` is the product.

---

## 1 The shape, in one page

```
                     folders[]  =  every folder, in one real .code-workspace
                          |
          +---------------+---------------+
          |                               |
      layer 1                         layer 2
      what the workbench draws        the extension host
          |                               |
      asks IActiveFolderService       gets all of them, unfiltered
      -> shows one                        |
                                      what it sends back lands in layer 1's
                                      views, and layer 1 is already narrowed
```

**Left of the divider**: a bar listing the workspace's folders. That is the workspace made
visible - the list that until now lived only inside a JSON file.

**Right of the divider**: a complete VS Code, opened on one folder. The explorer, the title, the
editors, the terminal, source control: all of it reads as though this window had been opened on
that folder alone. Click another row and the right-hand side is a complete VS Code opened on
that one instead - in tens of milliseconds, with nothing torn down.

Two promises hold the whole thing up:

```
1  Nothing a workspace does today may stop working. Section 4 is the list, item by item.
2  The right-hand side must read as one folder, and switching must be cheap enough that a
   person does it without thinking. Section 5 is the evidence.
```

And one principle decides every question the two promises do not:

```
⭐ ONE WINDOW, MANY FOLDERS.
   A second window is something a person asks for in as many words - "in New Window", or a
   new window they opened themselves. It is never what they get for saying "I want to work
   on this too".
```

That principle reaches past the workspace's own features into everything that can put a folder
in front of you: Open Folder, Open Recent, the CLI, a dropped folder, a fresh clone. §4.11 is
that list, and it is where most of the work left to do is.

---

## 2 What a VS Code workspace already is

Read end to end before any of this was designed. The numbers are from this tree.

### 2.1 The data model

```
IWorkspace = { id, folders[], configuration, transient }

folders[] IS the file. `configurationService.setFolders()` writes it back through
  IJSONEditingService; memory and disk are one thing.
id = md5(configuration path). Editing folders does not change it, so everything in
  StorageScope.WORKSPACE survives an edit. Save-as changes the path, so it changes the id -
  and `enterWorkspace` migrates the storage with its data preserved.
Only WorkbenchState.WORKSPACE may edit folders; `doUpdateFolders` returns early for EMPTY and
  FOLDER. That early return is where the one-time transition comes from.
Every view is a pure function of folders[]: `explorerModel.ts` builds its roots from it and
  rebuilds on `onDidChangeWorkspaceFolders`.
The extension host gets it through one function: `mainThreadWorkspace.getWorkspaceData()`.
```

### 2.2 Three states, and the transition between them

```
EMPTY      no folder at all
FOLDER     one folder, opened directly. No .code-workspace exists.
WORKSPACE  a .code-workspace, named or untitled, holding 0..N folders
```

A window in `FOLDER` state that is asked to hold a second folder goes through
`createAndEnterWorkspace`: an untitled `.code-workspace` is written into the profile and the
window enters it. **⚠️ In place, not by reloading** - `enterWorkspace` stops the extension
hosts, re-initialises configuration, switches storage with its data preserved, and starts them
again. Measured: one extension-host restart, no window reload.

### 2.3 How much of the workbench reads it

Counted over `src/vs`, excluding tests and `src/vs/sessions` (which is a second workbench of its
own), so that the numbers can be re-run:

```
getWorkspace().folders                     174 in 114 files
onDidChangeWorkspaceFolders                 71 in  52 files
getWorkspaceFolder()                       113 in  62 files
distinct user-visible strings saying "Workspace"   136
```

That count is the argument for extending rather than replacing. A private list of our own would
have had to re-earn every one of those 174 reads, and a third meaning for the word would have
had to live beside those 136 strings - which is microsoft/vscode#77718 happening twice.

### 2.4 The two layers, and why the split is the whole design

```
layer 1   drawn by the workbench: explorer, search, SCM, problems, title, editors, terminal
          ours to filter, freely, per view
layer 2   the extension host
          all or nothing. There is no "this extension sees one, that one sees all"
layer 3   whatever an extension spawns - tsserver, gopls, jdt.ls
          reached only through layer 2
```

Narrowing layer 1 is enough, because layer 2 has no screen of its own. Everything an extension
produces arrives in a view the workbench draws, and that view is already narrowed.

### 2.5 What multi-root is used for today

Evidence, gathered 2026-09-20:

```
microsoft/vscode issues by area label, all time
  debug 7671 · git 4354 · search 2527 · tasks 2506 · file-explorer 2306
  scm 1345 · workbench-editors 813 · workbench-multiroot 495 (28 still open)
workspaceLoad telemetry records window size, theme, language, restored editors - not the
  number of folders. Adoption is not measured anywhere.
microsoft/vscode#77718, "Consistency with the use of workspace": folder settings are called
  Workspace until a .code-workspace exists, then they are called Folder. Closed, unresolved.
What its users do use it for: monorepos (cited benefit: per-folder settings), microservices,
  front-end beside back-end, infrastructure beside application, and since 2025 feeding AI
  agents across repositories.
Their standing complaint is that multi-root flattens the explorer.
```

That complaint is the feature. We are not inventing multi-root; we are fixing the one thing its
users say is wrong with it.

---

## 3 What we add

### 3.1 The bar is a view of `folders[]`

`WorkspaceBarModel` stores nothing. `folders` reads `getWorkspace().folders`; `add` calls
`IWorkspaceEditingService.addFolders`; `remove` calls `removeFolders`. It listens to
`onDidChangeWorkspaceFolders`, so the bar follows an edit whoever made it - the bar, an
extension, or someone typing in the `.code-workspace` file.

⚠️ One thing the bar must do that upstream does not: de-duplicate **within a batch**.
`doUpdateFolders` works out what is already there once, before its loop, so a single call
carrying the same folder twice writes it twice - and dropping two `.code-workspace` files that
share a folder does exactly that.

### 3.2 `IActiveFolderService`

`src/vs/workbench/services/activeFolder/`

```ts
readonly activeFolder: IWorkspaceFolder | undefined;
readonly onWillChangeActiveFolder: Event<IActiveFolderWillChangeEvent>;   // with join()
readonly onDidChangeActiveFolder: Event<void>;
setActiveFolder(folder: IWorkspaceFolder | URI): Promise<void>;
```

State in `StorageScope.WORKSPACE`, seeded from `getLastActiveWorkspaceRoot()` the first time.

⚠️ **The name is upstream's own.** `IHistoryService.getLastActiveWorkspaceRoot()` appears 30
times in this tree; take away the tests, its own declaration and implementation, and this
service's seed, and **15 are call sites that guess** - terminal 10, file dialogs 2, search 2,
debug configuration 1 - and every one of them names its local `activeWorkspaceRootUri`. This
service is the same question with an answer, and repointing those 15 is most of what "only
better" means here.

```
rejected  scope   StorageScope is used 1404 times and ConfigurationScope 322, same count as
                  above. Worse, `StorageScope.WORKSPACE` means the WHOLE workspace - the
                  opposite of one folder in it
rejected  view    IViewDescriptor, ViewContainer and IViewsService all mean something else
```

⚠️ `onWillChangeActiveFolder` fires only for a deliberate move. When the active folder leaves
the workspace the service moves to its neighbour without announcing it first, because there is
nothing to put away: whatever a listener saved would be keyed to a folder the workspace no
longer has.

⚠️ `onDidChangeActiveFolder` also fires when the active folder is **renamed** in the workspace
file. It does **not** fire when the folder list changes around it - a reorder moves its index and
nobody outside the service reads one. Consumers that draw the name listen here and nowhere else,
which is also what removes the ordering hazard: both this service and `ExplorerModel` used to
listen to `onDidChangeWorkspaceFolders`, and which ran first was whichever registered first.

### 3.3 What layer 1 narrows

```
explorer        the active folder only, and no root row above it            done
title bar       ${rootName} and the command center name the active folder   done
                ${workspaceName} is new, and keeps the workspace's own name reachable
explorer header the active folder's name                                    done
editors         a working set per folder, swapped on the way in and out     done
terminal, file dialogs, search-from-here, debug config                      next
                the 15 non-test call sites that guess, repointed to ask
source control  the active folder's repositories                            planned
search          folderQueries = the active folder, with a way to widen      planned
problems        filtered by the active folder; markers are stored by
                resource, so this partitions rather than discards           planned
```

### 3.4 Layer 2 is untouched

`getWorkspaceData()` is unchanged. Extensions see every folder, `workspaceContains:` fires for
all of them, and language servers index all of them. That is deliberate:

- it is what makes the folder list a real workspace rather than a fiction
- it is why switching costs tens of milliseconds instead of rebuilding a project graph
- and it is parity: a stock multi-root workspace holding the same folders does the same

### 3.5 Two rules that cannot be broken

```
⚠️ Nothing may hand a narrowed folder list into the write path. `doUpdateFolders`
   (configurationService.ts:241) is read-modify-write over `getWorkspace().folders`: it takes
   the current list, rebuilds the stored form from it, and writes that back. A narrowed list
   reaching it means one Add Folder deletes the other N-1 from the .code-workspace.

⚠️ Nothing of ours goes into the .code-workspace file. Which folder is active, the per-folder
   editor working sets, any bookkeeping: StorageScope.WORKSPACE, keyed by the workspace id.
   A `facade.*` key in the file makes stock VS Code report an unknown setting.
```

---

## 4 Every workspace feature, before and after

Enumerated rather than remembered. §4.10 gives the method and what it turned up.

Two markings, because they answer different questions.

```
T0    the workspace's own features - §4.1 to §4.10. The question is "does it still work?"
T1    features that are not the workspace but that decide whether a second window appears -
      §4.11. The question is "does it obey one window, many folders?"

UI    a person reaches it: menu, command palette, keybinding, context menu, drag, the CLI
API   only code reaches it: the extension API, an internal command, a service, an event,
      an activation event, a variable
```

A `UI` row is a promise to a person and changing it has to be argued. An `API` row is a contract
with someone else's code and changing it is a break.

### 4.1 Opening and closing

| | who | before | after |
|---|---|---|---|
| `File > Open Folder` (`workbench.action.files.openFolder`) | UI | one folder, `FOLDER` state | unchanged. The bar shows one row |
| `File > Open Workspace from File` (`openWorkspace`) | UI | the window enters that workspace | unchanged. The bar shows its folders |
| `File > Open Recent` (`openRecent`, `quickOpenRecent`) | UI | folders and workspaces, mixed | unchanged |
| `File > Close Folder` / `Close Workspace` (`closeFolder`) | UI | back to an empty window | unchanged |
| `Open Folder via Workspace` (`openFolderViaWorkspace`) | UI | opens one folder of this workspace in a new window | unchanged |
| `Duplicate Workspace in New Window` | UI | a second window on the same workspace | unchanged. Each window keeps its own active folder - that record is `StorageScope.WORKSPACE`, which is per window |
| Opening a `.code-workspace` in an editor (`openWorkspaceFromEditor`, and the prompt behind `workspaces.dontPromptToOpen`) | UI | a banner offers to enter it | unchanged. ⚠️ Deliberately different from **dropping** the same file, which adds its folders here - opening a file in an editor and dropping it on the window are two different requests |
| `code <folder>`, `code <file.code-workspace>` | UI | opens it | unchanged |
| `code --add <folder>`, `--folder-uri`, `--reuse-window`, `--new-window` | UI | adds to, or opens, the last active window | unchanged. `--add` now also puts a row in the bar |
| `vscode.openFolder`, `vscode.newWindow` | API | open a folder or workspace, here or in a new window | unchanged |
| `_files.pickFolderAndOpen`, `openFolderInNewWindow`, `openFileFolderInNewWindow` | API | internal openers | unchanged |

### 4.2 The folder list

| | who | before | after |
|---|---|---|---|
| `File > Add Folder to Workspace...` (`addRootFolder`) | UI | dialog, folder appended, transition if needed | unchanged. The bar's `+` runs the same path |
| `Remove Folder from Workspace` - explorer context menu (`removeRootFolder`) | UI | folder removed | unchanged |
| The bar's own `Remove Folder` | UI | did not exist | a confirmation naming the path; the window moves to the row that took its index; that folder's editor working set is dropped |
| Drag a folder inside the explorer to reorder | UI | `updateFolders(0, n, ...)` rewrites the list | unchanged. Reordering **from the bar** is not built yet - 6.2 |
| `setRootFolder` | API | makes one folder the only root | unchanged, and now redundant: it is what the bar does, minus the cost |
| `workspace.updateWorkspaceFolders` | API | edits the list | unchanged. The bar follows, because it listens to the same event |
| `workspace.onDidChangeWorkspaceFolders` | API | fires on any edit | unchanged |
| Editing the `.code-workspace` by hand | UI | the workbench reloads it | unchanged. The bar follows, including a folder renamed inside the file |
| `workbench.contrib.workspaceWatcher` | API | one file watcher per folder | unchanged - every folder is still watched, which is what makes a background edit show up |

### 4.3 Saving and sharing

| | who | before | after |
|---|---|---|---|
| The untitled workspace | API | written into the profile on the FOLDER→WORKSPACE transition | unchanged. **Verified**: drag a second folder into a single-folder window and the file appears, holding both folders and nothing else |
| `Save Workspace As...` | UI | copies it to a chosen path, rewrites paths relative to it, migrates storage with `preserve data` | unchanged. The active folder and the editor working sets survive, because they are keyed by the workspace id and `enterWorkspace` switches the storage |
| `Open Workspace Configuration File` | UI | opens the `.code-workspace` in an editor | unchanged |
| Hand the file to someone on stock VS Code | UI | an ordinary multi-root workspace | **unchanged, and this is the receipt for the whole design.** Verified against VS Code 1.137.0 |

### 4.4 Settings, tasks, launch

| | who | before | after |
|---|---|---|---|
| Workspace settings (`settings` in the file; `openWorkspaceSettings`, `openWorkspaceSettingsFile`) | UI | apply to the window | unchanged |
| Folder settings (`.vscode/settings.json`; `openFolderSettings`, `_workbench.action.openFolderSettings`) | UI | the settings editor offers a folder picker in a multi-root workspace | unchanged. ⚠️ The picker still lists every folder. Defaulting it to the active one is 6.2 work, not a break |
| `_workbench.pickWorkspaceFolder` | API | the folder picker tasks, debug and extensions all reuse | unchanged. It lists every folder, which is right: those are workspace-level questions |
| `tasks.json`, `launch.json`, `mcp.json` per folder, and workspace-level (`openWorkspaceFileTasks`) | UI | resolved per folder | unchanged |
| `${workspaceFolder}`, `${workspaceFolder:name}`, `${workspaceFolderBasename}` | API | resolved against the folder in context | unchanged. **This is the reason layer 2 is not narrowed**: an extension seeing a different folder list than the workbench would resolve these differently |
| Extension recommendations, workspace and folder level (`addToWorkspaceRecommendations`, `addToWorkspaceFolderRecommendations`, `installWorkspaceRecommendedExtensions`, and the ignored variants) | UI | written into the workspace file or a folder's `.vscode/extensions.json` | unchanged |
| Enable / disable an extension for this workspace (`extensions.enableForWorkspace`, `disableForWorkspace`, `enableAllWorkspace`, `disableAllWorkspace`, and the MCP equivalents) | UI | applies to the window | unchanged. ⚠️ "This workspace" now means all N folders. It always did; with more folders in one workspace it is worth knowing |
| `files.autoSaveWorkspaceFilesOnly` | UI | auto-save only inside the workspace | unchanged, and it now covers more folders because more of them are in one workspace |
| `explorer.expandSingleFolderWorkspaces` | UI | expands the single root of a multi-root workspace at startup | ⚠️ **Audited**: it no longer applies, and correctly. It expands a *root row*, and a window narrowed to one folder has no root row - the files are already at the top level, exactly as a stock single-folder window shows them |

### 4.5 The views

| | who | before | after | why |
|---|---|---|---|---|
| Explorer | UI | every root, flattened, each with a row of its own | the active folder only, no root row above it - the shape a single-folder window has | the standing complaint about multi-root, and the point of the bar |
| Window title `${rootName}` | UI | `name (Workspace)` or `Untitled (Workspace)` | the active folder's name | the title names what you are working on. `${workspaceName}` is added, so nothing is lost |
| Command center | UI | the workspace's name | the active folder's name | the same label, in the same place, for the same question |
| Explorer pane header | UI | `name (Workspace)` | the active folder's name | it sits directly above that folder's files |
| Editors | UI | one set for the window | a working set per folder, stored and restored across a switch | switching is only cheap if you come back to what you left |
| Source control | UI | one provider per repository, all listed | the active folder's repositories | planned, 6.2. A requirement, not a preference |
| Search (`Find in Files`) | UI | every folder | the active folder by default, widenable | planned, 6.2 |
| `Find in Folder` from the explorer (`search.action.restrictSearchToFolder`) | UI | scopes a search to one folder | unchanged. It already answers the narrow question |
| **Go to Symbol in Workspace** (`Cmd+T`, `registerWorkspaceSymbolProvider`, `_executeWorkspaceSymbolProvider`) | UI + API | symbols from every folder, because the providers live in layer 2 | ⚠️ **Found by the audit and not yet decided.** It is the same shape as Search: the results arrive in a view the workbench draws, so they can be narrowed there. Listed in 6.2 |
| Go to File (`Cmd+P`) | UI | every folder | planned, 6.2 - same mechanism as Search |
| Problems | UI | every folder's markers | the active folder's, the rest partitioned and kept | planned, 6.2. `markersModel` stores by resource, so nothing is discarded |
| Debug | UI | per-folder `launch.json`, compound configs across folders | unchanged; the configuration picker defaults to the active folder | planned, 6.2 |
| Terminal cwd | UI | `getLastActiveWorkspaceRoot()` - a guess | the active folder | planned, 6.2 |
| Timeline, outline, breadcrumbs | UI | follow the active editor | unchanged |

### 4.6 The extension API

| | who | before | after |
|---|---|---|---|
| `workspace.workspaceFolders` | API | every folder | unchanged - every folder |
| `workspace.workspaceFile` | API | the `.code-workspace` uri | unchanged |
| `workspace.name` | API | the workspace's name | unchanged |
| `workspace.rootPath` (deprecated) | API | `folders[0]` | unchanged - and it is the reason `WorkspaceChangeExtHostRelauncher` restarts the extension host when `folders[0]` changes. ⚠️ A switch no longer changes `folders[0]`, so that restart no longer fires on one |
| `workspace.onDidChangeWorkspaceFolders` | API | fires on edits | unchanged |
| `workspace.getWorkspaceFolder`, `asRelativePath` | API | resolve against the list | unchanged |
| `workspace.findFiles`, `createFileSystemWatcher` with a `RelativePattern` | API | scoped to the folder given | unchanged |
| `workspace.saveAll`, `workspace.fs`, `getConfiguration(section, scope)` | API | scoped as before | unchanged |
| `workspace.onDidGrantWorkspaceTrust` | API | fires when the window becomes trusted | unchanged |
| `workspaceContains:` activation | API | fires for every folder | unchanged. This is what costs memory - 5.2 |
| `showWorkspaceFolderPick` | API | lists every folder | **unchanged, and we cannot narrow it.** An extension's own UI is its own. Stock multi-root lists them all too: parity, not a regression |

### 4.7 Trust, storage, the window

| | who | before | after |
|---|---|---|---|
| Workspace trust (`security.workspace.trust.*`, `manageWorkspaceTrust`) | UI | computed over every root; one verdict for the window | unchanged. ⚠️ One untrusted folder still restricts the whole window. Upstream's behaviour; 7.2 confirms it is not surprising |
| `StorageScope.WORKSPACE` | API | keyed by `md5(config path)` | unchanged, and now holds the active folder and the editor working sets |
| Hot exit, backups | UI | per workspace | unchanged |
| Recently opened (`vscode.removeFromRecentlyOpened`) | UI + API | folders and workspaces | unchanged |
| Profiles bound to a workspace (`workbench.profiles.actions.resetWorkspaces`) | UI | a profile can be associated with a workspace | unchanged - the association is with the workspace, and the workspace is still one thing |

### 4.8 What we deliberately changed

Three behaviours are different on purpose. Each is written out because "nothing may stop
working" means the exceptions have to be argued, not hidden.

**① Dropping a folder on the window.** `UI`

```
before   dnd.ts `handleWorkspaceDrop`:
           any .code-workspace among the dropped things, or exactly one folder
             -> hostService.openWindow(...)      a second window
           more than one folder, ordinary workspace
             -> createAndEnterWorkspace(...)     THE CURRENT WORKSPACE IS REPLACED
after    one rule for the whole window, whatever was dropped and wherever it landed:
           a file            -> opened in the editor
           a folder          -> added to this workspace, a row appears in the bar
           a .code-workspace -> its folders added, the window stays where it is
```

Why this is better: dropping something on a window is a request to work on it **here**. Opening
a second window is a different request and it has its own menu item. And the old rule for two or
more folders discards the workspace someone was in without asking - a data-losing surprise that
only appears when you drop two things instead of one.

⚠️ A `.code-workspace` is read, never entered: entering replaces the window's workspace identity,
and every folder's editors are stored under it.

**② The explorer shows one root.** `UI`

Covered in 4.5. Repeated here because it is the most visible break with stock behaviour, and
because the escape hatch is the bar itself: nothing is hidden, it is one click away, and the
workspace file still holds every folder.

**③ The window title, command center and explorer header name the active folder.** `UI`

Covered in 4.5. `${workspaceName}` is added so nothing is lost; the default title template did
not change.

### 4.9 What we cannot narrow, and say so

```
showWorkspaceFolderPick and any tree an extension draws itself   an extension's own UI
_workbench.pickWorkspaceFolder                                   a workspace-level question
                                                                 asked by tasks and debug
workspace trust                                                  one verdict per window
workspaceContains: activation                                    all or nothing, by design
```

None of these is a regression: a stock multi-root workspace does the same. They are listed so
that a reader does not go looking for a bug that is parity.

### 4.10 How this list was built

Remembering the feature list is how a feature gets missed, so it was enumerated instead:

```
1  every command id in src/vs (excluding tests and src/vs/sessions) whose name mentions
   workspace, rootFolder, openFolder, closeFolder, addFolder, removeFolder, openRecent,
   pickFolder or newWindow  ->  82 ids
2  each one classified by how a person could reach it: `f1: true` (command palette),
   `menu:`/`appendMenuItem` (a menu), `keybinding:` (a key), `_` prefix (internal)
3  the `workspace` namespace of `src/vscode-dts/vscode.d.ts`, read end to end
4  settings whose name contains workspace or folder
5  the File menu's `2_open` and `3_workspace` groups, and the explorer's context menu
6  activation events, variable resolution, and the CLI's argv table
```

What the pass turned up that memory had missed:

```
Go to Symbol in Workspace        a whole search surface, layer 2, not yet decided - now 6.2
openWorkspaceFromEditor          opening a .code-workspace in an editor still offers to enter
                                 it, which is deliberately not what dropping it does
the folder settings picker       the settings editor's Folder tab lists every folder
enable/disable for this          "this workspace" now means more folders than it used to
  workspace
explorer.expandSingleFolderWorkspaces   audited: correctly no longer applies
workspace.rootPath               the reason the extension-host relauncher exists at all
files.autoSaveWorkspaceFilesOnly covers more folders now
Find in Folder                   already answers the narrow question, needs nothing
```

### 4.11 T1 — what decides whether a second window appears

Found by enumerating every call site of `IHostService.openWindow` in `src/vs/workbench`
(excluding tests, `src/vs/sessions`, and the auxiliary-editor-window machinery), then asking one
question of each: **is a second window what the person asked for?**

| surface | who | today, stock *and* ours | verdict |
|---|---|---|---|
| Drop a folder on the window | UI | ⚠️ **the window leaves its workspace and becomes that folder** | **fixed.** §4.8 ① |
| `File > Open Folder...` | UI | `pickFolderAndOpen` → `openWindow([{folderUri}], { forceNewWindow: false })`; the main process reuses or opens a new window | **violates.** Should add the folder and switch to it |
| `code <folder>` while a window is open | UI | a second window | **violates.** Should add and switch, unless `--new-window` |
| `File > Open Recent` → a folder | UI | `openWindow([pick.openable])`, with ⌘ for a new window and ⌥ to reuse | **violates** for the plain Enter. The modifiers already say what they mean and should keep meaning it |
| Welcome page "Open Folder" | UI | same path as Open Folder | violates |
| "Open Folder" offered when you open a directory as a file (`textFileEditor.ts:178`) | UI | `forceNewWindow: true` | violates |
| `Open Folder via Workspace` | UI | opens one folder **of this workspace** in a new window | violates, and doubly: that folder is already here. It should just switch |
| Git clone → "Open" | UI | `vscode.openFolder(uri)` | violates |
| Git clone → **"Add to Workspace"** | UI | `updateWorkspaceFolders(...)` - and it is only offered when a workspace is open | ⭐ **upstream already agrees.** It is just not the default, and it is only in this one place |
| `File > New Window` | UI | a new empty window | correct - asked for in as many words |
| `Open Folder in New Window`, ⌘Enter in Open Recent, `Duplicate Workspace in New Window` | UI | a new window | correct - asked for |
| `File > Open Workspace from File`, and the "this folder contains a workspace file" prompt | UI | the window enters that workspace | correct - a different workspace is a different window-ful of work |
| `File > Close Folder` | UI | the window empties | correct |
| `vscode.openFolder`, `openWindow` (API) | API | whatever the caller asked for | **leave alone.** It is a contract; an extension that asks for a new window means it |

#### Measured, stock against ours

Both builds on the same three-folder workspace (`ky · gin · gson`), same profile shape, same
action. Driven, not recalled:

```
drop one folder (axios) on the window
  stock   window title  cmp (Workspace) -> axios     CDP: "target navigated or closed"
          the explorer is axios's files. The three-folder workspace is gone from that window
  ours    window title  ky, unchanged                cmp.code-workspace -> [ky gin gson axios]
          a fourth row in the bar, the window still on ky

code <folder> while a window is open
  stock   2 windows      ours  2 windows      ⚠️ ours has not fixed this one yet
```

The first is the principle applied. The second is the principle not yet applied, and it is
representative: every row marked "violates" above goes through the same `openWindow` decision.

#### What this means for the work left

The fix is one seam, not eight: the places that mean **"show me this folder"** should call the
active-folder service instead of `IHostService.openWindow`, and the places that mean **"give me
another window"** should keep calling it. That is 6.2's item 13.

⚠️ Two things it must not do:

```
never   swallow an explicit request. "in New Window" and ⌘Enter mean a window
never   change `vscode.openFolder` for extensions. An extension asking to open a folder in a
        new window has said what it wants, and a fork quietly doing something else to it is
        the kind of surprise this whole document exists to avoid
```

## 5 Performance

### 5.1 The shape we rejected, and what it cost

The first design kept the folder list private and swapped a single folder in and out of
`folders[]` on every switch. Two measurements ended it:

```
retention is bound to workspace MEMBERSHIP, not to process lifetime
  a folder swapped out and back rebuilds its project graph every time:  19237 / 18688 ms
  both folders resident in one .code-workspace, revisited:               1750 ms
a switch that changes folders[0] restarts the extension host every time
  old host gone 273ms · new host up 348ms · git back 800-1100ms
  and the cost is fixed, not proportional: 32 files or 20000 files, 1058 vs 1096 ms
```

So the old shape paid 19 seconds a visit to buy an isolation that narrowing layer 1 gives away.

### 5.2 Cold start with N folders resident

32GB machine, fresh profile each run, one TypeScript file passed on the command line so a real
language service starts. Timings are VS Code's own `performance.mark('code/*')`.

```
                       folders  splash  workbench  extensions  Eventually  final MB  idle at
 8, one of them Java      8     110-129  1885-1994  2364-2463  4410-4518  5801-5991  44-45s
 8, biggest folder first  8     118      1892       2400       4394       6220       39s
 7, no Java               7     119      1909       2485       4409       5559       29s
 1                        1     117-128  1885-1991  2484-2515  4390-4494  5373-5459  29s
```

**Folder count costs nothing in time.** Every milestone is inside its own run-to-run spread.

**Folder count costs almost nothing in memory; language count does.** Seven folders against one
is +100..190MB. One Java folder nobody opened is +1.2GB and +15s of background CPU, because
`workspaceContains:` starts jdt.ls. Drop that folder and both go with it.

```
cost of N folders resident = the language servers those N folders eagerly activate
the folder list itself is free
```

**The UI never degrades.** A trivial expression on the renderer's main thread, sampled every
400ms through the whole warm-up, six runs, ~1400 samples:

```
p50 1ms   p90 1-3ms   p99 20-40ms   worst 82-259ms   samples with no answer: 0
```

Every worst-case spike is between 2.3s and 5.2s - extension loading - and the *single-folder*
runs produce the largest of them. jdt.ls burning 484-628% CPU does not move the renderer: it is
a separate process and the machine has cores.

⚠️ RSS totals are a floor. The eight-folder runs peak at 6.2-6.3GB, and on a machine already
8.6GB into swap macOS reclaims from whoever has the most reclaimable pages - which is why the
renderer and tsserver read *smaller* there. Totals are comparable; the per-process split under
pressure is not.

### 5.3 What a switch costs now

Measured in a running window, six switches across three folders, judged by four surfaces
agreeing (bar row, window title, explorer pane header, explorer contents):

```
49 · 66 · 67 · 77 · 81 · 86 ms
extension host started once before them and once after: 0 restarts across six switches
of which  fileService.exists  1-4ms      setActiveFolder (incl. editor working sets)  0-6ms
```

Nearly all of it is redrawing. The folder list does not move, so nothing is torn down.

### 5.4 What we chose, and what we did not

```
chose      all folders resident. It is what makes a switch 50ms instead of 19s, and the
           memory it costs is the memory a stock multi-root workspace costs.
chose      keep the pre-switch `exists` check on the hot path: 1-4ms against 49-86ms, and
           the model's cached availability is only as fresh as the last edit to the list.
did not    withhold a folder from layer 2 until it is needed. It would stop
           `workspaceContains:` starting a language server nobody asked for - the 1.2GB
           above - but extensions would then see a folder list the workbench does not have,
           and `${workspaceFolder}` and friends would drift from it. That breaks promise 1
           to serve promise 2, and 5.2 says promise 2 is not under threat.
did not    gate the extension-host relauncher. A switch no longer touches folders[], so
           `WorkspaceChangeExtHostRelauncher` does not fire on one. It still fires when a
           folder is added or removed, which is upstream's own behaviour and correct.
```

---

## 6 Implementation

### 6.1 Done, and verified in a running window

```
1  IActiveFolderService                     services/activeFolder/, 20 tests
2  the bar's list is folders[]              the model reads and edits the workspace, 17 tests
3  switching sets the active folder         no queue, no rollback: nothing can fail
4  the explorer shows the active folder     explorerModel, and the three places that read
                                            FOLDER state as "one root", 5 tests
5  title, command center, explorer header   windowTitle.rootName + ${workspaceName}
   the mark is the bar's own                the list clears its selection on a click in its
                                            empty space, which is right for a list and wrong
                                            for a fact about the window
   hygiene accepts a non-Microsoft gallery  build/lib/extensionsGallery.ts, 4 tests
```

### 6.2 Next

```
6  repoint the 15 guesses          terminal and external terminal (10), file dialogs (2),
                                   search-from-here (2), debug configuration (1). ⚠️ one at a
                                   time: some of them really do mean "last active"
7  source control                  set scmViewService.visibleRepositories on a switch; upstream
                                   already has the setter, the event and the record
8  the three search surfaces       Find in Files · Go to File · Go to Symbol in Workspace.
                                   One decision, three views: the results come back from layer
                                   2 either way, and the narrowing happens where they land.
                                   ⚠️ Go to Symbol was found by the §4.10 audit, not by memory
9  problems                        filter the view by the active folder
10 move a folder up and down       the order of folders[] is the order in the file
11 open and save a workspace       prove the other direction: opening a .code-workspace from
                                   outside fills the bar with its folders
12 the folder settings picker      default the settings editor's Folder tab to the active
                                   folder. ⚠️ Only the default - it must still list them all,
                                   because folder settings are a workspace-level question
13 ⭐ one window, many folders      the T1 list in §4.11. Open Folder, Open Recent, the CLI,
                                   the welcome page, the directory-opened-as-a-file offer,
                                   Open Folder via Workspace, and git clone's "Open" should
                                   add the folder and switch to it. One seam: they all go
                                   through the same `openWindow` decision. ⚠️ "in New Window",
                                   ⌘Enter and `vscode.openFolder` keep meaning what they say
```

### 6.3 Deliberately later

```
worktrees                    a worktree is a folder; it can wait until the folder list is done
withholding folders from     5.4, and only if a real machine runs out of memory
  layer 2
per-folder colour and name   the workspace file already carries a name per folder; using it
                             is free, choosing one needs a dialog
```

---

## 7 Tests

### 7.1 Unit

```
services/activeFolder/test/          20  where a window starts · what outranks what · joiners
                                         and a joiner that throws · removal by index · a rename
                                         is a change, a reorder is not
test/browser/parts/workspacebar/     17  the folder list: the rows are the workspace's folders ·
                                         batch de-duplication · symlinks and case · unavailable
                                         is marked not dropped · an edit made elsewhere redraws
                                     12  what a drop from outside means
                                     12  reading a .code-workspace · markdown code spans
                                     10  editor working sets: captured, restored, and pruned
                                         when a folder leaves however it left
                                      1  the grid shape layout.ts addresses into
contrib/files/test/                   5  the roots the explorer shows
build/lib/test/                       4  which gallery urls are Microsoft's
                                     --
                                     81
```

### 7.2 Live, in a running window

Each of these has been run; the harnesses are in the session scratchpad.

```
switching        four surfaces agree, six switches, 0 extension-host restarts
the mark         click the empty space below the rows - the mark stays, which it did not before
drop             a file opens · a folder is added · a .code-workspace adds its folders and the
                 window stays · three workspace files at once de-duplicate against each other
transition       single folder + drag one in: two rows, still on the first, one extra
                 extension-host start, no window reload
rename           edit the name of the active folder in the .code-workspace: the row, the mark,
                 the window title and the explorer header all follow
several          three workspaces, three windows, independent active folders, each remembered
workspaces       across a full restart
themes           all 19 built-in: the name and the icon of a row are the same ink in every one;
                 17 clear 4.5; Quiet Light 3.48 and Solarized Light 3.24 are those themes' own
                 pair, identical to the explorer's selected row in the same theme
```

⚠️ Harness traps that each cost a wrong answer first:

```
a virtualised list only has DOM for visible rows - `scrollTop` on the wrong element reports a
  missing root that is simply below the fold. Use real wheel events
CDP's dispatchDragEvent needs several dragOver events before the overlay is up; one sample at
  120ms reports no overlay
.click() does not drive a VS Code list. Real mouse events, and for a menu a real mouse move first
a detection condition has to be specific: "the first file is not .github" says nothing when both
  repositories have a .github
process matching by name pulls in every other instance on the machine. Walk the tree from the
  pid that was launched
tsserver and gopls start from an OPEN FILE, not from the workspace. A cold-start run that opens
  nothing measures a window with no language service in it
composite alpha onto the real background before computing contrast, or a failing 3.41 reads as
  12.63
```

### 7.3 The receipt

```
write a .code-workspace from the bar, open it in stock VS Code:
  every folder present, no warnings, no unknown settings
```

Run against VS Code 1.137.0 with a throwaway profile. This is the test that says the first
promise held: if the file is ordinary, everything that reads an ordinary workspace still works,
and that is an argument about the whole of section 4 rather than about one row of it.

### 7.4 Gates, every step

```
npx tsc --noEmit -p src/tsconfig.json
npm run valid-layers-check · npm run stylelint · npx eslint <touched> · npx gulp hygiene
(cd build && npm test)
./scripts/test.sh --grep "Workspace bar|Active folder|Files - the roots"
grep -rnE "#[0-9a-fA-F]{3,8}\b|rgba?\(" src/vs/workbench/browser/parts/workspacebar/
```
