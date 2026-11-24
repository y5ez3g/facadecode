//! The daemon's named pipe.

use std::ffi::OsStr;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, IntoRawHandle, OwnedHandle};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::task::{Context, Poll, Waker};
use std::time::Duration;

use tokio::io::{AsyncRead, ReadBuf, ReadHalf, WriteHalf};
use tokio::net::windows::named_pipe::NamedPipeServer;
use windows_sys::Wdk::Storage::FileSystem::{
    FILE_PIPE_CONNECTED_STATE, FILE_PIPE_LISTENING_STATE, FILE_PIPE_LOCAL_INFORMATION,
    FilePipeLocalInformation, NtQueryInformationFile,
};
use windows_sys::Win32::Foundation::{
    DUPLICATE_SAME_ACCESS, DuplicateHandle, HANDLE, INVALID_HANDLE_VALUE, LocalFree,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
use windows_sys::Win32::Storage::FileSystem::{FILE_FLAG_OVERLAPPED, PIPE_ACCESS_DUPLEX};
use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;
use windows_sys::Win32::System::Pipes::{
    CreateNamedPipeW, DisconnectNamedPipe, GetNamedPipeClientProcessId, PIPE_READMODE_BYTE,
    PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
};
use windows_sys::Win32::System::Threading::GetCurrentProcess;

use crate::platform::socket_paths::ClientSocket;

pub(super) type Socket = NamedPipeServer;
pub(super) type Writer = WriteHalf<NamedPipeServer>;

/// The access list of every pipe: its owner alone, with every right.
const OWNER_ONLY: &str = "D:P(A;;GA;;;OW)";

/// How often a connection is checked for its client's close.
const CLOSE_CHECK_INTERVAL: Duration = Duration::from_millis(100);

/// How many bytes each direction of a pipe buffers.
const PIPE_BUFFER_BYTES: u32 = 65_536;

/// One overlapped instance of the named pipe `path`, with the access list that lets in its owner
/// alone. For the keeper, and each of the daemon's instances.
pub fn server_pipe(path: &Path) -> io::Result<OwnedHandle> {
    owner_only_pipe(
        path.as_os_str(),
        PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
        PIPE_UNLIMITED_INSTANCES,
    )
}

/// An instance of the named pipe `name` with `open_mode`, `pipe_mode` and up to `instances`
/// instances, and the access list that lets in its owner alone.
pub(crate) fn owner_only_pipe(
    name: &OsStr,
    open_mode: u32,
    pipe_mode: u32,
    instances: u32,
) -> io::Result<OwnedHandle> {
    let sddl: Vec<u16> = OsStr::new(OWNER_ONLY)
        .encode_wide()
        .chain(Some(0))
        .collect();
    let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    // SAFETY: `sddl` is NUL-terminated; the descriptor is freed below.
    let made = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            std::ptr::null_mut(),
        )
    };
    if made == 0 {
        return Err(io::Error::last_os_error());
    }
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor,
        bInheritHandle: 0,
    };
    let name: Vec<u16> = name.encode_wide().chain(Some(0)).collect();
    // SAFETY: `name` is NUL-terminated and `attributes` points at a valid descriptor.
    let pipe = unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            open_mode,
            pipe_mode,
            instances,
            PIPE_BUFFER_BYTES,
            PIPE_BUFFER_BYTES,
            0,
            &attributes,
        )
    };
    let made = if pipe == INVALID_HANDLE_VALUE {
        Err(io::Error::last_os_error())
    } else {
        // SAFETY: CreateNamedPipeW returned a handle that nothing else owns.
        Ok(unsafe { OwnedHandle::from_raw_handle(pipe) })
    };
    // SAFETY: the descriptor came from LocalAlloc, and the pipe no longer needs it.
    unsafe { LocalFree(descriptor) };
    made
}

/// `pipe` on tokio's reactor.
fn on_reactor(pipe: OwnedHandle) -> io::Result<NamedPipeServer> {
    // SAFETY: the handle is an overlapped named pipe's, which the server owns from here on.
    unsafe { NamedPipeServer::from_raw_handle(pipe.into_raw_handle()) }
}

/// The daemon's pipe, with the instance the next client connects to.
pub(super) struct Listener {
    path: PathBuf,
    next: NamedPipeServer,
}

impl Listener {
    pub(super) fn bind(path: &Path) -> io::Result<Listener> {
        Ok(Listener {
            path: path.to_path_buf(),
            next: on_reactor(server_pipe(path)?)?,
        })
    }

    /// Cancel-safe: a client that connected meanwhile stays connected to the waiting instance, and
    /// the next call returns it.
    pub(super) async fn accept(&mut self) -> io::Result<Socket> {
        self.next.connect().await?;
        let next = on_reactor(server_pipe(&self.path)?)?;
        Ok(std::mem::replace(&mut self.next, next))
    }
}

