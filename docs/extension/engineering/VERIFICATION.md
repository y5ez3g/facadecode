# Verification and implementation handoff

Layer 4. A target specification and a verified implementation are different deliverables. This document defines the
required evidence and records its status. No code/runtime test has been run by the specification rewrite itself.

| Group | Decides | Evidence state |
| --- | --- | --- |
| 1 Acceptance | What “complete” means and what evidence must contain | Defined; runtime pending |
| 2 Critical gates | Platform/CLI facts that must be proven first | Open; partial native evidence |
| 3 Scenarios | End-to-end behavior and focused failure coverage | Partly run with the handoff |
| 4 Handoff | Work order, reviews and reporting | Ready with spec handoff |

## 1 Acceptance

### 1.1 Three separate claims

**Specification completion, code completion and product verification are reported separately.**

Specification: owner decisions are preserved, layers agree, contracts define outcomes, and references resolve. Code:
required behavior is implemented with relevant automated tests and no knowingly omitted feature. Product: complete
journeys work in supported real editor/environment/CLI combinations, with evidence. A successful type check, mock test
or CLI launch proves only that check. Open critical gates block claiming complete product support, even if all local
unit tests pass. A documented unsupported capability is honest degradation but does not satisfy a required release
promise for a built-in advertised as supporting it.

### 1.2 Evidence format

**Every passed scenario records exactly where, when and how it was checked.**

Evidence entry: scenario ID; spec revision/hash; code revision or working-tree snapshot/hash; date; OS/architecture;
editor/client/server version; CLI and model when relevant; local/SSH/WSL/container environment; isolated data/profile paths;
command/procedure; observed result; assertion/log/screenshot path; pass/fail/blocked/not-run; known limitations. Store
results with the tested build or handoff, without credentials or full private conversations. Screenshots are
needed for visual/focus claims; traces for process/delivery/lifetime claims. Historical source claims stay historical.

### 1.3 Required gates for an implementation milestone

**Run the repository's required checks and the scenarios affected by the change before reporting the milestone complete.**

Use ARCHITECTURE-5.1's type checks, unit suite, bundle, package checks and isolated integration suite. Add failure-injection tests where
behavior involves changed input, lifecycle or result handling; a test that repeats implementation logic is insufficient.
Do not rerun unrelated expensive suites after a docs-only amendment. Re-run relevant checks when the amendment changes
behavior, and full gates at final code handoff. List unrun platform checks explicitly instead of implying a local mock
proves native support.

## 2 Critical gates

### 2.1 Platform and integration proof

**All gates must pass before first-release product completion or full support is claimed.**

| Gate | Required proof | Current evidence / status |
| --- | --- | --- |
| G1 Client network and packaging | Install the workspace component and its window component through the extension pack in clean local and Remote-SSH profiles; register windows, including windows with no agents or no folder; route every tool local→SSH, SSH→local, SSH→SSH and between two local windows; recover from stale registry entries; replace a window component on update with messages in flight; prove native backend packaging | 2026-10-30, official VS Code with isolated profiles and fake CLIs - 1.143.1 on macOS arm64, 1.144.0 on Linux x64 (Ubuntu 26.04, under xvfb) and Windows x64 (10.0.26200, in the desktop session): between two local windows on each, an agent listed the other window, started an agent there, messaged it, read its screen and stopped it. Over Remote-SSH 0.128.0 from macOS (`npm run test:remote`, each host's server in a folder of the run's own) the same journey passed local→SSH, SSH→local and SSH→SSH on Linux x64 and on Windows x64, and between an SSH window on Linux and one on Windows; the single-window journeys passed in an SSH window on each. The 0.2.0 packages were built natively for darwin-arm64, linux-x64 and win32-x64 with node-pty 1.2.0-beta.15 (D99), each passing `test:package`, and installed with the window component in clean profiles, where both parts started and registered the window under its name. Unit tests cover registry staleness, protocol mismatch, timeouts, a window not yet served and the name a window publishes. Installation through the extension pack from the Marketplace and window-component replacement with messages in flight not run; OPEN |
| G3 Draft-safe ordinary input | For every built-in, on the current version and at least one earlier one, prove input box versus menu, actual empty versus history/paste/multiline draft, working-CLI submission, full text + Enter, uncertain effects and an unrecognized layout left untouched; macOS, Linux and Windows terminals | Recorded screens of real CLIs on macOS arm64 are the readers' fixtures: Claude Code 2.1.312 and Codex 0.165.0 (Facade Dots, 2026-10-29), and on 2026-10-30 Antigravity 1.4.12, Muse Code 1.4.14, OpenCode 2.1.4 and Pi 1.4.0 - 110 screens, every reader reading every other CLI's as unknown. On 2026-10-31 the integration suite proved, for each of the six, the paste, draft protection, Enter, deadline failure and read delivery against a fake CLI drawing that CLI's own input, in macOS and Linux terminals and Windows ConPTY. Later that day, on macOS: `scripts/capture-inputs.mjs` recorded every built-in's pastes - Claude Code 2.1.316, Codex 0.166.0 with the warning under its input that its `-c` overrides bring without `--no-daemon`, Antigravity 1.4.12, Muse Code 1.4.14, OpenCode 2.1.4 and Pi 1.4.0, each paste's text kept, 37 screens, all read as expected and every paste as its own draft, Claude Code's with its lead (D104, D108, D112); and the integration suite proved a draft waited for until it goes and never submitted with the message, an input it cannot read failing at fifteen seconds, and a submission its CLI takes slowly or whose Enter it misses typed once, for every built-in's input (D104, D106), with Copy Diagnostics naming both agents of each journey with what their input readers read and their last rows, and the log naming each tool call (D116, D117). In a 120x24 terminal the same day `scripts/capture-inputs.mjs` recorded all six with a taller and a wider paste as well, 49 screens: Antigravity and Pi scroll a tall draft and Pi folds a wide one as `[paste #1 1284 chars]`, which their readers then failed and now read as the message's own (D118). With every fix of D118 in, the integration suite passed again for all six on macOS, on Linux under xvfb and on Windows in its desktop session, ConPTY; the unit suites passed with 791 tests on macOS and Linux, and on Windows all but a trust test of their own that used macOS paths there - writing two entries for its temporary folders into that computer's Claude Code configuration, taken back at once under Claude Code's lock - which now uses that computer's own paths and home variables and checks its target file before any write, and passes there. Real agents with YOLO off on macOS (`FACADE_IT_ONLY=real`), each starting a second of the same CLI with a first task and exchanging messages pasted and submitted, no approval asked for Facade's tools: Claude Code 2.1.316 and Codex 0.166.0 on the Qwen token plan in their own configuration folders, Antigravity 1.4.12 signed in (its first task after its MCP panel was opened and closed, D100), OpenCode 2.1.4 and Pi 1.4.0 on the Qwen token plan in their own configuration folders - OpenCode's configured to ask for every tool. Not run: Muse Code with a model (its account's usage ran out until 2026-11-01; with the Qwen API it cannot call tools), so whether it asks for Facade's tools with YOLO off is not observed; real CLIs on Linux and Windows; earlier versions of the four CLIs D77 adds. OPEN |
| G2 True window lifetime | Distinguish reload, extension-host restart, remote loss, close-one, close-last and immediate reopen without mistaken replay/restart | Owner-accepted five-minute policy (D75) implemented in place of a close detector. Candidate 4/5 native evidence on a macOS VS Code 1.143.1 client with Remote-SSH to Linux x64 and Windows x64: reload and remote extension-host restart keep the original runs; close-last then immediate reopen keeps the original processes; no takeover ends them at about 300 s. Evidence stays with the handoff. True close detection remains OPEN |
| G5 Native environment matrix | Native macOS/Windows/Linux, SSH, WSL and containers, compatible editor, native PTY ABI, paths/quoting/Unicode/keys and package install | Exercised: macOS arm64 local and Remote-SSH to Linux x64 and Windows x64, packages installed for those three targets, Unicode input. On 2026-10-30, a Windows x64 client with VS Code 1.140.0 ran the integration suite and started from the panel the four CLIs D77 adds; 0.2.0 ran natively on Linux x64 (under xvfb) and Windows x64 (in the desktop session) - the unit, package and integration suites, which on Windows run ptyd's named pipes and ConPTY. They found and fixed two crashes of ptyd on Windows - a second kill of an ended console, and node-pty 1.1.0's unlocked console list (D99) - after which ptyd's terminal tests passed 20 runs in a row where they had crashed 2 of 10. On 2026-10-31, on the release code: the unit suites (745 tests; on Windows 743 and the three Unix-socket tests skipped), the integration suites - each of the six CLIs' journeys, tools and messages, cross-window and workspace conversion - and the package checks passed on macOS arm64, Linux x64 and Windows x64; the packages installed in clean profiles on all three, both parts finding each other; and Remote-SSH from macOS passed all nine scenarios on the Linux and Windows hosts and between them. On 2026-10-31, with D101-D118 in, Remote-SSH passed all nine again, Copy Diagnostics in each SSH window naming its window component by the version that component answered with (D116), and the unit suites, integration suites and packages passed on all three. Not run: Linux and Windows as Remote-SSH clients, WSL, containers, a compatible editor, the declared minimum VS Code 1.105, other architectures. OPEN |

