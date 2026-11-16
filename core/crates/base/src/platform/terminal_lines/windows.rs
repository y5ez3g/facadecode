//! A terminal's handles with a line, as its `terminal` member.

use std::io::{self, Read, Write};
use std::os::windows::io::{AsRawHandle, BorrowedHandle, FromRawHandle, OwnedHandle};

use serde_json::{Map, Value};
use windows_sys::Win32::Foundation::{DUPLICATE_SAME_ACCESS, DuplicateHandle, HANDLE};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, PROCESS_DUP_HANDLE, PROCESS_QUERY_LIMITED_INFORMATION,
};

use crate::line::MAX_LINE_BYTES;
use crate::platform::socket_paths::{ClientSocket, is_connection_lost};
use crate::platform::terminal::PtyMaster;
use crate::platform::unix_process::birth;
use crate::process::ProcessIdentity;

/// How many bytes one read of the link takes.
const CHUNK_BYTES: usize = 64 * 1024;

/// A process that handles are duplicated into: the other end of the keeper link.
pub struct PeerProcess(OwnedHandle);

impl PeerProcess {
    /// Opens the process `identity`, checking its birth, with the access that duplicating handles
    /// into it needs.
    pub fn open(identity: &ProcessIdentity) -> io::Result<PeerProcess> {
        let access = PROCESS_DUP_HANDLE | PROCESS_QUERY_LIMITED_INFORMATION;
        // SAFETY: OpenProcess returns a new handle or null.
        let raw = unsafe { OpenProcess(access, 0, identity.pid) };
        if raw.is_null() {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: raw is a handle the call just returned and nothing else owns.
        let process = PeerProcess(unsafe { OwnedHandle::from_raw_handle(raw) });
        // The open handle keeps the ID from passing to another process, so this birth is its.
        if birth(identity.pid)?.as_ref() != Some(&identity.birth) {
            let why = format!("process {} is no longer the one expected", identity.pid);
            return Err(io::Error::new(io::ErrorKind::NotFound, why));
        }
        Ok(process)
    }
}

/// `line`, a JSON-RPC object with its newline, with a `terminal` member naming copies of
/// `terminal`'s handles duplicated into `receiver`.
pub fn add_terminal(
    line: &[u8],
    terminal: &PtyMaster,
    receiver: &PeerProcess,
) -> io::Result<Vec<u8>> {
    let text = line.strip_suffix(b"\n").unwrap_or(line);
    let mut message: Map<String, Value> = serde_json::from_slice(text)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
    let handles = terminal.handles();
    let mut member = Map::new();
    member.insert("input".into(), duplicate(handles.input, receiver)?.into());
    member.insert("output".into(), duplicate(handles.output, receiver)?.into());
    if let Some(signal) = handles.signal {
        member.insert("signal".into(), duplicate(signal, receiver)?.into());
    }
    member.insert("job".into(), duplicate(handles.job, receiver)?.into());
    message.insert("terminal".into(), Value::Object(member));
    let mut with_terminal = serde_json::to_vec(&message).map_err(io::Error::other)?;
    with_terminal.push(b'\n');
    Ok(with_terminal)
}

/// A copy of `handle` in `receiver`, with the same access, as its value there.
fn duplicate(handle: BorrowedHandle<'_>, receiver: &PeerProcess) -> io::Result<u64> {
    let mut copy: HANDLE = std::ptr::null_mut();
    // SAFETY: both process handles and the handle are open; copy receives a value in the receiver.
    let done = unsafe {
        DuplicateHandle(
            GetCurrentProcess(),
            handle.as_raw_handle(),
            receiver.0.as_raw_handle(),
            &mut copy,
            0,
            0,
            DUPLICATE_SAME_ACCESS,
        )
    };
    if done == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(copy as usize as u64)
}

/// The terminal whose handles `line`'s `terminal` member names, which this process owns from now
/// on; None where it names none.
pub fn take_terminal(line: &[u8]) -> Option<PtyMaster> {
    let text = line.strip_suffix(b"\n").unwrap_or(line);
    let message: Map<String, Value> = serde_json::from_slice(text).ok()?;
    let member = message.get("terminal")?.as_object()?;
    let handle = |name: &str| {
        let value = usize::try_from(member.get(name)?.as_u64()?).ok()?;
        // SAFETY: the sender duplicated this handle into this process for the line, which hands
        // it over to whoever takes the terminal.
        Some(unsafe { OwnedHandle::from_raw_handle(value as HANDLE) })
    };
    let (input, output, signal, job) = (
        handle("input"),
        handle("output"),
        handle("signal"),
        handle("job"),
    );
    Some(PtyMaster::from_handles(input?, output?, signal, job?))
}

pub(super) struct Sender {
    socket: ClientSocket,
    receiver: PeerProcess,
}

impl Sender {
    pub(super) fn new(socket: ClientSocket, receiver: &ProcessIdentity) -> io::Result<Sender> {
        let receiver = PeerProcess::open(receiver)?;
        Ok(Sender { socket, receiver })
    }

    pub(super) fn send(&self, line: &[u8], terminal: Option<&PtyMaster>) -> io::Result<()> {
        match terminal {
            Some(terminal) => {
                let line = add_terminal(line, terminal, &self.receiver)?;
                (&self.socket).write_all(&line)
            }
            None => (&self.socket).write_all(line),
        }
    }
}

pub(super) struct Receiver {
    socket: ClientSocket,
    pending: Vec<u8>,
    at_end: bool,
}

impl Receiver {
    pub(super) fn new(socket: ClientSocket) -> Receiver {
        Receiver {
            socket,
            pending: Vec::new(),
            at_end: false,
        }
    }

    pub(super) fn next_line(&mut self) -> io::Result<Option<(Vec<u8>, Option<PtyMaster>)>> {
        let mut searched = 0;
        let newline = loop {
            if let Some(at) = self.pending[searched..]
                .iter()
                .position(|&byte| byte == b'\n')
            {
                break searched + at;
            }
            searched = self.pending.len();
            if self.pending.len() >= MAX_LINE_BYTES {
                let why = "a line exceeds the protocol limit";
                return Err(io::Error::new(io::ErrorKind::InvalidData, why));
            }
            if self.at_end {
                return Ok(None);
            }
            self.read_chunk()?;
        };
        let mut line: Vec<u8> = self.pending.drain(..=newline).collect();
        line.pop();
        let terminal = take_terminal(&line);
        Ok(Some((line, terminal)))
    }

    fn read_chunk(&mut self) -> io::Result<()> {
        let start = self.pending.len();
        self.pending.resize(start + CHUNK_BYTES, 0);
        let read = match (&self.socket).read(&mut self.pending[start..]) {
            Err(error) if is_connection_lost(&error) => Ok(0),
            read => read,
        };
        self.pending.truncate(start + *read.as_ref().unwrap_or(&0));
        let read = read?;
        self.at_end = read == 0;
        Ok(())
    }
}
