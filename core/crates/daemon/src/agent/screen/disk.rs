//! File publication: sync contents, replace current, sync the folder, then reclaim old files.
use std::collections::BTreeSet;
use std::fs::File;
use std::io::{self, Write};
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use facade_base::files::create_private_file;

use super::codec::{Checkpoint, LOG_HEADER, LOG_HEADER_REQUIRES_OWN_CHECKPOINT};
use super::warn;

pub(super) struct Generations {
    pub(super) numbers: BTreeSet<u64>,
    pub(super) current: Option<u64>,
}
impl Generations {
    pub(super) fn scan(folder: &Path) -> io::Result<Self> {
        let mut found = BTreeSet::new();
        for entry in std::fs::read_dir(folder)? {
            let entry = entry?;
            let filename = entry.file_name();
            let text = filename.to_string_lossy();
            let stem = text
                .strip_suffix(".checkpoint")
                .or_else(|| text.strip_suffix(".log"));
            if let Some(number) = stem.and_then(|s| s.parse::<u64>().ok()) {
                found.insert(number);
            }
        }
        let published = published_generation(folder)?;
        Ok(Self {
            current: published,
            numbers: found,
        })
    }
    pub(super) fn last(&self) -> u64 {
        self.current
            .into_iter()
            .chain(self.numbers.last().copied())
            .max()
            .unwrap_or_default()
    }
}

pub(super) fn published_generation(folder: &Path) -> io::Result<Option<u64>> {
    match std::fs::read_to_string(folder.join("current")) {
        Ok(contents) => contents
            .trim()
            .parse::<u64>()
            .map(Some)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}
pub(super) fn checkpoint_path(folder: &Path, number: u64) -> PathBuf {
    folder.join(format!("{number}.checkpoint"))
}
pub(super) fn log_path(folder: &Path, number: u64) -> PathBuf {
    folder.join(format!("{number}.log"))
}

pub(super) fn create_agent_dir(folder: &Path) -> io::Result<()> {
    let private = |path: &Path| match std::fs::DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
        }
        Err(e) => Err(e),
    };
    if let Some(parent) = folder.parent() {
        private(parent)?;
    }
    private(folder)
}
pub(super) fn sync_dir(folder: &Path) -> io::Result<()> {
    File::open(folder)?.sync_all()
}
pub(super) fn write_checkpoint(
    folder: &Path,
    number: u64,
    captured: &Checkpoint,
) -> io::Result<()> {
    write_synced(&checkpoint_path(folder, number), &captured.encode())
}
pub(super) fn write_synced(path: &Path, data: &[u8]) -> io::Result<()> {
    let mut output = create_private_file(path)?;
    output.write_all(data)?;
    output.sync_all()
}
pub(super) fn create_log(folder: &Path, number: u64, own: bool) -> io::Result<(File, u64)> {
    let header = if own {
        LOG_HEADER_REQUIRES_OWN_CHECKPOINT
    } else {
        LOG_HEADER
    };
    let mut output = create_private_file(&log_path(folder, number))?;
    output.write_all(header)?;
    Ok((output, header.len() as u64))
}

/// Publication succeeded; records whether syncing the folder allowed old files to be reclaimed.
#[derive(Debug)]
pub(crate) enum Cleanup {
    Done,
    FolderNotSynced(io::Error),
}
pub(super) fn publish(folder: &Path, number: u64, fallback: u64) -> io::Result<Cleanup> {
    let next = folder.join("current.next");
    write_synced(&next, format!("{number}\n").as_bytes())?;
    std::fs::rename(next, folder.join("current"))?;
    Ok(clean_up(folder, number, fallback))
}
pub(super) fn clean_up(folder: &Path, number: u64, fallback: u64) -> Cleanup {
    match sync_dir(folder) {
        Err(e) => Cleanup::FolderNotSynced(e),
        Ok(()) => {
            let deletion = Generations::scan(folder)
                .and_then(|all| delete_generations(folder, all.numbers.range(..fallback)));
            if let Err(e) = deletion {
                warn(&format!(
                    "checkpoint {number} in {} is published, but older screen files could not all be deleted: {e}; a later publication or recovery retries cleanup",
                    folder.display()
                ));
            }
            Cleanup::Done
        }
    }
}
pub(super) fn remove_file(path: &Path) -> io::Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}
pub(super) fn delete_generations<'a>(
    folder: &Path,
    numbers: impl Iterator<Item = &'a u64>,
) -> io::Result<()> {
    let mut failure = Ok(());
    for &number in numbers {
        for file in [checkpoint_path(folder, number), log_path(folder, number)] {
            let attempt = remove_file(&file);
            if failure.is_ok() {
                failure = attempt;
            }
        }
    }
    failure
}

pub(super) struct CheckpointJob {
    pub(super) dir: PathBuf,
    pub(super) generation: u64,
    pub(super) checkpoint: Arc<Checkpoint>,
    pub(super) keep_from: u64,
}
impl CheckpointJob {
    pub(super) fn run(self) -> io::Result<Cleanup> {
        write_checkpoint(&self.dir, self.generation, self.checkpoint.as_ref())?;
        publish(&self.dir, self.generation, self.keep_from)
    }
}
