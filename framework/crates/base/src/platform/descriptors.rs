//! Protocol lines that carry file descriptors over a Unix socket (`SCM_RIGHTS`), as the keeper
//! protocol passes PTYs.
//!
//! A line's descriptors are attached to its first byte. One read brings the descriptors of at most
//! one send: Linux ends the read at that send, macOS starts a read with it. So the descriptors of a
//! read belong to a line that began in that read, and once a line begins after it, whatever no line
//! took is closed.
//!
//! Received descriptors are close-on-exec before any child can start: atomically on Linux, and
//! elsewhere under [`super::unix_process::FORK_LOCK`].

use std::{
    collections::VecDeque,
    io::{self, IoSlice},
    ops::Range,
    os::fd::{AsRawFd, BorrowedFd, FromRawFd, OwnedFd, RawFd},
    os::unix::net::UnixStream,
    time::Instant,
};

use nix::errno::Errno;
use nix::sys::socket::{ControlMessage, MsgFlags, UnixAddr, sendmsg};

use crate::line::MAX_LINE_BYTES;

/// The most descriptors one read can bring: Linux's `SCM_MAX_FD` (include/net/scm.h).
#[cfg(target_os = "linux")]
const MAX_FDS_PER_READ: usize = 253;
/// The most descriptors one read can bring: XNU's `UIPC_MAX_CMSG_FD` bounds a rights mbuf
/// (bsd/kern/uipc_usrreq.c). A 64-bit send carries at most 254, but the buffer is sized for the
/// kernel's bound, so `recvmsg` reports every descriptor it installed and each can be closed.
#[cfg(target_os = "macos")]
const MAX_FDS_PER_READ: usize = 512;

/// How a read takes descriptors: close-on-exec at once where the system can, and elsewhere without
/// waiting, as the fork lock is held.
#[cfg(target_os = "linux")]
const RECEIVE_FLAGS: libc::c_int = libc::MSG_CMSG_CLOEXEC;
#[cfg(not(target_os = "linux"))]
const RECEIVE_FLAGS: libc::c_int = libc::MSG_DONTWAIT;

/// The bytes read from the socket at a time.
const CHUNK_BYTES: usize = 64 * 1024;

/// Writes all of `line`, with `fds` attached to its first byte. On a non-blocking socket without
/// room, waits for room until `deadline`; past it, the line is cut short and the error is
/// `TimedOut`, and the caller must give up the connection.
pub fn send_line(
    socket: BorrowedFd<'_>,
    line: &[u8],
    fds: &[BorrowedFd<'_>],
    deadline: Option<Instant>,
) -> io::Result<()> {
    let fds: Vec<RawFd> = fds.iter().map(AsRawFd::as_raw_fd).collect();
    let rights = [ControlMessage::ScmRights(&fds)];
    let mut sent = 0;
    while sent < line.len() {
        let attach = sent == 0 && !fds.is_empty();
        let control: &[ControlMessage] = if attach { &rights } else { &[] };
        let rest = [IoSlice::new(&line[sent..])];
        match sendmsg::<UnixAddr>(socket.as_raw_fd(), &rest, control, MsgFlags::empty(), None) {
            Ok(written) => sent += written,
            Err(Errno::EINTR) => {}
            Err(Errno::EAGAIN) => wait_writable(socket, deadline)?,
            Err(err) => return Err(err.into()),
        }
    }
    Ok(())
}

/// Waits until `socket` has room; past `deadline`, `TimedOut`.
fn wait_writable(socket: BorrowedFd<'_>, deadline: Option<Instant>) -> io::Result<()> {
    loop {
        let timeout = match deadline {
            None => -1,
            Some(deadline) => {
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "the peer read nothing in time",
                    ));
                }
                left.as_millis().clamp(1, i32::MAX as u128) as i32
            }
        };
        if poll(socket.as_raw_fd(), libc::POLLOUT, timeout)? {
            return Ok(());
        }
    }
}

/// Polls `fd` for `events` up to `timeout` milliseconds, -1 for no limit, through interruptions.
/// Returns whether it became ready.
fn poll(fd: RawFd, events: libc::c_short, timeout: libc::c_int) -> io::Result<bool> {
    let mut poll = libc::pollfd {
        fd,
        events,
        revents: 0,
    };
    loop {
        // SAFETY: one valid pollfd for the duration of the call.
        match unsafe { libc::poll(&mut poll, 1, timeout) } {
            -1 if Errno::last() == Errno::EINTR => {}
            -1 => return Err(io::Error::last_os_error()),
            ready => return Ok(ready > 0),
        }
    }
}

