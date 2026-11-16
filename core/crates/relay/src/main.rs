//! `facade-mcp`, the relay between a CLI's MCP client and the Facade daemon's MCP server.
//!
//! The CLI starts it and speaks MCP over its standard input and output, one JSON-RPC message per
//! line. The relay passes each line on to the daemon of the Facade home its environment names,
//! and each line the daemon writes back to its standard output. Where no daemon listens, it runs
//! `facade daemon --detach` from its own folder once and connects when Facade is up. It reads only
//! three things of what it passes on: its own hello, the daemon's `closing`, and each line's
//! `id`, by which it keeps the requests that have no response yet, for the next daemon when this
//! one ends or a newer one takes over. Its arguments go into the hello and nothing else.
//!
//! Exit codes:
//! - 0: its input ended, or could not be read any more, and every request had its response; or
//!   its input ended while no daemon was connected.
//! - 1: its environment names no Facade home, its standard input cannot be opened, or its
//!   standard output cannot be written.

mod daemon;
mod jsonrpc;
mod lines;
mod relay;
mod socket;
#[cfg(windows)]
mod windows;

use std::process::ExitCode;

use crate::daemon::Hello;

fn main() -> ExitCode {
    let socket = match socket::daemon_socket() {
        Ok(socket) => socket,
        Err(why) => {
            relay::log(
                "error",
                &format!("{why}; set FACADE_HOME in this CLI's MCP settings"),
            );
            return ExitCode::FAILURE;
        }
    };
    let hello = Hello {
        args: std::env::args_os()
            .skip(1)
            .map(|word| word.to_string_lossy().into_owned())
            .collect(),
        env: std::env::vars_os()
            .filter_map(|(name, value)| Some((name.into_string().ok()?, value.into_string().ok()?)))
            .collect(),
        cwd: std::env::current_dir()
            .ok()
            .and_then(|cwd| cwd.into_os_string().into_string().ok()),
        reconnect: false,
    };
    relay::run(socket, hello)
}
