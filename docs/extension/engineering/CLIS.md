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

**Built-ins and added entries are discovered in the destination execution environment.**

| Display name | Entry ID | Default command | Settings entry |
| --- | --- | --- | --- |
| Claude Code | `claude` | `claude` | `clis.claude` |
| Codex | `codex` | `codex` | `clis.codex` |
| Antigravity | `agy` | `agy` | `clis.agy` |
| Muse Code | `muse` | `muse` | `clis.muse` |
| OpenCode | `opencode` | `opencode` | `clis.opencode` |
| Pi | `pi` | `pi` | `clis.pi` |

Use this order, then added entries in file order (CONFIGURATION-2.1). Each entry is independent; its `type` selects
an adapter and its name remains the CLI ID. A valid `enabled: false` entry is hidden from New Agent and refused on
explicit start or restoration, naming `clis["<name>"].enabled`. Existing processes remain. Invalid entries, including
disabled ones, report CONFIGURATION-4.1's errors. Recompute on settings-file/PATH changes, picker/discovery requests,
and immediately before launch. Discovery inspects files/configuration without invoking a model, logging in, installing/updating a CLI, or
modifying settings, except creating a missing settings file under CONFIGURATION-1.3.

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
entry's `env`; the variables every run is given and final cleanup. Resolve the profile through
`terminal.integrated.defaultProfile.<platform>` and its entry in `terminal.integrated.profiles.<platform>` in the
destination environment. A profile without a configured env map adds nothing. Do not start a shell or parse its startup
scripts to discover extra variables; shell-only PATH changes are not part of Facade's computed environment.

In every configured environment map, a string sets the value, null removes the variable and an omitted key inherits
the preceding layer. `${env:NAME}` is expanded only in environment string values, once, from the execution host's
environment. A missing reference in an entry's `env` is an error for that entry; an existing empty variable stays empty.
In `terminal.integrated.env.<os>` and the default profile's `env`, a missing reference expands to an empty string,
as VS Code's terminal reads it. This keeps existing terminal settings working. For example, with `PYTHONPATH` unset,
`"PYTHONPATH": "${env:PYTHONPATH}:/work/src"` in either editor layer becomes `:/work/src`; the same reference in the
entry's own `env` is an error.
References never read sibling values or the merged terminal layers, and inserted text is not expanded again.
Windows keys compare without regard to case; duplicate names differing only in case within one entry's `env` are
errors (CONFIGURATION-3.2). The execution extension host environment is taken as VS Code's integrated terminal
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

An omitted `command` uses the type's command on PATH; `custom` requires one (CONFIGURATION-2.2). A simple name is
searched on that PATH; a relative path is from launch cwd; leading `~` uses that environment's home; an absolute path
is exact. Empty or whitespace-only is invalid. There is no silent fallback to another CLI.
Require executable file on POSIX, file plus PATHEXT resolution on Windows. Preserve quoted PATH entries. A Windows
`.cmd` launcher, recognized only as its installer writes it, starts what it runs, using an argument array: npm's shim
for a package's Node script runs that script with Node, its shim for a native program runs that program, the `pi.cmd`
Pi's own installer writes runs its `pi-launcher.js` with the Node it chooses - its own in `LOCALAPPDATA` where it names
one and it is there - and Muse Code's installer launcher runs its active native program (2.4). Node is the `node.exe`
beside npm's shim, else a Node program (`.exe` or `.com`) on the launch's PATH, never a version manager's `.cmd` or
`.bat`. Any other `.cmd` or `.bat` runs through cmd.exe, which Facade gives no text it would read as its own: a launch
through cmd.exe is refused before execution where an argument or the program's own path holds `"`, `%`, `^`, `&`, `|`,
`<`, `>`, `!` or a line break, saying to set the entry's `command` to its own program or Node entry point; a configured
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
| Antigravity | `--mode accept-edits --dangerously-skip-permissions` | Its own approvals; Facade does not yet map its newer sandbox option |
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

**Facade resolves model and effort from this start, then the current entry, then the CLI's own configuration.**

CONFIGURATION-3.3 owns the precedence and suggested values. Resolve each field independently. An absent request field
can use `clis["<name>"].model` or `.effort`; with neither source present, add no override. A native restored session
can keep its saved choice. Historical requested values never become current overrides. Model and effort options are
not accepted in built-in `args` (3.1), so a start does not remove a competing configured argument.