/// The descriptors one read brought.
struct Received {
    /// The stream offsets the read spans.
    span: Range<u64>,
    chunk: Chunk,
}

/// One read from the socket: the bytes it brought, and its descriptors.
struct Chunk {
    read: usize,
    fds: Vec<OwnedFd>,
    /// The kernel dropped descriptors that did not fit.
    truncated: bool,
}

/// Reads lines, and the descriptors that came with each.
pub struct DescriptorLines {
    stream: UnixStream,
    /// A read with nothing to read is `WouldBlock`.
    nonblocking: bool,
    /// The buffer each read fills.
    buffer: Vec<u8>,
    /// Bytes read and not yet given out as a line, and the stream offset of the first.
    pending: Vec<u8>,
    pending_at: u64,
    /// The reads that brought descriptors no line took yet, oldest first.
    reads: VecDeque<Received>,
    at_end: bool,
}

impl DescriptorLines {
    pub fn new(stream: UnixStream) -> Self {
        DescriptorLines {
            stream,
            nonblocking: false,
            buffer: vec![0; CHUNK_BYTES],
            pending: Vec::new(),
            pending_at: 0,
            reads: VecDeque::new(),
            at_end: false,
        }
    }

    /// Reads from `stream`, made non-blocking: [`DescriptorLines::next_line`] then fails with
    /// `WouldBlock` while no whole line has come, and keeps what came of the next one.
    pub fn nonblocking(stream: UnixStream) -> io::Result<Self> {
        stream.set_nonblocking(true)?;
        Ok(DescriptorLines {
            nonblocking: true,
            ..DescriptorLines::new(stream)
        })
    }

    /// The next line without its newline, with the stream offset it began at, for
    /// [`DescriptorLines::take`]; None at the stream's end. A line longer than [`MAX_LINE_BYTES`]
    /// is an `InvalidData` error. A line's descriptors must be taken before the next line is read,
    /// which may close them.
    pub fn next_line(&mut self) -> io::Result<Option<(u64, Vec<u8>)>> {
        while !self.pending.contains(&b'\n') {
            let too_long = self.pending.len() >= MAX_LINE_BYTES;
            if too_long {
                let why = "a line exceeds the protocol limit";
                return Err(io::Error::new(io::ErrorKind::InvalidData, why));
            }
            if self.at_end {
                return Ok(None);
            }
            self.read_chunk()?;
        }
        let newline = self.pending.iter().position(|&byte| byte == b'\n');
        Ok(newline.map(|newline| self.split_line(newline)))
    }

    /// Gives out the line that ends at `newline` in `data`, and closes the descriptors of reads that
    /// ended before it began: they belonged to earlier lines that did not take them.
    fn split_line(&mut self, newline: usize) -> (u64, Vec<u8>) {
        let begin = self.pending_at;
        let mut line: Vec<u8> = self.pending.drain(..=newline).collect();
        self.pending_at += line.len() as u64;
        line.pop();
        self.reads.retain(|read| read.span.end > begin);
        (begin, line)
    }

    /// Reads one chunk into `data`, keeping its descriptors with the offsets it spans.
    fn read_chunk(&mut self) -> io::Result<()> {
        let chunk = receive(
            &self.stream,
            &mut self.buffer,
            MAX_FDS_PER_READ,
            self.nonblocking,
        )?;
        let start = self.pending_at + self.pending.len() as u64;
        self.pending.extend_from_slice(&self.buffer[..chunk.read]);
        self.at_end = chunk.read == 0;
        if chunk.truncated || !chunk.fds.is_empty() {
            let span = start..start + chunk.read as u64;
            self.reads.push_back(Received { span, chunk });
        }
        Ok(())
    }

    /// Takes the `count` descriptors of the line that began at `begin`: those of the read its first
    /// byte came in. Where that read brought another count, or the kernel dropped some, they are
    /// closed and the error is the count that came. A line that expects none takes none.
    pub fn take(&mut self, begin: u64, count: usize) -> Result<Vec<OwnedFd>, usize> {
        let began_in_first = self
            .reads
            .front()
            .is_some_and(|read| read.span.contains(&begin));
        let Some(Received { chunk, .. }) = began_in_first.then(|| self.reads.pop_front()).flatten()
        else {
            return if count == 0 { Ok(Vec::new()) } else { Err(0) };
        };
        match chunk.fds.len() {
            came if came == count && !chunk.truncated => Ok(chunk.fds),
            came => Err(came),
        }
    }

