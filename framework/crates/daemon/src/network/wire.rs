//! The API v1 introduction and JSON-RPC lines carried by each end of a machine session.

use std::io;
use std::time::Duration;

use facade_base::api_v1::daemon::{
    self, AdvertiseParams, ClientKind, ConnectedMachine, ForwardParams, ForwardRequest,
    HelloParams, MachineHelloParams, methods,
};
use facade_base::api_v1::{
    ApiVersion, ApiVersions, EmptyResult, ErrorBody, ErrorData, MAX_LINE_BYTES, MachineMessage,
    MalformedRequest, Request, Response, ResponseBody, Topic, decode_arguments, encode_line,
    parse_request, read_machine_message,
};
use facade_base::model::machine::{ExecutionOutcome, MachineIdentity};
use serde::Serialize;
use serde_json::{Value, json};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use super::{MachineGreeting, SessionWork};

const INTRODUCTION_TIMEOUT: Duration = Duration::from_secs(10);
pub(super) const CLOSE_GRACE: Duration = Duration::from_millis(250);
const HELLO_ID: u64 = 0;
const INITIAL_TABLE_ID: u64 = 1;
pub(super) const FIRST_REQUEST_ID: u64 = INITIAL_TABLE_ID + 1;

pub(super) const REQUEST_TIMEOUT: &str = "The request timed out.";
pub(super) const TIMEOUT_BEFORE_SEND: &str = "The request timed out before it was sent.";
pub(super) const TIMEOUT_BEFORE_TARGET: &str = "The request timed out before reaching the machine.";

pub(super) fn work(forward: &ForwardParams) -> Option<SessionWork> {
    match &forward.request {
        ForwardRequest::Call(_) => Some(SessionWork::Call),
        ForwardRequest::Watch(watch) if watch.topic == daemon::AttachTopic::NAME => {
            Some(SessionWork::Viewer)
        }
        ForwardRequest::Watch(_) => None,
    }
}

/// For a timed call, leave the frame open so the remaining time is written after the body.
pub(super) fn forward_line(id: u64, mut forward: ForwardParams, timed: bool) -> Vec<u8> {
    forward.time_left_ms = None;
    let mut line = encode_line(&Request::new(Some(id), methods::FORWARD, forward));
    if timed {
        let prefix = line
            .strip_suffix(b"}}\n")
            .expect("the request ends in its params object");
        line.truncate(prefix.len());
    }
    line
}

pub(super) fn forward_end(left: u64) -> String {
    format!(",\"time_left_ms\":{left}}}}}\n")
}

pub(super) struct Reader<R> {
    read: R,
    line: Vec<u8>,
    parsed_line: Vec<u8>,
}

impl<R: AsyncBufRead + Unpin> Reader<R> {
    pub(super) fn new(read: R) -> Self {
        Self {
            read,
            line: Vec::new(),
            parsed_line: Vec::new(),
        }
    }

    /// Keeps the original buffered reader intact across the handshake.
    pub(super) async fn next(&mut self) -> Result<Option<MachineMessage>, MalformedRequest> {
        self.line.clear();
        let count = (&mut self.read)
            .take(MAX_LINE_BYTES as u64 + 1)
            .read_until(b'\n', &mut self.line)
            .await
            .map_err(|error| MalformedRequest {
                id: None,
                error: io_error(error),
            })?;
        if count == 0 {
            return Ok(None);
        }
        if count > MAX_LINE_BYTES {
            return Err(MalformedRequest {
                id: None,
                error: ErrorBody::line_too_long(),
            });
        }
        if !self.line.ends_with(b"\n") {
            return Err(MalformedRequest {
                id: None,
                error: ErrorBody::invalid_request("Incomplete machine protocol line."),
            });
        }
        read_machine_message(&mut self.line.as_slice(), &mut self.parsed_line).map_err(|_| {
            parse_request(&self.line)
                .err()
                .unwrap_or_else(|| MalformedRequest {
                    id: None,
                    error: ErrorBody::invalid_request("Invalid machine protocol line."),
                })
        })
    }

    async fn initial(&mut self) -> Result<MachineMessage, ErrorBody> {
        self.next()
            .await
            .map_err(|malformed| malformed.error)?
            .ok_or_else(|| {
                error(
                    "unavailable",
                    "The machine session closed during its handshake.",
                )
            })
    }
}

pub(super) fn error(reason: &str, message: impl Into<String>) -> ErrorBody {
    ErrorBody {
        code: -32000,
        message: message.into(),
        data: ErrorData {
            reason: reason.to_owned(),
            details: None,
        },
    }
}

pub(super) fn detail(error: &mut ErrorBody, name: &str, value: Value) {
    error
        .data
        .details
        .get_or_insert_default()
        .insert(name.to_owned(), value);
}

pub(super) fn io_error(error: io::Error) -> ErrorBody {
    self::error(
        "unavailable",
        format!("Machine session I/O failed: {error}"),
    )
}

