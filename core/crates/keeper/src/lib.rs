//! `facade keeper`: the long-lived parent of every CLI in a Facade home.
//!
//! One keeper runs per home. It starts and stops CLIs, holds a PTY master for each so a terminal
//! survives a daemon crash, and supervises the daemon. Everything happens on a single thread
//! around one `poll`: no tokio, no locks. It never interprets a CLI, a screen or a message. The
//! daemon talks to it in the keeper protocol, [`facade_base::keeper`].

mod cli;
mod keeper;
mod link;
mod supervisor;
mod terminal;
mod wake;

use std::os::fd::RawFd;

use facade_base::service::{self, Locked, Service, StartupChannel};

use keeper::Keeper;

/// Runs the keeper until no daemon is running and it holds no CLI.
///
/// Whoever launched it (a command, or a daemon whose keeper died) learns the outcome on the
/// startup channel: `started`, `contention` when another keeper owns the home, or `failed`.
pub fn serve() -> anyhow::Result<()> {
    let channel = StartupChannel::take();
    let inherited: Vec<RawFd> = channel.iter().map(StartupChannel::raw_fd).collect();
    match prepare(&inherited) {
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

/// Everything before the keeper can report `started`: a clean descriptor table, the private home,
/// the keeper lock, and a bound socket. None when another keeper holds the lock.
fn prepare(inherited: &[RawFd]) -> anyhow::Result<Option<Keeper>> {
    service::close_inherited_fds(inherited)?;
    let core = service::create_private_home()?;
    if let Locked::Contended = service::lock_home(&core, Service::Keeper)? {
        return Ok(None);
    }
    Keeper::bind(core).map(Some)
}

/// Writes a line to the keeper's log.
fn log(level: &str, message: &str) {
    facade_base::log::write("keeper", level, message);
}
