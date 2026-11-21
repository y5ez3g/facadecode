//! What a run's command line is made of, before runs prepares it: its configured CLI entry
//! (rule, program, arguments and environment) and whether that CLI can start in the folder.
//!
//! The paths a program is found by are `facade_base::programs`; what a CLI adds to its command line
//! and environment is `facade_rules`.

use std::collections::BTreeMap;
use std::path::Path;

use crate::operations::StartRequest;
use facade_base::model::agent::{CliInfo, Overrides};
use facade_base::model::error::{ErrorBody, Reason};
use facade_base::settings::Settings;
use facade_rules::Rule;
use facade_rules::entries::{self, Entry, LaunchOptions};

use crate::{Daemon, blocking_in_place};

/// The settings file, read for a start or a resume: its problems refuse either.
pub(crate) fn read_settings() -> Result<Settings, ErrorBody> {
    blocking_in_place(facade_base::settings::read)
        .map_err(|problems| ErrorBody::new(Reason::InvalidSettings, problems))
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
    /// The CLI its agent records: the configured entry's name.
    pub(crate) cli: String,
    /// The rule it runs by: its entry's type's; none for a program.
    pub(crate) rule: Option<&'static Rule>,
    /// The settings file entry that supplies this CLI.
    entry: Entry,
    /// The program its entry names in place of its rule's, once found where it starts
    /// ([`Configured::find_program`]).
    pub(crate) program: Option<String>,
    pub(crate) options: LaunchOptions,
    /// The start's environment with its entry's `env` over it.
    pub(crate) env: BTreeMap<String, String>,
}

/// Selects the configured CLI for a start. Unknown entries get the choices available here.
pub(crate) fn configure(
    settings: &Settings,
    args: &StartRequest,
    folder: &str,
    by_model: bool,
) -> Result<Configured, ErrorBody> {
    let entries = entries::read(settings);
    let folder = Path::new(folder);
    let entry = entries::select(&entries, &args.cli, folder, &args.env).map_err(|error| {
        let available = available_clis(&entries, &args.env, folder);
        let mut error = with_available_clis(error, &available);
        if error.data.reason == Reason::NotFound && error.data.entry.is_none() {
            error.data.available_clis = available;
        }
        error
    })?;
    let (model, effort) = (args.model.as_deref(), args.effort.as_deref());
    if let Some(asked) = entry.refused_choice(model, effort) {
        return Err(refused_choice(entry.display_name(), asked, by_model));
    }
    let options = entry.launch_options(model, effort, &args.args)?;
    Ok(Configured {
        cli: entry.name.clone(),
        rule: entry.kind.and_then(|kind| kind.rule()),
        entry: entry.clone(),
        program: None,
        options,
        env: entry.environment(&args.env),
    })
}

fn available_clis(entries: &[Entry], env: &BTreeMap<String, String>, folder: &Path) -> Vec<String> {
    blocking_in_place(|| {
        entries
            .iter()
            .filter(|entry| entry.enabled && entry.problems_with(env).is_empty())
            .filter(|entry| {
                entry
                    .resolve_program(folder, &entry.environment(env))
                    .is_ok()
            })
            .map(|entry| entry.name.clone())
            .collect()
    })
}

fn with_available_clis(mut error: ErrorBody, available: &[String]) -> ErrorBody {
    let available = if available.is_empty() {
        "none".into()
    } else {
        available.join(", ")
    };
    error
        .message
        .push_str(&format!("\nAvailable CLIs: {available}."));
    error
}

impl Configured {
    /// Finds its entry's own program from `cwd`, the folder it starts in, once that folder is made
    /// (a worktree it asks for: CONFIGURATION-2.2). Refuses the start where the program its entry
    /// or its type names cannot run there (CONFIGURATION-4.1).
    pub(crate) fn find_program(
        &mut self,
        cwd: &str,
        settings: &Settings,
        env: &BTreeMap<String, String>,
    ) -> Result<(), ErrorBody> {
        let program = blocking_in_place(|| self.entry.resolve_program(Path::new(cwd), &self.env))
            .map_err(|error| {
            with_available_clis(
                error,
                &available_clis(&entries::read(settings), env, Path::new(cwd)),
            )
        })?;
        self.program = Some(program.to_string_lossy().into_owned());
        Ok(())
    }
}

