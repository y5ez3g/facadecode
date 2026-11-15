//! `facade hook …`: what a CLI's hooks run. A hook reads its input from standard input, at most
//! 1 MiB and for at most one second, prints its output in the format of the CLI it names, as
//! `facade_rules::hook` gives it, and never stands in the CLI's way: it exits 0 whatever happens.
//!
//! Hooks of a run Facade started:
//!
//! - `session-start <session-file>` saves the session the input names in the run's session file,
//!   unless the run's environment says the session is not the run's own. With `--skill`, it first
//!   prints the skill in the run's folder as the context the session starts with.
//! - `title <session-file> [<command>]` saves the session the title input names in the same way,
//!   then hands the same input to `command`, the person's own title command, whose output alone
//!   reaches the CLI.
//! - `instructions <cli>` prints the instructions and skill that the run's start wrote in the
//!   folder of the run's agent, where the CLI wants them at that hook.
//! - `approve <cli>` prints an approval for a call of one of Facade's own tools, and decides
//!   nothing about any other tool.
//!
//! Hooks of a session the person started, a guest: `session-start --cli <cli>` joins it and prints
//! the guest's instructions; `prompt` begins a turn and prints the messages that waited for it;
//! `turn-end` ends a turn and prints the messages that came during it, which keeps the turn going,
//! or, for a turn cut short, only makes the guest idle, as `idle` does; `session-end` makes the
//! guest leave. They reach the daemon only when it runs: a hook never starts Facade.
//!
//! A hook in a background job of its session does nothing for the session: the job's turns are
//! not the session's.

use std::ffi::OsStr;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use facade_base::daemon::{
    HookIdle, HookPrompt, HookSession, HookSessionEnd, HookSessionStart, HookTurnEnd, Message,
    typed_text,
};
use facade_base::daemon_client::{DaemonClient, environment};
use facade_base::{paths, unix_process};
use facade_rules::hook;
use serde_json::Value;

/// The most hook input read.
const MAX_INPUT_BYTES: u64 = 1024 * 1024;
/// How long a hook waits for the end of its input.
const INPUT_TIMEOUT: Duration = Duration::from_secs(1);

