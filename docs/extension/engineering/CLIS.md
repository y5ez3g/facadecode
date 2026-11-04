# CLI integrations

Layer 4. This document specifies the CLI adapters and the effective launch configuration: how each CLI is found,
started, given the Facade tools, read, resumed and inspected. A recorded vendor observation is a test lead, never
current-platform certification (5.1).

| Group | Decides |
| --- | --- |
| 1 Discovery and permissions | Programs, environment, permission mapping, model and effort |
| 2 Runtime adapters | Capability interface, input readers, Facade tool files, status and conversations |
| 3 Launch configuration | Literal arguments/environment, adapter internals and trust |
| 4 Inspection and design | Launch inspection, persistence and adapter ownership |
| 5 Evidence baseline | What recorded vendor behavior proves and the evidence a support claim needs |

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

Use this order, then custom entries in configuration order. `.enabled:false` hides a built-in from new starts and never
stops its runs; a start that asks for it, start_agent's too, is refused, saying it is turned off by its
`facade.<cli>.enabled` setting. Recompute on relevant settings/PATH changes, picker/discovery request, and immediately
before launch. Discovery inspects files/configuration without invoking a model, logging in, installing/updating a CLI, or
modifying settings.

A line of a CLI Facade does not support, known by the version its installation names, is unavailable for new starts and
refused at a start, saying how to update. That line is OpenCode below version 2, as the `package.json` of npm's
`opencode-ai` or `@opencode/cli` beside its program names it: it sends no activity reports, does not take `--standalone`
and draws an input box no reader knows, so no message reaches it. Its refusal says to run `npm uninstall -g opencode-ai`,
then `npm install -g @opencode/cli`. A version no installation file names is started; a 1.x program found so starts, and
with the Facade tools exits at `--standalone` with its usage.

### 1.2 Executable and environment

**The program is resolved using the same destination-folder environment used for its eventual terminal launch.**

Use this environment order for both discovery and launch: execution extension host environment; resource-scoped
`terminal.integrated.env.<platform>`; the explicitly configured `env` map of the selected default terminal profile; the
CLI's configured launch environment; the variables every run is given. Resolve the profile through
`terminal.integrated.defaultProfile.<platform>` and its entry in `terminal.integrated.profiles.<platform>` in the
destination environment. A profile without a configured env map adds nothing. Do not start a shell or parse its startup
scripts to discover extra variables; shell-only PATH changes are not part of Facade's computed environment.

In every configured environment map, a string sets the value, null removes the variable and an omitted key inherits
the preceding layer. `${env:NAME}` in environment values reads the host environment (missing becomes empty); Windows
keys compare case-insensitively. The execution extension host environment is taken as VS Code's integrated terminal
inherits it: without what its `sanitizeProcessEnvironment` removes - `ELECTRON_*`; `VSCODE_*` except `VSCODE_PORTABLE`,
`VSCODE_SHELL_LOGIN`, `VSCODE_ENV_REPLACE`/`_APPEND`/`_PREPEND` and `VSCODE_IPC_HOOK_CLI`; `SNAP` and `SNAP_*`;
`GDK_PIXBUF_*` - with, on macOS, `NODE_OPTIONS` and `NODE_REPL_EXTERNAL_MODULE` restored from their `VSCODE_` copies;
and without inherited run markers, which would make a run act as another's: Facade's own run variables
(`FACADE_AGENT`, `FACADE_CODE_SESSION_FILE`, `FACADE_CODE_TITLE_COMMAND`, `FACADE_RUN`, `FACADE_PTYD`,
`FACADE_LAUNCH_CONTEXT`, `FACADE_ELECTRON_RUN_AS_NODE`) and a Claude Code session's (`CLAUDECODE`,
`CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_BRIDGE_SESSION_ID`, `CLAUDE_CODE_EXECPATH`,
`CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_JOB_DIR`). A configured layer may set any of them again. Over every layer, each run
is given no `ELECTRON_RUN_AS_NODE`, which would make an Electron-based CLI run as Node, and is given
`TERM_PROGRAM=vscode`, `COLORTERM=truecolor`, `FACADE_AGENT` set to its `#aN` alias, and the variables its Facade tools
and session tracking set (2.2, 2.4). Never copy credentials from the client to a remote environment. Claude Code is given
`CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL=1` where no layer sets that variable: in a VS Code terminal without its VS Code
extension, Claude Code installs that extension and shows a welcome that waits for Enter, past which no message goes.
Claude Code never runs with `CLAUDE_CODE_DISABLE_TERMINAL_TITLE`, whichever layer sets it: that switch also turns off
its OSC 7501 reports (2.3), so its run settings clear it as well for the copy its settings files carry.