| Type | Model mapping | Effort mapping |
| --- | --- | --- |
| `claude`, `agy` | `--model` | `--effort` |
| `codex` | `--model` | Per-run `-c model_reasoning_effort` |
| `muse` | `--model` | Per-run `-c reasoning_effort`, with `model_reasoning_efforts` cleared for the run; unavailable through Windows cmd.exe, which cannot carry the JSON |
| `pi` | `--model`, including `provider/model` | `--thinking` |
| `opencode`, `custom` | Unavailable | Unavailable |

Muse's native effort-selection option is not used because it saves the choice in the person's settings. An added
entry has its type's supported overrides. Unsupported explicit request fields are refused; unsupported entry fields
are configuration errors. For example, an entry's `effort: "high"` supplies a default, and a start's `effort: "low"`
replaces it for that run alone.

list_agents reports override support for the actual destination. Structured diagnostics record requested model/effort
and startup outcomes. They do not establish effective native choices or successful model requests. Values are not a
model catalog or an allowlist. The native CLI owns its model controls, history and later in-session changes; an omitted
choice is unknown to Facade unless the CLI reports it.

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

Each built-in CLI has an input reader that finds its input box around the cursor - its prompt row, frame or box, the
cursor being the terminal's or the CLI's own drawn one - and reads what the box holds: nothing, its placeholder, or a
draft. A placeholder is known by how a CLI draws it apart from typed text, with the cursor where the input starts and
nothing typed before it: dim, as every built-in's but OpenCode's and Antigravity's mode hints draw it; or, for a CLI whose
recorded captures show its empty input's placeholder and the person's typed and pasted text - with the cursor moved back
to the start - in different colors, the placeholder's, as those captures establish them. Text where the placeholder
would be - the cursor at the input start, nothing typed before it - in a color no capture establishes reads as unknown,
never as an empty input or a draft, except where its words are recognized, as OpenCode's and Antigravity's mode hints'
are: a person's draft is never taken for an empty input, and a draft a CLI draws in a color of its own is never
submitted with a message. OpenCode, which draws typed text and its placeholder
in the same color, has its placeholder known by its words. A reader goes by layout, not version number, and tells a usable input from a
draft by nothing outside the box: footers, hints, status rows and warnings may change, as a CLI updates or within a
session, without changing what it reads, apart from the two places below where the box alone cannot tell - Antigravity's
colored placeholder and the lower edge of Codex's box. A CLI's questions, menus and logins take its box's place: a
screen without the box around the cursor is a native interaction where the reader recognizes one of its CLI's questions
or menus, which a message waits for (RULES-1.4, 1.5), and unknown otherwise. Nothing is typed into either, and an
unknown screen fails the message at its deadline with `input_unknown`, naming the CLI and the version Facade found.
A screen its program is still drawing - within a synchronized update - is read again within the same attempt, every
tenth of a second for at most a second, until a complete frame shows: an unfinished frame is never taken for an empty
input, a frame still unfinished after that second reads as unknown for that attempt, and reading again never pastes
again or moves a deadline. Every installed version is attempted. The version never gates message input; only 1.1's unsupported line is refused, at
its start. A CLI without an input reader fails ordinary messages at once with `unsupported`. Readers are tested against
recorded screens of real CLI versions; a changed box becomes a new recorded case, and a reader never guesses an empty
input where it does not find its box.

