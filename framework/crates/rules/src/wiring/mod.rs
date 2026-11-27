//! Facade's way into each CLI: what a run's CLI is given to have Facade's tools and report its
//! session, and the formats of Facade's hooks. Each CLI takes them its own way, chosen by rule
//! name. The legacy integration module also describes the entries the old commands wrote.
//!
//! A run's CLI gets `facade-mcp`, Facade's MCP server, in its own configuration for the run alone,
//! or for Antigravity in a plugin of the folder it starts in, shared by the runs there; with its
//! tools approved in advance where the CLI can approve one server's. A managed relay entry carries
//! the run credential in its server arguments and uses `FACADE_HOME` to find the daemon. A relay
//! without a credential can prove its session to the daemon where the CLI supplies that evidence.

mod config_files;
mod conflicts;
mod copilot;
mod cursor;
mod devin;
pub mod hook;
pub mod integration;
mod kiro;
mod omp;
mod plugin;
mod qoder;
mod run_tools;
mod servers;
mod session_report;
mod settings;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::{ManagedServer, RUN_CREDENTIAL_ARG, Rule};

pub(crate) use devin::user_dir as devin_config_dir;
pub use plugin::{PLUGIN_FOLDER, PLUGIN_MEMBERS, plugin_files, plugin_version, uses_folder_plugin};
pub use session_report::SessionReport;
pub(crate) use session_report::{Hooked, install_hook};

/// The old skill path, still recognized in Antigravity plugins and inherited OpenCode settings.
pub const SKILL_FILE: &str = "skills/facade/SKILL.md";
/// Where a run's own folder holds its instructions, for a CLI that takes them from a hook: Muse
/// Code's and Antigravity's.
pub const INSTRUCTIONS_FILE: &str = "instructions.md";
/// OpenCode's inline configuration, which a start may carry.
const OPENCODE_CONFIG: &str = "OPENCODE_CONFIG_CONTENT";

/// Facade's MCP server as a run's CLI is given it.
#[derive(Clone, Copy, Debug)]
pub struct Server<'a> {
    /// The `facade-mcp` program.
    pub program: &'a str,
    /// The run's `FACADE_AGENT` and `FACADE_HOME`.
    pub env: &'a [(String, String)],
    /// The run's own folder, where its files go.
    pub folder: &'a Path,
    /// What the model is told of Facade's tools, for a CLI that shows its model no server's
    /// instructions.
    pub instructions: &'a str,
    /// The folder the run's CLI starts in, whose project files it reads.
    pub cwd: &'a Path,
    /// `facade`, whose `hook instructions` gives the instructions to a CLI that shows its model no
    /// server's instructions and has no other place for them.
    pub facade: &'a str,
}

impl Server<'_> {
    fn hook_variables(&self) -> impl Iterator<Item = (&str, &str)> {
        self.env
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str()))
    }
}

/// How a run's CLI was given Facade's tools.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Tools {
    /// Not given: the CLI's rule does not give them.
    NotInjected,
    /// Given: the CLI starts the server.
    Injected,
    /// Its rule gives them, but Facade could not, for this reason.
    NotGiven(String),
}

/// What giving a run's CLI the tools adds to its command line.
#[derive(Default, PartialEq, Eq)]
pub(crate) struct Wiring {
    pub(crate) args: Vec<String>,
    pub(crate) env: Vec<(String, String)>,
    pub(crate) tools_config: Option<PathBuf>,
    /// Files in the run's folder: each name and its text.
    pub(crate) files: Vec<(String, String)>,
    /// A relative alias and the existing user configuration entry it points to.
    pub(crate) config_links: Vec<(PathBuf, PathBuf)>,
    /// The CLI settings the run supplies as an overlay or a run-scoped replacement.
    pub(crate) settings: Option<Value>,
    /// Its options take every value up to the next option, as Claude Code's `--mcp-config` and
    /// `--allowedTools` do, so the person's words never come right after them.
    pub(crate) takes_values_to_next_option: bool,
    /// The run's own hook commands, keyed by event.
    pub(crate) hooks: Vec<(String, String)>,
    /// The files of the plugin the CLI reads in [`PLUGIN_FOLDER`] of the folder it starts in,
    /// shared by the runs there: each name and its text. Antigravity's.
    pub(crate) plugin: Vec<(String, String)>,
    /// The Facade program and session file for Antigravity's title command.
    pub(crate) title: Option<(String, PathBuf)>,
    /// The CLI reads a session reporter from a configuration supplied through `args`.
    pub(crate) captures: bool,
    /// A managed native profile has a name that a resumed session can retain.
    pub(crate) profile_name: Option<String>,
    /// One native configuration file read from the workspace, named relative to its root.
    pub(crate) workspace_file: Option<(PathBuf, String)>,
}

