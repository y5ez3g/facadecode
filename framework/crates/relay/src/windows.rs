//! Windows pipe I/O and the standard-input thread. Only this module calls Win32 directly.

#![allow(unsafe_code)]

use std::fs::File;
use std::io::{self, Cursor, Read, Write};
use std::mem::size_of;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsHandle, AsRawHandle, FromRawHandle, OwnedHandle};
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::Command;
use std::ptr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{
    ERROR_IO_PENDING, ERROR_PIPE_BUSY, GENERIC_READ, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE,
    WAIT_TIMEOUT,
};
use windows_sys::Win32::Security::{
    EqualSid, GetTokenInformation, TOKEN_QUERY, TOKEN_USER, TokenUser,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAG_OVERLAPPED, OPEN_EXISTING, ReadFile, WriteFile,
};
use windows_sys::Win32::System::IO::{
    CancelIoEx, CreateIoCompletionPort, GetOverlappedResult, GetQueuedCompletionStatus, OVERLAPPED,
    PostQueuedCompletionStatus,
};
use windows_sys::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
use windows_sys::Win32::System::Pipes::{GetNamedPipeServerProcessId, WaitNamedPipeW};
use windows_sys::Win32::System::Threading::{
    CREATE_NO_WINDOW, CreateEventW, GetCurrentProcess, INFINITE, OpenProcess, OpenProcessToken,
    PROCESS_QUERY_LIMITED_INFORMATION,
};

const INPUT_KEY: usize = 1;
const STARTUP_KEY: usize = usize::MAX;
const READ_BYTES: usize = 64 * 1024;

/// The local daemon's monotonic clock, in nanoseconds on the same QPC time base.
pub(crate) fn monotonic_now() -> u64 {
    let (mut count, mut frequency) = (0, 0);
    // SAFETY: both calls take an output pointer to an i64.
    unsafe {
        QueryPerformanceCounter(&raw mut count);
        QueryPerformanceFrequency(&raw mut frequency);
    }
    let count = u128::try_from(count).unwrap_or(0);
    let frequency = u128::try_from(frequency).unwrap_or(1).max(1);
    u64::try_from(count * 1_000_000_000 / frequency).unwrap_or(u64::MAX)
}

/// No console window for the only program the relay starts.
pub(crate) fn no_window(command: &mut Command) {
    command.creation_flags(CREATE_NO_WINDOW);
}

/// The completion port, with a distinct key for each connection so cancelled reads from an old
/// connection cannot be mistaken for a new one's reads.
pub(crate) struct Events {
    port: Arc<OwnedHandle>,
    next_key: usize,
}

/// The most recent standard-input read, handed to the loop by a completion packet.
pub(crate) struct Input(Cursor<Vec<u8>>);

impl Read for Input {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        self.0.read(bytes)
    }
}

impl Events {
    pub(crate) fn new() -> io::Result<(Self, Input)> {
        let input = File::from(io::stdin().as_handle().try_clone_to_owned()?);
        // SAFETY: INVALID_HANDLE_VALUE creates a new port; the returned handle is owned here.
        let port = Arc::new(owned(unsafe {
            CreateIoCompletionPort(INVALID_HANDLE_VALUE, ptr::null_mut(), 0, 1)
        })?);
        let reader_port = Arc::clone(&port);
        std::thread::Builder::new()
            .name("relay-stdin".into())
            .spawn(move || read_input(input, &reader_port))?;
        Ok((Self { port, next_key: 2 }, Input(Cursor::new(Vec::new()))))
    }

