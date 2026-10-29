# Activity Bar

The activity bar chooses a workbench view, such as Explorer or Search. The
workspace bar chooses a project or worktree. These are separate parts of the
window; this document describes the activity bar.

[WORKSPACE.md](WORKSPACE.md) owns the workspace bar, folder navigation, the rest of
the window layout and dialog styling. [WORKTREE.md](WORKTREE.md) owns Git worktree
behavior. [IDENTITY.md](IDENTITY.md) owns the product identity.

# Part 1: Specification

## AB1. Location

`workbench.activityBar.location` has a fifth value, `toolbar`, and it is the default:
the window's first column is the workspace bar, and a second strip of icons beside it
is one too many. At `toolbar` the view container icons sit in the title bar, left of
the layout controls, and the side bar draws no strip. `default` puts the icons back.

- A divider separates the icons from the layout controls. It is drawn only while at
  least one icon shows: every icon can be hidden, and a divider with nothing on one
  side is a stray mark.
- Icons that do not fit fold into the overflow action; they never cover the command
  center.
- Accounts and Manage move to the title bar, as they do at `top` and `bottom`.
- The icons live in the custom title bar, so without it - `customTitleBarVisibility`
  `never`, or `windowed` in full screen - they show nowhere, and a view is reached by
  its shortcut or the command palette, as the workspace toggle is (WORKSPACE.md W10.1).
  Choosing `toolbar` turns `never` back to `auto`, as choosing `top` or `bottom` does.

Each icon choosing its own bar is not built: one bar with one position needs no
filtering and no drag between bars, and the divider already says where navigation ends
and commands begin.

## AB2. Secondary side bar

The secondary side bar starts hidden (`workbench.secondarySideBar.defaultVisibility:
hidden`): the workspace bar already takes a column on the left, and taking the right
one as well on first run would leave the editor as the narrow middle of three.
`visibleInWorkspace` still works when it is set.

## AB3. Settings

| Setting | Default | Section |
| --- | --- | --- |
| `workbench.activityBar.location` | `toolbar`, where stock has `default` | AB1 |
| `workbench.secondarySideBar.defaultVisibility` | `hidden`, where stock has `visibleInWorkspace` | AB2 |

# Part 2: Technical Design

## AB4. Host and stored state

The host is upstream's `PaneCompositeBar`, so dragging, badges, the context menu and a click on
the active icon behave as in the activity bar. The storage keys are the activity
bar's, so what a person pinned, hid and reordered survives a move between locations.

The surrounding grid, workspace toggle and title-bar controls are specified in
[WORKSPACE.md W10.1](WORKSPACE.md#w101-the-grid-and-the-title-bar-row).

# Part 3: Acceptance

## AB5. Acceptance matrix

Levels and evidence follow [WORKSPACE.md W15](WORKSPACE.md#w15-test-levels-and-evidence);
the shared execution plan is [W19](WORKSPACE.md#w19-shared-test-plan).
The WS-45 through WS-47 ids are retained so existing test and procedure references
continue to name the same cases. Requirements are not claims that the implementation
already passes them.

| ID | Level | Setup and action | Required observation |
| --- | --- | --- | --- |
| WS-45 | I | Start at each of the five activity bar locations; change live from each location to each other one (20 changes), from Settings and from the context menu | Every cell: icons where the location puts them; no side bar strip at `toolbar`; the divider in all four theme kinds; the context menu lists five positions with the current one checked |
| WS-46 | I | At `toolbar`: reorder by a real OS drag, hide and pin an icon, click the active icon and another one, show a badge, then move to `default` and back | Reordering, hiding and pinning survive the round trip; the active icon collapses the side bar and another switches to it; badges as in the activity bar |
| WS-47 | I, H | Narrow the window from 1440 to 480 at `toolbar`; a fresh profile with and without `defaultVisibility: visibleInWorkspace` | Icons fold into the overflow and never overlap the command center; the secondary side bar starts hidden unless the setting says otherwise |
