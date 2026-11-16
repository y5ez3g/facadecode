//! What a run's command line is made of, before runs prepares it: the settings file's entry its
//! first word names (its rule, program, words and environment) or else the program that word
//! names; whether that entry and program can start in a folder; and the CLIs an agent's windows
//! offer it.
//!
//! The paths a program is found by are `facade_base::programs`; what a CLI adds to its command line
//! and environment is `facade_rules`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use facade_base::daemon::{CliInfo, Overrides, StartArgs, WindowInfo};
use facade_base::jsonrpc::{ErrorBody, Reason};
use facade_base::programs::{on_path, program_of, runnable};
use facade_base::settings::Settings;
use facade_base::system::env_var;
use facade_rules::Rule;
use facade_rules::entries::{self, Entry};

use crate::{Daemon, blocking_in_place};

/// The settings file, read for a start or a resume: its problems refuse either.
pub(crate) fn read_settings() -> Result<Settings, ErrorBody> {
    blocking_in_place(facade_base::settings::read)
        .map_err(|problems| ErrorBody::new(Reason::ConfigurationInvalid, problems))
}

/// The settings file's `names`, for an agent named outside a start: a guest, or an agent renamed
/// to a blank name (LIFECYCLE-2.1). A file that cannot be read gives none, and the built-in names
/// stand in.
pub(crate) fn settings_names() -> Option<Vec<String>> {
    blocking_in_place(facade_base::settings::read)
        .ok()
        .and_then(|settings| settings.names)
}

/// What a start runs (CONFIGURATION-2, 3).
pub(crate) struct Configured {
    /// The CLI its agent records: its entry's name, or the program's file name.
    pub(crate) cli: String,
    /// The rule it runs by: its entry's type's; none for a program.
    pub(crate) rule: Option<&'static Rule>,
    /// Its settings file entry; none for a program started by its path or name.
    pub(crate) entry: Option<Entry>,
    /// The program its entry names in place of its rule's, once found where it starts
    /// ([`Configured::find_program`]).
    pub(crate) program: Option<String>,
    /// The words after the program: its model's and effort's, its entry's `args`, the start's own.
    pub(crate) words: Vec<String>,
    /// The start's environment with its entry's `env` over it.
    pub(crate) env: BTreeMap<String, String>,
}

/// What start `args` runs by `settings`, read once for it (CONFIGURATION-2, 3, 4.1), as far as
/// its folder does not decide it. A start from an MCP tool, `by_model`, must name an entry, and is
/// refused in its tool's words.
pub(crate) fn configure(
    settings: &Settings,
    args: &StartArgs,
    by_model: bool,
) -> Result<Configured, ErrorBody> {
    let all = entries::read(settings);
    match entries::find(&all, &args.command[0]) {
        Some(entry) => configure_entry(entry, args, by_model),
        None if by_model => Err(no_such_cli(&all, args)),
        None => configure_program(args, by_model),
    }
}

/// A start of `entry`. What is wrong with it in the start's environment refuses it, then its
/// being turned off, then a model or effort its CLI takes none of.
fn configure_entry(
    entry: &Entry,
    args: &StartArgs,
    by_model: bool,
) -> Result<Configured, ErrorBody> {
    let (model, effort) = (args.model.as_deref(), args.effort.as_deref());
    check_entry(entry, &args.env)?;
    if let Some(asked) = entry.refused_choice(model, effort) {
        return Err(refused_choice(entry.display_name(), asked, by_model));
    }
    let own = &args.command[1..];
    Ok(Configured {
        cli: entry.name.clone(),
        rule: entry.kind.and_then(|kind| kind.rule()),
        entry: Some(entry.clone()),
        program: None,
        words: [
            entry.choices(model, effort, own),
            entry.args.clone(),
            own.to_vec(),
        ]
        .concat(),
        env: entry.environment(&args.env),
    })
}

/// A start of the program the first word names, by its path or name: it takes no model or effort.
fn configure_program(args: &StartArgs, by_model: bool) -> Result<Configured, ErrorBody> {
    let cli = program_name(&args.command[0]);
    let asked = [("model", &args.model), ("effort", &args.effort)]
        .into_iter()
        .find_map(|(asked, chosen)| chosen.as_ref().map(|_| asked));
    if let Some(asked) = asked {
        return Err(refused_choice(&cli, asked, by_model));
    }
    Ok(Configured {
        cli,
        rule: None,
        entry: None,
        program: None,
        words: args.command[1..].to_vec(),
        env: args.env.clone(),
    })
}

