//! An agent's terminal as Facade Code Framework holds it, and the daemon's reading and writing of it.
//!
//! On Unix the terminal is a PTY master, read and written without blocking on tokio's reactor. On
//! Windows it is a pseudo console's pipes: the input pipe's write end, the output pipe's read end,
//! the signal pipe's write end, which keeps the console open while any copy of it is, and the
//! CLI's job. The daemon reads and writes every Windows terminal on one thread of its own, the
//! terminal I/O thread, around a completion port; it starts on first use.

use std::io;

#[cfg(unix)]
mod unix;
#[cfg(unix)]
use unix as imp;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as imp;

/// How many bytes a terminal takes per millisecond of a paste: the wait before a paste's Enter is
/// counted from it. A pseudo console takes a paste far slower than a PTY.
#[cfg(unix)]
pub const PASTE_BYTES_PER_MS: usize = 4_096;

/// How many bytes a terminal takes per millisecond of a paste: the wait before a paste's Enter is
/// counted from it. A pseudo console takes a paste far slower than a PTY.
#[cfg(windows)]
pub const PASTE_BYTES_PER_MS: usize = 64;

/// The side of an agent's terminal that Facade Code Framework holds. Unix: the PTY master. Windows: the input
/// pipe's write end, the output pipe's read end, the signal pipe's write end until it is let go
/// of, and the CLI's job.
#[derive(Debug)]
pub struct PtyMaster(imp::Master);

impl PtyMaster {
    /// Another copy of every part of it.
    pub fn try_clone(&self) -> io::Result<PtyMaster> {
        self.0.try_clone().map(PtyMaster)
    }

    /// Lets go of what keeps the terminal open, ahead of a stop. Windows closes this copy of the
    /// signal pipe's write end, so that the console host ends the pseudo console once every copy is
    /// closed; Unix does nothing.
    pub fn let_go_before_stop(&mut self) {
        self.0.let_go_before_stop();
    }

    /// The terminal's columns and rows: Unix the PTY's size; Windows None, as only the daemon's
    /// writes to the signal pipe set it.
    pub fn size(&self) -> Option<(u16, u16)> {
        self.0.size()
    }
}

#[cfg(unix)]
impl From<std::os::fd::OwnedFd> for PtyMaster {
    fn from(master: std::os::fd::OwnedFd) -> PtyMaster {
        PtyMaster(imp::Master::from(master))
    }
}

#[cfg(unix)]
impl From<PtyMaster> for std::os::fd::OwnedFd {
    fn from(master: PtyMaster) -> std::os::fd::OwnedFd {
        master.0.into()
    }
}

#[cfg(unix)]
impl std::os::fd::AsFd for PtyMaster {
    fn as_fd(&self) -> std::os::fd::BorrowedFd<'_> {
        self.0.as_fd()
    }
}

#[cfg(windows)]
impl PtyMaster {
    /// The terminal of these handles, which it owns from now on: for the keeper. `signal` is None
    /// where the sender had let go of its copy for a stop.
    pub fn from_handles(
        input: std::os::windows::io::OwnedHandle,
        output: std::os::windows::io::OwnedHandle,
        signal: Option<std::os::windows::io::OwnedHandle>,
        job: std::os::windows::io::OwnedHandle,
    ) -> PtyMaster {
        PtyMaster(imp::Master::from_handles(input, output, signal, job))
    }

    /// The CLI's job, for the keeper.
    pub fn job(&self) -> std::os::windows::io::BorrowedHandle<'_> {
        self.0.job()
    }

    /// Every handle of it, borrowed: for duplicating them into another process.
    pub(crate) fn handles(&self) -> imp::Handles<'_> {
        self.0.handles()
    }
}

