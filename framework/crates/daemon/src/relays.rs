//! The same-user relay socket and the process and session that establish its actor.

mod bindings;
pub(super) use bindings::Bindings;

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, OnceLock};
use std::time::Instant;

use facade_base::api_v1::daemon::{self as wire, AgentKind};
use facade_base::model::agent::{AgentRef, AgentsUpdate, ManagedAgent, is_session_id};
use facade_base::model::error::{ErrorBody, Reason};
use facade_base::process::{ProcessIdentity, ProcessState};
use facade_base::{system, unix_process};
use facade_rules::NativeRelayHost;
use serde_json::{Value, json};
use tokio::sync::watch;

use crate::agent::{AgentHandle, ToolsStage};
use crate::delivery::missing_reply_inbox;
use crate::guests::{GuestJoin, RelayProcess};
use crate::lifecycle::RelayLink;
use crate::machine_service::agent_caller;
use crate::mcp::{
    self, AcquirePresence, ActorIdentity, ActorServices, CatalogEvent, DiscoverClis, InboxAnswer,
    InboxOutput, Initialization, ReadReply, Relay, RelayHelloParams,
};
use crate::messages::{InboxRead, InboxSelection, ReplyRead};
use crate::runs::RunIdentity;
use crate::server::{Outbox, RelayHandshake, RelayLines, RelayResponse, WhenFull};
use crate::{Cancel, Daemon, api, blocking_in_place, log};

struct RelayEvidence {
    process: RelayProcess,
    env: BTreeMap<String, String>,
    cwd: Option<String>,
    guest_cli: Option<String>,
    reconnect: bool,
    actor: OnceLock<BoundActor>,
    authenticating: tokio::sync::Mutex<()>,
    verified_run: VerifiedRelayRun,
}

impl RelayEvidence {
    fn bound_actor(&self) -> Result<&BoundActor, ErrorBody> {
        self.actor
            .get()
            .ok_or_else(|| ErrorBody::internal("the relay did not establish an actor"))
    }
}

struct BoundActor {
    reference: AgentRef,
    run: Option<(u64, u32)>,
}

struct CurrentActor {
    handle: AgentHandle,
    info: ManagedAgent,
}

enum RelayRole<T> {
    Managed(T),
    AwaitingSession,
    Guest,
}

struct ManagedRun {
    current: CurrentActor,
    generation: u64,
}

type VerifiedRelayRun = watch::Sender<Option<(AgentHandle, u64)>>;

