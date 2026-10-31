# Panel

Layer 3. The panel displays this window's agents. [Rules](../RULES.md) owns meanings; [UX](../UX.md) owns common
interaction and tokens. This document owns the card, list and webview contract. Runtime evidence is pending.

| Group | Decides | Implementation evidence |
| --- | --- | --- |
| 1 View and card | Loading, empty state, badge, content and geometry | Pending |
| 2 List and actions | Order, selection and menu | Pending |
| 3 Technical design | State transport, rendering, resources and scrolling | Pending |

## 1 View and card

### 1.1 One view of this window

**Facade Code has one webview view in its own activity-bar container and shows only this window's agents.**

Container `facade`, view `facade.agents`, title `Facade Code`, icon `media/facade.svg`; background activation uses
`onStartupFinished`. Opening the contributed view or invoking a contributed command can activate it on demand.
Until agent records are reconciled use native view progress and draw no false empty state. Git metadata does not block
card loading. Title actions in order: New Agent (`new-session`). The view's native `Views and More Actions...` (`…`) menu holds
Add Folder to Workspace... (the editor's command), then New Worktree... when a workspace folder is open, followed by
Message History... and Configure Agents... in a separate group. Go to Agent... is a Command Palette entry, not a
view-menu item. Facade commands
use the titles and flows in UX-3.1. The badge counts this window's cards, including starting, retained-error and temporarily disconnected
records. Tooltip `1 agent` / `{n} agents`; omit zero.

### 1.2 Empty states

**The empty state explains the current condition and offers the next relevant action.**

No folder: `Open a folder to launch agents.` with Open Folder. No agents:
`Launch an agent in this workspace.` with New Agent (primary). Empty-state buttons have no ellipsis, as VS Code's
welcome buttons do. Open Folder from this button or New Agent invokes the editor's `vscode.openFolder` command,
matching the built-in Git view's entry. The editor owns folder selection, window opening and the resulting view;
Facade does not record a return marker or automatically switch the sidebar back after activation. The person can
return through Facade Code's activity-bar icon. Do not display worktree tutorials when Git is absent. Paragraphs wrap;
buttons are native-themed and keyboard accessible. There is no composer field.

Invoking New Agent with no folder opens a native Quick Pick titled `New Agent`, with placeholder
`Open a folder to continue` and one item: `Open Folder...`, detail
`A workspace folder is required to run agents.` The placeholder identifies the next action and the detail explains
the prerequisite. Cancel changes nothing. Opening a folder uses the editor's normal behavior as above; it does not
automatically launch an agent. This prerequisite step does not ask the person to select a CLI.

### 1.3 Card geometry and identity

**A card is two lines beside a CLI avatar and status dot, with identity and location visible first.**

| Element | Value |
| --- | --- |
| Card | Minimum 44 px tall; padding 8 px top/bottom/left, 9 px right; 4 px corners |
| Avatar | 28 px circle, 8 px before text, 1 px theme border |
| First line | Name 13 px; location 12 px aligned at end; 6 px gaps |
| Second line | 12 px, quieter, single line with ellipsis |
| Dot | 10 px at avatar bottom right, offset 1 px outward, 2 px ring of current row background |
| Text block | Vertically centered; whole-pixel geometry; accents/descenders never clipped |

Use maker avatars in `media/agents/avatar-claude.png` and `avatar-codex.png`. Location is alias/branch/folder, prefixed by workspace folder in
a multi-folder window unless it is named that folder's name already, as a plain folder is (D66). A related worktree can
be outside a folder and still show its actual location. Confirmed location removal closes its affected agents; a
temporarily disconnected location is retained. The location keeps its own width, as a chat list keeps a message's time,
up to 40% of the line, and is cut beyond that; the name has the rest. A workspace-folder prefix is shown whole or not at
all (D72). Avatar/dot do not shrink. Full values remain in hover and accessibility.

### 1.4 Second line and dot

**The second line adds the most useful known fact without claiming task completion.**

Priority: retained failure or specific connection/status error; known native blocker; generic activity-unavailable
explanation; unavailable Facade tools; active startup stage; CLI title; creation prompt first line; fallback. When a
known native blocker coexists with unavailable activity, lead with the blocker and retain the status explanation, for
example `Sign-in required · Activity unavailable`.
A CLI that runs without its Facade tools says so in plain words, for example `Cannot work with other agents: move or rename {file} in this folder`,
and stays usable. A creation prompt's first line describes an agent that another agent started until its CLI reports a
title. Fallbacks: `Working`, `Ready for input`, `Activity unavailable`. Before any prompt, a proven ready CLI may say
`Ready for your first message`. Never `Done, waiting for you` from a turn end. Native blockers use CLI words or
`Needs permission`, `Sign-in required`, `Waiting for an answer`; no popup solely for them.

Dot semantics and precedence follow RULES-3.2; theme tokens follow UX-2.1. The text priority above does not change the
dot or notification rules. Working breathes every 1.8 s using opacity only (0–65% overlay of row background); reduced
motion is static. Hover explicitly says `Starting`, `Working`, `Idle`, `Error: {reason}` or `Activity
unavailable`; the accessible label preserves it. No unread dot, completed check, bold-name state or extra error badge.

### 1.5 Hover and accessible content

**Every fact cut from a card remains readable without relying on color.**

Card tooltip lines, one fact per line: name, short run ID and CLI; full title or creation prompt; state and reason;
started relative time and, for an agent started by an agent, its creator; qualified location; its path, the home folder
written `~` except on Windows; window. Accessible label: name, short run
ID, state, location, CLI, second line. Use a listbox named `Agents`,
options with `aria-selected`, decorative icons hidden, one roving Tab stop. Update labels in place. State-change
announcements are polite, coalesced, and do not repeatedly announce spinner/progress ticks.

## 2 List and actions

### 2.1 Order and selection

**The list is a manually reorderable stack; state changes do not move cards.**

A new card goes first, whether a person or an agent started it. Move Up/Down works within the list. Explicit close
removes a card immediately; no stopping card remains. There are no batch actions or automatic creation-tree grouping. Click selects immediately and reveals its terminal. Selection follows the last
active owned agent terminal, survives focus on a file/unrelated terminal, and disappears when that record is removed. A
failed launch remains selected. Keyboard focus and selection are independent.

### 2.2 Card menu

**A card uses a flat native context menu with only actions meaningful to its current record.**

Groups: Rename / Copy Agent Reference; Move Up/Down; Close Agent for starting, live and retained-ended
records. Enable actions by actual availability; name editing need not wait for CLI readiness. There is no worktree
deletion or bulk selection action. LIFECYCLE-3.1 owns the shared close action. No menu outside a card, not even the
webview's default Cut/Copy/Paste. Context targets its stable run ID, revalidated against current host state under 3.1,
never the selected row by fallback. Palette targeting follows UX-3.1.

## 3 Technical design

### 3.1 One state and one webview generation

**The model sends one coherent state per microtask and applies it only to the current page generation.**

State contains revision, loading, agents in order, card count, location metadata and capabilities. Agent run IDs remain
stable through launch. Badge and context keys come from the same state. Reported text/activity updates are coalesced to
at most once per 300 ms; real lifecycle/errors are sent without waiting for that coalescer. `ready` triggers a full
state and scroll settings. Webview-to-host actions carry the page generation and, for a targeted action, the stable run
ID. Ignore actions from a replaced page generation; the host validates current-page actions against current state and
never substitutes another row. Async replies go only to the generation that asked. An action correlation ID is an
implementation detail when needed to match a reply; no expected revision is required on every action. Test-only probes
never ship.

Update `src/ui/model.ts`, `src/ui/panel.ts`, `src/webview/panel.ts` together. Webview sends `ready`,
validated `act` (`open`, `new`, `openFolder`, `rename`), and diagnostic `error`; host sends `state`, `scrolling`, and
matching action outcomes. These acts serve the empty-state buttons in 1.2 and F2 under UX-2.3; `rename` asks the host to
open the native Input Box, and the host validates the target. Context menu commands run in the host through validated
targets. Page-held state is navigation/typeahead/scroll, not business rules. Use the webview's saved page state to
restore the still-valid scroll position and keyboard navigation target when the person hides and reopens the view;
restoring a navigation target does not take actual input focus. Rebuild current cards from the host model and discard a
navigation target that no longer exists. Use this saved page state without a host persistence service or
retainContextWhenHidden; keep cards keyed and avatars reused within a page.

### 3.2 Security and resource use

**The webview loads only bundled resources and renders all outside strings as text.**

CSP:
`default-src 'none'; style-src <cspSource>; font-src <cspSource>; img-src <cspSource>; script-src 'nonce-<nonce>';`.
Nonce is 16 random bytes per page. Escape `<` in embedded localization JSON, use textContent for CLI/user strings,
validate incoming actions and reject unknown keys/types. Local resource roots are only bundled media/webview output. No
external image fetches, remote scripts, injected HTML, command links from messages or secrets in state. Cards, focus, open context framing and avatar
nodes survive ordinary text changes; initial draw does not animate.

### 3.3 Scrolling

**Scrolling follows VS Code's list settings and remains usable by wheel, trackpad, scrollbar and keyboard.**

Respect `mouseWheelScrollSensitivity` (default 1), `fastScrollSensitivity` (default 5 with Alt), `smoothScrolling`,
`scrollByPage`, and zoom. Wheel baseline 50 px per line; normalize Chromium wheel delta/120, else line delta, else
pixel delta/40; round away from zero to whole pixels. Predominantly horizontal movement does not scroll vertically;
Ctrl-wheel is left to the editor. No overscroll/page scroll at list ends. Trackpad movement tracks fingers; mouse-wheel
smoothing is 125 ms cubic ease-out only when enabled, canceled by keyboard/drag. Wheel/trackpad classification is an
implementation adapter verified against current VS Code behavior, not guessed from one event.

Overlay scrollbar: 8 px at right, 4 px top/bottom inset, minimum thumb 20 px, 4 px corners, theme scrollbarSlider colors.
Show on hover/scroll, fade in 100 ms; after 500 ms without activity fade out 800 ms. No bar when content fits. Click
centers and begins drag unless scrollByPage is enabled, when it moves a viewport toward the click. Reduced motion
removes fades/glides. Keyboard Page Up/Down moves fully visible row count minus one (minimum one).

## Checks

| Rules | Acceptance |
| --- | --- |
| 1.1–1.5 | Approved title/menu entries, both empty states and the no-folder New Agent prerequisite, slow/no Git, three dot meanings, known blocker before generic unavailable text without losing that explanation, all widths/themes/accessibility |
| 2.1–2.2 | Stack insertion and manual order, retained failure, exact context target |
| 3.1–3.3 | Generation-isolated replies/actions with current target validation, coherent badge, XSS/command-link payloads, hide/show browsing-position restore without focus theft, input-to-paint and scrolling |

Evidence: [Verification](../engineering/VERIFICATION.md). Visual tests use an isolated editor profile.

## Change log

- 2026-10-30: Step 2 of the Facade Code extension: 1.1 adds Message History... to the view menu; 1.4 adds an
  unavailable-tools explanation and a creation prompt's first line; 1.5 names an agent's creator; 2.1 places agent-started
  cards like any other without tree grouping; 3.2 renders no command links from messages.

- 2026-10-30: 1.3 adds the Codex avatar; 3.1 names the current source paths.

- 2026-10-30: Apply the three-reviewer approved IA wording for status, location actions and failure feedback; behavior and deletion safeguards remain unchanged.

- 2026-10-29: The owner clarifies that New Worktree... remains in the view's `…` menu and is hidden only from the
  Command Palette. This corrects the earlier removal of both entries.

- 2026-10-29: Removed standalone New Worktree... from the view menu at the owner's request; standalone creation
  belongs to Git. Add Folder to Workspace... and Configure Agents... remain in their existing groups.

- 2026-10-29: The owner revises D61 to match Git: both Open Folder entries use the native command and leave sidebar
  selection to the editor. Remove the automatic return and its marker/timeout; restore `onStartupFinished` activation.
  This supersedes the earlier automatic-return and early-activation decisions below.

- 2026-10-29: The owner requests earlier activation for the Open Folder return: use `*` instead of
  `onStartupFinished`. Whether this removes the visible Explorer transition remains a runtime verification item.
  The container menu's tooltip is the editor-owned `Views and More Actions...`, not extension-controlled copy.

- 2026-10-29: Applied the owner's IA-01 and IA-02 English review: the view menu follows the approved global entries;
  empty states omit redundant `coding`; the no-folder New Agent picker explains the folder prerequisite instead of
  asking for a CLI. Removed the retired New Agent Here menu entry. This records the agreed design, not runtime evidence.

- 2026-10-29: Chat-style card truncation (D72); the card hover gives each fact its own line, with the path (D74).
- 2026-10-29: Step 1 of the Facade Code extension, carried from the Facade Dots specification: the rules step 1
  needs, each with its final number. Later steps add the others.
  View `facade.agents`, icon `media/facade.svg`.
