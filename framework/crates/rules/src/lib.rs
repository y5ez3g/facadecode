//! What Facade knows about each CLI it starts by name. Each CLI has a rule file in `framework/rules/`,
//! built into the program and checked as it is read: the program to run and how it reads its
//! arguments, how its session is reported and resumed, how its screen draws its message input and
//! takes a paste, what its screen shows of its state where its own reports do not say it, and how
//! Facade's tools and hooks enter it.
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
use std::sync::LazyLock;
use std::time::Duration;

use facade_base::key_input::Key;
use facade_base::model::agent::WaitKind;
use facade_base::model::terminal::InputMechanism;
use facade_base::system::{SYSTEM, System};
use facade_base::terminal::KeyRecord;
use regex::Regex;
use serde::de::Error as _;
use serde::{Deserialize, Deserializer};

pub use command_line::{Choices, TrustQuestion, YoloRule, entries};
pub use compose::{
    CommandLine, LaunchOrigin, LaunchPolicy, resume_managed_launch_command,
    start_managed_launch_command,
};
pub use formats::shell_word;
pub use input::{
    BoxReading, InputLine, LineCell, PasteDisclosure, PasteDrawing, ProbeVerdict, canonical_text,
    could_be_paste_prefix, draft_backspace_count, is_full_draft, is_legacy_split_paste,
    is_own_draft, is_own_paste_tail, is_own_recovered_draft, is_paste_placeholder, is_same_draft,
    read_box, read_box_after_paint, read_box_for_screen, read_box_for_typing, read_box_with_redraw,
    read_draft, read_input, restored, settle_time, shape_of, shows_original_text, shows_paste_end,
    shows_paste_placeholder, shows_whole, space_taken, verdict_of, with_paste_text,
};
pub use sessions::{
    Reported, SESSION_FILE, SESSION_VARIABLES, SavedSession, SessionFile, WriteFailure,
    is_session_variable, list_sessions, parse_session_id, read_session_file, run_folder,
    session_evidence, session_for_id, session_from_hook, session_from_prompt, session_from_title,
    session_variable, write_session_file,
};
pub use state::{ScreenState, read_state};
pub use wiring::{
    INSTRUCTIONS_FILE, PLUGIN_FOLDER, PLUGIN_MEMBERS, SKILL_FILE, Server, SessionReport, Tools,
    guest_entry_serves_run, hook, integration, managed_cli_for_project_guest, plugin_files,
    plugin_version, project_guest_reply, restore_config_environment, runs_start_guest_entry,
    session_ends_with_process, uses_folder_plugin,
};
pub use wrappers::direct_command;

pub(crate) use sessions::qoder_config_dir;
pub(crate) use wiring::devin_config_dir;

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
const FILES: [(&str, &str); 12] = [
    ("claude", include_str!("../../../rules/claude.json")),
    ("codex", include_str!("../../../rules/codex.json")),
    ("agy", include_str!("../../../rules/agy.json")),
    ("muse", include_str!("../../../rules/muse.json")),
    ("opencode", include_str!("../../../rules/opencode.json")),
    ("pi", include_str!("../../../rules/pi.json")),
    ("devin", include_str!("../../../rules/devin.json")),
    ("agent", include_str!("../../../rules/agent.json")),
    ("kiro-cli", include_str!("../../../rules/kiro-cli.json")),
    ("qoder", include_str!("../../../rules/qoder.json")),
    ("omp", include_str!("../../../rules/omp.json")),
    ("copilot", include_str!("../../../rules/copilot.json")),
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
    /// How Facade reads the CLI's state from its screen or a report's words.
    #[serde(default)]
    pub status: Option<StateRule>,
    /// The status glyph the CLI puts before its terminal title and leaves out when the terminal takes its reports.
    #[serde(default)]
    pub status_glyph: Option<StatusGlyph>,
    /// What a run's start types so that the CLI starts Facade's tools before its first turn, for a
    /// CLI that starts a folder's servers only with its first turn or its panel of MCP servers
    /// (COLLABORATION-2.2).
    #[serde(default)]
    pub ready_tools: Option<ReadyTools>,
    /// What the CLI's MCP client does that Facade's MCP server answers to.
    #[serde(default)]
    pub mcp: McpRule,
    /// The CLI's work options for YOLO and its startup options for agent starts with YOLO.
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
    /// The CLI initializes its managed relay at startup and lists tools on its first turn.
    #[serde(default)]
    pub deferred_tool_list: bool,
    /// The `_meta` key in which a tool call names its session, for a CLI whose one MCP server
    /// serves many sessions. A CLI that starts an MCP server for each session names it in the
    /// server's environment instead.
    #[serde(default)]
    pub session_meta_key: Option<String>,
    /// A variable the CLI supplies to each of its stdio servers for the server's own session.
    #[serde(default)]
    pub session_env_key: Option<String>,
    /// The CLI gets a managed run's instructions from its hook or extension.
    #[serde(default)]
    pub managed_instructions_from_hook: bool,
}

