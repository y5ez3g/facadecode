//! The idle deadline for one machine session.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::Notify;
use tokio::time::Instant;

use super::{SessionHold, session};

const IDLE_DELAY: Duration = Duration::from_secs(30);

#[derive(Default)]
pub(super) struct Activity {
    head: Mutex<Head>,
    changed: Notify,
}

#[derive(Default)]
struct Head {
    count: usize,
    deadline: session::Deadline,
    reaped: bool,
}

pub(super) struct SessionActivity {
    activity: Arc<Activity>,
    _work: Option<SessionHold>,
}

impl Activity {
    pub(super) fn start(&self) {
        let mut head = self.head.lock().unwrap();
        if head.count == 0 {
            head.deadline = Some(Instant::now() + IDLE_DELAY);
            self.changed.notify_one();
        }
    }

    pub(super) fn hold(self: &Arc<Self>, work: Option<SessionHold>) -> Option<SessionActivity> {
        let mut head = self.head.lock().unwrap();
        if head.reaped {
            return None;
        }
        head.count += 1;
        if head.deadline.take().is_some() {
            self.changed.notify_one();
        }
        Some(SessionActivity {
            activity: self.clone(),
            _work: work,
        })
    }

    pub(super) async fn reap(&self) {
        loop {
            let deadline = {
                let mut head = self.head.lock().unwrap();
                if head
                    .deadline
                    .is_some_and(|deadline| Instant::now() >= deadline)
                {
                    head.reaped = true;
                    return;
                }
                head.deadline
            };
            tokio::select! {
                () = self.changed.notified() => {}
                () = session::expires(deadline) => {}
            }
        }
    }
}

impl Drop for SessionActivity {
    fn drop(&mut self) {
        let mut head = self.activity.head.lock().unwrap();
        head.count -= 1;
        if head.count == 0 {
            head.deadline = Some(Instant::now() + IDLE_DELAY);
            self.activity.changed.notify_one();
        }
    }
}