`scripts/capture-inputs.mjs` records a built-in's input box for each case - empty, typed and pasted text, messages, a
Facade result alone and several in one paste, Chinese and emoji, a seven-line message, a message of a few long lines, a
hundred-line message and Claude Code's lead - without submitting anything, at 40 rows or the `--rows` given, and checks
each reader and its own-draft recognition against what it drew; it is run against each built-in's newest version before
a release and whenever a CLI updates, and the screens it saves, each paste's text kept with its screen, become recorded
cases. In a terminal 24 rows high, as an editor's panel may be, Antigravity and Pi scroll a draft taller than their
input box, Antigravity marking it with `↑ 1 more lines` first in the box and Pi in its upper rule, `─── ↑ 2 more ───`:
their readers say how many rows are out of sight above and below, apart from the draft, and a draft whose end in sight
is the message's end, nothing being out of sight below, is the message's own. Pi draws a paste of ten lines or fewer and
more than 1,000 characters as `[paste #1 1284 chars]`, counting a line break as one and a tab as four; its reader reads
that count apart from the paste's number, so that a person's `[paste #2 11284 chars]` is not a message's 1,284, and
finds Pi's own drawn cursor by its column, after wide characters too. Codex has no frame: its box is its prompt row `› `
with the input or its dim placeholder, the draft going on in rows indented two spaces, blank ones among them, and its
own earlier messages begin `› ` too, higher up: the box is the one the cursor is in. It ends at the blank row above the
row Codex draws its model and folder on - two spaces, the model, ` · ` and the folder's path - which its reader finds by
that shape and its place, the last row Codex draws or the one above it. The row under it, where Codex draws one, changes
with its state and is not read - among them a status at the right end, `⚠ 1 warning · f2 to view`, when `-c` overrides
run it outside its background server, as Facade starts it with `--no-daemon`, and in a passive transcript view
`enter/esc latest` or, under a resting draft, `esc latest`, led by `New activity · `, by `Earlier messages available.  `
while older history is not loaded, or by both. Its transcript browsing, search and selection keep the box drawn while
they take its keys, and put the cursor outside the box or hide it: they are not usable input and stay unavailable to
ordinary delivery, as a recorded screen of each shows. A usable input in a passive transcript view says nothing about
current activity, as its transcript can show old content (2.3).

