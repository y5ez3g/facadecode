# Framework and Extension CI

**A green CI Gate means the proposed Framework and Extension merge passed every check that its acceptance plan
requires.** Each check identifies the source, target, implementation and behavior it exercised. Missing evidence
blocks the decision. A release separately proves that the files offered to users are the files that passed
candidate acceptance.

This is the target design. The baseline below records observed CI behavior. The rollout and the measured
acceptance criteria determine when the design is in service.

## Scope and baseline

This policy covers [Framework](framework/FEATURES.md) and the [standalone VS Code extension](extension/PRODUCT.md), including each implementation and native target that the extension supports. For
an IDE-only change, CI records an empty Framework and Extension test plan. Product behavior and version support
come from their owning specifications. Use [Framework compatibility review](framework/ENGINEERING.md#compatibility-contracts) and [Extension verification](extension/engineering/VERIFICATION.md#52-verify-upgrade-and-compatibility-against-the-previous-build) when changing a compatibility boundary.

| Observed at `6a35d3ee` | Consequence for this design |
| --- | --- |
| The active `main` ruleset requires PRs and has no required CI check. Framework and Extension workflows have separate path filters. | Give every PR candidate one required conclusion and test the policy that selects the individual checks. [Main ruleset](https://github.com/y5ez3g/facadecode/rules/25134905) · [Framework workflow](../.github/workflows/framework-check.yml) · [Extension workflow](../.github/workflows/extension-check.yml) |
| PR #103 took 45:34 for 19 jobs to go green. One editor step took about 42 minutes, including 8:28 of Framework release compilation. One Framework job waited 22:40 for its runner. | Measure queueing, build, test and cleanup separately. Move repetitive long journeys out of the routine PR path after the equivalent acceptance is proven in the new lanes. [Editor job](https://github.com/y5ez3g/facadecode/actions/runs/44944261048/job/136967976476) · [Framework job](https://github.com/y5ez3g/facadecode/actions/runs/44944261124/job/136967977192) |
| Seven PR workflow runs in a 100-run sample initially failed and passed on a later attempt. Logs show both a VS Code download timeout and an intermittent Framework RSS assertion. | Preserve the first attempt. Classify a verified dependency error, a harness error and a possible product race by their evidence. [Download failure](https://github.com/y5ez3g/facadecode/actions/runs/44370120326/job/135034307575) · [Framework failure and rerun](https://github.com/y5ez3g/facadecode/actions/runs/44913206203) |
| Real previous-version Framework scenarios, Extension Remote SSH and installed VSIX upgrade have explicit entry points. Release can already reuse full checks on an identical source tree. | Make applicable compatibility scenarios mandatory. Bind release reuse and installation evidence to the source and package digests. [Framework scenarios](framework/ENGINEERING.md#compatibility-contracts) · [Editor runner](../extension/src/test/integration/run.ts) · [Release workflow](../.github/workflows/extension-release.yml) |

The baseline sample takes the latest 100 workflow runs through 2026-11-21 22:24:10 UTC, starting at
2026-11-18 05:50:42 UTC. Retrieve that creation interval from the [workflow runs endpoint](https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-repository). Select `pull_request` runs that
finished successfully after attempt 1. Count those whose attempt 1 jobs include a failure, timeout, startup
failure or action-required conclusion. The seven run IDs are `44913206203`, `44794531694`, `44688437401`,
`44370120326`, `44357962324`, `44280320906` and `44269027394`. The candidate-based SLO below uses eligible
PR versions, including missing runs.

## Acceptance inventory

Generate an interface inventory from each executable registry in the candidate. Reconcile it with the
published contract or the actual registration at that boundary. Keep reviewed test bindings in a versioned
case catalog. The inventory generator and the test reporter use independent inputs so that an omitted test
cannot also erase its obligation. The `6a35d3ee` source review identified 186 interface entries and 15
cross-interface journeys before the window socket and Guest review. Treat that table as a starting
inventory. The registry parity check and reviewed support matrix determine the obligations for each
candidate.

| Boundary | Source used to enumerate it | Required evidence |
| --- | --- | --- |
| Shell and invoked process entry points | [Clap commands and parser dispatch](../framework/crates/facade/src/cli.rs), [hook commands](../framework/crates/facade/src/hooks.rs) and [Shell contract](PRODUCT.md#shell) | Run the built executable with an expected argv and assert exit status, observed output and effect. Include documented modes such as foreground and detached launches. |
| Daemon v1 requests, topics and frames | [Rust registry](../framework/crates/base/src/protocol/api_v1/daemon/registry.rs) and [generated schema](../framework/protocol/protocol.schema.json) | Cover each operation, topic and frame. Receive actual events at subscriber boundaries. Reconcile terminal, Extension, MCP and authenticated peer access with the registry. |
| Keeper v1 and relay connections | [Keeper schema](../framework/protocol/keeper.schema.json), [Keeper contract](../framework/protocol/KEEPER.md) and [relay handshake](../framework/crates/relay/src/daemon.rs) | Exercise requests and notifications with the real processes. Cover independent version negotiation, reconnect, and native terminal-resource ownership where used. |
| Both MCP implementations | [Framework tool catalog](../framework/crates/base/src/texts/tools.json), [Framework transport](../framework/crates/daemon/src/mcp/lines.rs), [legacy tool catalog](../extension/src/schema/tools.ts) and [Extension transport](../extension/src/transport/mcpServer.ts) | Send real stdio frames to each implementation and check the advertised tool catalog. Each of the eight names has separate tool evidence for both implementations. Check applicable managed and Guest behavior. |
| Extension commands | [VS Code contributions](../extension/package.json) and [command handlers](../extension/src/ui/commands/index.ts) | Invoke each supported command through VS Code. Check the handler for each implementation in which the command appears and assert the user-visible or persisted result. |
| Extension process and UI boundaries | [Window network declarations](../extension/src/base/windowNetwork.ts), [local window socket](../extension/src/host/windowNetwork.ts), [window identity and terminal registration](../extension/src/base/windowIdentity.ts), [legacy supervisor](../extension/src/ptyd/protocol.ts), [panel host](../extension/src/ui/panel.ts) and [Webview receiver](../extension/src/webview/panel.ts) | Exercise VS Code component commands and the socket's request, correlated response, rejected version, expiry and disconnect paths. Exercise supervisor events and panel actions through the corresponding boundary. Verify sequence, page generation and target identity. |
| Configuration and reload | [Framework settings reader](../framework/crates/base/src/settings.rs), [VS Code settings](../extension/package.json) and [Extension settings schema](../extension/media/settings.schema.json) | Exercise the real readers for `facade.json`, `facade.home` and `facade.framework`. Verify defaults, malformed input, scoped home, actual implementation selection and live reload where supported. Observe refusal before effects. |

Cover each registered, supported entry with at least one observed behavior. A read needs the expected data
and identity. A mutation needs corroborating observation of the intended state or effect. An event needs its
source, payload and correlation to the subscriber. An expected refusal needs the reason and evidence that
state stayed intact. Check advertised allow and deny rules as a generated contract matrix. Use a real
boundary example for each distinct authority or routing mechanism. Record serving implementation and applicable
direction as part of the case identity. A schema or mock check can prove its own contract, and each
interface obligation also requires evidence from a real boundary.

The catalog records a stable case ID, API or journey ID, owning spec and component, expected assertions,
runner and selector, implementation, target, compatibility fixture, required stage and owner. A single isolated
fixture can create several passing case records. Emit them only after their specific assertions complete.
Start with a repo-native `ci/cases.json` catalog and a support table keyed by product, implementation, target, host,
supported version direction and stage. Derive a case's required variants from that table. Implement each PR
smoke using the lowest-cost real boundary, and run platform-specific variants in the required native lanes.
The first implementation regenerates the inventory from these sources and validates one working mapping in
each product using the cited scenarios. Complete the missing mappings and validate the exact capabilities
advertised before enabling full enforcement.

Changes to a registry or an advertised support condition require a matching catalog diff. The verifier
reviews old and new inventory separately and reports added, removed and narrowed obligations. An API removal
or narrowed support follows its owning product compatibility review. A new boundary must have a discovery
rule and parity fixture before it can enter the supported surface.

### P0 acceptance

These journeys exercise the boundaries that carry user work and published compatibility promises. Keep
individual API coverage in addition to these end-to-end assertions. The catalog expands each row into
distinct success and failure cases. Paths are in-repository starting points for implementing or reviewing
the cases. The last column declares each required case ID suffix. The catalog checker rejects a
missing individual case even when other cases in the same journey are present.

| Journey | Required behavior and failure evidence | Required stage and existing entry point | Case ID suffixes |
| --- | --- | --- | --- |
| `framework/p0/start-stop` Start, resolve and stop | The selected CLI, folder and stable agent identity match the request. A failed start leaves no live process or published record. A retry with the original request ID creates one run. Stop selects the exact targets and records per-target results. Running and resumable lists show the current native session label, and resume keeps the full session ID. | PR · [CLI scenarios](../framework/tests/tests/cli.rs), [reliability cases](../framework/tests/tests/reliability.rs) | `start-and-resolve`, `failed-start`, `retry`, `targeted-stop`, `native-session-name` |
| `framework/p0/attach` Shell Attach and exit | Attach streams the selected process. Detach restores native terminal state and keeps the process alive. A foreground exit returns the child status. Reconnect uses the same run. Returning from an alternate screen restores the same host page and scrollback. | PR · [Attach scenarios](../framework/tests/tests/attach.rs), [Shell command cases](../framework/tests/tests/commands.rs) | `stream`, `detach-reconnect`, `foreground-exit`, `alternate-screen` |
| `framework/p0/input-draft` Input and draft protection | Type the expected Unicode and keys. A mixed sequence stays ordered ahead of subsequent input. Rejected input has zero unintended effect. A person's new input cancels a pending probe and draft-safe send leaves the draft intact. | PR · [MCP cases](../framework/tests/tests/mcp.rs), [probe scenarios](../framework/tests/tests/probes.rs) | `type`, `invalid-batch`, `draft-protection`, `ordered-sequence` |
| `framework/p0/message-receipt` Message and receipt | Delivery reaches one target with the expected sender and receipt. A deliberately lost response followed by retry with the original ID settles once. Disconnect during raw input reports the supported partial or unknown result. Check immediate inbox acceptance, explicit delivery waits, zero-budget MCP and a linked Shell reply across machines. | PR · [message scenarios](../framework/tests/tests/messages.rs), [reliability cases](../framework/tests/tests/reliability.rs) | `delivery`, `lost-reply`, `raw-disconnect`, `acceptance-and-delivery`, `mcp-zero-wait`, `shell-linked-reply` |
| `framework/p0/guest-reply` Guest reply | A Guest sends and receives through the real MCP connection. Verify the reply points to the original request, arrives once, and cannot be fetched by a different caller. A result wait can continue by the original message ID after a reply timeout. | PR · [MCP scenarios](../framework/tests/tests/mcp.rs), [MCP contract](extension/engineering/MCP.md#7-mcp-through-the-orchestrator) | `correlated-reply`, `wrong-caller`, `result-wait` |
| `framework/p0/authority` Authority and peer identity | Verify authorized and refused callers, a mismatched machine identity, and same names on different machines. Refusal preserves the relevant files, agents, routes and inboxes. Claude trust remains with the person for Shell and IDE starts. An agent start confirms only a recognized choice permitted by the destination. | PR · [authority cases](../framework/tests/tests/yolo.rs), [machine cases](../framework/tests/tests/machines.rs) | `authorized`, `permission-denied`, `wrong-peer`, `person-claude-trust`, `agent-claude-trust` |
| `framework/p0/remote-execution` Discovery and remote execution | Discover and choose the expected machine. Create a worktree from the remote HEAD, run the CLI in it and reach the same process from Shell and the Extension. Verify route loss and recovery and that the local repository remained intact. Deliberately lose a cross-machine reply after delivery, then retry with the original ID. Check the same settlement and exactly one delivery. Exercise a real SSH transport on SSH-sensitive changes. | PR and targeted native · [machine scenarios](../framework/tests/tests/machines.rs), [SSH smoke](../framework/scripts/ssh-check.sh) | `remote-worktree`, `route-recovery`, `retry-lost-reply`, `real-ssh` |
| `framework/p0/watch` Watch lifecycle | Watch the initial state and a subsequent correlated update. Unwatch releases resources and ends delivery for that watch. Reconnect gives a fresh snapshot and discards stale events. | PR · [protocol scenarios](../framework/tests/tests/protocol.rs), [terminal and watch scenarios](../framework/tests/tests/attach.rs) | `snapshot-update`, `unwatch`, `reconnect` |
| `framework/p0/service-recovery` Daemon and Keeper recovery | Replace or restart either service as applicable. Verify original CLI identity, Attach, terminal output and an exactly-once pending effect. Verify resource and process cleanup after the test. | PR and targeted native · [recovery scenarios](../framework/tests/tests/recovery.rs), [Keeper scenarios](../framework/tests/tests/keeper.rs) | `daemon-restart`, `keeper-recovery`, `pending-effect` |
| `framework/p0/prior-build` Real prior-build compatibility | Negotiate against pinned supported builds. Compatible hot replacement keeps the live process. Disjoint versions refuse before changing state or programs. | Compatibility-sensitive PR and candidate · [compatibility scenarios](framework/ENGINEERING.md#compatibility-contracts) | `hot-replacement`, `incompatible-version` |
| `extension/p0/activation-shell` Editor activation and Shell handoff | In isolated official VS Code with Framework active, start or locate the same Framework agent from Shell and the editor. Operate on its original process and worktree. With the legacy implementation, run the separate start, MCP, terminal and worktree journeys in its own supervisor. Check the actual serving implementation. A failed automatic Framework startup shows the recovery warning and leaves the legacy implementation ready without launching an agent on its own. | PR · [editor journeys](../extension/src/test/integration/run.ts), [Shell handoff scenario](../extension/src/test/integration/frameworkMultiWindow.ts) | `framework-handoff`, `legacy-supervisor`, `activation-failure`, `startup-fallback` |
| `extension/p0/pin-reload` Pin, reload and multiple windows | Verify a Pin restores the exact session once. Close one member window and observe the other keeps the same run. A missing session gives the prescribed outcome and an Unpin prevents resurrection. The legacy scheduled and candidate case also tests its close-last grace with the production timer, reconnect before expiry and cleanup afterward. | PR · [window journeys](../extension/src/test/integration/frameworkMultiWindow.ts) | `resume-legacy`, `resume-framework`, `pinned-reload`, `close-one-window`, `missing-session-unpin`, `legacy-last-window-grace` |
| `extension/p0/message-delivery` Draft protection in the editor running Framework | Run a real CLI stand-in through Framework. An explicit delivery wait blocked by a draft never writes to it or delivers after the draft is cleared. | PR · [MCP editor journey](../extension/src/test/integration/mcp.it.ts) | `draft-protection-framework` |
| `extension/p0/remote-host` Extension host reconnect | Test an actual Remote SSH editor host and controlled peer. Disconnect and reconnect. Verify identity, window ownership and pending message settlement. | Remote-sensitive PR, scheduled and candidate · [remote journeys](../extension/src/test/integration/remote.ts) | `ssh-connect`, `ssh-reconnect` |
| `extension/p0/window-replacement` Window replacement and implementation behavior | Verify both implementation paths, Window Component activation and an update with a message in flight. Observe the documented result with no duplicate effect. Stale claims and Webview generations cannot affect the current owner or a different agent. | PR and candidate · [editor runner](../extension/src/test/integration/run.ts), [command tests](../extension/src/test/commands.test.ts) | `window-activation-legacy`, `window-activation-framework`, `replacement-in-flight`, `stale-owner` |
| `framework/p0/install-upgrade` Framework install and upgrade | Install the candidate archive, start and query a fake CLI, and upgrade a pinned prior installation. An invalid digest or incompatible target preserves the working installation. | Installer-sensitive PR and candidate · [upgrade scenarios](../framework/tests/tests/upgrade.rs), [native installers](../.github/workflows/extension-check.yml) | `install`, `upgrade`, `bad-archive` |
| `extension/p0/vsix-upgrade` Installed VSIX and upgrade | Install both candidate VSIX components in clean profiles and exercise activation and a real command. Upgrade the prior supported package and check persisted workspace state, Pins and the Window Component. | Packaging-sensitive PR and candidate · [package tests](../extension/scripts/package.test.mjs), [VSIX upgrade journey](../extension/src/test/integration/run.ts) | `install-pair`, `upgrade-pair` |
| `extension/p0/release` Release promotion | The trusted candidate record accounts for every expected signed package. Corrupt, missing, wrong-version or stale-source artifacts block promotion. Verify bytes and the stable pointer after promotion. | Candidate · [release script tests](../extension/scripts/release.test.mjs), [release workflow](../.github/workflows/extension-release.yml) | `signed-artifacts`, `invalid-artifact`, `stable-pointer` |

## Candidate routing and enforcement

### Required lanes

| Input change | Before merge | After merge or on schedule |
| --- | --- | --- |
| Documentation or IDE-only paths | Check the changed CI and product contract documents, links and scope. Emit an explicit empty product plan when no Framework or Extension behavior is affected. | Regular scheduled matrix remains the integration baseline. |
| Framework runtime, tests, assets or toolchain | Framework format, lint, lockfile and the every-commit build and lockfile check for a Framework change. Run all applicable Framework API smoke and fast P0 cases. Run Extension Framework contract and smoke against the same Framework source. | Expanded native Framework and Extension coverage. |
| Extension runtime, tests, manifests or toolchain | Type, localization and spec checks as applicable, all Extension API smoke, and deterministic editor P0. Exercise each implementation that can be affected. Shared contract changes also select Framework. | Expanded native and implementation coverage. |
| Wire, durable state, PTY, paths, SSH, packaging, signing or installers | Add the corresponding exact-version, real transport, native target or candidate-package checks before merge. On shared protocol changes check Framework and Extension together. | Six native targets, supported editor versions, native combinations and release fitness. |
| Workflow, CI policy, shared root files or ambiguous diff | Run policy exercises and every possibly affected product and risk lane. Choose the known complete plan if a diff is ambiguous. A candidate whose source identity is unresolved is blocked. | Review scope drift and the first result on `main`. |

Resolve the checked-out test merge commit's base, head and tree from Git and GitHub. Diff that base to the
tested tree, including both sides of renames, additions, deletions and shared dependencies. Review the route
that controls the real entry point, such as generated protocol copies, runtime and dependency locks, package
or mirror scripts and runner changes. Large or incomplete path inputs take the conservative route. Exercise
the router with fixtures for each row and mixed changes before it can reduce any required coverage.

Retain the owning checks in their defined lanes. Framework PRs run `cargo fmt --check`, Clippy, the every-commit
build and lockfile check, and affected isolated scenarios. Wire changes run `protocol_files` and
`guide_examples`, including byte parity of generated TypeScript. The full workspace suite and native SSH
login smoke run daily and for affected native PRs. Extension PRs run `npm run compile`, relevant `npm test`
shards, `node scripts/l10n.mjs check`, the spec audit, bundling and isolated editor cases. Package changes
and candidates run `npm run package` and `npm run test:package`. Changes to release scripts run `node --test
scripts/release.test.mjs` before merge. The complete Mocha, native packaging and editor suites run at
milestones and in their scheduled lanes. [Framework engineering](framework/ENGINEERING.md#tests) · [Required Extension checks](extension/engineering/ARCHITECTURE.md#51-required-checks)

Use Linux x64 with a pinned current VS Code build as the routine smoke lane. Run platform-specific
obligations on their actual platform. Express each supported combination in the versioned support table with
the highest-fidelity required lane.

| Compatibility or native risk | Required fixtures and routing |
| --- | --- |
| Platform, PTY, native backend, paths and package layout | Linux x64/Arm64, macOS x64/Arm64 and Windows x64/Arm64 are the six native targets. Require every affected target when its native code, ABI, toolchain or packaging changes. Shared code affecting all targets expands the plan to all six. Test both supported Extension implementations on the scheduled native matrix. Verify installed artifacts on every released target. |
| Editor host and minimum version | Include VS Code `1.105`, the manifest minimum at the baseline, and a pinned current build. Run real host and component activation on both in the candidate matrix. Manifest or API-usage changes trigger minimum-version checks before merge. A scheduled current-channel lane identifies upstream changes early. |
| SSH, WSL and Dev Containers | Verify the declared combinations of local and remote clients and hosts using owned, disposable fixtures. Test native SSH with a real peer for remote-sensitive changes. Record local to SSH, SSH to local and SSH to SSH separately. Cover declared SSH host types, WSL on a disposable Windows host and pinned distribution, and Dev Containers with a pinned image. Require advertised directions in their scheduled and release lanes. A missing environment stays visible as an unmet obligation. |
| Framework build pairs and storage | Use immutable Framework builds for v1 hot takeover and incompatible offers. Record both source revisions, binary digests and API versions. Exercise schema upgrades with Framework store fixtures and the range-hello refusal with its wire scenario. |
| Actual extension packages and Window Component | Test the published prior VSIX pair against the new candidate pair with the installed-product harness. Changes to activation, component IPC, persisted Pins or package updates trigger their relevant pair before merge. |

The support table uses the repository's advertised compatibility windows and reviewed exceptions. Align
every included or deferred pairing with the actual contract. Pre-provision disposable native and remote
fixtures under test-only credentials. The required run uses an isolated test host and scoped test data. A
required fixture that is unavailable remains an explicit pending or failed obligation. [Framework compatibility inputs](framework/ENGINEERING.md#compatibility-contracts) · [Extension compatibility inputs](extension/engineering/VERIFICATION.md#52-verify-upgrade-and-compatibility-against-the-previous-build) · [Current Framework targets](../.github/workflows/framework-check.yml) · [Current Extension targets](../.github/workflows/extension-check.yml)
· [VS Code test hosts](https://code.visualstudio.com/api/working-with-extensions/testing-extension) · [Rust target-tier practice](https://doc.rust-lang.org/rustc/platform-support.html)

The owner supplies the native CLI release checks and user walkthroughs required by the Extension
specification. Use isolated accounts or recorded captures as the scenario specifies. Record the exact
candidate, host and CLI versions with the owner's observed outcome. [Extension verification](extension/engineering/VERIFICATION.md#22-coverage-matrix)

Run the standalone `facade-stress` program on a reserved, comparable Linux x64 runner nightly, on release
candidates and after merges that affect scheduling, terminal throughput or delivery. Use the optimized
fake-CLI build documented in [Framework](../framework/README.md#build-and-test), the default 100 agents and 100 flooders,
an isolated home, `--json` evidence and a same-shape, same-runner-class `--baseline`. Record the D6.7 and D6.9
limits with source and fixture hashes. Start with a 20-minute job budget, including cleanup. The program's
failed assertion or performance comparison opens a Framework incident and holds candidate promotion. Keep
the original result and run a same-shape comparison for diagnosis. A baseline shape or runner mismatch blocks
the comparison. To replace the baseline, run the last fully verified Framework revision on the new runner and
workload. Record its source tree, runner, fixture and result digests and obtain separate owner approval
before testing the candidate against it. Use the expanded affected-native lane for a native regression
when that target has an approved baseline and workload. [Stress program](../framework/tests/src/bin/facade-stress.rs)

### One merge conclusion

Every PR open, update, reopen and ready-for-review event gets a PR-scoped plan. Use `pull_request_target` to
read candidate metadata in protected code and record the pending check. Run selection inside the policy so
every eligible candidate gets a conclusion. A push to `main` or the reconciliation sweep reevaluates base
movement and missed events. Use strict required status on `main` and the existing review and merge-commit
rules. A moved base invalidates the old result. Hold expensive dispatch until the branch meets the strict
base requirement, and identify that requirement in the pending result. Supersede earlier candidates of the
same PR only. [GitHub workflow events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows) · [Required status checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks) · [Rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)

Protected coordinator and reconciler workflows read metadata as data and execute protected default-branch
code. Dispatch a protected-ref worker with the frozen candidate tuple and dispatch key. The worker verifies
the fetched merge commit and uses a separate permission domain for candidate build and execution.

Use an unprivileged container or disposable guest on Linux. On Windows and macOS, use a restricted native
execution identity or disposable native guest that preserves real terminal and editor behavior. The
protected driver owns the fixtures, assertions, observations and ledger. The candidate can read its input
and write its test scratch space. It runs without elevation, GitHub credentials, workflow command files or
write access to the driver, oracle, cache writer or evidence. Prefer standard hosted capacity where the
restriction passes preflight. Use disposable native test capacity on a target that needs a guest. A lane
with no proven isolation remains blocked.

The protected driver verifies the actual implementation, native architecture, toolchain, editor and process
identity. It observes effects from outside the candidate domain. Candidate output is input to these
assertions. Candidate-side helper tests can supply supplemental diagnostics. Only protected assertions emit
a required pass. The protected worker uploads bounded, schema-validated evidence. The reconciler checks
GitHub metadata, dispatch ID, workflow and policy revisions. Only the repository-scoped App issues the `CI
Gate` check. Select that App as the ruleset source. Keep its key in the protected environment and release
and merge credentials separate. Serialize check updates per PR and recheck head and base before posting.

Prove in a sandbox that GitHub applies the expected App result to the test merge commit for both a
same-repository PR and a fork. Exercise a different issuer with the same check name, base and head changes,
and removal of the producer from a candidate. Keep the design in shadow until the status, permissions,
cancellation and reconciliation behavior pass. A candidate self-report and a blocked attempt to write the
test ledger both leave the required case unproven. [GitHub security guidance](https://docs.github.com/en/actions/reference/security/secure-use) · [Checks API](https://docs.github.com/en/rest/checks/runs)

For each candidate, compute and persist a plan that identifies the policy revision, repository, PR, base and
head commits, test merge commit and tree, and exact expected case and lane tuples. The trusted reconciler
recalculates required obligations from protected policy and resolves the latest candidate through GitHub
before publishing. Candidate-supplied test records cannot set the required list, change scope or claim a
different producer. Accept the union of existing obligations and approved additions when the candidate adds
a registry entry. The trusted planner parses candidate registries and bindings as data and applies the
protected catalog minimum. Policy, discovery, test-oracle and release-verifier changes run the existing
trusted obligations plus the proposed behavior in shadow. Approval is tied to the exact candidate hash and
altered policy or oracle diff. Use a protected policy approval for an intentional replacement or retirement.
Record the owner, exact base, head, merge tree and policy digest, case IDs, reason and expiration within 24
hours. A replacement must pass its protected case and fail its controlled regression. A retirement requires
the documented support change and observed refusal or migration behavior. The protected driver executes the independently reviewed oracle at its
approved digest. The approval only changes the
named obligations for the approved candidate. Preserve the record and invalidate it after any tuple change.

A case record contains the case ID, candidate and plan digest, selected target and implementation, fixture and
toolchain revisions, runner image and OS, VS Code build and seed where applicable, run/job/attempt IDs,
status, elapsed time and sanitized evidence location. Attach artifact digests where cases ran on an
artifact. Accept an expected pass only from an allowed job of the corresponding protected dispatch, with
successful execution and matching metadata. Read source, event and conclusion from GitHub. Validate each
data artifact against a strict schema and byte limit. Only the trusted reconciler turns it into a decision.
Reconcile API discovery, selection and proof as sets. An unresolved route, missing, duplicate or unexpected
result, zero-test discovery, skip, cancellation, timeout, wrong implementation, stale attempt, or bad evidence
leaves the required check red or pending. Legitimately empty plans include the approved scope reason. A
diagnostic rerun produces additional evidence under the same candidate identity. A product assertion stays
blocking until a reviewed fix produces a new candidate. For a verified infrastructure failure before
assertions, the owner may authorize a same-plan job recovery. Reuse earlier passes only when candidate,
artifact, case, runtime and fixture match. Allow at most one recovery action per failed lane, including
dependency retries. A second failure opens an incident and requires an identified repair and a fresh plan.
Diagnostic reruns leave the product failure blocking. Reconcile late or duplicate completion events
idempotently and discard observations for superseded candidates. A scheduled sweep surfaces a missing or
stuck workflow by its deadline and alerts the maintainer.

## Reliable and fast execution

1. **Reproduce the inputs.** Pin toolchains, actions and the VS Code build used for PRs. Verify fetched archive
   digests. Keep a scheduled lane against the current supported external versions. Use fresh per-case Facade
   homes, platform temp paths, editor profiles, repositories, ports and fake CLIs. Two windows share state only
   inside the fixture that asserts sharing. Exercise real local transports without depending on a developer's
   services, editor state or accounts. Use isolated accounts and profiles for any maintainer-run vendor check.
   [Hermetic testing at Google](https://abseil.io/resources/swe-book/html/ch11.html#properties-common-to-all-test-sizes)
2. **Separate waiting from behavior.** Wait on a readiness or state transition with a bounded deadline and a
   diagnostic snapshot. Use controlled clocks or events in tests of timeouts, retries, races and shutdown.
   Preserve exact ordering, request IDs and process identity. On timeout or failure capture versions, failing
   case and assertion, sanitized frames or relevant trace, and the command and fixture needed for single-case
   reproduction. Cleanup reports process and file leaks even on failure. Remote resources have a per-run lease and an
independent reaper that stops processes, closes ports and removes test data after expiry or runner loss.
Stream bounded diagnostics during execution. Cleanup failure blocks acceptance.
3. **Keep the first failure visible.** Classify each failure as product, harness, dependency/runner,
   canceled/superseded or unresolved. A rerun to green supplies evidence for triage without converting an
   assertion failure to a pass. Count a known dependency acquisition retry even if the eventual gate succeeds.
   Use at most one 90-second automatic recovery for a listed transient dependency acquisition before product assertions. A rerun after runner loss uses the same lane recovery allowance.
   Assertion and security failures stop the gate and get a diagnostic rerun on the same revision and fixture. A
   required case can leave the gate only after equivalent deterministic coverage is active and verified. Track
   any quarantined case by owner, expiry and continued scheduled execution. [Google's flake practices](https://testing.googleblog.com/2016/05/flaky-tests-at-google-and-how-we.html)
4. **Shorten the measured critical path.** Run quick format, compile and contract checks in parallel. Partition
   editor journeys by setup and measured duration. Run a short real-boundary smoke that reuses one fixture for
   many case records. Build once per tree, target, toolchain and profile where the binaries are interchangeable.
   Reuse those verified artifacts across eligible consumers. Key caches by target, profile, toolchain and
   lockfiles, and measure restore costs and misses. A cache hit never supplies test evidence. Use cold-path spot
   runs to verify the build still works on fresh runners. Hosted runners are the starting point. Consider
   capacity changes only after queue metrics identify the limiting lane. [DORA CI feedback](https://dora.dev/capabilities/continuous-integration/) · [Google presubmit and postsubmit](https://abseil.io/resources/swe-book/html/ch23.html#presubmit-versus-post-submit) · [GitHub cache scope](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)

First enforce the actual provider limits for the account and physical runner pool, then the design cap of 12
active jobs across all lanes. Within that remaining capacity, admit at most four routine Linux x64 jobs in
their own logical lane. The cap of two jobs per native target applies to expanded PR, nightly and candidate
jobs, including their Linux x64 jobs. Both logical lanes share the same physical Linux x64 pool and count
against its provider limit and the account cap. Admit ready routine PR jobs first and reserve one place in
each affected native pool for waiting expanded PR work before admitting more background jobs. With one
physical slot, run queued PR obligations before a bounded, cancellable background job in a measured quiet
window. Report delayed obligations and preserve them until they run.

| Lane | Critical path | Runner budget and split |
| --- | --- | --- |
| Routine PR | 2 minutes dispatch, queue and setup, 4 build, 3 tests, 1 decision | At most four Linux jobs and 40 runner-minutes. Include cold runs in the SLO and take at least one cold trace per cohort per week. |
| Expanded native or compatibility PR | 5 minutes queue, 4 setup and artifact restore, 8 build, 10 tests, 3 decision | Up to two jobs and 60 runner-minutes per affected target. Compile once per target and profile. Reuse the identical binaries for both implementation journeys when possible. Split independent native and version rows. |
| Daily native and compatibility matrix | Complete within 24 hours of due time | Start with 90 runner-minutes per native target and track the remote and prior-version lane budgets separately. Stagger native pools. |
| Release candidate | Measure signing, installation, compatibility and distribution separately | Report cold cost for each target and compare like-for-like acceptance obligations before changing capacity. |

Take paired cold and warm traces during shadow validation. On overrun remove duplicated builds and fixture
startup first, then measure runner capacity. Keep the acceptance obligations while changing implementation.
[GitHub Actions limits](https://docs.github.com/en/actions/reference/limits)

Reuse `framework/scripts/test-all.sh` or `test-all.ps1`, the existing daemon and MCP scenario clients, and the
Extension's `test:integration` and `test:remote` harnesses. The new runner exposes each selected case and
its reproduction command. Keep raw first-attempt summaries and the consolidated case ledger for at least 90
days. Maintain one weekly report of first failures, slowest cases, queue wait, cold/warm timing and
unexplained skips. Redact credentials and user content before upload. [Framework test runner guidance](framework/ENGINEERING.md#tests) · [Extension verification evidence](extension/engineering/VERIFICATION.md#12-evidence-format)

## Main and release health

Recheck the tree landed on `main` on every merge. Run affected deep lanes and complete the remaining native
and compatibility matrix daily. Compare the landed tree with the one previously validated. Record the last
fully green tree, pending obligations and a versioned main health state.

If a required main result turns red, record a hold in protected control state before issuing further
success. Update affected open App checks to failure, including already green candidates, and link the
incident. The repair or revert candidate still needs fresh evidence, including the failing case. Close the
hold after passing validation on the landed repair and reevaluate pending candidates. Pair every escaped
defect with a case that fails on the broken tree and passes on the fix.

Each merge in enforced service is an explicit owner-authorized request to the protected merge job. Use
separate rulesets for branch update authority and required status. Give only the merger permission to update
`main` under the update rule, and keep PR review and the App's required check in the other rule. The
protected merger shares the health lock with the publisher. It validates the latest base, expected head, App result and current health before the GitHub merge request. During a hold, this job accepts only the exact
incident-linked fix or revert with fresh evidence and owner authorization. All other merges wait for recovery. Keep the owner's review and merge decision.
Prove earlier greens cannot merge during a recorded hold in the same-repo and fork sandbox rehearsal.

A read-only monitor on an owner-controlled scheduler outside repository Actions polls GitHub for candidate,
main and release heartbeats every five minutes. It alerts on overdue candidate results, 15 minutes without
GitHub visibility, or a missed daily matrix at 24 hours. Exercise loss of schedule and loss of workflow
visibility. The clock and alert path need to work when the monitored workflows do not.

Use the existing prepare, mirror and owner-approved publish transaction. Resolve a release tag to an accepted
commit reachable from protected `main` with eligible source and main evidence. A tag push or manual prepare
requests work. Both route to the same protected main release workflow and have no signing authority of their
own. The Extension PR and manual check workflows build unsigned artifacts or use a test certificate.
Remove the manual `sign` path's production credential access when the protected path takes over.

Require two approvals bound to distinct immutable records. Before signing, the owner approves the tag,
source commit and tree, protected workflow revision, verification and build plan, and digests of the
unsigned inputs that the job is about to sign. The signer checks that record, the input digests and current
main health before requesting production credentials. Limit OIDC credential issuance to the repository,
protected environment, approved signing workflow and exact protected ref. Use a customized subject when the
provider matches only subject and audience. Advance only after a sandbox proves the tag workflow, manual
check, and an alternate workflow on the same repository cannot obtain the production credential.

Sign the approved inputs, assemble each final archive and VSIX once, and test those resulting bytes on their
published targets. Bind the signed bytes and installation and upgrade evidence to the approved build plan
by SHA-256. Attest the final artifact digests and candidate manifest from the protected release workflow.
The owner then approves the final tested manifest digest for store publication and stable promotion. Both
verify that approval, builder, digests, tag and main health before effects. A partial rerun uses the same
immutable input and candidate records. A moved tag or changed artifact requires new proof and approval.
[Current release workflow](../.github/workflows/extension-release.yml) ·
[GitHub OIDC workflow trust](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-with-reusable-workflows) ·
[SLSA provenance verification](https://slsa.dev/spec/v1.2/verifying-artifacts) ·
[GitHub artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)

Canary the existing mirror with the candidate and verify every expected digest through the real installer
paths. Publish store assets under the owner's existing approval process and verify each channel's files
before changing the stable pointer. Resume partial publication idempotently by verifying prior uploads. Keep
the previous verified release accessible. Freeze promotion on any mismatch or discovered defect. For a
channel with a movable pointer, restore the previous verified set only after verifying that current
persisted data can still open safely. Use a verified forward fix for immutable store versions or
incompatible data migration. Rehearse both recovery paths on disposable mirror and store fixtures. [Google release engineering](https://sre.google/sre-book/release-engineering/)

## Measured acceptance

Track full active PR wait from ready to a verified current decision, including required base sync and
repeated verification. Show needed base updates or any other first blocker within two minutes and track a
15-minute P95 routine wait target, with service and contributor wait shown separately. For the 10-minute
test SLO, measure each latest eligible candidate once, keyed by repository, PR, head and base. Reconstruct
the denominator from qualifying PR and base events, including candidates that never started a workflow.
Start the clock when a ready, mergeable candidate satisfies the base rule. Track separately the time held
for conflicts, stale bases or a documented fork approval. The first actionable result identifies a completed
policy, contract or build check that can guide a change. A queued or planned status contributes no feedback
sample. Count the time until the required decision, including runner queue and infrastructure retries. Split
Framework-only, Extension-only, cross-product and expanded native or compatibility changes. Report warm and cold
samples and each cohort's size. Exclude a canceled candidate only when a newer one is observed. A missing or
timed-out result for the newest candidate counts as a service failure and a latency breach. Keep these
observations in the denominator rather than measuring successful jobs alone. Record first-attempt outcomes
independently of the final gate. Triage first-red outcomes using case and environmental evidence. Charge
confirmed false reds and still-unresolved first failures after 48 hours to the same budget.

| Steady-state objective | Acceptance evidence |
| --- | --- |
| **100% of required API and P0 evidence** | Every required case on the current plan passed in its supported lane. Audit the inventory against registries, P0 behaviors and every shipped native target. Require the enforced-gate and release canaries to pass. |
| **Fast PR feedback** | Routine code changes have P95 ≤ 10 minutes for the merge decision, and P95 ≤ 5 minutes to the first actionable check. Expanded platform or compatibility plans have P95 ≤ 30 minutes. Show queue, build, execution and reporting time separately. |
| **Low false-red rate** | Over a rolling 30 days, at most 1% of distinct evaluated first attempts are confirmed false reds or unresolved after 48 hours. Include dependency retries in the first-attempt accounting. Show the numerator, denominator and uncertainty. |
| **Actionable failures** | At least 95% of first failures link to the specific case or infrastructure operation, its inputs and a reproducible command or diagnostic route. Every open P0 incident has an owner and an active merge or release response. |
| **Main and candidate health** | Investigate any P0 escape within one working day and hold promotion until recovery evidence passes. Surface a missing daily matrix after 24 hours. Every actual candidate must have the complete native artifact and compatibility proof. |
| **Cost is visible** | Report runner minutes and queue distribution per applicable PR candidate, full post-merge matrix and release. Compare the same coverage plan when judging an optimization. |

Use a rolling 30-day window and at least 30 comparable candidates for a reported latency P95 per cohort.
Treat smaller cohorts as provisional. For the 1% claim, include a one-sided 95% binomial upper bound and
gather comparable observations until it is at or below 1%. For example, 299 independent observations with
zero charged failures meet that bound. Accumulate confidence evidence under the same policy across up to 90
days while publishing the rolling 30-day operating rate. Small and correlated samples stay provisional. Keep
sample counts and uncertainty visible when traffic or correlated incidents limit the inference. Declare the
implementation at the 90-point target only after coverage, gate integrity, release proof and the measured
limits above are demonstrated. Regressions in those limits trigger investigation and plan adjustment.

## Rollout and proof of the gate

| Step | Change and accountable role | Exit evidence |
| --- | --- | --- |
| 1. Inventory and measurement | CI maintainer owns planner, case ledger and baseline timings. Framework and Extension owners verify their source registries and existing case mappings. | From one Framework and one Extension run, reconcile exact versions, required IDs and the observed test count. Omit a planned pass and verify the shadow aggregator identifies it by name. Preserve the existing required behavior and check jobs during this stage. |
| 2. Deterministic required cases | Product owners fill every required API and P0 mapping, using existing test harnesses. CI maintainer adds route fixtures, pinned inputs and reproductions. | All obligations pass on supported profiles. For a duplicate delivery, lost Pin and compatibility refusal, inject the controlled regression, observe the intended assertion fail, then restore and pass. Measure the intended PR lanes in cold and warm conditions. Compare at least 30 same-tree shadow candidates with the current full suite and exercise each high-risk route with fixtures. Include a measurement while native jobs compete for runners. Resolve missed obligations and attain the intended budgets before enforcement. |
| 3. Protect the merge decision | Repository owner enables the strict `main` rule after the protected verifier is proven. Validate same-name checks, fork candidates and base churn. | Demonstrate that docs-only, Framework-plus-Extension, Windows-specific and mixed rename changes select correctly. Confirm that failing, skipped, canceled, zero-test, missing, wrong-implementation and stale-candidate evidence cannot merge. An older success cannot satisfy a new merge candidate. Rehearse a late main P0 hold with a previously green PR, a reviewed API retirement, rejected forged evidence and failure of the workflow schedule. |
| 4. Transfer deep coverage | Product and CI maintainers enable post-merge and scheduled lanes, candidate verification, and the first-failure dashboard. | Keep the comparison evidence from shadow validation. Confirm post-merge and daily coverage on multiple consecutive runs before retiring duplicate jobs. Resolve any lost obligation before removal. Verify native artifacts, a tag outside verified main, corrupt-artifact refusal, partial channel promotion and safe recovery in a dry run. |
| 5. Measure sustained operation | CI maintainer reviews the error budget and top critical-path costs weekly. Repository owner handles incidents and protected rule changes. | Use the measured criteria above. Unresolved baseline gaps and insufficient samples stay visible. Work next on the largest measured source of lost time or trust. |

Retain the last known good policy during migration. If the new verifier or runner infrastructure fails, keep
user changes pending and restore the known good verifier through an owner-controlled, tested recovery path.
Keep a protected ref and verified copy of that policy. Rehearse a ruleset repair in a disposable target and
log the exact rule state and verified replacement. During a fault the repair path restores verification. The
live check continues to require candidate proof before permitting a product change. Validate the restored
policy against the actual candidate before reopening merges. A recovery record states the cause, affected
revisions, the evidence used to restore service and the follow-up case. Keep a tested restoration route for
the test service and the release workflow.

## Shadow implementation

The [complete acceptance table](CI-ACCEPTANCE.md) is generated from [`ci/cases.json`](../ci/cases.json),
which holds the reviewed assertions, stages, candidate test sources and exact bindings. The catalog
checker discovers Framework's CLI, daemon, Keeper, relay, MCP and configuration
interfaces from their registries and schemas. It discovers Extension commands, the Window Component,
local window transport, supervisor, Webview, MCP and settings from declarations and serving code.
Extension API IDs identify the legacy or Framework implementation when the implementations differ. The P0 table above
declares each required journey case by name. Every bound PR row enters the plan automatically.
The catalog rejects any PR P0 row without a binding. Discovery and the P0 table are independent of
the test bindings. Both installed VSIX rehearsals also require a binding. A surviving obligation
with a binding at the base commit must keep an executable test. The PR and main checks report
changed assertions, stages and selectors and flag removed rows for review before protected enforcement.

The [shadow workflow](../.github/workflows/ci-acceptance.yml) checks catalog drift and policy
regressions on relevant PRs. Framework source or CI policy changes select both Linux x64 pilots,
because the editor also runs Framework. Extension source changes select the editor pilot. Changes to
the shared built-in names select both. Documentation updates run the catalog check. Selection
compares the first parent of the PR merge tree to that tree and includes both paths of a rename.
The same shadow checks run on the landed `main` tree after a relevant push. Manual and
main runs select both pilots. A new PR head cancels the three earlier workflows of that PR.
The Extension job builds its test stage
once and uses official VS Code `1.105.1` with isolated profiles and fake CLIs.
It checks the pinned Linux x64 archive size and SHA-256 before each extraction, including
cache restores. It stages the verified official bundle in fresh scratch before building the
fixtures. A listed transient download gets one retry within the 90-second acquisition budget,
and the download log keeps its first failure. Framework shares one run
per scenario target and compares its exact test names. Extension shares a fixture for compatible
Mocha selections with the same implementation and route. Multi-window and lifetime drivers use separate
fixtures. Shared Window Component and stdio contracts also use exact compiled Mocha selectors.
The verifier requires their complete JSON report with the selected titles and zero failures or
skips. The native Extension matrix pins the official VS Code `1.147.0` archive for each host.
Each job checks the archive size, digest, version and build commit before building editor
fixtures. The Remote SSH lane stages the same verified Linux x64 desktop archive. Build,
download and test execution remain separate timed steps. The Intel Framework PR
job can restore Cargo dependencies for an eligible build. It still builds from source and runs
every case. The editor pilot runs the remote worktree case with two live Framework Shell Attach clients
and a real editor attached to the same process through a fixture SSH route. An incompatible
Framework hello must show its error inside the actual panel, with no serving implementation or CLI launch.
The window update installs the digest-pinned Extension 0.1.5 release into two isolated profiles,
then installs packages built for the current candidate while the same routed message is pending.
The run retains both VSIX pairs and verifies their digests with the completion record. It proves
the component replacement and one terminal submission within the original deadline.
A pair of Linux x64 release rehearsals uses those same verified inputs. The first installs the
candidate into a fresh profile and exercises the installed New Agent command. The second
reopens two actual Pins after updating both components, while the unpinned control stays hidden
and all three original CLI processes and sessions survive. These rows record the unsigned Linux
x64 candidate's installation and upgrade. Other release targets remain in their owning lanes.
The installed-pair journeys give VS Code both exact archive files and disable reciprocal
Marketplace pack resolution. The recorded component identities and real install or replacement
still have to pass within the same deadlines.
A separate two-window run checks that an old claim and an old Webview generation
leave the current owner, both running agents and their terminals intact. The current page then
changes only its selected agent.
The Linux x64 PR package job also installs the candidate Framework archive with default activation.
It starts and queries a fake CLI through the installed Shell, checks the installed MCP relay,
and proves two bad digests leave the install and the same live agent usable. The verifier
reads the candidate archive and checksum file again, checks the installed programs and
live identities, and reconciles each refusal with the unchanged state and later screen output.
The completion marker binds those observations and cleanup to the reviewed tree and run
attempt. It records Linux x64 coverage for these two rows. The other targets and signed candidate are
tracked in their native and release lanes.
When checking retained logs from a different runner, pass the known absolute runner checkout
path as `verify-native-install --producer-checkout`. The current local checkout supplies the
inspected installer source and tree.

The Linux x64 Framework job starts a separate loopback OpenSSH peer with disposable keys and homes.
It checks the selected machine, compares the same agent and process through the peer and the
forwarded route, and verifies that only the intended peer receives the exact input bytes.
The job reconciles the original log and scoped cleanup with the three tested binaries and the
GitHub run attempt. The same job uses locked Cargo commands to revalidate its debug build and runs
the exact Keeper recovery scenario from an isolated copy. Review checks the process and Attach
observations, scoped teardown and matching program digests in the Keeper and real SSH receipts.

### Local CI Gate decision

Evaluate a same-repository PR against a local observation snapshot. Use a clean checkout of the
exact test merge or the reviewed head with the same tree. Make the test merge object available locally.
The head must include the observed main base.

```sh
python3 -B ci/gate_shadow.py --repo OWNER/REPO --pr NUMBER --head "$head" --base "$base" \
    --merge "$merge" --checkout "$checkout" --observations "$work/observations.json"
```

The decision records the exact candidate, plan digest, changed paths, bound pilot cases, and required
workflows, jobs, runner labels, steps and artifacts. An IDE-only change gets an explicit empty product
plan. Changes to product documentation that trigger CI acceptance still require the catalog job. Framework
changes select both pilots because the Extension runs the Framework. Package and remote-sensitive
paths select their applicable native checks. Shared policy
and unclassified paths select the complete matrix. Each required workflow must have a supported
`pull_request` path filter that matches the diff. The decision names absent, unsupported or unmatched
triggers as failures.

Supply observations from an independent, reviewed source. The snapshot's `candidate` contains the
recorded GitHub PR, main ref and test merge commit objects under `pull`, `main` and `merge`. Its
`workflows` map is keyed by planned workflow filename. Each entry contains the GitHub `registration`,
`run`, `jobs` and `checks` records, along with paginated `artifacts` where planned. The entry's
`source` records `repo`, `pull`, `head`, `base`, `merge`, `tree`, the gate `plan` digest and the
`run` identity in the form `github/RUN/ATTEMPT`.

Place the original `shadow-pilot-PRODUCT-1.zip` files in a `shadow/` directory beside the snapshot.
The result's `shadow_replay` records rehashed pilot archives and exact case results, bindings and cleanup
for the selected attempt. The `job_metadata` and `artifact_manifest` fields record native job and
artifact manifest evidence. To include the full native archive replay, attach the JSON produced by
the expanded reviewer below under `expanded_review`. The decision matches that report to the candidate,
workflow jobs and attempts, artifacts and replayed shadow evidence.

The command prints JSON and returns 0 for success, 1 for pending and 2 for failure. Omit
`--observations` to print the plan with a pending decision. The local policy suite includes fixtures
for all four routes and blocked observations. [CI Gate fixtures](../ci/test_gate_shadow.py)

### Collect a CI Gate snapshot

Use a trusted GitHub CLI context with read access to the selected repository. Supply a clean,
reviewed checkout with the current test merge object available and a new output directory outside
that checkout. Add `--head` and `--base` to pin the expected current positions.

```sh
python3 -B ci/gate_collect.py --repo OWNER/REPO --pr NUMBER --checkout "$checkout" \
    --output "$work/gate"
```

The collector uses GitHub GET requests for the current PR and main ref, the planned workflow runs,
and the jobs, checks and artifact manifests for successful first attempts. It performs one collection
pass and rechecks the PR, base, test merge and selected workflow positions before saving. Metadata
requests have a 30-second timeout. ZIP downloads use the existing 90-second timeout and 1 GiB size
check per artifact. The saved observation file is capped at 4 MiB.

The local checkout supplies the gate plan. GitHub run and check records supply workflow association
and conclusions. The snapshot's `source.plan` joins those observations to the local plan. The
pilot ZIPs supply the replayed case evidence and its run-specific plan digest. For each planned
native workflow, the collector checks the run, merge and tree recorded in one original receipt.
Native results report job and artifact manifest metadata and the source receipt's artifact ID
and digest. Use the expanded reviewer for complete native archive replay.

The JSON result gives the exact candidate, plan and named blockers. A planning refusal preserves
the observed PR, head, base, merge and tree for diagnosis. A stable collection saves
`observations.json` and any collected shadow ZIPs, including when evidence is missing or stale.
Pass that file to `gate_shadow.py --observations` to replay it offline. A change to the candidate
or selected attempts during collection returns pending before the snapshot is saved. The collector
uses the local decision's success, pending and failure exit codes. [Collector fixtures](../ci/test_gate_collect.py)

### GitHub shadow review

Dispatch **CI Gate shadow review** from `main` with a same-repository PR number. The job checks out
the pinned workflow revision and requires it to match the current `main` base. It fetches the
repository's PR test merge into a separate disposable Git checkout and verifies its commit, parents
and tree against GitHub. The checkout uses an empty Git template and ignores global and system Git
configuration. A new or changed symlink or submodule blocks inspection.
[Workflow](../.github/workflows/ci-gate-shadow.yml) · [GitHub workflow variables](https://docs.github.com/en/actions/reference/workflows-and-actions/variables)

The runner executes the reviewer and collector from `main` and treats the candidate checkout and
artifacts as data. The repository token has read access to Actions, checks, contents and pull
requests. The existing PR workflows supply the evidence. Protected test isolation and a required
merge conclusion each have their own rollout proof.
[GitHub workflow permissions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions)

The job summary records the policy revision, candidate head, base, test merge, tree and plan digest.
Its table shows the exact PR runs and attempts seen for the existing matrix, including workflows outside
the Gate plan. Use the linked runs to compare the same candidate. The result distinguishes replayed
pilot cases from native source and job metadata. Read the diagnostic result and blockers in the
summary when the job completes. A rejected catalog identifies the observed candidate and the
catalog error before any matrix evidence is considered.

### Expanded PR evidence review

The shadow catalog job compares pending totals with the base on PR and main push runs.
It reports the IDs added to and removed from its pending obligations. An increase in that
count or the loss of a binding for an existing ID fails the job.

For a same-repository PR that schedules the complete Framework and Extension matrix, run the
read-only review from a clean, reviewed checkout of the exact head or matching GitHub merge.

```sh
python3 -B ci/merge_review.py --repo OWNER/REPO --pr NUMBER --head "$head" --base "$base" \
    --output "$work/review"
```

Review requires the current `main` base and GitHub test merge, the four first-attempt
workflows, all 24 jobs on their expected runner labels, and successful execution and
evidence steps. It checks the registered workflow and matching GitHub Actions check for
each job. The expanded review preserves each base catalog obligation and exact existing binding.
It requires a binding for every new obligation and sends intentional catalog changes for separate
review. It rehashes the original shadow and native archives, reconciles exact shadow case proofs,
six typed runtime case records and two release fixture case records, and verifies all six unsigned
native package sets and their paired VSIX bytes. The Linux x64 legacy editor log must show the
same process on immediate reopen and the same session in a new process after the production
close-last grace. Each of the 12 native editor logs must meet the reviewed 61-pass baseline and
record completed profile cleanup. The verifier checks the current
PR, base, workflows and local checkout again before reporting success. Drafts can be reviewed.

This command is an operator review of already reviewed sources. Required status and App
credentials belong to the protected coordinator and isolated execution described above.
A later attempt requires separate incident and recovery review.

The read-only current main observer identifies missing, running and failed shadow evidence
on the exact checked branch position.

```sh
python3 -B ci/github_main_health.py --repo OWNER/REPO --head "$main" --checkout "$main_checkout"
```

It retains the first failed attempt and its failing step links even after a rerun. A verified
result replays both main shadow artifacts. The protected health lock and merge authority
remain separate deployment steps.

The Linux x64 legacy implementation PR job archives the complete release-script suite with its exact
test names and the producing source and attempt. Its disposable GitHub and website
transports prove corrupt and stale candidates cannot switch stable, and an interrupted
promotion can finish with the same verified pointer and manifest.

### Signed Extension candidate evidence

Replay an exact tagged release and its retained native test evidence with the read-only
`verify` command. Use an independent digest of `native-test-evidence.json` from the reviewed
producer. Keep the Git tag locally so the verifier can resolve its commit, tree and installers.
Omit `--release-dir` to read the GitHub Release.

```sh
cd extension
node scripts/release.mjs verify --tag "$tag" --release-dir "$release_assets" \
    --evidence-dir "$native_evidence" --evidence-digest "$reviewed_evidence_sha256"
```

The evidence directory keeps the original `extension-<target>` package artifacts under
`packages/` and UTF-8 logs under `tests/<target>/`. The version 1 `native-test-evidence.json`
contains `schemaVersion`, `tag`, `source` (the release candidate's `revision`, `tree`, `run`
and `attempt`), the digest of the release `SHA256SUMS` as `manifestSha256`, and `targets`.
Each target supplies `target`, `packageEvidenceSha256` for its original
`native-package-evidence.json` and a `logs` map keyed by the check name. Each log record names
`source`, `target`, `inputs` (file names and SHA-256 values), `exitCode` and the log's `sha256`.
The editor records also name the official VS Code `editor` identity (`version`, `commit`,
archive `sha256`). The upgrade record names the reviewed `prior` pair (`tag` and a `files`
map from name to SHA-256).

| Check and log name | Inputs and observations |
| --- | --- |
| `framework-install.log` | Run the tagged installer on the accepted Framework archive in an isolated install root. Keep the installer's output followed by the installed Shell's `facade --version` output. |
| `install-pair.log` | Give `install-pair` the released native and Window Component VSIX files through `FACADE_IT_CURRENT`. Check activation and one New Agent effect in the clean profile. |
| `upgrade-pair.log` | Give `upgrade-pair` the same candidate pair and the pinned prior pair through `FACADE_IT_RELEASED`. Check the workspace, Pins, Window Component and original sessions. |

Run the existing installed-pair drivers with `FACADE_IT_IMPLEMENTATION=legacy`,
`FACADE_IT_BUILT_IN=claude` and the same check name in `FACADE_IT_ONLY` and
`FACADE_IT_EXPECT_DRIVER`. Their final lines report isolated profile cleanup and the exact
driver result. Hash staged inputs before and after testing, record the actual exit status
and retain the original logs alongside the package digests.

Framework transcript replay checks the install report and the source-stamped Shell version. For evidence
of installed program digests, a live fake Agent and installer refusal behavior on Linux x64,
use the existing `ci/acceptance.py verify-native-install` with its typed receipt, original log,
and exact tested archive and checksum sidecar. [Native install verifier](../ci/check_native_install.py)

Replay checks the release manifest and six package sets, including both Windows signature
records and the exact universal VSIX selected for publication. It matches the test logs to
those bytes, source, target and attempt before emitting a JSON receipt. The receipt records
local replay of the supplied evidence. Plain `verify --tag` checks the release files and
remains available for historical inspection. Disposable fixtures exercise replay and
refusal without supplying production signing evidence.

The remaining production rehearsal requires an owner-approved candidate on protected main
and the signing approval described above. Retain the Windows x64 and ARM64 timestamped
signature checks from the approved workflow, with the expected publisher and Microsoft
ConPTY signer identities. In that candidate run and attempt, install and test the final
archives and exact published VSIX pairs on all six native targets. Stage the same published
Window Component for every target. Retain the pinned prior packages, native install and editor
logs, and the protected workflow's attestation for the final manifest and evidence digests.
Replay the record and check the approved producer and attestation before using it for the
`signed-artifacts` case. Previous releases provide historical evidence only. The approval
to publish and switch stable is a separate decision.

### Native Framework hot takeover QA

The Linux x64 replay takes two digest-pinned pairs of `facade` and `facade-mcp` from builds
with compatible v1 APIs. To produce a source QA pair, build the current checkout and a
separate numbered worktree at the same revision. Raise only the workspace package version
in the second worktree and update only the affected workspace package entries in `Cargo.lock`.
Keep the source revision, version diff, build logs and a SHA-256 manifest from each build.

```sh
# Run in framework/ in both worktrees, with the pinned Rust toolchain.
cargo build --locked --target x86_64-unknown-linux-gnu \
    -p facade -p facade-relay --bin facade --bin facade-mcp
# In each target/x86_64-unknown-linux-gnu/debug directory, save these checksums.
sha256sum facade facade-mcp
```

```sh
python3 -B ci/check_prior_build.py --candidate-bin "$lower_bin" \
    --output-dir "$work/hot-qa" --run-id hot-qa-local hot-qa \
    --candidate-manifest "$lower_manifest" --higher-bin "$higher_bin" \
    --higher-manifest "$higher_manifest"
```

The exact scenario verifies a new Daemon, the original Keeper, CLI and session, the
restored terminal watch, the original receipt and one fresh delivery to the same CLI.
The runner verifies both installed program pairs, their launchers, the two Keeper API
handshakes and owned cleanup. Separate tests exercise same-version, older-version and
disjoint offers. This is opt-in source QA. Actual incompatible builds and signed release
artifacts have their own catalog rows.

### Native Framework Keeper recovery

Run the exact native Keeper recovery scenario on Linux x64 from a committed Framework tree. Give each
attempt its own output directory and run identity.

```sh
python3 -B ci/check_keeper_recovery.py --run-id "$attempt" --output-dir "$output"
```

The runner records the locked build, test executable digests, original libtest result and cleanup
in the receipt. The scenario replaces the Keeper while the original Daemon and CLI remain live and
checks exit on the original Attach watch. This is an opt-in local replay. The native acceptance row
also requires matching evidence from the selected hosted lane when a candidate uses that lane.

### Linux x64 packaged Framework upgrade QA

Use two compatible archives, with a higher numeric version in the candidate. Obtain an
independent SHA-256 pin for each archive and keep its original `SHA256SUMS` file. To use
local QA builds, prepare the version-only pair described above and package both builds
with `node framework/scripts/package-framework.mjs --target linux-x64 --bin-dir "$bin" --out-dir "$package"`.
The fake CLI can come from a locked build of `facade-scenarios --bin facade-fakecli`.

```sh
python3 -B ci/check_packaged_upgrade.py \
    --prior-archive "$prior/facade-framework-linux-x64.tar.gz" --prior-checksums "$prior/SHA256SUMS" \
    --prior-sha256 "$prior_sha256" \
    --candidate-archive "$candidate/facade-framework-linux-x64.tar.gz" --candidate-checksums "$candidate/SHA256SUMS" \
    --candidate-sha256 "$candidate_sha256" --fake-executable "$fake" \
    --output-dir "$work/packaged-upgrade" --run-id packaged-upgrade-local
```

The shipped installer selects and activates each exact BUILD in the same disposable
home. The candidate replaces the Daemon while the Keeper and fake CLI retain their process
identities and the CLI retains its reported session. Both home launchers resolve to the candidate
programs. The old screen and receipt remain available, and the same CLI receives exactly one
fresh submission. Retain each archive's provenance, the console output and `receipt.json`
with the observed commands and scoped cleanup. This local QA evidence records a compatible
packaged path. The release upgrade row requires a qualifying pinned prior and release candidate.

### Native Framework incompatible build

On unprivileged Linux x64 with OpenSSH server and pidfds, build the lower and higher
Linux x64 pairs as described for hot takeover. Apply [the test Keeper API patch](../ci/fixtures/framework-keeper-api2.patch)
in the separate higher worktree before compiling. It leaves Daemon API 1 available so
the higher Shell reaches the actual takeover call, and makes its Keeper negotiate API 2.
Keep the source versions, the numeric and API diffs, the build logs and the archive checksums.

```sh
# From the root of each build checkout, with a separate package directory.
node framework/scripts/package-framework.mjs --target linux-x64 \
    --bin-dir framework/target/x86_64-unknown-linux-gnu/debug --out-dir "$package_dir"
# From the original checkout, build the stand-in CLI.
(cd framework && cargo build --locked --target x86_64-unknown-linux-gnu \
    -p facade-scenarios --bin facade-fakecli)

python3 -B ci/check_incompatible_build.py \
    --lower-archive "$lower_dir/facade-framework-linux-x64.tar.gz" --lower-manifest "$lower_dir/SHA256SUMS" \
    --higher-archive "$higher_dir/facade-framework-linux-x64.tar.gz" --higher-manifest "$higher_dir/SHA256SUMS" \
    --fake-executable framework/target/x86_64-unknown-linux-gnu/debug/facade-fakecli \
    --output-dir "$work/incompatible" --run-id incompatible-local
```

The higher build negotiates Keeper API 2 in a fresh home. Its direct `daemon --takeover`
against the older live Keeper refuses the exact Agent before changing program or durable
state. The original process, route, session and receipt stay usable. A repeat produces no
new terminal input and a fresh message reaches the same CLI once. The separate installer
check verifies that refusal leaves the selected home's program files, launchers and state
intact. This is local source QA for the native incompatible case.

### Native Extension Remote SSH

The Linux x64 connect proof opens official VS Code 1.147.0 against a disposable loopback
Docker SSH guest. Use a local Docker daemon, OpenSSH client, Xvfb, Node 24 and Python 3.
Put the four files named in the pinned manifests into a local asset directory. The server
file is `vscode-server-linux-x64-1.147.0.tar.gz`. Each extension file is `ID-VERSION.vsix`.
The runner stages and hashes the four files before opening the editor. [Server pin](../ci/fixtures/remote-ssh/official-server-linux-x64.json) · [Marketplace pins](../ci/fixtures/remote-ssh/pinned-marketplace.json)

```sh
(cd extension && npm ci && npm run compile && npm run bundle && node scripts/build-it.mjs)
ci/check_remote_editor.sh "$asset_dir" "$vscode_executable" "$work/remote-ssh"
```

The native test reads the actual remote Extension Host executable and the original Agent
identity from the guest. The exact workspace owns one pinned viewer, and the fake CLI
records one startup. The receipt includes the staged program and editor digests, the
authenticated SSH observation and the verified removal of the exact guest and scratch
scope. Pull requests that change these inputs select a separate Linux x64 connect job.
The reconnect case stays pending because the official workbench failed to reconnect after
a real carrier drop even when SSH transport recovered. A native reconnect run must restore
the actual workbench session, verify the original remote Agent identity and restored window
ownership, and settle an in-flight message exactly once before cleanup. This evidence is
independent of the signed candidate replay. [Remote SSH workflow](../.github/workflows/extension-remote.yml)

Each successful native PR package job records the VSIX pair, Framework archive and checksum file
digests with the checked-out revision, tree and GitHub attempt. Run
`extension/scripts/native-package-evidence.mjs verify` on the downloaded `extension-*`
artifacts to require an exact set of targets and recheck their bytes. The CI canary refuses a
missing target, a wrong-version VSIX, a stale tree or attempt, and a changed archive even when
its checksum file has also changed. It reads the Framework archive's version and checks its executable
members byte for byte against the paired VSIX. This verification reads the unsigned PR artifacts.

A clean checkout with a bundled editor can stage Framework programs from a verified native package on the same
source tree and host target. Supply the reviewed package directory and its pinned evidence digest.

```sh
(cd extension && node scripts/build-it.mjs --framework-package "$package_dir" \
  --framework-package-evidence-sha256 "$evidence_sha256")
```

The builder checks the digest of `native-package-evidence.json` and matches the Framework archive
and VSIX program bytes and `VERSION` marker before staging the fixture. For hosted reuse, verify
the artifact against the intended producer run and attempt before passing its digest. A Linux x64
fixture comparison exercises staging and refusal before fixture writes.

The manual [Intel macOS handoff canary](../.github/workflows/extension-intel-framework-canary.yml) compares
a Cargo control with the same Framework editor suite using a verified same-attempt package. Set
`reuse_framework` to `true` for the package path. Run both on one revision once the workflow is
registered on the default branch. Compare the ordered editor
cases and cleanup, then compare full wall time including producer queue, packaging, handoff wait,
artifact import and editor execution. [GitHub manual workflow events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch)

The Linux x64 Framework PR matrix closes every editor and removes the exact managed agents before
starting its next independent fixture. Only the previous fixture's daemon and Keeper idle waits
overlap. The native supervisor joins those waits, checks both endpoints and verifies owned
process cleanup. It reclaims the disposable scope on an interruption or a failed timeout.

After one shared build, the runner executes at most two isolated editor groups at a time.
An interrupt stops active owned sessions, cancels waiting groups and runs scoped cleanup.
After normal editor teardown it reclaims the detached Chromium crash reporter from the
same fixture using the pinned editor's executable identity. The final scoped scan still
checks all remaining processes and blocks a receipt when any are left.
Verify requires results, original logs and a post-cleanup record for every
planned case on the same source, plan, platform and run attempt. The editor tests identify the
serving implementation from the live host. The status describes the shadow pilot only. The existing product
jobs and merge and release rules continue to own their checks.

VS Code `1.105.1` lacks the built-in Git extension's `Repository.createWorktree` method. The
legacy implementation's New Worktree success case needs an editor with that capability. The minimum-editor
pilot exercises the legacy supervisor using a real linked checkout created by the fixture.

Run from the repository root on Linux x64. Install the pinned Rust toolchain and musl target, the
Node version from `extension/.nvmrc`, `musl-gcc`, `xvfb-run` and VS Code's runtime libraries.
The Extension runner uses the repository's lockfile and downloads the pinned editor. Supply
`--vscode /absolute/path/to/code` to reuse that exact editor build. On shared machines with
a low per-user inotify limit, use `--editor-workers 1` to run the same groups in sequence.

```sh
python3 -B -m unittest discover -s ci
python3 -B ci/acceptance.py catalog
python3 -B ci/acceptance.py table > docs/CI-ACCEPTANCE.md
work=$(mktemp -d)
attempt=$(basename "$work")
python3 -B ci/acceptance.py --run-id "$attempt" run --product framework --output "$work/framework"
python3 -B ci/acceptance.py --run-id "$attempt" run --product extension --output "$work/extension"
python3 -B ci/acceptance.py --run-id "$attempt" verify "$work/framework/receipt.json" "$work/extension/receipt.json"
```

To compare hosted runs, pass the full candidate head and each applicable workflow's run ID to
`ci/github_timing.py`. It reads queue and step timestamps, preserves first-attempt job outcomes
when a workflow is rerun, and rejects a different head. Retain the JSON record with the case
receipts. Its wall clock starts at workflow creation. A job cancelled before GitHub assigns a
runner records its wait as queue time and records no runner usage. The eligibility and denominator for the
steady-state SLO are defined above. [GitHub Actions jobs API](https://docs.github.com/en/rest/actions/workflow-jobs)

```sh
python3 -B ci/github_timing.py --repo y5ez3g/facadecode --head "$head" "$shadow_run" "$framework_run" "$extension_run"
```

To retain a current candidate observation, supply the exact head and live `main` base of an open,
mergeable, same-repository PR. Repeat `--workflow` for each required workflow path from its policy.
The command verifies the PR, base and test merge twice and records readiness and the observation time.
It works before any job results exist. The observation leaves `eligible_at` unknown. A timing roster
requires independent evidence for the eligibility time.

```sh
python3 -B ci/github_candidate_observation.py --repo y5ez3g/facadecode --pr "$pull" --head "$head" --base "$base" \
    --workflow "$required_workflow" > candidate-observation.json
```

For a first-attempt summary, save the timing JSON for each candidate and pass an explicit roster to
`python3 -B ci/github_candidate_summary.py roster.json`. The roster contains `observed_at` and a
`candidates` array. Each entry supplies `repository`, `pull`, `head`, `base`, `eligible_at`,
`expected_workflow_paths` and `timing`. List at least one exact required path, use timezone-aware
timestamps, and give a timing file path relative to the roster or `"timing": null` when no workflow was observed.
The roster supplies eligibility, the PR and base association, and the required workflow scope. The
summary checks each timing record's repository, head and event, uses each run ID once per repository,
and retains an optional `eligibility_evidence` reference.

The latest eligible row per PR supplies the service counts. A canceled row is superseded only by a
later eligible row recorded for that PR. The report lists observed and missing paths. A missing required
path makes the result `missing`. Missing, canceled and timed-out results for the latest candidate count
as service failures and latency breaches. Completed results distinguish success across all required
workflows, an explicit workflow failure and other conclusions. The summary uses the declared paths and
retains all raw timing records. First feedback measures the wait from eligibility to the first completed
actionable job in attempt one, with zero wait if the result was already available. An evaluated attempt
has a completed actionable job. Its first failure stays unresolved unless `first_failure_triage` supplies a
`classification` of `confirmed_false_red` or `confirmed_product_failure` and an `evidence` reference.
The summary counts confirmed false reds and first failures still unresolved after 48 hours, and shows
unknown durations and failure ages. Its counts describe the supplied sample. A population or P95 claim
requires the comparable rolling cohort and eligibility evidence described in measured acceptance.

For an independent verification of a hosted PR shadow run, check out the reviewed head when
its tree matches the tested merge tree, or use the exact merge checkout. The command requires
each selected job to have passed in the current attempt. It checks the GitHub ZIP digests and
the merge parents, then reconciles the original selected cases with their logged evidence.
Supply `--pr` to also confirm the workflow belongs to the open PR. The audit checks the
head, live base branch and GitHub merge revision before and after replay.
Use `--output` with a new local directory to keep the original downloads.
[GitHub Actions artifacts API](https://docs.github.com/en/rest/actions/artifacts)

```sh
python3 -B ci/github_evidence.py --repo y5ez3g/facadecode --run "$shadow_run" --head "$head" --base "$base"
```

`catalog --require-bindings` lists the remaining exact bindings and fails until every catalog row
has one. The current shadow evidence covers only the selected bindings on Linux x64. Native targets,
installed artifacts, prior releases and the latency and false-red objectives require the rollout
evidence above.

## Design review

Score the written design out of 100 before implementation. Each category earns its points for explicit
inputs, behavior, owner, failure handling and an observable exit criterion. Two TLs review independently and
record each deduction. A 99 requires at least 99 from both reviewers and resolution of every critical design
ambiguity. Runtime and coverage claims still require the measured evidence above.

| Review category | Points |
| --- | ---: |
| Scope, complete API inventory, P0 and platform fidelity | 25 |
| Candidate identity, merge enforcement, selection and evidence integrity | 20 |
| Reproducible execution, failure classification and diagnosis | 20 |
| Feedback time, cost and measurement | 15 |
| Main health, release acceptance and recovery | 10 |
| Ownership, rollout and tests of the CI policy | 10 |
