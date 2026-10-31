# Interaction and interface

Layer 3. [Product](PRODUCT.md) prioritizes capability, familiarity and simplicity; [Rules](RULES.md) owns status/notification meaning.
This document owns common surfaces, presentation, accessibility, commands and settings. Feature documents own behavior.

| Group | Decides | Implementation evidence |
| --- | --- | --- |
| 1 Surfaces and words | Native controls, steps, progress and notification presentation | Pending |
| 2 Look and access | Theme, geometry, motion, keyboard and languages | Pending |
| 3 Commands | Titles, IDs, placement and target rules | Pending |
| 4 Settings | Values, scopes and external settings | Pending |
| 5 Technical design | Manifest, performance, localization and UI checks | Pending |

## 1 Surfaces and words

### 1.1 Use the editor's controls

**Use native Quick Pick for choices, Input Box for names and editor terminals for CLI interaction.**

The webview contains cards/empty state only. Context menus are native, flat and show relevant actions; no nested custom
popover or global chat composer. Multi-step choices retain one flow with Back and previous selections. Show validation
beneath the input while typing; asynchronous checks show busy and disable acceptance until complete. Cancel changes no
selection history or filesystem state. Accepted agent launches close the picker and show card/terminal immediately.

Use native view progress for initial loading and human Git operations, and existing card/terminal text for launch/setup.
No progress, success or copy notifications. Long operation diagnostics are in Show Agents Log. A button/key receives
immediate visual feedback without waiting for process/Git work. Routine errors keep relevant failure surfaces.

### 1.2 Notifications and errors

**A permitted notification says what happened in one short line and offers only relevant Show actions.**

RULES-3.4 and RULES-1.8 decide eligibility and error ownership. Errors use native error notifications. No ordinary
news/warning/progress toasts. Show a permitted human notification only in its related window. There is no durable
notification-recovery protocol. Example: `Could not start Ada: {CLI error}`. Show opens the exact source run or final
screen. No Retry or generic Learn More. Maximum 300 display code points including ellipsis; full diagnostic remains
available. Escape/neutralize Markdown and command URI syntax in user/CLI strings. Dismissal changes no lifecycle or
operation result. No routine reminder or success popup is introduced, and no exactly-once error-popup guarantee is
required.

### 1.3 Consistent wording

**Commands use a verb, Title Case and an ellipsis when they ask for another choice; explanatory text uses sentence case.**

Extension display name, activity-bar container and command category are `Facade Code`; a command's title agrees in
palette, menus and tooltips. Name objects as the person sees them,
with window/environment context only when needed. Use “working location” when a plain folder is possible, “worktree” for
a Git worktree. Never call a quiet CLI “done,” or a lost connection “exited.” CLI messages stay in the CLI's original
language.

## 2 Look and access

### 2.1 Theme and geometry

**The interface uses VS Code theme tokens, typography and spacing.**

| Part | Token/value |
| --- | --- |
| Text / secondary | `foreground` / `descriptionForeground` |
| Hover | `list.hoverBackground` |
| Selection | `list.activeSelectionBackground`, `list.activeSelectionForeground` even after panel loses focus |
| Keyboard focus | 1 px `list.focusOutline` inside row |
| Work / idle / error | `charts.green` / `charts.yellow` / `charts.red` |
| Status meaning and unknown evidence | RULES-3.2; second-line wording is PANEL-1.4 |
| Controls | `button.*`, `input.*`, `inputValidation.*`, `scrollbarSlider.*` |
| Typeface | Workbench font, 13 px body, 12 px secondary, 600 emphasis |
| Corners/inset | 4 px rows/buttons, 2 px fields, 4 px list side inset |

No contributed color palette. Custom avatars use a stable hash of the normalized CLI name to choose one of the editor's
`charts` colors, paired with contrast-tested foreground/background; in high contrast use `foreground` on
`sideBar.background` with `contrastBorder` if the chosen pair fails. Status colors are not reused as avatar meanings.
High contrast selection uses a dotted `contrastActiveBorder` outline, hover dashed, never over keyboard focus. Do not
fade high-contrast text. Other secondary selection text can use 80% opacity only if contrast remains adequate.
Whole-pixel layout at supported zoom; preserve diacritics/descenders. Paragraphs wrap, card lines ellipsize with full
accessible text.

