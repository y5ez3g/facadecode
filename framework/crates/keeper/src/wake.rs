//! The single blocking call in the keeper: one `poll` over the descriptors the loop cares about,
//! with signals turned into readable pipes so they wake the same call.

use std::io::{self, Read};
use std::os::fd::{AsFd, BorrowedFd};
use std::time::Instant;

use nix::errno::Errno;
use nix::fcntl::{FcntlArg, OFlag, fcntl};
use nix::poll::{PollFd, PollFlags, PollTimeout, poll};
use signal_hook::consts::{SIGCHLD, SIGINT, SIGTERM};

/// The self-pipes the signal handlers write into.
pub(super) struct Wake {
    sigchld: io::PipeReader,
    shutdown: io::PipeReader,
}

/// Why `poll` returned.
#[derive(Default)]
pub(super) struct Woken {
    /// SIGTERM or SIGINT arrived.
    pub(super) shutdown: bool,
    /// SIGCHLD arrived: at least one child may have exited.
    pub(super) sigchld: bool,
    /// Positions, in the slice given to [`Wake::wait`], of descriptors that are readable or hung up.
    pub(super) ready: Vec<usize>,
}

impl Wake {
    /// Installs the handlers for SIGCHLD, SIGTERM and SIGINT. Each handler only writes one byte
    /// to its pipe; the loop does the rest.
    pub(super) fn install() -> io::Result<Wake> {
        let (sigchld, sigchld_tx) = io::pipe()?;
        let (shutdown, shutdown_tx) = io::pipe()?;
        set_nonblocking(sigchld.as_fd())?;
        set_nonblocking(sigchld_tx.as_fd())?;
        set_nonblocking(shutdown.as_fd())?;
        set_nonblocking(shutdown_tx.as_fd())?;
        signal_hook::low_level::pipe::register(SIGINT, shutdown_tx.try_clone()?)?;
        signal_hook::low_level::pipe::register(SIGTERM, shutdown_tx)?;
        signal_hook::low_level::pipe::register(SIGCHLD, sigchld_tx)?;
        Ok(Wake { sigchld, shutdown })
    }

    /// Sleeps in `poll` until one of `fds` or a signal pipe is ready, or `deadline` passes. A
    /// signal that interrupts `poll` itself shows up as an empty [`Woken`]; its byte is still in
    /// the pipe for the next call.
    pub(super) fn wait(
        &mut self,
        fds: &[BorrowedFd<'_>],
        deadline: Option<Instant>,
    ) -> io::Result<Woken> {
        let mut polled = Vec::with_capacity(fds.len() + 2);
        polled.push(PollFd::new(self.sigchld.as_fd(), PollFlags::POLLIN));
        polled.push(PollFd::new(self.shutdown.as_fd(), PollFlags::POLLIN));
        polled.extend(fds.iter().map(|fd| PollFd::new(*fd, PollFlags::POLLIN)));
        if let Err(errno) = poll(&mut polled, poll_timeout(deadline)) {
            return match errno {
                Errno::EINTR => Ok(Woken::default()),
                other => Err(other.into()),
            };
        }
        let fired = |slot: &PollFd<'_>| slot.revents().is_some_and(|got| !got.is_empty());
        let mut woken = Woken {
            sigchld: fired(&polled[0]),
            shutdown: fired(&polled[1]),
            ready: Vec::new(),
        };
        for (position, slot) in polled[2..].iter().enumerate() {
            if fired(slot) {
                woken.ready.push(position);
            }
        }
        if woken.sigchld {
            discard(&mut self.sigchld);
        }
        if woken.shutdown {
            discard(&mut self.shutdown);
        }
        Ok(woken)
    }
}

/// Milliseconds until `deadline`, rounded up: rounding down would wake the loop a moment early
/// and make it spin until the deadline really passes.
fn poll_timeout(deadline: Option<Instant>) -> PollTimeout {
    match deadline {
        None => PollTimeout::NONE,
        Some(deadline) => {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let ms = remaining.as_nanos().div_ceil(1_000_000);
            PollTimeout::try_from(i32::try_from(ms).unwrap_or(i32::MAX)).unwrap_or(PollTimeout::MAX)
        }
    }
}

fn set_nonblocking(fd: BorrowedFd<'_>) -> io::Result<()> {
    let current = OFlag::from_bits_retain(fcntl(fd, FcntlArg::F_GETFL)?);
    fcntl(fd, FcntlArg::F_SETFL(current | OFlag::O_NONBLOCK))?;
    Ok(())
}

/// Drains a self-pipe so it stays quiet until the next signal.
fn discard(pipe: &mut io::PipeReader) {
    let mut sink = [0u8; 32];
    loop {
        match pipe.read(&mut sink) {
            Ok(n) if n > 0 => continue,
            _ => break,
        }
    }
}