impl BoundActor {
    fn managed(run: &RunIdentity, machine_id: &str) -> Self {
        Self {
            reference: AgentRef {
                machine_id: machine_id.into(),
                agent_id: run.agent_id.clone(),
            },
            run: Some((run.run, run.process.pid)),
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
        let (verified_run, mut run) = watch::channel(None);
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
            reconnect: hello.reconnect(),
            actor: OnceLock::new(),
            authenticating: tokio::sync::Mutex::new(()),
            verified_run,
        });
        let relay = Arc::new(self.relay(hello, evidence));
        if relay.reconnect() {
            let relay = relay.clone();
            tokio::spawn(async move {
                relay
                    .hold_verified_presence(CatalogEvent::Reconnect, None)
                    .await;
            });
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
            run_ended: Box::pin(async move {
                let verified = run
                    .wait_for(Option::is_some)
                    .await
                    .ok()
                    .and_then(|run| run.clone());
                if let Some((handle, number)) = verified {
                    run_ended(&handle, number).await;
                } else {
                    std::future::pending().await
                }
            }),
        })
    }

    fn relay(self: &Arc<Self>, hello: RelayHelloParams, evidence: Arc<RelayEvidence>) -> Relay {
        let (pid, birth) = (evidence.process.pid, evidence.process.birth.clone());
        let authenticate: mcp::verified::Authenticate = {
            let (daemon, evidence) = (self.clone(), evidence.clone());
            Box::new(
                move |credential: Option<&str>, meta: Option<&Value>, app: Option<&str>| {
                    let (daemon, evidence) = (daemon.clone(), evidence.clone());
                    Box::pin(async move {
                        let _authenticating = evidence.authenticating.lock().await;
                        let (current, acquire) =
                            match daemon.relay_run(&evidence, credential, meta).await? {
                                RelayRole::Managed(ManagedRun {
                                    current,
                                    generation,
                                }) => {
                                    current.handle.note_tool_use(generation);
                                    let acquire =
                                        (!deferred_tool_list(&current.handle)).then(|| {
                                            prepare_tool_presence(
                                                current.handle.clone(),
                                                generation,
                                                ToolsStage::Listed,
                                            )
                                        });
                                    (current, acquire)
                                }
                                RelayRole::AwaitingSession => return Err(native_session_mismatch()),
                                RelayRole::Guest => {
                                    if evidence.actor.get().is_none() {
                                        let id = daemon.join_relay_guest(&evidence, app).await?;
                                        let actor = BoundActor {
                                            reference: AgentRef {
                                                machine_id: daemon.machine_id.clone(),
                                                agent_id: id,
                                            },
                                            run: None,
                                        };
                                        evidence.actor.set(actor).ok();
                                    }
                                    (
                                        evidence
                                            .bound_actor()?
                                            .current(&daemon, &evidence.process)?,
                                        None,
                                    )
                                }
                            };
                        let identity = evidence.bound_actor()?.identity(&current.handle);
                        Ok(mcp::verified::AuthenticatedActor { identity, acquire })
                    })
                },
            )
        };
        let call: mcp::verified::ActorCall = {
            let (daemon, evidence) = (self.clone(), evidence.clone());
            Box::new(
                move |reference: &AgentRef, call: wire::DaemonCall, deadline, cancel| {
                    let (daemon, evidence) = (daemon.clone(), evidence.clone());
                    Box::pin(async move {
                        call.authorize(wire::ClientKind::Mcp)?;
                        if let Some(error) = daemon.lifecycle.draining() {
                            return Err(error);
                        }
                        let actor = attached_actor(&evidence.actor, reference)
                            .map_err(api::project_error)?;
                        let CurrentActor { handle, info } = actor
                            .current(&daemon, &evidence.process)
                            .map_err(api::project_error)?;
                        let project_guest_reply = match &call {
                            wire::DaemonCall::AgentSend(args) if info.guest => args
                                .reply_to
                                .as_ref()
                                .zip(facade_rules::managed_cli_for_project_guest(&info.cli))
                                .map(|(reply, managed_cli)| {
                                    (api::project_error(missing_reply_inbox(reply)), managed_cli)
                                }),
                            _ => None,
                        };
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
                            let result = calling.await;
                            if let (Some((missing, managed_cli)), Err(error)) =
                                (&project_guest_reply, &result)
                                && error == missing
                            {
                                blocking_in_place(|| {
                                    daemon.log_project_guest_reply(
                                        &evidence,
                                        &reference.agent_id,
                                        managed_cli,
                                    )
                                });
                            }
                            return result;
                        };
                        let tools = if deferred_tool_list(&handle) {
                            None
                        } else {
                            handle.hold_tools_connection(run, ToolsStage::Listed)
                        };
                        let Some(tools) = tools else {
                            return calling.await;
                        };
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
            let (daemon, evidence) = (self.clone(), evidence.clone());
            Box::new(
                move |reference: &AgentRef, read: InboxRead, cancel: Cancel, output| {
                    let (daemon, evidence) = (daemon.clone(), evidence.clone());
                    Box::pin(async move {
                        let actor = attached_actor(&evidence.actor, reference)?;
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
            let (daemon, evidence) = (self.clone(), evidence.clone());
            Box::new(move |reference, read, cancel, output| {
                let (daemon, evidence) = (daemon.clone(), evidence.clone());
                Box::pin(async move {
                    let actor = attached_actor(&evidence.actor, reference)?;
                    daemon
                        .read_relay_inbox(actor, &evidence, RelayInbox::Reply(read), cancel, output)
                        .await
                })
            })
        };
        let discover_clis: DiscoverClis = {
            let (daemon, evidence) = (self.clone(), evidence.clone());
            Box::new(move |reference, machines, deadline| {
                let (daemon, evidence) = (daemon.clone(), evidence.clone());
                Box::pin(async move {
                    let actor = attached_actor(&evidence.actor, reference)
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
            Box::new(move |credential, meta| {
                let (daemon, evidence) = (daemon.clone(), evidence.clone());
                Box::pin(async move {
                    let role = {
                        let _authenticating = evidence.authenticating.lock().await;
                        daemon.relay_run(&evidence, credential, meta).await?
                    };
                    let RelayRole::Managed(ManagedRun {
                        current: CurrentActor { handle, info },
                        generation,
                    }) = role
                    else {
                        return Ok(Initialization {
                            instructions: None,
                            acquire: None,
                        });
                    };
                    let (instructions, handle) = if handle
                        .rule()
                        .is_some_and(facade_rules::managed_instructions_from_hook)
                    {
                        (None, handle)
                    } else {
                        let instructions =
                            blocking_in_place(|| daemon.instructions_for_current_run(&info))?;
                        let current = evidence
                            .bound_actor()?
                            .current(&daemon, &evidence.process)?;
                        (Some(instructions), current.handle)
                    };
                    let acquire = deferred_tool_list(&handle).then(|| {
                        prepare_tool_presence(handle, generation, ToolsStage::Initialized)
                    });
                    Ok(Initialization {
                        instructions,
                        acquire,
                    })
                })
            })
        };
        let ready: mcp::verified::Ready = {
            let daemon = self.clone();
            Box::new(move |credential, meta, event| {
                let (daemon, evidence) = (daemon.clone(), evidence.clone());
                Box::pin(async move {
                    let role = {
                        let _authenticating = evidence.authenticating.lock().await;
                        daemon.relay_run(&evidence, credential, meta).await?
                    };
                    let RelayRole::Managed(ManagedRun {
                        current: CurrentActor { handle, .. },
                        generation,
                    }) = role
                    else {
                        return Ok(None);
                    };
                    // An older relay can reconnect before the CLI has listed its tools.
                    if deferred_tool_list(&handle) && matches!(event, CatalogEvent::Reconnect) {
                        return Ok(None);
                    }
                    Ok(Some(prepare_tool_presence(
                        handle,
                        generation,
                        ToolsStage::Listed,
                    )))
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
        selection: RelayInbox,
        cancel: Cancel,
        output: Option<InboxOutput>,
    ) -> Result<InboxAnswer, ErrorBody> {
        let CurrentActor {
            handle,
            info: ManagedAgent { guest, .. },
        } = actor.current(self, &evidence.process)?;
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
            // The delivery lock covers projection and recording the returned messages together.
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

    /// Resolves or establishes the same actor from initialize, catalog and tools.
    /// The caller holds the evidence's authentication lock while it may establish an actor.
    async fn relay_run(
        &self,
        evidence: &RelayEvidence,
        credential: Option<&str>,
        meta: Option<&Value>,
    ) -> Result<RelayRole<ManagedRun>, ErrorBody> {
        if let Some(actor) = evidence.actor.get() {
            let current = actor.current(self, &evidence.process)?;
            let Some((generation, pid)) = actor.run else {
                return Ok(RelayRole::Guest);
            };
            if credential.is_none() {
                let proof = blocking_in_place(|| {
                    self.native_relay_run(evidence, meta, [current.handle.clone()])
                })?;
                if !matches!(proof, RelayRole::Managed(run)
                    if run.agent_id == actor.reference.agent_id
                        && run.run == generation && run.process.pid == pid)
                {
                    return Ok(RelayRole::AwaitingSession);
                }
            }
            return Ok(RelayRole::Managed(ManagedRun {
                current,
                generation,
            }));
        }
        if self.guests.member_of(&evidence.process).is_some() {
            return Ok(RelayRole::Guest);
        }
        let proof = match credential {
            Some(credential) => self
                .runs
                .verify_credential(credential)
                .await?
                .map_or(RelayRole::Guest, RelayRole::Managed),
            None => blocking_in_place(|| {
                self.relay_bindings
                    .verify(&evidence.process, evidence.reconnect, |agent| match agent {
                        Some(agent) => self.native_relay_run(evidence, meta, self.get_agent(agent)),
                        None => self.native_relay_run(evidence, meta, self.agents()),
                    })
            })?,
        };
        let run = match proof {
            RelayRole::Managed(run) => run,
            RelayRole::AwaitingSession => return Ok(RelayRole::AwaitingSession),
            RelayRole::Guest => return Ok(RelayRole::Guest),
        };
        let actor = BoundActor::managed(&run, &self.machine_id);
        let current = actor.current(self, &evidence.process)?;
        if credential.is_none() {
            blocking_in_place(|| self.relay_bindings.remember(&evidence.process, &run))?;
        }
        evidence.actor.set(actor).ok();
        evidence
            .verified_run
            .send_replace(Some((current.handle.clone(), run.run)));
        Ok(RelayRole::Managed(ManagedRun {
            current,
            generation: run.run,
        }))
    }

    fn native_relay_run(
        &self,
        evidence: &RelayEvidence,
        meta: Option<&Value>,
        candidates: impl IntoIterator<Item = AgentHandle>,
    ) -> Result<RelayRole<RunIdentity>, ErrorBody> {
        let relay = ProcessIdentity {
            pid: evidence.process.pid,
            birth: evidence.process.birth.clone(),
        };
        let mut parents = Vec::new();
        let mut role = RelayRole::Guest;
        for handle in candidates {
            let (run, info) = handle.installed_record();
            if info.guest || info.process != ProcessState::Running {
                continue;
            }
            let Some(rule) = handle
                .rule()
                .and_then(|name| facade_rules::find(name).ok().flatten())
            else {
                continue;
            };
            let Some(chain) = rule.mcp.native_relay_chain.as_deref() else {
                continue;
            };
            while parents.len() <= chain.len() {
                let child = parents.last().unwrap_or(&relay);
                let Some(parent) = unix_process::parent_identity(child).ok().flatten() else {
                    break;
                };
                parents.push(parent);
            }
            let Some(managed) = parents.get(chain.len()) else {
                continue;
            };
            if info.pid != Some(managed.pid) {
                continue;
            }
            let Some(kept) = self
                .store
                .relay_run(&info.agent_id)
                .map_err(ErrorBody::internal)?
            else {
                continue;
            };
            if kept.process != *managed
                || !chain
                    .iter()
                    .zip(parents[..chain.len()].iter().rev())
                    .all(|(expected, observed)| native_host_matches(expected, observed, managed))
            {
                continue;
            }
            let version_matches = match kept.version {
                2 => legacy_run_matches(evidence, &info),
                3 => true,
                _ => false,
            };
            if !matches!(role, RelayRole::Guest) {
                return Ok(RelayRole::AwaitingSession);
            }
            role = if version_matches && native_session_matches(rule, &info, managed, &relay, meta)?
            {
                RelayRole::Managed(RunIdentity {
                    agent_id: info.agent_id,
                    process: kept.process,
                    run,
                })
            } else {
                RelayRole::AwaitingSession
            };
        }
        Ok(role)
    }

    /// Explains a reply from a project Guest when its relay is descended from a managed run
    /// in the same project.
    fn log_project_guest_reply(&self, evidence: &RelayEvidence, guest: &str, managed_cli: &str) {
        let (Some(cwd), Some(home)) = (
            evidence.cwd.as_deref(),
            system::env_var(&evidence.env, "FACADE_HOME"),
        ) else {
            return;
        };
        let parents = unix_process::ancestors(evidence.process.pid);
        let managed = self.agent_infos().into_iter().find(|info| {
            !info.guest
                && info.cli == managed_cli
                && info.cwd == cwd
                && info.process == ProcessState::Running
                && info.pid.is_some_and(|pid| {
                    parents.contains(&pid)
                        && self
                            .store
                            .relay_run(&info.agent_id)
                            .ok()
                            .flatten()
                            .is_some_and(|kept| {
                                kept.process.pid == pid
                                    && unix_process::birth(pid).ok().flatten().as_ref()
                                        == Some(&kept.process.birth)
                            })
                })
        });
        if let Some(managed) = managed
            && let Some(why) =
                facade_rules::project_guest_reply(managed_cli, Path::new(cwd), Path::new(home))
        {
            log(
                "warn",
                &format!("#{}: {why} (Guest #{guest})", managed.agent_id),
            );
        }
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

fn native_host_matches(
    expected: &NativeRelayHost,
    observed: &ProcessIdentity,
    managed: &ProcessIdentity,
) -> bool {
    let Some(image) = unix_process::executable(observed).ok().flatten() else {
        return false;
    };
    match expected {
        NativeRelayHost::ManagedExecutable => {
            unix_process::executable(managed).ok().flatten().as_ref() == Some(&image)
        }
        NativeRelayHost::Executable(name) => facade_base::programs::program_name(&image) == *name,
    }
}

fn native_session_matches(
    rule: &facade_rules::Rule,
    info: &ManagedAgent,
    managed: &ProcessIdentity,
    relay: &ProcessIdentity,
    meta: Option<&Value>,
) -> Result<bool, ErrorBody> {
    if rule.mcp.session_env_key.is_none() && rule.mcp.session_meta_key.is_none() {
        return Ok(true);
    }
    let env = if rule.mcp.session_env_key.is_some() {
        let Some(env) = unix_process::environment(relay).ok().flatten() else {
            return Ok(false);
        };
        env
    } else {
        BTreeMap::new()
    };
    if let Some(session) = info.session.as_deref() {
        return Ok(facade_rules::session_evidence(rule, session, &env, meta));
    }
    let Some(id) = rule
        .mcp
        .session_env_key
        .as_deref()
        .and_then(|key| system::env_var(&env, key))
    else {
        return Ok(false);
    };
    let Some(managed_env) = unix_process::environment(managed).ok().flatten() else {
        return Ok(false);
    };
    let Some(started_at) = unix_process::started_at(managed).ok().flatten() else {
        return Ok(false);
    };
    facade_rules::live_mcp_session_matches(
        rule,
        Path::new(&info.cwd),
        &managed_env,
        id,
        managed.pid,
        started_at,
    )
}

fn legacy_run_matches(evidence: &RelayEvidence, info: &ManagedAgent) -> bool {
    system::env_var(&evidence.env, "FACADE_AGENT") == Some(info.agent_id.as_str())
        && evidence.guest_cli.as_deref().is_none_or(|cli| {
            let reported = facade_rules::session_variable(cli)
                .and_then(|key| system::env_var(&evidence.env, key))
                .filter(|session| is_session_id(session));
            info.cli == cli
                && facade_rules::guest_entry_serves_run(cli)
                && info
                    .session
                    .as_deref()
                    .zip(reported)
                    .is_none_or(|(known, given)| known == given)
        })
}

async fn run_ended(handle: &AgentHandle, run: u64) {
    let mut exit = handle.exit();
    let _ = exit
        .wait_for(|exit| exit.is_some() || handle.run() != run)
        .await;
}

fn deferred_tool_list(agent: &AgentHandle) -> bool {
    agent
        .rule()
        .and_then(|name| facade_rules::find(name).ok().flatten())
        .is_some_and(|rule| rule.mcp.deferred_tool_list)
}

fn prepare_tool_presence(agent: AgentHandle, run: u64, stage: ToolsStage) -> AcquirePresence {
    Box::new(move || {
        agent
            .hold_tools_connection(run, stage)
            .map(|connection| Box::new(connection) as mcp::PresenceLease)
    })
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
        self.relay.close_presence();
        if !closing_answered && let Some(id) = self.daemon.guests.end_member(&self.process) {
            self.daemon.end_listed_guest(&id);
        }
    }
}

fn native_session_mismatch() -> ErrorBody {
    ErrorBody::refused("this request does not match the relay's managed session")
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
