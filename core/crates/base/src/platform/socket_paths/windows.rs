//! The client's end of a named pipe.

use std::ffi::OsStr;
use std::io::{self, Read, Write};
use std::net::Shutdown;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, BorrowedHandle, FromRawHandle, OwnedHandle};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_BROKEN_PIPE, ERROR_IO_PENDING, ERROR_NO_DATA, ERROR_OPERATION_ABORTED,
    ERROR_PIPE_BUSY, ERROR_PIPE_NOT_CONNECTED, GENERIC_READ, GENERIC_WRITE, HANDLE,
    INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
};
use windows_sys::Win32::Security::{
    EqualSid, GetTokenInformation, TOKEN_QUERY, TOKEN_USER, TokenUser,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAG_OVERLAPPED, OPEN_EXISTING, ReadFile, SECURITY_IDENTIFICATION,
    SECURITY_SQOS_PRESENT, WriteFile,
};
use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};
use windows_sys::Win32::System::Pipes::{
    GetNamedPipeServerProcessId, NMPWAIT_WAIT_FOREVER, WaitNamedPipeW,
};
use windows_sys::Win32::System::Threading::{
    CreateEventW, GetCurrentProcess, INFINITE, OpenProcess, OpenProcessToken,
    PROCESS_QUERY_LIMITED_INFORMATION, WaitForSingleObject,
};

/// Whether `error`'s raw code says the other end went away.
pub(super) fn is_connection_lost(error: &io::Error) -> bool {
    let lost = [ERROR_BROKEN_PIPE, ERROR_NO_DATA, ERROR_PIPE_NOT_CONNECTED];
    error
        .raw_os_error()
        .is_some_and(|code| lost.iter().any(|&lost| lost as i32 == code))
}

/// A blocking client's end of a named pipe, with the methods callers use on a Unix stream. The
/// pipe is opened overlapped, so that a read under way on one clone never holds up a write on
/// another, `shutdown` on one clone ends a read or write under way on another, and reads and writes
/// can time out. `connect` waits while every instance of the pipe is busy, and checks that the
/// server runs as this user before it returns.
#[derive(Debug)]
pub struct ClientSocket {
    pipe: Arc<Pipe>,
}

/// The connection every clone shares, with the state a Unix socket keeps for all its descriptors.
#[derive(Debug)]
struct Pipe {
    handle: OwnedHandle,
    read_timeout: Mutex<Option<Duration>>,
    write_timeout: Mutex<Option<Duration>>,
    read_shut: AtomicBool,
    write_shut: AtomicBool,
}

impl ClientSocket {
    /// Connects to the named pipe `path`, waiting while every instance is busy. Fails with
    /// `PermissionDenied` where the server runs as another user.
    pub fn connect<P: AsRef<Path>>(path: P) -> io::Result<ClientSocket> {
        Self::open(path.as_ref(), true)
    }

    pub(super) fn try_connect(path: &Path) -> io::Result<ClientSocket> {
        Self::open(path, false)
    }

    fn open(path: &Path, wait_for_instance: bool) -> io::Result<ClientSocket> {
        let name = wide(path.as_os_str());
        let handle = loop {
            // SAFETY: `name` is a NUL-terminated wide string that outlives the call.
            let handle = unsafe {
                CreateFileW(
                    name.as_ptr(),
                    GENERIC_READ | GENERIC_WRITE,
                    0,
                    std::ptr::null(),
                    OPEN_EXISTING,
                    FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
                    std::ptr::null_mut(),
                )
            };
            if handle != INVALID_HANDLE_VALUE {
                // SAFETY: CreateFileW returned a handle that nothing else owns.
                break unsafe { OwnedHandle::from_raw_handle(handle) };
            }
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(ERROR_PIPE_BUSY as i32) {
                return Err(error);
            }
            if !wait_for_instance {
                return Err(io::Error::new(io::ErrorKind::WouldBlock, error));
            }
            // Every instance is busy: wait for one. Where the pipe is gone meanwhile, the next
            // open says so.
            // SAFETY: as above.
            unsafe { WaitNamedPipeW(name.as_ptr(), NMPWAIT_WAIT_FOREVER) };
        };
        refuse_other_user(&handle)?;
        Ok(ClientSocket {
            pipe: Arc::new(Pipe {
                handle,
                read_timeout: Mutex::new(None),
                write_timeout: Mutex::new(None),
                read_shut: AtomicBool::new(false),
                write_shut: AtomicBool::new(false),
            }),
        })
    }

