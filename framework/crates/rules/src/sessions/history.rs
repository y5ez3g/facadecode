//! The session stores CLI launches in the selected folder would use.

mod claude;
mod codex;
mod indexes;
mod muse;
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

use super::{parse_session_id, reported_path};
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
    read_sessions(rule, &Folder::new(folder, None), environment, args)
}

/// Reads the saved session with this full canonical ID in the supplied launch context.
/// The run's session report can locate its native file before using the configured history.
pub fn session_for_id(
    rule: &Rule,
    folder: &Path,
    environment: &BTreeMap<String, String>,
    args: &[String],
    id: &str,
    report: Option<&Path>,
) -> Result<Option<SavedSession>, ErrorBody> {
    if parse_session_id(id).as_deref() != Some(id) {
        return Ok(None);
    }
    let scope = Folder::new(folder, Some(id));
    if let Some(report) = report
        && let Some(session) = read_reported_session(rule.cli.as_str(), report, id, &scope)?
    {
        return Ok(Some(session));
    }
    Ok(read_sessions(rule, &scope, environment, args)?
        .into_iter()
        .next())
}

fn read_reported_session(
    cli: &str,
    report: &Path,
    id: &str,
    scope: &Folder<'_>,
) -> Result<Option<SavedSession>, ErrorBody> {
    let read: fn(&Path, &Folder<'_>) -> Result<Option<SavedSession>, ErrorBody> = match cli {
        "claude" => claude::conversation,
        "codex" => codex::reported,
        "pi" => pi::conversation,
        _ => return Ok(None),
    };
    let Some(path) = reported_path(report, id) else {
        return Ok(None);
    };
    read(&path, scope)
}

fn read_sessions(
    rule: &Rule,
    scope: &Folder<'_>,
    environment: &BTreeMap<String, String>,
    args: &[String],
) -> Result<Vec<SavedSession>, ErrorBody> {
    let folder = scope.selected;
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
            configured("CLAUDE_CONFIG_DIR", ".claude").map(|root| claude::list(&root, scope))
        }
        "codex" => configured("CODEX_HOME", ".codex").map(|root| codex::list(&root, scope)),
        "agy" => home
            .map(|home| indexes::antigravity(&home.join(".gemini").join("antigravity-cli"), scope)),
        "muse" => data().map(|root| muse::sessions(&root.join("muse"), scope)),
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
            path.map(|file| indexes::opencode(&file, scope))
        }
        "pi" => return pi::list(rule, scope, home, environment, args),
        _ => None,
    }
    .unwrap_or_else(|| Ok(Vec::new()))
}

struct Folder<'a> {
    selected: &'a Path,
    resolved: Option<PathBuf>,
    id: Option<&'a str>,
}

impl<'a> Folder<'a> {
    fn new(selected: &'a Path, id: Option<&'a str>) -> Self {
        let resolved = real_path(selected)
            .ok()
            .filter(|real| real.as_os_str() != selected.as_os_str());
        Self {
            selected,
            resolved,
            id,
        }
    }

    fn includes_id(&self, id: &str) -> bool {
        self.id.is_none_or(|selected| selected == id)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_folder::TestFolder;
    use serde_json::json;

    #[test]
    fn muse_session_lookup_uses_the_first_prompt_before_the_index_has_it() {
        // Created on November 23 at 05:15 UTC, under November 22 in Muse's local folders.
        const ID: &str = "01a206d4-3420-7000-8000-0123456789ab";
        let home = TestFolder::new("muse-unindexed");
        let workspace = home.join("workspace");
        fs::create_dir(&workspace).unwrap();
        let data = home.join("data");
        let root = data.join("muse");
        let session = root.join("sessions/2026/11/22").join(ID);
        fs::create_dir_all(&session).unwrap();
        let log = session.join("session.jsonl");
        let records = [
            json!({
                "payload_type": "runtime.session.metadata",
                "payload": { "record": { "workspace_root": workspace } }
            }),
            json!({
                "payload_type": "runtime.user_intent.accepted",
                "payload": { "refill_blocks": [{ "text": "Explain a flange\nUse two paragraphs." }] }
            }),
            json!({
                "payload_type": "runtime.user_intent.accepted",
                "payload": { "refill_blocks": [{ "text": "Show an example" }] }
            }),
        ];
        fs::write(&log, records.map(|record| format!("{record}\n")).concat()).unwrap();
        let index = rusqlite::Connection::open(root.join("session-index.db")).unwrap();
        index
            .execute_batch(
                "CREATE TABLE sessions (session_id TEXT, workspace_root TEXT, first_user_prompt TEXT,
                 updated_at_us INTEGER, session_log_path TEXT, status TEXT, prompt_count INTEGER);",
            )
            .unwrap();
        let environment = BTreeMap::from([("XDG_DATA_HOME".into(), data.to_str().unwrap().into())]);
        let rule = crate::find("muse").unwrap().unwrap();

        let found = session_for_id(rule, &workspace, &environment, &[], ID, None)
            .unwrap()
            .expect("the running session is already in Muse's transcript");
        assert_eq!(found.id, ID);
        assert_eq!(found.folder, workspace);
        assert_eq!(found.title.as_deref(), Some("Explain a flange"));
        assert!(
            session_for_id(rule, &home, &environment, &[], ID, None)
                .unwrap()
                .is_none()
        );
        assert!(
            list_sessions(rule, &workspace, &environment, &[])
                .unwrap()
                .is_empty()
        );

        index
            .execute(
                "INSERT INTO sessions VALUES (?1, ?2, '', 1, ?3, 'valid', 2)",
                [ID, workspace.to_str().unwrap(), log.to_str().unwrap()],
            )
            .unwrap();
        let untitled = session_for_id(rule, &workspace, &environment, &[], ID, None)
            .unwrap()
            .unwrap();
        assert_eq!(untitled.title.as_deref(), Some("Explain a flange"));

        index
            .execute(
                "UPDATE sessions SET first_user_prompt = 'Indexed prompt'",
                [],
            )
            .unwrap();
        let indexed = session_for_id(rule, &workspace, &environment, &[], ID, None)
            .unwrap()
            .unwrap();
        assert_eq!(indexed.title.as_deref(), Some("Indexed prompt"));
    }
}
