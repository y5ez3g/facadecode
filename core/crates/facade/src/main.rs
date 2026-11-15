//! The `facade` program: terminal commands, and the keeper and daemon services.

mod attach;
mod commands;
mod daemon_client;
mod hooks;

use std::fmt;
use std::io::IsTerminal;

use clap::{Parser, Subcommand};
use facade_base::daemon::DEFAULT_TERMINAL_SIZE;
use facade_base::process::{EndReason, ProcessExit};

use commands::{Format, IntegrationAction};
use daemon_client::{attempt, connect_or_start};
use hooks::HookEvent;

#[derive(Parser)]
#[command(
    name = "facade",
    version,
    about = "Run agents, view their terminals, and send input."
)]
struct Arguments {
    #[command(subcommand)]
    command: Command,
}

/// The agent a command acts on.
#[derive(clap::Args)]
struct Target {
    /// An agent ID (a3, '#a3', or 3), a unique name with or without @, or a name and its ID,
    /// such as '@Pixel #a3'.
    agent: String,
}

#[derive(Subcommand)]
enum Command {
    /// Start an agent and show its terminal when run interactively.
    ///
    /// Examples: `facade start claude`, `facade start --name review codex --model gpt-6`, or
    /// `facade start --prompt "fix the failing test" claude`. A CLI of Facade's settings file, by
    /// its name - a built-in's (claude, codex, agy, muse, opencode, pi) or one its `clis` adds -
    /// starts as its entry says; any other program, including a path, runs as given. Facade's own
    /// options come before the CLI's name, and every word after it is the CLI's own.
    ///
    /// `--name <name>` names the agent; a missing or blank name gets one from the settings file's
    /// `names`, else the built-in names, or its ID once every one is taken. `--prompt <text>` is
    /// the agent's first message: Facade sends it as `facade send` does, once the CLI's tools are
    /// connected or will not be, so that its first turn has them, the same for every CLI. Only a
    /// CLI of the settings file takes one. The first turn counts only when its prompt comes through
    /// `--prompt`; words after the CLI's name are the CLI's own.
    ///
    /// In a terminal, Ctrl-] detaches; the agent keeps running. If the agent ends, this command
    /// exits with its code, or 128 plus the terminating signal number. An unavailable exit status
    /// returns code 1. If the connection closes, reconnect by agent ID and start the daemon if
    /// needed. Keys wait for the screen to be redrawn; Ctrl-] waits at most one second to send
    /// them. Without a terminal, start the agent in the background and print its ID.
    Start {
        /// Facade's options, `--name <name>` and `--prompt <text>`, then the CLI program and its
        /// arguments.
        #[arg(
            trailing_var_arg = true,
            allow_hyphen_values = true,
            required = true,
            value_name = "CLI [ARGS]"
        )]
        command_line: Vec<String>,
    },
    /// Stop an agent and keep its record in the list.
    ///
    /// Send SIGHUP to a running agent's process group, then SIGKILL to anything left 3 seconds
    /// after Facade accepted the first stop. Return the recorded exit once the agent ends; an ended
    /// agent returns it without another signal.
    Stop(Target),
    /// Remove an agent record.
    ///
    /// Stop a running agent first; see facade stop --help for signal timing. Removing an ended
    /// agent sends no additional signal. Processes left by a CLI that ended by itself can keep
    /// running if they ignore terminal hangup.
    Remove(Target),
    /// List agents with what each is doing.
    ///
    /// Each agent's state is starting, working, waiting_for_you (with what for), just_done, idle,
    /// error, ended (with how), or unknown. The CLI's own words and the last thing said to the
    /// agent follow on lines of their own.
    List {
        /// Print complete agent records as JSON.
        #[arg(long)]
        json: bool,
    },
    /// Show an agent's terminal and send it your input.
    ///
    /// Ctrl-] detaches; the agent keeps running. If the agent ends, exit with its code or 128 plus
    /// the signal number. An unavailable exit status returns code 1. If the connection closes,
    /// reconnect by agent ID and start the daemon if needed. Keys wait for the screen to be
    /// redrawn; Ctrl-] waits at most one second to send them. Bytes handed to a connection are
    /// never sent again: they may have arrived.
    Attach(Target),
    /// Type text or press keys in an agent's terminal.
    ///
    /// Examples: `facade type a3 "run the tests" --enter` or
    /// `facade type a3 --key Esc --key Down --key Enter`. Text is pasted as one input. --enter
    /// presses Enter in a write of its own once the CLI can have read the text. Keys are pressed in
    /// order, as a terminal sends them in the CLI's modes. Return once the input reached the
    /// terminal; if the agent ends first, the error says what was typed.
    #[command(
        override_usage = "facade type <AGENT> <TEXT> [--enter]\n       facade type <AGENT> \
                          --key <KEY>...",
        group(clap::ArgGroup::new("input").required(true).args(["text", "keys"]))
    )]
    Type {
        #[command(flatten)]
        target: Target,
        /// The text to paste: printable characters, tabs, and line breaks. Put `--` before text
        /// that starts with `-`.
        text: Option<String>,
        /// Press Enter after the text. With empty text, press Enter alone.
        #[arg(long, requires = "text")]
        enter: bool,
        /// A key to press; repeat for more. Enter, Esc, Tab, Shift+Tab, Backspace, Delete, Up,
        /// Down, Left, Right, Home, End, PageUp, PageDown, Space, Ctrl+A to Ctrl+Z, in any letter
        /// case, or one character.
        #[arg(long = "key", value_name = "KEY")]
        keys: Vec<String>,
    },
    /// Start an ended agent's CLI again in its terminal, continuing its recorded session.
    ///
    /// The agent keeps its ID, name, and screen. The CLI starts with your environment and terminal
    /// size and the CLI's current rule; the session's own settings stay the CLI's. Only an agent
    /// started by a CLI's name, such as `facade start claude`, whose CLI reported its session, can
    /// resume. In a terminal, show the agent as `facade start` does; otherwise print its ID and
    /// process ID.
    Resume(Target),
    /// Show an agent's CLI rule, its state, its message input as its screen shows it now, what was
    /// last said to it, and its session.
    ///
    /// Reads the screen without sending keys. Input reads unknown for an ended agent, one without a
    /// rule, and one whose CLI has not written since it started, resumed, or was recovered. A
    /// reading never means input may be typed.
    Inspect {
        #[command(flatten)]
        target: Target,
        /// Print the inspection as JSON.
        #[arg(long)]
        json: bool,
    },
    /// Send a message to an agent, or to the person, and print how it was delivered.
    ///
    /// Once the agent's input is empty, its typist pastes the message under a header naming its
    /// sender, such as `📨 Message from #human · #m5`, and presses Enter; it never types over a
    /// draft. In an agent's terminal, the message comes from that agent; elsewhere, from the
    /// person. A message to '#human' from an agent of an editor window goes to that window, which
    /// shows it to the person. A message to a guest, a CLI the person started, waits for its next
    /// turn: return at once. Otherwise return once the message is delivered, or fail within 30
    /// seconds saying why.
    Send {
        /// The recipient: an agent ID (a3, '#a3', or 3), a unique name of a running agent with or
        /// without @, a name and its ID, or '#human' for the person.
        to: String,
        /// The message: at most 8,000 characters and 540 lines of text, tabs, and line breaks.
        text: String,
        /// The message this one answers: one in the sender's inbox, such as m4.
        #[arg(long, value_name = "MESSAGE")]
        reply_to: Option<String>,
    },
    /// Print the messages waiting for the agent of this terminal, which delivers them.
    ///
    /// Each message shows under its header, such as `📨 Message from Ada (#a1) · #m5`, as the
    /// agent's terminal would show it, and its sender learns that it was read.
    Messages,
    /// Rename an agent and print its ID and new name.
    Rename {
        #[command(flatten)]
        target: Target,
        /// The new name. A blank name gets one as a start without a name does.
        name: String,
    },
    /// Print the last lines of an agent's screen and scrollback.
    Screen {
        #[command(flatten)]
        target: Target,
        /// The number of lines to print, from 1 to 2000. Defaults to 50.
        #[arg(long)]
        lines: Option<u16>,
    },
    /// Show Facade's version, process IDs, and agent count; start the daemon if needed.
    Status,
    /// Let the sessions of a CLI that you start yourself join Facade as guests:
    /// `facade integration add claude`.
    ///
    /// Adding writes Facade's entries in the CLI's user configuration: Facade's MCP server, the
    /// approval of its own tools only, and the hooks or extension that report each session's start,
    /// turns and end. Nothing else changes, and nothing is written where a file cannot be read as
    /// its CLI writes it or holds a facade entry of your own. Adding again brings Facade's entries
    /// up to date. Removing takes them out; a file nothing else changed since goes back as it was.
    Integration {
        #[command(subcommand)]
        action: IntegrationAction,
    },
    /// For CLIs: the hooks a CLI's rule installs in its runs, which report the run's session, give
    /// the model its instructions, and approve Facade's own tools; and a guest's hooks, which
    /// report its session and its turns and give its model its messages.
    #[command(hide = true)]
    Hook {
        #[command(subcommand)]
        event: HookEvent,
    },
    /// Internal: run the keeper, which a command starts with Facade, or a daemon whose keeper
    /// ended.
    #[command(hide = true)]
    Keeper,
    /// For programs: run the daemon, or with --detach start Facade in the background: the keeper,
    /// which starts the daemon.
    #[command(hide = true)]
    Daemon {
        /// Start the daemon in the background. Return code 0 when it starts, another daemon holds
        /// the daemon lock, or it is still starting after 10 seconds. Print startup failures and
        /// return code 1. Connect and send hello to confirm readiness.
        #[arg(long)]
        detach: bool,
    },
}

