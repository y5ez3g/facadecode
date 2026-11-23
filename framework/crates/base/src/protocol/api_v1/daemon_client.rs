//! Blocking client for the authenticated daemon API v1 connection.

use std::collections::VecDeque;
use std::io::{self, BufRead, BufReader, ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::paths::{
    ClientSocket, allow_timeout_on_hangup, clear_client_timeouts, connect_client_until,
    is_connection_lost,
};

use super::daemon::{
    self, AgentSend, AgentStart, ChangedParams, ClientKind, ClosingParams, HANDOVER_TIME,
    HelloParams, HelloResult, UnwatchParams, WatchEndedParams, WatchParams, WatchResult, methods,
};
use super::{
    ApiVersions, CallParams, EmptyResult, ErrorBody, NoArgs, Notification, Operation, Request,
    Response, ResponseBody, ServerMessage, Topic, encode_line, read_server_message,
};

const HELLO_ID: u64 = 1;
const TAKEOVER_POLL: Duration = Duration::from_millis(100);

/// The time a client gives a newer build to answer once it takes over: the old daemon hands over,
/// then the keeper gets 10 seconds to start the new one.
pub fn takeover_timeout() -> Duration {
    HANDOVER_TIME + Duration::from_secs(10)
}

/// A call the daemon's end cut off before its answer: what it did is not known.
#[derive(Debug)]
pub struct Cut;

impl std::fmt::Display for Cut {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(
            "the daemon disconnected before responding; the outcome is unknown; check \
             `facade list`",
        )
    }
}

impl std::error::Error for Cut {}

/// A local connection that completed the daemon API v1 hello.
pub struct DaemonClient {
    pub writer: ClientSocket,
    pub hello_result: HelloResult,
    /// The build named by the retiring daemon.
    pub closing: Option<String>,
    reader: BufReader<ClientSocket>,
    line: Vec<u8>,
    next_id: u64,
    unread: VecDeque<Notification>,
    /// The socket path of a reconnectable terminal session.
    origin: Option<PathBuf>,
}

