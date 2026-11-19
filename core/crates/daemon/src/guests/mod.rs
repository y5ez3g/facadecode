//! Guests: the agents Facade did not start but lists, with the integrations through which they
//! come.
//!
//! - A CLI session the person started joins through the CLI's hooks. Facade knows it by the CLI
//!   and the session ID the CLI gives its hooks, its tool calls and the commands its model runs,
//!   never by its processes.
//! - Any other MCP client that reaches Facade's server joins as a member: Facade knows it by its
//!   relay process, the `facade-mcp` it started, which lasts as long as the client is there.
//!
//! The daemon numbers and names a guest and lists it; this module keeps what it knows of each
//! guest in memory and in the `guests` table through [`GuestTable`]. A daemon started anew
//! recovers a relay guest only while the same relay process still runs. The guest keeps its
//! number, inbox and YOLO, and the relay supplies its environment again on reconnect.

mod integration;
mod roster;
mod watch;

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use facade_base::daemon::{
    AgentInfo, AgentState, HookSession, IntegrationArgs, IntegrationInfo, IntegrationListArgs,
    IntegrationListResult, StateDetail, StateReason, ToolsState, is_session_id, location_id,
};
use facade_base::jsonrpc::ErrorBody;
use facade_base::process::{ProcessIdentity, ProcessState};
use facade_base::programs::Held;
use facade_base::unix_process::{self, Presence};
use tokio::sync::mpsc;

use crate::blocking_in_place;
use crate::store::{GuestRecord, GuestTable, IntegrationTable};

use integration::Integrations;
use roster::{Roster, SessionKey};

/// What the daemon hears from its guests without a hook.
pub(crate) enum GuestEvent {
    /// The guest's session ended: the process that ended it exited, for a CLI with no hook for a
    /// session's end, or another session joined from that process.
    Ended { cli: String, session: String },
    /// Its CLI's own file says the turn the guest began ended, though no hook said so.
    TurnIdle { id: String },
}

/// Where the session a hook names stands.
pub(crate) enum SessionMatch {
    /// It is guest `#aN`'s session.
    Guest(String),
    /// It is part of guest `#aN`'s session, as a subagent's: it acts for that guest.
    Part(String),
    /// No guest has it: the daemon decides whether it is a run's own, or joins it.
    New,
}

/// A relay process: its pid and birth together belong to it alone.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct RelayProcess {
    pub(crate) pid: u32,
    pub(crate) birth: String,
}

/// A guest's verified relay and the details it supplied on this connection.
pub(crate) struct GuestJoin {
    pub(crate) process: RelayProcess,
    pub(crate) app: Option<String>,
    /// The relay's directory for display.
    pub(crate) cwd: Option<String>,
    pub(crate) env: BTreeMap<String, String>,
}

impl GuestJoin {
    /// The card and row for a relay joining for the first time, with this machine's current YOLO.
    pub(crate) fn info(&self, id: &str, name: &str) -> (AgentInfo, GuestRecord) {
        joined(
            id,
            name,
            self.app.as_deref().unwrap_or(ANY_CLIENT),
            &member_session(&self.process),
            self.cwd.clone().unwrap_or_default(),
            guest_yolo(),
        )
    }
}

/// The kept guests a daemon started anew found.
pub(crate) struct Restored {
    /// The records the daemon can list again.
    pub(crate) listed: Vec<AgentInfo>,
    /// Those that ended while no daemon ran: the daemon deletes them with their inbox.
    pub(crate) ended: Vec<GuestRecord>,
}

/// The guests listed, and the integrations.
pub(crate) struct Guests {
    roster: Arc<Mutex<Roster>>,
    /// Held while a relay or hook session joins, so that it gets one guest record.
    joining: tokio::sync::Mutex<()>,
    table: GuestTable,
    events: mpsc::UnboundedSender<GuestEvent>,
    integrations: Integrations,
}

/// The client name a member takes where its own is missing or not a name Facade lists.
const ANY_CLIENT: &str = "mcp";

