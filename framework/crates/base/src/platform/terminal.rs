//! An agent's terminal as Facade holds it, and the daemon's reading and writing of it.
//!
//! On Unix the terminal is a PTY master, read and written without blocking on tokio's reactor. On
//! Windows it is a pseudo console's pipes: the input pipe's write end, the output pipe's read end,
//! the signal pipe's write end, which keeps the console open while any copy of it is, and the
//! CLI's job. The daemon reads and writes every Windows terminal on one thread of its own, the
//! terminal I/O thread, around a completion port; it starts on first use.

use std::io;
use std::sync::OnceLock;

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

/// The side of an agent's terminal that Facade holds. Unix: the PTY master. Windows: the input
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

/// An automatic write's last check and the output prefix at its first actual issue.
#[derive(Clone, Copy)]
pub struct WriteCheck<'a> {
    pub defer_for_output: bool,
    pub issued: &'a OnceLock<Option<usize>>,
    pub deadline: Option<std::time::Instant>,
}

#[derive(Clone, Copy)]
enum WriteObservation<'a> {
    Prefix(&'a OnceLock<Option<usize>>),
    Checked(WriteCheck<'a>),
}

impl WriteObservation<'_> {
    fn permits(self, before: Option<usize>) -> bool {
        match self {
            Self::Prefix(_) => true,
            Self::Checked(check) => {
                check
                    .deadline
                    .is_none_or(|at| std::time::Instant::now() < at)
                    && (!check.defer_for_output || before == Some(0))
            }
        }
    }

    fn issued(self, before: Option<usize>) {
        let output = match self {
            Self::Prefix(output) => output,
            Self::Checked(check) => check.issued,
        };
        let _ = output.set(before);
    }
}

impl PtyIo {
    pub fn new(master: PtyMaster) -> io::Result<PtyIo> {
        let io = imp::Io::new(&master.0)?;
        Ok(PtyIo { io, master })
    }

    /// Waits for output and reads it, at most as much as `buf` holds; `Ok(0)` once the CLI's side
    /// closed and all its output was read. Cancel-safe: waiting takes no output.
    pub async fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
        self.io.read(buf).await
    }

    /// Output already there, without waiting; `WouldBlock` when there is none.
    pub fn try_read(&self, buf: &mut [u8]) -> io::Result<usize> {
        self.io.try_read(buf)
    }

    /// Counts the output that reached Facade's end and has not been read: none is held where this
    /// count misses it. A closed peer can still leave bytes; `UnexpectedEof` comes once none is
    /// left.
    pub fn queued_output_bytes(&self) -> io::Result<usize> {
        self.io.queued_output_bytes()
    }

    /// Leaves no read under way. Output not read stays for the next reader. Windows cancels the
    /// wait for output and waits for that; Unix has nothing under way.
    pub async fn stop_reading(&mut self) -> io::Result<()> {
        self.io.stop_reading().await
    }

    /// Writes `bytes`, and returns how many the terminal took, counted once they are in it.
    /// Cancel-safe: a write under way stays under way; the next `write` returns its count and
    /// writes nothing else, so the caller passes the same bytes again until a write returns.
    /// Fills `before` at the issue of a new write with the readable output prefix, if it can
    /// be sampled. Collecting the result of a write under way does not fill it again.
    pub async fn write(
        &self,
        bytes: &[u8],
        before: Option<&OnceLock<Option<usize>>>,
    ) -> io::Result<usize> {
        self.io
            .write(bytes, before.map(WriteObservation::Prefix))
            .await
            .map(|result| result.expect("an unchecked write is never deferred"))
    }

    /// Checks just before issuing a new write. None means no write was attempted.
    pub async fn write_checked(
        &self,
        bytes: &[u8],
        check: WriteCheck<'_>,
    ) -> io::Result<Option<usize>> {
        self.io
            .write(bytes, Some(WriteObservation::Checked(check)))
            .await
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

/// A key with the keys held, as win32-input-mode's key records give it, `CSI Vk;Sc;Uc;Kd;Cs;1_`:
/// the form in which a Windows console takes a key, whatever the machine's keyboard layout. The
/// same on every system.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KeyRecord {
    virtual_key: u16,
    scan_code: u16,
    /// The UTF-16 unit the key gives.
    unit: u16,
    /// The control keys held, as a console key event's `dwControlKeyState` has them.
    held: u32,
}

impl KeyRecord {
    /// Shift and Enter together.
    pub const SHIFT_ENTER: KeyRecord = KeyRecord {
        virtual_key: 0x0d,
        scan_code: 0x1c,
        unit: 0x0d,
        held: 0x10,
    };

