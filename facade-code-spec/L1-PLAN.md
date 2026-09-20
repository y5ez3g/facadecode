# L1 plan — steps 0 to 4

Baseline is the `vendor/1.138.0` root commit. Every step stands on its own: it can be built, checked and
reverted by itself. Each lands on `feature/<n>-<name>`, gets reviewed, then merges into
`main` with `--no-ff`.

Suggested order: **0 → 1 → 2 → 4 → 3.** Performance measures cleanest right after step 2,
while the change surface is still small; step 3 then adds work to the switch path.

```
0  identity        drop Copilot, new icon, rename to Facade Code
1  top bar         the activity bar can live in the title bar, and does by default
2  workspace bar   the project and worktree rail
3  per-tab shells  terminals and agent CLIs that follow the project
4  switching       make moving between projects fast
```

Naming, so that it is settled once:

```
the surface     "workspace bar" wherever a person reads it
the part        Parts.WORKSPACEBAR_PART, WorkspaceBarPart - like ActivitybarPart, no vendor
                prefix on a part
settings        facade.*        upstream owns workbench.*, so ours cannot collide with it
colour tokens   workspaceBar.*  named after the surface, the way every other part's are
```

---

## Step 0 — Identity

Smallest and most independent. Do it first to get a baseline that already looks like its
own product.

### 0.1 Turn Copilot off by default

The chat extension ships in-tree at `extensions/copilot` — 4136 files, 57 MB, built by
`compileCopilotExtensionBuildTask` and listed in `build/lib/extensions.ts`. It is **not**
in `product.json`'s `builtInExtensions`, which holds only the js-debug trio.

The approach is to **stop showing the AI features, not to tear them out**:

```
✓ do not register the chat views and contributions by default
✓ keep the extension in the tree and the build
✓ keep product.json's defaultChatAgent
✓ one setting turns the whole thing back on
```

⚠️ **Why not delete it.** `defaultChatAgent` is typed non-optional
(`readonly defaultChatAgent: IDefaultChatAgent`) and read at **129 non-test call sites**,
72 of them in `vs/workbench/contrib` and 32 in `vs/workbench/services`. Removing it is
not a deletion, it is a refactor of the chat plumbing — a different project with a
different risk, and it would conflict with every upstream merge.

⚠️ **Do not leave a dead entrance.** Hiding must mean not registering, not "registering a
view that shows an install prompt for something we do not ship". A visible control that
leads nowhere is worse than no control.

### 0.2 Rename

19 identity fields in `product.json` — display names, executable names, data folders,
system identity — plus two files that spell the name out and never read `product.json`:

```
resources/server/manifest.json             PWA name / short_name
resources/win32/VisualElementsManifest.xml
```

⚠️ Leave the four upstream URLs alone (`licenseUrl`, `serverLicenseUrl`,
`reportIssueUrl`, `webviewContentExternalBaseUrlTemplate`). Changing them either lies or
breaks.

⚠️ Two one-off costs: `dataFolderName` moves, so an existing profile is not found;
`darwinBundleIdentifier` changes, so macOS treats this as a new application and window
state and permissions start over.

### 0.3 Icon

Source art comes in three variants, each with its own job:

```
app          opaque square, generous margin   -> resources/darwin/code.icns
web-icon     transparent outside and in gaps  -> linux / server / win32 / favicon
web-inline   silhouette only                  -> empty-editor watermark
```

Keep each target file's existing size set rather than inventing new ones.

**⚠️ The `.icns` trap.** Slots `ic04` (16px) and `ic05` (32px) can only hold ARGB, not
PNG, and `iconutil`'s ARGB encoder loses colour and can add a yellow artefact — a whole
bottom row on an opaque full-bleed image, a single pixel on a transparent one. The fix:
**leave `icon_16x16.png` and `icon_32x32.png` out of the iconset** and supply only the
`@2x` files, so they land in the PNG slots `ic11`/`ic12` and macOS downscales for 1x.
The result is eight PNG slots, bit-identical to the source. A vendor-supplied `.icns`
hits this too, so rebuild from the iconset rather than shipping theirs.

**⚠️ A watermark with depth layers must not be flattened to one colour.** Take each
layer's ink weight against white, normalise to the frontmost, and express it as
`fill-opacity`. The root keeps a letterpress opacity — **0.15** light, **0.45** dark.
The two high-contrast themes use fixed colours and are left alone.

**⚠️ Verify the app icon by asking the system, not by diffing the file.** macOS 26 clips
app icons to a rounded superellipse and insets them, so a pixel diff between the system
render and the source is meaningless — judge by colour and geometry. After changing the
file, `touch` the bundle, re-register it with `lsregister -f` and restart the Dock, or
the old icon stays.

### 0.4 Acceptance

```
19 product.json fields plus the two files that spell the name out
the bundle is named Facade Code.app with the right CFBundle* values
icns has eight PNG slots, bit-identical to the source iconset
watermark checked in four themes: Dark Modern, Light Modern, HC Dark, HC Light
dock icon checked by capturing what the system actually renders
no chat view registered, and nothing on screen pointing at an extension we hide
```

---

## Step 1 — The activity bar can live in the title bar

Upstream has `workbench.activityBar.location: default|top|bottom|hidden` — four places,
and all four keep the view container icons inside the side bar's own frame. None of them
puts navigation on the same row as the layout controls.

The step is in two parts. **1a** adds a fifth position and moves the whole bar there.
**1b** breaks the bar apart so each icon picks its own side. 1a is a complete change on
its own and ships without 1b.

### 1a — A fifth position: `toolbar`  ✅ done