/// Checks session support before the configured CLI starts.
pub(crate) fn check_session(configured: &Configured, session: &str) -> Result<(), ErrorBody> {
    match configured.rule {
        Some(rule) if rule.resume_args(session).is_some() => Ok(()),
        _ => {
            let message = format!("{} does not resume sessions", configured.cli);
            Err(ErrorBody::new(Reason::Unsupported, message))
        }
    }
}

/// `error`, which `entry` caused, naming the entry, such as `claude`.
fn by_entry(mut error: ErrorBody, entry: &Entry) -> ErrorBody {
    error.data.entry = Some(entry.name.clone());
    error
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
    saved: LaunchOptions,
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
    entries::select(&all, cli, Path::new(cwd), env)?;
    let env = entry.environment(env);
    let program = blocking_in_place(|| entry.resolve_program(Path::new(cwd), &env))?;
    let runs_now = entry.kind.and_then(|kind| kind.rule());
    if runs_now.is_none_or(|now| now.cli != rule.cli) {
        let now = runs_now.map_or("a program", |now| now.display_name.as_str());
        let message = format!(
            "{} runs {now} now, but this conversation is {}'s; it cannot be resumed with it",
            entry.setting, rule.display_name
        );
        return Err(by_entry(
            ErrorBody::new(Reason::Unsupported, message),
            entry,
        ));
    }
    let (has_model, has_effort) = rule.choices.chosen_in(&rule.arguments, &saved.args);
    let mut words = rule.choices.args(
        saved.model.as_deref().filter(|_| !has_model),
        saved.effort.as_deref().filter(|_| !has_effort),
    );
    words.extend(saved.args);
    Ok(Resumed {
        words,
        program: Some(program.to_string_lossy().into_owned()),
        env,
    })
}

/// `text` quoted as a problem quotes it: a JSON string.
fn quoted(text: &str) -> String {
    serde_json::to_string(text).expect("a string is JSON")
}

/// The environment a creator's CLI started with, `read` from its process, less the wiring its
/// the rule added, so one CLI's settings never reach another's. The caller read the running
/// process by its keeper-verified identity.
pub(crate) fn creator_environment(
    read: Option<BTreeMap<String, String>>,
    rule: Option<&Rule>,
) -> Result<BTreeMap<String, String>, &'static str> {
    let Some(mut env) = read else {
        return Err("its CLI is not running");
    };
    env.retain(|name, _| !name.eq_ignore_ascii_case("FACADE_AGENT"));
    if let Some(rule) = rule {
        rule.remove_wiring_environment(&mut env);
    }
    Ok(env)
}

/// The CLIs a start can run in a window; or, where the settings file is wrong as a whole, none and
/// its problems.
#[derive(Default)]
struct Clis {
    rows: Vec<CliInfo>,
    settings_problem: Option<String>,
}

impl Daemon {
    pub(crate) async fn cli_list(
        &self,
        folder: Option<String>,
        environment: BTreeMap<String, String>,
    ) -> Result<facade_base::model::machine::CliListResult, ErrorBody> {
        let (environment, folder) = self.launch_context(folder, environment).await?;
        let clis = clis_from(&Ok(environment), &folder);
        Ok(facade_base::model::machine::CliListResult {
            clis: clis.rows,
            settings_problem: clis.settings_problem,
        })
    }

