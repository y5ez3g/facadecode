//! What Facade knows about each CLI it starts by name. Each CLI has a rule file in `core/rules/`,
//! built into the program and checked as it is read: the program to run and how it reads its
//! arguments, how its session is reported and resumed, how its screen draws its message input and
//! takes a paste, what its screen shows of its state where its own reports do not say it, and how
//! Facade's tools, hooks and integration enter it.
//!
//! A rule's exact name, such as `claude`, selects that rule. Any other word, a path such as
//! `/opt/bin/claude` included, is a program without a rule.

pub mod args;
mod command_line;
mod compose;
mod formats;
mod input;
mod sessions;
mod state;
mod wiring;
mod wrappers;

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::LazyLock;
use std::time::Duration;

use facade_base::system::{SYSTEM, System};
use regex::Regex;
use serde::de::Error as _;
use serde::{Deserialize, Deserializer};

pub use command_line::{Choices, TrustQuestion, YoloRule, entries};
pub use compose::{CommandLine, resume_command_line, start_command_line};
pub use formats::shell_word;
pub use input::{
    BoxReading, InputLine, LineCell, ProbeVerdict, is_own_draft, is_same_draft, read_box,
    read_box_for_typing, read_draft, read_input, restored, settle_time, shape_of, space_taken,
    verdict_of, with_paste_text,
};
pub use sessions::*;
pub use state::{ScreenState, read_state};
pub use wiring::{
    INSTRUCTIONS_FILE, PLUGIN_FOLDER, PLUGIN_MEMBERS, SKILL_FILE, Server, SessionReport, Tools,
    guest_entry_serves_run, hook, integration, plugin_files, plugin_version,
    runs_start_guest_entry, session_ends_with_process, uses_folder_plugin,
};
pub use wrappers::direct_command;

/// The argument that precedes the credential for a managed run's MCP relay.
pub const RUN_CREDENTIAL_ARG: &str = "--run-credential";

/// The MCP server for one managed run, with the relay's arguments kept separately
/// from the CLI's arguments and environment.
#[derive(Clone, Copy)]
pub struct ManagedServer<'a> {
    pub server: Server<'a>,
    pub args: &'a [String],
}

/// The rule files of the CLIs Facade starts, by name, in the order `facade` lists them.
const FILES: [(&str, &str); 6] = [
    ("claude", include_str!("../../../rules/claude.json")),
    ("codex", include_str!("../../../rules/codex.json")),
    ("agy", include_str!("../../../rules/agy.json")),
    ("muse", include_str!("../../../rules/muse.json")),
    ("opencode", include_str!("../../../rules/opencode.json")),
    ("pi", include_str!("../../../rules/pi.json")),
];

/// The test CLI's rule. Only debug builds carry it, as only they run the test gates: a release
/// starts no test program.
#[cfg(debug_assertions)]
const TEST_FILES: [(&str, &str); 1] = [("fake", include_str!("../../../rules/fake.json"))];
#[cfg(not(debug_assertions))]
const TEST_FILES: [(&str, &str); 0] = [];

/// One CLI's rule: one rule file, read and checked.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rule {
    /// The CLI's name, which is its rule file's name too.
    pub cli: String,
    /// The name people know the CLI by, such as `Claude Code`.
    pub display_name: String,
    /// The program's file name, found on the `PATH` the CLI starts with.
    pub program: String,
    /// What every command line of the CLI adds.
    #[serde(default)]
    pub launch: CommandLineRule,
    /// How the CLI reads its arguments, and which of them Facade sets or decides itself: what an
    /// entry's `args` cannot hold (CLIS-3.1).
    pub arguments: args::ArgsGrammar,
    /// The arguments that give the CLI a model and an effort (CLIS-1.4). A CLI that names none
    /// takes neither from Facade.
    #[serde(default)]
    pub choices: Choices,
    pub input: InputRule,
    #[serde(default)]
    pub paste: PasteRule,
    pub session: SessionRule,
    /// What the screen shows of the CLI's state, for a CLI whose own reports do not say it.
    #[serde(default)]
    pub status: Option<StateRule>,
    /// The file beside the program that names the installed version, read without running the CLI
    /// (CLIS-2.1): JSON with a `version` string, in the program's real folder or one of the two
    /// above it.
    #[serde(default)]
    pub version_file: Option<String>,
    /// What a run's start types so that the CLI starts Facade's tools before its first turn, for a
    /// CLI that starts a folder's servers only with its first turn or its panel of MCP servers
    /// (COLLABORATION-2.2).
    #[serde(default)]
    pub ready_tools: Option<ReadyTools>,
    /// What the CLI's MCP client does that Facade's MCP server answers to.
    #[serde(default)]
    pub mcp: McpRule,
    /// What YOLO on adds: running without asking and without the sandbox, and the folder trusted.
    #[serde(default)]
    pub yolo: YoloRule,
    /// What typing into the CLI needs where it reads console input records, as Codex and Muse Code
    /// do on Windows (CLIS-2.1). See [`console_typing`].
    #[serde(default)]
    pub console: Option<ConsoleRule>,
}