Separate pre-integration evidence from main, recorded before the MCP merge (not certification of the merged build):

Exercised: macOS arm64 local and Remote-SSH to Linux x64 and Windows x64, packages installed for those three targets, Unicode input. On 2026-10-30, a Windows x64 client with VS Code 1.140.0: the integration suite, and the four CLIs D77 adds started from the panel; a macOS arm64 client with VS Code 1.143.1: the native build, unit and package checks and the integration suite; Linux x64: the native build, unit and package checks. On 2026-10-31, a Windows x64 client with VS Code 1.144.0: Remote-SSH to Linux x64 and macOS arm64 hosts - an agent started there, a reload, a restarted remote extension host, a lost network, Close All's one question, reopening within five minutes, and the runs ending five minutes after the last window closed; the integration suite with VS Code 1.144.0 and the declared minimum 1.105.0, whose codicons have no `new-session` for New Agent's title button; Linux x64 under xvfb with VS Code 1.144.0: the integration suite. Not run: a full Windows or a Linux client walkthrough, Remote-SSH to a Windows host, WSL, containers, a compatible editor, other architectures. OPEN

Resume/Pin/Unpin evidence for the 2026-10-31 `feature/74-resume-pin` worktree: Linux x64 and official VS Code 1.144.0.
The editor journey suite exercises native history fixtures and exact cwd/ID, card/native-tab Pin and Unpin for all six
built-ins. For each built-in separately, real window reloads preserve Pin, preserve Unpin, and keep the same run ID,
PID and single terminal when the folder becomes a multi-root workspace. The CLIs in these editor tests are fakes;
CLIS-5.1 separately records the six actual native CLI probes. Native Windows/macOS/remote Resume/Pin regressions are
not run in this handoff and G5 remains open for them. Reproduce editor coverage with `npm run test:integration`;
`FACADE_IT_ONLY=journeys` and `conversion` select the two parts. Do not run them against a live owner profile.

