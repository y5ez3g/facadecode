//! The command line that starts or resumes a run's CLI, put together in order from the rule's own
//! arguments, YOLO's, what gives the CLI Facade's tools and has it report its session, and the
//! person's words.

use std::collections::BTreeMap;
use std::fmt;
use std::path::{Path, PathBuf};

use serde_json::json;

use crate::formats::merge_settings;
use crate::wiring::{self, Hooked, MergedSettings, SessionReport, Tools, Wiring};
use crate::{ManagedServer, Rule};

/// Who requested this launch, including a launch that reopens a native session.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LaunchOrigin {
    Person,
    Agent,
}

/// The initiating origin and the destination's YOLO setting for this run.
#[derive(Clone, Copy, Debug)]
pub struct LaunchPolicy<'a> {
    pub origin: LaunchOrigin,
    /// The launch folder when YOLO is enabled.
    pub yolo: Option<&'a Path>,
}

impl<'a> LaunchPolicy<'a> {
    /// The folder when Facade may handle startup trust and notices for this run.
    pub fn startup_folder(self) -> Option<&'a Path> {
        self.yolo.filter(|_| self.origin == LaunchOrigin::Agent)
    }
}

/// The command line of a run's CLI.
#[derive(PartialEq, Eq)]
pub struct CommandLine {
    /// The program, then its arguments.
    pub command: Vec<String>,
    /// Variables for session reporting and Facade's tools.
    pub env: Vec<(String, String)>,
    /// Run-local updater and startup settings. Their changes are undone on inheritance.
    pub launch_env: BTreeMap<String, String>,
    /// The CLI reports its session to the run's session file.
    pub captures: bool,
    /// The files the run's folder holds for the CLI: each name and its text.
    pub files: Vec<(String, String)>,
    /// Aliases inside the private run folder to the user's existing configuration entries.
    pub config_links: Vec<(PathBuf, PathBuf)>,
    /// The files of the plugin the CLI reads in [`crate::PLUGIN_FOLDER`] of the folder it starts
    /// in, each name and its text. They are written there before it starts and shared by the runs
    /// there.
    pub plugin: Vec<(String, String)>,
    /// A native configuration file named relative to the workspace and owned by this run.
    pub workspace_file: Option<(PathBuf, String)>,
    /// How the CLI was given Facade's tools.
    pub tools: Tools,
    /// A configuration file that names a Facade server, for connection diagnostics.
    pub tools_config: Option<PathBuf>,
    /// The run's credential is present in the relay configuration this command will load.
    pub uses_run_credential: bool,
}

impl fmt::Debug for CommandLine {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        // The run's credential can be in its arguments, environment, or file contents.
        formatter
            .debug_struct("CommandLine")
            .field("captures", &self.captures)
            .field("uses_run_credential", &self.uses_run_credential)
            .finish_non_exhaustive()
    }
}

/// The command line that starts `rule`'s CLI, in order: the program, the rule's arguments, YOLO's,
/// the arguments that give Facade's tools, those that carry what the tools and YOLO add to the
/// CLI's own settings, those that have the CLI report its session, then the person's `words`.
///
/// An option of the tools' that takes every value up to the next option never comes right before
/// the person's words, which it would take as its own: options that take one value each follow it,
/// or else it goes after the person's words, before a `--` of theirs.
///
/// `session` is where the CLI reports its session. `None` skips session reporting.
/// `server` is the managed MCP server for the run. `None` starts without the tools.
/// `policy` gives the launch origin and whether the destination has YOLO on.
/// `environment` is the CLI's own environment.
pub fn start_managed_launch_command(
    rule: &Rule,
    words: &[String],
    session: Option<&SessionReport<'_>>,
    server: Option<&ManagedServer<'_>>,
    environment: &BTreeMap<String, String>,
    policy: LaunchPolicy<'_>,
) -> CommandLine {
    let (mut wiring, launch_env, tools, uses_run_credential) =
        wire(rule, words, session, server, environment, policy, None);
    let reports = wiring::report_session(&rule.cli, &mut wiring, session, server);
    let hooked = hook(rule, words, session, &wiring, environment);
    let mut command = rule_args(rule, policy.yolo);
    let (hook_args, rest) = (hooked.args, hooked.rest);
    let MergedSettings {
        args: merged,
        files: settings_files,
        mut rest,
    } = merge(
        rule,
        &wiring,
        rest,
        server,
        session,
        policy.yolo,
        environment,
    );
    // A CLI that reports its session through its settings reports it only where they merged.
    let captures = wiring.captures || hooked.reported || (reports && !merged.is_empty());
    let after_words = wiring.takes_values_to_next_option && hook_args.is_empty();
    place_tool_args(
        rule,
        &mut command,
        &mut rest,
        &mut wiring,
        after_words && merged.is_empty(),
    );
    command.extend(merged);
    command.extend(hook_args);
    place_startup_args(rule, &mut rest, policy);
    command.extend(rest);
    CommandLine {
        command,
        env: [hooked.env, wiring.env].concat(),
        launch_env,
        captures,
        files: [wiring.files, hooked.files, settings_files].concat(),
        config_links: wiring.config_links,
        plugin: wiring.plugin,
        workspace_file: wiring.workspace_file,
        tools,
        tools_config: wiring.tools_config,
        uses_run_credential,
    }
}

