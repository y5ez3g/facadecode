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
| G2 True window lifetime | Distinguish reload, extension-host restart, remote loss, close-one, close-last and immediate reopen without mistaken replay/restart | Owner-accepted five-minute policy (D75) implemented in place of a close detector. Candidate 4/5 native evidence on a macOS VS Code 1.143.1 client with Remote-SSH to Linux x64 and Windows x64: reload and remote extension-host restart keep the original runs; close-last then immediate reopen keeps the original processes; no takeover ends them at about 300 s. Evidence stays with the handoff. True close detection remains OPEN |
| G5 Native environment matrix | Native macOS/Windows/Linux, SSH, WSL and containers, compatible editor, native PTY ABI, paths/quoting/Unicode/keys and package install | Exercised: macOS arm64 local and Remote-SSH to Linux x64 and Windows x64, packages installed for those three targets, Unicode input. On 2026-10-30, a Windows x64 client with VS Code 1.140.0: the integration suite, and the four CLIs D77 adds started from the panel; a macOS arm64 client with VS Code 1.143.1: the native build, unit and package checks and the integration suite; Linux x64: the native build, unit and package checks. On 2026-10-31, a Windows x64 client with VS Code 1.144.0: Remote-SSH to Linux x64 and macOS arm64 hosts - an agent started there, a reload, a restarted remote extension host, a lost network, Close All's one question, reopening within five minutes, and the runs ending five minutes after the last window closed; the integration suite with VS Code 1.144.0 and the declared minimum 1.105.0, whose codicons have no `new-session` for New Agent's title button; Linux x64 under xvfb with VS Code 1.144.0: the integration suite. Not run: a full Windows or a Linux client walkthrough, Remote-SSH to a Windows host, WSL, containers, a compatible editor, other architectures. OPEN |

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
| CLI | Each built-in; missing/disabled/invalid CLI |
| UI | Themes/widths/zoom/languages/reduced motion/keyboard/accessibility from UX |

Use pairwise sampling for routine presentation combinations, but exercise every critical G2 boundary directly.

Two required product exercises are first launch from the empty-panel explanation and usable panel/search/order with 100
agents in one window. Test CLIs may supply the scale load; vendor capability evidence still uses the actual supported
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
| J04 | CLI/worktree creation fails; native post-create setup fails | Actual startup failures retain pair and report to initiator; setup success is not a launch gate; LIFECYCLE-1.5 |
| J05 | Startup before the CLI's first report and past CLIS-2.3's bound, working, idle, native blocker, unavailable reliable status, blocker plus unavailable status, recovery | RULES-3 dot meanings; startup green until the first activity, then red with why; PANEL-1.4 leads with the known blocker before generic unavailable text while retaining that explanation; no idle/turn-end popup |
| J06 | Normal exit 0; Ctrl+C ordinary interruption from the person; unexplained nonzero exit | Actor-independent classification; abnormal retained; unknown cause no popup; RULES-3.3 |
| J07 | Close card/terminal, stop during creation, unreachable remote cleanup; close live agents' tabs alone and with Close All, then Cancel and confirm | Immediately remove pair; cleanup background, no fixed five-second wait; created files remain; one question for tabs closed together, Cancel reopens their terminals, confirm ends them; LIFECYCLE-3.1 |
| J09 | Reload, extension-host restart, remote loss, close-one, close-last, immediate reopen, close-last without reopen | G2 trace; original process survives reload/disconnect; reopen within five minutes claims the original runs; without it they end at five minutes (RULES-4.1) |
| J13 | New VS Code user follows empty-panel explanation | First agent starts without a separate onboarding wizard |
| J14 | 100 agents in one window, then request another | Panel/search/manual order remain usable at 100; no 100-agent hard cap |
| J16 | Real VS Code user completes the common flows before public use | Record observed familiarity/usability; automated tests alone do not pass |

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
| U03 | Human operation error | Error to initiator in the related window |
| U05 | New card, manual movement | Card-count badge, stack insertion and stable state changes |
| U06 | Go to Agent with duplicate names, exact/short IDs and stale-name copied references; terminal placement | ID selects the intended current-window run; picker detail/hover distinguish duplicates; editor-only terminals; no global default shortcut |
| U07 | Command/menu catalog with starting, live and retained-ended records; view a notified source | One Close Agent action for all states; no attention queue/seen state, nextAgent, human stopAgent or startAgent registration; opening does not clear the error |
| U08 | Activate agent B, switch to a file/unrelated terminal, invoke palette Rename/Copy/Close; repeat without a selected run | Available actions target B under UX-3.1; no target picker; unavailable without a valid target; explicit card/tab context still targets its own run |
| U09 | Browse near the 80th card, switch to Explorer, then return; repeat after the navigation target is removed | Restore still-valid scroll position and navigation target without stealing input focus; removed target is discarded; existing PANEL-3.3 scrolling behavior is unchanged |
| C02 | Executable found only through configured default-profile PATH; null/omitted variables at each env layer; remote and Windows cases | Discovery and launch use the same CLIS-1.2 environment; null removes, omission inherits; no shell-init execution/parser |
| C03 | New worktree with tracked relative executable; missing/nonexecutable file after creation | Static validation before creation; cwd-dependent checks use actual Git destination before spawn; failure retains pair and created worktree; no preparation barrier/rollback |
| E01 | Output flood/slow UI, attach snapshot/output race, current/alternate screen | Bounded pressure, no duplicated input/output, readable final evidence |
| E03 | Package contents/localization/native ABI/install in isolated profiles | No test probes/secrets, complete strings/notices, verified components |
| E04 | Full compile/test/bundle/package/integration milestone | Record actual command/results, no claim of unrun native support |

## 4 Handoff and review

### 4.1 Implementation order

**Build shared contracts first, then the human journey, then the full compatibility matrix.**

1. Read PRODUCT, EXPERIENCE, RULES and this document; inspect current dirty-tree baseline before edits.
2. Investigate G2 with small isolated traces/fixtures; raise concrete spec feasibility problems to the assigned reviewer early.
3. Implement run records/state and execution adapters.
4. Implement human lifecycle and direct terminal journey.
5. Complete location/worktree, panel and commands/settings using the same services.
6. Run relevant suites and required behavioral scenarios; inspect real isolated UI; update the implementation-to-rule matrix.
7. The assigned reviewer checks evidence/diffs and resolves defects with the implementer; report completion levels under 1.1 separately.

Task assignments and current status follow the user's current instructions; they are not product rules. Raise a concrete rule/scenario/evidence issue when needed; do not repeatedly ask the owner to approve routine
engineering choices. Apply the owner-reviewed simple contract rather than preserving invalid requirements for old tests.

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
| 3.1, 3.3 | Scenario matrix has recorded result and artifacts at acceptance |
| 4.1, 4.3 | Handoff, spec-amendment log and independent review |

## Change log

- 2026-10-31: G5 records the night verification's Remote-SSH runs from a Windows x64 client, and the integration suite on
  VS Code 1.105.0, the declared minimum, and on Linux.
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
