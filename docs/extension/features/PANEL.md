# Panel

Layer 3. The panel displays this window's agents. [Rules](../RULES.md) owns meanings; [UX](../UX.md) owns common
interaction and tokens. This document owns the card, list, filter and webview contract.

| Group | Decides |
| --- | --- |
| 1 View and card | Loading, empty state, badge, content and geometry |
| 2 List and actions | Order, selection, menu and filtering |
| 3 Technical design | State transport, rendering, resources and scrolling |

## 1 View and card

### 1.1 One view of this window

**Facade Code has one webview view in its own activity-bar container and shows only this window's agents.**

Container `facade`, view `facade.agents`, title `Facade Code`, icon `media/facade.svg`; background activation uses
`onStartupFinished`. Opening the contributed view or invoking a contributed command can activate it on demand.
Until agent records are reconciled use native view progress and draw no false empty state. Git metadata does not block
card loading. Title actions in order: Filter by Working Location (`filter`, filled when active), Resume Agent
(`history`), New Agent, so New Agent is rightmost. New Agent's icon is Facade's own copy of the `new-session` codicon,
shipped with the extension and shown in every editor: VS Code has that codicon only from 1.111, later than the
supported minimum. The view's native `Views and More Actions...` (`…`) menu holds Add Folder to Workspace... (the
editor's command), then New Worktree... when a workspace folder is open, followed by Configure Agents... in a separate
group. Go to Agent..., Show Agent Launch... and Show Agents Log are Command Palette entries, not view-menu items.
Facade commands use the titles and flows in UX-3.1. The badge counts this window's cards, including starting,
retained-error and temporarily disconnected records. Tooltip `1 agent` / `{n} agents`; omit zero. A display filter does
not change the underlying card count.

### 1.2 Empty and filtered states

**The empty state explains the current condition and offers the next relevant action.**

No folder: `Open a folder to launch agents.` with Open Folder. No agents:
`Launch an agent in this workspace.` with New Agent (primary) and Resume Agent (secondary). No matching cards with a filter:
`No agents found in "{location}".`, then `{n} other agents are in this workspace.` (`1 other agent is in this
workspace.`; omitted when no other card exists), Clear Filter (primary) and New Agent (secondary), which starts at the
filtered location (LIFECYCLE-1.2). Empty-state buttons have no ellipsis, as VS Code's
welcome buttons do. Open Folder from this button or New Agent invokes the editor's `vscode.openFolder` command,
matching the built-in Git view's entry. The editor owns folder selection, window opening and the resulting view;
Facade does not switch the sidebar back once the folder opens, and the person returns through Facade Code's
activity-bar icon. Do not display worktree tutorials when Git is absent or make an empty
filter look like all agents ended. Paragraphs wrap; buttons are native-themed and keyboard accessible. There is no
composer field.

A window whose Facade could not start shows the reason in the panel, in place of its progress and cards, and Facade's
commands repeat that reason. A window without its window component shows ARCHITECTURE-4.3's explanation there, with a
button that shows the component in the Extensions view, themed as the empty states' buttons are (UX-2.1).

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
| Pin | 14 px icon box 4 px after the name as shown, its ellipsis included; adds no card height |
| Second line | 12 px, quieter, single line with ellipsis |
| Dot | 10 px at avatar bottom right, offset 1 px outward, 2 px ring of current row background |
| Text block | Vertically centered; whole-pixel geometry; accents/descenders never clipped |

Use maker avatars in `media/agents`: `avatar-claude.png`, `avatar-codex.png`, `avatar-antigravity.png`,
`avatar-muse.png`, `avatar-opencode.png` and `avatar-pi.png`. Custom avatars are an uppercased first grapheme in a
circle; deterministic theme colors from UX-2.1. Location is alias/branch/folder, prefixed by workspace folder in a
multi-folder window unless it is named that folder's name already, as a plain folder is. A related worktree can be
outside a folder and still show its actual location. Where every agent works in the window's one place to work
(LIFECYCLE-1.3) no card shows a location, the name taking the first line, and the hover keeps it. Confirmed location
removal closes its affected agents; a temporarily disconnected location is retained. Reserve the Pin's measured width
and spacing when present, then let name and location share the first line's remaining width: a short one stays whole and
the other uses the remaining room. Only when both exceed their shares does the line divide about 60% to the name and 40%
to location; 40% is not a location cap. A long name ellipsizes at the end, its width that of the text it shows as drawn,
so that a Pin follows the ellipsis as closely as it follows a whole name. Location keeps its `folder · worktree`
structure: each long component ellipsizes in the middle, between whole graphemes, keeping its beginning and end where
they fit. A short component stays whole; when both are long, the worktree receives about two thirds of their text space.
The separator remains and the folder is never hidden just because it is long. These shares are width limits, not
reserved empty boxes: after fitting whole graphemes, give unused folder space to the worktree, then any remaining space
back to the folder. Render each fitted component at its measured width and align their compact group at the line's end.
Only the separator's normal spaces separate the two visible labels; unused allocation must not appear before the
separator or after the worktree. Any final spare width is available to the name, up to its natural width. Measure in the
displayed font and available pixels, not a fixed character count; refit on resize, font changes, rename and location
updates. Avatar/dot do not shrink. Full values remain in hover and accessibility; the panel header is unchanged.