    pub(crate) fn startup_waker(&self) -> impl FnOnce() + Send + 'static {
        let port = Arc::clone(&self.port);
        move || {
            // SAFETY: the port is owned by the callback until the notification is posted.
            unsafe {
                PostQueuedCompletionStatus(port.as_raw_handle(), 0, STARTUP_KEY, ptr::null_mut())
            };
        }
    }

    /// Posts a marker after the stdin chunks already queued. The relay loop is the only reader
    /// of the port. Its next wait that reaches the marker returns with neither stream ready.
    pub(crate) fn mark_ready_input_end(&self) -> io::Result<()> {
        // SAFETY: the port is live and the null operation carries no data to free.
        if unsafe { PostQueuedCompletionStatus(self.port.as_raw_handle(), 0, 0, ptr::null_mut()) }
            == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// Arms one daemon read, then waits for that read, the CLI, or the reconnect deadline.
    pub(crate) fn wait(
        &mut self,
        mut input: Option<&mut Input>,
        mut stream: Option<&mut Stream>,
        timeout: Option<Duration>,
        waiting_for_startup: bool,
    ) -> io::Result<(bool, bool)> {
        if let Some(stream) = stream.as_mut()
            && let Err(error) = stream.start_read()
        {
            stream.ready = Some(Err(error));
            return Ok((false, true));
        }
        let deadline = timeout.map(|timeout| Instant::now() + timeout);
        loop {
            let millis = deadline.map_or(INFINITE, |deadline| {
                let left = deadline.saturating_duration_since(Instant::now());
                u32::try_from(left.as_millis()).unwrap_or(INFINITE - 1)
            });
            let mut bytes = 0;
            let mut key = 0;
            let mut operation = ptr::null_mut();
            // SAFETY: the port and all output pointers remain valid throughout this wait.
            let success = unsafe {
                GetQueuedCompletionStatus(
                    self.port.as_raw_handle(),
                    &raw mut bytes,
                    &raw mut key,
                    &raw mut operation,
                    millis,
                )
            };
            let error = (success == 0).then(io::Error::last_os_error);
            if operation.is_null() {
                if key == STARTUP_KEY && !waiting_for_startup {
                    continue;
                }
                return match error {
                    Some(error) if error.raw_os_error() == i32::try_from(WAIT_TIMEOUT).ok() => {
                        Ok((false, false))
                    }
                    Some(error) => Err(error),
                    None => Ok((false, false)),
                };
            }
            if key == INPUT_KEY {
                // SAFETY: read_input transfers exactly one Box<Vec<u8>> in each input packet.
                let bytes = unsafe { Box::from_raw(operation.cast::<Vec<u8>>()) };
                if let Some(input) = input.as_mut() {
                    input.0 = Cursor::new(*bytes);
                    return Ok((true, false));
                }
            } else if let Some(stream) = stream.as_mut().filter(|stream| stream.key == key) {
                stream.reading = false;
                stream.ready = Some(error.map_or(Ok(bytes), Err));
                return Ok((false, true));
            }
            // A cancelled old connection's packet carries no live allocation to dereference.
        }
    }
}

fn read_input(mut input: File, port: &OwnedHandle) {
    loop {
        let mut bytes = vec![0; READ_BYTES];
        let count = loop {
            match input.read(&mut bytes) {
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                result => break result.unwrap_or(0),
            }
        };
        bytes.truncate(count);
        let packet = Box::into_raw(Box::new(bytes));
        // SAFETY: the packet owns its bytes until the loop takes it from the port. The reader
        // holds the port open; only a failed post retains ownership here.
        if unsafe { PostQueuedCompletionStatus(port.as_raw_handle(), 0, INPUT_KEY, packet.cast()) }
            == 0
        {
            unsafe {
                drop(Box::from_raw(packet));
            }
            return;
        }
        if count == 0 {
            return;
        }
    }
}

/// One overlapped daemon pipe. Reads join the loop's port; writes and the hello block on their
/// own event, just as Unix writes and the hello block on the socket.
pub(crate) struct Stream {
    transport: OpeningStream,
    key: usize,
    read: Box<OVERLAPPED>,
    read_event: OwnedHandle,
    buffer: Box<[u8]>,
    reading: bool,
    ready: Option<io::Result<u32>>,
}

/// The authenticated pipe before its event reads are attached to the relay loop.
pub(crate) struct OpeningStream {
    pipe: OwnedHandle,
    pub(crate) peer_pid: u32,
    until: Option<Instant>,
}

