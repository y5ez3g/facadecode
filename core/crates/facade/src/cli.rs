//! `facade`'s command line: its commands, their arguments and options, and the parse. The words
//! of each page beyond its summary and argument lines are in `help.rs`.

use clap::builder::PossibleValuesParser;
use clap::{CommandFactory, FromArgMatches, Parser, Subcommand};
use facade_base::daemon::first_control;
use facade_base::key_input::{MAX_KEYS, NAMED_KEYS, key_problems};

use crate::errors::Problem;
use crate::help;
use crate::hooks::HookEvent;

/// The shells `facade completion` writes a script for.
const SHELLS: [&str; 4] = ["bash", "zsh", "fish", "powershell"];

const MACHINE_SELECTOR_HELP: &str =
    "Machine name or 'id:' followed by 8 to 32 hex digits from 'facade machine list'";

#[derive(Parser)]
#[command(name = "facade", bin_name = "facade", version)]
pub(crate) struct Arguments {
    #[command(subcommand)]
    pub(crate) command: Option<Command>,
}

#[derive(clap::Args)]
pub(crate) struct Target {
    #[arg(
        value_name = "AGENT",
        help = "Agent ID or name; add @MACHINE for another machine's agent, such as a17@gpu"
    )]
    pub(crate) agent: String,
}

#[derive(clap::Args)]
pub(crate) struct Targets {
    #[arg(
        value_name = "AGENT",
        required = true,
        help = "Agent ID or name; add @MACHINE for another machine's agent, such as a17@gpu"
    )]
    pub(crate) agents: Vec<String>,
}

pub(crate) struct StartOptions {
    pub(crate) name: Option<String>,
    pub(crate) prompt: Option<String>,
    pub(crate) machine: Option<String>,
    pub(crate) folder: Option<String>,
    pub(crate) worktree: Option<String>,
    pub(crate) model: Option<String>,
    pub(crate) effort: Option<String>,
    pub(crate) cli_and_args: Vec<String>,
}

