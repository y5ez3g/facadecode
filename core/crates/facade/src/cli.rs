//! The Shell command line. Usage errors are resolved before dispatch can open a service.

use std::ffi::OsString;
use std::sync::OnceLock;

use clap::error::{ContextKind, ContextValue, ErrorKind};
use clap::{CommandFactory, FromArgMatches, Parser, Subcommand};
use facade_base::daemon::{MAX_MESSAGE_CHARS, MAX_MESSAGE_LINES, check_message_text};
use facade_base::key_input::{KeyProblem, MAX_KEYS, NAMED_KEYS, key_problems};
use facade_base::settings::is_space;
use facade_base::ssh::{SshArgumentError, parse_ssh_destination};
use facade_base::v3::address::{is_machine_name, parse_machine_selector};

use crate::help::{self, Page};
use crate::hooks::HookEvent;

#[derive(Parser)]
#[command(name = "facade", bin_name = "facade", disable_help_subcommand = true)]
pub(crate) struct Arguments {
    #[command(subcommand)]
    pub(crate) command: Option<Command>,
}

#[derive(clap::Args)]
pub(crate) struct Target {
    #[arg(value_name = "AGENT")]
    pub(crate) agent: String,
}

#[derive(clap::Args)]
pub(crate) struct StartOptions {
    #[arg(short = 'n', long, value_name = "NAME", allow_hyphen_values = true)]
    pub(crate) name: Option<String>,
    #[arg(long, value_name = "MACHINE")]
    pub(crate) machine: Option<String>,
    #[arg(long, value_name = "DIRECTORY", value_parser = clap::builder::NonEmptyStringValueParser::new())]
    pub(crate) workdir: Option<String>,
    #[arg(long, value_name = "BRANCH")]
    pub(crate) worktree: Option<String>,
    #[arg(value_name = "CLI", trailing_var_arg = true, num_args = 1..)]
    pub(crate) cli_and_args: Vec<String>,
}

#[derive(Subcommand)]
pub(crate) enum Command {
    Start {
        #[command(flatten)]
        options: StartOptions,
        #[arg(short = 'd', long)]
        detach: bool,
    },
    List {
        #[arg(long, value_name = "MACHINE")]
        machine: Option<String>,
    },
    Attach(Target),
    Stop(Target),
    Resume {
        #[arg(short = 'd', long)]
        detach: bool,
        #[arg(long, value_name = "MACHINE")]
        machine: Option<String>,
        #[arg(value_name = "REFERENCE")]
        reference: Option<String>,
    },
    Rename {
        #[command(flatten)]
        target: Target,
        #[arg(value_name = "NAME")]
        name: String,
    },
    Screen {
        #[arg(short = 'n', long, value_name = "N", default_value_t = 50,
            allow_negative_numbers = true, value_parser = clap::value_parser!(u16).range(1..=2000))]
        lines: u16,
        #[command(flatten)]
        target: Target,
    },
    Type {
        #[command(flatten)]
        target: Target,
        #[arg(value_name = "TEXT")]
        text: Option<String>,
        #[arg(long)]
        enter: bool,
        #[arg(short = 'k', long = "key", value_name = "KEY")]
        keys: Vec<String>,
    },
    Send {
        #[arg(value_name = "RECIPIENT")]
        to: String,
        #[arg(value_name = "TEXT")]
        text: String,
    },
    #[command(disable_help_subcommand = true)]
    Machine {
        #[command(subcommand)]
        action: MachineAction,
    },
    Status {
        #[arg(value_name = "AGENT")]
        agent: Option<String>,
    },
    Upgrade,
    // Help and version are dispatch results, without subcommands of their own.
    #[command(skip)]
    Help(&'static Page),
    #[command(skip)]
    PrintVersion,
    #[command(hide = true)]
    Hook {
        #[command(subcommand)]
        event: HookEvent,
    },
    #[command(hide = true)]
    Keeper,
    #[command(hide = true)]
    Daemon {
        #[arg(long, conflicts_with = "takeover")]
        detach: bool,
        #[arg(long)]
        takeover: bool,
    },
}

