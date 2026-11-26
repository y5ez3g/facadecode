//! A pseudo console's pipes, read and written on the terminal I/O thread.

use std::io;
use std::os::windows::io::{AsHandle, AsRawHandle, BorrowedHandle, FromRawHandle, OwnedHandle};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use windows_sys::Win32::Foundation::{
    ERROR_BROKEN_PIPE, ERROR_IO_PENDING, ERROR_OPERATION_ABORTED, ERROR_PIPE_NOT_CONNECTED,
    GENERIC_READ, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAG_OVERLAPPED, OPEN_EXISTING, PIPE_ACCESS_INBOUND, PIPE_ACCESS_OUTBOUND,
    ReadFile, WriteFile,
};
use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};
use windows_sys::Win32::System::JobObjects::CreateJobObjectW;
use windows_sys::Win32::System::Pipes::{
    CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE, PIPE_WAIT, PeekNamedPipe,
};
use windows_sys::Win32::System::Threading::CreateEventW;

use super::super::io_thread::{self, Operation};
use super::WriteObservation;

/// The most bytes one read takes, and one write gives.
const CHUNK_BYTES: usize = 64 * 1024;

/// How long a read waits before looking again when zero-byte reads keep completing with nothing
/// to read, which only another reader of the same pipe could cause.
const NOTHING_AFTER_READY: std::time::Duration = std::time::Duration::from_millis(1);

/// The input pipe's write end, the output pipe's read end, the signal pipe's write end until it is
/// let go of, and the CLI's job.
#[derive(Debug)]
pub(super) struct Master {
    input: OwnedHandle,
    output: OwnedHandle,
    signal: Option<OwnedHandle>,
    job: OwnedHandle,
}

/// A terminal's handles, borrowed: for duplicating them into another process.
pub(crate) struct Handles<'a> {
    pub(crate) input: BorrowedHandle<'a>,
    pub(crate) output: BorrowedHandle<'a>,
    pub(crate) signal: Option<BorrowedHandle<'a>>,
    pub(crate) job: BorrowedHandle<'a>,
}

impl Master {
    pub(super) fn from_handles(
        input: OwnedHandle,
        output: OwnedHandle,
        signal: Option<OwnedHandle>,
        job: OwnedHandle,
    ) -> Master {
        Master {
            input,
            output,
            signal,
            job,
        }
    }

    pub(super) fn job(&self) -> BorrowedHandle<'_> {
        self.job.as_handle()
    }

    pub(super) fn handles(&self) -> Handles<'_> {
        Handles {
            input: self.input.as_handle(),
            output: self.output.as_handle(),
            signal: self.signal.as_ref().map(OwnedHandle::as_handle),
            job: self.job.as_handle(),
        }
    }

    pub(super) fn try_clone(&self) -> io::Result<Master> {
        Ok(Master {
            input: self.input.try_clone()?,
            output: self.output.try_clone()?,
            signal: self
                .signal
                .as_ref()
                .map(OwnedHandle::try_clone)
                .transpose()?,
            job: self.job.try_clone()?,
        })
    }

    pub(super) fn let_go_before_stop(&mut self) {
        self.signal = None;
    }

    pub(super) fn size(&self) -> Option<(u16, u16)> {
        None
    }
}

/// The terminal's ends, bound to the terminal I/O thread's completion port: at most one write
/// under way, and on the output only a zero-byte read, which waits for output without taking
/// any. A sized read takes output only once it waits, and completes at once, so every byte that
/// reached Facade's end is either still in the pipe or given to the caller. This holds while this
/// `Io` is the output pipe's only reader.
pub(super) struct Io {
    input: OwnedHandle,
    output: OwnedHandle,
    /// Signals this `Io`'s sized reads, which the completion port does not take.
    read_event: OwnedHandle,
    reading: Mutex<Reading>,
    writing: Mutex<Option<Arc<Operation>>>,
}

#[derive(Default)]
struct Reading {
    /// A zero-byte read under way: it completes once output waits or the CLI's side closed.
    ready: Option<Arc<Operation>>,
    ended: bool,
}

