//! The keeper's end of the daemon's connection on Windows. Each instance of the keeper's pipe
//! waits for a client in an overlapped connect; the client is proved through the kernel before a
//! single byte is read. After that the link keeps one overlapped read under way and moves
//! newline-framed messages, with the terminals that ride along in them, both ways.

use std::io;
use std::os::windows::io::{AsHandle, AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::Path;
use std::ptr;
use std::time::{Duration, Instant};

use facade_base::jsonrpc::{MAX_LINE_BYTES, encode_line};
use facade_base::process::ProcessIdentity;
use facade_base::service::{self, Service};
use facade_base::sockets;
use facade_base::terminal::PtyMaster;
use facade_base::terminal_lines::{self, PeerProcess};
use serde::Serialize;
use windows_sys::Win32::Foundation::{
    ERROR_IO_INCOMPLETE, ERROR_IO_PENDING, ERROR_PIPE_CONNECTED, HANDLE, WAIT_TIMEOUT,
};
use windows_sys::Win32::Storage::FileSystem::{ReadFile, WriteFile};
use windows_sys::Win32::System::IO::{
    CancelIoEx, GetOverlappedResult, GetOverlappedResultEx, OVERLAPPED,
};
use windows_sys::Win32::System::Pipes::ConnectNamedPipe;
use windows_sys::Win32::System::Threading::CreateEventW;

use super::port::{Port, overlapped};
use crate::log;

/// How long one outgoing message may wait for the daemon to make room. A daemon that has not read
/// for this long is treated as gone: the write is cancelled, the link is dropped, and the ping
/// watchdog takes it from there.
const SEND_TIMEOUT: Duration = Duration::from_secs(1);

/// How much one read takes at most.
const READ_BYTES: usize = 64 * 1024;

/// One instance of the keeper's pipe, waiting for a client.
pub(super) struct Listener {
    pipe: OwnedHandle,
    key: usize,
    /// The connect under way, kept in place until it completes.
    _connect: Box<OVERLAPPED>,
}

impl Listener {
    /// A new instance of the pipe at `path`, whose connection completes on `port`.
    pub(super) fn open(path: &Path, port: &mut Port) -> io::Result<Listener> {
        let pipe = sockets::server_pipe(path)?;
        let key = port.key();
        port.bind(pipe.as_handle(), key)?;
        let mut connect = overlapped();
        // SAFETY: the pipe is open, and `connect` stays in place in the listener until the connect
        // completes: the listener is only given up after its key completed.
        if unsafe { ConnectNamedPipe(pipe.as_raw_handle(), &mut *connect) } == 0 {
            let error = io::Error::last_os_error();
            match error.raw_os_error().map(|code| code as u32) {
                Some(ERROR_IO_PENDING) => {}
                // A client came before the connect began; nothing is queued for it, so this is.
                Some(ERROR_PIPE_CONNECTED) => port.post(key)?,
                _ => return Err(error),
            }
        }
        Ok(Listener {
            pipe,
            key,
            _connect: connect,
        })
    }

    pub(super) fn key(&self) -> usize {
        self.key
    }

    /// The instance a client connected to, and its key, once that key completed. A connect that
    /// failed leaves an instance whose proof fails.
    pub(super) fn into_connected(self) -> (OwnedHandle, usize) {
        (self.pipe, self.key)
    }
}

pub(super) struct Link {
    pipe: OwnedHandle,
    /// The key its reads complete under: its listener's.
    key: usize,
    daemon: ProcessIdentity,
    /// The daemon's process, which terminals are duplicated into.
    peer: PeerProcess,
    greeted: bool,
    /// The read under way, if any, and where it reads into; both stay in place until it ends.
    read: Box<OVERLAPPED>,
    buffer: Vec<u8>,
    reading: bool,
    read_event: OwnedHandle,
    write_event: OwnedHandle,
    /// What came after the last full line.
    inbox: Vec<u8>,
}

/// One thing read from the link.
pub(super) enum Inbound {
    /// A message line, newline stripped. A terminal it carries is in it, as handles of this
    /// process.
    Line(Vec<u8>),
    /// The daemon sent a line over the protocol's size limit.
    Overlong,
    /// End of stream, or a read error.
    Closed,
}

impl Link {
    /// Accepts the connected instance `pipe` only if its client is a process of this user whose
    /// pid and birth match the record in `core/daemon.lock`. Anyone else is turned away and
    /// logged, and the instance closed.
    pub(super) fn prove(pipe: OwnedHandle, key: usize, core: &Path) -> Option<Link> {
        let daemon = match service::authenticate_client(pipe.as_handle(), core, Service::Daemon) {
            Ok(daemon) => daemon,
            Err(reason) => {
                log("warn", &format!("turned away a connection: {reason}"));
                return None;
            }
        };
        let link = PeerProcess::open(&daemon).and_then(|peer| {
            let mut link = Link {
                pipe,
                key,
                daemon,
                peer,
                greeted: false,
                read: overlapped(),
                buffer: vec![0; READ_BYTES],
                reading: false,
                read_event: event()?,
                write_event: event()?,
                inbox: Vec::new(),
            };
            link.read_more()?;
            Ok(link)
        });
        match link {
            Ok(link) => Some(link),
            Err(err) => {
                log("warn", &format!("turned away a connection: {err}"));
                None
            }
        }
    }

    pub(super) fn key(&self) -> usize {
        self.key
    }

    /// The daemon process at the other end.
    pub(super) fn daemon(&self) -> &ProcessIdentity {
        &self.daemon
    }

    /// Whether `hello` has succeeded on this link.
    pub(super) fn is_greeted(&self) -> bool {
        self.greeted
    }

    pub(super) fn mark_greeted(&mut self) {
        self.greeted = true;
    }

    /// After the link's key completed: what the read brought, as lines, then the next read. A
    /// `Closed` or `Overlong` entry is always last.
    pub(super) fn drain(&mut self) -> Vec<Inbound> {
        self.reading = false;
        let mut got = Vec::new();
        let mut read = 0u32;
        // SAFETY: the read on this pipe with this OVERLAPPED has completed.
        let ok =
            unsafe { GetOverlappedResult(self.pipe.as_raw_handle(), &*self.read, &mut read, 0) };
        if ok == 0 {
            closed(&mut got, io::Error::last_os_error());
            return got;
        }
        self.inbox.extend_from_slice(&self.buffer[..read as usize]);
        let mut taken = 0;
        while let Some(newline) = self.inbox[taken..].iter().position(|&byte| byte == b'\n') {
            got.push(Inbound::Line(self.inbox[taken..taken + newline].to_vec()));
            taken += newline + 1;
        }
        self.inbox.drain(..taken);
        if self.inbox.len() >= MAX_LINE_BYTES {
            got.push(Inbound::Overlong);
            return got;
        }
        if let Err(err) = self.read_more() {
            closed(&mut got, err);
        }
        got
    }

    /// Starts the next read, which completes on the port under the link's key.
    fn read_more(&mut self) -> io::Result<()> {
        // SAFETY: OVERLAPPED is plain data, for which all zeros is valid.
        *self.read = unsafe { std::mem::zeroed() };
        self.read.hEvent = self.read_event.as_raw_handle();
        // SAFETY: the buffer and the OVERLAPPED stay in place until the read ends: the link waits
        // for it before it lets go of them.
        let ok = unsafe {
            ReadFile(
                self.pipe.as_raw_handle(),
                self.buffer.as_mut_ptr(),
                READ_BYTES as u32,
                ptr::null_mut(),
                &mut *self.read,
            )
        };
        if ok == 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(ERROR_IO_PENDING as i32) {
                return Err(error);
            }
        }
        self.reading = true;
        Ok(())
    }

    /// Serializes `message` as one line and writes it, with `terminal` duplicated into the daemon
    /// if given. Gives up after [`SEND_TIMEOUT`]; any error means the link should be dropped.
    pub(super) fn write(
        &self,
        message: &impl Serialize,
        terminal: Option<&PtyMaster>,
    ) -> io::Result<()> {
        let mut line = encode_line(message);
        if let Some(terminal) = terminal {
            line = terminal_lines::add_terminal(&line, terminal, &self.peer)?;
        }
        self.write_all(&line, Instant::now() + SEND_TIMEOUT)
    }

    /// Writes all of `bytes`, waiting until `deadline` at most, then cancelling the write.
    fn write_all(&self, bytes: &[u8], deadline: Instant) -> io::Result<()> {
        let pipe = self.pipe.as_raw_handle();
        let mut written = 0;
        while written < bytes.len() {
            // SAFETY: OVERLAPPED is plain data, for which all zeros is valid.
            let mut write: OVERLAPPED = unsafe { std::mem::zeroed() };
            // The event's low bit keeps this write's completion off the port: it is waited for
            // here.
            write.hEvent = (self.write_event.as_raw_handle() as usize | 1) as HANDLE;
            let chunk = &bytes[written..];
            let length = u32::try_from(chunk.len()).unwrap_or(u32::MAX);
            // SAFETY: `chunk` and `write` stay in place until the write ends: it is waited for, or
            // cancelled and waited for, before this returns.
            let ok =
                unsafe { WriteFile(pipe, chunk.as_ptr(), length, ptr::null_mut(), &mut write) };
            if ok == 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() != Some(ERROR_IO_PENDING as i32) {
                    return Err(error);
                }
            }
            let mut moved = 0u32;
            let left = deadline.saturating_duration_since(Instant::now());
            let ms = u32::try_from(left.as_millis()).unwrap_or(u32::MAX - 1);
            // SAFETY: as above; nothing is alertable.
            let ok = unsafe { GetOverlappedResultEx(pipe, &write, &mut moved, ms, 0) };
            if ok == 0 {
                let error = io::Error::last_os_error();
                let code = error.raw_os_error().map(|code| code as u32);
                if code != Some(WAIT_TIMEOUT) && code != Some(ERROR_IO_INCOMPLETE) {
                    return Err(error);
                }
                // SAFETY: cancels this write alone, then waits for it to end.
                unsafe {
                    CancelIoEx(pipe, &write);
                    GetOverlappedResult(pipe, &write, &mut moved, 1);
                }
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "the daemon took no message for a second",
                ));
            }
            written += moved as usize;
        }
        Ok(())
    }
}

impl Drop for Link {
    /// Cancels the read under way and waits for it, so that nothing writes into the link's buffer
    /// once it is gone. Its completion still comes to the port, under a key nothing holds.
    fn drop(&mut self) {
        if self.reading {
            let mut read = 0u32;
            // SAFETY: cancels this link's read alone, then waits for it to end.
            unsafe {
                CancelIoEx(self.pipe.as_raw_handle(), &*self.read);
                GetOverlappedResult(self.pipe.as_raw_handle(), &*self.read, &mut read, 1);
            }
        }
    }
}

/// Ends `got` with the link's end; an end that is not the daemon closing its side is logged.
fn closed(got: &mut Vec<Inbound>, error: io::Error) {
    if !facade_base::paths::is_connection_lost(&error) {
        log("warn", &format!("reading from the daemon failed: {error}"));
    }
    got.push(Inbound::Closed);
}

/// A new event that only a new operation resets.
fn event() -> io::Result<OwnedHandle> {
    // SAFETY: an unnamed event, owned by nobody else.
    let event = unsafe { CreateEventW(ptr::null(), 1, 0, ptr::null()) };
    if event.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the event was just created and is owned here alone.
    Ok(unsafe { OwnedHandle::from_raw_handle(event) })
}