impl DaemonClient {
    /// Opens a terminal connection and gives its hello until the deadline to complete.
    pub fn connect(
        socket: &Path,
        until: Instant,
        opening: &mut dyn FnMut(&ClientSocket) -> bool,
    ) -> anyhow::Result<Option<Self>> {
        let Some(writer) = connect_transport(socket, until, opening)? else {
            return Ok(None);
        };
        let Ok(time) = remaining(until) else {
            return Ok(None);
        };
        // A peer that closed during opening can refuse the initial timeout setup.
        if writer.set_read_timeout(Some(time)).is_err() {
            return Ok(None);
        }
        match Self::hello_as(writer, ClientKind::Terminal, Some(until)) {
            Ok(mut client)
                if client.writer.set_read_timeout(None).is_ok()
                    && client.writer.set_write_timeout(None).is_ok()
                    && remaining(until).is_ok() =>
            {
                client.origin = Some(socket.to_owned());
                Ok(Some(client))
            }
            Ok(_) => Ok(None),
            Err(error) if upgrading(&error) => Ok(None),
            Err(error)
                if error
                    .downcast_ref::<io::Error>()
                    .is_some_and(transient_transport) =>
            {
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }

    /// Completes hello on an internal socket whose MCP actor the daemon already proved.
    pub fn hello_actor(writer: ClientSocket) -> anyhow::Result<Self> {
        Self::hello_as(writer, ClientKind::Mcp, None)
    }

    fn hello_as(
        mut writer: ClientSocket,
        kind: ClientKind,
        until: Option<Instant>,
    ) -> anyhow::Result<Self> {
        let mut reader = BufReader::new(writer.try_clone()?);
        let mut line = Vec::new();
        let offered = ApiVersions::new(daemon::SUPPORTED_API_VERSIONS.to_vec())
            .expect("the daemon API has a supported version");
        let request = Request::new(
            Some(HELLO_ID),
            methods::HELLO,
            HelloParams {
                api_versions: offered.clone(),
                build: crate::build_id(),
                kind,
                machine: None,
                foreground: false,
            },
        );
        write_frame(&mut writer, &encode_line(&request), until)?;

        let response = match read_frame(&mut reader, &mut line, until)? {
            Some(ServerMessage::Response(response)) if answers(&response, HELLO_ID) => response,
            Some(_) => anyhow::bail!("the Orchestrator did not respond to hello"),
            None => {
                return Err(io::Error::new(
                    ErrorKind::UnexpectedEof,
                    "the Orchestrator closed before hello",
                )
                .into());
            }
        };
        let result = response_result(response)?;
        let hello_result = daemon::decode_hello_result(result, &offered, kind)?;

        Ok(Self {
            writer,
            hello_result,
            closing: None,
            reader,
            line,
            next_id: HELLO_ID + 1,
            unread: VecDeque::new(),
            origin: None,
        })
    }

    /// Calls an operation and returns its typed result.
    pub fn call<O: Operation>(&mut self, args: O::Args) -> anyhow::Result<O::Result> {
        self.exchange(methods::CALL, &call_params::<O>(args)?)
    }

    /// Calls once on this connection within an absolute deadline, including partial socket
    /// transfers and closing acknowledgments. Discard the connection after a timeout because a
    /// request or response frame may be incomplete.
    pub fn call_until<O: Operation>(
        &mut self,
        args: O::Args,
        until: Instant,
    ) -> anyhow::Result<O::Result> {
        let params = call_params::<O>(args)?;
        let result = self
            .ask(methods::CALL, &params, Some(until))
            .and_then(|id| self.answer_to(id, Some(until)));
        let reset = clear_client_timeouts(&self.writer);
        let result = result?;
        reset?;
        Ok(result)
    }

    /// Repeats an interrupted start or send with its original business request ID.
    pub fn call_with_request_id<O: Operation>(
        &mut self,
        args: O::Args,
        after_crash: bool,
    ) -> anyhow::Result<(O::Result, bool)>
    where
        O::Args: Clone,
    {
        let params = call_params::<O>(args)?;
        let can_repeat = [AgentStart::NAME, AgentSend::NAME].contains(&O::NAME)
            && params
                .args
                .get("request_id")
                .and_then(Value::as_str)
                .is_some_and(|id| !id.is_empty());
        match self.exchange(methods::CALL, &params) {
            Ok(result) => Ok((result, false)),
            Err(error)
                if error.is::<Cut>()
                    && can_repeat
                    && self.origin.is_some()
                    && (after_crash || self.closing.is_some()) =>
            {
                self.connect_again()?;
                Ok((self.exchange(methods::CALL, &params)?, true))
            }
            Err(error) => Err(error),
        }
    }

    /// Starts a call without waiting, returning its connection-local request ID.
    pub fn begin_call<O: Operation>(&mut self, args: O::Args) -> anyhow::Result<u64> {
        self.ask(methods::CALL, &call_params::<O>(args)?, None)
    }

    pub fn result<O: Operation>(&mut self, id: u64) -> anyhow::Result<O::Result> {
        self.answer_to(id, None)
    }

    pub fn watch<T: Topic>(&mut self, args: T::Args) -> anyhow::Result<(u64, T::Snapshot)> {
        let params = WatchParams {
            topic: T::NAME.to_owned(),
            args: serde_json::to_value(args)?,
        };
        let started: WatchResult = self.exchange(methods::WATCH, &params)?;
        Ok((started.watch, serde_json::from_value(started.snapshot)?))
    }

    /// Ends this connection's watch and waits for its acknowledgment.
    pub fn unwatch(&mut self, watch: u64) -> anyhow::Result<()> {
        let id = self.ask(methods::UNWATCH, &UnwatchParams { watch }, None)?;
        let _: EmptyResult = self.answer_to(id, None)?;
        self.unread.retain(|notification| {
            !matches!(
                notification.method.as_str(),
                methods::CHANGED | methods::WATCH_ENDED
            ) || notification.params.get("watch").and_then(Value::as_u64) != Some(watch)
        });
        Ok(())
    }

    pub fn next_change<T: Topic>(&mut self, watch: u64) -> anyhow::Result<Option<T::Change>> {
        while let Some(notification) = self.next_notification()? {
            match notification.method.as_str() {
                methods::CLOSING => {
                    self.record_closing(notification)?;
                    return Ok(None);
                }
                methods::WATCH_ENDED => {
                    let ended: WatchEndedParams = serde_json::from_value(notification.params)?;
                    if ended.watch == watch {
                        return Err(ended.error.into());
                    }
                }
                methods::CHANGED => {
                    let changed: ChangedParams = serde_json::from_value(notification.params)?;
                    if changed.watch == watch {
                        return Ok(Some(serde_json::from_value(changed.change)?));
                    }
                }
                _ => {}
            }
        }
        Ok(None)
    }

    /// Detaches the original buffered reader and writer after machine authorization.
    pub fn into_stream(self) -> (BufReader<ClientSocket>, ClientSocket) {
        (self.reader, self.writer)
    }

    pub fn disable_auto_reconnect(&mut self) {
        self.origin = None;
    }

    /// Replaces this Terminal connection once hello succeeds at its saved endpoint.
    pub fn reconnect_until(&mut self, until: Instant) -> anyhow::Result<()> {
        let socket = self
            .origin
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("this connection cannot connect again"))?;
        loop {
            remaining(until)?;
            if let Some(client) = Self::connect(socket, until, &mut |_| true)? {
                *self = client;
                return Ok(());
            }
            std::thread::sleep(TAKEOVER_POLL.min(remaining(until)?));
        }
    }

    fn connect_again(&mut self) -> anyhow::Result<()> {
        let timeout = takeover_timeout();
        match self.reconnect_until(Instant::now() + timeout) {
            Err(error)
                if error
                    .downcast_ref::<io::Error>()
                    .is_some_and(|error| error.kind() == ErrorKind::TimedOut) =>
            {
                anyhow::bail!(
                    "the Orchestrator did not respond within {} seconds of a newer build taking over",
                    timeout.as_secs()
                );
            }
            result => result,
        }
    }

    /// Acknowledges closing after the caller has stopped any concurrent writer.
    pub fn respond_to_closing(&mut self) {
        let _ = self.acknowledge_closing(None);
    }

    fn acknowledge_closing(&mut self, until: Option<Instant>) -> io::Result<()> {
        let frame = encode_line(&Notification::new(methods::CLOSING, NoArgs {}));
        write_frame(&mut self.writer, &frame, until)
    }

    fn record_closing(&mut self, notification: Notification) -> anyhow::Result<()> {
        let closing: ClosingParams = serde_json::from_value(notification.params)?;
        self.closing = Some(closing.build);
        Ok(())
    }

    fn exchange<T: DeserializeOwned>(
        &mut self,
        method: &str,
        params: &impl Serialize,
    ) -> anyhow::Result<T> {
        loop {
            let id = self.ask(method, params, None)?;
            let answer = self.answer_to(id, None);
            if !matches!(&answer, Err(error) if upgrading(error)) || self.origin.is_none() {
                return answer;
            }
            self.connect_again()?;
        }
    }

    fn ask(
        &mut self,
        method: &str,
        params: &impl Serialize,
        until: Option<Instant>,
    ) -> anyhow::Result<u64> {
        let id = self.next_id;
        self.next_id = id
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("request IDs exhausted"))?;
        let frame = encode_line(&Request::new(Some(id), method, params));
        write_frame(&mut self.writer, &frame, until)?;
        Ok(id)
    }

