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

use std::fmt;
use std::io::{IsTerminal, Write};

use facade_base::daemon::DEFAULT_TERMINAL_SIZE;
use facade_base::daemon_client::DaemonClient;
use facade_base::process::{EndReason, ProcessExit};

use cli::{Command, Integration, Target, Targets};
use commands::{Format, IntegrationAction, Listing};
use daemon_client::{connect_or_start, reconnect};
use errors::Problem;
use machine::MachineAction;

/// How an attachment began, for the line before the agent's screen.
pub(crate) enum Opening {
    /// `start` began the agent in this terminal: its record's name.
    Started { name: String },
    /// `resume` began it: its record's name.
    Resumed { name: String },
    /// `facade attach`.
    Attached,
}

/// An agent that `start` or `resume` began in this terminal, to attach to.
pub(crate) struct Shown {
    /// The agent's ID, such as `a3`.
    pub(crate) agent: String,
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
        Err(error) if error.use_stderr() && is_hook_line() => skip_hook_line(&error),
        Err(error) => error.exit(),
    };
    let Some(command) = arguments.command else {
        // `facade` alone prints the root page, as help does.
        let _ = cli::cli().print_help();
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
                action: MachineAction::Add(_) | MachineAction::Connect(_) | MachineAction::Serve(_)
            }
    ) {
        facade_base::service::default_broken_pipe();
    }
    let hidden = matches!(
        command,
        Command::Hook { .. } | Command::Keeper | Command::Daemon { .. }
    );
    let code = run(command).unwrap_or_else(|error| {
        if hidden {
            eprintln!("facade: {error:#}");
            1
        } else {
            errors::report(&error)
        }
    });
    std::process::exit(code)
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

/// Whether this program runs as a CLI's hook: `facade hook …`.
fn is_hook_line() -> bool {
    std::env::args_os()
        .nth(1)
        .is_some_and(|word| word == "hook")
}

/// Does nothing for a hook line another build wrote, naming an event or an argument this build
/// does not know, or a word that is not UTF-8: a hook never fails its CLI. Says why where the CLI
/// keeps a hook's errors, prints the empty output of a CLI that reads every hook's output as JSON,
/// and exits 0.
fn skip_hook_line(error: &clap::Error) -> ! {
    let words: Vec<String> = std::env::args_os()
        .skip(1)
        .map(|word| word.to_string_lossy().into_owned())
        .collect();
    let reason = error.to_string();
    let reason = reason
        .lines()
        .next()
        .map_or("", |line| line.trim_start_matches("error: "));
    facade_base::log::write(
        "facade",
        "warn",
        &format!(
            "did nothing for `{}`, which this build cannot use: {reason}",
            words.join(" ")
        ),
    );
    if let Some(output) = words
        .iter()
        .find_map(|word| facade_rules::hook::empty_output(word))
    {
        println_or_end!("{output}");
    }
    std::process::exit(0)
}

/// Whether this command's standard input and output are both terminals, where it can show an
/// agent.
fn interactive() -> bool {
    std::io::stdin().is_terminal() && std::io::stdout().is_terminal()
}

/// The size of the person's terminal for an agent's first frame, where this command shows the
/// agent: it is interactive and `detach` does not keep the agent in the background.
fn shown_terminal(detach: bool) -> Option<(u16, u16)> {
    (!detach && interactive()).then(|| attach::terminal_size().unwrap_or(DEFAULT_TERMINAL_SIZE))
}

/// Shows the agent a start or resume returned, until the person detaches or it ends; exits 0 where
/// there is none to show.
fn show(client: DaemonClient, shown: Option<Shown>) -> anyhow::Result<i32> {
    match shown {
        Some(Shown { agent, opening }) => attach::attach(client, &agent, opening, &reconnect),
        None => Ok(0),
    }
}