/// The command line that resumes session `id` of `rule`'s CLI, in order: the program, the resume
/// arguments, the rule's arguments, YOLO's, the arguments that have the CLI report its session,
/// those that give Facade's tools and carry what the tools and YOLO add to its settings, then the
/// person's saved `words`, which join Facade's hooks and settings as a start's do.
/// See [`start_managed_launch_command`] for `session`, `server`, `environment` and `policy`.
/// Returns `None` for a rule that does not resume sessions.
pub fn resume_managed_launch_command(
    rule: &Rule,
    id: &str,
    words: &[String],
    session: Option<&SessionReport<'_>>,
    server: Option<&ManagedServer<'_>>,
    environment: &BTreeMap<String, String>,
    policy: LaunchPolicy<'_>,
) -> Option<CommandLine> {
    let resume = rule.resume_args(id)?;
    let (mut wiring, launch_env, tools, uses_run_credential) =
        wire(rule, words, session, server, environment, policy, Some(id));
    let reports = wiring::report_session(&rule.cli, &mut wiring, session, server);
    let mut command = vec![rule.program.clone()];
    command.extend(resume);
    command.extend(rule_args(rule, policy.yolo).into_iter().skip(1));
    let hooked = hook(rule, words, session, &wiring, environment);
    command.extend(hooked.args);
    let MergedSettings {
        args: merged,
        files: settings_files,
        mut rest,
    } = merge(
        rule,
        &wiring,
        hooked.rest,
        server,
        session,
        policy.yolo,
        environment,
    );
    let captures = wiring.captures || hooked.reported || (reports && !merged.is_empty());
    let after_words = wiring.takes_values_to_next_option && merged.is_empty();
    place_tool_args(rule, &mut command, &mut rest, &mut wiring, after_words);
    command.extend(merged);
    place_startup_args(rule, &mut rest, policy);
    command.extend(rest);
    Some(CommandLine {
        command,
        env: [hooked.env, wiring.env].concat(),
        launch_env,
        captures,
        files: [wiring.files, hooked.files, settings_files].concat(),
        config_links: wiring.config_links,
        plugin: wiring.plugin,
        workspace_file: wiring.workspace_file,
        tools,
        tools_config: wiring.tools_config,
        uses_run_credential,
    })
}

/// Facade's tools for the run, as `server` gives them, with what YOLO adds to the run's settings
/// merged into theirs. Without a server, no tools.
fn wire(
    rule: &Rule,
    words: &[String],
    session: Option<&SessionReport<'_>>,
    server: Option<&ManagedServer<'_>>,
    environment: &BTreeMap<String, String>,
    policy: LaunchPolicy<'_>,
    resume: Option<&str>,
) -> (Wiring, BTreeMap<String, String>, Tools, bool) {
    let profile = wiring::native_profile(rule, words, session, server, environment, resume);
    let given = match (server, &profile) {
        (Some(server), Ok(profile)) => {
            wiring::wire_managed(rule, words, server, environment, profile.as_deref())
        }
        (Some(_), Err(reason)) => Err(reason.clone()),
        (None, _) => Ok(None),
    };
    let (mut wiring, tools, uses_run_credential) = match given {
        Ok(Some(output)) => (output.wiring, output.tools, output.uses_run_credential),
        Err(reason) => (Wiring::default(), Tools::NotGiven(reason), false),
        Ok(None) => (Wiring::default(), Tools::NotInjected, false),
    };
    wiring.profile_name = profile.unwrap_or_default();
    let mut launch_env = if policy.origin == LaunchOrigin::Agent {
        rule.launch.agent_env.clone()
    } else {
        BTreeMap::new()
    };
    for (change, folder) in [
        (&rule.yolo.work, policy.yolo),
        (&rule.yolo.startup, policy.startup_folder()),
    ] {
        if let Some(folder) = folder {
            launch_env.extend(change.env.clone());
            if let Some(settings) = change.settings(folder) {
                merge_settings(wiring.settings.get_or_insert_with(|| json!({})), &settings);
            }
        }
    }
    (wiring, launch_env, tools, uses_run_credential)
}