    /// The descriptors that the line spanning `begin..end`, its newline included, carries, for a
    /// reader that does not know which lines carry some: empty for a line that carries none. A
    /// read's descriptors came with the send that ends it on Linux and with the send that starts
    /// it on macOS, so they are the last line's that begins in that read on Linux, and on macOS
    /// the line's that begins with it. Where the kernel dropped some, those that came are closed
    /// and the error is their count.
    pub fn take_carried(&mut self, begin: u64, end: u64) -> Result<Vec<OwnedFd>, usize> {
        let Some(read) = self.reads.front() else {
            return Ok(Vec::new());
        };
        #[cfg(target_os = "linux")]
        let carries = read.span.contains(&begin) && end >= read.span.end;
        #[cfg(not(target_os = "linux"))]
        let carries = {
            let _ = end;
            read.span.start == begin
        };
        if !carries {
            return Ok(Vec::new());
        }
        match self.reads.pop_front() {
            Some(Received { chunk, .. }) if !chunk.truncated => Ok(chunk.fds),
            Some(Received { chunk, .. }) => Err(chunk.fds.len()),
            None => Ok(Vec::new()),
        }
    }
}

/// Reads one chunk and up to `most` descriptors with it, which are close-on-exec when it returns,
/// and whether the kernel dropped some that did not fit.
fn receive(
    stream: &UnixStream,
    chunk: &mut [u8],
    most: usize,
    nonblocking: bool,
) -> io::Result<Chunk> {
    // SAFETY: CMSG_SPACE computes a size from a length.
    let space = unsafe { libc::CMSG_SPACE((most * size_of::<RawFd>()) as u32) } as usize;
    // u64 elements keep the buffer aligned for cmsghdr.
    let mut control = vec![0u64; space.div_ceil(8)];
    loop {
        // Elsewhere than Linux, receipt cannot make the descriptors close-on-exec atomically: it
        // holds the fork lock until they are, and waits for data before taking it.
        #[cfg(not(target_os = "linux"))]
        let _forks = {
            if !nonblocking {
                poll(stream.as_raw_fd(), libc::POLLIN, -1)?;
            }
            super::unix_process::fork_lock()
        };
        let mut data = libc::iovec {
            iov_len: chunk.len(),
            iov_base: chunk.as_mut_ptr().cast(),
        };
        // SAFETY: an all-zero msghdr is valid; the fields set below point at buffers that outlive
        // the call.
        let mut header: libc::msghdr = unsafe { std::mem::zeroed() };
        (header.msg_control, header.msg_controllen) = (control.as_mut_ptr().cast(), space as _);
        (header.msg_iov, header.msg_iovlen) = (&mut data, 1);
        // SAFETY: recvmsg writes within the buffers `header` describes.
        let read = unsafe { libc::recvmsg(stream.as_raw_fd(), &mut header, RECEIVE_FLAGS) };
        if read < 0 {
            match Errno::last() {
                Errno::EAGAIN if nonblocking => return Err(Errno::EAGAIN.into()),
                Errno::EINTR | Errno::EAGAIN => continue,
                err => return Err(err.into()),
            }
        }
        #[cfg(not(target_os = "linux"))]
        super::service::gate_for_test("after-rights-receipt");
        // SAFETY: recvmsg filled `header`'s control buffer and reported its length.
        let fds = unsafe { rights_in(&header) };
        #[cfg(not(target_os = "linux"))]
        for fd in &fds {
            nix::fcntl::fcntl(
                fd,
                nix::fcntl::FcntlArg::F_SETFD(nix::fcntl::FdFlag::FD_CLOEXEC),
            )?;
        }
        return Ok(Chunk {
            read: read as usize,
            fds,
            truncated: header.msg_flags & libc::MSG_CTRUNC != 0,
        });
    }
}

