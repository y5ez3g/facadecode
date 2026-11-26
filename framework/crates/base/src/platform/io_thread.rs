//! The terminal I/O thread: one thread around one completion port, which every terminal's pipe
//! ends are bound to. A read or write is issued by the task that wants it, overlapped; the thread
//! takes its completion and wakes that task. It also takes wait completion packets for process
//! exits and waitable timers. It starts on first use and runs for as long as the process.

use std::collections::HashMap;
use std::ffi::c_void;
use std::io;
use std::os::windows::io::{AsHandle, AsRawHandle, BorrowedHandle, FromRawHandle, OwnedHandle};
use std::pin::pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};

use tokio::sync::Notify;
use windows_sys::Wdk::Storage::FileSystem::{
    FILE_COMPLETION_INFORMATION, FileReplaceCompletionInformation, NtSetInformationFile,
};
use windows_sys::Win32::Foundation::{
    HANDLE, INVALID_HANDLE_VALUE, NTSTATUS, RtlNtStatusToDosError, STATUS_INVALID_PARAMETER,
};
use windows_sys::Win32::Storage::FileSystem::SetFileCompletionNotificationModes;
use windows_sys::Win32::System::IO::{
    CreateIoCompletionPort, GetQueuedCompletionStatusEx, IO_STATUS_BLOCK, OVERLAPPED,
    OVERLAPPED_ENTRY,
};
use windows_sys::Win32::System::WindowsProgramming::FILE_SKIP_COMPLETION_PORT_ON_SUCCESS;

/// The key of a read's or write's completion, whose overlapped pointer is its [`Operation`]. A
/// wait completion packet's key is any other.
const OPERATION_KEY: usize = 0;

/// How many completions the thread takes at once.
const BATCH: usize = 64;

/// The thread's port and the objects that tasks await, by key.
struct IoThread {
    port: OwnedHandle,
    waits: Mutex<HashMap<usize, Arc<Completion>>>,
    next_key: AtomicUsize,
}

static THREAD: OnceLock<Result<IoThread, i32>> = OnceLock::new();

/// The terminal I/O thread, started on first use; the error is the system's code.
fn io_thread() -> io::Result<&'static IoThread> {
    match THREAD.get_or_init(|| start().map_err(|error| error.raw_os_error().unwrap_or(0))) {
        Ok(thread) => Ok(thread),
        Err(code) => Err(io::Error::from_raw_os_error(*code)),
    }
}

fn start() -> io::Result<IoThread> {
    // SAFETY: a new port, associated with no file.
    let raw = unsafe { CreateIoCompletionPort(INVALID_HANDLE_VALUE, std::ptr::null_mut(), 0, 1) };
    if raw.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: raw is a handle the call just returned and nothing else owns.
    let port = unsafe { OwnedHandle::from_raw_handle(raw) };
    let port_for_thread = port.as_raw_handle() as usize;
    std::thread::Builder::new()
        .name("terminal I/O".to_string())
        .spawn(move || take_completions(port_for_thread))?;
    Ok(IoThread {
        port,
        waits: Mutex::new(HashMap::new()),
        next_key: AtomicUsize::new(OPERATION_KEY + 1),
    })
}

/// The thread's loop: takes completions and wakes whoever waits on each.
fn take_completions(port: usize) {
    // SAFETY: an all-zero OVERLAPPED_ENTRY is valid.
    let mut entries: [OVERLAPPED_ENTRY; BATCH] = unsafe { std::mem::zeroed() };
    loop {
        let mut taken = 0u32;
        // SAFETY: the port stays open for the process's life, in the static IoThread; entries is
        // writable for BATCH entries.
        let got = unsafe {
            GetQueuedCompletionStatusEx(
                port as _,
                entries.as_mut_ptr(),
                BATCH as u32,
                &mut taken,
                u32::MAX,
                0,
            )
        };
        if got == 0 {
            continue;
        }
        for entry in &entries[..taken as usize] {
            if entry.lpCompletionKey == OPERATION_KEY {
                // SAFETY: an operation's overlapped pointer is the Arc that `issue` gave the
                // system, which comes back once, here.
                let operation = unsafe { Arc::from_raw(entry.lpOverlapped as *const Operation) };
                let status = operation.status();
                operation
                    .done
                    .finish(result_of(status, entry.dwNumberOfBytesTransferred as usize));
            } else if let Some(Ok(thread)) = THREAD.get() {
                let waits = lock(&thread.waits);
                if let Some(wait) = waits.get(&entry.lpCompletionKey) {
                    wait.finish(Ok(0));
                }
            }
        }
    }
}