/// An agent's exit as a person reads it: `code 3`, the signal's name, or what is known of an exit
/// with neither.
pub(crate) struct ExitText<'a>(pub(crate) &'a ProcessExit);

impl fmt::Display for ExitText<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match (self.0.code, &self.0.signal, self.0.reason) {
            (Some(code), _, _) => write!(f, "code {code}"),
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
    let command = match Arguments::try_parse() {
        Ok(arguments) => arguments.command,
        Err(error) if error.use_stderr() && is_hook_line() => skip_hook_line(&error),
        Err(error) => error.exit(),
    };
    if !matches!(command, Command::Keeper | Command::Daemon { .. }) {
        end_quietly_on_closed_output();
    }
    let code = run(command).unwrap_or_else(|error| {
        eprintln!("facade: {error:#}");
        1
    });
    std::process::exit(code)
}

/// Whether this program runs as a CLI's hook: `facade hook …`.
fn is_hook_line() -> bool {
    std::env::args_os()
        .nth(1)
        .is_some_and(|word| word == "hook")
}

/// Lets a command whose output is closed early, as by `facade list | head`, end without an error,
/// like other shell tools. The keeper and the daemon keep the default of Rust programs: a peer that
/// closes is an error they handle.
fn end_quietly_on_closed_output() {
    // SAFETY: called before any thread starts; it only puts SIGPIPE's default action back.
    unsafe { libc::signal(libc::SIGPIPE, libc::SIG_DFL) };
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
        println!("{output}");
    }
    std::process::exit(0)
}