#[derive(Subcommand)]
pub(crate) enum Command {
    #[command(
        about = "Start an agent",
        override_usage = "facade start [OPTIONS] <PROGRAM> [ARGS]..."
    )]
    Start {
        #[arg(
            long,
            value_name = "NAME",
            allow_hyphen_values = true,
            help = "Name the agent [default: chosen by Facade]"
        )]
        name: Option<String>,
        #[arg(
            long,
            value_name = "TEXT",
            allow_hyphen_values = true,
            help = "Give the agent its first prompt when its CLI is ready; use a CLI that supports Facade \
                    messages, such as claude or codex"
        )]
        prompt: Option<String>,
        #[arg(
            short = 'd',
            long,
            help = "Start in the background and print the agent's ID"
        )]
        detach: bool,
        #[arg(long, value_name = "MACHINE", help = MACHINE_SELECTOR_HELP)]
        machine: Option<String>,
        #[arg(
            long,
            value_name = "FOLDER",
            value_parser = clap::builder::NonEmptyStringValueParser::new(),
            help = "Folder for the agent. Relative paths use the shell's current folder here. On another machine, \
                    give an absolute path [default: current folder here, login home on another machine]"
        )]
        folder: Option<String>,
        // PROGRAM and its arguments: one trailing list, so that every word after PROGRAM is the
        // program's own, its `--help` included.
        #[arg(
            value_name = "PROGRAM",
            required = true,
            trailing_var_arg = true,
            allow_hyphen_values = true,
            num_args = 1..,
            hide = true
        )]
        command_line: Vec<String>,
    },
    #[command(about = "List agents", visible_alias = "ls")]
    List {
        #[arg(short, long, conflicts_with = "json", help = "Print only agent IDs")]
        quiet: bool,
        #[arg(long, help = "Print agents as JSON")]
        json: bool,
    },
    #[command(about = "Watch an agent and use its terminal")]
    Attach(Target),
    #[command(about = "Stop one or more agents")]
    Stop(Targets),
    #[command(about = "Resume an ended agent's session")]
    Resume {
        #[arg(
            short = 'd',
            long,
            help = "Resume in the background and print the agent's ID"
        )]
        detach: bool,
        #[command(flatten)]
        target: Target,
    },
    #[command(about = "Remove one or more agents", visible_alias = "rm")]
    Remove(Targets),
    #[command(about = "Rename an agent")]
    Rename {
        #[command(flatten)]
        target: Target,
        #[arg(
            value_name = "NAME",
            help = "New name, or \" \" for one chosen by Facade"
        )]
        name: String,
    },
    #[command(about = "Show what an agent is doing")]
    Inspect {
        #[arg(long, help = "Print the details as JSON")]
        json: bool,
        #[command(flatten)]
        target: Target,
    },
    #[command(about = "Print an agent's recent output")]
    Screen {
        #[arg(
            short = 'n',
            long,
            value_name = "N",
            default_value_t = 50,
            value_parser = clap::value_parser!(u16).range(1..=2000),
            help = "Number of lines to print, from 1 to 2,000"
        )]
        lines: u16,
        #[command(flatten)]
        target: Target,
    },
    #[command(
        about = "Type text or press keys in an agent's terminal",
        override_usage = "facade type <AGENT> <TEXT> [--enter]\n       facade type <AGENT> --key <KEY>...",
        group(clap::ArgGroup::new("input").required(true).args(["text", "keys"]))
    )]
    Type {
        #[command(flatten)]
        target: Target,
        #[arg(
            value_name = "TEXT",
            help = "Text to type; put '--' before text that starts with '-'"
        )]
        text: Option<String>,
        #[arg(long, requires = "text", help = "Press Enter after the text")]
        enter: bool,
        #[arg(
            short = 'k',
            long = "key",
            value_name = "KEY",
            help = key_help()
        )]
        keys: Vec<String>,
    },
    #[command(about = "Send a message to an agent or the human")]
    Send {
        #[arg(
            value_name = "RECIPIENT",
            help = "Agent ID or name, such as a17@gpu on another machine, or human for the human\nIf an agent is also named human, quote '#human' \
                    for the human or use the agent's ID"
        )]
        to: String,
        #[arg(
            value_name = "TEXT",
            help = "Message text, up to 8,000 characters and 540 lines"
        )]
        text: String,
    },
    #[command(about = "Connect to Facade on other machines")]
    Machine {
        #[command(subcommand)]
        action: MachineAction,
    },
    #[command(about = "Show Facade's status")]
    Status {
        #[arg(long, help = "Print the status as JSON")]
        json: bool,
    },
    #[command(about = "Print the version")]
    Version {
        #[arg(long, help = "Print the version as JSON")]
        json: bool,
    },
    #[command(about = "Print a shell completion script")]
    Completion {
        #[arg(
            value_name = "SHELL",
            value_parser = PossibleValuesParser::new(SHELLS),
            hide_possible_values = true,
            help = "bash, zsh, fish or powershell"
        )]
        shell: String,
    },
    // For CLIs: the hooks a CLI's settings run in Facade's runs and in a guest's sessions.
    #[command(hide = true)]
    Hook {
        #[command(subcommand)]
        event: HookEvent,
    },
    // For Facade: the keeper, which a command starts with Facade.
    #[command(hide = true)]
    Keeper,
    // For editors and other programs: the daemon, or with --detach Facade in the background.
    #[command(hide = true)]
    Daemon {
        #[arg(long)]
        detach: bool,
    },
}

/// `facade machine`'s subcommands.
#[derive(Subcommand)]
pub(crate) enum MachineAction {
    #[command(about = "Connect to a machine and keep the connection")]
    Add(SshTarget),
    #[command(about = "Connect to a machine while this command runs")]
    Connect(SshTarget),
    #[command(about = "List machines")]
    List {
        #[arg(long, help = "Print machines as JSON")]
        json: bool,
    },
    #[command(about = "Remove a saved connection")]
    Remove {
        #[arg(value_name = "MACHINE", help = MACHINE_SELECTOR_HELP)]
        machine: String,
    },
    #[command(about = "Rename a machine")]
    Rename {
        #[arg(value_name = "MACHINE", help = MACHINE_SELECTOR_HELP)]
        machine: String,
        #[arg(value_name = "NAME", help = "New name")]
        name: String,
    },
    // For Facade: the far end of a machine connection, which SSH runs on the other machine.
    #[command(hide = true)]
    Serve(ServeArgs),
}

