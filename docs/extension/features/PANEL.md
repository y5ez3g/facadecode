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
editor's command), then New Worktree... when a workspace folder is open, followed by Open Settings in a separate
group. Open Settings follows CONFIGURATION-1.2: Facade Code's Settings section and its Edit in facade.json link, or
facade.json directly for a remote window whose Settings open as JSON, including file creation and migration conflicts.
Go to Agent..., Show Agent Launch... and Show Agents Log are Command Palette entries, not view-menu items.
Facade commands use the titles and flows in UX-3.1. The badge counts this window's cards, including starting,
retained-error and temporarily disconnected records. Tooltip `1 agent` / `{n} agents`; omit zero. A display filter does
not change the underlying card count.

### 1.2 Empty and filtered states

**The empty state explains the current condition and offers the next relevant action.**

No folder: `Open a folder to start agents.` with Open Folder. No agents:
`Start an agent in this workspace.` with New Agent (primary) and Resume Agent (secondary). No matching cards with a filter:
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

Once a folder is available, New Agent uses LIFECYCLE-1.1's CLI picker. Configuration errors come before the disabled
check: an invalid entry with `enabled: false` appears under Unavailable with its error and Open Settings. A valid
disabled entry is not listed (CONFIGURATION-4.1).

### 1.3 Card geometry and identity

**A card is two lines beside a CLI avatar and status dot; the first line identifies the agent and shows its Pin at the
right, and there, under the pointer, the card's details, menu and Pin buttons.**

| Element | Value |
| --- | --- |
| Card | Minimum 44 px tall; padding 8 px top/bottom/left, 9 px right; 4 px corners |
| Avatar | 28 px circle, 8 px before text, 1 px inner edge of the theme foreground at 14 % opacity - high contrast: its contrast border - never an opaque border over the icon |
| First line | Name 13 px at the left; its short ID where its name repeats, 12 px in the quieter color, 4 px after it; the Pin at the right; no location |
| Pin | 14 px icon centered on the first line, 7 px from the card's top and as far from its right; at least 4 px from the name and ID; adds no card height |
| Buttons | ⓘ details, gear menu and, where the card can be pinned or unpinned, Pin, in that order; 18 px each, 2 px apart, 5 px from the card's top and as far from its right; add no card height |
| Second line | 12 px, quieter, single line with ellipsis |
| Dot | 10 px at avatar bottom right, offset 1 px outward, 2 px ring of current row background |
| Text block | Vertically centered; whole-pixel geometry; accents/descenders never clipped |

Choose the avatar by the entry's `icon` under CONFIGURATION-2.4. Built-in icons use `media/agents`:
`avatar-claude.png`, `avatar-codex.png`, `avatar-antigravity.png`, `avatar-muse.png`, `avatar-opencode.png` and
`avatar-pi.png`. Robot icons use `robot-<color>-face.svg` with `robot-eyes.svg` over it.

While the pointer is over the panel, each robot's eyes move toward it, at most 4/32 of the face's width. They reach
that limit when the pointer is a face and a half away, and move a quarter of the remaining distance each frame.
They keep looking toward the last known pointer position when a click focuses a terminal, a menu takes the pointer,
or the pointer leaves the panel. A pointer entering, moving or pressing in the panel updates that position; selection,
details, status updates and scrolling do not reset it. This keeps the eyes from jumping back during panel operations.
VS Code's or the system's reduced-motion setting keeps them still; turning either preference on returns eyes already
off center to the middle at once, without easing or waiting for a pointer event.
Once the eyes rest, no further animation frames are computed.

No card shows its location, at any width, under the pointer or on
focus: the first line is the agent's name, a shortened location being no help to read, and the location is the
details' and the accessible label's in full (1.5). A location's label there is alias/branch/folder, prefixed by workspace folder in a
multi-folder window unless it is named that folder's name already, as a plain folder is; a related worktree can be
outside a folder and still show its actual location. Confirmed location removal closes its affected agents; a
temporarily disconnected location is retained. Where two or more of this window's cards have exactly the same stored
name after trimming - compared whole and case-sensitively, among its starting, disconnected and retained-error cards too
and those the filter hides, other windows' never - each adds its own short ID after the name; an empty name shows its
short ID alone, in the name's style. A duplicate appearing, going or being renamed updates every card affected, changing
no stored name, order, selection or focus. Reserve the whole ID where present, and the Pin's width and gap, and give the
name the rest: a long name ellipsizes at the end between whole graphemes, and a short name and its ID stay together at
their natural widths, the spare space before the Pin. Unpinned cards reserve no Pin box. While the buttons show they
take the Pin's place, and the name gives up their width and gap, taking it back as they go. The Pin's and the
buttons' icons stay clear of the overlay scrollbar at every width and zoom, and neither the scrollbar's showing nor
keyboard focus moves them. Measure in the displayed font and available pixels, not a fixed character count; refit on resize, font
changes and rename. Avatar/dot do not shrink. The panel header is unchanged.