Antigravity's accept-edits and plan modes draw a colored, non-dim initial placeholder. Recognize its exact mode
sentence (or the CLI's width-truncated prefix ending in `...`) only inside its one-line frame with the empty-input
`? for shortcuts` footer and the cursor at the input start. The same words typed or pasted by a person hide that
footer hint and remain a draft, even with the cursor moved back to the start. Neither its color nor matching words alone
prove the input empty; its captures may later establish its hint's color under the rule above, which then reads it too.

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
time. These times decide whether an attempt's paste fits within what remains of its delivery's budget; they never extend
it (RULES-1.5). type_text keeps them as its wait before its Enter (MCP-5.2), Muse Code's 250 ms included, so that its
Enter after a typed text submits too. State actual full/partial/unknown effects. A
later attempt never types the text again; it presses Enter only over the message's own draft (RULES-1.6). Do not require
a reconciliation API. An unknown version still starts its terminal, and its activity can still be verified per run under
2.3. A CLI that never shows its activity is red, with its reason, once the run's startup bound passed (2.3). Every CLI
advertised as fully supported must actually demonstrate the required capabilities on its stated platform.

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
server runs over stdio with per-run identity. Its skill contains MCP mechanics only, consistent with MCP-6.
Every start using a built-in type attempts this injection; there is no switch to turn it off (RULES-4.4).
Where the tools cannot be given - a project file in conflict (below), launch files that cannot be written, a
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
them, each take far longer than one alone - a reloaded window counting from that start too. A custom program, which has
no adapter and no tools, has started once its process has: no first report is awaited (CONFIGURATION-2.3). Past that bound, a run whose
CLI never showed its activity - no report at all, or a probe answered and no report since - or whose tools never
connected did not start properly: red, with its reason (RULES-3.2). A report the CLI clears later is unknown activity,
never idle. It never implies an empty input. No “screen quiet for two seconds means done” fallback. A supported terminal
animation may establish working, but its absence supplies no idle proof beyond Codex's title spinner below.

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
state/kind/reason change; progress-only updates keep its start time.  Codex reports root `working` while any command its
turn started runs on, even after the turn ends; the spinner its default terminal title animates follows the turn alone.
From 0.166.0 on, its adapter has ptyd read that title: once a spinner frame - `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` as a word of its own,
wherever its title items put it - has shown in a run, a title without one reads its `working` as idle until a spinner
shows again, which starts a new working episode. A title that never shows one - animations off, or items without it -
leaves its own report as it is. Its screen is not read for this: the notices it adds, the terminal's width and drafts
change nothing. Native idle/done, blockers, errors, clear/reset and probe states are never overridden, and the report's
record and title stay intact. Earlier versions and other CLIs keep their own reports; a run held by an older ptyd keeps
that ptyd's behavior (ARCHITECTURE-2.4).

Accept bounded valid UTF-8/base64 messages up to 2,048 decoded bytes and titles up to 192 decoded bytes; reject controls
and malformed reports. Sanitize invisible formatting and whitespace without stripping visible decorations. Keep the
protocol text whole for the card; display previews may be shortened, always between complete graphemes. Neither a
CLI's terminal title (OSC 0/2) nor a status report's title is shown anywhere - not on the card, in its details, Go to
Agent or list_agents: CLIs mostly title their terminals with their own name or their folder's - Codex with its folder's,
Pi `π - {folder}`, OpenCode `OpenCode` - and Antigravity sets none, while the conversation's title each CLI keeps in its
own history says what the run works on. A run's title is its conversation's (2.4). The supervisor may go on recording
its run's bounded terminal title (up to 4096 UTF-16 units) and a report's; the window takes neither. Message delivery
and notifications do not depend on any title. Terminal emoji width follows tested Unicode cell tables;
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

A run's title is its conversation's complete native stored title, the one Resume shares, by each store's reader and
precedence: Claude Code's
custom title, then its AI title, summary and prompt; Codex's name, else its title - a rollout's first prompt where the
index has none of it; OpenCode's title; Pi's name, else its first prompt; Muse Code's name, else its prompt; and
Antigravity's title, else its preview. Resume's one-line presentation of it, and a preview made from a first prompt
where a store falls back to one, do not shorten the complete native stored title held by the details (PANEL-1.5) and
the API (MCP-3.1).
It is read by the run's exact conversation - its CLI, session ID and environment - alone, in the store its launch uses,
found as discovery finds a directory's: an indexed store is queried by that exact ID; a file store may list its file
names to find the one for that ID and parses only the matching candidates, never discovering the store's other
conversations. It reads Claude Code's
`<ID>.jsonl` in the project folders the run's folder names; Codex's thread by its ID in `state_5.sqlite`, else, not
indexed, the rollout named for it; Pi's session file named for its ID in the folder Pi keeps the run's folder's sessions
in, or its override's; and OpenCode's, Muse Code's and Antigravity's row by its ID - each by the rules its list has, each
file version read once. It is read as soon as the run's conversation is known - its CLI names it, or the run starts to
resume it by its ID - and whenever that changes; once for each run a reload reattaches; and as each turn ends, the run's
activity going from working to not working. A run's title is read at most once in 30 seconds: a read asked sooner follows
once they are up, one however many were asked, never dropped; a run's reads never overlap, and none is asked or waits for
a run that ended or closed, or once the window's Facade stops. There is no polling and no file watcher. A title found
replaces the run's, its card told only where it changed. Before its CLI saved the conversation it has none; a later read
that finds none, or fails - said in the log, never shown - keeps the last, and another conversation of the run has none
until it is read. The title is kept with the run across a reload, its reattachment and an ended run's restoration, as a conversation
title only where it was proven to come from the native conversation reader: a title an earlier build kept without that
proof, which may have come from a CLI's report, is discarded. A custom program keeps no history Facade reads, so
its runs have no title (CONFIGURATION-2.3). The extension runs where its window's CLIs do, a remote window's included, and reads the stores
their launches use.

A session already running in Facade is not duplicated; later Pin restorations skip it. Facade does not scan for or
acquire external writer locks. An externally active session may be resumed; return the vendor's actual acceptance or
error without promising concurrency safety. Restoration context follows RULES-4.2.
Verify interoperability with the actual Claude/Codex/vendor extensions where promised. Different stores cannot be
silently imported and called the same conversation. An added entry of a built-in's type resumes and pins as its built-in does
(CONFIGURATION-3.4); a program does neither. Configuration alone supplies no discovery or live identity.

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
vendor interoperability on an untested platform. A custom program has no discovery or identity
adapter, so it advertises neither (CONFIGURATION-2.3).

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

**Entries use `command`, `args` and `env`; each adapter rejects options that replace Facade's launch choices.**

CONFIGURATION-2.2 owns field shapes and defaults, CONFIGURATION-3.1 literal arguments, and 1.2 environment handling.
Arrays are used whole, in order. There is no public argument-group engine, placeholder template, trust-file merger
or input-delay field. Errors name the field or argument position and expected type, never the supplied value.

For built-in types, permissions come from `yolo`, model and effort from their fields, and location, session,
interactive terminal and first task from the launch request. Cloud, remote, background and desktop redirection cannot
replace the process Facade manages. The reserved options are:

| Type | Reserved arguments and configuration paths |
| --- | --- |
| `claude` | `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`, `--permission-mode`, `--bare`, `--safe-mode`, `--restricted`, `--session-id`, `--resume` / `-r`, `--continue` / `-c`, `--fork-session`, `--resume-session-at`, `--no-session-persistence`, `--from-pr`, `--worktree` / `-w`, `--tmux`, `--environment`, `--cloud`, `--teleport`, `--desktop`, `--bg` / `--background`, `--print` / `-p`, `--model`, `--effort`; positional arguments |
| `codex` | `--dangerously-bypass-approvals-and-sandbox` / `--yolo`, `--sandbox` / `-s`, `--ask-for-approval` / `-a`, `--approve-for-me`, `--not-so-yolo`, `--cd` / `-C`, `--worktree`, `--remote`, `--remote-auth-token-env`, `--no-daemon`, `--model` / `-m`, `--last`; subcommands such as `resume` and `exec`; positional arguments. In `-c` / `--config`: `check_for_update_on_startup`, `projects`, `mcp_servers.facade`, `mcp_optional_startup_grace_ms`, `approval_policy`, `sandbox_mode`, `model`, `model_reasoning_effort` |
| `agy` | `--dangerously-skip-permissions`, `--mode`, `--sandbox`, `--conversation`, `--continue` / `-c`, `--remote-agent`, `--print` / `-p` / `--prompt`, `--prompt-interactive` / `-i`, `--model`, `--effort`; subcommands |
| `muse` | `--disable-approval`, `--disable-sandbox`, `--yolo`, `--approval-mode`, `--permission-profile`, `--approval-judge`, `--trust-workspace`, `--worktree` / `-w`, `--worktree-existing`, `--worktree-base`, `--no-session-log`, `--model`, `--reasoning-effort` / `--effort`, `--continue`, `--last`; subcommands such as `resume` and `exec`; positional arguments. In `-c`: `mcpServers.facade`, `model`, `reasoning_effort`, `model_reasoning_efforts` |
| `opencode` | `--auto` / `--yolo` / `--dangerously-skip-permissions`, `--session` / `-s`, `--continue` / `-c`, `--fork`, `--standalone`, `--server`, `--prompt`; subcommands; positional arguments, which OpenCode treats as its working folder |
| `pi` | `--session`, `--session-id`, `--continue` / `-c`, `--resume` / `-r`, `--fork`, `--no-session`, `--no-mcp`, `--no-tools` / `-nt`, `--approve` / `-a`, `--no-approve` / `-na`, `--print` / `-p`, `--mode`, `--export`, `--model`, `--provider`, `--thinking`; positional arguments |

Each adapter has an explicit table, not a comparison with whatever strings it happens to generate today. Recognize
aliases, separate values, `--name=value` and the CLI's supported short forms. Parse `-c` and `--config` consistently
where supported. Compare configuration paths: replacing a reserved node's parent or child also conflicts. For example,
`mcp_servers={...}` cannot bypass the rule for `mcp_servers.facade`; another server's own path is allowed.

Antigravity also reads long options after one dash, as Go programs do. Refuse `-mode` wherever `--mode` is reserved;
apply the same rule to every reserved long option. Its allowed `-settings` is merged like `--settings` (3.4).
Claude, Codex, Muse and OpenCode also read short options joined together. Check each one until an option takes the
remaining text as its value. For example, Claude's `-cp` means `-c -p`, while Codex's `-pwork` selects profile `work`.

An end-of-options `--` is refused in a built-in entry's `args`: the options Facade adds after it would become positional.
It remains literal and allowed for a custom program. The table also reserves modes that turn off integration a
Facade run needs, such as Claude's `--bare` and Pi's `--no-mcp`.

Read each option together with its value, following that CLI's parser:

| CLI and option | How Facade reads a separate value |
| --- | --- |
| Claude Code options documented with `<value>` | Take the next argument whatever it looks like, as Commander does |
| Antigravity non-boolean flags | Take the next argument whatever it looks like, as Go's flag package does |
| Pi value options | Take the next argument whatever it looks like, as Pi's parser does |
| Codex, Muse and OpenCode options | Never take a following argument that starts with `-`, matching their clap or yargs parser |

Any other option takes the next argument only when it does not start with `-`. For unknown options, this lenient
rule prefers missing a positional argument to rejecting a newly added native option that takes a value.
Pi treats `--name=value` for its own options as an unknown flag, so Facade neither extracts a model from that spelling
nor merges it into a list, but still refuses it when the option name is reserved.

Validation, migration, `--settings` extraction, list merging and `-c` hook merging all read arguments this same way.
An argument already taken as a value is not read again as an option, subcommand or end marker. For example,
`--profile resume` selects a profile named `resume`. Claude's
`["--append-system-prompt", "--model=literal"]` adds the text `--model=literal` to its system prompt; it does not select
a model. A `--settings=...` string in that same value position is prompt text too, and is not extracted or merged.

Pi's provider is part of its `model`, such as `openrouter/my-model`; its native `--provider` requires `--model`, which
Facade supplies. `--session-dir` remains allowed, and history discovery follows Pi's native precedence.
Custom-program arguments pass through without these adapter reservations. Additive and merged integrations follow 3.4.

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
starts in, as the person would by accepting the CLI's own trust question: where the CLI takes trust for one launch, in
that launch (Codex `-c projects` with `trust_level = "trusted"` for the folder; Muse Code `--trust-workspace`; Pi
`--approve`); where it keeps trust in its own file, by merging only that entry as the CLI itself writes it, under the
CLI's lock and preserving the rest of the file (Claude Code `hasTrustDialogAccepted` in its global configuration for the
folder it keys the project on - on macOS and Linux the real path of the repository's main checkout; on Windows the
folder with `.git` at or above the folder it starts in, a linked worktree's own, spelled as the run is given it with
forward slashes; outside any repository the folder itself; Antigravity `trustedWorkspaces` with the folder, spelled as
Antigravity names its working directory - the folder as the launch gives it, which its terminal names in `PWD`, never
its real path where a link or another case of its letters names it - in `~/.gemini/antigravity-cli/settings.json`). A
merged entry stays after the run, as the person's own answer would. OpenCode asks no trust question and is given none. A
file that cannot be read, or that does not exist, is left as it is and the CLI asks in its terminal. Claude Code's trust
covers every folder below a trusted one, so it is never written for the home folder, a folder above it or a filesystem
root; that CLI asks in its terminal there too. Native login and permission interactions remain in the terminal.

