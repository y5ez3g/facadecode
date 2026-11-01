# Panel

Layer 3. The panel displays this window's agents. [Rules](../RULES.md) owns meanings; [UX](../UX.md) owns common
interaction and tokens. This document owns the card, list, filter and webview contract. Runtime evidence is pending.

| Group | Decides | Implementation evidence |
| --- | --- | --- |
| 1 View and card | Loading, empty state, badge, content and geometry | Pending |
| 2 List and actions | Order, selection, menu and filtering | Pending |
| 3 Technical design | State transport, rendering, resources and scrolling | Pending |

## 1 View and card

### 1.1 One view of this window

**Facade Code has one webview view in its own activity-bar container and shows only this window's agents.**

Container `facade`, view `facade.agents`, title `Facade Code`, icon `media/facade.svg`; background activation uses
`onStartupFinished`. Opening the contributed view or invoking a contributed command can activate it on demand.
Until agent records are reconciled use native view progress and draw no false empty state. Git metadata does not block
card loading. Title actions in order: Filter by Working Location (`filter`, filled when active), Resume Agent (`history`), New Agent
(Facade's own copy of the `new-session` codicon, shipped with the extension, D85), so New Agent is rightmost.
The view's native `Views and More Actions...` (`…`) menu holds
Add Folder to Workspace... (the editor's command), then New Worktree... when a workspace folder is open, followed by
Configure Agents... in a separate group. Message History..., Go to Agent..., Show Agent Launch and Show Agents Log
are Command Palette entries, not view-menu items (D83, D129). Facade commands
use the titles and flows in UX-3.1. The badge counts this window's cards, including starting, retained-error and temporarily disconnected
records. Tooltip `1 agent` / `{n} agents`; omit zero. A display filter does not change the underlying card count.

### 1.2 Empty and filtered states

**The empty state explains the current condition and offers the next relevant action.**

No folder: `Open a folder to launch agents.` with Open Folder. No agents:
`Launch an agent in this workspace.` with New Agent (primary) and Resume Agent (secondary). No matching cards with a filter:
`No agents found in "{location}".`, then `{n} other agents are in this workspace.` (`1 other agent is in this
workspace.`; omitted when no other card exists), Clear Filter (primary) and New Agent (secondary), which starts at the
filtered location (LIFECYCLE-1.2). Empty-state buttons have no ellipsis, as VS Code's
welcome buttons do. Open Folder from this button or New Agent invokes the editor's `vscode.openFolder` command,
matching the built-in Git view's entry. The editor owns folder selection, window opening and the resulting view;
Facade does not record a return marker or automatically switch the sidebar back after activation. The person can
return through Facade Code's activity-bar icon. Do not display worktree tutorials when Git is absent or make an empty
filter look like all agents ended. Paragraphs wrap; buttons are native-themed and keyboard accessible. There is no
composer field.

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
| Pin | 14 px icon box after the name, 4 px from it; adds no card height |
| Second line | 12 px, quieter, single line with ellipsis |
| Dot | 10 px at avatar bottom right, offset 1 px outward, 2 px ring of current row background |
| Text block | Vertically centered; whole-pixel geometry; accents/descenders never clipped |

Use maker avatars in `media/agents`: `avatar-claude.png`, `avatar-codex.png`, `avatar-antigravity.png`,
`avatar-muse.png`, `avatar-opencode.png` and `avatar-pi.png`. Custom avatars are an uppercased first grapheme in a
circle; deterministic theme colors from UX-2.1. Location is alias/branch/folder, prefixed by workspace folder in a
multi-folder window unless it is named that folder's name already, as a plain folder is (D66). A related worktree can be
outside a folder and still show its actual location. Confirmed location removal closes its affected agents; a
temporarily disconnected location is retained. Reserve the Pin's measured width and spacing when present, then let
name and location share the first line's remaining width: a short one
stays whole and the other uses the remaining room. Only when both exceed their shares does the line divide about 60%
to the name and 40% to location; 40% is not a location cap (D128, superseding D72). A long name ellipsizes at the end.
Location keeps its `folder · worktree` structure: each long component ellipsizes in the middle, between whole graphemes,
keeping its beginning and end where they fit. A short component stays whole; when both are long, the worktree receives
about two thirds of their text space. The separator remains and the folder is never hidden just because it is long.
These shares are width limits, not reserved empty boxes: after fitting whole graphemes, give unused folder space to
the worktree, then any remaining space back to the folder. Render each fitted component at its measured width and
align their compact group at the line's end. Only the separator's normal spaces separate the two visible labels;
unused allocation must not appear before the separator or after the worktree. Any final spare width is available to
the name, up to its natural width.
Measure in the displayed font and available pixels, not a fixed character count; refit on resize, font changes, rename
and location updates. Avatar/dot do not shrink. Full values remain in hover and accessibility; the panel header is unchanged.

Pinned cards show the Pin beside the name, with its restoration meaning in a tooltip. Its color follows the quieter
text, including the selected foreground at 80% opacity; high-contrast selections use full opacity. The icon's internal
space keeps its visible shape smaller than the name's letters (D122).

### 1.4 Second line and dot

**The second line adds the most useful known fact without claiming task completion.**

Priority: retained failure or specific connection/status error; known native blocker; generic activity-unavailable
explanation; unavailable Facade tools; active startup stage, active until the CLI first shows its activity (CLIS-2.3);
CLI title; creation prompt first line; fallback. When a known native blocker coexists with unavailable activity, lead with
the blocker and retain the status explanation, for example `Sign-in required · Activity unavailable`.
A CLI that runs without its Facade tools says so in plain words, for example `Cannot work with other agents: move or rename {file} in this folder`,
or `Cannot work with other agents: its Facade tools stopped` once its tools went away (D136), and stays usable. A creation prompt's first line describes an agent that another agent started until its CLI reports a
title. Fallbacks: `Working`, `Ready for input`, `Activity unavailable`. Before any prompt, a proven ready CLI may say
`Ready for your first message`. Never `Done, waiting for you` from a turn end. Normal work/idle shows the CLI title or
creation prompt directly, without a repeated `Working`/`Idle` prefix. Native blockers lead with `Needs permission`,
`Sign-in required` or `Waiting for an answer`, followed by the CLI's original words when present. Errors lead with
`Error: {reason}`; unavailable activity names that state before its explanation. No popup solely for a native blocker (D127).

Dot semantics and precedence follow RULES-3.2; theme tokens follow UX-2.1. The text priority above does not change the
dot or notification rules. Working breathes every 1.8 s using opacity only (0–65% overlay of row background); reduced
motion is static. Hover explicitly says `Starting`, `Working`, `Idle`, the native blocker's kind, `Error: {reason}` or
`Activity unavailable`; the accessible label preserves it. No unread dot, completed check, bold-name state or extra error badge.

### 1.5 Hover and accessible content

**Every fact cut from a card remains readable without relying on color.**

Card tooltip lines, one fact per line: name, short run ID and CLI; full title or creation prompt; state and reason; for
a working agent, how long ago its CLI reported that work, `Reported working 25 min. ago` - the CLI's last word, which a long
silence leaves for the person to judge rather than turning it into idle or done, following competitive analysis of
last-update indicators (D114);
started relative time and, for an agent started by an agent, its creator; qualified location; its path, the home folder
written `~` except on Windows; window. Accessible label: name, short run
ID, state, location, CLI, second line. Use a listbox named `Agents`,
options with `aria-selected`, decorative icons hidden, one roving Tab stop. Update labels in place. State-change
announcements are polite, coalesced, and do not repeatedly announce spinner/progress ticks.

## 2 List and actions

### 2.1 Order and selection

**The list is a manually reorderable stack with Pins first; state changes do not move cards.**

A new card goes first, whether a person or an agent started it, below the Pin area. Pin moves it to the very top; Unpin moves it first below the Pin area.
Move Up/Down works within both the Pin and ordinary areas; hidden cards retain their relative positions. Persist Pin
order by Pin ID so restoration keeps it. Explicit close removes a card immediately; no stopping card remains.
There are no batch actions or automatic creation-tree grouping.
Click selects immediately and reveals its terminal. Selection follows the last active owned agent terminal, survives
focus on a file/unrelated terminal, and disappears when that record is removed. A failed launch remains selected;
background starts do not change selection. Keyboard focus and selection are independent.

### 2.2 Card menu

**A card uses a flat native context menu with only actions meaningful to its current record.**

Groups: Rename / Pin or Unpin / Copy Agent Reference; Move Up/Down; Filter by This Location / Filter by This Folder / Clear Filter;
Close Agent for starting, live and retained-ended records. Enable actions by actual availability; name editing need
not wait for CLI readiness. There is no worktree deletion or bulk selection action. LIFECYCLE-3.1 owns the shared close
action. No menu outside a card, not even the webview's default Cut/Copy/Paste. Context targets its stable run ID,
revalidated against current host state under 3.1, never the selected row by fallback. Palette targeting follows UX-3.1.

### 2.3 Filters

**A filter affects this window's card visibility only, not access or launch defaults.**

Filter by Working Location opens native Quick Pick steps by folder (D82). In each step one separator follows the first
item, then come the folders or locations that have cards (including starting and retained failures) or hold the
current filter, each with its count. In a window of several folders the first step lists All Locations, then the
folders. A folder opens its own step - All Worktrees (the whole folder), then its locations, the main checkout first
(WORKTREES-1.2) - where two or more of its locations are listed, or where the filtered location is one of several it
has; choosing any other folder filters by it directly. A window of one folder shows that folder's step alone, its
first item showing every card: All Worktrees, or All Locations outside Git. A filtered location the catalog no longer
lists stays choosable, last in the first step. The current filter, or in the first step its folder, is initially
highlighted. Back returns to the first step; Escape leaves the filter unchanged. The view description names the
filter; the icon fills.
Persist environment-qualified location/folder association in workspace state. Clear on Clear Filter, the first
step's first item or confirmed location removal, never on a failed Git read. A launch does not change the filter;
every new agent enters the normal list data and is displayed only when it matches. Per-card filters appear only when
they would change the visible set. Ordinary folders use “location,” not an implication that Git/worktrees are required.

## 3 Technical design

### 3.1 One state and one webview generation

**The model sends one coherent state per microtask and applies it only to the current page generation.**

State contains revision, loading, agents in order, filter, card count, location metadata and capabilities. Agent run
IDs remain stable through launch. Badge, description and context keys come from the same state. Reported text/activity updates are coalesced to
at most once per 300 ms; real lifecycle/errors are sent without waiting for that coalescer. `ready` triggers a full
state and scroll settings. Webview-to-host actions carry the page generation and, for a targeted action, the stable run
ID. Ignore actions from a replaced page generation; the host validates current-page actions against current state and
never substitutes another row. Async replies go only to the generation that asked. An action correlation ID is an
implementation detail when needed to match a reply; no expected revision is required on every action. Test-only probes
never ship.

Update `src/ui/model.ts`, `src/ui/panel.ts`, `src/webview/panel.ts` together. Webview sends `ready`,
validated `act` (`open`, `new`, `clearFilter`, `openFolder`, `rename`), and diagnostic `error`; host sends `state`, `scrolling`, and
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
nodes survive ordinary text changes; initial draw/filter changes do not animate.

### 3.3 Scrolling

**The list scrolls and shows an overlay scrollbar as VS Code's own lists do, without reserving a gutter.**

The wheel follows VS Code's list code, ported, not imitated: `workbench.list.mouseWheelScrollSensitivity` (default 1),
`fastScrollSensitivity` (default 5, with Alt), `smoothScrolling` and the window's zoom. Wheel baseline 50 px per line;
normalize Chromium wheel delta/120, else line delta, else pixel delta/40; round away from zero to whole pixels.
Predominantly horizontal movement does not scroll vertically, and off macOS Shift turns vertical movement horizontal, as
in VS Code's lists. Ctrl-wheel is left to the editor; the list takes every other wheel, so nothing scrolls past its ends.
Mouse-wheel smoothing is 125 ms cubic ease-out, only when enabled and only for what VS Code's classifier takes for a
physical mouse wheel; the keyboard or any other scroll ends it where it is, and reduced motion removes it. The classifier
undoes the zoom `window.zoomLevel` says, the only one a page is told: a window zoomed alone (`window.zoomPerWindow`) can
have a mouse wheel's scroll taken for a touchpad's, and not glide.

The page retains native scrolling, with its browser scrollbar hidden. Its right-edge overlay follows the native sidebar
lists (D125): 10 px wide with square corners normally; 8 px wide with `cornerRadius.small` corners (4 px fallback) when
`workbench.experimental.modernUI` is true. The host supplies the effective setting at startup and on changes; an absent
setting uses the traditional appearance. The theme name does not decide this mode. Slider colors follow `scrollbarSlider.*`
and the track follows `scrollbar.background`, transparent when unset. The entire page content and the overlay share
the visible viewport through the host's clipping ancestors. Fractional-scale iframe rounding must not crop the last
card or remove a column of the slider. Cross-origin intersection bounds may enclose a partially clipped device pixel;
keep the right and bottom edges one device pixel inside those reported bounds. The correction follows sidebar resizing
and display/zoom changes, including without overflow. It is independent of the scrollbar's visibility and reserves no
scrollbar gutter. Hit testing follows the corrected track.

The list has no additional top or bottom padding beyond the clipping correction; its existing 4 px side padding
already accommodates its rounded corners. Its right padding absorbs the one-device-pixel guard instead of adding it
again, keeping the two side gaps balanced within host raster rounding. This applies in both appearance modes so a
mode change does not move cards. Modern UI leaves 2 px at both scrollbar ends and 1 px at the right, measured
from the safe visible viewport. This is clearance for the scrollbar beside the webview's additional rounded clip;
it does not add list padding or duplicate the editor's existing outer spacing.
Traditional UI adds no decorative clearance; both modes compensate host
clipping for all page content, including empty states. A mode change preserves card order and focus and keeps scrolling
within the resulting valid range. Both caps and first/last card corners must remain visible; shared antialiased boundary
pixels do not require exact equality. Slider placement uses fractional track dimensions and stays inside the track at
both ends, rather than mixing a rounded clientHeight with a fractional CSS height. The thumb reaches its track end
when the native scroller clamps within one device pixel of the outward-rounded range. The last card can stop less than
one device pixel inside the safe visible edge because of native scroll quantization. Native scrolling, dragging and the
wheel reach the complete content range. Slider sizing and pointer mapping use the
remaining track, while page clicks still move one viewport. The overlay reserves no width, whether visible or hidden,
and is absent without overflow. Its slider is proportional to the viewport, at least 20 px and at most the usable track's length. Slider position,
dragging and track clicks follow VS Code's list code: a click centers the slider, or moves one viewport when
`workbench.list.scrollByPage` is true (default false). Dragging captures the pointer outside the view; on Windows, moving
more than 140 px sideways resets to the drag's starting scroll position. The overlay adds no Tab stop.

The scrollbar starts hidden unless the pointer is over the view, appears on hover or scrolling, and stays visible while
hovered or dragged. Leaving the view fades it out; a scroll without hover reveals it until 500 ms after the last scroll.
Reveal is 100 ms linear and hide is 800 ms linear, as in VS Code's lists; reduced motion makes both immediate. Release
outside the view, canceled dragging and loss of window focus cannot leave it stuck visible. Keyboard Page Up/Down moves
fully visible row count minus one (minimum one).

## Checks

| Rules | Acceptance |
| --- | --- |
| 1.1–1.5 | Approved title/menu entries, the empty and filtered states and the no-folder New Agent prerequisite, empty/filter distinction, slow/no Git, four dot meanings, known blocker before generic unavailable text without losing that explanation, all widths/themes/accessibility |
| 2.1–2.3 | Stack insertion and manual order, retained failure, exact context target, filter removal/read failure |
| 3.1–3.3 | Generation-isolated replies/actions with current target validation, coherent badge, XSS/command-link payloads, hide/show browsing-position restore without focus theft, input-to-paint and scrolling |

Evidence: [Verification](../engineering/VERIFICATION.md). Visual tests use an isolated editor profile.

## Change log

- 2026-11-01: 1.4 says when an agent's Facade tools went away (D136).
- 2026-11-01: Describe the competitive-analysis rationale without naming individual products; hover behavior is unchanged.
- 2026-11-01: Removed Message History... from the view's More Actions menu at the owner's request; its Command
  Palette entry remains (D129).
- 2026-11-01: Combined D128 with the upstream Pin and overlay scrollbar: fit text within the space left by the Pin,
  refitting when it is added or removed, while retaining PANEL-3.3's clipping and scrolling behavior.
- 2026-11-01: Clarified 1.3 after the owner spotted a gap before the location separator: fitting budgets and final
  rendered widths are distinct; unused grapheme space is shared and the visible group stays compact (D128).
- 2026-11-01: 1.3 shares width between name and location and ellipsizes folder/worktree separately in the middle (D128);
  1.4 distinguishes idle and blockers and gives blockers/errors an explicit leading label (D127).
- 2026-10-31: Use an auto-hiding overlay that follows native Modern UI settings, compensates webview clipping and preserves complete card/slider corners without list top or bottom padding (D125).

- 2026-10-31: Adjusted the Pin's size, name spacing and selected/high-contrast colors after the owner's visual review (D122).

- 2026-10-31: Added the owner-authorized Resume and linked Pin/Unpin step, using Facade Dots as the reference.

- 2026-10-31: 1.5's hover says how long ago a working agent's CLI reported its work (D114).
- 2026-10-30: Step 2 of the Facade Code extension: 1.1 adds Message History... to the view menu; 1.4 adds an
  unavailable-tools explanation and a creation prompt's first line; 1.5 names an agent's creator; 2.1 places agent-started
  cards like any other without tree grouping; 3.2 renders no command links from messages.
- 2026-10-31: 3.3's wheel is VS Code's list code, ported, and its scrollbar the page's own (D87).
- 2026-10-31: 1.1's New Agent shows Facade's own copy of `new-session`, which VS Code before 1.111 does not have (D85).
- 2026-10-31: 2.3's Filter by Working Location steps by folder; All Locations and All Worktrees replace All
  Agents (D82).

- 2026-10-31: 1.3 draws a custom CLI's avatar as its initial on a theme color (UX-2.1).

- 2026-10-31: 1.1 names Show Agent Launch and Show Agents Log as Command Palette entries, not view-menu items (D83).

- 2026-10-30: Display filters, carried from the Facade Dots specification: 1.1 adds Filter by Working Location before
  New Agent and counts every card whatever is shown; 1.2 adds the filtered empty state; 2.2 the card's filters; 2.3
  Filters; 3.1 carries the filter in the state and the `clearFilter` act; 3.2 keeps a filter change still. New Agent
  Here stays retired.

- 2026-10-30: 1.3 adds the Antigravity, Muse Code, OpenCode and Pi avatars (D77); 1.4's startup stage lasts until the
  CLI first shows its activity (D81).

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