/// What a CLI's MCP client does that Facade's MCP server answers to. It lives in the rule so that
/// the MCP server names no CLI.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct McpRule {
    /// The `_meta` key in which a tool call names its session, for a CLI whose one MCP server
    /// serves many sessions. A CLI that starts an MCP server for each session names it in the
    /// server's environment instead.
    #[serde(default)]
    pub session_meta_key: Option<String>,
    /// A variable the CLI supplies to each of its stdio servers for the server's own session.
    #[serde(default)]
    pub session_env_key: Option<String>,
    /// The CLI's guests take Facade's instructions and skill from the MCP server alone, as its
    /// session-start hook gives them nothing. Every other CLI's hooks give both and its MCP server
    /// neither, so each guest's model is told once.
    #[serde(default)]
    pub instructions_from_server: bool,
    /// The `_meta` key that has the CLI load a tool from the start rather than on demand.
    #[serde(default)]
    pub always_load_key: Option<String>,
}

/// What a run's start types to ready the CLI's tools: `text` once the input first reads empty,
/// Enter once the input shows it alone, then `close` once the screen shows the tools `ready`, or
/// once the wait ends while the panel still shows `opened`. Patterns match a screen line without
/// its trailing spaces.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadyTools {
    /// The command that opens the CLI's panel of MCP servers, which starts them.
    pub text: String,
    /// A line that shows `text` alone in the input.
    pub typed: Pattern,
    /// A line that shows Facade's MCP server ready.
    pub ready: Pattern,
    /// A line that shows the panel open.
    pub opened: Pattern,
    /// The key that closes the panel.
    pub close: String,
}

/// What typing into a CLI that reads console input records needs: a wait before Enter for each
/// character typed, and characters above U+FFFF sent as key-down records.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConsoleRule {
    /// The wait before Enter, in milliseconds, for each UTF-16 code unit of the text typed.
    pub per_char_ms: u64,
    /// Characters above U+FFFF go as win32-input-mode key-down records: the CLI loses them
    /// otherwise.
    pub records_above_bmp: bool,
}

/// How the typist types into a CLI where it reads console input records.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ConsoleTyping {
    /// The wait before Enter for each UTF-16 code unit of the text typed.
    pub per_char: Duration,
    /// Characters above U+FFFF go as key-down records
    /// ([`facade_base::terminal::key_down_records`]).
    pub records_above_bmp: bool,
}

/// How to type into `rule`'s CLI where it reads console input records: Some only on Windows, for a
/// rule with a `console` section. Elsewhere the CLI reads the terminal's bytes and needs nothing
/// more.
pub fn console_typing(rule: &Rule) -> Option<ConsoleTyping> {
    let console = rule
        .console
        .as_ref()
        .filter(|_| SYSTEM == System::Windows)?;
    Some(ConsoleTyping {
        per_char: Duration::from_millis(console.per_char_ms),
        records_above_bmp: console.records_above_bmp,
    })
}

/// How the CLI takes a pasted message: what its input shows of a paste, and how long the message
/// shows there before the Enter that submits it.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PasteRule {
    /// The CLI takes a paste alone as material rather than a request, so a message's first header
    /// words, `📨 Message from `, are typed before its paste.
    #[serde(default)]
    pub lead: bool,
    /// How long a message shows as the input's own draft before its Enter, in milliseconds.
    #[serde(default)]
    pub enter_ms: u64,
    /// How much longer for each line of the message, in milliseconds.
    #[serde(default)]
    pub line_ms: u64,
    /// What the input shows in place of a long paste.
    #[serde(default)]
    pub placeholders: Vec<PastePlaceholder>,
}

/// What the input shows in place of a long paste, such as `[Pasted text #1 +3 lines]`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PastePlaceholder {
    /// The placeholder without its spaces, or with each run of them as one where `spaced` is
    /// true. Its one capture is what `count` counts.
    pub pattern: Pattern,
    pub count: PasteCount,
    /// The CLI types a paste's first character itself where it is not ASCII, and shows the
    /// placeholder for the rest after it.
    #[serde(default)]
    pub after_first_character: bool,
    /// Runs of spaces in the placeholder stay as one space rather than going.
    #[serde(default)]
    pub spaced: bool,
}

/// What a placeholder's number counts.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PasteCount {
    /// The paste's lines.
    Lines,
    /// Its lines after the first.
    LinesAfterFirst,
    /// Its characters, as code points or as UTF-16 units.
    Chars,
    /// Its characters other than control characters, as UTF-16 units, each tab as four spaces.
    VisibleUtf16,
}

/// What every command line of the CLI adds.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommandLineRule {
    /// Arguments right after the program.
    #[serde(default)]
    pub args: Vec<String>,
}

/// How the CLI's session is reported and resumed.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionRule {
    pub capture: Capture,
    /// The arguments that resume a session, before the rule's own arguments; `${session_id}`
    /// stands for its ID.
    #[serde(default)]
    pub resume: Option<Vec<String>>,
}

/// How a running CLI reports its session.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Capture {
    /// The CLI reports the session it selects to the run's session file, through its own
    /// session-start hook, which runs `facade hook session-start`, or through a plugin or extension
    /// of the run's.
    SessionStart,
    /// The CLI does not report its session.
    None,
}

