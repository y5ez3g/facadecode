//! `facade hook …`: what a CLI's hooks run. A hook reads its input from standard input, at most
//! 1 MiB and for at most one second, prints its output in the format of the CLI it names, as
//! `facade_rules::hook` gives it, and never stands in the CLI's way: it exits 0 whatever happens.
//!
//! Hooks of a run Facade started:
//!
//! - `session-start <session-file>` saves the session the input names in the run's session file,
//!   unless the run's environment says the session is not the run's own. The old `--skill` flag
//!   is accepted and ignored.
//! - `session-prompt <session-file> <cli>` saves the session the CLI names when a prompt is
//!   submitted, using the same run folder and session checks.
//! - `title <session-file> [<command>]` saves the session the title input names in the same way,
//!   then hands the same input to `command`, the person's own title command, whose output alone
//!   reaches the CLI.
//! - `instructions <cli>` prints the managed instructions that the run's start wrote in the
//!   folder of the run's agent, where the CLI wants them at that hook.
//! - `approve <cli>` prints an approval for a call of one of Facade's own tools, and decides
//!   nothing about any other tool.
//!
//! The session-start hook skips background jobs of its session.

use std::ffi::OsStr;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use facade_base::paths;
use facade_rules::hook;
use serde_json::Value;

/// The most hook input read.
const MAX_INPUT_BYTES: u64 = 1024 * 1024;
/// How long a hook waits for the end of its input.
const INPUT_TIMEOUT: Duration = Duration::from_secs(1);

#[derive(clap::Subcommand)]
pub(crate) enum HookEvent {
    /// Record the session the CLI selected. Reads the hook's input from standard input and exits 0
    /// whatever happens.
    SessionStart {
        /// The run's session file, an absolute path in the private run folder.
        file: PathBuf,
        /// Accepted and ignored for older run hooks.
        #[arg(long)]
        skill: bool,
    },
    /// Record the session the CLI reports when a prompt is submitted.
    SessionPrompt {
        /// The run's session file, an absolute path in the private run folder.
        file: PathBuf,
        /// The CLI whose hook runs it.
        cli: String,
    },
    /// Antigravity's title command: write the conversation it shows to the run's session file, then
    /// run the person's own title command with the same input. Reads the input from standard input
    /// and exits 0 whatever happens.
    Title {
        /// The run's session file, an absolute path in the private run folder.
        file: PathBuf,
        /// The person's own title command, a shell command.
        command: Option<String>,
    },
    /// Print the instructions of the run's agent, as its run's start wrote them in the run's
    /// folder, as the CLI's hook output, for a CLI that shows its model no MCP server's
    /// instructions. Reads the hook's input from standard input and exits 0 whatever happens.
    Instructions {
        /// The CLI whose hook runs it: muse or agy.
        cli: String,
    },
    /// Approve, as the CLI's hook output, a call of one of Facade's own tools that the CLI would
    /// ask the person about, for a CLI with no rule that approves one server's tools. Reads the
    /// hook's input from standard input and exits 0 whatever happens.
    Approve {
        /// The CLI whose hook runs it: muse.
        cli: String,
    },
}

/// Runs a hook: reads its input and prints its output in the CLI's format, never failing. `agent`
/// is the run's `FACADE_AGENT`, whose folder holds the run's instructions.
pub(crate) fn run(event: HookEvent, agent: Option<&str>) {
    match event {
        HookEvent::SessionStart { file, .. } => {
            report_run_session(&file, facade_rules::session_from_hook)
        }
        HookEvent::SessionPrompt { file, cli } => report_run_session(&file, |input| {
            facade_rules::session_from_prompt(&cli, input).map(Some)
        }),
        HookEvent::Title { file, command } => retitle(&file, command.as_deref()),
        HookEvent::Instructions { cli } => print_run_start(&cli, agent),
        HookEvent::Approve { cli } => print_approval(&cli),
    }
}

/// Saves the run's own session the hook input names in `file`.
fn report_run_session(
    file: &Path,
    report: impl FnOnce(&[u8]) -> Option<Option<facade_rules::Reported>>,
) {
    if in_background_job() {
        return;
    }
    let Some(folder) = session_folder(file) else {
        return;
    };
    let Some(input) = read_input() else { return };
    let Some(reported) = report(&input) else {
        return;
    };
    write_own_session(&folder, reported.as_ref());
}

