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

/// When following starts: read at once, as a start does, or once the run writes output again, as
/// recovery does, having read the file already.
pub(crate) enum FirstRead {
    Now,
    AfterOutput,
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
        output: watch::Receiver<()>,
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
            output,
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

/// Waits until the next check is due, or the run ends. A check is due a second after the run's
/// output: at most once a second while output goes on, and once more a quiet second after the
/// last of it, as a CLI saves its session while it works. `soon` makes one due a second from now
/// without output. Without output nothing wakes the follower.
async fn until_due(
    ended: &mut watch::Receiver<bool>,
    output: &mut watch::Receiver<()>,
    soon: bool,
) {
    if !soon && !output.has_changed().unwrap_or(false) {
        let actor_ended = tokio::select! {
            changed = output.changed() => changed.is_err(),
            _ = ended.wait_for(|ended| *ended) => return,
        };
        if actor_ended {
            // The agent's actor ended: only the run's end is left to wait for.
            let _ = ended.wait_for(|ended| *ended).await;
            return;
        }
    }
    // Output after this point makes the check after this one due too.
    output.borrow_and_update();
    tokio::select! {
        _ = tokio::time::sleep(READ_INTERVAL) => {},
        _ = ended.wait_for(|ended| *ended) => {},
    }
}

#[allow(clippy::too_many_arguments)]
async fn track(
    events: mpsc::UnboundedSender<RunEvent>,
    id: String,
    run: u64,
    file: PathBuf,
    mut committed: Option<String>,
    mut ended: watch::Receiver<bool>,
    mut output: watch::Receiver<()>,
    first: FirstRead,
) {
    let mut previous = None;
    let mut reported = None;
    let mut logged = false;
    // A start reads at once and once more a second later; a recovery read the file already.
    let mut soon = matches!(first, FirstRead::Now);
    if !soon {
        until_due(&mut ended, &mut output, false).await;
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
                soon = true;
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
        until_due(&mut ended, &mut output, std::mem::take(&mut soon)).await;
    }
}