#[derive(Subcommand)]
pub(crate) enum MachineAction {
    Add(SshTarget),
    Connect(SshTarget),
    List,
    Remove {
        #[arg(value_name = "MACHINE")]
        machine: String,
    },
    Rename {
        #[arg(value_name = "MACHINE")]
        machine: String,
        #[arg(value_name = "NAME")]
        name: String,
    },
    // Holds the SSH session after the public add command returns.
    #[command(hide = true)]
    Link(SshTarget),
    // The far end of a machine session, which SSH runs on the other machine.
    #[command(hide = true)]
    Serve(ServeArgs),
}

#[derive(clap::Args)]
pub(crate) struct SshTarget {
    #[arg(long, value_name = "PATH")]
    pub(crate) home: Option<String>,
    #[arg(value_name = "SSH_ARGS", required = true, trailing_var_arg = true, allow_hyphen_values = true, num_args = 1..)]
    pub(crate) ssh_args: Vec<String>,
}

/// The Facade home 'machine serve' serves, as a path or, from a daemon, hex-encoded.
#[derive(clap::Args)]
pub(crate) struct ServeArgs {
    #[arg(long, value_name = "PATH", conflicts_with = "home_hex")]
    pub(crate) home: Option<std::path::PathBuf>,
    #[arg(long)]
    pub(crate) home_hex: Option<String>,
    /// A passive machine session can use a running daemon without starting one.
    #[arg(long)]
    pub(crate) no_start: bool,
}

#[derive(Debug)]
pub(crate) enum ParseError {
    Usage(String),
    Internal(clap::Error),
}

pub(crate) fn parse() -> Result<Arguments, ParseError> {
    parse_from(&std::env::args_os().collect::<Vec<_>>())
}

/// Parses argv, including the program name. Neither parsing nor help selection opens a socket.
pub(crate) fn parse_from(argv: &[OsString]) -> Result<Arguments, ParseError> {
    let words = argv.get(1..).unwrap_or_default();
    match words {
        [help, rest @ ..] if help == "help" => return requested_help("", rest),
        [machine, help, rest @ ..] if machine == "machine" && help == "help" => {
            return requested_help("machine", rest);
        }
        [command]
            if matches!(
                command.to_str(),
                Some(
                    "start" | "attach" | "stop" | "screen" | "rename" | "send" | "type" | "machine"
                )
            ) =>
        {
            return requested_help("", words);
        }
        [machine, action]
            if machine == "machine"
                && matches!(
                    action.to_str(),
                    Some("add" | "connect" | "remove" | "rename")
                ) =>
        {
            return requested_help("", words);
        }
        _ => {}
    }

    let scope = public_scope(words);
    static VERSION: OnceLock<String> = OnceLock::new();
    let mut arguments = match Arguments::command()
        .version(VERSION.get_or_init(facade_base::version).as_str())
        .try_get_matches_from(argv)
        .and_then(|matches| Arguments::from_arg_matches(&matches))
    {
        Ok(arguments) => arguments,
        Err(error) => match (scope, error.kind()) {
            (Some(page), ErrorKind::DisplayHelp) => return selected(Command::Help(page)),
            (Some(_), ErrorKind::DisplayVersion) => return selected(Command::PrintVersion),
            (Some(page), _) => return Err(public_error(page, words, &error)),
            (None, _) => return Err(ParseError::Internal(error)),
        },
    };

    if let Some(Command::Machine {
        action:
            MachineAction::Add(target) | MachineAction::Connect(target) | MachineAction::Link(target),
    }) = arguments.command.as_mut()
    {
        let first_ssh = match words.get(2) {
            Some(word) if word == "--home" => 4,
            _ if target.home.is_some() => 3,
            _ => 2,
        };
        // The leading -- is for SSH. Clap only keeps it after the first trailing argument.
        if words.get(first_ssh).is_some_and(|word| word == "--") {
            target.ssh_args.insert(0, "--".into());
        }
    }
    if let (Some(page), Some(command)) = (scope, &arguments.command) {
        validate(page, command)?;
    }
    Ok(arguments)
}

fn selected(command: Command) -> Result<Arguments, ParseError> {
    Ok(Arguments {
        command: Some(command),
    })
}

