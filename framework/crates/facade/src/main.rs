//! The `facade` program: terminal commands, and the keeper and daemon services.

/// Prints to standard output as `print!` does; a reader that went away ends the command quietly.
macro_rules! print_or_end {
    ($($arg:tt)*) => {
        $crate::write_or_end(format_args!($($arg)*))
    };
}

/// Prints a line to standard output as `println!` does; a reader that went away ends the command
/// quietly.
macro_rules! println_or_end {
    ($($arg:tt)*) => {
        $crate::write_or_end(format_args!("{}\n", format_args!($($arg)*)))
    };
}

mod attach;
mod cli;
mod commands;
mod daemon_client;
mod errors;
mod help;
mod hooks;
mod machine;
#[cfg(test)]
mod tests;
mod upgrade;

use std::borrow::Cow;
use std::collections::BTreeMap;
use std::fmt::{self, Write as _};
use std::io::{IsTerminal, Write};
use std::path::PathBuf;
use std::time::{Duration, Instant};

use facade_base::address::default_machine_name;
use facade_base::address::selector::{exact_machine_selector, format_agent_address};
use facade_base::api_v1::NoArgs;
use facade_base::api_v1::daemon::{AgentRef, AgentTarget, MachineList, Scope, StopSelection};
use facade_base::api_v1::daemon_client::DaemonClient;
use facade_base::model::terminal::DEFAULT_TERMINAL_SIZE;
use facade_base::process::{EndReason, ProcessExit};
use facade_base::start::LaunchColors;
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use cli::{Command, MachineAction, ParseError, ServeArgs, SshTarget, StartOptions, Target};
use daemon_client::{connect_or_start, reconnect};

/// How an attachment began, for the line before the agent's screen.
pub(crate) enum Opening {
    /// `start` began the agent in this terminal.
    Started,
    /// `resume` began a new run of an existing agent.
    Resumed,
    /// `resume` started a new agent from a CLI's saved session.
    SavedSession { cli: String },
    /// `facade attach`.
    Attached,
}

/// An agent that `start` or `resume` began in this terminal, to attach to.
pub(crate) struct Shown {
    /// The exact reference to the agent just started or resumed.
    pub(crate) target: AgentTarget,
    pub(crate) opening: Opening,
}

/// An agent's exit as a person reads it: `code 3`, the signal's name, or what is known of an exit
/// with neither. A code outside 0–255, such as a Windows status, shows its 32 bits in hex:
/// `code 0xC000013A`.
pub(crate) struct ExitText<'a>(pub(crate) &'a ProcessExit);

impl fmt::Display for ExitText<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match (self.0.code, &self.0.signal, self.0.reason) {
            (Some(code @ 0..=255), _, _) => write!(f, "code {code}"),
            (Some(code), _, _) => write!(f, "code {:#X}", code as u32),
            (None, Some(signal), _) => f.write_str(signal),
            (None, None, Some(EndReason::TerminalClosed)) => {
                f.write_str("the terminal closed; the CLI may still be running")
            }
            (None, None, _) => f.write_str("exit status is unavailable"),
        }
    }
}

fn main() {
    facade_base::take_test_build();
    let arguments = match cli::parse() {
        Ok(arguments) => arguments,
        Err(ParseError::Usage(message)) => {
            eprintln!("{message}");
            std::process::exit(2);
        }
        Err(ParseError::Internal(error)) if error.use_stderr() && is_hook_line() => {
            skip_hook_line(&error);
        }
        Err(ParseError::Internal(error)) => error.exit(),
    };
    let Some(command) = arguments.command else {
        // `facade` alone prints the root page, as help does.
        print_help(help::page("").expect("root help page"));
        std::process::exit(0)
    };
    // A command whose output is closed early, as by `facade list | head`, ends without an error,
    // like other shell tools: by SIGPIPE where the system has it, else through `write_or_end`. The
    // services and SSH streams handle broken pipes themselves so the command can report the
    // handshake outcome or the SSH exit status.
    if !matches!(
        command,
        Command::Keeper
            | Command::Daemon { .. }
            | Command::Machine {
                action: MachineAction::Add { .. }
                    | MachineAction::Connect(_)
                    | MachineAction::Link { .. }
                    | MachineAction::Serve(_)
                    | MachineAction::SshAdmin { .. }
            }
    ) {
        facade_base::service::default_broken_pipe();
    }
    let hidden = matches!(
        command,
        Command::Hook { .. }
            | Command::Keeper
            | Command::Daemon { .. }
            | Command::Machine {
                action: MachineAction::Serve(_) | MachineAction::SshAdmin { .. }
            }
    );
    let code = dispatch(command).unwrap_or_else(|error| {
        if hidden {
            eprintln!("facade: {error:#}");
            errors::exit_code(&error)
        } else {
            errors::report(&error)
        }
    });
    daemon_client::acknowledge_startup_failure();
    std::process::exit(code)
}

