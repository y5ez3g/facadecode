# Configuration

Facade reads its settings from one file: `facade.json` in the Facade home. Edit it to choose how agents start, add another
setup for a familiar CLI, or run a different program. An empty object uses the defaults:

```json
{}
```

Layer 3. This document owns the file, fields, validation and migration. [CLI integrations](../engineering/CLIS.md)
owns native invocation and environment handling. [Lifecycle](LIFECYCLE.md) owns the pickers and launch flow.

| Group | Decides |
| --- | --- |
| 1 The settings file | Location, editing, creation and top-level fields |
| 2 CLI entries | Names, fields, capabilities and icons |
| 3 Starting an agent | Arguments, environment, model, effort and restoration |
| 4 Errors and private values | Which starts are blocked and what Facade shows |
| 5 Using another API | Native Claude Code, Codex and other CLI configuration |
| 6 Moving earlier settings | What moves, conflicts and the one-time notice |

## 1 The settings file

### 1.1 One file per Facade home

**Windows using the same Facade home in an execution environment read the same `facade.json`.**

The default path is `~/.facade/facade.json`. Facade: Home (`facade.home`) overrides `FACADE_HOME`, which overrides
`~/.facade`; ARCHITECTURE-3.1 owns the home and its reload behavior. Local windows use the local file. Remote SSH,
WSL and container windows use the file in their execution environment. This file is separate from the editor's
settings and Settings Sync.

The format is JSONC: JSON with comments and trailing commas. `{}`, an empty file, or a file with only spaces or
comments means the defaults. An unfinished comment, invalid character or incomplete JSON is still an error (4.1).
A UTF-8 byte order mark at the start is ignored. Error positions count CR LF, LF and CR as line endings.
For example, this is a complete settings file:

```jsonc
{
  // Ask for the CLI's normal approvals on future starts.
  "yolo": false,
}
```

### 1.2 Open and edit

**Open Settings opens Facade Code's Settings section, or facade.json for remote windows whose Settings open as JSON.**

Open Settings opens the Remote tab in a remote window and the User tab locally. If `workbench.settings.editor` is
`json` in a remote window, it opens the remote facade.json directly through Open facade.json: the editor would
otherwise show the remote settings JSON without Facade Code's section or its file link. Locally, the editor still
shows the requested section even with that preference. The menu, Command Palette, New Agent row gears and items
all use this path. The unusable Facade: Home error's button still opens the setting itself: for a remote JSON user,
that is the remote editor settings JSON at `facade.home`.

| Entry | Where it appears |
| --- | --- |
| Open Settings (`facade.openSettings`) | The panel's `…` menu and Command Palette |
| Open Settings gear | Each Unavailable row in New Agent |
| Open Settings item | New Agent when configuration fails or no usable CLI is available |
| File-problem row, choosing Open Settings | Resume Agent when the file is wrong as a whole |
| Edit in facade.json | Facade: Home's description and notifications about file errors |

The Settings page has one section, **Facade Code**, with **Facade: Home** (`facade.home`, machine scope), whose box
shows `~/.facade`. Its description explains the home and links **Edit in facade.json** to
`facade.openSettingsFile`, titled **Open facade.json**. That command creates the file under 1.3 if missing and opens
it. A remote window opens the remote file. A migration conflict shows 6.2's error and opens the old editor settings
JSON where the values need correction, remotely in a remote window.

The 0.1.2 editor settings remain registered for migration and say **Moved to facade.json**. Unset legacy keys are
hidden; set ones appear deprecated. There is no separate form, Add CLI action or Reset button; writing `{}` restores
the defaults.

Editor validation, completion and hover help use `media/settings.schema.json`, associated with `**/facade.json`,
locally and remotely, including custom homes. The schema permits comments and trailing commas. A built-in entry
without `type` gets help for its implicit type. The schema checks entry names against 2.1 while they are typed.
It underlines a bad name with: "A CLI's name needs a visible character, no space at either end and no control
character, and it cannot be a built-in CLI's ID or name in any letter case." Facade's own reader gives the exact
reason. Effort suggestions are not an enum: another nonblank string is valid.

For example, with Facade: Home set to `/tmp/facade-test`, Edit in facade.json opens `/tmp/facade-test/facade.json`.

### 1.3 Creating the file

**Facade writes settings only when creating a missing file.**

The first read, Open facade.json, and any later read that finds the file missing use one creation step. With no
0.1.2 settings to move, the file starts with `yolo: true`, then `names` with the 140 built-in names. Next come comments
listing the eight entry fields and explaining why Facade adds options, then `clis`.

Each of the six built-ins shows `type` and `icon` set to its ID, `args: []`, `env: {}` and `enabled: true`.
`command`, `model` and `effort` are commented out with sample values; OpenCode has one comment saying model and effort
belong in its own configuration instead. Each `icon` has `// or values on line N`, where N is the field list's icon
line. A migrated value is written out over its sample. An explicit `null` stays `null`, including in `args`, `env` and
`enabled`; only an absent field takes its default.

Comments explain tools, session tracking, folder trust and launch settings, followed by each built-in's additions,
YOLO behavior, model and effort handling, and how its arguments and environment are combined with Facade's.
Three commented examples follow the built-ins:

