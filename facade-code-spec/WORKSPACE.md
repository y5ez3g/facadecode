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

### 3.2b The bar decides, and the editor never does

Settled after the audit turned up a state nobody had designed for: the window on `gin`, an editor
open on a file from `alpha`, and the title reading `alpha.ipynb — gin`.

```
⭐ The active folder is set by the bar and by nothing else. Opening a file that belongs to
   another folder does not move it.
```

⚠️ **This is a change from upstream, and the mechanism already runs.**
`getLastActiveWorkspaceRoot()` walks the editor history and returns the folder of the most
recently opened file, so in stock VS Code - and in this build today, because the 15 call sites
have not been repointed yet - a terminal opened while editing `alpha/foo.py` gets `alpha` even
though the bar says `gin`. After the repoint it gets `gin`.

What each choice costs, for the three surfaces that actually change:

```
                      the editor decides            the bar decides  (chosen)
terminal cwd          the file's folder             the bar's folder
Go to File            the file's neighbours         the bar's folder - and the file you are
                                                      looking at is not in the list
search default        the file's folder             the bar's folder
the cost              opening one file puts away    the window can hold an editor from
                      every tab of the folder you   outside the active folder
                      were in and restores another
```

Why the bar: with a working set per folder, letting the editor move the active folder means
**one cross-folder file open costs a full switch** - every tab of the folder you were in is put
away and another set restored. That is a heavy price for looking at a file, and it would be paid
every time.

And the cost of this choice shrinks as the narrowing lands. Once the explorer, Go to File,
search, problems and SCM are all narrowed, the ways to open a file from another folder are:

```
Go to Definition        follows the code across folders and cannot be narrowed - and it is
                        exactly the moment when you want to look without moving house
Open Recent, a drop     deliberate
everything else         narrowed
```

So the state this decision tolerates is the rare, deliberate one; the state the other choice
would have created is the everyday one.

⚠️ It follows that the bar must never be a display. Anything that would move the active folder
without the person choosing a row is this decision being broken.

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
| `Duplicate Workspace in New Window` | UI | a second window on the same workspace | unchanged. ⭐ **Measured, because a review said this line was wrong.** `StorageScope.WORKSPACE` is keyed by the **workspace id**, not by the window - so the sentence as first written was wrong. The consequence it feared does not arise: the duplicate is a *new* workspace with its own id (two `workspaceStorage` directories, measured), and a workspace that is already open cannot be opened a second time - `--new-window` on it focuses the window that has it. So no two windows ever share one record, and each keeps its own active folder |
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

### 6.2 The plan, in order

Six stages. Each is one commit or a short run of them, each leaves the window coherent, and each
says what proves it. The order is by dependency first and by how much pain it removes second.

⚠️ Every stage ends with the same two live checks, because they are the two the audit kept
catching: **switch folders and read the surface again**, and **check the surface when no editor
is open** - most of what was wrong only showed up in one of those two states.

---

#### Stage A — stop guessing, ask the service

The `3.2b` decision becomes real here, and it is the seam the rest of the work hangs off.

```
A1  repoint the 15 guesses          getLastActiveWorkspaceRoot() -> IActiveFolderService
                                    terminal and external terminal (10), file dialogs (2),
                                    search-from-here (2), debug configuration (1)
                                    ⚠️ one at a time. Some of them really do mean "last
                                    active" - `history.ts`'s own two are the service's seed
                                    and must stay
                                    ⚠️ this changes the terminal cwd from upstream behaviour.
                                    It is the point of 3.2b, and it is worth saying in the
                                    commit message
    proves it                       open a terminal on folder A, switch to B, open another:
                                    two different cwds. Open a file from B while on A, open a
                                    terminal: still A
    measured                        four folders, one editor open on `gson/pom.xml` the whole
                                    time. Bar on ky -> /private/tmp/langbench/ky; on gin ->
                                    .../gin; on axios -> .../axios. Then GsonBuilder.java
                                    opened from gson while the bar sat on axios: the bar did
                                    not move and the next terminal opened on axios.
                                    ⭐ Upstream answers gson in all four
    the fallback stays              `activeFolderFor(scheme, authority)` keeps upstream's walk
                                    to the first folder that matches, because a workspace can
                                    hold a local folder and a remote one at once and a caller
                                    asking for a local path cannot be handed the remote one

A2  source control, both knobs      the user's own words: "I do not need SCM to show me every
                                    repository at once. That is a downside for me."
    A2a  the Changes pane           set scmViewService.visibleRepositories on a switch.
                                    Upstream already has the setter, the event and the
                                    StorageScope.WORKSPACE record
    A2b  the Graph and the status   scmViewService.ts:298 derives activeRepository from
         bar, one fix               [activeEditorRepository, focusedRepository] - neither of
                                    which is the active folder, which is why it pins to the
                                    first repository and stays there. Add the active folder,
                                    ahead of the editor
    A2c  what is remembered         ⚠️ `onWillSaveState` persists the selection under
                                    `scm:view:visibleRepositories`. Reading the narrowed getter
                                    there records "the folder the window closed on" as a
                                    deselection of every other folder's repository - and the
                                    record outlives the window, so the next session shows one
                                    repository and no switch brings the others back. Same for
                                    `onDidRemoveRepository`'s "nothing visible, select the
                                    first": it writes a selection, so it has to ask what is
                                    chosen, not what is on screen
    proves it                       four repositories on four branches, no editor open. The
                                    Changes pane lists one, the Graph header names it, the
                                    status bar agrees, and all three follow a switch
    and then prove it again         ⭐ stop on the last folder, reload the window, switch back.
                                    A2c was invisible to the check above: it only shows on the
                                    second run, and by then the record is already wrong
    measured                        fresh profile, five folders: ky/main · gin/master · gson/main ·
                                    axios/v1.x and one with no repository at all. Each names itself
                                    in the Changes pane's commit box, the Graph header, the Graph's
                                    first commit and the status bar; the fifth shows none of them
                                    and says so. Stopped on axios, reloaded, all of it still follows
    A2d  the two smaller surfaces   the status bar's "Source Control Provider" entry appears when
                                    there is more than one repository - it counted all of them, so
                                    four folders of one repository each always showed it, naming a
                                    repository the bar already names. And `RepositoryRenderer`
                                    disambiguates a row against the other rows, but read the whole
                                    list to do it: two views use that renderer and they draw
                                    different sets, so it is told which
    A2e  a folder with no            the Graph read "there is no repository" as the moment before
         repository in it            the first one arrived and left the tree alone, so it went on
                                    drawing the folder the window had left, under a header naming
                                    that folder's repository, with its context keys still enabling
                                    its menu items. ⚠️ Upstream could not reach this state: one
                                    window per folder, and the view is only registered when some
                                    provider exists. It now redraws, forgets those keys, and says
                                    "There is no source control repository in this folder."
    tests                           `scmViewService.test.ts`, twelve of them. ⭐ Each was checked by
                                    putting its bug back: the storage one turns three red, the
                                    other two one each
    ⚠️ a false-green first          the first version of the "removing a repository" test asserted
                                    on `onDidChangeVisibleRepositories`, which is debounced on that
                                    path - it could not have failed. A test that passes against the
                                    broken code is worth less than no test
```

#### Stage B — the three search surfaces

One decision, three views, because the results all come back from layer 2 and are narrowed
where they land.

```
B0  one scope, not three            `ISearchScopeService`: folder or workspace, held in
                                    `StorageScope.WORKSPACE` and announced when either it or the
                                    active folder changes. One answer for all three, because
                                    they are one question to the person asking it - somebody who
                                    widened the search view and then presses ⌘P is still looking
                                    for the same thing
B1  Find in Files                   `queryBuilder`'s folderQueries come from the scope, and the
                                    view re-runs when it changes: results for a folder the
                                    window has left are answers to a question nobody is asking
B2  Go to File (⌘P)                 the same scope, in all three of its file queries. ⚠️ Its
                                    file cache is built over the folders the scope covered when
                                    the picker opened, so widening from inside it builds a new
                                    one
B3  Go to Symbol in Workspace (⌘T)  narrowed where the results land, not in the query: the
                                    providers live in the extension host and are handed the
                                    whole workspace, which is the layer split this design turns
                                    on. ⚠️ Found by the §4.10 audit, not by memory
    the way back                    a toggle in the search view's title, and a button on both
                                    pickers. ⚠️ On the pickers and not only in the view:
                                    somebody who types a file name, finds nothing and has to go
                                    open another view to widen has been handed a narrowing with
                                    no way out of it from where they are. `PickerQuickAccess`
                                    gains a `refresh` event for it, because it only asked for
                                    its picks again when somebody typed
    ⚠️ the tension, on purpose      ⌘P and ⌘T are pickers, and stage D's rule is that a chooser
                                    lists everything and puts the active folder first. Narrowed
                                    here because the folder list makes switching cost 49-86ms,
                                    so the two steps are cheap - and because a search that
                                    answers about eight repositories is the complaint this whole
                                    design starts from. The rule still holds for D's own rows
    measured                        ⌘P on gson: only gson's README files. On ky: one. The button
                                    widens in place, and the next ⌘P is still wide · Find in
                                    Files for `Copyright`, window on gson: 275 results in 251
                                    files, which is what `grep -rl` counts in that folder alone;
                                    widened, 384 in 350 · ⌘T for `Ky` with the window on axios:
                                    ky's symbols while wide, nothing while narrow, and back
                                    again once the window is on ky
    ⚠️ twice in one stage           a negative result needs a control. "Licensed under the
                                    Apache" reads as a narrowing that works and is really a
                                    string only one of the five folders has; ⌘T answering with
                                    nothing reads the same way and was really a language server
                                    that had indexed nothing yet. Neither says anything until
                                    the instrument has produced the other answer somewhere
    not run                         ⌘T rests on a language server having indexed the folder,
                                    which only the TypeScript one had here. ⚠️ And the ranking
                                    once widened is upstream's: the folder the window is on is
                                    not put first, which is a stage-D question rather than this
                                    one
```

#### Stage C — problems

```
C0  the scope moves house           `ISearchScopeService` becomes `IFolderScopeService` and leaves
                                    `contrib/search` for `services/folderScope`. How wide a window
                                    is looking is a fact about the window, not about searching, and
                                    problems live in another contrib - a contrib reaching into
                                    another contrib would have been the wrong seam. The toggle
                                    becomes one action with a menu entry per narrowing view
C1  the markers view                reads the markers the scope covers. ⚠️ Filtered where they land,
                                    never at `IMarkerService`: every extension reads and writes
                                    that, and a problem in a folder the window is not on is still a
                                    problem. `markersModel` stores by resource, so this partitions
                                    rather than discards and a switch brings the others straight up
C2  the count beside them           the status bar entry and the activity badge counted
                                    `getStatistics()`, which the marker service maintains over
                                    every marker it holds. Narrowed they count what the scope
                                    covers; widened they use the maintained answer, which is
                                    already the right one
    proves it                       a problem in folder B while the window is on A: the status bar
                                    and the panel show A's, and B's are there the moment you widen
                                    or switch
    measured                        two broken JSON files, one in ky and one in axios, both open in
                                    the same window: widened 4 problems and both files listed,
                                    narrowed 3 and one file, widened again 4
    ⚠️ the control, a third time    markers from the built-in language services live as long as the
                                    editor holding them does, and the editor working set is per
                                    folder - so opening one file in each folder and switching
                                    between them measures the editors, not the narrowing. Both
                                    files had to be opened from the same folder before the
                                    narrowing was the only thing left that could explain the
                                    numbers. ⚠️ The Java server, which would have had markers that
                                    outlive an editor, never finished starting in three minutes
```

#### Stage D — seven pickers, ordered not narrowed

All of them ask "which folder?", which is a workspace-level question. Listing every folder is
right; **not putting the active one first is the bug**. `foldersWithActiveFirst` is that sentence
as a function, and most of the rows are one call to it.

```
D1  debug configuration             `Add Config (ky)` first while the window is on axios
D2  Configure Snippets              same
D3  the settings editor's Folder    same
    tab
D4  Tasks: Run Task                 lists every folder's tasks; the active folder's first
D5  the agent folder picker         agentHostFolderPickerActionItem.ts:146 falls back to
                                    `folders[0]`, so a session started on axios offers ky.
                                    ⚠️ same shape as the Graph, and the same fix
D6  Terminal: Create New Terminal   found while proving A1, not by the audit: with more than one
                                    folder the command asked "Select current working directory for
                                    new terminal" and offered `ky`, the first folder, while the
                                    window was on gin. It no longer asks - the bar has answered -
                                    and `Terminal: Create New Terminal in Another Folder...` is
                                    where the question went. ⚠️ I had written that upstream already
                                    had a command that asks. It does not: `newWithCwd` takes a
                                    path as an argument. Stopping asking without putting the
                                    question somewhere would have taken away the only way to start
                                    a terminal in a folder you are not looking at
D7  the three repository choosers   the Repositories view (measured: lists all four while the
                                    window is on gin), the Graph's repository picker, and
                                    `RepositoryPicker`. ⚠️ Deliberately left out of A2: by this
                                    stage's own rule a chooser lists everything and puts the
                                    active folder first. Narrowing the Repositories view would
                                    also take away the only way to re-enable a repository that
                                    was turned off in a folder you are not in
    the shared one                  `_workbench.pickWorkspaceFolder` is the answer to "which
                                    folder?" for the settings editor's folder tab, an extension
                                    being installed into one, an MCP server and a terminal's
                                    working directory. One call there covers all of them
    proves it                       window on the last folder of four: each picker opens with
                                    that folder first or preselected, and still lists all four
    measured                        window on gson: `Preferences: Open Folder Settings` lists
                                    gson, ky, gin, axios, plainfolder - the active folder first
                                    and all five still there · `Terminal: Create New Terminal`
                                    asks nothing and opens in gson
    not clicked                     snippets, tasks, the debug dropdown and the agent picker. All
                                    four are one call to `foldersWithActiveFirst`, which has six
                                    tests, but the harness could not get the command palette to
                                    accept those rows - a separator sits at index 0 in a palette
                                    that has a "recently used" group, and Enter accepts nothing
```

#### Stage E — one window, many folders

The principle from §1, applied to the seven rows §4.11 marks `violates`. Left until here on
purpose: a folder arriving in a window whose right-hand side is not narrowed yet lands in a
state that is confusing to judge.

```
E1  the seam                        `IWorkspaceBarService.show(uri)`: put the folder in the
                                    workspace if it is not there, then move the window onto it.
                                    Through the bar because the bar owns the list, including
                                    knowing that `/tmp/x` and `/private/tmp/x` are one folder -
                                    two ways to put a folder in a workspace would be two answers
                                    to that. `openOrShow` sits beside it for the callers that
                                    offer "a folder or a workspace or a file" and were written
                                    when a folder could only mean a window
E2  the callers                     File > Open Folder, native and in-app · Open Recent, both its
                                    paths · the recent-folders menu · the welcome page, its recent
                                    list and its walkthrough command · the "Open Folder" offered
                                    when a directory is opened as a file · folders dropped on the
                                    window · `code <folder>`
    `code <folder>`                 decided in the main process, where `--add` already knew how to
                                    put a folder in a running window. A folder named on a command
                                    line, dropped on the dock or followed from a link takes that
                                    path; `API` - which is what `vscode.openFolder` arrives as -
                                    and the dialogs this window drives itself do not
    git                             "Add to Workspace" is offered first after a clone and after an
                                    init, and `git.openAfterClone: always` adds to a window that
                                    already holds folders rather than replacing it. ⚠️ Both
                                    choices are still there; only the order and the default moved
    ⚠️ never                        swallow an explicit request. `--new-window`, "in New Window",
                                    the modifier in Open Recent and `vscode.openFolder` from an
                                    extension all keep meaning a window
    proves it                       stock and this build side by side, same action: `code
                                    <folder>` gives stock a second window and gives this one a
                                    new row
    measured                        five folders, one window. `code /tmp/langbench/newfolder`: one
                                    row added, the window moves onto it, still one page. The same
                                    command again: still one row, no second one - the bar's own
                                    spelling rule doing the work. `code --new-window <folder>`:
                                    two pages
    ⚠️ the ring                     injecting `IWorkspaceBarService` into `IFileDialogService`
                                    made the workbench unbuildable: `IWorkspaceEditingService`
                                    asks the dialog service where to put a workspace file, and the
                                    bar asks `IWorkspaceEditingService` to change the folder list.
                                    The window came up **entirely blank** and the only trace was
                                    one line in the log - `illegal state - RECURSIVELY
                                    instantiating service`. Resolved at the point of use instead.
                                    A service that everything already depends on is the wrong
                                    place to hang a new dependency
```

