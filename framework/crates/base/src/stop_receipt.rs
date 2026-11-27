//! A Keeper's durable acceptance of a creator stop, tied to the exact CLI process.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use crate::files;
use crate::process::ProcessIdentity;

fn receipt_path(framework: &Path, agent: &str) -> io::Result<PathBuf> {
    if !files::valid_folder_name(agent) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid agent ID",
        ));
    }
    Ok(framework.join("runs").join(agent).join("creator-stop"))
}

/// Commits the acceptance before the Keeper begins stopping this process. A partial write is
/// never read as a receipt, and the agent's run folders retire it on resume or removal.
pub fn record(framework: &Path, agent: &str, process: &ProcessIdentity) -> io::Result<()> {
    let path = receipt_path(framework, agent)?;
    let folder = path.parent().expect("the receipt is in the run folder");
    files::create_private_folder_all(folder)?;
    let pending = path.with_extension("pending");
    let mut file = files::create_private_file(&pending)?;
    serde_json::to_writer(&mut file, process)?;
    file.flush()?;
    file.sync_all()?;
    drop(file);
    fs::rename(pending, &path)?;
    // Once published, the receipt counts as an accepted stop even if syncing the folder fails.
    if let Err(error) = files::sync_folder(folder) {
        crate::log::write(
            "keeper",
            "warn",
            &format!("could not sync the creator stop of {agent}: {error}"),
        );
    }
    Ok(())
}

/// Whether the Keeper accepted a creator stop for this exact process.
pub fn exists(framework: &Path, agent: &str, process: &ProcessIdentity) -> io::Result<bool> {
    match fs::read(receipt_path(framework, agent)?) {
        Ok(record) => Ok(serde_json::from_slice::<ProcessIdentity>(&record)? == *process),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}
