//! Selecting saved sessions and resuming a single agent on the machine that owns it.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use facade_base::address::selector::{AgentAddress, AgentKey, parse_agent_address};
use facade_base::api_v1::{
    NoArgs, Operation, Size,
    daemon::{self as wire, Caller},
};
use facade_base::model::agent::{HowEnded, ManagedAgent, is_session_id};
use facade_base::model::{
    agent::SessionMatch,
    machine::{MachineQueryResult, MachineState},
};
use facade_base::process::ProcessState;
use facade_base::start::LaunchColors;
use facade_base::{
    jsonrpc::decode_arguments,
    model::error::{ErrorBody, Reason},
};
use facade_base::{model::agent::AgentRef, model::machine::MachineQueryStatus};
use facade_rules::{LaunchOrigin, Rule, SavedSession, entries};
use tokio::sync::OnceCell;
use tokio::task::JoinSet;
use tokio::time::Instant;

use crate::agent::AgentHandle;
use crate::api;
use crate::network_operations::{LIST_DEADLINE, machine_query_result, require_person};
use crate::operations::{RestartRequest, StartOrigin, StartRequest};
use crate::records::{self, OperationTarget, Reach};
use crate::service::{
    check_size, launch_environment, sender_from, shell_launch_colors, shell_unattended, value_of,
};
use crate::{Daemon, blocking_in_place, command_line};

#[derive(Default)]
pub(crate) struct ResumeFilter {
    pub(crate) folder: Option<String>,
    pub(crate) all: bool,
}

type LoginEnvironment = (BTreeMap<String, String>, String);
type ResumeLogin = OnceCell<Result<LoginEnvironment, ErrorBody>>;

struct ResumeSelector {
    reference: String,
    machine: Option<String>,
    folder: Option<String>,
}

struct ResumeRequest {
    target: ResumeSelector,
    machine_id: Option<String>,
    env: BTreeMap<String, String>,
    colors: Option<LaunchColors>,
    unattended: bool,
    cols: u16,
    rows: u16,
}

#[derive(Clone)]
pub(crate) struct ResumeCandidate {
    address: String,
    cli: String,
    folder: String,
    machine_id: String,
    session: String,
    session_selector: Option<String>,
    agent: Option<AgentRef>,
    name: Option<String>,
    stopped: bool,
    title: Option<String>,
    session_name: Option<String>,
    at: Option<String>,
}

impl ResumeCandidate {
    pub(crate) fn into_wire(self) -> wire::ResumeCandidate {
        let agent = self.agent.as_ref().map(api::wire_ref);
        let target = match &agent {
            Some(reference) => wire::ResumeTarget::Agent {
                reference: reference.clone(),
            },
            None => wire::ResumeTarget::Session {
                machine_id: self.machine_id.clone(),
                cli: self.cli.clone(),
                session: self.session.clone(),
                folder: self.folder.clone(),
            },
        };
        wire::ResumeCandidate {
            target,
            cli: self.cli,
            folder: self.folder,
            machine_id: self.machine_id,
            session: self.session,
            session_selector: self.session_selector,
            agent,
            name: self.name,
            stopped: self.stopped,
            title: self.title,
            session_name: self.session_name,
            at: self.at,
        }
    }

    fn received(candidate: wire::ResumeCandidate) -> Result<Self, ErrorBody> {
        let address = match candidate.target {
            wire::ResumeTarget::Agent { reference } => api::agent_ref(reference).exact_address(),
            wire::ResumeTarget::Session { cli, session, .. } => format!("{cli}:{session}"),
            wire::ResumeTarget::Selector { .. } => {
                return Err(ErrorBody::invalid_argument(
                    "expected an exact resume candidate",
                ));
            }
        };
        Ok(Self {
            address,
            cli: candidate.cli,
            folder: candidate.folder,
            machine_id: candidate.machine_id,
            session: candidate.session,
            session_selector: candidate.session_selector,
            agent: candidate.agent.map(api::agent_ref),
            name: candidate.name,
            stopped: candidate.stopped,
            title: candidate.title,
            session_name: candidate.session_name,
            at: candidate.at,
        })
    }
}

fn received_candidates(value: serde_json::Value) -> Result<Vec<ResumeCandidate>, ErrorBody> {
    decode_arguments::<Vec<wire::ResumeCandidate>>(value)?
        .into_iter()
        .map(ResumeCandidate::received)
        .collect()
}

