//! What Facade asks of the operating system: processes, terminals, the services' sockets, locks and
//! start, the installed programs, private files, the person's console and open-file limits. Every
//! branch by system in this crate is here: each module's public items are the same on every system
//! unless their documentation says otherwise, and the code of each system sits beside them.

pub mod clipboard;
pub mod console;
#[cfg(unix)]
pub mod descriptors;
pub mod desktop;
pub mod files;
pub mod install;
pub mod limits;
pub mod programs;
pub mod service;
pub mod sockets;
pub mod ssh;
pub mod system;
pub mod terminal;
pub mod terminal_lines;
pub mod unix_process;

#[cfg(windows)]
mod io_thread;
mod random;
mod socket_paths;

pub use random::random_u64;

/// Whether the person reaches this computer over SSH, and so sits at another one.
fn over_ssh() -> bool {
    ["SSH_CONNECTION", "SSH_TTY"]
        .iter()
        .any(|name| std::env::var_os(name).is_some())
}

/// The public modules, which the crate root re-exports.
pub mod modules {
    #[cfg(unix)]
    pub use super::descriptors;
    pub use super::{
        clipboard, console, desktop, files, install, limits, programs, service, sockets, ssh,
        system, terminal, terminal_lines, unix_process,
    };
}

/// What the crate root re-exports under `paths`: the socket paths, the client's socket and the
/// test for a lost connection.
pub mod paths {
    pub use super::socket_paths::*;
}