Empty `.path` means command on PATH. A simple name is searched on that PATH; relative path is from launch cwd; leading
`~` uses that environment's home; absolute path is exact. Whitespace-only is invalid, no silent fallback to another CLI.
Require executable file on POSIX, file plus PATHEXT resolution on Windows. Preserve quoted PATH entries. A Windows
`.cmd` launcher, recognized only as its installer writes it, starts what it runs, using an argument array: npm's shim
for a package's Node script runs that script with Node, its shim for a native program runs that program, the `pi.cmd`
Pi's own installer writes runs its `pi-launcher.js` with the Node it chooses - its own in `LOCALAPPDATA` where it names
one and it is there - and Muse Code's installer launcher runs its active native program (2.4). Node is the `node.exe`
beside npm's shim, else a Node program (`.exe` or `.com`) on the launch's PATH, never a version manager's `.cmd` or
`.bat`. Any other `.cmd` or `.bat` runs through cmd.exe, which Facade gives no text it would read as its own: a launch
through cmd.exe is refused before execution where an argument or the program's own path holds `"`, `%`, `^`, `&`, `|`,
`<`, `>`, `!` or a line break, saying to set the CLI's `.path` to its own program or Node entry point; a configured
argument is named by its place in its setting and that character, never quoted. Where only the Facade tools' arguments
cannot pass, the CLI starts without the tools, which are unavailable with why (2.2). A launch never builds an unescaped
shell string. cmd.exe starts in no UNC folder - a network share's, a WSL distribution's `\\wsl$` one - but in the Windows
directory, so a launch through it from such a folder is refused before execution. On Windows, which cannot run a script
itself, a `.js`, `.cjs` or `.mjs` program - the Node entry point those refusals advise - runs with Node on the launch's
PATH; with none there it is refused. A Windows program is one a launch can start - `.exe`, `.com`, `.cmd`, `.bat` or such
a Node script; a PowerShell or Windows Script Host script, found on PATH or configured, is not available. PATH discovery
and effective launch must agree. Checks requiring a new worktree's actual cwd follow the validation stages in 4.2.

### 1.3 Permissions and native CLI interaction

**Adapters map the run's YOLO value from RULES-4.3 to supported native permission controls.**

Non-YOLO enables the CLI sandbox when supported and retains normal approvals for the CLI's own commands and edits.
Calls to Facade's own tools are approved in advance in both modes wherever the CLI can approve one server's tools (2.2);
Muse Code cannot, so with YOLO off its own approvals apply to them too (RULES-4.3). Report actual sandbox/approval
on/off/unavailable/unknown without inventing a capability. Facade's same-tree rules are separate normal MCP policy, not
an authentication boundary.

| CLI | YOLO on | YOLO off |
| --- | --- | --- |
| Claude Code | Permission bypass; its sandbox as its own settings have it | Its sandbox enabled where it has one (not on Windows); its own approvals |
| Codex | Approval and sandbox bypass | `--sandbox workspace-write`; its own approval policy |
| Antigravity | `--mode accept-edits --dangerously-skip-permissions` | Its own approvals; it has no sandbox |
| Muse Code | `--disable-approval --disable-sandbox` | Its own approvals and shell sandbox, on unless its configuration turns it off |
| OpenCode | `--auto` | Its own permission configuration; it has no sandbox |
| Pi | Nothing to bypass | Nothing to enable: it has no approvals and no sandbox |

Muse Code's `--yolo` is not used: it also withholds its question tool. A CLI with no native approvals or sandbox - Pi,
and OpenCode under its default permissions, which allow every tool - runs as it natively does with YOLO off; the
extension's README says so, and Facade adds no approval mechanism of its own. The maintained adapters own the actual
flags; a spelling recorded for one CLI version certifies no other. Native login, approval, question tools, the person's
project servers and user settings remain intact. Do not default-disable them or insert instructions to report to a
creator (MCP-6.2). If the requested actual mode cannot be supplied, report that fact rather than silently changing modes.

### 1.4 Model and effort

**The CLI owns model/effort defaults and saved session state; Facade passes only explicit current overrides.**

Current CLI availability and explicit override support are returned by list_agents for the actual destination.
Facade records requested model/effort and process-start outcomes as structured diagnostic events. Values requested
before are neither defaults nor an allowlist. Actual model selections, available models/efforts and model responses
remain in the native CLI's own controls/history; Facade maintains no model-choice catalog or success statistics.
An omitted value is unknown to Facade unless the native CLI separately reports it. Do not invent model IDs.
An explicit model or effort in a `start_agent` call is passed through the CLI's own option for this launch only. An
omitted field adds no override: the CLI's native default or saved session state applies. The call's explicit choice
takes precedence over the matching mapped option in `.launch.arguments`; remove that configured option and its value, in
any spelling the CLI takes - a short form such as `-m`, or a `-c`/`--config` override of the same key, with or without
`=` - before adding the explicit choice, preserving other literal arguments and unrelated configuration keys. The
adapters map these choices to their CLI argument/configuration mechanism; Facade reports the requested values alone, as
the effective ones are the CLI's own. An ignored override is not verified success. Do not track every in-CLI change to
reconstruct session settings. Claude Code and Antigravity take `--model` and `--effort`; Pi `--model` and `--thinking`;
Codex `--model` and its `model_reasoning_effort`; Muse Code `--model` and, as its own effort option would save the choice
in the person's settings, its `reasoning_effort` for the run, its per-model efforts cleared for that run as they would
win over it - the effort is not offered where Muse Code runs through cmd.exe, on Windows, which cannot carry that JSON
string. OpenCode's interface takes neither, nor does a custom CLI (3.4), so a start that asks one of them for either is
refused with why.

## 2 Runtime adapters

### 2.1 Required capability interface

**Each CLI adapter reports individual capabilities and allows interactive startup and messaging even when a version is untested.**

An adapter is one maintained definition per CLI (4.2): its command and settings, the argument groups and values of its
invocation (3.2), the explicit choices it takes (1.4), how it is given the Facade tools (2.2), its input reader, its
native initial prompt mapping, its trust (3.3), the launchers it verified (1.2), its sandbox and approval facts (1.3),
its session integration (2.4) and, for Muse Code, its screen reader (2.3). It states each capability as supported,
unverified or unavailable, with why, never more than its evidence holds. A CLI's version is read only from what its
installation keeps beside the program - the versions folder of Claude Code's native installer, Codex's
`codex-package.json`, Muse Code's versioned program or its `.muse-version`, OpenCode's npm `package.json` - never by
running it, and is kept with the launch as a diagnostic; Antigravity's and Pi's installations name none.