### 2.2 Motion and responsive layout

**Motion is brief, does not delay input, and disappears when reduced motion is requested.**

Card insertion 180 ms and removal after a normal process exit 160 ms, `cubic-bezier(0.22,1,0.36,1)`; text fade 160 ms.
No motion on first draw/filter change. Explicit close and confirmed location removal remove the card and terminal immediately, without
animation. Dot and scrolling durations belong to PANEL. Long-running animation changes only opacity/transform. Follow
both `workbench.reduceMotion` and system preference. Test 180, 260, 420 and 720 px view widths plus editor minimum; no
overlap, horizontal overflow or hidden essential controls. Test zoom -1, 0, 2. Themes: Dark Modern, Light Modern, both
High Contrast, and Solarized Light. A failed contrast/layout case is a defect, not an intended unsupported theme.

### 2.3 Keyboard and screen readers

**The list follows familiar editor keyboard navigation and conveys every meaningful state without color or animation.**

One roving Tab stop; Tab/Shift+Tab leave. Up/Down/Home/End/Page Up/Page Down move focus, scroll minimally into view.
Typeahead combines characters within 750 ms and wraps to the next matching name. Enter/Space opens, F2 renames; native
context-menu key opens the current card's menu. Click focuses without a keyboard outline. Escape closes transient UI.
Use semantic listbox/options, aria-selected and current state labels. No unbounded live-region chatter.
No global shortcuts are preassigned; existing commands are bindable through normal Keyboard Shortcuts.

### 2.4 Languages and times

**All human-facing strings ship in English and eleven translated languages; the specification and API remain English.**

Languages: `zh-cn`, `zh-tw`, `pt-br`, `es`, `ru`, `de`, `ja`, `fr`, `ko`, `tr`, `pl`. Use VS Code's language selection
and English fallback. Facade Code, Facade, CLI and YOLO are not translated. Use Microsoft's established editor terms;
Chinese uses `agent`, `工作树` / `工作樹`. Relative times use `Intl.RelativeTimeFormat`; full timestamps are localized in
human details, UTC ISO strings in APIs/journals. Locale updates refresh text; API IDs/paths never change with locale.
Translations cover settings, pickers, errors, menus, access labels and empty states in the same implementation change.
Facade's own failure reasons - CLI configuration and worktree problems - reach the person in their language through one
presentation shared by pickers, notifications and cards; logs and API text stay English.

## 3 Commands

### 3.1 Public command catalog

**Every command has one `facade.` ID, one title and one behavioral owner.**

Listed commands appear in the Facade Code palette category subject to availability, except entries explicitly marked
as menu-only. Arguments bypass a picker only
when their schema fully identifies the target; invalid arguments fail without guessing. The table is the authoritative
command inventory, not a second description of behavior.

For Rename, Copy Agent Reference and Close Agent, a palette invocation without an explicit target uses PANEL-2.1's
current selected run. If no selected run exists or the action is unavailable for it, the command is unavailable; it does
not open a target picker. Rename still asks for the new name. Explicit arguments and card/tab context target that exact
run and are validated against current state, without falling back to the selection.

| ID after `facade.` | Title | Availability / other surface | Owner |
| --- | --- | --- | --- |
| `newAgent` | New Agent... | Always; panel/empty state | LIFECYCLE-1.1 |
| `showActiveAgents` | Go to Agent... | Always; Command Palette | LIFECYCLE-2.3 |
| `renameAgent` | Rename Agent... | Known owned record; card/F2 | LIFECYCLE-2.1 |
| `copyAgentReference` | Copy Agent Reference | Known owned record; card/Go to Agent | LIFECYCLE-2.1 |
| `closeAgent` | Close Agent | Any owned starting/live/retained-ended record; card | LIFECYCLE-3.1 |
| `filter` | Filter by Working Location... | Always; panel title | PANEL-2.3 |
| `clearFilter` | Clear Filter | Active filter; card/empty state | PANEL-2.3 |
| `configureAgents` | Configure Agents... | Always; panel `…` menu; opens native Settings filtered to `@ext:facade.facadecode` | UX-4.1 |
| `showAgentLaunch` | Show Agent Launch | Always; Command Palette | CLIS-4.1 |
| `showAgentsLog` | Show Agents Log | Always; Command Palette | ARCHITECTURE-3.3 |
| `newWorktree` | New Worktree... | Menu-only: panel `…` when a workspace folder is open; hidden from Command Palette | WORKTREES-2.1, 4.3 |

