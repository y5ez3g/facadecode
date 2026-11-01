# CLI integrations

Layer 4. This document specifies adapters and effective launch configuration. It distinguishes target contracts from
dated observations; an old probe is not current-platform certification.

| Group | Decides | Implementation evidence |
| --- | --- | --- |
| 1 Discovery and permissions | Programs, environment, permission mapping, model and effort | Pending |
| 2 Runtime adapters | Capability interface, input readers, Facade tool files and status | Pending |
| 3 Launch configuration | Literal arguments/environment, adapter internals and trust | Pending |
| 4 Inspection and design | Persistence and adapter ownership | Pending |
| 5 Evidence baseline | Previously measured/reported vendor behavior and fresh test requirements | Historical only |

## 1 Discovery and permissions

### 1.1 CLI catalog

**Built-ins and configured custom CLIs are discovered in the destination execution environment.**

| Display name | API ID | Executable | Setting segment |
| --- | --- | --- | --- |
| Claude Code | `claude` | `claude` | `claude` |
| Codex | `codex` | `codex` | `codex` |
| Antigravity | `agy` | `agy` | `antigravity` |
| Muse Code | `muse` | `muse` | `muse` |
| OpenCode | `opencode` | `opencode` | `opencode` |
| Pi | `pi` | `pi` | `pi` |

