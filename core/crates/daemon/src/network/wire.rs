//! The machine introduction and JSON-RPC lines carried by each end of a session.

use std::io;
use std::time::Duration;

use facade_base::daemon::{
    ClientKind, DAEMON_PROTOCOL_VERSION, HelloParams, HelloResult, MIN_DAEMON_PROTOCOL_VERSION,
    methods,
};
use facade_base::jsonrpc::{
    ErrorBody, MAX_LINE_BYTES, Reason, Request, Response, decode_arguments, encode_line,
};
use facade_base::machine::{
    AdvertiseParams, ExecutionOutcome, ForwardParams, MachineHello, MachineIdentity,
    ProtocolMismatch, Unavailable,
};
use facade_base::operations::EmptyResult;
use serde::Serialize;
use serde_json::Value;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWrite, AsyncWriteExt};

const INTRODUCTION_TIMEOUT: Duration = Duration::from_secs(10);
const HELLO_ID: u64 = 0;
const INITIAL_TABLE_ID: u64 = 1;
pub(super) const FIRST_REQUEST_ID: u64 = INITIAL_TABLE_ID + 1;

pub(super) enum Frame {
    Request(Request),
    Response(Response),
}

/// The hop reads only the route and deadline. Only the destination decodes the application fields.
pub(super) struct Forward {
    pub(super) route: Vec<String>,
    pub(super) time_left_ms: Option<u64>,
    fields: serde_json::Map<String, Value>,
}

impl Forward {
    pub(super) fn from_origin(params: ForwardParams) -> Self {
        Self::decode(serde_json::to_value(params).expect("forward parameters serialize"))
            .expect("forward parameters form an envelope")
    }

    pub(super) fn decode(params: Value) -> Result<Self, ErrorBody> {
        let Value::Object(mut fields) = params else {
            return Err(ErrorBody::invalid_argument(
                "Expected a forwarding envelope.",
            ));
        };
        let route = decode_arguments(fields.remove("route").unwrap_or(Value::Null))?;
        let time_left_ms = decode_arguments(fields.remove("time_left_ms").unwrap_or(Value::Null))?;
        Ok(Self {
            route,
            time_left_ms,
            fields,
        })
    }

    pub(super) fn encode(mut self) -> Value {
        self.fields.insert(
            "route".to_owned(),
            serde_json::to_value(self.route).expect("route serializes"),
        );
        if let Some(time_left_ms) = self.time_left_ms {
            self.fields
                .insert("time_left_ms".to_owned(), Value::from(time_left_ms));
        }
        Value::Object(self.fields)
    }
}

/// For a timed call, leave the frame open so the remaining time is written after the body.
pub(super) fn forward_line(id: u64, mut forward: Forward, timed: bool) -> Vec<u8> {
    forward.time_left_ms = None;
    let mut line = encode_line(&Request::new(Some(id), methods::FORWARD, forward.encode()));
    if timed {
        let prefix = line
            .strip_suffix(b"}}\n")
            .expect("the request ends in its params object");
        line.truncate(prefix.len());
    }
    line
}

pub(super) fn forward_end(left: u64) -> String {
    let closing = "}}\n";
    format!(",\"time_left_ms\":{left}{closing}")
}

pub(super) struct Reader<R> {
    read: R,
    line: Vec<u8>,
}

impl<R: AsyncBufRead + Unpin> Reader<R> {
    pub(super) fn new(read: R) -> Self {
        Self {
            read,
            line: Vec::new(),
        }
    }

    /// Keeps the original buffered reader intact across the handshake.
    pub(super) async fn next(&mut self) -> Result<Option<Frame>, ErrorBody> {
        self.line.clear();
        let count = (&mut self.read)
            .take(MAX_LINE_BYTES as u64 + 1)
            .read_until(b'\n', &mut self.line)
            .await
            .map_err(io_error)?;
        if count == 0 {
            return Ok(None);
        }
        if count > MAX_LINE_BYTES {
            return Err(ErrorBody::line_too_long());
        }
        match parse(&self.line) {
            Ok(frame) if self.line.ends_with(b"\n") => Ok(Some(frame)),
            _ => Err(ErrorBody::invalid_argument(
                "Expected a machine protocol line.",
            )),
        }
    }