#[derive(serde::Deserialize)]
struct ResumeListReply {
    items: Vec<wire::ResumeCandidate>,
    machines: Vec<MachineQueryResult>,
}

impl Daemon {
    pub(crate) async fn api_resume_candidates(
        self: &Arc<Self>,
        caller: &Caller,
        request: wire::ResumeListArgs,
        forwarded: bool,
    ) -> Result<wire::ResumeListResult, ErrorBody> {
        require_person(caller)?;
        let scope = request.scope.unwrap_or(wire::Scope::Local);
        let reachable = matches!(scope, wire::Scope::Reachable);
        let machine = match scope {
            wire::Scope::Machine { machine } => Some(machine),
            _ => None,
        };
        if forwarded && (reachable || machine.is_some()) {
            return Err(ErrorBody::invalid_argument(
                "a forwarded resume list needs local scope",
            ));
        }
        let named_records = machine.is_some() && request.folder.is_none();
        let mut args = ResumeFilter {
            folder: request.folder,
            all: named_records || matches!(request.folder_scope, Some(wire::FolderScope::All)),
        };
        let selected = if forwarded {
            None
        } else {
            self.machine_for(machine.as_deref())?
        };
        if let Some(id) = selected.as_ref().filter(|id| *id != &self.machine_id) {
            self.ensure_machine_route(id, caller).await?;
            let (mut items, mut machines) = if named_records {
                let reply = self
                    .network_call::<wire::InternalResumeRecords>(id, caller, NoArgs {}, None)
                    .await?;
                let items = received_candidates(reply)?;
                let machines = self
                    .public_machines()?
                    .into_iter()
                    .filter(|row| row.machine_id == *id)
                    .map(|row| machine_query_result(row, MachineQueryStatus::Answered))
                    .collect();
                (items, machines)
            } else {
                let reply: ResumeListReply = decode_arguments(
                    self.network_call::<wire::AgentResumeList>(
                        id,
                        caller,
                        wire::ResumeListArgs {
                            scope: None,
                            folder: args.folder,
                            folder_scope: args.all.then_some(wire::FolderScope::All),
                        },
                        None,
                    )
                    .await?,
                )?;
                let items = reply
                    .items
                    .into_iter()
                    .map(ResumeCandidate::received)
                    .collect::<Result<Vec<_>, _>>()?;
                (items, reply.machines)
            };
            for item in &mut items {
                self.project_resume_candidate(item, true)?;
            }
            let visible = self.machine_identities()?;
            for row in &mut machines {
                crate::machine_service::project_machine_query(row, &visible);
            }
            return Ok(wire::ResumeListResult {
                items: items.into_iter().map(ResumeCandidate::into_wire).collect(),
                machines: machines.into_iter().map(api::machine_query).collect(),
            });
        }

        let rows = if reachable {
            self.probe_machine_queries(None, caller).await?
        } else {
            self.public_machines()?
                .into_iter()
                .map(|row| machine_query_result(row, MachineQueryStatus::Unavailable))
                .collect()
        };
        if reachable && !args.all && args.folder.is_none() {
            args.folder = Some(self.login_environment().await?.1);
        }
        let mut local = self
            .local_resume_candidates(
                &args,
                !named_records,
                matches!(caller, Caller::Terminal { .. }),
            )
            .await?;
        let mut machines = Vec::new();
        let mut jobs = JoinSet::new();
        for mut row in rows {
            if row.machine_id == self.machine_id {
                row.status = MachineQueryStatus::Answered;
                machines.push(row);
            } else if reachable {
                if row.state != MachineState::Online {
                    machines.push(row);
                    continue;
                }
                let (daemon, caller) = (self.clone(), caller.clone());
                jobs.spawn(async move {
                    let reply = daemon
                        .network_call::<wire::InternalResumeRecords>(
                            &row.machine_id,
                            &caller,
                            NoArgs {},
                            None,
                        )
                        .await
                        .and_then(received_candidates);
                    (row, reply)
                });
            }
        }
        while let Some(task) = jobs.join_next().await {
            let (mut query, result) = task.map_err(ErrorBody::internal)?;
            match result {
                Ok(items) => {
                    query.status = MachineQueryStatus::Answered;
                    for mut item in items.into_iter().filter(|item| {
                        item.machine_id == query.machine_id
                            && (args.all || args.folder.as_deref() == Some(item.folder.as_str()))
                    }) {
                        self.project_resume_candidate(&mut item, true)?;
                        local.push(item);
                    }
                }
                Err(error) => {
                    query.status = crate::network_operations::machine_query_failure(&error);
                    query.error = Some(error.message);
                }
            }
            machines.push(query);
        }
        local.sort_by(|a, b| b.at.cmp(&a.at).then_with(|| a.address.cmp(&b.address)));
        machines.sort_by(|a, b| a.machine_id.cmp(&b.machine_id));
        Ok(wire::ResumeListResult {
            items: local.into_iter().map(ResumeCandidate::into_wire).collect(),
            machines: machines.into_iter().map(api::machine_query).collect(),
        })
    }

