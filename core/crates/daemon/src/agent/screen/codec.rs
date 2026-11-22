//! The checkpoint and record formats shared by append and replay.
use std::fs::File;
use std::io::{self, BufRead, BufReader, Read};
use std::path::Path;

use facade_screen::Screen;
use sha2::{Digest, Sha256};

use super::{MAX_FEED_BYTES, SCROLLBACK_ROWS};

pub(super) const LOG_HEADER: &[u8] = b"facade screen log\n";
pub(super) const LOG_HEADER_REQUIRES_OWN_CHECKPOINT: &[u8] =
    b"facade screen log requires-own-checkpoint\n";
pub(super) const SYNC_END_RECORD: &[u8] = b"sync_end\n";
const CHECKPOINT_HEADER: &[u8] = b"facade screen checkpoint\n";
pub(super) const MAX_RECORD_BYTES: u64 = MAX_FEED_BYTES as u64 + 32;

/// A redraw and the dimensions needed to replay it; capture does no disk I/O.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Checkpoint {
    cols: u16,
    rows: u16,
    pub(super) title: Option<String>,
    redraw: Vec<u8>,
}

impl Checkpoint {
    /// Captures the retained scrollback and active screen without taking a lock.
    pub(crate) fn capture(screen: &Screen) -> Checkpoint {
        Self::capture_with_title(screen, None)
    }

    pub(super) fn capture_with_title(screen: &Screen, title: Option<&str>) -> Checkpoint {
        Self {
            redraw: screen.redraw_with_all_scrollback(),
            cols: screen.cols(),
            rows: screen.rows(),
            title: title.map(str::to_owned),
        }
    }

    pub(super) fn restore(&self) -> Screen {
        let mut restored = Screen::new(self.cols, self.rows, SCROLLBACK_ROWS);
        restored.feed(self.redraw.as_slice());
        if let Some(title) = self.title.as_deref() {
            restored.restore_title(title);
        }
        restored
    }

    pub(super) fn size(&self) -> (u16, u16) {
        (self.cols, self.rows)
    }

    pub(super) fn encode(&self) -> Vec<u8> {
        let title = self.title.as_deref().unwrap_or_default();
        let mut data = format!(
            "facade screen checkpoint\nsize {} {}\ntitle {}\n",
            self.cols,
            self.rows,
            title.len()
        )
        .into_bytes();
        data.extend_from_slice(title.as_bytes());
        write!(&mut data, "\nredraw {}\n", self.redraw.len())
            .expect("writing to a vector cannot fail");
        data.extend(&self.redraw);
        let digest = checksum(&data);
        write!(&mut data, "\nchecksum {digest}\n").expect("writing to a vector cannot fail");
        data
    }

    pub(super) fn decode(data: &[u8]) -> Option<Self> {
        let mut cursor = SliceCursor {
            remaining: data.strip_prefix(CHECKPOINT_HEADER)?,
        };
        let dimensions = cursor.line()?.strip_prefix("size ")?;
        let (width, height) = dimensions.split_once(' ')?;
        let size = (width.parse().ok()?, height.parse().ok()?);
        let title = std::str::from_utf8(cursor.field("title")?).ok()?;
        let drawing = cursor.field("redraw")?.to_vec();
        let digest_end = data.len().checked_sub(cursor.remaining.len() + 1)?;
        let expected = cursor.line()?.strip_prefix("checksum ")?;
        (cursor.remaining.is_empty() && checksum(&data[..digest_end]) == expected).then_some(Self {
            cols: size.0,
            rows: size.1,
            title: (!title.is_empty()).then(|| title.to_owned()),
            redraw: drawing,
        })
    }
}

use std::io::Write;
fn checksum(data: &[u8]) -> String {
    use std::fmt::Write;
    let mut result = String::new();
    for byte in Sha256::digest(data) {
        write!(result, "{byte:02x}").unwrap();
    }
    result
}

