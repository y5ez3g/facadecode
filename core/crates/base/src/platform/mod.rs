//! What Facade asks of the operating system: processes and their groups, descriptors passed over
//! sockets, the services' locks and start, the installed programs, private files, open-file limits
//! and the socket folder. Every branch by system in this crate is here.

pub mod descriptors;
pub mod files;
pub mod limits;
pub mod programs;
pub mod service;
pub mod unix_process;

mod sockets;

pub use sockets::{daemon_socket, daemon_socket_for, keeper_socket, keeper_socket_for, socket_dir};
