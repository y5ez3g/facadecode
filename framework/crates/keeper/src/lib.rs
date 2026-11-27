//! `facade keeper`: the long-lived parent of every CLI in a Facade home.
//!
//! One keeper runs per home. It starts and stops CLIs, holds a copy of each one's terminal so a
//! terminal survives a daemon crash, and supervises the daemon. Everything happens on a single
//! thread around one wait, `poll` on Unix and an I/O completion port on Windows: no tokio, no
//! locks. It never interprets a CLI, a screen or a message. The daemon talks to it in the keeper
//! protocol, [`facade_base::api_v1::keeper`].

#[cfg(unix)]
mod cli;
#[cfg(unix)]
mod keeper;
#[cfg(unix)]
mod link;
mod runtime;
#[cfg(unix)]
mod supervisor;
#[cfg(unix)]
mod terminal;
#[cfg(unix)]
mod wake;
#[cfg(windows)]
mod windows;

use std::fs::File;
use std::path::Path;
use std::time::{Duration, Instant, SystemTime};

use facade_base::service::{self, Locked, Service, StartupChannel};
use facade_base::startup::Attempt;

#[cfg(unix)]
use keeper::Keeper;
#[cfg(windows)]
use windows::Keeper;

/// Runs the keeper until no daemon is running and it holds no CLI.
///
/// Whoever launched it (a command, or a daemon whose keeper died) learns the outcome on the
/// startup channel: `started`, `contention` when another keeper owns the home, or `failed`.
pub fn serve() -> anyhow::Result<()> {
    let channel = StartupChannel::take();
    let lease = service::take_startup_lease();
    match prepare(channel.as_ref(), lease) {
        Ok(Some(keeper)) => {
            if let Some(channel) = channel {
                channel.started();
            }
            keeper.run()
        }
        Ok(None) => {
            log(
                "info",
                "the keeper lock is taken; another keeper serves this home",
            );
            if let Some(channel) = channel {
                channel.contention();
            }
            Ok(())
        }
        Err(err) => {
            if let Some(channel) = channel {
                channel.failed(&format!("{err:#}"));
            }
            Err(err)
        }
    }
}

/// Everything before the keeper can report `started`: nothing inherited but the startup channel,
/// the private home, the keeper lock, and a listening socket. None when another keeper holds the
/// lock.
fn prepare(
    channel: Option<&StartupChannel>,
    lease: Option<File>,
) -> anyhow::Result<Option<Keeper>> {
    service::close_inherited(channel, lease.as_ref())?;
    service::gate_for_test("startup-before-keeper-lock");
    let framework = service::create_private_home()?;
    let startup = Attempt::inherited(&framework);
    if lease.is_some()
        && let Some(attempt) = &startup
    {
        attempt.accept_keeper_candidate()?;
    }
    if let Locked::Contended = service::lock_home(&framework, Service::Keeper)? {
        return Ok(None);
    }
    if let Some(attempt) = &startup {
        attempt.record("keeper", "keeper lock acquired")?;
    }
    drop(lease);
    Keeper::bind(framework, startup).map(Some)
}

/// Writes a line to the keeper's log.
fn log(level: &str, message: &str) {
    facade_base::log::write("keeper", level, message);
}

/// Maintains the log from the keeper's event loop after it takes its service lock.
fn prune_log_if_due(framework: &Path, now: Instant, next: &mut Instant) {
    const INTERVAL: Duration = Duration::from_secs(60 * 60);

    if now < *next {
        return;
    }
    *next = now + INTERVAL;
    let path = framework.join("logs").join("keeper.log");
    if let Err(err) = facade_base::log::prune(&path, SystemTime::now()) {
        log("warn", &format!("could not prune the keeper's log: {err}"));
    }
}