| Entry | What it demonstrates |
| --- | --- |
| `Claude · Other` | Another Anthropic-compatible provider through `env`, with `icon: facade-blue` |
| `Codex · Other` | Another Responses provider defined and selected through `args`, with its key in `env` and `icon: facade-lime` (5.2) |
| `Aider` | `type: custom`, `icon: facade-pink`, `command: aider` and `args: ["--model", "sonnet"]` |

The provider examples use `YOUR_PROVIDER_URL` and `YOUR_API_KEY`, give OpenRouter and Qwen Cloud samples in comments,
and use DeepSeek V4.1 Flash as the sample model. To use one, remove its outer `//`, replace both placeholders and
check the provider's model names. Inner explanations remain comments. Trailing commas let any combination of the
examples be uncommented together.

A key written into the file is stored there in plain text. `${env:NAME}` reads it from the editor's environment and
keeps it out of this settings file. Facade does not add the key to the command line. CLI-specific handling still
applies: Claude's private run file holds the expanded environment under 5.1, and Codex's `env_key` uses the process
environment under 5.2.

If released settings exist, group 6 moves them over these defaults. Saved values win, including invalid values that
need correction. Added entries follow the six built-ins, before the commented examples, in their migration order.
An existing file, including an empty one, is never regenerated or reformatted.

Creation is atomic and never replaces a file that another window or the person created first. On POSIX, both the
temporary file and the final file have mode 0600: only the current user can read and write them. On Windows, Facade
sets no access control list. Files inherit their folder's permissions. At the default root, `%USERPROFILE%\.facade`,
privacy comes from the user profile's permissions. A `FACADE_HOME` elsewhere must be a folder only its user can read.

A failed write reports the reason and leaves no partial settings file. It is not treated as a successful creation or
as permission to use defaults. If the file disappears between creation and reading, retry creation and reading once.

For example, if two windows try to create the file, one creates it. The other reads that file. It does not overwrite
it or show a second migration notice.

### 1.4 Top-level fields

**The file has four optional top-level fields: `yolo`, `names`, `clis` and `$schema`.**

| Field | Accepted value | Default | Meaning |
| --- | --- | --- | --- |
| `yolo` | Boolean | `true` | `true`: each CLI's no-approval mode, and the agent's Facade tools reach every agent in Facade windows on this computer. `false`: each CLI's own approvals and sandbox, and the tools reach only the agent's own creation tree. Applies to agents started afterwards (RULES-4.3, CLIS-1.3). |
| `names` | Array of nonblank strings, trimmed | The 140 built-in names | Suggested and blank agent names; an empty or exhausted list falls back to the agent ID (LIFECYCLE-2.1) |
| `clis` | Object | `{}` | Changes built-ins or adds named CLI entries (group 2) |
| `$schema` | String | Omitted | Editor metadata; Facade checks its type but does not use its value |

`names` trims each string. A non-array value, a non-string member or a blank member blocks every start with its file
position; no invalid member is skipped. LIFECYCLE-2.1 owns choosing and saving agent names.

YOLO is one setting for the execution environment, with no per-entry or per-call override. `false` uses each CLI's own
approvals and sandbox where it has them. Pi has neither, so it runs the same either way.
The exact native mappings live in CLIS-1.3. There is no tools or collaboration switch (RULES-4.4).

Facade uses the same words in this file, its APIs and documentation: `cli`, `command`, `args`, `env`, `model`,
`effort`, `icon`, `names` and `yolo`. Facade-owned field names use snake_case; these fields each happen to be one word.
Native CLI keys keep their native spelling.

For example, `{"yolo": false, "clis": {"pi": {"enabled": false}}}` uses normal native permissions and hides Pi from
new starts. The six built-in entries still exist when `clis` is empty.

## 2 CLI entries

### 2.1 Names are IDs

**A key in `clis` names one launch setup, and that name is its CLI ID everywhere.**

| Key | Meaning |
| --- | --- |
| `claude`, `codex`, `agy`, `muse`, `opencode`, `pi` | Change that built-in; omitting the entry restores its defaults |
| Any other valid name | Add an independent entry with a required `type` |

Names are case-sensitive. They can contain Unicode, spaces and punctuation such as `·`. They need a visible character, have no
leading or trailing whitespace, and contain no control characters. An added name cannot match a built-in ID or display
name without regard to case: the six IDs above, Claude Code, Codex, Antigravity, Muse Code, OpenCode and Pi.
`claude` itself changes the built-in; `Claude`, `CLAUDE` and `Claude Code` cannot name a new entry.
The editor schema enforces the same name rules as the reader (1.2).

New Agent, Resume Agent, `list_agents`, `start_agent.cli` and launch inspection use this ID. It is separate from an
agent's display name. Built-ins appear in CLIS-1.1 order, then added entries in file order; New Agent can put the
last successful choice first under LIFECYCLE-1.1.

For example, `"Codex · work": {"type": "codex"}` adds a second Codex setup. It inherits nothing from the `codex`
entry, including its command, arguments or disabled state. `"CODEX"` is not an available name for a new entry.

### 2.2 Entry fields

