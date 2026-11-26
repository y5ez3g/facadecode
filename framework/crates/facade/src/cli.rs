//! The Shell command line. Usage errors are resolved before dispatch can open a service.

use std::ffi::OsString;
use std::sync::OnceLock;

use clap::error::{ContextKind, ContextValue, ErrorKind};
use clap::{ArgMatches, CommandFactory, FromArgMatches, Parser, Subcommand};
use facade_base::address::{is_machine_name, selector::parse_machine_selector};
use facade_base::api_v1::daemon::{InputStep, SendWait, TerminalInput};
use facade_base::key_input::{KeyProblem, MAX_INPUT_BYTES, MAX_KEYS, NAMED_KEYS, key_problems};
use facade_base::model::message::{MAX_MESSAGE_CHARS, MAX_MESSAGE_LINES, check_message_text};
use facade_base::settings::is_space;
use facade_base::ssh::{SshArgumentError, parse_ssh_destination};

use crate::help::{self, Page};
use crate::hooks::HookEvent;

pub(crate) struct Arguments {
    pub(crate) command: Option<Command>,
}

#[derive(Parser)]
#[command(name = "facade", bin_name = "facade", disable_help_subcommand = true)]
struct LexicalArguments {
    #[command(subcommand)]
    command: Option<LexicalCommand>,
}

#[derive(Subcommand)]
enum LexicalCommand {
    Type(TypeOperands),
    Send(SendOperands),
    #[command(flatten)]
    Other(Command),
}

#[derive(clap::Args)]
struct TypeOperands {
    #[command(flatten)]
    target: Target,
    #[arg(value_name = "TEXT")]
    text: Vec<String>,
    #[arg(long)]
    enter: bool,
    #[arg(short = 'k', long = "key", value_name = "KEY")]
    keys: Vec<String>,
}

#[derive(clap::Args)]
struct SendOperands {
    #[arg(value_name = "RECIPIENT")]
    to: Option<String>,
    #[arg(value_name = "TEXT")]
    text: Option<String>,
    #[arg(short = 'w', long)]
    wait_delivery: bool,
    #[arg(short = 'r', long)]
    wait_reply: bool,
    #[arg(short, long, value_name = "SECONDS", default_value_t = 30,
        allow_negative_numbers = true, value_parser = send_timeout)]
    timeout: u16,
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
        #[arg(long)]
        local: bool,
        #[arg(long, value_name = "MACHINE")]
        machine: Option<String>,
    },
    Attach(Target),
    Stop {
        #[arg(value_name = "AGENT")]
        agents: Vec<String>,
        #[arg(long)]
        local: bool,
        #[arg(long, value_name = "MACHINE")]
        machine: Option<String>,
        #[arg(long)]
        all: bool,
    },
    Resume {
        #[arg(long)]
        local: bool,
        #[arg(long, value_name = "MACHINE")]
        machine: Option<String>,
        #[arg(short = 'd', long)]
        detach: bool,
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
    #[command(skip)]
    Type {
        target: Target,
        input: TerminalInput,
    },
    #[command(skip)]
    Send {
        to: String,
        text: String,
        wait_for: SendWait,
        timeout: u16,
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
    Upgrade {
        #[arg(long, value_name = "X.Y.Z", value_parser = upgrade_version)]
        version: Option<String>,
    },
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
        #[arg(long, conflicts_with_all = ["takeover", "install_only", "await_startup"])]
        detach: bool,
        #[arg(long, conflicts_with = "install_only")]
        takeover: bool,
        #[arg(long)]
        install_only: bool,
        #[arg(long, hide = true, num_args = 0..=3, conflicts_with_all = ["takeover", "install_only"])]
        await_startup: Option<Vec<String>>,
    },
}

fn upgrade_version(value: &str) -> Result<String, &'static str> {
    if value
        .bytes()
        .all(|byte| byte.is_ascii_digit() || byte == b'.')
        && facade_base::version_of(value).is_some()
    {
        Ok(value.to_owned())
    } else {
        Err("use three decimal numbers, such as 0.1.6")
    }
}

const TIMEOUT_RANGE: &str = "must be a whole number between 1 and 300";

