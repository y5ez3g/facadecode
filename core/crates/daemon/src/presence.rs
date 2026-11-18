//! Who comes and goes besides the agents Facade starts: guests, the sessions people start that
//! join through a hook, and editor windows. Guests and windows keep their own registers; the
//! daemon lists, publishes and removes the agents that go with them, in the orders
//! docs/core/ARCHITECTURE.md gives for a window's binding and a guest's join and end.

use std::sync::Arc;

use facade_base::daemon::{
    AgentInfo, AgentState, AgentsChange, HookSession, LocationInfo, TERMINAL_WINDOW,
    TerminalColors, WindowDescription, WindowRef, WorktreeCreateArgs,
};
use facade_base::jsonrpc::ErrorBody;
use facade_base::process::ProcessState;
use tokio::sync::mpsc;

use crate::agent::{AgentCommand, AgentHandle, WindowColors};
use crate::guests::{GuestEvent, Guests, SessionMatch};
use crate::windows::{LocationsRead, WindowConnection};
use crate::{Daemon, WindowBinding, blocking_in_place, command_line, gate_for_test, log};

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
            &[self.local_window(TERMINAL_WINDOW)],
            &id,
            command_line::settings_names().as_deref(),
        );
        let (info, record) = Guests::info_of(&id, &name, session);
        let info = self.project_guest(info);
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
        // With its last guest gone, the daemon may become idle.
        self.lifecycle.note_change();
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
            agents.insert(
                info.agent_id.clone(),
                AgentHandle::guest(self.project_guest(info)),
            );
        }
        Ok(())
    }

    /// A guest belongs to this machine's terminal.
    pub(crate) fn project_guest(&self, mut info: AgentInfo) -> AgentInfo {
        info.machine_id = self.machine_id.clone();
        info.windows = vec![self.local_window(TERMINAL_WINDOW)];
        info
    }

    /// Ends the guests not heard from since `before`.
    pub(crate) fn end_unheard_guests(&self, before: &str) {
        for (cli, session) in self.guests.unheard(before) {
            self.end_guest(&cli, &session);
        }
    }

    /// Saves an IDE hello's binding and keeps the connection until its guard goes.
    pub(crate) async fn window_connected(
        self: &Arc<Self>,
        description: WindowDescription,
    ) -> Result<WindowConnection, ErrorBody> {
        if let Some(colors) = &description.colors {
            terminal_colors(colors)?;
        }
        let (connection, before) = self.windows.bind(description).await?;
        self.window_description_changed(connection.binding(), before)
            .await;
        Ok(connection)
    }

    /// A connected window described itself again (`window.update`).
    pub(crate) async fn window_updated(
        self: &Arc<Self>,
        binding: &WindowBinding,
        description: WindowDescription,
    ) -> Result<(), ErrorBody> {
        if let Some(colors) = &description.colors {
            terminal_colors(colors)?;
        }
        let before = self.windows.update(binding, description).await?;
        self.window_description_changed(binding, before).await;
        Ok(())
    }

    async fn window_description_changed(
        self: &Arc<Self>,
        binding: &WindowBinding,
        before: Vec<String>,
    ) {
        if let Some(read) = self.windows.read_locations(binding, Some(before)).await {
            self.stop_gone(&read);
        }
        self.push_colors(binding).await;
    }

    pub(crate) fn window_colors(
        &self,
        window: &WindowRef,
    ) -> Option<facade_screen::TerminalColors> {
        self.windows
            .colors(window)
            .and_then(|colors| terminal_colors(&colors).ok())
    }

    /// The first member with known colors. Descriptions keep the last colors across disconnects.
    pub(crate) fn first_member_colors(&self, members: &[WindowRef]) -> Option<WindowColors> {
        members.iter().find_map(|window| {
            self.window_colors(window).map(|colors| WindowColors {
                window: window.clone(),
                colors,
            })
        })
    }

    async fn push_colors(&self, binding: &WindowBinding) {
        let window = &binding.window;
        for agent in self.agents() {
            if !self.windows.is_current(binding) {
                break;
            }
            let info = agent.info();
            if info.guest || !info.windows.contains(window) {
                continue;
            }
            let command = match agent.color_source() {
                Some(source) if source == *window => Some(AgentCommand::WindowColorsChanged {
                    colors: WindowColors {
                        window: source,
                        colors: self.window_colors(window).unwrap_or_default(),
                    },
                    allow_initial: false,
                }),
                None => self.first_member_colors(&info.windows).map(|colors| {
                    AgentCommand::WindowColorsChanged {
                        colors,
                        allow_initial: true,
                    }
                }),
                Some(_) => None,
            };
            if let Some(command) = command {
                agent.send(command).await;
            }
        }
    }

    /// Stops only the same run whose source binding reported that its location went away.
    fn stop_gone(self: &Arc<Self>, read: &LocationsRead) {
        let binding = read.binding();
        if !self.windows.is_current(binding) {
            return;
        }
        for agent in self.agents() {
            let (run, info) = agent.installed_record();
            if info.process != ProcessState::Running
                || info.location_source_window.as_ref() != Some(&binding.window)
                || !read.is_gone(&info.cwd)
            {
                continue;
            }
            let daemon = self.clone();
            let binding = binding.clone();
            tokio::spawn(async move {
                let _changing = agent.lock_run_change().await;
                let (installed, current) = agent.installed_record();
                if installed == run
                    && current.process == ProcessState::Running
                    && daemon.windows.is_current(&binding)
                {
                    log(
                        "info",
                        &format!(
                            "#{} ends: its location {} is gone from window {}",
                            agent.id(),
                            current.cwd,
                            binding.window.window_id
                        ),
                    );
                    let _ = daemon.stop_run(&agent).await;
                }
            });
        }
    }

    /// Makes a worktree at the requested logical window's location or in the terminal.
    pub(crate) async fn create_worktree(
        self: &Arc<Self>,
        args: WorktreeCreateArgs,
    ) -> Result<LocationInfo, ErrorBody> {
        let (location, read) = self.windows.create_worktree(args).await?;
        if let Some(read) = read {
            self.stop_gone(&read);
        }
        Ok(location)
    }

    /// Restores the logical windows before accepting clients.
    pub(crate) fn restore_windows(&self) -> Result<(), ErrorBody> {
        self.windows
            .restore(|window| self.store.delete_empty_window(window))
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

/// `colors` as the screen replies with them; a color that is not `#` and six hexadecimal digits
/// is refused.
fn terminal_colors(colors: &TerminalColors) -> Result<facade_screen::TerminalColors, ErrorBody> {
    let color = |name: &str, text: &Option<String>| -> Result<Option<[u8; 3]>, ErrorBody> {
        let Some(text) = text else {
            return Ok(None);
        };
        let digits = text.strip_prefix('#').filter(|digits| {
            digits.len() == 6 && digits.bytes().all(|byte| byte.is_ascii_hexdigit())
        });
        let Some(digits) = digits else {
            let message = format!("the {name} color {text:?} is not # and six hexadecimal digits");
            return Err(ErrorBody::invalid_argument(message));
        };
        let channel = |at: usize| u8::from_str_radix(&digits[at..at + 2], 16).expect("hex digits");
        Ok(Some([channel(0), channel(2), channel(4)]))
    };
    Ok(facade_screen::TerminalColors {
        foreground: color("foreground", &colors.foreground)?,
        background: color("background", &colors.background)?,
        cursor: color("cursor", &colors.cursor)?,
    })
}