impl OpeningStream {
    pub(crate) fn connect(path: &Path, until: Option<Instant>) -> io::Result<Self> {
        let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let pipe = loop {
            // SAFETY: path is terminated; no security attributes or template are supplied.
            let handle = unsafe {
                CreateFileW(
                    path.as_ptr(),
                    GENERIC_READ | GENERIC_WRITE,
                    0,
                    ptr::null(),
                    OPEN_EXISTING,
                    FILE_FLAG_OVERLAPPED,
                    ptr::null_mut(),
                )
            };
            if handle != INVALID_HANDLE_VALUE {
                break owned(handle)?;
            }
            let error = io::Error::last_os_error();
            if error.raw_os_error() != i32::try_from(ERROR_PIPE_BUSY).ok() {
                return Err(error);
            }
            // SAFETY: path is terminated and remains valid through the blocking wait.
            let wait = until.map_or(INFINITE, |until| {
                u32::try_from(until.saturating_duration_since(Instant::now()).as_millis())
                    .unwrap_or(INFINITE - 1)
            });
            if unsafe { WaitNamedPipeW(path.as_ptr(), wait) } == 0 {
                return Err(io::Error::last_os_error());
            }
        };
        let peer_pid = authenticate(&pipe)?;
        Ok(Self {
            pipe,
            peer_pid,
            until,
        })
    }
}

impl Stream {
    pub(crate) fn attach(mut transport: OpeningStream, events: &mut Events) -> io::Result<Self> {
        let key = events.next_key;
        events.next_key += 1;
        // SAFETY: both handles are live; each connection receives its own completion key.
        if unsafe {
            CreateIoCompletionPort(
                transport.pipe.as_raw_handle(),
                events.port.as_raw_handle(),
                key,
                0,
            )
        }
        .is_null()
        {
            return Err(io::Error::last_os_error());
        }
        transport.until = None;
        Ok(Self {
            transport,
            key,
            read: Box::default(),
            // SAFETY: the unnamed event is owned until the pending read has completed.
            read_event: owned(unsafe { CreateEventW(ptr::null(), 1, 0, ptr::null()) })?,
            buffer: vec![0; READ_BYTES].into_boxed_slice(),
            reading: false,
            ready: None,
        })
    }

    fn start_read(&mut self) -> io::Result<()> {
        if self.reading || self.ready.is_some() {
            return Ok(());
        }
        *self.read = OVERLAPPED {
            hEvent: self.read_event.as_raw_handle(),
            ..OVERLAPPED::default()
        };
        // SAFETY: both boxes stay at fixed addresses until the read completes, including on
        // drop, which cancels the read and waits before releasing either box.
        let success = unsafe {
            ReadFile(
                self.transport.pipe.as_raw_handle(),
                self.buffer.as_mut_ptr(),
                u32::try_from(READ_BYTES).unwrap_or(u32::MAX),
                ptr::null_mut(),
                &raw mut *self.read,
            )
        };
        if success == 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != i32::try_from(ERROR_IO_PENDING).ok() {
                return Err(error);
            }
        }
        self.reading = true;
        Ok(())
    }
}

impl OpeningStream {
    fn transfer(&self, bytes: *mut u8, length: usize, write: bool) -> io::Result<usize> {
        // SAFETY: no name or security attributes; the new event is owned for this operation.
        let event = owned(unsafe { CreateEventW(ptr::null(), 1, 0, ptr::null()) })?;
        let mut operation = OVERLAPPED {
            // The low bit suppresses a port packet for this blocking operation.
            hEvent: event.as_raw_handle().map_addr(|address| address | 1),
            ..OVERLAPPED::default()
        };
        let length = u32::try_from(length).unwrap_or(u32::MAX);
        // SAFETY: callers lend bytes until GetOverlappedResult has finished; operation and event
        // also live until then. write determines whether Win32 may modify the supplied bytes.
        let success = unsafe {
            if write {
                WriteFile(
                    self.pipe.as_raw_handle(),
                    bytes,
                    length,
                    ptr::null_mut(),
                    &raw mut operation,
                )
            } else {
                ReadFile(
                    self.pipe.as_raw_handle(),
                    bytes,
                    length,
                    ptr::null_mut(),
                    &raw mut operation,
                )
            }
        };
        if success == 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != i32::try_from(ERROR_IO_PENDING).ok() {
                return Err(error);
            }
        }
        if success == 0
            && let Some(until) = self.until
        {
            let millis = u32::try_from(until.saturating_duration_since(Instant::now()).as_millis())
                .unwrap_or(INFINITE - 1);
            // SAFETY: both event and operation are live until cancellation and completion.
            let waited = unsafe {
                windows_sys::Win32::System::Threading::WaitForSingleObject(
                    event.as_raw_handle(),
                    millis,
                )
            };
            if waited != windows_sys::Win32::Foundation::WAIT_OBJECT_0 {
                let error = if waited == WAIT_TIMEOUT {
                    io::ErrorKind::TimedOut.into()
                } else {
                    io::Error::last_os_error()
                };
                let mut drained = 0;
                // SAFETY: cancellation is drained before the operation or buffer leaves scope.
                unsafe {
                    CancelIoEx(self.pipe.as_raw_handle(), &raw const operation);
                    GetOverlappedResult(
                        self.pipe.as_raw_handle(),
                        &raw const operation,
                        &raw mut drained,
                        1,
                    );
                }
                return Err(error);
            }
        }
        let mut count = 0;
        // SAFETY: the operation belongs to this pipe and its event is still live.
        if unsafe {
            GetOverlappedResult(
                self.pipe.as_raw_handle(),
                &raw const operation,
                &raw mut count,
                1,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(usize::try_from(count).unwrap_or(0))
    }
}

impl Read for OpeningStream {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        self.transfer(bytes.as_mut_ptr(), bytes.len(), false)
    }
}

