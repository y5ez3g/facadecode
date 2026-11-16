//! Nonblocking terminal I/O and the ordered input waiting to reach the CLI.

use std::collections::VecDeque;
use std::fs::File;
use std::future::pending;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, OwnedFd};

use tokio::io::Interest;
use tokio::io::unix::AsyncFd;
use tokio::time::Instant;

/// The most bytes one read takes from the terminal.
pub(crate) const MAX_READ_BYTES: usize = 64 * 1024;
const MAX_WRITE_BYTES: usize = 64 * 1024;

/// What the terminal did while the actor waited on it.
pub(crate) enum TerminalEvent {
    /// Output arrived; `Terminal::output` holds it.
    Read,
    /// The CLI side closed (EOF or EIO): nothing more to read.
    Closed,
    /// Queued input was written.
    Wrote,
    /// Writing failed: the terminal takes no more input.
    WriteFailed(std::io::Error),
}

/// What `Terminal::ready` waits for.
pub(crate) enum TerminalWait {
    ReadAndWrite,
    WriteOnly,
}

/// An agent's PTY master and the input waiting for it. Owned by its actor, without locks.
pub(crate) struct Terminal {
    master: Option<AsyncFd<File>>,
    read_closed: bool,
    input: VecDeque<u8>,
    sent: u64,
    last_write: Option<Instant>,
    buffer: Vec<u8>,
    received: usize,
}

impl Terminal {
    /// The terminal of `master`, read and written without blocking; none for an agent whose terminal closed.
    pub(crate) fn new(master: Option<OwnedFd>) -> anyhow::Result<Terminal> {
        let mut terminal = Self {
            master: None,
            read_closed: true,
            input: VecDeque::new(),
            sent: 0,
            last_write: None,
            buffer: Vec::new(),
            received: 0,
        };
        if let Some(master) = master {
            terminal.install(master)?;
        }
        Ok(terminal)
    }

    /// Takes a resumed run's master in place of none, without waiting or taking locks.
    pub(crate) fn install(&mut self, master: OwnedFd) -> anyhow::Result<()> {
        let file = File::from(master);
        nix::fcntl::fcntl(
            &file,
            nix::fcntl::FcntlArg::F_SETFL(nix::fcntl::OFlag::O_NONBLOCK),
        )?;
        // SAFETY: the registered File owns this descriptor until AsyncFd is dropped.
        let registered = unsafe {
            AsyncFd::register_with_interest(file, Interest::READABLE | Interest::WRITABLE)
        }?;
        self.master = Some(registered);
        self.read_closed = false;
        self.received = 0;
        Ok(())
    }

    /// Lets go of the master as a resume begins. Queued input is dropped.
    pub(crate) fn detach(&mut self) {
        self.master = None;
        self.read_closed = true;
        self.clear();
        self.buffer = Vec::new();
        self.received = 0;
    }

    /// Waits until output can be read (only with `ReadAndWrite`) or queued input can be written, and does one of them.
    /// Pending forever while there is nothing to do. Safe to cancel in `select!`; takes no locks.
    pub(crate) async fn ready(&mut self, wait: TerminalWait) -> TerminalEvent {
        let Some(master) = self.master.as_ref() else {
            return pending().await;
        };
        let read = matches!(wait, TerminalWait::ReadAndWrite) && !self.read_closed;
        if read {
            self.buffer.resize(MAX_READ_BYTES, 0);
        }
        let (head, _) = self.input.as_slices();
        let head = &head[..head.len().min(MAX_WRITE_BYTES)];
        tokio::select! {
            result = master.async_io(Interest::READABLE, |mut file| file.read(&mut self.buffer)), if read => {
                match result {
                    Ok(n) if n > 0 => {
                        self.received = n;
                        TerminalEvent::Read
                    }
                    _ => {
                        self.read_closed = true;
                        TerminalEvent::Closed
                    }
                }
            }
            result = async {
                loop {
                    let mut guard = master.writable().await?;
                    let closed = guard.ready().is_write_closed();
                    match guard.try_io(|file| file.get_ref().write(head)) {
                        Ok(result) => return result,
                        // Once the CLI side closed, Linux answers EAGAIN, not an error, and the closed
                        // state stays ready: retrying would never yield. The run's end drops the input.
                        Err(_) if closed => return pending().await,
                        Err(_) => {}
                    }
                }
            }, if !head.is_empty() => {
                match result {
                    Ok(n) => {
                        self.input.drain(..n);
                        self.sent += n as u64;
                        self.last_write = Some(Instant::now());
                        TerminalEvent::Wrote
                    }
                    Err(error) => TerminalEvent::WriteFailed(error),
                }
            }
            else => pending().await,
        }
    }

    /// One read that does not wait: how many bytes it brought, or None when nothing is there or the terminal closed.
    pub(crate) fn read_now(&mut self) -> Option<usize> {
        if self.is_closed() {
            return None;
        }
        self.buffer.resize(MAX_READ_BYTES, 0);
        let mut file = self.master.as_ref()?.get_ref();
        match file.read(&mut self.buffer) {
            Ok(n) if n > 0 => {
                self.received = n;
                Some(n)
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => None,
            _ => {
                self.read_closed = true;
                None
            }
        }
    }

    /// What the last `TerminalEvent::Read` or `read_now` brought.
    pub(crate) fn output(&self) -> &[u8] {
        &self.buffer[..self.received]
    }

    /// Whether there is a master.
    pub(crate) fn is_open(&self) -> bool {
        self.master.is_some()
    }

    /// Whether nothing more can be read: no master, or its CLI side closed.
    pub(crate) fn is_closed(&self) -> bool {
        self.read_closed
    }

    /// Queues input after what waits, without writing or waiting.
    pub(crate) fn push(&mut self, bytes: &[u8]) {
        self.input.extend(bytes);
    }

    /// Drops the queued input.
    pub(crate) fn clear(&mut self) {
        self.input.clear();
    }

    /// Bytes queued and not yet written.
    pub(crate) fn queued(&self) -> usize {
        self.input.len()
    }

    /// Bytes written since the actor started, including earlier runs.
    pub(crate) fn written(&self) -> u64 {
        self.sent
    }

    /// When input was last written.
    pub(crate) fn written_at(&self) -> Option<Instant> {
        self.last_write
    }

    /// Sets the PTY's size immediately; nothing without a master. Takes no locks.
    pub(crate) fn set_size(&self, cols: u16, rows: u16) {
        if let Some(master) = &self.master {
            let dimensions = nix::pty::Winsize {
                ws_col: cols,
                ws_row: rows,
                ws_xpixel: 0,
                ws_ypixel: 0,
            };
            nix::ioctl_write_ptr_bad!(resize, libc::TIOCSWINSZ, nix::pty::Winsize);
            // SAFETY: dimensions is a live winsize and master owns the PTY descriptor.
            let _ = unsafe { resize(master.get_ref().as_raw_fd(), &dimensions) };
        }
    }
}

/// Reads the size of a PTY immediately, if it has one. Takes no locks.
pub(crate) fn terminal_size(fd: &impl AsRawFd) -> Option<(u16, u16)> {
    let mut dimensions = nix::pty::Winsize::default();
    nix::ioctl_read_bad!(read_size, libc::TIOCGWINSZ, nix::pty::Winsize);
    // SAFETY: fd remains open during the call and dimensions is writable winsize storage.
    unsafe { read_size(fd.as_raw_fd(), &mut dimensions) }.ok()?;
    match (dimensions.ws_col, dimensions.ws_row) {
        (0, _) | (_, 0) => None,
        size => Some(size),
    }
}