    pub(crate) async fn local_resume_candidates(
        self: &Arc<Self>,
        args: &ResumeFilter,
        include_sessions: bool,
        include_labels: bool,
    ) -> Result<Vec<ResumeCandidate>, ErrorBody> {
        let login = ResumeLogin::new();
        let folder = match (&args.folder, include_sessions || !args.all) {
            (Some(folder), _) => Some(PathBuf::from(folder)),
            (None, true) => Some(PathBuf::from(&self.resume_login(&login).await?.1)),
            (None, false) => None,
        };
        if let Some(folder) = &folder
            && (!folder.is_absolute() || !folder.is_dir())
        {
            return Err(ErrorBody::invalid_argument(format!(
                "{} is not an available folder",
                folder.display()
            )));
        }
        let mut items = Vec::new();
        let mut used = BTreeSet::new();
        let label_deadline = Instant::now() + LIST_DEADLINE;
        for agent in self.agents() {
            let info = agent.info();
            let Some(session) = info.session.clone() else {
                continue;
            };
            let Some(rule_name) = agent.rule() else {
                continue;
            };
            used.insert((rule_name.to_owned(), session.clone()));
            if info.process != ProcessState::Ended
                || (!args.all
                    && folder.as_ref().is_some_and(|folder| {
                        facade_base::files::folder_key(folder)
                            != facade_base::files::folder_key(Path::new(&info.cwd))
                    }))
            {
                continue;
            }
            let saved = match facade_rules::find(rule_name).ok().flatten() {
                Some(rule) if rule.session.resume_requires_saved_session => {
                    let Some(saved) = self.native_session(rule, &info, &login).await else {
                        continue;
                    };
                    Some(saved)
                }
                Some(rule) if include_labels && Instant::now() < label_deadline => {
                    tokio::time::timeout_at(
                        label_deadline,
                        self.native_session(rule, &info, &login),
                    )
                    .await
                    .ok()
                    .flatten()
                }
                _ => None,
            };
            let session_name = saved
                .filter(|_| include_labels)
                .and_then(|saved| saved.title);
            let info = self.public_agent(info)?;
            let reference = api::agent_ref(info.reference);
            items.push(ResumeCandidate {
                address: info.address,
                cli: info.cli,
                folder: info.cwd,
                machine_id: self.machine_id.clone(),
                session,
                session_selector: None,
                agent: Some(reference),
                name: Some(info.name),
                stopped: info.state_detail.as_ref().and_then(|detail| detail.how)
                    == Some(HowEnded::Stopped),
                title: info.title,
                session_name,
                at: info.exit.map(|exit| exit.at),
            });
        }
        if let Some(folder) = &folder
            && include_sessions
        {
            let (environment, _) = self.resume_login(&login).await?;
            let sessions = self.saved_candidates(folder, environment.clone(), None)?;
            let mut listed = BTreeSet::new();
            for candidate @ (rule, item) in &sessions {
                let key = (rule.clone(), item.session.clone());
                if !used.contains(&key) && listed.insert(key) {
                    let mut item = item.clone();
                    item.session_selector = Some(saved_session_selector(candidate, &sessions));
                    if !include_labels {
                        item.session_name = None;
                    }
                    self.project_resume_candidate(&mut item, false)?;
                    items.push(item);
                }
            }
        }
        items.sort_by(|a, b| b.at.cmp(&a.at).then_with(|| a.address.cmp(&b.address)));
        Ok(items)
    }

