# Rules

What Facade knows about each CLI it starts by name: the program and its arguments, how the CLI
reports and resumes its session, how its screen draws its input and state, and how Facade's tools,
hooks and integration enter it. It is its own island so that no other crate names a CLI: the
daemon and `facade` ask rules instead. Crate `facade-rules`, folder `core/crates/rules/`, rule
files in `core/rules/`. It is a library; it starts no program.

## Owns

- The rule files `core/rules/<cli>.json`, built into the program with `include_str!` and read once,
  on first use, into a `LazyLock`. `fake.json`, the test CLI's rule, is built into debug builds
  only.
- What each CLI's own files look like where Facade reads or writes them: its MCP settings,
  hook settings, plugin and extension files, and the integration entries in the person's settings.
- The variables in which each CLI names its session or marks its runs.
- The format of a run's session file.

## Keeps

- A rule's `cli` is its file's name, and no two rules share a program.
- A rule file is checked as it is read. If any file fails, every rule name fails in `find`, so a
  rule's name never runs as a program without its rule. Any other word, such as a path, selects no
  rule and runs as a program.
- No CLI name appears outside rules: what differs by CLI is in a rule file or behind a rules
  function that takes `cli`.
- Facade only recognizes and changes entries it wrote itself, in any CLI's files.
- No `cfg` by system. What differs by system is data, chosen by `facade_base::system::SYSTEM` at
  run time: each CLI's hook shell, `${folder_toml}`, console typing and the wrappers. On Unix,
  every command line, hook command, file and path is as it was before Windows.
- Every read of a variable of a CLI's environment goes through `facade_base::system::env_var`
  (names without case on Windows), and the home folder the CLIs use is
  `facade_base::system::home_folder_in` (Unix `HOME`, Windows `USERPROFILE`).

## Never does

- Connects to the daemon or holds runtime state.
- Starts a CLI, or decides when to type: it says what to type and what the screen shows.
- Chooses Facade's own paths: the run's folder and its session file are given by the caller.

## Interface

