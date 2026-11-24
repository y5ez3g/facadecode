//! A terminal's handles with a line, as its `terminal` member.

use std::borrow::Cow;
use std::collections::HashSet;
use std::fmt;
use std::io::{self, Read, Write};
use std::os::windows::io::{AsRawHandle, BorrowedHandle, FromRawHandle, OwnedHandle};
use std::ptr;

use serde::de::{IgnoredAny, MapAccess, Visitor};
use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};
use windows_sys::Win32::Foundation::{
    DUPLICATE_CLOSE_SOURCE, DUPLICATE_SAME_ACCESS, DuplicateHandle, GetHandleInformation, HANDLE,
};
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

const HANDLE_FIELDS: [&str; 4] = ["input", "output", "signal", "job"];

/// A line and the handle copies in its receiver. The sender keeps them until delivery completes.
#[must_use = "keep the prepared terminal until the full line has been sent"]
pub struct PreparedTerminal<'peer> {
    bytes: Vec<u8>,
    receiver: &'peer PeerProcess,
    copies: [Option<usize>; HANDLE_FIELDS.len()],
}

impl PreparedTerminal<'_> {
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    /// Transfers ownership to the receiver after the entire line, including its newline, arrived.
    pub fn commit(mut self) {
        self.copies.fill(None);
    }
}

impl Drop for PreparedTerminal<'_> {
    fn drop(&mut self) {
        for copy in self.copies.iter().flatten() {
            // SAFETY: the peer process is open and this guard owns each copy until commit.
            // DUPLICATE_CLOSE_SOURCE closes the handle there without making another copy.
            unsafe {
                DuplicateHandle(
                    self.receiver.0.as_raw_handle(),
                    *copy as HANDLE,
                    ptr::null_mut(),
                    ptr::null_mut(),
                    0,
                    0,
                    DUPLICATE_CLOSE_SOURCE,
                );
            }
        }
    }
}

/// Prepares a terminal's copies for a JSON-RPC line sent to an authenticated peer.
pub fn add_terminal<'peer>(
    line: &[u8],
    terminal: &PtyMaster,
    receiver: &'peer PeerProcess,
) -> io::Result<PreparedTerminal<'peer>> {
    let mut message: Map<String, Value> = serde_json::from_slice(line)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
    if message.contains_key("terminal") {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "the line already carries a terminal",
        ));
    }
    let handles = terminal.handles();
    let handles = [
        Some(handles.input),
        Some(handles.output),
        handles.signal,
        Some(handles.job),
    ];
    let mut prepared = PreparedTerminal {
        bytes: Vec::new(),
        receiver,
        copies: [None; HANDLE_FIELDS.len()],
    };
    let mut member = Map::new();
    for ((field, handle), copy) in HANDLE_FIELDS
        .into_iter()
        .zip(handles)
        .zip(&mut prepared.copies)
    {
        if let Some(handle) = handle {
            let value = duplicate(handle, receiver)?;
            *copy = Some(value);
            member.insert(field.into(), (value as u64).into());
        }
    }
    message.insert("terminal".into(), Value::Object(member));
    serde_json::to_writer(&mut prepared.bytes, &message).map_err(io::Error::other)?;
    prepared.bytes.push(b'\n');
    if prepared.bytes.len() > MAX_LINE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "a line exceeds the protocol limit",
        ));
    }
    Ok(prepared)
}

/// A copy of `handle` in `receiver`, with the same access, as its value there.
fn duplicate(handle: BorrowedHandle<'_>, receiver: &PeerProcess) -> io::Result<usize> {
    let mut copy: HANDLE = ptr::null_mut();
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
    Ok(copy as usize)
}

/// A malformed terminal member. Only an unambiguous request header supplies an ID.
#[derive(Debug)]
pub struct InvalidTerminalEnvelope {
    request_id: Option<u64>,
}

impl InvalidTerminalEnvelope {
    pub fn request_id(&self) -> Option<u64> {
        self.request_id
    }
}

impl fmt::Display for InvalidTerminalEnvelope {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("invalid Windows terminal member")
    }
}

impl std::error::Error for InvalidTerminalEnvelope {}

/// Removes the terminal member from a complete frame received from an authenticated peer.
/// The returned terminal owns the received copies. Ordinary lines are returned as borrowed bytes.
pub fn take_terminal(line: &[u8]) -> io::Result<(Cow<'_, [u8]>, Option<PtyMaster>)> {
    let Ok(mut frame) = serde_json::from_slice::<Frame>(line) else {
        return Ok((Cow::Borrowed(line), None));
    };
    if frame.terminals.is_empty() {
        return Ok((Cow::Borrowed(line), None));
    }
    let Some(terminal) = acquire_terminal(std::mem::take(&mut frame.terminals)) else {
        let error = InvalidTerminalEnvelope {
            request_id: frame.request_id(),
        };
        return Err(io::Error::new(io::ErrorKind::InvalidData, error));
    };

    let mut stripped = serde_json::to_vec(&frame).map_err(io::Error::other)?;
    if line.ends_with(b"\n") {
        stripped.push(b'\n');
    }
    Ok((Cow::Owned(stripped), Some(terminal)))
}