impl Reading {
    /// Lets go of a zero-byte read that is done. It only said that output may wait; the pipe
    /// itself says whether it does, and reports the end once no bytes are left.
    fn settle(&mut self) -> io::Result<()> {
        let Some(result) = self.ready.as_ref().and_then(|read| read.done.take()) else {
            return Ok(());
        };
        self.ready = None;
        readiness(result)
    }
}

/// A zero-byte read's result: it completed, the CLI's side closed, or it was cancelled.
fn readiness(result: io::Result<usize>) -> io::Result<()> {
    match result {
        Err(error)
            if !is_end(&error) && error.raw_os_error() != Some(ERROR_OPERATION_ABORTED as i32) =>
        {
            Err(error)
        }
        _ => Ok(()),
    }
}

/// Whether a read's `error` says the CLI's side closed.
fn is_end(error: &io::Error) -> bool {
    let ends = [ERROR_BROKEN_PIPE, ERROR_PIPE_NOT_CONNECTED];
    error
        .raw_os_error()
        .is_some_and(|code| ends.iter().any(|&end| end as i32 == code))
}

impl Io {
    pub(super) fn new(master: &Master) -> io::Result<Io> {
        let input = master.input.try_clone()?;
        let output = master.output.try_clone()?;
        io_thread::bind(input.as_handle())?;
        io_thread::bind(output.as_handle())?;
        // SAFETY: a new manual-reset event, unsignaled, with no name or security attributes.
        let event = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
        if event.is_null() {
            return Err(io::Error::last_os_error());
        }
        Ok(Io {
            input,
            output,
            // SAFETY: event is a handle the call just returned and nothing else owns.
            read_event: unsafe { OwnedHandle::from_raw_handle(event) },
            reading: Mutex::new(Reading::default()),
            writing: Mutex::new(None),
        })
    }

