//! A pseudo console's pipes, read and written on the terminal I/O thread.

use std::io;
use std::os::windows::io::{AsHandle, AsRawHandle, BorrowedHandle, FromRawHandle, OwnedHandle};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::Instant;

use windows_sys::Win32::Foundation::{
    ERROR_BROKEN_PIPE, ERROR_IO_INCOMPLETE, ERROR_OPERATION_ABORTED, ERROR_PIPE_NOT_CONNECTED,
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
use windows_sys::Win32::System::Threading::{
    CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, CreateEventW, CreateWaitableTimerExW,
    SYNCHRONIZATION_SYNCHRONIZE, SetWaitableTimer, TIMER_MODIFY_STATE,
};

use super::super::io_thread::{self, Operation};

/// The most bytes one read takes, and one write gives.
const CHUNK_BYTES: usize = 64 * 1024;

/// Waits until the monotonic instant through a one-shot timer on the terminal I/O port.
/// Dropping the future releases the timer and its completion packet.
pub(super) async fn wait_until_precise(at: Instant) -> io::Result<()> {
    if at <= Instant::now() {
        return Ok(());
    }
    // SAFETY: no name or security attributes, so the new handle is private to this caller.
    let raw = unsafe {
        CreateWaitableTimerExW(
            std::ptr::null(),
            std::ptr::null(),
            CREATE_WAITABLE_TIMER_HIGH_RESOLUTION,
            SYNCHRONIZATION_SYNCHRONIZE | TIMER_MODIFY_STATE,
        )
    };
    if raw.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: raw is a new handle with one owner.
    let timer = unsafe { OwnedHandle::from_raw_handle(raw) };
    loop {
        let remaining = at.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Ok(());
        }
        let due = -(remaining.as_nanos().div_ceil(100).min(i64::MAX as u128) as i64);
        // SAFETY: the timer and relative due time stay valid through the call.
        let armed =
            unsafe { SetWaitableTimer(timer.as_raw_handle(), &due, 0, None, std::ptr::null(), 0) };
        if armed == 0 {
            return Err(io::Error::last_os_error());
        }
        io_thread::wait_for_signal(timer.as_handle()).await?;
    }
}

#[cfg(test)]
mod timer_tests {
    use super::*;
    use std::future::{Future, poll_fn};
    use std::task::Poll;
    use std::time::Duration;

