//! The same-user relay socket and the actor it establishes at its first tool call.

use std::collections::BTreeMap;
use std::sync::{Arc, OnceLock};
use std::time::Instant;

use facade_base::api_v1::daemon::{self as wire, AgentKind};
use facade_base::model::agent::{AgentRef, AgentsUpdate, ManagedAgent, is_session_id};
use facade_base::model::error::{ErrorBody, Reason};
use facade_base::process::ProcessState;
use facade_base::{system, unix_process};
use serde_json::{Value, json};

use crate::agent::AgentHandle;
use crate::guests::{GuestJoin, RelayProcess};
use crate::lifecycle::RelayLink;
use crate::machine_service::agent_caller;
use crate::mcp::{
    self, ActorIdentity, ActorServices, DiscoverClis, InboxAnswer, InboxOutput, ReadReply, Relay,
    RelayHelloParams, ToolsPresence,
};
use crate::messages::{InboxRead, InboxSelection, ReplyRead};
use crate::runs::RunIdentity;
use crate::server::{Outbox, RelayHandshake, RelayLines, RelayResponse, WhenFull};
use crate::{Cancel, Daemon, api, blocking_in_place};

struct RelayEvidence {
    process: RelayProcess,
    env: BTreeMap<String, String>,
    cwd: Option<String>,
    guest_cli: Option<String>,
}

struct BoundActor {
    reference: AgentRef,
    run: Option<(u64, u32)>,
}

struct CurrentActor {
    handle: AgentHandle,
    info: ManagedAgent,
}

struct RelayTools(tokio::task::JoinHandle<()>);

impl Drop for RelayTools {
    fn drop(&mut self) {
        self.0.abort();
    }
}

impl BoundActor {
    fn managed(run: RunIdentity, machine_id: &str) -> Self {
        Self {
            reference: AgentRef {
                machine_id: machine_id.into(),
                agent_id: run.agent_id,
            },
            run: Some((run.run, run.pid)),
        }
    }

    fn identity(&self, handle: &AgentHandle) -> ActorIdentity {
        ActorIdentity {
            reference: self.reference.clone(),
            kind: if self.run.is_some() {
                AgentKind::Managed
            } else {
                AgentKind::Guest
            },
            receives_terminal_messages: self.run.is_some()
                && handle
                    .rule()
                    .and_then(|name| facade_rules::find(name).ok().flatten())
                    .is_some(),
        }
    }

    fn current(&self, daemon: &Daemon, process: &RelayProcess) -> Result<CurrentActor, ErrorBody> {
        let unavailable = || ErrorBody::new(Reason::Unavailable, "this relay's run has ended");
        let handle = daemon
            .get_agent(&self.reference.agent_id)
            .ok_or_else(unavailable)?;
        let (generation, info) = handle.installed_record();
        let current = match self.run {
            Some((run, pid)) => {
                !info.guest
                    && generation == run
                    && info.pid == Some(pid)
                    && info.process == ProcessState::Running
                    && handle.exit().borrow().is_none()
            }
            None => {
                info.guest
                    && info.process == ProcessState::Running
                    && daemon.guests.member_of(process).as_ref() == Some(&self.reference.agent_id)
            }
        };
        current
            .then_some(CurrentActor { handle, info })
            .ok_or_else(unavailable)
    }
}

struct RelayConnection {
    daemon: Arc<Daemon>,
    relay: Arc<Relay>,
    process: RelayProcess,
    link: Arc<RelayLink>,
}

enum RelayInbox {
    Page(InboxRead),
    Reply(ReplyRead),
}

impl Daemon {
    pub(crate) async fn accept_relay(
        self: &Arc<Self>,
        params: Value,
        peer_pid: Option<u32>,
    ) -> Result<RelayHandshake, ErrorBody> {
        let process = relay_process(peer_pid)?;
        let hello = RelayHelloParams::decode(params)?;
        let link = self.lifecycle.relays.join()?;
        let evidence = Arc::new(RelayEvidence {
            process: process.clone(),
            env: hello
                .env()
                .iter()
                .filter(|(key, _)| !key.eq_ignore_ascii_case("FACADE_RUN_TOKEN"))
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect(),
            cwd: hello.cwd().map(str::to_owned),
            guest_cli: hello
                .args()
                .windows(2)
                .find_map(|pair| (pair[0] == "--guest").then(|| pair[1].clone())),
        });
        let relay = Arc::new(self.relay(hello, evidence));
        if relay.reconnect() {
            let relay = relay.clone();
            tokio::spawn(async move { relay.hold_verified_presence().await });
        }
        let lines = RelayConnection {
            daemon: self.clone(),
            relay,
            process,
            link: link.clone(),
        };
        Ok(RelayHandshake {
            answer: json!({ "relay": mcp::RELAY_CONTRACT, "request_context": true }),
            lines: Arc::new(lines),
            link,
        })
    }