impl Write for OpeningStream {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.transfer(bytes.as_ptr().cast_mut(), bytes.len(), true)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Read for Stream {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        if let Some(result) = self.ready.take() {
            let count = usize::try_from(result?).unwrap_or(0);
            let source = self.buffer.get(..count).unwrap_or_default();
            let target = bytes
                .get_mut(..count)
                .ok_or_else(|| io::Error::other("read buffer too small"))?;
            target.copy_from_slice(source);
            return Ok(count);
        }
        self.transport.read(bytes)
    }
}

impl Write for Stream {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.transport.write(bytes)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Drop for Stream {
    fn drop(&mut self) {
        if self.reading {
            // SAFETY: the read's storage and pipe are still live. Waiting for cancellation is
            // required before freeing that storage. Its queued packet is ignored by its old key.
            unsafe {
                CancelIoEx(self.transport.pipe.as_raw_handle(), &raw const *self.read);
                let mut bytes = 0;
                GetOverlappedResult(
                    self.transport.pipe.as_raw_handle(),
                    &raw const *self.read,
                    &raw mut bytes,
                    1,
                );
            }
        }
    }
}

fn authenticate(pipe: &OwnedHandle) -> io::Result<u32> {
    let mut pid = 0;
    // SAFETY: pipe is live and pid is writable.
    if unsafe { GetNamedPipeServerProcessId(pipe.as_raw_handle(), &raw mut pid) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: only query access is requested; the returned process handle is owned here.
    let process = owned(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) })?;
    let peer = token_user(process.as_raw_handle())?;
    // SAFETY: GetCurrentProcess returns a pseudo handle, borrowed only for this call.
    let own = token_user(unsafe { GetCurrentProcess() })?;
    // SAFETY: token_user returns aligned TOKEN_USER storage retaining the SID it points to.
    let same_user = unsafe {
        let peer = &*peer.as_ptr().cast::<TOKEN_USER>();
        let own = &*own.as_ptr().cast::<TOKEN_USER>();
        EqualSid(peer.User.Sid, own.User.Sid) != 0
    };
    if !same_user {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "the Facade at this pipe is another user's",
        ));
    }
    Ok(pid)
}

fn token_user(process: HANDLE) -> io::Result<Vec<usize>> {
    let mut token = ptr::null_mut();
    // SAFETY: the process handle is live; token receives a new handle.
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &raw mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let token = owned(token)?;
    let mut length = 0;
    // SAFETY: the first call asks only for the required buffer size.
    unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            ptr::null_mut(),
            0,
            &raw mut length,
        );
    }
    let mut buffer = vec![
        0usize;
        usize::try_from(length)
            .unwrap_or(0)
            .div_ceil(size_of::<usize>())
    ];
    // SAFETY: usize storage is aligned for TOKEN_USER, with at least length bytes. Win32 writes
    // the structure and SID into this allocation, which is returned without moving its bytes.
    if unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            buffer.as_mut_ptr().cast(),
            length,
            &raw mut length,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(buffer)
}

fn owned(handle: HANDLE) -> io::Result<OwnedHandle> {
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        Err(io::Error::last_os_error())
    } else {
        // SAFETY: callers pass only newly created handles and transfer ownership here.
        Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
    }
}