fn dispatch(command: Command) -> anyhow::Result<i32> {
    if !matches!(
        command,
        Command::PrintVersion
            | Command::Keeper
            | Command::Daemon { takeover: true, .. }
            | Command::Daemon {
                await_startup: Some(_),
                ..
            }
            | Command::Daemon {
                install_only: true,
                ..
            }
            | Command::Machine {
                action: MachineAction::Serve(_) | MachineAction::SshAdmin { .. }
            }
    ) && let Some(code) = facade_base::programs::run_in_selected_home()?
    {
        return Ok(code);
    }
    run(command)
}

/// Writes `text` to standard output, for [`print_or_end`] and [`println_or_end`]. Where the reader
/// went away, the command ends quietly with code 0: it did what it was asked, and nobody reads more.
/// Any other failure panics, as `print!` does.
fn write_or_end(text: fmt::Arguments<'_>) {
    let mut stdout = std::io::stdout().lock();
    match stdout.write_fmt(text).and_then(|()| stdout.flush()) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::BrokenPipe => std::process::exit(0),
        Err(error) => panic!("failed printing to stdout: {error}"),
    }
}

/// Captures the UTF-8 environment and reports names of entries that could not be represented.
fn launch_environment() -> (BTreeMap<String, String>, Vec<String>) {
    let mut carried = BTreeMap::new();
    let mut left_out = Vec::new();
    for (name, value) in std::env::vars_os() {
        match (name.to_str(), value.to_str()) {
            (Some(name), Some(value)) => {
                carried.insert(name.to_owned(), value.to_owned());
            }
            _ => left_out.push(name.to_string_lossy().into_owned()),
        }
    }
    (carried, left_out)
}

fn agent_address(reference: &AgentRef, machine: Option<&str>) -> String {
    let selector = machine.map_or_else(
        || Cow::Owned(exact_machine_selector(&reference.machine_id)),
        Cow::Borrowed,
    );
    format_agent_address(&reference.agent_id, &selector)
}

fn single_line(text: &str) -> String {
    text.replace(
        |ch: char| ch.is_control() || matches!(ch, '\u{2028}' | '\u{2029}'),
        " ",
    )
}

enum TableLayout {
    Full,
    Roster(Option<usize>),
}

/// Align columns by the width of their headers and cells.
pub(crate) fn table(headers: &[&str], rows: &[Vec<String>]) -> String {
    render_table(headers, rows, TableLayout::Full)
}

/// Fit roster titles and working directories to the viewer, keeping agent and session refs whole.
pub(crate) fn roster_table(headers: &[&str; 8], rows: &[Vec<String>]) -> String {
    let columns = if std::io::stdout().is_terminal() {
        // Leave the rightmost cell free so writing the newline cannot wrap first.
        attach::console_size().map(|(cols, _)| usize::from(cols) - 1)
    } else {
        None
    };
    render_table(headers, rows, TableLayout::Roster(columns))
}

const COLUMN_GAP: &str = "   ";