The buttons show while the pointer is on the card - as far as the page can know where it is under the editor's menu
(2.2) - or its menu or details are open. Each is a 14 px icon, the size
chosen for them, with 2 px round it, in the manner of the editor's list-row actions without matching their dimensions.
The icons are the editor's own codicons `info` and `gear`, and for the Pin the outlined contour Facade bundles as
`media/pinned.svg`, the filled Pin being that icon's outer contour alone. They are centered on the first line, the Pin
button's where the Pin is, at least 4 px from the name and ID, and clear of the overlay scrollbar, which may cover the
last button's hover background. At rest the icons are in the Pin's quieter color, with the Pin's selected and
high-contrast exceptions below and UX-2.1's 75% foreground where a theme has no quieter color of its own; the one under
the pointer or pressed is in the icon color on the toolbar's hover or pressed background.

Pinned cards show the Pin, filled, at the first line's right; it is passive, with no click or Tab stop. Under the
pointer the buttons take its place, the Pin button in the same place as the Pin: filled where the card is pinned,
outlined where it is not, it pins or unpins the card as Pin Agent and Unpin Agent do (UX-3.1). The buttons are the
pointer's alone: they have no Tab stop, no accessible name and no tooltip, and are hidden from screen readers. The
keyboard and a screen reader reach what they do by these routes alone: Shift+F10 and the menu key open the gear's menu on
the card (2.2, UX-2.3); Pin Agent, Unpin Agent and Show Agent Details in the Command Palette act on the selected card
(UX-3.1); and a screen reader hears the details' facts in the card's accessible description (1.5). A press on a button
never puts the focus on the button and never reaches the card's own click, which opens its terminal; its action then has
its own effect: the Pin button's Pin or Unpin selects its card and shows its tab as LIFECYCLE-3.4 says - an Unpin of an
agent with no tab open keeping it hidden, and a Pin that cannot be saved opening nothing. The Pin's color
follows the quieter text, including the selected foreground at 80% opacity; high-contrast selections use full opacity.
The icon's internal space keeps its visible shape smaller than the name's letters.

### 1.4 Second line and dot

**The second line says one of three kinds of thing: the person's input, another agent's message, or Facade's own.**

1. `🧑‍💻`: the person's text after a nonempty Enter, slash commands included, as the CLI's input reader read the draft
   that Enter submitted (CLIS-2.1). A CLI without an input reader has no typed text to show.
2. `📨`: a message another agent sent that Facade typed into its input - the task an agent-started run was started with
   among them, its creation prompt's first line, whichever path it went in by - its own text, without the line that
   introduces it. A message the agent took through read_messages changes nothing.