struct SliceCursor<'a> {
    remaining: &'a [u8],
}
impl<'a> SliceCursor<'a> {
    fn line(&mut self) -> Option<&'a str> {
        let n = self.remaining.iter().position(|c| *c == b'\n')?;
        let (text, tail) = self.remaining.split_at(n);
        self.remaining = &tail[1..];
        std::str::from_utf8(text).ok()
    }
    fn field(&mut self, key: &str) -> Option<&'a [u8]> {
        let n: usize = self
            .line()?
            .strip_prefix(key)?
            .strip_prefix(' ')?
            .parse()
            .ok()?;
        let value = self.remaining.get(..n)?;
        let tail = self.remaining.get(n..)?.strip_prefix(b"\n")?;
        self.remaining = tail;
        Some(value)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum LogRecord {
    Output(Vec<u8>),
    Resize(u16, u16),
    SyncEnd,
}
impl LogRecord {
    pub(super) fn apply(self, screen: &mut Screen) -> Option<String> {
        match self {
            Self::Resize(width, height) => {
                screen.resize(width, height);
                None
            }
            Self::Output(data) => screen.feed(&data).title_change,
            Self::SyncEnd => screen.end_synchronized_update().title_change,
        }
    }
}

pub(super) fn output_record(bytes: &[u8]) -> Vec<u8> {
    let mut framed = format!("output {}\n", bytes.len()).into_bytes();
    framed.extend(bytes);
    framed.push(b'\n');
    framed
}
pub(super) fn resize_record(cols: u16, rows: u16) -> Vec<u8> {
    format!("resize {cols} {rows}\n").into_bytes()
}

pub(super) type OpenLog<'a> = &'a dyn Fn(&Path) -> io::Result<Box<dyn Read>>;
pub(super) fn open_log_file(path: &Path) -> io::Result<Box<dyn Read>> {
    File::open(path).map(|file| Box::new(file) as Box<dyn Read>)
}
pub(super) enum LogReadError {
    Damaged,
    Io(io::Error),
}
pub(super) struct LogReader {
    input: BufReader<Box<dyn Read>>,
    pub(super) offset: u64,
    pub(super) requires_own_checkpoint: bool,
}
impl LogReader {
    pub(super) fn open(path: &Path, opener: OpenLog<'_>) -> io::Result<Option<Self>> {
        let source = match opener(path) {
            Ok(source) => source,
            Err(e) => {
                return if e.kind() == io::ErrorKind::NotFound {
                    Ok(None)
                } else {
                    Err(e)
                };
            }
        };
        let mut input = BufReader::new(source);
        let mut header = Vec::new();
        input.by_ref().take(64).read_until(b'\n', &mut header)?;
        let own = if header == LOG_HEADER {
            false
        } else if header == LOG_HEADER_REQUIRES_OWN_CHECKPOINT {
            true
        } else {
            return Ok(None);
        };
        Ok(Some(Self {
            offset: header.len() as u64,
            input,
            requires_own_checkpoint: own,
        }))
    }

    pub(super) fn next_record(&mut self) -> Result<Option<LogRecord>, LogReadError> {
        use LogReadError::{Damaged, Io};
        let mut line = Vec::new();
        let count = self
            .input
            .by_ref()
            .take(32)
            .read_until(b'\n', &mut line)
            .map_err(Io)?;
        if count == 0 {
            return Ok(None);
        }
        let mut size = count as u64;
        let record = if line == SYNC_END_RECORD {
            LogRecord::SyncEnd
        } else {
            let text = std::str::from_utf8(&line)
                .ok()
                .and_then(|s| s.strip_suffix('\n'))
                .ok_or(Damaged)?;
            if let Some(length) = text.strip_prefix("output ") {
                let n: u64 = length.parse().map_err(|_| Damaged)?;
                if n > MAX_RECORD_BYTES || n + size >= MAX_RECORD_BYTES {
                    return Err(Damaged);
                }
                let mut payload = vec![0; n as usize + 1];
                self.input.read_exact(&mut payload).map_err(|e| {
                    if e.kind() == io::ErrorKind::UnexpectedEof {
                        Damaged
                    } else {
                        Io(e)
                    }
                })?;
                if payload.pop() != Some(b'\n') {
                    return Err(Damaged);
                }
                size += n + 1;
                LogRecord::Output(payload)
            } else {
                let (x, y) = text
                    .strip_prefix("resize ")
                    .and_then(|s| s.split_once(' '))
                    .ok_or(Damaged)?;
                LogRecord::Resize(
                    x.parse().map_err(|_| Damaged)?,
                    y.parse().map_err(|_| Damaged)?,
                )
            }
        };
        self.offset += size;
        Ok(Some(record))
    }
}
