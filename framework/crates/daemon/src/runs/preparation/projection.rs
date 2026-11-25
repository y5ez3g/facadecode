//! One provider-owned workspace configuration projected from a run's private folder.

use std::fs;
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const NOTE: &str = "workspace-file.json";

#[derive(Clone)]
pub(super) struct Projection {
    pub(super) workspace: PathBuf,
    pub(super) relative: PathBuf,
    pub(super) contents: String,
}

#[derive(Deserialize, Serialize)]
struct Note {
    workspace: PathBuf,
    relative: PathBuf,
    digest: Vec<u8>,
    bytes: u64,
}

impl Projection {
    pub(super) fn create(&self, run: &Path) -> anyhow::Result<()> {
        let workspace = fs::canonicalize(&self.workspace)?;
        let target = target(&workspace, &self.relative, true)?;
        let staged = target.with_extension("json.tmp");
        match fs::symlink_metadata(&target) {
            Ok(_) => anyhow::bail!("the workspace file {} already exists", target.display()),
            Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error.into()),
            Err(_) => (),
        }
        let bytes = self.contents.as_bytes();
        let note = Note {
            workspace,
            relative: self.relative.clone(),
            digest: Sha256::digest(bytes).to_vec(),
            bytes: bytes.len() as u64,
        };
        let note_path = run.join(NOTE);
        let mut stored = facade_base::files::private_options()
            .write(true)
            .create_new(true)
            .open(&note_path)?;
        serde_json::to_writer(&mut stored, &note)?;
        stored.sync_all()?;
        facade_base::files::sync_folder(run)?;
        let file = facade_base::files::private_options()
            .write(true)
            .create_new(true)
            .open(&staged);
        let result = file.and_then(|mut file| {
            let written = file.write_all(bytes).and_then(|()| file.sync_all());
            drop(file);
            // The final name becomes visible only with the complete contents and is never replaced.
            let published = written.and_then(|()| fs::hard_link(&staged, &target));
            let _ = fs::remove_file(&staged);
            published
        });
        if result.is_err() {
            let _ = fs::remove_file(note_path);
        }
        result.map_err(|error| anyhow::anyhow!("could not create {}: {error}", target.display()))
    }
}

/// Removes a projection the run still owns. User edits and substituted paths are left alone.
pub(super) fn retire(run: &Path) -> io::Result<()> {
    let note_path = run.join(NOTE);
    let data = match fs::read(&note_path) {
        Ok(data) => data,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    let note: Note = serde_json::from_slice(&data)?;
    let path = match target(&note.workspace, &note.relative, false) {
        Ok(path) => path,
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::InvalidInput
            ) =>
        {
            return Ok(());
        }
        Err(error) => return Err(error),
    };
    for candidate in [path.with_extension("json.tmp"), path] {
        remove_matching(&candidate, &note)?;
    }
    remove_if_present(&note_path)
}

fn remove_matching(path: &Path, note: &Note) -> io::Result<()> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if !meta.is_file() || meta.len() != note.bytes {
        return Ok(());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(note.bytes + 1)
        .read_to_end(&mut bytes)?;
    if Sha256::digest(&bytes).as_slice() == note.digest {
        remove_if_present(path)?;
    }
    Ok(())
}

fn remove_if_present(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

/// Every config parent must still be inside the same canonical workspace.
fn target(workspace: &Path, relative: &Path, create: bool) -> io::Result<PathBuf> {
    if workspace.canonicalize()? != workspace {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "workspace path changed",
        ));
    }
    let unsafe_path =
        || io::Error::new(io::ErrorKind::InvalidInput, "unsafe workspace config path");
    let mut path = workspace.to_path_buf();
    let mut parts = relative.components().peekable();
    while let Some(part) = parts.next() {
        let Component::Normal(name) = part else {
            return Err(unsafe_path());
        };
        path.push(name);
        if parts.peek().is_none() {
            return Ok(path);
        }
        if create {
            match fs::create_dir(&path) {
                Err(error) if error.kind() != io::ErrorKind::AlreadyExists => return Err(error),
                _ => (),
            }
        }
        if !fs::symlink_metadata(&path)?.is_dir() || path.canonicalize()? != path {
            return Err(unsafe_path());
        }
    }
    Err(unsafe_path())
}