Pinned cards show the Pin beside the name. Hovering the Pin shows its own tooltip with its restoration meaning: the
conversation is restored when the workspace opens again. Its color follows the quieter text, including the selected
foreground at 80% opacity; high-contrast selections use full opacity. The icon's internal space keeps its visible shape
smaller than the name's letters.

### 1.4 Second line and dot

**The second line says what was last sent to the agent, unless its dot is red or its CLI waits for the person.**

It says the last message sent to the agent: the person's text after a nonempty Enter, slash commands included, as the
CLI's input reader read the draft that Enter submitted (CLIS-2.1); a message or Facade result that Facade typed into
its input, as typed, its `📨` or `🔔` line first; or the task it was started with, its creation prompt's first line. A
CLI without an input reader has no typed text to show. Before any, it says its CLI title's words: the title CLIS-2.3
keeps, without the spinner frame or state symbol a CLI puts before its words, for every CLI. Once a message was sent, a
title never replaces it; the hover's `Title:` shows the title as CLIS-2.3 keeps it. The last message is kept across a
reload. Two cases say something else while they last: a red dot says why (RULES-3.2) - the error, the Facade tools it
cannot use or the start not ready - and a native blocker says what it waits for.
A CLI without its Facade tools says so in plain words, for example
`Cannot work with other agents: move or rename {file}`, or `Cannot work with other agents: its Facade tools stopped`
once its tools went away, and stays usable. Fallbacks, before any message or title: the startup stage, `Working`,
`Idle`, `Activity unavailable`. Idle alone proves neither an empty composer nor usable input; there is no separate
first-message readiness claim. Never `Done, waiting for you` from a turn end. Normal work/idle shows the message or
title directly, without a repeated `Working`/`Idle` prefix. Native blockers lead with `Needs permission`,
`Sign-in required` or `Waiting for an answer`, followed by the CLI's original words when present. A reported blocker
with no recognized kind says `Needs attention`, preserving its original words. Errors lead with `Error: {reason}`; why
activity is unavailable is the hover's. No popup solely for a native blocker.

Dot semantics and precedence follow RULES-3.2; theme tokens follow UX-2.1. The text priority above does not change the
dot or notification rules. Tools injected but not yet connected say `Not connected to other agents yet` in the hover;
startup waits for them, and once CLIS-2.3's bound passed without them the dot is red and the second line says so. An
actual tool connection removes the message; known injection failures or a lost existing connection keep their specific
explanation. Ended cards do not claim a pending tool connection. Working breathes every 1.8 s using opacity only (0–65%
overlay of row background); reduced motion is static. The hover's `Status:` says `Starting`, `Working`, `Idle`, the
native blocker's kind, `Needs attention`, `Error: {reason}` or `Activity unavailable`, and for a red dot without an
error why it is red: the tools explanation, `Not connected to other agents yet` or why its activity is unavailable.
The accessible label preserves it. No unread dot, completed check, bold-name state or extra error badge.

### 1.5 Hover and accessible content

**Every fact cut from a card remains readable without relying on color.**

