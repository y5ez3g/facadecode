//! JSON-RPC 2.0 message types and line framing shared by the daemon protocol and keeper protocol.

use std::fmt;
use std::io::{self, BufRead, Read};

use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::daemon::{Kept, TextWritten};

pub use crate::line::MAX_LINE_BYTES;

/// The JSON-RPC version every message names.
fn jsonrpc() -> String {
    "2.0".to_owned()
}

/// JSON-RPC's own error codes, and the one it leaves to servers that Facade uses for every other
/// failure.
const PARSE_ERROR: i64 = -32700;
const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;
const SERVER_ERROR: i64 = -32000;

/// The response ID is required. It is `null` for a malformed request.
fn nullable_id(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({ "type": ["integer", "null"], "minimum": 0 })
}

/// A protocol value as JSON. Every protocol type serializes; failing to is a bug in this build.
fn to_json(value: impl Serialize) -> Value {
    serde_json::to_value(value).expect("protocol value must serialize")
}

/// A method call. Calls with an ID receive a response; calls without an ID are notifications.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct Request {
    /// Always `2.0`.
    #[serde(default = "jsonrpc")]
    pub jsonrpc: String,
    /// A non-negative integer request ID, at most u64::MAX. Omit it for a notification. The
    /// response repeats this ID.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<u64>,
    /// The method name, such as `hello` or `call`.
    pub method: String,
    /// Parameters for the named method.
    #[serde(default)]
    pub params: Value,
}

impl Request {
    pub fn new(id: Option<u64>, method: &str, params: impl Serialize) -> Self {
        let (method, params) = (method.to_owned(), to_json(params));
        Request {
            jsonrpc: jsonrpc(),
            id,
            method,
            params,
        }
    }
}

/// A response containing either a result or an error.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct Response {
    /// Always `2.0`.
    #[serde(default = "jsonrpc")]
    pub jsonrpc: String,
    /// The request ID, or `null` for a malformed request.
    #[schemars(required, schema_with = "nullable_id")]
    pub id: Option<u64>,
    /// The success result, with the type defined by the method or operation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    /// The error on failure. Omitted when the response contains a result.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorBody>,
}

impl Response {
    pub fn ok(id: u64, result: impl Serialize) -> Self {
        Response::answering(Some(id), Some(to_json(result)), None)
    }

    pub fn failed(id: Option<u64>, error: ErrorBody) -> Self {
        Response::answering(id, None, Some(error))
    }

    fn answering(id: Option<u64>, result: Option<Value>, error: Option<ErrorBody>) -> Self {
        Response {
            jsonrpc: jsonrpc(),
            id,
            result,
            error,
        }
    }
}

/// A message without an ID or response, such as `changed`.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct Notification {
    /// Always `2.0`.
    #[serde(default = "jsonrpc")]
    pub jsonrpc: String,
    /// The notification method, such as `changed`.
    pub method: String,
    /// Parameters for the notification method.
    #[serde(default)]
    pub params: Value,
}

impl Notification {
    pub fn new(method: &str, params: impl Serialize) -> Self {
        let (method, params) = (method.to_owned(), to_json(params));
        Notification {
            jsonrpc: jsonrpc(),
            method,
            params,
        }
    }
}

/// A response or notification received from a server.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum ServerMessage {
    // Notifications come first: a response reads a missing ID as null, so it would take a
    // notification too, while a notification needs a method.
    Notification(Notification),
    Response(Response),
}

/// A request error.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ErrorBody {
    /// The JSON-RPC error code: -32700 for invalid JSON, -32600 for an invalid request, -32601 for
    /// an unknown method, -32602 for invalid arguments, and -32000 for other failures.
    pub code: i64,
    /// A plain-language explanation of the error.
    pub message: String,
    /// Structured error details.
    pub data: ErrorData,
}