fn send_timeout(value: &str) -> Result<u16, &'static str> {
    value
        .parse::<u16>()
        .ok()
        .filter(|seconds| (1..=300).contains(seconds) && value.bytes().all(|b| b.is_ascii_digit()))
        .ok_or(TIMEOUT_RANGE)
}

#[derive(Subcommand)]
pub(crate) enum MachineAction {
    Add {
        #[command(flatten)]
        target: SshTarget,
        #[arg(long)]
        bidirectional: bool,
    },
    Connect(SshTarget),
    List,
    Remove {
        #[arg(value_name = "MACHINE")]
        machine: String,
        #[arg(long)]
        bidirectional: bool,
    },
    Rename {
        #[arg(value_name = "MACHINE")]
        machine: String,
        #[arg(value_name = "NAME")]
        name: String,
    },
    // Holds the SSH session after the public add command returns.
    #[command(hide = true)]
    Link {
        #[command(flatten)]
        target: SshTarget,
        #[arg(long)]
        bidirectional: bool,
    },
    // The far end of a machine session, which SSH runs on the other machine.
    #[command(hide = true)]
    Serve(ServeArgs),
    #[command(hide = true)]
    SshAdmin {
        #[arg(long)]
        home_hex: Option<String>,
        #[arg(long)]
        probe: bool,
    },
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
    if let Some(page) = scope.filter(|page| page.path == "type") {
        for word in words.iter().skip(1).take_while(|word| *word != "--") {
            if let Some(option @ ("-key" | "--Key")) = word.to_str() {
                return Err(option_error(
                    page,
                    &format!("Unknown option '{option}'. Use '-k' or '--key'."),
                ));
            }
        }
    }
    static VERSION: OnceLock<String> = OnceLock::new();
    let parsed = LexicalArguments::command()
        .version(VERSION.get_or_init(facade_base::build_id).as_str())
        .try_get_matches_from(argv)
        .and_then(|matches| Ok((LexicalArguments::from_arg_matches(&matches)?, matches)));
    let (lexical, matches) = match parsed {
        Ok(parsed) => parsed,
        Err(error) => match (scope, error.kind()) {
            (Some(page), ErrorKind::DisplayHelp) => return selected(Command::Help(page)),
            (Some(_), ErrorKind::DisplayVersion) => return selected(Command::PrintVersion),
            (Some(page), _) => return Err(public_error(page, words, &error)),
            (None, _) => return Err(ParseError::Internal(error)),
        },
    };

    let command = match lexical.command {
        None => return Ok(Arguments { command: None }),
        Some(LexicalCommand::Type(operands)) => operands.validate(
            scope.expect("type help page"),
            matches.subcommand_matches("type").expect("type arguments"),
        )?,
        Some(LexicalCommand::Send(operands)) => {
            operands.validate(scope.expect("send help page"))?
        }
        Some(LexicalCommand::Other(mut command)) => {
            if let Command::Machine { action } = &mut command {
                keep_ssh_separator(action, &words[2..]);
            }
            if let Some(page) = scope {
                validate(page, &command)?;
            }
            command
        }
    };
    selected(command)
}

fn keep_ssh_separator(action: &mut MachineAction, mut words: &[OsString]) {
    let (target, bidirectional) = match action {
        MachineAction::Add {
            target,
            bidirectional,
        }
        | MachineAction::Link {
            target,
            bidirectional,
        } => (target, *bidirectional),
        MachineAction::Connect(target) => (target, false),
        _ => return,
    };
    loop {
        words = match words {
            [option, _, rest @ ..] if option == "--home" => rest,
            [option, rest @ ..]
                if option
                    .to_str()
                    .is_some_and(|word| word.starts_with("--home="))
                    || (bidirectional && option == "--bidirectional") =>
            {
                rest
            }
            _ => break,
        };
    }
    // The leading -- is for SSH. Clap only keeps it after the first trailing argument.
    if words.first().is_some_and(|word| word == "--") {
        target.ssh_args.insert(0, "--".into());
    }
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
            Some("link" | "serve" | "ssh-admin") => None,
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
    option_error(page, &format!("Unknown option '{given}'."))
}

