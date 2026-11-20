//! Agent targets and terminal messages.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::process::{ProcessExit, ProcessState};
use crate::protocol::daemon::include_scrollback_by_default;

use super::{AgentInfo, AgentLabel, AgentRef, AgentTarget, ScreenBuffer, TerminalColors};

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "V3AgentArgs")]
pub struct AgentSelectorArgs {
    /// An agent's public address or exact stored reference.
    #[serde(flatten)]
    pub target: AgentTarget,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "V3TypeArgs")]
pub struct AgentTypeArgs {
    /// An agent's public address or exact stored reference.
    #[serde(flatten)]
    pub target: AgentTarget,
    /// Bytes from an attached terminal, encoded as standard base64 with padding. They are queued as
    /// they are, also between a typed text and its Enter.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw: Option<String>,
    /// Text to paste as one input: printable characters, tabs, and line breaks. When the CLI turned
    /// on bracketed paste, the text goes between the paste brackets with each line break as a
    /// carriage return; otherwise it goes as given.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Press Enter after `text`, in a write of its own 0.1 seconds and the CLI's settle time for
    /// the text after the whole text reached the terminal. Empty text with `enter` presses Enter
    /// alone. Defaults to false.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub enter: bool,
    /// Keys to press in order: Enter (or Return), Escape (or Esc), Tab, Shift+Tab, Backspace,
    /// Delete, Up, Down, Left, Right (or ArrowUp, ArrowDown, ArrowLeft, ArrowRight), Home, End,
    /// PageUp, PageDown, Space, and Ctrl+A to Ctrl+Z, in any letter case, or any one character
    /// other than a control character, exactly as given. Each goes as a terminal sends it in the
    /// CLI's modes. After an Escape, the next key waits 50 ms.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keys: Option<Vec<String>>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct TypeResult {
    /// The target that took the input. Raw terminal input keeps the empty receipt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<AgentLabel>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "V3RenameArgs")]
pub struct AgentRenameArgs {
    /// An agent's public address or exact stored reference.
    #[serde(flatten)]
    pub target: AgentTarget,
    /// The new name, trimmed. An empty or blank name gets a default name chosen from the suggested
    /// names: unused while one is available, otherwise reused. Names may repeat.
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct RenameResult {
    #[serde(flatten)]
    pub agent: AgentInfo,
    /// The name this operation replaced.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_name: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "V3ScreenArgs")]
pub struct AgentScreenArgs {
    /// The agent's address or name.
    pub agent: String,
    /// The number of lines to return, from 1 to 2000. Defaults to 50.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lines: Option<u16>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "V3ResizeArgs")]
pub struct AgentResizeArgs {
    /// An agent's public address or exact stored reference.
    #[serde(flatten)]
    pub target: AgentTarget,
    /// Terminal width in columns, at least 2.
    pub cols: u16,
    /// Terminal height in rows, at least 1.
    pub rows: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub colors: Option<TerminalColors>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ScreenSize {
    /// Terminal width in columns, at least 2.
    pub cols: u16,
    /// Terminal height in rows, at least 1.
    pub rows: u16,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "V3ScreenWatchArgs")]
pub struct ScreenWatchArgs {
    /// An agent's public address or exact stored reference.
    #[serde(flatten)]
    pub target: AgentTarget,
    /// Keep the viewer's existing scrollback. Defaults to false: every snapshot and redraw clears
    /// it first. A main-screen snapshot then replays up to 1,000 rows of the agent's scrollback
    /// unless `include_scrollback` is false. Later redraws include only the visible screen.
    /// `facade attach` sets this option to true.
    #[serde(default)]
    pub keep_scrollback: bool,
    /// Include up to 1,000 main-screen scrollback rows before the visible screen in the snapshot.
    /// Defaults to true. `facade attach` sets it to false on reconnect so the viewer does not
    /// receive those rows twice.
    #[serde(default = "include_scrollback_by_default")]
    pub include_scrollback: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub viewer: Option<String>,
    /// With an exact managed reference, allow the final snapshot of an ended run.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub allow_ended: bool,
    /// Include the agent's working state in the snapshot and report changes to it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub report_activity: bool,
    /// Request the viewer's size for the shared layout before the first snapshot of a live run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<ScreenSize>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "V3ScreenSnapshot")]
pub struct ScreenSnapshot {
    /// The ID of the agent being viewed.
    pub agent_id: String,
    pub address: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The agent's running machine, for reconnecting to its exact reference.
    pub machine_id: String,
    /// Terminal width required to apply the redraw.
    pub cols: u16,
    /// Terminal height required to apply the redraw.
    pub rows: u16,
    /// Base64-encoded terminal bytes that redraw the screen at this size. Restores cursor state,
    /// charsets, and modes. On the main screen, up to 1,000 rows of agent scrollback come first
    /// unless `include_scrollback` is false. `keep_scrollback` controls whether the viewer's
    /// existing scrollback is cleared before the redraw.
    pub redraw: String,
    /// The recorded exit, if the agent has ended.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit: Option<ProcessExit>,
    /// The shell exit status calculated on the machine that ran the agent, if known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_status: Option<i32>,
    /// The CLI's resume instructions for a Shell attachment that opens an ended run.
    /// Empty when it printed none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_hint: Option<String>,
    /// The agent's process state captured with this snapshot.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process: Option<ProcessState>,
    /// Whether the agent is starting or working, when the watch requested activity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub working: Option<bool>,
}

impl ScreenSnapshot {
    pub fn reference(&self) -> AgentRef {
        AgentRef {
            machine_id: self.machine_id.clone(),
            agent_id: self.agent_id.clone(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "V3ScreenText")]
pub struct ScreenText {
    pub agent_id: String,
    pub address: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Whether the agent's CLI is running. An ended agent's screen is the one it left.
    pub process: ProcessState,
    /// When the screen was read, in UTC ISO 8601 format with milliseconds; for an ended agent, when
    /// it ended, as its screen is the one it left.
    pub observed_at: String,
    pub buffer: ScreenBuffer,
    /// The lines, joined by line feeds, each wrapped row joined into its line. Inverse text is
    /// between `[[` and `]]` and dim text between `{{` and `}}`, inverse outside dim. Each
    /// backslash, bracket, and brace of the screen's own text is escaped with a backslash, so
    /// removing the marks and the escapes gives the text exactly; see [`crate::daemon::plain`].
    pub text: String,
    /// How many lines `text` holds.
    pub line_count: u32,
    /// Whether output lies above the lines read.
    pub older_lines: bool,
    /// Whether the scrollback let go of its oldest lines.
    pub trimmed: bool,
}