#[derive(clap::Subcommand)]
pub(crate) enum HookEvent {
    /// A session began. With the run's session file, in a run Facade started, write the session the
    /// CLI selected to it, and with --skill print the skill in the run's folder as the context the
    /// session starts with. With --cli, in a CLI the person started, join its session as a guest
    /// and print what its model is told, in the CLI's hook format. Reads the hook's input from
    /// standard input; exits 0 whatever happens.
    SessionStart {
        /// The run's session file, an absolute path.
        file: Option<PathBuf>,
        /// The CLI whose hook this is, by its rule's name.
        #[arg(long)]
        cli: Option<String>,
        /// With the run's session file, also print the skill in the run's folder as the context the
        /// session starts with, for a CLI that reads no skill file of its own.
        #[arg(long)]
        skill: bool,
    },
    /// Tell Facade that a guest's turn began, and give its model, with the prompt, the messages
    /// that waited, in the CLI's hook format; Antigravity's, which runs before each model call, at
    /// a turn's first. Prints nothing otherwise, and exits 0 whatever happens.
    Prompt {
        /// The CLI whose hook this is, by its rule's name.
        #[arg(long)]
        cli: String,
    },
    /// End a guest's turn: give its model the messages that came during it, in the CLI's hook
    /// format, which keeps the turn going. Prints nothing otherwise, and exits 0 whatever happens.
    TurnEnd {
        /// The CLI whose hook this is, by its rule's name.
        #[arg(long)]
        cli: String,
    },
    /// Tell Facade that the person cut a guest's turn short: it reads idle, and its messages wait
    /// for the next prompt. Prints nothing and exits 0 whatever happens.
    Idle {
        /// The CLI whose hook this is, by its rule's name.
        #[arg(long)]
        cli: String,
    },
    /// Tell Facade that a guest's session ended: it leaves. Prints nothing and exits 0 whatever
    /// happens.
    SessionEnd {
        /// The CLI whose hook this is, by its rule's name.
        #[arg(long)]
        cli: String,
    },
    /// Antigravity's title command: write the conversation it shows to the run's session file, then
    /// run the person's own title command with the same input. Reads the input from standard input
    /// and exits 0 whatever happens.
    Title {
        /// The run's session file, an absolute path.
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

/// What a guest's hook tells the daemon.
#[derive(Clone, Copy, PartialEq, Eq)]
enum GuestEvent {
    Join,
    TurnBegins,
    TurnEnds,
    Idles,
    Leaves,
}

/// Runs a hook: reads its input and prints its output in the CLI's format, never failing. `agent`
/// is the run's `FACADE_AGENT`, whose folder holds the run's instructions; `connect` reaches the
/// daemon that runs, or gives None when nothing answers.
pub(crate) fn run(
    event: HookEvent,
    agent: Option<&str>,
    connect: &dyn Fn() -> Option<DaemonClient>,
) {
    let (cli, guest) = match event {
        HookEvent::SessionStart {
            file: Some(file),
            skill,
            ..
        } => return start_run_session(&file, skill),
        HookEvent::SessionStart { cli: None, .. } => return,
        HookEvent::Title { file, command } => return retitle(&file, command.as_deref()),
        HookEvent::Instructions { cli } => return print_run_start(&cli, agent),
        HookEvent::Approve { cli } => return print_approval(&cli),
        HookEvent::SessionStart { cli: Some(cli), .. } => (cli, GuestEvent::Join),
        HookEvent::Prompt { cli } => (cli, GuestEvent::TurnBegins),
        HookEvent::TurnEnd { cli } => (cli, GuestEvent::TurnEnds),
        HookEvent::Idle { cli } => (cli, GuestEvent::Idles),
        HookEvent::SessionEnd { cli } => (cli, GuestEvent::Leaves),
    };
    print_output(&cli, report_guest(&cli, guest, connect));
}

/// Prints a guest hook's output for `cli`'s model, or, where there is none, what `cli` reads as
/// none.
fn print_output(cli: &str, output: Option<String>) {
    if let Some(output) = output.as_deref().or_else(|| hook::empty_output(cli)) {
        println!("{output}");
    }
}

/// `session-start <file>`: prints the run's skill first where `skill` asks for it, then saves the
/// run's own session the input names in `file`.
fn start_run_session(file: &Path, skill: bool) {
    if in_background_job() {
        return;
    }
    let skill_text = (skill && is_session_file(file))
        .then(|| std::fs::read_to_string(file.with_file_name(facade_rules::SKILL_FILE)).ok())
        .flatten();
    if let Some(text) = skill_text {
        print!("{}", hook::skill_output(&text));
    }
    let Some(input) = read_input() else { return };
    let Some(reported) = facade_rules::session_from_hook(&input) else {
        return;
    };
    let env = environment().0;
    let own = reported
        .as_ref()
        .is_none_or(|session| hook::is_run_own_session(&env, &session.id));
    if own && is_session_file(file) {
        let _ = facade_rules::write_session_file(file, reported.as_ref());
    }
}

/// `title <file> [<command>]`: saves the session the title input names in `file`, then hands the
/// same input to the person's own title command `command`.
fn retitle(file: &Path, command: Option<&str>) {
    let input = read_input().unwrap_or_default();
    if is_session_file(file)
        && let Some(reported) = facade_rules::session_from_title(&input)
    {
        let _ = facade_rules::write_session_file(file, reported.as_ref());
    }
    if let Some(command) = command.filter(|command| !command.is_empty()) {
        pipe_to_shell(command, &input);
    }
}

/// Whether `file` can be a run's session file: an absolute path with the session file's name.
fn is_session_file(file: &Path) -> bool {
    file.is_absolute() && file.file_name() == Some(OsStr::new(facade_rules::SESSION_FILE))
}

/// Runs the shell command `command` with `input` on its standard input and the hook's standard
/// output and error as its own, and waits for it.
fn pipe_to_shell(command: &str, input: &[u8]) {
    let shell = Command::new("/bin/sh")
        .arg("-c")
        .arg(command)
        .stdin(Stdio::piped())
        .spawn();
    if let Ok(mut shell) = shell {
        if let Some(mut stdin) = shell.stdin.take() {
            let _ = stdin.write_all(input);
        }
        let _ = shell.wait();
    }
}

/// `instructions <cli>`: prints what the run of `agent` gives `cli`'s model at this hook, from the
/// files its start wrote in the run's folder.
fn print_run_start(cli: &str, agent: Option<&str>) {
    let input = read_json();
    let runs = paths::core_dir().ok().map(|core| core.join("runs"));
    let folder = runs
        .zip(agent)
        .and_then(|(runs, agent)| facade_rules::run_folder(&runs, agent));
    let in_folder = |name: &str| {
        let folder = folder.as_ref()?;
        std::fs::read_to_string(folder.join(name)).ok()
    };
    let instructions = in_folder(facade_rules::INSTRUCTIONS_FILE);
    let skill = in_folder(facade_rules::SKILL_FILE);
    let own_session = facade_rules::session_variable(cli).and_then(|name| std::env::var(name).ok());
    let start = hook::RunStart {
        input: input.as_ref(),
        own_session: own_session.as_deref(),
        instructions: instructions.as_deref(),
        skill: skill.as_deref(),
    };
    if let Some(output) = hook::run_start_output(cli, &start) {
        print!("{output}");
    }
}

/// `approve <cli>`: prints the approval of a call of one of Facade's own tools.
fn print_approval(cli: &str) {
    if let Some(output) = read_json().and_then(|input| hook::approval_output(cli, &input)) {
        print!("{output}");
    }
}

/// Reports `event` of the guest session the input names to the daemon that runs, and gives what
/// the guest's model is told, if anything.
fn report_guest(
    cli: &str,
    event: GuestEvent,
    connect: &dyn Fn() -> Option<DaemonClient>,
) -> Option<String> {
    if in_background_job() {
        return None;
    }
    let input = read_json()?;
    let mut daemon = connect()?;
    if event == GuestEvent::TurnBegins && !hook::begins_turn(cli, &input) {
        return None;
    }
    let mut session = guest_session(cli, &input)?;
    match event {
        GuestEvent::Join => {
            let started = daemon.call::<HookSessionStart>(session).ok()?;
            Some(hook::context_output(
                cli,
                "SessionStart",
                &started.instructions?,
            ))
        }
        GuestEvent::TurnBegins => {
            session.status_file = status_file(cli, &session);
            let waited = daemon.call::<HookPrompt>(session).ok()?.messages;
            Some(hook::context_output(
                cli,
                "UserPromptSubmit",
                &typed(&waited)?,
            ))
        }
        GuestEvent::TurnEnds if !hook::is_turn_cut_short(cli, &input) => {
            let came = daemon.call::<HookTurnEnd>(session).ok()?.messages;
            Some(hook::block_output(cli, &typed(&came)?))
        }
        GuestEvent::TurnEnds | GuestEvent::Idles => {
            let _ = daemon.call::<HookIdle>(session);
            None
        }
        GuestEvent::Leaves => {
            let _ = daemon.call::<HookSessionEnd>(session);
            None
        }
    }
}

/// The guest session `cli`'s hook input names, as the daemon takes it: in the input's working
/// folder or the hook's own; with the CLI's process that ran the hook where the session ends with
/// that process; and with the hook's environment, which an agent the guest starts runs with, but
/// for its variables that are not UTF-8.
fn guest_session(cli: &str, input: &Value) -> Option<HookSession> {
    let hook::NamedSession {
        session,
        parent,
        cwd,
    } = hook::session_of(cli, input)?;
    let cwd = cwd.or_else(|| Some(std::env::current_dir().ok()?.display().to_string()));
    let pid = if facade_rules::session_ends_with_process(cli) {
        unix_process::calling_program()
    } else {
        None
    };
    Some(HookSession {
        cli: cli.to_string(),
        session,
        cwd,
        pid,
        parent,
        env: Some(environment().0),
        status_file: None,
    })
}

/// The file in which the CLI that ran the hook keeps its session's status, where it keeps one: the
/// daemon reads a turn cut short there, which no hook reports.
fn status_file(cli: &str, session: &HookSession) -> Option<String> {
    let env = session.env.as_ref()?;
    let file =
        facade_rules::integration::session_status_file(cli, env, unix_process::calling_program()?)?;
    file.is_file().then(|| file.display().to_string())
}

/// The messages as the guest's terminal would show them, oldest first, or None where none waited.
fn typed(messages: &[Message]) -> Option<String> {
    if messages.is_empty() {
        return None;
    }
    let shown: Vec<String> = messages.iter().map(typed_text).collect();
    Some(shown.join("\n\n"))
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

#[cfg(test)]
mod tests {
    use facade_base::daemon::{Delivery, DeliveryStatus, TextWritten};

    use super::*;

    fn message(number: usize, text: &str) -> Message {
        Message {
            message_id: format!("m{number}"),
            from: "human".into(),
            from_name: None,
            to: "a7".into(),
            text: text.to_string(),
            reply_to: None,
            from_window: None,
            call_id: None,
            result: None,
            at: "2026-11-11T00:00:00.000Z".into(),
            delivery: Delivery {
                status: DeliveryStatus::Success,
                reason: None,
                text_written: TextWritten::None,
                enter_written: None,
                deadline: None,
                delivered_via: None,
                delivered_at: None,
            },
        }
    }

    /// The model gets the messages as its terminal would show them, oldest first, and nothing where
    /// none waited.
    #[test]
    fn a_hook_hands_over_the_messages_as_a_terminal_shows_them() {
        let both = "📨 Message from #human · #m1\none\n\n📨 Message from #human · #m2\ntwo";
        assert_eq!(
            typed(&[message(1, "one"), message(2, "two")]).as_deref(),
            Some(both)
        );
        assert_eq!(typed(&[]), None);
    }
}
