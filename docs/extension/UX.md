# Interaction and interface

Layer 3. [Product](PRODUCT.md) prioritizes capability, familiarity and simplicity; [Rules](RULES.md) owns status/notification meaning.
This document owns common surfaces, presentation, accessibility, commands and settings. Feature documents own behavior.

| Group | Decides |
| --- | --- |
| 1 Surfaces and words | Native controls, steps, progress and notification presentation |
| 2 Look and access | Theme, geometry, motion, keyboard and languages |
| 3 Commands | Titles, IDs, placement and target rules |
| 4 Settings | Values, scopes and external settings |
| 5 Technical design | Manifest, performance, localization and UI checks |

## 1 Surfaces and words

### 1.1 Use the editor's controls

**Use native Quick Pick for choices, Input Box for names and editor terminals for CLI interaction.**

The webview contains cards, their details (PANEL-1.5) and the empty state only. Context menus are native, flat and
show relevant actions, opened from a card's gear (PANEL-2.2); no other custom popover and no global chat composer. Multi-step choices retain one flow with Back and previous selections. Show validation
beneath the input while typing; asynchronous checks show busy and disable acceptance until complete. Cancel changes no
selection history or filesystem state. A person's accepted launch closes the picker and shows card and terminal
immediately; an agent's start shows its card (LIFECYCLE-2.2).

Use native view progress for initial loading and human Git operations, and existing card/terminal text for launch/setup.
No progress, success or copy notifications. Long operation diagnostics are in Show Agents Log. A button/key receives
immediate visual feedback without waiting for process/Git work. Routine errors keep relevant failure surfaces.

### 1.2 Notifications and errors

**A permitted notification says what happened in one short line and offers only relevant actions.**

RULES-3.4 and RULES-1.8 decide eligibility and error ownership. Errors use native error notifications; explicit
agent-to-person messages use native information notifications, even while that agent is viewed. No ordinary
news/warning/progress toasts. Agent-operation errors return to the caller; no message-delivery or result-handoff failure
creates a human popup. Show a permitted human notification only in its related window. There is no durable
notification-recovery protocol. Example: `Could not start Ada: {CLI error}.` Show opens the exact source run or final
screen; a launch that failed on its CLI's configuration also offers Configure Agents, and ARCHITECTURE-4.3's
missing-component notice offers Show Window Component, while Reload Window comes on a notice of its own once the
component answers. A message to the person reads `{agent name}
#aN: {first line of the message}` (`#aN: ...` for an empty name) and offers `Open Message`, which opens the complete
message read-only, then `Show Agent`, which opens that agent's terminal. No Retry or generic Learn More. Maximum 300
display code points including ellipsis; full diagnostic or message remains available. Escape/neutralize Markdown and
command URI syntax in user/CLI/agent strings. Dismissal changes no lifecycle or operation result. No routine reminder or
success popup is introduced, and no exactly-once error-popup guarantee is required.

### 1.3 Consistent wording

**Commands use a verb, Title Case and an ellipsis when they ask for another choice; explanatory text uses sentence case.**

Extension display name, activity-bar container and command category are `Facade Code`; a command's title agrees in
palette, menus and tooltips. Name objects as the person sees them,
with window/environment context only when needed. Use “working location” when a plain folder is possible, “worktree” for
a Git worktree. Never call submitted input “read,” a quiet CLI “done,” or a lost connection “exited.” CLI messages stay
in the CLI's original language. API/system messages to agents are English.

Words a person sees - commands, settings descriptions, notifications, cards, pickers and history - describe agents,
windows, messages and what happened in plain language. They never use internal terms such as run, run ID, ptyd, shim,
MCP server, capability, adapter, route, protocol or broker; an agent's own reference such as `#a7` may appear where the
person needs to tell agents apart. A failure says what did not happen and what the person can do, not which internal
part failed.