/// The layout the CLI draws its message input in, and what marks it. Patterns are Rust regular
/// expressions matched against a whole row's text.
#[derive(Debug, Deserialize)]
#[serde(tag = "mechanism", rename_all = "snake_case", deny_unknown_fields)]
pub enum InputRule {
    /// A prompt row in a frame of two rules, with the cursor in it.
    Frame(Frame),
    /// A prompt row above a model line at the bottom, with the cursor in it.
    Prompt(Prompt),
    /// An editor between two rules, with a cursor the CLI draws itself.
    Editor(Editor),
    /// A box of bar rows above a half-block border.
    Box(BoxInput),
    /// The last row that starts with the prompt holds the input.
    PromptRow { prompt: String },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Frame {
    /// The prompt in the prompt row's first column.
    pub prompt: String,
    /// What follows the prompt, in the second column.
    pub gap: String,
    pub upper: Pattern,
    pub lower: Pattern,
    pub scrolled: Scrolled,
    /// A mode's text drawn in an empty input, known by the footer under the frame.
    #[serde(default)]
    pub placeholder: Option<ModePlaceholder>,
    /// The CLI can draw a hint in the same style as a draft in a fresh input.
    #[serde(default)]
    pub probe_unstyled_hint: bool,
    pub menus: Vec<Menu>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Prompt {
    /// The prompt in the prompt row's first column.
    pub prompt: String,
    pub model_line: Pattern,
    pub scrolled: Scrolled,
    pub menus: Vec<Menu>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Editor {
    pub upper: Pattern,
    pub lower: Pattern,
    /// The upper rule while rows are scrolled out above; its one capture counts them.
    pub above: Pattern,
    /// The lower rule while rows are scrolled out below; its one capture counts them.
    pub below: Pattern,
    /// The editor is at most this many rows tall, or this share of the screen where that is more.
    pub most_rows: usize,
    pub most_share: f64,
    pub menus: Vec<Menu>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BoxInput {
    /// The bar that starts each row of the box.
    pub bar: String,
    /// The corner that starts the border under the box.
    pub corner: String,
    /// The half block after the corner.
    pub edge: String,
    /// The text of an empty box.
    pub placeholder: Pattern,
    pub menus: Vec<Menu>,
}

/// What the screen shows of the CLI's state, read around the input its `input` rule describes.
/// Patterns match a whole logical line (the rows a soft wrap joins), without its trailing spaces.
#[derive(Debug, Deserialize)]
#[serde(tag = "mechanism", rename_all = "snake_case", deny_unknown_fields)]
pub enum StateRule {
    /// For a CLI that may send no state reports, read until it reports, around its input frame:
    /// working while its working line stands above the frame, idle in its known resting layout,
    /// waiting for the person while a sign-in or trust question stands in place of the frame.
    FrameTranscript(Box<FrameTranscript>),
    /// For a CLI that reports `working` while commands it left in the background outlive its turn:
    /// a finished turn above its input prompt narrows that report to idle.
    BackgroundCorrection(Box<BackgroundCorrection>),
    /// For a CLI that reports a turn whose model call failed as a turn that ended: the error drawn
    /// right above the turn's summary, at the end of the conversation over the input box, turns
    /// the report into an error with the error's words. The patterns guard every version: a
    /// layout drawn otherwise stops matching and reads nothing.
    TurnError(Box<TurnError>),
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TurnError {
    /// The line that begins the error; its one capture starts the error's words.
    pub error: Pattern,
    /// The summary under a turn that produced nothing (one that produced words shows a rate).
    pub summary: Pattern,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FrameTranscript {
    /// The one line under the frame, which completes it.
    pub footer: Pattern,
    /// The line above the frame while a turn goes on.
    pub working: Pattern,
    /// A usage warning, which may stand between the working line and the frame.
    pub usage: Pattern,
    /// Queued input, which may stand there too; its continuation lines are indented or start with
    /// `queue_continuation`.
    pub queued: Pattern,
    pub queue_continuation: String,
    /// The CLI's header, above the frame of a new conversation.
    pub header: Pattern,
    /// What starts the line above an idle frame, past the indented lines of an earlier answer.
    pub idle_marks: Vec<String>,
    /// What starts an answer, drawn bold; not bold, the same mark is a working line's.
    pub answer: String,
    /// The sign-in choices, all of which show while the CLI waits for the person to sign in.
    pub sign_in: Vec<Pattern>,
    /// The question whether the person trusts the workspace.
    pub trust: Pattern,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BackgroundCorrection {
    /// A line the CLI may draw under its model line.
    pub hints: Pattern,
    /// The dim line above the prompt that counts the commands running in the background; its one
    /// capture is the count.
    pub background: Pattern,
    /// That line in full, `${count}` for the count and `${s}` for a plural's ending. The CLI crops
    /// it at the screen's right edge.
    pub footer: String,
    /// The CLI versions this correction was verified on; other versions keep their own reports
    /// (CLIS-2.3).
    pub verified: Vec<String>,
    /// The dim summary of the finished turn, above that line.
    pub worked: Pattern,
}

/// The rows that mark a draft scrolled out of the input; each pattern's one capture counts the
/// hidden rows.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Scrolled {
    pub above: Pattern,
    pub below: Pattern,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModePlaceholder {
    pub texts: Vec<String>,
    pub footer: Pattern,
}

/// A menu or question the CLI draws in place of its input: its selected row and the row under it,
/// or a hint row that only its questions have within so many rows.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Menu {
    pub selected: Pattern,
    /// A selected row never matches this.
    #[serde(default)]
    pub not_selected: Option<Pattern>,
    #[serde(default)]
    pub next: Option<Pattern>,
    #[serde(default)]
    pub hint: Option<Hint>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Hint {
    pub pattern: Pattern,
    pub within: usize,
}

/// A regular expression of a rule file, compiled as the file is read.
#[derive(Debug)]
pub struct Pattern(Regex);

impl std::ops::Deref for Pattern {
    type Target = Regex;

    fn deref(&self) -> &Regex {
        &self.0
    }
}

impl<'de> Deserialize<'de> for Pattern {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let source = String::deserialize(deserializer)?;
        let regex = Regex::new(&source).map_err(|err| {
            D::Error::custom(format!(
                "{source:?} is not a valid regular expression: {err}"
            ))
        })?;
        Ok(Pattern(regex))
    }
}

impl Rule {
    /// Reads one rule file, `<name>.json`, and checks it. Every problem names the file.
    fn parse(name: &str, text: &str) -> Result<Rule, String> {
        serde_json::from_str::<Rule>(text)
            .map_err(|err| err.to_string())
            .and_then(|rule| rule.problem(name).map_or(Ok(rule), Err))
            .map_err(|err| format!("{name}.json: {err}"))
    }

    /// The first thing wrong with the rule read from `<name>.json`: who it is, then each section
    /// as the file lists them, then how its session is reported and resumed.
    fn problem(&self, name: &str) -> Option<String> {
        let sections = [
            self.identity_problem(name).err(),
            self.input.check().err(),
            self.yolo.check().err(),
            self.choices.check().err(),
            self.paste.check().err(),
            self.state_problem().err(),
            self.session_problem().err(),
        ];
        sections.into_iter().flatten().next()
    }

    /// The rule's name, program and fixed arguments.
    fn identity_problem(&self, name: &str) -> Result<(), String> {
        let cli = self.cli.as_str();
        if cli != name {
            return Err(format!(
                "cli is {cli:?}; it must be the file's name, {name:?}"
            ));
        }
        if !is_cli_name(cli) {
            return Err(format!(
                "cli {cli:?} must be lowercase letters, digits, and hyphens"
            ));
        }
        let program = self.program.as_str();
        if program.is_empty() || program.contains(['/', '\0']) {
            return Err(format!(
                "program {program:?} must be an executable's file name"
            ));
        }
        match self.launch.args.iter().find(|arg| !is_literal(arg)) {
            Some(arg) => Err(format!(
                "launch argument {arg:?} must be literal text without NUL"
            )),
            None => Ok(()),
        }
    }

    /// The `status` section, read around the input, and the version it may need.
    fn state_problem(&self) -> Result<(), String> {
        let Some(state) = &self.status else {
            return Ok(());
        };
        match state {
            StateRule::FrameTranscript(transcript) => transcript.check(&self.input),
            StateRule::BackgroundCorrection(correction) => {
                correction.check(&self.input)?;
                if self.version_file.is_some() {
                    Ok(())
                } else {
                    Err(
                        "status background_correction holds for a verified version, so the rule \
                         needs a version_file"
                            .into(),
                    )
                }
            }
            StateRule::TurnError(error) => error.check(&self.input),
        }
    }

    /// A captured session must be resumable, and only a captured one is.
    fn session_problem(&self) -> Result<(), String> {
        let resume = self.session.resume.as_deref();
        match self.session.capture {
            Capture::None if resume.is_some() => {
                Err("session.resume needs a captured session".into())
            }
            Capture::None => Ok(()),
            Capture::SessionStart => {
                let resume =
                    resume.ok_or("a CLI whose session is captured needs session.resume")?;
                if wiring::reports_sessions(&self.cli) {
                    command_line::check_resume(resume)
                } else {
                    Err(format!(
                        "Facade cannot have {} report its session",
                        self.cli
                    ))
                }
            }
        }
    }

    /// The arguments that resume `session`, its ID filled in as literal text. None for a CLI whose
    /// sessions Facade does not resume.
    pub fn resume_args(&self, session: &str) -> Option<Vec<String>> {
        let resume = self.session.resume.as_ref()?;
        Some(command_line::resume_args(resume, session))
    }

    /// Takes out of `env`, the environment a run of this CLI started with, what Facade added to
    /// wire it: its session-start hook and Facade's tools. What the person set stays, so an agent
    /// this run starts gets the person's environment without this run's wiring.
    pub fn remove_wiring_environment(&self, env: &mut BTreeMap<String, String>) {
        wiring::remove_wiring_environment(&self.cli, env);
    }
}

/// A rule's name: a lowercase letter, then lowercase letters, digits and hyphens.
fn is_cli_name(cli: &str) -> bool {
    let mut chars = cli.chars();
    chars.next().is_some_and(|first| first.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// An argument Facade passes as it is: no NUL, and nothing to fill in.
fn is_literal(arg: &str) -> bool {
    !arg.contains('\0') && !arg.contains("${")
}

impl PasteRule {
    fn check(&self) -> Result<(), String> {
        let uncounted = self
            .placeholders
            .iter()
            .position(|each| each.pattern.captures_len() != 2);
        match uncounted {
            Some(index) => Err(format!(
                "paste.placeholders[{index}].pattern must have exactly one capture, the number \
                 the placeholder shows"
            )),
            None => Ok(()),
        }
    }
}

impl InputRule {
    fn check(&self) -> Result<(), String> {
        match self {
            InputRule::Frame(frame) => frame.check()?,
            InputRule::Prompt(prompt) => {
                one_cell("prompt", &prompt.prompt)?;
                prompt.scrolled.check()?;
            }
            InputRule::Editor(editor) => editor.check()?,
            InputRule::Box(input) => {
                for (field, marker) in [
                    ("bar", &input.bar),
                    ("corner", &input.corner),
                    ("edge", &input.edge),
                ] {
                    one_cell(field, marker)?;
                }
            }
            InputRule::PromptRow { prompt } => {
                let visible = !prompt.is_empty() && !prompt.chars().any(char::is_control);
                return if visible {
                    Ok(())
                } else {
                    Err("prompt must be visible text".into())
                };
            }
        }
        let hints = self.menus().iter().filter_map(|menu| menu.hint.as_ref());
        if hints.into_iter().any(|hint| hint.within == 0) {
            return Err("a menu hint's within must be positive".into());
        }
        Ok(())
    }

    /// The menus and questions the CLI draws in place of its input.
    pub fn menus(&self) -> &[Menu] {
        self.layout().1
    }

    /// The mechanism's name in the protocol.
    pub fn mechanism(&self) -> facade_base::daemon::InputMechanism {
        self.layout().0
    }

    /// The layout's name in the protocol, and its menus.
    fn layout(&self) -> (facade_base::daemon::InputMechanism, &[Menu]) {
        use facade_base::daemon::InputMechanism as Mechanism;
        match self {
            InputRule::Frame(Frame { menus, .. }) => (Mechanism::Frame, menus),
            InputRule::Prompt(Prompt { menus, .. }) => (Mechanism::Prompt, menus),
            InputRule::Editor(Editor { menus, .. }) => (Mechanism::Editor, menus),
            InputRule::Box(BoxInput { menus, .. }) => (Mechanism::Box, menus),
            InputRule::PromptRow { .. } => (Mechanism::PromptRow, &[]),
        }
    }
}

impl Frame {
    fn check(&self) -> Result<(), String> {
        one_cell("prompt", &self.prompt)?;
        one_cell("gap", &self.gap)?;
        self.scrolled.check()?;
        let texts = self
            .placeholder
            .iter()
            .flat_map(|placeholder| &placeholder.texts);
        if texts.into_iter().any(String::is_empty) {
            return Err("a placeholder text is empty".into());
        }
        Ok(())
    }
}

impl Editor {
    fn check(&self) -> Result<(), String> {
        counts_rows("above", &self.above)?;
        counts_rows("below", &self.below)?;
        if self.most_rows == 0 {
            return Err("most_rows must be positive".into());
        }
        if (0.0..=1.0).contains(&self.most_share) && self.most_share != 0.0 {
            Ok(())
        } else {
            Err("most_share must be more than 0 and at most 1".into())
        }
    }
}

impl Scrolled {
    fn check(&self) -> Result<(), String> {
        counts_rows("scrolled.above", &self.above)?;
        counts_rows("scrolled.below", &self.below)
    }
}

impl StateRule {
    /// Whether the screen's evidence holds for the CLI at `version`: a correction holds only for
    /// the versions it was verified on.
    pub fn applies_to(&self, version: Option<&str>) -> bool {
        let StateRule::BackgroundCorrection(correction) = self else {
            return true;
        };
        version.is_some_and(|version| correction.verified.iter().any(|v| v == version))
    }
}

impl FrameTranscript {
    fn check(&self, input: &InputRule) -> Result<(), String> {
        if !matches!(input, InputRule::Frame(_)) {
            return Err("status frame_transcript reads around an input frame".into());
        }
        let mut marks = self
            .idle_marks
            .iter()
            .chain([&self.answer, &self.queue_continuation]);
        if self.sign_in.is_empty() || marks.any(String::is_empty) {
            return Err(
                "status frame_transcript needs sign-in choices and marks that are not empty".into(),
            );
        }
        Ok(())
    }
}

impl BackgroundCorrection {
    fn check(&self, input: &InputRule) -> Result<(), String> {
        if !matches!(input, InputRule::Prompt(_)) {
            return Err("status background_correction reads above an input prompt".into());
        }
        if self.background.captures_len() != 2 {
            return Err("status background must have exactly one capture, the count".into());
        }
        let (count, plural) = (state::COUNT, state::PLURAL);
        let named_once = self.footer.matches(count).count() == 1;
        let rest = self.footer.replace(count, "").replace(plural, "");
        if named_once && !rest.contains("${") {
            return Ok(());
        }
        Err(format!(
            "status footer must name {count} exactly once and nothing else to fill in but {plural}"
        ))
    }
}

impl TurnError {
    fn check(&self, input: &InputRule) -> Result<(), String> {
        if !matches!(input, InputRule::Box(_)) {
            return Err("status turn_error reads above an input box".into());
        }
        if self.error.captures_len() != 2 {
            return Err(
                "status error must have exactly one capture, the start of the error's words".into(),
            );
        }
        Ok(())
    }
}

/// A marker the input's reader compares with one cell: one character, one column wide.
fn one_cell(field: &str, marker: &str) -> Result<(), String> {
    let mut chars = marker.chars();
    let one = chars.next().filter(|_| chars.next().is_none());
    if one.and_then(unicode_width::UnicodeWidthChar::width) == Some(1) {
        return Ok(());
    }
    Err(format!(
        "{field} {marker:?} must be one character one column wide"
    ))
}

/// A pattern whose one capture counts rows.
fn counts_rows(field: &str, pattern: &Pattern) -> Result<(), String> {
    if pattern.captures_len() == 2 {
        Ok(())
    } else {
        Err(format!(
            "{field} must have exactly one capture, the number of rows"
        ))
    }
}

/// Every rule file of this build.
fn files() -> impl Iterator<Item = (&'static str, &'static str)> {
    FILES.into_iter().chain(TEST_FILES)
}

/// Reads every rule file. A program belongs to one rule at most.
fn read_rules(files: &[(&str, &str)]) -> Result<Vec<Rule>, String> {
    let mut rules: Vec<Rule> = Vec::with_capacity(files.len());
    for (name, text) in files {
        let rule = Rule::parse(name, text)?;
        if rules.iter().any(|earlier| earlier.program == rule.program) {
            return Err(format!(
                "{}.json: program {} belongs to another rule too",
                rule.cli, rule.program
            ));
        }
        rules.push(rule);
    }
    Ok(rules)
}

static RULES: LazyLock<Result<Vec<Rule>, String>> =
    LazyLock::new(|| read_rules(&files().collect::<Vec<_>>()));

/// Every rule, in the order `facade` lists them, or why the rule files could not be read. The
/// tests read every rule file, so no release carries rules that fail them.
pub fn rules() -> Result<&'static [Rule], &'static str> {
    RULES.as_deref().map_err(String::as_str)
}

/// The rule `name` selects: a rule's exact CLI name, such as `claude`. Any other word, a path
/// included, selects none. A rule's name fails while the rule files cannot be read, so that name
/// never runs as a program without its rule.
pub fn find(name: &str) -> Result<Option<&'static Rule>, String> {
    find_in(rules(), name)
}

fn find_in<'a>(rules: Result<&'a [Rule], &str>, name: &str) -> Result<Option<&'a Rule>, String> {
    let is_rule_name = files().any(|(file, _)| file == name);
    match rules {
        _ if !is_rule_name => Ok(None),
        Ok(rules) => Ok(rules.iter().find(|rule| rule.cli == name)),
        Err(error) => Err(format!("the CLI rules could not be read: {error}")),
    }
}

/// The version that the installation of `rule`'s CLI names beside `program`, read without running
/// it (CLIS-2.1): the rule's `version_file`, in the program's real folder or one of the two above
/// it, as JSON with a `version` string. None where the rule names no such file or none is found.
pub fn installed_version(rule: &Rule, program: &Path) -> Option<String> {
    let file = rule.version_file.as_deref()?;
    let folder = std::fs::canonicalize(program).ok()?;
    let version_in = |folder: &Path| -> Option<String> {
        let text = std::fs::read_to_string(folder.join(file)).ok()?;
        let json: serde_json::Value = serde_json::from_str(&text).ok()?;
        Some(json.get("version")?.as_str()?.to_string())
    };
    folder.ancestors().skip(1).take(3).find_map(version_in)
}

/// What the rules say about the CLIs' MCP clients, in the order `facade` lists the CLIs. A
/// release always reads its rules: one whose rule files cannot be read fails their tests.
fn mcp_rules() -> impl Iterator<Item = &'static McpRule> {
    rules().unwrap_or_default().iter().map(|rule| &rule.mcp)
}

/// The `_meta` keys in which the CLIs' tool calls name their session.
pub fn session_meta_keys() -> impl Iterator<Item = &'static str> {
    mcp_rules().filter_map(|mcp| mcp.session_meta_key.as_deref())
}

/// Whether `cli`'s guests take Facade's instructions from its MCP server alone (see
/// [`McpRule::instructions_from_server`]).
pub fn instructions_from_server(cli: &str) -> bool {
    matches!(find(cli), Ok(Some(rule)) if rule.mcp.instructions_from_server)
}

/// The `_meta` keys that have the CLIs load a tool from the start.
pub fn always_load_keys() -> impl Iterator<Item = &'static str> {
    mcp_rules().filter_map(|mcp| mcp.always_load_key.as_deref())
}

#[cfg(test)]
pub(crate) mod test_folder {
    use std::ffi::OsStr;
    use std::path::{Path, PathBuf};

    /// A folder for one test, `facade-<name>-<process ID>` in the system's temporary folder. It is
    /// empty when made, and it is removed with everything in it when the test ends, so that test
    /// runs leave nothing behind.
    pub(crate) struct TestFolder(PathBuf);

    impl TestFolder {
        pub(crate) fn new(name: &str) -> TestFolder {
            let path = std::env::temp_dir().join(format!("facade-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).unwrap();
            TestFolder(path)
        }
    }

    impl std::ops::Deref for TestFolder {
        type Target = Path;

        fn deref(&self) -> &Path {
            &self.0
        }
    }

    impl AsRef<Path> for TestFolder {
        fn as_ref(&self) -> &Path {
            &self.0
        }
    }

    impl AsRef<OsStr> for TestFolder {
        fn as_ref(&self) -> &OsStr {
            self.0.as_os_str()
        }
    }

    impl Drop for TestFolder {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Runs `script`, an ES module, with Node, and returns whether it ran: false where this machine
    /// has no Node.
    pub(crate) fn run_with_node(script: &str) -> bool {
        let Ok(output) = std::process::Command::new("node")
            .args(["--input-type=module", "-e", script])
            .output()
        else {
            eprintln!("node is not installed: the plugin and extension code is not run");
            return false;
        };
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claude() -> String {
        FILES[0].1.to_string()
    }

    /// Codex's version is read from `codex-package.json` above its real program, and its correction
    /// holds for the verified versions only.
    #[test]
    fn codex_s_correction_holds_for_the_version_its_installation_names_when_verified() {
        let codex = find("codex").unwrap().unwrap();
        let base = crate::test_folder::TestFolder::new("rules-version");
        let release = base.join("lib/codex");
        std::fs::create_dir_all(release.join("bin")).unwrap();
        std::fs::write(release.join("bin/codex"), "").unwrap();
        let program = release.join("bin/codex");
        assert_eq!(
            installed_version(codex, &program),
            None,
            "no file names a version"
        );
        let status = codex.status.as_ref().unwrap();
        for (version, holds) in [
            ("0.165.0", false),
            ("0.166.0", true),
            ("0.166.1", false),
            ("0.167.0", true),
            ("0.167.1", false),
            ("0.168.0", false),
        ] {
            std::fs::write(
                release.join("codex-package.json"),
                format!(r#"{{"name":"codex","version":"{version}"}}"#),
            )
            .unwrap();
            let read = installed_version(codex, &program);
            assert_eq!(read.as_deref(), Some(version));
            assert_eq!(status.applies_to(read.as_deref()), holds, "{version}");
        }
        assert!(
            !status.applies_to(None),
            "an unknown version keeps the CLI's own reports"
        );
        assert_eq!(
            installed_version(find("claude").unwrap().unwrap(), &program),
            None,
            "a rule without a version file reads none"
        );
        std::fs::remove_dir_all(&base).unwrap();
    }

    fn refusal(name: &str, text: &str) -> String {
        Rule::parse(name, text).expect_err("the rule must be refused")
    }

    #[test]
    fn every_rule_file_reads_with_its_name_and_a_unique_program() {
        let names: Vec<&str> = rules()
            .unwrap()
            .iter()
            .map(|rule| rule.cli.as_str())
            .collect();
        assert_eq!(
            names,
            ["claude", "codex", "agy", "muse", "opencode", "pi", "fake"]
        );
        let names = |files: &[(&str, &str)]| {
            files
                .iter()
                .map(|(name, _)| name.to_string())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            names(&FILES),
            ["claude", "codex", "agy", "muse", "opencode", "pi"],
            "what a release carries"
        );
        assert_eq!(
            names(&TEST_FILES),
            ["fake"],
            "the test CLI's rule, in debug builds only"
        );
        assert_eq!(
            find("fake").unwrap().map(|rule| rule.program.as_str()),
            Some("facade-fakecli")
        );
        for raw in [
            "/opt/bin/claude",
            "./claude",
            "Claude",
            "facade-fakecli",
            "sh",
        ] {
            assert!(
                find(raw).unwrap().is_none(),
                "{raw} is a program without a rule"
            );
        }
    }

    #[test]
    fn resume_arguments_name_the_session_once_as_literal_text() {
        let resumed = |cli: &str| {
            find(cli)
                .unwrap()
                .unwrap()
                .resume_args("86da4482-2bae-4a45-b193-a5664c19826a")
        };
        assert_eq!(
            resumed("claude").unwrap(),
            ["--resume", "86da4482-2bae-4a45-b193-a5664c19826a"]
        );
        assert_eq!(
            resumed("codex").unwrap(),
            ["resume", "86da4482-2bae-4a45-b193-a5664c19826a"]
        );
        assert_eq!(
            resumed("fake").unwrap(),
            ["--resume", "86da4482-2bae-4a45-b193-a5664c19826a"]
        );
        assert_eq!(
            resumed("opencode").unwrap(),
            ["--session", "86da4482-2bae-4a45-b193-a5664c19826a"]
        );
        assert_eq!(
            resumed("pi").unwrap(),
            ["--session", "86da4482-2bae-4a45-b193-a5664c19826a"]
        );
        assert_eq!(
            resumed("agy").unwrap(),
            ["--conversation", "86da4482-2bae-4a45-b193-a5664c19826a"]
        );
        assert_eq!(
            resumed("muse").unwrap(),
            ["resume", "86da4482-2bae-4a45-b193-a5664c19826a"]
        );
        let rule = find("claude").unwrap().unwrap();
        assert_eq!(
            rule.resume_args("${session_id}$1").unwrap(),
            ["--resume", "${session_id}$1"],
            "the ID is filled in once, as text"
        );
    }

    #[test]
    fn a_rule_file_with_an_unknown_field_mechanism_or_capture_is_refused() {
        assert!(
            refusal(
                "claude",
                &claude().replacen("\"program\"", "\"programme\"", 1)
            )
            .contains("unknown field")
        );
        assert!(
            refusal("claude", &claude().replacen("\"frame\"", "\"window\"", 1))
                .contains("unknown variant")
        );
        assert!(
            refusal(
                "claude",
                &claude().replacen("\"session_start\"", "\"session_end\"", 1)
            )
            .contains("unknown variant")
        );
        assert!(
            refusal(
                "claude",
                &claude().replacen("\"lower\":", "\"colour\": 1, \"lower\":", 1)
            )
            .contains("unknown field")
        );
        assert!(
            refusal(
                "claude",
                &claude().replacen("\"lower\": \"^─+$\"", "\"lower\": 7", 1)
            )
            .contains("invalid type")
        );
    }

    #[test]
    fn a_rule_file_with_a_wrong_name_program_argument_or_variable_is_refused() {
        assert!(refusal("codex", &claude()).contains("must be the file's name"));
        assert!(
            refusal(
                "claude",
                &claude().replacen(
                    "\"program\": \"claude\"",
                    "\"program\": \"/usr/bin/claude\"",
                    1
                )
            )
            .contains("file name")
        );
        let launch = |launch: &str| {
            claude().replacen(
                "\"program\": \"claude\",",
                &format!("\"program\": \"claude\", \"launch\": {{ {launch} }},"),
                1,
            )
        };
        assert!(refusal("claude", &launch("\"args\": [\"a\\u0000b\"]")).contains("without NUL"));
        assert!(
            refusal("claude", &launch("\"args\": [\"--session=${session_id}\"]"))
                .contains("literal")
        );
    }

    #[test]
    fn a_rule_file_with_a_bad_pattern_marker_or_count_is_refused() {
        assert!(
            refusal(
                "claude",
                &claude().replacen("\"upper\": \"", "\"upper\": \"(", 1)
            )
            .contains("regular expression")
        );
        assert!(
            refusal(
                "claude",
                &claude().replacen("\"prompt\": \"❯\"", "\"prompt\": \"❯❯\"", 1)
            )
            .contains("one character")
        );
        assert!(
            refusal(
                "claude",
                &claude().replacen("\"prompt\": \"❯\"", "\"prompt\": \"你\"", 1)
            )
            .contains("one column")
        );
        assert!(
            refusal(
                "claude",
                &claude().replacen("^↑ (\\\\d+) more lines?$", "^↑ \\\\d+ more lines?$", 1)
            )
            .contains("one capture")
        );
        let pi = FILES[5].1;
        assert!(
            refusal(
                "pi",
                &pi.replacen("\"most_rows\": 5", "\"most_rows\": 0", 1)
            )
            .contains("positive")
        );
        assert!(
            refusal(
                "pi",
                &pi.replacen("\"most_share\": 0.3", "\"most_share\": 1.5", 1)
            )
            .contains("most_share")
        );
        assert!(
            refusal("pi", &pi.replacen("\"within\": 40", "\"within\": 0", 1)).contains("positive")
        );
    }

    #[test]
    fn a_session_rule_resumes_exactly_when_it_is_captured() {
        let with = |session: &str| {
            claude().replacen(
                "\"session\": { \"capture\": \"session_start\", \"resume\": [\"--resume\", \
                 \"${session_id}\"] }",
                session,
                1,
            )
        };
        assert!(
            refusal(
                "claude",
                &with("\"session\": { \"capture\": \"session_start\" }")
            )
            .contains("needs session.resume")
        );
        assert!(
            refusal(
                "claude",
                &with(
                    "\"session\": { \"capture\": \"none\", \"resume\": [\"-r\", \
                     \"${session_id}\"] }"
                )
            )
            .contains("captured")
        );
        assert!(
            refusal(
                "claude",
                &with(
                    "\"session\": { \"capture\": \"session_start\", \"resume\": [\"--resume\"] }"
                )
            )
            .contains("exactly once")
        );
        assert!(
            refusal(
                "claude",
                &with(
                    "\"session\": { \"capture\": \"session_start\", \"resume\": \
                     [\"${session_id}\", \"${session_id}\"] }"
                )
            )
            .contains("exactly once")
        );
        assert!(
            refusal(
                "claude",
                &with(
                    "\"session\": { \"capture\": \"session_start\", \"resume\": \
                     [\"${session_id}\", \"${model}\"] }"
                )
            )
            .contains("nothing else")
        );
        let twin = FILES[2]
            .1
            .replacen("\"cli\": \"agy\"", "\"cli\": \"twin\"", 1);
        assert!(
            refusal("twin", &twin).contains("cannot have twin report its session"),
            "only CLIs Facade can have report their session capture it"
        );
    }

    #[test]
    fn rules_that_share_a_program_are_refused_and_a_broken_catalog_never_runs_a_rule_s_name_as_a_program()
     {
        let session = "\"session\": { \"capture\": \"session_start\", \"resume\": \
                       [\"--conversation\", \"${session_id}\"] }";
        let twin = FILES[2]
            .1
            .replacen("\"cli\": \"agy\"", "\"cli\": \"twin\"", 1)
            .replacen(session, "\"session\": { \"capture\": \"none\" }", 1);
        let error = read_rules(&[("agy", FILES[2].1), ("twin", &twin)]).unwrap_err();
        assert!(error.contains("belongs to another rule"), "{error}");
        let broken = read_rules(&[("claude", "{")]).unwrap_err();
        assert!(
            find_in(Err(&broken), "claude")
                .unwrap_err()
                .contains("could not be read"),
            "a rule's name fails rather than running as a program"
        );
        assert!(
            find_in(Err(&broken), "/bin/sh").unwrap().is_none(),
            "a program without a rule still starts"
        );
    }

    /// What each CLI's MCP client does that Facade's server answers to: where a tool call names its
    /// session, whose guests take Facade's instructions from the server, and the keys that load its
    /// tools from the start.
    #[test]
    fn each_cli_s_rule_says_what_its_mcp_client_does() {
        assert_eq!(
            session_meta_keys().collect::<Vec<_>>(),
            [
                "sessionId",
                "antigravity.google/root_conversation_id",
                "ai.opencode/sessionID"
            ]
        );
        let from_server: Vec<&str> = rules()
            .unwrap()
            .iter()
            .map(|rule| rule.cli.as_str())
            .filter(|cli| instructions_from_server(cli))
            .collect();
        assert_eq!(from_server, ["opencode"]);
        assert_eq!(
            always_load_keys().collect::<Vec<_>>(),
            ["anthropic/alwaysLoad", "antigravity/alwaysLoad"]
        );
    }
}