**daemon**
- `find(name) -> Result<Option<&'static Rule>, String>`, `rules()`: the rule a CLI name selects.
- `Rule`: the rule file as typed fields; `Rule::resume_args`, `Rule::remove_wiring_environment`.
- `start_command_line(rule, words, session, server, environment, yolo) -> CommandLine` and
  `resume_command_line(rule, id, …) -> Option<CommandLine>`: the run's command line, environment,
  files, plugin files and `Tools` (whether Facade's tools were given, and if not, why).
- `installed_version(rule, program)`: the version the installation names beside its program,
  read without running it.
- `entries`: the `clis` entries of `facade.json`.
- `direct_command(rule: Option<&Rule>, program, env, cwd) -> Vec<String>`: what starts `program`,
  the file a start's command resolved to. On Windows, Pi's and Muse Code's installers' wrappers
  start the CLI's own program; everything else is as base's `programs::direct_command` has it.
- `console_typing(rule) -> Option<ConsoleTyping>`, for the typist: on Windows, for a CLI that reads
  console input records, the wait before Enter for each UTF-16 code unit typed and whether
  characters above U+FFFF go as key-down records.
- The input, state, sessions and wiring functions listed under each child below.
- `session_meta_keys`, `always_load_keys`, `instructions_from_server`: what each CLI's MCP client
  does that the daemon's MCP server responds to.

**facade** (`facade hook …`, and finding the agent of a command's terminal)
- `hook`: what each CLI's hooks print and the keys their input uses, and `hook::title_command`,
  which runs the person's title command with the shell of the CLI that runs title hooks.
- `session_from_hook`, `session_from_title`, `write_session_file`, `run_folder`, `SKILL_FILE`,
  `INSTRUCTIONS_FILE`, `session_variable`, `SESSION_VARIABLES`.

**Scenario tests** (`core/tests`): `session_variable`.

## Depends on

- `facade-base`: `settings` (the `facade.json` model the entries read), `daemon` (`InputMechanism`,
  `InputInfo`, `InputState`, `HiddenRows`, `is_session_id`), `skill::text` and `version()` for the
  files a run and the plugin are given; `system` (`SYSTEM`, `env_var`, `home_folder_in`),
  `programs` (`direct_command`, `on_path`) and `files` (`private_options`, `is_private`,
  `sync_folder`), and `base64` for encoded PowerShell hooks.
- `facade-screen`: `ScreenView` and its cells, which the input and state readers read.
- serde, serde_json, regex, toml, sha2, unicode-width.

## Inside

The layer holds the rule-file format and the one step that needs two children: putting a run's
command line together. The children never use each other. They may use the layer's rule types,
`args`, `formats`, `find`, `rules` and `FILES`, read only.

- `lib.rs`: `Rule` and the type of each section, `parse` and the checks. Each section checks
  itself (`InputRule`, `PasteRule`, `Frame`, `Editor`, the three state mechanisms); `Rule` returns
  the first problem, naming the file. Also `find`, `rules`, `installed_version`, the MCP keys and
  `console_typing`. Every child's public items are re-exported at the crate root.
- `wrappers.rs`: `direct_command`, and the two wrappers it reads: Pi's `pi.cmd`, whole as Pi's
  installer writes it, starts its `pi-launcher.js` with the installer's own Node or a Node program
  on `PATH`; Muse Code's wrapper starts `muse-bin-<version>.exe` beside it, for the version and
  channel its installer chose. A file that is not exactly that is base's to start.
- `args.rs`: how a CLI reads its arguments, from the rule's `arguments` section. A `Reader` walks
  the words into pieces (option, override, positional, end of options). `problems` refuses
  options and settings keys (Codex's config keys) Facade sets itself in an entry's `args`; `found`, `overrides`,
  `holds` and `end_of_options` serve command_line and wiring.
- `formats.rs`: the CLIs' own text formats in one place: JSON with comments, shell words, TOML
  strings and inline values, and merging Facade's settings into the person's. `Shell` is the shell
  a CLI runs Facade's hook commands with: POSIX on Unix, and for Claude Code on Windows, whose
  Git Bash takes `'C:\…'` words as they are; cmd.exe for the other Windows CLIs except Codex. A cmd.exe
  command is `[set "NAME=value" && ]…@"<program>" <word> …`: it never starts with a quote, which
  `cmd /c` without `/s` would take away with the last one. A text cmd.exe cannot carry in quotes,
  one with `"` or a line break, never goes into one.
  Codex's Windows hooks use encoded UTF-16LE PowerShell scripts, carried unchanged through its
  session shell (normally PowerShell) or cmd.exe fallback. The scripts quote each argument as a
  PowerShell literal, preserve the exit code, and put `--skill` inside the encoded session hook.
  Integration recognizes these encoded hooks as well as the earlier shell forms for updates and removal.
- `compose.rs`: `start_command_line` and `resume_command_line`. In order:
  1. wiring gives the tools (`wire`), and YOLO's run settings are merged into the wiring's;
  2. wiring has the CLI report its session, through its settings (`report_session`) or a hook,
     plugin or extension (`install_hook`);
  3. the command: the program, the resume arguments, the rule's `launch.args`, YOLO's arguments;
  4. wiring merges the tools' and YOLO's settings with the person's own (`merged_settings`);
  5. the tools' arguments, the merged settings, the hook's arguments (a resume puts them right
     after YOLO's), then the person's words. An option that takes every value up to the next option never comes right before the person's
     words: then it goes after them, before their `--`.

**Rule files.** `core/rules/<cli>.json`, one per CLI. Unknown fields are refused. Patterns are
Rust regular expressions.

| Key | Says |
|---|---|
| `cli`, `display_name`, `program` | the name (same as the file), the name people know, the program on `PATH` |
| `launch.args` | literal arguments right after the program |
| `arguments` | how the CLI reads its arguments, and the options and keys Facade sets itself |
| `choices` | the arguments that give a model and an effort |
| `input` | the layout of the input box: `frame`, `prompt`, `editor`, `box` or `prompt_row` |
| `paste` | how long a paste shows before Enter, and the placeholders the CLI draws for it |
| `session` | `capture` (`session_start` or `none`) and the `resume` arguments with `${session_id}` |
| `status` | screen evidence of the state, for a CLI whose own reports fall short |
| `version_file` | the file beside the program that names its version |
| `ready_tools` | what to type so the CLI starts Facade's tools before its first turn |
| `mcp` | what the CLI's MCP client does: session `_meta` key, always-load key |
| `yolo` | YOLO's arguments, run settings, and the trust question to answer |
| `console` | on Windows, for a CLI that reads console input records: `per_char_ms`, the wait before Enter for each UTF-16 code unit, and `records_above_bmp` |

**Adding a CLI.** Write `core/rules/<cli>.json` and add it to `FILES` in `lib.rs`; its place there
is its place in `facade`'s lists. With a rule file alone, Facade starts the CLI and reads its
screen, but gives it no tools and cannot resume it: its `session.capture` must be `none`. To give
it Facade's tools, have it report its session, take an integration or answer hooks, add its case in
wiring: `wire` and `reports_sessions` in `wiring/mod.rs`, its builder and `unwire` in
`run_tools.rs`, `install_hook` in `session_report.rs`, `integration::CLIS` and its file kinds, and
the functions of `hook`. Its session variables go in `SESSION_VARIABLES` in `sessions.rs`. The tests
read every rule file, so a release never carries one that fails its checks.

### command_line

The parts of a CLI's command line that come from its rule and the person's settings: what YOLO
adds, the model and effort, the session a resume names, and the `clis` entries of `facade.json` (`command_line/`).

- **Owns:** the rule file's `yolo` and `choices` sections (`YoloRule`, `TrustQuestion`, `Choices`)
  and the `session.resume` placeholder `${session_id}`. It reads the `clis` table of
  `facade.json`, as `facade_base::settings` parsed it, into `Entry` values; it never writes it.
- **Keeps:**
  - A rule's `session.resume` names `${session_id}` exactly once and nothing else to fill in, so a
    resume puts the session ID in one place.
  - YOLO off adds nothing; YOLO on fills only `${folder}` and `${folder_toml}`. On Windows
    `${folder_toml}` is the folder with `A`–`Z` in lower case, as Codex keys a project there.
  - `${env:NAME}` in an entry is read through `env_var`.
  - Each choice in `choices` holds exactly one `${value}`, `${value_toml}` or `${value_json}`.
    When the person's own words already pick a model or an effort, the entry's choice is not
    added.
  - Each `clis` entry is read on its own and takes nothing from another. A mistake makes only
    that entry unavailable, and its problem names the setting path, never the value written.
  - A built-in's entry can't change its `type`. An added CLI's name can't be a built-in's ID or
    name, in any letter case.
- **Never does:** touch Facade's tools or session reports (wiring's job), read the screen, or
  write any file.
- **Interface:**
  - To the rules layer: `YoloRule::check`, `args(folder)` and `settings(folder)`;
    `Choices::check`; `check_resume(resume)` and `resume_args(resume, session)`. `compose` puts
    the YOLO arguments and settings on a command line; `Rule::check` and `Rule::resume_args` call
    the rest.
  - To daemon (`command_line.rs`), the `entries` module, used to read `facade.json`'s CLIs:
    `entries::read(&Settings) -> Vec<Entry>` (built-ins first in rule order, then added CLIs in
    file order) and `entries::find(&[Entry], name)`. Daemon also uses the `Entry` fields
    `kind`, `command` and `args`, and these methods:
    - `display_name()`;
    - `takes("model" | "effort")`;
    - `refused_choice(model, effort)`;
    - `choices(model, effort, words)`;
    - `environment(env)`, which fills each `${env:NAME}` from the start's environment;
    - `problems_with(env)`;
    - `listed(env)`.

    `Kind::rule()` gives the rule a built-in type runs by. `PROGRAM_TYPE` is `"custom"`.
  - To daemon (`agent/readiness.rs`): `TrustQuestion`, through `rule.yolo.question`. It is the
    screen question that a CLI with no other way to trust the folder shows, and Facade answers it.

### input

Reads a CLI's input box from its screen, tells a pasted message's own draft from anything else in it, and says what a probe's space and Backspace did to the box (`input/mod.rs`, `input/paste.rs`, `input/probe.rs`).

- **Owns:** nothing. It reads the `input` and `paste` sections of a CLI's rule, and a screen view the caller gives it.
- **Keeps:**
  - Ordinary readings use the screen's cells, their dim, inverse and colored marks, the cursor,
    and an open synchronized update. For automatic delivery the daemon also supplies whether the
    input is untouched.
  - Each mechanism (`frame`, `prompt`, `editor`, `box`, `prompt_row`) knows only the layout its CLI was recorded drawing. Any other screen reads `unknown`, or `interaction` when one of the rule's menus or questions shows.
  - A screen in the middle of a synchronized update, a cursor off the screen, or a hidden terminal cursor with no inverse cell of the CLI's own at that position never reads `usable` or `draft`.
  - Colored text alone where the input starts could be a hint or a draft. Claude can also draw hints without styling. For automatic delivery to a fresh input that has received no external edits, the reader marks a single unstyled row at the input start as `unknown` and unsure. Ordinary input reads identify that writing as a draft. A dim hint, or a mode placeholder shown above its footer, counts as empty only while the cursor is where the input starts.
  - A probe is judged from two readings, before its key and after, never from the time between them: whether its space went in by the cursor and the text, what the row was by the text alone, and whether Backspace put the box back by every cell and the cursor.
  - The evidence names the rows, never the draft's text. The draft's text leaves `read_draft` only as its second value and is never saved.
  - A message's own draft is its text alone, after the message's lead when one was typed. Whitespace is ignored, because wrapping and indentation draw it differently. The draft may also be the CLI's placeholder for a paste of that size, counted the way that CLI counts. A draft scrolled out above only has to show the text's end.
- **Never does:** decide whether input may be typed; press Enter; read CLI reports, hooks or session files; keep state between readings.
- **Interface** (re-exported from `facade_rules`):
  - `read_box(&InputRule, &ScreenView) -> BoxReading` gives the reading, the draft's text,
    the input's first row and whether the reading is unsure. The `InputLine` includes the
    input's starting column and cursor, its cells and styling, and whether the box has more rows.
  - `read_box_for_typing(&InputRule, &ScreenView, bool) -> BoxReading` lets automatic delivery
    consider an unstyled probe when the daemon reports untouched input and the CLI's rule allows it.
  - `read_draft(&InputRule, &ScreenView) -> (InputInfo, Option<String>)` gives the input state,
    evidence, mechanism and scrolled rows along with the draft's text. `read_input` gives
    `InputInfo` alone. The actor uses ordinary readings for inspect, readiness, state and
    tracking when the CLI takes a person's draft.
  - `with_paste_text(&PasteRule, draft, pastes) -> String`: the agent actor uses it to give back the pasted text behind each placeholder in a draft the person submits.
  - For the typist:
    - `is_own_draft(&PasteRule, draft, text, lead, hidden) -> bool`: whether the box shows the message before its Enter.
    - `settle_time(&PasteRule, text) -> Duration`: how long that draft must stay the same before the Enter, which is the CLI's wait plus its wait for each line.
    - `is_same_draft(draft, seen, text, lead, hidden) -> bool`: whether the draft is still the one it pressed Enter over. The placeholder's paste number must match too, because a later paste of the same size gets a new number.
  - For the typist's probe, each from the row before its key and the reading after:
    - `space_taken(&InputLine, &BoxReading) -> bool`: whether its space went in: the cursor one column on, the row its space ahead of the text it held, or its space alone.
    - `verdict_of(&InputLine, &BoxReading) -> ProbeVerdict`: the row gone, a `Hint`; moved on by the space, a `Draft`; else `Other`.
    - `restored(ProbeVerdict, &InputLine, &BoxReading) -> bool`: whether Backspace put the box back: a hint's box empty or showing a hint where the input starts, else the row and the cursor as they were.
    - `shape_of(Option<&InputLine>) -> String`: the row's shape for a log, never its text.

### state

Reads what a CLI's screen shows of its state, for the CLIs whose own reports leave it out (`state.rs`).

- **Owns:** no state. It reads two sections of a `Rule`: `status` (a `StateRule`, which names the mechanism and its patterns) and `input` (where the input is drawn). It also owns the screens recorded from each CLI that the readers are tested against, in `tests/state/<cli>.json`.
- **Keeps:** a reader recognizes only the layout its CLI was recorded drawing. Any other screen reads as None, so a CLI that draws differently keeps its own reports. A rule reads its screen only around the input kind its mechanism names; any other pairing reads nothing. Readers work on logical lines: rows joined by a soft wrap count as one line, and rows separated by a line break never do. A line that began above the screen is never evidence, and neither is text in the input.
- **Never does:** keep anything between readings; read the CLI's own reports or decide which version a correction holds for (the daemon does both); type into the CLI or press Enter.
- **Interface:**
  - `read_state(rule, view) -> Option<ScreenState>`, where `ScreenState` is `Working`, `Idle`, `Blocked(BlockKind)` or `Error(words)`. The daemon's agent state calls it on each complete frame, but only while the selected evidence calls for a screen reading and never while the CLI is drawing a synchronized update. It is None when the rule has no `status` section, or when the screen shows nothing that section recognizes.
  - The three mechanisms:
    - `turn_error` (OpenCode, over its input box): when a turn's model call failed, the error stands just over that turn's summary. It reads as `Error` with the CLI's words. A turn that produced words shows a rate in its summary, so it never reads as an error.
    - `background_correction` (Codex, around its input prompt): reads `Idle` when, over the prompt, a dim footer counts the commands still running in the background, drawn exactly as the CLI draws it or cut off at the screen's right edge, and over that stands the dim summary of a finished turn. The daemon uses this to correct Codex's `working` report.
    - `frame_transcript` (Muse Code, around its input frame): `Working` while the working line stands over the frame, with at most a usage warning or queued input between them. `Idle` under the CLI's header, a question it answered, or the last line of an earlier conversation. Where no frame is drawn, `Blocked(Auth)` while all of its sign-in choices show, and `Blocked(Permission)` while its question about trusting the workspace shows. Part of a frame on the screen reads as None.
  - To check rule files, the layer reads `COUNT` (`${count}`) and `PLURAL` (`${s}`): a footer must contain `COUNT` exactly once, and no placeholder other than these two.

### sessions

Which session a run is in, and the variables through which CLIs name their sessions and mark their runs (`sessions.rs`).

- **Owns:** the format of a run's session file, `<run folder>/session`. It holds a session ID and a newline. For a CLI that says where it saves the session, a second line follows with that file's absolute path and a newline. An empty file means no session is selected. A file over 4 KiB is unreadable. It also owns the session variable of each CLI (`SESSION_VARIABLES`: `CLAUDE_CODE_SESSION_ID`, `CODEX_SESSION_ID` and `CODEX_THREAD_ID`, and so on) and the 22 Claude Code and Codex variables that mark a session or run, such as `CLAUDECODE` and `CODEX_SANDBOX`.
- **Keeps:**
  - A session ID has one spelling: a UUID in lowercase, or OpenCode's `ses_` followed by 1 to 64 letters and digits.
  - A session counts only once it is saved. If the file names a path that does not exist yet, it reads as no session, so a session the CLI has not saved cannot be resumed. This holds for every CLI.
  - A write goes to a temporary file that only its owner can read (base's `files::private_options`). The file is synced, then renamed over the session file, so a reader sees the old file or the new one, never part of either; the folder is synced through `files::sync_folder`.
  - On Windows a session variable's name is compared without case.
  - The run's folder is never created, so a late hook from a removed run writes nothing.
  - "Which CLI variables must not carry into a new agent" has no other owner in core: these variables together with `Rule::remove_wiring_environment`.
- **Never does:** create or remove run folders; handle Facade's own `FACADE_*` variables or terminal variables (the daemon owns those); decide when a session is resumed.
- **Interface:**
  - `facade hook` (`hooks.rs`):
    - `session_from_hook(input) -> Option<Option<Reported>>` reads a `SessionStart` hook's `session_id` and `transcript_path`. `session_from_title(input)` reads the `conversation_id` in Antigravity's title input. For both, `Some(None)` means no session is selected and `None` means leave the file alone.
    - The reported session is then written with `write_session_file`.
    - `run_folder(runs, agent)` finds the agent's single run folder. `SESSION_FILE` checks the file name it is given.
    - `session_variable(cli)` finds the hook's own session.
  - `facade` commands (`daemon_client.rs`): `SESSION_VARIABLES` names the sessions of the terminal a command runs in.
  - The daemon:
    - Run preparation finds the file with `run_folder` and `SESSION_FILE`, and writes the session a resume continues with `write_session_file(path, Some(&Reported::saved(id)))`. `WriteFailure::NotWritten` fails the start; `NotDurable` is logged.
    - It reads the file back with `read_session_file(path) -> SessionFile`, which is `Session(id)`, `NoSession`, `Missing` or `Unreadable(why)`.
    - It drops `is_session_variable(name)` variables from a new agent's environment.
    - The store keeps a stored session only if `parse_session_id` gives it back unchanged.
    - The guest server uses `session_variable(cli)`.
  - Test package: `session_variable(cli)` in `tests/guests.rs` and `tests/mcp.rs`.

### wiring

`src/wiring/` is Facade's way into each CLI: what a run's CLI is given to have Facade's tools and report its session,
the entries `facade integration add` writes into a CLI's user settings, and the formats of Facade's hooks.

- **Owns:** the knowledge of each CLI's entry points, chosen by rule name: how it takes an MCP server (a file or `-c`
  overrides for the run alone, inline settings, an extension, or for Antigravity a plugin in
  `PLUGIN_FOLDER` of the folder it starts in, shared by the runs there); how it approves one server's tools; where it
  reads its user and project settings; how it reports its session (a session-start hook, a title command, a
  plugin, an extension, or for the test CLI a variable); the files a run's folder holds for it (the server
  settings, the skill at `SKILL_FILE`, the instructions at `INSTRUCTIONS_FILE`); the shape of each integration
  file, by `integration::Kind`; and each CLI's hook input keys and hook output format.
- **Keeps:**
  - Facade reads and changes only entries it wrote. A server is Facade's when its program is `facade-mcp`, whatever its
    arguments; a hook when its command is `facade hook …` for that CLI; a whole file when it starts with Facade's
    marker line; a plugin when its manifest's description names Facade core and a version (`plugin_version`).
  - A run is given no tools beside a `facade` server of the person's own that its CLI reads; Muse Code's are also
    withheld where Muse Code would refuse the run. The reason goes back as `Tools::NotGiven`, and nothing is written.
    Antigravity is the exception: Antigravity names a plugin's server after the plugin, so Facade's is
    `facade_facade`, and neither it nor a `facade` server of the person's own takes the other's place.
  - Settings of the person's that Facade cannot read stay as they are, for the CLI to report; Facade then adds nothing
    to them, and the run reports no session that way.
  - Integration writes keep every other byte of the file: a file that already holds Facade's current entries comes
    back unchanged, Codex's TOML keeps its comments, and a JSON file with comments is refused rather than rewritten.
  - Whatever a run added to its CLI's environment, `remove_wiring_environment` takes out again.
  - Codex's session-start hook is trusted under its synthetic session-flags layer: `/<session-flags>/config.toml`
    on Unix and `C:\<session-flags>\config.toml` on Windows, with a literal `C:` regardless of the run's drive.
    Persistent integration hooks in `hooks.json` keep Codex's one-time review; Facade writes no trust keys for them.
  - Each hook command is written for its CLI's shell (`Shell::of`, or encoded PowerShell for Codex on Windows).
    Recognition accepts these forms with either `facade` or `facade.exe` as the program. Where Antigravity's own
    title command cannot go through cmd.exe, it stays as it is and Facade adds no title hook. On Windows Claude Code keys a project in
    `.claude.json` by its folder with forward slashes, and conflicts look it up so too.
  - No entry names the daemon's socket. The server finds it from its Facade home; `FACADE_HOME` is written where the
    home is not the default.
- **Never does:** write an entry Facade did not write, or run a CLI (`claude mcp add` is run by the daemon; this only
  gives its arguments). It holds no state: every file it reads is found from the environment and folders the
  caller gives.
- **Interface:**
  - For the rules layer's `compose`: `wire(cli, &Server, env) -> Result<Option<Wiring>, String>`,
    `report_session(cli, &mut Wiring, &SessionReport) -> bool`,
    `install_hook(rule, words, &SessionReport, &Wiring, env) -> Option<Hooked>`,
    `merged_settings(rule, &Wiring, words, cwd, env) -> MergedSettings`, and the `Wiring`, `Hooked` and
    `MergedSettings` values they pass. For `lib.rs`: `reports_sessions(cli)`, which checks a rule's session capture,
    and `remove_wiring_environment(cli, env)`, behind `Rule::remove_wiring_environment`.
  - For the daemon's run preparation: `Server` (program, run variables, folder, instructions, cwd, `facade`),
    `SessionReport` (`facade`, session file, cwd) and `Tools`, through `start_command_line` and `resume_command_line`;
    `uses_folder_plugin(cli)`, `plugin_files(program, facade)`, `plugin_version(manifest)`, `PLUGIN_FOLDER`,
    `PLUGIN_MEMBERS` and `SKILL_FILE`, to write and replace Antigravity's folder plugin.
  - For the daemon's guests: `integration` (`CLIS`, `Programs`, `Kind`, `Target`, `Part`, `Held`, `targets`, `write`,
    `parts`, `wanted`, `take_out`, `held`, `note`, `claude_server`, `claude_server_add`, `claude_server_remove`,
    `is_facade_server`, `same_server`, and `command_program(cli)`, the program the daemon runs to add a server where
    Facade does not write it itself: `claude`). `held` reports an entry an earlier version wrote as `Changed`, so the
    daemon writes it anew. Also `runs_start_guest_entry`, `guest_entry_serves_run` and `session_ends_with_process`,
    for the MCP guest sessions.
  - For `facade hook` (the facade crate's hooks): `hook`, pure functions of a hook's input and output:
    `run_start_output`, `approval_output`, `skill_output`, `context_output`, `block_output`, `empty_output`,
    `begins_turn`, `is_turn_cut_short`, `session_of` (`NamedSession`), `is_run_own_session` and
    `BACKGROUND_JOB_VARIABLE`; and `integration::session_status_file`, `INSTRUCTIONS_FILE`, `SKILL_FILE` and
    `session_ends_with_process`.

Inside, `mod.rs` holds the interface above and picks each CLI's way. `servers` builds the server entry every CLI's
settings take, for runs and integration alike; `run_tools` gives each CLI the tools for a run; `conflicts` finds
the person's own `facade` server; `settings` merges Antigravity's `--settings` and Muse Code's `-c hooks=` with the
person's; `session_report` has each CLI report its session; `plugin` is Antigravity's plugin; `config_files` finds a
CLI's settings files from its environment; `integration` describes each file kind's entries once, for writing, finding
and taking them out; `hook` is the hook formats.

## Reading the code

1. `lib.rs`: `Rule`, `find`, and the checks.
2. `compose.rs`: `start_command_line`, the whole command line in order.
3. `wiring/mod.rs`, then `wiring/run_tools.rs`: what each CLI is given for a run.
4. `input/mod.rs`: `read_draft`; then `input/paste.rs`: `is_own_draft`, which the typist relies on.
5. `args.rs`: `Reader`, then `problems`.
