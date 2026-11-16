//! The single blocking call in the keeper on Windows: one I/O completion port, which every
//! overlapped operation and every process end completes on, each under a key of its own.

use std::io;
use std::os::windows::io::{AsHandle, AsRawHandle, BorrowedHandle, FromRawHandle, OwnedHandle};
use std::ptr;
use std::time::Instant;

use windows_sys::Win32::Foundation::{INVALID_HANDLE_VALUE, WAIT_TIMEOUT};
use windows_sys::Win32::System::IO::{
    CreateIoCompletionPort, GetQueuedCompletionStatusEx, OVERLAPPED, OVERLAPPED_ENTRY,
    PostQueuedCompletionStatus,
};

/// How many completions one wait takes at most; the rest wait for the next turn.
const BATCH: usize = 64;

/// What the loop waits on, and the source of the keys that tell completions apart.
pub(super) struct Port {
    port: OwnedHandle,
    /// The last key handed out. A key is never reused, so a completion that arrives after its
    /// owner was dropped names nothing and is ignored.
    last_key: usize,
}

impl Port {
    pub(super) fn new() -> io::Result<Port> {
        // SAFETY: a new port, owned by nobody else.
        let port = unsafe { CreateIoCompletionPort(INVALID_HANDLE_VALUE, ptr::null_mut(), 0, 1) };
        if port.is_null() {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: the port was just created and is owned here alone.
        let port = unsafe { OwnedHandle::from_raw_handle(port) };
        Ok(Port { port, last_key: 0 })
    }

    pub(super) fn handle(&self) -> BorrowedHandle<'_> {
        self.port.as_handle()
    }

    /// A key no completion has used.
    pub(super) fn key(&mut self) -> usize {
        self.last_key += 1;
        self.last_key
    }

    /// Makes every overlapped operation on `file` complete on this port under `key`.
    pub(super) fn bind(&self, file: BorrowedHandle<'_>, key: usize) -> io::Result<()> {
        // SAFETY: both handles are open for the duration of the call.
        let bound = unsafe {
            CreateIoCompletionPort(file.as_raw_handle(), self.port.as_raw_handle(), key, 0)
        };
        if bound.is_null() {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// Queues a completion under `key` by hand, for an operation that finished as it began.
    pub(super) fn post(&self, key: usize) -> io::Result<()> {
        // SAFETY: the port is open; the packet carries no OVERLAPPED.
        let posted =
            unsafe { PostQueuedCompletionStatus(self.port.as_raw_handle(), 0, key, ptr::null()) };
        if posted == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// Sleeps until something completes or `deadline` passes, and returns the keys of what
    /// completed, in order; none when the deadline passed.
    pub(super) fn wait(&self, deadline: Option<Instant>) -> io::Result<Vec<usize>> {
        // SAFETY: OVERLAPPED_ENTRY is plain data, for which all zeros is valid.
        let mut entries: [OVERLAPPED_ENTRY; BATCH] = unsafe { std::mem::zeroed() };
        let mut taken = 0u32;
        // SAFETY: `entries` holds BATCH entries; nothing is alertable.
        let ok = unsafe {
            GetQueuedCompletionStatusEx(
                self.port.as_raw_handle(),
                entries.as_mut_ptr(),
                BATCH as u32,
                &mut taken,
                timeout_ms(deadline),
                0,
            )
        };
        if ok == 0 {
            let error = io::Error::last_os_error();
            return match error.raw_os_error() {
                Some(code) if code as u32 == WAIT_TIMEOUT => Ok(Vec::new()),
                _ => Err(error),
            };
        }
        Ok(entries[..taken as usize]
            .iter()
            .map(|entry| entry.lpCompletionKey)
            .collect())
    }
}

/// Milliseconds until `deadline`, rounded up: rounding down would wake the loop a moment early
/// and make it spin until the deadline really passes. None waits without end.
fn timeout_ms(deadline: Option<Instant>) -> u32 {
    const INFINITE: u32 = u32::MAX;
    match deadline {
        None => INFINITE,
        Some(deadline) => {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let ms = remaining.as_nanos().div_ceil(1_000_000);
            u32::try_from(ms).unwrap_or(INFINITE - 1).min(INFINITE - 1)
        }
    }
}

/// An OVERLAPPED that stays where it is while the system writes into it.
pub(super) fn overlapped() -> Box<OVERLAPPED> {
    // SAFETY: OVERLAPPED is plain data, for which all zeros is valid.
    Box::new(unsafe { std::mem::zeroed() })
}