Edited English uses serial commas, direct imperative picker hints and concise status phrases, which may omit articles.
Facade's terminal notices use objective prose without first-person narration or contractions; call the CLI's message
entry surface its terminal input. Keep failure reasons grammatical when inserted into a surrounding sentence, with
no repeated failure prefix. Short fixed phrases fit their surface; a character budget never truncates a full title,
path, dynamic diagnostic or message that the owning rule requires to remain available. Localized prose follows each
language's natural grammar while preserving placeholders, product names and the same known or uncertain outcome.

## 2 Look and access

### 2.1 Theme and geometry

**The interface uses VS Code theme tokens, typography and spacing.**

| Part | Token/value |
| --- | --- |
| Text / secondary | `foreground` / `descriptionForeground` |
| Hover | `list.hoverBackground` |
| Selection | `list.activeSelectionBackground`, `list.activeSelectionForeground` even after panel loses focus |
| Keyboard focus | 1 px `list.focusOutline` inside row, kept while a context menu is open; the card a menu is open on gets no other frame |
| Busy / problem dot | `charts.green` / `charts.red`; no dot for anything else |
| Status meaning and unknown evidence | RULES-3.2; second-line wording is PANEL-1.4 |
| Controls | `button.*`, `input.*`, `inputValidation.*`, `scrollbarSlider.*` |
| Typeface | Workbench font, 13 px body, 12 px secondary, 600 emphasis |
| Corners/inset | 4 px rows/buttons, 2 px fields, 4 px list side inset |

No contributed color palette. A custom CLI's avatar uses a stable hash of its normalized name to choose `charts.blue`,
`charts.orange` or `charts.purple` as a 30% tint over `sideBar.background` behind `foreground`; in any theme where that
pair has less than 4.5:1 contrast it falls back to a 12% tint, then to `sideBar.background` alone. Status colors are not
reused as avatar meanings. High contrast selection uses a dotted `contrastActiveBorder` outline, hover dashed, never
over keyboard focus. Do not fade high-contrast text. Other secondary selection text uses 80% opacity only where it
keeps 4.5:1 on the theme's selection, the page measuring it as the theme draws it, and full opacity otherwise; a card's
details draw their quieter words and icons in the quieter color only where it keeps 4.5:1 on
`editorHoverWidget.background`, the text color otherwise (PANEL-1.5). Where a theme's `descriptionForeground` is its
`foreground` - Light Modern's is - nothing would read as quieter: the panel's quieter text and icons take `foreground`
at 75%, the dimming chosen for them, where that keeps 4.5:1 on `sideBar.background` and on
`editorHoverWidget.background`, and `foreground` whole otherwise; a high contrast theme keeps its colors whole. A card's buttons use the toolbar's `toolbar.hoverBackground` and `toolbar.activeBackground`,
their 14 px icons at rest in the quieter color with PANEL-1.3's exceptions - a selected card's, high contrast's and the
75% `foreground` above - and `icon.foreground` under the pointer or pressed (PANEL-1.3). Whole-pixel layout at supported zoom; preserve diacritics/descenders. Paragraphs wrap, card lines
ellipsize with full accessible text.

### 2.2 Motion and responsive layout

**Motion is brief, does not delay input, and disappears when reduced motion is requested.**

Durations and curves are Fluent's, chosen and decided: a card's insertion 200 ms, `cubic-bezier(0,0,0,1)`, as its normal motion enters; a
card in view after a normal process exit fades as its row closes up from its own height in 150 ms, `cubic-bezier(1,0,1,1)`,
as its fast motion leaves - one out of view or cut by an edge, or the list gliding, goes at once; a card's details enter
as Fluent's popover does, fading in as they slide 10 px in from the ⓘ's side over 400 ms, `cubic-bezier(0,0,0,1)`, and
leave at once (PANEL-1.5); text changes in place. No motion on first draw/filter change. End Agent and confirmed location removal remove the card and terminal
immediately, without animation. Dot and scrolling durations belong to PANEL. Long-running animation changes only
opacity/transform. The panel and a busy tab's spinner (LIFECYCLE-2.2) follow both `workbench.reduceMotion` and the
system preference; as the extension host cannot read the system preference, the tab takes it from the panel's page, and
under `auto` keeps one frame still until the page has reported that motion is allowed. Test 180, 260, 420 and 720 px
view widths plus editor minimum; no overlap, horizontal overflow or hidden essential controls. Test zoom -1, 0, 2.
Themes: Dark Modern, Light Modern, both High Contrast, and Solarized Light. A failed contrast/layout case is a defect,
not an intended unsupported theme.