fn render_table(headers: &[&str], rows: &[Vec<String>], layout: TableLayout) -> String {
    let rows: Vec<Vec<String>> = rows
        .iter()
        .map(|row| row.iter().map(|cell| single_line(cell)).collect())
        .collect();
    let mut widths: Vec<usize> = headers.iter().map(|header| header.width()).collect();
    for row in &rows {
        for (width, cell) in widths.iter_mut().zip(row) {
            *width = (*width).max(cell.width());
        }
    }
    if let TableLayout::Roster(columns) = layout {
        const DIRECTORY: usize = 5;
        const TITLE: usize = 7;
        widths[TITLE] = widths[TITLE].min(40);
        if let Some(columns) = columns {
            let width = widths.iter().sum::<usize>() + COLUMN_GAP.len() * (headers.len() - 1);
            let mut excess = width.saturating_sub(columns);
            for column in [DIRECTORY, TITLE] {
                let spare = widths[column] - headers[column].width();
                let shorten = spare.min(excess);
                widths[column] -= shorten;
                excess -= shorten;
            }
        }
    }
    let mut lines = Vec::with_capacity(rows.len() + 1);
    lines.push(table_row(headers.iter().copied(), &widths));
    for row in &rows {
        lines.push(table_row(row.iter().map(String::as_str), &widths));
    }
    lines.join("\n")
}

fn table_row<'a>(cells: impl Iterator<Item = &'a str>, widths: &[usize]) -> String {
    let mut line = String::new();
    for (column, (cell, width)) in cells.zip(widths).enumerate() {
        if column > 0 {
            line.push_str(COLUMN_GAP);
        }
        let cell = clip_cells(cell, *width);
        line.push_str(&cell);
        if column + 1 < widths.len() {
            let _ = write!(line, "{:pad$}", "", pad = width - cell.width());
        }
    }
    line.truncate(line.trim_end_matches(' ').len());
    line
}

/// Fits a label within `width` display columns, keeping each grapheme whole.
fn clip_cells(cell: &str, width: usize) -> Cow<'_, str> {
    if cell.width() <= width {
        return Cow::Borrowed(cell);
    }
    let mut taken = 0;
    for (index, grapheme) in cell.grapheme_indices(true) {
        taken += grapheme.width();
        if taken >= width {
            return Cow::Owned(format!("{}…", &cell[..index]));
        }
    }
    Cow::Borrowed(cell)
}

/// Whether this program runs as a CLI's hook: `facade hook …`.
fn is_hook_line() -> bool {
    std::env::args_os()
        .nth(1)
        .is_some_and(|word| word == "hook")
}

/// Keeps a CLI running if its managed hook cannot be parsed.
fn skip_hook_line(error: &clap::Error) -> ! {
    let mut words = std::env::args_os().skip(2);
    let event = words.next();
    let cli = words.next();
    facade_base::log::write(
        "facade",
        "warn",
        &format!("ignored a hook this build cannot use: {:?}", error.kind()),
    );
    if event.as_deref().is_some_and(|word| word == "instructions")
        && let Some(output) = cli
            .as_deref()
            .and_then(std::ffi::OsStr::to_str)
            .and_then(facade_rules::hook::empty_output)
    {
        println_or_end!("{output}");
    }
    std::process::exit(0)
}

/// Prints help with the local machine's name when that page needs it.
fn print_help(page: &help::Page) {
    let machine = if page.path == "start" {
        local_machine_name()
    } else {
        String::new()
    };
    print_or_end!("{}", page.render(&machine));
}

fn local_machine_name() -> String {
    let name = match daemon_client::probe() {
        Ok(Some(mut client)) => client
            .call::<MachineList>(NoArgs {})
            .ok()
            .and_then(|listed| {
                listed
                    .machines
                    .into_iter()
                    .find(|machine| machine.machine_id == client.hello_result.machine_id)
                    .map(|machine| machine.name)
            }),
        Ok(None) => facade_daemon::offline_machine_name(),
        Err(_) => None,
    };
    name.unwrap_or_else(|| {
        default_machine_name(&facade_base::system::hostname().unwrap_or_default())
    })
}