/// An MCP tool's start names a CLI no entry has: say which ones it could name there.
fn no_such_cli(all: &[Entry], args: &StartArgs) -> ErrorBody {
    let listed: Vec<&str> = all
        .iter()
        .filter(|entry| entry.listed(&args.env))
        .map(|entry| entry.name.as_str())
        .collect();
    let listed = match listed.is_empty() {
        true => "none".to_string(),
        false => listed.join(", "),
    };
    let message = format!(
        "No CLI {} is configured at {}; the CLIs there are {listed}.",
        quoted(&args.command[0]),
        args.cwd
    );
    ErrorBody::new(Reason::NotFound, message)
}

/// The name of the program `command` names, as a person calls it: its file name, without the
/// extension that makes it runnable on Windows; `command` itself where it names no file.
fn program_name(command: &str) -> String {
    match facade_base::programs::program_name(Path::new(command)) {
        name if name.is_empty() => command.to_string(),
        name => name,
    }
}

impl Configured {
    /// Finds its entry's own program from `cwd`, the folder it starts in, once that folder is made
    /// (a worktree it asks for: CONFIGURATION-2.2). Refuses the start where the program its entry
    /// or its type names cannot run there (CONFIGURATION-4.1).
    pub(crate) fn find_program(&mut self, cwd: &str) -> Result<(), ErrorBody> {
        let Some(entry) = &self.entry else {
            return Ok(());
        };
        blocking_in_place(|| entry_program(entry, &self.env, cwd))?;
        let command = entry.command.as_deref();
        self.program = command.map(|command| program_of(command, &self.env, cwd));
        Ok(())
    }
}

/// Refuses `asked`, a `model` or `effort`, that `cli` takes none of (CLIS-1.4): in the MCP tool's
/// words for a start `by_model`, else in a command's.
fn refused_choice(cli: &str, asked: &str, by_model: bool) -> ErrorBody {
    let message = if by_model {
        format!("{cli} takes no explicit {asked}; leave `{asked}` out to use its default.")
    } else {
        let what = match asked {
            "model" => "a model",
            _ => "an effort",
        };
        format!("{cli} has no supported way to set {what}; omit {asked} to use its own default")
    };
    ErrorBody::new(Reason::Unsupported, message)
}

/// Refuses a start of `entry` with environment `env` that its settings stop (CONFIGURATION-2.2,
/// 4.1): what is wrong with it first, else its `enabled` turning it off. Its running agents go
/// on.
pub(crate) fn check_entry(entry: &Entry, env: &BTreeMap<String, String>) -> Result<(), ErrorBody> {
    let problems = entry.problems_with(env);
    if !problems.is_empty() {
        return Err(ErrorBody::new(
            Reason::ConfigurationInvalid,
            problems.join("; "),
        ));
    }
    if entry.enabled {
        return Ok(());
    }
    let message = format!(
        "{} is turned off by {}.enabled",
        entry.display_name(),
        entry.setting
    );
    Err(ErrorBody::new(Reason::Unavailable, message))
}

/// The program `entry` runs in `folder` with the environment `env` it starts with (CLIS-1.2,
/// CONFIGURATION-2.2): its `command`, else its type's program on the `PATH`. Else why none can
/// run there: `not_found`, in its setting's words, as `list_agents`, a start and a resume all say
/// it (CONFIGURATION-4.1), or `unavailable` for a folder that is not there.
pub(crate) fn entry_program(
    entry: &Entry,
    env: &BTreeMap<String, String>,
    folder: &str,
) -> Result<PathBuf, ErrorBody> {
    let at = Path::new(folder);
    if !at.is_dir() {
        let message = format!("the folder {folder} is not available");
        return Err(ErrorBody::new(Reason::Unavailable, message));
    }
    let (path, setting) = (env_var(env, "PATH"), &entry.setting);
    let found = match entry.command.as_deref() {
        // A path: `~`, relative or absolute, with either separator where the system has two.
        Some(command)
            if command.contains('/')
                || command.contains(std::path::MAIN_SEPARATOR)
                || command == "~" =>
        {
            let file = PathBuf::from(program_of(command, env, folder));
            match runnable(&file) {
                true => Ok(file),
                false => Err(format!(
                    "{setting}.command is {}, and {} is not a program that can be run",
                    quoted(command),
                    file.display()
                )),
            }
        }
        Some(command) => on_path(command, path, at).ok_or_else(|| {
            format!(
                "{setting}.command is {}, which was not found on the PATH of a terminal in \
                 {folder}",
                quoted(command)
            )
        }),
        None => {
            let rule = entry.kind.and_then(|kind| kind.rule());
            let program = rule.map_or("", |rule| rule.program.as_str());
            on_path(program, path, at).ok_or_else(|| {
                format!(
                    "{program} was not found on the PATH of a terminal in {folder}, and \
                     {setting}.command does not name its location"
                )
            })
        }
    };
    found.map_err(|problem| ErrorBody::new(Reason::NotFound, problem))
}