    fn relay(self: &Arc<Self>, hello: RelayHelloParams, evidence: Arc<RelayEvidence>) -> Relay {
        let bound: Arc<OnceLock<BoundActor>> = Arc::new(OnceLock::new());
        let (pid, birth) = (evidence.process.pid, evidence.process.birth.clone());
        let authenticate: mcp::verified::Authenticate = {
            let (daemon, evidence, bound) = (self.clone(), evidence.clone(), bound.clone());
            Box::new(
                move |credential: Option<&str>, meta: Option<&Value>, app: Option<&str>| {
                    let (daemon, evidence, bound) =
                        (daemon.clone(), evidence.clone(), bound.clone());
                    Box::pin(async move {
                        let run = daemon.relay_run(&evidence, credential, meta).await?;
                        let actor = match run {
                            Some(run) => BoundActor::managed(run, &daemon.machine_id),
                            None => {
                                let id = daemon.join_relay_guest(&evidence, app).await?;
                                BoundActor {
                                    reference: AgentRef {
                                        machine_id: daemon.machine_id.clone(),
                                        agent_id: id,
                                    },
                                    run: None,
                                }
                            }
                        };
                        let current = actor.current(&daemon, &evidence.process)?;
                        let identity = actor.identity(&current.handle);
                        bound.set(actor).ok();
                        Ok(identity)
                    })
                },
            )
        };
        let call: mcp::verified::ActorCall = {
            let (daemon, evidence, bound) = (self.clone(), evidence.clone(), bound.clone());
            Box::new(
                move |reference: &AgentRef, call: wire::DaemonCall, deadline, cancel| {
                    let (daemon, evidence, bound) =
                        (daemon.clone(), evidence.clone(), bound.clone());
                    Box::pin(async move {
                        call.authorize(wire::ClientKind::Mcp)?;
                        if let Some(error) = daemon.lifecycle.draining() {
                            return Err(error);
                        }
                        let actor =
                            attached_actor(&bound, reference).map_err(api::project_error)?;
                        let CurrentActor { handle, info } = actor
                            .current(&daemon, &evidence.process)
                            .map_err(api::project_error)?;
                        let caller = agent_caller(&info);
                        drop(info);
                        let calling = daemon.call_with_result(
                            &caller,
                            call,
                            WhenFull::Refuse,
                            cancel,
                            None,
                            deadline,
                        );
                        let Some((run, _)) = actor.run else {
                            return calling.await;
                        };
                        let tools = handle.tools_connected();
                        tokio::pin!(calling);
                        tokio::select! {
                            result = &mut calling => result,
                            () = run_ended(&handle, run) => {
                                drop(tools);
                                calling.await
                            }
                        }
                    })
                },
            )
        };
        let read_inbox: mcp::verified::ReadInbox = {
            let (daemon, evidence, bound) = (self.clone(), evidence.clone(), bound.clone());
            Box::new(
                move |reference: &AgentRef, read: InboxRead, cancel: Cancel, output| {
                    let (daemon, evidence, bound) =
                        (daemon.clone(), evidence.clone(), bound.clone());
                    Box::pin(async move {
                        let actor = attached_actor(&bound, reference)?;
                        daemon
                            .read_relay_inbox(
                                actor,
                                &evidence,
                                RelayInbox::Page(read),
                                cancel,
                                output,
                            )
                            .await
                    })
                },
            )
        };
        let read_reply: ReadReply = {
            let (daemon, evidence, bound) = (self.clone(), evidence.clone(), bound.clone());
            Box::new(move |reference, read, cancel, output| {
                let (daemon, evidence, bound) = (daemon.clone(), evidence.clone(), bound.clone());
                Box::pin(async move {
                    let actor = attached_actor(&bound, reference)?;
                    daemon
                        .read_relay_inbox(actor, &evidence, RelayInbox::Reply(read), cancel, output)
                        .await
                })
            })
        };
        let discover_clis: DiscoverClis = {
            let (daemon, evidence, bound) = (self.clone(), evidence.clone(), bound.clone());
            Box::new(move |reference, machines, deadline| {
                let (daemon, evidence, bound) = (daemon.clone(), evidence.clone(), bound.clone());
                Box::pin(async move {
                    let actor = attached_actor(&bound, reference)
                        .and_then(|actor| actor.current(&daemon, &evidence.process));
                    match actor {
                        Ok(current) => {
                            daemon
                                .relay_clis(current.info, machines, deadline.into())
                                .await
                        }
                        Err(error) => machines
                            .iter()
                            .filter(|machine| machine.status == wire::QueryStatus::Answered)
                            .map(|machine| (machine.machine_id.clone(), Err(error.message.clone())))
                            .collect(),
                    }
                })
            })
        };
        let managed_instructions: mcp::verified::ManagedInstructions = {
            let daemon = self.clone();
            let evidence = evidence.clone();
            Box::new(move |credential: Option<&str>| {
                let (daemon, evidence) = (daemon.clone(), evidence.clone());
                Box::pin(async move {
                    let Some(run) = daemon.relay_run(&evidence, credential, None).await? else {
                        return Ok(None);
                    };
                    let actor = BoundActor::managed(run, &daemon.machine_id);
                    let current = actor.current(&daemon, &evidence.process)?;
                    if current
                        .handle
                        .rule()
                        .is_some_and(facade_rules::managed_instructions_from_hook)
                    {
                        return Ok(None);
                    }
                    let instructions =
                        blocking_in_place(|| daemon.instructions_for_current_run(&current.info))?;
                    actor.current(&daemon, &evidence.process)?;
                    Ok(Some(instructions))
                })
            })
        };
        let ready: mcp::verified::Ready = {
            let daemon = self.clone();
            Box::new(move |credential: Option<&str>| {
                let (daemon, evidence) = (daemon.clone(), evidence.clone());
                Box::pin(async move {
                    let Some(run) = daemon.relay_run(&evidence, credential, None).await? else {
                        return Ok(None);
                    };
                    let generation = run.run;
                    let actor = BoundActor::managed(run, &daemon.machine_id);
                    let handle = actor.current(&daemon, &evidence.process)?.handle;
                    let tools = handle.tools_connected();
                    let held: ToolsPresence = Box::new(RelayTools(tokio::spawn(async move {
                        let _tools = tools;
                        run_ended(&handle, generation).await;
                    })));
                    Ok(Some(held))
                })
            })
        };
        let services = ActorServices {
            authenticate,
            call,
            read_inbox,
            managed_instructions,
            ready,
        };
        Relay::of_verified(hello, pid, birth, services)
            .with_actor_queries(read_reply, discover_clis)
    }