One row, in this order:

```
[command center]  ......empty......  ⬚ ⬚ ⬚ ⬚ ⬚ │ ▭ ▤ ▥ ▦ ⊙ ⚙
                                     navigation   layout    account
```

The icons are hosted by a second `PaneCompositeBar`, prepended into the title bar's
`.action-toolbar-container`, and the side bar draws no strip while this position is
chosen. Everything else about the icons — drag to reorder, badges, hover, the context
menu, what a click does — is upstream's, because the host is upstream's class.

```
layoutService.ts          ActivityBarPosition.TOOLBAR
workbench.contribution.ts the setting's enum and its description
activitybarPart.ts        the fifth entry in the position menu
layout.ts                 toolbar joins top/bottom: no standalone activity bar part
sidebarPart.ts            toolbar looks like hidden from here - draw no strip
titlebarPart.ts           create, size and dispose the host
titlebarCompositeBar.ts   its options                                      (new)
media/titlebarCompositeBar.css  its box, and the divider                   (new)
panecomposite.ts          getPartByLocation, no longer private
```

**⚠️ `Parts.ACTIVITYBAR_PART`, not `SIDEBAR_PART`.** `ViewContainerActivityAction` reads
that argument to decide whether clicking the active icon collapses the side bar. Passing
the side bar - which is what `SidebarPart` does for its own strip - silently drops that
behaviour, and the setting named `workbench.activityBar.iconClickBehavior` stops applying
to the activity bar.

**⚠️ Size the bar on creation, not only on layout.** `CompositeBar.layout` returns early
on a zero dimension and nothing lays the part out again just because a setting changed, so
a bar built at that moment renders no icons until the next resize. The part's own element
carries the current size; `this.dimension` does not, because `Part.layout` is never
reached from `BrowserTitlebarPart.layout`.

**⚠️ Never measure our own container when budgeting the bar.** It is sized by its content,
so reading it back is a layout feedback loop, and it reports zero on the first layout,
which collapses every icon into the overflow chevron. Budget from the width the part was
handed minus the neighbours that are sized by their own content, capped at half the title
bar - `.titlebar-right` is `min-width: min-content`, so a bar that always asks for its
natural width pushes the region into the command center and then under the
adjacent-center toolbar, which macOS offsets 8px further left than flex puts it.

**⚠️ The bar has to carry its own way out.** A `PaneCompositeBar` with no
`fillExtraContextMenuActions` offers the view containers and nothing else, so right-clicking
the icons cannot move them anywhere: the only routes back are the settings editor and the
command palette, neither of which the person is looking at. Upstream keeps those entries in
`ActivityBarCompositeBar.getActivityBarContextMenuActions`; it is lifted out into a function
both bars call, rather than copied.

