# Rules

What Facade knows about each CLI it starts by name: the program and its arguments, how the CLI
keeps, reports and resumes sessions, how it draws its input, how it shows or reports its state,
and how Facade's tools and hooks enter it. The daemon and `facade` ask Rules for CLI-specific details. Crate
`facade-rules`, folder `framework/crates/rules/`, rule
files in `framework/rules/`. It is a library; it starts no program.

## Owns

- The rule files `framework/rules/<cli>.json`, built into the program with `include_str!` and read once,
  on first use, into a `LazyLock`. `fake.json`, the test CLI's rule, is built into debug builds
  only.
- What each CLI's own files look like where Facade reads or writes them: its MCP settings,
  hook settings, plugin and extension files.
- The variables in which each CLI names its session or marks its runs.
- The format of a run's session file.

## Keeps

- A rule's `cli` is its file's name, and no two rules share a program.
- Cursor, Kiro and Qoder use `agent`, `kiro-cli` and `qoder` as their built-in keys and programs.
- GitHub Copilot CLI uses `copilot` as its built-in key and program.
- A rule file is checked as it is read. If any file fails, every rule name fails in `find`. A
  start selects a configured entry. An entry with the `custom` type supplies its own program.
- No CLI name appears outside rules: what differs by CLI is in a rule file or behind a rules
  function that takes `cli`.
- Facade only recognizes and changes entries it wrote itself, in any CLI's files.
- No `cfg` by system. What differs by system is data, chosen by `facade_base::system::SYSTEM` at
  run time: each CLI's hook form, `${folder_toml}`, console typing and the wrappers. On Unix,
  every command line, hook command, file and path is as it was before Windows.
  For Copilot's managed settings path inside the Unix branch, the runtime OS selects
  `/Library/Application Support/GitHubCopilot/managed-settings.json` on macOS and
  `/etc/github-copilot/managed-settings.json` on Linux. Other Unix targets have neither path.
  Windows uses `GitHubCopilot/managed-settings.json` under the effective `ProgramFiles`.
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
- `start_managed_launch_command(rule, words, session, server, environment, policy) -> CommandLine`
  builds the run's command line, environment, private files and plugin files. Its optional
  `workspace_file` gives the daemon a path relative to the launch folder and the contents
  of one run-owned native configuration. It may reference the private files.
  `config_links` describes aliases in the private run folder that retain existing configuration
  entries when a CLI needs a separate configuration root.
  `resume_managed_launch_command(rule, id, words, session, server, environment, policy)` also
  names the session to resume and returns `None` for a CLI without session resume. `Tools` records
  whether the CLI has Facade's tools or why they could not be given. `uses_run_credential` lets
  the daemon save the credential's digest when the resulting configuration carries it.
  Both use `wire_managed` to configure the CLI's connection to Facade API v1's MCP entry point.
  `LaunchPolicy` carries the authenticated launch origin and the folder when YOLO is on.
- The `entries` module reads `clis` in `facade.json`. `entries::select` checks the exact entry key.
  `Entry::resolve_program` uses its effective environment and working folder. `Entry::launch_options`
  returns the literal arguments to save and replay, with their model and effort when known. Those
  values are separate from what a run adds for YOLO, session reporting and MCP.
  `Entry::choice_refusal` names every unsupported choice in MCP or command-line wording.
- `direct_command(rule: Option<&Rule>, program, env, cwd) -> Vec<String>`: what starts `program`,
  the file a start's command resolved to. On Windows, Pi's and Muse Code's installers' wrappers
  start the CLI's own program; everything else is as base's `programs::direct_command` has it.
- `console_typing(rule) -> Option<ConsoleTyping>`, for the typist: on Windows, for a CLI that reads
  console input records, the wait before submission for each UTF-16 code unit typed and whether
  characters above U+FFFF go as key-down records.
- The input, state, sessions and wiring functions listed under each child below.
- `session_meta_keys`: the keys in which CLI tool calls name their sessions.
- `managed_instructions_from_hook(cli)` identifies the rules whose managed runs get their
  instructions from a hook or extension.

