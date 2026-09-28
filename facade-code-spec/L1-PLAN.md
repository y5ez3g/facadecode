# L1 — identity and the window

L1 is the first release level of Facade Code: a VS Code fork that looks like its own product, and
whose window is organised around the workspace - one window, many folders. It starts from the
`vendor/1.138.0` root commit and is three steps. Each step stands on its own, lands on
`feature/<n>-<name>`, and merges into `main` after review (ENGINEERING.md).

```
0  identity    Copilot off by default · renamed Facade Code · its own icon          done
1  top bar     the activity bar can live in the title bar, and does by default      done
2  workspace   the workspace bar, one window for many folders, worktrees            WORKSPACE.md
                                                                                    WORKTREE.md
```

## Names

```
the surface     "workspace bar" wherever a person reads it
the part        Parts.WORKSPACEBAR_PART, WorkspaceBarPart - no vendor prefix on a part
settings        facade.*       upstream owns workbench.*
colour tokens   facadeBar.*    a theme author writes these, and upstream is free to add a
                               workspaceBar.* of its own
```

## Step 0 — Identity

```
Copilot         not registered by default, and one setting turns it back on. Hidden, not deleted:
                the extension stays in the tree and the build, and product.json keeps
                defaultChatAgent, which 129 call sites read. No visible control may lead to
                something we hide
name            19 identity fields in product.json, plus resources/server/manifest.json and
                resources/win32/VisualElementsManifest.xml. The four upstream URLs stay. Costs,
                once: the data folder moves, and macOS treats the new bundle id as a new app
icon            app (opaque square) -> code.icns · web-icon (transparent) -> linux, server,
                win32, favicon · web-inline (silhouette) -> the empty-editor watermark. Each target
                keeps its existing size set. The watermark keeps its depth: each layer's ink
                against white, normalised to the frontmost, as fill-opacity; the whole at 0.15
                light, 0.45 dark; the high-contrast themes keep fixed colours
```

Done means: the name and the icon are asserted where a person sees them, not where they are set; the
bundle is `Facade Code.app`; the watermark is checked in Dark Modern, Light Modern, HC Dark and HC
Light; the dock icon is checked as the system renders it; no chat view is registered. How the `.icns`
is built, and why, is in `build/lib/facade/icns.ts`.

## Step 1 — The activity bar in the title bar

`workbench.activityBar.location` gains a fifth value, `toolbar`: the view container icons move into
the title bar, left of the layout controls, behind a divider, and the side bar draws no strip. The host
is upstream's `PaneCompositeBar`, so dragging, badges, the context menu and a click on the active icon
behave as they do in the activity bar. The default is `toolbar`: the window's first column is the
workspace bar, and a second strip of icons beside it is one too many. `default` puts them back.

Not doing: letting each icon choose its own bar. One bar with one position needs no filtering and no
drag between bars, and the divider already says where navigation ends and commands begin.

Done means: all five locations crossed with the switch on and off, every cell - one value per axis
passes while the broken combination goes unvisited.

## Step 2 — The workspace

[`WORKSPACE.md`](./WORKSPACE.md) and [`WORKTREE.md`](./WORKTREE.md).

## Every step

```
tests               step 0 and 1 as above; step 2 in WORKSPACE.md §8
build-failing       bare ms durations, bare cubic-bezier/ease, bare box-shadow numbers, literal
checks              #hex / rgb() colours, and any call site for rebase, reset --hard, push --force
measuring a window  WORKSPACE.md §8.4
```