/// `title <file> [<command>]`: saves the session the title input names in `file`, then hands the
/// same input to the person's own title command `command`.
fn retitle(file: &Path, command: Option<&str>) {
    let input = read_input().unwrap_or_default();
    if let Some(folder) = session_folder(file)
        && let Some(reported) = facade_rules::session_from_title(&input)
    {
        write_own_session(&folder, reported.as_ref());
    }
    if let Some(command) = command.filter(|command| !command.is_empty()) {
        pipe_to_shell(command, &input);
    }
}

/// The canonical runs root in the selected Facade home.
fn runs_root() -> Option<PathBuf> {
    paths::framework_dir()
        .ok()?
        .join("runs")
        .canonicalize()
        .ok()
}

/// The private folder of the agent's sole run under the canonical runs root.
fn private_run_folder(runs: &Path, agent: &str) -> Option<PathBuf> {
    let digits = agent.strip_prefix('a')?;
    if digits.is_empty() || !digits.bytes().all(|digit| digit.is_ascii_digit()) {
        return None;
    }
    let folder = facade_rules::run_folder(runs, agent)?;
    (folder.canonicalize().ok()? == folder).then_some(folder)
}

/// Resolves the parent of an absolute session file to the agent's private run folder.
fn session_folder(file: &Path) -> Option<PathBuf> {
    if !file.is_absolute() || file.file_name() != Some(OsStr::new(facade_rules::SESSION_FILE)) {
        return None;
    }
    let runs = runs_root()?;
    let folder = file.parent()?.canonicalize().ok()?;
    let agent = folder.parent()?.strip_prefix(&runs).ok()?.to_str()?;
    (private_run_folder(&runs, agent)? == folder).then_some(folder)
}

/// Records a session the CLI chose for this run, or clears its file when the CLI chose none.
fn write_own_session(folder: &Path, reported: Option<&facade_rules::Reported>) {
    if reported
        .is_none_or(|session| hook::is_run_own_session(&crate::launch_environment().0, &session.id))
    {
        let file = folder.join(facade_rules::SESSION_FILE);
        let _ = facade_rules::write_session_file(&file, reported);
    }
}

/// Runs the shell command `command`, with the shell the CLI that runs title hooks uses, with
/// `input` on its standard input and the hook's standard output and error as its own, and waits
/// for it.
fn pipe_to_shell(command: &str, input: &[u8]) {
    let words = facade_rules::hook::title_command(command);
    let Some((program, arguments)) = words.split_first() else {
        return;
    };
    let shell = Command::new(program)
        .args(arguments)
        .stdin(Stdio::piped())
        .spawn();
    if let Ok(mut shell) = shell {
        if let Some(mut stdin) = shell.stdin.take() {
            let _ = stdin.write_all(input);
        }
        let _ = shell.wait();
    }
}

/// `instructions <cli>`: prints the managed instructions from the run's folder in the CLI's hook
/// format.
fn print_run_start(cli: &str, agent: Option<&str>) {
    let input = read_json();
    let instructions = runs_root()
        .zip(agent)
        .and_then(|(runs, agent)| private_run_folder(&runs, agent))
        .and_then(|folder| {
            std::fs::read_to_string(folder.join(facade_rules::INSTRUCTIONS_FILE)).ok()
        });
    let own_session = facade_rules::session_variable(cli).and_then(|name| std::env::var(name).ok());
    let start = hook::RunStart::new(
        input.as_ref(),
        own_session.as_deref(),
        instructions.as_deref(),
    );
    if let Some(output) = hook::run_start_output(cli, &start) {
        print_or_end!("{output}");
    }
}

/// `approve <cli>`: prints the approval of a call of one of Facade's own tools.
fn print_approval(cli: &str) {
    if let Some(output) = read_json().and_then(|input| hook::approval_output(cli, &input)) {
        print_or_end!("{output}");
    }
}

/// Whether the hook runs in a background job of its session.
fn in_background_job() -> bool {
    std::env::var_os(hook::BACKGROUND_JOB_VARIABLE).is_some_and(|dir| !dir.is_empty())
}

/// The hook's input as JSON, or None where it is not.
fn read_json() -> Option<Value> {
    serde_json::from_slice(&read_input()?).ok()
}

/// The hook's input: None where it is over 1 MiB, cannot be read, or has not ended after a second.
fn read_input() -> Option<Vec<u8>> {
    let (done, finished) = mpsc::channel();
    std::thread::spawn(move || {
        let mut input = Vec::new();
        let limit = MAX_INPUT_BYTES + 1;
        let whole = std::io::stdin().take(limit).read_to_end(&mut input).is_ok()
            && input.len() as u64 <= MAX_INPUT_BYTES;
        let _ = done.send(whole.then_some(input));
    });
    finished.recv_timeout(INPUT_TIMEOUT).ok().flatten()
}