    async fn read_relay_inbox(
        &self,
        actor: &BoundActor,
        evidence: &RelayEvidence,
        mut selection: RelayInbox,
        cancel: Cancel,
        output: Option<InboxOutput>,
    ) -> Result<InboxAnswer, ErrorBody> {
        let CurrentActor {
            handle,
            info: ManagedAgent { guest, .. },
        } = actor.current(self, &evidence.process)?;
        let active = handle.clone();
        let run = actor.run.map(|(run, _)| run);
        let admit_run: crate::messages::ReadAdmission = Arc::new(move || {
            active.exit().borrow().is_none() && run.is_none_or(|run| active.run() == run)
        });
        let link = output.as_ref().map(|output| output.link().clone());
        match &mut selection {
            RelayInbox::Page(read) => {
                read.admit_run = Some(admit_run);
                read.relay = link;
            }
            RelayInbox::Reply(read) => {
                read.admit_run = Some(admit_run);
                read.relay = link;
            }
        }
        let machines = self.machine_identities()?;
        let project = |page: &facade_base::model::message::MessagesSnapshot, room| {
            let render = if page.messages.iter().any(|message| message.result.is_some()) {
                let mut render = page.clone();
                for message in &mut render.messages {
                    if let Some(result) = &message.result {
                        message.text = crate::delivery::render_start_result(result, &machines)?;
                    }
                }
                Some(render)
            } else {
                None
            };
            let (count, projected) =
                mcp::project_inbox(render.as_ref().unwrap_or(page), &self.machine_id, &machines)?;
            // The writer rechecks this run and the complete prefix when taking the page.
            actor.current(self, &evidence.process)?;
            if let Some(output) = &output {
                output.prepare(count, projected, room)
            } else {
                Ok(InboxSelection::ready(count, InboxAnswer::Page(projected)))
            }
        };
        let owner = &actor.reference.agent_id;
        let read = async {
            match selection {
                RelayInbox::Page(read) => {
                    self.messages
                        .read_inbox(owner, guest, read, cancel, project)
                        .await
                }
                RelayInbox::Reply(read) => {
                    self.messages
                        .read_first_reply(owner, guest, read, cancel, project)
                        .await
                }
            }
        };
        if let Some((run, _)) = actor.run {
            let mut exit = handle.exit();
            tokio::select! {
                biased;
                _ = exit.wait_for(|exit| exit.is_some() || handle.run() != run) => {
                    Err(ErrorBody::new(Reason::Unavailable, "this relay's run has ended"))
                }
                result = read => result,
            }
        } else {
            read.await
        }
    }