#[derive(Deserialize)]
#[serde(untagged)]
enum TerminalMember {
    Object(TerminalFields),
    Malformed(IgnoredAny),
}

struct TerminalFields(Vec<(String, Value)>);

impl<'de> Deserialize<'de> for TerminalFields {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct FieldsVisitor;

        impl<'de> Visitor<'de> for FieldsVisitor {
            type Value = TerminalFields;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a Windows terminal object")
            }

            fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<Self::Value, M::Error> {
                let mut fields = Vec::new();
                while let Some(entry) = map.next_entry()? {
                    fields.push(entry);
                }
                Ok(TerminalFields(fields))
            }
        }

        deserializer.deserialize_map(FieldsVisitor)
    }
}

fn acquire_terminal(members: Vec<TerminalMember>) -> Option<PtyMaster> {
    let mut valid = members.len() == 1;
    let mut seen = HashSet::new();
    let mut handles: [Option<OwnedHandle>; HANDLE_FIELDS.len()] = Default::default();
    // Walk even malformed objects so every received copy in a known slot is closed on refusal.
    for member in members {
        let TerminalMember::Object(TerminalFields(fields)) = member else {
            valid = false;
            continue;
        };
        for (name, value) in fields {
            let Some(slot) = HANDLE_FIELDS.iter().position(|&field| field == name) else {
                valid = false;
                continue;
            };
            let Some(raw) = value.as_u64().and_then(|value| isize::try_from(value).ok()) else {
                valid = false;
                continue;
            };
            if raw == 0 || !seen.insert(raw) {
                valid = false;
                continue;
            }
            let raw = raw as HANDLE;
            let mut flags = 0;
            // SAFETY: flags is writable and the call checks whether the value names an open handle.
            if unsafe { GetHandleInformation(raw, &mut flags) } == 0 {
                valid = false;
                continue;
            }
            // SAFETY: the authenticated sender hands over these newly duplicated copies. Each
            // numeric handle is acquired at most once, including when a member is malformed.
            let owned = unsafe { OwnedHandle::from_raw_handle(raw) };
            valid &= handles[slot].replace(owned).is_none();
        }
    }
    let [input, output, signal, job] = handles;
    if valid {
        Some(PtyMaster::from_handles(input?, output?, signal, job?))
    } else {
        None
    }
}

/// Keep all the header entries. A JSON map would silently replace duplicate members.
struct Frame {
    fields: Vec<(String, Value)>,
    terminals: Vec<TerminalMember>,
}

impl Frame {
    fn request_id(&self) -> Option<u64> {
        let (mut version, mut method, mut params, mut id) = (false, false, false, None);
        for (key, value) in &self.fields {
            match key.as_str() {
                "jsonrpc" if !version && value.as_str() == Some("2.0") => version = true,
                "method" if !method && value.is_string() => method = true,
                "params" if !params => params = true,
                "id" if id.is_none() => id = Some(value.as_u64()?),
                "jsonrpc" | "method" | "params" | "id" | "result" | "error" => return None,
                _ => {}
            }
        }
        if version && method { id } else { None }
    }
}

impl<'de> Deserialize<'de> for Frame {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct FrameVisitor;

        impl<'de> Visitor<'de> for FrameVisitor {
            type Value = Frame;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a JSON-RPC object")
            }

            fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<Frame, M::Error> {
                let mut frame = Frame {
                    fields: Vec::new(),
                    terminals: Vec::new(),
                };
                while let Some(key) = map.next_key::<String>()? {
                    if key == "terminal" {
                        frame.terminals.push(map.next_value()?);
                    } else {
                        frame.fields.push((key, map.next_value()?));
                    }
                }
                Ok(frame)
            }
        }

        deserializer.deserialize_map(FrameVisitor)
    }
}

impl Serialize for Frame {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.fields.len()))?;
        for (key, value) in &self.fields {
            map.serialize_entry(key, value)?;
        }
        map.end()
    }
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
                let prepared = add_terminal(line, terminal, &self.receiver)?;
                (&self.socket).write_all(prepared.bytes())?;
                prepared.commit();
                Ok(())
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

impl Drop for Receiver {
    fn drop(&mut self) {
        // Complete frames own their copies from delivery. The sender still owns the copies
        // of any unfinished frame, so only take resources from newline-terminated frames.
        for frame in self.pending.split_inclusive(|&byte| byte == b'\n') {
            if frame.ends_with(b"\n") {
                drop(take_terminal(frame));
            }
        }
    }
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
        if newline >= MAX_LINE_BYTES {
            // The full line arrived, so dispose of any copies before refusing the frame.
            drop(take_terminal(&self.pending[..newline]));
            drop(self.pending.drain(..=newline));
            let why = "a line exceeds the protocol limit";
            return Err(io::Error::new(io::ErrorKind::InvalidData, why));
        }
        let mut line: Vec<u8> = self.pending.drain(..=newline).collect();
        line.pop();
        let (stripped, terminal) = take_terminal(&line)?;
        let line = match stripped {
            Cow::Borrowed(_) => line,
            Cow::Owned(bytes) => bytes,
        };
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
