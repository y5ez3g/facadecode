use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, ensure};

use super::os;

#[derive(Clone, Copy)]
pub(super) enum Access {
    Account,
    #[cfg(windows)]
    Administrators,
}

impl Access {
    pub(super) fn administrators(self) -> bool {
        match self {
            Self::Account => false,
            #[cfg(windows)]
            Self::Administrators => true,
        }
    }
}

pub(super) fn credentials_dir(home: &Path) -> anyhow::Result<PathBuf> {
    ensure!(home.is_absolute(), "the Facade home must be absolute");
    let path = home.join("core").join("ssh");
    fs::create_dir_all(path.parent().expect("SSH directory has a parent"))?;
    ensure_directory(&path, Access::Account)?;
    os::check_private(&path, true)?;
    Ok(path)
}

pub(super) fn ensure_directory(path: &Path, access: Access) -> io::Result<()> {
    match os::create_directory(path, access) {
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            if fs::symlink_metadata(path)?.is_dir() {
                Ok(())
            } else {
                Err(io::Error::other("expected an SSH directory"))
            }
        }
        result => result,
    }
}

pub(super) struct Scratch(PathBuf);

impl Scratch {
    pub(super) fn new(parent: &Path) -> anyhow::Result<Self> {
        let path = parent.join(format!(".facade-ssh-{:016x}", crate::random_u64()));
        os::create_directory(&path, Access::Account)
            .with_context(|| format!("creating private SSH directory {}", path.display()))?;
        Ok(Self(path))
    }

    pub(super) fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub(super) fn lock(path: &Path, access: Access) -> io::Result<File> {
    let file = match os::create_file(path, access) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            if !fs::symlink_metadata(path)?.is_file() {
                return Err(io::Error::other("expected a regular SSH lock file"));
            }
            OpenOptions::new().read(true).write(true).open(path)?
        }
        Err(error) => return Err(error),
    };
    file.lock()?;
    Ok(file)
}

pub(super) fn read_limited(path: &Path, limit: usize) -> anyhow::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    File::open(path)?
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= limit,
        "{} exceeds the SSH file size limit",
        path.display()
    );
    Ok(bytes)
}

pub(super) struct TextFile {
    pub(super) bytes: Vec<u8>,
    metadata: Option<Metadata>,
}

impl TextFile {
    pub(super) fn read(path: &Path) -> io::Result<Self> {
        match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.is_file() => Ok(Self {
                bytes: fs::read(path)?,
                metadata: Some(metadata),
            }),
            Ok(_) => Err(io::Error::other("expected a regular SSH file")),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Self {
                bytes: Vec::new(),
                metadata: None,
            }),
            Err(error) => Err(error),
        }
    }

    pub(super) fn write(&self, path: &Path, access: Access) -> anyhow::Result<()> {
        let parent = path.parent().expect("SSH file has a parent");
        let scratch = Scratch::new(parent)?;
        let temp = scratch.path().join("replacement");
        let mut file = os::create_file(&temp, access)?;
        file.write_all(&self.bytes)?;
        if let Some(metadata) = &self.metadata {
            os::set_replacement_access(&file, path, metadata)?;
        }
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, path)?;
        Ok(())
    }
}

/// The records supplied by this attempt, and a separator inserted after a nonterminated line.
pub(super) struct AppendedLines {
    lines: Vec<Vec<u8>>,
    separator: Option<usize>,
}

impl AppendedLines {
    pub(super) fn append(bytes: &mut Vec<u8>, lines: Vec<Vec<u8>>) -> Self {
        let separator =
            (!bytes.is_empty() && !bytes.ends_with(b"\n") && !lines.is_empty()).then(|| {
                let at = bytes.len();
                bytes.push(b'\n');
                at
            });
        for line in &lines {
            bytes.extend_from_slice(line);
        }
        Self { lines, separator }
    }

    pub(super) fn remove(self, bytes: &mut Vec<u8>) -> bool {
        let mut lines = self.lines;
        let mut kept = Vec::new();
        for line in bytes.split_inclusive(|&byte| byte == b'\n') {
            // Consume each receipt entry once, leaving any unrelated duplicate intact.
            if let Some(index) = lines.iter().position(|entry| entry == line) {
                lines.swap_remove(index);
            } else {
                kept.extend_from_slice(line);
            }
        }
        if kept.len() == bytes.len() {
            return false;
        }
        if let Some(at) = self.separator
            && kept.len() == at + 1
            && kept[at] == b'\n'
            && kept == bytes[..=at]
        {
            kept.pop();
        }
        *bytes = kept;
        true
    }
}
