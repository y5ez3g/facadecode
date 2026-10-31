# Decisions and provenance

This records why rules changed; only the normative files define the product. The latest 2026-10-28 owner review
supersedes conflicting earlier O/D entries and implementation discussions.

The owner completed two top-down reviews, recalibrated the review standard and then accepted the simplification review
R1–R14 except R7's proposed scrolling reduction. Those choices are applied in the normative files. Historical review
drafts do not override current decisions; the tables below are provenance, not another copy of exact product rules. Task
assignments and execution state follow the current user instructions. The subsequent independent-review follow-up below
records the owner's dispositions of the items that bear on these rules.

## Owner-calibrated decisions

IDs remain stable for provenance; the decision column states the current owner-calibrated result.

| ID | Current decision | Normative owner |
| --- | --- | --- |
| O03 | Capability before familiarity before simplicity; agreed scope, no speculative feature expansion | PRODUCT-4 |
| O04 | All VS Code users; free MIT desktop extension, own CLI/accounts, compatible editors, no hosted model service or multi-user product | PRODUCT-1.2, 5.2 |
| O05 | Local, SSH, WSL and containers execute where their workspace lives | PRODUCT-5.3 |
| O06 | Plain and multi-folder use works without Git; worktree creation/use is optional | PRODUCT-5.4, 5.5 |
| O07 | Every human UX manages its current window only | LIFECYCLE-2.3 |
| O08 | Human last successful location/CLI, editable name label, folder/worktree choices in the picker | LIFECYCLE-1 |
| O09 | Accepted start immediately creates pair; actual launch error retains it | LIFECYCLE-1.5 |
| O10 | Green work, yellow not working, red error or unknown reliable status; reason in second line | RULES-3.2 |
| O11 | Normal exit closes; abnormal retains red; unknown cause no guessed popup | RULES-3.3 |
| O12 | All launch origins share the current-setting YOLO rule | RULES-4.3 |
| O18 | Reload preserves original runs; explicit close removes UI immediately | RULES-4.1 |
| O21 | Preserve native sandbox mapping; use the single launch-time setting policy | RULES-4.3, CLIS-1.3 |
| O22 | Owner-revised on 2026-10-29: names are trimmed label strings; empty strings, spaces, duplicates and `human` are allowed. Empty is still `name: ""`, with its existing UI slot, not an absent field or an automatic replacement. The person has ID `#human`; an agent named `human` is identified by its own agent ID. Message routing belongs to the later messaging step | LIFECYCLE-2.1 |
| O24 | No Git initialization/initial commit; worktree deletion only as D73; native Git creation and no post-create setup gate | WORKTREES-2, 3 |
| O27 | Agent terminals only in editor | LIFECYCLE-2.2 |
| O32 | Badge counts cards; manual order | PANEL-1.1, 2 |
| O33 | No default global shortcut; empty-panel explanation instead of onboarding; locales and fixed visual values retained | UX-2, PANEL-1.2 |
| O34 | Real known human errors may notify | RULES-1.8, 3.4 |
| O35 | G2, G5, first use, 100 agents/window and human walkthrough are first-release acceptance; 100 is not a cap | VERIFICATION-2, 3 |

## Disposition of earlier Codex deductions

These are engineering choices, not claims that the owner individually approved the original mechanisms. The owner
rejected several of them. Their old implementation/tests must follow the current rules rather than preserve sunk work.