/// What having the CLI report its session through a hook, plugin or extension adds, and the
/// person's words that remain. Nothing where it reports none so.
struct SessionHook {
    args: Vec<String>,
    env: Vec<(String, String)>,
    files: Vec<(String, String)>,
    rest: Vec<String>,
    reported: bool,
}

fn hook(
    rule: &Rule,
    words: &[String],
    session: Option<&SessionReport>,
    wiring: &Wiring,
    environment: &BTreeMap<String, String>,
) -> SessionHook {
    let hooked =
        session.and_then(|session| wiring::install_hook(rule, words, session, wiring, environment));
    match hooked {
        Some(Hooked {
            args,
            env,
            files,
            rest,
        }) => SessionHook {
            args,
            env,
            files,
            rest,
            reported: true,
        },
        None => SessionHook {
            args: Vec::new(),
            env: Vec::new(),
            files: Vec::new(),
            rest: words.to_vec(),
            reported: false,
        },
    }
}

/// The program, the rule's own arguments, and the selected approval mode.
fn rule_args(rule: &Rule, yolo: Option<&Path>) -> Vec<String> {
    let mut command = vec![rule.program.clone()];
    command.extend(rule.launch.args.iter().cloned());
    command.extend(yolo.map_or_else(
        || rule.yolo.off_args.clone(),
        |folder| rule.yolo.work.args(folder),
    ));
    command
}

/// Startup overrides go after the person's options so the run's last value takes precedence.
fn place_startup_args(rule: &Rule, rest: &mut Vec<String>, policy: LaunchPolicy<'_>) {
    if let Some(folder) = policy
        .startup_folder()
        .filter(|_| !rule.yolo.startup.args.is_empty())
    {
        let end = rule.arguments.end_of_options(rest);
        rest.splice(end..end, rule.yolo.startup.args(folder));
    }
}

/// The arguments that carry the tools' and YOLO's settings merged with the person's, the files they
/// name, and the person's words left. The settings are read in the folder the CLI starts in: the
/// server's, else the session's, else YOLO's; their files go in the run's folder, the server's or
/// else the session's.
fn merge(
    rule: &Rule,
    wiring: &Wiring,
    words: Vec<String>,
    server: Option<&ManagedServer<'_>>,
    session: Option<&SessionReport>,
    yolo: Option<&Path>,
    environment: &BTreeMap<String, String>,
) -> MergedSettings {
    let server = server.map(|managed| &managed.server);
    let cwd = server
        .map(|server| server.cwd)
        .or(session.map(|session| session.cwd))
        .or(yolo);
    let folder = server
        .map(|server| server.folder)
        .or(session.map(|session| session.folder()));
    match cwd {
        Some(cwd) => wiring::merged_settings(rule, wiring, words, cwd, folder, environment),
        None => MergedSettings {
            args: Vec::new(),
            files: Vec::new(),
            rest: words,
        },
    }
}

/// Puts the tools' arguments at the end of `command`, or, `after_words`, among the person's words
/// before their `--`: there an option of the tools' that takes every value up to the next option
/// takes none of theirs.
fn place_tool_args(
    rule: &Rule,
    command: &mut Vec<String>,
    rest: &mut Vec<String>,
    wiring: &mut Wiring,
    after_words: bool,
) {
    let tool_args = std::mem::take(&mut wiring.args);
    if after_words {
        let end = rule.arguments.end_of_options(rest);
        rest.splice(end..end, tool_args);
    } else {
        command.extend(tool_args);
    }
}

/// The settings `launch` passes with `--settings`: the text of the run's file it names, else its
/// JSON.
#[cfg(test)]
fn passed_settings(launch: &CommandLine) -> serde_json::Value {
    let at = launch.command.iter().position(|word| word == "--settings");
    let given = &launch.command[at.expect("a --settings argument") + 1];
    let file = launch
        .files
        .iter()
        .find(|(name, _)| Path::new(given).ends_with(name));
    serde_json::from_str(file.map_or(given.as_str(), |(_, text)| text.as_str())).unwrap()
}

#[cfg(test)]
const PERSON: LaunchPolicy<'static> = LaunchPolicy {
    origin: LaunchOrigin::Person,
    yolo: None,
};

#[cfg(test)]
mod session_tests;
#[cfg(test)]
mod tools_tests;