    fn answer_to<T: DeserializeOwned>(
        &mut self,
        id: u64,
        until: Option<Instant>,
    ) -> anyhow::Result<T> {
        loop {
            match read_frame(&mut self.reader, &mut self.line, until) {
                Ok(Some(ServerMessage::Response(response))) if answers(&response, id) => {
                    return response_result(response);
                }
                Ok(Some(ServerMessage::Response(_))) => {}
                Ok(Some(ServerMessage::Notification(notification))) => {
                    if notification.method == methods::CLOSING {
                        self.record_closing(notification)?;
                        if let Err(error) = self.acknowledge_closing(until)
                            && until.is_some()
                            && error.kind() == ErrorKind::TimedOut
                        {
                            return Err(error.into());
                        }
                    } else {
                        self.unread.push_back(notification);
                    }
                }
                Err(error) if error.kind() == ErrorKind::InvalidData => return Err(error.into()),
                Err(error) if until.is_some() && error.kind() == ErrorKind::TimedOut => {
                    return Err(error.into());
                }
                Ok(None) | Err(_) => return Err(Cut.into()),
            }
        }
    }

    fn next_notification(&mut self) -> io::Result<Option<Notification>> {
        if let Some(notification) = self.unread.pop_front() {
            return Ok(Some(notification));
        }
        while let Some(message) = read_server_message(&mut self.reader, &mut self.line)? {
            if let ServerMessage::Notification(notification) = message {
                return Ok(Some(notification));
            }
        }
        Ok(None)
    }
}