Ordinary input evidence distinguishes a usable input box, a draft, a native interaction and unknown. Activity or
tracked keystrokes alone cannot prove the draft empty after paste/history navigation. Never send Enter as a probe.
Direct text/keys only require the terminal input backend, not an input reader.

Each built-in CLI has an input reader that recognizes its input box by layout - prompt row, frame, box or footer, a
placeholder drawn dim or known by its words, and the cursor position or the CLI's own drawn cursor - not by version
number. Every installed version is attempted. A screen the reader does not recognize is unknown: nothing is typed, and
the message fails at its deadline with `input_unknown`, naming the CLI and the version Facade found. The version never
gates message input; only 1.1's unsupported line is refused, at its start. A CLI without an input reader fails ordinary
messages at once with `unsupported`. Readers are tested against recorded screens of real CLI versions; a changed layout
becomes a new recorded case, and a reader never guesses an empty input from a layout it does not recognize.
`scripts/capture-inputs.mjs` records a built-in's input box for each case - empty, typed and pasted text, messages, a
Facade result alone and several in one paste, Chinese and emoji, a seven-line message, a message of a few long lines, a
hundred-line message and Claude Code's lead - without submitting anything, at 40 rows or the `--rows` given, and checks
each reader and its own-draft recognition against what it drew; it is run once a CLI updates, and the screens it saves,
each paste's text kept with its screen, become recorded cases. In a terminal 24 rows high, as an editor's panel may be,
Antigravity and Pi scroll a draft taller than their input box, Antigravity marking it with `↑ 1 more lines` first in the
box and Pi in its upper rule, `─── ↑ 2 more ───`: their readers say how many rows are out of sight above and below,
apart from the draft, and a draft whose end in sight is the message's end, nothing being out of sight below, is the
message's own. Pi draws a paste of ten lines or fewer and more than 1,000 characters as `[paste #1 1284 chars]`,
counting a line break as one and a tab as four; its reader reads that count apart from the paste's number, so that a
person's `[paste #2 11284 chars]` is not a message's 1,284, and finds Pi's own drawn cursor by its column, after wide
characters too. Codex 0.166.0 draws a status at the right end of its hints row, `⚠ 1 warning · f2 to view`, alone there
while a draft hides the hints, when `-c` overrides run it outside its background server: Facade starts it with
`--no-daemon`, and its reader takes that row either way. Codex 0.166.0's passive transcript footer can replace its
shortcuts row with `enter/esc latest` or `New activity · enter/esc latest`, optionally followed by `· ? shortcuts` and a
right-aligned warning, and a resting draft changes that hint to `esc latest`: these are usable input layouts only with
the model/folder row, the blank separator, the complete composer and the cursor in it, and the same draft and
synchronized-drawing checks apply. Active transcript browsing, search and selection are not these passive footers and
stay unavailable to ordinary delivery. A usable input in a passive transcript view says nothing about current activity,
as its transcript can show old content (2.3).