**Each entry accepts these eight fields, with the same meaning for built-in and added names.**

| Field | Accepted value | Default |
| --- | --- | --- |
| `type` | `claude`, `codex`, `agy`, `muse`, `opencode`, `pi`, `custom` | Built-in name: that type, and no other; added name: required |
| `icon` | One built-in ID or robot value in 2.4 | The type's icon; `facade-pearl` for `custom` or a missing/unknown type |
| `command` | One nonblank program name or path | The type's command on PATH; required for `custom` |
| `args` | Array of literal strings, including empty strings | `[]` |
| `env` | Object mapping variable names to strings or `null` | `{}` |
| `model` | Nonblank string; an error for `opencode` and `custom` | No Facade override |
| `effort` | Nonblank string; an error for `opencode` and `custom` | No Facade override |
| `enabled` | Boolean | `true` |

`command` is one executable, not a shell command line. A name without a path separator is searched on PATH.
An absolute path is exact; `~/` uses the execution environment's home; a relative path starts at the agent's working
folder. CLIS-1.2 owns executable checks and Windows launchers. An empty or whitespace-only command is an error.

Command, argument, model, effort and environment strings contain no NUL: these values go into a process's arguments
or environment. An environment name is not empty and contains neither `=` nor NUL. On Windows, two names in the
same `env` object that differ only in case are an error.
`null` is accepted only as an environment value. Unknown fields are errors, including `tools`, `baseUrl` and
`apiKey`; each API is configured through its native CLI settings (group 5).

A built-in entry may repeat its own `type`. Another type is an error asking the person to set it back or remove the line.
A wrong `icon` is an entry error with its field path, like other invalid fields.

`enabled: false` hides a valid entry from New Agent and refuses explicit starts and restoration. Running agents stay
as they are. Configuration errors are checked before `enabled`: an invalid disabled entry appears under Unavailable
with its error (4.1), while a valid disabled entry is not listed.

For example:

```json
{
  "clis": {
    "codex": { "command": "/opt/homebrew/bin/codex" },
    "pi": { "enabled": false }
  }
}
```

### 2.3 What the type gives you

**A built-in type uses that CLI's adapter; `custom` starts an ordinary terminal program.**

| Capability | Built-in type | `custom` |
| --- | --- | --- |
| Startup | Adapter invocation using this entry's settings | `command` and `args` with the shared environment handling |
| Facade tools and skill | Injection on every start; actual failures are reported under CLIS-2.2 | No injection |
| Trust and YOLO | The adapter's native mappings | No mapping or trust change |
| Messages and first task | The adapter's supported input path | Fail as `unsupported`; the program still starts |
| Direct text and keys | Available through the terminal | Available through the terminal |
| Model and effort | The supported fields in 3.3 | Neither |
| Status | Native reports or a verified reader | Unknown without a report; no missing-status red dot |
| Resume and Pin | The adapter's supported conversation integration | Neither |

Capabilities reflect the adapter, installed version and platform (CLIS-2.1). Labeling an arbitrary program `codex`
does not make it understand Codex's options. A custom program still gets common environment cleanup and
`FACADE_AGENT` under CLIS-1.2. Its own error report or abnormal exit can make its card red. It does not wait for
activity or tools to finish startup.

For example, this starts Aider with its own arguments. Facade does not interpret `--model` for a custom program:

```json
{"clis": {"aider": {"type": "custom", "command": "aider", "args": ["--model", "sonnet"]}}}
```

### 2.4 Entry icons

**An entry's `icon` chooses its image; without it, the entry uses its type's icon.**

The built-in values are `claude`, `codex`, `agy`, `muse`, `opencode` and `pi`. The 16 robot values are `facade-red`,
`facade-orange`, `facade-amber`, `facade-lime`, `facade-green`, `facade-teal`, `facade-sky`, `facade-blue`,
`facade-violet`, `facade-pink`, `facade-aurora`, `facade-sunset`, `facade-ocean`, `facade-orchid`, `facade-pearl` and
`facade-graphite`. A `custom` entry, or one whose type is missing or unknown, defaults to `facade-pearl`.

| Surface | How it draws the icon |
| --- | --- |
| New Agent, Resume Agent, Go to Agent | A built-in logo image or `media/agents/robot-<color>.svg` |
| Terminal tab | A contributed `facade-cli-<id>` glyph in the theme's text color, or `facade-robot-<color>` from `media/robots.woff` |
| Panel card | A built-in's maker avatar or `robot-<color>-face.svg` with `robot-eyes.svg` over it (PANEL-1.3) |

The icon is read from the file when shown. Saving, creating or removing facade.json refreshes the panel cards, so
a changed icon appears at once. If an agent's entry is gone, its CLI ID chooses a built-in's own icon when
it matches one, otherwise `facade-pearl`. For example, `Codex · work` with `type: codex` shows Codex's icon by default;
adding `icon: facade-blue` gives it a blue robot.

Robots are round gradient faces with a shine and two black eyes. `scripts/robot-icons.py`, using fontTools 4.60.1 for
asset maintenance only, writes all 16 picker images, the card faces and eyes, and the tabs' COLR v1 font at U+E200–U+E20F.
PANEL-1.3 owns eye motion. ARCHITECTURE-1.2 owns terminal icon integration.

