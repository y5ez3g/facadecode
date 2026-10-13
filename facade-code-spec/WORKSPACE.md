# The workspace

What Facade Code does to VS Code's workspace, and why. There is no new layer above it and no second
list beside it: `folders[]` is the product. Worktrees are in [`WORKTREE.md`](./WORKTREE.md).

---

## 1 The idea

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

**Left**: the workspace bar, listing the workspace's folders - the list that until now lived only in
a JSON file. **Right**: a complete VS Code opened on one of them. Click another row and the right side
is a complete VS Code on that one, in tens of milliseconds, with nothing torn down.

```
promise 1   nothing a workspace does today stops working                        §4
promise 2   the right side reads as one folder, and switching is cheap enough
            to do without thinking                                               §5

⭐ ONE WINDOW, MANY FOLDERS. A second window is something a person asks for in as many words -
   "in New Window", or a window they opened themselves. It is never what they get for saying
   "I want to work on this too".                                                 §3.7
```

---

## 2 What we build on

### 2.1 The workspace, as VS Code has it

```
IWorkspace = { id, folders[], configuration, transient }

folders[] IS the file      `setFolders()` writes it back through IJSONEditingService
id = md5(config path)      editing folders keeps it, so StorageScope.WORKSPACE survives an edit;
                           Save As changes it, and `enterWorkspace` migrates the storage
three states               EMPTY · FOLDER (one folder, no file) · WORKSPACE (a file, 0..N folders)
the one transition         a FOLDER window asked to hold a second folder writes an untitled
                           .code-workspace and enters it in place: one extension-host restart,
                           no window reload
views                      pure functions of folders[], rebuilt on onDidChangeWorkspaceFolders
```

### 2.2 Three layers

```
layer 1   drawn by the workbench: explorer, search, SCM, problems, title, editors, terminal
          ours to narrow, view by view
layer 2   the extension host: all folders or none
layer 3   what extensions spawn - tsserver, gopls, jdt.ls - reached only through layer 2
```

Narrowing layer 1 is enough: layer 2 has no screen of its own, and everything it produces lands in a
view layer 1 draws.

### 2.3 Why extend it rather than replace it

`getWorkspace().folders` is read at 174 places in `src/vs`, `onDidChangeWorkspaceFolders` at 71,
`getWorkspaceFolder()` at 113, and 136 user-visible strings say "Workspace". A private list would
have had to re-earn every read, and a third meaning of the word is microsoft/vscode#77718 twice over.
Multi-root's standing complaint is that it flattens the explorer into every root at once; showing one
folder at a time is the fix for that complaint, not a new invention.

---

## 3 Design

### 3.1 The bar is a view of `folders[]`

`WorkspaceBarModel` stores nothing: `folders` reads the workspace, `add` and `remove` call
`IWorkspaceEditingService`, and it follows `onDidChangeWorkspaceFolders`, so an edit made anywhere -
the bar, an extension, the file by hand - redraws it.

```
de-duplicated within a batch   upstream checks what is there once, before its loop, so one call
                               carrying a folder twice writes it twice
one folder, one row            `/tmp/x` and `/private/tmp/x`, and case on a case-insensitive disk,
                               are one folder: the model resolves every spelling to the same row
unavailable is marked          a folder that cannot be reached is dimmed and struck through, never
                               hidden - the row is the only place to remove it from
```

### 3.2 `IActiveFolderService`

`services/activeFolder/`

```ts
readonly activeFolder: IWorkspaceFolder | undefined;
readonly onWillChangeActiveFolder: Event<IActiveFolderWillChangeEvent>;   // with join()
readonly onDidChangeActiveFolder: Event<void>;
setActiveFolder(folder: IWorkspaceFolder | URI): Promise<void>;
activeFolderFor(scheme?: string, authority?: string): IWorkspaceFolder | undefined;
```

- Kept in `StorageScope.WORKSPACE`, seeded from `getLastActiveWorkspaceRoot()` the first time.
- `onWillChangeActiveFolder` fires only for a deliberate move; joiners put things away (the editor
  working set). When the active folder leaves the workspace the service moves to its neighbour without
  announcing it: there is nothing to put away for a folder that is gone.