    /// A character of the text typed, as one UTF-16 unit, which no key gives.
    fn of_unit(unit: u16) -> KeyRecord {
        KeyRecord {
            virtual_key: 0,
            scan_code: 0,
            unit,
            held: 0,
        }
    }

    /// Appends the key going down.
    pub fn write_down(self, bytes: &mut Vec<u8>) {
        self.write(true, bytes);
    }

    /// Appends the key going down and then up, as a key pressed. A console merges a key-down into
    /// the same key-down before it, unread, so two presses of a key in a row need the key-up between.
    pub fn write_press(self, bytes: &mut Vec<u8>) {
        self.write(true, bytes);
        self.write(false, bytes);
    }

    /// How many bytes [`KeyRecord::write_press`] appends.
    pub fn press_len(self) -> usize {
        2 * self.record_len()
    }

    /// How many bytes one record of the key takes, going down or up alike.
    fn record_len(self) -> usize {
        let digits = |number: u32| number.checked_ilog10().map_or(1, |log| log as usize + 1);
        let Self {
            virtual_key,
            scan_code,
            unit,
            held,
        } = self;
        // `ESC [`, the five semicolons, the down digit, and `1_`.
        10 + digits(virtual_key.into())
            + digits(scan_code.into())
            + digits(unit.into())
            + digits(held)
    }

    fn write(self, down: bool, bytes: &mut Vec<u8>) {
        let Self {
            virtual_key,
            scan_code,
            unit,
            held,
        } = self;
        let down = u8::from(down);
        bytes
            .extend(format!("\x1b[{virtual_key};{scan_code};{unit};{down};{held};1_").into_bytes());
    }
}

/// Each character of `text` as key-down records, the form in which a Windows console takes text it
/// would otherwise split: one record for each UTF-16 unit, without releases. The same on every
/// system.
pub fn key_down_records(text: &str) -> Vec<u8> {
    let mut records = Vec::new();
    for unit in text.encode_utf16() {
        KeyRecord::of_unit(unit).write_down(&mut records);
    }
    records
}

/// How many bytes [`key_down_records`] gives for `text`, without making them.
pub fn key_down_records_len(text: &str) -> usize {
    text.encode_utf16()
        .map(|unit| KeyRecord::of_unit(unit).record_len())
        .sum()
}