/// The machine `machine add` and `machine connect` reach over SSH.
#[derive(clap::Args)]
pub(crate) struct SshTarget {
    #[arg(
        value_name = "DESTINATION",
        help = "SSH host from your SSH config, or user@host"
    )]
    pub(crate) ssh_destination: String,
    #[arg(
        long,
        value_name = "PATH",
        help = "Facade home on that machine [default: that user's Facade home]"
    )]
    pub(crate) home: Option<String>,
}

/// The Facade home `machine serve` serves, as a path or, from a daemon, hex-encoded.
#[derive(clap::Args)]
pub(crate) struct ServeArgs {
    #[arg(long, value_name = "PATH", conflicts_with = "home_hex")]
    pub(crate) home: Option<std::path::PathBuf>,
    #[arg(long)]
    pub(crate) home_hex: Option<String>,
}

/// `start`'s Arguments section, which shows PROGRAM and its arguments as two arguments though
/// they parse as one list.
const START_ARGUMENTS: &str = "  <PROGRAM>  Built-in or configured CLI, such as claude or codex, or another program name or path\n  \
     [ARGS]...  Arguments for the program; put Facade's options before PROGRAM";

/// `type`'s Arguments section, which shows TEXT as clap shows a required argument: it is required
/// unless keys are given, as the two usage lines say.
const TYPE_ARGUMENTS: &str =
    "  <AGENT>  Agent ID or name; add @MACHINE for another machine's agent, such as a17@gpu
  <TEXT>   Text to type; put '--' before text that starts with '-'";

/// The key option's help, using the names and count the command checks.
fn key_help() -> &'static str {
    static HELP: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    HELP.get_or_init(|| {
        format!(
            "Press a key. Repeat for 1 to {MAX_KEYS} keys. Use {}, Ctrl+A to Ctrl+Z or one non-control Unicode code point. Names and Ctrl combinations ignore ASCII case",
            NAMED_KEYS.join(", ")
        )
    })
}

/// The version of this build, which a test can have it play.
fn version() -> &'static str {
    static VERSION: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    VERSION.get_or_init(facade_base::version)
}

/// The whole command line with its help: every page dressed as `help.rs` says.
pub(crate) fn cli() -> clap::Command {
    let root = Arguments::command()
        .version(version())
        .disable_version_flag(true)
        .arg(
            clap::Arg::new("version")
                .short('V')
                .long("version")
                .action(clap::ArgAction::Version)
                .help("Print the version")
                .display_order(usize::MAX),
        );
    let root = help::dress_root(root.override_usage("facade [OPTIONS] [COMMAND]"));
    dress_children(root, "")
}

/// Dresses every public subcommand of `command`, whose path is `path`.
fn dress_children(mut command: clap::Command, path: &str) -> clap::Command {
    let names: Vec<String> = command
        .get_subcommands()
        .filter(|sub| !sub.is_hide_set() && sub.get_name() != "help")
        .map(|sub| sub.get_name().to_string())
        .collect();
    for name in names {
        let child_path = if path.is_empty() {
            name.clone()
        } else {
            format!("{path} {name}")
        };
        command = command.mut_subcommand(&name, |sub| {
            let Some(page) = help::page(&child_path) else {
                return sub;
            };
            let arguments = match child_path.as_str() {
                "start" => Some(START_ARGUMENTS),
                "type" => Some(TYPE_ARGUMENTS),
                _ => None,
            };
            let sub = help::dress_page(sub, page, arguments);
            let sub = if sub.has_subcommands() {
                sub.disable_help_subcommand(true)
            } else {
                sub
            };
            dress_children(sub, &child_path)
        });
    }
    command
}

/// Parses the program's arguments; clap's own errors and help end the program as clap does.
pub(crate) fn parse() -> Result<Arguments, clap::Error> {
    let matches = cli().try_get_matches()?;
    Arguments::from_arg_matches(&matches)
}