pub(super) fn peer_pid(socket: &Socket) -> Option<u32> {
    let mut pid = 0u32;
    // SAFETY: the pipe is open; `pid` is written.
    let known = unsafe { GetNamedPipeClientProcessId(socket.as_raw_handle(), &mut pid) } != 0;
    known.then_some(pid)
}

pub(super) fn split(socket: Socket) -> (Reader, Writer, Peer) {
    let read_shut = Arc::new(ReadShut::default());
    let peer = Peer {
        pipe: duplicate(socket.as_raw_handle()).ok(),
        read_shut: Arc::clone(&read_shut),
    };
    let (reader, writer) = tokio::io::split(socket);
    (Reader { reader, read_shut }, writer, peer)
}

/// Whether the daemon shut down its reading of a connection, and the read that waits meanwhile.
#[derive(Default)]
struct ReadShut {
    shut: AtomicBool,
    waiting: Mutex<Option<Waker>>,
}

/// The reading half of a client's connection, which ends at the daemon's own shutdown of reading,
/// while the client stays connected and replies still reach it.
pub(super) struct Reader {
    reader: ReadHalf<NamedPipeServer>,
    read_shut: Arc<ReadShut>,
}

impl AsyncRead for Reader {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let waiting = &self.read_shut.waiting;
        *waiting.lock().unwrap_or_else(PoisonError::into_inner) = Some(cx.waker().clone());
        if self.read_shut.shut.load(Ordering::SeqCst) {
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut self.reader).poll_read(cx, buf)
    }
}

/// A copy of `handle` in this process.
fn duplicate(handle: HANDLE) -> io::Result<OwnedHandle> {
    let mut copy: HANDLE = std::ptr::null_mut();
    // SAFETY: `handle` is open; the copy is checked and owned once made.
    let made = unsafe {
        let this = GetCurrentProcess();
        DuplicateHandle(this, handle, this, &mut copy, 0, 0, DUPLICATE_SAME_ACCESS)
    };
    if made == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: DuplicateHandle made a handle that nothing else owns.
    Ok(unsafe { OwnedHandle::from_raw_handle(copy) })
}

/// A copy of the connection's handle, None where it could not be copied, and then the close is
/// never seen; and the reader's shutdown.
pub(super) struct Peer {
    pipe: Option<OwnedHandle>,
    read_shut: Arc<ReadShut>,
}

impl Peer {
    /// A pipe tells no one of its client's close but a reader, so the pipe's state is checked every
    /// [`CLOSE_CHECK_INTERVAL`]; it reads no byte.
    pub(super) async fn closed(&self) {
        let Some(pipe) = &self.pipe else {
            return std::future::pending().await;
        };
        while connected(pipe) {
            tokio::time::sleep(CLOSE_CHECK_INTERVAL).await;
        }
    }

    /// `Read` ends the connection's reader, which returns no more bytes, and leaves the client
    /// connected. A pipe has no half close, so `Write` and `Both` disconnect the client, and what
    /// it has not read is lost.
    pub(super) fn shutdown(&self, how: std::net::Shutdown) {
        if how == std::net::Shutdown::Read {
            self.read_shut.shut.store(true, Ordering::SeqCst);
            let waiting = self.read_shut.waiting.lock();
            if let Some(waker) = waiting.unwrap_or_else(PoisonError::into_inner).take() {
                waker.wake();
            }
            return;
        }
        if let Some(pipe) = &self.pipe {
            // SAFETY: the copy is open.
            unsafe { DisconnectNamedPipe(pipe.as_raw_handle()) };
        }
    }
}

/// Whether `pipe` still has its client, or waits for one; false once the client closed or the
/// state cannot be read.
fn connected(pipe: &OwnedHandle) -> bool {
    // SAFETY: all-zero values of both are valid.
    let (mut status, mut info): (IO_STATUS_BLOCK, FILE_PIPE_LOCAL_INFORMATION) =
        unsafe { (std::mem::zeroed(), std::mem::zeroed()) };
    // SAFETY: `info` has the size given, and the handle is open.
    let queried = unsafe {
        NtQueryInformationFile(
            pipe.as_raw_handle(),
            &mut status,
            (&raw mut info).cast(),
            size_of::<FILE_PIPE_LOCAL_INFORMATION>() as u32,
            FilePipeLocalInformation,
        )
    };
    queried >= 0
        && matches!(
            info.NamedPipeState,
            FILE_PIPE_CONNECTED_STATE | FILE_PIPE_LISTENING_STATE
        )
}

/// Tells pipes of `pair` apart within this process.
static PAIRS: AtomicU64 = AtomicU64::new(0);

pub(super) fn pair() -> io::Result<(ClientSocket, Socket)> {
    let number = PAIRS.fetch_add(1, Ordering::Relaxed);
    let name = format!(
        r"\\.\pipe\facade-framework-pair-{}-{number}",
        std::process::id()
    );
    let server = server_pipe(Path::new(&name))?;
    let client = ClientSocket::connect(&name)?;
    // On the reactor only once the client is connected: one registered before reads at once, finds
    // no client, and never reads again.
    let server = on_reactor(server)?;
    Ok((client, server))
}
