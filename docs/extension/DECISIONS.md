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
| O01 | Super Engineer and Super Team equally important; no mode/team wizard | PRODUCT-2.1 |
| O02 | Panel, editor terminals and basic runtime MCP; prompts/skills own workflow, no task concept | PRODUCT-3.1 |
| O03 | Capability before familiarity before simplicity; agreed scope, no speculative feature expansion | PRODUCT-4 |
| O04 | All VS Code users; free MIT desktop extension, own CLI/accounts, compatible editors, no hosted model service or multi-user product | PRODUCT-1.2, 5.2 |
| O05 | Local, SSH, WSL and containers execute where their workspace lives; interoperability is first-release scope | PRODUCT-5.3, 5.6 |
| O06 | Plain and multi-folder use works without Git; worktree creation/use is optional | PRODUCT-5.4, 5.5 |
| O07 | Agents connect across client windows; every human UX manages its current window only | PRODUCT-5.6, LIFECYCLE-2.3 |
| O08 | Human last successful location/CLI, editable name label, folder/worktree choices in the picker | LIFECYCLE-1 |
| O09 | Accepted start immediately creates pair; actual launch error retains it; usable CLI survives tool failure | LIFECYCLE-1.5 |
| O10 | Green work, yellow not working, red error or unknown reliable status; reason in second line | RULES-3.2 |
| O11 | Normal exit closes; abnormal retains red; unknown cause no guessed popup | RULES-3.3 |
| O12 | Explicit agent startup choices remain; all launch origins share the current-setting YOLO rule | MCP-2, RULES-4.3 |
| O13 | Success means the recipient has the complete message: CLI acceptance by the selected submission path, or a read_messages handback under D88 | RULES-1.3 |
| O14 | Two-second initial response; an attempt every three seconds in a fifteen-second stage, waiting up to ten minutes for an input another draft or a native question holds (D106); results to the agent sender for both outcomes, never human fallback | RULES-1.2, 1.5, 1.7, 1.8 |
| O15 | Ordinary messages protect drafts; no typing-idle timer or post-check human-typing race machinery | RULES-1.4 |
| O16 | Duplicate delivery is accepted; the injected skill tells the model to deduplicate by message ID | RULES-1.6, MCP-6.2 |
| O17 | Any window close ends its own agents; no reopening replay; sender-only close needs no guaranteed delivery handover | RULES-1.9 |
| O18 | Reload preserves original runs; creator closure does not close children; explicit close removes UI immediately | RULES-4.1 |
| O21 | Preserve tree-limited non-YOLO reach and native sandbox mapping; use the single launch-time setting policy | RULES-4.3, CLIS-1.3 |
| O22 | Owner-revised on 2026-10-29: names are trimmed label strings; empty strings, spaces, duplicates and `human` are allowed. Empty is still `name: ""`, with its existing UI slot, not an absent field or an automatic replacement. The person has ID `#human`; an agent named `human` is identified by its own agent ID. In messages `#human` addresses the person (D91) | LIFECYCLE-2.1, RULES-2.3 |
| O23 | Direct text/keys have no input-policy choice/draft guard or arbitrary text single-line/length cap | COLLABORATION-1.2, MCP-5.2 |
| O24 | No Git initialization/initial commit; worktree deletion only as D73; native Git creation and no post-create setup gate | WORKTREES-2, 3 |
| O27 | Agent terminals only in editor | LIFECYCLE-2.2 |
| O28 | Nine MCP tools; D110 adds optional request_id to start_agent and send_message; no get_operation/recall/bulk/rename/deletion extensions; inbox reads only one's incoming messages | MCP-1, 3, 4 |
| O29 | MCP switch affects future injection only; no authentication/tokens/delegation; IDs are addresses, normal tree policy remains | RULES-4.4, ARCHITECTURE-2.1 |
| O30 | Initial prompt uses native interactive arguments if supported, otherwise automatic post-start message; no unattended overlay | COLLABORATION-2.2, CLIS-3.2 |
| O31 | Message History is window-local and view-only, automatically cleaned after 30 days; no vendor-history deletion | COLLABORATION-3 |
| O32 | Badge counts cards; manual order | PANEL-1.1, 2 |
| O33 | No default global shortcut; empty-panel explanation instead of onboarding; locales and fixed visual values retained | UX-2, PANEL-1.2 |
| O34 | Real known human errors may notify; agent errors return to their initiator, and an agent message chain never automatically notifies people | RULES-1.8, 3.4 |
| O35 | G1–G3, G5, local plus two remotes, first use, 100 agents/window and human walkthrough are first-release acceptance; 100 is not a cap | VERIFICATION-2, 3 |

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
| D09 | Reversed: client connectivity does not imply unrestricted reach; tree policy remains, historical YOLO inheritance is superseded | RULES-4.3 |
| D10 | Retain complete ordinary messages and no batching/reminder-as-delivery; the separate fetch state is superseded by D88's single delivery state | COLLABORATION-2, 3 |
| D11 | Remove caller request keys and get_operation; startup discovery remains as list_start_options. D110 gives start_agent and send_message an optional request ID again | MCP-1–3 |
| D12 | Retain ordinary-folder-first catalog and stale Git observations without inventing deletion | WORKTREES-1 |
| D13 | Retain selected source/base, remove all Git initialization and initial-commit flows | WORKTREES-2 |
| D14 | Retire Facade deletion, including external-tree eligibility and preview. Superseded by D73 for a confirmed clean linked worktree; the rest stays retired | WORKTREES-3.2 |
| D15 | Retire deletion consent/fingerprints/peer queries/leftover cleanup with the deleted feature. Superseded by D73 for a confirmed clean linked worktree; the rest stays retired | WORKTREES-3.2 |
| D16 | Reversed: native post-create preparation does not block CLI startup or become a Facade job | WORKTREES-2.4 |
| D17 | Retain original remote URI and caller-readable generated long results, without authenticated transfer | COLLABORATION-4.2 |
| D18 | Remove workflow warmups/latest-session fallback; restore native prompt arguments where supported | CLIS-3.2 |
| D19 | Owned PTY accepted; still one product/install and actual packaging proof required | ARCHITECTURE-1, 4.3 |
| D20 | Retain public APIs and exact context targeting; no guessed foreground terminal | UX-3.2 |
| D21 | Retain actual window-lifetime evidence gates, without claiming timers prove them | VERIFICATION-2.1 |
| D22 | Remove security leases; retain true process ownership and honest unreachable cleanup | ARCHITECTURE-2 |
| D23 | Simple bounded buffers/retention; no permanent accumulated-operation quota | RULES-5.3, ARCHITECTURE-2.4 |
| D24 | Retain specified theme/visual values and ordinary-location wording | UX-2.1 |
| D25 | Superseded: direct terminal input has no draft guard | COLLABORATION-1.2 |
| D26 | Remove manual history hide/delete; automatic Facade message expiry remains | COLLABORATION-3.3 |
| D27 | Retain quiet progress in existing UI and errors directed to their initiators | UX-1 |
| D28 | Remove required protect_draft/direct policy; direct input is direct, ordinary messages always guard drafts | MCP-5.2 |
| D29 | Retain reproducible builds, separate isolated fixture stage, README staging markers and target-native notices | ARCHITECTURE-4 |
| D30 | Retire the entire automatic human fallback/notification claim/recovery mechanism | RULES-1.7, 1.8 |
| D31 | Retain repository layout/test safeguards; task-specific arrangements follow current user instructions | ARCHITECTURE-4, 5 |
| D32 | Retain discoverable empty windows and ordinary/external-created locations; child inherits own tree, catalog is not global agent authorization | MCP-2 |
| D33 | Retain two-second first-ingress timing; internal hops do not restart it | RULES-1.2 |
| D34 | Remove token hashes, authenticated binding/delegation/cleanup authority; retain unique non-reused run addresses and correct routing | ARCHITECTURE-2.1 |
| D36 | Owner-delegated choice: natural sender-close lifecycle; drop unreachable system receipts, report B's actual reply failure to B only | RULES-1.7, 1.9 |
| D37 | Owner-authorized: no compatibility migration or aliases from development builds; their records are ignored with one log line, old MCP calls fail explicitly, no user data deleted | ARCHITECTURE-4.2, UX-3.2 |
| D38 | Owner-authorized: webview `act` adds clearFilter, openFolder and rename for the empty-state buttons and F2; the host opens the Input Box and validates | PANEL-3.1 |
| D39 | Owner-revised in IA-03: the native picker title uses middle dots and keeps name/location visible while filtering, including the folder in multi-folder windows. A planned worktree uses `(new)` in the title and retains its source in the location row. Missing history silently falls back. The branch input has a placeholder and shorter source prompt. The latest confirmed screenshots use `Select a branch or worktree` without a folder suffix and no custom Change Name prompt, without restricting name labels | LIFECYCLE-1.1, 1.2, 1.3 |
| D41 | Owner-authorized: the 160 ms removal animation follows only a normal exit; explicit close and confirmed location removal are immediate | UX-2.2 |
| D42 | Owner-authorized: test-only `state`, `selectRow` (by run ID) and `probe` commands; the first draft's hidden scripted start was withdrawn because the owner-approved R9 removal stands | UX-3.2 |
| D43 | Owner-authorized: Settings sections are Agents, then each built-in CLI in CLIS-1.1 order, then Custom Agents | UX-4.1 |
| D44 | Owner-authorized: type_text takes printable Unicode plus tab/LF/CR and refuses other controls toward press_keys; no press_keys count limit; protocol_incompatible. Its immediate capability_unverified is superseded by D89's `unsupported` | MCP-5.2, MCP-1.2 |
| D45 | Owner-authorized: a window ID is a routing address that can change on reload; the same run IDs reattach | ARCHITECTURE-2.2, RULES-2.2 |
| D46 | Owner-authorized: `FACADE_AGENT` carries the run's `#aN` alias | CLIS-1.2 |
| D47 | Owner-authorized: confirmed deletion needs a successful Git read without the worktree (or marking it prunable) and a missing root; launch-location association; feature-detected Git extension creation API | WORKTREES-1.3, 3.3, 4.1 |
| D48 | Owner-authorized: activity is verified per run by an OSC 7501 probe answer or valid reports, independent of version; quirks stay version-scoped | CLIS-2.1, 2.3 |
| D49 | Owner-authorized: a declared maintained native prompt mapping is used while unverified and reports its capability state; otherwise post-start delivery | COLLABORATION-2.2, CLIS-3.2 |
| D50 | Owner-authorized: `.agents/` is untracked because the product injects its `facade` skill there; repository skills avoid that name | ARCHITECTURE-4.1 |
| D51 | Owner-authorized: `npm run package` and `npm run test:package` join the documented and required checks | ARCHITECTURE-4.1, 5.1 |
| D52 | Owner-authorized: isolated editors are official VS Code builds with sanitized environments and short roots; no editor CLI against a default profile | ARCHITECTURE-5.2 |
| D53 | Owner-calibrated: the store is `<FACADE_HOME or ~/.facade>/extension`, overridable for tests; `FACADE_HOME` (default `~/.facade`) is a root shared with the Facade Code IDE, and the extension uses only its `extension/` subfolder | ARCHITECTURE-3.1 |
| D54 | Derived from independent-review item 5: palette availability keys follow the selected run (`agentSelected*`), not the active terminal, so a file in front keeps the actions | UX-3.2 |
| D56 | Owner-authorized G3 probes of the owner's installed, signed-in Claude Code 2.1.312 and Codex 0.165.0 on macOS; their recorded screens are the input readers' fixtures. Superseded by D89: a version list no longer gates input | VERIFICATION-2.1, CLIS-2.1, 5.1 |
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
| D83 | Owner-decided 2026-10-31, after trying them: Show Agent Launch and Show Agents Log are commands only, in the Command Palette; the view's `…` menu does not list them, as Facade Dots' did | PANEL-1.1, UX-3.1 |
| D84 | Owner-decided 2026-10-31, after the filter's steps: Show Agent Launch chooses its location in steps by folder - the folders, one with two or more locations opening a step of them; a window of one folder lists its locations - offering locations alone, main checkout first and with no separator, rather than one list grouped by folder | CLIS-4.1 |
| D85 | Owner-decided 2026-10-31, after VS Code 1.105 - the declared minimum - showed New Agent's title button with no icon, its codicons having no `new-session` before 1.111: New Agent shows Facade's own copy of that glyph, shipped with the extension, in every editor. Using the editor's own where it has one would take a second New Agent command, listed beside the first in Keyboard Shortcuts. Neither the minimum version nor the icon's look changes | PANEL-1.1 |
| D86 | Owner-decided 2026-10-31, after the night verification found that agents still running in 0.0.1's ptyd (protocol 8) were only kept alive, unseen, by a window updated to protocol 9: every agent Facade started stays shown in its window's panel and editor, whatever the reason, red where it is in error. As Orca keeps every released daemon protocol attachable, a build speaks each earlier released protocol and operates each run through the ptyd that holds it. A lost or damaged window identity record (ARCHITECTURE-2.2) stays the exception: refusing is safer there than guessing whose agents they are | RULES-4.1, ARCHITECTURE-2.4 |
| D87 | Owner-decided 2026-10-31, after the night verification found the panel scrolling natively - about twice a list's step a wheel turn on Windows, gliding, its list settings unread - though R7 had kept the full contract: the wheel is VS Code's own list code, ported, so that it scrolls exactly as a list does; the scrollbar stays the page's, in VS Code's colors. An overlay scrollbar that hides and fades as VS Code's does would have to be drawn by Facade, a change of its own | PANEL-3.3 |
| D88 | Owner-calibrated 2026-10-30: messages are one full paste plus Enter, with no doorbell or reminder line. A message has one delivery state: delivered once its terminal submission is confirmed or once read_messages hands it to its recipient; there is no separate fetch state. read_messages without IDs returns the records not yet delivered and delivers them; a record read while being pasted is not pasted again, and its sender's result says read_messages. Claude decided, under the owner's delegation of such details, that a record read after its failure result becomes delivered without a second result. Revises D10's separate fetch state | RULES-1.3, 1.7, COLLABORATION-3.1, MCP-4.2 |
| D89 | Owner-calibrated 2026-10-30: no CLI-version gate on message input. Every version is attempted; input readers recognize the input box by its layout; an unrecognized layout is never typed into and fails at the deadline as `input_unknown`, naming the CLI and version; a CLI without a reader fails at once as `unsupported`. Replaces D56's version list, which the owner's installed Claude Code 2.1.314 and Codex 0.166.0 had already left | CLIS-2.1, RULES-1.4, MCP-1.2, VERIFICATION-2.1 |
| D90 | Owner-calibrated 2026-10-30: with YOLO off as with it on, Facade's own tools never ask for approval (Claude Code `--allowedTools mcp__facade`, Codex `default_tools_approval_mode="approve"`), while the CLI's own commands and edits keep their approvals. Derived with it: the server is never required, so its failure leaves a usable CLI | CLIS-2.2, MCP-6.1, RULES-4.3 |
| D91 | Derived from O22: `#human` addresses the person; `@human` does too unless an agent in the caller's reach is named `human`, when it is ambiguous like any repeated name | RULES-2.3, MCP-4.1 |
| D92 | Owner-calibrated 2026-10-30: after an accepted send the sender receives a Facade result whether the message was delivered or not, for completeness; budgets stay at two seconds and five attempts within fifteen seconds | RULES-1.5, 1.7 |
| D93 | Owner-requested 2026-10-30: agents reach every Facade window on this client computer, local and Remote-SSH. Claude chose, under the owner's delegation, a network without a central process: each window component listens on its own local socket and registers in a client registry; the caller's window handles calls, the recipient's window delivers, and aliases are allocated client-wide | ARCHITECTURE-1.1, 2.1, RULES-2.1, COLLABORATION-1.1, 4.1 |
| D94 | Derived from the 0.0.1 remote first-install failure, where VS Code activated the remote extension before installing its local dependency and offered no reload: the window component installs through `extensionPack`, activation waits up to 60 seconds for it, and its absence is explained in plain words | ARCHITECTURE-4.3 |
| D95 | Claude chose under the owner's 2026-10-30 delegation: `facade.collaboration.enabled` and `facade.collaboration.waitSeconds` join `facade.yolo` in the Agents section, keeping D43's section order. The editor names a setting after its key, so both copy reviewers rejected the earlier `facade.orchestration.enabled` (shown as "Orchestration: Enabled") and `facade.timeout` under D96; both settings are new in this step | UX-4.1, RULES-4.4, MCP-1.3 |
| D96 | Owner-requested 2026-10-30: everything a person sees is plain language; internal terms such as run, ptyd, shim, MCP server, capability, adapter, route, protocol or broker never appear in it | UX-1.3, PRODUCT-4.2 |
| D97 | Owner-requested 2026-10-30: this release covers all nine tools, control and messages across windows for every built-in - Claude Code, Codex, Antigravity, Muse Code, OpenCode and Pi - releasable rather than a prototype, with no built-in left out ("一次搞定"); Claude included start_agent's optional model/effort and prompt under the owner's delegation | MCP-2.2, CLIS-1.4, 2.2, PRODUCT-5.1 |
| D98 | Superseded by the owner's D86: the earlier delegated choice showed 0.0.1 agents in terminals alone after an update. Released protocols now keep those agents in the ordinary panel and terminals, with supported operations routed to their original ptyd | ARCHITECTURE-2.4, RULES-4.1 |
| D99 | Claude chose under the owner's 2026-10-30 delegation: the native backend is node-pty 1.2.0-beta.15, pinned exactly, the backend VS Code 1.143 itself requires. node-pty 1.1.0's Windows exit watchers change its shared console list without a lock (fixed by node-pty #922), which the Windows runs of 2026-10-30 caught as heap corruption and access violations when several consoles ended together - in ptyd, the end of every agent of every window. On Windows a console is also ended once: a second kill reaches a console already freed | ARCHITECTURE-2.4, 4.3, VERIFICATION G5 |
| D100 | Claude chose under the owner's 2026-10-30 delegation, each from that CLI's own behavior on this Mac that night: Pi registers the server for its session from a per-run extension (`-e`), its tools given to the model directly, and the skill from `--skill`. Antigravity reads servers only from its own configuration or a plugin, so a folder plugin is shared by the folder's runs; its `--settings` replaces a key whole for the session, so Facade's allow rule is added to the person's own permission rules; it starts a folder's plugin servers only with its first turn, planned before they connect, or its MCP panel, so a start opens and closes that panel before the first turn and its first task follows, and the server marks its tools to be given directly. Muse Code is given the server for the run alone by `-c`, its variables references to its environment; its arguments pass cmd.exe on Windows, which cannot carry JSON, so there its server is an entry of the project's `.mcp.json`, its variables `${NAME:-}` references - an unset plain one turns off every server of the person's own sessions there - and Claude Code's runs disable a project's `facade` entry, which would ask about it at their start; Muse Code has no rule for one server's tools, so with YOLO off they follow its own approvals and review, and its effort, a JSON string, is not offered through cmd.exe. OpenCode's shared background service would not read a run's configuration, so a run with the tools has its own server process (`--standalone`) and the run's inline configuration, put on the person's own; its interface takes no model or effort. A server started without a run's variables offers no tools | CLIS-1.3, 1.4, 2.2, COLLABORATION-2.2, MCP-6.1 |
| D101 | Owner-approved 2026-10-31, from the comparison with T3 Code and Orca: a CLI whose startup update prompt would stop the first task it is given starts without that prompt in Facade's launches - Codex with `-c check_for_update_on_startup=false`, as Orca starts it; the person's own sessions still prompt. Claude Code, OpenCode and Antigravity update in the background, Pi only notes a new version and Muse Code's launcher asks only to sign in, so they keep their own behavior. Codex is also told to wait up to 10 s for its optional MCP servers before its first model request (`mcp_optional_startup_grace_ms=10000`): T3 Code found that its 1 s default leaves a server that starts slowly out of the first turn | CLIS-2.2, 3.2 |
| D102 | Owner-approved 2026-10-31: the tools' arguments are advertised in a shape every model provider takes - each value with a `type`, no `oneOf` - because T3 Code saw Gemini refuse a whole tool list over one argument without a type and OpenCode send union arguments as JSON text. `read_messages` `ids` and `press_keys` `keys` are advertised as lists; a single string, or a list written as JSON text, is still taken as that list | MCP-1.1, 4.2, 5.2 |
| D103 | Owner-approved 2026-10-31: Claude Code applies a folder's trust to every folder below it, so Facade never writes it for the home folder, a folder above it or a filesystem root, as Orca refuses; and no CLI's missing configuration file is created only to hold a trust. In both cases the CLI asks its own question in its terminal | CLIS-3.3 |
| D104 | Owner-approved 2026-10-31, from Orca: a message's text goes into its recipient's input at most once. A later attempt presses Enter only over the message's own draft - its text, or its CLI's placeholder for a paste of its size - and an input that empties after an Enter of the delivery confirms it; a paste that never showed is not typed again either (amended by D118). Orca found that typing again a prompt the CLI took slowly delivers it twice, and counts a written prompt as delivered; Facade also never presses Enter over a draft that is not its own. Supersedes RULES-1.6's retry of uncertain delivery into a usable input | RULES-1.3, 1.4, 1.6; CLIS-2.1 |
| D105 | Owner-approved 2026-10-31, from Orca's measurements: Enter waits for the CLI to take a paste of the message's size - its bytes at 4 KB a millisecond, ConPTY's 64 bytes a millisecond on Windows, and 45 ms a line more for Antigravity, which takes seconds to expand a long paste - on top of the input showing the message's own draft | CLIS-2.1 |
| D106 | Owner-approved 2026-10-31 ("the same as Orca"): a delivery whose recipient's input holds a draft that is not the message's own, or a native menu, login or question, waits for it, trying every three seconds, up to ten minutes from the stage's start, as Orca holds its notices while a person types; it never submits the person's text with the message. An unknown input still fails at fifteen seconds. Supersedes the fifteen-second failure of a held input in O14 and D92 | RULES-1.4, 1.5; MCP-4.1 |
| D107 | Owner-approved 2026-10-31 (plan items B4 and B5), from Muse Code 1.4.14 run headless with its echo provider in an isolated home: a run's MCP server that does not start fails the whole run unless its entry says `"mode": "optional"`, which T3 Code also sets, so Facade's entry says so; and a prompt after `--` that is exactly one of its commands' names, such as `login`, is refused as an unknown argument and the CLI exits, so a first task of one lowercase word goes after startup instead | CLIS-2.2, 3.2 |
| D108 | Owner-approved 2026-10-31 (plan item B12), from Orca: Claude Code takes a paste alone as pasted material, and Orca saw it refuse a brief that came that way, so Facade types `Act on this Facade message: ` before a message's paste to Claude Code, in the same write, as Orca types its lead: the person's own words that ask it to act. Only a message has it; a Facade result asks for nothing. Other CLIs take the paste alone, as Orca found Codex drops typed text that shares a paste's write. A ptyd from before leads ignores one, and the message then goes as before | COLLABORATION-2.1; CLIS-2.1 |
| D109 | Owner-approved 2026-10-31 (plan items B15 and B16), from Orca and T3 Code: an agent another agent of the same window started, whose CLI has reported its own permission, question or sign-in for twenty seconds, is reported to its creator once each time it starts waiting. Owner clarification on 2026-10-31: this reports a blocker, never an instruction to contact the person or forward the notice; the person's task instructions decide human contact. Permission and sign-in remain the person's to authorize or perform. A first task the CLI cannot start for a question of its own is reported the same way. Never a person, never a creator of another window or one that ended | RULES-1.8 |
| D110 | Owner-approved 2026-10-31 (plan item B18), from T3 Code's `clientRequestId` and Orca's `--retry-request`: start_agent and send_message take an optional `request_id` of the caller's own. The same one again from that caller within an hour answers the agent or message the first call made, as it stands, and starts or sends nothing again; it is kept on the run's metadata and the message record, so a reload in between keeps it. This supersedes D11's removal of caller request keys for these two tools; the other seven take none | RULES-1.1; MCP-1.1, 2.2, 4.1 |
| D111 | Owner-approved 2026-10-31 (plan items B6, B7 and C5), from T3 Code: the shim speaks MCP 2025-11-25 as its newest version, so a newer CLI never falls back or leaves; its instructions tell a CLI that lists tools by name alone until loaded - Claude Code defers MCP tools behind its tool search - to load one before calling it; and a test keeps the tool list, instructions and skill within a byte budget, as T3 Code's AgentContextBudget test keeps what every turn of every agent pays for from growing unseen | MCP-6.1 |
| D112 | Owner-approved 2026-10-31 (plan item C3), from Orca's recorded boot traces and live screen rules: `scripts/capture-inputs.mjs` records a built-in's input box for each paste case without submitting, and checks the readers and own-draft recognition; its screens become recorded cases. Its first run found that Codex 0.166.0 draws `⚠ 1 warning · f2 to view` at the end of its hints row, alone there under a draft, whenever `-c` overrides run it outside its background server - which every Facade launch of Codex has - and its reader read that input as unknown; its reader now takes that row, and Codex always starts with `--no-daemon`, as launches with Facade's tools already did | CLIS-2.1, 3.2 |
| D113 | Owner-approved 2026-10-31 (plan items B13 and B14). B14: T3 Code's source reads back the mark `[Earlier output truncated]` with which Antigravity sends a long argument cut to its last 8,000 characters, so a text argument that begins with it is refused with invalid_argument, asking for shorter parts, rather than delivered as though whole. B13: Codex 0.166.0 on macOS takes a bracketed paste and the Enter right after it as one submission, so its paste-burst handling is left on; Orca turns it off only where its own terminals relay typing, and on Windows, where Codex reads console input records rather than bracketed pastes, sends a pasted line break as Alt+Enter - a Windows check that remains open. type_text's Enter, like a message's, goes in a write of its own once its CLI can have read the text - a tenth of a second and the paste's time - because writes back to back may reach a CLI as one read, and Claude Code drops an Enter read with a paste's end | MCP-4.1, 5.2; VERIFICATION G3 |
| D114 | Owner-approved 2026-10-31 (plan item B17), from Orca's `No update in …`: a working card's hover says how long ago its CLI reported that work, reckoned as the pointer comes, so that a long silence is the person's to judge; the dot keeps the CLI's own report, never turned into idle or done | PANEL-1.5 |
| D115 | Owner-approved 2026-10-31 (plan item B19), from T3 Code, which wakes a parent once for the delegated tasks that settled together: Facade results on their way to one terminal while none of them is typed go in one paste, one turn of its model; the paste's text is fixed as its typing begins, and a result read through read_messages before then is left out of it | RULES-1.7 |
| D116 | Owner-approved 2026-10-31 (plan item C6): Copy Diagnostics, a Command Palette command, puts on the clipboard the versions, the CLIs, this window's agents with what their input readers read and their last screen rows, and the agents log's end, so that a problem the person meets is reported with what it needs; reading an agent's screen was the integration suite's alone. Nothing is sent anywhere, the home folder is written `~`, and its notification warns that screens can show code and keys | ARCHITECTURE-3.3; UX-3.1 |
| D117 | Owner-approved 2026-10-31 (plan item C4), from T3 Code's checks of what its agents do: each tool call is logged by tool, caller, outcome and duration, never its arguments, and the real-agent journey checks the models as well as the delivery - each message sent once, one agent started, and read_messages, list_agents and read_screen called by an agent at most two, three and two times in the journey, more being polling for what a paste brings. Whether an agent ends its turn as a tool result's `Next:` says is checked with the wording work (A), which brings it | ARCHITECTURE-3.3, 4.1 |
| D118 | 2026-10-31, within the owner's approval of B and C and of avoiding their pitfalls: from an independent review of that work and the 24-row captures it led to; each fix has its test: a send's request ID is kept on its record and travels with it to another window, and a repeated start answers as its start went; a paste whose answer was lost is never confirmed by an empty input; nothing goes in once its stop came while a read was under way; another draft after a message's text is waited for as before it, but a part of the text is not; a paste that may still show holds its terminal; a long paste's time is added to its stage's deadlines; a result joins others only with a whole stage's time before them, and a batch that typed nothing keeps gathering; a later Enter goes only over the placeholder its paste showed as; Antigravity's and Pi's scrolled drafts and Pi's `[paste #N C chars]` are read; a creator's notice that cannot be recorded is logged, not thrown. RULES-1.6's earlier sentence that a paste that never showed may be typed again contradicted its own heading and D104's at most once, and is withdrawn | RULES-1.5, 1.6, 1.10; CLIS-2.1; MCP-1.1 |
| D119 | 2026-10-31, under the owner's request for a comprehensive MCP review and fixes: request deduplication covers overlapping calls, routed retries after a lost reply, and removed runs for the original one-hour period. Run metadata is persisted before startup effects; a reload with an unknown start outcome never starts again. read_messages delivers immediately, cancels unstarted pastes, and lets only an already-issued complete Facade draft finish within its existing budget, without submitting a person's edits or typing it again. Result batches include their combined paste time. Name resolution does not guess from an incomplete window list, and @human checks other windows. Real test runs refuse the personal-home escape and global CLI state. These close correctness and test-isolation gaps rather than changing the nine-tool scope | RULES-1.5, 5.1; COLLABORATION-3.1; MCP-1.1, 4.2; ARCHITECTURE-2.4, 5.3 |
| D120 | 2026-10-31, while integrating current main into the MCP feature under the owner's approval: keep main's earlier-protocol cards and terminals (D86), while refusing newer MCP screen/input requests before sending to a runtime that cannot serve them. Custom CLIs retain their exact configured start, with no invented tools or input reader; malformed catalogs are visible in MCP discovery and diagnostics. Explicit MCP model/effort choices replace only their matching configured arguments, preserving unrelated configuration. Show Agent Launch reports withheld folder trust honestly. The creator's status notice does not request human contact or authorize answering the CLI's prompt | RULES-1.8; CLIS-1.4, 3.3, 3.4, 4.1; MCP-2.1; ARCHITECTURE-2.4 |
| D121 | Owner-authorized 2026-10-31: use Facade Dots as the reference and implement Resume, Pin and Unpin in this extension. Preserve exact vendor conversation identity, original cwd, current launch configuration, native tab synchronization and saved Pin order. MCP is assigned separately; this step does not add it | RULES-4.2, LIFECYCLE-3.2, LIFECYCLE-3.3, LIFECYCLE-3.4, PANEL-2.1 |
| D122 | Owner visual review 2026-10-31: the Pin looks disproportionately small beside the name. The preview uses a 14 px icon box, a 4 px name gap and the selected/high-contrast colors of secondary text; these sizes are the implementation's adjustment for the requested preview | PANEL-1.3 |
| D123 | Owner correction 2026-10-31: Resume, Pin and Unpin must meet release quality across all six built-ins. The initial four history readers and Claude-only Pin were an incomplete implementation, not an approved scope reduction. Verify native identity changes and preservation of user configuration for each adapter; record actual release evidence and remaining blockers. Native checks also established that Antigravity loses the original cwd when `--add-dir` is used; the implementation preserves that ambiguity and asks for a working location rather than inventing an original cwd | CLIS-2.4, LIFECYCLE-3.2, LIFECYCLE-3.4 |
| D124 | Owner's 2026-10-31 comparison with native Claude `/resume` exposed missing AI/custom titles, file mtime shown as activity and a superseded segment shown twice. Correct native metadata and continuation handling, including cache invalidation and pagination order; the all-CLI scope does not justify different facts for the same conversation | CLIS-2.4, LIFECYCLE-3.2 |
| D125 | Owner-approved 2026-10-31: the panel scrollbar auto-hides, overlays existing content without taking width, and follows the effective Modern UI setting automatically. Correct the visible webview boundary independently of decorative clearance. Modern UI leaves 2 px at the scrollbar ends and 1 px at its right; the list keeps its 4 px sides and has no additional top or bottom padding. Traditional UI has no decorative scrollbar clearance. Both modes compensate clipping for content and overlay. This supersedes D87's choice of the browser scrollbar | PANEL-3.3 |

D14–16 added mechanisms the latest review explicitly rejects; their prior code or tests are not reasons to restore them.

D38–D53 follow the owner's 2026-10-28 instruction that the product contain only what the specification requires, using
implementation feasibility findings from that day's code audit. D42 defines only test-only commands; R9's removal of
scripted start and its single human Close Agent both remain.

## Latest simplification review

The scrollbar follow-up (D125) separates actual clipping correction from visual clearance. Native lists have no extra
webview corner clip. For the default 8 px host radius, 4 px thumb radius and 1 px side clearance, the ideal minimum end
clearance is 4 - sqrt(7), about 1.35 px; 2 px is the smallest whole-CSS-pixel choice, verified at fractional display scales.
The cards already have 4 px side padding, so neither end needs decorative padding. Their right padding absorbs the
one-device-pixel guard: adding it again made the right gap visibly larger. Keep the scrollbar's separate right clearance.

The owner explicitly asked to find overdesign. The earlier review's setup barriers and extra status states were rejected
as complexity without sufficient product value. Unverified platform mechanisms stay evidence questions rather than
asserted design defects.

| Review item | Owner disposition and reason | Normative owner |
| --- | --- | --- |
| R1 | Accepted: a user must be able to change YOLO for the next start without preserving an old mode | RULES-4.3 |
| R2 | Accepted: an incomplete custom definition without a Resume command is not a supported configuration | CLIS-3.4 |
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

The earlier R7 decision still protects the PANEL-3.3 scrolling contract, whose scrollbar D87 later left to the page. No
new settings, capability-registration framework or general argument parser is introduced by this follow-up.

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

- 2026-10-31: Recorded the accepted overlay scrollbar, automatic Modern UI appearance and separate content/scrollbar clipping clearance (D125).

- 2026-10-31: D120 records the resolved intersections with main; earlier source evidence remains separate from merged-build verification.

- 2026-10-31: Integrate the parallel feature branches: preserve main's D82–D87 and renumber the MCP decisions D88–D119, updating their references; D86 supersedes the terminal-only compatibility choice.
- 2026-10-31: Clarified D109: reporting a blocker to its creator does not request contact with the person.
- 2026-10-31: Recorded D119: concurrency, recovery, read-during-paste, result budgets, reference resolution and probe isolation.
- 2026-10-31: Recorded D118: the review's fixes; D104's retyping of a paste that never showed withdrawn.
- 2026-10-31: Recorded the owner-approved D117: tool calls logged, and the real journey's checks of the models.
- 2026-10-31: Recorded the owner-approved D116: Copy Diagnostics.
- 2026-10-31: Recorded the owner-approved D115: results for one terminal in one paste.
- 2026-10-31: Recorded the owner-approved D114: how long ago a working agent's CLI reported its work.
- 2026-10-31: Recorded the owner-approved D113: a cut argument refused, and what was found of Codex's paste handling.
- 2026-10-31: Recorded the owner-approved D112: input-box captures, and what the first found in Codex 0.166.0.
- 2026-10-31: Recorded the owner-approved D111: MCP 2025-11-25, loading deferred tools, and a tested context budget.
- 2026-10-31: Recorded the owner-approved D110: request IDs on start_agent and send_message, superseding D11 for them.
- 2026-10-31: Recorded the owner-approved D109: a started agent's wait on its CLI's question goes to its creator.
- 2026-10-31: Recorded D107 from Muse Code 1.4.14's observed behavior, and the owner-approved D108: a message's lead for
  Claude Code.
- 2026-10-31: Recorded the owner-approved D104-D106: a message is typed at most once and Enter is pressed again only over
  its own draft, Enter waits for a paste of its size, and a held input is waited for up to ten minutes; O14 follows D106.
- 2026-10-31: Recorded the owner-approved D101-D103 from the comparison with T3 Code and Orca: Codex starts without its
  update prompt and waits for its MCP servers before its first turn, the tools' arguments take every provider's shape,
  and trust is never written for a home folder or into a configuration file the CLI has not made.
- 2026-10-30: Step 2 of the Facade Code extension: carried the Facade Dots rows that bear on agent collaboration (O01,
  O02, O13–O17, O23, O28–O31; D09–D11, D17, D18, D25, D26, D28, D30, D32–D34, D36, D37, D44, D45, D49, D50, D56),
  updated O05, O07, O09, O12, O18, O21, O22, O34 and O35 for this step, and recorded the owner's decisions of that day
  as D88–D99, numbered after the built-in CLIs' D77–D81 when the two lines of work were merged.
- 2026-10-31: D97 covers every built-in, at the owner's 2026-10-30 request; D100 records how Antigravity, Muse Code,
  OpenCode and Pi are given the tools, and why.
- 2026-10-31: Corrected Claude native title, activity and continuation metadata after the owner's picker comparison (D124).

- 2026-10-31: Recorded the Pin proportion feedback and preview adjustment (D122).

- 2026-10-31: Owner authorized Resume, Pin and Unpin using Facade Dots as the reference. The additive step carries
  exact vendor identity, original cwd, native tab pin synchronization and saved-order restoration; current ownership,
  five-minute cleanup, commands and launch settings remain authoritative. Collaboration metadata follows its separate step.


- 2026-10-31: Recorded the owner's decision on the panel's wheel and scrollbar (D87).
- 2026-10-31: Recorded the owner's rule that every started agent stays shown, every released ptyd protocol spoken (D86).
- 2026-10-31: Recorded the owner's decision on New Agent's icon in an editor without `new-session` (D85).
- 2026-10-31: Recorded the owner's choice of Show Agent Launch's location in steps by folder (D84).

- 2026-10-31: Recorded the owner's choice of Filter by Working Location in steps by folder (D82).

- 2026-10-31: D43 adds the Custom Agents section and R2 the required custom Resume, carried with the custom CLIs.

- 2026-10-31: Recorded the owner's choice of Show Agent Launch and Show Agents Log as commands only (D83).

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
