//! Remembers the run selected by a live native relay while this daemon is running.

use std::collections::{HashMap, hash_map::Entry};
use std::sync::Mutex;

use facade_base::model::error::ErrorBody;
use facade_base::process::ProcessIdentity;
use facade_base::unix_process::{self, Presence};

use crate::guests::RelayProcess;
use crate::runs::RunIdentity;

use super::RelayRole;

#[derive(Default)]
pub(crate) struct Bindings(Mutex<HashMap<RelayProcess, RunIdentity>>);

impl Bindings {
    pub(super) fn verify(
        &self,
        relay: &RelayProcess,
        reconnect: bool,
        prove: impl FnOnce(Option<&str>) -> Result<RelayRole<RunIdentity>, ErrorBody>,
    ) -> Result<RelayRole<RunIdentity>, ErrorBody> {
        let previous = self.0.lock().unwrap().get(relay).cloned();
        let Some(previous) = previous else {
            return if reconnect {
                Ok(RelayRole::AwaitingSession)
            } else {
                prove(None)
            };
        };
        match prove(Some(&previous.agent_id))? {
            RelayRole::Managed(run) if run == previous => Ok(RelayRole::Managed(run)),
            _ => Ok(RelayRole::AwaitingSession),
        }
    }

    pub(super) fn remember(
        &self,
        relay: &RelayProcess,
        run: &RunIdentity,
    ) -> Result<(), ErrorBody> {
        match self.0.lock().unwrap().entry(relay.clone()) {
            Entry::Vacant(entry) => {
                entry.insert(run.clone());
                Ok(())
            }
            Entry::Occupied(entry) if entry.get() == run => Ok(()),
            Entry::Occupied(_) => Err(super::native_session_mismatch()),
        }
    }

    pub(crate) fn sweep(&self) {
        self.0.lock().unwrap().retain(|relay, _| {
            let process = ProcessIdentity {
                pid: relay.pid,
                birth: relay.birth.clone(),
            };
            !matches!(unix_process::presence(&process), Ok(Presence::Ended))
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_live_relay_reconnects_only_to_its_original_run_in_the_same_daemon() {
        let process = unix_process::own_identity().unwrap();
        let relay = RelayProcess {
            pid: process.pid,
            birth: process.birth.clone(),
        };
        let run = RunIdentity {
            agent_id: "a1".into(),
            process,
            run: 5,
        };
        let daemon = Bindings::default();
        daemon.remember(&relay, &run).unwrap();
        daemon.sweep();

        let missing = daemon.verify(&relay, true, |agent| {
            assert_eq!(agent, Some("a1"));
            Ok(RelayRole::Guest)
        });
        assert!(matches!(missing.unwrap(), RelayRole::AwaitingSession));
        let resumed = RunIdentity {
            run: 6,
            ..run.clone()
        };
        let changed = daemon.verify(&relay, true, |_| Ok(RelayRole::Managed(resumed.clone())));
        assert!(matches!(changed.unwrap(), RelayRole::AwaitingSession));
        assert!(daemon.remember(&relay, &resumed).is_err());

        let original = daemon.verify(&relay, true, |_| Ok(RelayRole::Managed(run.clone())));
        assert!(matches!(original.unwrap(), RelayRole::Managed(verified) if verified == run));

        let reused = RelayProcess {
            birth: "reused PID".into(),
            ..relay.clone()
        };
        let first = daemon.verify(&reused, false, |agent| {
            assert_eq!(agent, None);
            Ok(RelayRole::Guest)
        });
        assert!(matches!(first.unwrap(), RelayRole::Guest));

        let new_daemon = Bindings::default();
        let missing = new_daemon.verify(&relay, true, |_| {
            panic!("a reconnect without its original binding cannot select an actor")
        });
        assert!(matches!(missing.unwrap(), RelayRole::AwaitingSession));
    }
}
