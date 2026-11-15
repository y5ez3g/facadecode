//! The four topics a client can watch: the agents, the windows, an agent's screen, and an inbox's
//! messages. Each watch is a snapshot and a task that turns what changes into the topic's changes,
//! resending everything where it fell behind. The server sends them on.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use facade_base::daemon::{
    self, AgentInfo, AgentsChange, AgentsTopic, LocationInfo, LocationKind, Message,
    MessagesChange, MessagesTopic, MessagesWatchArgs, ScreenChange, ScreenSnapshot, ScreenTopic,
    ScreenWatchArgs, TERMINAL_WINDOW, TERMINAL_WINDOW_LABEL, WindowInfo, WindowsChange,
    WindowsTopic,
};
use facade_base::jsonrpc::{ErrorBody, Reason, decode_arguments};
use facade_base::operations::{NoArgs, Topic};
use serde::Serialize;
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::{mpsc, oneshot};

use crate::agent::{AgentCommand, AgentHandle, ViewerChange, viewer_channel};
use crate::command_line::Clis;
use crate::messages::Change;
use crate::records::{self, Reach};
use crate::server::{Client, Watch, WatchChange};
use crate::service::{actor_stopped, decode_or_default, value_of};
use crate::{Daemon, HUMAN};

/// How long an agent has to draw a new viewer's first screen.
const SCREEN_SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(10);
/// The changes a watch holds for the server before it waits.
const CHANGES_WAITING: usize = 64;

impl Daemon {
    /// Starts watching `topic` for `client`. Each topic subscribes to its changes before it takes
    /// its snapshot, so that nothing changes unseen in between.
    pub(crate) async fn start_watch(
        self: &Arc<Self>,
        client: &Client,
        topic: &str,
        args: serde_json::Value,
        viewer: u64,
    ) -> Result<Watch, ErrorBody> {
        match topic {
            ScreenTopic::NAME => {
                self.watch_screen(client, decode_arguments(args)?, viewer)
                    .await
            }
            AgentsTopic::NAME => Ok(self.watch_agents(client)),
            MessagesTopic::NAME => self.watch_messages(client, decode_or_default(args)?, viewer),
            WindowsTopic::NAME => {
                let NoArgs {} = decode_or_default(args)?;
                Ok(self.watch_windows(client).await)
            }
            other => Err(ErrorBody::invalid_argument(format!(
                "unknown topic {other}; supported topics: {}",
                daemon::topic_names().join(", ")
            ))),
        }
    }

    /// Ends a watch before its `unwatch` answers: a screen's viewer leaves its agent, and a
    /// window's messages watch stops counting as one that can tell the person.
    /// changes; the other topics hold nothing more.
    pub(crate) async fn end_watch(&self, _client: &Client, _topic: &str, viewer: u64) {
        let ending = self.watch_ends.lock().unwrap().remove(&viewer);
        match ending {
            Some(WatchEnd::Viewer(agent)) => {
                agent.send(AgentCommand::RemoveViewer { viewer }).await;
            }
            Some(WatchEnd::Person(person)) => drop(person),
            None => {}
        }
    }

    /// An agent's screen: what it shows now, then its output, redraws and exit, as viewer
    /// `viewer` of the agent.
    async fn watch_screen(
        &self,
        client: &Client,
        args: ScreenWatchArgs,
        viewer: u64,
    ) -> Result<Watch, ErrorBody> {
        let agent = self.terminal_agent(&args.agent, client.agent.as_deref())?;
        let (tx, mut feed) = viewer_channel();
        let stalled = feed.stalled();
        let (reply, drawn) = oneshot::channel();
        let added = AgentCommand::AddViewer {
            viewer,
            tx,
            keep_scrollback: args.keep_scrollback,
            include_scrollback: args.include_scrollback,
            reply,
        };
        if !agent.send(added).await {
            return Err(actor_stopped(&agent));
        }
        let drawn = match tokio::time::timeout(SCREEN_SNAPSHOT_TIMEOUT, drawn).await {
            Ok(drawn) => drawn.map_err(|_| actor_stopped(&agent))?,
            Err(_) => {
                // A timeout, not an empty snapshot; the viewer that waits goes.
                agent.send(AgentCommand::RemoveViewer { viewer }).await;
                let message = format!(
                    "#{} did not draw its screen within {} seconds",
                    agent.id(),
                    SCREEN_SNAPSHOT_TIMEOUT.as_secs()
                );
                return Err(ErrorBody::new(Reason::Unavailable, message));
            }
        };
        let snapshot = ScreenSnapshot {
            agent_id: agent.id().to_string(),
            cols: drawn.cols,
            rows: drawn.rows,
            redraw: facade_base::base64::encode(&drawn.redraw),
            exit: drawn.exit,
            process: Some(drawn.process),
        };
        self.watch_ends
            .lock()
            .unwrap()
            .insert(viewer, WatchEnd::Viewer(agent.clone()));
        let (changes, sent) = mpsc::channel(CHANGES_WAITING);
        tokio::spawn(async move {
            let forwarding = async {
                while let Some(out) = feed.recv().await {
                    let change = screen_change(out);
                    let last = change == ScreenChange::Removed;
                    if !send(&changes, &change).await || last {
                        return;
                    }
                }
            };
            tokio::select! {
                () = forwarding => {}
                () = changes.closed() => {}
                _ = stalled => {
                    // The viewer fell too far behind across resumes. Its client is disconnected,
                    // and can watch a fresh snapshot.
                    facade_base::log::write("daemon", "warn", &format!(
                        "disconnecting a client whose screen viewer of {} fell too far behind",
                        agent.id()
                    ));
                    let _ = changes.send(WatchChange::Disconnect).await;
                }
            }
            agent.send(AgentCommand::RemoveViewer { viewer }).await;
        });
        Ok(Watch {
            snapshot: value_of(snapshot),
            changes: sent,
        })
    }