/// The managed run's wiring and how it gets Facade's tools.
pub(crate) struct ManagedWiring {
    pub(crate) wiring: Wiring,
    pub(crate) tools: Tools,
    /// This wiring puts the current run's credential in a relay entry.
    pub(crate) uses_run_credential: bool,
}

/// The arguments that carry the run's additions to the CLI's settings, merged with the person's
/// own, the files in the run's folder they name, and the person's words without their own such
/// arguments.
pub(crate) struct MergedSettings {
    pub(crate) args: Vec<String>,
    /// Files in the run's folder: each name and its text.
    pub(crate) files: Vec<(String, String)>,
    pub(crate) rest: Vec<String>,
}

/// Gives the run's CLI the managed relay entry, or keeps an existing entry where the CLI uses it.
/// Reads the CLI's configuration using its environment. Returns None for a CLI whose rule does
/// not give the tools, or an error explaining why the tools could not be given.
pub(crate) fn wire_managed(
    rule: &Rule,
    words: &[String],
    managed: &ManagedServer<'_>,
    environment: &BTreeMap<String, String>,
    profile: Option<&str>,
) -> Result<Option<ManagedWiring>, String> {
    let cli = rule.cli.as_str();
    let server = &managed.server;
    let pi_configured = cli == "pi" && conflicts::pi_has_server(server.cwd, environment)?;
    if !pi_configured && let Some(why) = conflicts::persons_server(cli, server.cwd, environment) {
        return Err(why);
    }
    let env: Vec<_> = server
        .env
        .iter()
        .filter(|(name, _)| name == "FACADE_HOME")
        .cloned()
        .collect();
    let entry = servers::Entry {
        program: server.program,
        args: managed.args.to_vec(),
        env: &env,
    };
    let credential = match managed.args {
        [flag, value] if flag == RUN_CREDENTIAL_ARG && !value.is_empty() => Some(value.as_str()),
        _ => None,
    };
    let uses_credential = credential.is_some();
    let (wiring, uses_run_credential) = match cli {
        "claude" => (run_tools::claude_run(server, &entry), uses_credential),
        "codex" => (run_tools::codex_run(&entry)?, uses_credential),
        "opencode" => (
            run_tools::opencode_run(&entry, environment)?,
            uses_credential,
        ),
        "pi" => {
            let name = if pi_configured {
                conflicts::PI_MANAGED_SERVER
            } else {
                servers::SERVER
            };
            (run_tools::pi_run(server, &entry, name), uses_credential)
        }
        "muse" => {
            let configured = conflicts::muse_config(server.cwd, environment)?;
            let inject = configured.is_none();
            let mut wiring = run_tools::muse_run(server, inject.then_some(&entry));
            wiring.tools_config = configured;
            (wiring, uses_credential && inject)
        }
        "agy" => (run_tools::agy_managed(server, credential), uses_credential),
        "copilot" => (copilot::tools(&entry), uses_credential),
        "devin" => (devin::tools(server, &entry, environment)?, uses_credential),
        "agent" => (cursor::tools(server, &entry), uses_credential),
        "kiro-cli" => {
            let name = profile.ok_or("Kiro's managed profile could not be selected")?;
            (kiro::tools(name, server, &entry), uses_credential)
        }
        "qoder" => (
            qoder::tools(rule, words, server, &entry, environment)?,
            uses_credential,
        ),
        "omp" => (omp::tools(server, &entry), uses_credential),
        #[cfg(debug_assertions)]
        "fake" => (run_tools::fake_run(server, &entry), uses_credential),
        _ => return Ok(None),
    };
    Ok(Some(ManagedWiring {
        wiring,
        tools: Tools::Injected,
        uses_run_credential,
    }))
}

pub(crate) fn native_profile(
    rule: &Rule,
    words: &[String],
    session: Option<&SessionReport<'_>>,
    server: Option<&ManagedServer<'_>>,
    environment: &BTreeMap<String, String>,
    resume: Option<&str>,
) -> Result<Option<String>, String> {
    if rule.cli != "kiro-cli" {
        return Ok(None);
    }
    let location = server
        .map(|managed| (managed.server.folder, managed.server.cwd))
        .or_else(|| session.map(|session| (session.folder(), session.cwd)));
    location
        .map(|(folder, cwd)| kiro::selected_profile(rule, words, folder, cwd, environment, resume))
        .transpose()
}