    pub(super) async fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
        loop {
            let ready = {
                let mut reading = lock(&self.reading);
                if let Some(count) = self.output_now(&mut reading, buf)? {
                    return Ok(count);
                }
                reading.ready.clone()
            };
            match ready {
                Some(ready) => ready.done.done().await,
                None => tokio::time::sleep(NOTHING_AFTER_READY).await,
            }
        }
    }

    pub(super) fn try_read(&self, buf: &mut [u8]) -> io::Result<usize> {
        let mut reading = lock(&self.reading);
        match self.output_now(&mut reading, buf)? {
            Some(count) => Ok(count),
            None => Err(io::ErrorKind::WouldBlock.into()),
        }
    }

    /// The bytes waiting in the pipe. No read holds output the pipe no longer counts, so the
    /// count is whole when it is taken.
    pub(super) fn queued_output_bytes(&self) -> io::Result<usize> {
        let _reading = lock(&self.reading);
        self.waiting()?
            .ok_or_else(|| io::ErrorKind::UnexpectedEof.into())
    }

    /// The bytes waiting in the output pipe; None once the CLI's side closed and none are left.
    fn waiting(&self) -> io::Result<Option<usize>> {
        let mut bytes = 0;
        // SAFETY: output is open, and only the count of bytes waiting is requested.
        let peeked = unsafe {
            PeekNamedPipe(
                self.output.as_raw_handle(),
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
                &mut bytes,
                std::ptr::null_mut(),
            )
        };
        if peeked != 0 {
            return Ok(Some(bytes as usize));
        }
        let error = io::Error::last_os_error();
        if is_end(&error) { Ok(None) } else { Err(error) }
    }

    /// Output there now: bytes waiting in the pipe, or `Some(0)` at the output's end. With nothing
    /// there, leaves a zero-byte read under way and returns None.
    fn output_now(&self, reading: &mut Reading, buf: &mut [u8]) -> io::Result<Option<usize>> {
        if reading.ended {
            return Ok(Some(0));
        }
        // A zero-byte read that completes at once says output arrived after the look; this looks
        // again. Twice with nothing to read would take another reader, so it stops there.
        for _ in 0..2 {
            reading.settle()?;
            match self.waiting()? {
                None => {
                    reading.ended = true;
                    return Ok(Some(0));
                }
                Some(0) => {}
                Some(_) => match self.read_waiting(buf)? {
                    Some(0) => {
                        reading.ended = true;
                        return Ok(Some(0));
                    }
                    Some(count) => return Ok(Some(count)),
                    None => continue,
                },
            }
            if reading.ready.is_some() {
                return Ok(None);
            }
            let ready = Operation::new(vec![0; 1]);
            let output = self.output.as_raw_handle();
            let under_way = io_thread::issue(&ready, |buffer, _, overlapped| {
                // SAFETY: the handle is open and bound; the operation outlives the read, which
                // asks for no bytes.
                unsafe { ReadFile(output, buffer, 0, std::ptr::null_mut(), overlapped) }
            });
            if under_way {
                reading.ready = Some(ready);
                return Ok(None);
            }
            readiness(ready.done.take().unwrap_or(Ok(0)))?;
        }
        Ok(None)
    }

    /// Reads bytes that wait into `buf` with a read the completion port does not take: `Some` of
    /// a count above 0, or of 0 at the output's end. The waiting bytes complete it at once. If it
    /// stays under way all the same, which only another reader could cause, it is cancelled and
    /// waited for, which takes no longer than the cancellation; None when it then brought nothing.
    fn read_waiting(&self, buf: &mut [u8]) -> io::Result<Option<usize>> {
        let output = self.output.as_raw_handle();
        let length = u32::try_from(buf.len().min(CHUNK_BYTES)).unwrap_or(u32::MAX);
        // SAFETY: an all-zero OVERLAPPED is valid.
        let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
        // The low bit keeps the completion port from taking this read's completion.
        overlapped.hEvent = self
            .read_event
            .as_raw_handle()
            .map_addr(|address| address | 1);
        // SAFETY: the handle is open; buf and overlapped outlive the read, which completes or is
        // waited for below.
        let started = unsafe {
            ReadFile(
                output,
                buf.as_mut_ptr(),
                length,
                std::ptr::null_mut(),
                &mut overlapped,
            )
        };
        if started == 0 {
            let error = io::Error::last_os_error();
            if is_end(&error) {
                return Ok(Some(0));
            }
            if error.raw_os_error() != Some(ERROR_IO_PENDING as i32) {
                return Err(error);
            }
            // SAFETY: the OVERLAPPED is this read's, which is under way.
            unsafe { CancelIoEx(output, &overlapped) };
        }
        let mut brought = 0u32;
        // SAFETY: the read is done or cancelled; this waits for its completion, after which the
        // system no longer uses buf or overlapped.
        if unsafe { GetOverlappedResult(output, &overlapped, &mut brought, 1) } == 0 {
            let error = io::Error::last_os_error();
            if is_end(&error) {
                return Ok(Some(0));
            }
            if error.raw_os_error() != Some(ERROR_OPERATION_ABORTED as i32) {
                return Err(error);
            }
        }
        Ok((brought > 0).then_some(brought as usize))
    }

    /// Leaves no read under way: cancels the zero-byte read, which holds no bytes, and waits for
    /// it. Output still in the pipe stays there for the next reader.
    pub(super) async fn stop_reading(&mut self) -> io::Result<()> {
        let ready = {
            let mut reading = lock(&self.reading);
            reading.settle()?;
            let Some(ready) = reading.ready.clone() else {
                return Ok(());
            };
            // SAFETY: the handle is open; the OVERLAPPED is the read's, alive in the operation.
            unsafe { CancelIoEx(self.output.as_raw_handle(), ready.overlapped()) };
            ready
        };
        ready.done.done().await;
        lock(&self.reading).settle()
    }

    pub(super) async fn write(
        &self,
        bytes: &[u8],
        check: Option<WriteObservation<'_>>,
    ) -> io::Result<Option<usize>> {
        let write = {
            let mut writing = lock(&self.writing);
            match writing.as_ref() {
                Some(write) => Arc::clone(write),
                None => {
                    if bytes.is_empty() {
                        return Ok(Some(0));
                    }
                    let write = Operation::new(bytes[..bytes.len().min(CHUNK_BYTES)].to_vec());
                    let input = self.input.as_raw_handle();
                    let before = check.and_then(|_| self.queued_output_bytes().ok());
                    if check.is_some_and(|check| !check.permits(before)) {
                        return Ok(None);
                    }
                    let under_way = io_thread::issue(&write, |buffer, length, overlapped| {
                        // SAFETY: the handle is open and bound; buffer and overlapped live in
                        // the operation, which outlives the write.
                        unsafe {
                            WriteFile(input, buffer, length, std::ptr::null_mut(), overlapped)
                        }
                    });
                    if !under_way {
                        let result = write.done.take().unwrap_or(Ok(0));
                        if result.as_ref().is_ok_and(|n| *n > 0)
                            && let Some(check) = check
                        {
                            check.issued(before);
                        }
                        return result.map(Some);
                    }
                    if let Some(check) = check {
                        check.issued(before);
                    }
                    *writing = Some(Arc::clone(&write));
                    write
                }
            }
        };
        write.done.done().await;
        let mut writing = lock(&self.writing);
        if writing
            .as_ref()
            .is_some_and(|under_way| Arc::ptr_eq(under_way, &write))
        {
            *writing = None;
        }
        write.done.take().unwrap_or(Ok(0)).map(Some)
    }

    pub(super) fn set_size(&self, master: &Master, cols: u16, rows: u16) {
        if let Some(signal) = &master.signal {
            let _ = write_packet(signal.as_handle(), cols, rows);
        }
    }
}