## 3 Starting an agent

### 3.1 Literal arguments

**`args` adds literal CLI arguments without a shell or placeholder expansion.**

The strings keep their order. An empty string is an argument too. `${env:NAME}`, `~` and shell syntax in an argument
stay literal. Put environment references in `env`, not `args`.

For built-in types, Facade keeps control of permissions, model and effort, working folder, conversation, interactive
terminal and first task. Arguments that replace those choices are errors. CLIS-3.1 owns the per-type reserved options,
aliases and configuration paths. It also distinguishes option values from subcommands: `--profile resume` names a
profile and is not a resume command. Validation, migration and integration merges share CLIS-3.1's rules for which
arguments belong to an option. Custom programs receive their arguments unchanged.

User integrations remain possible. Claude's MCP files, plugins and allowed tools, and Pi's extensions, combine with
Facade's. Claude and Antigravity settings and Codex and Muse hooks are merged where required (CLIS-3.4).

For example, `"args": ["--profile", "work"]` is valid for Codex. Use `"model": "my-model"`, rather than
`"args": ["--model", "my-model"]`, to choose its model. A custom program can use that same `--model` argument.

### 3.2 Environment values

**An environment string sets a variable, `null` removes it, and an omitted name inherits it.**

Discovery and launch use one environment and one working folder. CLIS-1.2 defines this order:

| Order | Source |
| --- | --- |
| 1 | Execution extension host environment |
| 2 | The destination folder's `terminal.integrated.env.<platform>` |
| 3 | The selected default terminal profile's configured `env` |
| 4 | This entry's `env` |
| 5 | Facade's run variables and final cleanup |

Only `${env:NAME}` is expanded, only in environment string values. It reads the execution host's environment,
not another value in this object or an earlier terminal layer. A missing reference in the entry's `env` makes that
entry unavailable. In the editor's terminal and default-profile `env` layers, missing references expand to empty
strings, as VS Code's terminal reads them (CLIS-1.2).
An existing empty variable expands to an empty string. Expansion runs once; inserted text is not expanded again.
There is no `$${env:...}` escape syntax. Windows compares environment names without regard to case.

For example, `"env": {"API_TOKEN": "${env:WORK_TOKEN}", "OLD_TOKEN": null}` reads `WORK_TOKEN` from the host
and removes `OLD_TOKEN`. Adding `"WORK_TOKEN": "abc"` to this same object does not supply that reference.
Claude has two explicit null-to-empty exceptions, and checks for native settings that reintroduce a removed variable
(5.1). Other variables retain the deletion meaning.
Claude's run settings also preserve layer 5: if the entry or its own `--settings` names a variable Facade sets last,
the file uses the run's value. A variable the run removes is left out, as 5.1 describes.

### 3.3 Model and effort

**A choice in this start wins over the entry's field, which wins over the CLI's own configuration or saved session.**

Each field is independent. If neither the current request nor the entry supplies it, Facade adds no override.
On Resume, the native saved session may supply a value different from the CLI's new-session default.
Past requested values are diagnostic records, not defaults or proof that a model accepted them.

| Type | Model | Suggested effort values |
| --- | --- | --- |
| `claude` | Native model name | `low`, `medium`, `high`, `xhigh`, `max`, `ultracode` |
| `codex` | Native model name | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` |
| `agy` | Native model name | `low`, `medium`, `high`, `xhigh`, `max` |
| `muse` | Native model name | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra` |
| `pi` | Native model name, including `provider/model` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `opencode` (supported 2.x) | Not available | Not available |
| `custom` | Not available | Not available |

Suggestions help editing; they do not restrict other nonblank strings or certify model support. CLIS-1.4 owns the
native argument mapping and platform limits. Claude's `--effort ultracode` requests `xhigh` with ultracode enabled;
it requires Claude Code 2.1.203 or later, a compatible model and the native feature to be available.

For example, `"codex": {"model": "my-model", "effort": "high"}` supplies both choices. A start requesting
`effort: "low"` changes only the effort for that run. The entry's model still applies.

### 3.4 Changes and restoration

**A change applies to agents started afterwards, including Resume and Pin; an agent that is already running keeps how it was started.**

Saving the file does not change the arguments, environment or YOLO of a running agent. New Agent, MCP starts,
Resume and Pin restoration share the current configuration path. Resume and Pin start the original entry with its
current command, arguments and environment, and the destination's current YOLO. Model and effort follow 3.3.

Facade records the entry name and type with the run and its conversation association. It keeps requested model,
effort and YOLO for diagnostics, without environment values or their expansions. Those historical requests do not
become explicit choices on restoration. If the original entry is gone, disabled or has a different type, restoration
fails with the reason. It does not choose a built-in or another entry instead. Conversations with no Facade entry
association use their native built-in. If that built-in's current launches keep conversations in another folder, the
conversation is unavailable with that reason; it is not offered as a resumable choice through another entry.
Resume checks whether this entry's launch in the conversation's own folder finds the store containing it. That
launch uses the innermost workspace folder's settings and the CLI's own settings in the conversation's folder,
such as Pi's `.pi/settings.json` naming another session folder. Another folder whose launches find the store is
not enough, including an enclosing folder. Apply the same check to every working folder Resume offers to choose.
Store paths name the same folder when they match directly or with links resolved; comparisons ignore case on
Windows and macOS. A window folder opened through a link does not by itself make its conversations unavailable.
A custom program has no conversation integration (CLIS-2.4).

