//! Terminal I/O and the ordered input waiting to reach the CLI.

use std::collections::VecDeque;
use std::future::pending;
use std::io;

use facade_base::terminal::{PtyIo, PtyMaster};
use tokio::time::Instant;

/// The most bytes one read takes from the terminal.
pub(crate) const MAX_READ_BYTES: usize = 64 * 1024;
const MAX_WRITE_BYTES: usize = 64 * 1024;

/// What the terminal did while the actor waited on it.
pub(crate) enum TerminalEvent {
    /// Output arrived; `Terminal::output` holds it.
    Read,
    /// The CLI side closed: nothing more to read.
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

/// An agent's terminal and the input waiting for it. Owned by its actor, without locks.
pub(crate) struct Terminal {
    master: Option<PtyIo>,
    read_closed: bool,
    input: VecDeque<u8>,
    /// The bytes at the head of `input` that a write under way was given: the terminal may still
    /// take them, so they stay at the head until a write returns.
    writing: usize,
    sent: u64,
    last_write: Option<Instant>,
    buffer: Vec<u8>,
    received: usize,
}

impl Terminal {
    /// The terminal of `master`; none for an agent whose terminal closed.
    pub(crate) fn new(master: Option<PtyMaster>) -> anyhow::Result<Terminal> {
        let mut terminal = Self {
            master: None,
            read_closed: true,
            input: VecDeque::new(),
            writing: 0,
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
    pub(crate) fn install(&mut self, master: PtyMaster) -> anyhow::Result<()> {
        self.master = Some(PtyIo::new(master)?);
        self.read_closed = false;
        self.received = 0;
        Ok(())
    }

    /// Lets go of the master as a resume begins. Queued input is dropped.
    pub(crate) fn detach(&mut self) {
        self.master = None;
        self.read_closed = true;
        self.writing = 0;
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
        // A write under way is given the same bytes again until it returns.
        if self.input.as_slices().0.len() < self.writing {
            self.input.make_contiguous();
        }
        let (head, _) = self.input.as_slices();
        let head = match self.writing {
            0 => &head[..head.len().min(MAX_WRITE_BYTES)],
            writing => &head[..writing],
        };
        self.writing = head.len();
        tokio::select! {
            result = master.read(&mut self.buffer), if read => {
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
            result = master.write(head), if !head.is_empty() => {
                self.writing = 0;
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
        match self.master.as_ref()?.try_read(&mut self.buffer) {
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

    /// Leaves no read under way: how many bytes the read it ended brought, which `output` then
    /// holds, or None once no read is under way and no byte is kept, or with no master. Called
    /// until it gives None. A failure closes the read side, as a failed read does.
    pub(crate) async fn stop_reading(&mut self) -> Option<usize> {
        let master = self.master.as_mut()?;
        self.buffer.resize(MAX_READ_BYTES, 0);
        match master.stop_reading(&mut self.buffer).await {
            Ok(0) => None,
            Ok(n) => {
                self.received = n;
                Some(n)
            }
            Err(_) => {
                self.read_closed = true;
                None
            }
        }
    }

    /// Lets go of the terminal's signal pipe ahead of a stop; reading and writing go on. Nothing
    /// with no master.
    pub(crate) fn let_go_before_stop(&mut self) {
        if let Some(master) = &mut self.master {
            master.let_go_before_stop();
        }
    }

    /// What the last `TerminalEvent::Read`, `read_now` or `stop_reading` brought.
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

    /// Drops the queued input, but for what a write under way was given.
    pub(crate) fn clear(&mut self) {
        self.input.truncate(self.writing);
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

    /// Sets the terminal's size immediately; nothing without a master. Takes no locks.
    pub(crate) fn set_size(&self, cols: u16, rows: u16) {
        if let Some(master) = &self.master {
            master.set_size(cols, rows);
        }
    }
}