    /// Another end of the same connection.
    pub fn try_clone(&self) -> io::Result<ClientSocket> {
        Ok(ClientSocket {
            pipe: Arc::clone(&self.pipe),
        })
    }

    /// Ends the connection in the direction `how`; a read or write under way on any clone ends.
    pub fn shutdown(&self, how: Shutdown) -> io::Result<()> {
        if matches!(how, Shutdown::Read | Shutdown::Both) {
            self.pipe.read_shut.store(true, Ordering::SeqCst);
        }
        if matches!(how, Shutdown::Write | Shutdown::Both) {
            self.pipe.write_shut.store(true, Ordering::SeqCst);
        }
        // SAFETY: the handle is open; a null OVERLAPPED cancels every operation on it.
        unsafe { CancelIoEx(self.raw(), std::ptr::null()) };
        Ok(())
    }

    /// How long a read waits before it fails with `TimedOut`; None waits for ever.
    pub fn set_read_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
        set_timeout(&self.pipe.read_timeout, timeout)
    }

    /// How long a write waits before it fails with `TimedOut`; None waits for ever.
    pub fn set_write_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
        set_timeout(&self.pipe.write_timeout, timeout)
    }

    /// The pipe's handle, for the checks that ask the system who serves it.
    pub(crate) fn handle(&self) -> BorrowedHandle<'_> {
        use std::os::windows::io::AsHandle;
        self.pipe.handle.as_handle()
    }

    fn raw(&self) -> HANDLE {
        self.pipe.handle.as_raw_handle()
    }

    /// Runs one overlapped read or write, `start`, waiting at most `timeout`. Where `shut` is set,
    /// by `shutdown` on any clone, the operation ends.
    fn transfer(
        &self,
        timeout: &Mutex<Option<Duration>>,
        shut: &AtomicBool,
        start: impl FnOnce(HANDLE, *mut OVERLAPPED) -> bool,
    ) -> io::Result<Result<usize, Ended>> {
        if shut.load(Ordering::SeqCst) {
            return Ok(Err(Ended::Shut));
        }
        let timeout = *timeout.lock().unwrap_or_else(PoisonError::into_inner);
        let event = Event::new()?;
        // SAFETY: an all-zero OVERLAPPED is valid.
        let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
        overlapped.hEvent = event.0;
        let handle = self.raw();
        if !start(handle, &mut overlapped) {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(ERROR_IO_PENDING as i32) {
                return ended_by(error, shut);
            }
            // A shutdown that came before the operation started cancels it here.
            if shut.load(Ordering::SeqCst) {
                // SAFETY: `overlapped` is this operation's, still under way.
                unsafe { CancelIoEx(handle, &overlapped) };
            }
            let millis = timeout.map_or(INFINITE, |timeout| {
                timeout.as_millis().clamp(1, u128::from(INFINITE - 1)) as u32
            });
            // SAFETY: the event is open.
            if unsafe { WaitForSingleObject(event.0, millis) } != WAIT_OBJECT_0 {
                // Timed out: cancel it, and take what it moved meanwhile.
                // SAFETY: as above.
                unsafe { CancelIoEx(handle, &overlapped) };
            }
        }
        let mut moved = 0u32;
        // SAFETY: `overlapped` belongs to this operation; waiting lets it finish before it is
        // dropped.
        if unsafe { GetOverlappedResult(handle, &overlapped, &mut moved, 1) } == 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_OPERATION_ABORTED as i32)
                && !shut.load(Ordering::SeqCst)
            {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "the named pipe did not answer in time",
                ));
            }
            return ended_by(error, shut);
        }
        Ok(Ok(moved as usize))
    }
}

/// Why a read or write moved nothing: the connection was shut down on this side, or closed on the
/// other.
enum Ended {
    Shut,
    Closed,
}

/// What `error` means for an operation: the end of the connection, or a failure.
fn ended_by(error: io::Error, shut: &AtomicBool) -> io::Result<Result<usize, Ended>> {
    if shut.load(Ordering::SeqCst) {
        return Ok(Err(Ended::Shut));
    }
    if error.raw_os_error() == Some(ERROR_BROKEN_PIPE as i32) {
        return Ok(Err(Ended::Closed));
    }
    Err(error)
}

fn set_timeout(slot: &Mutex<Option<Duration>>, timeout: Option<Duration>) -> io::Result<()> {
    if timeout == Some(Duration::ZERO) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "cannot set a 0 duration timeout",
        ));
    }
    *slot.lock().unwrap_or_else(PoisonError::into_inner) = timeout;
    Ok(())
}

