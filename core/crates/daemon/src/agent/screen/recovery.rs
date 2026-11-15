//! Reconstruct a screen without overwriting a chain until its replacement is published.
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;

use facade_screen::Screen;

use super::codec::*;
use super::disk::*;
use super::{
    FALLBACK_SIZE, MAX_LOG_BYTES, SCROLLBACK_ROWS, ScreenLog, forced_checkpoint_losses, warn,
};

/// The recovered screen and its append log. An unreadable chain is preserved with no log.
pub(crate) struct RecoveredScreen {
    pub(crate) screen: Screen,
    pub(crate) log: Option<ScreenLog>,
}

/// Reads an ended screen without modifying checkpoint or log contents; blocks and takes no lock.
pub(crate) fn load(dir: &Path, agent_id: &str) -> io::Result<Screen> {
    read_saved(dir, agent_id, None, &|| {}, &open_log_file, false).map(|saved| saved.screen)
}

/// Replays and publishes a combined generation for future appends; blocks and takes no lock.
pub(crate) fn recover(
    dir: &Path,
    agent_id: &str,
    terminal_size: Option<(u16, u16)>,
    progress: &dyn Fn(),
) -> RecoveredScreen {
    recover_with(dir, agent_id, terminal_size, progress, &open_log_file)
}

/// Replays after clean handover and continues its log when whole; blocks and takes no lock.
pub(crate) fn recover_after_clean_end(
    dir: &Path,
    agent_id: &str,
    terminal_size: Option<(u16, u16)>,
    progress: &dyn Fn(),
) -> RecoveredScreen {
    let saved = read_saved(
        dir,
        agent_id,
        terminal_size,
        progress,
        &open_log_file,
        false,
    );
    match saved {
        Ok(saved) => {
            if let Some(log) = saved.continue_log(dir, agent_id) {
                RecoveredScreen {
                    log: Some(log),
                    screen: saved.screen,
                }
            } else {
                saved.fold(dir, agent_id)
            }
        }
        Err(e) => unreadable(agent_id, terminal_size, e),
    }
}

/// Reads the final size from the usable record chain, without feeding output to an engine.
/// This blocks on disk and takes no lock.
pub(crate) fn saved_size(dir: &Path) -> (u16, u16) {
    let base = Generations::scan(dir).and_then(|found| choose_checkpoint(dir, &found));
    let Ok(Some((number, captured, _))) = base else {
        return FALLBACK_SIZE;
    };
    let mut dimensions = captured.size();
    let mut next = number;
    while let Ok(Some(mut reader)) = LogReader::open(&log_path(dir, next), &open_log_file) {
        if next > number && reader.requires_own_checkpoint {
            break;
        }
        let complete = loop {
            match reader.next_record() {
                Ok(None) => break true,
                Err(_) => break false,
                Ok(Some(LogRecord::Resize(x, y))) => dimensions = (x, y),
                Ok(Some(_)) => (),
            }
        };
        if !complete {
            break;
        }
        next += 1;
    }
    (dimensions.0.max(2), dimensions.1.max(1))
}

pub(super) fn recover_with(
    dir: &Path,
    id: &str,
    size: Option<(u16, u16)>,
    progress: &dyn Fn(),
    opener: OpenLog<'_>,
) -> RecoveredScreen {
    match read_saved(dir, id, size, progress, opener, true) {
        Err(e) => unreadable(id, size, e),
        Ok(saved) => saved.fold(dir, id),
    }
}
fn empty(size: Option<(u16, u16)>) -> Screen {
    let dimensions = size.unwrap_or(FALLBACK_SIZE);
    Screen::new(dimensions.0, dimensions.1, SCROLLBACK_ROWS)
}
fn unreadable(id: &str, size: Option<(u16, u16)>, failure: io::Error) -> RecoveredScreen {
    warn(&format!(
        "could not read the screen files of {id}: {failure}; its screen starts empty, and its output is not saved until Facade restarts"
    ));
    RecoveredScreen {
        screen: empty(size),
        log: None,
    }
}