impl Guests {
    pub(crate) fn new(
        guests: GuestTable,
        integrations: IntegrationTable,
        held: Arc<Held>,
        events: mpsc::UnboundedSender<GuestEvent>,
    ) -> Guests {
        Guests {
            roster: Arc::default(),
            joining: tokio::sync::Mutex::new(()),
            table: guests,
            events,
            integrations: Integrations::new(integrations, held),
        }
    }

    /// The session `session` acts for, and whether a guest has it. The hook's `part_of_session`, or
    /// what an earlier hook said of it, makes it part of another. The roster records that relation
    /// before finding the whole session.
    pub(crate) fn find(
        &self,
        session: &HookSession,
    ) -> Result<(HookSession, SessionMatch), ErrorBody> {
        let names = [
            Some(&session.cli),
            Some(&session.session),
            session.part_of_session.as_ref(),
        ];
        if !names.into_iter().flatten().all(|name| is_session_id(name)) {
            return Err(ErrorBody::invalid_argument(
                "a hook names its CLI and its session: 1 to 128 letters, digits, `_`, `.`, `:` \
                 or `-` each",
            ));
        }
        let mut roster = self.roster.lock().unwrap();
        if let Some(whole) = &session.part_of_session {
            roster.note_part(&session.cli, &session.session, whole);
        }
        let whole = roster.whole_of(&session.cli, &session.session);
        let guest = roster.guest_of(&session.cli, &whole).cloned();
        if whole == session.session {
            let found = guest.map_or(SessionMatch::New, SessionMatch::Guest);
            return Ok((session.clone(), found));
        }
        let whole = HookSession {
            session: whole,
            part_of_session: None,
            ..session.clone()
        };
        Ok((whole, guest.map_or(SessionMatch::New, SessionMatch::Part)))
    }

    /// Held by the daemon while it joins a session.
    pub(crate) async fn joining(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.joining.lock().await
    }

    /// The guest of `cli`'s `session`.
    pub(crate) fn guest_of(&self, cli: &str, session: &str) -> Option<String> {
        self.roster.lock().unwrap().guest_of(cli, session).cloned()
    }

    /// The record of guest `id`, named `name`, which joins with `session`: in the terminal window,
    /// at its CLI's folder, reading `unknown` until its hooks say more.
    pub(crate) fn info_of(id: &str, name: &str, session: &HookSession) -> (AgentInfo, GuestRecord) {
        let cwd = session.cwd.clone().unwrap_or_default();
        joined(id, name, &session.cli, &session.session, cwd, guest_yolo())
    }

    /// Commits the record of a guest that joins, before the daemon lists it.
    pub(crate) async fn keep(&self, record: &GuestRecord) -> Result<(), ErrorBody> {
        blocking_in_place(|| self.table.keep_guest(record)).map_err(ErrorBody::internal)
    }

    /// Commits a relay guest and its first YOLO together, before the daemon lists it.
    pub(crate) fn keep_member(&self, record: &GuestRecord, yolo: bool) -> Result<(), ErrorBody> {
        blocking_in_place(|| self.table.keep_snapshot(record, Some(yolo)))
            .map_err(ErrorBody::internal)
    }

    /// Notes that `session` is guest `id`'s, once the daemon listed it, with its CLI's environment.
    /// Where the hook names the CLI's process, its end ends the session.
    pub(crate) async fn register(&self, id: &str, session: &HookSession) {
        {
            let mut roster = self.roster.lock().unwrap();
            let key = (session.cli.clone(), session.session.clone());
            roster.sessions.insert(key, id.to_string());
            if let Some(env) = &session.env {
                roster.environments.insert(id.to_string(), env.clone());
            }
        }
        if let Some(pid) = session.pid {
            self.end_with(&session.cli, &session.session, pid).await;
        }
    }

    /// `sessions`, a part replaced by the whole session it is part of.
    pub(crate) fn whole_sessions(&self, sessions: &[String]) -> Vec<String> {
        let roster = self.roster.lock().unwrap();
        sessions
            .iter()
            .map(|session| roster.whole_of_any(session))
            .collect()
    }

    /// Whether a guest is listed.
    pub(crate) fn any_guest(&self) -> bool {
        let roster = self.roster.lock().unwrap();
        !roster.sessions.is_empty() || !roster.members.is_empty()
    }