fn requested_help(parent: &'static str, words: &[OsString]) -> Result<Arguments, ParseError> {
    let mut page = help::page(parent).expect("public help group");
    for word in words {
        if word == "-h" || word == "--help" {
            return selected(Command::Help(page));
        }
        let word = word.to_string_lossy();
        if word.starts_with('-') {
            return Err(unknown_option(page, &word));
        }
        let path = match page.path {
            "" => word.to_string(),
            "machine" => format!("machine {word}"),
            _ => {
                return Err(usage(format!(
                    "error: Unexpected argument {word:?}.\n{}",
                    help_tip(page)
                )));
            }
        };
        page = help::page(&path)
            .filter(|_| !word.is_empty() && !word.contains(' '))
            .ok_or_else(|| unknown_command(page, &word))?;
    }
    selected(Command::Help(page))
}

/// Identifies the public page whose syntax applies. Hidden invocations retain their own errors.
fn public_scope(words: &[OsString]) -> Option<&'static Page> {
    let command = words.first().and_then(|word| word.to_str()).unwrap_or("");
    match command {
        "daemon" | "keeper" | "hook" => None,
        "machine" => match words.get(1).and_then(|word| word.to_str()) {
            Some("link" | "serve") => None,
            Some(action) => {
                help::page(&format!("machine {action}")).or_else(|| help::page("machine"))
            }
            None => help::page("machine"),
        },
        _ => help::page(command).or_else(|| help::page("")),
    }
}

fn usage(message: impl Into<String>) -> ParseError {
    ParseError::Usage(message.into())
}

fn help_tip(page: &Page) -> String {
    match page.path {
        "" => "Run 'facade --help' for available commands.".into(),
        "machine" => "Run 'facade machine --help' for available commands.".into(),
        command => format!("Run 'facade {command} --help' for all options."),
    }
}

fn unknown_command(page: &Page, given: &str) -> ParseError {
    usage(format!(
        "error: Unknown command {given:?}.\n{}",
        help_tip(page)
    ))
}

fn unknown_option(page: &Page, given: &str) -> ParseError {
    usage(format!(
        "error: Unknown option '{given}'.\n{}\n{}",
        page.usage,
        help_tip(page)
    ))
}

fn context(error: &clap::Error, kind: ContextKind) -> Option<&str> {
    match error.get(kind) {
        Some(ContextValue::String(text)) => Some(text),
        _ => None,
    }
}

fn public_error(page: &Page, words: &[OsString], error: &clap::Error) -> ParseError {
    let arg = context(error, ContextKind::InvalidArg).unwrap_or_default();
    let value = context(error, ContextKind::InvalidValue);
    let is_group = matches!(page.path, "" | "machine");
    match error.kind() {
        ErrorKind::MissingRequiredArgument => missing_argument(page, words, error),
        ErrorKind::InvalidSubcommand => unknown_command(
            page,
            context(error, ContextKind::InvalidSubcommand).unwrap_or(arg),
        ),
        ErrorKind::UnknownArgument if arg == "-v" && page.path.is_empty() => {
            usage("error: Unknown option '-v'.\nRun 'facade --version' to print the CLI version.")
        }
        ErrorKind::UnknownArgument if page.path == "start" && arg.starts_with('-') => {
            unknown_start_option(words, arg)
        }
        ErrorKind::UnknownArgument if arg.starts_with('-') && !passed_separator(words, arg) => {
            unknown_option(page, arg)
        }
        ErrorKind::UnknownArgument if is_group => unknown_command(page, arg),
        ErrorKind::UnknownArgument => extra_argument(page, arg),
        ErrorKind::ValueValidation | ErrorKind::InvalidValue
            if page.path == "screen" && arg.starts_with("--lines") && value.is_some() =>
        {
            usage(format!(
                "error: Invalid value {:?} for '--lines <N>': must be between 1 and 2,000.\n{}",
                value.unwrap_or_default(),
                help_tip(page)
            ))
        }
        ErrorKind::InvalidValue if value == Some("") => usage(format!(
            "error: '{arg}' requires a value.\n{}\n{}",
            page.usage,
            help_tip(page)
        )),
        // Keep clap's details for malformed option values, repeated options and invalid UTF-8.
        _ => {
            let detail = error.to_string();
            let detail = detail.lines().next().unwrap_or(&detail);
            usage(format!("{detail}\n{}\n{}", page.usage, help_tip(page)))
        }
    }
}

fn passed_separator(words: &[OsString], arg: &str) -> bool {
    words
        .iter()
        .take_while(|word| *word != arg)
        .any(|word| word == "--")
}