    /// Carries the initiating environment on local starts and queries. An absent folder or
    /// environment uses the login defaults of the machine that will run the CLI.
    pub(crate) async fn launch_context(
        &self,
        folder: Option<String>,
        environment: BTreeMap<String, String>,
    ) -> Result<(BTreeMap<String, String>, String), ErrorBody> {
        if let Some(folder) = folder.as_ref().filter(|_| !environment.is_empty()) {
            return Ok((environment, folder.clone()));
        }
        let (login, home) = self.login_environment().await?;
        let environment = if environment.is_empty() {
            login
        } else {
            environment
        };
        Ok((environment, folder.unwrap_or(home)))
    }

    pub(crate) async fn login_environment(
        &self,
    ) -> Result<(BTreeMap<String, String>, String), ErrorBody> {
        let env = facade_base::system::login_environment(std::time::Duration::from_secs(3))
            .await
            .map_err(|error| {
                ErrorBody::new(
                    Reason::Unavailable,
                    format!("could not read this machine's login environment: {error:#}"),
                )
            })?;
        let home = facade_base::system::home_folder_in(&env)
            .and_then(|path| path.into_os_string().into_string().ok())
            .ok_or_else(|| {
                ErrorBody::new(
                    Reason::Unavailable,
                    "this machine's login environment has no user home folder",
                )
            })?;
        Ok((env, home))
    }
}

/// The CLIs a start with `environment` can run in `folder` (CONFIGURATION-4.1): the settings
/// file's, built-ins then those it adds, without those turned off that are right there. Each says
/// whether it can start there, else why not: what is wrong with its entry, or that its program
/// cannot run there. A settings file wrong as a whole lists none, and its problems, which stand
/// for every start, are said once.
fn clis_from(environment: &Result<BTreeMap<String, String>, ErrorBody>, folder: &str) -> Clis {
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
            let checked = cli_problem(entry, environment, folder)?;
            // A built-in CLI whose own program is not found where it would start.
            let not_installed = entry.built_in
                && entry.program.is_none()
                && checked
                    .as_ref()
                    .is_err_and(|error| error.data.reason == Reason::NotFound);
            Some(CliInfo {
                cli: entry.name.clone(),
                display_name: entry.display_name().to_string(),
                available: checked.is_ok(),
                problem: checked.err().map(|error| error.message),
                not_installed,
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

/// Whether `entry` can start in `folder` for an agent with `environment`, else why not; `None`
/// where it is not listed there. Where the agent's environment cannot be read, what its `env`
/// reads is not known: an entry turned on or with problems says why, and the others are not
/// listed. Only a program not found is `not_found`.
fn cli_problem(
    entry: &Entry,
    environment: &Result<BTreeMap<String, String>, ErrorBody>,
    folder: &str,
) -> Option<Result<(), ErrorBody>> {
    let env = match environment {
        Ok(env) => env,
        Err(error) if entry.enabled || !entry.problems.is_empty() => {
            return Some(Err(ErrorBody::new(
                Reason::Unavailable,
                error.message.clone(),
            )));
        }
        Err(_) => return None,
    };
    if !entry.listed(env) {
        return None;
    }
    let problems = entry.problems_with(env);
    if !problems.is_empty() {
        let message = problems.join("; ");
        return Some(Err(ErrorBody::new(Reason::InvalidSettings, message)));
    }
    let program =
        blocking_in_place(|| entry.resolve_program(Path::new(folder), &entry.environment(env)));
    Some(program.map(|_| ()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A verified run supplies its ordinary environment without relay wiring or old identity.
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
            ["MINE"],
            "the person's own stays and the rule's goes"
        );
        assert_eq!(
            creator_environment(Some(read.clone()), None).unwrap(),
            read.iter()
                .filter(|(name, _)| name.as_str() != "FACADE_AGENT")
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect(),
            "only the legacy identity is removed without a rule"
        );
        let hidden = read
            .into_iter()
            .filter(|(name, _)| name != "FACADE_AGENT")
            .collect();
        assert_eq!(creator_environment(Some(hidden), Some(fake)).unwrap(), env);
        assert_eq!(
            creator_environment(None, Some(fake)),
            Err("its CLI is not running")
        );
    }
}