/// A terminal whose CLI side a unit test plays: its Facade side, and the CLI's. Unix: a PTY whose
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

    /// Reads what Facade wrote to the terminal, waiting for it.
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Output that reached Facade's end of the pipe counts as ready, including bytes that a read
    /// under way has taken but not yet reported. Windows only: the CLI's write returns once its
    /// bytes are there, so the count can be checked right after it.
    #[cfg(windows)]
    #[test]
    fn ready_output_includes_bytes_a_read_under_way_has_taken() {
        let (master, mut cli) = test_terminal(80, 24).unwrap();
        let pty = PtyIo::new(master).unwrap();
        let chunk = b"earlier redraw";
        let mut buf = [0u8; 64];
        for round in 0..200 {
            // Nothing is there yet, so this attempt leaves a read under way.
            let waiting = pty.try_read(&mut buf).unwrap_err();
            assert_eq!(waiting.kind(), io::ErrorKind::WouldBlock);
            cli.write_output(chunk).unwrap();
            assert_eq!(
                pty.queued_output_bytes().unwrap(),
                chunk.len(),
                "round {round}"
            );
            let mut read = 0;
            while read < chunk.len() {
                match pty.try_read(&mut buf) {
                    Ok(n) => read += n,
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        std::thread::yield_now()
                    }
                    Err(error) => panic!("{error}"),
                }
            }
            assert_eq!(read, chunk.len());
        }
    }

    /// Reads `count` bytes as they come, without waiting on a runtime.
    #[cfg(windows)]
    fn read_exactly(pty: &PtyIo, count: usize) -> Vec<u8> {
        let mut read = Vec::new();
        let mut buf = [0u8; 64];
        while read.len() < count {
            match pty.try_read(&mut buf) {
                Ok(0) => panic!("the output ended after {} bytes", read.len()),
                Ok(n) => read.extend_from_slice(&buf[..n]),
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => std::thread::yield_now(),
                Err(error) => panic!("{error}"),
            }
        }
        read
    }

    /// Output the CLI wrote before its side closed is all read, and only then does the output end.
    #[cfg(windows)]
    #[test]
    fn output_written_before_the_cli_closed_is_read_before_the_end() {
        let (master, mut cli) = test_terminal(80, 24).unwrap();
        let pty = PtyIo::new(master).unwrap();
        let mut buf = [0u8; 4];
        let waiting = pty.try_read(&mut buf).unwrap_err();
        assert_eq!(waiting.kind(), io::ErrorKind::WouldBlock);
        cli.write_output(b"last words").unwrap();
        drop(cli);
        assert_eq!(pty.queued_output_bytes().unwrap(), 10);
        let mut read = Vec::new();
        loop {
            match pty.try_read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    read.extend_from_slice(&buf[..n]);
                    if read.len() < 10 {
                        assert_eq!(pty.queued_output_bytes().unwrap(), 10 - read.len());
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => std::thread::yield_now(),
                Err(error) => panic!("{error}"),
            }
        }
        assert_eq!(read, b"last words");
        assert_eq!(
            pty.queued_output_bytes().unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
        assert_eq!(pty.try_read(&mut buf).unwrap(), 0, "the end stays the end");
    }

    /// A caller that takes fewer bytes than wait leaves the rest counted.
    #[cfg(windows)]
    #[test]
    fn output_a_small_buffer_leaves_stays_counted() {
        let (master, mut cli) = test_terminal(80, 24).unwrap();
        let pty = PtyIo::new(master).unwrap();
        let mut small = [0u8; 4];
        let waiting = pty.try_read(&mut small).unwrap_err();
        assert_eq!(waiting.kind(), io::ErrorKind::WouldBlock);
        cli.write_output(b"earlier redraw").unwrap();
        assert_eq!(pty.try_read(&mut small).unwrap(), 4);
        assert_eq!(&small, b"earl");
        assert_eq!(pty.queued_output_bytes().unwrap(), 10);
        assert_eq!(read_exactly(&pty, 10), b"ier redraw");
        assert_eq!(pty.queued_output_bytes().unwrap(), 0);
    }

    /// A reader that stops while it waits for output hands every later byte, once, to the next.
    #[cfg(windows)]
    #[tokio::test]
    async fn output_after_a_stopped_reader_goes_to_the_next_once() {
        let (master, mut cli) = test_terminal(80, 24).unwrap();
        let next = master.try_clone().unwrap();
        let mut first = PtyIo::new(master).unwrap();
        cli.write_output(b"read ").unwrap();
        assert_eq!(read_exactly(&first, 5), b"read ");
        let mut buf = [0u8; 64];
        let waiting = first.try_read(&mut buf).unwrap_err();
        assert_eq!(waiting.kind(), io::ErrorKind::WouldBlock);
        cli.write_output(b"handed over").unwrap();
        first.stop_reading().await.unwrap();
        assert_eq!(first.queued_output_bytes().unwrap(), 11);
        drop(first);

        let second = PtyIo::new(next).unwrap();
        assert_eq!(second.queued_output_bytes().unwrap(), 11);
        assert_eq!(read_exactly(&second, 11), b"handed over");
        let waiting = second.try_read(&mut buf).unwrap_err();
        assert_eq!(
            waiting.kind(),
            io::ErrorKind::WouldBlock,
            "nothing comes twice"
        );
    }

    #[test]
    fn a_key_record_names_the_key_its_character_the_keys_held_and_whether_it_goes_down() {
        let mut down = Vec::new();
        KeyRecord::SHIFT_ENTER.write_down(&mut down);
        assert_eq!(down, b"\x1b[13;28;13;1;16;1_");
        let mut press = Vec::new();
        KeyRecord::SHIFT_ENTER.write_press(&mut press);
        assert_eq!(press, b"\x1b[13;28;13;1;16;1_\x1b[13;28;13;0;16;1_");
    }

    #[test]
    fn each_utf_16_unit_of_a_text_is_a_key_down_record_of_no_key() {
        assert_eq!(
            key_down_records("a📨"),
            b"\x1b[0;0;97;1;0;1_\x1b[0;0;55357;1;0;1_\x1b[0;0;56552;1;0;1_"
        );
    }

    #[test]
    fn the_length_of_records_is_counted_without_making_them() {
        for text in [
            "",
            "a",
            "\t",
            "é",
            "€",
            "a📨",
            "😀😀",
            "\u{ffff}\u{10000}\u{10ffff}",
        ] {
            assert_eq!(
                key_down_records_len(text),
                key_down_records(text).len(),
                "{text:?}"
            );
        }
        let held = KeyRecord {
            virtual_key: 0xffff,
            scan_code: 1,
            unit: 0,
            held: u32::MAX,
        };
        for key in [KeyRecord::SHIFT_ENTER, held] {
            let mut press = Vec::new();
            key.write_press(&mut press);
            assert_eq!(key.press_len(), press.len(), "{key:?}");
        }
    }
}
