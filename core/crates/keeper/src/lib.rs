//! `facade keeper`: the long-lived parent of every CLI in a Facade home.
//!
//! One keeper runs per home. It starts and stops CLIs, holds a copy of each one's terminal so a
//! terminal survives a daemon crash, and supervises the daemon. Everything happens on a single
//! thread around one wait, `poll` on Unix and an I/O completion port on Windows: no tokio, no
//! locks. It never interprets a CLI, a screen or a message. The daemon talks to it in the keeper
//! protocol, [`facade_base::keeper`].

#[cfg(unix)]
mod cli;
#[cfg(unix)]
mod keeper;
#[cfg(unix)]
mod link;
#[cfg(unix)]
mod supervisor;
#[cfg(unix)]
mod terminal;
#[cfg(unix)]
mod wake;
#[cfg(windows)]
mod windows;

use facade_base::service::{self, Locked, Service, StartupChannel};

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
    match prepare(channel.as_ref()) {
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
fn prepare(channel: Option<&StartupChannel>) -> anyhow::Result<Option<Keeper>> {
    service::close_inherited(channel)?;
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
