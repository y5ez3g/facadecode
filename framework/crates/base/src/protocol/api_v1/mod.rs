//! Typed wire boundary for the independently negotiated daemon and keeper APIs.

mod frame;
mod versions;

pub mod daemon;
pub mod daemon_client;
pub mod keeper;

pub use crate::operations::{EmptyResult, Operation, Topic};
pub use crate::process::ProcessExit;
pub use frame::{
    CallParams, ErrorBody, ErrorData, MAX_LINE_BYTES, MachineMessage, MalformedRequest, NoArgs,
    Notification, ProtocolMismatchDetails, Request, RequestRead, Response, ResponseBody,
    ServerMessage, Size, decode_arguments, encode_line, parse_request, read_machine_message,
    read_request, read_server_message,
};
pub use versions::{ApiVersion, ApiVersions, highest_common};