/// What a run's start types to ready the CLI's tools: `text` once the input first reads empty,
/// Enter once the input shows it alone, then `close` once the open panel shows the tools `ready`.
/// The startup allowance bounds the waits for these frames. Patterns match a screen line without
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

/// What typing into a CLI that reads console input records needs: a wait before submission for each
/// character typed, and characters above U+FFFF sent as key-down records.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConsoleRule {
    /// The wait before submission, in milliseconds, for each UTF-16 code unit of the text typed.
    pub per_char_ms: u64,
    /// Characters above U+FFFF go as win32-input-mode key-down records: the CLI loses them
    /// otherwise.
    pub records_above_bmp: bool,
    /// The key that puts a line break in the CLI's input. A message's line breaks go as that key
    /// where the CLI submits on Enter and tells a pasted Enter from a typed one only by time.
    #[serde(default)]
    line_break: Option<LineBreakKey>,
}

/// A key that puts a line break in a CLI's input.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum LineBreakKey {
    ShiftEnter,
}

impl LineBreakKey {
    fn record(self) -> KeyRecord {
        match self {
            Self::ShiftEnter => KeyRecord::SHIFT_ENTER,
        }
    }
}

/// How the typist types into a CLI where it reads console input records.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ConsoleTyping {
    /// The wait before submission for each UTF-16 code unit of the text typed.
    pub per_char: Duration,
    /// Characters above U+FFFF go as key-down records
    /// ([`facade_base::terminal::key_down_records`]).
    pub records_above_bmp: bool,
    /// The key a line break goes as, pressed, for a CLI whose Enter submits.
    pub line_break: Option<KeyRecord>,
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
        line_break: console.line_break.map(LineBreakKey::record),
    })
}

/// How the CLI takes a pasted message: its terminal mode, what its input shows, and how long
/// the CLI takes to settle the draft and to show an empty input after submission.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PasteRule {
    /// The CLI enables bracketed paste on every screen where Facade can deliver a message.
    #[serde(default)]
    bracketed: bool,
    /// How long a message shows as the input's own draft before submission, in milliseconds.
    #[serde(default)]
    pub enter_ms: u64,
    /// Tab queues a message in this CLI while it is working.
    #[serde(default)]
    tab_while_working: bool,
    /// How much longer for each line of the message, in milliseconds.
    #[serde(default)]
    pub line_ms: u64,
    /// The measured upper bound from the submission key to an empty input, in milliseconds.
    #[serde(default)]
    submit_clear_ms: Option<u64>,
    /// Delay before repeating a submission key proven harmless on an empty input.
    #[serde(default)]
    retry_submit_ms: Option<u64>,
    /// The CLI can draw the paste in pieces on Windows even without console input settings.
    #[serde(default)]
    check_paste_end_on_windows: bool,
    /// What the input shows in place of a long paste.
    #[serde(default)]
    pub placeholders: Vec<PastePlaceholder>,
    /// Prefixes a previous build typed before it pasted the rest of a delivery.
    #[serde(default)]
    legacy_split_prefixes: Vec<String>,
    /// The editor's deletion unit for a literal draft, where it has been established.
    #[serde(default)]
    backspace_unit: Option<BackspaceUnit>,
    /// Characters the editor deletes individually when they end a draft.
    #[serde(default)]
    backspace_single_code_points: Option<Pattern>,
    /// The exact single-row label offering Tab to reveal a collapsed paste.
    #[serde(default)]
    pub tab_to_expand: Option<Pattern>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum BackspaceUnit {
    CodePoint,
    Grapheme,
    LegacyGrapheme,
}

/// What the input shows in place of a long paste, such as `[Pasted text #1 +3 lines]`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PastePlaceholder {
    /// The placeholder without its spaces, or with each run of them as one where `spaced` is
    /// true. A numbered count has one capture for the size shown. A single-line form has none.
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