fn unknown_start_option(words: &[OsString], option: &str) -> ParseError {
    let has_following_word = words
        .iter()
        .skip_while(|word| {
            word.to_str()
                .is_none_or(|word| word.split('=').next() != Some(option))
        })
        .skip(1)
        .any(|word| word.to_str().is_some_and(|word| !word.starts_with('-')));
    let example = if has_following_word {
        help::page("start")
            .expect("start help page")
            .first_example()
    } else {
        "facade start <CLI>"
    };
    usage(format!(
        "error: Unknown option '{option}' before <CLI>.\n\
         Put Facade options before the CLI name, and CLI options after it.\n\
         Example: {example} {option} ...\n\
         Run 'facade start --help' for Facade options."
    ))
}

fn missing_argument(page: &Page, words: &[OsString], error: &clap::Error) -> ParseError {
    let mut operands = words.iter().skip(page.path.split_whitespace().count());
    let given = operands
        .next()
        .and_then(|word| {
            if word == "--" {
                operands.next()
            } else {
                Some(word)
            }
        })
        .map(|word| word.to_string_lossy())
        .unwrap_or_default();
    let missing_first = match error.get(ContextKind::InvalidArg) {
        Some(ContextValue::Strings(missing)) => {
            missing.iter().any(|arg| arg != "<NAME>" && arg != "<TEXT>")
        }
        _ => true,
    };
    let find_agent = "Run 'facade list' to find an agent.";
    let (message, tip) = match page.path {
        "stop" => ("Choose an agent to stop.".into(), find_agent),
        "attach" => ("Choose an agent to attach to.".into(), find_agent),
        "screen" => (
            "Choose an agent whose screen you want to read.".into(),
            find_agent,
        ),
        "type" => (
            "Choose an agent and provide text or keys to type.".into(),
            find_agent,
        ),
        "rename" if missing_first => ("Choose an agent and its new name.".into(), find_agent),
        "rename" => (format!("Enter a new name for {given:?}."), ""),
        "send" if missing_first => ("Choose a recipient and enter a message.".into(), find_agent),
        "send" => (format!("Enter a message to send to {given:?}."), ""),
        "machine add" | "machine connect" => return missing_ssh_destination(page),
        "machine remove" => (
            "Choose a saved machine connection to remove.".into(),
            "Run 'facade machine list' to see saved machines.",
        ),
        "machine rename" if missing_first => (
            "Choose a machine and its new name.".into(),
            "Run 'facade machine list' to see machines.",
        ),
        "machine rename" => (format!("Enter a new name for machine {given:?}."), ""),
        _ => return usage(error.to_string().trim_end()),
    };
    let example = if page.path == "type" {
        TYPE_TEXT_EXAMPLE
    } else {
        page.first_example()
    };
    example_error(page, &message, example, tip)
}

fn missing_ssh_destination(page: &Page) -> ParseError {
    example_error(page, "Enter an SSH destination.", page.first_example(), "")
}

fn example_error(page: &Page, message: &str, example: &str, tip: &str) -> ParseError {
    let mut text = format!("error: {message}\n{}\nExample: {example}", page.usage);
    if !tip.is_empty() {
        text.push('\n');
        text.push_str(tip);
    }
    usage(text)
}