/// A read's or write's result, once it is there, and the task waiting for it.
#[derive(Default)]
pub(super) struct Completion {
    result: Mutex<Option<io::Result<usize>>>,
    notify: Notify,
}

impl Completion {
    fn finish(&self, result: io::Result<usize>) {
        *lock(&self.result) = Some(result);
        self.notify.notify_waiters();
    }

    pub(super) fn is_done(&self) -> bool {
        lock(&self.result).is_some()
    }

    /// The result, once; None while the operation is under way or after it was taken.
    pub(super) fn take(&self) -> Option<io::Result<usize>> {
        lock(&self.result).take()
    }

    /// Returns once the result is there. Cancel-safe.
    pub(super) async fn done(&self) {
        loop {
            let mut notified = pin!(self.notify.notified());
            notified.as_mut().enable();
            if self.is_done() {
                return;
            }
            notified.await;
        }
    }
}

/// An overlapped read or write: its OVERLAPPED first, so that the system's pointer to it is a
/// pointer to the whole, and its buffer, which the system uses until it completes.
#[repr(C)]
pub(super) struct Operation {
    overlapped: std::cell::UnsafeCell<OVERLAPPED>,
    buffer: std::cell::UnsafeCell<Vec<u8>>,
    pub(super) done: Completion,
}

// SAFETY: the system writes the OVERLAPPED and buffer only while the operation is under way, and
// they are read only once it is done, which the Completion's lock orders.
unsafe impl Send for Operation {}
// SAFETY: as above.
unsafe impl Sync for Operation {}

impl Operation {
    /// A read of up to `capacity` bytes, or a write of `bytes`.
    pub(super) fn new(buffer: Vec<u8>) -> Arc<Operation> {
        Arc::new(Operation {
            // SAFETY: an all-zero OVERLAPPED is valid.
            overlapped: std::cell::UnsafeCell::new(unsafe { std::mem::zeroed() }),
            buffer: std::cell::UnsafeCell::new(buffer),
            done: Completion::default(),
        })
    }

    /// The bytes a read brought, `brought` of them. Only once it is done.
    pub(super) fn bytes(&self, brought: usize) -> &[u8] {
        // SAFETY: the operation is done, so the system no longer writes the buffer.
        let buffer = unsafe { &*self.buffer.get() };
        &buffer[..brought.min(buffer.len())]
    }

    pub(super) fn overlapped(&self) -> *mut OVERLAPPED {
        self.overlapped.get()
    }

    fn status(&self) -> NTSTATUS {
        // SAFETY: the operation is done; Internal holds its status.
        unsafe { (*self.overlapped.get()).Internal as NTSTATUS }
    }
}

/// Issues `operation` on `file` through `call`, `ReadFile` or `WriteFile` with the operation's
/// buffer and OVERLAPPED. Returns whether it is under way, its completion still to come on the
/// thread; otherwise its result is in `operation.done` already.
pub(super) fn issue(
    operation: &Arc<Operation>,
    call: impl FnOnce(*mut u8, u32, *mut OVERLAPPED) -> i32,
) -> bool {
    let raw = Arc::into_raw(Arc::clone(operation));
    // SAFETY: the buffer is not touched by anyone else until the operation is done.
    let buffer = unsafe { &mut *operation.buffer.get() };
    let length = u32::try_from(buffer.len()).unwrap_or(u32::MAX);
    let completed = call(buffer.as_mut_ptr(), length, operation.overlapped());
    let error = io::Error::last_os_error();
    if completed == 0
        && error.raw_os_error() == Some(windows_sys::Win32::Foundation::ERROR_IO_PENDING as i32)
    {
        // The system holds `raw` until the thread takes its completion.
        return true;
    }
    // Completed or failed at once: with FILE_SKIP_COMPLETION_PORT_ON_SUCCESS no completion
    // follows, so the reference comes back here.
    // SAFETY: raw came from Arc::into_raw above and the system did not keep it.
    drop(unsafe { Arc::from_raw(raw) });
    let result = if completed != 0 {
        // SAFETY: the operation completed; InternalHigh holds its count.
        Ok(unsafe { (*operation.overlapped()).InternalHigh })
    } else {
        Err(error)
    };
    operation.done.finish(result);
    false
}

