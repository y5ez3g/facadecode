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
pub mod hook;
pub mod integration;
mod plugin;
mod run_tools;
mod servers;
mod session_report;
mod settings;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use facade_base::skill::text_v3;
use serde_json::Value;

use crate::{ManagedServer, RUN_CREDENTIAL_ARG, Rule};

pub use plugin::{
    PLUGIN_FOLDER, PLUGIN_MEMBERS, plugin_files, plugin_files_v3, plugin_version,
    uses_folder_plugin,
};
pub use session_report::SessionReport;
pub(crate) use session_report::{Hooked, install_hook};

/// Where a folder of Facade's holds its skill: a run's own folder, the plugin Claude Code loads for
/// a run, and Antigravity's plugin.
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

/// Whether the session-start hook also gives the model Facade's skill.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum SessionSkill {
    #[default]
    Omit,
    Include,
}

/// What giving a run's CLI the tools adds to its command line.
#[derive(Default, PartialEq, Eq)]
pub(crate) struct Wiring {
    pub(crate) args: Vec<String>,
    pub(crate) env: Vec<(String, String)>,
    /// Files in the run's folder: each name and its text.
    pub(crate) files: Vec<(String, String)>,
    /// What the run adds to the CLI's settings: Claude Code's and Antigravity's `--settings`.
    pub(crate) settings: Option<Value>,
    /// Its options take every value up to the next option, as Claude Code's `--mcp-config` and
    /// `--allowedTools` do, so the person's words never come right after them.
    pub(crate) takes_values_to_next_option: bool,
    /// What the CLI's own hooks run for the run, each an event and its command: Muse Code's
    /// `-c hooks=`.
    pub(crate) hooks: Vec<(String, String)>,
    /// The files of the plugin the CLI reads in [`PLUGIN_FOLDER`] of the folder it starts in,
    /// shared by the runs there: each name and its text. Antigravity's.
    pub(crate) plugin: Vec<(String, String)>,
    /// The Facade program and session file for Antigravity's title command.
    pub(crate) title: Option<(String, PathBuf)>,
    /// The session-start hook that reports the run's session also gives the model the skill, as
    /// Codex has no place of the run's own for one.
    session_skill: SessionSkill,
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

/// What gives `cli` Facade's tools for a run, as `server` says, reading what `environment`, the
/// CLI's own environment, holds of its configuration. None for a CLI whose rule does not give them;
/// an error says why they cannot be given. Reads files; does not wait otherwise.
pub(crate) fn wire(
    cli: &str,
    server: &Server,
    environment: &BTreeMap<String, String>,
) -> Result<Option<Wiring>, String> {
    if let Some(why) = conflicts::persons_server(cli, server.cwd, environment, false) {
        return Err(why);
    }
    let wiring = match cli {
        "claude" => run_tools::claude(server),
        "codex" => run_tools::codex(server)?,
        "opencode" => run_tools::opencode(server, environment)?,
        "pi" => run_tools::pi(server),
        "muse" => run_tools::muse(server, environment)?,
        "agy" => run_tools::agy(server),
        "fake" => run_tools::fake(server),
        _ => return Ok(None),
    };
    Ok(Some(wiring))
}

/// Gives the run's CLI the managed relay entry, or keeps an existing entry where the CLI uses it.
pub(crate) fn wire_managed(
    cli: &str,
    managed: &ManagedServer<'_>,
    environment: &BTreeMap<String, String>,
) -> Result<Option<ManagedWiring>, String> {
    let server = &managed.server;
    let pi_configured = cli == "pi" && conflicts::pi_has_server(server.cwd, environment)?;
    if !pi_configured
        && let Some(why) = conflicts::persons_server(cli, server.cwd, environment, true)
    {
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
        "claude" => (
            run_tools::claude_run(server, &entry, text_v3()),
            uses_credential,
        ),
        "codex" => (run_tools::codex_run(&entry, text_v3())?, uses_credential),
        "opencode" => (
            run_tools::opencode_run(server, &entry, environment, text_v3(), true)?,
            uses_credential,
        ),
        "pi" => {
            let name = if pi_configured {
                conflicts::PI_MANAGED_SERVER
            } else {
                servers::SERVER
            };
            (
                run_tools::pi_run(server, &entry, name, text_v3()),
                uses_credential,
            )
        }
        "muse" => {
            let configured = conflicts::muse_config(server.cwd, environment, true)?;
            let entry = (!configured).then_some(&entry);
            (
                run_tools::muse_run(server, entry, text_v3()),
                uses_credential && !configured,
            )
        }
        "agy" => (run_tools::agy_managed(server, credential), uses_credential),
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

/// Has `cli` report its session through the settings `wiring` merges with the person's: a
/// session-start hook in Muse Code's `-c hooks=`, and the title command of Antigravity's
/// `--settings`, which it runs with the conversation it shows. Whether `cli` reports it so;
/// [`merged_settings`] then says whether those settings could be merged.
pub(crate) fn report_session(cli: &str, wiring: &mut Wiring, session: &SessionReport) -> bool {
    match cli {
        "muse" => wiring.hooks.push((
            "SessionStart".into(),
            session.hook("muse", SessionSkill::Omit),
        )),
        "agy" => wiring.title = Some((session.facade.into(), session.file.into())),
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
    let merged = match rule.cli.as_str() {
        "agy" if wiring.settings.is_some() || wiring.title.is_some() => folder.and_then(|folder| {
            settings::agy_settings(grammar, wiring, &words, cwd, folder, environment)
        }),
        "muse" if !wiring.hooks.is_empty() => {
            settings::muse_hooks(grammar, &wiring.hooks, &words, environment)
        }
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
}

/// Whether Facade can have `cli` report its session.
pub(crate) fn reports_sessions(cli: &str) -> bool {
    ["claude", "codex", "agy", "muse", "opencode", "pi", "fake"].contains(&cli)
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
