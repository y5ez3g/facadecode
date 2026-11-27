use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use anyhow::{Context, ensure};

use super::files::{self, Access, AppendedLines, TextFile};
use super::{keys::PublicKey, os};

pub struct AuthorizationFile {
    path: PathBuf,
    access: Access,
}

pub fn authorization_file() -> anyhow::Result<AuthorizationFile> {
    let (path, access) = os::authorization_path()?;
    Ok(AuthorizationFile { path, access })
}

impl AuthorizationFile {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn administrators(&self) -> bool {
        self.access.administrators()
    }

    pub fn authorize(
        &self,
        key: &str,
        machine_name: &str,
        machine_id: &str,
    ) -> anyhow::Result<Option<AuthorizationChange>> {
        let machine_id = full_id(machine_id)?;
        let key = PublicKey::parse(key)?;
        ensure!(
            key.kind == "ssh-ed25519",
            "expected a dedicated Ed25519 SSH public key"
        );
        let name = marker_name(machine_name);
        self.with_path_context((|| {
            files::ensure_directory(
                self.path.parent().expect("authorization path has a parent"),
                self.access,
            )?;
            let _lock = files::lock(&self.lock_path(), self.access)?;
            let mut file = TextFile::read(&self.path)?;
            if file
                .bytes
                .split(|&byte| byte == b'\n')
                .any(|line| contains_key(line, &key))
            {
                return Ok(None);
            }
            let entry = format!("{} # facade:{name}:{machine_id}\n", key.line());
            let added = AppendedLines::append(&mut file.bytes, vec![entry.into_bytes()]);
            file.write(&self.path, self.access)?;
            Ok(Some(AuthorizationChange {
                file: AuthorizationFile {
                    path: self.path.clone(),
                    access: self.access,
                },
                added,
            }))
        })())
    }

    pub fn revoke_peer(&self, machine_id: &str) -> anyhow::Result<bool> {
        let machine_id = full_id(machine_id)?;
        self.with_path_context((|| {
            match fs::symlink_metadata(&self.path) {
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
                result => {
                    result?;
                }
            }
            let _lock = files::lock(&self.lock_path(), self.access)?;
            let mut file = TextFile::read(&self.path)?;
            let kept: Vec<u8> = file
                .bytes
                .split_inclusive(|&byte| byte == b'\n')
                .filter(|line| !belongs_to(line, &machine_id))
                .flatten()
                .copied()
                .collect();
            if kept.len() == file.bytes.len() {
                return Ok(false);
            }
            file.bytes = kept;
            file.write(&self.path, self.access)?;
            Ok(true)
        })())
    }

    fn lock_path(&self) -> PathBuf {
        self.path.with_extension("facade-lock")
    }

    fn with_path_context<T>(&self, result: anyhow::Result<T>) -> anyhow::Result<T> {
        if self.administrators()
            && let Err(error) = &result
            && error.downcast_ref::<io::Error>().is_some_and(|error| {
                // A filtered Administrators token rejects the group owner with error 1307.
                error.kind() == io::ErrorKind::PermissionDenied
                    || matches!(error.raw_os_error(), Some(1300 | 1307 | 1314))
            })
        {
            anyhow::bail!(
                "writing {} requires an elevated Administrator terminal",
                self.path.display()
            );
        }
        result.with_context(|| format!("updating {}", self.path.display()))
    }
}

pub struct AuthorizationChange {
    file: AuthorizationFile,
    added: AppendedLines,
}

impl AuthorizationChange {
    pub fn rollback(self) -> anyhow::Result<()> {
        self.file.with_path_context((|| {
            let _lock = files::lock(&self.file.lock_path(), self.file.access)?;
            let mut file = TextFile::read(&self.file.path)?;
            if self.added.remove(&mut file.bytes) {
                file.write(&self.file.path, self.file.access)?;
            }
            Ok(())
        })())
    }
}

fn full_id(id: &str) -> anyhow::Result<String> {
    ensure!(
        id.len() == 36
            && id.bytes().enumerate().all(|(at, byte)| {
                if matches!(at, 8 | 13 | 18 | 23) {
                    byte == b'-'
                } else {
                    byte.is_ascii_hexdigit()
                }
            }),
        "expected a full Facade Code Framework machine ID"
    );
    Ok(id.to_ascii_lowercase())
}

fn marker_name(name: &str) -> String {
    let mut name: String = name
        .bytes()
        .map(|byte| byte.to_ascii_lowercase())
        .map(|byte| {
            if byte.is_ascii_alphanumeric() {
                byte
            } else {
                b'-'
            }
        })
        .skip_while(|&byte| byte == b'-')
        .take(64)
        .map(char::from)
        .collect();
    if name.is_empty() {
        name.push_str("machine");
    }
    name
}

fn contains_key(line: &[u8], key: &PublicKey<'_>) -> bool {
    let line = line.trim_ascii_start();
    if line.starts_with(b"#") {
        return false;
    }
    let Some((first, rest)) = option_field(line) else {
        return false;
    };
    let mut fields = rest
        .split(|byte| byte.is_ascii_whitespace())
        .filter(|word| !word.is_empty());
    let Some(second) = fields.next() else {
        return false;
    };
    key.matches(first, second)
        || fields
            .next()
            .is_some_and(|third| key.matches(second, third))
}

/// The first field can be a comma-separated set of options with quoted spaces.
fn option_field(line: &[u8]) -> Option<(&[u8], &[u8])> {
    let mut quoted = false;
    let mut escaped = false;
    for (at, &byte) in line.iter().enumerate() {
        if escaped {
            escaped = false;
        } else if byte == b'\\' && quoted {
            escaped = true;
        } else if byte == b'"' {
            quoted = !quoted;
        } else if !quoted && byte.is_ascii_whitespace() {
            return Some(line.split_at(at));
        }
    }
    None
}

fn belongs_to(line: &[u8], id: &str) -> bool {
    let Ok(line) = std::str::from_utf8(line.trim_ascii_end()) else {
        return false;
    };
    let Some((key, marker)) = line.split_once(" # facade:") else {
        return false;
    };
    let Some((name, marked_id)) = marker.split_once(':') else {
        return false;
    };
    name.bytes()
        .next()
        .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && name
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        && marked_id.eq_ignore_ascii_case(id)
        && PublicKey::parse(key)
            .is_ok_and(|parsed| parsed.kind == "ssh-ed25519" && parsed.line() == key)
}