    async fn relay_clis(
        self: &Arc<Self>,
        info: ManagedAgent,
        machines: &[wire::MachineQuery],
        deadline: tokio::time::Instant,
    ) -> BTreeMap<String, Result<Vec<String>, String>> {
        let online = self.network.machines();
        let caller = agent_caller(&info);
        let mut jobs = tokio::task::JoinSet::new();
        for machine in machines
            .iter()
            .filter(|machine| machine.status == wire::QueryStatus::Answered)
        {
            let local = machine.machine_id == self.machine_id;
            if !local
                && !online.iter().any(|known| {
                    known.machine_id == machine.machine_id
                        && known.state == wire::MachineState::Online
                })
            {
                continue;
            }
            let daemon = self.clone();
            let machine = machine.machine_id.clone();
            let caller = caller.clone();
            let managed_folder = (!info.guest).then(|| info.cwd.clone());
            let agent_id = info.agent_id.clone();
            jobs.spawn(async move {
                let lookup = async {
                    if local {
                        let environment = if managed_folder.is_some() {
                            daemon.environment_of(&agent_id).await?
                        } else {
                            BTreeMap::new()
                        };
                        daemon.cli_list(managed_folder, environment).await
                    } else {
                        let value = daemon
                            .network_call::<wire::CliList>(
                                &machine,
                                &caller,
                                wire::CliListArgs::default(),
                                Some(
                                    deadline.saturating_duration_since(tokio::time::Instant::now()),
                                ),
                            )
                            .await?;
                        facade_base::jsonrpc::decode_arguments::<wire::CliListResult>(value)
                    }
                };
                let result = match tokio::time::timeout_at(deadline, lookup).await {
                    Err(_) => Err("The CLI lookup did not finish in time.".into()),
                    Ok(Err(error)) => Err(error.message),
                    Ok(Ok(result)) => match result.settings_problem {
                        Some(problem) => Err(problem),
                        None => Ok(result
                            .clis
                            .into_iter()
                            .filter(|cli| cli.available)
                            .map(|cli| cli.cli)
                            .collect()),
                    },
                };
                (machine, result)
            });
        }
        let mut results = BTreeMap::new();
        while let Some(result) = jobs.join_next().await {
            if let Ok((machine, result)) = result {
                results.insert(machine, result);
            }
        }
        results
    }

    async fn relay_run(
        &self,
        evidence: &RelayEvidence,
        credential: Option<&str>,
        meta: Option<&Value>,
    ) -> Result<Option<RunIdentity>, ErrorBody> {
        if self.guests.member_of(&evidence.process).is_some() {
            return Ok(None);
        }
        if let Some(credential) = credential {
            return self.runs.verify_credential(credential).await;
        }
        blocking_in_place(|| self.legacy_relay_run(evidence, meta))
    }