    /// Keeps `env` as the environment of guest `id`'s CLI, the agents it starts run with.
    pub(crate) fn keep_environment(&self, id: &str, env: Option<&BTreeMap<String, String>>) {
        if let Some(env) = env {
            let mut roster = self.roster.lock().unwrap();
            roster.environments.insert(id.to_string(), env.clone());
        }
    }

    /// The environment of guest `id`, as its relay or hooks gave it.
    pub(crate) fn environment(&self, id: &str) -> Option<BTreeMap<String, String>> {
        self.roster.lock().unwrap().environments.get(id).cloned()
    }

    /// Facade heard from guest `id`, `cli`'s `session`, now: the store notes when. A guest listed
    /// again after a restart is watched for its process's end from the first hook that names it.
    pub(crate) async fn heard_from(&self, id: &str, cli: &str, session: &str, pid: Option<u32>) {
        let at = facade_base::time::iso_now();
        if let Err(err) = blocking_in_place(|| self.table.heard_from_guest(id, &at)) {
            log("warn", &format!("{err:#}"));
        }
        let key: SessionKey = (cli.to_string(), session.to_string());
        let watched = self.roster.lock().unwrap().watched.contains_key(&key);
        if let Some(pid) = pid.filter(|_| !watched) {
            self.end_with(cli, session, pid).await;
        }
    }

    /// Follows the turn guest `id` just began, where its prompt hook named the file in which its CLI
    /// reports how the session stands: `idle` there, written since the turn began, ends the turn,
    /// as a turn the person cut short ends with no hook.
    pub(crate) fn follow_turn(&self, id: &str, session: &HookSession) {
        if let Some(file) = &session.status_file {
            watch::follow_turn(&self.roster, &self.events, id, &session.session, file);
        }
    }

    /// Lets go of `cli`'s hook session and its parts. The daemon then unlists the guest and
    /// deletes it with its inbox.
    pub(crate) fn end(&self, cli: &str, session: &str) -> Option<String> {
        self.roster.lock().unwrap().end(cli, session)
    }

    /// Restores live relay guests and the hook sessions still within their retention period.
    pub(crate) fn restore(&self, kept_since: &str) -> anyhow::Result<Restored> {
        let started = unix_process::boot_time().map(facade_base::time::iso_time);
        let mut restored = Restored {
            listed: Vec::new(),
            ended: Vec::new(),
        };
        let mut members = Vec::new();
        for record in blocking_in_place(|| self.table.guests())? {
            let ended = match member_process(&record.session) {
                Some(process) => {
                    let rebooted = started
                        .as_deref()
                        .is_some_and(|started| record.heard_at.as_str() < started);
                    if !rebooted
                        && blocking_in_place(|| unix_process::presence(&process))?
                            != Presence::Ended
                    {
                        members.push(record);
                        continue;
                    }
                    Some("its relay ended")
                }
                None => ended_at_start(&record.heard_at, started.as_deref(), kept_since),
            };
            if let Some(why) = ended {
                log("info", &format!("#{} ended: {why}", record.agent_id));
                restored.ended.push(record);
                continue;
            }
            self.roster.lock().unwrap().list_session(&record);
            restored.listed.push(guest_info(&record, guest_yolo()));
        }
        restored.listed.extend(self.restore_members(members)?);
        Ok(restored)
    }

    /// Restores rows whose relay the daemon has found still running.
    pub(crate) fn restore_members(
        &self,
        records: Vec<GuestRecord>,
    ) -> Result<Vec<AgentInfo>, ErrorBody> {
        let mut listed = Vec::with_capacity(records.len());
        let mut migration_yolo = None;
        for record in records {
            let yolo = match blocking_in_place(|| self.table.snapshot_yolo(&record.agent_id))
                .map_err(ErrorBody::internal)?
            {
                Some(yolo) => yolo,
                None => {
                    let yolo = *migration_yolo.get_or_insert_with(guest_yolo);
                    self.keep_member(&record, yolo)?;
                    yolo
                }
            };
            listed.push(guest_info(&record, yolo));
            self.roster
                .lock()
                .unwrap()
                .members
                .insert(record.session, record.agent_id);
        }
        Ok(listed)
    }

