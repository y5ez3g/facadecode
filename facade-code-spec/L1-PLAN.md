# L1 plan — steps 0 to 4

Baseline is the `vendor/1.138.0` root commit. Every step stands on its own: it can be built, checked and
reverted by itself. Each lands on `feature/<n>-<name>`, gets reviewed, then merges into
`main` with `--no-ff`.

Suggested order: **0 → 1 → 2 → 4 → 3.** Performance measures cleanest right after step 2,
while the change surface is still small; step 3 then adds work to the switch path.

```
0  identity        drop Copilot, new icon, rename to Facade Code
1  top bar         the activity bar in the title bar, then each icon choosing a side
2  workspace bar   the project and worktree rail
3  per-tab shells  terminals and agent CLIs that follow the project
4  switching       make moving between projects fast
```

All new code uses the `facade` prefix.

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

### 1b — Each activity icon picks its bar

1a moves the bar as a unit. 1b gives each icon a position of its own and lets it be
dragged between the title bar and the side strip.

#### Where the contract lives

```
services/facade/common/facadeTopBar.ts     IFacadeTopBarService (parts may depend on this)
contrib/facade/browser/facadeTopBar.ts     implementation, setting, layout contribution
browser/parts/facadeLauncherBar.ts         bar items that are not view containers
```

⚠️ **This split is the layering rule, not tidiness.** `vs/workbench/browser/**` may not
import from `vs/workbench/contrib/**`, and both bars are parts. A part importing from
contrib will type-check and pass `valid-layers-check`; only hygiene catches it.

#### Upstream files get optional hooks only

Four of them on `IPaneCompositeBarOptions`:

```
shouldShow(id)            does this bar show this view container at all
onDidChangeShouldShow     the answer changed, redraw
extraMoveActions(id)      extra entries for the item's "Move To" submenu
foreignItems              accept an item dragged in from the other bar
```

**⚠️ The filter belongs in `getViewContainers()` / `getViewContainer()`, not in
`addComposite`.** `updateCompositeBarItemsFromStorage` never goes near `addComposite`, so
filtering only there leaves both bars showing everything.

**⚠️ A "refresh visibility" pass must iterate the unfiltered set and go through
`showOrHideViewContainer`** — not through the already-filtered accessor, where the
removal branch becomes dead code, and not through `addComposite`, which bypasses
`hideIfEmpty` and conjures up containers that should stay away.

**⚠️ Separate storage keys**, as 1a's note says: the moment both bars can be on screen,
sharing one record has them overwriting each other's half.

#### Dragging between the bars

`CompositeDragAndDrop` needs a third case: an item this bar does not own.
**⚠️ Ask before the location lookup.** A launcher has no view container, so
`getViewContainerById` returns undefined behind a non-null assertion and reading `.id`
off it throws inside the drop handler. From outside that is indistinguishable from a
refused drop: dragstart fires, dragover fires repeatedly, drop fires, nothing happens.

⚠️ An item arriving from the panel does **not** take this path; it has to be moved to
this location by the view service first.

⚠️ The "Move To" menu entries are **the only route that works from a standing start** —
the side strip is hidden while empty, so the first icon cannot be dragged onto it.

#### Auto-hiding

The divider is drawn only when something is left of it — 1a already ties it to the bar
holding an item. The side strip hides when nothing is assigned to it.
⚠️ Its composite bar is built lazily in `show()`, which the layout service's hide/show
path does not call — the symptom is a full-height activity bar with nothing in it.

#### ⭐ The precondition that makes or breaks this

```ts
get enabled() {
  return settingIsOn && activityBarLocation === 'toolbar';
}
```

⚠️ **Without the second half this does not degrade, it empties the window.** The title
bar only builds its bar at `toolbar`, and the default assigns every icon to the top bar,
so at any other location the top bar names something that does not exist: no title bar
host, a zero-width activity bar, a zero-width side strip, and two icons left in the whole
window.

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

### 2.4 Git call rules

`execFile` with an argument array, **never a shell string**. No call site for `rebase`,
`reset --hard` or `push --force`; enforce it with a grep check that fails the build.

### 2.5 Colours

```
facadeBar.background          = activityBar.background
facadeBar.foreground          = activityBar.foreground
facadeBar.inactiveForeground  = 80% of this bar's own ink over its own fill, ⭐ opaque
facadeBar.hoverBackground     =  8% of this bar's own ink over its own fill
```

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

`facade.rail.enabled`, default on. Off must be genuinely stock, not "mostly hidden".

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

### 4.2 Still undefined

⚠️ **There is no ceiling for switch time yet.** The known floor is a 301ms extension host
restart. What blocks the ceiling is that language-service re-indexing has never been
measured. Measure it first, then set the target.

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