/// Error details for clients to inspect.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ErrorData {
    /// The error reason for clients to inspect.
    pub reason: Reason,
    /// With `partial_input` for text: how much of the text reached the agent's terminal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_written: Option<TextWritten>,
    /// With `partial_input` for text: whether its Enter reached the agent's terminal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enter_written: Option<bool>,
    /// With `partial_input` for keys: how many keys reached the agent's terminal whole.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keys_sent: Option<u32>,
    /// With `worktree.create`, or `agent.start` with a `worktree`, that failed after Git made part
    /// or all of the worktree: what it made, which stays.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kept: Option<Kept>,
    /// With a refused start or resume that an entry of the settings file caused - its program not
    /// found, the entry turned off or wrong, or a model or effort the entry gives that its CLI cannot
    /// take - the entry's name, such as `claude`. A client offers to open the settings file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry: Option<String>,
}

/// Error reasons shared by both protocols.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    /// An argument is missing, malformed, or out of range, or the request is unsupported.
    InvalidArgument,
    /// The agent, run, message, or watch does not exist.
    NotFound,
    /// A reference names more than one agent, or the person and an agent: select one by its ID.
    AmbiguousReference,
    /// The agent ended: it takes no more input or messages.
    Ended,
    /// A text or keys call stopped partway: the agent ended, or its terminal stopped taking input,
    /// after part of the call reached the terminal. The error's data says what went in.
    PartialInput,
    /// The operation cannot complete: for example, a stop or a screen watch's snapshot timed out,
    /// or the keeper disconnected.
    Unavailable,
    /// The peers share no protocol version, or a required client kind, operation, or field is
    /// unsupported.
    ProtocolIncompatible,
    /// A message exceeds the line limit, or input exceeds the per-call limit or available queue
    /// room.
    CapacityExceeded,
    /// An internal Facade error.
    Internal,
    /// The caller is not allowed to perform this operation. The keeper accepts only the daemon
    /// holding the daemon lock.
    Refused,
    /// Facade's settings file, `facade.json` in the Facade home, cannot be read as it must, which
    /// stops every launch until it is fixed. The message says each problem, with the file's path
    /// and, where known, its line and column.
    ConfigurationInvalid,
    /// The call was withdrawn by its `cancel` before it took effect: a message whose paste had not
    /// begun, which is not kept.
    Cancelled,
    /// Git could not make a worktree it was asked for: `data.kept` says what it made, which stays.
    WorktreeFailed,
    /// A newer Facade is taking over: the call did nothing, and a client repeats it once the new
    /// daemon answers.
    Upgrading,
    /// The CLI cannot do what the call asks of it: take a model or an effort it has no way to set,
    /// or resume a session that a CLI of another type had.
    Unsupported,
    /// An error reason this build does not recognize.
    #[serde(other)]
    #[schemars(skip)]
    Unknown,
}

impl ErrorBody {
    /// Creates an operation error with the JSON-RPC code for its reason.
    pub fn new(reason: Reason, message: impl Into<String>) -> Self {
        let data = ErrorData {
            reason,
            text_written: None,
            enter_written: None,
            keys_sent: None,
            kept: None,
            entry: None,
        };
        let code = if reason == Reason::InvalidArgument {
            INVALID_PARAMS
        } else {
            SERVER_ERROR
        };
        ErrorBody {
            code,
            message: message.into(),
            data,
        }
    }

    /// The same error under JSON-RPC's own code for what went wrong with the request.
    fn coded(self, code: i64) -> Self {
        ErrorBody { code, ..self }
    }

    /// Creates a parse error for invalid JSON.
    pub fn parse_error(message: impl Into<String>) -> Self {
        ErrorBody::invalid_argument(message).coded(PARSE_ERROR)
    }

    /// Creates an invalid-request error for JSON that is not a request.
    pub fn invalid_request(message: impl Into<String>) -> Self {
        ErrorBody::invalid_argument(message).coded(INVALID_REQUEST)
    }

    /// Creates an error for an unsupported method.
    pub fn method_not_found(message: impl Into<String>) -> Self {
        ErrorBody::invalid_argument(message).coded(METHOD_NOT_FOUND)
    }