/// A manual-reset event, closed when dropped.
struct Event(HANDLE);

impl Event {
    fn new() -> io::Result<Event> {
        // SAFETY: no attributes and no name; the result is checked.
        let event = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
        if event.is_null() {
            return Err(io::Error::last_os_error());
        }
        Ok(Event(event))
    }
}

impl Drop for Event {
    fn drop(&mut self) {
        // SAFETY: the event is this value's own.
        unsafe { CloseHandle(self.0) };
    }
}

/// `text` as a NUL-terminated wide string.
fn wide(text: &OsStr) -> Vec<u16> {
    text.encode_wide().chain(Some(0)).collect()
}

/// Fails with `PermissionDenied` unless the process serving `pipe` runs as this process's user.
fn refuse_other_user(pipe: &OwnedHandle) -> io::Result<()> {
    let mut pid = 0u32;
    // SAFETY: the handle is an open pipe; `pid` is written.
    if unsafe { GetNamedPipeServerProcessId(pipe.as_raw_handle(), &mut pid) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let refused = || {
        let message = format!("the named pipe's server, process {pid}, is not this user's");
        io::Error::new(io::ErrorKind::PermissionDenied, message)
    };
    // SAFETY: the result is checked, and owned once open.
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return Err(refused());
    }
    // SAFETY: OpenProcess returned a handle that nothing else owns.
    let process = unsafe { OwnedHandle::from_raw_handle(process) };
    let theirs = token_user(process.as_raw_handle()).map_err(|_| refused())?;
    // SAFETY: the pseudo handle of this process needs no closing.
    let ours = token_user(unsafe { GetCurrentProcess() })?;
    // SAFETY: both buffers hold a TOKEN_USER whose SID lies inside the buffer.
    let same = unsafe {
        let theirs = &*(theirs.as_ptr() as *const TOKEN_USER);
        let ours = &*(ours.as_ptr() as *const TOKEN_USER);
        EqualSid(theirs.User.Sid, ours.User.Sid) != 0
    };
    if same { Ok(()) } else { Err(refused()) }
}

/// The `TOKEN_USER` of `process`'s token, in a buffer aligned for it.
fn token_user(process: HANDLE) -> io::Result<Vec<u64>> {
    let mut token: HANDLE = std::ptr::null_mut();
    // SAFETY: `process` is open with query access; the token is checked and owned once open.
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: OpenProcessToken returned a handle that nothing else owns.
    let token = unsafe { OwnedHandle::from_raw_handle(token) };
    let mut size = 0u32;
    // SAFETY: a size query with no buffer.
    unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            std::ptr::null_mut(),
            0,
            &mut size,
        )
    };
    let mut buffer = vec![0u64; (size as usize).div_ceil(8).max(1)];
    // SAFETY: the buffer holds `size` bytes.
    let got = unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            buffer.as_mut_ptr().cast(),
            size,
            &mut size,
        )
    };
    if got == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(buffer)
}

impl Read for &ClientSocket {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let pipe = &self.pipe;
        let wanted = buf.len().min(u32::MAX as usize) as u32;
        let read = self.transfer(&pipe.read_timeout, &pipe.read_shut, |handle, overlapped| {
            // SAFETY: `buf` and `overlapped` outlive the operation: `transfer` waits for it.
            unsafe {
                ReadFile(
                    handle,
                    buf.as_mut_ptr(),
                    wanted,
                    std::ptr::null_mut(),
                    overlapped,
                ) != 0
            }
        })?;
        Ok(read.unwrap_or(0))
    }
}

impl Write for &ClientSocket {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let pipe = &self.pipe;
        let wanted = buf.len().min(u32::MAX as usize) as u32;
        let written = self.transfer(
            &pipe.write_timeout,
            &pipe.write_shut,
            |handle, overlapped| {
                // SAFETY: as in `read`.
                unsafe {
                    WriteFile(
                        handle,
                        buf.as_ptr(),
                        wanted,
                        std::ptr::null_mut(),
                        overlapped,
                    ) != 0
                }
            },
        )?;
        match written {
            Ok(written) => Ok(written),
            Err(Ended::Shut) => Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "the connection was shut down",
            )),
            Err(Ended::Closed) => Err(io::Error::from_raw_os_error(ERROR_BROKEN_PIPE as i32)),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Read for ClientSocket {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        (&*self).read(buf)
    }
}

impl Write for ClientSocket {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        (&*self).write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        (&*self).flush()
    }
}