#### Stage F — the list as a product, and the loose ends

```
F1  move a folder up and down       the order of `folders[]` is the order in the file, so there is
                                    nothing of ours to keep in step. Right-click or ⌥↑/⌥↓ on the
                                    bar, and the command palette. ⚠️ Not `updateFolders`: a
                                    read-modify-write of the whole list runs outside the workspace
                                    write queue, so it loses whatever landed between the read and
                                    the write, and re-serialises every entry. `moveFolder`
                                    instead - queued behind every other workspace edit, by
                                    identity rather than by index, and each entry keeps its `raw`
                                    so nothing else in the file moves. ⚠️ No drag to reorder - two
                                    ways to move a row is two sets of edge cases for something
                                    people do a handful of times
    measured                        six rows, window on the last: up, up, down. The folder moves,
                                    the window stays on it, and the rest keep their order.
                                    ⚠️ Moving a folder through the first position **restarts the
                                    extension host** - upstream's relauncher watches `folders[0]`
                                    for the deprecated `workspace.rootPath`. One Move Folder Down
                                    took pid 75498 out and 78361 in. Upstream's behaviour and
                                    correct, but it is a cost and it belongs beside the feature
F2  open a workspace from outside   a `.code-workspace` opened from the CLI fills the bar. ⚠️ Not
                                    a task so much as a standing fact: every measurement in
                                    stages A to F was taken in a window opened exactly that way
F3  the three unverified rows       Save Workspace As (it changes the workspace id), workspace
    of §4                           trust (one untrusted folder restricts the window), and
                                    per-folder launch.json. Point at them rather than argue
F4  the two still untested          the notebook's per-folder kernel discovery (needs a Python
                                    extension) and editSessions (needs sign-in). ⚠️ MCP has no
                                    command in this build at all - it rides with Copilot, which
                                    Step 0 turns off - but its 13 sites read the folder list,
                                    so it joins stage D the day it is switched on
```

---

#### What has been run, and what has not

⚠️ Written down per stage, because "it compiles and the tests pass" is a different claim from "it
was seen to work", and only the second one settles anything here. A row that was only compiled is
not a row that is broken - it is a row nobody has looked at yet, and saying which is which is the
difference between a gap and a surprise.

Stage A, as of 2026-09-20:

```
seen to work        the terminal's cwd across four folders, with an editor open on a fifth
                    folder's file the whole time, and again with no editor open at all ·
                    source control's Changes pane, Graph header, Graph content and status bar
                    across five folders, one of which holds no repository · the record of which
                    repositories the person chose surviving a reload taken while the window sat
                    on the last folder

compiled and unit   the file dialogs' starting directory · the debug configuration picker ·
tested only         `${workspaceFolder}` inside a terminal profile · `sendSequence` · the pty
                    host's variable resolution · `findInFiles` called with arguments · the chat
                    agent tool's cwd. ⚠️ Most of these need a variable in a setting before they
                    are reachable at all, which is why they were not clicked

cannot be run here  everything on `vscode-remote`: the remote terminal backend, Create New
                    Integrated Terminal (Local), and the scheme fallback inside
                    `activeFolderFor`. ⚠️ That fallback is the whole reason the method exists
                    and it is the least exercised code in stage A

Stage B, as of 2026-09-20:

```
seen to work        ⌘P narrowed and widened, the widening surviving the picker being closed ·
                    Find in Files narrowed and widened, counted against `grep -rl` · ⌘T
                    narrowed and widened against a language server that had indexed one folder

compiled and unit   the scope itself: eleven tests over what it covers, what it announces and
tested only         what it remembers

not run             ⌘T on anything but TypeScript, because no other language server had
                    indexed a folder in the window it was measured in
```

Stages C to F, as of 2026-09-20:

```
seen to work        the problems panel and its count, narrowed and widened, against two broken
                    files in two folders · the shared folder picker listing the active folder
                    first and all five folders · `Terminal: Create New Terminal` asking nothing
                    and opening where the bar is · `code <folder>` adding one row, moving the
                    window onto it, and adding nothing the second time · `code --new-window`
                    still opening a window · moving a folder up and down the bar

compiled and unit   `foldersWithActiveFirst` itself, six tests. The four pickers that use it and
tested only         were not clicked: snippets, tasks, the debug dropdown, the agent picker

not run             File > Open Folder and Open Recent end to end - both are native dialogs or
                    palette rows this harness could not drive, though the code they now reach is
                    the same `show` that `code <folder>` proved · git clone and git init, which
                    need a remote · the three unverified rows of §4 and the two untested ones,
                    which is what F3 and F4 are for and they are still open
```

not covered by a    the Graph's empty state on a folder with no repository, and the status bar
unit test           entry that used to count every repository. Both are view-level and were
                    measured live instead; `activeRepository` answering `undefined` on such a
                    folder - the root both of them hang off - is covered
```

#### What the review found

⚠️ Written down because every one of these passed the type checker, the layer checker, the linter
and thirty-seven thousand unit tests. Reading the diff found them; nothing else was going to.

```
covered nothing outside    `covers()` answered false for a resource in none of the workspace's
the workspace              folders, so a file opened from outside it - and everything in a window
                           with no folders - had its problems and its symbols hidden with no way
                           back: widening does not reach a folder the workspace never had.
                           ⭐ Now covered by every scope, and measured: a broken file in /tmp,
                           opened into a five-folder window, shows its problem

one write per folder        `code a b c` and a three-folder drop called `show` once per folder,
                           editing the `.code-workspace` three times and walking the window
                           through two folders nobody asked to see. One add, then one switch

the wrong visibility       the problems view rebuilt on `isVisible()`, but its model is built and
                           torn down on body visibility - a collapsed view was rebuilt for
                           nothing and then rebuilt again when opened

a search nobody was        the search view re-ran on every folder switch even while hidden.
looking at                 Switching folders is the cheap, frequent act here; a folder's worth of
                           ripgrep behind it is not. It now defers, the way the view's own
                           `changedWhileHidden` already did

a folder dropped in        the main process decided "join the open window" against any last active
silence                    window, but dispatched against the one matching the folder's authority.
                           When those differ - a local folder and only a remote window open -
                           `foldersToOpen` was empty and the folder went nowhere at all

a row that cannot be       `openOrShow` would put a folder from another remote authority into a
opened                     window not connected to it. A folder this window cannot reach needs a
                           window that can, the same as an explicit "in New Window"

a name nobody wrote        reordering passed each folder's `name` back, which for a folder never
                           named in the file is its basename - so a reorder wrote a `"name"` into
                           the `.code-workspace` for every folder

every path rewritten       ⭐ and reordering with `updateFolders` over the whole list removes and
                           re-adds every folder, so every path was serialised afresh: five
                           absolute paths came back relative. The control settled it - a plain
                           `addFolders` leaves existing entries alone, so this was ours. A move is
                           now its own operation on the stored list, and no entry's value changes.
                           ⚠️ The array's formatting is not preserved - a comment inside it is
                           lost - but stock's own Remove Folder loses it too. Measured both.
                           Measured: after a move, every path is byte-for-byte what it was and the
                           one folder that had a name still has it
```

#### What is deliberately not in the plan

```
withholding a folder from layer 2 until it is needed   §5.4: it breaks promise 1 to serve
                                                       promise 2, and promise 2 is not
                                                       under threat
narrowing showWorkspaceFolderPick or a tree an         an extension's own UI is its own.
  extension draws itself                               Stock multi-root does the same:
                                                       parity, not a regression
narrowing _workbench.pickWorkspaceFolder's list        it is asked by tasks and debug, and
                                                       those are workspace-level questions.
                                                       Stage D orders it instead
taking one workspace file's folders into      considered and parked. The capability is the
another window                               right one - two `.code-workspace` files you want
                                             to see at once is exactly what this fork exists
                                             for - but a `.code-workspace` is not only folders:
                                             its `settings`, `extensions`, `launch` and `tasks`
                                             cannot be merged, and after the folders arrive the
                                             file is no longer the one being written to. Calling
                                             that "merge" would be a lie the UI cannot walk back
                                             from. ⚠️ If it comes back, it is "add its folders
                                             to this window", said in those words, with what
                                             stays behind said out loud
```

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

---

## 8 The comparison suite

Everything in section 7 asks "does ours do the right thing". This asks a harder question, and the
one the first promise is made of: **put stock VS Code and this build side by side, do the same thing
to both, and account for every difference.**

### 8.1 Two kinds of case, and why that is the whole design

```
≠   must differ    somewhere we changed behaviour on purpose. The case fails if the two
                   builds agree - an intended change that did not happen is a feature that
                   is not there
=   must match     somewhere we did not. The case fails if the two builds differ at all.
                   This is promise 1 written as a test, and it is where regressions live
```

⚠️ The `=` cases are the point. Anybody can check that a new feature works; nobody notices the
setting that stopped being honoured, the menu item that moved, the file that got rewritten. Two
thirds of this suite is `=`.

### 8.2 How it is run

```
one fixture         /tmp/cmp/three.code-workspace, three folders: alpha, beta, gamma. Each a
                    git repository on a different branch, each with a README.md and an
                    index.ts, one with a file that has an error in it, and one file name that
                    exists in all three so a search has something to be wrong about
one at a time       argent probes one CDP port, so the suite runs against stock, then against
                    this build, from the same fresh fixture and the same fresh profile. That
                    is also how a person with one screen does it
like a person       `describe` reads the window the way a screen reader does - every row,
                    button and status entry with a frame - and `gesture-tap` clicks the frame.
                    No selectors into our own DOM, because stock does not have our DOM
what is recorded    for each case: the action, what stock showed, what this build showed, and
                    whether they were meant to differ. A case with no recorded reading from
                    one of the two builds is not a result
⚠️ the control      a case where both builds show nothing proves nothing. Every `≠` case has to
                    produce the difference somewhere, and every `=` case has to produce the
                    thing that is supposed to match - three times this session a "narrowing
                    works" reading turned out to be an empty instrument
```

### 8.3 The cases

⚠️ These twelve letters are also §9.4's. The numbers below never move; everything found
after the run was appended to the same areas, and four more letters were added for what had no home.
There is one set of case IDs in this document.

```
A  the shape of the window            7    A-1 = both hold three folders · A-2 ≠ explorer roots
                                           A-3 ≠ title and command centre · A-4 = opening a
                                           workspace does not rewrite it · A-5 = a plain folder
                                           A-6 = a second workspace file is a second window
                                           A-7 ≠ column zero exists

B  editing the folder list            6    B-1 = add · B-2 = remove · B-3 = add the same twice
                                           B-4 ≠ move up and down · B-5 = ⭐ the other entries'
                                           paths are untouched · B-6 = Save Workspace As

C  explorer and files                 5    C-1 ≠ roots · C-2 ≠ switching · C-3 = create, rename,
                                           delete · C-4 = collapse and filter · C-5 = reveal

D  source control                     8    D-1 ≠ Changes · D-2 ≠ Graph · D-3 ≠ status bar branch
                                           D-4 ≠ a folder with no repository · D-5 = the
                                           Repositories view lists all · D-6 = ⭐ a deselected
                                           repository stays deselected across a reload
                                           D-7 = stage and commit · D-8 ≠ the provider entry

E  search                             8    E-1 ≠ Find in Files · E-2 = ⭐ widened equals stock
                                           E-3 ≠ ⌘P · E-4 = widened equals stock · E-5 ≠ ⌘T
                                           E-6 = widened equals stock · E-7 = include and
                                           exclude · E-8 ≠ the scope survives a reload

F  problems                           5    F-1 ≠ count and contents · F-2 = ⭐ widened equals
                                           stock · F-3 = ⭐ a file outside the workspace
                                           F-4 = clicking one · F-5 = badge agrees with the bar

G  pickers                            7    G-1..G-5 ≠ order, = membership: folder settings,
                                           snippets, tasks, debug, the agent picker
                                           G-6 ≠ Create New Terminal asks or does not
                                           G-7 ≠ the command the question moved to

H  one window, many folders          10    H-1 ≠ `code <folder>` · H-2 = `--new-window`
                                           H-3 = `code <file>` · H-4 = `--add`
                                           H-5 ≠ Open Recent · H-6 = with the modifier
                                           H-7 ≠ File > Open Folder · H-8 ≠ the recent menu
                                           H-9 ≠ a directory opened as a file
                                           H-10 ≠ a dropped folder, = a dropped workspace

I  terminal                           5    I-1 ≠ cwd with an editor on another folder
                                           I-2 ≠ split with splitCwd · I-3 ≠ ${workspaceFolder}
                                           I-4 = run, split, kill, restore
                                           I-5 = terminal.integrated.cwd per folder

J  dialogs and editors                5    J-1 ≠ ⌘O with no editor open · J-2 = with one open
                                           J-3 ≠ Save As · J-4 ≠ editors are per folder
                                           J-5 = reopening restores them

K  what extensions see               5    K-1 = workspaceFolders is three · K-2 = tasks.json's
   ⭐ promise 1, directly                  ${workspaceFolder} · K-3 = a language server indexes
                                           all three · K-4 = ⭐ vscode.openFolder still opens a
                                           window · K-5 = onDidChangeWorkspaceFolders

L  persistence and a clean exit       4    L-1 = reopening restores · L-2 ≠ and the active folder
                                           L-3 = ⭐ the file after a whole session
                                           L-4 ≠ the scope is remembered
```

```
75 cases · about 30 ≠ and 45 = · two runs each
```

### 8.4 What it needs that does not exist yet

```
a fixture builder      three git repositories, branches, the error file, the shared name.
                       Written once, run before each of the two passes
a reading extension    ✓ built, and used for K. `/tmp/cmp/ext-probe` writes `workspaceFolders`,
                       `workspaceFile`, `name`, `getWorkspaceFolder` and every
                       `onDidChangeWorkspaceFolders` to a file, and carries a command that calls
                       `vscode.openFolder` so K-4 can be asked from inside the extension host
⚠️ a transcript        every case writes one line per build. The result of the suite is the
                       diff of two transcripts, not a pile of screenshots - a screenshot is
                       how a difference gets explained, not how it gets found
```

### 8.5 What the run has found so far

Run in order, both builds launched fresh for each area, on `/tmp/cmp/three.code-workspace`
(alpha, beta, gamma - three git repositories on three branches, one shared file name, one
unparseable JSON file). Stock is 1.137.0. `files.simpleDialog.enable` is on in both profiles so
that the open and save dialogs are in the page and can be driven; both builds route the simple
and the native dialog through the same call, so nothing is dodged by using it.

**A - the shape of the window. 7 of 7 hold.**

```
A-1  =   three roots in the explorer            three rows in the bar             ok
A-2  ≠   one section `three (Workspace)`, 13     header `alpha`, 4 rows            as intended
         tree rows
A-3  ≠   command centre `three (Workspace)`      `alpha`                           as intended
A-4  =   the workspace file is not touched by opening it                            ok
A-5  =   one folder: header `alpha`, 4 files,   word for word the same, plus       ok
         command centre `alpha`                 one row in the bar
A-6  =   a second workspace opens a second window on both                           ok
A-7  ≠   only an activity bar                    a workspace bar in column zero    as intended
```

