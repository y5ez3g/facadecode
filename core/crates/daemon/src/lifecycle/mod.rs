//! The daemon exits after 30 consecutive idle seconds. Work includes client connections, active
//! machine sessions, starts, stops, calls, sends, handovers and exits being saved. A running agent,
//! a listed Guest, the keeper starting or a screen checkpoint being written also keeps it awake.
//!
//! The exit is decided under the same lock that accepts work, so work accepted before the decision
//! cancels it, and none is accepted after. Once acceptance pauses, the daemon announces sleep.
//! Writers finish, the socket goes, and the daemon exits still holding its lock. The keeper,
//! which holds no CLI by then, exits once it sees the daemon end.

mod log_file;
mod takeover;

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use facade_base::api_v1::ApiVersion;
use facade_base::api_v1::daemon::{AgentLabel, DaemonUpgradeResult};
use tokio::sync::{Notify, oneshot, watch};
use tokio::time::Instant;

use crate::log;

pub(crate) use log_file::{MAX_LOG_LINES, last_lines, prune};
pub(crate) use takeover::{handed_over_cleanly, take_clean_end};

/// Work and terminal actions provided by the daemon's layer.
pub(crate) trait LifecycleActivity: Send + Sync + 'static {
    fn holds_agents(&self) -> bool;
    fn runs_busy(&self) -> Option<String>;
    fn guest_listed(&self) -> bool;
    fn screen_writes(&self) -> usize;
    fn running_count(&self) -> usize;
    fn running_managed_agents(&self) -> Vec<AgentLabel>;
    fn keeper_api_version(&self) -> Option<ApiVersion>;
    fn keeper_build(&self) -> Option<String>;
    fn announce_machine_sleeping(&self) -> impl Future<Output = ()> + Send;
    fn settle_pastes(&self) -> impl Future<Output = Vec<oneshot::Receiver<()>>> + Send;
    fn quiet_agents(&self, deadline: tokio::time::Instant) -> impl Future<Output = bool> + Send;
}

/// How long the daemon stays idle before it exits.
const IDLE_EXIT_DELAY: Duration = Duration::from_secs(30);
/// How soon work the daemon does not count, such as a keeper being started, is looked at again.
const BUSY_RECHECK: Duration = Duration::from_secs(1);

/// How often the exit waits look again for writers that end.
const WRITERS_INTERVAL: Duration = Duration::from_millis(20);

/// Work that keeps the daemon alive while it lasts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Work {
    Connection,
    /// Active machine work or a foreground machine connection.
    MachineSession,
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
    const ALL: [Work; 8] = [
        Work::Connection,
        Work::MachineSession,
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
            Work::MachineSession => "a machine session is active",
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
    last_work_end: Option<Instant>,
    exiting: bool,
}

impl Counts {
    fn of(&self, work: Work) -> usize {
        self.under_way[work as usize]
    }
}

/// The work under way, idle exit and takeover. Accepting work and deciding to exit
/// both take the counts lock.
pub(crate) struct Lifecycle {
    counts: Mutex<Counts>,
    changed: Notify,
    idle_delay: IdleDelayLog,
    takeover: tokio::sync::Mutex<Option<DaemonUpgradeResult>>,
    draining: AtomicBool,
    closing_to: watch::Sender<Option<String>>,
}

/// One piece of work, counted until it is dropped.
pub(crate) struct WorkGuard {
    lifecycle: Arc<Lifecycle>,
    work: Work,
}

impl Drop for WorkGuard {
    fn drop(&mut self) {
        {
            let mut counts = self.lifecycle.counts.lock().unwrap();
            counts.under_way[self.work as usize] -= 1;
            counts.last_work_end = Some(Instant::now());
        }
        self.lifecycle.changed.notify_waiters();
    }
}