**facade** (`facade hook …`, and finding the agent of a command's terminal)
- `hook`: what each CLI's hooks print and the keys their input uses, and `hook::title_command`,
  which runs the person's title command with the shell of the CLI that runs title hooks.
  `hook::RunStart::new` supplies the start hook's input, own session and instructions to
  `hook::run_start_output`.
- `session_from_hook`, `session_from_title`, `write_session_file`, `run_folder`,
  `INSTRUCTIONS_FILE`, `session_variable`, `SESSION_VARIABLES`.

**Scenario tests** (`framework/tests`): `session_variable`.

## Depends on

- `facade-base` provides `settings` for reading `facade.json`. The `daemon` module provides
  `InputMechanism`, `InputInfo`, `InputState`, `HiddenRows` and `is_session_id`. The Antigravity
  plugin uses `version()`. Rules uses `system` (`SYSTEM`, `env_var`, `home_folder_in`),
  `programs` (`direct_command`, `on_path`) and `files` (`private_options`, `is_private`,
  `sync_folder`), and `base64` for encoded PowerShell hooks.
- `facade-screen`: `ScreenView` and its cells, which the input and state readers read.
- serde, serde_json, regex, toml, sha2, unicode-width and rusqlite for CLI session indexes.

## Inside

The layer holds the rule-file format and the one step that needs two children: putting a run's
command line together. The children never use each other. They may use the layer's rule types,
`args`, `formats`, `find`, `rules` and `FILES`, read only.

- `lib.rs`: `Rule` and the type of each section, `parse` and the checks. Each section checks
  itself (`InputRule`, `PasteRule`, `Frame`, `Editor`, `StatusGlyph`, and the state mechanisms
  that read the screen). `Rule` returns the first problem and names the file. Also `find`, `rules`,
  the MCP keys and `console_typing`. Every child's public items are re-exported at the crate root.
- `wrappers.rs`: `direct_command`, and the two wrappers it reads: Pi's `pi.cmd`, whole as Pi's
  installer writes it, starts its `pi-launcher.js` with the installer's own Node or a Node program
  on `PATH`; Muse Code's wrapper starts `muse-bin-<version>.exe` beside it, for the version and
  channel its installer chose. A file that is not exactly that is base's to start.
- `args.rs`: how a CLI reads its arguments, from the rule's `arguments` section. A `Reader` walks
  the words into pieces (option, override, positional, end of options). `problems` refuses
  options and settings keys (Codex's config keys) Facade sets itself in an entry's `args`; `found`, `overrides`,
  `holds` and `end_of_options` serve command_line and wiring. `problems_at` gives the setting reader
  the source index of each problem. `choice_value` finds the value of a model or effort option,
  including the short forms its CLI accepts.
- `formats.rs`: the CLIs' own text formats in one place: JSON with comments, shell words, TOML
  strings and inline values, and merging Facade's settings into the person's. Facade writes POSIX
  hook commands on Unix and for Claude Code on Windows, whose Git Bash takes `'C:\…'` words as
  they are. On Windows, Antigravity passes its hooks from `hooks.json` verbatim to cmd.exe. Facade
  writes them as `[set "NAME=value" && ]…@"<program>" <word> …`.
  On Windows, Muse Code's hooks, Codex's hooks, the test CLI's session hook and Antigravity's title
  command use encoded UTF-16LE PowerShell scripts. The outer command has no quotes and passes
  through the CLI's shell intact. The scripts quote each argument as a literal and preserve
  Facade's exit code.
- `compose.rs` builds the command line for a start or resume in this order.
  1. wiring gives the tools (`wire_managed`), and YOLO's run settings are merged into the wiring's;
  2. wiring has the CLI report its session, through its settings (`report_session`) or a hook,
     plugin or extension (`install_hook`);
  3. the command: the program, the resume arguments, the rule's `launch.args`, YOLO's arguments;
  4. wiring merges the tools' and YOLO's settings with the person's own (`merged_settings`);
  5. the tools' arguments, the merged settings, the hook's arguments (a resume puts them right
     after YOLO's), then the person's words. An option that takes every value up to the next option never comes right before the person's
     words: then it goes after them, before their `--`.

**Rule files.** `framework/rules/<cli>.json`, one per CLI. Unknown fields are refused. Patterns are
Rust regular expressions.

| Key | Says |
|---|---|
| `cli`, `display_name`, `program` | the name (same as the file), the name people know, the program on `PATH` |
| `launch.args` | literal arguments right after the program |
| `arguments` | how the CLI reads its arguments, and the options and keys Facade sets itself |
| `choices` | the arguments that give a model and an effort |
| `input` | the layout of the input box: `frame`, `prompt`, `editor`, `box` or `prompt_row` |
| `paste` | the settle time, submission key policy, and placeholders for a pasted message |
| `session` | `capture` (`session_start` or `none`) and the `resume` arguments with `${session_id}` |
| `status` | how Facade reads the CLI's state from its screen or a report's words |
| `status_glyph` | the CLI's glyph for viewer titles once the CLI has reported its state. The `working` list holds one or more glyph frames, each shown for `frame_ms` milliseconds. The `resting` glyph is for Starting after a report, Idle, Just done, Waiting for you and Error. Every glyph must be nonempty, and `frame_ms` must be positive |
| `ready_tools` | what to type so the CLI starts Facade's tools before its first turn |
| `mcp` | the session key in MCP metadata or the relay environment, and whether a run gets its instructions from a hook or extension |
| `yolo` | `work` controls for native permissions, `startup` controls for YOLO agent starts, optional `off_args` for explicit consent mode, and the trust question to answer |
| `console` | on Windows, for a CLI that reads console input records: `per_char_ms`, the wait before submission for each UTF-16 code unit, and `records_above_bmp` |

**Adding a CLI.** Write `framework/rules/<cli>.json` and add it to `FILES` in `lib.rs`; its place there
is its place in `facade`'s lists. With a rule file alone, Facade starts the CLI and reads its
screen, but gives it no tools and cannot resume it: its `session.capture` must be `none`. To give
it Facade's tools, have it report its session or answer hooks, add its case in wiring. The entry
points are `wire_managed` and `reports_sessions` in `wiring/mod.rs`, its builder and `unwire` in
`run_tools.rs`, `install_hook` in `session_report.rs`, and the functions of `hook`.
Its session variables go in `SESSION_VARIABLES` in `sessions.rs`. The tests
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
  - YOLO enables `work` controls. `startup` controls require both YOLO and an agent start.
    A rule can specify `off_args` to select its normal approval mode explicitly.
    Rule options interpolate `${folder}` and `${folder_toml}`. The TOML value uses the
    resolved working folder, lowercased on Windows as Codex keys a project there.
  - The rule's agent-start updater environment applies to agent starts in either YOLO mode.
    Reusing a run's environment restores the inputs its launch controls replaced, before the destination's
    entry settings apply. Later changes in the invoking shell take precedence.
  - `${env:NAME}` in an entry is read through `env_var`.
  - Each choice in `choices` holds exactly one `${value}`, `${value_toml}` or `${value_json}`.
    When the person's own words already pick a model or an effort, the entry's choice is not
    added.
  - Each `clis` entry is read on its own and takes nothing from another. A mistake makes only
    that entry unavailable, and its problem names the setting path, never the value written.
  - A built-in keeps its `type`. Added entries have names distinct from the built-in IDs and display
    names, ignoring case. An existing entry with a newly added provider's name keeps its explicitly
    selected earlier type, including `custom`.
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
    `kind`, `program` and `args`, and these methods:
    - `display_name()`;
    - `takes("model" | "effort")`;
    - `choice_refusal(model, effort, by_model)`;
    - `choices(model, effort, words)`;
    - `environment(env)`, which fills each `${env:NAME}` from the start's environment;
    - `program_setting()` names the key read or the preferred key for an unset program;
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
  - Menu patterns match physical rows after removing trailing ASCII spaces. Leading columns,
    adjacency and hint ranges still distinguish native menus from composer text.
  - Claude's theme chooser shows its heading, the `/theme` help and a selected native theme.
    Kiro shows a login question with a selected Yes or No, and Cursor shows its login hint
    below the Cursor Agent splash title. Those login notices also report authentication waits.
    Kiro trust and Devin's `✱` trust question are also interactions. Kiro's option menus read as
    interactions by the footer below their selected `❯` row, so its trust-all-tools warning does at
    any window height.
  - Frame, editor and prompt rules use a `scrolled` object that identifies the scroll layout by `position`.
    For `rows` (Muse Code and Antigravity), one capture in each pattern counts the hidden rows
    from separate marker rows inside the frame. For `rules` (Claude Code and Pi), the patterns
    capture counts from the upper and lower border rules. A frame with a marked upper rule can
    start on a continuation row.
  - Frames can specify an indent and a second prompt glyph. Cursor and Kiro anchor their prompt
    rows at the cursor and read wrapped rows using that prompt's margin.
  - Devin uses `❭` inside its two-rule frame. Qoder sets `hidden_cursor_in_frame` and can use
    the hidden terminal cursor without an inverse cell when its position is inside the complete
    input frame, at or after the input column. Both colored hints still need the reversible
    space probe to distinguish them from a draft.
  - Cursor sets `drawn_cursor` on its prompt-row rule. While the terminal cursor is hidden, a single
    inverse cell at or after the input start of a prompt row or one of its wrapped rows supplies the
    cursor position for the input reading and the space probe. With zero or several such cells,
    the rule checks for a menu. A visible terminal cursor supplies its own position.
  - Cursor's live trust question reads `interaction` when the boxed selected option has the key help
    within three rows below it. Once answered, the box loses the selection marker and key help.
    The input box below it can then read `usable` or `draft`.
  - Cursor's `Run this MCP tool?` question reads `interaction` when the selected `Run (once)`
    option and the `Allowlist MCP Tool` option follow. Its approval caption near the bottom
    reports `Blocked(Permission)` while the composer is absent.
  - Oh My Pi's default Band has a colored status row above its `╰─ ` prompt. With a visible
    terminal cursor in that input, the colored three-column margin bounds the draft, including
    blank continuation rows. Oh My Pi's Pi layout uses two horizontal rules. Band holds one
    more input row than Pi at the same terminal height. A full `unmarked` viewport reads
    `unknown` and can provide the visible end of a paste for verification. The daemon uses
    this evidence only when it started the paste in an empty input box in the same input generation.
    The first-run setup wizard reads `interaction` from the complete default
    `↑/↓ select · ⏎ confirm · ⎋ skip · ⌃C exit setup` footer at the bottom when the scene fits.
    A readable editor takes priority, and a clipped or remapped footer supplies no match.
    Oh My Pi draws what it predicts the person types next from the cursor on, in another color than
    the text before it. The reading leaves that out of the draft.
  - Copilot draws a colored rail or two plain full-width rules around its input. Both layouts
    require a visible hardware caret and the `Interactive` footer below the editor.
    The plain frame additionally has a `❯ ` prompt. A full viewport uses the shared editor
    guard. Its compact `[Paste #N - M lines]` marker supplies the paste's line count.
    The full styled sign-in notice two rows above a recognized editor reads `interaction`.
    A wrapped notice also matches when the complete styled text sits directly above one to
    three indented project rows, ending in the native `Run on:` context.
    Manual `/login` stays available, and Copilot continues to report its state through OSC.
  - Codex's `prompt` input accepts `›` and its `alternate_prompt`, `»` at Ultra effort.
    The updater menu reads `interaction` when the selected `Update now` row has the
    `enter continue · esc skip` footer within five rows. This also covers the wrapped option
    in the 120-column recording.
    A wrapped footer can end with a shortcuts row that may include aligned status, the
    `tab to queue message` hint, or a standalone warning count ending in `f2 to view` with at least
    20 leading spaces. The model line must start the contiguous, indented footer above the hint
    and have a blank row above it.
    Its `last_column` position uses dim glyphs (`↑` and `↓`) in the last column of the first
    and last input rows. When the model line is absent, those glyphs anchor the scrolled composer.
    The draft omits the glyphs and the reading reports one hidden row for each marked side.
  - OpenCode's box has one space between the bar and the text below `narrow_below` (44 columns),
    and two spaces from that width.
  - An open synchronized update reads `unknown`. A reader using the terminal cursor's position
    returns `unknown` when that position is off screen. While that cursor is hidden, those readers
    require an inverse cell at its position to read `usable` or `draft`.
  - Colored text alone where the input starts could be a hint or a draft. Claude can also draw hints without styling. For automatic delivery to a fresh input that has received no external edits, the reader marks a single unstyled row at the input start as `unknown` and unsure. Ordinary input reads identify that writing as a draft. A dim hint, or a mode placeholder shown above its footer, counts as empty only while the cursor is where the input starts.
  - A probe is judged from two readings, before its key and after, never from the time between them: whether its space went in by the cursor and the text, what the row was by the text alone, and whether Backspace put the box back by every cell and the cursor.
  - The evidence names the rows, never the draft's text. The draft's text leaves `read_draft` only as its second value and is never saved.
  - A message's own draft is its full text or the CLI's placeholder for a paste of that size. Whitespace is ignored because wrapping and indentation draw it differently. A draft scrolled out above only has to show the text's end.
  - OpenCode's `[Pasted ~N lines]` counts the lines after trimming whitespace from both ends of the paste.
    Claude Code's `[Pasted text #N]` matches a paste with no line break.
    Antigravity's `[Pasted text #N M chars]` counts Unicode scalar values, including line breaks.
  - Antigravity's mode placeholders include
    `Auto mode: edits & safe commands auto-approved (shift+tab to cycle)`.
- **Never does:** decide when to type, write terminal input, read CLI reports, hooks or session files, or keep state between readings.
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
    - `is_own_draft(&PasteRule, draft, text, hidden) -> bool` matches the message in the input box before submission.
    - `is_legacy_split_paste(&PasteRule, draft, prefix, pasted) -> bool` matches an older daemon's visible typed prefix and the paste placeholder during recovery.
    - `settle_time(&PasteRule, text) -> Duration` gives the base wait plus the wait for each line.
    - `is_same_draft(draft, seen, text, hidden) -> bool` compares the observed drafts, including the placeholder's paste number.
    - `PasteRule::submission_key(working) -> Key` selects Tab for Codex while Working and Enter otherwise.
  - For the typist's probe, each from the row before its key and the reading after:
    - `space_taken(&InputLine, &BoxReading) -> bool`: whether its space went in: the cursor one column on, the row its space ahead of the text it held, or its space alone.
    - `verdict_of(&InputLine, &BoxReading) -> ProbeVerdict`: the row gone, a `Hint`; moved on by the space, a `Draft`; else `Other`.
    - `restored(ProbeVerdict, &InputLine, &BoxReading) -> bool`: whether Backspace put the box back: a hint's box empty or showing a hint where the input starts, else the row and the cursor as they were.
    - `shape_of(Option<&InputLine>) -> String`: the row's shape for a log, never its text.

### state

Reads a CLI's screen for evidence of its state (`state.rs`). A rule can also have the daemon read a report's words.

- **Owns:** no state. For screen readings it uses `status` (a `StateRule`, which names the mechanism and its patterns) and `input` (where the input is drawn). It also owns the screens recorded from each CLI that the readers are tested against, in `tests/state/<cli>.json`.
- **Keeps:** a reader recognizes only the layout its CLI was recorded drawing. Any other screen reads as None, so a CLI that draws differently keeps its own reports. A rule reads its screen only around the input kind its mechanism names; any other pairing reads nothing. Readers work on logical lines: rows joined by a soft wrap count as one line, and rows separated by a line break never do. A line that began above the screen is never evidence, and neither is text in the input.
- **Never does:** keep anything between readings, read the CLI's own reports, or write terminal input.
- **Interface:**
  - `read_state(rule, view) -> Option<ScreenState>`, where `ScreenState` is `Working`, `Idle`, `Blocked(BlockKind)` or `Error(words)`. The daemon's agent state calls it on each complete frame, but only while the selected evidence calls for a screen reading and never while the CLI is drawing a synchronized update. It is None when the rule has no `status` section, or when the screen shows nothing that section recognizes.
  - The `status` mechanisms:
    - `composer` (Devin, Cursor, Kiro and Qoder) reads the visible composer and the CLI's nearby working, sign-in and approval cues. Cursor can draw a dim work hint beside the composer. A recognized composer with no work indicator reads as `Idle`. Native reports take precedence once received.
    - `turn_error` (OpenCode, over its input box): when a turn's model call failed, the error stands just over that turn's summary. It reads as `Error` with the CLI's words. A turn that produced words shows a rate in its summary, so it never reads as an error.
    - `background_correction` (Codex, around its input prompt): reads `Idle` when, over the prompt, a dim footer counts the commands still running in the background, drawn exactly as the CLI draws it or cut off at the screen's right edge, and over that stands the dim summary of a finished turn. The daemon uses this to correct Codex's `working` report regardless of the installed version.
    - `background_report` (Claude Code, in a report's words) gives the daemon a `background` pattern. A `working` report whose words match the pattern reads as `idle`.
    - `frame_transcript` (Muse Code, around its input frame): `Working` while the working line stands over the frame, with at most a usage warning or queued input between them. `Idle` under the CLI's header, a question it answered, or the end of an earlier conversation. The reader skips indented text and blank paragraph breaks when it looks for the answer marker. Where no frame is drawn, `Blocked(Auth)` while all of its sign-in choices show, and `Blocked(Permission)` while its question about trusting the workspace shows. Part of a frame on the screen reads as None. Muse Code reports an answer that asks the person something as a question, although its turn has ended. With `answers_ask`, that report counts as done while the CLI's input is on the screen.
  - To check rule files, the layer reads `COUNT` (`${count}`) and `PLURAL` (`${s}`): a footer must contain `COUNT` exactly once, and no placeholder other than these two.

### sessions

Which session a run is in, how a CLI reports it to MCP, and which saved sessions can continue from
a folder (`sessions.rs` and `sessions/history/`).

- **Owns:** the format of a run's session file, `<run folder>/session`. It holds a session ID and a newline. For a CLI that says where it saves the session, a second line follows with that file's absolute path and a newline. An empty file means no session is selected. A file over 4 KiB is unreadable. It also owns the session variables and run-specific environment keys, including `CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID` and `PI_SESSION_FILE`.
- **Keeps:**
  - History readers use the selected CLI's effective configuration, environment and arguments.
    They return sessions saved in the requested folder and read the CLI's stores without
    writing the session data.
  - `SavedSession.title` uses the saved native name when available and falls back to the existing
    conversation preview. The Claude Code and Pi readers find names between the transcript's
    head and tail windows, so later output does not hide a saved rename.
    Muse Code looks up an individual session's first prompt in its transcript when the index has
    no displayable title for it. The saved-session catalog reads the index.
  - A session ID uses the CLI's native spelling. UUIDs are lowercase. OpenCode uses `ses_` followed by 1 to 64 letters and digits, Kiro V3 uses `sess_` followed by a lowercase UUID, and Devin names a session with lowercase words joined by hyphens, such as `pickled-fighter`, at most 64 characters.
  - A session counts only once it is saved. If the file names a path that does not exist yet, it reads as no session, so a session the CLI has not saved cannot be resumed. This holds for every CLI.
  - A write goes to a temporary file that only its owner can read (base's `files::private_options`). The file is synced, then renamed over the session file, so a reader sees the old file or the new one, never part of either; the folder is synced through `files::sync_folder`.
  - On Windows a session variable's name is compared without case.
  - The run's folder is never created, so a late hook from a removed run writes nothing.
  - "Which CLI variables must not carry into a new agent" has no other owner in framework: these variables together with `Rule::remove_wiring_environment`.
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
    - `list_sessions(rule: &Rule, folder: &Path, environment: &BTreeMap<String, String>, args: &[String])
      -> Result<Vec<SavedSession>, ErrorBody>` reads the selected CLI's history.
      Each result has a session ID, folder and optional title and activity time. The daemon checks
      which sessions are in use and projects the resume targets for all entry points.
    - `session_for_id(rule: &Rule, folder: &Path, environment: &BTreeMap<String, String>, args: &[String],
      id: &str, report: Option<&Path>) -> Result<Option<SavedSession>, ErrorBody>` finds the full
      canonical ID in the same native history. The daemon supplies the run's launch context and
      optional session report file on the machine that holds the record. A matching report can
      locate the original Claude Code, Codex, Pi, Qoder or Oh My Pi transcript. The same native eligibility checks
      apply, and the supplied launch context is used when the report cannot locate a session.
    - Copilot uses `--config-dir`, `COPILOT_HOME` or the default `.copilot` directory in that
      order. The session directory and `workspace.yaml` must agree on the exact UUID, the
      workspace must match the launch folder, and the journal must show a persisted visible
      primary user message. The session-start hook supplies the live ID.
    - `session_evidence(rule: &Rule, recorded: &str, relay_env: &BTreeMap<String, String>,
      call_meta: Option<&serde_json::Value>) -> bool` compares the run's saved session to the
      evidence its CLI supplies. The daemon verifies which current run the operating system's
      relay process belongs to before relying on that comparison.
  - Test package: `session_variable(cli)` in `tests/guests.rs` and `tests/mcp.rs`.

### wiring

`src/wiring/` builds the configuration a run's CLI uses to get Facade's tools and report its
session. It also defines the formats of Facade's hooks.

- **Owns:** the knowledge of each CLI's entry points, chosen by rule name: how it takes an MCP server (a file or `-c`
  overrides for the run alone, inline settings, an extension, or for Antigravity a plugin in
  `PLUGIN_FOLDER` of the folder it starts in, shared by the runs there); how it approves one server's tools; where it
  reads its user and project settings; how it reports its session (a session-start hook, a title command, a
  plugin, an extension, or for the test CLI a variable); the files a run's folder holds for it (the server
  settings and the instructions at `INSTRUCTIONS_FILE`) and each CLI's
  hook input keys and hook output format.
- **Keeps:**
  - Managed wiring puts `ManagedServer.args` into the run's MCP server arguments. The daemon
    supplies `--run-credential` with the token for that run. The wiring's debug output omits the
    command, environment and file contents.
  - Managed instructions reach Muse Code through the run's own SessionStart hook, Pi through
    its run extension, and Antigravity through its PreInvocation hook. Other managed clients
    receive instructions from the MCP server. The Pi run extension registers its tools with
    deferred exposure. The person's Pi configuration governs exposure for their own entries.
  - Facade reads and changes only entries it wrote. A server is Facade's when its program is `facade-mcp`, whatever its
    arguments; a hook when its command is `facade hook …` for that CLI; a whole file when it starts with Facade's
    marker line; a plugin when its manifest's description names Facade Code Framework and a version (`plugin_version`).
  - A server named `facade` that runs a different program takes precedence, and the reason goes
    back as `Tools::NotGiven`. Antigravity calls the project plugin's server `facade_facade`, so it
    can load both servers. Muse Code uses a hand-configured `facade-mcp` server and can pass the
    CLI's session evidence. Pi prefers its `mcp.json` entries over extensions of the same name.
    When a hand-configured Facade entry uses that name, the run's extension registers its
    managed server under a different name and gives the model the managed tool names. The
    hand-configured Pi relay joins as a Guest.
  - OpenCode's `OPENCODE_CLI_CONFIG_CONTENT` for a managed run sets `tabs.enabled` to `false` so the
    terminal shows the run's own session. It also sets `tabs.mode` to `off` if the inline settings,
    `cli.json`, or the `tui.json` used in its absence has a `tabs.mode` key. The overlay keeps the
    person's other inline settings and takes plugins in order from the inline settings, `cli.json`,
    or `tui.json`, then appends the run's session plugin. The CLI's child processes inherit this
    overlay with the environment. Facade removes the run's session plugin when it uses that
    environment to start another agent.
  - Antigravity keeps one plugin under the project for concurrent runs. A process that loads the
    plugin and inherits another run's credential can attach to that run. The older plugin's skill
    path remains in `PLUGIN_MEMBERS` so the daemon recognizes the whole plugin when replacing it.
  - Settings of the person's that Facade cannot read stay as they are, for the CLI to report; Facade then adds nothing
    to them, and the run reports no session that way.
  - The daemon writes managed settings into the run's folder. Antigravity's shared plugin is
    written and cleaned up by the daemon under the project's plugin lock.
  - `remove_wiring_environment` takes the run's tools and session-reporting entries out of the
    environment Facade uses to start another agent. It also removes Facade's old OpenCode skill
    path from inherited inline configuration.
  - Codex's session-start hook is trusted under its synthetic session-flags layer: `/<session-flags>/config.toml`
    on Unix and `C:\<session-flags>\config.toml` on Windows, with a literal `C:` regardless of the run's drive.
    Hooks already in `hooks.json` keep Codex's one-time review.
  - Each hook command is written in a form its CLI hands intact to the program that runs it
    (`formats::facade_hook`). The supported forms include encoded PowerShell for Codex and
    Muse Code, POSIX and cmd.exe, with either `facade` or `facade.exe` as the program.
  - Muse Code runs hooks without the run's environment. Facade includes the run's
    `FACADE_AGENT` and `FACADE_HOME` in its `instructions`, `session-start` and `approve` hooks.
  - On Windows, the person's own Antigravity title command, when enabled, goes into Facade's
    encoded title command as one literal argument. A command with a double quote, CR or LF
    stays as it is. As with settings Facade cannot read, Facade adds nothing to the run's settings
    and the run reports no session that way. `facade hook title` runs a merged title command with
    Antigravity's title input through `/bin/sh -c` on Unix and `cmd.exe /d /s /c` on Windows.
  - On Windows Claude Code keys a project in `.claude.json` by its folder with forward slashes,
    and conflicts use the same spelling.
  - No entry names the daemon's socket. The server finds it from its Facade home; `FACADE_HOME` is written where the
    home is not the default.
- Rules builds configuration in memory and locates the files it reads from the environment and
  folders the caller supplies.
- **Interface:**
  - `wire_managed(cli, &ManagedServer, env)` builds the wiring, tools disposition and
    credential flag for both start and resume. The rest of composition uses
    `report_session(cli, &mut Wiring, &SessionReport, server) -> bool`,
    `install_hook(rule, words, &SessionReport, &Wiring, env) -> Option<Hooked>`,
    `merged_settings(rule, &Wiring, words, cwd, env) -> MergedSettings`, and the `Wiring`, `Hooked` and
    `MergedSettings` values they pass. For `lib.rs`: `reports_sessions(cli)`, which checks a rule's session capture,
    and `remove_wiring_environment(cli, env)`, behind `Rule::remove_wiring_environment`.
  - Daemon run preparation supplies `ManagedServer` (the `Server` configuration and this run's
    MCP arguments) and `SessionReport` (`facade`, session file, cwd). It writes and cleans up
    Antigravity's folder plugin using `uses_folder_plugin(cli)`, `plugin_files(program, facade)`,
    `plugin_version(manifest)`, `PLUGIN_FOLDER` and `PLUGIN_MEMBERS`.
  - `runs_start_guest_entry`, `guest_entry_serves_run` and `session_ends_with_process` support
    the older running-session paths.
  - For `facade hook` (the facade crate's hooks): `hook`, pure functions of a hook's input and output:
    `run_start_output`, `approval_output`, `context_output`, `block_output`, `empty_output`,
    `begins_turn`, `is_turn_cut_short`, `session_of` (`NamedSession`), `is_run_own_session` and
    `BACKGROUND_JOB_VARIABLE`; and `integration::session_status_file`, `INSTRUCTIONS_FILE` and
    `session_ends_with_process`.

Cursor loads its local plugin at startup. The plugin supplies Facade's relay, instructions and session hook.
Qoder takes a session MCP file and a settings overlay with a SessionStart hook. Devin uses a private
configuration root with the native `devin/mcp_config.json` path and an in-process local agent. Its
other existing config entries are linked into that root. Devin 3000 keeps its sessions in
`devin/cli/sessions.db` under its data folder; the catalog reads it there, else `devin/sessions.db`. A child Facade agent inherits the original
configuration root. Oh My Pi takes a local plugin, a settings overlay for the managed tools' approvals,
and an extension that reports session and turn changes. Oh My Pi announces the servers and tools it
connects. The overlay and the extension leave Facade's own out of those notices, so its conversation
opens as it does without Facade, and a failure to connect still shows. Oh My Pi selects its input layout
from its settings. Kiro starts as `kiro-cli chat --v3` and reads a projected workspace profile. Its
private launcher holds the relay credential. A
managed profile can be recreated under its saved name when another Facade agent resumes that session.
A native profile selected at launch, in the workspace or user settings, or in a saved session
keeps its own configuration and tools.

`mod.rs` selects the wiring for each CLI. `servers` and `run_tools` build the run's server entry
and tool configuration. `conflicts` checks for the person's own `facade` server. `settings`
merges the person's Antigravity `--settings` and Muse Code `-c hooks=` with the run's settings.
`session_report` builds session-reporting hooks, `plugin` builds the shared Antigravity plugin,
and `config_files` locates a CLI's settings. `hook` defines the inputs and outputs of hooks.

## Reading the code

1. `lib.rs`: `Rule`, `find`, and the checks.
2. `compose.rs` puts the whole command line in order in `start_managed_launch_command`.
3. `wiring/mod.rs`, then `wiring/run_tools.rs`: what each CLI is given for a run.
4. `input/mod.rs`: `read_draft`; then `input/paste.rs`: `is_own_draft`, which the typist relies on.
5. `args.rs`: `Reader`, then `problems`.