/// The size of the person's terminal for an agent's first frame, where this command shows the
/// agent: its standard input and output are both terminals.
fn shown_terminal() -> Option<(u16, u16)> {
    (std::io::stdin().is_terminal() && std::io::stdout().is_terminal())
        .then(|| attach::terminal_size().unwrap_or(DEFAULT_TERMINAL_SIZE))
}

/// Shows the agent a start or resume returned, until the person detaches or it ends; exits 0 where
/// there is none to show.
fn show(
    client: facade_base::daemon_client::DaemonClient,
    agent: Option<String>,
) -> anyhow::Result<i32> {
    match agent {
        Some(agent) => attach::attach(client, &agent, &attempt),
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
        Command::Start { command_line } => {
            // Words Facade cannot use fail before Facade starts.
            let words = commands::start_words(command_line)?;
            let terminal = shown_terminal();
            let mut client = connect_or_start()?;
            let shown = commands::start(&mut client, words, terminal)?;
            show(client, shown)
        }
        Command::Resume(Target { agent }) => {
            let terminal = shown_terminal();
            let mut client = connect_or_start()?;
            let shown = commands::resume(&mut client, agent, terminal)?;
            show(client, shown)
        }
        Command::Attach(Target { agent }) => attach::attach(connect_or_start()?, &agent, &attempt),
        Command::Messages => {
            let Some(agent) = daemon_client::agent_of_terminal()? else {
                anyhow::bail!(
                    "facade messages reads the inbox of the agent whose terminal it runs in, and \
                     this is no agent's terminal"
                );
            };
            commands::messages(&mut daemon_client::connect_or_start_for(&agent)?)?;
            Ok(0)
        }
        Command::List { json } => commands::list(&mut connect_or_start()?, format(json)).map(done),
        Command::Inspect {
            target: Target { agent },
            json,
        } => commands::inspect(&mut connect_or_start()?, agent, format(json)).map(done),
        Command::Screen {
            target: Target { agent },
            lines,
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
        Command::Stop(Target { agent }) => {
            commands::stop(&mut connect_or_start()?, agent).map(done)
        }
        Command::Remove(Target { agent }) => {
            commands::remove(&mut connect_or_start()?, agent).map(done)
        }
        Command::Integration { action } => {
            commands::integration(&mut connect_or_start()?, action).map(done)
        }
        Command::Status => {
            commands::status(&connect_or_start()?);
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