Pre-MCP Linux checks after D124's Claude metadata correction passed: `npm run compile`; `CHROMIUM_EXECUTABLE=/opt/google/chrome/chrome npm test`
(577 passing, one Windows-only file-lock test pending); `npm run package` and `npm run test:package` (11 passing);
`node scripts/l10n.mjs check` (247 runtime texts and 60 manifest strings, English plus 11 translations); the seven editor
journeys (15 passing across six built-ins and one custom CLI); and all six Pin/Unpin reload/conversion journeys.
The spec audit passes 134 rules and 70 local links. Test logs remain in `/tmp/fc74-claude-metadata-tests.log`,
`/tmp/fc74-claude-metadata-package-tests.log` and `/tmp/fc74-claude-metadata-integration.log`; the complete editor run
is retained at `/tmp/fdit-ddtoI0`. The actual Claude 2.1.316 picker comparison passed separately in
`/tmp/fc74-claude-picker-fD68QO` (CLIS-5.1). Regression fixtures cover rename-sidecar and continuation-target cache
invalidation, misleading mtimes, fork metadata, and activity ordering across the 100-entry pages and 1,000-read bound.
A new normal installed-VSIX window uses `/tmp/fc74-metadata-__g4nc_l`, titled `Facade Code · Resume 修复版`, with only
`facade.facadecode` and its window component installed. Its workspace bundle matches the VSIX (SHA-256
`95c852f7334c39f0f0534bde00545ca1b860cb5b3b8aed68cfe95b0a4a029e18`); it has no driver or fake CLI, and uses the user's
normal native CLI configuration. This window is for the owner to test, not an automated test subject.

The merged candidate integrates MCP main `b9bd5996` with Resume/Pin. Linux checks on 2026-10-31, at `ee355c07`,
pass compilation, 990 unit tests (one Windows-only file-lock test pending), 11 package checks, 296 runtime and
64 manifest strings in English plus 11 translations, and the specification audit (185 rules, 80 local links).
Logs are `/tmp/fc74-final-unit.log`, `/tmp/fc74-final-package-tests.log` and `/tmp/fc74-tabs-unit.log`.
Native Linux exact Resume with the combined MCP and session configuration passes for all six built-ins; Claude,
Codex and Pi also change native sessions and resume the new ID, using isolated stores and a local model stub.
MCP configuration probes use a local MCP stub and observe initialization/tool discovery; real Facade tools are exercised
by the separate editor journeys. Logs are `/tmp/fc74-reviewed-{claude,codex,pi,muse-opencode,agy}.log`.

On official VS Code 1.144.0, every built-in passes actual Pin/Unpin reload and folder-to-workspace conversion
(`/tmp/fc74-final-conversion.log`, `/tmp/fdit-SFAhpD`), and real close/immediate reopen preserves the original run ID,
PID, saved session and one terminal (`/tmp/fc74-final-reopen.log`, `/tmp/fdit-1b3daX`). The shared lifetime policy is
checked with its actual production timer: after closing the window, its process ends at 298,974 ms; reopening starts
one new run and process with the exact previously pinned session (`/tmp/fc74-final-expiry.log`, `/tmp/fdit-CsfAwA`).
The complete human and MCP journeys pass 33 tests across the six built-ins and custom CLI
(`/tmp/fc74-final-journeys.log`, `/tmp/fdit-wpL7YA`). Cross-window journeys pass five tests (`/tmp/fc74-final-cross.log`, `/tmp/fdit-yvzB2W`).
The minimum official VS Code 1.105.0 passes all six built-ins' Resume/Pin/Unpin and the custom launch journey
(15 tests; `/tmp/fc74-minimum-integration2.log`, `/tmp/fdit-7xriwE`), plus all six reload/conversion journeys
(`/tmp/fc74-minimum-conversion.log`, `/tmp/fdit-WXSIkt`). This found and fixed a native Pin defect: VS Code can
replace every public Tab object through its tab-group event; stale bindings now expire and rebind only from the exact
active Terminal/Tab correlation, including terminals with duplicate names. No name or position matching is used.

The complete serial Linux suite also passes at `b0a7df41` (`/tmp/fc74-final-serial.log`, `/tmp/fdit-E7MjCO`),
including expiry at 299,830 ms and exact restoration. The diagnostic readiness assertion added at `4c1cb8af` passes
separately for all six CLIs (`/tmp/fc74-final-diagnostics.log`, `/tmp/fdit-Oh42rh`). A clean installation of both
production VSIX packages activates both components and exposes Resume/Pin/Unpin without any test commands
(`/tmp/fc74-installed-package.log`, `/tmp/fc74-installed-kb3UYJ`). The Linux workspace VSIX SHA-256 is
`92afee1c30c924655a80ba0990f8c4ebf8e638e015f46b36ed2708e4f1409a9e`.