    /// The hook sessions Facade has not heard from since `before`.
    pub(crate) fn unheard(&self, before: &str) -> Vec<(String, String)> {
        let records = match blocking_in_place(|| self.table.guests_heard_before(before)) {
            Ok(records) => records,
            Err(err) => {
                log("warn", &format!("{err:#}"));
                return Vec::new();
            }
        };
        records
            .into_iter()
            .filter(|record| member_process(&record.session).is_none())
            .map(|record| {
                log(
                    "info",
                    &format!(
                        "#{} ended: Facade had not heard from its session since {}",
                        record.agent_id, record.heard_at
                    ),
                );
                (record.cli, record.session)
            })
            .collect()
    }

    /// The member whose relay is `relay`.
    pub(crate) fn member_of(&self, relay: &RelayProcess) -> Option<String> {
        self.roster
            .lock()
            .unwrap()
            .members
            .get(&member_session(relay))
            .cloned()
    }

    /// The record of member `id`, named `name`: the MCP client `client`, by the name it gave, whose
    /// relay is `relay`, at `cwd`.
    pub(crate) fn member_info(
        id: &str,
        name: &str,
        client: &str,
        relay: &RelayProcess,
        cwd: &str,
    ) -> (AgentInfo, GuestRecord) {
        let client = if is_session_id(client) {
            client
        } else {
            ANY_CLIENT
        };
        joined(
            id,
            name,
            client,
            &member_session(relay),
            cwd.to_string(),
            guest_yolo(),
        )
    }

    /// Notes that `relay` is member `id`'s, once the daemon listed it.
    pub(crate) fn register_member(&self, id: &str, relay: &RelayProcess) {
        let mut roster = self.roster.lock().unwrap();
        roster.members.insert(member_session(relay), id.to_string());
    }

    /// Associates a new or returning guest with its verified relay and current environment.
    pub(crate) fn register_join(&self, id: &str, join: GuestJoin) {
        let mut roster = self.roster.lock().unwrap();
        roster
            .members
            .insert(member_session(&join.process), id.to_string());
        roster.environments.insert(id.to_string(), join.env);
    }

    /// Lets go of the member whose relay is `relay`: the member it was, if any.
    pub(crate) fn end_member(&self, relay: &RelayProcess) -> Option<String> {
        self.roster
            .lock()
            .unwrap()
            .end_member(&member_session(relay))
    }

    pub(crate) async fn integration_add(
        &self,
        args: IntegrationArgs,
    ) -> Result<IntegrationInfo, ErrorBody> {
        self.integrations.add(args).await
    }

    pub(crate) async fn integration_remove(
        &self,
        args: IntegrationArgs,
    ) -> Result<IntegrationInfo, ErrorBody> {
        self.integrations.remove(args).await
    }

    pub(crate) async fn integration_list(
        &self,
        args: IntegrationListArgs,
    ) -> Result<IntegrationListResult, ErrorBody> {
        self.integrations.list(args).await
    }

    pub(crate) async fn bring_integrations_up_to_date(&self) {
        self.integrations.bring_up_to_date().await;
    }

    /// Ends `cli`'s `session` when process `pid` ends.
    async fn end_with(&self, cli: &str, session: &str, pid: u32) {
        let key: SessionKey = (cli.to_string(), session.to_string());
        watch::end_with(&self.roster, &self.events, key, pid).await;
    }
}

/// The YOLO a guest takes from this machine's settings when it joins. If the settings cannot be
/// read, the guest reaches only its own tree.
pub(crate) fn guest_yolo() -> bool {
    match blocking_in_place(facade_base::settings::read) {
        Ok(settings) => settings.yolo,
        Err(problems) => {
            log(
                "warn",
                &format!("{problems}; a guest that joins now reaches only its own tree"),
            );
            false
        }
    }
}

/// A guest as it joins, with a creation tree of its own.
fn joined(
    id: &str,
    name: &str,
    cli: &str,
    session: &str,
    cwd: String,
    yolo: bool,
) -> (AgentInfo, GuestRecord) {
    let now = facade_base::time::iso_now();
    let record = GuestRecord {
        agent_id: id.to_string(),
        name: name.to_string(),
        cli: cli.to_string(),
        session: session.to_string(),
        cwd,
        created_at: now.clone(),
        heard_at: now,
    };
    (guest_info(&record, yolo), record)
}