Resume and Pin restoration carry the original built-in type all the way to final launch planning. This includes a
Pin saved before its CLI named a conversation. If the entry's type changes after listing but before planning, the
start is still refused. For a Pin without a conversation, explain that the entry now runs another CLI:
`This agent ran X; it cannot be restored with it.`

For example, changing `Codex · work` to `Codex · personal` does not rename the CLI ID saved with an old conversation.
Restoring that conversation reports the missing `Codex · work` entry. RULES-4.2 and LIFECYCLE-3 own the rest of Resume
and Pin behavior.

## 4 Errors and private values

### 4.1 Explain the error at its source

**File errors block all starts and restoration; entry errors block only that entry.**

| Scope | Errors | Example |
| --- | --- | --- |
| Whole file | Unreadable file; invalid JSONC; duplicate keys at any depth; root is not an object; unknown top-level key; wrong type for `yolo`, `names`, `clis` or `$schema`; non-string or blank `names` member | `{"yolo": "false"}` blocks all starts |
| One entry | Invalid name; non-object entry; unknown field; wrong type or invalid value; missing or mismatched type; missing custom command; reserved argument; unsupported model/effort; missing reference in the entry's own `env`; unavailable program | `{"clis": {"codex": {"args": [42]}}}` leaves other entries usable |

Do not guess a correction, use stale settings or replace a bad value with a default. Only a missing file enters
creation or migration. A file that is empty or has only spaces or comments follows 1.1. Running processes are
unaffected by these errors.

New Agent, Resume, Pin restoration and `start_agent` use the same validation and reason. Configuration errors come
before the disabled check. New Agent lists invalid entries under Unavailable, even when `enabled` is false, and
offers Open Settings. With a file-level problem, Resume Agent reads no conversations: it shows one row per problem,
labeled by the file, with the reason as detail, a gear icon and an Open Settings gear button as in New Agent.
Choosing the row or its button runs Open Settings. It does not show
"No saved conversations in this window's folders" for a bad file. An entry's own error leaves its conversations out
of the list. A valid disabled entry is hidden. LIFECYCLE-1.1 owns how missing
installations and valid disabled entries are displayed. File errors give the file path, and line and column when
known. An I/O error gives its real reason instead of invented line numbers.

Entry errors name the path, expected type and correction, never the supplied value. The “is not a field of an entry”
and “must be an object of” errors list fields in file order: `type`, `icon`, `command`, `args`, `env`, `model`,
`effort`, `enabled`. For example:
`clis["Codex · work"].args[2] must be a string.` Discovery and final launch validation use the actual destination
folder and environment; new worktree paths follow CLIS-4.2's staged checks.

### 4.2 Keep private values out of Facade output

**Facade shows the names and sources of the person's environment variables, never their values; the fixed values Facade itself sets are shown.**

The person's values come from the execution host environment, `terminal.integrated.env`, the terminal profile's
`env`, or the entry's `env`. Errors, logs, diagnostics, API listings and Show Agent Launch show only their names and
sources. This includes their values embedded in generated arguments or files: redact the structured values before
serialization. Facade's own constant values are shown, such as `TERM_PROGRAM=vscode`, `COLORTERM=truecolor` and
`CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL=1`. Values Facade generates for each run, such as its run ID, launch context and
ptyd socket, keep their placeholders. Do not log a raw full command line.

Arguments can be shown after redaction. An option or configuration key is treated as secret when its name contains
`key`, `token`, `secret`, `password`, `passwd`, `passphrase`, `auth`, `credential`, `cookie` or `bearer`, without regard
to case. A name ending in `pat` or `pass` after `-`, `_` or `.` also counts: `GH_PAT` and `DB_PASS` do; `BYPASS` does not.
Hide the value even if it is a number. Cover separate values, `--name=value`, and native configuration assignments.
A secret option also hides its next argument when that value starts with one dash. For example, `--api-key abc`,
`--api-key=abc`, `-c service_token=abc` and `--token -abc` all hide their values.
This is not a promise to recognize every secret format an arbitrary custom program accepts.

When a launch passes a per-run settings file, Show Agent Launch also shows its JSON. This applies to Claude and
Antigravity. Hide the person's environment values and other secret values inside it, and use placeholders for
per-run values, just as in the arguments. The preview does not write the file (CLIS-4.1).

Generated settings that contain secrets go in per-run files with 1.3's access rules, with paths passed to the CLI
(CLIS-3.4).
Facade does not put those generated secrets inline in argv. This does not stop a program running as the same user
from reading its environment or accessible files. Native CLIs can also make their own copies; file permissions alone
do not describe parent-directory access or every platform's access controls.

## 5 Using another API

### 5.1 Claude Code

**A Claude entry uses Claude's environment and native settings for another Anthropic-compatible API.**