`⚠️` One observation not reproduced: on the first launch of our build for this area a screenshot
showed the window on **gamma** with the sidebar on Source Control, while storage held
`workbench.activeFolder = .../alpha` and a read a minute later agreed on alpha. Three clean
relaunches all gave alpha. Recorded, not explained, and worth a second look if it returns.

**B - editing the folder list. 6 of 6 hold. One bug found and fixed on the way.**

```
B-1  =   `--add /tmp/cmp/delta` writes `"delta"` into the file, on both. Ours also moves the
         window onto the new row; stock has no window-is-on-a-folder to move
B-2  =   `--remove` takes it out again on both, and the three that stay are byte-identical
B-3  ≠   `/tmp/cmp/alpha` beside `/private/tmp/cmp/alpha`: stock makes a second root for the
         same directory - two identical trees, 18 rows - and ours recognises it as the row it
         already has and switches to it. Upstream de-duplicates by string, so it catches the
         identical spelling and misses the symlink; a row that is a folder cannot be two rows
B-4  ≠   stock has no reorder command at all (Add, Remove, Close, Duplicate, and dragging a
         root in the explorer). Ours has Move Folder Up/Down, and the order survives the round
         trip down and back up
B-5  = ⭐ after add, remove, add, move down and move up: every entry that was not the subject
         kept its path, character for character, and no `"name"` key appeared on any of them.
         Both builds reindent the whole file on their first edit - that is the JSON editor's
         formatting, and it is stock's too
B-6  =   Save Workspace As from both, to two different paths: the two files are identical byte
         for byte, and neither touched the workspace it was saved from
```

`⭐` **What B-1 found.** Our build wrote `"../../private/tmp/cmp/delta"` where stock writes
`"delta"`. The bar canonicalised a folder's URI *before storing it* - `/tmp` resolves to
`/private/tmp` on macOS - and the entry is written relative to the workspace file, which was
still spelled `/tmp/cmp/three.code-workspace`. A sibling became a path that climbs two levels
and comes back down. Rule (b) held - nothing of ours went into the file - but we were rewriting
the person's own entry, which is the same trespass wearing a different hat.

Which folder is this, and what should the file say, are two questions. Only the first needs the
symlink followed. `add` and `remove` now resolve **both sides** at comparison time and store the
spelling that was given. That closed two more, neither of which had a test:

```
a folder listed in the `.code-workspace` as `/tmp/x` was not recognised when `/private/tmp/x`
was added, because only folders that had come in through `add` had ever been resolved - the
symlink case the canonicalising was written for was the one it missed
`show()` on the other spelling would have thrown out of `setActiveFolder`, which refuses a URI
that is not a folder of the workspace. It now asks the model which row a URI names
```

Five tests were added or rewritten for the new contract, one of them named for the case that
was live when it was found. What the bar knows a folder by, and what the bar writes down, are
now different methods with different comments saying why.

**C - the explorer and file operations. 5 of 5 hold. One bug found and fixed on the way.**

The fixture grew a nested folder for this area: `sub/nested.ts` in each of the three, and
`sub/only-in-alpha.ts`, a name no other folder has, so a quick-open query can name one file
without ambiguity on either build.

```
C-1  ≠   three root rows and 13 rows under      header `alpha`, its 5 rows, three rows in
         them                                   the bar
         ⭐ and the control: stock opened on `/tmp/cmp/alpha` alone reads
         `aria-level 1, posinset 1..5 of 5, indent 0px` - which is what ours now reads too
C-2  ≠   nothing to click; the workspace is     clicking a row swaps the header, the tree
         the unit                                and the command centre together, three times
                                                 round and back
C-3  =   new file, rename, move to trash: the same five steps, the same tree afterwards, the
         same four files left on disk. `c3.ts` -> `c3-renamed.ts` -> gone, on both
C-4  =   collapse, then type `shared` from the same rows on screen: focus moves `sub` ->
         `shared.ts` on both, and neither expands anything to do it
C-5  =   open `sub/only-in-alpha.ts`, then Reveal in Explorer: both expand `sub` and select
         the file, at the same level, with the same siblings
```

`⚠️` Two of these needed the harness fixed before they measured anything, and both failures
looked like findings first. `Input.insertText` puts text in without a keydown, so a tree's
keyboard navigation never sees it - the first "ours behaves differently" was a script that typed
into nothing. And rename and delete in the explorer are `Enter` and `cmd+backspace` on macOS, not
`F2` and `Delete`; pressing the Windows keys proved only that the Windows keys are not bound.

`⭐` **What C-1 found: the same question, asked twice, answered twice.** `explorerView` decides
whether the tree is handed the one root or the array of them, and had already been repointed at
"how many roots is the explorer showing" rather than "what state is the workbench in". The
renderer asks the same question again, for the level a screen reader announces - and that one
still read `getWorkbenchState() === WORKSPACE`. Our window is always a workspace, so every file
in a narrowed explorer was announced one level deeper than it is: the child of a row that is not
on screen. The indent was 0px and the rows looked right, which is why nothing caught it until
stock was opened on the same folder and the two trees compared attribute by attribute.

The fix is one predicate, `rootsAreRows`, in the model both files already import, and both call
sites ask it. They cannot drift apart again, because there is only one of them. It also let the
renderer give up a dependency it no longer had a use for.

`⚠️` This is the second time a narrowing has been correct in the view and wrong in something the
view feeds. The first was the SCM record of which repositories a person chose. The pattern is the
same: a value that used to be a fact about the workbench became a fact about one folder, and the
places that read it were repointed one at a time.

**D - source control. 8 of 8 hold. One bug found and fixed, one gap found and left open.**

All three repositories dirty and differently: alpha 1 file, beta 2, gamma 1. `git.useEditorAsCommitInput`
is off in both profiles - stock's default opens `COMMIT_EDITMSG` as an editor, which the harness
could not finish, and leaving that commit half-done gates every other git command behind
`operationInProgress`. Same setting on both sides.

```
D-1  ≠   three repository sections, each     one repository, no section header at all -
         with its own header, message box      the message box and the changes, the way a
         and changes                           window on one folder reads
D-2  ≠   the Graph follows the active        the Graph follows the bar. Clicking gamma,
         editor: opening gamma/shared.ts       beta, alpha moves it three times
         moves it to gamma
D-3  ≠   the status bar follows the active   it follows the bar. Same entry, same tooltip
         editor, tooltip `alpha (Git) - ...`   shape, different thing deciding
D-4  ≠   a folder with no repository         the pane empties, the branch entry goes, and
         changes nothing - the other           the Repositories view still lists all three
         repositories are still there          ⚠️ and see the gap below
D-5  =   the Repositories view lists all three, on both. ⭐ The way back, and on ours it now
         works: picking one there takes the window to its folder
D-6  = ⭐ stock: alpha+gamma chosen survives a reload, beta stays off.
         ours: after a reload, walking all three folders shows each one's changes - the bug
         where closing on one folder wrote down a deselection of every other is gone
D-7  =   stage all, then commit: identical. `D-7 from the comparison run`, one file, clean
         tree afterwards, beta and gamma untouched. Both ask "Choose a repository" and both
         list all three - the git extension sees every folder, which is the point
D-8  ≠   Changes carries a repository row per provider; ours has none. Same view title,
         same panes
```

`⭐` **What D-5 found: a click in a list of every repository, in a window showing one folder's.**
Upstream's Repositories view lists exactly the repositories that could be visible, so its
selection means "these and no others" and hands itself straight to `visibleRepositories`. Ours
lists every repository the workspace has - deliberately, because that is the only way back to one
turned off in a folder you are not in. The same gesture then means something else, and two things
were wrong at once:

```
picking a repository in another folder left the pane empty. The choice said beta, the folder
said alpha, and nothing was in both. No message, no clue - just a blank pane
and the write reached into every folder. "These and no others" turned off the repositories of
folders the window was not showing and had never been asked about
```

The second is the A2 bug through the other door. That one was a narrowed getter feeding a
persisted write; this is a write speaking for folders it cannot see. The fix is the same shape in
the same place: a write now says nothing about a folder the window is not on, and the Repositories
view asks the service to `show` repositories rather than writing the answer itself - so picking one
in another folder takes the window there, the way clicking that folder in the bar would. The folder
moves first, because the write that follows only speaks for the folder the window is on.

Four tests, two of them starred. Proven live: picking beta while the bar says alpha now draws
beta's two changes and moves the status bar to `beta (Git) - branch-beta*`, and walking all three
folders afterwards still finds each one's changes.

`⭐` **What D-4 found: a blank pane where stock offers a way forward, and three readers behind it.**
Stock opened on a folder with no repository shows a welcome - *"The folder currently open doesn't
have a Git repository"* and an **Initialize Repository** button. Ours, on the same folder, showed
**nothing at all**. Asked, and the answer was to narrow the key. That took three tries, and the two
failures are the interesting part.

```
1  scm.providerCount counted what the extension host had registered - three, whatever folder was
   on screen - so the git extension's welcome was unreachable. The registry in `common` cannot
   know which folder the window is on, so `SCMViewService` took the key over and set it from the
   repositories in the folder on screen. Chosen or not: turning the only one off is not the same
   as not having one, and offering to initialise a repository in a folder that has one is worse
   than the blank pane

2  ⚠️ and the Repositories view vanished. It is gated on `scm.providerCount != 0` too - asking
   the opposite question. The welcome asks "does this folder have a repository"; the view that
   lists every repository asks "are there any to choose from at all". Upstream could share one key
   because the two answers were always the same. A folder with nothing of its own is exactly when
   the way back is needed, and narrowing the key took it away. `scm.workspaceProviderCount` now
   answers the second question, and the view is gated on that

3  ⚠️ and the pane still drew nothing. `SCMViewPane.shouldShowWelcome()` asked the registry
   directly - `scmService.repositoryCount === 0` - which no narrowing of a context key could
   reach. It now asks the view service what the folder on screen has, through the same
   `folderRepositories` the key is computed from, and the pane listens for a switch as well as for
   repositories arriving and leaving
```

Measured afterwards: on `norepo` the Changes pane carries the welcome and an **Initialize
Repository** link that works, the Repositories view still lists all three, and switching to alpha
and back swaps between the four change rows and the message.

`⚠️` **One thing still reads wrong, and it is not ours to fix.** The sentence is the multi-root one:
*"The workspace currently open doesn't have any folders containing Git repositories."* In this
window that is false - three of its four folders have one. The git extension picks between that
sentence and the single-folder one on `workbenchState`, and this window is a workspace and has to
stay one. The button is right, the sentence overstates, and changing `workbenchState` is the one
thing this fork will not do.

`⚠️` Three readers of one fact, found one at a time, each hidden by the one before it. The grep
that would have found all three at once is for the *fact*, not for the symptom.

**E - search. 8 of 8 hold. Nothing found: the first area that turned up no bug.**

Every number checked against `grep` on the fixture first, and the widened numbers against stock's
output, not just against each other. The fixture was made clean for this area - the dirty files
from D reverted and every editor closed - because a search reads unsaved buffers too, and one
stray keystroke in an open editor had already turned 3 hits into 4.

```
ground truth   FACADE_MARKER   alpha 1 file / 1 hit    all three 3 / 3
               export          alpha 4 / 5             all three 10 / 13
               export, not in **/sub/**                all three  6 / 9
```

```
E-1  ≠   3 results in 3 files, in three     1 result in 1 file, and no folder row
         folder sections                      above it
E-2  = ⭐ widened: `3 results in 3 files`, and the row list is stock's, string for string -
         the folder sections come back with it
E-3  ≠   ⌘P `index` -> three, one per       -> one, alpha's
         folder; `shared` -> three
E-4  = ⭐ widened: the same three, in the same order stock gives them (beta, alpha, gamma)
E-5  ≠   ⌘T `#FACADE_MARKER` -> three       -> one, alpha's
E-6  = ⭐ widened: the same three, in the same order
E-7  =   include `**/*.ts` -> 13 / 10;        widened: 13 / 10 and 9 / 6, the same numbers.
         and excluding `**/sub/**` -> 9 / 6   Narrowed: 5 / 4 and 3 / 2, which is alpha on
                                              its own, counted by `grep`
E-8  ≠   there is no scope to survive       the widened scope survives a reload, and the
         anything                             title reads `Showing All Folders`, checked
```

`⚠️` **⌘T needed a control before it could say anything.** The first reading was one result where
three were expected, and it was not the narrowing: TypeScript indexes lazily, and only the folder
whose file had been opened was warm. Opening `shared.ts` from each of the three and waiting made
stock answer three - and only then was there an instrument that could tell a narrowed answer from
a cold one. Both builds are warmed the same way, by opening the same three files.

`⚠️` Two harness faults on the way, both of which read as findings first. A quick input remembers
its last query **including the prefix**, so selecting all and typing over it turns `#symbol` into a
file search that answers "No matching workspace symbols" for everything. And `Input.insertText`
fills a box without the widget hearing a keystroke, so the search never runs - the last character
has to go in as a real key event.

`⚠️` Noticed in passing, not a planned case: after opening `shared.ts` from beta and then from
gamma, the title still read `shared.ts — alpha`. The window stays on the folder the bar says, which
is the rule about the editor never moving it, holding in a running window.

**F - problems. 5 of 5 hold. Nothing found; one thing that looked like a bug for half an hour.**

The fixture grew a bad JSON file in beta and gamma, so that narrowing has something to hide. Four
bad files in all: one in each folder, and `outside/broken-outside.json`, which is in none of them.
All four opened from the one folder, which the widened scope makes reachable without moving the
window.

```
F-1  ≠   four file rows, one per bad file    two: alpha's and the one outside the
                                              workspace. beta's and gamma's are filtered
                                              out although their editors are still open
F-2  = ⭐ widened: the same four rows, in the same order, with the same message, the same
         column numbers and the same badge - `4 0`, `Errors: 4`
F-3  = ⭐ `broken-outside.json` is in the panel in **both** scopes. A file in none of the
         workspace's folders is covered by every scope, which is the regression this case exists
         for: `covers()` once hid everything outside the workspace and everything in an empty
         window
F-4  =   double-clicking beta's problem opens the file at `Ln 1, Col 12`, one character selected,
         on both. On ours the window stays on alpha while it does it
F-5  =   the badge counts what the panel shows, at every step: 2 on alpha, 0 on a folder with
         nothing open, and back
```

`⚠️` **The half hour.** Walking the bar alpha -> beta -> gamma -> alpha left the panel empty and the
badge at zero, with all four tabs back on screen. Thirty seconds of waiting did not change it, and
closing every editor by hand and reopening one did not either. It looked like the switch had
broken diagnostics for the window.

It had not, and two measurements said so. Widening the scope showed one problem - **beta's** - so
the markers were not gone, there was just one of them. And stock, reloaded with the same four
files open, came back with **one** as well: its restored tabs are lazy, so only the editor that is
actually active has a document, and only a document has diagnostics. Four became one on both
builds, for the same upstream reason.

Ours read zero rather than one because the editor the restore made active was beta's, and the
panel was narrowed to alpha - which is the panel doing its job. The badge agreed with it, which is
what F-5 asks.

`⚠️` Worth saying out loud even though it is upstream's: on stock this only happens when a window
reloads, which is rare. Here it happens on **every folder switch**, because each folder brings back
its own editors. Leaving a folder with four problems on screen and coming back to one is going to
read as a bug to whoever it happens to, and the honest answer - the tabs are there, the documents
are not yet - is not visible anywhere.

**G - the pickers. 6 of 7 hold, 1 not run. One bug found and fixed.**

