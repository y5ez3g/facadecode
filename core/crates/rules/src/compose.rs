//! The command line that starts or resumes a run's CLI, put together in order from the rule's own
//! arguments, YOLO's, what gives the CLI Facade's tools and has it report its session, and the
//! person's words.

use std::collections::BTreeMap;
use std::path::Path;

use serde_json::json;

use crate::Rule;
use crate::formats::merge_settings;
use crate::wiring::{self, Hooked, MergedSettings, Server, SessionReport, Tools, Wiring};

/// The command line of a run's CLI.
#[derive(Debug, PartialEq, Eq)]
pub struct CommandLine {
    /// The program, then its arguments.
    pub command: Vec<String>,
    /// The variables the session-start hook and Facade's tools need, set after the rule's own
    /// changes to the environment.
    pub env: Vec<(String, String)>,
    /// The CLI reports its session to the run's session file.
    pub captures: bool,
    /// The files the run's folder holds for the CLI: each name and its text.
    pub files: Vec<(String, String)>,
    /// The files of the plugin the CLI reads in [`crate::PLUGIN_FOLDER`] of the folder it starts
    /// in, each name and its text. They are written there before it starts and shared by the runs
    /// there.
    pub plugin: Vec<(String, String)>,
    /// How the CLI was given Facade's tools.
    pub tools: Tools,
}

/// The command line that starts `rule`'s CLI, in order: the program, the rule's arguments, YOLO's,
/// the arguments that give Facade's tools, those that carry what the tools and YOLO add to the
/// CLI's own settings, those that have the CLI report its session, then the person's `words`.
///
/// An option of the tools' that takes every value up to the next option never comes right before
/// the person's words, which it would take as its own: options that take one value each follow it,
/// or else it goes after the person's words, before a `--` of theirs.
///
/// `session` is where the CLI reports its session, None to start without; `server` is Facade's MCP
/// server for the run, None to start without the tools; `yolo` is the folder of a run with YOLO on,
/// None for YOLO off, which adds nothing. `environment` is the CLI's own environment.
pub fn start_command_line(
    rule: &Rule,
    words: &[String],
    session: Option<&SessionReport>,
    server: Option<&Server>,
    environment: &BTreeMap<String, String>,
    yolo: Option<&Path>,
) -> CommandLine {
    let (mut wiring, tools) = wire(rule, server, environment, yolo);
    let reports =
        session.is_some_and(|session| wiring::report_session(&rule.cli, &mut wiring, session));
    let hooked = hook(rule, words, session, &wiring, environment);
    let mut command = rule_args(rule, yolo);
    let (hook_args, rest) = (hooked.args, hooked.rest);
    let MergedSettings {
        args: merged,
        mut rest,
    } = merge(rule, &wiring, rest, server, session, yolo, environment);
    // A CLI that reports its session through its settings reports it only where they merged.
    let captures = hooked.reported || (reports && !merged.is_empty());
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
    command.extend(rest);
    CommandLine {
        command,
        env: [hooked.env, wiring.env].concat(),
        captures,
        files: [wiring.files, hooked.files].concat(),
        plugin: wiring.plugin,
        tools,
    }
}

/// The command line that resumes session `id` of `rule`'s CLI, in order: the program, the resume
/// arguments, the rule's arguments, YOLO's, the arguments that have the CLI report its session,
/// those that give Facade's tools and carry what the tools and YOLO add to its settings, then the
/// person's `words`: those of its entry as it is now (CONFIGURATION-3.4), which join Facade's
/// hooks and settings as a start's do. The rest is as for [`start_command_line`]. None for a rule
/// that does not resume sessions.
pub fn resume_command_line(
    rule: &Rule,
    id: &str,
    words: &[String],
    session: Option<&SessionReport>,
    server: Option<&Server>,
    environment: &BTreeMap<String, String>,
    yolo: Option<&Path>,
) -> Option<CommandLine> {
    let resume = rule.resume_args(id)?;
    let (mut wiring, tools) = wire(rule, server, environment, yolo);
    let reports =
        session.is_some_and(|session| wiring::report_session(&rule.cli, &mut wiring, session));
    let mut command = vec![rule.program.clone()];
    command.extend(resume);
    command.extend(rule_args(rule, yolo).into_iter().skip(1));
    let hooked = hook(rule, words, session, &wiring, environment);
    command.extend(hooked.args);
    let MergedSettings {
        args: merged,
        mut rest,
    } = merge(
        rule,
        &wiring,
        hooked.rest,
        server,
        session,
        yolo,
        environment,
    );
    let captures = hooked.reported || (reports && !merged.is_empty());
    let after_words = wiring.takes_values_to_next_option && merged.is_empty();
    place_tool_args(rule, &mut command, &mut rest, &mut wiring, after_words);
    command.extend(merged);
    command.extend(rest);
    Some(CommandLine {
        command,
        env: [hooked.env, wiring.env].concat(),
        captures,
        files: [wiring.files, hooked.files].concat(),
        plugin: wiring.plugin,
        tools,
    })
}

/// Facade's tools for the run, as `server` gives them, with what YOLO adds to the run's settings
/// merged into theirs. Without a server, no tools.
fn wire(
    rule: &Rule,
    server: Option<&Server>,
    environment: &BTreeMap<String, String>,
    yolo: Option<&Path>,
) -> (Wiring, Tools) {
    let given = server.map(|server| wiring::wire(&rule.cli, server, environment));
    let (mut wiring, tools) = match given {
        Some(Ok(Some(wiring))) => (wiring, Tools::Injected),
        Some(Err(reason)) => (Wiring::default(), Tools::NotGiven(reason)),
        Some(Ok(None)) | None => (Wiring::default(), Tools::NotInjected),
    };
    if let Some(settings) = yolo.and_then(|folder| rule.yolo.settings(folder)) {
        merge_settings(wiring.settings.get_or_insert_with(|| json!({})), &settings);
    }
    (wiring, tools)
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

/// The program, the rule's own arguments, and YOLO's where it is on.
fn rule_args(rule: &Rule, yolo: Option<&Path>) -> Vec<String> {
    let mut command = vec![rule.program.clone()];
    command.extend(rule.launch.args.iter().cloned());
    command.extend(
        yolo.map(|folder| rule.yolo.args(folder))
            .unwrap_or_default(),
    );
    command
}

/// The arguments that carry the tools' and YOLO's settings merged with the person's, and the
/// person's words left. The settings are read in the run's folder: the server's, else the
/// session's, else YOLO's.
fn merge(
    rule: &Rule,
    wiring: &Wiring,
    words: Vec<String>,
    server: Option<&Server>,
    session: Option<&SessionReport>,
    yolo: Option<&Path>,
    environment: &BTreeMap<String, String>,
) -> MergedSettings {
    let cwd = server
        .map(|server| server.cwd)
        .or(session.map(|session| session.cwd))
        .or(yolo);
    match cwd {
        Some(cwd) => wiring::merged_settings(rule, wiring, words, cwd, environment),
        None => MergedSettings {
            args: Vec::new(),
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

#[cfg(test)]
mod session_tests;
#[cfg(test)]
mod tools_tests;
