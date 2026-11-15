//! Who comes and goes besides the agents Facade starts: guests, the sessions people start that
//! join through a hook, and editor windows. Guests and windows keep their own registers; the
//! daemon lists, publishes and removes the agents that go with them, in the orders
//! docs/core/ARCHITECTURE.md gives for a window's takeover and a guest's join and end.

use std::sync::Arc;

use facade_base::daemon::{
    AgentState, AgentsChange, HookSession, LocationInfo, TERMINAL_WINDOW, WindowDescription,
    WorktreeCreateArgs,
};
use facade_base::jsonrpc::ErrorBody;
use facade_base::process::ProcessState;
use tokio::sync::mpsc;

use crate::agent::AgentHandle;
use crate::guests::{GuestEvent, Guests, SessionMatch};
use crate::windows::{LocationsRead, WindowConnection, WindowEvent};
use crate::{Daemon, blocking_in_place, command_line, gate_for_test, log};

/// What a hook reports on: a guest; a part of a guest's session, such as a subagent's, which acts
/// for the guest but whose turns are not the guest's; or a session of the run Facade started that
/// the hook's client acts for, which the hook leaves alone.
pub(crate) enum HookTarget {
    Guest(AgentHandle),
    Part(AgentHandle),
    OwnRun,
}

impl Daemon {
    /// The guest a hook of `session` reports on, joining it where it is new. `client` is the agent
    /// the hook's client acts for, where it acts for one.
    pub(crate) async fn hook_target(
        self: &Arc<Self>,
        client: Option<&str>,
        session: &HookSession,
    ) -> Result<HookTarget, ErrorBody> {
        let (whole, found) = self.guests.find(session)?;
        let part = whole.session != session.session;
        let guest = match found {
            SessionMatch::Guest(id) | SessionMatch::Part(id) => self.get_agent(&id),
            SessionMatch::New => None,
        };
        let target = match guest {
            Some(guest) => {
                if let Some(pid) = whole.pid {
                    self.guests
                        .heard_from(guest.id(), &whole.cli, &whole.session, Some(pid))
                        .await;
                }
                HookTarget::Guest(guest)
            }
            None if self.is_own_run(client, &whole) => HookTarget::OwnRun,
            None => HookTarget::Guest(self.join_guest(&whole).await?),
        };
        Ok(match target {
            HookTarget::Guest(guest) if part => HookTarget::Part(guest),
            other => other,
        })
    }

    /// Whether `session` is the run the hook's client acts for: a Facade run of the same CLI whose
    /// session is this one, or not known yet.
    fn is_own_run(&self, client: Option<&str>, session: &HookSession) -> bool {
        let Some(run) = client.and_then(|id| self.get_agent(id)) else {
            return false;
        };
        let info = run.info();
        !info.guest
            && info.cli == session.cli
            && info
                .session
                .as_ref()
                .is_none_or(|own| *own == session.session)
    }

    /// Joins `session` as a guest: records numbers it, the record is kept, the guest is listed,
    /// and only then does guests register its session, so that a hook right after either waits to
    /// join or finds the guest listed.
    async fn join_guest(self: &Arc<Self>, session: &HookSession) -> Result<AgentHandle, ErrorBody> {
        let _joining = self.guests.joining().await;
        if let Some(guest) = self
            .guests
            .guest_of(&session.cli, &session.session)
            .and_then(|id| self.get_agent(&id))
        {
            return Ok(guest);
        }
        let id = self.records.next_id().await?;
        let name = self.reserve_name(
            TERMINAL_WINDOW,
            &id,
            command_line::settings_names().as_deref(),
        );
        let (info, record) = Guests::info_of(&id, &name, session);
        if let Err(error) = self.guests.keep(&record).await {
            self.records.release_name(&name);
            return Err(error);
        }
        let guest = AgentHandle::guest(info.clone());
        {
            let mut agents = self.agents.lock().unwrap();
            agents.insert(id.clone(), guest.clone());
            self.records.release_name(&name);
        }
        self.guests.register(&id, session).await;
        self.publish(info);
        Ok(guest)
    }

    /// Ends the guest of `cli`'s `session`, as its session-end hook or its process's end says.
    pub(crate) fn end_guest(&self, cli: &str, session: &str) {
        if let Some(id) = self.guests.end(cli, session) {
            self.end_listed_guest(&id);
        }
    }