- `onDidChangeActiveFolder` also fires when the active folder is renamed in the file, and not when the
  list reorders around it. Anything that draws the folder's name listens here and nowhere else.
- `activeFolderFor` keeps upstream's walk to the first folder of a matching scheme and authority: a
  workspace can hold a local folder and a remote one, and a caller asking for a local path cannot be
  handed the remote one.

The name is upstream's own question. `getLastActiveWorkspaceRoot()` had 15 call sites that guessed -
terminal 10, file dialogs 2, search 2, debug 1 - each naming its local `activeWorkspaceRootUri`. They
ask this service now.

### 3.3 The bar decides, and the editor never does

```
⭐ The active folder is set by the bar and by nothing else. Opening a file that belongs to another
   folder does not move it.
```

```
                      the editor decides              the bar decides  (chosen)
terminal cwd          the file's folder               the bar's folder
Go to File, search    the file's folder               the bar's folder
the cost              opening one file puts away      the window can hold an editor from
                      every tab of the folder you     outside the active folder
                      were in and restores another
```

With a working set per folder, letting the editor move the active folder makes one cross-folder open
cost a full switch. The state this choice tolerates is rare and deliberate - Go to Definition across
folders, Open Recent, a drop. It follows that the bar is never a display: anything that moves the
active folder without somebody choosing a row breaks this rule. Upstream's `getLastActiveWorkspaceRoot`
walks the editor history, so this is a change from stock: a terminal opened while editing `alpha/foo.py`
with the bar on `gin` opens in `gin`.

### 3.4 Layer 1, surface by surface

```
explorer          the active folder only, with no root row above it - the shape a single-folder
                  window has
title bar         ${rootName}, the command center and the explorer header name the active folder;
                  ${workspaceName} is new and keeps the workspace's own name reachable
editors           a working set per folder, stored on the way out and restored on the way in
                  (`WorkspaceBarEditors`), dropped when the folder leaves the workspace
terminals         one in the editor area belongs to the folder it was opened in: leaving the folder
                  puts it away, coming back shows the same shell, and it survives a reload
                  (`IFolderTerminalsService`, `facade.terminal.followFolder`, on by default). Off,
                  it is the window's and stays on screen, out of the editor area only while a
                  switch keeps one folder's editors and puts up the next's, which would close it
                  or open it twice. A terminal in the panel belongs to the window, but one Facade
                  opened for a folder - an agent's - is that folder's wherever it is, and ends with it
new terminal,     ask `IActiveFolderService` (§3.2). Create New Terminal no longer asks which folder;
dialogs, debug    Create New Terminal in Another Folder... is where that question went
source control    the Changes pane lists the active folder's repositories (`visibleRepositories`);
                  the Graph and the status bar follow it (`activeRepository` puts the active folder
                  ahead of the editor). What is remembered is what the person chose, never what is on
                  screen - saving the narrowed list would deselect every other folder's repository for
                  good. A folder without a repository says so
search, Go to     one scope for all three, `IFolderScopeService` (`services/folderScope`): folder or
File, Go to       workspace, kept per workspace, toggled in the search view's title and on both
Symbol            pickers. ⌘T is narrowed where its results land, since its providers are in layer 2.
                  A resource in none of the folders is always covered. A hidden search view defers
                  its re-run until it is shown
problems          filtered where they land, never at `IMarkerService`; the count follows the scope.
                  Markers are stored by resource, so this partitions rather than discards
pickers           "which folder?" is a workspace-level question: every folder is listed and the active
                  one is first (`foldersWithActiveFirst`, `activeFirst`) - debug configurations, snippets, the settings
                  editor's folder tab, tasks, the agent folder picker, `_workbench.pickWorkspaceFolder`,
                  and `showWorkspaceFolderPick` (whose API caller still sees the workspace's order).
                  Repository choosers list every repository for the same reason
```

### 3.5 Layer 2 is untouched

`getWorkspaceData()` is unchanged: extensions see every folder, `workspaceContains:` fires for all of
them, language servers index all of them. That is what makes the list a real workspace, why a switch
costs milliseconds rather than a rebuilt project graph, and it is parity with stock multi-root.