**The submenu label and the setting value are the same word.** The full command title says
where the bar goes ("Move Activity Bar to Title Bar", matching upstream's "Move Activity Bar
to Side"); the short title is the position's name and reads `Toolbar`, because a menu entry
saying "Title Bar" beside a setting saying `toolbar` leaves nothing to search for.

**⚠️ The divider is `::after` on the bar's container, not a `Separator` in the toolbar.**
The boundary is at the toolbar's *left* edge and `prepareActions` deletes a leading
separator - correctly, since a separator with nothing before it separates nothing.

**⚠️ A class, not `:has()`.** `:not(:empty)` does not work - the container always holds the
bar's action bar even when that bar shows nothing - and `:has(.action-item)` is the trap
upstream closed in #327052: a `:has()` whose anchor is live makes Blink re-evaluate it on
every DOM mutation in the document, and `build/stylelint.ts` now rejects the root-anchored
form outright. Toggle a class from the part, which already knows the count. That needs a
change signal, so `PaneCompositeBar` forwards its `CompositeBar`'s `onDidChange` - the one
event that fires from `updateCompositeSwitcher`, the single funnel for what is rendered.

**The storage keys are the activity bar's, on purpose.** One position for one bar, so only
one of them is ever on screen, and what a person pinned, hid and reordered has to survive
being moved - the same way upstream's `top` and `bottom` share these keys with `default`.
**⚠️ 1b must split them** before two bars can be visible at once: each `CompositeBar` saves
the whole list it knows about, so two bars over one key take turns erasing each other.

Measured, in a dev window at `toolbar`:

```
nav icons          5, draggable, reorder survives a switch back to default
divider            drawn in all four theme kinds, and keyed off a class, not the icons
side bar strip     absent;  activity bar part  0 wide
title actions      4 layout toggles, Accounts, Manage
click active icon  collapses the side bar;  click another  switches to it
context menu       Activity Bar Position (5 entries, toolbar checked) + Move Primary Side
                   Bar Right;  round trip toolbar -> default -> toolbar from the menu alone
                   default and top menus unchanged by the extraction
window 1440 -> 480 icons fold into the chevron at 480, never overlap the command center
5 locations x 14 live switches  every cell as specified
```

### 1b — Each activity icon picks its bar  ❌ not doing this

An earlier design gave every icon its own position and let it be dragged between the two
bars. Against a bar that moves as a whole, none of it is needed: one bar has one position,
so there is nothing to filter and nowhere to drag to, and `layout.ts` already hides the
side strip. It also carries the worst failure in this step - a precondition that has to
read `enabled && location === 'toolbar'`, where dropping the second half does not degrade
but empties the window - and that failure only exists if the split does.

What it was for was real: with launcher buttons on this row, the first few icons were
draggable and the rest were not, with nothing to say where that changed. **1a's divider
answers that.** It sits on the boundary - view containers left, commands right - so a
launcher to the right of the line is consistent rather than inconsistent.

`workbench.activityBar.location` defaults to `toolbar`, because the window's first column
is the workspace bar and a second strip of icons beside it is one column too many. Setting
it back to `default` puts them where upstream has them.

### Acceptance

Five locations × switch on and off — the **cross product**, every cell. Testing one value
per axis passes while the broken combination goes unvisited.

⚠️ An HTML5 drag cannot be driven over CDP on macOS: `Input.dispatchMouseEvent` with a
button held produces no `dragover` at all. Reordering has to be checked with real OS mouse
events.

---

## Step 2 — The workspace bar

The largest piece: a rail listing projects and their worktrees, and switching between
them.

### 2.1 It is a real Part

Registered in the grid: the `Parts` enum plus the grid shape in `layout.ts`.
⚠️ A part missing from the enum is a whole class of silent no-op. Land it with a test
asserting the grid shape.

### 2.2 Data model

```
IFacadeProject   { uri, label, color?, worktrees }
IFacadeWorktree  { uri, branch, isMain }
storage          project list        -> StorageScope.PROFILE (follows the person)
                 per-window state    -> StorageScope.WORKSPACE
```

**⚠️⭐ The rail must own its model. Do not derive it from `ISCMService`.** That service
records which repositories the git extension happens to have loaded right now, and the
extension closes and reopens them as the window changes folder. A list rendered from it
collapses and refills on every switch: rows flicker, worktrees disappear and come back in
a different order. Treat git as one source of fact, not as the model.

### 2.3 Actions

```
addProject / removeProject / renameProject / customizeProject
moveProjectUp / moveProjectDown          reordering is menu-only, no drag-to-reorder
switchProject / nextProject / previousProject / focusProjects
newWorktree / deleteWorktree
openInNewWindow / revealInOS
```

### 2.4 Reading git, and writing it

**⚠️ The workbench cannot run git.** The renderer is sandboxed, so there is no `execFile`
to reach for from here at all. The two halves go to different places:

```
read     the workbench, itself, through IFileService
         `git worktree` keeps its bookkeeping in plain files under the shared `.git`, and
         reading them is four small reads - which is all the git extension does for this
         too. No extension is activated, no process is spawned, no dependency is added,
         and the answer does not depend on which folder the window happens to show.

write    the git extension, through commands it exposes
         `git worktree add` and `remove` do real work that cannot be imitated by writing
         files. `git.createWorktreeAt`, `git.deleteWorktreeAt`, `git.worktreePreflightAt`.
```

Inside the extension: `execFile` with an argument array, **never a shell string**. No call
site for `rebase`, `reset --hard` or `push --force`; enforce it with a grep check that
fails the build.

### 2.5 Colours

```
workspaceBar.background          = the activity bar's, and the whole of its rule
workspaceBar.foreground          = activityBar.foreground
workspaceBar.inactiveForeground  = 80% of this bar's own ink over its own fill, ⭐ opaque
workspaceBar.hoverBackground     =  8% of this bar's own ink over its own fill
```

**⚠️ The background is three tokens, not one.** Modern UI swaps in
`modernActivityBar.background`, and that one has a second colour for a window without
focus. Taking only `activityBar.background` agrees in eighteen of the nineteen built-in
themes and then disagrees in Solarized Light, which leaves the modern token undefined.

**⚠️ Take the pair, never half of it.** Moving only the background leaves the text tuned
for a surface it no longer sits on. Branching on theme kind to avoid that is worse: if a
value really equals a token, no theme can disagree with it, so a per-kind branch is
visible as an inconsistency. A theme that pairs a background with a foreground has
already guaranteed they work together; that guarantee beats any rule written here.

**⚠️ Derive the quiet ink; do not borrow one.** Measured across all 19 built-in themes:
`descriptionForeground` is tuned to the window's polarity rather than this surface
(median 5.47, 4 themes under 4.5); `activityBar.inactiveForeground` is an *icon* colour,
tuned to the 3.0 threshold and often translucent (median 3.56, 13 under 4.5, floor 1.76);
80% of this bar's own ink gives median 8.63, 2 under 4.5, floor 3.51.

**⚠️ Composite alpha over the background before computing contrast.** Workbench themes use
translucent secondary colours heavily, and scoring one as opaque turns a failing 3.41 into
a passing 12.63. Sweep all 19 built-in themes and publish the table.

**⚠️ Hover must be derived too.** `list.hoverBackground` is a pale grey in a light theme
and would flash white across a dark rail. Eight percent of the bar's own ink over its own
fill lands within the band the built-in themes use for their own hovers.

### 2.6 Reversibility

**No switch for the bar itself.** It is what the product is; a window without it is not
this product wearing a different setting, it is Visual Studio Code. Everything the bar
*changes* about the stock window stays reversible on its own -
`workbench.activityBar.location` back to `default` is the whole of it today.

### 2.7 Nine commits

Sized against a working implementation of the same thing: 4,470 lines of TypeScript and
1,004 of CSS in new files, plus `layout.ts` +140, the git extension +373 and a handful of
smaller upstream edits. Each of these builds, is checked and is reverted on its own.

```
1  the part          in the grid, with its width and its sash, and the grid-shape test
                     that a part missing from the enum needs          ✅ done
2  reading git       the .git bookkeeping, watched          unit tests, no UI
3  the model         projects and worktrees, and where each half of the state is stored
                                                            unit tests, storage scope
4  the bar draws     rows on the list widget, expanding, filtering
5  switching         the window changes folder[0]           and the three staleness bugs
6  worktrees         made and unmade, with a preflight      fixture repository
7  colours           derived, and swept over every built-in theme    the table
8  naming            rename, and the customize dialog
9  the rest          new window, reveal, reorder, next/previous, dropping a folder in
```

Two more landed with 1 that were not in this list: `workbench.activityBar.location`
defaulting to `toolbar`, and the splash learning to paint the first column, which it has
to or the window's first frame does not line up with its second.

⚠️ **2 comes before 3 and is not folded into it.** It is the trap in 2.2 and the one piece
here that is pure logic, so it can be held to unit tests before anything renders.

⚠️ **7 is its own commit** because its acceptance is a published table, not a screenshot,
and that table has to be attached to the change it measures.

---

## Step 3 — Terminals and agent CLIs, per tab

### 3.1 Terminals follow the project

A terminal is claimed by the project it was created in and comes back when that project
does. Terminals survive tab switches; verify it with a live loop rather than by looking.

### 3.2 One button, one menu

A single `terminal` icon on the bar. Clicking opens a context menu: `New Terminal` plus
every tool that was **detected**. That one slot is still draggable, reorderable and
movable to the side strip.

⚠️ One button rather than one per tool: the bar is shared with view containers, and every
launcher put on it takes a seat from them permanently.

### 3.3 Detection

Take the first word of the command line and show the entry only if it can be found.

⚠️ **`PATH` is not reachable from the renderer** — it is sandboxed and `process` is not
even defined there. Even if it were, the `PATH` the application launched with is the
wrong answer: launched from the desktop it is the bare system one, while these tools live
in directories a login shell adds. So: `PATH` when available, plus a list of the
directories such tools install into.

⚠️ If no directory can be read at all — a remote or web window — **hide nothing**. An
empty menu is a worse answer than a hopeful one.

⚠️ Register the commands unconditionally and withhold only the menu entry. Detection is a
guess about a `PATH` this window cannot see; it must not break a keybinding someone set
deliberately.

### 3.4 Two implementation details

⚠️ **Keep actions by id across renders.** `CompositeBar` asks for an item's action once
and then holds what it is given. Rebuilding disposes objects it is still using and
changes nothing on screen; push a late-arriving icon into the existing action instead —
upstream provides a change event for exactly this.

⚠️ **Anchor the menu to the bar's own box, not the button's.** The composite bar's view
item provider is hardcoded and hands nothing back, and finding the element by position is
the fragile pattern the lint rules warn about.

⚠️ Menus in this workbench deliberately carry no icons, so a launcher's icon only means
anything on the bar itself.

---

## Step 3.5 — Which layer holds the list

Settled 2026-09-20 after reading the workspace architecture end to end.

### 3.5.1 What VS Code's workspace actually is

```
IWorkspace = { id, folders[], configuration, transient }
  folders[] IS the file. configurationService.setFolders() writes it back through
  IJSONEditingService. Memory and disk are one thing.
  id = md5(config path). Editing folders does not change it, so StorageScope.WORKSPACE
  survives a switch. Save-as changes the path, so it changes the id.
  Only WorkbenchState.WORKSPACE may edit folders; doUpdateFolders returns early for
  EMPTY and FOLDER. That is where the one-time transition comes from.
  Every view is a pure function of folders[]: explorerModel.ts builds roots from it and
  rebuilds on onDidChangeWorkspaceFolders.
  The extension host gets it through one function: mainThreadWorkspace.getWorkspaceData().
```

Blast radius: `getWorkspace().folders` 182 sites, `onDidChangeWorkspaceFolders` 79,
`getWorkspaceFolder()` 120.

### 3.5.2 The choice, as a 2x2

```
                    ext host sees 1                    ext host sees N
workbench sees 1    WHAT WE BUILT. Everything is       -
                    isolated for free. Switching
                    tears down and rebuilds.
workbench sees N    All of the work, the same          Switching is free at the language
                    switch cost. Only worth it to      layer. N language services resident.
                    show cross-repo things.            Noise IS filterable - Problems and
                                                       SCM are workbench views.
```

⚠️ Isolation and a cheap switch are opposed. Isolation means the language services know one
repository; switching means they must forget it. Feeding the extension host a filtered list
does not avoid that - `$acceptWorkspaceData` with different contents fires the same folder
change, and the project is rebuilt either way.

### 3.5.3 Decision - SUPERSEDED by 3.6

⚠️ What follows was decided before the measurements in 4.2f and 4.2j existed. Both numbers it
rests on turned out to be wrong, in opposite directions. Kept because the reasoning is still
the right reasoning; read 3.6.1 for what changed.

Stay where we are: the window keeps an untitled workspace holding exactly one folder, and
the list of projects is ours.

```
The list is saveable by writing a real .code-workspace whose folders[] is the whole list,
  and reading one back. Opened in stock VS Code it is an ordinary multi-root workspace -
  an honest degradation. Reading one is already built (the drop handler).
Cross-repository information does not need multi-root. Read .git from the bar with
  IFileService - branch, worktrees, dirty - no extension host, no membership.
Multi-root only earns its cost if two repositories must be edited together, or searched
  together. That is a feature to add later, not an architecture to adopt now.
```

⚠️ Overruled. This said not to call it "Workspace" in the product, because 426 user-visible
strings already say it and a third meaning reproduces microsoft/vscode#77718. That objection
only holds for a *third* meaning. Under 3.6 there is no third meaning: the window has one
workspace, it is a real one, and the bar lists its roots. The word keeps the meaning it had.

⚠️ Hiding "Add Folder to Workspace" does not stop an extension calling
`updateWorkspaceFolders`. The bar follows `onDidChangeWorkspaceFolders` already; what a
folder we did not put there should look like is still undefined.

### 3.5.4 How much anyone uses multi-root

Evidence, not opinion, gathered 2026-09-20:

```
microsoft/vscode issues by area label, all time
  debug 7671 · git 4354 · search 2527 · tasks 2506 · file-explorer 2306
  scm 1345 · workbench-editors 813 · workbench-multiroot 495 (28 still open)
workspaceLoad telemetry records window size, theme, language, restored editors - not the
  number of folders. Adoption is not measured.
microsoft/vscode#77718, "Consistency with the use of workspace": folder settings are called
  Workspace until a .code-workspace exists, then they are called Folder. Users do not know
  what a workspace is. Closed, under-discussion.
What its users do use it for: monorepos (cited benefit: per-folder settings), microservices,
  front-end plus back-end, infrastructure beside application, and since 2025 feeding AI
  agents across repositories.
Their standing complaint is that multi-root flattens the explorer - which is the thing we
  are avoiding, not inventing.
```

---

## Step 3.6 — The architecture

Settled 2026-09-20, after 4.2j measured a cold start with N projects resident. Supersedes 3.5.3.

### 3.6.1 What changed the decision

3.5.3 chose way 3 believing that N resident roots cost N times something, and that way 3's
switch was the cheap one. Both were measured afterwards and both were wrong:

```
4.2j   folder count costs nothing at startup and almost nothing in memory. 1 folder against
       8: window painted ~120ms either way, workbench restored ~1.9s either way, +100..190MB.
       What costs is language COUNT - and a stock multi-root workspace holding the same
       folders pays exactly the same. It is parity, not a cost we introduce.
4.2f   retention is bound to workspace membership, not to process lifetime. Way 3 swaps the
       folder out of folders[], so every revisit rebuilds the project graph: 19s. A root that
       stayed in folders[] comes back in 1.75s.
```

So way 3 buys isolation we can get another way, and pays 19s per revisit for it.

### 3.6.2 The shape

The window is a real multi-root workspace. One service says which root is active. Layer 1 asks
that service instead of asking the workspace. Layer 2 is untouched and gets all N.

```
              folders[] = all N          a real .code-workspace, on disk, openable by stock
                   |
        +----------+----------+
        |                     |
    layer 1               layer 2
    drawn by the          the extension host
    workbench             |
        |                 gets all N, unfiltered
    asks IActiveFolder    |
    Service -> sees 1     what it returns lands in layer 1's views,
                          and layer 1 is already narrowed
```

The reason this works is the one thing 3.5.2 got right: layer 1 is ours to filter and layer 2
is not. Narrowing layer 1 is enough, because layer 2 has no screen of its own.

### 3.6.3 IActiveFolderService

`src/vs/workbench/services/activeFolder/`

```ts
readonly activeFolder: IWorkspaceFolder | undefined;
readonly onDidChangeActiveFolder: Event<void>;
setActiveFolder(folder: IWorkspaceFolder | URI): Promise<void>;
isInActiveFolder(resource: URI): boolean;   // the predicate layer 1 filters with
```

State lives in `StorageScope.WORKSPACE` - it is per window. It seeds from
`getLastActiveWorkspaceRoot()` the first time.

⚠️ The name is upstream's own. `IHistoryService.getLastActiveWorkspaceRoot()` has 27 call
sites, and every one of them names its local `activeWorkspaceRootUri`: the terminal's cwd, the
terminal profile resolver, the search editor. They are all *guessing* which root is meant.
This service makes the guess authoritative, which is most of what "only better" means here.

```
rejected  scope     StorageScope 2822 sites, ConfigurationScope 571. Worse, StorageScope
                    .WORKSPACE means the WHOLE workspace - the opposite of one folder in it
rejected  view      IViewDescriptor, ViewContainer, IViewsService all mean something else
```

The part stays `workspacebar`. The product word stays "workspace".

### 3.6.4 What layer 1 narrows

```
explorer          the active root only (SET_ROOT_FOLDER_COMMAND_ID already exists upstream)
search, quick     default scope = active root, with a way to widen
open
SCM               the active root's repositories
problems          PARTITION per root and keep them, show the active root's. Never discard -
                  republish on switch
title, status     the active root's name
editors           a working set per root (built)
terminals         cwd = active root (step 3)
```

### 3.6.5 Two rules that cannot be broken

```
⚠️ IActiveFolderService never enters the write path. doUpdateFolders (configurationService.ts
   :241) is read-modify-write: it takes getWorkspace().folders, rebuilds newStoredFolders from
   it, and writes that back. A narrowed list reaching it means one Add Folder deletes the other
   N-1 from the .code-workspace.
⚠️ Layer 2 has exactly one entry: getWorkspaceData() (mainThreadWorkspace.ts:132), used by
   $initializeWorkspace and $acceptWorkspaceData. The baseline changes nothing there.
```

### 3.6.6 How the two requirements are met

**Nothing the workspace does may be lost.** It is not lost because we did not touch the thing
that does it. `folders[]` *is* the workspace, so Save Workspace As, Add and Remove Folder,
workspace settings, workspace tasks and launch, `${workspaceFolder}` resolution, recently
opened and multi-root search all keep working without being adapted one by one. This is the
structural advantage of way 1 over way 3, where the list was private and none of that was free.

**Performance may not be worse.** Two honest baselines:

```
vs a stock workspace holding the same N folders
   identical by construction, and measured so in 4.2j - every startup milestone inside the
   run-to-run spread, same processes, same memory
vs N windows each holding one folder
   we save N-1 renderers and N-1 extension hosts. DERIVED from the per-process figures in
   4.2j (one window's shell is 2.3-3.0GB, of which main, shared, gpu and the watcher are
   shared between windows and the renderer and ext host are not) - NOT measured end to end
better than stock
   moving between two roots is 1.75s with both resident, against 19s for a folder swap (4.2f)
```

**What stays at parity rather than improving.** An extension's own UI - `showWorkspaceFolderPick`,
a tree it draws itself - lists all N. We cannot filter it. Stock multi-root does the same thing,
so it is parity, not a regression.

### 3.6.7 What we save must open in stock VS Code

A `.code-workspace` we write is an ordinary one. That is a checkable acceptance test, not an
aspiration: write it, open it in stock VS Code, get all N folders and no warnings.

```
⚠️ The file contains only what upstream would write. folders[] as plain {path} or {uri,name},
   and settings only if the user set them.
⚠️ Our own state never goes in it: which root is active, the per-root editor working sets, any
   bookkeeping. StorageScope.WORKSPACE, keyed by the workspace id. Writing a facade.* key into
   the file would make stock VS Code report an unknown setting.
```

### 3.6.8 Deliberately later

Withholding a root from layer 2 until it is needed would stop `workspaceContains:` starting a
heavy language server for a project nobody has opened - the 1.2GB jdt.ls in 4.2j. The lever is
`getWorkspaceData()`.

Not in the baseline: extensions would see a folder list the workbench does not have, and
`${workspaceFolder}` and friends would drift from it. That breaks the first requirement to
serve the second, and 4.2j says the second is not under threat.

---

## Step 4 — Switching performance

### 4.1 Two levers, already measured

```
1. Do not restart the extension host on switch
   The relauncher restarts it because folder[0] changed, purely for the deprecated
   workspace.rootPath. A setting bypasses it.
   Measured: ~975ms saved per switch, and the SCM view goes from blanking for ~1.03s
   (empty at +1120ms, back at +2153ms) to never blanking.

2. git.detectWorktrees: false
   Stock defaults to true with a limit of 50, opening every worktree as its own SCM
   repository. Measured: SCM settles in ~590ms instead of ~1650-2350ms.
```

### 4.2 Where a switch actually spends its time

Measured 2026-09-20, three git repos of 32 / 20 000 files, renderer clock, 20ms sampling.

```
+0ms          click
+38-98ms      explorer root swapped, title swapped, SCM cleared    <- everything we own
+273ms        old extension host process gone                      graceful stop ~220ms
+348ms        new extension host process up                        spawn ~75ms
+800-1100ms   git indicators back                                  bootstrap + activate + status
```

⚠️ **The cost is fixed, not proportional to the repository.** 32 files -> 20 000 files is
1096ms; 20 000 -> 32 is 1118ms; 32 -> 32 is 1058ms. Meanwhile `git status` itself is 13ms
on 32 files, 47ms on 20 000, 346ms on this repo's 18 866. Nearly all of that second is the
extension host being torn down and rebuilt, and none of it is work anybody asked for.

⚠️ **Every switch restarts the extension host.** `relauncher.contribution.ts` watches
`folders[0]` and restarts when it changes, for the deprecated `workspace.rootPath`. Counted
by PID, not by a coalescing event: three switches, three new processes.

### 4.2b The ceiling, per surface

```
explorer                  40-100ms      already there, nothing to do
title / context / editors tens of ms    already there
Source Control            ~instant      needs 4.1's two levers, plus keeping the git
                                        extension's repositories open across a switch
Problems / search         tens of ms    workbench-side; MarkerService.read() filters by
                                        resource and markersView already has FilterOptions
language services         UNMEASURED    the only thing left, and the only thing a workbench
                                        change cannot fix
```

⚠️ **Language services are the open question.** tsserver has to forget one project and learn
another; that work is real. Suppressing the restart keeps the tsserver *process* alive (the
TS extension spawns it, so it dies with the host), which should leave only the project graph
to rebuild - unverified. Measure "switch -> first completion" on real repositories before
promising a switch time.

⚠️ The 20 000-file repository above had no `tsconfig.json`, so no TS project was ever built.
Everything in 4.2 measures the git path only.

### 4.2c Language services, measured

Real repositories cloned from GitHub, bundled extensions only (this fork has no marketplace),
completions driven through the UI and timed from the click. 2026-09-20.

```
                    files   probe                         cold switch    warm
ky (TS, deps)         104   Math. (lib.d.ts)               316-1273ms   ~200ms
axios (JS, deps)      473   Math.                          598-1080ms   ~200ms
vue-core (TS)         702   Math.                          349-1390ms      -
bootstrap (SCSS)      793   colo -> color                  250-731ms    ~170ms
FacadeCode (TS,deps) 18866  Math.                          523-601ms    ~207ms
FacadeCode (TS,deps) 18866  cross-file auto-import       17845-18632ms  558-675ms
```

⚠️ **`Math.` is not a test of the language service.** It is answerable from `lib.d.ts` before
tsserver has built anything, which is why an 18 866-file repository and a 104-file one score
the same on it. The honest probe is a completion that only a built project graph can answer -
here, an auto-import of a symbol from another file.

⚠️ **On a large TypeScript project the project graph takes ~18 seconds, and suppressing the
extension host restart does not change it** (17 845ms with the restart, 18 632ms without).
The work is tsserver reading 13 159 `.ts` and 6 101 `.d.ts`, and nothing in the workbench
touches it.

⚠️ This is the same cost as opening that folder in stock VS Code. What is new is that a bar
makes it a one-click habit instead of a File > Open Folder.

### 4.2d What the restart gate is actually worth

A/B over four projects, `facade.switch.restartExtensionHost` true vs false:

```
                  restart on   restart off   saved
axios                  812ms        598ms     -26%
vue-core               694ms        358ms     -48%
ky                     658ms        316ms     -52%
bootstrap (SCSS)       350ms        250ms     -29%
ky (repeat)            720ms        205ms     -72%
FacadeCode graph    17845ms      18632ms       none
```

It buys back the host teardown and the re-activation of every extension - real for small and
medium projects, worth nothing against a large project graph.

⚠️ Not built, and the measurement patch has been reverted. Under 3.6 a switch never touches
`folders[]`, so `WorkspaceChangeExtHostRelauncher` does not fire on one and there is nothing to
gate. It still fires when a project is added or removed, where the restart is upstream's own
correct behaviour and should stay. The numbers are kept because they price what a folder swap
costs, which is what 3.6.1 weighed way 3 against.

### 4.2f What actually keeps a project graph warm

The question: if the extension host is not restarted, does tsserver keep the project it built?

```
Way 3, folder swapped out and back, extension host kept alive (restart gate off)
  first build of FacadeCode      ~20s
  revisit after one hop away    19237ms
  revisit again                 18688ms          <- rebuilt every single time

Way 1 shape, both folders resident in one .code-workspace, never swapped
  first build of FacadeCode     19576ms
  work in vue-core                213ms
  revisit FacadeCode             1750ms          <- retained
```

⚠️ **Keeping tsserver alive is not what keeps a project warm - workspace membership is.**
The TS extension follows the workspace folders, and our editor working sets close every file
of the project being left, so tsserver drops the project either way. Suppressing the extension
host restart buys 26-72% on small and medium projects and nothing at all here.

⚠️ tsserver is one semantic server plus one syntax server per extension host, holding many
projects at once. "Run several tsservers" is not a shape this can take; the shape is one
server holding several graphs, and it holds them for folders in the workspace.

So the switch cost on a large TypeScript project is a real fork in the road:

```
folder swapped (Way 3)      ~19s on every visit
folder resident (Way 1)     ~20s once, then ~1.7s
```

### 4.2g Languages not measured, and why

This fork has no `extensionsGallery`, so only bundled language features could be driven:
TS/JS, JSON, HTML, CSS/SCSS, Markdown. Java, Kotlin, Swift, Rust, Go all live in the
marketplace. The machine has `java` and `swift` but no `kotlin`, `rustc`, `cargo`, `go`,
`gradle` or `mvn`, so several of those servers could not do real work even if sideloaded.

⚠️ Do not read the TypeScript number as the worst case. jdt.ls, rust-analyzer and
sourcekit-lsp all build a whole-project model before answering, and all key it to the
workspace root, so 4.2f's conclusion applies to them unchanged - most likely with a larger
constant.

### 4.2h Go, and the languages that could not be reached

Open VSX wired into `product.json`, `golang.Go` and `redhat.java` sideloaded as VSIX, `go`,
`gopls` and `openjdk` installed. 2026-09-20.

```
                        project              switch -> a completion that needs the graph
Go     gopls (2 procs)  gin, 99 .go files    19991ms cold · 15135ms on a later visit
Java   jdt.ls           gson                 NOT MEASURED
```

⚠️ Java could not be measured. jdt.ls starts, reports `Java: Ready` and holds 732MB, but
`mvn` cannot resolve gson offline, so there is no classpath: no completions and no errors
either. A real number needs the dependency download first.

⚠️ **Two heavy servers make the window itself janky.** With gopls and jdt.ls both up, a
100ms sleep driven over CDP stretched to seconds and opening a file went from 300ms to
13 000ms. For Way 1 the cost of N resident servers is not only memory - it is the
responsiveness of the whole window. jdt.ls alone idles at 732MB.

⚠️ **`workspaceContains` confirmed in the wild.** Opening a Go project lit up `Java: Ready`
in the status bar as well. N projects resident means every language's extension activates.

⚠️ **A flaw in this harness, which changes how to read 4.2c.** `completionMs` starts after the
file is open, and the language server warms up during that open. Where the open was slow the
server got a free head start:

```
Go gin revisit   fileOpen 13027ms -> completionMs 1109ms -> end to end 15135ms
                        ^ 13 seconds of warm-up that completionMs does not count
```

Read `totalFromClickMs`. The TypeScript numbers in 4.2c are affected only slightly (2s of
open against 19s of graph); the Go "fast revisit" was an artefact.

### 4.2i What the language measurements settle

```
light servers   CSS · SCSS · JSON · HTML    separate small processes, ~200ms, never a problem
heavy servers   TS · Go · Java · Rust       15-20s on a real project, every cold visit
```

Two independent implementations, tsserver and gopls, land in the same 15-20s band on real
projects. That is the number the product has to be designed around, not the 200ms one.

### 4.2j Cold start with N projects resident

The question way 1 has to answer: a window that really holds N folders, opened cold. Measured on
a 32GB machine, six runs, a fresh profile each time, one TypeScript file passed on the command
line so a real language service starts. Timings are VS Code's own `performance.mark('code/*')`,
not a poll of mine. Memory is RSS attributed by walking the process tree from the launched pid.

```
                        folders   splash  workbench  extensions  Eventually   final MB  idle at
  8 incl. one Java         8       110-129  1885-1994  2364-2463   4410-4518   5801-5991   44-45s
  8, Facade first          8       118      1892       2400        4394        6220        39s
  7, no Java               7       119      1909       2485        4409        5559        29s
  1 (Facade alone)         1       117-128  1885-1991  2484-2515   4390-4494   5373-5459   29s
```

**Folder count costs nothing in time.** Every milestone is inside its own run-to-run spread:
the window is painted at ~120ms, the workbench is restored at ~1.9s, and extensions are loaded
at ~2.4s whether the workspace holds one folder or eight. Nothing in the startup path walks the
folder list in a way that shows up.

**Folder count costs almost nothing in memory either - language *count* does.** Seven folders
against one is +100..190MB. Adding a single Java folder that nobody opened is +1.2GB and +15s
of background CPU: `gson` is one of the eight, so `workspaceContains:` activates the Java
extension, which starts jdt.ls, which settles at 1165-1300MB. Drop that one folder and both the
memory and the late CPU go with it.

```
  cost of N projects resident = sum of the language servers those N projects eagerly activate
  the folder list itself is free
```

**The UI never degrades.** A trivial expression on the renderer's main thread, sampled every
400ms for the whole warm-up, across six runs and ~1400 samples:

```
  p50 1ms   p90 1-3ms   p99 20-40ms   worst 82-259ms   samples with no answer: 0
```

Every worst-case spike lands between 2.3s and 5.2s - extension loading - and the *single-folder*
runs produce the largest of them (259ms, 247ms, 245ms, 233ms) while the eight-folder runs stay
under 100ms. After 20s the worst sample in any run is 27ms. jdt.ls burning 484-628% CPU at
t=22-37s does not move the renderer at all: it is a separate process and the machine has cores.

⚠️ RSS totals are a floor, not demand. The eight-folder runs peak at 6.2-6.3GB, and on a machine
already 8.6GB into swap macOS reclaims from whoever has the most reclaimable pages. That is why
the *renderer* and *tsserver* read smaller in the 8-folder runs (1043-1104MB / 2143-2398MB) than
in the 1-folder run (1459-1636MB / 2557-2568MB) - not a saving, a reclaim. The totals are still
comparable; the per-process split under pressure is not.

**What this settles for view space.** Criteria one and two are met by way 1 as it stands, with no
work: the window is up in 120ms and operable in under 2s, and it stays operable while everything
warms up behind it. Criterion four is the only one that binds, and it binds on a single axis -
how many *language servers* are resident, not how many folders. So view space does not need to
stagger folders; it needs to own when a root is handed to layer 2 at all, and the only rows that
matter are the ones that would pull in a heavy server nobody asked for.

### 4.2e Harness traps hit while measuring this

```
⚠️ File search lives in a process that goes down with the extension host. Right after a switch
   quick open answers with nothing; a fixed timeout turns that into a fabricated 30s
⚠️ Cmd+K Cmd+W is a chord. A half-delivered chord swallows every key after it
⚠️ Clicking the project you are already on produces no folder change, and a wait-for-change
   probe then reports a 20s timeout as if it were a measurement
⚠️ xterm draws to a canvas, so innerText reads nothing - including the prompt. A probe that
   cannot see a control case cannot report a negative one
⚠️ A clean repository shows no SCM badge, so "N pending changes" is not a readiness signal
⚠️ Matching processes by name pulls in every other instance on the machine and every leftover.
   Attribute by walking the process tree from the pid that was launched
⚠️ `Code Helper (Plugin)` does not exist in a build from source, so matching on it filed the
   extension host under the workbench. Tag by `--type=`, which the process carries itself
⚠️ `node uisample.mjs x 240` makes argv[2] the label, so the budget is NaN and the loop never
   runs. It still prints a result, and the result is empty
⚠️ tsserver and gopls start from an *open file*, not from the workspace. A cold-start run that
   opens nothing measures a window with no language service in it
⚠️ Polling for a DOM condition every 3s reports every mark inside that window at the same
   timestamp. VS Code's own `performance.mark('code/*')` is already there and is exact
```

### 4.3 Rules for the measuring harness

```
⚠️ The timer must cost less than the thing timed. Spawning a process per timestamp turned
   a 21.7ms git call into 77ms - and nearly became a claim about the machine being slow
⚠️ Align to wall clock. Timing from "watcher started" folds in the startup offset and
   produces numbers that are not real
⚠️ A/B needs two real runs. Checking out the parent commit while both sides run in the
   same hot-reloaded renderer compares nothing
⚠️ transpile-client clears out/ on every run; only a cold start reveals a stale one
```

---

## Running through every step

### Tests

Each step lands with tests:

```
step 1   pure-logic tests for the position service
         a truth table for visibility across five locations x switch on/off
step 2   project and worktree model: add, remove, rename, reorder
         git command construction (argument arrays, never a string)
step 3   detection: PATH present, PATH absent, no readable directory
step 4   the benchmark lives in the repo and can be re-run
```

### Build-failing checks

Bare `ms` durations, bare `cubic-bezier`/`ease`, bare `box-shadow` numbers, literal
`#hex` / `rgb()` colours, and any call site for `rebase`, `reset --hard` or
`push --force`.

### Instruments

Written when needed. Traps worth knowing before writing them:

```
⚠️ A CDP driver must refuse to guess when more than one workbench window is open.
   /json/list is not stably ordered, so a probe and a screenshot taken seconds apart can
   read two different windows
⚠️ OS-level drag needs the window frontmost, or the first mouse-down only activates it
   and the whole event stream is wasted. CDP cannot drive an HTML5 drag on macOS
⚠️ Theme switching needs no restart - write workbench.colorTheme - but the switch must be
   asserted, because the workbench carries the theme's file name in a class. Not waiting
   long enough produces identical rows that look like a finding
```