    /// Takes guest `id` out of the list: its record says it ended first, then its record goes with
    /// its inbox in one transaction, and watchers learn of each message that went.
    pub(crate) fn end_listed_guest(&self, id: &str) {
        let Some(guest) = self.agents.lock().unwrap().remove(id) else {
            return;
        };
        guest.mark_ended();
        // Its record and inbox go before anything else can settle: a result its start's prompt
        // owes it is then never written.
        let gone = match blocking_in_place(|| self.store.delete_guest(id)) {
            Ok(gone) => gone,
            Err(err) => {
                log("warn", &format!("{err:#}"));
                Vec::new()
            }
        };
        gate_for_test("before-guest-inbox-removal");
        self.messages.drop_inbox(id, gone);
        let _ = self.changes.send(AgentsChange::Removed {
            agent_id: id.to_string(),
        });
    }

    /// Facade heard from `guest` at a hook that gave `env`: a guest with no environment kept, as
    /// after a restart, keeps this one, and a hook that began a turn or the session (`turn`) is
    /// noted as when Facade last heard from it.
    pub(crate) async fn heard_from(
        &self,
        guest: &AgentHandle,
        env: Option<&std::collections::BTreeMap<String, String>>,
        turn: bool,
    ) {
        if env.is_some() && self.guests.environment(guest.id()).is_none() {
            self.guests.keep_environment(guest.id(), env);
        }
        if turn {
            let info = guest.info();
            let session = info.session.unwrap_or_default();
            self.guests
                .heard_from(guest.id(), &info.cli, &session, None)
                .await;
        }
    }

    /// A guest's turn began or ended: it reads `state`.
    pub(crate) fn guest_state(&self, guest: &AgentHandle, state: AgentState) {
        if let Some(info) = guest.set_guest_state(state) {
            self.publish(info);
        }
    }