### 3.6 Rules

```
⚠️ Nothing hands a narrowed folder list to the write path. `doUpdateFolders` is read-modify-write over
   `getWorkspace().folders`; a narrowed list there means one Add Folder deletes the other N-1.
⚠️ Nothing of ours goes into the .code-workspace file. The active folder, working sets, parked
   terminals and bookkeeping live in StorageScope.WORKSPACE; a `facade.*` key in the file makes stock
   VS Code report an unknown setting.

a switch changes the view, not the process    a terminal running in A keeps its process, cwd and title
a new terminal follows the active folder      but an explicit cwd, a variable or a session choice wins
a switch is not an isolation boundary         extensions still see every folder; the bar cannot promise
                                              what an agent reads
a write belongs to its own folder             changes made in A while B is shown stay in A's Changes
```

### 3.7 One window, many folders: how a folder arrives

The seam is `IWorkspaceBarService.show(uri)`: put the folder in the workspace if it is not there, then
move the window onto it. Through the bar because the bar knows two spellings of one folder are one row.
`openOrShow` serves callers that offer "a folder or a workspace or a file".

```
File > Open Folder, Open Recent, the recent       added and shown
  folders menu, the welcome page, "Open Folder"
  on a directory opened as a file
code <folder>                                     added and shown, decided in the main process -
                                                  but into an empty window, a new window as stock;
                                                  a folder another window already has, that window
                                                  brought forward; a folder on another remote
                                                  authority, a window that can reach it
several folders at once                           one add, then one switch
git clone and git init                            "Add to Workspace" offered first; openAfterClone
                                                  `always` adds to a window that holds folders
a folder dropped on the bar                       added; the window stays
a folder dropped on the editor area               added and shown
a .code-workspace dropped or passed               its folders added; the file is read, never entered
a file dropped                                    opened in the editor

stays a window     --new-window, "in New Window", the modifier in Open Recent, New Window,
                   Duplicate Workspace, Open Workspace from File, and `vscode.openFolder` from an
                   extension - asked for in as many words, or a contract with someone else's code
```

### 3.8 The list

```
reorder         Move Folder Up / Down (Alt+Up / Alt+Down). `reorderFolders`, queued behind every
                other workspace edit, with each entry's stored form kept byte for byte. No drag.
                Moving a folder through the first position restarts the extension host - upstream's
                relauncher watches folders[0] for the deprecated `workspace.rootPath`
remove          asked first only where it stops something: an agent, or a process in one of the
                folder's terminals that VS Code would ask about before terminating it
                (`hasChildProcesses`, and `terminal.integrated.confirmOnKill` for where that
                terminal is). The question names the path, says how many agents it stops and that
                the processes will be terminated; anything else is removed unasked, an unsaved
                editor staying open. A setting, not a "do not ask again":
                `facade.workspaceBar.confirmRemoveFolder` off never asks. Every way in behaves the
                same - the bar's row, Workspaces: Remove Folder from Workspace... and the
                Explorer's Remove Folder from Workspace, one folder or several - as each stops the
                folder's agents and closes the editors kept for it
                The window moves to the row that took the index; the folder's editors go with it,
                its name and colour stay (they are the folder's, kept per profile)
customize       a display name, one of ten colours and one of ten glyphs (§7), per profile
rename          editing a folder's name in the file renames its row, the title and the header
the default     a window asked for nothing opens <userData>/User/Default.code-workspace, created as
workspace       `{ "folders": [] }` on first use, instead of an empty window. Only in the arm that
                would open an empty window, so it never takes a window somebody asked for;
                `window.restoreWindows` still wins. File > Open Default Workspace opens it any time.
                ⚠️ The path is a file: URI - `resolveLocalWorkspace` silently declines any other scheme
Zen Mode        hides the bar with the rest; the bar has no hide command and nothing is persisted
```

---

## 4 Every workspace feature, before and after

Enumerated rather than remembered: every command id in `src/vs` naming workspace, root folder, open or
close folder, add or remove folder, recent or new window (82); the `workspace` namespace of `vscode.d.ts`;
settings naming workspace or folder; the File menu and the explorer's context menu; activation events,
variables and the CLI. Then every call site of `IHostService.openWindow`, asking whether a second window
is what the person asked for.