### 2.3 Keyboard and screen readers

**The list follows familiar editor keyboard navigation and conveys every meaningful state without color or animation.**

One roving Tab stop; Tab/Shift+Tab leave. Up/Down/Home/End/Page Up/Page Down move focus, scroll minimally into view.
Typeahead combines characters within 750 ms and wraps to the next matching name; a Space within that time continues the
typeahead. Otherwise Enter/Space opens, F2 renames; Shift+F10 or the menu key opens the current card's menu under its gear
(PANEL-2.2). Show Agent Details (3.1) opens the selected card's details with the focus in them: the arrows, Page Up/Down,
Home and End scroll them and never the list, Tab and Shift+Tab leave and close them, Escape takes the focus back to the
card; copy, selection and a screen reader's keys stay theirs. A click focuses without a keyboard outline; a press on a card's button puts the keyboard on that card, never on the
button, and never reaches the card's own click, the press itself changing no selection - a Pin or Unpin then selects
and shows its card's tab as LIFECYCLE-3.4 says; and
the card a menu is open on gets no other frame than its keyboard outline, unlike the editor's own lists (2.1). Escape
closes transient UI, a card's details among it. Use semantic listbox/options,
aria-selected and current state labels. No unbounded live-region chatter. No global shortcuts are preassigned; existing
commands are bindable through normal Keyboard Shortcuts.

### 2.4 Languages and times

**All human-facing strings ship in English and eleven translated languages; the specification and API remain English.**

Languages: `zh-cn`, `zh-tw`, `pt-br`, `es`, `ru`, `de`, `ja`, `fr`, `ko`, `tr`, `pl`. Use VS Code's language selection
and English fallback. Facade Code, Facade, CLI, MCP and YOLO are not translated. Use Microsoft's established editor
terms; Chinese keeps the English word `Agent`, capitalized in every string, and uses `工作树` / `工作樹`. Resume list times
and a card's details' start follow the time steps and rounding of VS Code's short `fromNow` helper, with `ago` retained,
the chosen `just now` replacing its `now` phrase below 30 rounded seconds; then seconds, minutes, hours, days, weeks, months and years. Use the editor's translated singular/plural phrases. Units
change at 60 seconds, 60 minutes, 24 hours, 7 days, 30 days and 365 days; round the selected unit as VS Code does. Do
not replace elapsed days with calendar labels or automatically switch old history to dates. A future source timestamp is
shown as a localized absolute time instead of an invented recent activity. Within a sentence - `Started 5 mins ago` - the
time's first letter is in lower case, as a language's word that begins a list's line - `Vor`, `Il y a` - would not be
there. Full timestamps are localized in human details, UTC ISO strings in APIs/journals. Locale
updates refresh text; API IDs/paths never change with locale. Translations cover settings, pickers, errors, menus,
access labels and empty states in the same implementation change. Facade's own failure reasons - CLI configuration and
worktree problems, another window owning the workspace, a working location gone or not in this window, no agent or
message number, a window component too old, a conversation its CLI cannot pin, an installation an update or uninstall
removed - reach the person in their language through one presentation shared by pickers, notifications and cards, never
with an internal ID such as a location's; a system's, Git's or a CLI's own error keeps its own words. Logs and the text
agents read stay English.

## 3 Commands

### 3.1 Public command catalog

**Every command has one `facade.` ID, one title and one behavioral owner.**

Listed commands appear in the Facade Code palette category subject to availability, except entries explicitly marked
as menu-only. Arguments bypass a picker only
when their schema fully identifies the target; invalid arguments fail without guessing. The table is the authoritative
command inventory, not a second description of behavior.

For Rename, Pin, Unpin, End Agent and Show Agent Details, a palette invocation without an explicit target uses
PANEL-2.1's current selected run. If no selected run exists or the action is unavailable for it, the command is unavailable; it does not
open a target picker. Rename still asks for the new name. Explicit arguments and the card menu target that exact run and
are validated against current state, without falling back to the selection.