    /// Creates an error for an argument that is missing, malformed or out of range.
    pub fn invalid_argument(message: impl Into<String>) -> Self {
        ErrorBody::new(Reason::InvalidArgument, message)
    }

    /// Creates an error for a caller that is not allowed to perform the operation.
    pub fn refused(message: impl Into<String>) -> Self {
        ErrorBody::new(Reason::Refused, message)
    }

    /// Creates an error for an internal Facade failure. Its message keeps the error's causes.
    pub fn internal(error: impl fmt::Display) -> Self {
        ErrorBody::new(Reason::Internal, format!("{error:#}"))
    }

    /// Creates an error for a line longer than [`MAX_LINE_BYTES`], including its newline.
    pub fn line_too_long() -> Self {
        let message = format!("line exceeds the {MAX_LINE_BYTES}-byte limit");
        ErrorBody::new(Reason::CapacityExceeded, message)
    }
}

impl Reason {
    pub fn as_str(self) -> &'static str {
        match self {
            Reason::InvalidArgument => "invalid_argument",
            Reason::NotFound => "not_found",
            Reason::AmbiguousReference => "ambiguous_reference",
            Reason::Ended => "ended",
            Reason::PartialInput => "partial_input",
            Reason::Unavailable => "unavailable",
            Reason::ProtocolIncompatible => "protocol_incompatible",
            Reason::CapacityExceeded => "capacity_exceeded",
            Reason::Internal => "internal",
            Reason::Refused => "refused",
            Reason::ConfigurationInvalid => "configuration_invalid",
            Reason::Cancelled => "cancelled",
            Reason::WorktreeFailed => "worktree_failed",
            Reason::Upgrading => "upgrading",
            Reason::Unsupported => "unsupported",
            Reason::Unknown => "unknown",
        }
    }
}

/// Formats the message and reason: `no agent a9; nothing was done; no agents are listed (not_found)`.
impl fmt::Display for ErrorBody {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let ErrorBody { message, data, .. } = self;
        write!(f, "{message} ({})", data.reason.as_str())
    }
}

impl std::error::Error for ErrorBody {}

/// The outcome of reading a request line.
pub enum RequestRead<T> {
    Request(T),
    /// A malformed request. Send this error and continue reading.
    Malformed(ErrorBody),
    /// An oversized line. Send this error and close the connection; the unread remainder is not a
    /// separate request.
    LineTooLong(ErrorBody),
    Eof,
}

/// One line read into a buffer.
enum Line {
    /// A line within the limit, its newline still on it where it had one.
    Within,
    TooLong,
    Eof,
}

/// Reads one line into `buffer`, keeping at most one byte past the limit: enough to tell that the
/// line is too long, without holding the rest of it.
fn read_line(reader: &mut impl BufRead, buffer: &mut Vec<u8>) -> io::Result<Line> {
    buffer.clear();
    let bound = MAX_LINE_BYTES as u64 + 1;
    if reader.take(bound).read_until(b'\n', buffer)? == 0 {
        return Ok(Line::Eof);
    }
    Ok(if buffer.len() > MAX_LINE_BYTES {
        Line::TooLong
    } else {
        Line::Within
    })
}

fn without_newline(line: &[u8]) -> &[u8] {
    line.strip_suffix(b"\n").unwrap_or(line)
}

/// Reads one request with a bounded buffer. An unterminated line cannot grow beyond the line limit
/// plus one byte.
pub fn read_request<R: BufRead>(
    reader: &mut R,
    buffer: &mut Vec<u8>,
) -> io::Result<RequestRead<Request>> {
    Ok(match read_line(reader, buffer)? {
        Line::Eof => RequestRead::Eof,
        Line::TooLong => RequestRead::LineTooLong(ErrorBody::line_too_long()),
        Line::Within => match parse_request(buffer) {
            Ok(request) => RequestRead::Request(request),
            Err(error) => RequestRead::Malformed(error),
        },
    })
}