| ID | Current disposition and reason | Normative owner |
| --- | --- | --- |
| D01 | Retain four layers, one active entry and clear owner/evidence distinction | README |
| D02 | Retain human successful-launch history | LIFECYCLE-1 |
| D03 | Retain distinct window/run identities as simple bookkeeping, not credentials | RULES-2 |
| D04 | Reversed: unavailable reliable activity is red, never a neutral outline | RULES-3.2 |
| D05 | Retain error precedence and clearing only the recovered condition | RULES-3.2 |
| D06 | Reversed: explicit close removes card/terminal immediately; cleanup can remain unconfirmed in background | LIFECYCLE-3.1 |
| D07 | Retire separate unseen/seen attention bookkeeping | RULES-3.4 |
| D12 | Retain ordinary-folder-first catalog and stale Git observations without inventing deletion | WORKTREES-1 |
| D13 | Retain selected source/base, remove all Git initialization and initial-commit flows | WORKTREES-2 |
| D14 | Retire Facade deletion, including external-tree eligibility and preview. Superseded by D73 for a confirmed clean linked worktree; the rest stays retired | WORKTREES-3.2 |
| D15 | Retire deletion consent/fingerprints/peer queries/leftover cleanup with the deleted feature. Superseded by D73 for a confirmed clean linked worktree; the rest stays retired | WORKTREES-3.2 |
| D16 | Reversed: native post-create preparation does not block CLI startup or become a Facade job | WORKTREES-2.4 |
| D19 | Owned PTY accepted; still one product/install and actual packaging proof required | ARCHITECTURE-1, 4.3 |
| D20 | Retain public APIs and exact context targeting; no guessed foreground terminal | UX-3.2 |
| D21 | Retain actual window-lifetime evidence gates, without claiming timers prove them | VERIFICATION-2.1 |
| D22 | Remove security leases; retain true process ownership and honest unreachable cleanup | ARCHITECTURE-2 |
| D23 | Simple bounded buffers/retention; no permanent accumulated-operation quota | RULES-5.3, ARCHITECTURE-2.4 |
| D24 | Retain specified theme/visual values and ordinary-location wording | UX-2.1 |
| D27 | Retain quiet progress in existing UI and errors directed to their initiators | UX-1 |
| D29 | Retain reproducible builds, separate isolated fixture stage, README staging markers and target-native notices | ARCHITECTURE-4 |
| D31 | Retain repository layout/test safeguards; task-specific arrangements follow current user instructions | ARCHITECTURE-4, 5 |
| D38 | Owner-authorized: webview `act` adds clearFilter, openFolder and rename for the empty-state buttons and F2; the host opens the Input Box and validates | PANEL-3.1 |
| D39 | Owner-revised in IA-03: the native picker title uses middle dots and keeps name/location visible while filtering, including the folder in multi-folder windows. A planned worktree uses `(new)` in the title and retains its source in the location row. Missing history silently falls back. The branch input has a placeholder and shorter source prompt. The latest confirmed screenshots use `Select a branch or worktree` without a folder suffix and no custom Change Name prompt, without restricting name labels | LIFECYCLE-1.1, 1.2, 1.3 |
| D41 | Owner-authorized: the 160 ms removal animation follows only a normal exit; explicit close and confirmed location removal are immediate | UX-2.2 |
| D42 | Owner-authorized: test-only `state`, `selectRow` (by run ID) and `probe` commands; the first draft's hidden scripted start was withdrawn because the owner-approved R9 removal stands | UX-3.2 |
| D43 | Owner-authorized: Settings sections are Agents, then each built-in CLI in CLIS-1.1 order | UX-4.1 |
| D46 | Owner-authorized: `FACADE_AGENT` carries the run's `#aN` alias | CLIS-1.2 |
| D47 | Owner-authorized: confirmed deletion needs a successful Git read without the worktree (or marking it prunable) and a missing root; launch-location association; feature-detected Git extension creation API | WORKTREES-1.3, 3.3, 4.1 |
| D48 | Owner-authorized: activity is verified per run by an OSC 7501 probe answer or valid reports, independent of version; quirks stay version-scoped | CLIS-2.1, 2.3 |
| D51 | Owner-authorized: `npm run package` and `npm run test:package` join the documented and required checks | ARCHITECTURE-4.1, 5.1 |
| D52 | Owner-authorized: isolated editors are official VS Code builds with sanitized environments and short roots; no editor CLI against a default profile | ARCHITECTURE-5.2 |
| D53 | Owner-calibrated: the store is `<FACADE_HOME or ~/.facade>/extension`, overridable for tests; `FACADE_HOME` (default `~/.facade`) is a root shared with the Facade Code IDE, and the extension uses only its `extension/` subfolder | ARCHITECTURE-3.1 |
| D54 | Derived from independent-review item 5: palette availability keys follow the selected run (`agentSelected*`), not the active terminal, so a file in front keeps the actions | UX-3.2 |
| D57 | Owner-calibrated: New Agent's suggested names are at least 100 short machine words (`Bolt`, `Pixel`, `Servo`), not invented personal names; a suggestion prefers one no agent in the window has, without requiring uniqueness | LIFECYCLE-2.1 |
| D58 | Owner-clarified on 2026-10-29: the native view menu holds Add Folder to Workspace..., New Worktree... when a workspace folder is open, then Configure Agents... in a separate group. New Worktree retains its standalone creation flow but is hidden from the Command Palette. Go to Agent stays in the palette; Refresh is removed. New Agent retains its contextual worktree option | PANEL-1.1, UX-3.1, WORKTREES-2.1 |
| D59 | Owner-calibrated: empty states use the reviewed copy (#m3056, final #m3060/#m3061 relayed by `#a525` at the owner's request): no-folder `Open a folder to launch coding agents.`; no-agents `Launch a coding agent in this workspace.`; the filtered empty panel counts other agents neutrally and its New Agent starts at the filtered location | PANEL-1.2, LIFECYCLE-1.2 |
| D60 | Owner-calibrated: empty-state buttons have no ellipsis, like VS Code's welcome buttons; the main action is primary | PANEL-1.2 |
| D61 | Owner-revised on 2026-10-29: Open Folder matches the built-in Git view and calls `vscode.openFolder`; sidebar selection stays with the editor, with no automatic return to Facade. Supersedes the earlier return-after-reload behavior and its early-activation workaround because they produced an extra visible view switch | PANEL-1.1–1.2 |
| D62 | Owner-calibrated: every launch trusts its folder as the person would by accepting the CLI's trust question - the CLI's own trust entry merged into its file, for Claude Code - as the Facade Code IDE did; login and permission prompts stay native | CLIS-3.3 |
| D63 | Derived from the owner's report that Change Working Location could not be clicked: skipping every single-choice step made the action do nothing; the step now shows whenever Git offers or explains New Worktree, and a lone plain folder is a label | LIFECYCLE-1.3 |
| D65 | Derived from the owner's report that every card disappeared after dragging a second folder into a single-folder window: the workspace key was the workspace's URI, which changes when the editor turns the window into an untitled multi-root workspace, so the restarted extension host claimed none of the window's runs. The key is now kept in workspace storage, which the editor carries over. Superseded by D70: the editor does not carry it over | ARCHITECTURE-2.2 |
| D66 | Derived from the owner's report of a card reading `untitled folder • untitled folder`: in a multi-folder window a location's workspace folder prefixes it to tell same-named branches apart, but a plain folder's location is named that folder already, so it shows the name once | PANEL-1.3 |
| D67 | Derived from the owner's report of `untitled folder • untitled folder · Local` in New Agent: the environment tells a remote window's machine apart, and `Local` in a local window says nothing, so it is named only where it is not this machine, as the picker's title already did | LIFECYCLE-1.1 |
| D70 | Derived from the owner losing every agent again when a folder window became a workspace, after D65. Measured in a real editor: the extension host restarts in the same editor session (`vscode.env.sessionId` unchanged) with an empty extension workspace state, so D65's assumption that the editor carries it over was wrong. Each activation records its key and folders by session in the execution Facade directory and keeps Facade's workspace state beside its runs; a later activation of the same session that still has the first folder takes them. A run shown again replaces the stale terminal tab of its name the previous extension host left. Verified end to end in official VS Code outside test mode, which refuses to enter a workspace | ARCHITECTURE-2.2 |
| D71 | Owner-approved, derived from an integration failure: while New Agent's CLIs loaded, the editor kept the focus's position across the change of items, so an Enter right as they appeared started the CLI after the preselected one. The CLI step lists nothing until the CLIs are found | LIFECYCLE-1.1 |
| D72 | Owner-calibrated: a card's location keeps its own width up to 40% of its first line, as a chat list keeps a message's time, and the name has the rest; the workspace-folder prefix is shown whole or not at all, never cut to a letter. The owner compared it with a variant that let a long location use all the room a short name leaves, and chose this one as less busy | PANEL-1.3 |
| D73 | Owner-calibrated: Change Working Location adds folders to the workspace and removes one from it in its folder step, and deletes a linked worktree in its location step; each removal first asks in a modal warning that names the agents it closes. A worktree with changes Git has not committed, or one Git lists as locked, is refused untouched; otherwise its agents close and their processes end before `git worktree remove` without `--force`, the branch kept and Git's own refusal shown. Supersedes O24's no-deletion part and D14/D15; no deletion command, agent API, preview, discard, consent fingerprint or peer query returns | LIFECYCLE-1.3, WORKTREES-3.2 |
| D74 | Owner-calibrated: the card's hover gives each fact its own line and writes the home folder as ~ (except on Windows), so the editor's tooltip never breaks a long path mid-line; compared on real tooltips before choosing | PANEL-1.5 |
| D75 | Owner-decided 2026-10-29: without a public close signal, a window's runs end five minutes after its extension host disconnects from ptyd, unless a reloaded or reopened window of the workspace claims them; reload, remote extension-host restart and network loss with the remote host connected keep them. The timer is cleanup policy, not close detection | RULES-4.1 |
| D76 | Owner-decided 2026-10-30 after a native reproduction that Close All, Close Others and Close Saved closed every agent terminal without a question: closing a terminal tab still closes its agent, but a live agent is asked about first, once for tabs closed together; Cancel keeps it and opens its terminal again; `terminal.integrated.confirmOnKill` is followed | LIFECYCLE-3.1 |
| D77 | Owner-decided 2026-10-30: Antigravity, Muse Code, OpenCode and Pi are built-ins at the level Claude Code and Codex have in step 1 - offered when installed, `.path`, the YOLO mapping, folder trust (D62), OSC 7501 activity, titles, icon and avatar - ported from Facade Dots where it had them. Their MCP, messages, Resume, Pin, model and effort follow those features' later steps | CLIS-1.1, UX-4.1, PANEL-1.3 |
| D78 | Owner-decided 2026-10-30: OpenCode is supported on its 2.x line (`@opencode/cli`), which reports its activity by OSC 7501. Its 1.x line (`opencode-ai`) sends no reports: a run of it starts and shows unavailable activity; Facade writes no plugin to make it report | CLIS-2.3 |
| D79 | Derived from the CLIs' own behavior: Pi has no approvals or sandbox, and OpenCode's default permissions allow every tool, so YOLO off leaves them as they natively are; the README says so, and Facade adds no approval mechanism of its own (RULES-4.3's sandbox applies where a CLI has one) | CLIS-1.3 |
| D80 | Owner-decided 2026-10-30, after Muse Code was found to send no OSC 7501 on Windows, signed in or not, while it reports on Linux: there is no neutral or gray dot; Muse Code alone gets a fallback, its activity read from its own screen while it sends no reports, as the other built-ins all report themselves | CLIS-2.3 |
| D81 | Owner-decided 2026-10-30, after seeing every card red for the seconds before its CLI's first report: a run is still starting - green, with its startup stage - until its CLI first shows its activity, by a report or, for Muse Code, its screen, for at most 20 s from its process start. The bound keeps a CLI that never reports, as OpenCode 1.x, from showing it starts forever: past it, the card is red with why | CLIS-2.3, RULES-3.2 |
| D82 | Owner-decided 2026-10-31, after trying the filter: Filter by Working Location steps by folder. Its first step lists All Locations, then the folders; a folder whose cards are in two or more locations opens its own step, All Worktrees then its locations; a window of one folder shows its folder's step alone (All Locations first outside Git). One separator follows each step's first item. This replaces Facade Dots' one grouped list | PANEL-2.3 |

D14–16 added mechanisms the latest review explicitly rejects; their prior code or tests are not reasons to restore them.

D38–D53 follow the owner's 2026-10-28 instruction that the product contain only what the specification requires, using
implementation feasibility findings from that day's code audit. D42 defines only test-only commands; R9's removal of
scripted start and its single human Close Agent both remain.

## Latest simplification review

The owner explicitly asked to find overdesign. The earlier review's setup barriers and extra status states were rejected
as complexity without sufficient product value. Unverified platform mechanisms stay evidence questions rather than
asserted design defects.

| Review item | Owner disposition and reason | Normative owner |
| --- | --- | --- |
| R1 | Accepted: a user must be able to change YOLO for the next start without preserving an old mode | RULES-4.3 |
| R5 | Accepted: vendor internals and arbitrary file merging do not belong in a general launch configuration language | CLIS-3 |
| R7 | Scrolling reduction rejected: the owner tried the earlier simpler scrolling and found it inadequate; retain the full existing requirements | PANEL-3.3 |
| R8 | Accepted: existing notification navigation and Go to Agent cover the need without another attention queue | RULES-3.4, LIFECYCLE-2.3 |
| R9 | Accepted: duplicate human close actions and a third scripted-start contract add no needed capability | LIFECYCLE-3.1, UX-3 |
| R10 | Accepted: duplicated exact rules drift despite passing structural checks; keep one owner and references | README-2 |
| R12 | Accepted: duplicate display names need the existing ID in search and details | LIFECYCLE-2.3, PANEL-1.5 |
| R13 | Accepted: a configured profile PATH must not yield conflicting discovery and launch expectations | CLIS-1.2 |
| R14 | Accepted: a tracked relative executable cannot be checked at a future worktree path before creation | CLIS-4.2 |

R5's concrete schema keeps literal argument arrays and environment maps. R13 uses directly configured profile env
without evaluating shell initialization. R14 moves only checks that depend on the new directory. These are
implementation-facing resolutions of the accepted simplification, not new runtime evidence.

## Independent-review follow-up

After discussion of the independent Muse/Codex reviews, the owner requested concrete user scenarios before deciding.
These item numbers match that discussion, not the earlier R1–R14 review. Accepted changes below amend the relevant
owners and verification scenarios; they are not evidence that the implementation is already correct.

| Item | Owner disposition and concrete reason | Normative owner |
| --- | --- | --- |
| 4 | Accepted: filtering or scrolling CLI choices must not hide the current name and actual launch location | LIFECYCLE-1.1 |
| 5 | Accepted: palette Rename/Copy/Close use the current selected run, including after moving focus to a file; no extra target picker | UX-3.1 |
| 7 | Accepted: a known native blocker appears before generic unavailable-activity text while preserving that explanation and existing dot/notification semantics | PANEL-1.4 |
| 8 | Accepted: returning from another sidebar view restores the still-valid browsing position without taking input focus | PANEL-3.1 |
| 9 | Deferred: use official VS Code for current tests; do not change editor isolation or claim compatible-editor acceptance in this revision | ARCHITECTURE-5.2, VERIFICATION-2 unchanged |

| Simplification | Owner disposition and reason | Owner |
| --- | --- | --- |
| Webview actions | Accepted: retain generation isolation, stable targets and current-state validation; do not mandate expected revisions or correlation IDs on every action | PANEL-3.1 |
| Rule ownership and assignments | Accepted: replace repeated status/theme/update rules with references; keep engineering safeguards and make temporary reviewer/implementer assignments follow current user instructions | UX, PANEL, ARCHITECTURE-5.3, VERIFICATION-4.1 |

The earlier R7 decision still protects the complete PANEL-3.3 scrolling contract. No new settings,
capability-registration framework or general argument parser is introduced by this follow-up.

## Evidence and open engineering gates

G2 and G5 remain defined in VERIFICATION. This document records decisions, not passing tests. Historical source/fixture
observations do not certify a current integration. Actual verification results belong with the tested build or handoff;
unavailable environments are labeled not run. Deleted historical logs are not evidence of current acceptance.

## Amendment protocol

Change the owning normative rule, dependent schema/scenarios/references, then implementation. Routine engineering
choices stay within the owner's simple scope and do not require renewed approval. Record actual contradictions or
proven platform limitations instead of silently weakening a product promise. The current authorization covers the
full spec revision; it does not authorize publication or unrelated source changes.

## Change log

- 2026-10-31: Recorded the owner's choice of Filter by Working Location in steps by folder (D82).

- 2026-10-30: D59 adds the filtered empty panel and D38 its Clear Filter act, carried with the display filters.

- 2026-10-30: Recorded the owner's addition of Antigravity, Muse Code, OpenCode and Pi (D77), the OpenCode line (D78)
  and YOLO off for CLIs that natively ask for nothing (D79), Muse Code's screen fallback without a gray dot (D80), and
  a run's startup that lasts until its CLI first shows its activity, at most 20 s (D81).

- 2026-10-30: Recorded the owner's five-minute cleanup policy (D75) and tab-close confirmation (D76).

- 2026-10-29: Corrected D58: the owner meant to remove New Worktree... only from the Command Palette, keeping the
  view's `…` entry and existing creation flow. The earlier removal of both entries was an implementation interpretation.

- 2026-10-29: The owner's latest screenshots supersede the earlier repeated-name explanation with the editor's native
  hint only, and confirm `Select a branch or worktree` without a folder suffix. Other IA-04/05 proposals await alignment.

- 2026-10-29: The owner adopts the review's branch-input wording and repeated-name explanation. Its proposed empty-name
  and `human` restrictions conflict with the owner's current naming rule and are not restored.

- 2026-10-29: The owner requires the main checkout first in each repository's location picker. Defaults retain the
  remembered/opened location. A New Worktree source in a subfolder is labeled by its checkout's branch, not the subfolder;
  the existing selected-checkout HEAD creation rule remains in WORKTREES-2.1.

- 2026-10-29: Revised D39 for the approved IA-03 presentation and O22 to allow empty labels and `human`; the person's
  distinct `#human` identity disambiguates future messaging without reserving a display name.

- 2026-10-29: Revised D58 for the approved command/menu inventory and removal of standalone New Worktree... in favor
  of Git's own interface.

- 2026-10-29: Revised D61 at the owner's request: native Open Folder behavior replaces automatic sidebar return;
  background activation returns to `onStartupFinished`.

- 2026-10-29: Recorded the owner-approved D72, D73 and D74; O24, D14 and D15 now defer to D73.
- 2026-10-29: Step 1 of the Facade Code extension, carried from the Facade Dots specification: kept the rows that bear
  on step-1 rules, with their original IDs; later steps add the others. D53 records the extension's data directory.