// Adjust the transport timeout at each refill without replacing the client's buffer.
struct DeadlineReader<'a> {
    reader: &'a mut BufReader<ClientSocket>,
    until: Instant,
}

impl Read for DeadlineReader<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let count = self.fill_buf()?.read(buffer)?;
        self.consume(count);
        Ok(count)
    }
}

impl BufRead for DeadlineReader<'_> {
    fn fill_buf(&mut self) -> io::Result<&[u8]> {
        let time = remaining(self.until)?;
        if self.reader.buffer().is_empty() {
            let socket = self.reader.get_ref();
            allow_timeout_on_hangup(socket, socket.set_read_timeout(Some(time)))?;
        }
        self.reader.fill_buf().map_err(transfer_error)
    }

    fn consume(&mut self, amount: usize) {
        self.reader.consume(amount);
    }
}

struct DeadlineWriter<'a> {
    writer: &'a mut ClientSocket,
    until: Instant,
}

impl Write for DeadlineWriter<'_> {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.writer
            .set_write_timeout(Some(remaining(self.until)?))?;
        self.writer.write(buffer).map_err(transfer_error)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.writer.flush()
    }
}

fn write_frame(writer: &mut ClientSocket, frame: &[u8], until: Option<Instant>) -> io::Result<()> {
    match until {
        Some(until) => DeadlineWriter { writer, until }.write_all(frame),
        None => writer.write_all(frame),
    }
}

fn read_frame(
    reader: &mut BufReader<ClientSocket>,
    line: &mut Vec<u8>,
    until: Option<Instant>,
) -> io::Result<Option<ServerMessage>> {
    match until {
        Some(until) => read_server_message(&mut DeadlineReader { reader, until }, line),
        None => read_server_message(reader, line),
    }
}

fn remaining(until: Instant) -> io::Result<Duration> {
    let time = until.saturating_duration_since(Instant::now());
    if time.is_zero() {
        return Err(io::Error::from(ErrorKind::TimedOut));
    }
    Ok(time)
}

fn transfer_error(error: io::Error) -> io::Error {
    if error.kind() == ErrorKind::WouldBlock {
        return io::Error::new(ErrorKind::TimedOut, error);
    }
    error
}

fn call_params<O: Operation>(args: O::Args) -> anyhow::Result<CallParams> {
    Ok(CallParams {
        op: O::NAME.to_owned(),
        args: serde_json::to_value(args)?,
    })
}

fn answers(response: &Response, id: u64) -> bool {
    response.id.is_none_or(|answered| answered == id)
}

fn response_result<T: DeserializeOwned>(response: Response) -> anyhow::Result<T> {
    match response.body {
        ResponseBody::Result(result) => Ok(serde_json::from_value(result)?),
        ResponseBody::Error(error) => Err(error.into()),
    }
}