/// How a paste's size is shown in its placeholder.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PasteCount {
    /// The paste's lines.
    Lines,
    /// Its lines after trimming whitespace from both ends.
    TrimmedLines,
    /// Its lines after the first.
    LinesAfterFirst,
    /// A paste without a line break uses a placeholder with no size count.
    SingleLine,
    /// Its characters, as code points or as UTF-16 units.
    Chars,
    /// Its characters, as Unicode scalar values. A differing UTF-16 unit count is rejected.
    UnicodeScalars,
    /// Its characters, as UTF-16 units.
    Utf16,
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
    /// The nonpersistent updater switches for agent starts.
    #[serde(default)]
    pub agent_env: BTreeMap<String, String>,
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
    /// A stopped managed run can resume only if the CLI has saved the session in its history.
    #[serde(default)]
    pub resume_requires_saved_session: bool,
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
    /// Input in a frame of two rules, with a prompt row unless it scrolled out.
    Frame(Frame),
    /// A prompt row above a model line, or with scroll marks when the model line is absent.
    Prompt(Prompt),
    /// An editor between two rules, with a cursor in its text.
    Editor(Editor),
    /// A box of bar rows above a half-block border.
    Box(BoxInput),
    /// The last row that starts with the prompt holds the input.
    PromptRow {
        prompt: String,
        alternate_prompt: Option<String>,
        /// A native placeholder identifies a cursor-anchored, possibly wrapped composer.
        placeholder: Option<Pattern>,
        /// A colored hint the native CLI shows before its composer is ready.
        unready_hint: Option<Pattern>,
        /// A paste marker that the CLI draws dim, like a hint.
        dim_draft: Option<Pattern>,
        /// The CLI hides the terminal cursor and draws its own, one inverse cell in its input box.
        #[serde(default)]
        drawn_cursor: bool,
        #[serde(default)]
        menus: Vec<Menu>,
    },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Frame {
    /// Blank columns before the prompt and wrapped lines.
    #[serde(default)]
    pub indent: usize,
    pub prompt: String,
    /// The prompt glyph in another permission mode.
    pub alternate_prompt: Option<String>,
    /// The cell after the prompt glyph.
    pub gap: String,
    pub upper: Pattern,
    pub lower: Pattern,
    pub scrolled: Scrolled,
    /// A mode's text drawn in an empty input, known by the footer under the frame.
    #[serde(default)]
    pub placeholder: Option<ModePlaceholder>,
    /// A single-row dim hint whose first glyph is under the CLI's inverted cursor.
    #[serde(default)]
    pub(crate) dim_cursor_hint: Option<String>,
    /// The CLI can draw a hint in the same style as a draft in a fresh input.
    #[serde(default)]
    pub probe_unstyled_hint: bool,
    /// The CLI also scrolls a draft taller than its frame without a mark, its prompt row with the
    /// draft's first rows.
    #[serde(default)]
    pub(crate) scrolls_unmarked: bool,
    /// A hidden terminal cursor supplies its position inside the complete input frame.
    #[serde(default)]
    pub(crate) hidden_cursor_in_frame: bool,
    /// Whole rows immediately above the upper rule while the CLI is preparing the input.
    #[serde(default)]
    pub(crate) waiting_above: Vec<Pattern>,
    pub menus: Vec<Menu>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Prompt {
    /// The prompt in the prompt row's first column.
    pub prompt: String,
    /// Another glyph the input may show in that same column.
    #[serde(default)]
    pub alternate_prompt: Option<String>,
    pub model_line: Pattern,
    /// A bottom hint that can follow several indented rows of the model footer.
    #[serde(default)]
    pub wrapped_footer_hint: Option<Pattern>,
    pub scrolled: Scrolled,
    pub menus: Vec<Menu>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Editor {
    /// The CLI may use the terminal cursor instead of painting its own cursor.
    #[serde(default)]
    pub hardware_cursor: bool,
    /// An optional one-row status band above the editor's prompt and its styled margin.
    #[serde(default)]
    pub(crate) band: Option<EditorBand>,
    /// An editor with a rail and a plain fallback, both identified by their interactive footer.
    #[serde(default)]
    pub(crate) rail: Option<EditorRail>,
    /// Notices above the editor while the CLI is provisioning its startup tools.
    #[serde(default)]
    pub(crate) provisioning: Vec<EditorProvisioning>,
    pub upper: Pattern,
    pub lower: Pattern,
    pub scrolled: Scrolled,
    /// The editor is at most this many rows tall, or this share of the screen where that is more.
    pub most_rows: usize,
    pub most_share: f64,
    /// The rows the CLI keeps of its editor, rules included, where the screen has no room for it
    /// all. Pi 1.4.0's full-screen layout keeps three: `minSize` of the editor at line 16 of
    /// pi-coding-agent's `dist/modes/interactive/chat-viewport.js`.
    #[serde(default)]
    pub(crate) least_rows: Option<usize>,
    #[serde(default)]
    pub(crate) question: Option<Question>,
    pub menus: Vec<Menu>,
}

/// A question the CLI asks with an editor of its own, in place of its input: a rule, the question,
/// the editor and the keys that answer it, with a blank row between each two. Pi 1.4.0 draws it in
/// pi-coding-agent's `dist/modes/interactive/components/extension-editor.js`, lines 37 to 68.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Question {
    /// The rule over the question.
    pub(crate) top: Pattern,
    /// The row of the keys, the first of them where they wrap.
    pub(crate) keys: Pattern,
    /// How many rows the CLI's own footer has, right under its input. The CLI cuts them before the
    /// keys.
    pub(crate) footer_rows: usize,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct EditorProvisioning {
    pub(crate) downloading: Pattern,
    pub(crate) finished: Pattern,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct EditorBand {
    pub(crate) top: Pattern,
    pub(crate) prompt: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct EditorRail {
    pub(crate) fallback_prompt: String,
    pub(crate) footer: Pattern,
    #[serde(default)]
    pub(crate) working_footer: Option<Pattern>,
    #[serde(default)]
    pub(crate) live_notice: Option<EditorLiveNotice>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct EditorLiveNotice {
    pub(crate) text: String,
    #[serde(default)]
    pub(crate) wait_kind: Option<WaitKind>,
    pub(crate) rows_above_upper: std::num::NonZeroUsize,
    #[serde(default)]
    pub(crate) wrapped_context: Option<EditorNoticeContext>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct EditorNoticeContext {
    pub(crate) max_rows: std::num::NonZeroUsize,
    pub(crate) last: Pattern,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EditorHeight {
    pub min_rows: usize,
    pub reserved_rows: usize,
    pub min_reserved_rows: usize,
}

impl EditorHeight {
    pub(crate) fn visible_rows(&self, screen: usize, maximum: usize) -> usize {
        screen
            .saturating_sub(self.reserved_rows)
            .clamp(self.min_rows, maximum)
            .min(screen.saturating_sub(self.min_reserved_rows))
            .max(1)
    }
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
    /// Below this screen width, the interior gap is one space. Otherwise it is two.
    pub narrow_below: usize,
    /// The text of an empty box.
    pub placeholder: Pattern,
    pub menus: Vec<Menu>,
}

/// How Facade reads the CLI's state from its screen or a report's words.
/// Screen patterns match a whole logical line (the rows a soft wrap joins), without its trailing spaces.
#[derive(Debug, Deserialize)]
#[serde(tag = "mechanism", rename_all = "snake_case", deny_unknown_fields)]
pub enum StateRule {
    /// A drawn composer and the native work or question text near it.
    Composer(ComposerStatus),
    /// For a CLI that may send no state reports, read until it reports, around its input frame:
    /// working while its working line stands above the frame, idle in its known resting layout,
    /// waiting for the person while a sign-in or trust question stands in place of the frame.
    FrameTranscript(Box<FrameTranscript>),
    /// For a CLI that reports `working` while commands it left in the background outlive its turn:
    /// a finished turn above its input prompt narrows that report to idle.
    BackgroundCorrection(Box<BackgroundCorrection>),
    /// For a CLI that reports `working` while work it left in the background outlives its turn, and names that work
    /// in the report's words: such a report reads as `idle`.
    BackgroundReport(Box<BackgroundReport>),
    /// For a CLI that reports a turn whose model call failed as a turn that ended: the error drawn
    /// right above the turn's summary, at the end of the conversation over the input box, turns
    /// the report into an error with the error's words. The patterns guard every version: a
    /// layout drawn otherwise stops matching and reads nothing.
    TurnError(Box<TurnError>),
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ComposerStatus {
    #[serde(default)]
    pub working: Vec<Pattern>,
    /// A trailing dim hint drawn beside an empty composer during work.
    pub working_hint: Option<String>,
    #[serde(default)]
    pub authentication: Vec<Pattern>,
    #[serde(default)]
    pub permission: Vec<Pattern>,
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
    /// The CLI reports an answer that asks the person something as a question, though its turn has
    /// ended and its input is there. The report then reads as `done`.
    #[serde(default)]
    pub answers_ask: bool,
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
    /// The dim summary of the finished turn, above that line.
    pub worked: Pattern,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BackgroundReport {
    /// The words of a `working` report sent while only background work runs.
    pub background: Pattern,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StatusGlyph {
    /// The glyph frames shown in turn while the CLI works.
    pub working: Vec<String>,
    /// The glyph shown while it is idle, just done, waits for the person or is in error.
    pub resting: String,
    /// How long each working glyph frame shows.
    pub frame_ms: u64,
}

/// How a CLI shows a draft scrolled out of the input.
#[derive(Debug, Deserialize)]
#[serde(tag = "position", rename_all = "snake_case", deny_unknown_fields)]
pub enum Scrolled {
    /// Separate rows inside the frame.
    Rows(CountedScroll),
    /// Markers on the upper and lower border rules.
    Rules(CountedScroll),
    /// Dim glyphs in the last column of the first and last input rows, without counts.
    LastColumn { above: String, below: String },
    /// An editor with a fixed viewport and no scroll markers.
    Unmarked(EditorHeight),
}

/// Each pattern's one capture counts the hidden rows on that side. A mark without a number, the
/// capture left out, counts as one.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CountedScroll {
    pub above: Pattern,
    pub below: Pattern,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModePlaceholder {
    pub texts: Vec<String>,
    pub footer: Pattern,
}

/// A menu or question drawn in place of the CLI's input, identified by an anchor line and any
/// required lines below it.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Menu {
    pub selected: MenuLinePattern,
    /// A pane below the prompt can still take input while that prompt shows its cursor.
    #[serde(default)]
    pub below_prompt: bool,
    /// The anchor's first logical line never matches this.
    #[serde(default)]
    pub not_selected: Option<Pattern>,
    #[serde(default)]
    pub next: Option<MenuLinePattern>,
    #[serde(default)]
    pub hint: Option<Hint>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Hint {
    pub pattern: MenuLinePattern,
    /// How many logical lines after the anchor may start the hint.
    pub within: usize,
}

/// Match a terminal's logical line, or exact text a CLI lays out on successive lines itself.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum MenuLinePattern {
    Regex(Pattern),
    Wrapped(WrappedMenuText),
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WrappedMenuText {
    /// The prefix at the start of the first line, including indentation and any option marker.
    pub prefix: Pattern,
    pub text: String,
    /// The number of spaces the CLI adds to each manually continued line.
    pub indent: usize,
    /// The CLI starts a separate hint or explanation with dim text at the same indentation.
    #[serde(default)]
    pub stop_at_dim: bool,
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
            self.status_glyph
                .as_ref()
                .and_then(|glyph| glyph.check().err()),
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

    /// The input layout a screen-based `status` mechanism may need.
    fn state_problem(&self) -> Result<(), String> {
        let Some(state) = &self.status else {
            return Ok(());
        };
        match state {
            StateRule::Composer(composer) => {
                if composer
                    .working_hint
                    .as_ref()
                    .is_some_and(|hint| hint.is_empty() || !is_literal(hint))
                {
                    return Err("a composer working hint must be nonempty literal text".into());
                }
                Ok(())
            }
            StateRule::FrameTranscript(transcript) => transcript.check(&self.input),
            StateRule::BackgroundCorrection(correction) => correction.check(&self.input),
            StateRule::BackgroundReport(_) => Ok(()),
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
    /// Whether automatic delivery uses paste brackets.
    pub fn brackets_delivery(&self) -> bool {
        self.bracketed
    }

    /// How long this CLI has to show an empty input after its submission key reaches it.
    pub fn submit_clear_time(&self) -> Option<Duration> {
        self.submit_clear_ms.map(Duration::from_millis)
    }

    /// How long to wait before repeating a submission key over the same draft.
    pub fn retry_submit_time(&self) -> Option<Duration> {
        self.retry_submit_ms.map(Duration::from_millis)
    }

    /// Whether delivery on this platform must see the end of the paste before submitting.
    pub fn checks_paste_end(&self) -> bool {
        cfg!(windows) && self.check_paste_end_on_windows
    }

    /// Which key submits a checked message draft.
    pub fn submission_key(&self, working: bool) -> Key {
        if working && self.tab_while_working {
            Key::Tab
        } else {
            Key::Enter
        }
    }

    fn check(&self) -> Result<(), String> {
        for (index, each) in self.placeholders.iter().enumerate() {
            let expected = usize::from(each.count != PasteCount::SingleLine);
            if each.pattern.captures_len() != expected + 1 {
                return Err(format!(
                    "paste.placeholders[{index}].pattern must have {expected} captures for {:?}",
                    each.count
                ));
            }
        }
        Ok(())
    }
}

impl InputRule {
    fn check(&self) -> Result<(), String> {
        match self {
            InputRule::Frame(frame) => frame.check()?,
            InputRule::Prompt(prompt) => {
                one_cell("prompt", &prompt.prompt)?;
                if let Some(alternate) = &prompt.alternate_prompt {
                    one_cell("alternate_prompt", alternate)?;
                }
                let Scrolled::LastColumn { above, below } = &prompt.scrolled else {
                    return Err("prompt requires scrolled.position last_column".into());
                };
                one_cell("scrolled.above", above)?;
                one_cell("scrolled.below", below)?;
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
            InputRule::PromptRow {
                prompt,
                alternate_prompt,
                placeholder,
                drawn_cursor,
                ..
            } => {
                if *drawn_cursor && placeholder.is_none() {
                    return Err("drawn_cursor requires a placeholder".into());
                }
                let visible = std::iter::once(prompt)
                    .chain(alternate_prompt)
                    .all(|prompt| {
                        !prompt.trim().is_empty() && !prompt.chars().any(char::is_control)
                    });
                if !visible {
                    return Err("prompt must be visible text".into());
                }
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
    pub fn mechanism(&self) -> InputMechanism {
        self.layout().0
    }

    /// The layout's name in the protocol, and its menus.
    fn layout(&self) -> (InputMechanism, &[Menu]) {
        match self {
            InputRule::Frame(Frame { menus, .. }) => (InputMechanism::Frame, menus),
            InputRule::Prompt(Prompt { menus, .. }) => (InputMechanism::Prompt, menus),
            InputRule::Editor(Editor { menus, .. }) => (InputMechanism::Editor, menus),
            InputRule::Box(BoxInput { menus, .. }) => (InputMechanism::Box, menus),
            InputRule::PromptRow { menus, .. } => (InputMechanism::PromptRow, menus),
        }
    }
}

impl Frame {
    fn check(&self) -> Result<(), String> {
        one_cell("prompt", &self.prompt)?;
        if let Some(alternate) = &self.alternate_prompt {
            one_cell("alternate_prompt", alternate)?;
        }
        self.indent.checked_add(2).ok_or("indent is too large")?;
        one_cell("gap", &self.gap)?;
        match &self.scrolled {
            Scrolled::Rows(marks) | Scrolled::Rules(marks) => marks.check()?,
            Scrolled::LastColumn { .. } | Scrolled::Unmarked(_) => {
                return Err("frame requires scrolled.position rows or rules".into());
            }
        }
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
        if let Some(rail) = &self.rail {
            if !self.hardware_cursor
                || self.band.is_some()
                || !matches!(self.scrolled, Scrolled::Unmarked(_))
            {
                return Err(
                    "an editor rail requires a hardware cursor, unmarked scroll and no status band"
                        .into(),
                );
            }
            if rail.fallback_prompt.trim().is_empty()
                || !rail.fallback_prompt.ends_with(' ')
                || rail.fallback_prompt.chars().any(char::is_control)
            {
                return Err(
                    "an editor rail needs a visible fallback prompt ending in a space".into(),
                );
            }
            if let Some(notice) = &rail.live_notice {
                if notice.text.is_empty()
                    || notice.text.trim() != notice.text
                    || notice.text.chars().any(char::is_control)
                {
                    return Err(
                        "an editor live notice needs visible text without edge whitespace".into(),
                    );
                }
                if notice.wait_kind == Some(WaitKind::Unrecognized) {
                    return Err("an editor live notice needs a recognized wait kind".into());
                }
            }
        }
        if let Some(band) = &self.band {
            if !self.hardware_cursor || !matches!(self.scrolled, Scrolled::Unmarked(_)) {
                return Err(
                    "an editor status band requires a hardware cursor and unmarked scroll".into(),
                );
            }
            if band.prompt.trim().is_empty()
                || !band.prompt.ends_with(' ')
                || band.prompt.chars().any(char::is_control)
            {
                return Err(
                    "an editor status band needs a visible prompt ending in a space".into(),
                );
            }
        }
        if self.most_rows == 0 {
            return Err("most_rows must be positive".into());
        }
        if self.least_rows.is_some_and(|least| least < 3) {
            return Err("least_rows must hold a row between two rules".into());
        }
        if self
            .question
            .as_ref()
            .is_some_and(|question| question.footer_rows == 0)
        {
            return Err("question.footer_rows must be positive".into());
        }
        match &self.scrolled {
            Scrolled::Rules(marks) => marks.check()?,
            Scrolled::Unmarked(height) if (1..=self.most_rows).contains(&height.min_rows) => {}
            _ => return Err("an editor must give scroll markers or its unmarked height".into()),
        }
        if (0.0..=1.0).contains(&self.most_share) && self.most_share != 0.0 {
            Ok(())
        } else {
            Err("most_share must be more than 0 and at most 1".into())
        }
    }
}

impl CountedScroll {
    fn check(&self) -> Result<(), String> {
        counts_rows("scrolled.above", &self.above)?;
        counts_rows("scrolled.below", &self.below)
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

impl StatusGlyph {
    fn check(&self) -> Result<(), String> {
        if self.working.is_empty() || self.working.iter().any(String::is_empty) {
            return Err(
                "status_glyph.working must list at least one glyph frame, each nonempty".into(),
            );
        }
        if self.resting.is_empty() {
            return Err("status_glyph.resting must be a nonempty glyph".into());
        }
        if self.frame_ms == 0 {
            return Err("status_glyph.frame_ms must be positive".into());
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

/// Whether a launch rule can set this exact variable and value.
pub fn is_launch_env_value(name: &str, value: &str) -> bool {
    rules().is_ok_and(|rules| {
        rules.iter().any(|rule| {
            [
                &rule.launch.agent_env,
                &rule.yolo.work.env,
                &rule.yolo.startup.env,
            ]
            .iter()
            .any(|env| env.get(name).is_some_and(|generated| generated == value))
        })
    })
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

/// What the rules say about the CLIs' MCP clients, in the order `facade` lists the CLIs. A
/// release always reads its rules: one whose rule files cannot be read fails their tests.
fn mcp_rules() -> impl Iterator<Item = &'static McpRule> {
    rules().unwrap_or_default().iter().map(|rule| &rule.mcp)
}

/// The `_meta` keys in which the CLIs' tool calls name their session.
pub fn session_meta_keys() -> impl Iterator<Item = &'static str> {
    mcp_rules().filter_map(|mcp| mcp.session_meta_key.as_deref())
}

/// Whether this CLI gets a managed run's instructions from its hook or extension.
pub fn managed_instructions_from_hook(cli: &str) -> bool {
    matches!(find(cli), Ok(Some(rule)) if rule.mcp.managed_instructions_from_hook)
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

    fn refusal(name: &str, text: &str) -> String {
        Rule::parse(name, text).expect_err("the rule must be refused")
    }

    #[test]
    fn embedded_input_rules_use_one_shape_for_hidden_row_markers() {
        for (cli, source) in FILES {
            let rule: serde_json::Value = serde_json::from_str(source).unwrap();
            let input = rule["input"].as_object().unwrap();
            for field in ["above", "below", "scroll_marks"] {
                assert!(!input.contains_key(field), "{cli}: {field}");
            }
            let position = match cli {
                "agy" | "muse" | "devin" | "qoder" => "rows",
                "claude" | "pi" => "rules",
                "codex" => "last_column",
                "omp" | "copilot" => "unmarked",
                _ => {
                    assert!(!input.contains_key("scrolled"), "{cli}");
                    continue;
                }
            };
            let scrolled = input["scrolled"].as_object().unwrap();
            assert_eq!(scrolled["position"], position, "{cli}");
            if position == "unmarked" {
                assert_eq!(scrolled.len(), 4, "{cli}: {scrolled:?}");
                for field in ["min_rows", "reserved_rows", "min_reserved_rows"] {
                    assert!(scrolled[field].as_u64().is_some(), "{cli}: {field}");
                }
                continue;
            }
            assert_eq!(scrolled.len(), 3, "{cli}: {scrolled:?}");
            for field in ["above", "below"] {
                assert!(
                    scrolled[field]
                        .as_str()
                        .is_some_and(|mark| !mark.is_empty()),
                    "{cli}: {field}"
                );
            }
        }
    }

    #[test]
    fn claude_s_rule_reads_background_reports_and_status_glyph() {
        let claude = find("claude").unwrap().unwrap();
        let status = claude.status.as_ref().unwrap();
        let StateRule::BackgroundReport(report) = status else {
            panic!("Claude Code's status must use background_report");
        };
        assert!(report.background.is_match("2 tasks still running"));
        assert!(!report.background.is_match("Still working"));
        assert!(
            !report
                .background
                .is_match("2 tasks still running in parallel")
        );

        let glyph = claude.status_glyph.as_ref().unwrap();
        assert_eq!(glyph.working, ["◐", "◑"]);
        assert_eq!(glyph.resting, "✳");
        assert_eq!(glyph.frame_ms, 960);
    }

    #[test]
    fn a_rule_file_with_an_empty_status_glyph_or_zero_interval_is_refused() {
        for (field, replacement, problem) in [
            (r#"["◐", "◑"]"#, "[]", "status_glyph.working"),
            (r#"["◐", "◑"]"#, r#"["", "◑"]"#, "status_glyph.working"),
            (r#""✳""#, r#""""#, "status_glyph.resting"),
            (
                r#""frame_ms": 960"#,
                r#""frame_ms": 0"#,
                "status_glyph.frame_ms",
            ),
        ] {
            let malformed = claude().replacen(field, replacement, 1);
            assert!(refusal("claude", &malformed).contains(problem));
        }
    }

    #[test]
    fn a_console_cli_s_line_breaks_go_as_the_key_its_rule_names() {
        for cli in ["codex", "muse"] {
            let rule = find(cli).unwrap().unwrap();
            let named = rule.console.as_ref().unwrap().line_break;
            assert_eq!(named, Some(LineBreakKey::ShiftEnter), "{cli}");
            let typing = console_typing(rule);
            if SYSTEM == System::Windows {
                assert_eq!(
                    typing.unwrap().line_break,
                    Some(KeyRecord::SHIFT_ENTER),
                    "{cli}"
                );
            } else {
                assert_eq!(
                    typing, None,
                    "{cli}: elsewhere it reads the terminal's bytes"
                );
            }
        }
        // A rule that names none keeps the terminal's carriage return.
        let codex = FILES[1].1;
        let without = Rule::parse(
            "codex",
            &codex.replacen(", \"line_break\": \"shift_enter\"", "", 1),
        )
        .unwrap();
        assert_eq!(without.console.as_ref().unwrap().line_break, None);
        assert!(console_typing(&without).is_none_or(|typing| typing.line_break.is_none()));
        let refused = refusal(
            "codex",
            &codex.replacen("\"shift_enter\"", "\"meta_enter\"", 1),
        );
        assert!(refused.contains("unknown variant"), "{refused}");
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
            [
                "claude", "codex", "agy", "muse", "opencode", "pi", "devin", "agent", "kiro-cli",
                "qoder", "omp", "copilot", "fake"
            ]
        );
        let names = |files: &[(&str, &str)]| {
            files
                .iter()
                .map(|(name, _)| name.to_string())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            names(&FILES),
            [
                "claude", "codex", "agy", "muse", "opencode", "pi", "devin", "agent", "kiro-cli",
                "qoder", "omp", "copilot"
            ],
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
    fn every_ruled_cli_enables_bracketed_paste_on_its_delivery_screens() {
        for rule in rules().unwrap() {
            assert!(rule.paste.brackets_delivery(), "{}", rule.cli);
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
            let mut rule: serde_json::Value = serde_json::from_str(&claude()).unwrap();
            rule["launch"] = serde_json::from_str(&format!("{{ {launch} }}")).unwrap();
            rule.to_string()
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
                &claude().replacen("↑ (\\\\d+) more", "↑ \\\\d+ more", 1)
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
            refusal(
                "pi",
                &pi.replacen("\"least_rows\": 3", "\"least_rows\": 2", 1)
            )
            .contains("least_rows")
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
    /// session and which managed runs get their instructions through a hook or extension.
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
        let from_hook: Vec<&str> = rules()
            .unwrap()
            .iter()
            .map(|rule| rule.cli.as_str())
            .filter(|cli| managed_instructions_from_hook(cli))
            .collect();
        assert_eq!(from_hook, ["agy", "muse", "pi"]);
    }
}