Keep administrator settings and user deny policies effective according to verified native precedence. If effective
native settings are unknown, report that fact instead of claiming trust or sandbox evidence. Test isolation remains
ARCHITECTURE-5's separate concern.

### 3.4 Named entries and native settings

**An entry's type selects the adapter, while its name and settings stay its own.**

CONFIGURATION-2 defines entry identity and capabilities. Resolve a built-in type using this entry's `command`, `args`
and `env`, without inheriting another entry. Use that type's readers, native history, trust and supported options.
Its name remains the API ID, and its icon follows CONFIGURATION-2.4. Record name and type with conversation metadata
so restoration can validate the original entry (CONFIGURATION-3.4); a missing or changed entry never falls back to a
built-in.

For example, `"Codex · work": {"type": "codex", "args": ["--profile", "work"]}` uses the Codex adapter with the
`work` profile. Provider configuration remains native (CONFIGURATION-5). There is no Facade `baseUrl`, `apiKey`,
provider generator or generated key-helper mechanism.

| User input | How the adapter keeps both user and Facade integrations |
| --- | --- |
| Claude `--mcp-config`, `--plugin-dir`, `--allowedTools` / `--allowed-tools`; Pi `-e` / `--extension` | Use native additive behavior where verified; otherwise merge before passing one effective input |
| Claude `--settings` | Merge user settings first, then Facade-owned fields; preserve unrelated settings and user rules |
| Antigravity `--settings` / `-settings` | Merge in argument order, replacing each named top-level key; then add the run's tools permission and tracked title command |
| Codex or Muse `-c hooks` | Merge user hooks with Facade's session hook |

