//! The session stores CLI launches in the selected folder would use.

mod claude;
mod codex;
mod indexes;
mod paths;
mod pi;
mod sqlite;
mod transcript;

use std::collections::BTreeMap;
use std::fmt::Display;
use std::fs::{self, Metadata};
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use facade_base::files::{folder_key, real_path};
use facade_base::model::error::{ErrorBody, Reason};
use facade_base::model::terminal::display_line;
use facade_base::system::{env_var, home_folder_in};

use super::parse_session_id;
use crate::Rule;

/// A resumable session that its CLI has saved in the selected folder's history.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SavedSession {
    pub id: String,
    pub folder: PathBuf,
    pub title: Option<String>,
    pub modified_at: Option<SystemTime>,
}

/// Reads the CLI's own history using the selected entry's effective environment and arguments.
/// The caller supplies an absolute folder on the machine where these stores live.
pub fn list_sessions(
    rule: &Rule,
    folder: &Path,
    environment: &BTreeMap<String, String>,
    args: &[String],
) -> Result<Vec<SavedSession>, ErrorBody> {
    let scope = Folder::new(folder);
    let home = home_folder_in(environment).map(|home| folder.join(home));
    let home = home.as_deref();
    let value = |name| env_var(environment, name).filter(|value| !value.is_empty());
    let configured = |name, default| {
        value(name)
            .map(|path| folder.join(path))
            .or_else(|| home.map(|home| home.join(default)))
    };
    let data = || {
        value("XDG_DATA_HOME")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .or_else(|| home.map(|home| home.join(".local").join("share")))
    };
    match rule.cli.as_str() {
        "claude" => {
            configured("CLAUDE_CONFIG_DIR", ".claude").map(|root| claude::list(&root, &scope))
        }
        "codex" => configured("CODEX_HOME", ".codex").map(|root| codex::list(&root, &scope)),
        "agy" => home.map(|home| {
            indexes::antigravity(&home.join(".gemini").join("antigravity-cli"), &scope)
        }),
        "muse" => data().map(|root| indexes::muse(&root.join("muse"), &scope)),
        "opencode" => {
            let file = value("OPENCODE_DB").unwrap_or("opencode.db");
            if file == ":memory:" {
                return Ok(Vec::new());
            }
            let file = Path::new(file);
            let path = if file.is_absolute() {
                Some(file.to_path_buf())
            } else {
                data().map(|data| data.join("opencode").join(file))
            };
            path.map(|file| indexes::opencode(&file, &scope))
        }
        "pi" => return pi::list(rule, &scope, home, environment, args),
        _ => None,
    }
    .unwrap_or_else(|| Ok(Vec::new()))
}

struct Folder<'a> {
    selected: &'a Path,
    resolved: Option<PathBuf>,
}

impl<'a> Folder<'a> {
    fn new(selected: &'a Path) -> Self {
        let resolved = real_path(selected)
            .ok()
            .filter(|real| real.as_os_str() != selected.as_os_str());
        Self { selected, resolved }
    }

    fn matches(&self, recorded: &Path) -> bool {
        if !recorded.is_absolute() {
            return false;
        }
        let matches = |path: &Path| {
            let key = folder_key(path);
            self.forms()
                .any(|form| path == form || key == folder_key(form))
        };
        matches(recorded) || real_path(recorded).is_ok_and(|real| matches(&real))
    }

    fn forms(&self) -> impl Iterator<Item = &Path> {
        std::iter::once(self.selected).chain(self.resolved.as_deref())
    }

    fn session(
        &self,
        id: String,
        title: Option<String>,
        modified_at: Option<SystemTime>,
    ) -> SavedSession {
        SavedSession {
            id,
            folder: self.selected.to_path_buf(),
            title,
            modified_at,
        }
    }

    /// Claude and Pi encode their cwd in a directory name. The transcript confirms the folder.
    fn stores_at(
        &self,
        root: &Path,
        encode: impl Fn(&Path) -> String,
    ) -> Result<Vec<PathBuf>, ErrorBody> {
        let names: Vec<_> = self
            .forms()
            .map(|form| folder_key(Path::new(&encode(form))))
            .collect();
        entries(root, |name| {
            let key = folder_key(Path::new(name));
            names.contains(&key)
        })
    }
}

fn uuid(id: &str) -> Option<String> {
    parse_session_id(id).filter(|id| !id.starts_with("ses_"))
}

fn title(native: Option<&str>, prompt: Option<&str>) -> Option<String> {
    let display = |text: &str| {
        let line = display_line(text.trim().lines().next().unwrap_or_default(), 120);
        (!line.is_empty()).then_some(line)
    };
    native
        .and_then(display)
        .or_else(|| prompt.and_then(display))
}

fn unix_time(value: Option<i64>, duration: fn(u64) -> Duration) -> Option<SystemTime> {
    let value = u64::try_from(value?).ok()?;
    UNIX_EPOCH.checked_add(duration(value))
}

fn store_error(path: &Path, error: impl Display) -> ErrorBody {
    ErrorBody::new(
        Reason::Unavailable,
        format!(
            "Could not read session history at {} ({error})",
            path.display()
        ),
    )
}

fn if_present<T>(path: &Path, result: io::Result<T>) -> Result<Option<T>, ErrorBody> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(store_error(path, error)),
    }
}

fn metadata(path: &Path) -> Result<Option<Metadata>, ErrorBody> {
    if_present(path, fs::metadata(path))
}

fn saved_file(path: &Path) -> Result<bool, ErrorBody> {
    Ok(path.is_absolute() && metadata(path)?.is_some_and(|meta| meta.is_file()))
}

fn entries(dir: &Path, take: impl Fn(&str) -> bool) -> Result<Vec<PathBuf>, ErrorBody> {
    let mut paths = Vec::new();
    if let Some(entries) = if_present(dir, fs::read_dir(dir))? {
        for entry in entries {
            let entry = entry.map_err(|error| store_error(dir, error))?;
            if entry.file_name().to_str().is_some_and(&take) {
                paths.push(entry.path());
            }
        }
    }
    Ok(paths)
}