impl Lifecycle {
    pub(crate) fn new() -> Arc<Lifecycle> {
        Arc::new(Lifecycle {
            counts: Mutex::default(),
            changed: Notify::new(),
            idle_delay: IdleDelayLog::new(),
            takeover: tokio::sync::Mutex::default(),
            draining: AtomicBool::new(false),
            closing_to: watch::channel(None).0,
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
        let deadline = Instant::now() + timeout;
        loop {
            // Made before `done` is asked, so that no change in between goes unheard.
            let changed = self.changed.notified();
            if done() || tokio::time::timeout_at(deadline, changed).await.is_err() {
                return;
            }
        }
    }

    /// Wakes whatever waits on the work, where something it does not count changed, such as a
    /// guest leaving the list.
    pub(crate) fn note_change(&self) {
        self.changed.notify_waiters();
    }

    /// The first work under way, by the order of [`Work::ALL`].
    fn first_under_way(&self) -> Option<Work> {
        let counts = self.counts.lock().unwrap();
        Work::ALL.into_iter().find(|work| counts.of(*work) > 0)
    }

    pub(crate) fn delay_exit(&self, detail: &str) {
        self.idle_delay.delayed(detail);
    }

    pub(crate) fn clear_exit_delay(&self) {
        self.idle_delay.cleared();
    }

    /// Why the daemon cannot exit now, or None where it is idle.
    fn busy_with(&self, activity: &impl LifecycleActivity) -> Option<String> {
        #[cfg(debug_assertions)]
        if self.count(Work::ExitCommit) > 0 && activity.screen_writes() > 0 {
            facade_base::service::mark_for_test("exit-drain-and-writer-counted");
        }
        if let Some(work) = self.first_under_way() {
            return Some(work.doing().to_string());
        }
        if let Some(why) = activity.runs_busy() {
            return Some(why);
        }
        // A guest is an agent like any other: while one is listed, working or not, the daemon
        // stays.
        if activity.guest_listed() {
            return Some("a guest is listed".to_string());
        }
        if activity.screen_writes() > 0 {
            return Some("a screen checkpoint is being written".to_string());
        }
        None
    }

    /// Exits the daemon after 30 consecutive idle seconds. `closing` asks the server to
    /// stop accepting clients, which `paused` confirms.
    pub(crate) async fn exit_when_idle(
        self: Arc<Self>,
        activity: Arc<impl LifecycleActivity>,
        closing: watch::Sender<bool>,
        mut paused: watch::Receiver<bool>,
    ) {
        let mut idle_since: Option<Instant> = None;
        loop {
            // Made before the look, so that no change in between goes unheard.
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            let busy = self.busy_with(activity.as_ref());
            if let Some(why) = &busy {
                // Only an error keeps an exit from being saved: the log says it once.
                if why.contains("cannot be saved") {
                    self.delay_exit(why);
                }
                idle_since = None;
            }
            if activity.holds_agents() {
                // Only an agent's exit, saved as counted work, or a guest's end, which notes a
                // change, can make the daemon idle: nothing else wakes this while agents are listed.
                idle_since = None;
                changed.await;
                continue;
            }
            if busy.is_some() {
                // Work that is not counted, such as the keeper being started, is looked at again soon.
                let _ = tokio::time::timeout(BUSY_RECHECK, changed).await;
                continue;
            }
            let since = *idle_since.get_or_insert_with(Instant::now);
            if since.elapsed() < IDLE_EXIT_DELAY {
                let _ = tokio::time::timeout_at(since + IDLE_EXIT_DELAY, changed).await;
                continue;
            }
            // A guard may start and drop between checks. Its end restarts the idle interval too.
            {
                let mut counts = self.counts.lock().unwrap();
                if Work::ALL.iter().any(|work| counts.of(*work) > 0) {
                    idle_since = None;
                    continue;
                }
                if let Some(ended) = counts.last_work_end
                    && ended > since
                {
                    idle_since = Some(ended);
                    continue;
                }
                counts.exiting = true;
            }
            crate::pause_for_test("after-idle-decision");
            log(
                "info",
                &format!("idle for {} seconds; exiting", IDLE_EXIT_DELAY.as_secs()),
            );
            closing.send_replace(true);
            facade_base::service::mark_for_test("acceptance-pause-requested");
            if paused.wait_for(|paused| *paused).await.is_err() {
                return;
            }
            activity.announce_machine_sleeping().await;
            // The keeper holds no CLI either, so it exits once it sees this daemon end.
            self.finish_and_exit(activity.as_ref()).await;
        }
    }

    /// Waits for screen writers and exit drains, removes the daemon socket, and exits the process.
    async fn finish_and_exit(&self, activity: &impl LifecycleActivity) -> ! {
        while activity.screen_writes() > 0 || self.count(Work::ExitCommit) > 0 {
            tokio::time::sleep(WRITERS_INTERVAL).await;
        }
        if let Ok(socket) = facade_base::paths::daemon_socket() {
            let _ = std::fs::remove_file(socket);
        }
        std::process::exit(0)
    }
}

/// Says once per episode why the daemon cannot exit yet.
struct IdleDelayLog(Mutex<Option<String>>);

impl IdleDelayLog {
    fn new() -> IdleDelayLog {
        IdleDelayLog(Mutex::new(None))
    }

    /// Logs `detail` unless this episode said it already.
    fn delayed(&self, detail: &str) {
        let mut said = self.0.lock().unwrap();
        if said.as_deref() != Some(detail) {
            log("warn", &format!("idle exit delayed: {detail}"));
            *said = Some(detail.to_string());
        }
    }

    /// Ends the episode.
    fn cleared(&self) {
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
        for work in Work::ALL {
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