3. Facade's own, with no mark: a Facade result, without the `🔔` it is typed to its agent with (COLLABORATION-2.2); or a
   notable state while it lasts: its start - `Starting {CLI}…` or `Creating worktree…`; what its CLI waits for - `Permission needed`, `Sign-in needed` or `Answer needed`, then
   ` · ` and the CLI's original words when present, such as `Permission needed · Run npm test?`, and `Attention
   needed` with its original words for a blocker of no recognized kind; why its dot is red (RULES-3.2) - an error's
   reason without `Error · `, which the red dot says, such as `Process exited · code 1`, `Process terminated ·
   SIGKILL` or `Process lost · reason unknown`; a start that failed as `Start failed · {reason}` and a worktree that
   could not be made as `Worktree failed · {reason}`, the reason without its closing `.` or `。`, such as `Start failed ·
   claude was not found on PATH`, while their notifications keep their own sentences (UX-1.2, WORKTREES-2.2); an end
   Facade could not confirm, `Stop unconfirmed · check process` (LIFECYCLE-3.5); the Facade tools it cannot use; its
   tools not connected past CLIS-2.3's bound, `Collaboration not connected yet`; or a start that did not become ready,
   with why its activity is unknown, such as `No initial status · check terminal`. Before any message, with no notable
   state, it says how the run began: `New conversation started` for a new conversation, `Conversation resumed` for one
   it resumed - by Resume Agent, or a restored Pin resuming its conversation, never a Pin that begins a new one
   (LIFECYCLE-3.4).

What the second line says is the first of these that holds, in this order of precedence:

1. a retained error's or an ended run's reason (RULES-3.2, 3.3);
2. a native blocker: what its CLI waits for (RULES-3.2);
3. another red condition: Facade tools it cannot use, its tools not connected past CLIS-2.3's bound, or a start not
   ready by it (RULES-3.2);
4. its start's stage, while it starts (LIFECYCLE-1.5);
5. the last item sent to it: the person's input, another agent's message or a Facade result;
6. how its run began.

The last item sent comes back as soon as none of 1-4 holds any longer; the words of each are those above.

The `🧑‍💻` and the `📨` are the editor's color emoji, at the second line's size, one space before the text, so that what
was sent to the agent, and by whom, shows at a glance; Facade's own words carry no emoji or other mark. The `📨` and the
`🧑‍💻` come from who sent the item as its record keeps it, never from a name, the destination or an emoji the text
begins with. It says where that item came from, not what the agent works on now or
whether it read it. The last message, and whether the run resumed a conversation, are kept across a reload. A CLI
without its Facade tools says so in plain words, for example `Collaboration off · move or rename {0}`, or
`Collaboration stopped · end and resume` once its tools went away, and stays usable. The second line never says a
title - its conversation's is the details' (1.5), and a terminal's is never shown (CLIS-2.3) - nor `Working`, `Idle`
or, without a red dot, `Status unavailable · check terminal`, nor `Error · ` before a red card's reason: the state is
the dot's and the accessible label's, the label also saying why activity is unavailable. Idle alone proves neither an
empty composer nor usable input; there is no separate first-message readiness claim. Never `Done, waiting for you`
from a turn end. No popup solely for a native blocker.

Dot semantics and precedence follow RULES-3.2; theme tokens follow UX-2.1. The text priority above does not change the
dot or notification rules. Tools injected but not yet connected say `Collaboration not connected yet` in the accessible
label; startup waits for them, and once CLIS-2.3's bound passed without them the dot is red and the second line says so. An
actual tool connection removes the message; known injection failures or a lost existing connection keep their specific
explanation. Ended cards do not claim a pending tool connection. The green dot, starting or working, breathes every 1.8 s using
opacity only (0–65% overlay of row background); reduced motion is static. The accessible label says the state in words: `Starting`,
`Working`, `Idle`, the native blocker's kind, `Attention needed`, `Error · {reason}` or `Status unavailable · check
terminal`, and for a red dot without an error why it is red: the tools explanation, `Collaboration not connected yet` or why its
activity is unavailable. No unread dot, completed check, bold-name state or extra error badge.

### 1.5 Details and accessible content

**A card's details say what the agent works on, who it is, when it started and where it works, in five lines the person
opens with a click.**

A card's details open from its ⓘ, as Fluent's info button opens its popover, or from Show Agent Details for the
keyboard (UX-2.3, 3.1), and close on Escape, a press elsewhere, the ⓘ again, the focus leaving them - Tab and Shift+Tab
leave them - a scroll of the card list, the view losing the focus or the card going; a scroll within the details keeps
them open. Nothing in the panel opens on hover and no element has a native tooltip:
everything a card offers is one click (2.2). The details are as wide as the card, in the editor's hover colors, border
and corners, with Fluent's popover shadow, 12 px in, their arrow at the ⓘ; they open below the card, or above it where
they do not fit below and there is more room above, stay on the side they opened on while they fit there, and scroll within themselves where neither side has
room. They enter as Fluent's popover does, fading in as they slide 10 px in from the ⓘ's side over 400 ms, slowing to
a stop, and leave at once; with reduced motion they only appear (UX-2.2). Open, they follow the card's state with no new
entrance: a fact's words are written again only where they changed, and those of a fact with selected text in it once
the selection ends; how long ago is said again whenever its words would change - seconds each second, then each age
where the minute words change, and each minute past the hour - with UX-2.4's steps and rounding. Their text can be
selected.

Each line is one fact after its 16 px codicon in the quieter color, 13/20 px, 4 px apart, a long one wrapping whole,
never cut:

1. `comment-discussion`, as VS Code's chat marks a conversation: its conversation's complete title as its CLI
   stores it, the one Resume Agent lists (CLIS-2.4) - an actual stored title kept even where it equals its CLI's name or the agent's - else, after the same `Title: ` label, in the
   quieter color, `No title yet` when Facade has no title from a CLI whose history it can read, or `Title unavailable` where Facade has no history
   reader for its CLI - a custom program (CONFIGURATION-2.3) - so none can come. Never its terminal's title, nor its creation prompt.
2. `tag`: who - its name, then in the quieter color its short run ID: `Hinge #a1`. An empty name is its `#aN` alone.
3. `clockface`: when it started, in the text color, as Resume Agent says a time: `Started 5 mins ago`,
   and for an agent another started `Started 5 mins ago by Ada #a3`. How long ago is in Resume Agent's words and steps
   (LIFECYCLE-3.2, UX-2.4), `just now` below 30 seconds, its first letter in lower case within the sentence; a wrap
   never parts the time's words, nor the starter's name from its `#aN`. A start the source clock puts ahead of the
   host's says its date and time instead. The start is the run's own, else its creation's.