Antigravity's accept-edits and plan modes draw a colored, non-dim initial placeholder. Recognize its exact mode
sentence (or the CLI's width-truncated prefix ending in `...`) only inside its one-line frame with the empty-input
`? for shortcuts` footer and the cursor at the input start. The same words typed or pasted by a person hide that
footer hint and remain a draft, even with the cursor moved back to the start. Color or matching words alone never
prove the input empty.

Each reader also reports a draft as it is drawn, so that a delivery knows its own (RULES-1.6): its rows' text, or the
placeholder its CLI draws for a long paste - Claude Code's `[Pasted text #1 +N lines]` counting the lines after the
first, Antigravity's `[Pasted text #1 +N lines]` and Pi's `[paste #1 +N lines]` counting every line, Codex's and Muse
Code's `[Pasted Content N chars]`, OpenCode's `[Pasted ~N lines]` from three lines on. That text is compared, never
logged. A message's lead - the start of its header, typed for Claude Code, which takes a paste alone as pasted material
rather than a request (COLLABORATION-2.1) - goes ahead of the paste in the same write; the other CLIs take the paste
alone, as Codex drops typed text that shares a paste's write. The draft is the message's own with the lead, or without
it where the run's older ptyd types none (ARCHITECTURE-2.4). Use complete paste plus Enter for ordinary messages. In
Windows win32 input mode a character outside the Basic Multilingual Plane goes as its two UTF-16 halves in two key-down
records together, with no key release for either half: Codex and Muse Code pair a half with a release and lose the
character, and releases added after the pair duplicate it; this holds for the person's input, direct text and keys and
messages alike. Their long-paste placeholder may follow the text's first non-ASCII character drawn as it is: the draft
is the message's own only where that exact character and the count of the rest match. A run held by an older ptyd can
still lose such characters, and its draft is the message's own without them too. A paste takes its bytes at 4 KB a
millisecond, ConPTY's 64 bytes a millisecond on Windows, counted in whole tenths of a second. The message's own draft
has 2 seconds and that time to show - on Windows a character (UTF-16 code unit) more, 3 ms for Codex and 1 ms for Muse
Code, which read console input one key at a time: 21.1 s for 9,249 characters, and 4.9 s for 7,533. Enter goes only over
that draft - for Antigravity, which takes seconds to expand a long paste, 45 ms a line after the draft shows; for Muse
Code 250 ms after, as it takes an Enter that soon after its paste for a line break in it (it did 15 ms after, and
submitted 100 ms after) - and delivery is confirmed once the input box is empty again, within 3 seconds and the paste's
time. The same times - Muse Code's 250 ms apart, which comes before an ordinary message's Enter alone - extend the
stage's deadlines (RULES-1.5) and type_text's wait before its Enter (MCP-5.2). State actual full/partial/unknown
effects. A later attempt never types the text again; it presses Enter only over the message's own draft (RULES-1.6). Do
not require a reconciliation API. An unknown version still starts its terminal, and its activity can still be verified
per run under 2.3. A CLI that never shows its activity is red, with its reason, once the run's startup bound passed
(2.3). Every CLI advertised as fully supported must actually demonstrate the required capabilities on its stated
platform.

The reader also reads what the person submits. An Enter the person types into an agent's terminal waits for the reader's
reading of the input - at most 150 ms, after 30 ms for typing sent with that Enter to be drawn - before it reaches the
CLI. The draft read is what that Enter submits once the CLI takes it: the input, read again over about four seconds,
reads empty or shows a menu or question; any other reading records nothing. That text is the card's second line
(PANEL-1.4) and is kept with the run, never logged. An Enter inside a paste, Alt+Enter, and an Enter after a draft
ending in `\`, which CLIs take as a line break, submit nothing. A CLI without an input reader, or a run held by an older
ptyd that reads no input (ARCHITECTURE-2.4), gives no such text.

### 2.2 MCP files and cleanup

**Use per-run launch files first; write project files only where the CLI requires them and preserve user content.**

Each built-in receives the `facade` server, the skill and an approval of Facade's own tools as its CLI takes them:

| CLI | Server | Skill | Facade's tools without asking |
| --- | --- | --- | --- |
| Claude Code | Per-run `--mcp-config` file | Per-run `--plugin-dir` plugin | `--allowedTools mcp__facade` |
| Codex | Per-run `-c mcp_servers.facade.*` overrides | Project `.agents/skills/facade/SKILL.md` | `default_tools_approval_mode="approve"` |
| Antigravity | Project plugin `.agents/plugins/facade`, shared; its PreInvocation hook supplies run-private ephemeral initialization context through the run environment | In that plugin | `mcp(facade_facade/*)` added to the person's own rules in its session `--settings` |
| Muse Code | Per-run `-c mcpServers.facade` with `"mode": "optional"`, on Windows too, where Facade starts its native program (2.4); where its program starts through cmd.exe, which cannot carry that JSON, a `facade` entry merged into the project's `.mcp.json`, shared, without `mode`, which in a project file Muse Code takes for a configuration error that turns off all its servers; the same entry takes the place of a `facade` server the run's own folder's `.mcp.json` already names, beside which Muse Code refuses a `-c` one. Its SessionStart hook supplies the run-private initialization context, except through cmd.exe | Project `.agents/skills/facade/SKILL.md` | Its own approvals: it has no rule for one server's tools |
| OpenCode | Per-run `OPENCODE_CONFIG_CONTENT`, on the person's own, with `--standalone` | Per-run file as `instructions` | `facade_*` allowed, after the person's own rules |
| Pi | Per-run extension, `-e`, that registers it with its tools given directly and supplies the same initialization instructions in its own native prompt section under MCP-6.2 | Its resource-discovery hook supplies the per-run skill only when Pi has not already loaded a byte-identical Facade skill | It has no approvals |

These approvals cover Facade's own tools alone, in either YOLO mode, for every CLI with a rule for one server's tools;
Muse Code has none, so with YOLO off its own approvals apply to Facade's tools too (RULES-4.3). The CLI's own commands
and edits keep the mode RULES-4.3 chose. An entry shared by a folder's runs holds no run's identity: the run's variables
reach the server through the CLI's environment, and a server started without them - by a session the person starts in
that folder - offers no tools (MCP-6.1). Muse Code's per-run entry names its variables only by references to that
environment. Its project entry, through cmd.exe, uses `${NAME:-}` references, empty in a session the person starts there
by hand - an unset plain reference would turn off every server of theirs. Muse Code refuses to run with a `-c` server of
a name its own settings or a project MCP file it reads already gives one - the `.mcp.json` of each folder from the run's
up to the top of its repository, of the run's alone outside one - and beside a project MCP file it cannot load, so
Facade looks first: where the run's own folder's `.mcp.json` names a `facade` server, the shared project entry takes its
place there, a Facade's brought up to date and a person's a conflict; anything else in the way is a conflict, and the
CLI starts without the tools, which are reported unavailable with why. Claude Code's run settings disable a project's
`facade` entry, which would otherwise ask about it at its start. Antigravity's `--settings` replaces a settings key
whole for its session, so the person's own permission rules are read and kept in it. OpenCode's background service,
which the person's sessions share, would not read a run's own configuration, so a run with the tools has its own server
process; the person's own inline configuration is read as OpenCode reads it, and one that cannot be read stays as it is,
the run without the tools. Antigravity starts a folder's plugin servers only with its first turn, which is planned
before they connect, or with its MCP panel: a run's start opens and closes that panel before the first turn
(COLLABORATION-2.2), and the server marks its tools for Antigravity to give the model directly. The server is never
declared required, so that a CLI whose Facade server fails still starts and stays usable. Muse Code requires a server
unless its entry says `"mode": "optional"`, and fails a whole run over a required one that does not start, so its
per-run entry says so; its project entry through cmd.exe cannot, as Muse Code refuses `mode` in a project file, so a
Facade server failing there can fail that run. Codex waits up to 10 s for its optional servers before its first model
request (`-c mcp_optional_startup_grace_ms=10000`), so a server that starts slowly still serves the first turn. The
server runs over stdio with per-run identity. Its skill contains MCP mechanics only, consistent with MCP-6. When
`facade.collaboration.enabled` is off for a start (RULES-4.4), inject no Facade server, skill or approval into that new
process. Where the tools cannot be given - a project file in conflict (below), launch files that cannot be written, a
CLI variable that cannot be read, or arguments cmd.exe cannot carry (1.2) - the CLI starts without them, its tools
unavailable with why, and nothing of them stays written.

Pi automatically discovers the project skill Codex or Muse Code may have written in the same folder. On each native
startup or resource reload, inspect Pi's loaded skill commands and their source files. Reuse a loaded `facade` skill
only when its complete bytes match the run's bundled skill; otherwise supply the per-run file through Pi's
`resources_discover` hook. If the project copy disappears, the next reload loads the per-run copy. Different content
retains Pi's native collision diagnostic: do not suppress warnings, overwrite it, or disable other skills.

Before a project write, snapshot exact original bytes/existence, take one lock for the execution environment's runs and
windows, merge only owned content, and record content hashes/reference counts. Content a Facade wrote is Facade's
whatever wrote it - another version, another Facade data directory, or one changed since - and is brought up to date: a
skill by its `facade` name and the description every Facade skill begins with; a file of its Antigravity plugin by its
members, every one of them one a Facade writes there - the manifest's `facade` name and Facade's description, an MCP
configuration and hooks of Facade's server alone, the shim; and a `.mcp.json` entry by that server. What the Facade Code
IDE's agent extension writes into a folder is Facade's too: its `facade` skill by its own description, its Antigravity
plugin's manifest by its name alone, its server by its shim. So is what a Facade left of a plugin file after taking its
own part out of it - the IDE takes its `name` out of this extension's manifest - even an empty object: nothing of anyone
else's is in it, and the person is never asked to move or rename a file only Facade wrote. A skill Facade writes into a
folder ends with a line naming the Facade version that wrote it; one a later version marked stands. An existing `facade`
server/skill of the person's own is a conflict; fail integration while preserving the CLI where it can launch safely.
Never overwrite malformed user config or unknown values. On cleanup remove only unchanged Facade-owned content after the
last run that uses it releases it; a `.mcp.json` entry taken over goes with the file left as it would be without it, and
modified files remain with a diagnostic. Never hide arbitrary files by modifying global Git ignore. Do not copy vendor
credentials into project files. Per-run files reside in the execution environment's Facade data directory; no identity
token or protected-file authentication mechanism is introduced.

### 2.3 Status, title and input evidence

**Only root-process reports and tested adapter evidence change displayed activity or input availability.**

Support the OSC 7501 adapter where verified: `working` → working; `idle|done|blocked` → not_working; `error` → known
error; `clear`, a full reset, a new shell prompt (OSC 133 A) after a working or blocked report, or a pending probe →
unknown. A `blocked` report remains blocked even without a known kind. Reports follow the [Program Status
Protocol](https://www.superlogical.com/rex/docs/build/program-status): each replaces the whole root record, so omitted
or empty titles clear that report's title. Malformed or unknown-state reports are discarded without changing the last
valid record; capability replies advertise only the states implemented here. Activity reporting is verified for a run
when that run's CLI sends the OSC 7501 capability probe, which ptyd answers, or valid reports, independent of CLI
version; CLI-specific quirks remain version-scoped evidence. OpenCode reports from its 2.x line; its 1.x line, which
sends no reports, is not started (1.1). Ignore worker reports carrying a distinct worker ID. Respond to capability
probes only for protocols implemented by the PTY adapter. The supervisor answers a probe of OSC 7501 as the CLI's output
reaches it, before any of that output goes on to a window and before the queries it answers as it parses them
(ARCHITECTURE-2.3): an answer to a later query coming first would tell the CLI that its reports go nowhere. A run whose
tab is hidden (LIFECYCLE-2.2) has no editor to answer what only an editor knows; each built-in is verified to start and
work so, from a start with its tab never opened. A run is still starting, with its startup stage, until its CLI first
shows its activity - a valid report or, where its screen is read, a state its reader knows - and its injected Facade
tools connect, for at most 60 s from its process start - many CLIs starting at once, as when an agent starts a group of
them, each take far longer than one alone - a reloaded window counting from that start too. Past that bound, a run whose
CLI never showed its activity - no report at all, or a probe answered and no report since - or whose tools never
connected did not start properly: red, with its reason (RULES-3.2). A report the CLI clears later is unknown activity,
never idle. It never implies an empty input. No “screen quiet for two seconds means done” fallback. A supported terminal
animation may establish working, but its absence supplies no idle proof.

Muse Code's observed Windows versions send no reports, so its adapter names a screen reader that ptyd applies to a run
whose CLI has neither asked nor reported. It reads logical lines, joining terminal soft wraps without guessing where
hard line breaks belong. A recognized working indicator above its complete input frame establishes working. Idle
requires the complete known input/footer layout and a recognized surrounding region, retaining native text styling where
it distinguishes an answer marker from a working indicator; an unknown indicator, clipped region or unfamiliar dialog
never supplies idle evidence. Drafts remain separate from activity. Its sign-in choice and workspace trust question
establish their corresponding blockers only when replacing the input frame. An unrecognized completed screen revokes
prior screen evidence; a full reset does too. A synchronized update still being drawn is not observed. Its own reports
always take precedence: once the CLI asks or reports, its screen is not read from then on. Evidence becomes stale after
route loss/reset; title/status from a new run does not update a previous one. A status episode starts on
state/kind/reason change; progress-only updates keep its start time.  Codex 0.166.0 reports root `working` while any
background command it started survives, even after its interactive turn ends; its own terminal-title animation follows
the active turn instead. For this version alone, the adapter names a correction that narrows `working` to idle while the
current completed screen shows its native dim `Worked for … • …` turn summary, then only blank spacing and its dim
background-terminal footer, followed by the complete input/model/hints layout. Draft text is outside that evidence, and
the footer may be clipped exactly at the native width as long as its identifying text and the whole turn summary stay
visible. The footer alone is insufficient: Codex also draws it while it streams an answer. A new turn, an unfamiliar
drawing or a lost layout removes the correction and restores the CLI's own report; a synchronized update still being
drawn supplies no new observation. Native idle/done, blockers, errors, clear/reset and probe states are never
overridden, and the report's record and title stay intact. Other versions and other CLIs keep their own reports until
verified the same way; a run held by an older ptyd keeps that ptyd's behavior (ARCHITECTURE-2.4).

Accept bounded valid UTF-8/base64 messages up to 2,048 decoded bytes and titles up to 192 decoded bytes; reject controls
and malformed reports. Sanitize invisible formatting and whitespace without stripping visible decorations. Keep the
bounded terminal title (up to 4096 UTF-16 units) and the protocol text whole for the hover; display previews may be
shortened, always between complete graphemes. A run's title is its CLI's nonempty terminal title from OSC 0/2; a status
report's title is used only when no terminal title is available. A later activity report must not replace a terminal
title or suppress its decoration-only updates. The title is kept as the CLI sets it - status symbols, decorations,
CLI/folder/agent names and default session titles included, even where the card already gives the same information -
with no adapter-specific filtering or rewriting, and the hover shows it so (PANEL-1.5). What the card's second line takes
from it - the title's words without the state symbol or spinner frame before them, until a message is sent - is
PANEL-1.4's. When both current title sources are empty, discard the previous title, including after reattachment;
PANEL-1.4's fallback then applies. A lost connection alone does not clear the last known title. Native CLIs may omit
decorations after status-protocol negotiation or shorten their own titles; Facade keeps what they actually send.
Message delivery and notifications do not depend on the title. Terminal emoji width follows tested Unicode cell tables;
wide-character/wrapped-line reading and bracketed paste modes are verified per terminal backend.

### 2.4 Exact conversations and vendor extensions

**Resume and Pin use the vendor's exact session identity and native discovery/resume, without external-writer policing.**

Use a supported session ID/hook/metadata source demonstrably tied to the selected conversation. Ambiguity remains
unknown; never replace it with --continue, --last, the newest file or a made-up ID. Data-capture hooks do not impose work.
Keep native interactive conversation stores and account configuration. Facade does not attach MCP to an existing
external process; resume creates a new interactive run.

Discover metadata relevant to all current-window folders/subfolders and their related worktrees, including external
vendor histories in that scope. Paginate and reuse metadata rather than parse full logs or repeatedly rescan on every
search key. There is no 30-day exclusion or hide/delete option. A simple bounded scan must be able to continue to older
relevant records. Do not copy histories across environments or include unrelated project histories.
Resolve native storage overrides from the launch environment, native settings and configured launch arguments with the
vendor's precedence, so that discovery and the resumed process use the same store.
Claude metadata includes the transcript head and tail: latest custom title (including its native title sidecar), AI title,
summary, then native prompt fallback. Use its last user/assistant timestamp, bounded by file mtime, for activity; mtime is
only the fallback when that timestamp is unavailable. Honor `continued-in` while its successor has conversation records;
a later meaningful turn in the original makes it independent again. Claude Code's documented
[native session-picker naming](https://code.claude.com/docs/en/sessions) is the vendor contract for this metadata.
Cache invalidation includes title sidecars and continuation targets. Metadata enrichment must not leave pages ordered by
stale file-maintenance timestamps.
Antigravity's sorted `workspace_uris` includes `--add-dir` folders and does not identify the launch cwd. Preserve that
ambiguity through discovery for LIFECYCLE-3.2's explicit location choice; never treat the first matching URI as the
original cwd.

A session already running in Facade is not duplicated; later Pin restorations skip it. Facade does not scan for or
acquire external writer locks. An externally active session may be resumed; return the vendor's actual acceptance or
error without promising concurrency safety. Restoration context follows RULES-4.2.
Verify interoperability with the actual Claude/Codex/vendor extensions where promised. Different stores cannot be
silently imported and called the same conversation. Custom Resume/Pin depends on exact capabilities, not CLI branding.
Configuration alone supplies no discovery or live identity.

All six built-ins support native history discovery and exact Resume: Claude Code, Codex, Antigravity, Muse Code,
OpenCode 2.x and Pi. Pin and Unpin require a maintained, process-bound session identity, including native new, switch,
clear and fork operations; discovering history alone does not establish that identity. Each adapter uses its vendor's
native per-launch hooks, extension interfaces or process registry without replacing user configuration, changing global
hook trust, or selecting a session by recency. A run whose session integration is in place can be pinned from its start:
a resumed conversation at once, a new one before its CLI names it, the Pin then taking the key the CLI names
(LIFECYCLE-3.4). A run whose integration could not be installed cannot be pinned. Missing or disabled native integration
cannot silently save a stale session. OpenCode's session tabs are off in its runs, through the same per-run CLI
configuration: they list every session of the working folder, other agents' among them, and a run's terminal shows its
own session alone. Its `tabs.enabled` is off, and `tabs.mode` too where the person set one, which would take its place;
the person's other settings stay as they are.

Release verification covers each built-in's actual native history format, exact resume arguments, session changes,
native tab synchronization and reload/reopen persistence. Reader fixtures establish format compatibility, not live
vendor interoperability on an untested platform. Custom CLIs still require a maintained discovery and identity adapter
before advertising these capabilities.

Compose session identity and Facade tool settings in the same launch; neither may overwrite the other's settings or a
user's hooks. An initial prompt remains after all launch options. On Windows, Muse Code's recognized installer is
resolved to the active native executable named by its `.muse-version`, only in the installed channel. This bypasses the
launcher's argument conversion so native JSON hooks and its server entry (2.2) reach Muse Code unchanged; that Facade
launch does not run the launcher's update check. An unrecognized batch wrapper still starts as configured, without
claiming session tracking it cannot install safely. Likewise, native settings or a per-launch configuration file an
identity integration cannot read leave the launch as configured, with no session tracking claimed: the CLI reports its
own settings' problem, and the start is never refused for it. A Claude Code background job (`CLAUDE_JOB_DIR`) never
records its session as its run's.

## 3 Launch configuration

### 3.1 Launch arguments and environment

**Expose executable paths, literal arguments and environment values; keep vendor integration inside adapters.**

Built-in `.path` follows 1.2; `.launch` defaults to `{}` and accepts only:

| Field | Shape / default |
| --- | --- |
| arguments | `string[]`, default `[]`; additional literal CLI options in supplied order |
| environment | Map of string/null values, default `{}`; use 1.2's single environment rule |

Arrays are replaced as a whole, not merged by named groups. There is no public argument-group/template engine,
deep-merged native settings object, generic trust-file merge or input-delay setting. Custom start/Resume argument
templates are the limited exception defined in 3.4. A field the launch schema does not have reports its setting path; it
is never translated or ignored. Preserve the user's values so they can correct them. An argument that repeats an option
the adapter sets itself - its run settings, its YOLO mapping in either mode, or its session options: the resume and
session-ID options and the CLI's own continue, resume, fork and no-session shortcuts, such as Claude Code's `--continue`
or Pi's `--no-session`, which would leave the exact conversation (2.4) - in any spelling its CLI takes, such as Codex's
`-s` and `--yolo` or OpenCode's `--yolo` and `--dangerously-skip-permissions`, is a configuration error naming its place
in `arguments`: the CLI would take the person's value in place of Facade's (RULES-4.3). A generic configuration option -
Codex's and Muse Code's `-c` - is never reserved whole, as it carries unrelated settings too. A problem names a received
value by its JSON type, never the value, which may be a secret. Running processes keep their actual plan.

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
Code's unless it is one lowercase word, which it reads as one of its commands even there and refuses to start - and
OpenCode as the value of `--prompt` unless it starts with `-`. A prompt with a NUL character, or one cmd.exe cannot be
given safely where the launch goes through it (1.2), goes after startup too, with why. The mapping is used while
unverified and reports that state. Antigravity's first task goes after what its start types before the first turn
(COLLABORATION-2.2), as its first message. Do not wait for MCP or activity idle beyond that, send a confirmed prompt twice
or synthesize a prompt to make MCP appear connected.

A CLI whose startup update prompt would hold back the first task it is given starts without that prompt in Facade's
launches: Codex with `-c check_for_update_on_startup=false`; the person's own sessions still prompt. The other built-ins
update in the background, only note a new version or, for Muse Code's launcher, ask only to sign in, and keep that
behavior, except that on Windows Facade starts Muse Code's native program directly, so its launcher's update check does
not run (2.4).

### 3.3 Native configuration and trust

**Users configure native CLI settings and trust through the CLI; Facade writes only necessary integration configuration.**

Use native configuration files, commands or explicit literal launch options for vendor preferences. Facade does not
provide a generic engine to edit arbitrary settings files or mirror their schemas. Facade trusts the folder an agent
starts in, as the person would by accepting the CLI's own trust question: where the CLI takes trust for one launch,
in that launch (Codex `-c projects` with `trust_level = "trusted"` for the folder; Muse Code `--trust-workspace`; Pi
`--approve`); where it keeps trust in its own file, by merging only that entry as the CLI itself writes it, under the
CLI's lock and preserving the rest of the file (Claude Code `hasTrustDialogAccepted` in its global configuration for the
folder it keys the project on - on macOS and Linux the real path of the repository's main checkout; on Windows the folder
with `.git` at or above the folder it starts in, a linked worktree's own, spelled as the run is given it with forward
slashes; outside any repository the folder itself; Antigravity `trustedWorkspaces` with the folder, spelled as
Antigravity names its working directory, in `~/.gemini/antigravity-cli/settings.json`). A merged entry stays after the
run, as the person's own answer would. OpenCode asks no trust question and is given none. A file that cannot be read, or
that does not exist, is left as it is and the CLI asks in its terminal. Claude Code's trust covers every folder below a
trusted one, so it is never written for the home folder, a folder above it or a filesystem root; that CLI asks in its
terminal there too. Native login and permission interactions remain in the terminal.

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
Substitute the exact session ID once as literal argument data; `${sessionId}` is the only custom argument placeholder,
and only `resume` takes it: any other `${...}`, or `${sessionId}` in `start`, is a configuration error naming its place.
Do not invoke a shell or expand integration/configuration variables. A wrapper executable can handle a CLI with a
different command structure. For example, `{"path":"my-cli","launch":{"start":[],"resume":["resume","${sessionId}"]}}`.
Missing/empty Resume or a command without the exact-session placeholder is a configuration error, not an accepted
interactive-only definition. No YOLO mapping and no implicit model, effort, prompt or resume flags are invented:
`facade.yolo` leaves a custom launch as configured, and Show Agent Launch says so, reporting its sandbox and approvals
as unknown to Facade and that Facade gives it no trust (3.3). A start that asks a custom CLI for a model or effort is
refused (1.4). A custom CLI is given no Facade tools - no server, skill or approval - and no input reader, so ordinary
messages to it fail as `unsupported`, and no screen reader. The errors of `facade.custom` are listed by list_agents and
Show Agent Launch.

Capabilities are what the shipped adapter or the run itself proves under 2.1 and 2.3 - a custom CLI that sends OSC 7501
reports shows its activity - never configured by the user. There is no `capabilities` field in a custom definition. An
interactive CLI without runtime capability proofs can still start and accept direct terminal control after its
definition passes validation; unproved capabilities remain unavailable. A Resume command is necessary but does not
prove session discovery/identity or successful restoration; the definition requirement never becomes a claim that an
untested integration works.

## 4 Inspection and design

### 4.1 Show Agent Launch...

**Show Agent Launch... displays a start's effective launch and actual known choices without running a CLI.**

Show executable/environment source, cwd, literal argument order, resulting YOLO, native sandbox/approval facts, how the
folder is trusted and configuration errors. It includes the arguments and variables the Facade tools (2.2) and session
tracking (2.4) add at a start, in their literal order, without writing any launch file to show them: a value that exists
only once a start makes it - a generated path or session ID - appears as a named placeholder, and what cannot be planned
without writing files is said in words. Use one launch configuration and RULES-4.3's YOLO source. A chosen inspection
location is not an API launch default. Redact account secrets and sensitive environment values; do not invent
invalid-plan defaults. Where 3.3 withholds trust for a broad folder, or the CLI's trust file does not exist, say that no
trust entry is written and the CLI asks in its terminal, instead of claiming an entry will be written. The document does
not certify observed behavior of a process never started.

Its location is the one a `{ location_id }` names, the window's only one, or the person's choice in native steps by
folder that offer locations alone: in a window of several folders, the folders, as Change Working Location lists
them (LIFECYCLE-1.3) - one with a single location choosing it, one with more opening its own step of them; in a window
of one folder, its locations. Locations come main checkout first (WORKTREES-1.2), and no separator divides them.

### 4.2 Adapter ownership and files

**One versioned adapter definition generates detection and launch.**

Validate argument types, configuration shape and all already-resolvable prerequisites before side effects. CLI discovery
for a proposed worktree uses the selected existing source checkout. For the new worktree, resolve cwd-dependent paths
and check executable existence/permissions after native Git returns the actual created location, before CLI spawn. A
tracked `./tools/agent` need not exist at the future destination beforehand. No setup wait is added; WORKTREES-2.4
applies. Final validation failure retains the accepted error pair and reports the actual created worktree under
LIFECYCLE-1.5; do not delete it or roll back files. Existing-location launches perform these same checks before spawn
without creation.

Each CLI's adapter and the PTY adapter form the one launch path; there is no second launch path and no public
trust/template machinery. A run keeps safe metadata - its CLI, location, YOLO, requested model and effort, version and
tools state - and the injection record keeps owned-file hashes and reference counts (2.2); neither keeps the
arguments, environment values or a credential. Capability facts are computed at each launch from its adapter and the
installation found, so a changed executable, version or platform applies to the next start.

## 5 Evidence baseline

### 5.1 Dated observations are not release evidence

**A recorded vendor observation is a test lead with its original limits, never release or platform certification.**

An observation of a CLI - a probe, a recorded screen, a vendor document - shows what it shows for its date, version and
platform, and stays labeled with them. A capability is advertised as supported only on fresh versioned evidence
(VERIFICATION-2.1). Native CLI probes use isolated HOME, XDG and native configuration, never the owner's state; Qwen is
never probed. Native Resume/Pin evidence from Linux does not establish Windows, macOS or remote support; that platform
regression is VERIFICATION-2.1's.

### 5.2 Current external facts used by the handoff

**Vendor mappings and external documentation are evidence inputs, not substitutes for actual integration checks.**

Verify concrete installed versions, stores, flags and supported APIs before making a release-support claim. A vendor's
documentation states its contract, as Claude Code's session-picker naming does for 2.4; an isolated check of the
installed CLI is the runtime evidence.

## Checks

| Rules | Acceptance |
| --- | --- |
| 1.1–1.4 | Each built-in's destination discovery, unknown-version launch, OpenCode below version 2 refused with how to update, a turned-off CLI refused as turned off, matching profile/PATH/env/quoting, Windows launcher recognition and cmd.exe refusals, native permission mapping, explicit per-call model/effort and native defaults |
| 2.1–2.3 | Adapter evidence, layout-based input readers on recorded screens of several versions, unrecognized layouts untouched, direct versus ordinary input, the person's submitted text read before Enter, pre-approved Facade tools and Muse Code's own approvals, optional server, owned-file cleanup, startup until the first activity and the tools' connection or its bound - a reload too - then red where not ready, titles kept as set for each built-in, Muse Code's screen reader on its fixtures and its reports' precedence |
| 2.4 | Each built-in's native history, exact resume, session changes and Pin from a start with session integration, on reader fixtures and isolated native checks |
| 3.1–3.4 | `.enabled` affects new starts only, custom CLIs require Resume without capability declarations or other placeholders, minimal argument/env schema, owned and session options refused, no generic file merge, native prompt mapping, adapter-owned evidence, each built-in's trust: per-launch arguments, Claude Code's and Antigravity's entries merged and preserved user configuration |
| 4.1–4.2 | Show Agent Launch describes and redacts the configured launch and says where no trust entry is written; staged cwd validation |
| 5.1–5.2 | Fresh versioned fixtures plus isolated real CLI probes; no claim inferred from a dated observation |

See [Verification](VERIFICATION.md). Never probe a real CLI in the owner's state directory; never run Qwen probes.