/// The person's terminal at a launch.
struct LaunchConsole {
    size: (u16, u16),
    colors: LaunchColors,
    /// The console a launch in the foreground keeps for its view.
    view: Option<attach::Probe>,
}

impl LaunchConsole {
    fn without_terminal() -> Self {
        Self {
            size: DEFAULT_TERMINAL_SIZE,
            colors: LaunchColors::default(),
            view: None,
        }
    }
}

/// Foreground commands need a console on both ends of the attachment.
fn require_console(command: &str, tip: &str) -> anyhow::Result<()> {
    if !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
        anyhow::bail!("'facade {command}' requires an interactive terminal.\n{tip}");
    }
    Ok(())
}

fn read_screen_tip(agent: &str) -> String {
    let mut words = vec!["facade".into(), "screen".into()];
    if agent.starts_with('-') {
        words.push("--".into());
    }
    words.push(agent.into());
    match errors::repair_command(&words) {
        Ok(command) if command.contains('\'') => {
            format!("Use {command} to read its recent output.")
        }
        Ok(command) => format!("Use '{command}' to read its recent output."),
        Err(_) => "Use 'facade screen' with the agent reference to read its recent output.".into(),
    }
}

/// The terminal's size and colors, which a CLI in the background gets too: the person attaches to it
/// from there. A launch without a terminal takes the defaults.
fn launch_console(detach: bool) -> anyhow::Result<LaunchConsole> {
    if !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
        return Ok(LaunchConsole::without_terminal());
    }
    let size = attach::console_size().unwrap_or(DEFAULT_TERMINAL_SIZE);
    if detach && !asks_colors() {
        return Ok(LaunchConsole {
            size,
            ..LaunchConsole::without_terminal()
        });
    }
    if detach {
        return Ok(LaunchConsole {
            size,
            colors: attach::Probe::read_colors()?,
            view: None,
        });
    }
    let probe = attach::Probe::read()?;
    Ok(LaunchConsole {
        size,
        colors: probe.colors,
        view: Some(probe),
    })
}

/// Whether a launch in the background can ask the terminal for its colors: a shell's background job
/// may not read it, and a terminal without escape sequences would print the question.
fn asks_colors() -> bool {
    facade_base::console::owns_input()
        && std::env::var("TERM").map_or(cfg!(windows), |term| term != "dumb")
}

/// Shows the agent a start or resume returned, until the person detaches or it ends.
fn show(
    client: DaemonClient,
    shown: Option<Shown>,
    terminal: LaunchConsole,
) -> anyhow::Result<i32> {
    match shown {
        Some(Shown { target, opening }) => {
            let probe = terminal.view.unwrap_or_default();
            attach::attach(client, target, opening, probe, &reconnect)
        }
        None => Ok(0),
    }
}

/// Missing a CLI is still a usage error when the service cannot list available CLIs.
fn missing_cli(options: StartOptions) -> i32 {
    let error = connect_or_start()
        .ok()
        .and_then(|mut client| {
            commands::start(&mut client, options, &LaunchConsole::without_terminal()).err()
        })
        .unwrap_or_else(|| {
            errors::Problem::MissingCli {
                available: Vec::new(),
            }
            .into()
        });
    errors::report(&error);
    2
}

fn scope(local: bool, machine: Option<String>) -> Scope {
    match machine {
        Some(machine) => Scope::Machine { machine },
        None if local => Scope::Local,
        None => Scope::Reachable,
    }
}

fn select_machine_home(home: Option<PathBuf>) {
    if let Some(home) = home {
        // SAFETY: hidden SSH commands select the home before opening a socket or starting threads.
        // Any service started below inherits this home.
        unsafe { std::env::set_var("FACADE_HOME", home) };
    }
}