4. Where it works, always, after the icon Facade's location pickers give it: `repo` for a main checkout, `worktree` for
   a worktree, `folder` for a folder, a workspace folder opened inside a checkout among them (WORKTREES-1.2) - its branch, else its folder's name, after its workspace folder's
   in a multi-folder window and before a non-local environment's. A folder inside one of them, which a resumed
   conversation works in, says the location it is inside.
5. `folder`: its complete path, the home folder written `~` except on Windows, every component kept.

Its avatar, CLI, state, second line and window are not said again. The CLI is the avatar's to show and the state the
dot's (1.4, RULES-3.2): a CLI that reports nothing within CLIS-2.3's start bound turns its dot red, and activity unknown
later in a run shows no dot until the CLI's next report; the state in words is the accessible label's. The second line
is the card's, and the window is the one the panel is in. The details have these five lines and no other: no state, no
second line, no dot, no tooltip or hover for text a card cuts off. Where the theme's quieter color reads below 4.5:1 on the hover color, the quieter words and icons take its
text color (UX-2.1). The page makes the details with a dialog's role, named by row 2, who the agent is. They are nonmodal, with no
focus trap: Show Agent Details puts the keyboard's focus in their scroll area, Tab and Shift+Tab leave and close them,
and Escape takes the focus back to the card (UX-2.3). A screen reader hears the title, the location and the path after their localized `Title: `,
`Location: ` and `Path: ` labels, out of sight, each such `Label: {0}` text keeping its value last in every language.
A card the filter hides (2.3) has no details to open: Show Agent Details is offered for the selected card only while
it is shown (UX-3.1), and opens nothing for a card gone meanwhile.

Accessible label: name, short run ID, `Pinned` for a pinned card, state, location, CLI, and the second line where it
says what the state does not, its source said in words - a message from an agent, the person's input or a Facade
result - rather than by its mark, and Facade's own words as the second line says them, unmarked. A red card's label says `Error · {reason}`
once, as its state, and not its reason again. The card's accessible description says what the
details add to it, in their order: the title where the label does not say it already, when it started, the location
where its environment is more than the label says, and the path. The details are in the accessibility tree while they
show, the buttons never. Use a listbox named `Agents`, options with `aria-selected`, decorative icons hidden, one roving
Tab stop. Update labels in place. State-change announcements are polite, coalesced, and do not repeatedly announce
spinner/progress ticks.

## 2 List and actions

### 2.1 Order and selection

**The list is two manually reorderable queues, Pins first; state changes do not move cards.**

A new card, whether a person or an agent started it, goes last in the ordinary area. Pin moves a card last among the
Pins, also where it takes its conversation's existing Pin (LIFECYCLE-3.4). A card that leaves the Pins - by Unpin, or
because another card took its Pin - goes first in the ordinary area, just below the Pins it left. A new card the person
started, which is selected, scrolls into view; one an agent started does not move the list. Move Up/Down works within
both the Pin and ordinary areas; hidden cards retain their relative positions. Persist Pin order by Pin ID so
restoration keeps it. Explicit close removes a card immediately; no stopping card remains. There are no batch actions or
automatic creation-tree grouping. Click selects immediately and opens or reveals its terminal (LIFECYCLE-2.2). Selection
follows the last active owned agent terminal, survives focus on a file/unrelated terminal and its tab being hidden, and
disappears when that record is removed. A failed launch remains selected; background starts do not change selection.
While a reload, an extension-host restart or Pin restoration opens its pinned agents' tabs one after another the
selection does not move; once they are open it is on the last one opened, in front of the active group, or where none
opened as it was: LIFECYCLE-3.5's tab procedure owns that order, this list only its final selection.
Keyboard focus and selection are independent.