pub(super) fn unavailable(
    machine: MachineIdentity,
    execution: ExecutionOutcome,
    detail: &str,
) -> ErrorBody {
    let message = unavailable_message(&machine, execution, detail);
    let mut error = error("unavailable", message);
    error.data.details = Some(serde_json::Map::from_iter([
        ("execution".to_owned(), json!(execution)),
        ("machine".to_owned(), json!(machine)),
    ]));
    error
}

fn unavailable_message(
    machine: &MachineIdentity,
    execution: ExecutionOutcome,
    detail: &str,
) -> String {
    let outcome = match execution {
        ExecutionOutcome::NotExecuted => "The request did not run.",
        ExecutionOutcome::OutcomeUnknown => "The result is unknown.",
    };
    format!("{}: {detail} {outcome}", machine.name)
}

pub(super) fn reports_timeout(error: &ErrorBody) -> bool {
    let Some(details) = &error.data.details else {
        return false;
    };
    let Some(machine) = details
        .get("machine")
        .and_then(|value| serde_json::from_value::<MachineIdentity>(value.clone()).ok())
    else {
        return false;
    };
    let Some(execution) = details
        .get("execution")
        .and_then(|value| serde_json::from_value::<ExecutionOutcome>(value.clone()).ok())
    else {
        return false;
    };
    [REQUEST_TIMEOUT, TIMEOUT_BEFORE_SEND, TIMEOUT_BEFORE_TARGET]
        .into_iter()
        .any(|detail| error.message == unavailable_message(&machine, execution, detail))
}

pub(super) async fn introduce(
    read: &mut Reader<impl AsyncBufRead + Unpin>,
    write: &mut (impl AsyncWrite + Unpin),
    local: ConnectedMachine,
    foreground: bool,
) -> Result<MachineGreeting, ErrorBody> {
    in_time(async {
        let offered = ApiVersions::new(vec![ApiVersion::MIN]).expect("the machine API v1 offer");
        let hello = HelloParams {
            api_versions: offered.clone(),
            build: local.build,
            kind: ClientKind::Machine,
            machine: Some(MachineHelloParams {
                machine_id: local.machine_id,
                boot_id: local.boot_id,
                name: local.name,
                ssh_cleans_processes: local.ssh_cleans_processes,
            }),
            foreground,
        };
        send(write, &Request::new(Some(HELLO_ID), methods::HELLO, hello)).await?;
        let response = read.initial().await.map_err(|error| {
            if matches!(error.code, -32700 | -32600) {
                unexpected_output()
            } else {
                error
            }
        })?;
        let MachineMessage::Response(response) = response else {
            return Err(unexpected_output());
        };
        if response.id != Some(HELLO_ID) {
            return Err(unexpected_output());
        }
        let result = match response.body {
            ResponseBody::Result(result) => result,
            ResponseBody::Error(error) => return Err(error),
        };
        let hello = daemon::decode_hello_result(result, &offered, ClientKind::Machine)?;
        let remote = hello.machine.ok_or_else(unexpected_output)?;
        Ok(MachineGreeting {
            api_version: hello.api_version,
            machine: ConnectedMachine {
                machine_id: hello.machine_id,
                boot_id: remote.boot_id,
                name: remote.name,
                build: hello.build,
                ssh_cleans_processes: remote.ssh_cleans_processes,
            },
            foreground: false,
        })
    })
    .await
}

/// Each peer reserves admission before accepting the other's initial table. Later tables are
/// notifications. The returned reservation is only usable after both peers accepted.
pub(super) async fn exchange_tables<T>(
    read: &mut Reader<impl AsyncBufRead + Unpin>,
    write: &mut (impl AsyncWrite + Unpin),
    table: AdvertiseParams,
    reserve: impl FnOnce(AdvertiseParams) -> Result<T, ErrorBody>,
) -> Result<T, ErrorBody> {
    let received = in_time(async {
        let table = Request::new(Some(INITIAL_TABLE_ID), methods::ADVERTISE, table);
        let sending = send(write, &table);
        let receiving = async {
            match read.initial().await? {
                MachineMessage::Request(request)
                    if request.id == Some(INITIAL_TABLE_ID)
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
    .await;
    let admission = match received.and_then(reserve) {
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
            let MachineMessage::Response(response) = read.initial().await? else {
                return Err(bad_confirmation());
            };
            if response.id != Some(INITIAL_TABLE_ID) {
                return Err(bad_confirmation());
            }
            match response.body {
                ResponseBody::Result(result) => decode_arguments::<EmptyResult>(result)
                    .map(|_| ())
                    .map_err(|_| bad_confirmation()),
                ResponseBody::Error(error) => Err(error),
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
    let _ = tokio::time::timeout(CLOSE_GRACE, send(write, &response)).await;
}

pub(super) async fn in_time<T>(
    work: impl Future<Output = Result<T, ErrorBody>>,
) -> Result<T, ErrorBody> {
    tokio::time::timeout(INTRODUCTION_TIMEOUT, work)
        .await
        .unwrap_or_else(|_| Err(error("unavailable", "The machine handshake timed out.")))
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