/// Runs a command and returns its exit code.
fn run(command: Command) -> anyhow::Result<i32> {
    match command {
        Command::Hook { event } => {
            let agent = daemon_client::terminal_agent();
            hooks::run(event, agent.as_deref(), &|| {
                daemon_client::connect_running(daemon_client::terminal_agent())
            });
            Ok(0)
        }
        Command::Keeper => facade_keeper::serve().map(|()| 0),
        Command::Daemon { detach: false } => facade_daemon::run().map(|()| 0),
        Command::Daemon { detach: true } => daemon_client::detach(),
        Command::Machine { action } => machine::run(action, &connect_or_start, &|home| {
            if let Some(home) = home {
                // SAFETY: the initial command chooses the home before opening a socket or starting
                // any threads. The keeper and daemon inherit this home if started below.
                unsafe { std::env::set_var("FACADE_HOME", home) };
            }
            daemon_client::machine_socket()
        }),
        Command::Start {
            name,
            prompt,
            detach,
            machine,
            cwd,
            command_line,
        } => {
            // An option Facade does not know fails before Facade is reached.
            cli::check_start(&command_line)?;
            let terminal = shown_terminal(detach);
            let mut client = connect_or_start()?;
            let shown = commands::start(
                &mut client,
                name,
                prompt,
                (machine, cwd),
                command_line,
                terminal,
            )?;
            show(client, shown)
        }
        Command::Resume {
            detach,
            target: Target { agent },
        } => {
            let terminal = shown_terminal(detach);
            let mut client = connect_or_start()?;
            let shown = commands::resume(&mut client, agent, terminal)?;
            show(client, shown)
        }
        Command::Attach(Target { agent }) => {
            if !interactive() {
                return Err(Problem::NotInteractive { given: agent }.into());
            }
            attach::attach(connect_or_start()?, &agent, Opening::Attached, &reconnect)
        }
        Command::Messages => {
            let Some(agent) = daemon_client::agent_of_terminal()? else {
                return Err(Problem::NotAgentTerminal.into());
            };
            commands::messages(&mut daemon_client::connect_or_start_for(&agent)?).map(done)
        }
        Command::List { quiet, json } => {
            let listing = match (quiet, json) {
                (true, _) => Listing::Quiet,
                (_, true) => Listing::Json,
                _ => Listing::Table,
            };
            commands::list(&mut connect_or_start()?, listing).map(done)
        }
        Command::Inspect {
            json,
            target: Target { agent },
        } => commands::inspect(&mut connect_or_start()?, agent, format(json)).map(done),
        Command::Screen {
            lines,
            target: Target { agent },
        } => commands::screen(&mut connect_or_start()?, agent, lines).map(done),
        Command::Type {
            target: Target { agent },
            text,
            enter,
            keys,
        } => commands::type_input(&mut connect_or_start()?, agent, text, enter, keys).map(done),
        Command::Send { to, text, reply_to } => {
            commands::send(&mut connect_or_start()?, to, text, reply_to).map(done)
        }
        Command::Rename {
            target: Target { agent },
            name,
        } => commands::rename(&mut connect_or_start()?, agent, name).map(done),
        Command::Stop(Targets { agents }) => {
            commands::stop(&mut connect_or_start()?, agents, &errors::report)
        }
        Command::Remove(Targets { agents }) => {
            commands::remove(&mut connect_or_start()?, agents, &errors::report)
        }
        Command::Integration { action } => {
            let (action, json) = match action {
                Integration::Add { json, cli } => (IntegrationAction::Add { cli: cli.cli }, json),
                Integration::Remove { json, cli } => {
                    (IntegrationAction::Remove { cli: cli.cli }, json)
                }
                Integration::List { json } => (IntegrationAction::List, json),
            };
            commands::integration(&mut connect_or_start()?, action, format(json)).map(done)
        }
        Command::Status { json } => {
            let home = facade_base::paths::facade_home()?;
            let reply = daemon_client::probe()?;
            commands::status(&home, reply.as_ref(), format(json)).map(done)
        }
        Command::Version { json } => commands::version(format(json)).map(done),
        Command::Completion { shell } => {
            cli::completion(&shell);
            Ok(0)
        }
    }
}

/// The exit code of a command that did what it was asked.
fn done((): ()) -> i32 {
    0
}

/// How `--json` asks a command to print.
fn format(json: bool) -> Format {
    if json { Format::Json } else { Format::Text }
}