/// Refuses an option of `start`'s that Facade does not know, which came before PROGRAM.
pub(crate) fn check_start(command_line: &[String]) -> Result<(), Problem> {
    match command_line.first() {
        Some(first) if first.starts_with('-') => Err(Problem::UnknownStartOption {
            option: first.clone(),
        }),
        _ => Ok(()),
    }
}

/// Checks a paste or key batch before reaching the daemon.
pub(crate) fn check_type(text: Option<&str>, keys: &[String]) -> Result<(), Problem> {
    let problem = match text {
        Some(text) => first_control(text).map(|diagnostic| Problem::TypeControl { diagnostic }),
        None => key_problems(keys).next().map(Problem::Keys),
    };
    problem.map_or(Ok(()), Err)
}

/// Writes `shell`'s completion script to stdout.
pub(crate) fn completion(shell: &str) {
    let shell = match shell {
        "bash" => clap_complete::Shell::Bash,
        "zsh" => clap_complete::Shell::Zsh,
        "fish" => clap_complete::Shell::Fish,
        _ => clap_complete::Shell::PowerShell,
    };
    // A root of the public commands only, with the root's own options: completion offers no hidden
    // command, at the root or after `help`.
    let full = cli();
    let mut command = clap::Command::new("facade")
        .bin_name("facade")
        .version(version())
        .disable_version_flag(true)
        .args(full.get_arguments().cloned())
        .subcommands(
            full.get_subcommands()
                .filter(|sub| !sub.is_hide_set())
                .cloned(),
        );
    let mut script = Vec::new();
    clap_complete::generate(shell, &mut command, "facade", &mut script);
    let mut script = String::from_utf8_lossy(&script).into_owned();
    // clap_complete's PowerShell and fish scripts complete no argument's values; the others do.
    for (path, values) in argument_values(&command, &[]) {
        match shell {
            clap_complete::Shell::PowerShell => add_powershell_values(&mut script, &path, &values),
            clap_complete::Shell::Fish => add_fish_values(&mut script, &path, &values),
            _ => {}
        }
    }
    print_or_end!("{script}");
}

/// Each public command path and the fixed values its positional argument accepts.
fn argument_values(command: &clap::Command, path: &[String]) -> Vec<(Vec<String>, Vec<String>)> {
    let mut found = Vec::new();
    for sub in command.get_subcommands().filter(|sub| !sub.is_hide_set()) {
        let mut sub_path = path.to_vec();
        sub_path.push(sub.get_name().to_string());
        let values: Vec<String> = sub
            .get_positionals()
            .flat_map(|argument| argument.get_possible_values())
            .map(|value| value.get_name().to_string())
            .collect();
        if !values.is_empty() {
            found.push((sub_path.clone(), values));
        }
        if sub.get_name() != "help" {
            found.extend(argument_values(sub, &sub_path));
        }
    }
    found
}

/// Adds `values` to the PowerShell completions of the command at `path`.
fn add_powershell_values(script: &mut String, path: &[String], values: &[String]) {
    let block = format!("'facade;{}' {{\n", path.join(";"));
    let Some(at) = script.find(&block) else {
        return;
    };
    let lines: String = values
        .iter()
        .map(|value| {
            format!(
                "            [CompletionResult]::new('{value}', '{value}', \
                 [CompletionResultType]::ParameterValue, '{value}')\n"
            )
        })
        .collect();
    script.insert_str(at + block.len(), &lines);
}

/// Adds `values` to the fish completions of the command at `path`, one or two words deep.
fn add_fish_values(script: &mut String, path: &[String], values: &[String]) {
    let condition = match path {
        [command] => format!("__fish_facade_using_subcommand {command}"),
        [command, sub] => {
            format!(
                "__fish_facade_using_subcommand {command}; and __fish_seen_subcommand_from {sub}"
            )
        }
        _ => return,
    };
    script.push_str(&format!(
        "complete -c facade -n \"{condition}\" -f -a \"{}\"\n",
        values.join(" ")
    ));
}