PANEL-1.1 places the editor's own Add Folder to Workspace... command in the view menu; it is not another `facade.` command.
Refresh, New Agent Here, Pin/Unpin Agent, the former working-location rename/navigation/copy/terminal commands and Message
History have no contributed entry or hidden compatibility alias. Facade Dots' `facade.agents.showLaunch` and
`facade.agents.showLog` are not aliases of Show Agent Launch and Show Agents Log.

### 3.2 Context and internal commands

**Context-only actions carry their actual target and never substitute the foreground agent.**

Hidden from palette: `newWorktree` (view-menu creation), `moveUp`, `moveDown`, `filterByLocation`, `filterByFolder`,
`filterOn` (filled-icon alias) and `revealAgent` (notification navigation). `filterOn` invokes exactly the same
behavior as `filter`. The worktree command follows WORKTREES-4.3. Tab Rename/Copy entries are contributed only on
editors/versions where public context can be resolved exactly; otherwise the card/palette remain available. No internal
`$mid` terminal-context trick. There is no scripted-start command. Retired `facade.nextAgent`, `facade.stopAgent` and
`facade.startAgent` commands are not registered as hidden aliases.

Test commands `state`, `selectRow` (selects a card by run ID) and `probe` are registered only in test mode and excluded
from production manifests/bundles. Context keys: `facade.hasAgents` includes any visible owned record; `agentSelected`
identifies PANEL-2.1's current selected run for 3.1's palette actions; `agentSelectedEnded` and `filtered` reflect current state.

## 4 Settings

### 4.1 Facade settings

**Settings configure future starts.**

| Setting | Type / default | Scope | Behavioral owner |
| --- | --- | --- | --- |
| `facade.yolo` | boolean; true | machine in execution environment | RULES-4.3 |
| `facade.<cli>.enabled` | boolean; true | machine in execution environment | CLIS-1.1 |
| `facade.<cli>.path` | string; empty | machine in execution environment | CLIS-1.2 |
| `facade.<cli>.launch` | object; `{}` | machine in execution environment | CLIS-3 |
| `facade.custom` | object; `{}` | machine in execution environment | CLIS-3.4 |

`<cli>` is `claude`, `codex`, `antigravity`, `muse`, `opencode` or `pi`. Settings sections in order: `Agents` (`facade.yolo`), then one section per built-in CLI in CLIS-1.1
order, then `Custom Agents` (`facade.custom`). Read on use and apply live where RULES-4.4 allows. Do not add an “agent
default CLI/model/worktree” setting. Local and remote values are clearly scoped in the editor.

### 4.2 Follow existing editor settings

**Where VS Code has a relevant setting, use it instead of another Facade setting.**

| Editor setting | Owner/use |
| --- | --- |
| `terminal.integrated.tabs.separator` | LIFECYCLE tab title |
| `terminal.integrated.confirmOnKill` | LIFECYCLE-3.1 close confirmation: `editor`/`always` ask, `never`/`panel` do not |
| `terminal.integrated.env.osx/linux/windows`, configured default-profile env | CLIS-1.2 owns the shared discovery/launch environment; shell startup scripts are not evaluated |
| Default terminal profile and shell | Ordinary Open Terminal Here terminals |
| `git.path`, `git.branchPrefix` | WORKTREES executable and creation |
| `git.worktreeIncludeFiles`, `git.worktreeSymlinkFolders` | WORKTREES setup where supported by editor version |
| `git.detectWorktreesLimit` | Catalog pagination hint, never authorization or silent loss of locations |
| `workbench.list.mouseWheelScrollSensitivity`, `fastScrollSensitivity`, `smoothScrolling`, `scrollByPage` | PANEL scrolling |
| `window.zoomLevel`, `workbench.reduceMotion` | Layout/motion |

Unsupported optional editor settings use the documented empty/default behavior and do not block plain-folder agent use.
Worktree creation uses the editor's native Git workflow through a supported, verified interface. Facade does not
create a parallel setup/task runner; missing native integration does not block ordinary-folder agents.

## 5 Technical design

### 5.1 Manifest and localization

**The manifest, runtime registrations and localized words match this catalog.**