    #[tokio::test]
    async fn dropping_a_wait_leaves_the_next_timer_free_to_wake_at_its_due_time() {
        let mut first = Box::pin(wait_until_precise(Instant::now() + Duration::from_secs(10)));
        poll_fn(|cx| {
            assert!(first.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
        drop(first);

        let due = Instant::now() + Duration::from_millis(20);
        tokio::time::timeout(Duration::from_secs(3), wait_until_precise(due))
            .await
            .unwrap()
            .unwrap();
        assert!(Instant::now() >= due);
    }
}

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

/// The terminal's ends, bound to the terminal I/O thread's completion port: at most one read and
/// one write under way, and the bytes a read brought that its caller could not take yet.
pub(super) struct Io {
    input: OwnedHandle,
    output: OwnedHandle,
    reading: Mutex<Reading>,
    writing: Mutex<Option<Arc<Operation>>>,
}

#[derive(Default)]
struct Reading {
    under_way: Option<Arc<Operation>>,
    kept: Vec<u8>,
    ended: bool,
}

impl Reading {
    /// Takes the result of a read that is done: its bytes into `kept`, or the output's end.
    fn collect(&mut self) -> io::Result<()> {
        let Some(result) = self.under_way.as_ref().and_then(|read| read.done.take()) else {
            return Ok(());
        };
        let Some(read) = self.under_way.take() else {
            return Ok(());
        };
        match result {
            Ok(brought) => self.kept.extend_from_slice(read.bytes(brought)),
            Err(error) if is_end(&error) => self.ended = true,
            Err(error) if error.raw_os_error() == Some(ERROR_OPERATION_ABORTED as i32) => {}
            Err(error) => return Err(error),
        }
        Ok(())
    }

    /// Kept bytes, as many as `buf` holds; None where none are kept.
    fn give(&mut self, buf: &mut [u8]) -> Option<usize> {
        if self.kept.is_empty() {
            return None;
        }
        let count = buf.len().min(self.kept.len());
        buf[..count].copy_from_slice(&self.kept[..count]);
        self.kept.drain(..count);
        Some(count)
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
        Ok(Io {
            input,
            output,
            reading: Mutex::new(Reading::default()),
            writing: Mutex::new(None),
        })
    }

    pub(super) async fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
        loop {
            let read = {
                let mut reading = lock(&self.reading);
                if let Some(count) = self.output_now(&mut reading, buf)? {
                    return Ok(count);
                }
                reading.under_way.clone()
            };
            if let Some(read) = read {
                read.done.done().await;
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

    fn queued_output_bytes(&self) -> io::Result<usize> {
        let reading = lock(&self.reading);
        let output = self.output.as_raw_handle();
        let completed = || {
            let Some(read) = &reading.under_way else {
                return Ok(Some(0));
            };
            let mut bytes = 0;
            // SAFETY: this is the live operation on output. The call only samples its result.
            if unsafe { GetOverlappedResult(output, read.overlapped(), &mut bytes, 0) } != 0 {
                return Ok(Some(bytes as usize));
            }
            let error = io::Error::last_os_error();
            match error.raw_os_error().map(|code| code as u32) {
                Some(ERROR_IO_INCOMPLETE) => Ok(None),
                Some(ERROR_OPERATION_ABORTED | ERROR_BROKEN_PIPE | ERROR_PIPE_NOT_CONNECTED) => {
                    Ok(Some(0))
                }
                _ => Err(error),
            }
        };
        let queued = || {
            let mut bytes = 0;
            // SAFETY: output is open, and only the count of bytes waiting is requested.
            let peeked = unsafe {
                PeekNamedPipe(
                    output,
                    std::ptr::null_mut(),
                    0,
                    std::ptr::null_mut(),
                    &mut bytes,
                    std::ptr::null_mut(),
                )
            };
            if peeked == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(bytes as usize)
        };
        let mut read = completed()?;
        let mut pipe = queued()?;
        if read.is_none() {
            read = completed()?;
            if read.is_some() {
                // The outstanding read may have taken bytes counted by the first peek.
                pipe = queued()?;
            }
        }
        Ok(reading.kept.len() + read.unwrap_or(0) + pipe)
    }

    /// Output there now: kept bytes, or what a read that completes at once brings, or `Some(0)`
    /// at the output's end. Issues a read where none is under way; None while it stays under way.
    fn output_now(&self, reading: &mut Reading, buf: &mut [u8]) -> io::Result<Option<usize>> {
        loop {
            reading.collect()?;
            if let Some(count) = reading.give(buf) {
                return Ok(Some(count));
            }
            if reading.ended {
                return Ok(Some(0));
            }
            if reading.under_way.is_some() {
                return Ok(None);
            }
            let read = Operation::new(vec![0; CHUNK_BYTES]);
            let output = self.output.as_raw_handle();
            io_thread::issue(&read, |buffer, length, overlapped| {
                // SAFETY: the handle is open and bound; buffer and overlapped live in the
                // operation, which outlives the read.
                unsafe { ReadFile(output, buffer, length, std::ptr::null_mut(), overlapped) }
            });
            reading.under_way = Some(read);
        }
    }

    pub(super) async fn stop_reading(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let read = {
            let mut reading = lock(&self.reading);
            reading.collect()?;
            if let Some(count) = reading.give(buf) {
                return Ok(count);
            }
            let Some(read) = reading.under_way.clone() else {
                return Ok(0);
            };
            // SAFETY: the handle is open; the OVERLAPPED is the read's, alive in the operation.
            unsafe { CancelIoEx(self.output.as_raw_handle(), read.overlapped()) };
            read
        };
        read.done.done().await;
        let mut reading = lock(&self.reading);
        reading.collect()?;
        Ok(reading.give(buf).unwrap_or(0))
    }

    pub(super) async fn write(
        &self,
        bytes: &[u8],
        before: Option<&OnceLock<Option<usize>>>,
        permit: Option<&dyn super::WritePermit>,
    ) -> io::Result<super::WriteAttempt> {
        use super::WriteAttempt;

        let write = {
            let mut writing = lock(&self.writing);
            match writing.as_ref() {
                Some(write) => Arc::clone(write),
                None => {
                    if bytes.is_empty() {
                        return Ok(WriteAttempt::Written(0));
                    }
                    let write = Operation::new(bytes[..bytes.len().min(CHUNK_BYTES)].to_vec());
                    let input = self.input.as_raw_handle();
                    let mut read_first = false;
                    let mut immediate = None;
                    let mut issue = || {
                        let guarded_prefix = if permit.is_some() {
                            match self.queued_output_bytes() {
                                Ok(0) => Some(0),
                                Ok(_) => {
                                    read_first = true;
                                    return false;
                                }
                                Err(error) => {
                                    immediate = Some(Err(error));
                                    return false;
                                }
                            }
                        } else {
                            None
                        };
                        if io_thread::issue(&write, |buffer, length, overlapped| {
                            if let Some(before) = before {
                                let prefix =
                                    guarded_prefix.or_else(|| self.queued_output_bytes().ok());
                                let _ = before.set(prefix);
                            }
                            // SAFETY: the handle is open and bound. The operation keeps its
                            // buffer and overlapped alive until the write completes.
                            unsafe {
                                WriteFile(input, buffer, length, std::ptr::null_mut(), overlapped)
                            }
                        }) {
                            return true;
                        }
                        let result = write.done.take().unwrap_or(Ok(0));
                        let copied = result.as_ref().is_ok_and(|n| *n > 0);
                        immediate = Some(result);
                        copied
                    };
                    if let Some(permit) = permit {
                        if !permit.try_issue(&mut issue) {
                            return Ok(WriteAttempt::Revoked);
                        }
                    } else {
                        issue();
                    }
                    if read_first {
                        return Ok(WriteAttempt::ReadFirst);
                    }
                    if let Some(result) = immediate {
                        return result.map(WriteAttempt::Written);
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
        write
            .done
            .take()
            .unwrap_or(Ok(0))
            .map(WriteAttempt::Written)
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