    async fn initial(&mut self) -> Result<Frame, ErrorBody> {
        match self.next().await {
            Ok(Some(frame)) => Ok(frame),
            Ok(None) => Err(ErrorBody::new(
                Reason::Unavailable,
                "The machine session closed during its handshake.",
            )),
            Err(error) if error.data.reason == Reason::InvalidArgument => Err(unexpected_output()),
            Err(error) => Err(error),
        }
    }
}

fn parse(line: &[u8]) -> serde_json::Result<Frame> {
    let mut frame: serde_json::Map<String, Value> = serde_json::from_slice(line)?;
    if frame.contains_key("method") {
        return decode_frame(frame).map(Frame::Request);
    }
    // A null application result is a result as well.
    let result = frame.remove("result");
    let mut response: Response = decode_frame(frame)?;
    response.result = result;
    Ok(Frame::Response(response))
}

fn decode_frame<T: serde::de::DeserializeOwned>(
    frame: serde_json::Map<String, Value>,
) -> serde_json::Result<T> {
    serde_json::from_value(Value::Object(frame))
}

pub(super) fn io_error(error: io::Error) -> ErrorBody {
    ErrorBody::new(
        Reason::Unavailable,
        format!("Machine session I/O failed: {error}"),
    )
}

pub(super) fn unavailable(
    machine: MachineIdentity,
    execution: ExecutionOutcome,
    detail: &str,
) -> ErrorBody {
    let outcome = match execution {
        ExecutionOutcome::NotExecuted => "The request did not run.",
        ExecutionOutcome::OutcomeUnknown => "The result is unknown.",
    };
    let mut error = ErrorBody::new(
        Reason::Unavailable,
        format!("{}: {detail} {outcome}", machine.name),
    );
    error.data.unavailable = Some(Unavailable {
        execution,
        machine: Some(machine),
        window: None,
        matches: Vec::new(),
        unanswered: Vec::new(),
    });
    error
}

pub(super) fn protocol(local: &MachineHello, remote: &MachineHello) -> Result<(), ErrorBody> {
    let supported = [MIN_DAEMON_PROTOCOL_VERSION, DAEMON_PROTOCOL_VERSION];
    if remote.protocol == supported {
        return Ok(());
    }
    let mut error = ErrorBody::new(
        Reason::ProtocolIncompatible,
        format!(
            "Facade {} supports daemon protocol {:?}, but {} is running Facade {} with protocol {:?}. Install a build with protocol {} on {}.",
            local.build,
            supported,
            remote.name,
            remote.build,
            remote.protocol,
            supported[1],
            remote.name,
        ),
    );
    error.data.protocol = Some(ProtocolMismatch {
        local_build: local.build.clone(),
        local_protocol: supported,
        remote_build: remote.build.clone(),
        remote_protocol: remote.protocol,
    });
    Err(error)
}

pub(super) async fn introduce(
    read: &mut Reader<impl AsyncBufRead + Unpin>,
    write: &mut (impl AsyncWrite + Unpin),
    local: MachineHello,
) -> Result<MachineHello, ErrorBody> {
    in_time(async {
        let hello = HelloParams {
            protocol: local.protocol,
            build: local.build.clone(),
            kind: ClientKind::Machine,
            agent: None,
            sessions: Vec::new(),
            window: None,
            numbers_given: None,
            machine: Some(local.clone()),
        };
        send(write, &Request::new(Some(HELLO_ID), methods::HELLO, hello)).await?;
        let Frame::Response(response) = read.initial().await? else {
            return Err(unexpected_output());
        };
        if response.jsonrpc != "2.0" || response.id != Some(HELLO_ID) {
            return Err(unexpected_output());
        }
        if let Some(error) = response.error {
            return Err(error);
        }
        let hello: HelloResult = decode_arguments(response.result.ok_or_else(unexpected_output)?)
            .map_err(|_| unexpected_output())?;
        let remote = hello.machine.ok_or_else(|| {
            ErrorBody::new(
                Reason::ProtocolIncompatible,
                "Expected a machine introduction.",
            )
        })?;
        protocol(&local, &remote)?;
        if hello.protocol != DAEMON_PROTOCOL_VERSION
            || hello.build != remote.build
            || hello.machine_id != remote.machine_id
        {
            return Err(ErrorBody::invalid_argument(
                "Inconsistent machine introduction.",
            ));
        }
        Ok(remote)
    })
    .await
}