Verify repeated-option behavior with the supported CLI; do not assume repetition appends. The merged Claude or
Antigravity settings go into a per-run file with mode 0600 on POSIX. On Windows, Facade sets no access control list;
the file inherits its folder's permissions. CONFIGURATION-1.3 describes the default profile's protection and the
private-folder requirement for another `FACADE_HOME`. Pass `--settings <file>`, not inline JSON containing values.
The file follows 2.2's cleanup rules. CONFIGURATION-5.1 owns Claude's environment mirroring, the two null exceptions,
and checks against settings that reintroduce a removed variable, including the entry's own `--settings` input.
These checks can refuse a launch; optional tool or identity integration failures do not bypass them.

Every Antigravity launch passes one `--settings <file of the run>`, even when the file contains only `{}`.
Read each user occurrence in argument order: `--settings`, `-settings`, and either spelling with `=`. Each replaces
the top-level keys it names. For example, a later `{"theme": "light"}` replaces an earlier `theme` but keeps other keys.
Then add Facade's tools permission if the run has the tools, and its title command if the session is tracked.
An unreadable or invalid user settings value is a configuration error at that argument's path, as for Claude.
If Antigravity's own settings file cannot be read, identity tracking is unavailable; the per-run settings file is
still made with the person's settings and any active tools permission.

