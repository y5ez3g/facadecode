//! When the daemon exits: after five seconds in a row with nothing to do. Something to do is a
//! client connection, from its accept until its cleanup ends; a start, stop, call, send, handover
//! or exit being saved, each counted from its acceptance even after its client goes; a run that is
//! running or whose exit is not saved yet; a listed guest; the keeper starting; or a screen
//! checkpoint being written. Ended agents and idle actors keep nothing alive.
//!
//! The exit is decided under the same lock that accepts work, so work accepted before the decision
//! cancels it, and none is accepted after. Then connections close before `hello`, writers finish,
//! the socket goes, and the daemon exits still holding its lock. The keeper, which holds no CLI by
//! then, exits once it sees the daemon end.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::Notify;

use crate::{Daemon, log};

/// How long the daemon stays idle before it exits.
const IDLE_EXIT_DELAY: Duration = Duration::from_secs(5);

/// How often the exit waits look again for writers that end.
const WRITERS_INTERVAL: Duration = Duration::from_millis(20);

/// Work that keeps the daemon alive while it lasts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Work {
    Connection,
    Start,
    Handover,
    Stop,
    Call,
    /// A send. A takeover's drain does not wait for it: the store keeps its message for the next
    /// daemon.
    Send,
    ExitCommit,
}

impl Work {
    const ALL: [Work; 7] = [
        Work::Connection,
        Work::Start,
        Work::Handover,
        Work::Stop,
        Work::Call,
        Work::Send,
        Work::ExitCommit,
    ];

    /// What the daemon is doing while this work lasts, as its log says why it stays.
    fn doing(self) -> &'static str {
        match self {
            Work::Connection => "a client is connected",
            Work::Start => "an agent is starting",
            Work::Handover => "runs are being handed to the keeper",
            Work::Stop => "an agent is being stopped",
            Work::Call => "a call is unfinished",
            Work::Send => "a message is being sent",
            Work::ExitCommit => "an exit is being saved or terminal output is draining",
        }
    }
}

/// The work under way, and whether the daemon decided to exit.
#[derive(Default)]
struct Counts {
    under_way: [usize; Work::ALL.len()],
    exiting: bool,
}

impl Counts {
    fn of(&self, work: Work) -> usize {
        self.under_way[work as usize]
    }
}

/// The work under way. Accepting work and deciding to exit both take its lock.
pub(crate) struct Lifecycle {
    counts: Mutex<Counts>,
    changed: Notify,
}

/// One piece of work, counted until it is dropped.
pub(crate) struct WorkGuard {
    lifecycle: Arc<Lifecycle>,
    work: Work,
}

impl Drop for WorkGuard {
    fn drop(&mut self) {
        self.lifecycle.counts.lock().unwrap().under_way[self.work as usize] -= 1;
        self.lifecycle.changed.notify_waiters();
    }
}

impl Lifecycle {
    pub(crate) fn new() -> Arc<Lifecycle> {
        Arc::new(Lifecycle {
            counts: Mutex::default(),
            changed: Notify::new(),
        })
    }

    /// Counts `work` until the guard drops; None once the daemon decided to exit.
    pub(crate) fn begin(self: &Arc<Self>, work: Work) -> Option<WorkGuard> {
        {
            let mut counts = self.counts.lock().unwrap();
            if counts.exiting {
                return None;
            }
            counts.under_way[work as usize] += 1;
        }
        self.changed.notify_waiters();
        Some(WorkGuard {
            lifecycle: self.clone(),
            work,
        })
    }

    fn count(&self, work: Work) -> usize {
        self.counts.lock().unwrap().of(work)
    }

    /// Waits up to `timeout` for the calls, starts, stops and handovers under way to end, not for
    /// sends, whose messages the store keeps.
    pub(crate) async fn settle(&self, timeout: Duration) {
        let settling = [Work::Call, Work::Start, Work::Stop, Work::Handover];
        self.wait(timeout, || {
            settling.iter().all(|work| self.count(*work) == 0)
        })
        .await;
    }

    /// Waits up to `timeout` for every client connection to end.
    pub(crate) async fn connections_closed(&self, timeout: Duration) {
        self.wait(timeout, || self.count(Work::Connection) == 0)
            .await;
    }

    /// Waits up to `timeout` until `done`, which is asked again at each change of the work.
    async fn wait(&self, timeout: Duration, done: impl Fn() -> bool) {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            // Made before `done` is asked, so that no change in between goes unheard.
            let changed = self.changed.notified();
            if done() || tokio::time::timeout_at(deadline, changed).await.is_err() {
                return;
            }
        }
    }

    /// The first work under way, by the order of [`Work::ALL`].
    fn first_under_way(&self) -> Option<Work> {
        let counts = self.counts.lock().unwrap();
        Work::ALL.into_iter().find(|work| counts.of(*work) > 0)
    }
}