/// A refusal before the operation began, while a new daemon takes over.
pub fn upgrading(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<ErrorBody>()
        .is_some_and(|error| error.data.reason == "upgrading")
}

/// The transport failures worth another try: the daemon is not there yet, or went away.
const RETRIED_KINDS: [ErrorKind; 9] = [
    ErrorKind::NotFound,
    ErrorKind::ConnectionRefused,
    ErrorKind::ConnectionReset,
    ErrorKind::ConnectionAborted,
    ErrorKind::BrokenPipe,
    ErrorKind::UnexpectedEof,
    ErrorKind::TimedOut,
    ErrorKind::WouldBlock,
    ErrorKind::Interrupted,
];

/// Whether a transport failure before a decoded hello can be retried. Decoded errors and invalid
/// data are permanent.
pub fn transient_transport(err: &io::Error) -> bool {
    RETRIED_KINDS.contains(&err.kind()) || is_connection_lost(err)
}

/// Opens a local transport and lets its caller inspect it before hello.
fn connect_transport(
    socket: &Path,
    until: Instant,
    opening: &mut dyn FnMut(&ClientSocket) -> bool,
) -> anyhow::Result<Option<ClientSocket>> {
    let stream = match connect_client_until(socket, until) {
        Err(error) if transient_transport(&error) => return Ok(None),
        Err(error) => anyhow::bail!("cannot connect to {}: {error}", socket.display()),
        Ok(stream) => stream,
    };
    Ok(opening(&stream).then_some(stream))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::net::UnixStream;

    fn after_peer_closed(bytes: &[u8]) -> BufReader<ClientSocket> {
        let (client, mut peer) = UnixStream::pair().unwrap();
        peer.write_all(bytes).unwrap();
        drop(peer);
        BufReader::new(client)
    }

    #[test]
    fn a_deadline_read_drains_a_complete_reply_after_the_peer_closes() {
        let result = serde_json::json!({ "delivered": true });
        let mut reader = after_peer_closed(&encode_line(&Response::ok(2, result.clone())));
        let mut line = Vec::new();
        let expired = read_frame(&mut reader, &mut line, Some(Instant::now())).unwrap_err();
        assert_eq!(expired.kind(), ErrorKind::TimedOut);

        let until = Instant::now() + Duration::from_secs(1);
        let message = read_frame(&mut reader, &mut line, Some(until)).unwrap();
        let Some(ServerMessage::Response(response)) = message else {
            panic!("expected the queued response, received {message:?}");
        };
        assert_eq!(response.id, Some(2));
        assert_eq!(response_result::<Value>(response).unwrap(), result);
        let hangup = Err(io::Error::from_raw_os_error(libc::EINVAL));
        allow_timeout_on_hangup(reader.get_ref(), hangup).unwrap();
        clear_client_timeouts(reader.get_ref()).unwrap();
    }

    #[test]
    fn a_closed_peer_supplies_no_receipt_from_eof_or_partial_json() {
        let until = Instant::now() + Duration::from_secs(1);
        let mut line = Vec::new();
        let mut eof = after_peer_closed(b"");
        assert!(
            read_frame(&mut eof, &mut line, Some(until))
                .unwrap()
                .is_none()
        );

        let mut partial = after_peer_closed(br#"{"jsonrpc":"2.0","id":2,"result":"#);
        let error = read_frame(&mut partial, &mut line, Some(until)).unwrap_err();
        assert_eq!(error.kind(), ErrorKind::InvalidData);
    }

    #[test]
    fn readable_bytes_from_a_live_peer_do_not_mask_an_invalid_timeout() {
        let (client, mut peer) = UnixStream::pair().unwrap();
        peer.write_all(b"queued").unwrap();
        let changed = Err(io::Error::from_raw_os_error(libc::EINVAL));
        let error = allow_timeout_on_hangup(&client, changed).unwrap_err();
        assert_eq!(error.raw_os_error(), Some(libc::EINVAL));
    }
}