Use `%key%` for manifest strings and `vscode.l10n.t` for runtime strings, all translations under `l10n/`. Build copies
manifest translations beside shipped `package.json`. Translation export/check tooling is repository-owned, pinned and
repeatable, not a temporary-file dependency. Validate missing/unused placeholders and keys in every locale. Treat
settings objects strictly; an unknown key or wrong type produces the actual configuration error, no silent fallback.

### 5.2 Work and update budgets

**Idle work is event-driven except for explicitly bounded liveness checks and operation deadlines.**

Panel state and update budgets follow PANEL-3.1. Card clicks select within one animation frame. Process supervisor
liveness reconciliation may run every 2 s while runs exist; connection observations follow ARCHITECTURE-2; a timer never
proves window closure. Metadata discovery follows WORKTREES/CLIS events. No idle polling when there are no open windows
or active owned processes. Background output has bounded backpressure and no layout work per terminal byte. Record
measured timings on release fixtures.

### 5.3 Visual acceptance

**Visible changes are inspected in an isolated real editor before implementation acceptance.**

Exercise light/dark/high-contrast/Solarized, representative widths/zoom, all language strings for overflow, keyboard and
screen reader labels. Capture screenshots and scenario/version evidence. Automated DOM tests supplement this inspection;
they cannot certify native picker placement, focus or remote terminal behavior. Never test in the owner's profile.

## Checks

| Rules | Acceptance |
| --- | --- |
| 1.1–1.3 | Native flows/cancel, no progress/success toasts, error wording/action target, language and naming consistency |
| 2.1–2.4 | Theme/width/zoom/motion/contrast, keyboard/screen reader, localization completeness |
| 3.1–3.2 | Manifest/registration catalog, selected-run palette actions after focus leaves the agent terminal, exact context targeting, unavailable without a target, test commands absent in production |
| 4.1–4.2 | Scope/default/type validation and live effects in local and remote windows |
| 5.1–5.3 | Localization/build audit, idle/update measurement and isolated visual evidence |

Evidence: [Verification](engineering/VERIFICATION.md). All runtime results remain pending until recorded there.

## Change log

- 2026-10-31: 2.1 gives custom CLIs their avatars' colors; 4.1 adds `facade.custom` in its own section, Custom Agents.

- 2026-10-30: 3.1 adds Show Agent Launch (CLIS-4.1) and Show Agents Log (ARCHITECTURE-3.3), Command Palette
  commands (D83); 4.1 adds each built-in's `.enabled` and `.launch`; 1.1 points long operation diagnostics to Show
  Agents Log.

- 2026-10-30: 3.1 adds Filter by Working Location... and Clear Filter (PANEL-2.3); 3.2 keeps the card's filters and
  the filled-icon alias out of the palette and adds the `filtered` context key; 2.2 keeps a filter change still.

- 2026-10-30: 4.1 adds the `.path` settings of Antigravity, Muse Code, OpenCode and Pi, each in its own section in
  CLIS-1.1 order (D77).

- 2026-10-30: 4.1 lists the step 1 settings for Claude Code and Codex, with `.enabled` and `.launch` in a later step;
  3.2 removes two context keys nothing sets or uses.

- 2026-10-30: Owner-approved: 4.2 follows `terminal.integrated.confirmOnKill` for LIFECYCLE-3.1's close confirmation;
  2.4 sends Facade's own failure reasons through one translated presentation instead of English text from lower layers.

- 2026-10-29: The owner clarifies that only the Command Palette entry is removed for New Worktree...; the view's
  `…` menu and its existing standalone creation flow remain. This supersedes the removal of both entries below.

- 2026-10-29: The owner removes standalone New Worktree... from the Command Palette and view menu. Git supplies
  standalone worktree creation; New Agent's contextual worktree option remains under LIFECYCLE-1.3.

- 2026-10-29: Applied the owner's IA-01 English entry review: Facade Code branding, the seven public command titles,
  Configure Agents... and palette-only Go to Agent.... Removed retired commands from the active catalog; their removal
  does not add replacement controls or change the settings schema. Other-language copy is outside this review.

- 2026-10-29: Step 1 of the Facade Code extension, carried from the Facade Dots specification: the rules step 1
  needs, each with its final number. Later steps add the others.
  Category `Facade Code`; settings `facade.yolo` and `facade.claude.*`.