impl Daemon {
    /// Why the daemon cannot exit now, or None where it is idle.
    fn busy_with(&self) -> Option<String> {
        #[cfg(debug_assertions)]
        if self.lifecycle.count(Work::ExitCommit) > 0 && crate::agent::screen_writes() > 0 {
            facade_base::service::mark_for_test("exit-drain-and-writer-counted");
        }
        if let Some(work) = self.lifecycle.first_under_way() {
            return Some(work.doing().to_string());
        }
        if let Some(why) = self.runs.busy() {
            return Some(why);
        }
        // A guest is an agent like any other: while one is listed, working or not, the daemon
        // stays.
        if self.guests.any_guest() {
            return Some("a guest is listed".to_string());
        }
        if crate::agent::screen_writes() > 0 {
            return Some("a screen checkpoint is being written".to_string());
        }
        None
    }
}

/// Exits the daemon once it was idle for five seconds in a row. `closing` asks the server to stop
/// accepting clients, which `paused` confirms.
pub(crate) async fn exit_when_idle(
    daemon: Arc<Daemon>,
    closing: tokio::sync::watch::Sender<bool>,
    mut paused: tokio::sync::watch::Receiver<bool>,
) {
    let lifecycle = daemon.lifecycle.clone();
    let mut idle_since: Option<Instant> = None;
    loop {
        let _ = tokio::time::timeout(Duration::from_secs(1), lifecycle.changed.notified()).await;
        if let Some(why) = daemon.busy_with() {
            // Only an error keeps an exit from being saved: the log says it once.
            if why.contains("cannot be saved") {
                daemon.idle_delay.delayed(&why);
            }
            idle_since = None;
            continue;
        }
        if idle_since.get_or_insert_with(Instant::now).elapsed() < IDLE_EXIT_DELAY {
            continue;
        }
        // Decided under the lock that accepts work: whatever starts, joins or connects is counted
        // as work first, so work accepted since the look above cancels the exit.
        {
            let mut counts = lifecycle.counts.lock().unwrap();
            if Work::ALL.iter().any(|work| counts.of(*work) > 0) {
                idle_since = None;
                continue;
            }
            counts.exiting = true;
        }
        crate::pause_for_test("after-idle-decision");
        log(
            "info",
            "idle for 5 seconds with no agent running and no client connected; exiting",
        );
        closing.send_replace(true);
        facade_base::service::mark_for_test("acceptance-pause-requested");
        if paused.wait_for(|paused| *paused).await.is_err() {
            return;
        }
        // The keeper holds no CLI either, so it exits once it sees this daemon end.
        finish_and_exit(&daemon).await;
    }
}

/// Waits for screen writers and exit drains, removes the daemon socket, and exits the process.
pub(crate) async fn finish_and_exit(daemon: &Arc<Daemon>) -> ! {
    while crate::agent::screen_writes() > 0 || daemon.lifecycle.count(Work::ExitCommit) > 0 {
        tokio::time::sleep(WRITERS_INTERVAL).await;
    }
    if let Ok(socket) = facade_base::paths::daemon_socket() {
        let _ = std::fs::remove_file(socket);
    }
    std::process::exit(0)
}

/// Says once per episode why the daemon cannot exit yet.
pub(crate) struct IdleDelayLog(Mutex<Option<String>>);

impl IdleDelayLog {
    pub(crate) fn new() -> IdleDelayLog {
        IdleDelayLog(Mutex::new(None))
    }

    /// Logs `detail` unless this episode said it already.
    pub(crate) fn delayed(&self, detail: &str) {
        let mut said = self.0.lock().unwrap();
        if said.as_deref() != Some(detail) {
            log("warn", &format!("idle exit delayed: {detail}"));
            *said = Some(detail.to_string());
        }
    }

    /// Ends the episode.
    pub(crate) fn cleared(&self) {
        *self.0.lock().unwrap() = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_work_is_accepted_once_the_daemon_decided_to_exit() {
        let lifecycle = Lifecycle::new();
        let connected = lifecycle
            .begin(Work::Connection)
            .expect("work is accepted before the decision");
        assert_eq!(lifecycle.count(Work::Connection), 1);
        drop(connected);
        assert_eq!(
            lifecycle.count(Work::Connection),
            0,
            "the count ends with the work"
        );
        lifecycle.counts.lock().unwrap().exiting = true;
        for work in [Work::Connection, Work::Start, Work::Call] {
            assert!(
                lifecycle.begin(work).is_none(),
                "{work:?} after the decision"
            );
        }
    }

    /// Work that ends right after a wait read it as under way wakes the wait, which listens before
    /// it reads: a change between the two is not missed until the wait's time is out.
    #[tokio::test(start_paused = true)]
    async fn work_that_ends_right_after_a_wait_reads_it_wakes_the_wait() {
        let lifecycle = Lifecycle::new();
        let call = Mutex::new(lifecycle.begin(Work::Call));
        let done = || {
            let busy = lifecycle.count(Work::Call) > 0;
            drop(call.lock().unwrap().take());
            !busy
        };
        let waiting = tokio::time::Instant::now();
        lifecycle.wait(Duration::from_secs(60), done).await;
        assert!(
            waiting.elapsed() < Duration::from_secs(1),
            "the wait missed the call's end and waited {:?}",
            waiting.elapsed()
        );
    }
}
