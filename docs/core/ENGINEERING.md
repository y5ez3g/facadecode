# Engineering

How a team of agents builds Facade core: who does what, the way from a spec to `main`, the rules every agent keeps, and
the templates and scripts they use. The owner writes a spec and starts a General TL; the General TL starts everyone
else and runs the work to the end.

The code's design is in [ARCHITECTURE](ARCHITECTURE.md) and [islands/](islands/); its words are in the
[glossary](GLOSSARY.md). This page is about the work.

## Roles

| Role | How many | Owns | Never does | Agent |
| --- | --- | --- | --- | --- |
| Owner | 1, the person | The spec; product decisions; trying the result; merging, pushing and releasing | — | — |
| General TL | 1 | The root island: the spec's plan, which islands change, the crates' interfaces and the protocols, starting every other agent, integrating the crates into the root branch, deciding interface changes after a freeze, the status file | Write an island's code; merge, push or release without the owner | Claude Code, Opus, max effort |
| Bar raiser TL | 1 | The bar: the [glossary](GLOSSARY.md) and the rules between islands. Reviews every freeze and every interface change, with a veto; checks the docs' words | Write code; decide behavior or design, which are the General TL's | Claude Code, Opus, max effort |
| Review TL | 1 | The whole review once everything is integrated: correctness, simplicity, the product principles. Checks the docs against the code | Change code or docs: sends each finding to the island that wrote it | Claude Code, Opus, max effort |
| QA lead | 1 | The scenario tests and the fake CLI; moving tests to new interfaces; normal-path system tests for the spec's features; the full test runs and the stress test | Change product code; hunt for edge cases | Claude Code, Opus, high effort |
| Island owner | One per island with children | Freezing its children's interfaces and the wiring between them; starting its children; its layer's code; integrating its children; keeping its island working | Change a child's inside | Claude Code, Opus, high effort |
| Engineer | One per island without children | Its island's code, to the frozen interface | Touch a sibling; write new tests | Claude Code, Opus, high effort, or Codex, high effort |

- Every agent starts through Facade, in its own worktree, so the owner can watch it. No in-process subagents.
- The agents that write code and the agents that write tests are different agents.
- One Claude account's limits are shared by all its agents. Thirty Opus agents can use up five hours of quota in under
  one: put engineers on Codex, keep Opus for the TLs, owners and reviews, and keep progress in files, not messages.

## From a spec to main

1. **The owner writes a spec**: what the feature is, why, and how to tell it works. The owner starts a General TL with
   it and the status file's location.
2. **The General TL plans.** It reads this page, [ARCHITECTURE](ARCHITECTURE.md) and the docs of the islands the spec
   touches, and lists what changes in which island. It creates the root branch, `feature/<n>-<name>` from `main`. If
   the crates' interfaces or the protocols change, it writes the root freeze. It starts the bar raiser, the review TL
   and the QA lead.
3. **Freeze from the top down.** Before an island's children start, its owner writes a freeze document
   ([template](templates/freeze.md)): what each child owns, its interface with exact signatures, what it gets at
   creation, how its siblings' traffic goes through the parent and in what order, and the two lines each island keeps:
   what it keeps and what it never does. The bar raiser reviews every freeze; only "must fix" findings block. The
   owner's own layer may be written while its freeze is in review.
4. **Start the islands.** Each owner starts its children's agents ([briefs](templates/briefs.md)), each in its own
   worktree: branch `feature/<n>-<island path with dashes>`, in `facadecode.worktrees/<n>-<island path with dashes>`
   beside the repository. Every island branches from the same commit, `<start>`: the General TL's own commit on the
   root branch where it has one, else the commit of `main` the root branch began at. Only the islands that change
   start.
5. **Build.** Each island commits as it likes while it works, then delivers **one commit** with only its own files. It
   builds, and the tests of its island pass, in its worktree. Where another island needs a new interface first, its
   owner delivers that as a small commit ahead of the rest.
6. **Integrate from the bottom up.** A parent puts its children's commits on its own line, then its own commit last:

   ```sh
   git switch --detach <the line to build on>
   git cherry-pick <start>..feature/<n>-<child-1> <start>..feature/<n>-<child-2>
   git cherry-pick <the parent's own commit>
   git branch -f feature/<n>-<parent> HEAD && git switch feature/<n>-<parent>
   ```

   Siblings own different files, so their commits apply cleanly. Only `core/Cargo.toml`'s members and `Cargo.lock`
   can conflict: keep both members, and let cargo write the lock again. The parent builds, runs its and its children's
   tests, and, from a crate up, the scenario tests; then it reports its head to its own parent. The General TL
   integrates the crates into the root branch the same way, in dependency order. The line stays straight: no merge
   commits.
7. **Change an interface after its freeze** only through the chain: the island asks its parent, up to the General TL and
   the bar raiser; once they agree, the General TL tells every island it touches.