    async fn resume_login<'a>(
        &self,
        login: &'a ResumeLogin,
    ) -> Result<&'a LoginEnvironment, ErrorBody> {
        login
            .get_or_init(|| self.launch_context(None, BTreeMap::new()))
            .await
            .as_ref()
            .map_err(Clone::clone)
    }

    pub(crate) async fn native_session_name(
        self: &Arc<Self>,
        agent: &AgentHandle,
        info: &ManagedAgent,
    ) -> Option<String> {
        let rule = facade_rules::find(agent.rule()?).ok().flatten()?;
        self.native_session(rule, info, &ResumeLogin::new())
            .await?
            .title
    }

    async fn native_session(
        self: &Arc<Self>,
        rule: &'static Rule,
        info: &ManagedAgent,
        login: &ResumeLogin,
    ) -> Option<SavedSession> {
        info.session.as_ref()?;
        let settings = command_line::read_settings().ok();
        let configured = settings.as_ref().map(entries::read).unwrap_or_default();
        let entry = entries::find(&configured, &info.cli);
        let kept = blocking_in_place(|| self.store.launch_details(&info.agent_id)).ok();
        let args = kept
            .and_then(|details| details.options)
            .or_else(|| entry.and_then(|entry| entry.launch_options(None, None, &[]).ok()))
            .map(|options| options.args)
            .unwrap_or_default();
        let environment = if info.process == ProcessState::Running {
            blocking_in_place(|| self.runs.environment_of(&info.agent_id))
                .ok()
                .flatten()?
        } else {
            let (login, _) = self.resume_login(login).await.ok()?;
            match entry {
                Some(entry) => entry.environment(login),
                None => login.clone(),
            }
        };
        let daemon = self.clone();
        let info = info.clone();
        tokio::task::spawn_blocking(move || daemon.saved_session(rule, &info, &environment, &args))
            .await
            .ok()
            .and_then(Result::ok)
            .flatten()
    }

    /// Reads the exact recorded session using the supplied launch choices. Blocking.
    pub(crate) fn saved_session(
        &self,
        rule: &Rule,
        info: &ManagedAgent,
        environment: &BTreeMap<String, String>,
        args: &[String],
    ) -> Result<Option<SavedSession>, ErrorBody> {
        let Some(session) = info.session.as_deref() else {
            return Ok(None);
        };
        let report = self.runs.session_report_path(&info.agent_id);
        facade_rules::session_for_id(
            rule,
            Path::new(&info.cwd),
            environment,
            args,
            session,
            report.as_deref(),
        )
    }

    pub(crate) async fn api_resume(
        self: &Arc<Self>,
        caller: &Caller,
        mut args: wire::ResumeArgs,
        forwarded: bool,
    ) -> Result<wire::ResumeResult, ErrorBody> {
        require_person(caller)?;
        check_size(args.size.cols, args.size.rows)?;
        let colors = shell_launch_colors(caller, args.env.as_mut());
        let unattended = shell_unattended(caller, args.env.as_mut());
        let exact_machine = match &args.target {
            wire::ResumeTarget::Agent { reference } => Some(reference.machine_id.clone()),
            wire::ResumeTarget::Session { machine_id, .. } => Some(machine_id.clone()),
            wire::ResumeTarget::Selector {
                scope: Some(wire::SingleMachineScope::Local),
                ..
            } => Some(self.machine_id.clone()),
            wire::ResumeTarget::Selector { .. } => None,
        };
        if let Some(id) = exact_machine.as_ref().filter(|id| *id != &self.machine_id) {
            if forwarded {
                return Err(ErrorBody::invalid_argument(
                    "a forwarded resume needs this machine",
                ));
            }
            if !crate::network::is_uuid_v4(id) {
                return Err(ErrorBody::invalid_argument(
                    "resume requires a full machine ID",
                ));
            }
            return self
                .forward_resume(
                    id,
                    caller,
                    args.target,
                    args.size,
                    colors.as_ref(),
                    unattended,
                )
                .await;
        }
        let (target, exact_session) = match args.target {
            wire::ResumeTarget::Agent { reference } => {
                let id = reference.agent_id;
                if !matches!(
                    parse_agent_address(&id),
                    Ok(AgentAddress::Local(AgentKey::Number(number))) if number == id
                ) {
                    return Err(ErrorBody::invalid_argument(
                        "resume requires an exact agent ID",
                    ));
                }
                (
                    ResumeSelector {
                        reference: id,
                        machine: None,
                        folder: None,
                    },
                    None,
                )
            }
            wire::ResumeTarget::Session {
                cli,
                session,
                folder,
                ..
            } => {
                if cli.is_empty()
                    || facade_rules::parse_session_id(&session).as_deref() != Some(session.as_str())
                    || !Path::new(&folder).is_absolute()
                {
                    return Err(ErrorBody::invalid_argument(
                        "resume needs a full session ID and an absolute folder",
                    ));
                }
                (
                    ResumeSelector {
                        reference: session.clone(),
                        machine: None,
                        folder: Some(folder),
                    },
                    Some((cli, session)),
                )
            }
            wire::ResumeTarget::Selector {
                selector,
                scope,
                folder,
            } => (
                ResumeSelector {
                    reference: selector,
                    machine: api::single_machine(scope),
                    folder,
                },
                None,
            ),
        };
        self.resume_request(
            caller,
            ResumeRequest {
                target,
                machine_id: exact_machine,
                env: args.env.unwrap_or_default(),
                colors,
                unattended,
                cols: args.size.cols,
                rows: args.size.rows,
            },
            forwarded,
            exact_session,
        )
        .await
    }

    async fn resume_request(
        self: &Arc<Self>,
        caller: &Caller,
        args: ResumeRequest,
        forwarded: bool,
        exact_session: Option<(String, String)>,
    ) -> Result<wire::ResumeResult, ErrorBody> {
        let size = Size {
            cols: args.cols,
            rows: args.rows,
        };
        let selected = match args.machine_id.as_ref() {
            Some(id) => Some(id.clone()),
            None => self.machine_for(args.target.machine.as_deref())?,
        };
        if let Some(id) = selected.as_ref().filter(|id| *id != &self.machine_id) {
            if forwarded {
                return Err(ErrorBody::invalid_argument(
                    "a forwarded resume needs this machine",
                ));
            }
            let target = self.remote_resume_target(caller, id, &args.target).await?;
            return self
                .forward_resume(
                    id,
                    caller,
                    target,
                    size,
                    args.colors.as_ref(),
                    args.unattended,
                )
                .await;
        }

        let input = args
            .target
            .reference
            .trim_matches(facade_base::settings::is_space);
        let agent = if exact_session.is_some() {
            Err(ErrorBody::new(Reason::NotFound, "expected a saved session"))
        } else {
            let syntax = parse_agent_address(input)
                .map_err(|error| ErrorBody::invalid_argument(error.to_string()))?;
            match syntax {
                AgentAddress::Local(AgentKey::Number(number)) if selected.is_some() => {
                    Ok(AgentRef {
                        agent_id: number.into(),
                        machine_id: self.machine_id.clone(),
                    })
                }
                _ if selected.is_some() || forwarded => {
                    let key = self.resume_key(syntax, &self.machine_id)?;
                    let cards = self
                        .agents()
                        .iter()
                        .map(|agent| self.lookup_candidate(agent))
                        .collect::<Result<Vec<_>, _>>()?;
                    records::lookup(key, &Reach::from(caller), OperationTarget::Resume, &cards)
                }
                _ => {
                    self.addressed_agent(
                        caller,
                        wire::AgentTarget::Selector(input.to_owned()),
                        OperationTarget::Resume,
                    )
                    .await
                }
            }
        };
        let session_selector = exact_session
            .as_ref()
            .map(|(cli, id)| (Some(cli.as_str()), id.clone()))
            .or_else(|| session_selector(input, &agent));
        let (candidate, session_env) = if let Some((cli, id)) = &session_selector {
            let folder = args.target.folder.clone().or_else(|| {
                (!forwarded)
                    .then(|| facade_base::system::env_var(&args.env, "PWD").map(str::to_owned))
                    .flatten()
            });
            let (env, folder) = self
                .launch_context(
                    folder,
                    if forwarded {
                        BTreeMap::new()
                    } else {
                        args.env.clone()
                    },
                )
                .await?;
            let path = Path::new(&folder);
            if !path.is_absolute() || !path.is_dir() {
                return Err(ErrorBody::invalid_argument(format!(
                    "{folder} is not an available folder"
                )));
            }
            let candidates = self.saved_candidates(path, env.clone(), *cli)?;
            let matches: Vec<_> =
                matching_sessions(&candidates, id, exact_session.is_none()).collect();
            if matches.len() > 1 {
                let mut error = ErrorBody::new(
                    Reason::AmbiguousReference,
                    format!("{input} names several saved sessions"),
                );
                for (_, item) in matches {
                    error.data.candidates.push(item.address.clone());
                    error.data.sessions.push(session_match(item));
                }
                return Err(error);
            }
            (matches.first().map(|(_, item)| item.clone()), env)
        } else {
            (None, BTreeMap::new())
        };
        let agent = match (agent, candidate) {
            (Ok(agent), Some(session)) => {
                let mut error = ErrorBody::new(
                    Reason::AmbiguousReference,
                    format!("{input} names an agent and a saved session"),
                );
                error.data.sessions.push(session_match(&session));
                error.data.candidates = vec![self.agent_address(&agent)?, session.address];
                return Err(error);
            }
            (Ok(agent), None) => agent,
            (Err(error), Some(session)) if error.data.reason == Reason::NotFound => {
                let origin = StartOrigin {
                    deadline: None,
                    caller: caller.clone(),
                    sender: sender_from(caller, None),
                    launch: LaunchOrigin::Person,
                    unattended: args.unattended,
                };
                let started = self
                    .start_saved_session(
                        StartRequest {
                            cli: session.cli,
                            args: Vec::new(),
                            folder: Some(session.folder),

                            worktree: None,
                            model: None,
                            effort: None,
                            name: None,
                            prompt: None,
                            env: session_env,
                            cols: args.cols,
                            rows: args.rows,
                            colors: args
                                .colors
                                .map(crate::presence::launch_colors)
                                .unwrap_or_default(),
                            call_id: None,
                            result_message_id: None,
                            result_message_machine_id: None,
                            request_id: None,
                        },
                        origin,
                        session.session,
                    )
                    .await?;
                return Ok(wire::ResumeResult {
                    agent: self.public_agent(started.agent)?,
                    from_saved_session: Some(true),
                });
            }
            (Err(error), None)
                if error.data.reason == Reason::NotFound && session_selector.is_some() =>
            {
                return Err(ErrorBody::new(
                    Reason::SessionNotFound,
                    format!("no saved session {input} is in that folder"),
                ));
            }
            (Err(error), _) => return Err(error),
        };
        if agent.machine_id != self.machine_id {
            let target = wire::ResumeTarget::Agent {
                reference: api::wire_ref(&agent),
            };
            return self
                .forward_resume(
                    &agent.machine_id,
                    caller,
                    target,
                    size,
                    args.colors.as_ref(),
                    args.unattended,
                )
                .await;
        }

        let handle = self.local_target(caller, &agent, OperationTarget::Resume)?;
        let (env, _) = self
            .launch_context(
                Some(handle.info().cwd),
                if forwarded { BTreeMap::new() } else { args.env },
            )
            .await?;
        let resumed = self
            .resume(
                &handle,
                RestartRequest {
                    env,
                    unattended: args.unattended,
                    cols: args.cols,
                    rows: args.rows,
                    colors: args.colors.map(crate::presence::launch_colors),
                },
            )
            .await
            .map_err(|error| self.with_agent_error(&handle, error))?;
        Ok(wire::ResumeResult {
            agent: self.public_agent(resumed)?,
            from_saved_session: None,
        })
    }

    fn resume_key<'a>(
        &self,
        address: AgentAddress<'a>,
        machine_id: &str,
    ) -> Result<AgentKey<'a>, ErrorBody> {
        match address {
            AgentAddress::Local(key) => Ok(key),
            AgentAddress::Qualified { agent, machine, .. }
                if self.select_machine(machine)?.machine_id == machine_id =>
            {
                Ok(agent)
            }
            AgentAddress::Qualified { .. } => Err(ErrorBody::invalid_argument(
                "the agent address names a different machine",
            )),
        }
    }

    async fn remote_resume_target(
        self: &Arc<Self>,
        caller: &Caller,
        id: &str,
        selector: &ResumeSelector,
    ) -> Result<wire::ResumeTarget, ErrorBody> {
        let input = selector
            .reference
            .trim_matches(facade_base::settings::is_space);
        let syntax = parse_agent_address(input)
            .map_err(|error| ErrorBody::invalid_argument(error.to_string()))?;
        let agent = match self.resume_key(syntax, id)? {
            AgentKey::Number(agent_id) => Ok(AgentRef {
                agent_id: agent_id.into(),
                machine_id: id.into(),
            }),
            key => {
                let records = self.query_agents(caller, Some(id), false).await?.agents;
                records::lookup(key, &Reach::from(caller), OperationTarget::Resume, &records)
            }
        };
        if let Err(error) = &agent
            && error.data.reason != Reason::NotFound
        {
            return Err(error.clone());
        }
        let Some((cli, session)) = session_selector(input, &agent) else {
            return agent.map(|agent| wire::ResumeTarget::Agent {
                reference: api::wire_ref(&agent),
            });
        };
        if let (Some(cli), Some(folder)) = (cli, selector.folder.as_ref())
            && agent
                .as_ref()
                .is_err_and(|error| error.data.reason == Reason::NotFound)
        {
            return Ok(wire::ResumeTarget::Session {
                machine_id: id.into(),
                cli: cli.into(),
                session,
                folder: folder.clone(),
            });
        }
        let reply: ResumeListReply = decode_arguments(
            self.network_call::<wire::AgentResumeList>(
                id,
                caller,
                wire::ResumeListArgs {
                    scope: None,
                    folder: selector.folder.clone(),
                    folder_scope: None,
                },
                None,
            )
            .await?,
        )?;
        let items = reply
            .items
            .into_iter()
            .map(ResumeCandidate::received)
            .collect::<Result<Vec<_>, _>>()?;
        let mut sessions: Vec<_> = items
            .into_iter()
            .filter(|item| {
                item.machine_id == id
                    && item.agent.is_none()
                    && cli.is_none_or(|cli| cli == item.cli)
                    && matches_session(&item.session, &session)
            })
            .collect();
        if sessions.len() > 1 || (agent.is_ok() && !sessions.is_empty()) {
            let mut error = ErrorBody::new(
                Reason::AmbiguousReference,
                format!("{input} names multiple resume targets"),
            );
            if let Ok(agent) = agent {
                error.data.candidates.push(self.agent_address(&agent)?);
            }
            for session in sessions {
                error.data.sessions.push(session_match(&session));
                error.data.candidates.push(session.address);
            }
            return Err(error);
        }
        if let Some(session) = sessions.pop() {
            return Ok(wire::ResumeTarget::Session {
                machine_id: id.into(),
                cli: session.cli,
                session: session.session,
                folder: session.folder,
            });
        }
        agent
            .map(|agent| wire::ResumeTarget::Agent {
                reference: api::wire_ref(&agent),
            })
            .map_err(|error| {
                if error.data.reason == Reason::NotFound {
                    ErrorBody::new(
                        Reason::SessionNotFound,
                        format!("no saved session {input} is in that folder"),
                    )
                } else {
                    error
                }
            })
    }

    async fn forward_resume(
        &self,
        id: &str,
        caller: &Caller,
        target: wire::ResumeTarget,
        size: Size,
        colors: Option<&LaunchColors>,
        unattended: bool,
    ) -> Result<wire::ResumeResult, ErrorBody> {
        self.ensure_machine_route(id, caller).await?;
        let expected_agent = match &target {
            wire::ResumeTarget::Agent { reference } => Some(reference.agent_id.clone()),
            _ => None,
        };
        let request = wire::ForwardParams {
            route: Vec::new(),
            caller: caller.clone(),
            request: wire::ForwardRequest::Call(wire::CallParams {
                op: wire::AgentResume::NAME.into(),
                args: value_of(wire::ResumeArgs {
                    target,
                    size,
                    env: launch_environment(colors, unattended),
                }),
            }),
            time_left_ms: None,
            from_name: None,
            start_result: None,
        };
        let reply = self.call_peer(id, request, None).await?;
        let mut result: wire::ResumeResult = decode_arguments(reply)?;
        if result.agent.reference.machine_id != id
            || expected_agent.is_some_and(|agent_id| result.agent.reference.agent_id != agent_id)
        {
            return Err(ErrorBody::refused(
                "the machine returned a different resume target",
            ));
        }
        result.agent.address =
            self.agent_address(&api::agent_ref(result.agent.reference.clone()))?;
        result.from_saved_session = result.from_saved_session.filter(|saved| *saved);
        Ok(result)
    }

    fn project_resume_candidate(
        &self,
        item: &mut ResumeCandidate,
        remote: bool,
    ) -> Result<(), ErrorBody> {
        if let Some(agent) = &item.agent {
            item.address = self.agent_address(agent)?;
        } else if remote {
            self.machine_address_part(&item.machine_id)?;
        }
        Ok(())
    }

    fn saved_candidates(
        &self,
        folder: &Path,
        env: BTreeMap<String, String>,
        cli: Option<&str>,
    ) -> Result<Vec<(String, ResumeCandidate)>, ErrorBody> {
        let settings = command_line::read_settings()?;
        let entries = entries::read(&settings);
        blocking_in_place(|| {
            let mut items = Vec::new();
            for entry in entries
                .iter()
                .filter(|entry| cli.is_none_or(|cli| cli == entry.name))
            {
                let Some(rule) = entry.kind.and_then(|kind| kind.rule()) else {
                    continue;
                };
                let effective = entry.environment(&env);
                if !entry.enabled
                    || !entry.problems_with(&env).is_empty()
                    || entry.resolve_program(folder, &effective).is_err()
                {
                    continue;
                }
                let options = entry.launch_options(None, None, &[])?;
                for session in facade_rules::list_sessions(rule, folder, &effective, &options.args)?
                {
                    let folder = session.folder.display().to_string();
                    items.push((
                        rule.cli.clone(),
                        ResumeCandidate {
                            address: format!("{}:{}", entry.name, session.id),
                            cli: entry.name.clone(),
                            machine_id: self.machine_id.clone(),
                            session: session.id,
                            session_selector: None,
                            folder,
                            agent: None,
                            name: None,
                            stopped: false,
                            session_name: session.title.clone(),
                            title: session.title,
                            at: session.modified_at.map(facade_base::time::iso_time),
                        },
                    ));
                }
            }
            Ok(items)
        })
    }
}