Use this order, then custom entries in configuration order. `.enabled:false` hides a built-in from new starts, never
stops its runs. Recompute on relevant settings/PATH changes, picker/discovery request, and immediately before launch.
Discovery inspects files/configuration without invoking a model, logging in, installing/updating a CLI, or modifying
settings.

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
launchers: start what a verified launcher runs, using an argument array - npm's shim for a package's Node script runs
that script with Node, its shim for a native program runs that program, and a CLI's own installer launcher runs what
its adapter verified (the `pi.cmd` Pi's own installer writes: its `pi-launcher.js` with Node); otherwise a dedicated, tested cmd.exe
quoting adapter passes every argument safely. Reject unsupported quoting/control characters before execution, never build an
unescaped shell string. cmd.exe starts in no UNC folder - a network share's, a WSL distribution's `\\wsl$` one - but in
the Windows directory, so a launch through it from such a folder is refused before execution. On Windows, which cannot
run a script itself, a `.js`, `.cjs` or `.mjs` program - the Node entry point those refusals advise - runs with the Node
on the launch's PATH; with none there it is refused. PATH discovery and effective launch must agree. Checks requiring a new worktree's actual cwd
follow the validation stages in 4.2.

### 1.3 Permissions and native CLI interaction

**Adapters map the run's YOLO value from RULES-4.3 to supported native permission controls.**

Non-YOLO enables the CLI sandbox when supported and retains normal approvals for the CLI's own commands and edits;
calls to Facade's own tools are pre-approved in both modes under 2.2. Report actual sandbox/approval
on/off/unavailable/unknown without inventing a capability. Facade's same-tree rules are separate normal MCP policy,
not an authentication boundary.

| CLI | YOLO on | YOLO off |
| --- | --- | --- |
| Claude Code | Permission bypass; its sandbox as its own settings have it | Its sandbox enabled where it has one (not on Windows); its own approvals |
| Codex | Approval and sandbox bypass | `--sandbox workspace-write`; its own approval policy |
| Antigravity | `--mode accept-edits --dangerously-skip-permissions` | Its own approvals; it has no sandbox |
| Muse Code | `--disable-approval --disable-sandbox` | Its own approvals and shell sandbox, on unless its configuration turns it off |
| OpenCode | `--auto` | Its own permission configuration; it has no sandbox |
| Pi | Nothing to bypass | Nothing to enable: it has no approvals and no sandbox |

Muse Code's `--yolo` is not used: it also withholds its question tool. A CLI with no native approvals or sandbox - Pi,
and OpenCode under its default permissions, which allow every tool - runs as it natively does with YOLO off; the README
says so, and Facade adds no approval mechanism of its own (D79). Maintained versioned adapters own the actual flags; no
historical spelling certifies a current CLI. Native login, approval, question tools, project servers and user settings
remain intact. Do not default-disable them or insert creator/reporting instructions. If the requested actual mode cannot be supplied, report that fact rather
than silently changing modes.

### 1.4 Model and effort

**The CLI owns model/effort defaults and saved session state; Facade passes only explicit current overrides.**

Startup discovery includes previously successful model/effort values for that CLI/environment plus any reliable native
catalog, labeled complete/partial/unknown with its source. Past success is a useful choice, not a promise of current
availability or an exhaustive allowlist. Do not invent model IDs or require not_applicable placeholder objects.
An explicit model or effort in a `start_agent` call is passed through the CLI's own option for this launch only. An
omitted field adds no override: the CLI's native default or saved session state applies. The call's explicit choice
takes precedence over the matching mapped option in `.launch.arguments`; remove that configured option and its value
before adding the explicit choice, preserving other literal arguments and unrelated configuration keys. Versioned adapters map these
choices to their CLI argument/configuration mechanism and report requested versus observed values separately. An
ignored override is not verified success. Do not track every in-CLI change to reconstruct session settings. Previously
observed choices remain discovery/display facts, not restore inputs. Claude Code, Antigravity and Pi take `--model` and
an effort option (Pi's `--thinking`); Codex its `model_reasoning_effort`; Muse Code `--model` and its `reasoning_effort`
for the run, as its own effort option would save it in the person's settings - not offered where it runs through cmd.exe,
on Windows, which cannot carry that JSON string. OpenCode's interface takes neither, so a start that asks it for one is
refused with why.

## 2 Runtime adapters

### 2.1 Required capability interface

**Each CLI adapter reports individual capabilities and allows interactive startup and messaging even when a version is untested.**

Interface: discover, planLaunch, observeProcess, observeActivity, inspectInput, submitInput, readScreen and
initialPrompt. Report version/platform/source and observation time.

Ordinary input evidence distinguishes a usable input box, a draft, a native interaction and unknown. Activity or
tracked keystrokes alone cannot prove the draft empty after paste/history navigation. Never send Enter as a probe.
Direct text/keys only require the terminal input backend, not an input reader.

Each built-in CLI has an input reader that recognizes its input box by layout - prompt row, frame, box or footer, a
placeholder drawn dim or known by its words, and the cursor position or the CLI's own drawn cursor - not by version
number. Every installed version is attempted. A screen
the reader does not recognize is unknown: nothing is typed, and the message fails at its deadline with `input_unknown`,
naming the CLI and the version Facade found. The version is recorded as a diagnostic, never as a gate. A CLI without an
input reader fails ordinary messages at once with `unsupported`. Readers are tested against recorded screens of real
CLI versions; a changed layout becomes a new recorded case, and a reader never guesses an empty input from a layout it
does not recognize (D89). `scripts/capture-inputs.mjs` records a built-in's input box for each case - empty, typed, and
pasted text, messages, Chinese and emoji, a hundred-line message, and Claude Code's lead - without submitting anything, and
checks each reader and its own-draft recognition against what it drew; it is run once a CLI updates, and the screens it
saves, each paste's text kept with its screen, become recorded cases (D112). In a terminal 24 rows high, as an editor's
panel may be, Antigravity and Pi scroll a draft taller than their input box, Antigravity marking it with `↑ 1 more lines`
first in the box and Pi in its upper rule, `─── ↑ 2 more ───`: their readers say how many rows are out of sight above and
below, apart from the draft, and a draft whose end in sight is the message's end, nothing being out of sight below, is the
message's own. Pi draws a paste of ten lines or fewer and more than 1,000 characters as `[paste #1 1284 chars]`, counting
a tab as four (D118). Codex 0.166.0 draws a status at the right
end of its hints row, `⚠ 1 warning · f2 to view`, alone there while a draft hides the hints, when `-c` overrides run it
outside its background server: Facade starts it with `--no-daemon`, and its reader takes that row either way.

Each reader also reports a draft as it is drawn, so that a delivery knows its own (RULES-1.6): its rows' text, or the
placeholder its CLI draws for a long paste - Claude Code's `[Pasted text #1 +N lines]` counting the lines after the
first, Antigravity's `[Pasted text #1 +N lines]` and Pi's `[paste #1 +N lines]` counting every line, Codex's and Muse
Code's `[Pasted Content N chars]`, OpenCode's `[Pasted ~N lines]` from three lines on. That text is compared, never
logged. A message's lead, where its CLI takes one (COLLABORATION-2.1), is typed ahead of the paste in the same write, and
the draft is the message's own with it, or without it where an older ptyd typed none (D108). Use complete paste plus Enter
for ordinary messages: Enter only once the input holds the message's own draft and
the CLI has had the time a paste of that size takes - its bytes at 4 KB a millisecond, ConPTY's 64 bytes on Windows, and
45 ms a line more for Antigravity, which takes seconds to expand a long paste, as Orca measured (D105) - and delivery
confirmed once the input box is empty again. State actual full/partial/unknown effects. A later attempt never types the
text again; it presses Enter only over the message's own draft (RULES-1.6). Do not require a reconciliation API.
An unknown version still starts its terminal, and its activity can still be verified per run under 2.3. Unproved
activity shows red with an error once the run's startup is over (2.3). Every CLI advertised as fully supported must actually demonstrate the required
capabilities on its stated platform.

### 2.2 MCP files and cleanup

**Use per-run launch files first; write project files only where the CLI requires them and preserve user content.**

Each built-in receives the `facade` server, the skill and an approval of Facade's own tools as its CLI takes them (D100):

| CLI | Server | Skill | Facade's tools without asking |
| --- | --- | --- | --- |
| Claude Code | Per-run `--mcp-config` file | Per-run `--plugin-dir` plugin | `--allowedTools mcp__facade` |
| Codex | Per-run `-c mcp_servers.facade.*` overrides | Project `.agents/skills/facade/SKILL.md` | `default_tools_approval_mode="approve"` |
| Antigravity | Project plugin `.agents/plugins/facade`, shared | In that plugin | `mcp(facade_facade/*)` added to the person's own rules in its session `--settings` |
| Muse Code | Per-run `-c mcpServers.facade`; on Windows a `facade` entry merged into the project's `.mcp.json`, shared | Project `.agents/skills/facade/SKILL.md` | Its own approvals: it has no rule for one server's tools |
| OpenCode | Per-run `OPENCODE_CONFIG_CONTENT`, on the person's own, with `--standalone` | Per-run file as `instructions` | `facade_*` allowed, after the person's own rules |
| Pi | Per-run extension, `-e`, that registers it with its tools given directly | Per-run `--skill` folder | It has no approvals |

These approvals cover Facade's own tools alone, in either YOLO mode; the CLI's own commands and edits keep the mode
RULES-4.3 chose (D90). An entry shared by a folder's runs holds no run's identity: the run's variables reach the server
through the CLI's environment. Muse Code's own entry names its variables only by references to that environment; its
arguments pass through cmd.exe on Windows, which cannot carry a server's JSON, so there its entry is a project file, its
references `${NAME:-}`, empty in a session the person starts there by hand, whose server then offers no tools - an unset
plain reference would turn off every server of theirs. Claude Code's run settings disable a project's `facade` entry,
which would otherwise ask about it at its start. Antigravity's `--settings` replaces a settings key whole for its session,
so the person's own permission rules are read and kept in it. OpenCode's background service, which the person's sessions
share, would not read a run's own configuration, so a run with the tools has its own server process; the person's own
inline configuration is read as OpenCode reads it, and one that cannot be read stays as it is, the run without the tools. Antigravity starts a folder's plugin servers only
with its first turn, which is planned before they connect, or with its MCP panel: a run's start opens and closes that
panel before the first turn (COLLABORATION-2.2), and the server marks its tools for Antigravity to give the model
directly. The server is never declared required, so a CLI whose Facade server fails still starts and stays usable: Muse
Code requires a server unless its entry says `"mode": "optional"`, and fails a whole run over a required one that does not
start, so its entry says so (D107). Codex
waits up to 10 s for its optional servers before its first model request, so a server that starts slowly still serves the
first turn (D101). The server runs over stdio with per-run identity. Its skill contains MCP mechanics only, consistent with MCP-6. When
orchestration is off, inject no Facade server, skill or approval into that new process.

Before a project write, snapshot exact original bytes/existence, lock the path across runs, merge only owned content,
and record content hashes/reference counts. An existing different `facade` server/skill is a conflict; fail integration
while preserving the CLI where it can launch safely. Never overwrite malformed user config or unknown values. On cleanup
remove only unchanged Facade-owned content after the last run that uses it releases it; modified files remain with a
diagnostic. Never hide arbitrary files by modifying global Git ignore. Do not copy vendor credentials into project
files. Per-run files reside in the execution environment's Facade data directory; no identity token or protected-file
authentication mechanism is introduced.

### 2.3 Status, title and input evidence

**Only root-process reports and tested adapter evidence change displayed activity or input availability.**

Support the existing OSC 7501 adapter where verified: `working` → working; `idle|done|blocked` → not_working; `error` →
known error; `clear`, reset or pending probe → unknown. Activity reporting is verified for a run when that run's CLI
answers the OSC 7501 capability probe or sends valid reports, independent of CLI version; CLI-specific quirks remain
version-scoped evidence. OpenCode reports from its 2.x line; OpenCode 1.x sends no reports, so its runs show unavailable
activity (D78). Ignore worker reports carrying a distinct worker ID. Respond to capability probes only for
protocols implemented by the PTY adapter. A run is still starting, green with its startup stage, until its CLI first
shows its activity - a valid report or, where its screen is read, a state its reader knows - for at most 20 s from its
process start, a reloaded window counting from that start too (D81). Past that bound, a missing reliable activity
report - none at all, or a probe answered and no report since - is a red status error with its reason in the second
line, not a neutral dot; a report the CLI clears is one at once. It never implies an empty input. No “screen quiet for two seconds means done” fallback. A supported terminal
animation may establish working, but its absence supplies no idle proof.

Muse Code sends no reports on Windows, so its adapter names a screen reader that ptyd applies to a run whose CLI has
neither asked nor reported (D80): working while Muse Code's own working row - a mark, then `… esc to interrupt)` - shows
above its input frame; not working, ready for input, while its input frame - a rule, labeled where it offers voice
input, its `❯` prompt row and the plain rule under it - shows without that row, empty or holding a draft; blocked on
sign-in at its sign-in choice and on permission at its workspace trust question, each shown in place of that frame. A
screen it reads as none of these, or one still being drawn, leaves the status as it was. Its own reports always take precedence: once the CLI asks or reports, the screen is no longer read.
Evidence becomes stale after route loss/reset;
title/status from a new run does not update a previous one. A status episode starts on state/kind/reason change;
progress-only updates keep its start time.

Accept bounded valid UTF-8/base64 messages up to 2,048 decoded bytes, reject controls and malformed reports; sanitize
invisible formatting, trim and cap displayed title/status at 300 Unicode code points with ellipsis. Prefer a report's
title over OSC 0/2, except the placeholder an adapter knows its CLI reports before it has a title - OpenCode's own
`New session - {ISO time}`, which its terminal title never shows - which gives way to OSC 0/2. Strip only adapter-known status decorations and exact generic CLI/folder/name titles, not arbitrary
user punctuation. Never rewrite useful original CLI text. Terminal emoji width follows tested Unicode cell tables;
wide-character/wrapped-line reading and bracketed paste modes are verified per terminal backend.

## 3 Launch configuration

### 3.1 Launch arguments and environment

**Expose executable paths, literal arguments and environment values; keep vendor integration inside adapters.**

Built-in `.path` follows 1.2; `.launch` defaults to `{}` and accepts only:

| Field | Shape / default |
| --- | --- |
| arguments | `string[]`, default `[]`; additional literal CLI options in supplied order |
| environment | Map of string/null values, default `{}`; use 1.2's single environment rule |

Arrays are replaced as a whole, not merged by named groups. There is no public argument-group/template engine,
deep-merged native settings object, generic trust-file merge, unattended overlay, taskDelay or enterDelay setting.
Custom start/Resume argument templates are the limited exception defined in 3.4. Invalid or retired fields report their
setting path; do not silently translate ambiguous old configuration. Preserve the user's values so they can correct
them. An argument that repeats an option the adapter sets itself - its run settings or its YOLO mapping in either mode -
is a configuration error naming its place in `arguments`: the CLI would take the person's value in place of Facade's
(RULES-4.3). A problem names a received value by its JSON type, never the value, which may be a secret. Running
processes keep their actual plan.

### 3.2 Adapter-owned invocation

**Versioned adapters construct literal invocations and own vendor-specific flags, files and timing.**

The adapter combines the selected start command, configured literal arguments and necessary run options according to the
vendor's CLI grammar. Configured arguments stay in the vendor's options position before any positional prompt or
end-of-options marker. Adapter-owned MCP injection and YOLO mapping are applied explicitly; do not expose their internal
groups, routing variables or JSON/TOML serialization as user templates. Use proper serializers for required per-run
files and argument arrays for process launch; JSON quoting is not shell escaping. The adapter resolves model/effort
choices under 1.4 using its vendor-specific invocation; no general argument-conflict framework is required. Input
delays are internal adapter details only where required by its protocol.

Each adapter declares its maintained native interactive prompt-argument mapping, if it has one; COLLABORATION-2.2 owns
native/post-start prompt selection and its deadline start. Claude Code, Codex, Muse Code and Pi take the prompt as a
positional argument after the end of options - Pi's unless it starts with `@`, which it reads as a file to attach, and Muse
Code's unless it is one lowercase word, which it reads as one of its commands even there and refuses to start (D107) - and
OpenCode as the value of `--prompt` unless it starts with `-`; this mapping is used while unverified and reports that
state (Dots D49). Antigravity's first task goes after what its start types before the first turn (COLLABORATION-2.2),
as its first message. Do not wait for MCP or activity idle beyond that, send a confirmed prompt twice or synthesize a
prompt to make MCP appear connected.

A CLI whose startup update prompt would hold back the first task it is given starts without that prompt in Facade's
launches: Codex with `-c check_for_update_on_startup=false` (D101). The other built-ins update in the background or only
note a new version, and keep that behavior.

### 3.3 Native configuration and trust

**Users configure native CLI settings and trust through the CLI; Facade writes only necessary integration configuration.**

Use native configuration files, commands or explicit literal launch options for vendor preferences. Facade does not
provide a generic engine to edit arbitrary settings files or mirror their schemas. Facade trusts the folder an agent
starts in, as the person would by accepting the CLI's own trust question (D62): where the CLI takes trust for one launch,
in that launch (Codex `-c projects` with `trust_level = "trusted"` for the folder; Muse Code `--trust-workspace`; Pi
`--approve`); where it keeps trust in its own file, by merging only that entry as the CLI itself writes it, under the
CLI's lock and preserving the rest of the file (Claude Code `hasTrustDialogAccepted` for the repository's main checkout
in its global configuration; Antigravity `trustedWorkspaces` with the folder, spelled as Antigravity names its
working directory, in `~/.gemini/antigravity-cli/settings.json`). OpenCode asks no trust question and is given none.
A file that cannot be read, or that does not exist, is left as it is and the CLI asks in its terminal. Claude Code's trust
covers every folder below a trusted one, so it is never written for the home folder, a folder above it or a filesystem
root; that CLI asks in its terminal there too (D103). Native login and permission interactions remain in the terminal.

Keep administrator settings and user deny policies effective according to verified native precedence. If effective
native settings are unknown, report that fact instead of claiming trust or sandbox evidence. Test isolation remains
ARCHITECTURE-5's separate concern.

### 3.4 Custom CLIs

**A custom CLI definition requires an explicit exact-session Resume command before it can be used.**

Under `facade.custom`, map a unique custom CLI key to `{path, launch}`. Do not shadow built-in IDs;
CLI registry keys are distinct from agent display names. A key names its CLI wherever CLIs are listed, so it has a
visible character and no control character; a key that cannot be an ID is a configuration error that defines no CLI.
`path` is a required nonempty string resolved under 1.2. Custom `launch` accepts:

| Field | Shape / meaning |
| --- | --- |
| start | `string[]`, default `[]`; arguments for a new interactive conversation |
| resume | Required nonempty `string[]`; exact-session arguments containing `${sessionId}` |
| environment | Map of string/null values, default `{}`; follows 1.2 |

Both commands use `path` as the executable in the selected working location; Resume uses the conversation's original
cwd and replaces the start arguments.
Substitute the exact session ID once as literal argument data; `${sessionId}` is the only custom argument placeholder.
Do not invoke a shell or expand integration/configuration variables. A wrapper executable can handle a CLI with a
different command structure. For example, `{"path":"my-cli","launch":{"start":[],"resume":["resume","${sessionId}"]}}`.
Missing/empty Resume or a command without the exact-session placeholder is a configuration error, not an accepted
interactive-only definition. No YOLO mapping and no implicit model, effort, prompt or resume flags are invented:
`facade.yolo` leaves a custom launch as configured, and Show Agent Launch says so, reporting its sandbox and approvals
as unknown to Facade and that Facade gives it no trust (3.3).

Capabilities such as activity reporting are what the shipped adapter proves under 2.1 and 2.3, not configured by the
user. There is no `capabilities` field in a custom definition. An interactive CLI without runtime capability proofs
can still start and accept direct terminal control after its definition passes validation; unproved capabilities
remain unavailable. A Resume command is necessary but does not prove session discovery/identity or successful
restoration; the definition requirement never becomes a claim that an untested integration works.

## 4 Inspection and design

### 4.1 Show Agent Launch

**Show Agent Launch displays the current effective configuration and actual known choices without running a CLI.**

Show executable/environment source, cwd, literal argument order, resulting YOLO, native sandbox/approval facts, how
the folder is trusted and configuration errors. Use one launch configuration and RULES-4.3's YOLO source. A chosen
inspection location is not an API launch default. Redact account secrets and sensitive environment values; do not
invent invalid-plan defaults. Where CLIS-3.3 withholds trust for a broad folder, say no trust is given instead of
claiming an entry will be written. The document does not certify observed behavior of a process never started.

Its location is the one a `{ location_id }` names, the window's only one, or the person's choice in native steps by
folder that offer locations alone (D84): in a window of several folders, the folders, as Change Working Location lists
them (LIFECYCLE-1.3) - one with a single location choosing it, one with more opening its own step of them; in a window
of one folder, its locations. Locations come main checkout first (WORKTREES-1.2), and no separator divides them.

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
launch path. Journal effective arguments/environment hashes, safe metadata, owned-file hashes and permission source;
never the credential body. Invalidate capability evidence when executable/version/platform/parser changes.

## 5 Evidence baseline

### 5.1 Dated observations are not release evidence

**The source observations are retained as test leads with their original limits.**

| Integration | Source observation, 2026-10-26/27 | What remains unverified for this contract |
| --- | --- | --- |
| Claude 2.1.310/311 | OSC status probe, idle/working/done, title; trust prompt may provide no report | Native platform matrix; partial-write reconciliation; the input box's layout, recorded with 2.1.312 on macOS (Dots D56), is still to be recorded for current versions such as 2.1.314 |
| Codex 0.164.0 | OSC reports without probe, startup status blips, title; paste can change idle/done | Cross-environment delivery; the input box's layout, recorded with 0.165.0 on macOS (Dots D56), is still to be recorded for current versions such as 0.166.0 |
| Windows/Linux/native remote | Old source explicitly lacked native validation | Full platform and SSH/WSL/container matrix |

| Integration | Observation, 2026-10-30, Windows x64, Linux x64 and macOS arm64 | What remains unverified for this contract |
| --- | --- | --- |
| Muse Code 1.4.12, 1.4.14 | Linux, 1.4.12 as Facade plans it, not prompted: answered probe, `idle`, its folder for a title. macOS, 1.4.14 as Facade plans it, signed out: answered probe, `blocked` on `auth`. Windows, 1.4.12 and 1.4.14 - started from the panel, as Facade plans it and as its own program alike, with or without `TERM`: no OSC 7501 probe or report in 25-60 s, signed in or out; read from its screen instead, a run from the panel showed
not working, ready for input, signed in, and blocked on sign-in signed out. Its help: `--trust-workspace` (this run), `--disable-approval`, `--disable-sandbox` and `--yolo`; Facade Dots observed reports from 1.4.13 on macOS | A turn, not run: the owner's account had no usage left, so its working row is read from macOS fixtures alone, each a short `Thinking` row - one too long for its terminal it would read as not working; its approval prompts with YOLO off, which its screen reader does not know; why it does not report on Windows; a signed-in run on macOS |
| Antigravity | Windows, as Facade plans it and from the panel, signed in: asked the OSC 7501 probe and reported `blocked` (`auth`, then `permission` at its trust question) where its folder was untrusted; with Facade's `trustedWorkspaces` entry no trust question, `idle`; one turn `working`, `done`, `idle`; two Ctrl+C exit 0; no OSC 0/2 title. `ANTIGRAVITY_GEMINI_DIR` did not move its settings. Linux and macOS, as Facade plans it: with Facade's entry `idle`, no trust question, two Ctrl+C exit 0 | Its own version string |
| OpenCode 2.2.4 | Windows, run as Facade plans it - npm's shim started as its program - in isolated XDG folders with `--standalone`, not signed in: answered probe, `idle`, title `OpenCode`, Ctrl+C exit 0; from the panel, isolated, `idle`. macOS, 2.1.4 as Facade plans it, isolated with `--standalone`: answered probe, `idle`, title `OpenCode`, Ctrl+C exit 0; one signed-in turn, its own configuration read with its data and state isolated, `qwen3.8-flash` at low effort: `working`, its record titled `New session - {ISO time}` until it names the session, `idle` without a title; its session's record (with an `id`) `working` and cleared; its terminal then titled `OC \| Reply OK only`. Read from its source: reports of its own record and each session's (with an `id`), `OC \| {session title}`, no trust question; 1.19.5 sends no reports | A signed-in turn on Windows, not run: its background service was in the owner's use; its shared background server; Linux |
| Pi 1.4.0 | Windows, run as Facade plans it - its installer's `pi.cmd` started as `pi-launcher.js` with Node, `--approve` - in an isolated `PI_CODING_AGENT_DIR`, not signed in: answered probe, `idle` 13 ms later, title `π - {folder}`, two Ctrl+C `clear` and exit 0; from the panel, isolated, `idle`. macOS, as Facade plans it, isolated: the same; one signed-in turn, `qwen3.8-flash` with thinking off and no session kept: `working`, then `done` 1.4 s later, its reply shown; two Ctrl+C `clear` and exit 0. Read from its source: no approvals or sandbox; an unknown long option is passed to extensions, not refused | A signed-in turn on Windows; Linux |

### 5.2 Current external facts used by the handoff

**Vendor mappings and external documentation are evidence inputs, not substitutes for actual integration checks.**

Keep dated observations labeled historical. Verify concrete installed versions, stores, flags and supported APIs
before making a release-support claim. Task-specific implementer model choices and account state follow current task instructions,
not this product contract. This revision makes no fresh claim about a vendor's latest behavior.

## Checks

| Rules | Acceptance |
| --- | --- |
| 1.1–1.4 | Each built-in's destination discovery, unknown-version launch, matching profile/PATH/env/quoting, Windows launcher recognition, native permission mapping, explicit per-call model/effort and native defaults |
| 2.1–2.3 | Adapter evidence, layout-based input readers on recorded screens of several versions, unrecognized layouts untouched, direct versus ordinary input, pre-approved Facade tools, optional server, owned-file cleanup, startup until the first activity or its bound - a reload too - then red unknown, title sanitizing for each built-in's titles, Muse Code's screen reader on its fixtures and its reports' precedence |
| 3.1–3.4 | `.enabled` affects new starts only, custom CLIs require Resume without capability declarations, minimal argument/env schema, no generic file merge, native prompt mapping, adapter-owned evidence, each built-in's trust: per-launch arguments, Claude Code's and Antigravity's entries merged and preserved user configuration |
| 4.1–4.2 | Show Agent Launch describes and redacts the configured launch; staged cwd validation; version invalidation |
| 5.1–5.2 | Fresh versioned fixtures plus isolated real CLI probes, no claims inferred from historical tables |

See [Verification](VERIFICATION.md). Never probe a real CLI in the owner's state directory; never run Qwen probes.

## Change log

- 2026-10-31: 2.1 reads Antigravity's and Pi's scrolled drafts and Pi's `[paste #N C chars]` (D118).
- 2026-10-31: 2.1 records input boxes with `scripts/capture-inputs.mjs`, and reads Codex 0.166.0's status at the end of its
  hints row; Codex always runs embedded (D112).
- 2026-10-31: 2.2 makes Muse Code's Facade server optional, and 3.2 gives it a one-word first task after startup (D107).
- 2026-10-31: 2.1's readers report a draft's text or its CLI's paste placeholder, so that a delivery knows its own;
  Enter waits for a paste of its size and is pressed again only over that draft (D104, D105).
- 2026-10-31: 2.2 has Codex wait for its optional MCP servers before its first turn and 3.2 starts it without its
  update prompt (D101); 3.3 writes no trust for a home folder, a folder above it or a root, nor into a missing file (D103).
- 2026-10-31: Antigravity, Muse Code, OpenCode and Pi are given the Facade tools (D97, D100): 1.4 says each built-in's
  model and effort options, 2.1 their input readers - a box, a placeholder known by its words, a CLI's own drawn cursor -
  and 2.2 how each receives the server, the skill and the approval of Facade's own tools.
- 2026-10-30: Step 2 of the Facade Code extension: 1.3 and 2.2 pre-approve Facade's own tools in both YOLO modes and
  never require the server (D90); 1.4 carries model/effort for `start_agent` (D97); 2.1 adds input readers that recognize
  the input box by layout and attempt every version instead of Facade Dots' version list (D89); 2.2 and 3.2 add the
  Claude Code and Codex Facade files and the native prompt mapping; 5.1 records which layouts still need recording.
- 2026-10-31: 1.2 refuses a launch through cmd.exe from a UNC folder, where cmd.exe ran the CLI in the Windows directory
  with the run's permissions - Muse Code's launcher always goes through it - and runs a Node entry point with Node on
  Windows, where the program the refusals advise failed to start. Both found by the night verification.
- 2026-10-31: 4.1 chooses its location in native steps by folder, as Change Working Location does (D84).

- 2026-10-31: 1.1 lists configured custom CLIs after the built-ins; 3.1 names 3.4's templates as its exception; 3.4
  Custom CLIs, carried from the Facade Dots specification under `facade.custom`, with the capabilities of later steps
  left out; a key needs a visible character and no control character.

- 2026-10-30: 1.1 adds `.enabled`, 3.1 the `.launch` arguments and environment, and 4.1 Show Agent Launch, carried
  from the Facade Dots specification without the parts of later steps (model and effort, MCP, sessions and input). 3.1
  refuses an argument repeating an option the adapter sets, and names a received value by its type alone.

- 2026-10-30: At the owner's request, Antigravity, Muse Code, OpenCode and Pi join the built-in catalog at the level of
  Claude Code and Codex (D77): 1.1's catalog, 1.2's Windows launchers - recognized only as their installers write them, and
  refused through cmd.exe where the launcher's own path holds what cmd.exe reads as its own - 1.3's permission mappings, 2.3's OpenCode line
  (D78), 3.3's trust for each built-in, 5.1's dated observations and the checks. A CLI that natively asks for nothing
  runs as it does with YOLO off (D79). 5.1 records that Muse Code sends no reports on Windows, where 2.3 reads its
  activity from its own screen instead (D80). 2.1 and 2.3 keep a run starting until its CLI first shows its activity,
  for at most 20 s (D81); 2.3 reads OpenCode's placeholder title in its reports as none.

- 2026-10-30: 1.1 and 3.1 mark `.enabled` and `.launch` as later steps; step 1 has `.path` alone.

- 2026-10-30: Added Codex to the built-in catalog following the owner's earlier explicit instruction to include it
  in step 1. This corrects a stale specification entry; real vendor/platform capability evidence remains required.

- 2026-10-29: Step 1 of the Facade Code extension, carried from the Facade Dots specification: the rules step 1
  needs, each with its final number. Later steps add the others.
  Claude Code only; `FACADE_AGENT` carries the run's `#aN` alias.