    /// The agents in the client's reach as its watch began: an agent out of reach stays unknown
    /// to the client, and so does its removal.
    fn watch_agents(self: &Arc<Self>, client: &Client) -> Watch {
        let reach = self.reach_of_client(client);
        let mut following = self.changes.subscribe();
        let reached = |infos: Vec<AgentInfo>| -> Vec<AgentInfo> {
            infos
                .into_iter()
                .filter(|info| reach.reaches(info))
                .collect()
        };
        let snapshot = reached(self.agent_infos());
        let mut known: HashSet<String> =
            snapshot.iter().map(|info| info.agent_id.clone()).collect();
        let (changes, sent) = mpsc::channel(CHANGES_WAITING);
        let daemon = self.clone();
        tokio::spawn(async move {
            loop {
                let received = match following.recv().await {
                    Ok(change) => vec![change],
                    Err(RecvError::Lagged(_)) => {
                        let now = daemon.agent_infos();
                        let now = now.into_iter().filter(|info| reach.reaches(info)).collect();
                        resync_agents(&known, now)
                    }
                    Err(RecvError::Closed) => return,
                };
                for change in received {
                    match &change {
                        AgentsChange::Updated { agent } if !reach.reaches(agent) => continue,
                        AgentsChange::Updated { agent } => {
                            known.insert(agent.agent_id.clone());
                        }
                        AgentsChange::Removed { agent_id }
                            if !known.remove(agent_id) && reach != Reach::All =>
                        {
                            continue;
                        }
                        AgentsChange::Removed { .. } | AgentsChange::Unknown => {}
                    }
                    if !send(&changes, &change).await {
                        return;
                    }
                }
            }
        });
        Watch {
            snapshot: value_of(&snapshot),
            changes: sent,
        }
    }

    /// An inbox's messages. An editor window reads the person's inbox, and follows the messages
    /// its own agents send the person; any other client reads the inbox of the agent it acts for.
    fn watch_messages(
        self: &Arc<Self>,
        client: &Client,
        args: MessagesWatchArgs,
        viewer: u64,
    ) -> Result<Watch, ErrorBody> {
        let window = client.window.clone();
        let owner = match &window {
            Some(_) => HUMAN.to_string(),
            None => self.listed_actor(client.agent.as_deref())?,
        };
        // Subscribed before the window counts as one that can tell the person.
        let mut following = self.messages.subscribe();
        if let Some(window) = window.as_deref() {
            let person = self.windows.watch_person(window);
            self.watch_ends
                .lock()
                .unwrap()
                .insert(viewer, WatchEnd::Person(person));
        }
        let snapshot = self.messages.read(&owner, &args)?;
        // What this watch gave, so that a resync after a lag removes those no longer kept.
        let mut known: HashSet<String> = snapshot
            .messages
            .iter()
            .map(|message| message.message_id.clone())
            .collect();
        let (changes, sent) = mpsc::channel(CHANGES_WAITING);
        let daemon = self.clone();
        tokio::spawn(async move {
            let followed = |to: &str, from: &str| {
                to == owner
                    && window
                        .as_deref()
                        .is_none_or(|window| daemon.sent_from(from, window))
            };
            loop {
                let received = match following.recv().await {
                    Ok(change) if followed(change.to(), change.from()) => vec![change],
                    Ok(_) => continue,
                    Err(RecvError::Lagged(_)) => {
                        let inbox = daemon.messages.inbox(&owner);
                        let inbox = inbox
                            .into_iter()
                            .filter(|message| followed(&message.to, &message.from))
                            .collect();
                        resync_messages(&known, inbox, &owner)
                    }
                    Err(RecvError::Closed) => return,
                };
                for change in received {
                    let change = match change {
                        Change::Updated(message) => {
                            known.insert(message.message_id.clone());
                            MessagesChange::Updated { message }
                        }
                        Change::Removed { message_id, .. } => {
                            known.remove(&message_id);
                            MessagesChange::Removed { message_id }
                        }
                    };
                    if !send(&changes, &change).await {
                        return;
                    }
                    // Tests hold a watch here to make it lag.
                    crate::gate_for_test("after-messages-change");
                }
            }
        });
        Ok(Watch {
            snapshot: value_of(&snapshot),
            changes: sent,
        })
    }