/// What a resume runs (CONFIGURATION-3.4): the entry `cli` names in `settings` as they are now,
/// which must still run `rule`'s CLI, with its words and program found from `cwd` in the
/// environment `env` its entry gives.
pub(crate) struct Resumed {
    pub(crate) words: Vec<String>,
    pub(crate) program: Option<String>,
    pub(crate) env: BTreeMap<String, String>,
}

/// The entry an agent of `rule`, that ran entry `cli`, resumes with in `cwd` and environment
/// `env`: refused where the entry is gone, its settings stop it, its program cannot run there,
/// or it runs another CLI now. A resume takes no model or effort of its own.
pub(crate) fn resume_entry(
    settings: &Settings,
    rule: &'static Rule,
    cli: &str,
    cwd: &str,
    env: &BTreeMap<String, String>,
) -> Result<Resumed, ErrorBody> {
    let all = entries::read(settings);
    let Some(entry) = entries::find(&all, cli) else {
        let file = facade_base::settings::settings_file()
            .map(|file| facade_base::settings::shown(&file))
            .unwrap_or_default();
        let message = format!(
            "{} is no longer in clis of {file}, so this conversation cannot be resumed with it.",
            quoted(cli)
        );
        return Err(ErrorBody::new(Reason::Unavailable, message));
    };
    check_entry(entry, env)?;
    let env = entry.environment(env);
    blocking_in_place(|| entry_program(entry, &env, cwd))?;
    let runs_now = entry.kind.and_then(|kind| kind.rule());
    if runs_now.is_none_or(|now| now.cli != rule.cli) {
        let now = runs_now.map_or("a program", |now| now.display_name.as_str());
        let message = format!(
            "{} runs {now} now, but this conversation is {}'s; it cannot be resumed with it",
            entry.setting, rule.display_name
        );
        return Err(ErrorBody::new(Reason::Unsupported, message));
    }
    let words = [entry.choices(None, None, &[]), entry.args.clone()].concat();
    let program = entry
        .command
        .as_deref()
        .map(|command| program_of(command, &env, cwd));
    Ok(Resumed {
        words,
        program,
        env,
    })
}

/// `text` quoted as a problem quotes it: a JSON string.
fn quoted(text: &str) -> String {
    serde_json::to_string(text).expect("a string is JSON")
}

/// Refuses a start's `prompt` that cannot go as a message, or that goes to `program`, started by
/// its path or name, whose input Facade does not read. A `custom` entry's program takes it and
/// fails it as `unsupported` (CONFIGURATION-2.3).
pub(crate) fn check_start_prompt(
    prompt: &str,
    configured: &Configured,
    program: &str,
) -> Result<(), ErrorBody> {
    if let Err(why) = facade_base::daemon::check_message_text(prompt) {
        let message = format!("the prompt cannot go as a message: {why}");
        return Err(ErrorBody::invalid_argument(message));
    }
    if configured.rule.is_some() || configured.entry.is_some() {
        return Ok(());
    }
    Err(ErrorBody::invalid_argument(format!(
        "only a CLI of facade.json takes a prompt, as Facade reads its input to send it; \
         {program} is not one"
    )))
}

/// The environment a creator's CLI started with, `read` from its process, less the wiring its
/// `rule` added, so one CLI's settings never reach another's. Else why it cannot be had: nothing
/// read means the CLI is not running; a read without the `FACADE_AGENT` Facade set is one the
/// system keeps hidden, as macOS does for its own programs.
pub(crate) fn creator_environment(
    read: Option<BTreeMap<String, String>>,
    rule: Option<&Rule>,
) -> Result<BTreeMap<String, String>, &'static str> {
    let Some(mut env) = read else {
        return Err("its CLI is not running");
    };
    if !env.contains_key("FACADE_AGENT") {
        return Err("the system keeps it hidden");
    }
    if let Some(rule) = rule {
        rule.remove_wiring_environment(&mut env);
    }
    Ok(env)
}