    /// Lists again the guests a daemon before this one had; ends those that ended meanwhile, by
    /// the machine's restart or 30 days without a word, with their inboxes.
    pub(crate) fn restore_guests(&self) -> anyhow::Result<()> {
        let kept_since = facade_base::time::iso_time(
            std::time::SystemTime::now()
                .checked_sub(crate::messages::KEPT_FOR)
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH),
        );
        let restored = self.guests.restore(&kept_since)?;
        for record in restored.ended {
            blocking_in_place(|| self.store.delete_guest(&record.agent_id))?;
        }
        let mut agents = self.agents.lock().unwrap();
        for info in restored.listed {
            agents.insert(info.agent_id.clone(), AgentHandle::guest(info));
        }
        Ok(())
    }

    /// Ends the guests not heard from since `before`.
    pub(crate) fn end_unheard_guests(&self, before: &str) {
        for (cli, session) in self.guests.unheard(before) {
            self.end_guest(&cli, &session);
        }
    }

    /// An editor window connected (`hello` of an `ide` client): its description is saved, a window
    /// it takes over hands it its agents, and its locations are read. The connection counts until
    /// it is dropped.
    pub(crate) async fn window_connected(
        self: &Arc<Self>,
        description: WindowDescription,
    ) -> Result<WindowConnection, ErrorBody> {
        crate::windows::Windows::check(&description)?;
        self.describe_window(&description, true).await;
        Ok(self.windows.connection(&description.id))
    }

    /// A connected window described itself again (`window.update`).
    pub(crate) async fn window_updated(
        self: &Arc<Self>,
        description: WindowDescription,
    ) -> Result<(), ErrorBody> {
        crate::windows::Windows::check(&description)?;
        self.describe_window(&description, false).await;
        Ok(())
    }

    async fn describe_window(self: &Arc<Self>, description: &WindowDescription, connecting: bool) {
        let before = self.windows.folders(&description.id);
        for from in self.windows.describe(description, connecting) {
            self.take_over_window(&from, &description.id);
        }
        if let Some(read) = self
            .windows
            .read_locations(&description.id, Some(before))
            .await
        {
            self.stop_gone(&description.id, &read);
        }
    }

    /// Moves the agents of window `from`, which has no connection left, to window `to` that took
    /// it over: in one transaction, then in the list.
    fn take_over_window(&self, from: &str, to: &str) {
        if let Err(err) = blocking_in_place(|| self.store.take_over(from, to)) {
            log("warn", &format!("{err:#}"));
        }
        for agent in self.agents() {
            if let Some(info) = agent.move_window(from, to) {
                self.publish(info);
            }
        }
        log(
            "info",
            &format!(
                "window {to} took over the agents of window {from}, which had no connection left"
            ),
        );
        self.windows.taken_over(from);
    }

    /// The running agents of window `id`.
    fn running_in(&self, id: &str) -> Vec<AgentHandle> {
        self.agents()
            .into_iter()
            .filter(|agent| {
                let info = agent.info();
                info.window_id == id && info.process == ProcessState::Running
            })
            .collect()
    }

    /// Stops the running agents of window `id` whose location `read` says is gone.
    fn stop_gone(self: &Arc<Self>, id: &str, read: &LocationsRead) {
        for agent in self.running_in(id) {
            let cwd = agent.info().cwd;
            if !read.is_gone(&cwd) {
                continue;
            }
            log(
                "info",
                &format!(
                    "#{} ends: its location {cwd} is gone from window {id}",
                    agent.id()
                ),
            );
            let daemon = self.clone();
            tokio::spawn(async move {
                let _ = daemon.stop(&agent).await;
            });
        }
    }

    /// Makes a worktree in a window's location and answers with the new location
    /// (`worktree.create`); an agent whose folder is gone from the window's locations ends.
    pub(crate) async fn create_worktree(
        self: &Arc<Self>,
        args: WorktreeCreateArgs,
    ) -> Result<LocationInfo, ErrorBody> {
        let window = args.window_id.clone();
        let (location, read) = self.windows.create_worktree(args).await?;
        if let Some(read) = read {
            self.stop_gone(&window, &read);
        }
        Ok(location)
    }

    /// Lists again the windows a daemon before this one knew that still have running agents, each
    /// waiting out its grace for its window to come back.
    pub(crate) fn restore_windows(&self) {
        let owners: Vec<String> = self
            .agents()
            .iter()
            .map(AgentHandle::info)
            .filter(|info| info.process == ProcessState::Running)
            .map(|info| info.window_id)
            .collect();
        for id in self.windows.restore(&owners) {
            self.windows.start_grace(&id, 1);
        }
    }
}

/// Handles what windows report: a window whose last connection went waits out its grace where it
/// has running agents, and one whose grace ended without it coming back has them stopped.
pub(crate) async fn follow_windows(
    daemon: Arc<Daemon>,
    mut events: mpsc::UnboundedReceiver<WindowEvent>,
) {
    while let Some(event) = events.recv().await {
        match event {
            WindowEvent::Left {
                window_id,
                departure,
            } => {
                if daemon.running_in(&window_id).is_empty() {
                    daemon.windows.forget(&window_id, departure);
                } else {
                    daemon.windows.start_grace(&window_id, departure);
                }
            }
            WindowEvent::GraceEnded {
                window_id,
                departure,
            } => {
                let agents = daemon.running_in(&window_id);
                log(
                    "info",
                    &format!(
                        "window {window_id} did not come back in time: its {} running agents end",
                        agents.len()
                    ),
                );
                let daemon = daemon.clone();
                tokio::spawn(async move {
                    let mut stops = tokio::task::JoinSet::new();
                    for agent in agents {
                        let daemon = daemon.clone();
                        stops.spawn(async move { daemon.stop(&agent).await });
                    }
                    stops.join_all().await;
                    daemon.windows.forget(&window_id, departure);
                });
            }
        }
    }
}

/// Handles what guests report: a guest whose process ended ends, and one whose session file says
/// its turn ended reads `idle`.
pub(crate) async fn follow_guests(
    daemon: Arc<Daemon>,
    mut events: mpsc::UnboundedReceiver<GuestEvent>,
) {
    while let Some(event) = events.recv().await {
        match event {
            GuestEvent::Ended { cli, session } => daemon.end_guest(&cli, &session),
            GuestEvent::TurnIdle { id } => {
                if let Some(guest) = daemon.get_agent(&id) {
                    daemon.guest_state(&guest, AgentState::Idle);
                }
            }
        }
    }
}