/// Each peer reserves admission before accepting the other's initial table. Later tables are
/// notifications. The returned reservation is only usable after both peers accepted.
pub(super) async fn exchange_tables<T>(
    read: &mut Reader<impl AsyncBufRead + Unpin>,
    write: &mut (impl AsyncWrite + Unpin),
    machines: Vec<facade_base::machine::MachineInfo>,
    reserve: impl FnOnce(AdvertiseParams) -> Result<T, ErrorBody>,
) -> Result<T, ErrorBody> {
    let received = in_time(async {
        let table = Request::new(
            Some(INITIAL_TABLE_ID),
            methods::ADVERTISE,
            AdvertiseParams { machines },
        );
        let sending = send(write, &table);
        let receiving = async {
            match read.initial().await? {
                Frame::Request(request)
                    if request.jsonrpc == "2.0"
                        && request.id == Some(INITIAL_TABLE_ID)
                        && request.method == methods::ADVERTISE =>
                {
                    decode_arguments(request.params)
                }
                _ => Err(ErrorBody::invalid_argument(
                    "Expected the peer's machine table.",
                )),
            }
        };
        let (_, table) = tokio::try_join!(sending, receiving)?;
        Ok(table)
    })
    .await?;
    let admission = match reserve(received) {
        Ok(admission) => admission,
        Err(error) => {
            reject(write, Some(INITIAL_TABLE_ID), &error).await;
            return Err(error);
        }
    };
    in_time(async {
        let accepted = Response::ok(INITIAL_TABLE_ID, EmptyResult {});
        let sending = send(write, &accepted);
        let receiving = async {
            let Frame::Response(response) = read.initial().await? else {
                return Err(bad_confirmation());
            };
            if response.jsonrpc != "2.0" || response.id != Some(INITIAL_TABLE_ID) {
                return Err(bad_confirmation());
            }
            match (response.result, response.error) {
                (Some(Value::Object(result)), None) if result.is_empty() => Ok(()),
                (None, Some(error)) => Err(error),
                _ => Err(bad_confirmation()),
            }
        };
        tokio::try_join!(sending, receiving).map(|_| ())
    })
    .await?;
    Ok(admission)
}

fn bad_confirmation() -> ErrorBody {
    ErrorBody::invalid_argument("Expected the peer's machine table confirmation.")
}

/// A rejection is best effort when the link is about to close.
pub(super) async fn reject(
    write: &mut (impl AsyncWrite + Unpin),
    id: Option<u64>,
    error: &ErrorBody,
) {
    let response = Response::failed(id, error.clone());
    let _ = tokio::time::timeout(Duration::from_millis(250), send(write, &response)).await;
}

async fn in_time<T>(work: impl Future<Output = Result<T, ErrorBody>>) -> Result<T, ErrorBody> {
    tokio::time::timeout(INTRODUCTION_TIMEOUT, work)
        .await
        .unwrap_or_else(|_| {
            Err(ErrorBody::new(
                Reason::Unavailable,
                "The machine handshake timed out.",
            ))
        })
}

fn unexpected_output() -> ErrorBody {
    ErrorBody::invalid_argument(
        "Unexpected SSH stdout during the machine handshake. Ensure the remote shell startup files do not print to stdout for non-interactive sessions.",
    )
}

pub(super) async fn send(
    write: &mut (impl AsyncWrite + Unpin),
    frame: &impl Serialize,
) -> Result<(), ErrorBody> {
    let line = encode_line(frame);
    if line.len() > MAX_LINE_BYTES {
        return Err(ErrorBody::line_too_long());
    }
    write.write_all(&line).await.map_err(io_error)?;
    write.flush().await.map_err(io_error)
}
