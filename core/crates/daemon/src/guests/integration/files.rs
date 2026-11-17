//! The files of an integration: reading them, writing Facade's entries in, and taking them out.

use std::io::Write as _;
use std::path::{Path, PathBuf};

use facade_base::jsonrpc::ErrorBody;
use facade_rules::integration::{self, Kind, Part, Programs, Target};

use crate::store::IntegrationFile;

/// A file's new text, made before anything is written.
pub(super) struct Write {
    target: Target,
    /// The file the target's path names, through a link to it.
    real: PathBuf,
    current: Option<Vec<u8>>,
    text: String,
}

/// Reads `target`'s file and makes its text with Facade's entries in. A file its CLI could not
/// read, or that the integration refuses, stops the whole integration: nothing is written.
pub(super) fn plan(target: Target, programs: &Programs) -> Result<Write, ErrorBody> {
    let real = real_path(&target.file);
    let current = read(&real)?;
    let text = match &current {
        Some(bytes) => Some(std::str::from_utf8(bytes).map_err(|_| {
            ErrorBody::refused(format!(
                "{}: it is not text its CLI can read; nothing was written",
                target.file.display()
            ))
        })?),
        None => None,
    };
    let text = integration::write(target.kind, text, programs).map_err(|reason| {
        ErrorBody::refused(format!(
            "{}: {reason}; nothing was written",
            target.file.display()
        ))
    })?;
    Ok(Write {
        target,
        real,
        current,
        text,
    })
}

impl Write {
    /// Whether the file does not hold its new text yet.
    pub(super) fn changes(&self) -> bool {
        self.current.as_deref() != Some(self.text.as_bytes())
    }

    /// The file as the store names it.
    pub(super) fn name(&self) -> String {
        self.target.file.to_string_lossy().into_owned()
    }

    pub(super) fn kind(&self) -> Kind {
        self.target.kind
    }

    pub(super) fn current(&self) -> Option<&[u8]> {
        self.current.as_deref()
    }

    pub(super) fn bytes(&self) -> &[u8] {
        self.text.as_bytes()
    }

    pub(super) fn apply(self) -> Result<(), ErrorBody> {
        write_file(&self.real, self.text.as_bytes())
    }
}

/// Takes Facade's entries out of `file`, and says what stays of them. A file that holds what
/// Facade last wrote goes back to what it held before, byte for byte, or goes where Facade made
/// it; from a file changed since, Facade's entries go and the person's stay.
pub(super) fn take_out_of(
    file: &Path,
    kind: Kind,
    kept: Option<&IntegrationFile>,
    programs: &Programs,
) -> Result<Vec<String>, ErrorBody> {
    let real = real_path(file);
    let Some(current) = read(&real)? else {
        return Ok(Vec::new());
    };
    if let Some(kept) = kept.filter(|kept| kept.written == current) {
        match &kept.before {
            Some(before) => write_file(&real, before)?,
            None => delete(&real, kind)?,
        }
        return Ok(Vec::new());
    }
    let stays = |why: &str| vec![format!("{}: Facade's entries stay: {why}", file.display())];
    let Ok(text) = std::str::from_utf8(&current) else {
        return Ok(stays("it is not text its CLI can read"));
    };
    let left = match integration::take_out(kind, text, &facade_s_entries(kind, kept, programs)) {
        Ok(left) => left,
        Err(reason) => return Ok(stays(&reason)),
    };
    match left.as_deref() {
        None => delete(&real, kind)?,
        Some(left) if left != text => write_file(&real, left.as_bytes())?,
        Some(_) => {}
    }
    let changed = left
        .as_deref()
        .and_then(|left| integration::parts(kind, left).ok())
        .unwrap_or_default();
    Ok(changed
        .into_iter()
        .map(|Part { place, .. }| {
            format!(
                "{}: Facade's {place} stays: it changed since it was written",
                file.display()
            )
        })
        .collect())
}

/// Facade's entries as written now and as Facade last wrote them in a file, less those the file
/// held before Facade wrote in it: an entry of Facade's shape there is the person's own.
fn facade_s_entries(kind: Kind, kept: Option<&IntegrationFile>, programs: &Programs) -> Vec<Part> {
    let mut entries = integration::wanted(kind, programs);
    if let Some(kept) = kept {
        entries.extend(parts_of(kind, Some(&kept.written)));
        let held = parts_of(kind, kept.before.as_deref());
        entries.retain(|part| !held.contains(part));
    }
    entries
}

/// What a file held before Facade's entries, `current` being what it holds now: as kept where it
/// still holds what Facade last wrote; as it is where Facade has written nothing in it, entries of
/// Facade's shape included, which are the person's own or another Facade's; and where it changed
/// since Facade wrote it, the person's own of it now, without what Facade added. None where that is
/// nothing.
pub(super) fn before_of(
    kind: Kind,
    current: Option<&[u8]>,
    kept: Option<&IntegrationFile>,
) -> Result<Option<Vec<u8>>, ErrorBody> {
    let (Some(bytes), Some(kept)) = (current, kept) else {
        return Ok(current.map(<[u8]>::to_vec));
    };
    if bytes == kept.written.as_slice() {
        return Ok(kept.before.clone());
    }
    let text = std::str::from_utf8(bytes)
        .map_err(|_| ErrorBody::internal("a file Facade writes is not text"))?;
    let held = parts_of(kind, kept.before.as_deref());
    let added: Vec<Part> = parts_of(kind, Some(&kept.written))
        .into_iter()
        .filter(|part| !held.contains(part))
        .collect();
    let mine = integration::take_out(kind, text, &added).map_err(ErrorBody::internal)?;
    Ok(mine.map(String::into_bytes))
}

