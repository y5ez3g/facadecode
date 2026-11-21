//! Selecting saved sessions and resuming a single agent on the machine that owns it.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use facade_base::daemon::{AgentResumeArgs, HowEnded, is_session_id};
use facade_base::jsonrpc::{ErrorBody, Reason, decode_arguments};
use facade_base::machine::{AgentRef, MachineQueryStatus};
use facade_base::operations::Operation;
use facade_base::process::ProcessState;
use facade_base::v3::{
    self, Caller, ResumeArgs, ResumeCandidate, ResumeListArgs, ResumeListResult, ResumeResult,
    ResumeTarget, SessionMatch,
};
use facade_rules::entries;
use tokio::task::JoinSet;

use crate::network_operations::{machine_query_result, require_person};
use crate::operations::StartOrigin;
use crate::records::{self, OperationTarget, Reach};
use crate::service::{check_size, sender_from, value_of};
use crate::{Daemon, blocking_in_place, command_line};

pub(crate) const RESUME_RECORDS: &str = "machine.resume_records";

pub(crate) enum ResumeListOrigin {
    CandidateShell,
    Local,
    Forwarded,
}

impl Daemon {
    pub(crate) async fn resume_candidates(
        self: &Arc<Self>,
        caller: &Caller,
        mut args: ResumeListArgs,
        origin: ResumeListOrigin,
    ) -> Result<ResumeListResult, ErrorBody> {
        require_person(caller)?;
        if args.local && args.machine.is_some() {
            return Err(ErrorBody::invalid_argument(
                "choose either local resume listing or a machine",
            ));
        }
        if args.local {
            args.all = true;
        }
        let forwarded = matches!(origin, ResumeListOrigin::Forwarded);
        let selected = if forwarded {
            None
        } else {
            self.machine_for(args.machine.as_deref())?
        };
        let named_cli = matches!(caller, Caller::Terminal { .. })
            && args.all
            && selected.is_some()
            && args.folder.is_none();
        if let Some(id) = selected.as_ref().filter(|id| *id != &self.machine_id) {
            self.ensure_machine_route(id).await?;
            args.machine = None;
            let mut found = if named_cli {
                let items = decode_arguments(
                    self.network_call(
                        id,
                        caller.clone(),
                        RESUME_RECORDS,
                        value_of(args),
                        None,
                        None,
                    )
                    .await?,
                )?;
                let machines = self
                    .public_machines()?
                    .into_iter()
                    .filter(|row| row.machine_id == *id)
                    .map(|row| machine_query_result(row, MachineQueryStatus::Answered))
                    .collect();
                ResumeListResult { items, machines }
            } else {
                decode_arguments(
                    self.network_call(
                        id,
                        caller.clone(),
                        v3::AgentResumeList::NAME,
                        value_of(args),
                        None,
                        None,
                    )
                    .await?,
                )?
            };
            for item in &mut found.items {
                self.project_resume_candidate(item, true)?;
            }
            let visible = self.machine_identities()?;
            for row in &mut found.machines {
                crate::machine_service::project_machine_query(row, &visible);
            }
            return Ok(found);
        }

        let reachable = args.all && args.machine.is_none() && !args.local && !forwarded;
        let rows = if reachable && matches!(origin, ResumeListOrigin::CandidateShell) {
            self.probe_machine_queries(None).await?
        } else {
            self.public_machines()?
                .into_iter()
                .map(|row| machine_query_result(row, MachineQueryStatus::Unavailable))
                .collect()
        };
        let mut local = self.local_resume_candidates(&args, !named_cli).await?;
        let mut machines = Vec::new();
        let mut jobs = JoinSet::new();
        for mut row in rows {
            if row.machine_id == self.machine_id {
                row.status = MachineQueryStatus::Answered;
                machines.push(row);
            } else if reachable {
                if row.state != v3::MachineState::Online {
                    machines.push(row);
                    continue;
                }
                let (daemon, caller) = (self.clone(), caller.clone());
                jobs.spawn(async move {
                    let reply = daemon
                        .network_call(
                            &row.machine_id,
                            caller,
                            RESUME_RECORDS,
                            value_of(ResumeListArgs {
                                machine: None,
                                folder: None,
                                all: true,
                                local: false,
                            }),
                            None,
                            None,
                        )
                        .await
                        .and_then(decode_arguments::<Vec<ResumeCandidate>>);
                    (row, reply)
                });
            }
        }
        while let Some(task) = jobs.join_next().await {
            let (mut query, result) = task.map_err(ErrorBody::internal)?;
            match result {
                Ok(items) => {
                    query.status = MachineQueryStatus::Answered;
                    for mut item in items
                        .into_iter()
                        .filter(|item| item.machine_id == query.machine_id)
                    {
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
        local.sort_by(|a, b| {
            b.at.cmp(&a.at)
                .then_with(|| a.target.reference.cmp(&b.target.reference))
        });
        machines.sort_by(|a, b| a.machine_id.cmp(&b.machine_id));
        Ok(ResumeListResult {
            items: local,
            machines,
        })
    }

    pub(crate) async fn local_resume_candidates(
        &self,
        args: &ResumeListArgs,
        include_sessions: bool,
    ) -> Result<Vec<ResumeCandidate>, ErrorBody> {
        let folder = match (&args.folder, include_sessions || !args.all) {
            (Some(folder), _) => Some(PathBuf::from(folder)),
            (None, true) => Some(PathBuf::from(self.login_environment().await?.1)),
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
        for agent in self.agents() {
            let info = agent.info();
            let Some(session) = info.session.clone() else {
                continue;
            };
            let Some(rule) = agent.rule().map(str::to_owned) else {
                continue;
            };
            used.insert((rule, session.clone()));
            if info.process != ProcessState::Ended
                || (!args.all
                    && folder.as_ref().is_some_and(|folder| {
                        facade_base::files::folder_key(folder)
                            != facade_base::files::folder_key(Path::new(&info.cwd))
                    }))
            {
                continue;
            }
            let info = self.public_agent(info)?;
            let reference = info.reference();
            items.push(ResumeCandidate {
                target: ResumeTarget {
                    reference: info.address,
                    machine: None,
                    folder: None,
                },
                cli: info.cli,
                folder: info.cwd,
                machine_id: self.machine_id.clone(),
                session,
                agent: Some(reference),
                name: Some(info.name),
                stopped: info.state_detail.as_ref().and_then(|detail| detail.how)
                    == Some(HowEnded::Stopped),
                title: info.title,
                at: info.exit.map(|exit| exit.at),
            });
        }
        if let Some(folder) = &folder
            && include_sessions
        {
            let (environment, _) = self.login_environment().await?;
            let sessions = self.saved_candidates(folder, environment, None)?;
            let mut listed = BTreeSet::new();
            for (rule, mut item) in sessions {
                if !used.contains(&(rule.clone(), item.session.clone()))
                    && listed.insert((rule, item.session.clone()))
                {
                    self.project_resume_candidate(&mut item, false)?;
                    items.push(item);
                }
            }
        }
        items.sort_by(|a, b| {
            b.at.cmp(&a.at)
                .then_with(|| a.target.reference.cmp(&b.target.reference))
        });
        Ok(items)
    }

    pub(crate) async fn resume_request(
        self: &Arc<Self>,
        caller: &Caller,
        mut args: ResumeArgs,
        forwarded: bool,
    ) -> Result<ResumeResult, ErrorBody> {
        require_person(caller)?;
        check_size(args.cols, args.rows)?;
        if args.machine_id.is_some() && args.target.machine.is_some() {
            return Err(ErrorBody::invalid_argument(
                "choose a machine or a saved machine ID",
            ));
        }
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
            return self.forward_resume(id, caller, args).await;
        }

        let input = args
            .target
            .reference
            .trim_matches(facade_base::settings::is_space);
        let syntax = v3::address::parse_agent_address(input)
            .map_err(|error| ErrorBody::invalid_argument(error.to_string()))?;
        let pinned_number = match syntax {
            v3::address::AgentAddress::Local(v3::address::AgentKey::Number(number))
                if selected.is_some() =>
            {
                Some(number)
            }
            _ => None,
        };
        let agent = if let Some(number) = pinned_number {
            Ok(AgentRef {
                agent_id: number.into(),
                machine_id: self.machine_id.clone(),
            })
        } else if selected.is_some() || forwarded {
            let cards = self
                .agents()
                .iter()
                .map(|agent| self.lookup_candidate(agent))
                .collect::<Result<Vec<_>, _>>()?;
            let key = match syntax {
                v3::address::AgentAddress::Local(key) => key,
                v3::address::AgentAddress::Qualified { agent, machine, .. }
                    if self.select_machine(machine)?.machine_id == self.machine_id =>
                {
                    agent
                }
                _ => {
                    return Err(ErrorBody::invalid_argument(
                        "the agent address names a different machine",
                    ));
                }
            };
            records::lookup(key, &Reach::from(caller), OperationTarget::Resume, &cards)
        } else {
            self.addressed_agent(
                caller,
                v3::AgentTarget::Address {
                    agent: input.to_owned(),
                },
                OperationTarget::Resume,
            )
            .await
        };
        let legacy_session = input
            .split_once(':')
            .filter(|(entry, id)| {
                !entry.is_empty() && facade_rules::parse_session_id(id).as_deref() == Some(*id)
            })
            .map(|(cli, id)| (Some(cli), id.to_owned()));
        let session_selector = legacy_session.or_else(|| {
            if !agent
                .as_ref()
                .is_err_and(|error| error.data.reason == Reason::NotFound)
            {
                return None;
            }
            let id = facade_rules::parse_session_id(input).or_else(|| {
                (input.len() == 8 && is_session_id(input)).then(|| {
                    if input.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                        input.to_ascii_lowercase()
                    } else {
                        input.to_owned()
                    }
                })
            })?;
            Some((None, id))
        });
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
            let mut candidates = self.saved_candidates(path, env.clone(), *cli)?;
            let mut matched = BTreeSet::new();
            candidates.retain(|(rule, item)| {
                (item.session == *id || (id.len() == 8 && item.session.starts_with(id)))
                    && matched.insert((rule.clone(), item.session.clone()))
            });
            if candidates.len() > 1 {
                let mut error = ErrorBody::new(
                    Reason::AmbiguousReference,
                    format!("{input} names several saved sessions"),
                );
                for (_, item) in &candidates {
                    error.data.candidates.push(item.target.reference.clone());
                    error.data.sessions.push(session_match(item));
                }
                return Err(error);
            }
            (candidates.pop().map(|(_, item)| item), env)
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
                error.data.candidates = vec![self.agent_address(&agent)?, session.target.reference];
                return Err(error);
            }
            (Ok(agent), None) => agent,
            (Err(error), Some(session)) if error.data.reason == Reason::NotFound => {
                let origin = StartOrigin {
                    caller: caller.clone(),
                    sender: sender_from(caller, None),
                    by_model: false,
                };
                let started = self
                    .start_saved_session(
                        v3::StartArgs {
                            cli: session.cli,
                            args: Vec::new(),
                            folder: Some(session.folder),
                            folder_is_default: false,
                            machine: None,
                            worktree: None,
                            model: None,
                            effort: None,
                            name: None,
                            prompt: None,
                            env: session_env,
                            cols: args.cols,
                            rows: args.rows,
                            call_id: None,
                            result_message_id: None,
                            result_message_machine_id: None,
                            request_id: None,
                        },
                        origin,
                        session.session,
                    )
                    .await?;
                return Ok(ResumeResult {
                    agent: self.public_agent(started.agent)?,
                    from_saved_session: true,
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
            args.target.reference = agent.agent_id;
            return self.forward_resume(&agent.machine_id, caller, args).await;
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
                AgentResumeArgs {
                    agent: agent.agent_id,
                    env,
                    cols: args.cols,
                    rows: args.rows,
                },
            )
            .await
            .map_err(|error| self.with_agent_error(&handle, error))?;
        Ok(ResumeResult {
            agent: self.public_agent(resumed)?,
            from_saved_session: false,
        })
    }

    async fn forward_resume(
        &self,
        id: &str,
        caller: &Caller,
        mut args: ResumeArgs,
    ) -> Result<ResumeResult, ErrorBody> {
        self.ensure_machine_route(id).await?;
        args.machine_id = Some(id.to_owned());
        args.target.machine = None;
        args.env.clear();
        let mut result: ResumeResult = decode_arguments(
            self.network_call(
                id,
                caller.clone(),
                v3::AgentResume::NAME,
                value_of(args),
                None,
                None,
            )
            .await?,
        )?;
        result.agent.address = self.agent_address(&result.agent.reference())?;
        Ok(result)
    }

    fn project_resume_candidate(
        &self,
        item: &mut ResumeCandidate,
        remote: bool,
    ) -> Result<(), ErrorBody> {
        if let Some(agent) = &item.agent {
            item.target.reference = self.agent_address(agent)?;
        } else {
            item.target.machine = remote
                .then(|| self.machine_address_part(&item.machine_id))
                .transpose()?;
            item.target.folder = Some(item.folder.clone());
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
                            target: ResumeTarget {
                                reference: format!("{}:{}", entry.name, session.id),
                                machine: None,
                                folder: Some(folder.clone()),
                            },
                            cli: entry.name.clone(),
                            machine_id: self.machine_id.clone(),
                            session: session.id,
                            folder,
                            agent: None,
                            name: None,
                            stopped: false,
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

fn session_match(candidate: &ResumeCandidate) -> SessionMatch {
    SessionMatch {
        id: candidate.session.clone(),
        cli: candidate.cli.clone(),
        title: candidate.title.clone(),
    }
}
