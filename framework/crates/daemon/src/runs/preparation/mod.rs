//! Prepares a run without touching its keeper or actor. Run files, project plugins and session
//! followers each have one owner here; their locks never nest.

mod environment;
mod folder;
mod plugin;
mod projection;
mod session;

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use facade_base::model::error::{ErrorBody, Reason};
use facade_base::programs::{Held, display_command};
use facade_base::start::StartCommand;
use facade_base::system::env_var;
use facade_rules::{CommandLine, ManagedServer, RUN_CREDENTIAL_ARG, Rule};
use tokio::sync::mpsc;
use tokio::time::Instant;

use super::{PreparedRun, RunEvent, RunKind, RunRequest, credential_digest};
use crate::ToolsGiven;

pub(crate) use environment::restore_launch_environment;
pub(crate) use folder::RunFiles;
pub(crate) use plugin::PluginHold;
pub(crate) use session::FirstRead;

/// Owns preparation's folders, plugin references and session followers. Its locks are leaves.
pub(crate) struct Preparation {
    folders: PathBuf,
    held: Arc<Held>,
    plugins: Arc<plugin::Plugins>,
    sessions: session::Sessions,
}

impl Preparation {
    /// Creates preparation for `folders`, with held programs and the daemon's event channel.
    pub(crate) fn new(
        folders: PathBuf,
        held: Arc<Held>,
        events: mpsc::UnboundedSender<RunEvent>,
    ) -> Preparation {
        Self {
            folders,
            plugins: plugin::Plugins::new(held.clone()),
            held,
            sessions: session::Sessions::new(events),
        }
    }

    /// Composes tools, command line and environment and writes a start's private files. Failure
    /// removes a start's folders.
    pub(crate) async fn prepare(
        &self,
        request: RunRequest<'_>,
        managed_instructions: String,
    ) -> Result<PreparedRun, ErrorBody> {
        self.sessions.starting(request.id);
        let start = request.kind == RunKind::Start;
        let id = request.id.to_owned();
        let prepared = self.compose(request, managed_instructions).await;
        if start && prepared.is_err() {
            self.remove_folders(&id);
        }
        prepared
    }