/// Facade's entries in `bytes`, a file's text of `kind`: none where there is none, or it cannot be
/// read.
fn parts_of(kind: Kind, bytes: Option<&[u8]>) -> Vec<Part> {
    bytes
        .and_then(|bytes| std::str::from_utf8(bytes).ok())
        .and_then(|text| integration::parts(kind, text).ok())
        .unwrap_or_default()
}

/// The file a path names, through a link to it, so that the person's links to their configuration
/// stay.
pub(super) fn real_path(file: &Path) -> PathBuf {
    facade_base::files::real_path(file).unwrap_or_else(|_| file.to_path_buf())
}

/// A file's bytes, or None where there is no file.
pub(super) fn read(file: &Path) -> Result<Option<Vec<u8>>, ErrorBody> {
    match std::fs::read(file) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(ErrorBody::internal(format!(
            "cannot read {}: {err}",
            file.display()
        ))),
    }
}

/// Writes `bytes` to `file` through a file beside it, renamed into place, keeping the file's
/// permissions; makes its folder if needed.
fn write_file(file: &Path, bytes: &[u8]) -> Result<(), ErrorBody> {
    let failed = |err: std::io::Error| {
        ErrorBody::internal(format!("cannot write {}: {err}", file.display()))
    };
    let Some(folder) = file.parent() else {
        return Err(ErrorBody::internal(format!(
            "{} has no folder",
            file.display()
        )));
    };
    std::fs::create_dir_all(folder).map_err(failed)?;
    let name = file.file_name().unwrap_or_default().to_string_lossy();
    let beside = folder.join(format!(".{name}.facade-{}", std::process::id()));
    let mode = file.metadata().ok().map(|meta| meta.permissions());
    let written = std::fs::File::create(&beside)
        .and_then(|mut out| out.write_all(bytes).and_then(|()| out.sync_all()))
        .and_then(|()| mode.map_or(Ok(()), |mode| std::fs::set_permissions(&beside, mode)))
        .and_then(|()| std::fs::rename(&beside, file));
    if written.is_err() {
        let _ = std::fs::remove_file(&beside);
    }
    written.map_err(failed)
}

/// Deletes a file Facade made, with the folder of its own it is in where nothing else is there.
fn delete(file: &Path, kind: Kind) -> Result<(), ErrorBody> {
    match std::fs::remove_file(file) {
        Err(err) if err.kind() != std::io::ErrorKind::NotFound => {
            return Err(ErrorBody::internal(format!(
                "cannot remove {}: {err}",
                file.display()
            )));
        }
        _ => {}
    }
    if kind.in_own_folder()
        && let Some(folder) = file.parent()
    {
        let _ = std::fs::remove_dir(folder);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    const PROGRAMS: Programs = Programs {
        facade: "/opt/facade/facade",
        mcp: "/opt/facade/facade-mcp",
        home: None,
    };

    fn kept(before: Option<&str>, written: &str) -> IntegrationFile {
        IntegrationFile {
            file: "settings.json".into(),
            before: before.map(|text| text.as_bytes().to_vec()),
            written: written.as_bytes().to_vec(),
            added_at: "t".into(),
        }
    }

    /// What a file held before Facade's entries stays as kept while the file holds what Facade last
    /// wrote, so that an update of Facade's entries still puts the person's bytes back. Once the
    /// person changed the file, it is the person's own of it now.
    #[test]
    fn a_file_s_bytes_before_stay_kept_until_the_person_changes_it() {
        let own = "{\"model\":\"opus\"}";
        let written = integration::write(Kind::ClaudeSettings, Some(own), &PROGRAMS).unwrap();
        let before = |current: Option<&str>, kept: Option<&IntegrationFile>| {
            before_of(Kind::ClaudeSettings, current.map(str::as_bytes), kept)
                .unwrap()
                .map(|bytes| String::from_utf8(bytes).unwrap())
        };
        assert_eq!(
            before(Some(own), None).as_deref(),
            Some(own),
            "no entry of Facade's: the file as it is"
        );
        assert_eq!(
            before(Some(&written), Some(&kept(Some(own), &written))).as_deref(),
            Some(own),
            "as kept"
        );
        assert_eq!(
            before(Some(&written), Some(&kept(None, &written))),
            None,
            "Facade made the file"
        );
        let changed = written.replace("opus", "sonnet");
        let theirs = before(Some(&changed), Some(&kept(Some(own), &written))).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&theirs).unwrap(),
            serde_json::json!({ "model": "sonnet" }),
            "the person's own now"
        );
        let shaped = integration::write(Kind::ClaudeSettings, None, &PROGRAMS).unwrap();
        assert_eq!(
            before(Some(&shaped), None).as_deref(),
            Some(shaped.as_str()),
            "entries of Facade's shape it did not write stay"
        );
        // The person's own entry of Facade's shape, there before Facade wrote, stays theirs after
        // they change the file.
        let mine = r#"{"model":"opus","permissions":{"allow":["mcp__facade"]}}"#;
        let written = integration::write(Kind::ClaudeSettings, Some(mine), &PROGRAMS).unwrap();
        let changed = written.replace("opus", "haiku");
        let theirs: Value = serde_json::from_str(
            &before(Some(&changed), Some(&kept(Some(mine), &written))).unwrap(),
        )
        .unwrap();
        assert_eq!(
            theirs,
            serde_json::json!({ "model": "haiku", "permissions": { "allow": ["mcp__facade"] } }),
            "their approval stays"
        );
        assert_eq!(
            before(None, Some(&kept(Some(own), &written))),
            None,
            "no file now"
        );
    }
}