fn option_error(page: &Page, message: &str) -> ParseError {
    usage(format!(
        "error: {message}\n{}\n{}",
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
        ErrorKind::ValueValidation if page.path == "send" && arg.starts_with("--timeout") => {
            usage(format!(
                "error: Invalid value {:?} for '--timeout <SECONDS>': {TIMEOUT_RANGE}.\n{}",
                value.unwrap_or_default(),
                help_tip(page)
            ))
        }
        ErrorKind::InvalidValue if value == Some("") => {
            option_error(page, &format!("'{arg}' requires a value."))
        }
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
        "attach" | "screen" => format!("'facade {command}' accepts one agent."),
        "status" | "resume" => format!("'facade {command}' accepts at most one agent."),
        "list" => "'facade list' does not take positional arguments.".into(),
        "machine list" => {
            return usage(format!("error: 'facade {command}' does not take arguments.\n{}", page.usage));
        }
        "upgrade" => {
            return usage(format!("error: 'facade upgrade' does not take positional arguments.\n{}", page.usage));
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
        "attach" | "machine remove" | "machine rename" | "send" => {
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
        } => validate_machine_selector(page, machine)?,
        Command::List {
            local,
            machine: Some(machine),
        } => {
            if *local {
                return Err(local_machine_conflict(page, page.usage));
            }
            validate_machine_selector(page, machine)?;
        }
        Command::Stop {
            agents,
            local,
            machine,
            all,
        } => {
            let mut scopes = [
                (*all, "'--all'"),
                (*local, "'--local'"),
                (machine.is_some(), "'--machine'"),
                (!agents.is_empty(), "<AGENT> targets"),
            ]
            .into_iter()
            .filter_map(|(given, name)| given.then_some(name));
            match (scopes.next(), scopes.next()) {
                (None, _) => {
                    return Err(example_error(
                        page,
                        "Choose an agent to stop.",
                        page.first_example(),
                        "Run 'facade list' to find an agent.",
                    ));
                }
                (Some(first), Some(second)) => {
                    return Err(usage(format!(
                        "error: Cannot combine {first} with {second}."
                    )));
                }
                _ => {}
            }
            if let Some(machine) = machine {
                validate_machine_selector(page, machine)?;
            }
        }
        Command::Resume {
            local,
            machine,
            detach,
            reference,
        } => {
            if *local && machine.is_some() {
                let listing = page.usage.lines().nth(1).expect("resume listing syntax");
                return Err(local_machine_conflict(
                    page,
                    &format!("Usage: {}", listing.trim_start()),
                ));
            }
            if (*detach || reference.is_some()) && (*local || machine.is_some()) {
                let option = if *local { "--local" } else { "--machine" };
                return Err(usage(format!(
                    "error: '{option}' can only be used to list resumable agents and sessions, not with '-d' or <REFERENCE>.\n{}\n{}",
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
        Command::Machine {
            action: MachineAction::Rename { name, .. },
        } if !is_machine_name(name) => {
            return Err(usage(format!(
                "error: Invalid machine name {name:?}. Use lowercase letters, digits, and hyphens ('-')."
            )));
        }
        Command::Machine {
            action: MachineAction::Remove { machine, .. } | MachineAction::Rename { machine, .. },
        } => validate_machine_selector(page, machine)?,
        Command::Machine {
            action: MachineAction::Add { target, .. } | MachineAction::Connect(target),
        } => {
            if target.home.as_deref() == Some("") {
                return Err(usage(format!(
                    "error: '--home <PATH>' requires a nonempty path.\n{}\n{}",
                    page.usage,
                    help_tip(page)
                )));
            }
            if page.path == "machine add" {
                for word in target.ssh_args.iter().take_while(|word| *word != "--") {
                    let option = match word.as_str() {
                        "--bidirectional" => "--bidirectional",
                        "--home" => "--home",
                        word if word.starts_with("--home=") => "--home",
                        _ => continue,
                    };
                    return Err(usage(format!(
                        "error: Put '{option}' before the SSH arguments and destination.\n{}\n{}",
                        page.usage,
                        help_tip(page)
                    )));
                }
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

fn local_machine_conflict(page: &Page, syntax: &str) -> ParseError {
    usage(format!(
        "error: Cannot combine '--local' with '--machine'.\n{syntax}\n{}",
        help_tip(page)
    ))
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

impl SendOperands {
    fn validate(self, page: &Page) -> Result<Command, ParseError> {
        let wait_for = match (self.wait_delivery, self.wait_reply) {
            (true, true) => {
                return Err(option_error(
                    page,
                    "Cannot combine '--wait-delivery' with '--wait-reply'.",
                ));
            }
            (true, false) => SendWait::Delivery,
            (false, true) => SendWait::Result,
            (false, false) => SendWait::Inbox,
        };
        let Some(to) = self.to else {
            return Err(example_error(
                page,
                "Choose a recipient and enter a message.",
                page.first_example(),
                "Run 'facade list' to find an agent.",
            ));
        };
        let Some(text) = self.text else {
            return Err(example_error(
                page,
                &format!("Enter a message to send to {to:?}."),
                page.first_example(),
                "",
            ));
        };
        validate_message(&text)?;
        Ok(Command::Send {
            to,
            text,
            wait_for,
            timeout: self.timeout,
        })
    }
}

const TYPE_TEXT_EXAMPLE: &str = r#"facade type Nova "hello" --enter"#;
const TYPE_KEY_EXAMPLE: &str = "facade type Nova --key Enter";

impl TypeOperands {
    fn validate(self, page: &Page, matches: &ArgMatches) -> Result<Command, ParseError> {
        let Self {
            target,
            mut text,
            enter,
            keys,
        } = self;
        if enter {
            if text.is_empty() {
                return Err(usage(format!(
                    "error: '--enter' requires <TEXT>.\n\
                     To press Enter by itself, use '--key Enter'.\n\
                     Example: {TYPE_KEY_EXAMPLE}"
                )));
            }
            if text.len() != 1 || !keys.is_empty() {
                return Err(option_error(
                    page,
                    "'--enter' requires a single <TEXT> with no keys. Use '-k Enter' in an input sequence.",
                ));
            }
        }
        if text.is_empty() && keys.is_empty() {
            return Err(example_error(
                page,
                &format!(
                    "Enter text or provide a key to press in {:?}.",
                    target.agent
                ),
                TYPE_TEXT_EXAMPLE,
                "",
            ));
        }
        for segment in &text {
            validate_type_text(page, segment)?;
        }
        if !keys.is_empty() {
            validate_type_keys(page, &keys)?;
        }

        let input = match (text.len(), keys.is_empty()) {
            (1, true) => TerminalInput::Text {
                text: text.pop().expect("single text operand"),
                enter,
            },
            (0, false) => TerminalInput::Keys { keys },
            _ => {
                let text_steps = matches
                    .indices_of("text")
                    .into_iter()
                    .flatten()
                    .zip(text.into_iter().map(|text| InputStep::Text { text }));
                let key_steps = matches
                    .indices_of("keys")
                    .into_iter()
                    .flatten()
                    .zip(keys.into_iter().map(|key| InputStep::Key { key }));
                let mut indexed: Vec<_> = text_steps.chain(key_steps).collect();
                indexed.sort_unstable_by_key(|(index, _)| *index);
                TerminalInput::Sequence {
                    steps: indexed.into_iter().map(|(_, step)| step).collect(),
                }
            }
        };
        if input.typing_bytes().expect("validated text and keys") > MAX_INPUT_BYTES {
            return Err(usage(format!(
                "error: 'facade type' accepts at most {} KiB of input.",
                MAX_INPUT_BYTES / 1024
            )));
        }
        Ok(Command::Type { target, input })
    }
}

fn validate_type_text(page: &Page, text: &str) -> Result<(), ParseError> {
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
    Ok(())
}

fn validate_type_keys(page: &Page, keys: &[String]) -> Result<(), ParseError> {
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
            assert!(
                matches!(
                    parse_from(&words).map(|parsed| parsed.command),
                    Ok(Some(Command::Type {
                        input: TerminalInput::Keys { keys },
                        ..
                    })) if keys == [key]
                ),
                "{key}"
            );
        }
    }

    #[test]
    fn public_machine_selectors_are_checked_before_dispatch() {
        for command in [
            &["start", "--machine", "user@devbox", "codex"][..],
            &["list", "--machine", "user@devbox"],
            &["resume", "--machine", "user@devbox"],
            &["stop", "--machine", "user@devbox"],
            &["machine", "remove", "user@devbox"],
            &["machine", "remove", "--bidirectional", "user@devbox"],
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