Card tooltip lines use a localized `Label: value` format throughout: `Agent:` for name, short run ID and CLI;
`Title:` for a full title or `Prompt:` for its creation prompt's first line; `Status:` and a distinct `Reason:` when
present. Use `Tools:` for unavailable or connecting collaboration tools, retaining 1.4's conditions; an ended card leaves
out the tools that went away with its process. Where a red card's reason is its tools, `Status:` and `Tools:` say the
same words. Empty names create no empty identity separator. Keep title-over-prompt
priority and suppress a reason identical to the description. For a working agent, `Reported working:` shows how long
ago its CLI reported that work, for example `Reported working: 25 min. ago`. This is the CLI's last word; a long silence
leaves the person to judge it rather than turning it into idle or done. This uses the source observation for the current
working episode, preserved through title changes and reload, not the host's report-receipt or API-query time. Missing
source time omits the line. Relative times use the source clock; an observation ahead of that clock shows its absolute
time instead; `Started:` for started relative time and, for an agent started by an agent, `Started by:` for its creator;
`Location:` for qualified location including non-local environment context; `Path:` for its complete path, the home
folder written `~` except on Windows; `Window:` for the window. Preserve case and every path component, allowing
native wrapping. Do not repeat natural-language prefixes after labels. Missing facts omit their lines. Hovering the dot
shows its state alone, and hovering the Pin its own tooltip (1.3). Accessible label: name, short run ID, `Pinned` for a
pinned card, state, location, CLI, and the second line where it differs from the state. Use a listbox named `Agents`,
options with `aria-selected`, decorative icons hidden, one roving Tab stop. Update labels in place. State-change
announcements are polite, coalesced, and do not repeatedly announce spinner/progress ticks.

## 2 List and actions

### 2.1 Order and selection

**The list is two manually reorderable queues, Pins first; state changes do not move cards.**

A new card, whether a person or an agent started it, goes last in the ordinary area. Pin moves a card last among the
Pins, also where it takes its conversation's existing Pin (LIFECYCLE-3.4). A card that leaves the Pins - by Unpin, or
because another card took its Pin - goes first in the ordinary area, just below the Pins it left. A
new card the person started, which is selected, scrolls into view; one an agent started does not move the list.
Move Up/Down works within both the Pin and ordinary areas; hidden cards retain their relative positions. Persist Pin
order by Pin ID so restoration keeps it. Explicit close removes a card immediately; no stopping card remains.
There are no batch actions or automatic creation-tree grouping.
Click selects immediately and reveals its terminal. Selection follows the last active owned agent terminal, survives
focus on a file/unrelated terminal, and disappears when that record is removed. A failed launch remains selected;
background starts do not change selection. Keyboard focus and selection are independent.

### 2.2 Card menu

**A card uses a flat native context menu with only actions meaningful to its current record.**

Groups: Rename / Pin or Unpin; Move Up/Down; Close Agent for starting, live and retained-ended records. It has no other
entries: no worktree deletion or bulk selection action. Enable actions by actual availability; name editing need not
wait for CLI readiness. LIFECYCLE-3.1 owns the shared close action. No menu outside a card, not even the webview's
default Cut/Copy/Paste. Context targets its stable run ID, revalidated against current host state under 3.1, never the
selected row by fallback. Palette targeting follows UX-3.1.

### 2.3 Filters

**A filter affects this window's card visibility only, not access or launch defaults.**

Filter by Working Location opens native Quick Pick steps by folder. Where every agent works in the window's one place to
work (LIFECYCLE-1.3) there is nothing to filter by and it is not offered; an active filter keeps its way to be cleared.
In each step one separator follows the first item, then come the folders or locations that have cards (including
starting and retained failures) or hold the current filter, each with its count. In a window of several folders the
first step lists All Locations, then the folders. Every folder row keeps its name as label and shows `{agent count} ·
{parent path}` as description, with the count first and the parent path using the existing home-relative representation.
Do not shorten this path artificially; native clipping may still occur. Location rows retain their existing names, icons
and counts. A folder opens its own step - All Worktrees (the whole folder), then its locations, the main checkout first
(WORKTREES-1.2) - where two or more of its locations are listed, or where the filtered location is one of several it
has; choosing any other folder filters by it directly. A window of one folder shows that folder's step alone, its first
item showing every card: All Worktrees, or All Locations outside Git. A filtered location the catalog does not list now
stays choosable, last in the first step. The current filter, or in the first step its folder, is initially highlighted.
Back returns to the first step; Escape leaves the filter unchanged. The view description names the filter; the icon
fills. Persist environment-qualified location/folder association in workspace state. Clear on the filtered empty state's
Clear Filter, the first step's first item or confirmed location removal, never on a failed Git read. A launch does not
change the filter; every new agent enters the normal list data and is displayed only when it matches. Ordinary folders
use “location,” not an implication that Git/worktrees are required.

## 3 Technical design

### 3.1 One state and one webview generation

**The model sends one coherent state per microtask and applies it only to the current page generation.**

