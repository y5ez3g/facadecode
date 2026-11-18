//! Relays: the `facade-mcp` processes that carry an MCP client's lines to the daemon. A relay's
//! hello says whom its client acts for; the relay's own process, its pid with its start, names it.
//! An MCP client that is no Facade run's and no guest's joins as a member: a guest
//! found by its relay, with an ID and an inbox, which ends with its relay's connection.

use std::sync::Arc;
use std::time::Instant;

use facade_base::daemon::{AgentsUpdate, TERMINAL_WINDOW, is_session_id};
use facade_base::daemon_client::{DaemonClient, Identity, upgrading};
use facade_base::jsonrpc::ErrorBody;
use serde_json::{Value, json};

use crate::Daemon;
use crate::agent::AgentHandle;
use crate::guests::{Guests, RelayProcess};
use crate::mcp::{self, Connect, JoinMember, Relay, Serves};
use crate::server::{self, RelayLines};
use crate::service::not_listed;

/// The CLI a member is listed with where its client gives no name that can be one.
const MEMBER_CLI: &str = "mcp";

/// One relay's connection: what answers its lines, for whom.
struct RelayConnection {
    daemon: Arc<Daemon>,
    relay: Arc<Relay>,
    serves: Serves,
    process: RelayProcess,
}

impl Daemon {
    /// Accepts the relay whose hello `params` came from process `peer_pid`. A relay that serves
    /// no one may be a member that this daemon lists already, as after a restart; a relay that
    /// acts for an agent not yet listed is refused, and tries again.
    pub(crate) async fn accept_relay(
        self: &Arc<Self>,
        params: Value,
        peer_pid: Option<u32>,
    ) -> Result<(Value, Arc<dyn RelayLines>), ErrorBody> {
        let process = relay_process(peer_pid)?;
        // A member works in the folder its relay runs in.
        let cwd = params
            .get("cwd")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let join = self.join_member_by(process.clone(), cwd);
        let relay = Relay::of(
            params,
            process.pid,
            process.birth.clone(),
            self.connect(),
            join,
        )?;
        let relay = Arc::new(relay);
        let mut serves = {
            let relay = relay.clone();
            tokio::task::spawn_blocking(move || relay.serves())
                .await
                .map_err(ErrorBody::internal)?
        };
        match &serves {
            Serves::Nobody => {
                if let Some(id) = self.guests.member_of(&process) {
                    relay.serve_member(id.clone());
                    serves = Serves::Member(id);
                }
            }
            // It counts for its agent's tools, so its agent must be listed.
            Serves::Agent(agent) if self.get_agent(agent).is_none() => {
                return Err(not_listed(agent));
            }
            // A relay that connects again has had the tools since its first daemon.
            Serves::Agent(agent) if relay.reconnect() => {
                let (relay, agent) = (relay.clone(), agent.clone());
                tokio::task::spawn_blocking(move || relay.hold_presence(&agent));
            }
            _ => {}
        }
        let lines = RelayConnection {
            daemon: self.clone(),
            relay,
            serves,
            process,
        };
        Ok((json!({ "relay": mcp::RELAY_CONTRACT }), Arc::new(lines)))
    }

    /// Opens connections to this daemon for the relay's tools: one end of a socket pair, whose
    /// other end the server serves as it serves its socket's. Made and used in blocking tasks
    /// alone, as its hello waits for the daemon's answer. None while the daemon hands over to a
    /// newer build.
    fn connect(self: &Arc<Self>) -> Connect {
        let (daemon, runtime) = (self.clone(), tokio::runtime::Handle::current());
        Box::new(move |identity: &Identity| {
            let (ours, theirs) = {
                let _in_runtime = runtime.enter();
                facade_base::sockets::pair()?
            };
            runtime.spawn(server::serve_connection(daemon.clone(), theirs));
            match DaemonClient::hello(ours, identity) {
                Ok(client) => Ok(Some(client)),
                Err(err) if upgrading(&err) => Ok(None),
                Err(err) => Err(err),
            }
        })
    }

    /// How the MCP client of relay `process`, in folder `cwd`, joins as a member. Called from the
    /// relay's blocking task as its client says `initialize`.
    fn join_member_by(self: &Arc<Self>, process: RelayProcess, cwd: String) -> JoinMember {
        let (daemon, runtime) = (self.clone(), tokio::runtime::Handle::current());
        Box::new(move |client: Option<&str>| {
            runtime.block_on(daemon.join_member(&process, client, &cwd))
        })
    }

    /// Lists the MCP client of relay `process` as a member: a guest with the next agent ID and a
    /// default name, its CLI the client's name. As a guest joins, the store keeps it before it is
    /// listed, and it is registered by its relay last, so a second `initialize` waits on the same
    /// lock and finds it.
    async fn join_member(
        self: &Arc<Self>,
        process: &RelayProcess,
        client: Option<&str>,
        cwd: &str,
    ) -> Result<String, ErrorBody> {
        let _joining = self.guests.joining().await;
        if let Some(id) = self.guests.member_of(process) {
            return Ok(id);
        }
        let id = self.records.next_id().await?;
        // A member is in the terminal window, at its relay's folder.
        let names = crate::command_line::settings_names();
        let name = self.reserve_name(&[self.local_window(TERMINAL_WINDOW)], &id, names.as_deref());
        let cli = client
            .filter(|name| is_session_id(name))
            .unwrap_or(MEMBER_CLI);
        let (info, record) = Guests::member_info(&id, &name, cli, process, cwd);
        let info = self.project_guest(info);
        if let Err(err) = self.guests.keep(&record).await {
            self.records.release_name(&name);
            return Err(err);
        }
        {
            let mut agents = self.agents.lock().unwrap();
            agents.insert(id.clone(), AgentHandle::guest(info.clone()));
            self.records.release_name(&name);
        }
        self.guests.register_member(&id, process);
        let _ = self.changes.send(AgentsUpdate::Updated {
            agent: Box::new(info),
        });
        Ok(id)
    }
}

impl RelayLines for RelayConnection {
    fn notice(&self, line: &[u8]) -> bool {
        self.relay.notice(line)
    }

    fn respond(&self, line: &[u8], arrived: Instant) -> Option<Value> {
        self.relay.respond(&self.serves, line, arrived)
    }

    fn failed(&self) -> Value {
        mcp::internal_error()
    }

    /// A member ends with its relay's connection, unless the relay carries on with a newer daemon.
    fn ended(&self, closing_answered: bool) {
        if closing_answered {
            return;
        }
        if let Some(id) = self.daemon.guests.end_member(&self.process) {
            self.daemon.end_listed_guest(&id);
        }
    }
}

/// The relay's process, by its pid and when it started.
fn relay_process(peer_pid: Option<u32>) -> Result<RelayProcess, ErrorBody> {
    let unread = || ErrorBody::invalid_argument("the relay's process cannot be read");
    let pid = peer_pid.ok_or_else(unread)?;
    let birth = facade_base::unix_process::birth(pid)
        .ok()
        .flatten()
        .ok_or_else(unread)?;
    Ok(RelayProcess { pid, birth })
}
