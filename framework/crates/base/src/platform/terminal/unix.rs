//! A PTY master.

use std::fs::File;
use std::io::{self, Read, Write};
use std::os::fd::{AsFd, AsRawFd, BorrowedFd, OwnedFd};

use nix::fcntl::{FcntlArg, OFlag};
use tokio::io::Interest;
use tokio::io::unix::AsyncFd;

/// The PTY master.
#[derive(Debug)]
pub(super) struct Master(OwnedFd);

impl Master {
    pub(super) fn try_clone(&self) -> io::Result<Master> {
        self.0.try_clone().map(Master)
    }

    pub(super) fn let_go_before_stop(&mut self) {}

    pub(super) fn size(&self) -> Option<(u16, u16)> {
        size_of_terminal(self.0.as_fd())
    }
}

impl From<OwnedFd> for Master {
    fn from(master: OwnedFd) -> Master {
        Master(master)
    }
}

impl From<Master> for OwnedFd {
    fn from(master: Master) -> OwnedFd {
        master.0
    }
}

impl AsFd for Master {
    fn as_fd(&self) -> BorrowedFd<'_> {
        self.0.as_fd()
    }
}

/// The size of the terminal `fd`, where it has one.
fn size_of_terminal(fd: BorrowedFd<'_>) -> Option<(u16, u16)> {
    let mut dimensions = nix::pty::Winsize::default();
    nix::ioctl_read_bad!(read_size, libc::TIOCGWINSZ, nix::pty::Winsize);
    // SAFETY: fd stays open during the call and dimensions is writable winsize storage.
    unsafe { read_size(fd.as_raw_fd(), &mut dimensions) }.ok()?;
    match (dimensions.ws_col, dimensions.ws_row) {
        (0, _) | (_, 0) => None,
        size => Some(size),
    }
}

/// Sets the size of the terminal `fd`.
fn set_size_of_terminal(fd: BorrowedFd<'_>, cols: u16, rows: u16) -> io::Result<()> {
    let dimensions = nix::pty::Winsize {
        ws_col: cols,
        ws_row: rows,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    nix::ioctl_write_ptr_bad!(resize, libc::TIOCSWINSZ, nix::pty::Winsize);
    // SAFETY: dimensions is a live winsize and fd stays open during the call.
    unsafe { resize(fd.as_raw_fd(), &dimensions) }?;
    Ok(())
}

/// How long a write waits after the terminal took nothing before it tries again.
const FULL_WAIT: std::time::Duration = std::time::Duration::from_millis(5);

/// A copy of the master's descriptor, nonblocking, on tokio's reactor.
pub(super) struct Io(AsyncFd<File>);

/// A master reads EIO once the CLI's side closed: that is the end of its output.
fn end_of_output(read: io::Result<usize>) -> io::Result<usize> {
    match read {
        Err(error) if error.raw_os_error() == Some(libc::EIO) => Ok(0),
        read => read,
    }
}

impl Io {
    pub(super) fn new(master: &Master) -> io::Result<Io> {
        let file = File::from(master.0.try_clone()?);
        nix::fcntl::fcntl(&file, FcntlArg::F_SETFL(OFlag::O_NONBLOCK))?;
        let interest = Interest::READABLE | Interest::WRITABLE;
        // SAFETY: the File is owned by the AsyncFd, so it stays open, and the same descriptor, for
        // as long as it is registered.
        let registered = unsafe { AsyncFd::register_with_interest(file, interest) };
        registered.map(Io).map_err(io::Error::from)
    }

    pub(super) async fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
        loop {
            let mut ready = self.0.readable().await?;
            match ready.try_io(|file| end_of_output(file.get_ref().read(buf))) {
                Ok(read) => return read,
                Err(_would_block) => continue,
            }
        }
    }

    pub(super) fn try_read(&self, buf: &mut [u8]) -> io::Result<usize> {
        end_of_output(self.0.get_ref().read(buf))
    }

    pub(super) async fn stop_reading(&mut self, _buf: &mut [u8]) -> io::Result<usize> {
        Ok(0)
    }

    pub(super) async fn write(&self, bytes: &[u8]) -> io::Result<usize> {
        loop {
            let mut ready = self.0.writable().await?;
            match ready.try_io(|file| file.get_ref().write(bytes)) {
                Ok(written) => return written,
                // A full PTY master can go on reporting writable while a write would block, as
                // Linux 7.0's does: wait a moment before trying again rather than spin.
                Err(_would_block) => tokio::time::sleep(FULL_WAIT).await,
            }
        }
    }

    pub(super) fn set_size(&self, _master: &Master, cols: u16, rows: u16) {
        let _ = set_size_of_terminal(self.0.get_ref().as_fd(), cols, rows);
    }
}

/// A PTY whose sides are closed on exec from the moment they open, so that no child process
/// another test starts meanwhile holds one and keeps the terminal open.
pub(super) fn test_terminal(cols: u16, rows: u16) -> io::Result<(Master, TestCli)> {
    // ptsname names the CLI side in a buffer of its own, which a call on another thread could
    // overwrite meanwhile.
    static NAMING: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let master = nix::pty::posix_openpt(OFlag::O_RDWR | OFlag::O_NOCTTY | OFlag::O_CLOEXEC)?;
    nix::pty::grantpt(&master)?;
    nix::pty::unlockpt(&master)?;
    let name = {
        let _naming = NAMING
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // SAFETY: the name is copied out of ptsname's buffer before another call, which the lock
        // keeps out.
        unsafe { nix::pty::ptsname(&master) }?
    };
    let cli = nix::fcntl::open(
        name.as_str(),
        OFlag::O_RDWR | OFlag::O_NOCTTY | OFlag::O_CLOEXEC,
        nix::sys::stat::Mode::empty(),
    )?;
    set_size_of_terminal(cli.as_fd(), cols, rows)?;
    // Raw, as a CLI sets its terminal: bytes pass as they are, without waiting for a newline,
    // echoing or turning \r into \n.
    let mut modes = nix::sys::termios::tcgetattr(&cli)?;
    nix::sys::termios::cfmakeraw(&mut modes);
    nix::sys::termios::tcsetattr(&cli, nix::sys::termios::SetArg::TCSANOW, &modes)?;
    let master = OwnedFd::from(master);
    Ok((Master(master), TestCli(File::from(cli))))
}

/// The CLI side of a test PTY.
pub(super) struct TestCli(File);

impl TestCli {
    pub(super) fn try_clone(&self) -> io::Result<TestCli> {
        self.0.try_clone().map(TestCli)
    }

    pub(super) fn read_input(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.0.read(buf)
    }

    pub(super) fn write_output(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.0.write_all(bytes)
    }

    pub(super) fn size(&self) -> (u16, u16) {
        size_of_terminal(self.0.as_fd()).unwrap_or((0, 0))
    }
}