For example, replace the address and model names below with ones supported by the chosen service:

```json
{
  "clis": {
    "Claude · work": {
      "type": "claude",
      "model": "my-large-model",
      "env": {
        "ANTHROPIC_BASE_URL": "https://api.example.com/anthropic",
        "ANTHROPIC_AUTH_TOKEN": "${env:WORK_API_KEY}",
        "ANTHROPIC_API_KEY": null,
        "ANTHROPIC_DEFAULT_OPUS_MODEL": "my-large-model",
        "ANTHROPIC_DEFAULT_SONNET_MODEL": "my-large-model",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL": "my-small-model"
      }
    }
  }
}
```

| Value | Why it is present |
| --- | --- |
| `ANTHROPIC_BASE_URL` | The service's Anthropic-compatible endpoint |
| `ANTHROPIC_AUTH_TOKEN` | Its bearer token; this example reads a host variable |
| `ANTHROPIC_API_KEY: null` | Removes the person's inherited Anthropic API key |
| All three default-model variables | Maps Claude's aliases and subagent choices to models the service knows |

Facade also writes this entry's string environment values into the run's Claude settings `env`. Otherwise Claude's
own settings files can override them. Null values are handled as follows:

| Variable set to `null` | Per-run handling |
| --- | --- |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` | Remove from the launch environment and write an empty string in the run's settings; these are the two tested exceptions where Claude treats empty as unset |
| Any other variable | Remove from the launch environment; do not turn it into an empty string or put JSON null in Claude's string-only `env` |

For the second row, refuse the launch if native settings would add the variable again. Check `settings.json` under
the actual `CLAUDE_CONFIG_DIR`, the working folder's `.claude/settings.json` and `.claude/settings.local.json`, and
the entry's own `args --settings` input. Name the variable and the source file or argument path, without its value.
For example, a variable reintroduced by that input is reported at `clis["Claude · work"].args[1]`.
Managed administrator policy files are outside this check. Adding another null-to-empty exception needs specific
native evidence. Facade does not edit the person's global settings to resolve a conflict.

On Windows, these checks compare names without case, including the two key exceptions. The run settings hold one
name per variable, with the higher-priority source's value. For example, `anthropic_api_key: null` must also clear
`ANTHROPIC_API_KEY` from the person's `--settings`.

Facade finishes the file after it has the run's final environment. If the entry's `env` or the person's `--settings`
names `FACADE_AGENT`, `FACADE_CODE_SESSION_FILE`, `TERM_PROGRAM`, `COLORTERM` or another variable set last by the tools
or session integration, the file holds the run's value. A removed variable, such as `ELECTRON_RUN_AS_NODE`, is left
out, never written empty. Only names already present in the merged settings are changed this way. For example,
`FACADE_AGENT: "#a999"` becomes the current run's alias. This final-value pass does not inspect Claude's own user,
project or local files; those files are checked for removed variables as described above.

User `--settings` input and Facade's settings are merged under CLIS-3.4 and passed in a file with 1.3's access rules.
Someone who prefers a native `apiKeyHelper` can put it in a Claude settings file and select it with
`args: ["--settings", "path"]`.
Facade does not answer Claude's API-key confirmation or write its answer to `~/.claude.json`. The documented API
example uses `ANTHROPIC_AUTH_TOKEN`; a native API-key confirmation remains a terminal interaction.

### 5.2 Codex

**A Codex entry can define a provider in its arguments or select a native profile.**

Both routes use Codex's own provider settings. The endpoint must support OpenAI Responses; Chat Completions
compatibility alone is not enough.

The generated file's `Codex · Other` example needs no other configuration file. Replace `YOUR_PROVIDER_URL` and
`YOUR_API_KEY` and choose a model the provider serves:

```jsonc
"Codex · Other": {
  "type": "codex",
  "icon": "facade-lime",
  "model": "deepseek/deepseek-v4.1-flash",
  "args": [
    "-c", "model_provider=provider",
    "-c", "model_providers.provider.name=Provider",
    "-c", "model_providers.provider.base_url=YOUR_PROVIDER_URL",
    "-c", "model_providers.provider.wire_api=responses",
    "-c", "model_providers.provider.env_key=PROVIDER_API_KEY",
  ],
  "env": { "PROVIDER_API_KEY": "YOUR_API_KEY" },
},
```

| Field or option | What it does |
| --- | --- |
| `model` | The starting model; a model chosen for a particular start wins |
| `model_provider=provider` | Selects the provider defined by the following options |
| `model_providers.provider.name` | Gives the provider its display name |
| `model_providers.provider.base_url` | Sets the API address |
| `model_providers.provider.wire_api=responses` | Selects the Responses API format |
| `model_providers.provider.env_key=PROVIDER_API_KEY` | Tells Codex which environment variable holds the key; the argument contains its name, not its value |
| `env.PROVIDER_API_KEY` | Supplies that variable to the process |

These `-c` options apply to this entry's agents. They do not edit Codex's configuration files or change other Codex
entries. To keep the key out of Facade's settings file, replace `"YOUR_API_KEY"` with `"${env:PROVIDER_API_KEY}"` and make
that variable available in the editor's environment (3.2).

With `env_key`, the key is in the process environment. Codex's native shell snapshots may copy it. A profile using
`auth` keeps the key out of the environment instead:

```json
{"clis": {"Codex · work": {"type": "codex", "args": ["--profile", "work"]}}}
```

The profile is `work.config.toml` under the actual `CODEX_HOME`, normally `~/.codex/work.config.toml`:

```toml
model_provider = "work"
model = "my-model"