/// The CLIs a start by an agent can run, shown in each of its windows; or, where the settings
/// file is wrong as a whole, none and its problems.
#[derive(Clone, Debug, Default)]
pub(crate) struct Clis {
    rows: Vec<CliInfo>,
    settings_problem: Option<String>,
}

impl Clis {
    /// Shows them in `window`.
    pub(crate) fn show_in(&self, window: &mut WindowInfo) {
        window.clis = self.rows.clone();
        window.settings_problem = self.settings_problem.clone();
    }
}

impl Daemon {
    /// The CLIs a start by `agent` can run (CONFIGURATION-4.1): the settings file's, built-ins
    /// then those it adds, without those turned off that are right where the agent would start
    /// them. Each says whether it can start there, else why not: what is wrong with its entry, or
    /// that its program cannot run there. A settings file wrong as a whole lists none, and its
    /// problems, which stand for every start, are said once.
    pub(crate) async fn cli_infos(&self, agent: &str) -> Clis {
        let environment = self.environment_of(agent).await;
        let folder = self
            .get_agent(agent)
            .map(|agent| agent.info().cwd)
            .unwrap_or_default();
        let settings = match blocking_in_place(facade_base::settings::read) {
            Ok(settings) => settings,
            Err(problems) => {
                return Clis {
                    rows: Vec::new(),
                    settings_problem: Some(problems),
                };
            }
        };
        let rows = entries::read(&settings)
            .iter()
            .filter_map(|entry| {
                let problem = cli_problem(entry, &environment, &folder)?;
                Some(CliInfo {
                    cli: entry.name.clone(),
                    display_name: entry.display_name().to_string(),
                    available: problem.is_none(),
                    problem,
                    overrides: Overrides {
                        model: entry.takes("model"),
                        effort: entry.takes("effort"),
                    },
                })
            })
            .collect();
        Clis {
            rows,
            settings_problem: None,
        }
    }
}

/// Why `entry` cannot start in `folder` for an agent with `environment`, or `Some(None)` where it
/// can; `None` where it is not listed there. Where the agent's environment cannot be read, what
/// its `env` reads is not known: an entry turned on or with problems says why, and the others are
/// not listed.
fn cli_problem(
    entry: &Entry,
    environment: &Result<BTreeMap<String, String>, ErrorBody>,
    folder: &str,
) -> Option<Option<String>> {
    let env = match environment {
        Ok(env) => env,
        Err(error) if entry.enabled || !entry.problems.is_empty() => {
            return Some(Some(error.message.clone()));
        }
        Err(_) => return None,
    };
    if !entry.listed(env) {
        return None;
    }
    let problems = entry.problems_with(env);
    if !problems.is_empty() {
        return Some(Some(problems.join("; ")));
    }
    let program = blocking_in_place(|| entry_program(entry, &entry.environment(env), folder));
    Some(program.err().map(|error| error.message))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The environment a creator's CLI started with comes without what the CLI's rule added. A
    /// read without the `FACADE_AGENT` Facade set is hidden, and no read means the CLI is not
    /// running.
    #[test]
    fn a_creator_s_environment_comes_without_what_its_rule_added() {
        let fake = facade_rules::find("fake").unwrap().unwrap();
        let read: BTreeMap<String, String> = [
            ("FACADE_AGENT", "a1"),
            ("FAKECLI_MCP", "/opt/facade-mcp"),
            ("FAKECLI_SESSION_HOOK", "/opt/facade hook"),
            ("MINE", "kept"),
        ]
        .into_iter()
        .map(|(name, value)| (name.to_string(), value.to_string()))
        .collect();
        let env = creator_environment(Some(read.clone()), Some(fake)).unwrap();
        assert_eq!(
            env.keys().collect::<Vec<_>>(),
            ["FACADE_AGENT", "MINE"],
            "the person's own stays and the rule's goes"
        );
        assert_eq!(
            creator_environment(Some(read.clone()), None).unwrap(),
            read,
            "a CLI without a rule had nothing added"
        );
        let hidden = read
            .into_iter()
            .filter(|(name, _)| name != "FACADE_AGENT")
            .collect();
        assert_eq!(
            creator_environment(Some(hidden), Some(fake)),
            Err("the system keeps it hidden")
        );
        assert_eq!(
            creator_environment(None, Some(fake)),
            Err("its CLI is not running")
        );
    }
}