### 4.1 What changed

```
the explorer                 every root -> the active folder, no root row
title, command center,       the workspace's name -> the active folder's; ${workspaceName} added
  explorer header
editors                      one set -> a set per folder
terminal cwd                 the last editor's folder -> the active folder
terminals in the editor      the window's -> the folder's (§3.4)
source control               every repository -> the active folder's
search, Go to File, ⌘T       every folder -> the active folder, widenable
problems                     every folder's -> the active folder's, widenable
"which folder?" pickers      the workspace's order -> the active folder first
Create New Terminal          asks which folder -> uses the bar's; "in Another Folder..." asks
dropping a folder            a new window, or the workspace replaced -> added (§3.7)
dropping a .code-workspace   the window leaves its workspace -> its folders added
Open Folder, Open Recent,    a second window, or this one replaced -> added and shown (§3.7)
  code <folder>, clone
Zen Mode                     also hides the workspace bar
```

### 4.2 What did not, deliberately

Opening and closing folders and workspaces · Add Folder and Remove Folder in the explorer · edits to the
list through the API or the file by hand · the FOLDER-to-WORKSPACE transition · Save Workspace As ·
workspace and folder settings · per-folder `tasks.json`, `launch.json`, `mcp.json` · `${workspaceFolder}`
and friends · recommendations · enable or disable for this workspace · trust (one verdict per window) ·
storage, hot exit, recently opened, profiles · the whole `workspace` extension API, including
`workspace.workspaceFolders` (every folder) and `workspaceContains:` · Find in Folder · timeline, outline,
breadcrumbs.

`explorer.expandSingleFolderWorkspaces` no longer applies, correctly: it expands a root row, and a
window narrowed to one folder has none.

### 4.3 What cannot be narrowed, and is parity

```
showWorkspaceFolderPick results, any tree an extension draws    an extension's own UI
_workbench.pickWorkspaceFolder                                  ordered, not narrowed (§3.4)
workspace trust                                                 one verdict per window
workspaceContains: activation                                   all or nothing, by design
```

### 4.4 The receipt

A `.code-workspace` written by the bar, opened in stock VS Code, has every folder and no warnings.
That is promise 1 as one test: if the file is ordinary, everything that reads an ordinary workspace
still works. Verified against VS Code 1.137.0.

---

## 5 Performance

```
rejected    the first design kept the list private and swapped one folder in and out of
            folders[] on each switch: a folder swapped back rebuilt its project graph every
            time (19237 / 18688 ms, against 1750 ms resident), and changing folders[0]
            restarted the extension host on every switch (~1s, whatever the folder's size)

cold start  folder count costs nothing in time: 1 folder and 8 finish every milestone inside
            each other's spread. Memory is the language servers the folders activate: 7 folders
            against 1 is +100..190MB; one Java folder nobody opened is +1.2GB and +15s of CPU,
            because workspaceContains: starts jdt.ls. The renderer never degrades: p50 1ms,
            p99 20-40ms on its main thread through the whole warm-up
a switch    49-86ms across six switches, 0 extension-host restarts; the `exists` check 1-4ms,
            the editor working set 0-6ms. The rest is redrawing
```

```
chose      every folder resident: a switch in 50ms instead of 19s, for the memory a stock
           multi-root workspace costs anyway
did not    withhold a folder from layer 2 until it is needed. It would save jdt.ls's 1.2GB, but
           extensions would see a list the workbench does not have and ${workspaceFolder}
           would drift from it: promise 1 broken to serve promise 2, which is not under threat
```

---

## 6 The window

