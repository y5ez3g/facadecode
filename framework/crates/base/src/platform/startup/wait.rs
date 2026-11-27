//! Waits for changes to startup records between Shell observations.

use std::path::Path;
use std::time::{Duration, Instant};

#[cfg(windows)]
mod windows;

pub struct StartupWait {
    #[cfg(windows)]
    changes: Option<windows::DirectoryChanges>,
}

impl StartupWait {
    /// Creates a wait after the first connection attempt needs another observation.
    pub fn open(framework: &Path) -> Self {
        #[cfg(not(windows))]
        let _ = framework;
        Self {
            #[cfg(windows)]
            changes: windows::DirectoryChanges::open(framework).ok(),
        }
    }

    /// Retests occasionally for an exit without a report or a legacy service without progress.
    pub fn wait(&mut self, deadline: Instant, poll: Duration) {
        #[cfg(windows)]
        if let Some(changes) = &mut self.changes {
            let next = deadline.min(Instant::now() + Duration::from_secs(1));
            if changes.wait(next).is_ok() {
                return;
            }
            self.changes = None;
        }
        std::thread::sleep(poll.min(deadline.saturating_duration_since(Instant::now())));
    }
}
