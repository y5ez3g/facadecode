//! What the daemon knows of its guests in memory, under one lock: whose each kept hook session is,
//! each guest's environment, and the members by their relay.

use std::collections::{BTreeMap, HashMap};

use crate::store::GuestRecord;

/// A CLI and one of its sessions.
pub(super) type SessionKey = (String, String);

/// How a member's session, its relay process, begins: `relay-<pid>-<birth>`.
pub(super) const MEMBER_PREFIX: &str = "relay-";

#[derive(Default)]
pub(super) struct Roster {
    /// Each guest that joined through hooks, by its CLI and session.
    pub(super) sessions: HashMap<SessionKey, String>,
    /// Each guest's environment, by the guest's ID.
    pub(super) environments: HashMap<String, BTreeMap<String, String>>,
    /// Each member, by its session (`relay-<pid>-<birth>`).
    pub(super) members: HashMap<String, String>,
}

impl Roster {
    /// Lists a kept hook session again, as a daemon started anew does.
    pub(super) fn list_session(&mut self, record: &GuestRecord) {
        let key = (record.cli.clone(), record.session.clone());
        self.sessions.insert(key, record.agent_id.clone());
    }

    /// Lets go of `cli`'s hook session.
    pub(super) fn end(&mut self, cli: &str, session: &str) -> Option<String> {
        let key = (cli.to_string(), session.to_string());
        let id = self.sessions.remove(&key)?;
        self.forget(&id);
        Some(id)
    }

    /// Lets go of the member of `session`: the member it was, if any.
    pub(super) fn end_member(&mut self, session: &str) -> Option<String> {
        let id = self.members.remove(session)?;
        self.forget(&id);
        Some(id)
    }

    fn forget(&mut self, id: &str) {
        self.environments.remove(id);
    }
}