| ID after `facade.` | Title | Availability / other surface | Owner |
| --- | --- | --- | --- |
| `newAgent` | New Agent... | Always; panel/empty state | LIFECYCLE-1.1 |
| `history` | Resume Agent... | Always; panel/empty state | LIFECYCLE-3.2 |
| `pinAgent` | Pin Agent | Unpinned agent whose CLI can resume its exact conversation, before it names one too; the card's Pin button | LIFECYCLE-3.4 |
| `unpinAgent` | Unpin Agent | Pinned record; the card's Pin button | LIFECYCLE-3.4 |
| `showActiveAgents` | Go to Agent... | Always; Command Palette | LIFECYCLE-2.3 |
| `renameAgent` | Rename Agent... | Known owned record; card/F2 | LIFECYCLE-2.1 |
| `closeAgent` | End Agent | Any owned starting/live/retained-ended record; card | LIFECYCLE-3.1 |
| `showAgentDetails` | Show Agent Details | A selected record whose card the filter shows; the card's ⓘ | PANEL-1.5 |
| `filter` | Filter by Working Location... | Panel title and Command Palette, except where every agent works in the window's one place to work and no filter is on | PANEL-2.3 |
| `configureAgents` | Configure Agents... | Always; panel `…` menu; opens native Settings filtered to `@ext:facade.facadecode` | UX-4.1 |
| `showAgentLaunch` | Show Agent Launch... | Always; Command Palette | CLIS-4.1 |
| `showAgentsLog` | Show Agents Log | Always; Command Palette | ARCHITECTURE-3.3 |
| `newWorktree` | New Worktree... | Menu-only: panel `…` when a workspace folder is open; hidden from Command Palette | WORKTREES-2.1, 4.3 |

PANEL-1.1 places the editor's own Add Folder to Workspace... command in the view menu; it is not another `facade.` command.
This table and 3.2 list every command Facade contributes; there are no others and no aliases. Some actions are
deliberately not commands: Go to Agent's item button copies an agent's reference (LIFECYCLE-2.3), the filter picker's
first item and the filtered empty state's button clear a filter (PANEL-2.3, 1.2), and a message to the person opens from
its notification (UX-1.2).

### 3.2 Context and internal commands

**Context-only actions carry their actual target and never substitute the foreground agent.**

Hidden from palette: `newWorktree` (view-menu creation), `moveUp` (Move Up) and `moveDown` (Move Down) in the card menu,
`filterOn` (the filled-icon form of `filter`, shown while a filter is active) and `revealAgent` (Show Agent,
notification navigation). The worktree command follows WORKTREES-4.3. Facade contributes no terminal-tab context
entries; the card's gear menu covers Rename, Move Up, Move Down and End Agent, its Pin button pinning and unpinning
(PANEL-1.3, 2.2), and the palette's selected-agent actions Rename, Pin, Unpin, End Agent and Show Agent Details (3.1), and no internal
`$mid` terminal-context trick is used. There is no scripted-start command; UI and MCP use the same internal launch
service.

The two components exchange requests only through the uncontributed commands ARCHITECTURE-1.1 names: they validate
every argument, appear in no palette or menu and are not a public API.

Test commands `state`, `selectRow` (selects a card by run ID), `probe`, `screen`, `testPaste`, `messageInput` and
`diagnostics` (the diagnostics report, ARCHITECTURE-3.3) are registered only in test mode and excluded from production
manifests/bundles. Context keys: `facade.hasAgents` includes any visible owned record; `agentSelected` identifies
PANEL-2.1's current selected run for 3.1's palette actions; `agentSelectedEnded`, `agentSelectedPinned`,
`agentSelectedPinnable` and `filtered` reflect current state; `agentSelectedVisible` says the selected run's card is
shown, no filter hiding it (PANEL-2.3); `onePlace` says every agent works in the window's one
place to work (LIFECYCLE-1.3).

## 4 Settings

### 4.1 Facade settings

**Settings configure future starts; required name/window/location/CLI remain explicit for agent launches.**