/// One terminal that the daemon reads and writes. Needs a tokio runtime. Unix: without blocking,
/// on tokio's reactor. Windows: overlapped reads and writes on the terminal I/O thread's completion
/// port, binding the pipe ends after removing any earlier binding.
///
/// Reading and writing are independent: one read and one write may wait at once, as in one
/// `select!`, and at most one of each is under way. It is `Send` and `Sync`, so that an actor holds
/// `&PtyIo` across awaits on the multi-thread runtime.
pub struct PtyIo {
    io: imp::Io,
    master: PtyMaster,
}

impl PtyIo {
    pub fn new(master: PtyMaster) -> io::Result<PtyIo> {
        let io = imp::Io::new(&master.0)?;
        Ok(PtyIo { io, master })
    }

    /// Waits for output and reads it; `Ok(0)` once the CLI's side closed. Cancel-safe: a read under
    /// way stays under way. Bytes a read brought that `buf` cannot hold are kept and come with the
    /// next `read`, `try_read` or `stop_reading`, in order.
    pub async fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
        self.io.read(buf).await
    }

    /// Output already there, kept bytes first, without waiting; `WouldBlock` when there is none.
    pub fn try_read(&self, buf: &mut [u8]) -> io::Result<usize> {
        self.io.try_read(buf)
    }

    /// Leaves no read under way. Windows cancels the read under way, waits for it, and returns what
    /// it brought, as much as `buf` holds; Unix returns `Ok(0)` at once. Call it until it returns
    /// `Ok(0)`: then no read is under way and no byte is kept.
    pub async fn stop_reading(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.io.stop_reading(buf).await
    }

    /// Writes `bytes`, and returns how many the terminal took, counted once they are in it.
    /// Cancel-safe: a write under way stays under way; the next `write` returns its count and
    /// writes nothing else, so the caller passes the same bytes again until a write returns.
    pub async fn write(&self, bytes: &[u8]) -> io::Result<usize> {
        self.io.write(bytes).await
    }

    /// Sets the terminal's size at once: Unix `TIOCSWINSZ`; Windows the resize packet on its copy
    /// of the signal pipe. Nothing once it let go of it.
    pub fn set_size(&self, cols: u16, rows: u16) {
        self.io.set_size(&self.master.0, cols, rows);
    }

    /// As [`PtyMaster::let_go_before_stop`].
    pub fn let_go_before_stop(&mut self) {
        self.master.let_go_before_stop();
    }

    pub fn master(&self) -> &PtyMaster {
        &self.master
    }
}

/// Each character of `text` as a win32-input-mode key-down record, the form in which a Windows
/// console takes text it would otherwise split: one record for each UTF-16 unit, without releases.
/// The same on every system.
pub fn key_down_records(text: &str) -> Vec<u8> {
    let mut records = String::new();
    for unit in text.encode_utf16() {
        records.push_str(&format!("\x1b[0;0;{unit};1;0;1_"));
    }
    records.into_bytes()
}

/// A terminal whose CLI side a unit test plays: its Facade Code Framework side, and the CLI's. Unix: a PTY whose
/// sides no child inherits, its CLI side raw. Windows: pipes.
pub fn test_terminal(cols: u16, rows: u16) -> io::Result<(PtyMaster, TestCli)> {
    let (master, cli) = imp::test_terminal(cols, rows)?;
    Ok((PtyMaster(master), TestCli(cli)))
}

/// The CLI's side of a [`test_terminal`].
pub struct TestCli(imp::TestCli);

impl TestCli {
    /// Another end of the same CLI side, so that a test can read on a thread of its own.
    pub fn try_clone(&self) -> io::Result<TestCli> {
        self.0.try_clone().map(TestCli)
    }

    /// Reads what Facade Code Framework wrote to the terminal, waiting for it.
    pub fn read_input(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.0.read_input(buf)
    }

    /// Writes all of `bytes` as the CLI's output.
    pub fn write_output(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.0.write_output(bytes)
    }

    /// The terminal's columns and rows as the CLI sees them.
    pub fn size(&self) -> (u16, u16) {
        self.0.size()
    }
}
