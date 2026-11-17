//! Scenario test helpers. Each test uses a temporary Facade home with its own keeper, daemon, and
//! agents. Cleanup stops only that home's processes and removes its files. Set
//! `FACADE_SCENARIO_KEEP=1` to keep the files for inspection. Tests use workspace builds and a
//! terminal driver that reads their visible screens.

use std::process::Output;
use std::time::{Duration, Instant};

pub use serde_json;

mod binaries;
mod connections;
mod home;
mod mcp;
mod system;
mod terminal;

pub use binaries::*;
pub use connections::*;
pub use home::*;
pub use mcp::*;
pub use system::*;
pub use terminal::*;

pub fn secs(seconds: u64) -> Duration {
    Duration::from_secs(seconds)
}

/// How long the harness waits for what has to come: a response, a daemon's start, a gate. A machine
/// running many tests at once, as the Linux gate's does, has taken over 15 seconds for what takes
/// milliseconds alone. A wait ends as soon as its condition holds, so only a failing test waits all
/// of it.
pub const LOADED_TIMEOUT: Duration = Duration::from_secs(60);

/// Polls every 50 ms until `check` succeeds or the timeout expires.
pub fn wait_until(timeout: Duration, mut check: impl FnMut() -> bool) -> bool {
    let end = Instant::now() + timeout;
    loop {
        if check() {
            return true;
        }
        if Instant::now() >= end {
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Captures a process identity before the action under test can end it. A process already gone has
/// no matching birth.
pub fn process_identity(pid: i32) -> facade_base::process::ProcessIdentity {
    facade_base::process::ProcessIdentity {
        pid: pid as u32,
        birth: facade_base::unix_process::birth(pid as u32)
            .unwrap()
            .unwrap_or_default(),
    }
}

/// Checks the recorded PID and birth. An inconclusive observation keeps an exit poll waiting for
/// its next read.
pub fn alive(identity: &facade_base::process::ProcessIdentity) -> bool {
    use facade_base::unix_process::{Presence, presence};
    match presence(identity).expect("could not check the test process identity") {
        Presence::Running | Presence::Inconclusive => true,
        Presence::Ended => false,
    }
}

/// Sends `signal` to process `pid`, on Unix: tests of signals stay there.
#[cfg(unix)]
pub fn send_signal(pid: i32, signal: i32) {
    // SAFETY: sending a signal has no memory-safety preconditions.
    unsafe {
        libc::kill(pid, signal);
    }
}

pub fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

pub fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

#[cfg(test)]
mod tests {
    #[test]
    fn alive_rejects_the_same_pid_with_a_different_birth() {
        let identity = super::process_identity(std::process::id() as i32);
        assert!(super::alive(&identity));
        let reused = facade_base::process::ProcessIdentity {
            birth: format!("{}-older", identity.birth),
            ..identity
        };
        assert!(!super::alive(&reused));
    }
}