/// Binds the pipe end `file` to the thread's port, after removing any binding an earlier process
/// left on it, and makes a read or write that completes at once complete without a completion.
pub(super) fn bind(file: BorrowedHandle<'_>) -> io::Result<()> {
    let thread = io_thread()?;
    // SAFETY: an all-zero IO_STATUS_BLOCK is valid.
    let mut status_block: IO_STATUS_BLOCK = unsafe { std::mem::zeroed() };
    let unbound = FILE_COMPLETION_INFORMATION {
        Port: std::ptr::null_mut(),
        Key: std::ptr::null_mut(),
    };
    // SAFETY: the handle is open; both structures are live for the call.
    let status = unsafe {
        NtSetInformationFile(
            file.as_raw_handle(),
            &mut status_block,
            (&raw const unbound).cast(),
            size_of::<FILE_COMPLETION_INFORMATION>() as u32,
            FileReplaceCompletionInformation,
        )
    };
    // A file no port was bound to refuses the removal as an invalid parameter.
    if status != STATUS_INVALID_PARAMETER {
        result_of(status, 0)?;
    }
    // SAFETY: the handle and the port are open.
    let bound = unsafe {
        CreateIoCompletionPort(
            file.as_raw_handle(),
            thread.port.as_raw_handle(),
            OPERATION_KEY,
            0,
        )
    };
    if bound.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the handle is open.
    let flags = FILE_SKIP_COMPLETION_PORT_ON_SUCCESS as u8;
    if unsafe { SetFileCompletionNotificationModes(file.as_raw_handle(), flags) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Returns when the target signals. Dropping the wait cancels its completion packet.
pub(crate) async fn wait_for_signal(target: BorrowedHandle<'_>) -> io::Result<()> {
    let thread = io_thread()?;
    let key = thread.next_key.fetch_add(1, Ordering::Relaxed);
    let completion = Arc::new(Completion::default());
    lock(&thread.waits).insert(key, Arc::clone(&completion));
    let _awaited = Awaited { thread, key };
    let _packet = WaitPacket::arm(thread.port.as_handle(), target, key)?;
    completion.done().await;
    Ok(())
}

/// A completion key, forgotten when the wait ends or is dropped.
struct Awaited {
    thread: &'static IoThread,
    key: usize,
}

impl Drop for Awaited {
    fn drop(&mut self) {
        lock(&self.thread.waits).remove(&self.key);
    }
}

/// An operation's status and count as a result, with the Windows error the status maps to.
fn result_of(status: NTSTATUS, count: usize) -> io::Result<usize> {
    if status >= 0 {
        return Ok(count);
    }
    // SAFETY: RtlNtStatusToDosError has no preconditions.
    let code = unsafe { RtlNtStatusToDosError(status) };
    Err(io::Error::from_raw_os_error(code as i32))
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtCreateWaitCompletionPacket(
        packet: *mut HANDLE,
        access: u32,
        attributes: *const c_void,
    ) -> NTSTATUS;
    fn NtAssociateWaitCompletionPacket(
        packet: HANDLE,
        port: HANDLE,
        target: HANDLE,
        key: *const c_void,
        apc_context: *const c_void,
        status: NTSTATUS,
        information: usize,
        already_signaled: *mut u8,
    ) -> NTSTATUS;
    fn NtCancelWaitCompletionPacket(packet: HANDLE, remove_signaled_packet: u8) -> NTSTATUS;
}

/// The access that asks for every right the caller may have.
const MAXIMUM_ALLOWED: u32 = 0x0200_0000;

/// A waitable object's signal, armed to arrive on a completion port with a key. Dropping it
/// cancels the wait.
pub struct WaitPacket(OwnedHandle);

impl WaitPacket {
    /// Arms a wait completion packet that completes on `port` with `key` when `target` signals.
    /// The completion's overlapped pointer is null.
    pub fn arm(
        port: BorrowedHandle<'_>,
        target: BorrowedHandle<'_>,
        key: usize,
    ) -> io::Result<WaitPacket> {
        let mut raw: HANDLE = std::ptr::null_mut();
        // SAFETY: raw receives a new handle, which is owned below.
        result_of(
            unsafe { NtCreateWaitCompletionPacket(&mut raw, MAXIMUM_ALLOWED, std::ptr::null()) },
            0,
        )?;
        // SAFETY: raw is a handle this call just created and nothing else owns.
        let packet = WaitPacket(unsafe { OwnedHandle::from_raw_handle(raw) });
        let mut already_signaled = 0u8;
        // SAFETY: every handle is open for the call; the key is a value, not a pointer.
        result_of(
            unsafe {
                NtAssociateWaitCompletionPacket(
                    packet.0.as_raw_handle(),
                    port.as_raw_handle(),
                    target.as_raw_handle(),
                    key as *const c_void,
                    std::ptr::null(),
                    0,
                    0,
                    &mut already_signaled,
                )
            },
            0,
        )?;
        Ok(packet)
    }
}

impl Drop for WaitPacket {
    fn drop(&mut self) {
        // SAFETY: the packet's handle is open until self.0 drops after this.
        unsafe { NtCancelWaitCompletionPacket(self.0.as_raw_handle(), 1) };
    }
}