fn extra_argument(page: &Page, given: &str) -> ParseError {
    let command = page.path;
    let message = match command {
        "attach" | "stop" | "screen" => format!("'facade {command}' accepts one agent."),
        "status" | "resume" => format!("'facade {command}' accepts at most one agent."),
        "list" => "'facade list' does not take positional arguments.".into(),
        "machine list" | "upgrade" => {
            return usage(format!("error: 'facade {command}' does not take arguments.\n{}", page.usage));
        }
        "machine remove" => "'facade machine remove' accepts one machine.".into(),
        "machine rename" => "'facade machine rename' accepts one machine and one name.".into(),
        "rename" => "'facade rename' accepts one agent and one name.\nQuote names with spaces.".into(),
        "send" => "'facade send' accepts one recipient and one message.\nQuote the message if it has spaces.".into(),
        _ => format!("Unexpected argument {given:?}."),
    };
    match command {
        "list" => usage(format!(
            "error: {message}\n{}\n{}",
            page.usage,
            help_tip(page)
        )),
        "status" => example_error(page, &message, "facade status a3@devbox", ""),
        "rename" => example_error(page, &message, r#"facade rename Nova "Shell review""#, ""),
        "attach" | "stop" | "machine remove" | "machine rename" | "send" => {
            example_error(page, &message, page.first_example(), "")
        }
        _ => example_error(page, &message, page.first_example(), &help_tip(page)),
    }
}

fn validate(page: &Page, command: &Command) -> Result<(), ParseError> {
    match command {
        Command::Start {
            options:
                StartOptions {
                    machine: Some(machine),
                    ..
                },
            ..
        }
        | Command::List {
            machine: Some(machine),
        } => validate_machine_selector(page, machine)?,
        Command::Resume {
            detach,
            machine,
            reference,
        } => {
            if machine.is_some() && (*detach || reference.is_some()) {
                return Err(usage(format!(
                    "error: '--machine' can only be used to list resumable agents and sessions, not with '-d' or <REFERENCE>.\n{}\n{}",
                    page.usage,
                    help_tip(page)
                )));
            }
            if *detach && reference.is_none() {
                return Err(usage(
                    "error: Choose an agent or session to resume in the background.\n\
                     Usage: facade resume [-d|--detach] <REFERENCE>\n\
                     Example: facade resume -d a5@laptop\n\
                     Run 'facade resume' to see resumable agents and sessions.",
                ));
            }
            if let Some(machine) = machine {
                validate_machine_selector(page, machine)?;
            }
        }
        Command::Rename { name, .. } if name.chars().all(is_space) => {
            return Err(example_error(
                page,
                "Agent name cannot be empty.",
                page.first_example(),
                "",
            ));
        }
        Command::Send { text, .. } => validate_message(text)?,
        Command::Type {
            target,
            text,
            enter,
            keys,
        } => {
            validate_type(page, &target.agent, text.as_deref(), *enter, keys)?;
        }
        Command::Machine {
            action: MachineAction::Rename { name, .. },
        } if !is_machine_name(name) => {
            return Err(usage(format!(
                "error: Invalid machine name {name:?}. Use lowercase letters, digits, and hyphens ('-')."
            )));
        }
        Command::Machine {
            action: MachineAction::Remove { machine } | MachineAction::Rename { machine, .. },
        } => validate_machine_selector(page, machine)?,
        Command::Machine {
            action: MachineAction::Add(target) | MachineAction::Connect(target),
        } => {
            if target.home.as_deref() == Some("") {
                return Err(usage(format!(
                    "error: '--home <PATH>' requires a nonempty path.\n{}\n{}",
                    page.usage,
                    help_tip(page)
                )));
            }
            if let Err(error) = parse_ssh_destination(&target.ssh_args) {
                return Err(match error {
                    SshArgumentError::Destination => missing_ssh_destination(page),
                    _ => usage(format!(
                        "error: Invalid SSH arguments: {error}.\n{}",
                        help_tip(page)
                    )),
                });
            }
        }
        _ => {}
    }
    Ok(())
}

fn validate_machine_selector(page: &Page, machine: &str) -> Result<(), ParseError> {
    parse_machine_selector(machine).map_err(|_| {
        usage(format!(
            "error: Invalid machine selector {machine:?}. Use a machine name or ID from 'facade machine list'.\n{}",
            help_tip(page)
        ))
    })?;
    Ok(())
}

fn quantity(value: usize) -> String {
    if value < 1_000 {
        return value.to_string();
    }
    format!("{},{:03}", quantity(value / 1_000), value % 1_000)
}

fn validate_message(text: &str) -> Result<(), ParseError> {
    if let Err(problem) = check_message_text(text) {
        if text.trim().is_empty() {
            return Err(usage("error: Message text cannot be empty."));
        }
        let characters = text.chars().count();
        let lines = text.replace("\r\n", "\n").split(['\n', '\r']).count();
        if characters > MAX_MESSAGE_CHARS || lines > MAX_MESSAGE_LINES {
            return Err(usage(format!(
                "error: Message is too long ({} characters, {} lines). Maximum is {} characters and {} lines.",
                quantity(characters),
                quantity(lines),
                quantity(MAX_MESSAGE_CHARS),
                quantity(MAX_MESSAGE_LINES)
            )));
        }
        return Err(usage(format!("error: Invalid message text: {problem}.")));
    }
    Ok(())
}

const TYPE_TEXT_EXAMPLE: &str = r#"facade type Nova "hello" --enter"#;
const TYPE_KEY_EXAMPLE: &str = "facade type Nova --key Enter";

fn validate_type(
    page: &Page,
    agent: &str,
    text: Option<&str>,
    enter: bool,
    keys: &[String],
) -> Result<(), ParseError> {
    if let Some(text) = text {
        if !keys.is_empty() {
            return Err(usage(format!(
                "error: Cannot combine <TEXT> with '--key'.\n\
                 Use '--enter' to press Enter after text, or run separate commands.\n\
                 Example: {TYPE_TEXT_EXAMPLE}"
            )));
        }
        if text.is_empty() {
            return Err(example_error(
                page,
                "Text to type cannot be empty.",
                TYPE_TEXT_EXAMPLE,
                "",
            ));
        }
        if let Some(control) = text.chars().find(|ch| ch.is_control()) {
            return Err(usage(format!(
                "error: Text contains the control character U+{:04X}. Use '-k' or '--key' to press a key.\n\
                 Example: {TYPE_KEY_EXAMPLE}",
                u32::from(control)
            )));
        }
        return Ok(());
    }
    if enter {
        return Err(usage(format!(
            "error: '--enter' requires <TEXT>.\n\
             To press Enter by itself, use '--key Enter'.\n\
             Example: {TYPE_KEY_EXAMPLE}"
        )));
    }
    if keys.is_empty() {
        return Err(example_error(
            page,
            &format!("Enter text or provide a key to press in {agent:?}."),
            TYPE_TEXT_EXAMPLE,
            "",
        ));
    }
    match key_problems(keys).next() {
        Some(KeyProblem::Unknown { given, .. }) => Err(usage(format!(
            "error: Unknown key {given:?}.\n\
             Supported keys: {}, Ctrl+A to Ctrl+Z, or one character\n\
             Example: {TYPE_KEY_EXAMPLE}",
            NAMED_KEYS.join(", ")
        ))),
        Some(KeyProblem::Count(count)) => Err(usage(format!(
            "error: 'facade type' accepts at most {MAX_KEYS} keys, got {count}.\n{}",
            help_tip(page)
        ))),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn type_rejects_return_as_an_unknown_key() {
        let words = ["facade", "type", "Nova", "--key", "Return"].map(OsString::from);
        let Err(ParseError::Usage(message)) = parse_from(&words) else {
            panic!("Return should be a Shell usage error");
        };
        assert_eq!(
            message,
            concat!(
                "error: Unknown key \"Return\".\n",
                "Supported keys: Enter, Esc, Tab, Shift+Tab, Backspace, Delete, Up, Down, Left, Right, Home, End, PageUp, PageDown, Space, Ctrl+A to Ctrl+Z, or one character\n",
                "Example: facade type Nova --key Enter"
            )
        );

        for key in ["eNtEr", "ctrl+m", "界"] {
            let words = ["facade", "type", "Nova", "--key", key].map(OsString::from);
            assert!(parse_from(&words).is_ok(), "{key}");
        }
    }

    #[test]
    fn public_machine_selectors_are_checked_before_dispatch() {
        for command in [
            &["start", "--machine", "user@devbox", "codex"][..],
            &["list", "--machine", "user@devbox"],
            &["resume", "--machine", "user@devbox"],
            &["machine", "remove", "user@devbox"],
            &["machine", "rename", "user@devbox", "lab"],
        ] {
            let words: Vec<_> = std::iter::once("facade")
                .chain(command.iter().copied())
                .map(OsString::from)
                .collect();
            let Err(ParseError::Usage(message)) = parse_from(&words) else {
                panic!("expected an invalid machine selector in {command:?}");
            };
            assert!(message.starts_with("error: Invalid machine selector \"user@devbox\"."));
        }

        for selector in ["devbox", "9A0D44B2", "9a0d44b2-b6bf-46ab-840c-c23191867395"] {
            let words = ["facade", "list", "--machine", selector].map(OsString::from);
            assert!(parse_from(&words).is_ok(), "{selector}");
        }
    }
}