`type: custom` starts its literal command and arguments with 1.2's shared environment, including `FACADE_AGENT` and
cleanup. It gets no Facade tools, skill, trust or YOLO mapping, no model/effort override, no input or screen reader,
and no native history integration. An ordinary message or first task fails as `unsupported` without stopping the
program's launch; direct text and keys still work. Startup completes when the process starts. Without an activity
report its state stays unknown, not an integration error (CONFIGURATION-2.3).

## 4 Inspection and design

### 4.1 Show Agent Launch...

**Show Agent Launch... displays a start's effective launch and actual known choices without running a CLI.**

Show executable/environment source, cwd, literal argument order, resulting YOLO, native sandbox/approval facts, how the
folder is trusted and configuration errors. It includes the arguments and variables the Facade tools (2.2) and session
tracking (2.4) add at a start, in their literal order, without writing any launch file to show them: a value that exists
only once a start makes it - a generated path or session ID - appears as a named placeholder, and what cannot be planned
without writing files is said in words. Use one launch configuration and RULES-4.3's YOLO source. A chosen inspection
location is not an API launch default. Apply CONFIGURATION-4.2: show the person's environment names and sources,
never their values. Show Facade's constants; values generated for each run keep their placeholders.
When Claude or Antigravity receives a per-run settings file, also show that file's JSON with the person's environment
values and other secret values hidden, and per-run values replaced by placeholders. This preview writes no file.
Redact generated arguments and files structurally before serialization, including nested values from the person's
environment; hide
sensitive user arguments in separate, equals and configuration-assignment forms. Do not log raw full argv or invent
invalid-plan defaults. Where 3.3 withholds trust for a broad folder, or the CLI's
trust file does not exist, say that no trust entry is written and the CLI asks in its terminal, instead of claiming an
entry will be written. The document does not certify observed behavior of a process never started.

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
trust/template machinery. A run keeps safe metadata - its entry name and type, location, YOLO, requested model and effort, version and
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
| 1.1–1.4 | Destination discovery, independent entries, unknown-version launch, OpenCode below version 2 refusal, disabled entries, matching PATH/env/quoting, missing references fail only in entry env and expand to empty in terminal/profile layers, Windows duplicate names, launcher recognition and cmd.exe refusals, native permissions, request/entry/native model-effort precedence |
| 2.1–2.3 | Adapter evidence, input readers that read only the box around the cursor, on recorded screens of several versions, unrecognized layouts untouched, direct versus ordinary input, the person's submitted text read before Enter, pre-approved Facade tools and Muse Code's own approvals, optional server, owned-file cleanup, startup until the first activity and the tools' connection or its bound - a reload too - then red where not ready, terminal and report titles rejected for each built-in (2.3), Muse Code's screen reader on its fixtures and its reports' precedence |
| 2.4 | Each built-in's native history, exact resume, session changes and Pin from a start with session integration, on reader fixtures and isolated native checks; native-title refresh at 2.4's read times, its cache and its retention across reattachment, as VERIFICATION U14 checks |
| 3.1–3.4 | Literal arguments, reserved-option tables and aliases, short clusters and attached values, Go single-dash options, end marker versus a required value, parent/child config conflicts, per-CLI dash-prefixed values read consistently by validation/migration/settings extraction/list merging/hook merging, additive integrations and settings/hooks merges, run settings with POSIX 0600 and inherited Windows permissions, Antigravity's file with and without tools or identity tracking, Claude null conflicts, custom-program limits, native prompt mapping, folder trust and user configuration preserved |
| 4.1–4.2 | Show Agent Launch describes and redacts the configured launch and run-settings JSON, writes no preview files, and says where no trust entry is written; staged cwd validation |
| 5.1–5.2 | Fresh versioned fixtures plus isolated real CLI probes; no claim inferred from a dated observation |

See [Verification](VERIFICATION.md). Never probe a real CLI in the owner's state directory; never run Qwen probes.