impl Drop for Io {
    fn drop(&mut self) {
        // The ends stay open in the master, so a read or write under way would go on; its
        // completion still comes to the thread, which frees it.
        // SAFETY: both handles are open.
        unsafe {
            CancelIoEx(self.output.as_raw_handle(), std::ptr::null());
            CancelIoEx(self.input.as_raw_handle(), std::ptr::null());
        }
    }
}

/// Writes the resize packet `{8, cols, rows}` to the signal pipe, waiting for it, whether the
/// pipe end was opened overlapped or not.
fn write_packet(signal: BorrowedHandle<'_>, cols: u16, rows: u16) -> io::Result<()> {
    let mut packet = [0u8; 6];
    for (at, value) in [8u16, cols, rows].into_iter().enumerate() {
        packet[at * 2..at * 2 + 2].copy_from_slice(&value.to_le_bytes());
    }
    // SAFETY: a new manual-reset event, or null.
    let event = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
    if event.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: event is a handle the call just returned and nothing else owns.
    let event = unsafe { OwnedHandle::from_raw_handle(event) };
    // SAFETY: an all-zero OVERLAPPED is valid.
    let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
    overlapped.hEvent = event.as_raw_handle();
    let mut written = 0u32;
    // SAFETY: the handle is open; packet and overlapped outlive the write, which is waited for
    // below before they go.
    let started = unsafe {
        WriteFile(
            signal.as_raw_handle(),
            packet.as_ptr(),
            packet.len() as u32,
            std::ptr::null_mut(),
            &mut overlapped,
        )
    };
    let pending = io::Error::last_os_error();
    if started == 0
        && pending.raw_os_error() != Some(windows_sys::Win32::Foundation::ERROR_IO_PENDING as i32)
    {
        return Err(pending);
    }
    // SAFETY: as above; this waits for the write to complete.
    if unsafe { GetOverlappedResult(signal.as_raw_handle(), &overlapped, &mut written, 1) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// A test terminal: three pipes whose server ends are the CLI's, synchronous, and whose client
/// ends are Facade's, overlapped, as a pseudo console's are, and a job.
pub(super) fn test_terminal(cols: u16, rows: u16) -> io::Result<(Master, TestCli)> {
    let name = format!(
        r"\\.\pipe\facade-test-terminal-{}-{:016x}",
        std::process::id(),
        crate::platform::random_u64()
    );
    let (cli_input, input) = pipe(&format!("{name}-input"), PIPE_ACCESS_INBOUND, GENERIC_WRITE)?;
    let (cli_output, output) = pipe(
        &format!("{name}-output"),
        PIPE_ACCESS_OUTBOUND,
        GENERIC_READ,
    )?;
    let (cli_signal, signal) = pipe(
        &format!("{name}-signal"),
        PIPE_ACCESS_INBOUND,
        GENERIC_WRITE,
    )?;
    // SAFETY: a new unnamed job, or null.
    let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if job.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: job is a handle the call just returned and nothing else owns.
    let job = unsafe { OwnedHandle::from_raw_handle(job) };
    let master = Master::from_handles(input, output, Some(signal), job);
    let cli = TestCli {
        input: cli_input,
        output: cli_output,
        signal: cli_signal,
        size: Arc::new(Mutex::new((cols, rows))),
    };
    Ok((master, cli))
}

/// A named pipe `name`: its server end with `server_access`, and its client end opened overlapped
/// with `client_access`.
fn pipe(
    name: &str,
    server_access: u32,
    client_access: u32,
) -> io::Result<(OwnedHandle, OwnedHandle)> {
    let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
    let mode = PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT;
    let bytes = CHUNK_BYTES as u32;
    // SAFETY: wide is a NUL-terminated name; the call returns a new handle or INVALID_HANDLE_VALUE.
    let server = unsafe {
        CreateNamedPipeW(
            wide.as_ptr(),
            server_access,
            mode,
            1,
            bytes,
            bytes,
            0,
            std::ptr::null(),
        )
    };
    let server = owned(server)?;
    // SAFETY: as above.
    let client = unsafe {
        CreateFileW(
            wide.as_ptr(),
            client_access,
            0,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_OVERLAPPED,
            std::ptr::null_mut(),
        )
    };
    Ok((server, owned(client)?))
}

fn owned(raw: HANDLE) -> io::Result<OwnedHandle> {
    if raw == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: raw is a handle a call just returned and nothing else owns.
    Ok(unsafe { OwnedHandle::from_raw_handle(raw) })
}

/// The CLI side of a test terminal's pipes.
pub(super) struct TestCli {
    input: OwnedHandle,
    output: OwnedHandle,
    signal: OwnedHandle,
    /// Shared by every copy, as each may read the signal pipe.
    size: Arc<Mutex<(u16, u16)>>,
}

impl TestCli {
    /// Another end of the same CLI side.
    pub(super) fn try_clone(&self) -> io::Result<TestCli> {
        Ok(TestCli {
            input: self.input.try_clone()?,
            output: self.output.try_clone()?,
            signal: self.signal.try_clone()?,
            size: Arc::clone(&self.size),
        })
    }

    pub(super) fn read_input(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match read_now(self.input.as_handle(), buf) {
            Err(error) if is_end(&error) => Ok(0),
            read => read,
        }
    }

    pub(super) fn write_output(&mut self, bytes: &[u8]) -> io::Result<()> {
        let mut left = bytes;
        while !left.is_empty() {
            let mut written = 0u32;
            let length = u32::try_from(left.len()).unwrap_or(u32::MAX);
            // SAFETY: the handle is open and synchronous; left is readable for length bytes.
            let done = unsafe {
                WriteFile(
                    self.output.as_raw_handle(),
                    left.as_ptr(),
                    length,
                    &mut written,
                    std::ptr::null_mut(),
                )
            };
            if done == 0 {
                return Err(io::Error::last_os_error());
            }
            left = &left[written as usize..];
        }
        Ok(())
    }

    /// The last resize packet on the signal pipe, or the size the terminal was made with.
    pub(super) fn size(&self) -> (u16, u16) {
        let mut waiting = 0u32;
        // SAFETY: the handle is open; only the count of bytes waiting is asked for.
        let peeked = unsafe {
            PeekNamedPipe(
                self.signal.as_raw_handle(),
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
                &mut waiting,
                std::ptr::null_mut(),
            )
        };
        let whole = (waiting as usize / 6) * 6;
        if peeked != 0 && whole > 0 {
            let mut packets = vec![0u8; whole];
            if read_now(self.signal.as_handle(), &mut packets).ok() == Some(whole) {
                let last = &packets[whole - 6..];
                let value = |at: usize| u16::from_le_bytes([last[at], last[at + 1]]);
                *lock(&self.size) = (value(2), value(4));
            }
        }
        *lock(&self.size)
    }
}

/// One synchronous read of `file`.
fn read_now(file: BorrowedHandle<'_>, buf: &mut [u8]) -> io::Result<usize> {
    let mut read = 0u32;
    let length = u32::try_from(buf.len()).unwrap_or(u32::MAX);
    // SAFETY: the handle is open and synchronous; buf is writable for length bytes.
    let done = unsafe {
        ReadFile(
            file.as_raw_handle(),
            buf.as_mut_ptr(),
            length,
            &mut read,
            std::ptr::null_mut(),
        )
    };
    if done == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(read as usize)
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