/// Parses a request. Invalid JSON returns `-32700`; JSON that is not a request returns `-32600`.
pub fn parse_request(line: &[u8]) -> Result<Request, ErrorBody> {
    let line = without_newline(line);
    serde_json::from_slice(line).map_err(|err| {
        if serde_json::from_slice::<serde::de::IgnoredAny>(line).is_ok() {
            ErrorBody::invalid_request(format!("not a JSON-RPC request: {err}"))
        } else {
            ErrorBody::parse_error(format!("not JSON: {err}"))
        }
    })
}

/// Reads a response or notification. Returns `None` at the end of the stream.
pub fn read_server_message<R: BufRead>(
    reader: &mut R,
    buffer: &mut Vec<u8>,
) -> io::Result<Option<ServerMessage>> {
    match read_line(reader, buffer)? {
        Line::Eof => Ok(None),
        Line::TooLong => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "line exceeds the protocol limit",
        )),
        Line::Within => serde_json::from_slice(without_newline(buffer))
            .map(Some)
            .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err)),
    }
}

/// Encodes a message as JSON followed by a newline.
pub fn encode_line<T: Serialize>(value: &T) -> Vec<u8> {
    let mut line = Vec::new();
    serde_json::to_writer(&mut line, value).expect("protocol value must serialize");
    line.push(b'\n');
    line
}

/// Decodes operation arguments into their declared type.
pub fn decode_arguments<T: DeserializeOwned>(params: Value) -> Result<T, ErrorBody> {
    serde_json::from_value(params).map_err(|err| ErrorBody::invalid_argument(err.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn server_messages_distinguish_notifications_and_responses() {
        let notification: ServerMessage =
            serde_json::from_str(r#"{"jsonrpc":"2.0","method":"changed","params":{"watch":1}}"#)
                .unwrap();
        assert!(matches!(notification, ServerMessage::Notification(n) if n.method == "changed"));
        let response: ServerMessage =
            serde_json::from_str(r#"{"jsonrpc":"2.0","id":3,"result":{}}"#).unwrap();
        assert!(matches!(response, ServerMessage::Response(r) if r.id == Some(3)));
        let unread: ServerMessage = serde_json::from_str(
            r#"{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"m","data":{"reason":"invalid_argument"}}}"#,
        )
        .unwrap();
        assert!(
            matches!(unread, ServerMessage::Response(r) if r.id.is_none() && r.error.is_some())
        );
    }

    #[test]
    fn a_reason_this_build_does_not_know_reads_as_unknown() {
        let error: ErrorBody = serde_json::from_value(
            json!({ "code": -32000, "message": "m", "data": { "reason": "too_tired" } }),
        )
        .unwrap();
        assert_eq!(error.data.reason, Reason::Unknown);
    }

    #[test]
    fn request_reader_reports_parse_errors_and_bounds_line_length() {
        let mut buffer = Vec::new();
        let code = |input: &[u8]| match read_request(&mut &input[..], &mut Vec::new()).unwrap() {
            RequestRead::Malformed(error) | RequestRead::LineTooLong(error) => error.code,
            RequestRead::Request(_) => 0,
            RequestRead::Eof => 1,
        };
        assert_eq!(code(b"{nope\n"), -32700);
        assert_eq!(code(b"[1,2]\n"), -32600);
        assert_eq!(
            code(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"hello\"}\n"),
            0
        );
        assert_eq!(code(b""), 1);
        let long = vec![b'x'; MAX_LINE_BYTES + 10];
        assert!(matches!(
            read_request(&mut &long[..], &mut buffer).unwrap(),
            RequestRead::LineTooLong(_)
        ));
        assert!(
            buffer.len() <= MAX_LINE_BYTES + 1,
            "buffered {} bytes of an unterminated line",
            buffer.len()
        );
    }

    #[test]
    fn a_response_to_a_line_that_was_no_request_carries_a_null_id() {
        let response = Response::failed(None, ErrorBody::parse_error("x"));
        assert_eq!(serde_json::to_value(response).unwrap()["id"], Value::Null);
    }
}