    /// The windows. A client acting for an agent sees in each which CLIs a start by that agent can
    /// run. The terminal window changes with its agents.
    async fn watch_windows(self: &Arc<Self>, client: &Client) -> Watch {
        let clis = match client.agent.as_deref() {
            Some(agent) => self.cli_infos(agent).await,
            None => Clis::default(),
        };
        let mut following = self.windows.subscribe();
        let mut agents = self.changes.subscribe();
        let snapshot = self.window_infos(&clis);
        let mut known: HashSet<String> = snapshot
            .iter()
            .map(|window| window.window_id.clone())
            .collect();
        let mut terminal = self.terminal_window();
        let (changes, sent) = mpsc::channel(CHANGES_WAITING);
        let daemon = self.clone();
        tokio::spawn(async move {
            loop {
                let received = tokio::select! {
                    change = following.recv() => match change {
                        Ok(change) => vec![change],
                        Err(RecvError::Lagged(_)) => {
                            resync_windows(&known, daemon.window_infos(&Clis::default()))
                        }
                        Err(RecvError::Closed) => return,
                    },
                    change = agents.recv() => match change {
                        Ok(_) | Err(RecvError::Lagged(_)) => {
                            let now = daemon.terminal_window();
                            if now == terminal {
                                continue;
                            }
                            terminal = now.clone();
                            vec![match now {
                                Some(window) => WindowsChange::Updated { window: Box::new(window) },
                                None => WindowsChange::Removed {
                                    window_id: TERMINAL_WINDOW.into(),
                                },
                            }]
                        }
                        Err(RecvError::Closed) => return,
                    },
                };
                for mut change in received {
                    match &mut change {
                        WindowsChange::Updated { window } => {
                            clis.show_in(window);
                            known.insert(window.window_id.clone());
                        }
                        WindowsChange::Removed { window_id } => {
                            known.remove(window_id);
                        }
                        WindowsChange::Unknown => {}
                    }
                    if !send(&changes, &change).await {
                        return;
                    }
                }
            }
        });
        Watch {
            snapshot: value_of(&snapshot),
            changes: sent,
        }
    }

    /// The reach of `client`: the person's is everything.
    fn reach_of_client(&self, client: &Client) -> Reach {
        let acting = client.agent.as_deref();
        let caller = acting
            .and_then(|id| self.get_agent(id))
            .map(|agent| agent.info());
        records::reach_of(acting, caller.as_ref())
    }

    /// The agent the client acts for, whose inbox the messages topic reads; it must be listed.
    fn listed_actor(&self, agent: Option<&str>) -> Result<String, ErrorBody> {
        let Some(agent) = agent else {
            return Err(ErrorBody::invalid_argument(
                "the messages topic reads the inbox of the agent this client acts for, and this \
                 client acts for none",
            ));
        };
        if self.get_agent(agent).is_none() {
            let message = format!("#{agent}, the agent this client acts for, is not listed");
            return Err(ErrorBody::new(Reason::NotFound, message));
        }
        Ok(agent.to_string())
    }

    /// Whether `from`, a message's sender, is an agent of window `id`.
    fn sent_from(&self, from: &str, id: &str) -> bool {
        self.get_agent(from)
            .is_some_and(|agent| agent.info().window_id == id)
    }