/// Runs a command and returns its exit code.
fn run(command: Command) -> anyhow::Result<i32> {
    match command {
        Command::Help(page) => {
            print_help(page);
            Ok(0)
        }
        Command::PrintVersion => {
            println_or_end!("facade {}", facade_base::build_id());
            Ok(0)
        }
        Command::Hook { event } => {
            let agent = std::env::var("FACADE_AGENT").ok();
            hooks::run(event, agent.as_deref());
            Ok(0)
        }
        Command::Keeper => facade_keeper::serve().map(|()| 0),
        Command::Daemon { takeover: true, .. } => daemon_client::takeover(),
        Command::Daemon {
            install_only: true, ..
        } => facade_base::programs::select_running().map(|_| 0),
        Command::Daemon { detach: true, .. } => daemon_client::detach(),
        Command::Daemon {
            await_startup: Some(words),
            ..
        } => daemon_client::await_startup(&words),
        Command::Daemon { .. } => {
            facade_base::programs::validate_running_build()?;
            facade_daemon::run().map(|()| 0)
        }
        Command::Machine { action } => machine::run(
            action,
            &connect_or_start,
            &daemon_client::machine_socket,
            &select_machine_home,
        ),
        Command::Start { options, .. } if options.cli_and_args.is_empty() => {
            Ok(missing_cli(options))
        }
        Command::Start { options, detach } => {
            if !detach {
                require_console(
                    "start",
                    "Pass '-d' to start the agent in the background.\nExample: facade start -d codex",
                )?;
            }
            let mut client = connect_or_start()?;
            let terminal = launch_console(detach)?;
            let shown = commands::start(&mut client, options, &terminal)?;
            show(client, shown, terminal)
        }
        Command::Resume {
            reference: Some(reference),
            detach,
            ..
        } => {
            if !detach {
                require_console(
                    "resume",
                    "Pass '-d' to resume the agent in the background.\nExample: facade resume -d a5@laptop",
                )?;
            }
            let mut client = connect_or_start()?;
            let terminal = launch_console(detach)?;
            let shown = commands::resume(&mut client, reference, &terminal)?;
            show(client, shown, terminal)
        }
        Command::Resume { local, machine, .. } => {
            commands::resume_list(&mut connect_or_start()?, scope(local, machine)).map(done)
        }
        Command::Attach(Target { agent }) => {
            require_console("attach", &read_screen_tip(&agent))?;
            let target = AgentTarget::Selector(agent);
            attach::attach(
                connect_or_start()?,
                target,
                Opening::Attached,
                attach::Probe::default(),
                &reconnect,
            )
        }
        Command::List { local, machine } => {
            commands::list(&mut connect_or_start()?, scope(local, machine)).map(done)
        }
        Command::Screen {
            lines,
            target: Target { agent },
        } => commands::screen(&mut connect_or_start()?, agent, lines).map(done),
        Command::Type {
            target: Target { agent },
            input,
            ..
        } => commands::type_input(&mut connect_or_start()?, agent, input).map(done),
        Command::Send {
            to,
            text,
            wait_for,
            timeout,
            ..
        } => {
            let until = Instant::now() + Duration::from_secs(u64::from(timeout));
            let mut client = daemon_client::connect_or_start_until(until)?;
            commands::send(&mut client, to, text, wait_for, timeout, until).map(done)
        }
        Command::Rename {
            target: Target { agent },
            name,
        } => commands::rename(&mut connect_or_start()?, agent, name).map(done),
        Command::Stop {
            agents,
            local,
            machine,
            ..
        } => {
            let selection = if agents.is_empty() {
                StopSelection::All {
                    scope: scope(local, machine),
                }
            } else {
                StopSelection::Targets {
                    targets: agents.into_iter().map(AgentTarget::Selector).collect(),
                }
            };
            commands::stop(&mut connect_or_start()?, selection)
        }
        Command::Status { agent: Some(agent) } => {
            commands::inspect(&mut connect_or_start()?, agent).map(done)
        }
        Command::Status { agent: None } => {
            commands::status(daemon_client::probe()?.as_mut()).map(done)
        }
        Command::Upgrade { version } => upgrade::run(version.as_deref()).map(done),
    }
}

/// The exit code of a command that did what it was asked.
fn done((): ()) -> i32 {
    0
}