```
the grid       the workspace bar is the middle row's column 0, between the title bar and the status
               bar. Upstream's grid otherwise: the root is title / banner / middle row / status,
               and `adjustPartPositions`' `[2, 0]` is `[2, MIDDLE_FIRST_COLUMN]` (= 1) - at 0 the
               auxiliary bar lands left of the workspace bar. `verifyWorkspaceBarIsFirstInMiddleRow`
               logs if the shape ever differs
widths         220 open (the minimum), 480 at most, 36 collapsed with both constraints pinned to it.
               Collapsed by default; the choice and the open width are kept per profile
the toggle     the title bar's first button (`TitleBarLeftMenu`, main window only): in a 36px cell at
               the window's left edge on Windows and Linux, `File` starting at x=36 where the
               collapsed column ends; after the traffic lights on macOS (70 + 8), at the edge in full
               screen. Glyph ☰ (`menu`), the pattern of a navigation pane that folds to a column of
               icons (WinUI's NavigationView, Outlook, Gmail). The tooltip says what a click does.
               Not shown in Zen Mode. The main window's title bar is never "empty" (it holds the
               toggle), so `shouldShowCustomTitleBar` keeps it; `customTitleBarVisibility` `never`
               and `windowed` still remove it, and then the command palette is the way
the menu bar   its overflow button is `···` in every state, drawn as the row's other icon buttons
               (22x22, radius 6). Upstream swaps it to ☰ when no menu fits; ☰ is the toggle's now
               (`workspacebartoggle.css`, overriding `menubar.css`)
the header     28px, one row of the list, open and collapsed: `WORKSPACE` at x=10 on the icons'
               line, and `+` (Open Folder...) at the right. Collapsed, the `+` alone. The column is
               one 28px grid from its top, level with a compact activity bar beside it
dragging       the command center's margin is 40 on each side, so the window can be moved by the
               title bar however full the row is (not in full screen, not in a browser)
the splash     draws the title bar and status bar across the window and the bar between them
the app icon   `facade.titleBar.showAppIcon`, off: that corner is the toggle's
```

---

## 7 The column's look

Every distance, radius and size in `workspacebarpart.css` is a registered token, except the header's
height, which is `ROW_HEIGHT`. Colours are registered as `facadeBar.*`: upstream owns `workspaceBar.*`
tomorrow if it wants it.

### 7.1 One ink

Names, folder icons and the empty line use `facadeBar.foreground` - the activity bar's live ink - in
every state. The surface is the activity bar's background, and a theme picks that pair together; the
side bar's ink was tried and is dark on dark in themes whose activity bar is dark and side bar light.
The quiet ink is tuned for 16px glyphs (3.0) and missed 4.5 on 13px names in eleven of nineteen themes.

### 7.2 Which row is which

```
the folder the window is on   modernActivityBarItem.activeBackground, plus a 2px line down the
                              leading edge in facadeBar.activeBorder. One line in the column, ever
hovered                       modernActivityBarItem.hoverBackground - the same chip, lighter
the keyboard's row            the hover chip, only while the list has focus and the keyboard moved
                              last - never a second line
high contrast                 no fill: a solid outline for the marked row, dashed for hover and
                              keyboard, as activityBar.css does
```

The chip tokens are registered whether or not Modern UI is on, and most themes write them as a
lightening of what is underneath, so the chip is always a step brighter than the column. The ink does
not change on the chip: Kimbie Dark (3.59) and Quiet Light (4.26) fall short of 4.5 on the marked row,
the price of one ink rather than a name that changes colour as it is marked.

### 7.3 Buttons

The header's `+` and a row's `+`, one column: a 24px box, 16px glyph, `facadeBar.inactiveForeground`,
and on hover the ink only, no chip - the activity bar's gesture. A repository's triangle is not a
button: it takes its icon's slot (WORKTREE.md WT-1.13). The `+` is nudged half a pixel right
and down: the codicon's cross is not centred in its square (measured at 125%: centre 17 in a column
centred on 18). Everything in a row that changes takes `--facade-motion`, 150ms standard easing, 0 with
reduced motion.

### 7.4 Folder colours

Ten, ours, one value each - a tag is not a surface and does not follow the theme:

```
red #DD443F   orange #C26016   yellow #9A760A   lime #618720    green  #2C8C46
teal #208986  blue   #277CDC   indigo #7B6CD8   purple #A15FC7  pink   #CA4A9B
```