    /// The windows: the editor windows, then the terminal window while it holds running agents,
    /// each showing `clis`.
    fn window_infos(&self, clis: &Clis) -> Vec<WindowInfo> {
        let mut infos = self.windows.infos();
        infos.extend(self.terminal_window());
        for info in &mut infos {
            clis.show_in(info);
        }
        infos
    }

    /// The terminal window while it holds running agents: its locations are the folders they
    /// work in.
    fn terminal_window(&self) -> Option<WindowInfo> {
        let mut locations: Vec<LocationInfo> = Vec::new();
        let running = self.agent_infos().into_iter().filter(|info| {
            info.window_id == TERMINAL_WINDOW
                && info.process == facade_base::process::ProcessState::Running
        });
        for info in running {
            if locations.iter().any(|location| location.path == info.cwd) {
                continue;
            }
            let label = std::path::Path::new(&info.cwd).file_name().map_or_else(
                || info.cwd.clone(),
                |name| name.to_string_lossy().into_owned(),
            );
            locations.push(LocationInfo {
                location_id: info.location_id.clone(),
                label,
                path: info.cwd.clone(),
                kind: LocationKind::Folder,
            });
        }
        (!locations.is_empty()).then(|| WindowInfo {
            window_id: TERMINAL_WINDOW.into(),
            label: TERMINAL_WINDOW_LABEL.into(),
            environment: "local".into(),
            connected: true,
            folders: Vec::new(),
            locations,
            problems: Vec::new(),
            observed_at: Some(facade_base::time::iso_now()),
            clis: Vec::new(),
            settings_problem: None,
        })
    }
}

/// Sends one change on to the server: false once it no longer takes them.
async fn send(changes: &mpsc::Sender<WatchChange>, change: &impl Serialize) -> bool {
    changes
        .send(WatchChange::Change(value_of(change)))
        .await
        .is_ok()
}

fn screen_change(out: ViewerChange) -> ScreenChange {
    match out {
        ViewerChange::Redraw { bytes, cols, rows } => ScreenChange::Redraw {
            data: facade_base::base64::encode(&bytes),
            cols,
            rows,
        },
        ViewerChange::Output(bytes) => ScreenChange::Output {
            data: facade_base::base64::encode(&bytes),
        },
        ViewerChange::Exit(exit) => ScreenChange::Exit { exit },
        ViewerChange::Removed => ScreenChange::Removed,
    }
}

/// What brings a client that knew the agents `known` to the agents `now`.
fn resync_agents(known: &HashSet<String>, now: Vec<AgentInfo>) -> Vec<AgentsChange> {
    let gone = known
        .iter()
        .filter(|id| !now.iter().any(|info| &info.agent_id == *id))
        .map(|id| AgentsChange::Removed {
            agent_id: id.clone(),
        });
    let mut changes: Vec<AgentsChange> = gone.collect();
    changes.extend(now.into_iter().map(|info| AgentsChange::Updated {
        agent: Box::new(info),
    }));
    changes
}

/// What brings a client that knew the windows `known` to the windows `now`.
fn resync_windows(known: &HashSet<String>, now: Vec<WindowInfo>) -> Vec<WindowsChange> {
    let gone = known
        .iter()
        .filter(|id| !now.iter().any(|info| &info.window_id == *id))
        .map(|id| WindowsChange::Removed {
            window_id: id.clone(),
        });
    let mut changes: Vec<WindowsChange> = gone.collect();
    changes.extend(now.into_iter().map(|window| WindowsChange::Updated {
        window: Box::new(window),
    }));
    changes
}

/// What brings a client that was given the messages `known` to `owner`'s inbox as it stands:
/// every message of it again, after the removal of those no longer kept.
fn resync_messages(known: &HashSet<String>, inbox: Vec<Message>, owner: &str) -> Vec<Change> {
    let kept: HashSet<&str> = inbox
        .iter()
        .map(|message| message.message_id.as_str())
        .collect();
    let gone = known
        .iter()
        .filter(|id| !kept.contains(id.as_str()))
        .map(|id| Change::Removed {
            message_id: id.clone(),
            from: String::new(),
            to: owner.to_string(),
        });
    let mut changes: Vec<Change> = gone.collect();
    changes.extend(
        inbox
            .into_iter()
            .map(|message| Change::Updated(Box::new(message))),
    );
    changes
}

/// What ending a watch lets go of, by its viewer number.
pub(crate) enum WatchEnd {
    /// A screen watch's viewer of this agent.
    Viewer(AgentHandle),
    /// A window's messages watch, which counts as one that can tell the person.
    Person(crate::windows::PersonWatch),
}
