//! What the daemon knows of its guests in memory, under one lock: whose each session is, which
//! sessions are part of another, the processes whose end ends a session, each guest's environment
//! and turn, and the members by their relay.

use std::collections::{BTreeMap, HashMap};

use facade_base::process::ProcessIdentity;

use crate::store::GuestRecord;

/// A CLI and one of its sessions.
pub(super) type SessionKey = (String, String);

/// How a member's session, its relay process, begins: `relay-<pid>-<birth>`.
pub(super) const MEMBER_PREFIX: &str = "relay-";

/// The most sessions one part of a session leads through to the whole: a bound against a cycle.
const MOST_PARTS: usize = 16;

#[derive(Default)]
pub(super) struct Roster {
    /// Each guest that joined through hooks, by its CLI and session.
    pub(super) sessions: HashMap<SessionKey, String>,
    /// The session each part of a session is part of, as a subagent's is part of the session that
    /// started it.
    parts: HashMap<SessionKey, String>,
    /// For a CLI with no hook for a session's end, the CLI's process that ran the session's hook.
    pub(super) watched: HashMap<SessionKey, ProcessIdentity>,
    /// Each guest's CLI's environment, by the guest's ID.
    pub(super) environments: HashMap<String, BTreeMap<String, String>>,
    /// When, in milliseconds since the epoch, the turn each followed guest is in began.
    pub(super) turns: HashMap<String, u64>,
    /// Each member, by its session (`relay-<pid>-<birth>`).
    pub(super) members: HashMap<String, String>,
}

impl Roster {
    pub(super) fn guest_of(&self, cli: &str, session: &str) -> Option<&String> {
        self.sessions.get(&(cli.to_string(), session.to_string()))
    }

    /// Notes that `cli`'s `session` acts for the whole session `parent` is, unless it is that.
    pub(super) fn note_part(&mut self, cli: &str, session: &str, parent: &str) {
        let whole = self.whole_of(cli, parent);
        if whole != session {
            self.parts
                .insert((cli.to_string(), session.to_string()), whole);
        }
    }

    /// The session `cli`'s `session` is part of, through every part, or itself.
    pub(super) fn whole_of(&self, cli: &str, session: &str) -> String {
        let mut whole = session.to_string();
        for _ in 0..MOST_PARTS {
            match self.parts.get(&(cli.to_string(), whole.clone())) {
                Some(next) => whole = next.clone(),
                None => break,
            }
        }
        whole
    }

    /// The session `session`, of whichever CLI, is part of, or itself.
    pub(super) fn whole_of_any(&self, session: &str) -> String {
        self.parts
            .iter()
            .find(|((_, part), _)| part == session)
            .map_or_else(|| session.to_string(), |(_, whole)| whole.clone())
    }

    /// Lists a kept guest again, as a daemon started anew does.
    pub(super) fn list(&mut self, record: &GuestRecord) {
        let id = record.agent_id.clone();
        if record.session.starts_with(MEMBER_PREFIX) {
            self.members.insert(record.session.clone(), id);
        } else {
            let key = (record.cli.clone(), record.session.clone());
            self.sessions.insert(key, id);
        }
    }

    /// Lets go of `cli`'s `session` and its parts: the guest or member it was, if any.
    pub(super) fn end(&mut self, cli: &str, session: &str) -> Option<String> {
        let key = (cli.to_string(), session.to_string());
        self.watched.remove(&key);
        self.parts.remove(&key);
        self.parts
            .retain(|(part_cli, _), whole| !(part_cli == cli && whole == session));
        let id = match self.sessions.remove(&key) {
            Some(id) => id,
            None => self.members.remove(session)?,
        };
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
        self.turns.remove(id);
    }
}