fn guest_info(record: &GuestRecord, yolo: bool) -> AgentInfo {
    AgentInfo {
        address: None,
        label: None,
        unreachable: false,
        agent_id: record.agent_id.clone(),
        name: record.name.clone(),
        cli: record.cli.clone(),
        machine_id: String::new(),
        windows: Vec::new(),
        location_source_window: None,
        location_id: location_id(&record.cwd),
        cwd: record.cwd.clone(),
        pid: None,
        process: ProcessState::Running,
        cols: None,
        rows: None,
        created_at: record.created_at.clone(),
        creator: None,
        creator_machine_id: None,
        root: record.agent_id.clone(),
        root_machine_id: None,
        yolo,
        exit: None,
        session: Some(record.session.clone()),
        state: AgentState::Unknown,
        state_detail: Some(StateDetail {
            reason: Some(StateReason::NotShown),
            ..StateDetail::default()
        }),
        said: None,
        tools_state: ToolsState::NotInjected,
        tools_reason: None,
        guest: true,
    }
}

/// The session a member's record names: its relay process.
fn member_session(relay: &RelayProcess) -> String {
    format!("{}{}-{}", roster::MEMBER_PREFIX, relay.pid, relay.birth)
}

/// The process identity stored in a relay guest's session.
fn member_process(session: &str) -> Option<ProcessIdentity> {
    let (pid, birth) = session
        .strip_prefix(roster::MEMBER_PREFIX)?
        .split_once('-')?;
    let pid = pid.parse().ok()?;
    if pid == 0 || birth.is_empty() {
        return None;
    }
    Some(ProcessIdentity {
        pid,
        birth: birth.to_string(),
    })
}

/// Why a kept guest Facade last heard from at `heard_at` ends as the daemon starts, if it does: it
/// was before `started`, the machine's last start, which ended its CLI without its session-end
/// hook; or before `kept_since`, as long ago as messages are kept. Times are UTC ISO 8601 with
/// milliseconds; with no `started` known, only the 30 days count.
fn ended_at_start(heard_at: &str, started: Option<&str>, kept_since: &str) -> Option<&'static str> {
    match started {
        Some(started) if heard_at < started => {
            Some("the machine started again after Facade last heard from its session")
        }
        _ if heard_at < kept_since => Some("Facade had not heard from its session for 30 days"),
        _ => None,
    }
}

fn log(level: &str, message: &str) {
    facade_base::log::write("daemon", level, message);
}

#[cfg(test)]
mod tests {
    use super::ended_at_start;

    /// Each end on its own (Core Review's N27). A guest last heard from within the 30 days but
    /// before the machine started ends for that start; one heard from 31 days ago, after the start,
    /// ends for the 30 days; one heard from since both stays. With no start known, only the 30 days
    /// count.
    #[test]
    fn a_kept_guest_ends_at_start_for_a_machine_start_or_30_days_each_on_its_own() {
        let kept_since = "2026-10-13T12:00:00.000Z";
        let (started, started_long_ago) = (
            Some("2026-11-12T08:00:00.000Z"),
            Some("2026-09-01T00:00:00.000Z"),
        );
        let rebooted = Some("the machine started again after Facade last heard from its session");
        let unheard = Some("Facade had not heard from its session for 30 days");
        assert_eq!(
            ended_at_start("2026-11-12T07:59:59.999Z", started, kept_since),
            rebooted
        );
        assert_eq!(
            ended_at_start("2026-10-12T12:00:00.000Z", started_long_ago, kept_since),
            unheard
        );
        assert_eq!(
            ended_at_start("2026-11-12T08:00:00.000Z", started, kept_since),
            None
        );
        assert_eq!(
            ended_at_start("2026-10-13T12:00:00.000Z", started_long_ago, kept_since),
            None
        );
        assert_eq!(
            ended_at_start("2026-10-12T12:00:00.000Z", None, kept_since),
            unheard
        );
        assert_eq!(
            ended_at_start("2026-11-12T07:00:00.000Z", None, kept_since),
            None
        );
    }
}