| Setting | Type / default | Scope | Behavioral owner |
| --- | --- | --- | --- |
| `facade.yolo` | boolean; true | machine in execution environment | RULES-4.3 |
| `facade.collaboration.enabled` | boolean; true | machine in execution environment | RULES-4.4 |
| `facade.<cli>.enabled` | boolean; true | machine in execution environment | CLIS-1.1 |
| `facade.<cli>.path` | string; empty | machine in execution environment | CLIS-1.2 |
| `facade.<cli>.launch` | object; `{}` | machine in execution environment | CLIS-3 |
| `facade.custom` | object; `{}` | machine in execution environment | CLIS-3.4 |

`<cli>` is `claude`, `codex`, `antigravity`, `muse`, `opencode` or `pi`. Settings sections in order: `Agents`
(`facade.yolo`, `facade.collaboration.enabled`), then one section per built-in CLI
in CLIS-1.1 order, then `Custom Agents` (`facade.custom`). Descriptions say what changes for the person, for example
that agents can start, message and control other agents, and that a change applies to agents started afterwards. Read on
use and apply live where RULES-4.4 allows. A value of the wrong type in `facade.yolo` refuses the launch with the
reason, because the run's permissions depend on it; one in `facade.collaboration.enabled` starts agents without the
Facade tools, with the reason in the agents log. How long a start or stop is waited for is no setting (MCP-1.3). Do not add
an “agent default CLI/model/worktree” setting. Local and remote values are clearly scoped in the editor. The window
components' network has no settings; it shares the same OS-user desktop boundary.

### 4.2 Follow existing editor settings

**Where VS Code has a relevant setting, use it instead of another Facade setting.**

| Editor setting | Owner/use |
| --- | --- |
| `terminal.integrated.env.osx/linux/windows`, configured default-profile env | CLIS-1.2 owns the shared discovery/launch environment; shell startup scripts are not evaluated |
| `git.path`, `git.branchPrefix` | WORKTREES executable and creation |
| `git.worktreeIncludeFiles`, `git.worktreeSymlinkFolders` | WORKTREES setup where supported by editor version |
| `git.detectWorktreesLimit` | Catalog pagination hint, never authorization or silent loss of locations |
| `workbench.list.mouseWheelScrollSensitivity`, `fastScrollSensitivity`, `smoothScrolling`, `scrollByPage` | PANEL scrolling |
| `workbench.experimental.modernUI` | PANEL-3.3 scrollbar appearance |
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
proves window closure. Metadata discovery follows WORKTREES/CLIS events. History reads happen only on picker/API
request. Message checks occur only at RULES-1 attempt slots; no typing-timer loop. An MCP call sends no progress
notifications (MCP-1.3); it raises no human popup either. No idle polling when there are no open windows or active owned
processes. Background output has bounded backpressure and no layout work per terminal byte. Record measured timings on
release fixtures.

### 5.3 Visual acceptance

**Visible changes are inspected in an isolated real editor before implementation acceptance.**

Exercise light/dark/high-contrast/Solarized, representative widths/zoom, all language strings for overflow, keyboard and
screen reader labels. Capture screenshots and scenario/version evidence. Automated DOM tests supplement this inspection;
they cannot certify native picker placement, focus or remote terminal behavior. Never test in the owner's profile.

## Checks

| Rules | Acceptance |
| --- | --- |
| 1.1–1.3 | Native flows/cancel, no progress/success toasts, error wording/action target, message-to-person notification, plain words without internal terms, language and naming consistency |
| 2.1–2.4 | Theme/width/zoom/motion/contrast, keyboard/screen reader, localization completeness |
| 3.1–3.2 | Manifest/registration catalog, selected-run palette actions after focus leaves the agent terminal, exact context targeting, unavailable without a target, test commands absent in production |
| 4.1–4.2 | Scope/default/type validation, future-only collaboration switch and wait setting, live effects in local and remote windows |
| 5.1–5.3 | Localization/build audit, idle/update measurement and isolated visual evidence |

Evidence: [Verification](engineering/VERIFICATION.md).