[model_providers.work]
name = "Work API"
base_url = "https://api.example.com/v1"
wire_api = "responses"
auth = { command = "cat", args = ["/absolute/path/to/private-key-file"] }
```

The key itself is not a TOML value in this example. `cat` works on macOS and Linux; Windows needs an appropriate
native command that returns the key. Do not combine `auth` with `env_key`, `experimental_bearer_token` or
`requires_openai_auth` in the same provider.

A readable key file is still readable by the agent; it is not isolation. Facade passes the person's native provider
configuration to Codex and adds no separate provider account or key store. A profile or flag being accepted is not
proof of a successful model request (CLIS-5).

### 5.3 Other CLIs and native ownership

**Each CLI keeps its own provider settings, login and native permission interactions.**

| Type | Where to configure another API | Example in the Facade entry |
| --- | --- | --- |
| `agy` | Native login and settings | `"args": ["--settings", "/path/to/agy-settings.json"]` |
| `muse` | Native `--base-url` for the Meta provider's address; `muse auth` stores the key | `"args": ["--base-url", "https://api.example.com/v1"]` |
| `pi` | Native provider key variables and `provider/model` | `"model": "openrouter/my-model", "env": {"OPENROUTER_API_KEY": "${env:WORK_API_KEY}"}` |
| `opencode` | Native `opencode.json` or `OPENCODE_CONFIG` | `"env": {"OPENCODE_CONFIG": "/path/to/opencode.json"}` |
| `custom` | The program's own arguments and environment | `"args": ["--config", "/path/to/program.json"]` |

Facade preserves native user settings and merges the integration pieces under CLIS-3.4. The only lasting changes
it writes into a CLI's own global settings are folder-trust entries, as CLIS-3.3 defines; the README explains this.
Project integration files have CLIS-2.2's ownership and cleanup rules. Neither API-key confirmation nor Claude's
first-use bypass prompt is silently accepted. Antigravity's newer sandbox option has no newly promised mapping here;
CLIS-1.3 states the supported mapping.

## 6 Moving earlier settings

### 6.1 What moves

**Only explicitly saved machine-level settings from released standalone-extension versions are migrated.**

Read them in the execution environment. Editor manifest defaults are not saved user values. Migration happens only
when the new file is missing; an existing file is the sole configuration source. Development-only `cli`, `baseUrl`
and `apiKey` fields from the unreleased custom-CLI design are not supported or migrated. The old IDE extension is a
different product and its settings are not migrated.

| Earlier VS Code setting | New file field |
| --- | --- |
| `facade.yolo` | `yolo` |
| `facade.<cli>.enabled` | `clis.<cli>.enabled` |
| `facade.<cli>.path` | `clis.<cli>.command`; omit an empty string |
| `facade.<cli>.launch.arguments` | `clis.<cli>.args`, with model/effort extraction under 6.2 |
| `facade.<cli>.launch.environment` | `clis.<cli>.env` |
| `facade.antigravity.*` | The matching fields under `clis.agy` |
| `facade.custom.<name>.path` | `clis.<name>.command`, with `type: "custom"` |
| `facade.custom.<name>.launch.start` | `clis.<name>.args` |
| `facade.custom.<name>.launch.environment` | `clis.<name>.env` |
| `facade.custom.<name>.launch.resume` | Removed |
| `facade.collaboration.enabled` | Removed; tools are injected on every adapted start |

Here `<cli>` is `claude`, `codex`, `muse`, `opencode` or `pi`; Antigravity has the separate row above.
Migration trims surrounding whitespace from a nonblank old path, as 0.1.2 did at launch. An empty built-in path means
the default command, so it is omitted. A path made only of spaces is kept unchanged for validation to report.
For example, `facade.codex.path: " /opt/bin/codex "` becomes `clis.codex.command: "/opt/bin/codex"`; an empty path
leaves Codex to be found on PATH. Model and effort extraction follows the native spellings and end marker in 6.2.

### 6.2 Preserve values and report conflicts

**Migration preserves old values, even invalid ones, unless a listed conversion applies.**

Recognizable model and effort options in built-in arguments move into their fields. This avoids making the previously
documented way to choose a model invalid on arrival. Parse each CLI's own argument grammar, including supported
aliases and `=` forms, using CLIS-3.1's option-value rules. A value belonging to another option is never extracted as
a choice. Short-option values may be attached, as in Codex's `-mgpt-5`. Stop extracting at an end-of-options `--`;
everything after it keeps its original position and meaning.

| Type | Model | Effort |
| --- | --- | --- |
| `claude` | `--model` | `--effort` |
| `agy` | `--model`, `-model` | `--effort`, `-effort` |
| `codex` | `--model`, `-m`, `-c` / `--config model=` | `-c` / `--config model_reasoning_effort=` |
| `muse` | `--model`, `-c model=` | `--reasoning-effort`, `--effort`, `-c reasoning_effort=` |
| `pi` | `--model` | `--thinking` |

Ambiguous or conflicting options stay in `args` and get the normal error. Custom-program arguments stay unchanged.
Apart from these conversions and 6.1's explicit omissions, values are not repaired, renamed or silently dropped.
An explicit `null` in any field is written as it was for the file's rules to report; only an absent field takes a default.
An invalid name, permission argument or wrong type is written to the new file and reported under 4.1. The notice
lists the affected paths and how to fix them.

If the old structure cannot be represented without losing something, create no file. Report all conflicting source
paths, leave the old settings untouched, and block new starts and restoration until the conflict is resolved.
This includes a non-object `facade.custom` and two old entries or fields that map to the same destination.

For example, `facade.codex.enabled` and `facade.custom.codex` would describe different CLIs under one new key.
Migration reports both paths instead of choosing one. A lone `--model my-model` in old Codex arguments, however,
can move to `model: "my-model"` without changing its meaning.

While this conflict lasts, New Agent, Resume, Pin restoration and `start_agent` give one file-level error listing every
conflicting path. Open facade.json, reached through Edit in facade.json, shows that error and opens the editor's
settings JSON where those values are.
Fixing them lets the next start migrate; creating the new file by hand also ends the conflict, because an existing
file is the only source.

### 6.3 Create once and explain the move

**The window that successfully creates a migrated file shows one notice with an Open action.**

Use 1.3's atomic, non-overwriting creation step and its access rules. The notice says that Facade's settings moved to
the actual settings-file path. It lists extracted model/effort options and the paths of values that need correction,
using 4.2's redaction.
It also lists each entry whose `env` references a host variable missing from the migrating environment. Version 0.1.2
used an empty string for a missing `${env:NAME}`; 3.2 reports an error, so the notice explains which entries need attention.
If the old collaboration switch was false, it also explains that Facade tools are now always added.
Other windows read the new file without another notice. With no saved old settings, creation writes 1.3's defaults,
comments and examples and does not claim that settings were migrated.

Old settings stay untouched and remain registered, but they no longer control launches.
The editor's Facade Code section shows Facade: Home with Edit in facade.json. Unset legacy keys are hidden;
a legacy key the person still has set appears there as deprecated, saying Moved to facade.json and linking to it.
Facade creates no backup or separate migration marker. Deleting the new file while old values remain causes another migration. For example,
to reset to product defaults, keep the file and write `{}` instead of deleting it.

## Checks

| Rules | Acceptance |
| --- | --- |
| 1.1–1.4 | Local/remote homes and facade.json paths; JSONC, duplicate keys, BOM and line positions; Open Settings on the User/Remote tab or directly to remote facade.json for JSON users, New Agent row gears, Edit in facade.json and Open facade.json; schema at default/custom homes; schema and reader agree on the same entry names; names absent, trimmed, empty and invalid; generated field order, samples, icon line references, all example combinations and migrated overrides; atomic creation races, one retry, write failures and permissions |
| 2.1–2.4 | All eight fields and defaults; names and reserved IDs; built-in type repeated or changed; valid and invalid icons; independent entries; NUL and Windows env duplicates; errors before disabled checks; capabilities; all built-in and robot icons on every surface, current-file selection, immediate card refresh on save/create/remove and removed-entry fallback; robot assets and COLR v1 font |
| 3.1–3.4 | Literal and empty arguments; reserved aliases, config parent/child paths and shared per-CLI option-value parsing; additive integrations; missing references fail in entry env and expand to empty in editor layers, existing empty values and one-pass expansion; matching discovery and launch; model/effort precedence; current settings and original-type checks on Resume/Pin, with and without a conversation; native store mismatch by a launch in the conversation's own folder, including its CLI settings and every offered folder choice; same-store comparisons through links and platform letter case; unchanged living processes |
| 4.1–4.2 | File and entry failures; Resume file-problem rows and their gear buttons open Settings without reading history; field-list error order; duplicate keys; identical UI/MCP errors and accurate paths; the person's environment values hidden, including generated nested values and previewed run-settings JSON; Facade constants shown and per-run values kept as placeholders; sensitive argument forms and numeric values hidden; no raw argv logs |
| 5.1–5.3 | Simulated endpoints and fake keys check protocol/authentication; Claude string overrides, both null exceptions, all four reintroduction sources, Windows case-insensitive precedence, final run variables and merged settings with 1.3's access rules; Codex provider options with env_key and a native profile with auth, including their different key storage; distinguish startup, tools and actual model responses |
| 6.1–6.3 | Each migration row; explicit values versus manifest defaults; path trimming and empty/blank paths; native option spellings, attached values and end marker; invalid-value preservation including explicit nulls; collisions with no file and a route to correct legacy settings; old settings unchanged and set legacy keys shown as deprecated; one notice across competing windows, including missing environment references; deletion re-migrates and `{}` resets |

These checks describe required evidence, not completed tests. [Verification](../engineering/VERIFICATION.md) owns the
recorded gates. Native CLI tests require isolated state and their own authorization; a spec audit runs none.