### 2.2 Card menu

**A card's flat native menu opens from its gear, with only actions meaningful to its current record; a right click
opens nothing.**

A left click on the gear opens the menu under it, and Shift+F10 and the menu key open it there too (UX-2.3): the page
dispatches the context menu event on the card itself, so the editor shows its native webview menu with the card's
context. The person's right click opens nothing, on a card or anywhere in the view: on macOS a right click leaves an
inactive window inactive, and the editor then shows the menu in the active window, where a left click activates its
own window first. While the menu shows, its card keeps its buttons, the gear pressed. Where the editor's menus are its own
rather than the system's - `window.menuStyle` `custom`, or `inherit` with the custom title bar, as by default on Windows
and Linux - it draws the menu in its window over the page, and from the pointer's next move the page hears only that the
pointer left. A leave the page hears while a card's menu is open, or while the editor shows one, is therefore the menu's:
the card the pointer was on stays as under it - its buttons and, unless selected, its hover color, and once the menu
closes high contrast's dashed edge (UX-2.1) - until the page hears of the pointer again, on that card or elsewhere, or
until 1000 ms after the menu is gone, closed or never shown, with nothing heard. A click on the card that closes its menu,
its press reaching the editor's menu and only its release the page, so leaves the card as it was. Groups: Rename; Move
Up/Down; End Agent for starting, live and retained-ended records. It has no other entries: no Pin or Unpin, which the card's Pin
button and the palette do (1.3, UX-3.1), no worktree deletion or bulk selection action. Enable actions by actual
availability; name editing need not wait for CLI readiness. LIFECYCLE-3.1 owns End Agent. No menu outside a card, not even the webview's
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
`clearFilter`, `openFolder`, `rename`, `pin`, `unpin`), and diagnostic `error`; host sends `state`, `scrolling`, `details` - Show
Agent Details' run, whose card the page opens the details of for the keyboard once it has drawn the state (1.5) - and
matching action outcomes. `open` serves a card's click, Enter and Space, `rename` its F2 (UX-2.3), `pin` and `unpin` its
Pin button (1.3), and the others the empty-state buttons of 1.2; `rename` asks the host to open the native Input Box, and the host validates the target. Context menu
commands run in the host through validated targets. Page-held state is navigation/typeahead/scroll, not business rules.
Use the webview's saved page state to restore the still-valid scroll position and keyboard navigation target when the
person hides and reopens the view; restoring a navigation target does not take actual input focus. Rebuild current cards
from the host model and discard a navigation target whose card is gone. Saving, creating or removing facade.json
refreshes the cards, so a changed icon appears at once (CONFIGURATION-2.4). Use this saved page state without a host
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
| 1.1–1.5 | Built-in and robot avatars; eye reach/easing, gaze kept through terminal focus, menus, pointer leave, selection and updates; gaze updated on pointer entry, press and scrolling, both reduced-motion settings with immediate centering on preference change without a pointer event and no frames at rest; title and menu entries, the empty and filtered states, the failed-start and missing-component pages and the no-folder New Agent prerequisite, empty/filter distinction, slow/no Git, the green and red dots and no dot otherwise, error/ended first, then a native blocker before other red conditions or generic unavailable status, with its CLI's own words kept (1.4), the state in words in the accessible label alone, the card's buttons and five-line details with no state, hover popup or native tooltip, all widths/themes/accessibility |
| 2.1–2.3 | Insertion into the two queues and manual order, retained failure, the selection unmoved while the pinned tabs of a reload, an extension-host restart or Pin restoration open and on the last one opened after, exact context target from the gear and the keys, no menu on a right click, the card under the pointer kept through the editor's menu and the click that closes it, filter removal/read failure |
| 3.1–3.3 | Generation-isolated replies/actions with current target validation, coherent badge, icons refreshed on settings save/create/remove, XSS/command-link payloads, hide/show browsing-position restore without focus theft, input-to-paint and scrolling |

Evidence: [Verification](../engineering/VERIFICATION.md). Visual tests use an isolated editor profile.
