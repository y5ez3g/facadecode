//! The two protocols Facade's programs speak: the daemon protocol ([`daemon`], with its blocking
//! client [`daemon_client`]) and the keeper protocol ([`keeper`]). Both are JSON-RPC lines
//! ([`jsonrpc`]) whose calls are typed operations and topics ([`operations`]); terminal bytes
//! travel as [`base64`].

pub mod address;
pub mod api_v1;
pub mod base64;
pub mod daemon;
pub mod daemon_client;
pub mod jsonrpc;
pub mod keeper;
pub mod machine;
pub mod operations;
pub mod v3;