The judgement here is narrow and strict: **the same folders, in a different order**. A picker that
lost a folder would be promise 1 broken, whatever it gained. The fixture grew `.vscode/tasks.json`
and `.vscode/launch.json` in each folder so that the task and debug pickers have something to
offer, and the window was put on **gamma** - last in the workspace - so that "active first" is
visible rather than assumed.

```
                              stock 1.137.0                     ours, window on gamma
G-1  folder settings          alpha, beta, gamma                gamma, alpha, beta
G-2  snippets                 global, then alpha, beta, gamma   global, then gamma, alpha, beta
G-3  tasks                    echo-alpha, -beta, -gamma         echo-gamma, -alpha, -beta
G-4  debug                    run-alpha, -beta, -gamma          run-alpha*, run-gamma, run-beta
     and its Add Config       alpha, beta, gamma, workspace     gamma, alpha, beta, workspace
G-6  new terminal             asks "Select current working      asks nothing. The terminal opens
                              directory": alpha, beta, gamma    in `/private/tmp/cmp/gamma`,
                                                                read off the shell process itself
G-7  where the question went  there is no such command          `Create New Terminal in Another
                                                                Folder...`, offering gamma, alpha,
                                                                beta under stock's own placeholder
```

Membership is identical in every one of them.

`⭐` **What G-4 found: the fourth reader of the same fact.** `getLaunches()` was ordered - that is
what the Add Config entries come from, and they were right. `getAllConfigurations()`, which is what
the launch configurations themselves come from, walked `this.launches` raw. The comment left on
`getLaunches` said the rule out loud - *every reader that is not a `find` or a `filter` is a list
somebody looks at* - and then a reader two hundred lines away was not repointed.

Both places now share one helper, `activeFirst`, beside `foldersWithActiveFirst`, which moves one
item to the front and disturbs nothing else. That matters here: the launches list ends with the
workspace's own `launch.json` and the debugger takes it **by index from the end**, so a sort would
have broken it. Four tests, and the wiring is what the live run proves.

`⚠️` `run-alpha` still reads first, marked *Most Recent*. That is upstream pinning the **selected**
configuration to the top, and the selected one is alpha's because it is the first launch with
configurations in the raw list. Whether the selected configuration should follow the bar - the way
the Graph and the status bar do - is the same question D-2 and D-3 answered yes to, but it is a
persisted selection rather than a list order, so it is written down here and not changed.

`⚠️` **G-5 was not run.** The agent picker lives in the chat surface, which needs the Copilot
extension and a signed-in account; neither is present in a throwaway profile on a dev build. The
change there is the same single call to `foldersWithActiveFirst` as G-1 and G-2 and is covered by
that helper's tests, but **nobody has seen it on a screen**, and this table does not get to say
otherwise.

**H - one window, many folders. 8 of 10 hold, 2 not run. One bug found and fixed, in the path most
people use.**

The area the whole fork turns on, and the judgement is a number: how many windows are open
afterwards. Counted from the debugger's own page list, not from a screenshot.

```
                              stock 1.137.0                     ours
H-1  `code <folder>`          + 1 window, `delta`               same window. alpha -> delta, and
     ≠                                                          the workspace gains `"delta"`
H-2  `--new-window <folder>`  + 1 window, `epsilon`,            + 1 window, `epsilon`, workspace
     =                        workspace file untouched          file untouched
H-3  `code <file>`            same window,                      same window, `index.ts - alpha`
     =                        `index.ts - three (Workspace)`
H-4  `--add <folder>`         same window, file gains delta     the same, and the window moves
     =                                                          onto the folder it just added
H-5  Open Recent, Enter       ⚠️ the workspace is **replaced**   same window, delta becomes a row,
     ≠                        by a single-folder window on      workspace intact at four folders
                              delta
H-6  Open Recent, ⌘Enter     + 1 window                        + 1 window, workspace file
     =                                                          untouched
H-7  File > Open Folder       the workspace is replaced         delta becomes a row, workspace
     ≠                                                          intact
H-9  File > Open..., pointed  the workspace is replaced         ⭐ after a fix: a row, workspace
     ≠  at a directory                                          intact. A file picked the same
                                                                way still opens as an editor
```

`⚠️` **H-5 and H-7 are not "a second window" on stock - they are "your workspace is gone".** Picking
a recent folder, or opening one, replaces the window you were in. Nothing is lost on disk and the
workspace can be reopened, but what was on screen is not there any more. Ours adds a row and moves
to it, and the four folders are still four folders. That is a bigger difference than the case list
assumed, and in the right direction.

`⭐` **What H-9 found, and why it matters more than the others.** `File: Open...` offers files and
folders at once, and a directory picked there **replaced the workspace on our build too** - the
seam did not cover it. Two call sites were missing it, and the second is the one that matters:

```
the in-page dialog  `pickFileFolderAndOpenSimplified` opened a window itself for a directory
the native dialog   `pickFileFolderAndOpen` handed the whole job to the main process, which
                    picks and opens in a single call and can only answer with a window
```

⚠️ The native one is what runs by default. Every measurement in this area had been made with
`files.simpleDialog.enable` on, so the path almost every person actually uses was the one nobody
had looked at. The dialog is now **asked for a path** rather than told to open one - the same shape
the Open Folder fix already had - and a shared `openPicked` decides what to do with it, so the two
dialogs cannot answer differently again. A test pins the native half; the in-page half is what the
live run measured, before and after.

`⚠️` **H-8 and H-10 were not run.** H-8 is the File > Open Recent submenu, which on macOS is a
native menu that the debugger cannot drive; it reaches the same `openOrShow` seam H-5 proves, but
nobody has clicked it. H-10 is a folder dropped from Finder: synthetic drag events carry no real
file path into the page, and **stock did not react to one either** - so there is no instrument, not
a negative result. The drop handler is a path this fork changed and it is still unmeasured.

**I - the terminal. 3 of 5 have results, 2 have none. No bug found.**

The terminal is where the fifteen repointed guesses were supposed to show, and it is the surface
the rule about the editor was written for. Its working directory is read **from the shell process**
- `lsof -d cwd` on the pid - because xterm draws to a canvas and the screen has nothing to read.

```
I-1  ≠  stock follows the **active editor**: an editor on alpha gives a terminal in alpha, and
        moving the editor to gamma gives the next one gamma. Both measured, so the mechanism is
        established rather than assumed.
        ⭐ Ours follows the **bar**. With the editor on `alpha/sub/only-in-alpha.ts` - a name no
        other folder has, so there is nothing to misread - and the bar on gamma, the terminal
        opened in `/private/tmp/cmp/gamma`.
I-3  ≠  `${workspaceFolder}` in `terminal.integrated.cwd`: stock resolved it to the editor's
        folder three times over (`beta/sub`, then `alpha/sub` and `gamma/sub`). Ours resolved it
        to the bar's - `gamma/sub` - while the editor was still on alpha's file
I-4  =  killing every terminal takes both builds to zero terminals and zero shell processes. The
        split-and-restore half of this case was not driven; see below
```

`⚠️` **I-2 has no comparison.** The split could not be driven on our build: focus never lands
inside the terminal for a synthetic click, so the split keybinding and both split commands did
nothing, across five attempts. Stock has a data point - a split with `splitCwd: workspaceRoot`
landed in **alpha**, the editor's folder - and it arrived incidentally, showing up in a later
reading rather than the one that asked for it. One side measured is not a comparison, so this case
has no result. It shares its mechanism with I-1, which is measured on both.

`⚠️` **I-5 has no instrument.** A folder-level `terminal.integrated.cwd` in `gamma/.vscode/settings.json`
did not take effect on stock - and neither did a folder-level `files.exclude` put beside it as a
control. `terminal.integrated.cwd` is declared `ConfigurationScope.RESOURCE`, so it should have.
With the control failing too, what was measured is the fixture or the harness, not either build,
and there is nothing here to report about the product. The folder settings file was taken out
again afterwards.

`⚠️` Two readings in this area arrived late rather than not at all - a split that appeared in the
*next* measurement, and terminals counted before they existed. A terminal is slower than the thing
that asked for it, and "it did not happen" needs a second look before it is written down.

**J - dialogs and editors. 5 of 5 hold. No bug found.**

What a dialog offers when it opens is a guess about where you are, and it is one of the fifteen.
The starting path is read out of the dialog's own box, without completing it.

```
J-1  ≠  `File: Open...` with nothing open: stock starts at `/private/tmp/cmp/alpha/` - the
        **first** root, whichever folder you were working in. Ours starts at the bar's folder,
        `gamma/`. `File: Open Folder...` starts at `/private/tmp/cmp/` on both
J-2  =  with an editor open on `beta/shared.ts`, both start at `beta/` - **ours too, with the bar
        on gamma**. When there is a file in front of you, the dialog follows the file
J-3  =  Save As with that editor: `beta/shared.ts` on both, character for character
     ≠  ⭐ and in the one place it can differ - an untitled file in a window where no file has
        ever been opened - stock offers `alpha/Untitled-1` and ours offers `gamma/Untitled-1`
J-4  ≠  each folder keeps its own editors. gamma has `shared.ts`; alpha opens with **no tabs at
        all**, takes `broken.json`, and the two sets swap back and forth without losing either
J-5  =  after a reload the window comes back on alpha with `broken.json`, and switching to gamma
        brings `shared.ts` back. **Both** folders' sets survive, not only the one on screen
```