fn choose_checkpoint(
    dir: &Path,
    inventory: &Generations,
) -> io::Result<Option<(u64, Checkpoint, Vec<u8>)>> {
    let Some(current) = inventory.current else {
        return Ok(None);
    };
    for &number in inventory.numbers.range(..=current).rev() {
        match std::fs::read(checkpoint_path(dir, number)) {
            Ok(bytes) => {
                if let Some(captured) = Checkpoint::decode(&bytes) {
                    return Ok(Some((number, captured, bytes)));
                }
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => (),
            Err(e) => return Err(e),
        }
    }
    Ok(None)
}

#[derive(Copy, Clone, PartialEq, Eq)]
struct Position {
    generation: u64,
    offset: u64,
}
struct Extent {
    generation: u64,
    start: u64,
    end: u64,
}
struct Forced {
    at: Position,
    data: Vec<u8>,
    losses: Vec<&'static str>,
}
struct Replay {
    screen: Screen,
    extents: Vec<Extent>,
    clean: Option<Position>,
    forced: Option<Forced>,
    end: Position,
}
impl Replay {
    fn walk(
        dir: &Path,
        generation: u64,
        captured: &Checkpoint,
        stop: Option<Position>,
        progress: &dyn Fn(),
        opener: OpenLog<'_>,
    ) -> io::Result<Self> {
        let screen = captured.restore();
        let start = Position {
            generation,
            offset: 0,
        };
        let mut replay = Self {
            clean: screen.at_clean_point().then_some(start),
            screen,
            extents: Vec::new(),
            forced: None,
            end: start,
        };
        let mut number = generation;
        let mut bytes = 0;
        let header = LOG_HEADER_REQUIRES_OWN_CHECKPOINT.len() as u64;
        let mut tail = header;
        while let Some(mut reader) = LogReader::open(&log_path(dir, number), opener)? {
            if number != generation && reader.requires_own_checkpoint {
                break;
            }
            let start = reader.offset;
            let complete = loop {
                if stop == Some(replay.end) {
                    break false;
                }
                let previous = reader.offset;
                let record = match reader.next_record() {
                    Err(LogReadError::Io(e)) => return Err(e),
                    Err(LogReadError::Damaged) => break false,
                    Ok(None) => break true,
                    Ok(Some(record)) => record,
                };
                let length = reader.offset - previous;
                let step = 4 * 1024 * 1024;
                if (bytes + length) / step != bytes / step {
                    progress();
                }
                bytes += length;
                record.apply(&mut replay.screen);
                replay.end = Position {
                    generation: number,
                    offset: reader.offset,
                };
                tail += length;
                if replay.screen.at_clean_point() {
                    replay.clean = Some(replay.end);
                    replay.forced = None;
                    tail = header;
                } else if stop.is_none() && tail + MAX_RECORD_BYTES > MAX_LOG_BYTES {
                    replay.forced = Some(Forced {
                        at: replay.end,
                        data: Checkpoint::capture(&replay.screen).encode(),
                        losses: forced_checkpoint_losses(&replay.screen),
                    });
                    tail = header;
                }
            };
            replay.extents.push(Extent {
                generation: number,
                start,
                end: reader.offset,
            });
            if !complete {
                break;
            }
            number += 1;
        }
        Ok(replay)
    }
}

struct Saved {
    inventory: Generations,
    base: Option<u64>,
    last: Option<u64>,
    screen: Screen,
    checkpoint: Vec<u8>,
    from: Position,
    logs: Vec<Extent>,
    synced: Option<io::Result<()>>,
}
fn read_saved(
    dir: &Path,
    id: &str,
    size: Option<(u16, u16)>,
    progress: &dyn Fn(),
    opener: OpenLog<'_>,
    sync: bool,
) -> io::Result<Saved> {
    create_agent_dir(dir)?;
    let inventory = Generations::scan(dir)?;
    let base = choose_checkpoint(dir, &inventory)?;
    let synced = if sync { Some(sync_dir(dir)) } else { None };
    let Some((number, captured, bytes)) = base else {
        if !inventory.numbers.is_empty() {
            warn(&format!(
                "no valid screen checkpoint for {id}; its screen starts empty"
            ));
        }
        let screen = empty(size);
        let checkpoint = Checkpoint::capture(&screen).encode();
        let from = Position {
            generation: inventory.last() + 1,
            offset: 0,
        };
        return Ok(Saved {
            screen,
            checkpoint,
            from,
            inventory,
            base: None,
            last: None,
            logs: Vec::new(),
            synced,
        });
    };
    if Some(number) != inventory.current {
        warn(&format!(
            "the published checkpoint of {id} is damaged; recovering from checkpoint {number}"
        ));
    }
    let complete = Replay::walk(dir, number, &captured, None, progress, opener)?;
    let last = complete
        .extents
        .last()
        .map_or(number, |extent| extent.generation);
    let initial = Position {
        generation: number,
        offset: 0,
    };
    let (checkpoint, from) = if let Some(forced) = complete.forced {
        warn(&format!(
            "the screen log of {id} holds more than {} MiB after its last clean point; recovery checkpoints where the records reach that size, so a later recovery loses {}",
            MAX_LOG_BYTES / (1024 * 1024),
            forced.losses.join(" and ")
        ));
        (forced.data, forced.at)
    } else if let Some(clean) = complete.clean {
        if clean == complete.end {
            (Checkpoint::capture(&complete.screen).encode(), clean)
        } else if clean == initial {
            (bytes, initial)
        } else {
            let prefix = Replay::walk(dir, number, &captured, Some(clean), progress, opener)?;
            (Checkpoint::capture(&prefix.screen).encode(), clean)
        }
    } else {
        (bytes, initial)
    };
    Ok(Saved {
        inventory,
        base: Some(number),
        last: Some(last),
        screen: complete.screen,
        checkpoint,
        from,
        logs: complete.extents,
        synced,
    })
}
impl Saved {
    fn continue_log(&self, dir: &Path, id: &str) -> Option<ScreenLog> {
        let base = self.base?;
        let extent = self.logs.last()?;
        if self.inventory.current != Some(base)
            || self.last != Some(base)
            || self.inventory.last() != base
            || extent.generation != base
        {
            return None;
        }
        let file = OpenOptions::new()
            .append(true)
            .open(log_path(dir, base))
            .ok()?;
        let length = file.metadata().ok()?.len();
        if length != extent.end {
            return None;
        }
        let mut log = ScreenLog::open(dir.into(), id, base, Some(file), length);
        log.output_since_capture = extent.end - extent.start;
        Some(log)
    }
    fn fold(mut self, dir: &Path, id: &str) -> RecoveredScreen {
        let next = self.inventory.last() + 1;
        let synchronized = self.synced.take().unwrap_or_else(|| sync_dir(dir));
        if let Some(last) = self.last {
            let _ = delete_generations(dir, self.inventory.numbers.range(last + 1..));
        }
        if synchronized.is_ok()
            && let Some(base) = self.base
            && let Err(e) = delete_generations(dir, self.inventory.numbers.range(..base))
        {
            warn(&format!(
                "could not delete all screen files of {id} before checkpoint {base}: {e}"
            ));
        }
        let writing = synchronized.and_then(|()| self.write_fold(dir, next));
        let log = match writing {
            Ok((file, bytes, cleanup)) => {
                let mut log = ScreenLog::open(dir.into(), id, next, Some(file), bytes);
                log.cleaned_up(next, cleanup);
                log
            }
            Err(e) => {
                let _ = remove_file(&checkpoint_path(dir, next));
                let _ = remove_file(&log_path(dir, next));
                let mut log = ScreenLog::open(dir.into(), id, next - 1, None, 0);
                log.published = self.base.unwrap_or_default();
                log.cleanup_after_sync = Some(log.published);
                log.log_failure(&format!(
                    "could not write combined checkpoint {next} and its screen log: {e}"
                ));
                log
            }
        };
        RecoveredScreen {
            screen: self.screen,
            log: Some(log),
        }
    }
    fn write_fold(&self, dir: &Path, next: u64) -> io::Result<(File, u64, Cleanup)> {
        write_synced(&checkpoint_path(dir, next), &self.checkpoint)?;
        let (mut output, mut length) = create_log(dir, next, true)?;
        for extent in &self.logs {
            if extent.generation < self.from.generation {
                continue;
            }
            let start = if extent.generation == self.from.generation {
                extent.start.max(self.from.offset)
            } else {
                extent.start
            };
            if extent.end <= start {
                continue;
            }
            let mut source = File::open(log_path(dir, extent.generation))?;
            source.seek(SeekFrom::Start(start))?;
            length += io::copy(&mut source.take(extent.end - start), &mut output)?;
        }
        output.sync_all()?;
        let cleanup = publish(dir, next, next)?;
        Ok((output, length, cleanup))
    }
}
