# CLI integrations

Layer 4. This document specifies adapters and effective launch configuration. It distinguishes target contracts from
dated observations; an old probe is not current-platform certification.

| Group | Decides | Implementation evidence |
| --- | --- | --- |
| 1 Discovery and permissions | Programs, environment and permission mapping | Pending |
| 2 Runtime adapters | Capability interface and status | Pending |
| 3 Launch configuration | Literal arguments/environment, adapter internals and trust | Pending |
| 4 Inspection and design | Persistence and adapter ownership | Pending |
| 5 Evidence baseline | Previously measured/reported vendor behavior and fresh test requirements | Historical only |

## 1 Discovery and permissions

### 1.1 CLI catalog

**Built-ins are discovered in the destination execution environment.**

| Display name | API ID | Executable | Setting segment |
| --- | --- | --- | --- |
| Claude Code | `claude` | `claude` | `claude` |
| Codex | `codex` | `codex` | `codex` |

Use this order. Step 1 offers every installed built-in; `.enabled` joins with its later step. Recompute on relevant
settings/PATH changes, picker/discovery request, and immediately before launch. Discovery inspects files/configuration
without invoking a model, logging in, installing/updating a CLI, or modifying settings.

### 1.2 Executable and environment

**The program is resolved using the same destination-folder environment used for its eventual terminal launch.**

Use this environment order for both discovery and launch: execution extension host environment; resource-scoped
`terminal.integrated.env.<platform>`; the explicitly configured `env` map of the selected default terminal profile; the
CLI's configured launch environment; necessary run identity variables. Resolve the profile through
`terminal.integrated.defaultProfile.<platform>` and its entry in `terminal.integrated.profiles.<platform>` in the
destination environment. A profile without a configured env map adds nothing. Do not start a shell or parse its startup
scripts to discover extra variables; shell-only PATH changes are not part of Facade's computed environment.

In every configured environment map, a string sets the value, null removes the variable and an omitted key inherits
the preceding layer. `${env:NAME}` in environment values reads the host environment (missing becomes empty); Windows
keys compare case-insensitively. Remove `ELECTRON_RUN_AS_NODE` from agent CLIs. Set `TERM_PROGRAM=vscode`,
`COLORTERM=truecolor`, `FACADE_AGENT` to the run's `#aN` alias. Never copy credentials from the client to a remote environment.

Empty `.path` means command on PATH. A simple name is searched on that PATH; relative path is from launch cwd; leading
`~` uses that environment's home; absolute path is exact. Whitespace-only is invalid, no silent fallback to another CLI.
Require executable file on POSIX, file plus PATHEXT resolution on Windows. Preserve quoted PATH entries. Windows `.cmd`
launchers: prefer a verified known Node entrypoint using an argument array; otherwise a dedicated, tested cmd.exe quoting
adapter passes every argument safely. Reject unsupported quoting/control characters before execution, never build an
unescaped shell string. PATH discovery and effective launch must agree. Checks requiring a new worktree's actual cwd
follow the validation stages in 4.2.

### 1.3 Permissions and native CLI interaction

**Adapters map the run's YOLO value from RULES-4.3 to supported native permission controls.**

Non-YOLO enables the CLI sandbox when supported and retains normal approvals. Report actual sandbox/approval
on/off/unavailable/unknown without inventing a capability.

Historical mappings to reverify include Claude permission bypass. Maintained versioned adapters own the actual flags; no
historical spelling certifies a current CLI. Native login, approval, question tools, project servers and user settings
remain intact. Do not default-disable them. If the requested actual mode cannot be supplied, report that fact rather
than silently changing modes.

## 2 Runtime adapters

### 2.1 Required capability interface

**Each CLI adapter reports individual capabilities and allows interactive startup even when a version is untested.**

Interface: discover, planLaunch, observeProcess and observeActivity.
Report version/platform/source and observation time.

An unknown version still starts its terminal, and its activity can still be verified per run under 2.3. Unproved
activity shows red with an error. Every CLI advertised as fully supported must actually demonstrate the required
capabilities on its stated platform.

### 2.3 Status and title evidence

**Only root-process reports and tested adapter evidence change displayed activity.**

Support the existing OSC 7501 adapter where verified: `working` → working; `idle|done|blocked` → not_working; `error` →
known error; `clear`, reset or pending probe → unknown. Activity reporting is verified for a run when that run's CLI
answers the OSC 7501 capability probe or sends valid reports, independent of CLI version; CLI-specific quirks remain
version-scoped evidence. Ignore worker reports carrying a distinct worker ID. Respond to capability probes only for
protocols implemented by the PTY adapter. A missing reliable activity report is a red status error with its reason in
the second line, not a neutral dot. No “screen quiet for two seconds means done” fallback. A supported terminal
animation may establish working, but its absence supplies no idle proof. Evidence becomes stale after route loss/reset;
title/status from a new run does not update a previous one. A status episode starts on state/kind/reason change;
progress-only updates keep its start time.

Accept bounded valid UTF-8/base64 messages up to 2,048 decoded bytes, reject controls and malformed reports; sanitize
invisible formatting, trim and cap displayed title/status at 300 Unicode code points with ellipsis. Prefer a report's
title over OSC 0/2. Strip only adapter-known status decorations and exact generic CLI/folder/name titles, not arbitrary
user punctuation. Never rewrite useful original CLI text. Terminal emoji width follows tested Unicode cell tables.

## 3 Launch configuration