/// Adds a session reporter to the CLI's native configuration. Returns whether the rule uses this
/// route. The configuration must be supplied in the launch before the reporter can run.
pub(crate) fn report_session(
    cli: &str,
    wiring: &mut Wiring,
    session: Option<&SessionReport<'_>>,
    server: Option<&ManagedServer<'_>>,
) -> bool {
    if cli == "kiro-cli"
        && let Some(name) = wiring.profile_name.take()
    {
        let native_server = server.map(|managed| &managed.server);
        let folder = session
            .map(SessionReport::folder)
            .or_else(|| native_server.map(|server| server.folder));
        if let Some(folder) = folder {
            kiro::profile(wiring, folder, name, session, native_server);
        }
        return false;
    }
    let Some(session) = session else {
        return false;
    };
    match cli {
        "muse" => {
            let variables = server
                .into_iter()
                .flat_map(|managed| managed.server.hook_variables());
            let command = session.hook(cli, variables);
            wiring.hooks.push(("SessionStart".into(), command));
        }
        "agy" => wiring.title = Some((session.facade.into(), session.file.into())),
        "devin" => {
            let command = session.hook("devin", []);
            wiring.hooks.push(("SessionStart".into(), command));
        }
        "agent" => cursor::report(wiring, session, server.map(|server| &server.server)),
        "copilot" => copilot::report(wiring, session),
        _ => return false,
    }
    true
}

/// The arguments that carry what `wiring` adds to the CLI's own settings, merged with the
/// person's, and the person's `words` left. Antigravity's `--settings` replaces the person's
/// settings key by key for the session, so the permission rules they keep go in it beside
/// Facade's; Muse Code's `-c hooks=` replaces the hooks of its settings, so their own hooks go in
/// it before Facade's. `cwd` is the folder the CLI starts in, `folder` the run's own, without
/// which Antigravity's are not merged. Settings Facade cannot read are left
/// as they are, for the CLI to say what is wrong with them, and nothing is added to them.
pub(crate) fn merged_settings(
    rule: &Rule,
    wiring: &Wiring,
    words: Vec<String>,
    cwd: &Path,
    folder: Option<&Path>,
    environment: &BTreeMap<String, String>,
) -> MergedSettings {
    let grammar = &rule.arguments;
    if rule.cli == "copilot"
        && let Some(folder) = folder
    {
        return copilot::settings(rule, wiring, words, folder);
    }
    let merged = match rule.cli.as_str() {
        "agy" if wiring.settings.is_some() || wiring.title.is_some() => folder.and_then(|folder| {
            settings::agy_settings(grammar, wiring, &words, cwd, folder, environment)
        }),
        "muse" if !wiring.hooks.is_empty() => {
            settings::muse_hooks(grammar, &wiring.hooks, &words, environment)
        }
        "devin" if wiring.settings.is_some() || !wiring.hooks.is_empty() => {
            folder.and_then(|folder| devin::settings(wiring, &words, cwd, folder, environment))
        }
        "omp" => folder.map(|folder| omp::settings(rule, wiring, &words, folder)),
        _ => None,
    };
    merged.unwrap_or(MergedSettings {
        args: Vec::new(),
        files: Vec::new(),
        rest: words,
    })
}

/// Takes out of `env`, the environment a run of `cli` started with, everything the run added to
/// give it Facade's tools and have it report its session, so that a CLI started with what is left
/// is no part of the run.
pub(crate) fn remove_wiring_environment(cli: &str, env: &mut BTreeMap<String, String>) {
    session_report::unhook(cli, env);
    run_tools::unwire(cli, env);
    if cli == "devin" {
        restore_config_environment(env);
    }
}

/// Restores the caller's configuration directory before another client uses its environment.
pub fn restore_config_environment(env: &mut BTreeMap<String, String>) {
    devin::restore_config_home(env);
}

/// Whether Facade can have `cli` report its session.
pub(crate) fn reports_sessions(cli: &str) -> bool {
    [
        "claude", "codex", "agy", "muse", "opencode", "pi", "devin", "agent", "kiro-cli", "qoder",
        "omp", "copilot", "fake",
    ]
    .contains(&cli)
}

/// Whether a Facade run of `cli` starts Facade's guest entry, the server the person's
/// configuration names, for its own session: Muse Code's and Antigravity's runs do. Every other
/// CLI's run has a server of its own in the guest entry's place, or its guest extension steps aside
/// in the run's own session, so a guest entry of theirs serves only sessions that are no run's,
/// those nested in a run included.
pub fn runs_start_guest_entry(cli: &str) -> bool {
    cli == "muse" || cli == "agy"
}

/// Whether Facade's guest entry of `cli` serves a Facade run's own session, where the run starts
/// it: Muse Code refuses a run's own `facade` server beside the one in its settings, so there the
/// guest entry is the run's server, and the run adds none. Antigravity's guest entry steps aside
/// beside its plugin's server. Either way one Facade server serves the run's agent.
pub fn guest_entry_serves_run(cli: &str) -> bool {
    cli == "muse"
}

/// Whether a guest's session of `cli` ends with the CLI's process that ran its hooks, for a CLI
/// with no hook for a session's end: Antigravity. The session is still known by its own ID.
pub fn session_ends_with_process(cli: &str) -> bool {
    cli == "agy"
}