/// Takes ownership of the descriptors in the `SCM_RIGHTS` messages of `header`'s control buffer.
///
/// # Safety
///
/// `recvmsg` must just have filled the control buffer and set its length in `header`.
unsafe fn rights_in(header: &libc::msghdr) -> Vec<OwnedFd> {
    let mut fds = Vec::new();
    // `msg_controllen` is a `usize` on Linux and a `u32` on macOS.
    #[cfg_attr(target_os = "linux", expect(clippy::unnecessary_cast))]
    let filled_end = header.msg_control as usize + header.msg_controllen as usize;
    // SAFETY: the caller's promise: the CMSG macros walk within what recvmsg filled.
    unsafe {
        let mut message = libc::CMSG_FIRSTHDR(header);
        while !message.is_null() {
            if (*message).cmsg_level == libc::SOL_SOCKET && (*message).cmsg_type == libc::SCM_RIGHTS
            {
                let data = libc::CMSG_DATA(message);
                // A truncated message may claim more than the buffer holds: only those in it count.
                let claimed =
                    ((*message).cmsg_len as usize).saturating_sub(libc::CMSG_LEN(0) as usize);
                let count =
                    claimed.min(filled_end.saturating_sub(data as usize)) / size_of::<RawFd>();
                for at in 0..count {
                    let fd = std::ptr::read_unaligned(data.cast::<RawFd>().add(at));
                    // The kernel just installed it for this process; nothing else owns it.
                    fds.push(OwnedFd::from_raw_fd(fd));
                }
            }
            message = libc::CMSG_NXTHDR(header, message);
        }
    }
    fds
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::os::fd::AsFd;

    use super::*;

    /// Reads each line with the descriptors its `fds` field asks for, or the count that came if
    /// they were refused.
    fn taken(lines: &mut DescriptorLines) -> Vec<(String, Result<usize, usize>)> {
        let mut taken = Vec::new();
        while let Some((begin, line)) = lines.next_line().unwrap() {
            let count = serde_json::from_slice::<serde_json::Value>(&line)
                .ok()
                .and_then(|line| line["fds"].as_u64())
                .unwrap_or(0) as usize;
            let took = if count > 0 {
                lines.take(begin, count).map(|fds| fds.len())
            } else {
                Ok(0)
            };
            taken.push((String::from_utf8(line).unwrap(), took));
        }
        taken
    }

    #[test]
    fn descriptors_go_with_the_line_they_came_with() {
        let (ours, theirs) = UnixStream::pair().unwrap();
        let (one, two) = (std::io::pipe().unwrap(), std::io::pipe().unwrap());
        // A plain line; one with one descriptor; one with two; one sent in two writes, its
        // descriptor with its first part; and a line with one followed by a plain line in the same
        // send, which macOS reads as one.
        send_line(theirs.as_fd(), b"{\"plain\":1}\n", &[], None).unwrap();
        send_line(theirs.as_fd(), b"{\"fds\":1}\n", &[one.0.as_fd()], None).unwrap();
        send_line(
            theirs.as_fd(),
            b"{\"fds\":2}\n",
            &[one.1.as_fd(), two.0.as_fd()],
            None,
        )
        .unwrap();
        send_line(theirs.as_fd(), b"{\"fds\":", &[two.1.as_fd()], None).unwrap();
        send_line(theirs.as_fd(), b"1,\"split\":true}\n", &[], None).unwrap();
        send_line(
            theirs.as_fd(),
            b"{\"fds\":1,\"op\":\"run.add\"}\n{\"op\":\"run.attach\"}\n",
            &[one.0.as_fd()],
            None,
        )
        .unwrap();
        send_line(
            theirs.as_fd(),
            b"{\"fds\":2,\"came\":1}\n",
            &[two.0.as_fd()],
            None,
        )
        .unwrap();
        drop(theirs);
        let mut lines = DescriptorLines::new(ours);
        let line = |text: &str, took: Result<usize, usize>| (text.to_string(), took);
        assert_eq!(
            taken(&mut lines),
            [
                line("{\"plain\":1}", Ok(0)),
                line("{\"fds\":1}", Ok(1)),
                line("{\"fds\":2}", Ok(2)),
                line("{\"fds\":1,\"split\":true}", Ok(1)),
                line("{\"fds\":1,\"op\":\"run.add\"}", Ok(1)),
                line("{\"op\":\"run.attach\"}", Ok(0)),
                line("{\"fds\":2,\"came\":1}", Err(1)),
            ]
        );
    }

    /// A line that claims a descriptor began in a read that brought none; the descriptor of a later
    /// read belongs to the line that began in that read. The reads are recorded by hand: on Linux
    /// the kernel can join both into one read, which would give the descriptor to the first line
    /// instead, also within the rule.
    #[test]
    fn a_line_that_began_before_the_read_bringing_descriptors_does_not_take_them() {
        let (ours, _theirs) = UnixStream::pair().unwrap();
        let mut lines = DescriptorLines::new(ours);
        let text = b"{\"fds\":1,\"early\":1}\n{\"fds\":1,\"late\":1}\n";
        lines.pending.extend_from_slice(text);
        lines.at_end = true;
        // The first read brought 17 bytes and nothing else; the second brought the rest and one
        // descriptor.
        let (descriptor, _) = std::io::pipe().unwrap();
        lines.reads.push_back(Received {
            span: 17..text.len() as u64,
            chunk: Chunk {
                read: text.len() - 17,
                fds: vec![OwnedFd::from(descriptor)],
                truncated: false,
            },
        });
        let (early, _) = lines.next_line().unwrap().expect("the early line");
        assert_eq!(
            lines.take(early, 1).map(|fds| fds.len()),
            Err(0),
            "the early line began before the descriptor's read"
        );
        let (late, _) = lines.next_line().unwrap().expect("the late line");
        assert_eq!(
            lines.take(late, 1).map(|fds| fds.len()),
            Ok(1),
            "the late line began in it"
        );
    }

    #[test]
    fn descriptors_no_line_took_are_closed_and_never_pass_to_another() {
        let (ours, theirs) = UnixStream::pair().unwrap();
        let (refused_read, mut refused_write) = std::io::pipe().unwrap();
        let (meant_read, mut meant_write) = std::io::pipe().unwrap();
        // A refused line, which takes none of its descriptor, with a plain line in the same read;
        // then a line with its own.
        send_line(
            theirs.as_fd(),
            b"{\"refused\":1}\n{\"plain\":1}\n",
            &[refused_read.as_fd()],
            None,
        )
        .unwrap();
        send_line(
            theirs.as_fd(),
            b"{\"fds\":1}\n",
            &[meant_read.as_fd()],
            None,
        )
        .unwrap();
        drop(theirs);
        drop(refused_read);
        let mut lines = DescriptorLines::new(ours);
        lines.next_line().unwrap().expect("the refused line");
        lines.next_line().unwrap().expect("the plain line");
        assert!(
            refused_write.write_all(b"x").is_ok(),
            "kept while a line of its read may still take it"
        );
        let (meant, _) = lines.next_line().unwrap().expect("the line with its own");
        // A concurrent fork can temporarily hold a close-on-exec pipe end until exec finishes.
        let until = std::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            if refused_write
                .write_all(b"x")
                .is_err_and(|err| err.kind() == io::ErrorKind::BrokenPipe)
            {
                break;
            }
            assert!(
                std::time::Instant::now() < until,
                "closed once a line began after its read"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let fds = lines.take(meant, 1).expect("its own descriptor");
        meant_write.write_all(b"y").unwrap();
        assert!(
            poll(fds[0].as_raw_fd(), libc::POLLIN, 2_000).unwrap(),
            "the descriptor that came with this line, not the refused one's"
        );
        let flags = nix::fcntl::fcntl(&fds[0], nix::fcntl::FcntlArg::F_GETFD).unwrap();
        assert!(
            nix::fcntl::FdFlag::from_bits_truncate(flags).contains(nix::fcntl::FdFlag::FD_CLOEXEC),
            "received descriptors are close-on-exec"
        );
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn descriptors_cut_off_by_a_small_read_are_closed_and_reported() {
        let (ours, theirs) = UnixStream::pair().unwrap();
        let pipes: Vec<_> = (0..3).map(|_| std::io::pipe().unwrap()).collect();
        let raw: Vec<BorrowedFd<'_>> = pipes.iter().map(|(read, _)| read.as_fd()).collect();
        send_line(theirs.as_fd(), b"{\"fds\":3}\n", &raw, None).unwrap();
        let mut chunk = [0u8; 64];
        let received = receive(&ours, &mut chunk, 1, false).unwrap();
        assert_eq!(
            (received.read, received.truncated),
            (10, true),
            "the kernel reports the cut"
        );
        assert!(
            received.fds.len() <= 3,
            "the descriptors that arrived are owned, so they close"
        );
    }

    #[test]
    fn maximum_and_extra_rights_are_all_owned_and_closed() {
        if std::env::var_os("FACADE_RIGHTS_TEST_CHILD").is_none() {
            let result = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "platform::descriptors::tests::maximum_and_extra_rights_are_all_owned_and_closed",
                    "--exact",
                    "--test-threads=1",
                ])
                .env("FACADE_RIGHTS_TEST_CHILD", "1")
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stdout)
            );
            return;
        }
        #[cfg(target_os = "macos")]
        let maximum = 254;
        #[cfg(target_os = "linux")]
        let maximum = 253;
        let count = || {
            std::fs::read_dir(if cfg!(target_os = "linux") {
                "/proc/self/fd"
            } else {
                "/dev/fd"
            })
            .unwrap()
            .count()
        };
        for sent in [2, maximum] {
            let (ours, theirs) = UnixStream::pair().unwrap();
            let (read, _write) = std::io::pipe().unwrap();
            let before = count();
            send_line(theirs.as_fd(), b"x\n", &vec![read.as_fd(); sent], None).unwrap();
            let mut lines = DescriptorLines::new(ours);
            let (at, _) = lines.next_line().unwrap().unwrap();
            assert_eq!(lines.take(at, 1).map(|fds| fds.len()), Err(sent));
            assert_eq!(
                count(),
                before,
                "every installed descriptor is closed, even when unexpected"
            );
        }
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn a_fork_during_rights_receipt_waits_until_close_on_exec_is_set() {
        use std::os::unix::fs::MetadataExt;
        use std::time::{Duration, Instant};
        const TEST: &str = "platform::descriptors::tests::\
                            a_fork_during_rights_receipt_waits_until_close_on_exec_is_set";
        if let Some(sentinel) = std::env::var_os("FACADE_FORK_PROBE") {
            let metadata = std::fs::metadata(sentinel).unwrap();
            for fd in 3..1024 {
                // SAFETY: every field in stat admits a zero representation.
                let mut stat: libc::stat = unsafe { std::mem::zeroed() };
                // SAFETY: fstat writes to a valid stat buffer and safely fails for a closed
                // descriptor.
                if unsafe { libc::fstat(fd, &mut stat) } == 0 {
                    assert_ne!(
                        (stat.st_dev as u64, stat.st_ino),
                        (metadata.dev(), metadata.ino()),
                        "a child inherited a received descriptor"
                    );
                }
            }
            return;
        }
        if std::env::var_os("FACADE_FORK_RECEIVER").is_none() {
            let home = crate::test_folder::TestFolder::new("rights-fork");
            std::fs::create_dir_all(home.join("framework")).unwrap();
            let result = std::process::Command::new(std::env::current_exe().unwrap())
                .args([TEST, "--exact", "--test-threads=1"])
                .env("FACADE_FORK_RECEIVER", "1")
                .env("FACADE_HOME", &*home)
                .env("FACADE_TEST_GATES", "after-rights-receipt")
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "{}{}",
                String::from_utf8_lossy(&result.stdout),
                String::from_utf8_lossy(&result.stderr)
            );
            return;
        }
        let framework = crate::paths::framework_dir().unwrap();
        let sentinel = framework.join("sentinel");
        let file = std::fs::File::create(&sentinel).unwrap();
        let (ours, theirs) = UnixStream::pair().unwrap();
        send_line(theirs.as_fd(), b"x\n", &[file.as_fd()], None).unwrap();
        let receiver = std::thread::spawn(move || {
            let mut lines = DescriptorLines::new(ours);
            let (at, _) = lines.next_line().unwrap().unwrap();
            lines.take(at, 1).unwrap()
        });
        let until = Instant::now() + Duration::from_secs(5);
        while !framework.join("reached-after-rights-receipt").exists() {
            assert!(Instant::now() < until, "receipt must reach its boundary");
            std::thread::sleep(Duration::from_millis(10));
        }
        let (starting, arrived) = std::sync::mpsc::channel();
        let fork = std::thread::spawn(move || {
            starting.send(()).unwrap();
            let _forks = super::super::unix_process::fork_lock();
            std::process::Command::new(std::env::current_exe().unwrap())
                .args([TEST, "--exact", "--test-threads=1"])
                .env("FACADE_FORK_PROBE", sentinel)
                .output()
                .unwrap()
        });
        arrived.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(
            super::super::unix_process::FORK_LOCK.try_lock().is_err(),
            "receipt must exclude a concurrent spawn"
        );
        std::fs::write(framework.join("release-after-rights-receipt"), "").unwrap();
        let received = receiver.join().unwrap();
        let result = fork.join().unwrap();
        assert!(
            result.status.success(),
            "{}{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        assert_eq!(received.len(), 1);
    }
}