    async fn compose(
        &self,
        request: RunRequest<'_>,
        managed_instructions: String,
    ) -> Result<PreparedRun, ErrorBody> {
        let home = facade_base::paths::facade_home().map_err(ErrorBody::internal)?;
        let mut env = environment::build(request.inherited.clone(), request.cwd, &home, request.id);
        let Some(rule) = request.rule else {
            let launch = StartCommand {
                program: request.program.unwrap_or(request.plain_program).to_owned(),
                args: request.words.to_vec(),
                folder: request.cwd.to_owned(),
            };
            let launch = started_directly(None, launch, &env).await;
            return Ok(PreparedRun {
                launch_command: shown_command(&launch, &env, None),
                launch,
                env,
                captures: false,
                tools: ToolsGiven::NotInjected,
                plugin: None,
                files: RunFiles::default(),
                rule: None,
                kind: request.kind,
                credential_digest: None,
            });
        };
        let mut files = RunFiles::new(&self.folders, request.id);
        let facade = self.held.facade_launcher();
        let session_file = folder::session_file(files.path());
        let report = facade_rules::SessionReport {
            facade: &facade.to_string_lossy(),
            file: &session_file,
            cwd: Path::new(request.cwd),
        };
        let captures = request.session.is_some()
            || rule.session.capture == facade_rules::Capture::SessionStart;
        let report = captures.then_some(&report);
        let credential_args = [RUN_CREDENTIAL_ARG.to_owned(), new_credential()];
        let [_, credential] = &credential_args;
        let mcp = self.held.facade_mcp();
        let server_env = [
            ("FACADE_AGENT".to_owned(), request.id.to_owned()),
            (
                "FACADE_HOME".to_owned(),
                home.to_string_lossy().into_owned(),
            ),
        ];
        let server = facade_rules::Server {
            program: &mcp.to_string_lossy(),
            env: &server_env,
            folder: files.path(),
            instructions: &managed_instructions,
            cwd: Path::new(request.cwd),
            facade: &facade.to_string_lossy(),
        };
        let managed_server = ManagedServer {
            server,
            args: &credential_args,
        };
        let compose = |give_tools: bool| {
            let server = give_tools.then_some(&managed_server);
            match request.session {
                Some(session) => facade_rules::resume_managed_launch_command(
                    rule,
                    session,
                    request.words,
                    report,
                    server,
                    &env,
                    request.policy,
                ),
                None => Some(facade_rules::start_managed_launch_command(
                    rule,
                    request.words,
                    report,
                    server,
                    &env,
                    request.policy,
                )),
            }
        };
        let mut command_line = with_tools(&mcp, compose(true)).ok_or_else(|| {
            ErrorBody::new(
                Reason::Unavailable,
                format!("{} sessions cannot be resumed", rule.cli),
            )
        })?;
        if request.kind == RunKind::Start && !command_line.plugin.is_empty() {
            let (noted, cwd) = (files.clone(), PathBuf::from(request.cwd));
            file_work(move || noted.note_plugin(&cwd)).await?;
        }
        let plugin = if command_line.plugin.is_empty() {
            None
        } else {
            let (plugins, cwd, contents) = (
                self.plugins.clone(),
                PathBuf::from(request.cwd),
                command_line.plugin.clone(),
            );
            let placed = tokio::task::spawn_blocking(move || plugins.hold(&cwd, &contents))
                .await
                .unwrap_or_else(|error| Err(format!("the plugin could not be placed: {error}")));
            match placed {
                Ok(hold) => {
                    command_line.uses_run_credential &= hold.installed;
                    Some(hold)
                }
                Err(why) => {
                    command_line = compose(false)
                        .expect("a command line that already composed still composes");
                    command_line.tools = facade_rules::Tools::NotGiven(why);
                    None
                }
            }
        };
        let credential_digest = (command_line.uses_run_credential
            && command_line.tools == facade_rules::Tools::Injected)
            .then(|| credential_digest(credential));
        let CommandLine {
            command,
            env: added,
            launch_env,
            captures,
            files: contents,
            config_links,
            workspace_file,
            tools,
            ..
        } = command_line;
        environment::apply(&mut env, added, launch_env);
        let mut launch = StartCommand::from_words(command, request.cwd.to_owned());
        if let Some(program) = request.program {
            launch.program = program.to_owned();
        }
        // A chosen saved session belongs to this run until the CLI reports a change.
        let session = match request.session {
            Some(session) => Some(Some(session)),
            None => captures.then_some(None),
        };
        let create = captures
            || !contents.is_empty()
            || !config_links.is_empty()
            || workspace_file.is_some();
        files.fill(session, contents, config_links);
        if let Some((relative, contents)) = workspace_file {
            files.project(projection::Projection {
                workspace: PathBuf::from(request.cwd),
                relative,
                contents,
            });
        }
        if request.kind == RunKind::Start && create {
            let created = files.clone();
            file_work(move || created.create()).await?;
        }
        let launch = started_directly(Some(rule), launch, &env).await;
        let launch_command = shown_command(&launch, &env, Some(credential));
        let tools = match tools {
            facade_rules::Tools::Injected => ToolsGiven::Injected,
            facade_rules::Tools::NotInjected => ToolsGiven::NotInjected,
            facade_rules::Tools::NotGiven(why) => {
                facade_base::log::write(
                    "daemon",
                    "warn",
                    &format!(
                        "#{}'s CLI was not given Facade Code Framework's tools: {why}",
                        request.id
                    ),
                );
                ToolsGiven::NotGiven
            }
        };
        Ok(PreparedRun {
            launch,
            launch_command,
            env,
            captures,
            tools,
            plugin,
            files,
            rule: Some(rule),
            kind: request.kind,
            credential_digest,
        })
    }

    /// Retires earlier run folders before writing a resume's files. Blocking; takes no lock.
    pub(crate) fn replace_folders(
        &self,
        id: &str,
        prepared: &PreparedRun,
    ) -> Result<(), ErrorBody> {
        folder::remove(&self.folders, id).map_err(ErrorBody::internal)?;
        prepared.files.create().map_err(ErrorBody::internal)
    }

    /// Records a run's plugin reference, under the plugin lock.
    pub(crate) fn plugin_used(&self, id: &str, rule: Option<&str>, cwd: &Path) {
        self.plugins.used(id, rule, cwd);
    }

    /// Drops a run's plugin reference and removes the unused plugin where it remains ours.
    /// Blocking file work holds only the plugin lock.
    pub(crate) fn plugin_released(&self, id: &str) {
        self.plugins.released(id);
    }

    /// Retires a failed resume's workspace projection while keeping its session report.
    pub(crate) fn retire_projection(&self, id: &str) {
        if let Some(run) = folder::find(&self.folders, id) {
            folder::retire_projection(&run);
        }
    }

    /// Removes an agent's private folders, logging a failure. Blocking; takes no lock.
    pub(crate) fn remove_folders(&self, id: &str) {
        if let Err(error) = folder::remove(&self.folders, id) {
            facade_base::log::write(
                "daemon",
                "warn",
                &format!("could not delete the run folders of {id}: {error}"),
            );
        }
    }

    /// Deletes unrecorded run folders and retains their plugin notes for recovery cleanup.
    /// Blocking file work precedes taking the plugin lock.
    pub(crate) fn delete_folders_without_records(&self, kept: &HashSet<String>) {
        match folder::discard_unrecorded(&self.folders, kept) {
            Ok(projects) => self.plugins.note_unrecorded(projects),
            Err(error) => facade_base::log::write(
                "daemon",
                "warn",
                &format!("could not delete run folders without records: {error:#}"),
            ),
        }
    }