`⚠️` **The case list had J-3 down as a flat `≠`, and that was too coarse.** Save As follows the
file, and there is almost always a file - so it agrees with stock everywhere except the one window
where nothing has been opened yet. Measured three ways to find the seam: with a file (same), with
an untitled file after a file (same - both fall back to the last file's folder, `beta`), and with
an untitled file in a window that has never had one (different). The difference is exactly where
there is nothing else to go on, which is where the fork intends to differ and nowhere else.

**K - what extensions see. 5 of 5 hold. No bug found. ⭐ This is promise 1 said out loud.**

Every case here is `=`, and any `≠` would be a failure rather than a feature. The reading is done
by a throwaway extension - `ext-probe`, twelve lines of interest - that writes what it sees to
`/tmp/cmp/probe-out.json`, installed into both throwaway extension directories. §8.4 listed it as
something the suite needed and did not have; it exists now.

```
K-1  =  ⭐ the same snapshot on both builds, field for field:
        workspaceFolders  alpha, beta, gamma, at indices 0, 1, 2
        workspaceFile     /tmp/cmp/three.code-workspace
        name              **"three (Workspace)"** - while the window's own title bar says `alpha`
        getWorkspaceFolder(beta/shared.ts)  ->  beta
K-2  =  each folder's task resolves `${workspaceFolder}` to its own folder, on both:
        alpha -> /private/tmp/cmp/alpha, beta -> beta, gamma -> gamma. The tasks write it to a
        file, so what is compared is what the shell was actually given
K-3  =  the TypeScript server has all three indexed on both builds. Measured in E-5/E-6: widened,
        ⌘T answers `FACADE_MARKER` with alpha, beta and gamma in the same order on both. The
        narrowing is in what the picker offers, not in what the server knows
K-4  = ⭐ `vscode.openFolder(delta, { forceNewWindow: false })` replaces the window with a
        single-folder window on delta - on **both**. The probe confirms it from inside:
        `workspaceFile: null`, `name: "delta"`, `folders: ["delta"]`, and the `.code-workspace`
        on disk still holds its three. The seam that makes `code <folder>` join this window does
        not reach the API, which is the one carve-out, and it held
K-5  =  `onDidChangeWorkspaceFolders` fires identically: `added: ["delta"], removed: [], countAfter: 4`.
        On our build the same command also moves the window onto the new folder, and the extension
        is told none of that - it is told what upstream tells it
```

`⭐` **The line this area is really about.** The window shows one folder; `workspace.name` still
answers `three (Workspace)` and `workspaceFolders` still has three. An extension written against
VS Code cannot tell it is running here, and nothing in these five readings gives it a way to find
out. That is the promise, and it is the first time it has been checked from the other side of the
extension host rather than argued from the code.

**L - persistence and a clean exit. 4 of 4 hold. No bug found.**

A whole session on each build, then a **clean shutdown** - `SIGTERM` to the main process, so the
save-state path actually runs - then the window reopened. The session: open a file, widen the scope
(ours), search, problems, source control, walk the bar through all three folders (ours), a terminal,
another file, the explorer.

```
L-1  =  reopened, both builds bring back the same two editors and the terminal
L-2  ≠  and ours comes back **on alpha**, the folder the session left it on - explorer header,
        command centre and title all say so. Stock comes back to `three (Workspace)`, which is
        the only thing it has to come back to
L-3  = ⭐ the `.code-workspace` file is **byte-identical** afterwards, on both:
        md5 9ad2ad3c804aa3b1d8708c8676596505 before, and the same after
L-4  ≠  the widened scope survives the quit: the same search answers `3 results in 3 files`
        instead of 1, and the toggle reads `Showing All Folders`, checked
```

`⭐` **L-3 is the second of the two rules, measured end to end rather than argued.** Nothing of
ours goes into the workspace file - and what this run adds is that nothing of ours goes in *by
accident either*, after a session that touched every surface the fork changes. Where our state went
instead is readable in the workspace storage database beside it:

```
workbench.activeFolder              which folder the window is on
workbench.workspaceBar.editorSets   each folder's editors
facade.folderScope                  narrowed or widened
```

Three keys, all in `WORKSPACE` storage, none in the file. Stock's own control says the same file is
untouched by the same session, so the comparison is between two unchanged files rather than between
a changed one and a guess.

### 8.6 The suite, finished

```
area                       cases   with a result   found
A  the shape of the window     7         7          -
B  editing the folder list     6         6          1
C  explorer and files          5         5          1
D  source control              8         8          2
E  search                      8         8          -
F  problems                    5         5          -
G  pickers                     7         6          1
H  one window, many folders   10         8          1
I  terminal                    5         3          -
J  dialogs and editors         5         5          -
K  what extensions see         5         5          -
L  persistence, a clean exit   4         4          -
                              75        70          6
```

**Six bugs, and five of them are one mistake.** A fact that used to be about the workbench became a
fact about one folder, and its readers were repointed one at a time:

```
B   the bar resolved a symlink before *storing* the path, so a sibling folder went into the
    `.code-workspace` as `../../private/tmp/cmp/delta`. Which folder is this, and what should the
    file say, turned out to be two questions
C   `explorerView` asked "how many roots am I drawing"; the renderer asked `getWorkbenchState()`
    for the same thing, so every file was **announced** one level deeper than it is
D   a write to `visibleRepositories` spoke for folders the window could not see - and
    `scm.providerCount` had three readers, two of them asking opposite questions
G   `getLaunches()` was ordered; `getAllConfigurations()` walked the raw list two hundred lines away
H   `pickFileFolderAndOpen` bypassed the seam on **both** dialog paths, and the native one - the
    one that runs by default - had never been measured
```

`⭐` **The pattern is worth more than the six fixes.** Fixing the reader you can see hides the
others: they fail in a screen reader, in a stored record, in a folder nobody is looking at, behind
a setting nobody turned on. Four of the six were found only because stock was standing beside us
doing the same thing, and two of those only because the comparison went down to an attribute rather
than a row label.

**Five cases have no result, and none of them is a pass.**

```
G-5   the agent picker needs the chat surface: an extension and an account a throwaway profile
      does not have
H-8   File > Open Recent is a native menu on macOS. Same seam as H-5, which is measured
H-10  a folder dropped from Finder. Synthetic drags carry no path, and **stock did not react
      either** - no instrument, not a negative result. This is a path the fork changed
I-2   the terminal split could not be driven on our build; stock has a data point and one side
      is not a comparison
I-5   a folder-level `terminal.integrated.cwd` did not take effect on stock, and neither did the
      control beside it - so what failed was the fixture or the harness, not the product
```

`⚠️` H-10 is the one that should keep somebody awake: the drop handler is ours to break and nothing
has looked at it. The other four are either covered by a neighbour or blocked by the harness rather
than by the product.

`⚠️` **What the harness got wrong, kept here so the next run does not pay for it again.** Every one
of these read as a finding first:

```
the palette needs its `>` back after a select-all, or it silently becomes a file search
`Input.insertText` puts text in without a keystroke, so trees and search boxes never react
rename and delete in the explorer are Enter and cmd+backspace on macOS, not F2 and Delete
`timeout` does not exist on macOS, so the command that "failed" never ran
a surviving instance keeps port 9222, and every reading after that comes from the wrong window
a terminal, and a split, can arrive in the *next* measurement rather than the one that asked
an unsaved editor is searched too, so one stray keystroke turned 3 hits into 4
```

### 8.7 The review after the run

Reading the whole change back with the suite's experience in hand, looking for three things: more
of the bugs it found, tests it never ran, and corners cut.

**More of the same bug, still in the tree: two.**

```
⭐ the settings editor's own **Folder** dropdown listed the workspace's order, while
   `Preferences: Open Folder Settings` - the same question through the command palette - had been
   repointed to put the folder the window is on first. Two doors onto one question, one turned.
   Measured after the fix: with the window on gamma the dropdown offers `gamma, alpha, beta`
   the agent-sessions welcome opened a recent folder with `hostService.openWindow` directly,
   bypassing the seam every other "open this folder" goes through. Fixed, and ⚠️ unmeasured:
   that screen needs an extension and an account a throwaway profile does not have
```

Everything else the sweep turned up was a `find`, a `filter`, a count, or a fallback that already
had the active folder in front of `folders[0]`. Rule (a) holds: the two places that replace the
whole folder list both take it from a dialog, not from a narrowed getter.

**Corners cut: five, all mine.**

```
⭐ `add` then `show(the last one)` was written out twice - in the CLI path and in the drop
   handler - with the same intent and no shared code. Now one `addAndShow` on the bar service
⭐ and the reason only two of the four ways to add a folder move the window was **nowhere**.
   Dropping on the window means "show me this"; dropping on the bar, or picking through its `+`,
   means "put this in the list" - a real distinction, and one a reader could not tell from a bug.
   Said out loud now, at both sites that do not move
⭐ `vs/workbench/services/folderScope` was never added to `build/lib/i18n.resources.json`, so
   every string in the new service would have shipped untranslatable. The linter had been saying
   so; `| tail -3` had been cutting it off. Every warning across the change is read now, and there
   are none
   `folderScope.ts` and `pickerQuickAccess.ts` had unsorted imports, and `terminalActions.ts` had
   one sitting where the import it replaced used to be rather than where it belongs
   a `string | URI | undefined` annotation in `terminalActions.ts` that only widened what the
   expression already was
```

**Tests the suite never ran, run now.**

```
the scope toggle **on the picker itself** - ⌘P's own title button. Narrowed it offered one
`shared.ts`; clicking it offered the same three stock does, in the same order. Nothing in the 75
had ever pressed it; the scope was always changed from the palette or the search view
the scope changed while the Problems panel is **hidden**, which is the shape of the bug the
first review found in the search view. Widened and open: four problems, badge four. Panel closed,
scope narrowed, badge two straight away. Panel reopened: exactly the narrowed two. No staleness
```

`⚠️` **And a sixth harness fault, found by chasing what looked like a real one.** The bar stopped
responding to clicks in one window. The explorer in the same window still responded, so it was not
the window - it looked like ours. It was not: opening the settings editor's Folder dropdown
**twice without dismissing it** leaves a context menu listening at the document, and it swallows
every click after that. Reproduced on a fresh window, and the bar comes back the moment the menu is
dismissed. A person cannot get into that state; only a script that opens menus and never closes
them can.

`⚠️` Still not covered by anything: `addAndShow`'s empty-list guard, and the agent-sessions welcome
change above. Both are reasoned, neither is measured.

### 8.8 Three reviews, and what they found that this one had not

Two more reviews were run over the same change - one a test-plan review numbered R1 to R8, one a
line-by-line code review that checked those eight against the tree and went on. Every one of the
eight held. Seven are fixed here; R8, the stock-behaviour switch `ENGINEERING.md` asks for, is a
product decision and was deliberately left.

```
R1  restoration ran outside the switching transaction     fixed  switcher joins the capture
R2  a rename restored an old or empty editor set          fixed  a rename is not a move
R3  reorder bypassed the workspace write queue            fixed  queued, and by identity
R4  the drop interceptor shadowed everything              fixed  see below
R5  Go to File history bypassed the scope                 fixed  filtered through `covers`
R6  native Open lost multiple selection                   fixed  `canSelectMany` again
R7  membership changes did not invalidate the scope       fixed  it listens to the workspace
R8  no switch whose off state is stock                    open   a decision, not a defect
```

`⭐` **The worst of it was R4, and the first pass at it fixed the wrong half.** The bar's drop handler
listens on `document.body` in the capture phase and stopped **every** drag from the file manager,
wherever it landed. The first fix here changed what happens after that - a `.code-workspace` opens a
window rather than being taken apart - and left the interception alone. The second review counted
what the interception costs:

```
the explorer tree     copies the dropped files into that folder, with a confirmation
the chat input        attaches the file to the prompt
the Extensions view   installs a dropped `.vsix`
a webview, a notebook cell   whatever the extension or the cell does with it
```

All four were answered with "added to the workspace" instead. That is promise 1 broken four times to
pay for one feature that was already reachable. The listener now takes only what lands **on the
bar**, and everything else keeps the handler it had - including the editor area, where a dropped
folder reaches `ResourcesDropHandler` and is added *and* shown. Dropping on the bar adds without
moving; dropping on the window moves. That distinction is now enforced by where the listener looks
rather than asserted in a comment, and `isTheBars` is tested against all five surfaces.

`⚠️` **And the handler itself had drifted the other way.** Once the listener was narrowed to the bar,
the line inside it still said `addAndShow` - so a drop on the bar went on moving the window, which is
the whole feature undone for somebody dropping four folders at once. The seam was right (the service
has offered `add` and `addAndShow` side by side, with the rule written on both, since the CLI path);
one caller had simply never been repointed. It is `add` now, and a test says so - it fails when the
call is put back, which is how it was checked.

`⭐` **And then it was measured, because the instrument was wrong about itself.** "A synthetic drag
carries no file path" had been written down four times in this document as the reason H-10 could not
be run. It is not true: CDP's `Input.dispatchDragEvent` takes a `files` array, and the workbench
receives it as a real file drop. Measured on the built app, one window throughout:

```
                     bar                              title bar
start                alpha, beta, gamma               alpha
folder -> the bar    + delta                          alpha      added, did not move
folder -> the editor + epsilon                        epsilon    added and moved
file   -> the editor unchanged                        shared.ts  opened, no row
```

The same run on the build from before the fix put the title on `delta` after the bar drop - the
defect was live, and the instrument sees it. §9 is written on top of this: the rows that three
reviews called unreachable are reachable.

`⚠️` **One thing that run turned up and did not settle.** A `.code-workspace` dropped on the bar
does not open a second window - it **replaces this window's workspace**, and the three folders that
were in the bar go with no prompt. That may well be what stock does with a workspace file, but the
A/B was not run, and the sentence above this one claimed a new window. Carried into §9 as H-23.

`⭐` **`code <folder>` into an empty window wrote an untitled workspace.** The gate that makes a
folder join this window fired for any last-active window, empty ones included - and adding a folder
to an empty window turns it into a workspace: a `.code-workspace` in the profile, an extension-host
restart, and a "save your workspace configuration?" prompt on the way out. H-1 only ever measured a
window that already held three folders. The gate now asks whether that window is on anything, and
leaves upstream's own "this folder is already open over there" lookup in front of it. Measured after:
both builds record `{"folder": "file:///tmp/cmp/delta"}` and open a second window - identical. ⚠️ The
review said stock reuses the empty window; it does not, and the fix is the same either way.

`⭐` **Moving a folder through the first position restarts the extension host.** Upstream's relauncher
watches `folders[0]` for the deprecated `workspace.rootPath`, so Move Folder Up on the second row
costs every language server a restart. Measured: the extension host pid went from 75498 to 78361 on
one Move Folder Down. Not a defect - it is upstream's behaviour and it is correct - but F1 said
"measured" and never mentioned it, and the cost belongs beside the feature.

Also fixed from the third review: the Search Editor and the `%` quick text search now use the same
folder list as Find in Files; the reachability test that decided "this folder needs another window"
lived in two places and read a URI's own authority, so a `vscode-vfs://` folder was sent to a second
window that could have held it - it is now one function asking for the **remote** authority; and a
comment on `show()` that explained a guard by something `addFolders` does not do.

`⚠️` **What the `%` picker still does not do** is re-run the results already on screen when the scope
is toggled under them. The toggle is there, it flips the scope, and the next query or the next time
it is opened is answered from the new one. Clearing its cached matches ahead of the refresh was tried
and does not reach that path.

---

## 9 The release plan

Three reviews wrote three plans - a review and coverage plan (80 automated cases, 24 live checks,
R1-R8), a code review (twelve findings and a list of what the first plan missed) and a
release plan for Mac developers using coding agents (twelve user journeys, sixteen agent cases, eight
acceptance sessions). All three were folded in here and their files removed, so that there is one
plan rather than four. Their IDs are kept, so a citation in any of
them still resolves: every live row they wrote has a case in §9.4, `R1-R8` are answered in
§8.8, `J01-J12` name the journeys in §9.3, `AG`/`AL` keep their numbers in §9.7.

What none of the three could agree on was how much is enough. The first plan put a 3x2x8x4x3x3x3x2
matrix at 10,368 cells on the page and then picked 104. The answer this section takes is different:
**enough is when every way a person can get a folder in, move between folders, and read the right
side has been driven on the built app at least once, and compared against stock wherever the
behaviour is not ours.** That is about seventy rows, and they are listed.

### 9.1 The instrument, and what it turned out to reach

Everything here is driven through the Chrome DevTools Protocol against the packaged build, the same
way §8 was run. What changed since §8 is one thing, and it is the reason this plan can be complete:

```
Input.dispatchDragEvent   { type, x, y, data: { items: [], files: ['/tmp/...'], dragOperationsMask } }
```

`⭐` **A synthetic drag does carry a file path.** This document said four times that it does not, and
wrote off H-10 and five review rows on that basis. The call above delivers a real file drop to the
renderer - a folder dropped on the bar becomes a row, a folder dropped on the editor becomes a row
and moves the window. Every drop row below is therefore runnable, including the four stock surfaces
the interceptor used to shadow.

What is read, in order of preference. Never a screenshot alone:

```
the bar            .part.workspacebar .monaco-list-row  -> textContent, aria-selected
where the window is document.title, and the workspace file on disk
the tabs           .tabs-container .tab -> aria-label
how many windows   /json/list, counting type === 'page'
what a view holds  its own list rows; markers, repositories, search results all render rows
the extension host the window log: 'Extension host with pid N started' | 'exiting'
a dialog           .monaco-dialog-box .dialog-message-text
timing             performance.now() either side of the action, in the page
```

`⚠️` **Harness faults that read as findings.** Each of these cost a wrong conclusion once:

```
two un-dismissed context menus    the bar stops answering clicks; Escape between every step
the palette's '>' prefix          select-all then type eats it, and the palette becomes file search
Input.insertText                  fills the box without the list taking focus, so Enter accepts nothing
the last character                must go in as a real key event for the list to rank
macOS rename / delete             Enter and Cmd-Backspace, not F2 and Delete
`timeout`                         does not exist on macOS
a surviving instance              keeps port 9222; kill by --user-data-dir before every launch
terminals and splits              arrive in the *next* measurement, not the one that made them
out/ is not the source            transpile-client before every run, or a green suite means nothing
```

### 9.2 What has to be true, and the three ways to be wrong

Every row below fails in one of exactly three ways, and the row says which one it is watching for:

```
1  a promise is broken     something a workspace does today stopped working
2  the illusion leaks      the right side shows another folder's content, or the window moved by itself
3  a second window         one appeared that nobody asked for, or one was asked for and did not
```

A row that cannot say which of the three it would catch is not a test; it is a screenshot.

### 9.3 The twelve things a person does

The journeys from the Mac review, each one a group of rows that must all pass together. A journey
is not passed by its first row.

```
J01  bring projects into one window        H, A-1, A-6
J02  move between them while working       J-6..J-17, B-4, B-7
J03  start work in the intended directory  I, G-6, G-7
J04  keep several jobs running             P-1..P-4
J05  watch something change underneath     C-3, C-6..C-9, P-5, P-6
J06  resolve a conflict over one file      P-7, P-8
J07  find and inspect code                 E, F, G-1..G-5, G-8
J08  review and commit deliberately        D
J09  work on parallel branches             P-10..P-12
J10  run and interrupt commands            I, P-13, P-14
J11  leave and come back                   L, B-13
J12  stay usable under sustained work      M, P-15
```

`⚠️` J04, J06, J09 and most of area P are the **agent** story, and this fork hides built-in chat by
default. They are listed because the reviews listed them, and §9.6 schedules them as a tier that a
workspace release does not block on. Keeping an extension in the tree is not evidence a person can
use it.

### 9.4 The cases

**One set of IDs, and it is §8's.** The letters below are the same twelve areas the comparison suite
ran, with the same numbers, plus four areas that had no letter because nothing had asked for them
yet. Every citation in §8.5 - `D-5`, `H-9`, `B-4` - still points at the same case. New cases carry on
from the last number in their area. There is no second scheme.

```
ran  the case was driven on the built app; §8.5 or §8.8 says what it found
new  planned
  =  ours is expected to be identical to stock, and is compared against it
  ≠  ours is expected to differ, and this document says how
 [1] a promise is broken - something a workspace does today stopped working
 [2] the illusion leaks - the right side shows another folder, or the window moved by itself
 [3] a window appeared that nobody asked for, or was asked for and did not
```

#### A — the shape of the window

```
ran =  A-1   both builds hold three folders                                                   [1]
ran ≠  A-2   the explorer's roots                                                             [2]
ran ≠  A-3   the title and the command centre                                                 [2]
ran =  A-4   opening a workspace does not rewrite the file                                    [1]
ran =  A-5   a plain folder, no bar to speak of                                               [1]
ran =  A-6   a second workspace file is a second window                                       [3]
ran ≠  A-7   column zero exists
new =  A-8   Zen mode, fullscreen, side bar right, native title bar, custom title bar         [1]
new =  A-9   the bar at its narrowest and its widest: nothing clipped, nothing overlapping    [1]
```

#### B — editing the folder list

```
ran =  B-1   add                                                                              [1]
ran =  B-2   remove                                                                           [1]
ran =  B-3   add the same folder twice                                                        [1]
ran ≠  B-4   move up and down                                                                 [2]
ran =  B-5   the other entries' paths are untouched by a write                                [1]
ran =  B-6   Save Workspace As
new ≠  B-7   move through position 0.  ran in §8.8: the extension host restarts. Count it     [1]
new =  B-8   move at either end: nothing moves, nothing throws                                [1]
new =  B-9   remove with "do not ask again", then remove again: no second prompt               [1]
new =  B-10  remove the last folder: the window is empty, not broken                          [1]
new =  B-11  the .code-workspace edited by hand while open: the bar follows                   [1]
new =  B-12  a folder added to the file by another process: the bar adopts it                 [1]
new =  B-13  Save Workspace As with dirty editors, per-folder sets and the scope widened      [1]
```

#### C — explorer and files

```
ran ≠  C-1   the roots                                                                        [2]
ran ≠  C-2   what switching does to it                                                        [2]
ran =  C-3   create, rename, delete                                                           [1]
ran =  C-4   collapse and filter                                                              [1]
ran =  C-5   reveal                                                                           [1]
ran ≠  C-6   aria-level and indent: a child of nothing is announced as level 1                [2]
ran =  C-7   a file created outside, in the active folder, and in one that is not             [1]
new =  C-8   a batch of creates, renames and deletes: nothing stale, excludes honoured        [1]
new =  C-9   a .gitignore'd path is hidden by the rule, not by us                             [1]
```

#### D — source control

```
ran ≠  D-1   Changes            ran ≠ D-2  Graph          ran ≠ D-3  the status bar branch    [2]
ran ≠  D-4   a folder with no repository                                                      [1]
ran =  D-5   the Repositories view lists all                                                  [1]
ran =  D-6   a deselected repository stays deselected across a reload                         [1]
ran =  D-7   stage and commit                                                                 [1]
ran ≠  D-8   the provider entry                                                               [2]
new =  D-9   commit in one of two repositories: the other's index and branch are untouched    [1]
```

#### E — search and the pickers

```
ran ≠  E-1   Find in Files, narrowed, against `grep -rl`                                      [2]
ran =  E-2   widened equals stock                                                             [1]
ran ≠  E-3   ⌘P            ran = E-4  widened equals stock                                    [2]
ran ≠  E-5   ⌘T            ran = E-6  widened equals stock                                    [2]
ran =  E-7   include and exclude                                                              [1]
ran ≠  E-8   the scope survives a reload                                                      [2]
ran ≠  E-9   the scope toggle in the Search view's own title, both ways                       [2]
new ≠  E-10  ⌘P with a history spanning three folders, narrowed: read every row               [2]
new ≠  E-11  the `%` quick text search, both scopes                                           [2]
new ≠  E-12  a new Search Editor, both scopes                                                 [2]
new =  E-13  a folder added, then removed, while Search is open: it re-answers                [2]
```

#### F — problems

```
ran ≠  F-1   the count and the contents                                                       [2]
ran =  F-2   widened equals stock                                                             [1]
ran =  F-3   a file outside the workspace                                                     [1]
ran =  F-4   clicking one                                                                     [1]
ran =  F-5   the badge agrees with the bar                                                    [2]
ran ≠  F-6   the status bar's error count agrees with the Problems panel in both scopes       [2]
new =  F-7   a folder added, then removed, while Problems is open                             [2]
```

#### G — the surfaces that ask which folder

```
ran ≠  G-1..G-5  order, not membership: folder settings, snippets, tasks, debug, agent picker [2]
                 ⚠️ G-5 was never run - it needs a chat fixture. Stays in the agent tier
ran ≠  G-6   Create New Terminal asks, or does not                                            [2]
ran ≠  G-7   the command the question moved to                                                [2]
new ≠  G-8   the settings editor's Folder dropdown is active-first, and the extension API
             still sees the workspace's own order                                             [1]
```

#### H — one window, many folders: every way in

```
ran ≠  H-1   `code <folder>` at a window holding folders                                      [3]
ran =  H-2   `--new-window`                                                                   [3]
ran =  H-3   `code <file>`                                                                    [3]
ran =  H-4   `--add`                                                                          [3]
ran ≠  H-5   Open Recent          ran = H-6  with the modifier                                [3]
ran ≠  H-7   File > Open Folder                                                               [3]
ran ≠  H-8   the recent menu                     ⚠️ unrun in §8; superseded by H-20           [3]
ran ≠  H-9   a directory opened as a file                                                     [3]
ran ≠  H-10  a dropped folder, a dropped workspace  ⚠️ unrun in §8; superseded by H-13..H-19  [3]
new ≠  H-11  `code <folder>` at an empty window.  ran in §8.8: no untitled workspace          [3]
new =  H-12  `code <folder>` already open in this window: no second row                       [3]
new =  H-13  `code <folder>` already open in another window: that window comes forward        [3]
new =  H-14  `code <a> <b> <c>` and a file in one invocation                                  [3]
new =  H-15  a folder on a remote authority this window is not on: a second window, reachable [3]
ran ≠  H-16  a folder dropped on the bar: added, the window does not move.  ran in §8.8       [2]
ran ≠  H-17  a folder dropped on the editor area: added, and the window moves.  ran in §8.8   [2]
ran ≠  H-18  three folders dropped at once: three rows, one edit, one move, to the last       [2]
ran =  H-19  a file dropped on the editor area: a tab, no row.  ran in §8.8                   [1]
ran =  H-20  a file dropped on the explorer tree: stock's copy confirmation                   [1]
new =  H-21  a file dropped on the chat input: stock's attachment                             [1]
new =  H-22  a `.vsix` dropped on the Extensions view: stock's install                        [1]
             ⭐ H-20..H-22 are three of the four the body-capture listener used to swallow
ran ≠  H-23  a `.code-workspace` dropped on the bar, and on the editor
             ⚠️ measured as replacing this window with no prompt; the stock half is unrun     [3]
new =  H-24  a mixed drag - a file, a folder and a `.code-workspace` - in one drop            [3]
new =  H-25  File > Open Workspace from File                                                  [3]
new ≠  H-26  `+ Add Folder...`, one folder and then three: added, the window does not move    [2]
new ≠  H-27  File > Open..., two files and then two folders.  ran in §8.8 as a unit test      [1]
new =  H-28  a folder that no longer exists: the row is marked, not dropped                   [1]
new ≠  H-29  the same folder under `/tmp` and `/private/tmp`: one row, spelled as given       [2]
new =  H-30  a folder whose name collides with a row already there: both readable             [2]
```

#### I — terminal, tasks and debug

```
ran ≠  I-1   the cwd with an editor open on another folder                                    [2]
ran ≠  I-2   split, under each splitCwd mode        ⚠️ unrun in §8                            [1]
ran ≠  I-3   `${workspaceFolder}`                                                             [2]
ran =  I-4   run, split, kill, restore                                                        [1]
ran =  I-5   `terminal.integrated.cwd` per folder   ⚠️ unrun in §8; needs its own control     [1]
new =  I-6   a terminal with an explicit cwd: the explicit one wins                           [1]
new ≠  I-7   Run Task with per-folder tasks.json: which folder's task ran                     [2]
new ≠  I-8   Run and Debug with per-folder launch.json: the configuration list's order        [2]
```

#### J — dialogs, editors, and moving between folders

```
ran ≠  J-1   ⌘O with no editor open      ran = J-2  with one open                             [3]
ran ≠  J-3   Save As                                                                          [2]
ran ≠  J-4   editors are per folder                                                           [1]
ran =  J-5   reopening restores them                                                          [1]
ran ≠  J-6   click a row: the bar, the title, the explorer and the status bar all move         [2]
new =  J-7   click the row already active: nothing happens, no restore                        [2]
new ≠  J-8   Next / Previous Folder, from the palette and from the keyboard                   [2]
new =  J-9   A with two tabs -> B (empty) -> A: the tabs are back, with their split           [1]
new =  J-10  A dirty -> B -> A: the unsaved text, not just a tab with the right name          [1]
new =  J-11  an untitled editor survives the round trip by content                            [1]
ran ≠  J-12  A -> B -> C faster than the restore: C is on screen and B's slot is not A's
             ran as a unit test in §8.8; the live row is still to run                         [2]
ran ≠  J-13  rename the active folder on disk: the label changes, the tabs do not move
             ran as a unit test in §8.8; the live row is still to run                         [1]
ran ≠  J-14  open a file from another folder, widened: the window does NOT move. §3.2b        [2]
new ≠  J-15  Go to Definition into another folder: the same                                   [2]
new =  J-16  the active folder is removed: the window lands somewhere valid                   [2]
new =  J-17  Timeline, Outline and the breadcrumb bar follow the active folder                [2]
```

#### K — what extensions see (promise 1, directly)

```
ran =  K-1   `workspaceFolders` is three                                                      [1]
ran =  K-2   tasks.json's `${workspaceFolder}`                                                [1]
ran =  K-3   a language server indexes all three                                              [1]
ran =  K-4   `vscode.openFolder` still opens a window                                         [1]
ran =  K-5   `onDidChangeWorkspaceFolders`                                                    [1]
```

#### L — persistence and a clean exit

```
ran =  L-1   reopening restores                                                               [1]
ran ≠  L-2   and the active folder                                                            [2]
ran =  L-3   the file after a whole session                                                   [1]
ran ≠  L-4   the scope is remembered                                                          [2]
ran =  L-5   reload the window: the bar, the active row, the tabs                             [1]
new =  L-6   quit with unsaved content, reopen: the content, from backup                      [1]
new =  L-7   quit with terminals open, reopen: what is honestly restored                      [1]
new =  L-8   `kill -9` mid-switch with dirty content, reopen: recoverable                     [1]
new =  L-9   a new profile, first run: the bar is there and says what to do next              [1]
new =  L-10  a folder removed between sessions: its editor set is forgotten, not orphaned     [1]
new ≠  L-11  the same `.code-workspace` open in two windows, each on a different row
             ⚠️ §4.1 says WORKSPACE storage is per window. It is per workspace id, shared     [2]
```

#### M — moving between folders, measured

```
new =  M-1   a warm switch at 1, 10 and 50 resident roots: median, p95 and worst of 50        [1]
new =  M-2   a cold switch, reported separately                                               [1]
new =  M-3   10,000 markers, narrowed against widened: time per `onMarkerChanged` for the
             status bar entry and the badge together                                          [1]
new =  M-4   50 roots: `realpath` calls and wall time for one add, one show, one remove       [1]
new =  M-5   100 switches in a row: memory, listeners, orphan processes                       [1]
new =  M-6   sustained writes and terminal output during repeated switching: typing is not
             starved, and no search runs that nobody asked for                                [1]
```

#### N — keyboard, contrast and shape

```
new =  N-1   the whole of J and B by keyboard only: every action is reachable                 [1]
new =  N-2   the accessibility tree after a switch and after a rename                         [1]
new =  N-3   the 19 built-in themes: name >= 4.5, hint >= 4.5, icon >= 3.0
             ⚠️ composite the alpha onto the real background first, or 3.41 reads as 12.63    [1]
new =  N-4   a high-contrast theme, and macOS Increase Contrast                               [1]
```

#### O — the way back to stock

```
new =  O-1   the feature switched off: every modified surface compared to stock               [1]
new =  O-2   switched off, reopened, then switched on again                                   [1]
             ⚠️ NOT IMPLEMENTED. R8 was deliberately not built - "R8别做". Both stay red
             until the switch exists or ENGINEERING.md's reversibility rule is revised
```

#### P — the agent tier

```
new    P-1..P-16   the sixteen agent boundary cases (a recording worker process): same process
                   across a switch, cwd on launch, no crossed output, a membership edit never
                   implies a kill, convergence after a background batch, a dirty buffer is not
                   overwritten, worktree identity, PTY input during a switch, unexpected exit
new    P-17..P-24  the eight acceptance sessions against a real named CLI agent
                   ⚠️ Blocked: built-in chat is hidden by default in this build, so there is no
                   fixture. Keeping an extension in the tree is not evidence a person can use it
```

```
175 cases  ·  75 of them §8's, unchanged  ·  100 added, 24 of those the agent tier
```

### 9.5 What is still out of reach

```
the `%` picker's open results      the toggle flips the scope; it does not re-run what is already
                                   on screen. E-11 asserts the next query, and says so
a real agent, a real extension     built-in chat is hidden by default in this build, so area P has
                                   no fixture. Tier 3
a second machine                   H-15 needs a remote this window is not connected to
sleep / wake                       P-23; no instrument
```

Anything else that cannot be run gets a row saying **why the instrument cannot reach it**, not a row
saying it passed. A negative result is a claim about the instrument until the instrument has produced
the positive somewhere.

### 9.6 The order, and the gate

```
tier 1   the release gate     H  B  J  C  D  E  F  G  I  K  L  A      139 cases
         a person cannot do their work if any of these is red
tier 2   the polish gate      M  N                                     10 cases
         it works, and it is not unpleasant or slow
tier 3   the agent tier       P                                        24 cases
         scheduled, not blocking; needs a chat fixture and a named CLI agent first
tier 0   O                                                             2 cases
         red until R8 exists or ENGINEERING.md's rule is revised in writing
```

Run order inside tier 1 is the order above, and it is not alphabetical. **H first** - a folder that
cannot be added cannot be switched to. **B then J** - the list has to be editable before moving
around it means anything. Then the right side, area by area. **L last**, because it asserts that
everything the others did survives a restart. `A` sits at the end with `L` because the window's shape
is worth looking at once everything is in it.

`⚠️` **Each row logs its own assertions.** One action succeeding is not evidence that the session
passed - that is the mistake §8 made twice and the reviews called out three times. A session passes
when every assertion it declared passes.

`⚠️` **Before every run:** `npm run transpile-client`, then kill by `--user-data-dir`, then launch on
a fresh profile. `out/` going stale behind the source has already produced one green suite that was
measuring a build from thirteen minutes earlier.

### 9.7 What it would take to say "an ordinary person will not hit a problem"

Honestly: tier 1 green on both builds, tier 2 green, and the three open questions closed -

```
H-23      does a dropped `.code-workspace` replace this window, and is that what stock does?
L-11      two windows on one workspace file share one WORKSPACE store; §4.1 says they do not
O-1/O-2   is there a way back to stock, and does anyone need one?
```

Everything else in this document is either measured or has a row that says how to measure it. The
part no plan can cover is the one §8 kept running into: a fact that used to be about the workbench
becomes a fact about one folder, and its readers get repointed one at a time. Six of those were found
by running the suite, three more by reading it afterwards. **The row that catches the seventh is the
one nobody has written**, which is why `[stock]` is on every row where the behaviour is not ours: a
difference from stock is the only oracle that does not depend on having thought of the failure first.

### 9.8 The decisions the rows depend on

A row has no oracle until the question it asks has an answer. The code review listed eight open
decisions; this is where they stand.

```
settled
  code <folder> at an empty window     it joins that window only if the window is on something.
                                       An empty window opens a second one, as stock does. H-11
  code <folder> already open elsewhere upstream's own lookup comes first: that window is brought
                                       forward, not duplicated here. H-13
  a drop on the editor area            adds and moves. H-17
  a drop on the bar                    adds only. H-16     ⭐ the user's decision, both measured
  which surfaces keep their handler    all of them. Ours listens on the bar and nowhere else.
                                       H-20..H-22
  the debug configuration list         follows the bar - active folder first - and `activeFirst`
                                       is the one function every reader calls. I-8
  showWorkspaceFolderPick order        reordered for the person, and the extension API still sees
                                       the workspace's own order. G-8

open
  a dropped .code-workspace            H-23. Measured as replacing this window with no prompt;
                                       the [stock] half was not run
  two windows on one workspace         §4.1 says StorageScope.WORKSPACE is per window. It is per
                                       workspace id, and two windows on one file share it. L-11
                                       is the row; the fix, if it needs one, is not designed
  the way back to stock                O-1 and O-2, and R8 was deliberately not built
```

`⚠️` **Four standing rules that say what "correct" means** for the terminal and agent rows, taken
from the Mac review and not restated in each row:

```
a switch changes the view, not the process    a terminal running in A stays that process, with its
                                              cwd and its session. No cd, no cancel, no retarget -
                                              and its title must not start claiming B
a new terminal follows the active folder      but an explicit cwd, a workspace variable, or an
                                              existing session choice keeps its precedence. Read
                                              the shell's actual cwd, never the bar's label
a switch is not an isolation boundary         extensions still see every folder and may index all
                                              of them. The bar cannot promise what an agent reads.
                                              An integration has to make its own target observable
a write belongs to its own folder             something writing to A while B is shown must not put
                                              A's changes in B's Changes pane, and a dirty buffer
                                              keeps upstream's conflict handling
```

---

## 10 The run before the commit

A second pass over the plan in §9, both builds side by side - ours on port 9222, stock on 9223, each
on its own fresh profile and its own copy of the same fixtures. It is **not** the whole plan. What
was covered, what it found, and what was left is below, because a partial run reported as a full one
is worse than no run.

### 10.1 What it found

`⭐` **A folder with no repository was told something false about its workspace.** On `gamma` - no
`.git`, in a workspace where `alpha` and `beta` both have one - the Source Control view showed git's
welcome, correctly, but the welcome said *"The workspace currently open doesn't have any folders
containing Git repositories."* The workspace has two. This is ours: stock gates that sentence on
`scm.providerCount`, which counts every repository in the workspace, so stock never shows it here;
narrowing that key to the active folder brought the sentence into a state it was never written for.

Fixed without writing a new sentence, because the right one already existed and is already
translated: `%view.workbench.scm.folder%` - *"The folder currently open doesn't have a Git
repository."* The two welcomes are now told apart by the two keys that already exist:

```
scm.providerCount == 0 && scm.workspaceProviderCount == 0   ->  ...the workspace ... any folders...
scm.providerCount == 0 && scm.workspaceProviderCount != 0   ->  ...the folder currently open...
```

Measured both ways afterwards: on `gamma` beside two repositories it names the folder; in a workspace
of `gamma` and `delta`, where nothing is a repository, the workspace sentence comes back.

`⚠️` **A comment of mine was overclaiming.** `moveFolder` says it leaves "every entry exactly as the
file has it". Every entry's **value** yes - measured, the absolute paths stay absolute. The file's
**formatting** no: the whole `folders` array is written back, so entries written on one line come
back on several and a comment *inside* the array is lost. Stock loses the same comment on its own
Remove Folder - measured, same fixture, same result - so it is upstream's way of writing that array
and not something a reorder makes worse. The comment and §6 now say which of the two they mean.

`⭐` **The two-windows-on-one-workspace question is closed, and §4.1 was wrong.**
`StorageScope.WORKSPACE` is keyed by the workspace id, not by the window - the review was right about
that. But no two windows ever get the same id: opening a workspace that is already open focuses the
window that has it (measured: `--new-window` on it, window count stayed 1), and Duplicate As
Workspace makes a *new* workspace - two `workspaceStorage` directories, measured. §4.1 now says this.

### 10.2 What ran, and against what

```
                                         ours          stock         verdict
C-1 C-2  explorer roots, and a switch    1 root, L1    3 roots, L2   ≠ as designed
C-6      aria-level of a child of nothing     1             2        the level matches the indent
E-1      Find in Files, narrowed         1 in 1 file   3 in 3 files  = `grep -rl`, which finds 3
E-2      and widened                     3 in 3 files  3 in 3 files  identical
D-1      Changes, narrowed               alpha only    alpha+beta    ≠ as designed
D-4      a folder with no repository     git's welcome  n/a          ⭐ fixed above
F-1 F-6  Problems, and the status bar    beta.ts, 1 0  -             they agree, and follow the bar
J-6      click a row: every face moves   title, explorer, search, SCM, status all followed
J-14     open a file from another folder title changed, ⭐ the window did not. §3.2b
B-4 B-5  Move Folder Down                order changed, window stayed, other paths untouched
         and what it does to the file    reflowed, inner comment lost - stock does the same
L-1 L-2  reload: bar, active folder      both survived
L-4 L-5  reload: scope, tabs             both survived
L-11     two windows on one workspace    not reachable; see above
H-16     a folder dropped on the bar     added, window did not move   ⭐ the user's rule, live
H-17     a folder dropped on the editor  added, window moved          ⭐ the other half
H-19     a file dropped on the editor    a tab, no row
H-20     a file dropped on the explorer  copied in and opened - the handler R4 had taken away
H-23     a .code-workspace on the bar    replaces this window, no prompt   ⚠️ still open
```

### 10.3 What the instrument could and could not do

`⭐` **Synthetic file drags work on our build.** `Input.dispatchDragEvent` with a `files` array
delivers a real file drop; every H row above was driven that way, which is how the drop contract was
measured at last.

`⚠️` **They do not work reliably on stock.** The same call, the same Electron version, the same
`drop: Files#1` arriving at `document` - and stock acts on perhaps one drop in five. Two runs of the
same four rows gave different answers. **No drop row therefore has a stock baseline**, and the ones
above are ours-only. Anything drawn from stock's silence would be a claim about the instrument.

Three harness faults cost a wrong conclusion each before that was understood, and all three read
exactly like a product that ignores drops:

```
a modal over stock              a Copilot sign-in dialog covers the window and eats every event.
                                Ours hides chat by default, so only one side had it
an onboarding editor            stock opens on a theme picker; a drop aimed at `.part.editor`
                                landed on `onboarding-a-theme-label`
a document under the pointer    a file dropped on an OPEN editor means "insert this path as text",
                                in both builds, correctly. `dropFiles` now refuses to aim at one
```

### 10.4 What was not run

Honestly: about half of §9. Not run at all - `A-8` `A-9` (window shapes), `G` (picker order, beyond
seeing the commands exist), `I` (the terminal probe never got a shell prompt back), `K` (what
extensions see), `M` (cost), `N` (keyboard and contrast), most of `H`'s command-line rows
(`H-1..H-15`), `O` (no switch to test), `P` (no fixture). None of those is claimed as passing.

---

## 11 The second run: the rest of it

§10 covered about half the plan and said so. This is the rest, run the same way - both builds side by
side, ours on 9222 and stock on 9223, fresh profiles and identical fixtures. It found four more
defects, all of them ours, and all four are fixed below.

### 11.1 What it found

`⭐` **`code delta epsilon note.txt` opened a second window and wrote an untitled workspace.**
`code <folder>` joined the open window correctly; **two** folders did not. Inside `getPathsToOpen`,
upstream turns several folders from one command line into an untitled workspace and takes the folder
entries out of the list - and the gate that decides "these join the window that is open" ran *after*
that, by which time there were no folders left to look at. The folders were taken off one road and
never put on the other.

```
before   2 windows  ·  the new one held delta+epsilon as its own workspace  ·  1 untitled workspace file
after    1 window   ·  bar alpha beta gamma delta epsilon                   ·  0 untitled workspace files
```

The decision is one method now - `joinsTheOpenWindow` - asked at both sites, because two answers is
exactly what went wrong. `⚠️` It cannot be unit tested: `WindowsMainService` is electron-main and the
case needs a second window to exist. The evidence is the measurement above and nothing else.

`⭐` **And then the file was filed away where nobody was looking.** With the window count fixed, the
same command left `tabs: []`. The file was not lost - it had opened in `alpha`, the folder the window
was on when the command arrived, and the switch that followed captured it into alpha's editor set.
Folder requests are buffered on a scheduler in the renderer while file requests are answered at once,
so the file always won the race. `onOpenFiles` now waits for any folders arriving in the same breath.
Measured after: one window, five rows, `note.txt` on screen in `epsilon`.

`⭐` **Remove Folder had no "do not ask me again".** The plan asked for one, modelled on
`explorer.confirmDelete`, and it was never built: removing a second folder asked a second time. There
is a checkbox now, and `facade.workspaceBar.confirmRemoveFolder` behind it. `⚠️` The setting is
written only when the answer was **yes** - ticking the box and then cancelling is somebody saying
"not this one, and stop asking", and taking the second half while ignoring the first would remove the
next folder without a word. Measured: tick, remove, and the next removal happens with no dialog.

`⭐` **Zen Mode did not take the workspace bar.** Measured side by side: stock hides its activity bar,
side bar and status bar; ours hid the side bar and the status bar and left a 220px column of folders
as the loudest thing on the screen. Zen Mode means the editor and nothing else, and the bar was
exempt because `isVisible` said `WORKSPACEBAR_PART` is "always in the grid; nothing hides it". It is
the grid's answer now, and Zen hides it with the rest. `⚠️` No setting and nothing persisted: the bar
has no hide command of its own, so a remembered `hidden` would be a window with no way to get its
folders back. Measured: enter hides it, Escape twice brings it back, and the grid never once
complained that its first column had moved.

### 11.2 What ran, and what it said

```
                                              ours                      stock
H-1   code <folder>                           joins, 1 window            2 windows
H-2   --new-window                            2 windows                  2 windows          =
H-3   code <file>                             a tab                      a tab              =
H-4   --add                                   joins, 1 window            2 windows + untitled
H-11  code <folder> at an empty window        2 windows, 0 untitled      2 windows, 0 untitled  =
H-12  the folder is already in this window    nothing new                a third window
H-13  it is open in another window            that window forward        that window forward    =
H-14  two folders and a file                  ⭐ fixed above
H-5   Open Recent, a folder                   joins the list             replaces the window
G-6   Create New Terminal                     does not ask               asks which folder
I-1   the shell's real cwd, window on beta    /fx/beta                   -
      with an editor open on alpha            ⭐ the folder, not the editor
G-1   Folder Settings picker, on gamma        gamma alpha beta           alpha beta gamma
G-8   the extension API's own pick            alpha beta gamma           alpha beta gamma   =
K-1   what the extension host is offered      all three folders          all three folders  =
I-7   Run Task, on beta                       say-beta say-alpha         say-alpha say-beta
I-8   the debug configurations, on gamma      run-gamma run-alpha        alpha beta gamma
E-3   ⌘P                                      1 shared.ts                3 shared.ts
E-5   ⌘T symbols                              onlyalpha                  all three
E-10  ⌘P history across three folders         alpha.ts only              all three
E-7   Find in Files with an include pattern   no results                 no results         =
J-7   click the row already active            nothing happens
J-9   two tabs, leave, come back              both back, with the split
J-10  a dirty editor, there and back          dirty and identical
J-16  remove the folder the window is on      lands on a valid one
J-17  breadcrumbs                             gamma/gamma.ts             gamma/gamma.ts     =
D-3   the status bar                          one branch, 1 error        two, 2 errors
B-8   Move at the end                         nothing moves, no throw
B-10  remove the last folder                  empty bar, "Add a folder to get started."
L-8   kill -9 with unsaved content            beta, the bar, the tab, still dirty
M-1   27 warm switches                        median 48ms  p95 51ms  worst 57ms
M-5   heap across the run                     178MB -> 183MB
A-8   Zen Mode                                ⭐ fixed above
```

### 11.3 Two things measured that are costs, not defects

`⚠️` **A dirty editor does not leave when the window does.** Switching folders with unsaved changes on
screen leaves that editor where it is - `applyWorkingSet` will not close a dirty editor, and it
should not. So a window on `beta` can be showing `alpha.ts`, and for that moment the right side is
not one folder. The alternative is prompting to save on every switch, or discarding somebody's work.
This is the price and it is upstream's mechanism, not ours.

`⚠️` **The `%` picker still does not re-run what is on screen** when the scope is toggled under it.
The next query is answered from the new scope. Unchanged from §8.8.

### 11.4 Still not run, and why

```
P-1..P-24     the agent tier      built-in chat is hidden by default; no fixture exists
O-1 O-2       the way back        R8 was deliberately not built - "R8别做"
H-15          a remote authority  no remote this window is not already on
N-3 N-4       themes and contrast run - see §12. The two columns match in all 19; the quiet row
                                  ink and the orange swatch are open questions, not regressions
C-4 C-5 C-8   collapse, reveal, a batch of external writes
D-2 D-8       the Graph pane and the provider entry - the probe could not name their rows
L-9 L-10      a first run on a new profile, and an editor set orphaned between sessions
every drop row's stock half       the synthetic drag is unreliable on stock. §10.3
```

## 12 The 19-theme sweep

`⚠️` **This chapter measures a column that no longer exists.** It was run against the version that
marked its rows the activity bar's way - a quiet ink at rest, a bright one when live, a leading line
for both - and §13 replaced all three. The numbers stand as the record of how that version was
found wanting, and §12.6 stands on its own: every instrument fault in it is one this project will
make again. What has moved is named at the top of §13.

`N-3` and `N-4`, owed since §11.4. Every built-in colour theme, driven one at a time through a live
window, reading what the renderer computes rather than what the stylesheet says.

### 12.1 How it was run, and what it is measured against

The plan asks one question - does our ink clear its threshold. That question alone cannot be
answered usefully here, because this column takes the activity bar's colours whole: a ratio that
fails where the activity bar fails identically is a number upstream chose, and a ratio that *passes*
while the column beside us paints something else is the defect this bar has actually shipped, twice.
So the sweep asks both, and the pair is checked before any threshold is.

`⚠️` **The control is the real activity bar, in the same window, at the same instant.** It is put
back in the side position for the sweep - this build defaults it into the title bar - so both
columns are really painted, 220px of ours at x0 and 36 of it at x220. Comparing
`--vscode-facadeBar-*` against `--vscode-activityBar-*` instead would compare our registration with
itself and pass whatever the theme did.

`⚠️` **Alpha is composited before the ratio is taken.** Most of these inks are translucent -
`rgba(248, 248, 242, 0.4)` in Monokai - and measured against the surface they sit on rather than
flattened onto it, a failing 3.41 reads as 12.63.

```
themes            19/19 applied, 19 distinct           thresholds   13px row text   4.5
control           present for all 19                                the active mark 3.0
preconditions     asserted per theme, not once                      a folder glyph  3.0
```

### 12.2 The two columns paint identically, in all nineteen

| | background | quiet ink | live ink | block | mark | divider |
|---|---|---|---|---|---|---|
| 19/19 | same | same | same | same | same | same |

Nothing here is derived, weighted or branched per theme kind, and the sweep confirms nothing has
drifted: whatever a theme does to the activity bar happens to this column in the same instant.
The block is `none` in fifteen themes - `activityBar.activeBackground` is unset and the leading line
is the whole mark - and painted in Dark 2026 and Light 2026, where our row paints it too.

### 12.3 The quiet ink is an icon's ink, used for text

`⭐` This is the finding. Every number below is upstream's own, and our column is not the reason it
fails - but the **medium changed**. `activityBar.inactiveForeground` was tuned for a 16px glyph,
which is held to 3.0. We draw a folder's **name** in it, at 13px, which is held to 4.5.

```
theme                  quiet   live   button  header   mark  │  the activity bar's own
Dark Modern             4.88  12.34    4.88   12.34   3.92   │   4.88
Dark+                   3.41!  12.63   3.41!  12.63  12.63   │   3.41
Dark (Visual Studio)    3.41!  12.63   3.41!  12.63  12.63   │   3.41
Dark 2026               5.18   6.99    5.18    9.48   9.48   │   5.18
Light Modern            5.83  15.52    5.83   15.52   5.94   │   5.83
Light+                  3.56!  13.97   3.56!  13.97  13.97   │   3.56
Light (Visual Studio)   3.56!  13.97   3.56!  13.97  13.97   │   3.56
Light 2026              6.04  11.21    6.04   15.64  20.16   │   6.04
Dark High Contrast     21.00  21.00   21.00   21.00  10.55   │  21.00
Light High Contrast    14.55  14.55   14.55   14.55   8.98   │  14.55
Abyss                   3.75!  18.22   3.75!  18.22  18.22   │   3.75
Kimbie Dark             2.44!   8.38   2.44!   8.38   8.38   │   2.44!
Monokai                 3.49!  13.94   3.49!  13.94  13.94   │   3.49
Monokai Dimmed          3.36!  12.27   3.36!  12.27  12.27   │   3.36
Quiet Light             1.76!   5.20   1.76!   5.20   5.20   │   1.76!
Red                     3.17!  14.84   3.17!  14.84  14.84   │   3.17
Solarized Dark          3.30!  12.68   3.30!  12.68  12.68   │   3.30
Solarized Light         1.82!   5.84   1.82!   5.84   5.84   │   1.82!
Tomorrow Night Blue     3.75!  17.94   3.75!  17.94  17.94   │   3.75

!  under its threshold.  quiet = a row the window is not on · live = the row it is on ·
   button = ☰ and ＋ at rest · header = "WORKSPACE" · mark = the 2px leading line.
```

**The row the window is on, the header and the mark clear their thresholds in every theme** - 5.20
at worst, and the mark's worst is 3.92. **The quiet row fails 4.5 in eleven**, and in three of those
- Kimbie Dark 2.44, Solarized Light 1.82, Quiet Light 1.76 - it is under 3.0, which is the threshold
upstream holds its own activity bar to and does not meet either.

`⚠️` **Not decided here.** Three ways out, and they are not equivalent:

```
leave it     the column stays pixel-identical to the activity bar, which is the requirement
             it was built to. Eleven themes draw a quiet folder name at an icon's contrast.
name ink     rows take facadeBar.foreground and the quiet ink keeps only the glyph. Clears
             4.5 everywhere - and the column stops matching the activity bar in eleven themes.
floor it     blend the quiet ink toward the foreground until it reaches 4.5. Clears the
             threshold and keeps the pair, but the shade is then ours in eleven themes, which
             is the per-theme-kind branch this file has twice said not to write.
```

### 12.4 `charts.orange` is not an ink

`⭐` **A defect, and ours: the palette is our choice.** Five of the six swatches are inks in every
theme and paint what they promise. Orange is not one, in two different ways, and the swatch is
offered anyway.

```
Default High Contrast        charts.orange UNDEFINED → the glyph paints rgb(255,255,255)
Default High Contrast Light  charts.orange UNDEFINED → the glyph paints rgb(41,41,41)
                             ⭐ identical to a folder with no colour at all
the other 17                 charts.orange = minimapFindMatch, a find-highlight FILL:
                             rgba(234,92,0,0.33) · Abyss rgba(238,238,238,0.27)
                             · Quiet Light rgba(237,201,216,0.6)
                             → 1.17 to 2.83 on our background, and in two of them not orange
```

`chartsColors.ts` aliases red, blue and yellow to the editor's error/info/warning **inks**, and
writes green and purple as literal quartets. Orange alone is aliased to a **fill**, which is
translucent by construction and undefined wherever the minimap has no find colour.

The rest of the palette, on our background:

```
theme                  red    orange   yellow   green    blue   purple
Dark Modern            4.97    1.58!    7.69    9.74    6.85    5.87
Dark+                  3.54    1.47!    5.47    6.93    4.88    4.17
Dark (Visual Studio)   3.54    1.47!    5.47    6.93    4.88    4.17
Dark 2026              6.96    5.83     9.47    9.36    6.64    5.68
Light Modern           4.46    1.48!    2.93!   4.07    5.31    8.48
Light+                 2.95!   1.52!    4.48    3.23    2.48!   1.55!
Light (Visual Studio)  2.95!   1.52!    4.48    3.23    2.48!   1.55!
Light 2026             7.17    2.83!    5.01    4.15    5.02    8.65
Dark High Contrast     8.55     -      14.80   11.52    8.10    6.94
Light High Contrast    6.61     -       6.24    9.31    5.64    9.01
Abyss                  5.10    2.20!    7.89    9.99    7.03    6.02
Kimbie Dark            4.81    1.61!    7.44    9.42    6.63    5.67
Monokai                4.16    1.54!    6.44    8.16    5.73    4.91
Monokai Dimmed         3.43    1.46!    5.31    6.73    4.73    4.05
Quiet Light            4.07    1.17!    2.68!   3.72    4.84    7.73
Red                    4.15    1.58!    6.43    8.14    5.73    4.90
Solarized Dark         3.55    1.32!    5.49    6.96    4.89    4.19
Solarized Light        3.26    1.37!    2.15!   2.98!   3.88    6.20
Tomorrow Night Blue    5.02    1.48!    7.77    9.85    6.92    5.93
```

Orange aside, the palette is weakest in the two light `+` themes, where the theme's own inks are
tuned for text on an editor background and land on ours at 1.55 to 2.95.

`⚠️` **Upstream solved the same problem and we did not copy that part.** The terminal's tab-colour
picker - `terminalIcon.ts`, the file §4 of the plan already points at - builds its swatches from
`ansiColorMap` and keeps only the keys the **current theme actually defines**:

```ts
for (const colorKey in ansiColorMap) {
    const color = colorTheme.getColor(colorKey);
    if (color && !colorKey.toLowerCase().includes('bright')) { standardColors.push(colorKey); }
}
```

Our six are a fixed list with no such filter, which is exactly how a swatch that paints nothing came
to be offered in two themes.

### 12.5 The collapsed band takes a colour the title bar really paints

19/19. In every theme `titleBar.activeBackground` is the colour `.part.titlebar` computes, so the
strip above the header and the bar to the right of it are one surface with no seam. Six themes also
set `titleBar.border` and thirteen leave it unset, where the rule falls back to `transparent` and
draws nothing - which is what the title bar does beside it.

### 12.6 What the instrument got wrong first

Recorded because every one of these read as a finding about a theme, and four of them were believed
for a while.

```
1  workbench.colorTheme takes a theme's settingsId, not its label. "Dark (Visual Studio)" is
   `Visual Studio Dark`; "Dark High Contrast" is `Default High Contrast`. Writing the label changes
   nothing - no notification, no log line - and the row after it measures the theme before it.
   Four themes were scored twice and two were never measured. ⭐ The run now asserts that the
   theme class changed and that no two rows share one.
2  The activity bar's divider is on `.activitybar.bordered::before`, not on the part - the part
   reserves no pixel for it. Reading the part's own border-right says 0px in every theme, and our
   column, which sets it inline the way the side bar does, read as the only one with a divider in
   exactly the six themes that define the token. Six false disagreements.
3  A CSS custom property reads back as `#1e1f1c`; a computed style reads back as `rgb(30,31,28)`.
   A parser that only accepted `rgb()` failed every hex, which made five of the six folder colours
   unmeasurable and every one of the nineteen title bars a mismatch. Section 12.5 was "❌ 19/19"
   before the parser was fixed and "✅ 19/19" after, with nothing in the product changed.
4  ⭐ The window is on somebody's screen and changes under the instrument. Mid-run the bar was
   collapsed and the pointer came to rest on a row: a hovered row is painted with the live ink, and
   Monokai reported its quiet ink as differing from the activity bar's. It was a mouse position.
   Preconditions - expanded, one active row, a control with items, nothing hovered - are now
   asserted before every single reading, not once at the start.
5  A control that is not on screen is not a result. One run lost the activity bar for nine straight
   themes and reported nine disagreements. A missing control is now NOT MEASURED, which is neither
   a pass nor a fail.
6  Probing a colour class by appending it to an element that already had one measures stylesheet
   source order, not the colour. Every swatch declared before `blue` read back as blue, which looked
   exactly like five colours that do nothing. The classes are stripped before each is applied.
```


## 13 What the column is now

§12 measured the column as it was, and the answer it gave - eleven themes drawing a folder's name at
an icon's contrast - is what started this. What follows replaced it, one question at a time, each
answered by looking rather than by reasoning about tokens.

### 13.1 One ink, and it is the activity bar's live one

```
was   facadeBar.inactiveForeground at rest, facadeBar.foreground when live
now   facadeBar.foreground in every state, for the rows and for the empty line
```

`⚠️` **Two wrong answers were tried first, and both are worth keeping written down.**

The quiet ink went because it is tuned for a 16px glyph, held to 3.0, and a folder's **name** is
13px text held to 4.5 - §12.3 measured it missing in eleven of nineteen, down to 1.76.

The first replacement was the **explorer's** ink, on the reasoning that a list of names should read
like the list of names beside it. Light+ and Light (Visual Studio) put `activityBar.background` at
`#2c2c2c` and `sideBar.background` at `#f3f3f3` - the only two built-ins on opposite sides of their
own theme - so the side bar's ink on this surface is dark on dark. Adopting a surface means adopting
its ink; half of each pair is a ratio nobody chose.

### 13.2 The row says which one it is with a chip, not with ink

The modern activity bar's, which is `modernTab.*` underneath - the fill a **selected editor tab**
gets, and so the window's one "this is the selected thing" colour rather than one panel's.

```
marked   modernActivityBarItem.activeBackground     rgba(255,255,255,0.13) in Dark Modern
hovered  modernActivityBarItem.hoverBackground      rgba(255,255,255,0.07)
rest     nothing
high contrast   no fill at all - a solid outline for marked, dashed for hovered,
                which is what `activityBar.css` does for the same state
```

`⚠️` Most themes write these as a **lightening of whatever is underneath** rather than as a colour,
which is why they carry onto this surface: the chip is always one step brighter than the column it
is on. `list.*` cannot do that. `list.hoverBackground` is tuned to be a small step from
`sideBar.background`, and measured on this column in Light+ the ink on it came out at **1.23**; the
inactive-selection band at **1.24**. Four more themes define them with an alpha, so the same state
showed a different shade here than in the explorer, eight pixels away.

`⚠️` These four tokens are registered unconditionally, so none of this needs the Modern UI
experiment turned on. Measured with it off.

```
theme                  marked chip                 ink   hover chip                  ink
Dark Modern            rgba(255,255,255,0.13)     8.39   rgba(255,255,255,0.07)    10.22
Dark+                  rgb(30,30,30)             16.67   rgba(30,30,30,0.4)        14.24
Light Modern           rgb(228,230,241)          13.26   rgb(242,242,242)          14.72
Light+                 rgba(228,230,241,0.13)     9.70   rgba(232,232,232,0.13)     9.67
Dark High Contrast     outline                   21.00   outline (dashed)          21.00
Abyss                  rgb(8,40,107)             13.76   rgba(8,40,107,0.53)       15.94
Kimbie Dark            rgb(100,83,66)             3.59!  rgba(124,80,33,0.4)        6.07
Monokai                rgb(65,67,57)              9.44   rgb(62,61,50)             10.27
Quiet Light            rgb(211,219,205)           4.26!  rgb(224,224,224)           4.59
Solarized Light        rgb(223,202,136)           5.22   rgba(223,202,136,0.27)     5.66
Tomorrow Night Blue    rgba(255,255,255,0.25)     8.12   rgba(255,255,255,0.19)    10.10

one ink across all three states: 19 of 19.  under 4.5: Kimbie Dark and Quiet Light.
```

The two short ones are the price of one ink. Taking the chip's own foreground buys them back and
costs a name that changes colour as a row becomes the marked one, which is visible in every theme
where the two inks differ. A ratio that is short in two themes is a number; a name that changes
colour is a behaviour.

### 13.3 One line, and it belongs to the folder the window is on

The leading 2px line marked the keyboard's row as well, on the reasoning that the activity bar draws
one indicator for both. In a list you can arrow through, that is **two lines on screen whenever the
cursor is not on the current folder**, which is most of the time - a right-click put one there, and
so did Move Folder Up. Two lines is two answers to "which folder am I in".

The keyboard's row takes the hover chip instead, scoped to `.monaco-list:focus`: a list keeps
`focused` on the last row it put the cursor on whether the keyboard is near it or not, which is how
a context menu opened over one row while a line appeared beside another.

### 13.4 The six folder colours became ten, and they are ours

`⭐` **`charts.orange` is not an ink**, and §12.4 has the measurement. Five of the six were aliases
of editor inks and two were literals; orange alone aliased `minimapFindMatch`, a find-highlight
**fill** - translucent by construction and undefined in both high-contrast themes, where picking it
gave the same folder as picking nothing.

```
red #DD443F   orange #C26016   yellow #9A760A   lime #618720    green  #2C8C46
teal #208986  blue   #277CDC   indigo #7B6CD8   purple #A15FC7  pink   #CA4A9B
```

`⚠️` **Ten hues, evenly spaced.** The four that came after sit in the gaps the first six left -
yellow to green, green to blue, blue to purple, purple back to red - so no tag is a shade of
another. Pink exists because these are ours; `charts` has none to point at.

`⚠️` **One value each, no per-theme-kind branch**, and that is a decision rather than an oversight. A
tag is not a surface: no theme has an opinion about what colour somebody's tag for `~/work/api`
should be, so there is nothing to inherit. Each lightness is the one whose worst case across every
surface the glyph can land on - nineteen backgrounds and the two marked-row chips - is as high as a
single value can make it: **2.90**. It cannot reach 3.0, because those surfaces fall in two clusters
with a gap and one value would have to be at once brighter than L=0.2068 and darker than L=0.1908.

`⚠️` **A tag on the marked row is still hard to see** - 1.16 to 2.94 across the themes, because the
chip moves the background toward the mid-tone the tags sit in. Three ways out were measured and all
three trade something: a weaker chip (the tag survives, the mark stops reading), the chip in the
folder's own colour (the conflict disappears, the six need a second darker value), or leaving it.
Left, knowingly.

### 13.5 Ten glyphs, chosen against three rules

```
folder rocket beaker server database globe device-mobile book tools package
```

Out of the 652 the icon font has, and the three rules are why that number is not larger: it has to
survive 16px, which takes out everything drawn in thin strokes or many of them; it has to be
distinct from the other nine at a glance, which takes out the second and third square box; and it
has to say what a folder **is** rather than what it is **doing** - a bug, a check, a play arrow are
states, and a state that never changes is a lie.

`folder` is first and is stored as nothing at all, so a folder nobody has customised and one set back
to a plain folder are the same record rather than two.

`⚠️` The dialog is **460px** because the widest row says so: eleven 20px swatches with 8px between
them need 300, ten 28px icon boxes need 352. At 380 the swatches wrapped and the icons finished 7px
from the edge.

`⚠️` **`set` dropped the glyph**, and the bug shipped: it kept its fields one named line at a time,
so a field added to the type and to the dialog was accepted by the type checker and lost on the way
to storage. The dialog offered it, the renderer was ready to draw it, and Save did nothing that could
be seen. There is a test for it now, and the test was watched to fail with the bug put back.

### 13.6 The default workspace

A window asked for nothing at all opens one fixed workspace instead of coming up empty.

```
where      <userData>/User/Default.code-workspace, created on first use with { "folders": [] }
when       windowsMainService, the arm before "open an empty window":
           no files, not --new-window, no window opened yet, no remote authority
also       File > Open Default Workspace, which opens the same file
```

`⚠️` **Every other way in is untouched**, and that is the whole design. A folder, a workspace, a
file, anything restored from hot exit - all of them have already left `usedWindows` non-empty by the
time this arm is reached, so it cannot take a window somebody asked for. Measured on four fresh
profiles:

```
code                  Default (Workspace) opened, the file created
code <folder>         the folder, file untouched
code --new-window     an empty window, file untouched
code <file>           the file, file untouched
```

`⚠️` **`window.restoreWindows` still wins**, and it defaults to `all` - so on a machine with a
session to restore this arm is not reached. It fills the blank window and nothing else; the menu item
is the way back to the default workspace at any other time.

`⚠️` **A `vscode-userdata:` URI created the file and then declined to open it.** `resolveLocalWorkspace`
opens with `if (uri.scheme !== Schemas.file) { return undefined; }` and says nothing - no
notification, no log line. The path is built from `userDataPath`, a path on disk, and there is a test
that asserts the scheme.

### 13.7 What the review found

`⚠️` Run after everything above was working, which is the point: none of it was caught by the thing
being built.

```
a colour that painted nothing    facadeBar.activeBackground stayed registered after the chip
                                 replaced it - a colour in the theme picker that does nothing
a timer nobody could cancel      setTimeout(() => nameBox.focus()) in the dialog, which focuses a
                                 detached input if the dialog closes inside that tick
⭐ no tests at all               the `set` bug above was found by a person using it, not by a test.
                                 13 now, and both bugs were put back to watch them fail
42 lines hygiene refused         comment continuations indented with spaces to hang under `/*`
```

```
tsc · valid-layers · stylelint · eslint · gulp hygiene (12040 files)   clean
./scripts/test.sh                                 36998 passing · 0 failing · 470 pending
```
