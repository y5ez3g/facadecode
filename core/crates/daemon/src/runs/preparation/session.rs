//! Session reports are acknowledged by the daemon before they become the next committed value.
//! Unchanged files need only a metadata check, unless the file names a session its CLI has not
//! saved yet: that one is read every second until it is saved. A failed acknowledgement retries
//! the cached report.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinHandle;
use tokio::time::Instant;

use super::super::RunEvent;

const READ_INTERVAL: Duration = Duration::from_secs(1);

/// When following starts, read immediately or wait for the recovery read's next interval.
pub(crate) enum FirstRead {
    Now,
    AfterInterval,
}

struct Following {
    ended: watch::Sender<bool>,
    task: JoinHandle<()>,
}

#[derive(Default)]
struct Followers {
    active: HashMap<String, Following>,
    // An exit may precede installation of its session follower.
    pending_ended: HashSet<String>,
}

pub(super) struct Sessions {
    followers: Mutex<Followers>,
    events: mpsc::UnboundedSender<RunEvent>,
}

impl Sessions {
    pub(super) fn new(events: mpsc::UnboundedSender<RunEvent>) -> Self {
        Self {
            events,
            followers: Mutex::default(),
        }
    }

    pub(super) fn starting(&self, id: &str) {
        self.followers.lock().unwrap().pending_ended.remove(id);
    }

    pub(super) fn ended(&self, id: &str) {
        let mut followers = self.followers.lock().unwrap();
        if let Some(follower) = followers.active.get(id) {
            follower.ended.send_replace(true);
        } else {
            followers.pending_ended.insert(id.to_owned());
        }
    }

    pub(super) fn follow(
        &self,
        id: &str,
        run: u64,
        file: PathBuf,
        committed: Option<String>,
        first: FirstRead,
    ) {
        let mut followers = self.followers.lock().unwrap();
        let ended = followers.pending_ended.remove(id);
        let (signal, receiver) = watch::channel(ended);
        let task = tokio::spawn(track(
            self.events.clone(),
            id.to_owned(),
            run,
            file,
            committed,
            receiver,
            first,
        ));
        followers.active.insert(
            id.to_owned(),
            Following {
                ended: signal,
                task,
            },
        );
    }

    pub(super) async fn followed(&self, id: &str, deadline: Instant) -> bool {
        let follower = self.followers.lock().unwrap().active.remove(id);
        let Some(mut follower) = follower else {
            return true;
        };
        if !follower.task.is_finished() {
            facade_base::service::mark_for_test("waiting-for-previous-run");
        }
        if tokio::time::timeout_at(deadline, &mut follower.task)
            .await
            .is_ok()
        {
            return true;
        }
        self.followers
            .lock()
            .unwrap()
            .active
            .insert(id.to_owned(), follower);
        false
    }

    pub(super) async fn end_following(&self, id: &str) {
        let follower = {
            let mut followers = self.followers.lock().unwrap();
            followers.pending_ended.remove(id);
            followers.active.remove(id)
        };
        if let Some(follower) = follower {
            let _ = follower.task.await;
        }
    }
}

pub(super) async fn read(id: &str, file: PathBuf, logged: &mut bool) -> Option<Option<String>> {
    match tokio::task::spawn_blocking(move || facade_rules::read_session_file(&file))
        .await
        .ok()?
    {
        facade_rules::SessionFile::Session(session) => {
            *logged = false;
            Some(Some(session))
        }
        facade_rules::SessionFile::NoSession => {
            *logged = false;
            Some(None)
        }
        facade_rules::SessionFile::Missing => None,
        facade_rules::SessionFile::Unreadable(why) => {
            if !*logged {
                facade_base::log::write(
                    "daemon",
                    "warn",
                    &format!(
                        "could not read the session file of {id}: {why}; keeping its last session"
                    ),
                );
                *logged = true;
            }
            None
        }
    }
}

fn stamp(file: &std::path::Path) -> Option<(SystemTime, u64)> {
    let metadata = std::fs::metadata(file).ok()?;
    Some((metadata.modified().ok()?, metadata.len()))
}

async fn interval_or_end(ended: &mut watch::Receiver<bool>) {
    tokio::select! {
        _ = tokio::time::sleep(READ_INTERVAL) => {},
        _ = ended.wait_for(|ended| *ended) => {},
    }
}

async fn track(
    events: mpsc::UnboundedSender<RunEvent>,
    id: String,
    run: u64,
    file: PathBuf,
    mut committed: Option<String>,
    mut ended: watch::Receiver<bool>,
    first: FirstRead,
) {
    let mut previous = None;
    let mut reported = None;
    let mut logged = false;
    if matches!(first, FirstRead::AfterInterval) {
        interval_or_end(&mut ended).await;
    }
    loop {
        let last = *ended.borrow();
        let current = stamp(&file);
        // A file that names a session reads as no session until the CLI saves that session; only a
        // read sees it saved, as the file itself does not change then.
        let unsaved = reported == Some(None) && current.is_some_and(|(_, size)| size > 0);
        if last || unsaved || previous.as_ref() != Some(&current) {
            reported = read(&id, file.clone(), &mut logged).await;
            previous = Some(current);
        }
        if let Some(session) = &reported
            && session != &committed
        {
            if last {
                crate::gate_for_test("before-last-session-commit");
            }
            let (ack, response) = oneshot::channel();
            let sent = events
                .send(RunEvent::Session {
                    id: id.clone(),
                    run,
                    session: session.clone(),
                    committed: ack,
                })
                .is_ok();
            if sent && response.await.unwrap_or(false) {
                committed = session.clone();
            } else {
                facade_base::log::write(
                    "daemon",
                    "warn",
                    &format!("could not save the session of {id}; trying again on the next read"),
                );
            }
        }
        if last {
            return;
        }
        interval_or_end(&mut ended).await;
    }
}