    fn legacy_relay_run(
        &self,
        evidence: &RelayEvidence,
        meta: Option<&Value>,
    ) -> Result<Option<RunIdentity>, ErrorBody> {
        let process = &evidence.process;
        let legacy_id = system::env_var(&evidence.env, "FACADE_AGENT");
        let parent = unix_process::parent(process.pid).ok().flatten();
        let ancestors = legacy_id.map(|_| unix_process::ancestors(process.pid));
        let mut authenticated = None;
        for handle in self.agents() {
            let (run, info) = handle.installed_record();
            let Some(pid) = info
                .pid
                .filter(|_| !info.guest && info.process == ProcessState::Running)
            else {
                continue;
            };
            let legacy_candidate = legacy_id == Some(info.agent_id.as_str())
                && ancestors.as_ref().is_some_and(|line| line.contains(&pid));
            if parent != Some(pid) && !legacy_candidate {
                continue;
            }
            let Some(kept) = self
                .store
                .relay_run(&info.agent_id)
                .map_err(ErrorBody::internal)?
            else {
                continue;
            };
            if kept.process.pid != pid
                || unix_process::birth(pid).ok().flatten().as_deref() != Some(&kept.process.birth)
            {
                continue;
            }
            let accepted = match kept.version {
                2 => {
                    legacy_candidate
                        && evidence.guest_cli.as_deref().is_none_or(|cli| {
                            let same_cli =
                                info.cli == cli && facade_rules::guest_entry_serves_run(cli);
                            let reported = facade_rules::session_variable(cli)
                                .and_then(|key| system::env_var(&evidence.env, key))
                                .filter(|session| is_session_id(session));
                            same_cli
                                && info
                                    .session
                                    .as_deref()
                                    .zip(reported)
                                    .is_none_or(|(known, given)| known == given)
                        })
                }
                3 if parent == Some(pid) => info.session.as_deref().is_some_and(|session| {
                    self.get_agent(&info.agent_id)
                        .and_then(|agent| {
                            agent
                                .rule()
                                .and_then(|rule| facade_rules::find(rule).ok().flatten())
                        })
                        .is_some_and(|rule| {
                            facade_rules::session_evidence(rule, session, &evidence.env, meta)
                        })
                }),
                _ => false,
            };
            if accepted {
                if authenticated.is_some() {
                    return Ok(None);
                }
                authenticated = Some(RunIdentity {
                    agent_id: info.agent_id,
                    pid,
                    run,
                });
            }
        }
        Ok(authenticated)
    }

    async fn join_relay_guest(
        self: &Arc<Self>,
        evidence: &RelayEvidence,
        app: Option<&str>,
    ) -> Result<String, ErrorBody> {
        let _joining = self.guests.joining().await;
        let join = GuestJoin {
            process: evidence.process.clone(),
            app: app
                .map(|name| name.trim_matches(facade_base::settings::is_space))
                .filter(|name| !name.is_empty() && !name.chars().any(char::is_control))
                .map(str::to_owned),
            cwd: evidence.cwd.clone(),
            env: evidence.env.clone(),
        };
        if let Some(id) = self.guests.member_of(&evidence.process) {
            self.guests.register_join(&id, join);
            return Ok(id);
        }
        let id = self.records.next_id().await?;
        let names = crate::command_line::settings_names();
        let name = self.reserve_name(names.as_deref()).await?;
        let (info, record) = join.info(&id, &name);
        let info = self.project_guest(info);
        if let Err(err) = self.guests.keep_member(&record, info.yolo) {
            self.records.release_name(&name);
            return Err(err);
        }
        {
            let mut agents = self.agents.lock().unwrap();
            agents.insert(id.clone(), AgentHandle::guest(info.clone()));
            self.records.release_name(&name);
        }
        self.guests.register_join(&id, join);
        let _ = self.changes.send(AgentsUpdate::Updated {
            agent: Box::new(info),
        });
        Ok(id)
    }
}

async fn run_ended(handle: &AgentHandle, run: u64) {
    let mut exit = handle.exit();
    let _ = exit
        .wait_for(|exit| exit.is_some() || handle.run() != run)
        .await;
}

fn attached_actor<'a>(
    bound: &'a OnceLock<BoundActor>,
    reference: &AgentRef,
) -> Result<&'a BoundActor, ErrorBody> {
    bound
        .get()
        .filter(|actor| &actor.reference == reference)
        .ok_or_else(|| ErrorBody::refused("this relay has no verified actor"))
}

impl RelayLines for RelayConnection {
    fn take(&self, line: &[u8], arrived: Instant, outbox: &Outbox) -> Option<RelayResponse> {
        self.relay
            .take(line, arrived, outbox.clone(), self.link.clone())
    }

    fn settle_cancelled(&self) -> mcp::verified::ActorFuture<'_, ()> {
        Box::pin(self.relay.settle_cancelled())
    }

    fn ended(&self, closing_answered: bool) {
        if !closing_answered && let Some(id) = self.daemon.guests.end_member(&self.process) {
            let _ = self.daemon.end_listed_guest(&id);
        }
    }
}

fn relay_process(peer_pid: Option<u32>) -> Result<RelayProcess, ErrorBody> {
    let unread = || ErrorBody::invalid_argument("the relay's process cannot be read");
    let pid = peer_pid.ok_or_else(unread)?;
    let birth = blocking_in_place(|| unix_process::birth(pid))
        .ok()
        .flatten()
        .ok_or_else(unread)?;
    Ok(RelayProcess { pid, birth })
}