### 3.1 Launch arguments and environment

**Expose executable paths, literal arguments and environment values; keep vendor integration inside adapters.**

Step 1 has `.path` alone; the `.launch` schema below joins with its later step, and until then a launch uses its
adapter's invocation and 1.2's environment.

Built-in `.path` follows 1.2; `.launch` defaults to `{}` and accepts only:

| Field | Shape / default |
| --- | --- |
| arguments | `string[]`, default `[]`; additional literal CLI options in supplied order |
| environment | Map of string/null values, default `{}`; use 1.2's single environment rule |

Arrays are replaced as a whole, not merged by named groups. There is no public argument-group/template engine,
deep-merged native settings object, generic trust-file merge, unattended overlay, taskDelay or enterDelay setting.
Invalid or retired fields report their setting path; do not silently translate ambiguous old configuration. Preserve the
user's values so they can correct them. Running processes keep their actual plan.

### 3.2 Adapter-owned invocation

**Versioned adapters construct literal invocations and own vendor-specific flags, files and timing.**

The adapter combines the selected start command, configured literal arguments and necessary run options according to the
vendor's CLI grammar. Configured arguments stay in the vendor's options position before any end-of-options marker.
Adapter-owned YOLO mapping is applied explicitly; do not expose its internal groups, routing variables or JSON/TOML
serialization as user templates. Use argument arrays for process launch; JSON quoting is not shell escaping.

### 3.3 Native configuration and trust

**Users configure native CLI settings and trust through the CLI; Facade writes only necessary integration configuration.**

Use native configuration files, commands or explicit literal launch options for vendor preferences. Facade does not
provide a generic engine to edit arbitrary settings files or mirror their schemas. Facade trusts the folder an agent
starts in, as the person would by accepting the CLI's own trust question (D62): where the CLI keeps trust in its own
file, by merging only that entry as the CLI itself writes it, under the CLI's lock and preserving the rest of the file
(Claude Code `hasTrustDialogAccepted` for the repository's main checkout in its global configuration). A file that
cannot be read is left untouched and the CLI asks in its terminal. Native login and permission interactions remain in
the terminal.

Keep administrator settings and user deny policies effective according to verified native precedence. If effective
native settings are unknown, report that fact instead of claiming trust or sandbox evidence. Test isolation remains
ARCHITECTURE-5's separate concern.

## 4 Inspection and design

### 4.2 Adapter ownership and files

**One versioned adapter definition generates detection and launch.**

Validate argument types, configuration shape and all already-resolvable prerequisites before side effects. CLI discovery
for a proposed worktree uses the selected existing source checkout. For the new worktree, resolve cwd-dependent paths
and check executable existence/permissions after native Git returns the actual created location, before CLI spawn. A
tracked `./tools/agent` need not exist at the future destination beforehand. No new setup wait is implied; WORKTREES-2.4
still applies. Final validation failure retains the accepted error pair and reports the actual created worktree under
LIFECYCLE-1.5; do not delete it or roll back files. Existing-location launches perform these same checks before spawn
without creation.

Maintain the existing CLI and PTY adapter modules; remove public trust/template machinery instead of keeping a second
launch path. Journal effective arguments/environment hashes, safe metadata and permission source; never the credential
body. Invalidate capability evidence when executable/version/platform/parser changes.

## 5 Evidence baseline

### 5.1 Dated observations are not release evidence

**The source observations are retained as test leads with their original limits.**

| Integration | Source observation, 2026-10-26/27 | What remains unverified for this contract |
| --- | --- | --- |
| Claude 2.1.310/311 | OSC status probe, idle/working/done, title; trust prompt may provide no report | Native platform matrix |
| Windows/Linux/native remote | Old source explicitly lacked native validation | Full platform and SSH/WSL/container matrix |

### 5.2 Current external facts used by the handoff

**Vendor mappings and external documentation are evidence inputs, not substitutes for actual integration checks.**

Keep dated observations labeled historical. Verify concrete installed versions, stores, flags and supported APIs
before making a release-support claim. Task-specific implementer model choices and account state follow current task instructions,
not this product contract. This revision makes no fresh claim about a vendor's latest behavior.

## Checks

| Rules | Acceptance |
| --- | --- |
| 1.1–1.3 | Claude Code and Codex destination discovery, unknown-version launch, matching profile/PATH/env/quoting, native permission mapping |
| 2.1, 2.3 | Adapter evidence, red unknown, title sanitizing |
| 3.1–3.3 | Minimal argument/env schema, no generic file merge, adapter-owned evidence, Claude Code's trust entry merged and preserved user configuration |
| 4.2 | Staged cwd validation; version invalidation |
| 5.1–5.2 | Fresh versioned fixtures plus isolated real CLI probes, no claims inferred from historical tables |

See [Verification](VERIFICATION.md). Never probe a real CLI in the owner's state directory; never run Qwen probes.

## Change log

- 2026-10-30: 1.1 and 3.1 mark `.enabled` and `.launch` as later steps; step 1 has `.path` alone.

- 2026-10-30: Added Codex to the built-in catalog following the owner's earlier explicit instruction to include it
  in step 1. This corrects a stale specification entry; real vendor/platform capability evidence remains required.

- 2026-10-29: Step 1 of the Facade Code extension, carried from the Facade Dots specification: the rules step 1
  needs, each with its final number. Later steps add the others.
  Claude Code only; `FACADE_AGENT` carries the run's `#aN` alias.
