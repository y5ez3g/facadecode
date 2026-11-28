//! Shared launch commands and terminal colors. The daemon can receive an omitted folder.
//! The keeper gets the resolved folder.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// Private launch context, excluded from the CLI's environment by the daemon.
pub const LAUNCH_CONTEXT: &str = "FACADE_LAUNCH_CONTEXT";
const UNATTENDED: &str = "FACADE_LAUNCH_UNATTENDED";

/// Carries the Shell's explicit background launch choice.
pub fn carry_unattended(env: &mut BTreeMap<String, String>, unattended: bool) {
    if unattended {
        env.insert(UNATTENDED.into(), "1".into());
    } else {
        env.remove(UNATTENDED);
    }
}

/// Takes the private entry out of the environment before it is used to launch a CLI.
pub fn take_unattended(env: &mut BTreeMap<String, String>) -> bool {
    env.remove(UNATTENDED).as_deref() == Some("1")
}

/// The reported subset of a terminal's colors as 8-bit sRGB triples.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LaunchColors {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub foreground: Option<[u8; 3]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background: Option<[u8; 3]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<[u8; 3]>,
    #[serde(default, skip_serializing_if = "empty_ansi_palette")]
    pub ansi: [Option<[u8; 3]>; 16],
}

fn empty_ansi_palette(colors: &[Option<[u8; 3]>; 16]) -> bool {
    colors.iter().all(Option::is_none)
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct TerminalContext {
    terminal_colors: LaunchColors,
}

/// Carries a nonempty color sample in the launch environment.
pub fn carry_terminal_colors(env: &mut BTreeMap<String, String>, colors: &LaunchColors) {
    if *colors == LaunchColors::default() {
        env.remove(LAUNCH_CONTEXT);
        return;
    }
    let context = TerminalContext {
        terminal_colors: *colors,
    };
    env.insert(
        LAUNCH_CONTEXT.into(),
        serde_json::to_string(&context).expect("the terminal context is JSON"),
    );
}

/// Removes the reserved entry and returns its colors if valid and nonempty.
pub fn take_terminal_colors(env: &mut BTreeMap<String, String>) -> Option<LaunchColors> {
    let entry = env.remove(LAUNCH_CONTEXT)?;
    let context: TerminalContext = serde_json::from_str(&entry).ok()?;
    let colors = context.terminal_colors;
    (colors != LaunchColors::default()).then_some(colors)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StartCommand<F> {
    pub program: String,
    pub args: Vec<String>,
    pub folder: F,
}

impl<F> StartCommand<F> {
    /// Splits a legacy command vector. An empty vector leaves an empty program for the
    /// receiving operation to refuse.
    pub fn from_words(command: Vec<String>, folder: F) -> Self {
        let mut words = command.into_iter();
        let program = words.next().unwrap_or_default();
        Self {
            program,
            args: words.collect(),
            folder,
        }
    }

    /// The old wire formats put the program before the CLI's arguments.
    pub fn into_words(self) -> (Vec<String>, F) {
        let command = std::iter::once(self.program).chain(self.args).collect();
        (command, self.folder)
    }
}