The three-platform workflow runs compilation, units, translations, audit, packaging and the complete isolated editor
suite on Linux x64, Windows x64 and macOS arm64. Its current result is attached to
[PR 41](https://github.com/y5ez3g/facadecode/pull/41/checks); do not infer a platform pass from a queued or incomplete check.
At `ee355c07`, Linux and macOS pass 990 units, Windows passes 988 (the Unix old-Git fixture and three Unix-socket checks skipped).
CI also found two test-tool defects: an overlong fake CLI footer wrapped over its input on macOS, and the Python
specification audit read UTF-8 documents using Windows' default code page. Their fixes preserve the product assertions.
Native Windows/macOS and remote Resume/Pin remain unverified; fake-CLI editor coverage does not certify those native
vendor integrations. No earlier platform result certifies this merged build.

Release review of 2026-11-01 (`feature/76-release-review`, D131-D138), official VS Code 1.144.0 in isolated profiles with
fake CLIs, Node 24.18.0. Before any change, at `076527d4`: Windows x64 passed 1000 units and the integration suite, Linux
x64 1003 units and the integration suite. After the review's fixes and its independent cross-branch review, at
`ff14745b`: Linux x64 (Ubuntu, under xvfb) passed a clean `npm ci`, compilation, 1089 units (5 POSIX-only checks pending,
none failing), the translations (299 runtime texts, 64 manifest strings, 11 languages), the linux-x64 and window packages,
the 11 package checks and the whole integration suite; Windows x64 (10.0.26200, in the desktop session, ConPTY and named
pipes) passed compilation, the translations, the win32-x64 and window packages, the 11 package checks and the whole
integration suite, and 1088 of 1089 units: a Windows-only flake of a POSIX working-folder check, which compared 64-bit
NTFS file IDs as JavaScript numbers, fixed in `3229090d` and then passing five runs in a row. The specification audit
passes 12 documents, 185 rules and 80 links. Not run: macOS (the test Mac was offline), real CLIs (their test
credentials are on that Mac), Remote-SSH, WSL, containers and the minimum VS Code 1.105.

The implementer investigates concrete mechanisms and brings engineering changes with evidence to the assigned reviewer.
A failed proof cannot be disguised as an implemented heuristic or automatic product-scope reduction. If it cannot be solved in
the available environment, complete independent work and record the exact missing evidence and required next action.

### 2.2 Coverage matrix

**Every execution environment runs the same core contracts; unsupported capability evidence is explicit.**

| Dimension | Required samples |
| --- | --- |
| Client | macOS, Windows, Linux; VS Code minimum/current; one declared compatible editor |
| Execution | Local; Remote SSH Linux plus another supported host OS where available; WSL; Dev Container |
| Workspace | Plain folder without Git executable; ordinary nonrepository with Git; main checkout; opened worktree; mixed multi-folder; nested/duplicate repo folders; no folder |
| CLI | Each built-in, current and an earlier version for input readers; valid custom definition with required Resume but unverified runtime capabilities; missing Resume rejected; missing/disabled/invalid CLI |
| UI | Themes/widths/zoom/languages/reduced motion/keyboard/accessibility from UX |

Use pairwise sampling for routine presentation combinations, but exercise every critical G1–G3 boundary directly.

Three required product exercises are local plus two remote environments messaging/stopping each other, first launch
from the empty-panel explanation and usable panel/search/order with 100 agents in one window. Test CLIs may supply the scale load; vendor capability evidence still uses the actual supported
CLI. More than 100 remains allowed, without implying tested usability at that scale. A real VS Code user must walk the
common flow before public use; automated tests do not replace this check. Do not create a full combinatorial matrix or
repeatedly rerun unrelated suites for small changes. Missing environments are recorded as not run, not fabricated
passes.

## 3 Scenarios

### 3.1 Core journeys and lifecycle

**Acceptance exercises complete journeys, including their failure exits.**

| ID | Scenario | Expected observation / owner |
| --- | --- | --- |
| J01 | First human launch in plain folder, Git removed from PATH | Same short CLI flow, no Git setup/error; immediate pair; PRODUCT-5.4, LIFECYCLE-1 |
| J02 | Multi-folder defaults, last successful CLI/location, missing-location fallback, edit name, search/scroll CLI choices, cancel | Remembered/opened location stays selected independently of main-first display order; current name and actual location remain visible during search; last successful CLI preselected; editable label allows empty strings, `human` and duplicates; canceled choices not remembered; LIFECYCLE-1 |
| J03 | Open main versus open its worktree, including symlink/case/nested paths | Main checkout first in the picker; the actual opened folder remains the fallback launch location; no duplicate physical lock; WORKTREES-1 |
| J04 | CLI/worktree creation fails; native post-create setup fails; Facade tools fail while the CLI is usable | Actual startup failures retain pair and report to initiator; setup success is not a launch gate; usable CLI remains with a plain explanation; LIFECYCLE-1.5 |
| J05 | Startup before the CLI's first report and past CLIS-2.3's bound, working, idle, native blocker, unavailable reliable status, blocker plus unavailable status, recovery | RULES-3 dot meanings; startup green until the first activity, then red with why; PANEL-1.4 leads with the known blocker before generic unavailable text while retaining that explanation; no idle/turn-end popup |
| J06 | Normal exit 0; Ctrl+C ordinary interruption from the person; unexplained nonzero exit | Actor-independent classification; abnormal retained; unknown cause no popup; RULES-3.3 |
| J07 | Close card/terminal, stop during creation, unreachable remote cleanup; close live agents' tabs alone and with Close All, then Cancel and confirm | Immediately remove pair; cleanup background, no fixed five-second wait; created files remain; one question for tabs closed together, Cancel reopens their terminals, confirm ends them; LIFECYCLE-3.1 |
| J08 | Close creator, keep worker in same/other window | Workers remain except those owned by a window actually closed; RULES-4.1 |
| J09 | Reload, extension-host restart, an update from the last released build with its agents running, remote loss, close-one, close-last, immediate reopen, close-last without reopen | G2 trace; original process survives reload/disconnect/update; after the update the earlier build's agents show and work through its ptyd, which exits once they are gone (ARCHITECTURE-2.4); reopen within five minutes claims the original runs; without it they end at five minutes (RULES-4.1) |
| J11 | Resume an external and a Facade conversation, a nested cwd, old history beyond the first page, a disabled CLI and a running session | Exact ID/CLI/cwd, known name and current launch settings; no duplicate process or age cutoff; no implicit re-pin; LIFECYCLE-3.2, LIFECYCLE-3.3 |
| J12 | Pin/Unpin from a card and native tab; reopen, failed restoration, session change, explicit close and normal/abnormal exit | One saved intent, pinned area/order, two background starts at most, no focus theft or retry loop; individual failure cards and one summary; LIFECYCLE-3.4, RULES-4.2 |
| J16 | Both EXPERIENCE-4.1 journeys through review/integration and ordinary cleanup | No built-in task/workflow; files accessible without Git |
| J13 | New VS Code user follows empty-panel explanation | First agent starts without a separate onboarding wizard |
| J14 | 100 agents in one window, then request another | Panel/search/manual order remain usable at 100; no 100-agent hard cap |
| J15 | One local and two remote execution environments on one client | Agent starts, messages, screens, keys and stops work between them within YOLO/tree rules |
| J16 | Real VS Code user completes the common flows, including asking one agent to work with others, before public use | Record observed familiarity/usability; automated tests alone do not pass |

### 3.2 Collaboration and contracts

**Message and operation tests assert actual input effects, not just queued records or screenshots.**

| ID | Scenario | Expected observation / owner |
| --- | --- | --- |
| M01 | Query destination with zero agents; open window with no folder; disconnected runtime; missing/unknown catalogs | Include the folderless window with zero locations; selecting it returns an empty catalog and launch has no effects; distinguish known absence from unavailable windows; no invented CLI/model; MCP-2.1 |
| M02 | Omit name/window/location/CLI; omit model/effort; pass unsupported field/type | Required fields fail together before effects; omitted model/effort add no per-call override under CLIS-1.4; optional request_id on start/send alone; no permissions/task fields |
| M03 | Create across windows/remotes, plain folder or external-created checkout; native/post-start prompt still pending after process success | Actual destination, creator's tree and background focus; YOLO per RULES-4.3; separate process and delivery results; pending prompt later returns its outcome with the same message ID/target under MCP-2.3; native path invents no Enter effect |
| M04 | Send full multiline content while recipient working; busy queue observable/unobservable | One full paste + Enter; success without waiting; no unsupported queued claim |
| M05 | Existing draft via typing/paste/history, then clear it | No append/overwrite/Enter; next eligible attempt without typing cooldown |
| M06 | Login/permission/menu, missing activity, unknown input, an input box of a version the reader does not recognize, a CLI with no reader | No blind Enter probe and nothing typed; working status not eligibility; `input_unknown` at the deadline names CLI and version; no reader fails at once as `unsupported`; RULES-1.4 |
| M07 | Direct success, permanent failure, slow input after 2 s; delayed shim/window forwarding | Exactly three initial outcomes and one accepted operation; measure monotonic elapsed time from RULES-1.2's first Facade ingress to response handoff, with internal hops consuming one budget; record client round-trip separately; MCP-4.1 |
| M08 | Draft clears on attempt four; remains throughout; queued behind another send | At most 5 slots, deadline 15 s, serialized whole writes, no extension |
| M09 | Lose acknowledgement after partial/full input or Enter; repeat a new send with identical text; reopen windows | RULES-1.1's ID scope/reuse holds; retries retain ID, a new call gets another; skill explicitly teaches ID deduplication and separates results from instructions; no platform exactly-once guarantee |
| M10 | Repeat start after lost response, with and without request_id; attempt get_operation | The same request ID reuses the first start under MCP-1.1; a new ID or an invocation without one can create another run; inspect with list_agents; get_operation is rejected |
| M11 | B delivered/not delivered while A is absent, busy, drafted or unreachable | A result for both outcomes; original outcome unchanged; finite handoff if possible, otherwise end; no report to B unless B actually sends, and no human notification |
| M12 | Failure returned to A; A does nothing or replies | No automatic human escalation or instruction to A |
| M13 | Only A closes while delivery pending; B still open; then B closes | Delivery already owned by B may finish; work left on closing side may end; no special takeover or future-open replay |
| M14 | Disconnect/reload over attempt slots and after deadline | No catchup burst/late Enter; no new budgets; reconcile recorded effects |
| M15 | Read messages before, during and after delivery; read after a failure result; lookup sent or another agent's message by ID | Own inbox only including YOLO; a read delivers immediately, cancels an unstarted paste, and lets an already-issued owned draft finish without submitting a person's edits; its sender's result says read_messages and keeps uncertain input effects uncertain; a record read after its failure result gets no second result; reads by ID or all:true never paste again |
| M16 | One recipient by ID, unique name, ambiguous name, recipient array, `#human`, `@human` with and without an agent named `human` | ID/unique name resolves once; ambiguity requests ID; `#human` always reaches the person; arrays refused before effects; one independent message/result |
| M17 | Direct multiline/large/whitespace text, ESC/other control characters, empty text without Enter, existing draft, menu, unknown layout, key sequence, stop | No input_policy, draft guard or artificial text cap; exact serialized input and true partial/unknown effects; controls other than tab/LF/CR and empty no-Enter text fail INVALID before writing; ordinary messages still protect drafts |
| M18 | Long screen/history local-to-remote and remote-to-remote; one included record expires | Complete file readable by caller; delete whole temporary message file on any included expiry and regenerate remaining records on demand |
| M19 | MCP switch changes during an existing run and before a new start | Existing tools/runs unchanged; only subsequent injection follows setting; no message replay; recipient MCP not needed for terminal delivery |
| M20 | Same-tree sibling/ancestor access, unrelated root, YOLO, duplicate names and stale IDs, across windows | Normal tree scope on reads/writes, YOLO all; ambiguity does not guess; ended ID never retargets; no authentication/token/delegation requirements |
| M21 | Change YOLO before a human start and a child start in another environment; change it again while runs live | Every new run uses the destination's setting at acceptance under RULES-4.3; existing runs keep their value; children retain their tree without inheriting the creator's setting |
| M22 | Concurrent accepted calls, including more than one to the same run, finish out of order | Each result identifies its originating call and exact target under MCP-1.3; existing call context suffices without requiring caller-managed IDs or a query API |
| M23 | YOLO off: an agent calls each Facade tool, then its CLI runs a shell command | No approval prompt for Facade's tools in Claude Code, Codex, Antigravity or OpenCode, and none in Pi, which has no approvals; Muse Code's own approvals and review decide for its tools (D100); the CLI's own approval still appears for its command; MCP-6.1, CLIS-2.2 |
| M24 | Facade server cannot start or connect | The CLI starts and stays usable; the card explains in plain words; tools_state unavailable; LIFECYCLE-1.5 |
| M25 | Message to the person while its agent's terminal is visible and hidden; long message | Notification in the sender's window names the agent; Show Agent and Open Message open the agent and the complete message; no notification in another window; COLLABORATION-2.3 |
| M26 | Concurrent starts/sends with one request ID; routed delivery with a lost reply; Unicode request IDs; retry after run exit, close, failed start or interrupted startup | One original run/message within the one-hour period; receiver deduplicates before input and returns the original ID; metadata survives reload without restoring closed cards; an unrecorded startup outcome stays unknown; MCP-1.1, D119 |


### 3.3 Files, safety and presentation

**Data-loss and visual claims have their own evidence, independent of basic launch success.**

| ID | Scenario | Expected observation / owner |
| --- | --- | --- |
| W01 | Native Git creation, selected checkout/base, occupied destination, invalid branch | Source labels name the selected checkout's branch rather than a subfolder; fixed sibling path and current native Git result; no overwrite; WORKTREES-2 |
| W02 | Request worktree without Git/repository/commit; ordinary folder launch | Creation reports actual prerequisite; no initialization/initial commit/advice flow; ordinary agent still launches |
| W03 | Native copy/link/preparation delayed or failed; close creation before CLI spawn | Existing recognized worktree permits CLI without waiting; canceled launch does not spawn; no Facade setup job monitor/retry |
| W04 | Delete Worktree on clean, dirty, locked, detached and nesting worktrees with agents; an assumed-unchanged or skipped edit; an agent that does not end; a file written as its agents end | Clean: agents close and end, then `git worktree remove` without `--force`, branch kept; dirty or locked: refused untouched; detached: confirmation says it has no branch; no other deletion, discard confirmation or stop-with-delete entrypoints; WORKTREES-3.2 |
| W05 | Actually remove workspace folder or externally delete worktree with agents | Immediately close affected pair(s), background cleanup; other locations continue |
| W06 | Remote temporarily disconnected or Git read fails while location was known | Do not mistake unavailable observation for actual location deletion; no cleanup from that alone |
| U01 | Narrow/high contrast/reduced motion/non-English/keyboard/screen reader | UX/PANEL checks, no invented completion/extra badges |
| U02 | Old-page action/reply, unrelated state change before a current-page action, agent rename while menu open | PANEL-3.1 generation isolation and current-target validation; no wrong target or required per-action expected revision |
| U03 | Human operation error, agent operation error, failed message return, explicit `#human` | Error to initiator; no agent message fallback to human; explicit contact shown in related window even when terminal visible |
| U04 | Empty filtered panel; a person's start outside the filter; missing Git | Filter remains unchanged; new card follows normal data/order and only matching entries display; no launch-default change |
| U05 | New card, manual movement, filter | Card-count badge, stack insertion and stable state changes |
| U06 | Go to Agent with duplicate names, exact/short IDs and stale-name copied references; terminal placement | ID selects the intended current-window run; picker detail/hover distinguish duplicates; editor-only terminals; no global default shortcut |
| U07 | Command/menu catalog with starting, live and retained-ended records; view a notified source | One Close Agent action for all states; no attention queue/seen state, nextAgent, human stopAgent or startAgent registration; opening does not clear the error |
| U08 | Activate agent B, switch to a file/unrelated terminal, invoke palette Rename/Copy/Close; repeat without a selected run | Available actions target B under UX-3.1; no target picker; unavailable without a valid target; explicit card/tab context still targets its own run |
| U09 | Browse near the 80th card, switch to Explorer, then return; repeat after the navigation target is removed | Restore still-valid scroll position and navigation target without stealing input focus; removed target is discarded; existing PANEL-3.3 scrolling behavior is unchanged |
| U10 | Every new person-facing string - notifications, settings descriptions, cards, Message History and errors - in English and all eleven languages | Plain words with no internal terms under UX-1.3; reviewed by a content author and two reviewers; complete translations |
| U11 | Message History with conversations from this and other windows, long bodies, links and command text | Only messages involving this window's agents; read-only; delivery outcome shown; links and commands rendered as text; COLLABORATION-3.2 |
| U12 | Scrollbar initially idle, hover/leave, wheel and keyboard scrolling, drag outside and release/cancel, window blur, reduced motion, resize and changing card counts; track clicks with both scrollByPage values; Modern UI absent/on/off and live changes; both caps and first/last cards inside a rounded host clip at 100%, 125%, 150% and 200% display scale; native sidebar width sweeps through clipped and unclipped iframe sizes; short and empty content | PANEL-3.3 visibility and fading; native sidebar width, corners, theme colors and matching hit area in both modes; shared content/overlay compensation, dynamic correction removed when no longer needed and a device-pixel guard for rounded cross-origin bounds; filled cap/card contours retained (shared edge antialiasing allowed), no additional list top/bottom padding and 2 px Modern UI clearance for scrollbar ends only; compare total bottom spacing with native Extensions in the same editor; no traditional decorative inset, full scroll range through wheel, keyboard and dragging, fractional track endpoints and correct empty-padding hit testing; zero scrollbar gutter with and without overflow; no width jump on hover, stuck visibility, lost valid scroll position or hidden keyboard target |
| C02 | Executable found only through configured default-profile PATH; null/omitted variables at each env layer; remote and Windows cases | Discovery and launch use the same CLIS-1.2 environment; null removes, omission inherits; no shell-init execution/parser |
| C04 | Custom definition missing/empty Resume, lacking exact-session placeholder, containing a capabilities field, a key that cannot be an ID, valid unverified Resume | Invalid definitions cannot start; only path/launch are configured; a valid command alone does not prove Resume/Pin under CLIS-3.4 |
| C03 | New worktree with tracked relative executable; missing/nonexecutable file after creation | Static validation before creation; cwd-dependent checks use actual Git destination before spawn; failure retains pair and created worktree; no preparation barrier/rollback |
| E01 | Output flood/slow UI, attach snapshot/output race, current/alternate screen | Bounded pressure, no duplicated input/output, readable final evidence |
| E02 | Settings, commands and records of 0.0.1; records/settings from Facade Dots development builds; old MCP calls | 0.0.1 settings and commands keep working; development-build records ignored with one log line and no aliases; old MCP calls fail explicitly; no kill/replay; ARCHITECTURE-4.2 |
| E03 | Package contents/localization/native ABI/install in isolated profiles | No test probes/secrets, complete strings/notices, verified components |
| E04 | Full compile/test/bundle/package/integration milestone | Record actual command/results, no claim of unrun native support |
| E05 | Update from 0.0.1 with running agents in local and remote windows, then reload | Earlier-protocol agents retain their cards and terminals, with resize, direct terminal input, close and exit handling; MCP screen/input operations added by a newer protocol fail without sending a request; the update starts no five-minute cleanup; ARCHITECTURE-2.4, D86 |
| E06 | Window component missing, disabled, installed late after a remote first install, or older than the workspace component | Existing agents keep running; plain explanation with an Extensions action; New Agent unavailable until it appears, then works without a manual reload where the editor allows; an older component leaves the window usable and other windows unavailable to agents; ARCHITECTURE-4.3 |

## 4 Handoff and review

### 4.1 Implementation order

**Build shared contracts first, then the human journey, then the full compatibility matrix.**

1. Read PRODUCT, EXPERIENCE, RULES and this document; inspect current dirty-tree baseline before edits.
2. Investigate G2 with small isolated traces/fixtures; raise concrete spec feasibility problems to the assigned reviewer early.
3. Implement run records/state and execution adapters.
4. Implement human lifecycle and direct terminal journey, then agent discovery/start/message/result journey.
5. Complete location/worktree, panel and commands/settings using the same services, then the client network across
   windows and environments.
6. Run relevant suites and required behavioral scenarios; inspect real isolated UI; update the implementation-to-rule matrix.
7. The assigned reviewer checks evidence/diffs and resolves defects with the implementer; report completion levels under 1.1 separately.

Task assignments and current status follow the user's current instructions; they are not product rules. Raise a concrete rule/scenario/evidence issue when needed; do not repeatedly ask the owner to approve routine
engineering choices. Apply the owner-reviewed simple contract rather than preserving invalid requirements for old tests.

### 4.2 MCP reliability review, 2026-10-31

**D119's review fixes pass the following local checks; they do not close the unrun platform and real-model gates.**

Environment: macOS 27.2 arm64, Node 24.21.0, official VS Code 1.143.1, local execution. Branch:
`feature/65-extension-mcp`, with the pre-existing dirty tree preserved, based on commit
`3ce8dcc3b73acf75a1bf36226bef2a9daadcdfe1`. The tested source snapshot is
`c1a1c8c82bd91a13ddef274f4ac098750ef4be6db56ce29e9180da7d03377b84` (SHA-256; file list in the evidence JSON).
The specification is D119, with SHA-256 `1818357048f50194a2d9ccffae0ba4e5d84e8ccdb3adeb428c64b8482b5ce40c`
over the extension specification files except this evidence document.

| Check | Observed result |
| --- | --- |
| `npm run compile` | PASS: host and webview TypeScript |
| `npm test -- --reporter dot` | PASS: 815 tests, including 23 added regressions; one Windows-only file replacement test skipped on macOS |
| Bundle and `npm run package` | PASS: final production rebuild and both 0.2.0 VSIX files; native package is darwin-arm64 only |
| `npm run test:package` | PASS: 10 checks, including the relocated native PTY and exclusion of integration probes |
| `node scripts/l10n.mjs check` | PASS: 190 runtime and 34 manifest strings, English and all 11 translations |
| `FACADE_IT_KEEP=1 npm run test:integration` | PASS: 24 journeys across the six fake CLI adapters, 2 cross-window checks and 1 workspace-conversion check; 27 total |
| `node --check scripts/capture-inputs.mjs`, `git diff --check` | PASS |

The production message service and ordinary-input tests reproduce the original concurrent-start/send duplication,
lost-route-reply duplication, and read-during-paste draft blockage. Further tests cover Unicode request IDs, closed-run
and interrupted-start retention without card resurrection, honest read/closed-process effects, result-batch paste
budgets, incomplete-window name resolution, remote `human` ambiguity, and refusal of personal CLI state in test
runners. These cover M10, M15, M16, M26 and the affected lifecycle and packaging scenarios.

Local artifacts are in `extension/build/review-mcp-a541/`: `evidence.json` records the source file list, fingerprints,
package hashes, scope and limitations; the adjacent logs record compilation, unit tests, packaging and integration.
The final editor run kept its isolated profiles, Facade state and fake-CLI traces under
`/private/var/folders/by/5bc34gg53tj8v54bm1txmtjh0000gn/T/fdit-oLZl9X`.
No live owner window or agent was used as a test subject, and no real model or Qwen CLI was probed.

Not run for this snapshot: the real-model/C4 journeys, native Linux or Windows, Remote-SSH, WSL, containers, other
editors or the minimum supported editor. Prior D118 evidence remains historical evidence for that build. In particular,
Windows Codex's actual multiline input, Muse's real-model behavior and the other open G1/G2/G3/G5 cases remain unverified.
This evidence was captured before the fixes were committed and before integrating later main changes; it does not
certify that integration or a release.

#### Integration with current main, 2026-10-31

D120's resolved merge combines feature commit `67b0429ac4d628558c9fb6f599f2cde6ff74ddd8` with
main `99d599397374b7584e8b41f6eb61fb09c91a1623`. It preserves the five review commits and the earlier feature history.
The final extension source snapshot is SHA-256
`1d70d6631a4b61b9b59233f9493d9c2e735356cf4e221bbda21bc8452f86df9c`, over the 559 files listed in
`extension/build/review-mcp-main-merge/evidence.json`. The environment remains macOS 27.2 arm64, Node 24.21.0 and
official VS Code 1.143.1. This is new local evidence for the merged code, separate from the preceding snapshots.

| Check | Observed result |
| --- | --- |
| `npm run compile` | PASS: host and webview TypeScript |
| `npm test` | PASS: 915 tests; one Windows-only file replacement test skipped on macOS |
| `npm run package` and `npm run test:package` | PASS: both 0.2.0 VSIX files, darwin-arm64 native package, all 11 package checks |
| `node scripts/l10n.mjs check` | PASS: 282 runtime texts and 61 manifest strings, English and all 11 translations |
| `FACADE_IT_KEEP=1 npm run test:integration` | PASS: 31 editor checks plus one workspace-conversion check; six fake built-in CLIs, one fake custom CLI, and two local windows |
| `python3 -I -B docs/extension/audit/check_spec.py` | PASS: 12 normative documents, 179 rules and 80 local links; numbered references valid |
| Decision references and `git diff --check` | PASS: no duplicate decision IDs, dangling decision references or unresolved merge markers |

The regression checks cover explicit MCP model/effort overriding configured defaults without dropping unrelated
arguments, catalog configuration errors visible through MCP and diagnostics, withheld trust described accurately,
the window-component wait, and earlier-protocol cards/terminals retained with unsupported new MCP operations refused
before sending. Creator blocker notices remain agent status only: no request to contact the person or answer a prompt.
The custom CLI editor journey checks exact configured arguments and no MCP startup; it does not run the built-in MCP
journeys. Unit and production package inputs are unchanged by that final integration-only test correction; compilation
and the complete editor runner passed after it.

Logs, package hashes and the file manifest are in `extension/build/review-mcp-main-merge/`. The final isolated editor
profiles and fake-CLI traces are kept under
`/private/var/folders/by/5bc34gg53tj8v54bm1txmtjh0000gn/T/fdit-R65MQM`. The earlier editor attempt was intentionally
interrupted to correct the custom CLI test boundary and is preserved as `integration-interrupted.log`; it is not a pass.
No live owner window or agent was used, and no real model or Qwen probe ran.

Not rerun for this merge: real-model/C4 journeys, native Windows or Linux, Remote-SSH, WSL, containers, other editors
or the minimum supported editor. Earlier platform results remain evidence for their own snapshots. The local passes
do not certify those platforms or close their release gates.

### 4.3 Review output

**The final implementation report states what works, what was tested and what remains, with no hidden partial completion.**

Provide changed areas, rule-to-code/test coverage, required-check results, critical-gate evidence, pending platform/CLI
validation, relevant risks and exact reproduction for unresolved defects. Leave the workspace intact and uncommitted.
The spec stays authoritative after agreed amendments; audit history records why. A model saying it is done is a prompt
for review, not acceptance evidence.

## Checks

| Rules | How checked |
| --- | --- |
| 1.1–1.3 | Report separates spec/code/runtime and includes actual evidence entries |
| 2.1–2.2 | Each critical gate has a reproducible result; no inferred native/remote pass |
| 3.1–3.3 | Scenario matrix has recorded result and artifacts at acceptance |
| 4.1, 4.3 | Handoff, spec-amendment log and independent review |

## Change log

- 2026-11-01: Recorded the release review's Windows and Linux evidence and what it did not run (D131-D138).
- 2026-10-31: U12 covers native overlay appearance and interaction, fractional-scale host clipping, full-range scrolling and card corners without decorative list padding; check balanced card sides when the right padding absorbs the device-pixel guard.

- 2026-10-31: J11/J12 now run for all six built-ins, with a separate real reload/conversion journey for each. Native Linux CLI observations are recorded separately from fake-CLI editor evidence (D123).

- 2026-10-31: Added the owner-authorized Resume and linked Pin/Unpin step, using Facade Dots as the reference.

- 2026-10-31: 4.2 records the merged-build evidence for D120, separately from the original D119 review and earlier platform runs.
- 2026-10-31: 4.2 records D119's final local verification; M10 and M26 cover keyed retries, and M15 covers an owned draft
  finishing after read delivery. The older request-ID exclusions in M02 and M10 are reconciled with D110.
- 2026-10-31: G5 records the three platforms and Remote-SSH again with D101-D118 in.
- 2026-10-31: G3 records the input-box captures of every built-in and the integration suite's held draft, unreadable input,
  slow and missed submissions (D104, D106, D108, D112).
- 2026-10-31: G5 records the release code's suites, package installs and Remote-SSH scenarios on the three platforms.
- 2026-10-31: G3 covers every built-in: the four CLIs D77 adds have readers on recorded screens, the integration suite runs
  each of the six, and five worked together as real agents with YOLO off; M23 names how each keeps Facade's tools from
  asking (D100).
- 2026-10-30: G1, G3 and G5 record 0.2.0 run natively on Linux and Windows and over Remote-SSH to both, the real Claude Code
  attempt, and the two Windows crashes of ptyd found and fixed.

- 2026-10-30: Step 2 of the Facade Code extension: G1 covers the client network and extension-pack installation; G3
  proves layout-based input readers on current and earlier versions and three platforms instead of a version list (D89);
  2.2 adds local plus two remote environments messaging and stopping each other; 3.1 adds J08, J12 and J15; 3.2 carries
  M01–M22 with the one-state read (M15, D88) and `#human` (M16, D91) and adds M23–M25; 3.3 adds U10, U11, E02, E05 and
  E06.
- 2026-10-31: J09 includes an update from the last released build with its agents running (D86).
- 2026-10-31: G5 records the night verification's Remote-SSH runs from a Windows x64 client, and the integration suite on
  VS Code 1.105.0, the declared minimum, and on Linux.
- 2026-10-31: The CLI coverage and C04 cover custom CLIs (CLIS-3.4).

- 2026-10-30: U04 and U05 cover the panel's display filter (PANEL-2.3).

- 2026-10-30: G5 records the Windows x64 and macOS arm64 client and Linux x64 build evidence of the step adding four
  CLIs (D77); J05 covers startup until the CLI's first report (D81).

- 2026-10-30: J07 covers LIFECYCLE-3.1's confirmation when live agents' tabs are closed alone or together; J09 and G2
  follow the five-minute policy (D75); G2 and G5 record the candidate 4/5 native evidence and what was not run; C01 waits
  for the `.launch` setting's later step.

- 2026-10-29: J02/J03 separate picker order from launch defaults; W01 includes the checkout source label for a subfolder.

- 2026-10-29: J02 follows the owner's IA-03 naming rule: empty and `human` labels are valid; IDs identify agents.

- 2026-10-29: W04 tries Delete Worktree on clean, dirty, locked and detached worktrees with agents (D73).
- 2026-10-29: Step 1 of the Facade Code extension, carried from the Facade Dots specification: the rules step 1
  needs, each with its final number. Later steps add the others.
  Gates G2 and G5 and the scenarios step 1 needs keep their IDs.