8. **Review, QA and stress**, once everything is integrated. The review TL reviews the whole; the QA lead runs every
   test, adds normal-path system tests where a feature has none, and runs the stress test once. Each problem goes back
   to the island that wrote the code. Its fix comes as a `fixup! <title of that island's commit>` on the root branch,
   made from the root branch's head on a branch of its own.
9. **Squash and check.** The General TL puts the fixups on the root branch and squashes them once with
   `git rebase --autosquash <the commit before the first island's>`. Then it runs the workspace tests and
   `scripts/check-each-commit.sh <base> <head>` from `core/` on macOS or Linux.
10. **The owner tries it.** Build, install in an isolated home, tell the owner where it is, and wait. Problems the owner
    finds go back to the islands that wrote the code, as in step 8. Ask the owner before merging into `main`, pushing
    or releasing.

A small feature that touches a few islands takes the same steps: freeze only what changes, and start only those
islands' agents.

## Rules

### Product principles

The owner's product principles decide every trade-off: load the skill `product-principles`. In short: make the normal
path excellent first; add complexity only for a security hole or data lost on the normal path; build the simplest
version and optimize only after a stress test fails; write no code and no test for a problem nobody has seen. Keep the
edge cases that have already landed unless the owner says otherwise.

### History

- The root branch is `main` and the islands' commits after it: one commit per island, in a straight line. No merge
  commits, no work in progress, no `fixup!` left.
- Every commit builds, and cargo leaves its `Cargo.lock` as it is: `core/scripts/check-each-commit.sh` checks both.
  Where a squash leaves a commit whose lock cargo would change, write the lock again in that commit:

  ```sh
  git rebase --exec 'cd core && cargo metadata --offline >/dev/null && git add Cargo.lock && git commit --amend --no-edit --allow-empty' <base>
  ```

- A commit's title is `<crate or module>: <what it does>`. Its body says what the island owns, how it is split, and
  what behavior changed. Commit messages, code and comments say what the code does: no process words, such as island,
  freeze, spec or step, and no links to planning files.

### Islands