State contains revision, loading, the cards the filter shows in order, each with its location, the filter, the count of
every card, why no card is shown where none is (1.2), the runs that ended normally since the last state (UX-2.2),
capabilities, and the execution environment's clock at sending, against which the page reckons relative times (1.5).
Agent run IDs remain stable through launch. Badge, description and context keys come from the same state. Reported
text/activity updates are coalesced to at most once per 300 ms; real lifecycle/errors are sent without waiting for that
coalescer. `ready` triggers a full state and scroll settings. Webview-to-host actions carry the page generation and,
for a targeted action, the stable run ID. Ignore actions from a replaced page generation; the host validates
current-page actions against current state and never substitutes another row. Async replies go only to the generation
that asked. An action correlation ID is an implementation detail when needed to match a reply; no expected revision is
required on every action. Test-only probes never ship.

Update `src/webview/protocol.ts` (the wire types both sides use), `src/ui/model.ts`, `src/ui/panel.ts` and
`src/webview/panel.ts` together. Webview sends `ready`, carrying whether the system asks for reduced motion, `motion`
when that changes - which the host passes to busy tabs' spinners (UX-2.2) - validated `act` (`open`, `new`, `resume`,
`clearFilter`, `openFolder`, `rename`), and diagnostic `error`; host sends `state`, `scrolling`, and matching action
outcomes. `open` serves a card's click, Enter and Space, `rename` its F2 (UX-2.3), and the others the empty-state
buttons of 1.2; `rename` asks the host to open the native Input Box, and the host validates the target. Context menu
commands run in the host through validated targets. Page-held state is navigation/typeahead/scroll, not business rules.
Use the webview's saved page state to restore the still-valid scroll position and keyboard navigation target when the
person hides and reopens the view; restoring a navigation target does not take actual input focus. Rebuild current cards
from the host model and discard a navigation target whose card is gone. Use this saved page state without a host
persistence service or retainContextWhenHidden; keep cards keyed and avatars reused within a page.

### 3.2 Security and resource use

**The webview loads only bundled resources and renders all outside strings as text.**

CSP:
`default-src 'none'; style-src <cspSource>; img-src <cspSource>; script-src 'nonce-<nonce>';`.
Nonce is 16 random bytes per page. Escape `<` in embedded localization JSON, use textContent for CLI/user strings,
validate incoming actions and reject unknown keys/types. Local resource roots are only bundled media/webview output. No
external image fetches, remote scripts, injected HTML, command links from messages or secrets in state. The pages of 1.2
for a failed start or a missing window component load no resource and escape their text; only the latter runs a script,
its own nonce'd one. Cards, focus and avatar nodes survive ordinary text changes; initial draw/filter changes do not
animate.

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
lists: 10 px wide with square corners normally; 8 px wide with `cornerRadius.small` corners (4 px fallback) when
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
and is absent without overflow. Its slider is proportional to the viewport, at least 20 px and at most the usable
track's length. Slider position, dragging and track clicks follow VS Code's list code: a click centers the slider, or
moves one viewport when `workbench.list.scrollByPage` is true (default false). Dragging captures the pointer outside
the view; on Windows, moving more than 140 px sideways resets to the drag's starting scroll position. The overlay adds
no Tab stop.

The scrollbar starts hidden unless the pointer is over the view, appears on hover or scrolling, and stays visible while
hovered or dragged. Leaving the view fades it out; a scroll without hover reveals it until 500 ms after the last scroll.
Reveal is 100 ms linear and hide is 800 ms linear, as in VS Code's lists; reduced motion makes both immediate. Release
outside the view, canceled dragging and loss of window focus cannot leave it stuck visible. Keyboard Page Up/Down moves
fully visible row count minus one (minimum one).

## Checks

| Rules | Acceptance |
| --- | --- |
| 1.1–1.5 | Title and menu entries, the empty and filtered states, the failed-start and missing-component pages and the no-folder New Agent prerequisite, empty/filter distinction, slow/no Git, the green and red dots and no dot otherwise, known blocker before generic unavailable text without losing that explanation, the Pin's own tooltip, all widths/themes/accessibility |
| 2.1–2.3 | Insertion into the two queues and manual order, retained failure, exact context target, filter removal/read failure |
| 3.1–3.3 | Generation-isolated replies/actions with current target validation, coherent badge, XSS/command-link payloads, hide/show browsing-position restore without focus theft, input-to-paint and scrolling |

Evidence: [Verification](../engineering/VERIFICATION.md). Visual tests use an isolated editor profile.