    /// Cleans plugins no recovered run uses. Blocking, with the plugin lock held during changes.
    pub(crate) fn let_go_of_unused_plugins(&self, agents: Vec<(String, PathBuf)>) {
        self.plugins.unused(agents);
    }

    /// Starts a session follower for this run. Takes only the follower lock; commits go by event.
    pub(crate) fn follow_session(
        &self,
        id: &str,
        run: u64,
        committed: Option<String>,
        output: tokio::sync::watch::Receiver<()>,
        first: FirstRead,
    ) {
        if let Some(folder) = folder::find(&self.folders, id) {
            self.sessions.follow(
                id,
                run,
                folder::session_file(&folder),
                committed,
                output,
                first,
            );
        }
    }

    /// Wakes the follower for its final read, or keeps the exit for a follower installed later.
    pub(crate) fn run_ended(&self, id: &str) {
        self.sessions.ended(id);
    }

    /// Waits for the follower through `deadline`, restoring it on timeout. No lock across await.
    pub(crate) async fn session_followed(&self, id: &str, deadline: Instant) -> bool {
        self.sessions.followed(id, deadline).await
    }

    /// Waits for and removes the follower before deleting an agent. No lock across await.
    pub(crate) async fn end_session_following(&self, id: &str) {
        self.sessions.end_following(id).await;
    }

    /// Returns the current run's session report path even if the report is absent.
    pub(super) fn session_report_path(&self, id: &str) -> Option<PathBuf> {
        let folder = folder::find(&self.folders, id)?;
        Some(folder::session_file(&folder))
    }

    /// Reads the current run's reported session once, logging an unreadable file once per read.
    pub(crate) async fn read_session(&self, id: &str) -> Option<Option<String>> {
        let folder = folder::find(&self.folders, id)?;
        session::read(id, folder::session_file(&folder), &mut false).await
    }

    /// A nonempty, valid report reads as no session only until the CLI saves its session.
    pub(crate) async fn has_unsaved_session(&self, id: &str) -> bool {
        let Some(folder) = folder::find(&self.folders, id) else {
            return false;
        };
        let file = folder::session_file(&folder);
        tokio::task::spawn_blocking(move || {
            std::fs::metadata(&file).is_ok_and(|metadata| metadata.len() > 0)
                && facade_rules::read_session_file(&file) == facade_rules::SessionFile::NoSession
        })
        .await
        .unwrap_or(false)
    }

    /// Whether exactly one run folder holds a session report file. Blocking; takes no lock.
    pub(crate) fn captures(&self, id: &str) -> bool {
        folder::find(&self.folders, id).is_some_and(|at| folder::session_file(&at).exists())
    }
}

fn shown_command(
    launch: &StartCommand<String>,
    env: &BTreeMap<String, String>,
    credential: Option<&str>,
) -> Option<String> {
    let mut shown = display_command(
        &launch.program,
        &launch.args,
        env,
        Path::new(&launch.folder),
    )?;
    if let Some(credential) = credential {
        shown = shown.replace(credential, "<redacted>");
    }
    Some(shown)
}

fn new_credential() -> String {
    use facade_base::random_u64;

    format!(
        "{:016x}{:016x}{:016x}{:016x}",
        random_u64(),
        random_u64(),
        random_u64(),
        random_u64()
    )
}

fn with_tools(program: &Path, composed: Option<CommandLine>) -> Option<CommandLine> {
    let mut command_line = composed?;
    if command_line.tools == facade_rules::Tools::Injected && !program.is_file() {
        command_line.tools = facade_rules::Tools::NotGiven(format!(
            "there is no facade-mcp at {}",
            program.display()
        ));
    }
    Some(command_line)
}

async fn file_work<T: Send + 'static>(
    work: impl FnOnce() -> anyhow::Result<T> + Send + 'static,
) -> Result<T, ErrorBody> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(ErrorBody::internal)?
        .map_err(ErrorBody::internal)
}

/// Starts a wrapper's program directly where possible, such as npm's shim of a Node script
/// (`facade_rules::direct_command`), found on the run's `PATH` from the launch folder.
async fn started_directly(
    rule: Option<&'static Rule>,
    mut launch: StartCommand<String>,
    env: &BTreeMap<String, String>,
) -> StartCommand<String> {
    let program = launch.program.clone();
    let env = env.clone();
    let cwd = PathBuf::from(&launch.folder);
    let direct = tokio::task::spawn_blocking(move || {
        let path = env_var(&env, "PATH");
        let file = facade_base::programs::on_path(&program, path, &cwd)?;
        let direct = facade_rules::direct_command(rule, &file, &env, &cwd);
        (direct != [file.to_string_lossy()]).then_some(direct)
    })
    .await
    .ok()
    .flatten();
    if let Some(direct) = direct {
        let mut words = direct.into_iter();
        launch.program = words.next().expect("a direct command has a program");
        launch.args.splice(..0, words);
    }
    launch
}