The rules between islands are in [ARCHITECTURE](ARCHITECTURE.md#rules-between-islands). The bar raiser checks them in
every freeze and every delivery with these commands, run from the worktree's root:

```sh
# References that leave an island: run for each child's folder or file. Each line must be a shared value,
# a handle the parent gave, or a dependency the parent drew.
git grep -nE 'super::|crate::' -- <child folder or file>
# impl Daemon: only in the daemon's layer.
git grep -nE 'impl.*[ :]Daemon \{' -- core/crates/daemon/src
# CLI names outside rules: none outside tests and the texts a model reads.
git grep -niE '"(agy|claude|codex|muse|opencode|pi)"' -- core/crates ':!core/crates/rules' ':!*.md'
# Look for platform-specific implementation outside the platform, Keeper and Relay owners.
git grep -nE 'cfg!?\(.*(target_os|target_family|unix|windows)' -- 'core/crates/*.rs' ':!core/crates/base/src/platform' ':!core/crates/keeper' ':!core/crates/relay'
```

For the platform check, identify tests separately. The existing Shell platform branch selects
the text of a [repair command](../../core/crates/facade/src/errors.rs#L945). Its responsibility
ends at formatting. Process, terminal and transport behavior follows the [island ownership rules](ARCHITECTURE.md#rules-between-islands).
Review each new cross-island reference against the named owner and approved dependency.

### Compatibility contracts

[Daemon storage](islands/daemon.md#storage-format-and-migrations),
[Daemon API](../../core/protocol/DAEMON.md) and [Keeper API](../../core/protocol/KEEPER.md) define
current compatibility boundaries. Keep the database format, daemon API and keeper API versions
independent. The application owns SQLite's `user_version`.

A change to a persisted schema, stored encoding, ID, receipt key, or published wire field or behavior
needs the repository owner's approval through the [interface freeze and change procedure](#from-a-spec-to-main).
Put the proposed boundary, supported builds, migration or refusal behavior, and verification plan in
the freeze before approval. Record actual evidence at review, including the old and new artifact
revisions and the isolated home. Internal refactoring that preserves the contract follows the ordinary island review.

- **Wire.** Compare the proposed schema and behavior with the frozen released endpoint contract.
  Update the owning [Rust definitions](../../core/crates/base/src/protocol/api_v1/mod.rs) or
  [daemon guide](../../core/crates/base/src/protocol/guide.md) and
  [Keeper guide](../../core/crates/base/src/protocol/keeper-guide.md), then regenerate together.
  Check normal calls, permissions, errors and replay as well as JSON shapes. A generation match
  verifies parity. Real old/new calls verify interoperability within the published support window.
- **Storage.** Reopen an isolated store written by a supported prior build. Check machine and agent
  IDs, saved launches and routes, sessions, message receipts, and the editor's separate workspace
  membership and Pin files. Keep old inputs independent of the proposed migration. For a format
  change, define the unsupported-version behavior before writes, the atomic migration commit,
  and any supported rollback and restore path.
- **Custody.** For a daemon takeover, verify the same keeper and CLI, restored Attach and a single
  replayed receipt. For a keeper replacement, verify the same daemon and CLI and the original
  watch. Use the [native Keeper replacement scenario](../../core/tests/tests/keeper.rs#L422) and
  [takeover scenarios](../../core/tests/tests/upgrade.rs#L1826).

The daemon and Keeper use separate formal v1 offers. A hello that omits `api_versions`, including an
older range-form hello, is invalid. A valid offer with no common version gets `protocol_incompatible`.
The [refusal scenario](../../core/tests/tests/protocol.rs#L146) checks that an old hello leaves the
keeper and live CLI alone. The [disjoint takeover scenario](../../core/tests/tests/upgrade.rs#L1757)
checks that refusal leaves the installed build and services alone. When there is no compatible live
path, follow the [planned restart](FEATURES.md#restarts-and-diagnostics) and keep the homes and workspace
state. The [editor check](../extension/engineering/VERIFICATION.md#52-verify-upgrade-and-compatibility-against-the-previous-build)
exercises a saved workspace across that boundary.

Run the wire checks from `core/`.

```sh
cargo test --locked -p facade-base --test protocol_files --test guide_examples
```

The files and examples must match the registries, and the two generated TypeScript copies must
match byte for byte. Set `FACADE_REGENERATE=1` for the `protocol_files` test only to regenerate
approved changes. Then rerun both tests with it unset and compare the changes to the published contract.

The real-build scenarios below are opt-in. Run in an isolated home from `core/` with the named
absolute artifact path and
`cargo test --locked -p facade-scenarios --test <target> <case> -- --ignored --exact`.
Use the artifacts from the accepted QA handoff, including their native companions. Record their
source revisions, SHA-256 hashes and the version negotiated by each endpoint in the review evidence.
The normal workspace suite skips these cases.

| Case | Artifact input | Expected result |
| --- | --- | --- |
| [`machines` · `cold_cutover_keeps_prerelease_agent_records_and_saved_transport`](../../core/tests/tests/machines.rs#L265) | `FACADE_TEST_API_V1_PRERELEASE` is the accepted pre-v1 `facade[.exe]` with the range-form daemon hello. See the [native runner](../CI.md#native-core-cold-cutover). | Keep the machine IDs, Agent reference, finished record, session, saved SSH transport and delivery receipt through a cold open. Replay the same request without delivering it again. |
| [`machines` · `a_legacy_workspace_import_recovers_both_machines_before_cold_cutover`](../../core/tests/tests/machines.rs#L2106) | Same prerelease program selecting range protocol 3, plus the [pinned v2 fixture](../../core/tests/src/binaries.rs#L83). Use `FACADE_TEST_V2_BIN` for a prepared directory containing `facade[.exe]` and its matching `.test-build` marker. | Import both members before the switch and retain the expected records afterward. |
| [`upgrade` · `a_higher_v1_build_keeps_the_process_session_and_receipt_through_takeover`](../../core/tests/tests/upgrade.rs#L1826) | `FACADE_TEST_API_V1_NEXT` from a separate compatible build with a higher numeric version | Replace the daemon while the Keeper, CLI, session and one delivery survive. |

### Docs and working files

- The docs change with the code. An island owner whose design or interface changes updates its part of
  `docs/core/islands/<crate>.md`, and the crate's owner commits the doc with the crate's commit. The General TL keeps
  [ARCHITECTURE](ARCHITECTURE.md) and [FEATURES](FEATURES.md) current, and the bar raiser maintains the
  [glossary](GLOSSARY.md). Changes to [core/README](../../core/README.md) require prior owner approval under the
  [repository rules](../../AGENTS.md#readme-approval).
- The working files, such as the spec, the freezes, the reviews and the progress files, live in a folder of the root
  worktree that is never committed: `docs/plans/<feature>/`. Once the feature's commits are on the root branch, the
  General TL packs the folder into an archive outside the repository, checks that the archive opens, and deletes the
  folder.

### Builds and disk

- With many islands building at once, build with `CARGO_INCREMENTAL=0` and `CARGO_BUILD_JOBS=2`.
- Check the free disk space before a long build. An island's worktree with its build takes hundreds of megabytes to
  gigabytes: the 36 worktrees of core's rewrite into islands took about 26 GB. Delete each worktree once its island is
  integrated and its agent has ended.

### Tests

- While code is being written, nobody writes new tests or optimizes in advance.
- Unit tests change with the code. Normal-path and security tests must pass.
- Keep boundary cases for behavior the interface still promises. When the implementation changes, move affected cases to
  the protocol or public entry point that exposes the behavior. Delete a boundary case only when the interface drops the
  behavior it covers.
- Scenario tests use only the protocol and the programs.
- Every test run uses an empty `TMPDIR` of its own, and every Facade home a test makes is inside it. No test writes to
  the person's home folder: `core/scripts/test-all.sh` runs the tests with `HOME` in its temporary folder, and reports
  anything written there.
- A test that fails is run again alone before anyone draws a conclusion.

### Safety

- Tests and trials run in isolated Facade homes. Nobody touches the owner's `~/.facade`, editor windows or agents.
- Real CLIs run only in isolated state, and only the owner tries them; tests use the fake CLI. No real Qwen probes.
- Nobody kills processes by name. End only the processes your run started: those with your own Facade home, as
  `core/scripts/leftovers.sh` finds them.
- Write every `rm -rf` with guarded variables: `rm -rf "${W:?}/${S:?}"`.
- No `git stash`: every worktree shares its stack.
- An agent never deletes the worktree it runs in: Facade closes the agent with it. Its parent deletes it after the
  agent ends, once `git cherry` shows the branch's commits are on the parent's line.

### While the owner is away

- Decide small details yourself and write each decision in the status file's "For the owner" section.
- Wait for the owner on: product decisions, merging into `main`, pushing, releasing, deleting a remote branch, and
  deleting anything that cannot be recovered.
- Run `date` before writing a time. Never estimate one.

### When agents stop

Facade can restart, and an account can reach its limit. Agents keep no message that arrived while they were stopped.
Afterwards, the General TL lists the agents, reads each one's screen, and wakes each stopped agent with a message that
says its task again and points to the files that hold its progress. Every important handover is in a file as well as in
a message.

## Templates

- [Freeze document](templates/freeze.md): what a parent writes before its children start.
- [Briefs](templates/briefs.md): the first message for each role.
- [Status file](templates/status.md): what the owner reads.

## Scripts

Run them from `core/`, the `.ps1` ones from PowerShell on Windows. `check-each-commit.sh` runs on macOS or Linux,
where every commit must build.

| Script | What it does |
| --- | --- |
| `scripts/test-all.sh [<log>]` | Clears inherited Facade variables and runs the workspace suite with a temporary `HOME` and fallback `FACADE_HOME`. Scenarios set their own homes. Writes a summary and Cargo output, and fails on a test failure, a fallback write or a leftover process. |
| `scripts/leftovers.sh <TMPDIR> [<core folder>]` | Lists the processes a test run left behind: those working in its `TMPDIR` or naming a Facade home inside it, and those working in `core/` that outlived their parent |
| `scripts\test-all.ps1 [<log>]` | The same on Windows, its temporary folder in `.test-temp\` beside the checkout, outside every checkout so that no test's Git reaches the repository. It builds first with the person's own folders, as any build does, then runs the tests with `USERPROFILE`, `HOME`, `APPDATA` and `LOCALAPPDATA` in its temporary folder, and lists only the processes started after the tests began |
| `scripts\leftovers.ps1 <temporary folder> [<core folder>] [-Since <time>]` | The same on Windows: reads each process's working folder and environment, and ends nothing. With `-Since`, a UTC file time, it counts only processes started since then |
| `scripts/check-each-commit.sh <base> [<head>]` | Runs `cargo check --workspace --all-targets` for each commit after `<base>` and requires an unchanged `Cargo.lock`. Uses a temporary worktree. |
| `scripts/ssh-check.sh [<destination>]` | On Linux, over real ssh to this machine and with the test CLI: a login starts an agent and detaches, another login drops while attached, a new login finds both agents running with their screens and types into one, and once they stop, both services exit. Needs a key login without a prompt. Exits 1 when a step fails |

A pull request that changes `core/` runs the workflow `Core checks`: clippy and the tests on macOS, Linux and Windows,
each on arm64 and x64, with `test-all.sh`, or `test-all.ps1` on Windows; `cargo fmt --check`, `ssh-check.sh` and
`check-each-commit.sh` on Linux x64.

For documentation changes, follow each changed link and anchor from the published location and verify the stated
interface, effect order or command against its source. Run the
[extension specification audit](../extension/audit/REPORT.md#reproducible-checks) when changing the editor specification.
The audit checks structure and references in that specification. The Core workflow's path filters can skip changes
under `docs/core/`, so record the documentation review on the proposed revision.

Follow the [release workflow](../extension/engineering/ARCHITECTURE.md#43-packaging-and-version-support)
for prepare, mirror and owner-approved publish. Keep the candidate, native tests and release assets tied to
the same source tree.

The stress test is `facade-stress`; [core/README](../../core/README.md) says how to run it.