fn session_selector<'a>(
    input: &'a str,
    agent: &Result<AgentRef, ErrorBody>,
) -> Option<(Option<&'a str>, String)> {
    if let Some((cli, id)) = input.rsplit_once(':')
        && !cli.is_empty()
        && facade_rules::parse_session_id(id).as_deref() == Some(id)
    {
        return Some((Some(cli), id.to_owned()));
    }
    if !agent
        .as_ref()
        .is_err_and(|error| error.data.reason == Reason::NotFound)
    {
        return None;
    }
    unqualified_session_id(input).map(|id| (None, id))
}

fn unqualified_session_id(input: &str) -> Option<String> {
    facade_rules::parse_session_id(input).or_else(|| {
        (input.len() == 8 && is_session_id(input)).then(|| {
            if input.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                input.to_ascii_lowercase()
            } else {
                input.to_owned()
            }
        })
    })
}

fn saved_session_selector(
    (rule, item): &(String, ResumeCandidate),
    sessions: &[(String, ResumeCandidate)],
) -> String {
    if let Some(prefix) = item.session.get(..8)
        && let Some(query) = unqualified_session_id(prefix)
    {
        let mut matches = matching_sessions(sessions, &query, true);
        if matches.next().is_some_and(|(matched_rule, matched)| {
            matched_rule == rule && matched.session == item.session
        }) && matches.next().is_none()
        {
            return prefix.to_owned();
        }
    }
    item.session.clone()
}

fn matching_sessions<'a>(
    sessions: &'a [(String, ResumeCandidate)],
    query: &'a str,
    allow_prefix: bool,
) -> impl Iterator<Item = &'a (String, ResumeCandidate)> {
    let mut matched = BTreeSet::new();
    sessions.iter().filter(move |(rule, item)| {
        (item.session == query || (allow_prefix && matches_session(&item.session, query)))
            && matched.insert((rule.as_str(), item.session.as_str()))
    })
}

fn matches_session(session: &str, query: &str) -> bool {
    session == query || (query.len() == 8 && session.starts_with(query))
}

fn session_match(candidate: &ResumeCandidate) -> SessionMatch {
    SessionMatch {
        id: candidate.session.clone(),
        cli: candidate.cli.clone(),
        title: candidate.title.clone(),
    }
}