Evenly spaced hues. `charts.*` was used first and was wrong: `charts.orange` aliases
`minimapFindMatch`, a translucent find fill (1.17-2.83 on this column) that high contrast leaves
undefined, so picking orange there painted nothing. Each lightness maximises the worst case across the
nineteen backgrounds and the marked chip: 2.90. It cannot reach 3.0 - the surfaces fall in two
clusters, and one value would have to be brighter than L=0.2068 (Monokai Dimmed) and darker than
L=0.1908 (Light 2026's marked row). On the marked chip the worst is 1.73 (Kimbie Dark), left
knowingly. The colour paints the glyph only, never the name or the row.

### 7.5 Glyphs

```
folder rocket beaker server database globe device-mobile book tools package
```

Each survives 16px, is distinct from the other nine at a glance, and says what a folder is rather than
what it is doing. `folder` is stored as nothing, so an uncustomised folder and one set back to `folder`
are the same record. A worktree's glyph is a dot (WORKTREE.md WT-1.12).

---

## 8 Tests

### 8.1 Unit

```
services/activeFolder/test/              where a window starts, what outranks what, joiners,
                                         removal by index, rename versus reorder
test/browser/parts/workspacebar/         the model (rows are folders[], batch de-duplication,
                                         spellings, unavailable folders), drops, reading a
                                         .code-workspace, editor working sets, customization,
                                         git grouping, the grid shape, the title bar keeping
                                         the toggle
services/folderScope/test/               what a scope covers, announces and remembers
contrib/scm/test/                        what SCM shows and what it remembers
contrib/files/test/                      the roots the explorer shows
```

A test is watched to fail with its bug put back; one that passes against broken code is worse than none.

### 8.2 In a running window

Unit tests do not settle a surface; seeing it does. After a change, two checks catch most of what is
wrong: **switch folders and read the surface again**, and **read it with no editor open**. For
promise 1 the method is side by side: stock VS Code and this build, the same action on the same
workspace, and every difference accounted for - a difference from stock is the only oracle that does
not depend on having thought of the failure first.

### 8.3 Gates

```
tsc -p src/tsconfig.json · valid-layers-check · stylelint · eslint · gulp hygiene
./scripts/test.sh --grep "Workspace bar|Active folder|Files - the roots"
no literal colours in parts/workspacebar/
```

### 8.4 Instrument traps

Each of these produced a wrong answer before it was known:

```
out/ behind the source      transpile, kill by --user-data-dir, fresh profile, every run
two windows open            a CDP driver must refuse to guess which one it is reading
.click()                    does not drive a VS Code list or action bar: real mouse events
a virtualised list          has DOM for visible rows only; scroll with real wheel events
an HTML5 drag               CDP's dispatchDragEvent needs several dragOver events before the
                            overlay is up; on macOS CDP cannot drive one at all
an OS-level drag            needs the window in front, or the first mouse-down only activates it
drag regions                are decided by the window manager: ask Windows (WM_NCHITTEST), or
                            drag for real - a synthesised event proves nothing
contrast                    composite alpha onto the real background first
themes                      workbench.colorTheme takes a settingsId, not a label, and the switch
                            must be asserted
a negative result           needs a control that produced the positive somewhere
a language server           starts from an open file, not from the workspace
the pointer                 a hovered row is painted differently: park it before measuring
```

---

## 9 Known limits and open questions

```
no way back to stock        ENGINEERING.md asks for a switch that restores stock behaviour; the
                            workspace bar has none, deliberately not built. Open
the grid coordinate         [2, MIDDLE_FIRST_COLUMN] is measured in a window, not unit-tested:
                            it needs a running workbench
the menu bar's glyph        the `···` override wins over upstream's `menubar.css` by specificity;
                            check it on every upstream merge
the `+` nudge               corrects the default codicon font; a product icon theme with a
                            centred `add` gets it half a pixel off
tag contrast                2.90 at best on the column, 1.73 on Kimbie Dark's marked row (§7.4)
not run                     remote workspaces (activeFolderFor's scheme fallback), ⌘T beyond
                            TypeScript, per-folder notebook kernels, editSessions, macOS for §6
merging two workspaces      parked: a .code-workspace is more than folders, and its settings,
                            launch and tasks cannot be merged. If it returns, it is "add its
                            folders to this window", said in those words
```
