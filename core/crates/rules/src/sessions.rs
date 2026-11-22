//! Which session a run is in, kept in the run's folder, and the variables through which CLIs name
//! their sessions and mark their runs.
//!
//! Every run's folder has a session file. A CLI's hook (`facade hook session-start`), or the
//! plugin or extension Facade gives the run, reports the session the CLI picked, and the file
//! records it: the ID on the first line, and on the second, for a CLI that says where it keeps the
//! session, that file's path. An empty file means no session is picked.
//!
//! Resuming needs a saved session. A session whose CLI says where it keeps it is saved once that
//! file exists; until then it reads as no session, for every CLI alike.
//!
//! A new session file is written beside the old one, synced, and renamed over it, so readers never
//! see half a file. Nothing here creates a run's folder: once a run's folder is removed, its late
//! hooks have nowhere to write.

mod history;

pub use history::{SavedSession, list_sessions, session_for_id};

use std::collections::BTreeMap;
use std::fs::File;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use facade_base::files;
use facade_base::system::{SYSTEM, System, env_var};
use serde_json::Value;

use crate::Rule;

/// For each CLI, the variables it sets for the commands its model runs, and for MCP servers that
/// inherit its environment, to name its session: the session itself first, then, for a CLI that
/// has threads, the current thread. `facade` commands use them to find which agent's terminal they
/// run in; a guest's server reads only its own CLI's; agents Facade starts never inherit them.
pub const SESSION_VARIABLES: [(&str, &[&str]); 6] = [
    ("claude", &["CLAUDE_CODE_SESSION_ID"]),
    ("codex", &["CODEX_SESSION_ID", "CODEX_THREAD_ID"]),
    ("opencode", &["OPENCODE_SESSION_ID"]),
    ("pi", &["PI_SESSION_ID"]),
    ("muse", &["MUSE_SESSION_ID", "MUSE_THREAD_ID"]),
    ("agy", &["ANTIGRAVITY_CONVERSATION_ID"]),
];

/// More variables that mark a CLI session or run, or tune how it behaves: Claude Code and Codex
/// set these. A CLI started where they are set would treat that session or run as its own, so a
/// new agent never inherits them, just as it never inherits [`SESSION_VARIABLES`].
const RUN_VARIABLES: [&str; 22] = [
    "CLAUDECODE",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_BRIDGE_SESSION_ID",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_JOB_DIR",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_SSE_PORT",
    "CLAUDE_PID",
    "CLAUDE_EFFORT",
    "CLAUDE_PLUGIN_DATA",
    "CLAUDE_PLUGIN_ROOT",
    "CLAUDE_PROJECT_DIR",
    "CLAUDE_ENV_FILE",
    "CODEX_THREAD_ID",
    "CODEX_SANDBOX",
    "CODEX_SANDBOX_NETWORK_DISABLED",
    "CODEX_COMPANION_SESSION_ID",
    "CODEX_COMPANION_TRANSCRIPT_PATH",
];

/// The one variable naming `cli`'s session itself, if `cli` has one.
pub fn session_variable(cli: &str) -> Option<&'static str> {
    let (_, names) = SESSION_VARIABLES.iter().find(|(name, _)| *name == cli)?;
    names.first().copied()
}

/// Whether a new agent must not inherit the variable `name` because it marks some CLI's session,
/// thread or run: one of [`SESSION_VARIABLES`] or of [`RUN_VARIABLES`].
pub fn is_session_variable(name: &str) -> bool {
    SESSION_VARIABLES
        .iter()
        .flat_map(|(_, names)| names.iter())
        .chain(RUN_VARIABLES.iter())
        .any(|known| same_name(known, name))
}

/// Whether two variable names name the same variable: Windows compares them without case.
fn same_name(one: &str, other: &str) -> bool {
    match SYSTEM {
        System::Windows => one.eq_ignore_ascii_case(other),
        System::Unix => one == other,
    }
}

/// What the session file is called inside a run's folder.
pub const SESSION_FILE: &str = "session";

/// The folder of `agent`'s run under `runs` (Facade's `core/runs/`), if exactly one is there. Runs
/// live in `<agent>/<run>/`; a resume clears the agent's older folders before making its own.
pub fn run_folder(runs: &Path, agent: &str) -> Option<PathBuf> {
    let folders: Vec<PathBuf> = std::fs::read_dir(runs.join(agent))
        .ok()?
        .filter_map(|entry| Some(entry.ok()?.path()))
        .filter(|path| path.is_dir())
        .collect();
    let [only] = <[PathBuf; 1]>::try_from(folders).ok()?;
    Some(only)
}

/// A session file never needs more: one ID, one path, two newlines.
const SESSION_FILE_LIMIT: u64 = 4096;
/// OpenCode IDs are `ses_` plus at most this many letters and digits.
const OPENCODE_ID_LIMIT: usize = 64;

/// `text` as a session ID in its one accepted spelling, if it is one. Claude Code, Codex,
/// Antigravity, Muse Code and Pi use UUIDs, accepted in any case and given back in lowercase.
/// OpenCode uses `ses_` and letters and digits, kept exactly.
pub fn parse_session_id(text: &str) -> Option<String> {
    match text.strip_prefix("ses_") {
        Some(tail) => is_opencode_tail(tail).then(|| text.to_string()),
        None => is_uuid(text).then(|| text.to_ascii_lowercase()),
    }
}

/// Whether this call carries the canonical session ID of the run in its CLI's native source.
/// The caller verifies the relay's connection to the run before using this evidence.
pub fn session_evidence(
    rule: &Rule,
    recorded: &str,
    relay_env: &BTreeMap<String, String>,
    call_meta: Option<&Value>,
) -> bool {
    if parse_session_id(recorded).as_deref() != Some(recorded) {
        return false;
    }
    let metadata = || {
        let key = rule.mcp.session_meta_key.as_deref()?;
        call_meta?.get(key)?.as_str()
    };
    let reported = match rule.cli.as_str() {
        "muse" if is_uuid(recorded) => rule
            .mcp
            .session_env_key
            .as_deref()
            .and_then(|key| env_var(relay_env, key)),
        "agy" if is_uuid(recorded) => metadata(),
        "opencode" if recorded.starts_with("ses_") => metadata(),
        _ => None,
    };
    reported == Some(recorded)
}

fn is_opencode_tail(tail: &str) -> bool {
    (1..=OPENCODE_ID_LIMIT).contains(&tail.len()) && tail.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// 32 hex digits in groups of 8, 4, 4, 4 and 12, joined by hyphens.
fn is_uuid(text: &str) -> bool {
    text.len() == 36
        && text.bytes().enumerate().all(|(at, b)| match at {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
}

/// A session as its CLI reported it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reported {
    pub id: String,
    /// Where the CLI keeps the session, an absolute path, if it says. Until this file exists the
    /// session is not saved.
    pub saved_in: Option<PathBuf>,
}

impl Reported {
    /// A session already saved, such as the one a resume picks up.
    pub fn saved(id: &str) -> Reported {
        Reported {
            id: id.to_string(),
            saved_in: None,
        }
    }

    /// The session file's text for this session.
    fn file_text(&self) -> String {
        match &self.saved_in {
            Some(saved_in) => format!("{}\n{}\n", self.id, saved_in.display()),
            None => format!("{}\n", self.id),
        }
    }
}

/// The session file update a `SessionStart` hook asks for. `Some(Some(_))`: the session the CLI
/// picked. `Some(None)`: none is picked. None: anything else, which leaves the file alone. The
/// input's `hook_event_name` must be `SessionStart` and its `session_id` a session ID, or null or
/// empty for none; an absolute one-line `transcript_path` says where the session is kept.
pub fn session_from_hook(input: &[u8]) -> Option<Option<Reported>> {
    let input: serde_json::Value = serde_json::from_slice(input).ok()?;
    if input.get("hook_event_name")?.as_str()? != "SessionStart" {
        return None;
    }
    let picked = match input.get("session_id")? {
        serde_json::Value::Null => None,
        serde_json::Value::String(text) => picked_id(text)?,
        _ => return None,
    };
    let saved_in = input
        .get("transcript_path")
        .and_then(|path| path.as_str())
        .filter(|path| is_one_absolute_path(path))
        .map(PathBuf::from);
    Some(picked.map(|id| Reported { id, saved_in }))
}

/// The session file update the input of Antigravity's title command asks for, read like
/// [`session_from_hook`]'s. The input's `product` must be `antigravity`; `conversation_id`, or
/// `conversationId` as in Antigravity's hook payloads, names the conversation shown, or is empty
/// before there is one. Antigravity only names saved conversations.
pub fn session_from_title(input: &[u8]) -> Option<Option<Reported>> {
    let input: serde_json::Value = serde_json::from_slice(input).ok()?;
    if input.get("product")?.as_str()? != "antigravity" {
        return None;
    }
    let shown = ["conversation_id", "conversationId"]
        .iter()
        .find_map(|key| input.get(key))?
        .as_str()?;
    let picked = picked_id(shown)?;
    Some(picked.map(|id| Reported::saved(&id)))
}

/// A reported ID: `Some(None)` when empty, `Some(Some(id))` for a session ID, None otherwise.
fn picked_id(text: &str) -> Option<Option<String>> {
    if text.is_empty() {
        return Some(None);
    }
    parse_session_id(text).map(Some)
}

/// Whether `path` is absolute and has no line break.
fn is_one_absolute_path(path: &str) -> bool {
    Path::new(path).is_absolute() && !path.contains(['\n', '\r'])
}

/// A session file as read.
#[derive(Debug, PartialEq, Eq)]
pub enum SessionFile {
    /// The session the CLI selected, saved.
    Session(String),
    /// The file is empty, so no session is selected, or the selected session is not saved yet.
    NoSession,
    /// There is no file.
    Missing,
    /// The file cannot be read, or holds something other than a session ID.
    Unreadable(String),
}

/// What `read_session_file` says of a file in the wrong shape.
const MISSHAPEN: &str = "it does not hold one canonical session ID, and maybe the absolute path of \
                         its file, a line each";

/// Reads the session file at `path`, refusing one over 4 KiB.
pub fn read_session_file(path: &Path) -> SessionFile {
    let text = match read_limited(path, SESSION_FILE_LIMIT) {
        Ok(text) => text,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return SessionFile::Missing,
        Err(err) => return SessionFile::Unreadable(err.to_string()),
    };
    if text.is_empty() {
        return SessionFile::NoSession;
    }
    match recorded(&text) {
        None => SessionFile::Unreadable(MISSHAPEN.into()),
        Some(Recorded {
            saved_in: Some(kept),
            ..
        }) if !kept.exists() => SessionFile::NoSession,
        Some(Recorded { id, .. }) => SessionFile::Session(id.to_string()),
    }
}

/// The absolute native file reported for this session, if the report can supply one.
fn reported_path(report: &Path, id: &str) -> Option<PathBuf> {
    let text = read_limited(report, SESSION_FILE_LIMIT).ok()?;
    let record = recorded(&text)?;
    if record.id != id {
        return None;
    }
    record.saved_in.map(Path::to_path_buf)
}

/// `path`'s text, or an error if it is longer than `limit` bytes.
fn read_limited(path: &Path, limit: u64) -> io::Result<String> {
    let mut text = String::new();
    File::open(path)?
        .take(limit + 1)
        .read_to_string(&mut text)?;
    if text.len() as u64 > limit {
        return Err(io::Error::other(format!("it is larger than {limit} bytes")));
    }
    Ok(text)
}

/// The lines of a session file that is not empty.
struct Recorded<'a> {
    id: &'a str,
    saved_in: Option<&'a Path>,
}

/// A session file's text taken apart: an ID as [`parse_session_id`] spells it, then maybe an
/// absolute path, each ending in a newline. None for any other text.
fn recorded(text: &str) -> Option<Recorded<'_>> {
    let lines = text.strip_suffix('\n')?;
    let (id, saved_in) = match lines.split_once('\n') {
        Some((id, path)) => (id, Some(path)),
        None => (lines, None),
    };
    if parse_session_id(id).as_deref() != Some(id) {
        return None;
    }
    match saved_in {
        Some(path) if !is_one_absolute_path(path) => None,
        saved_in => Some(Recorded {
            id,
            saved_in: saved_in.map(Path::new),
        }),
    }
}

/// Why writing a session file failed.
#[derive(Debug)]
pub enum WriteFailure {
    /// The file was not replaced; it holds what it held before.
    NotWritten(io::Error),
    /// The file was replaced, but syncing its folder failed, so a machine crash could lose the
    /// change.
    NotDurable(io::Error),
}

impl std::fmt::Display for WriteFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WriteFailure::NotWritten(err) => write!(f, "the session file was not written: {err}"),
            WriteFailure::NotDurable(err) => write!(
                f,
                "the session file was written, but its folder could not be synced: {err}"
            ),
        }
    }
}

/// Makes the session file at `path` record `session`, or no session. Its folder must already
/// exist.
pub fn write_session_file(path: &Path, session: Option<&Reported>) -> Result<(), WriteFailure> {
    let text = session.map(Reported::file_text).unwrap_or_default();
    replace_with(
        path,
        &text,
        &|from, to| std::fs::rename(from, to),
        &files::sync_folder,
    )
}

/// Puts `text` at `path` through a synced temporary file, moved over it by `rename`, then has the
/// move made durable by `sync_folder`.
fn replace_with(
    path: &Path,
    text: &str,
    rename: &dyn Fn(&Path, &Path) -> io::Result<()>,
    sync_folder: &dyn Fn(&Path) -> io::Result<()>,
) -> Result<(), WriteFailure> {
    let folder = path.parent().ok_or_else(|| {
        WriteFailure::NotWritten(io::Error::new(io::ErrorKind::InvalidInput, "no folder"))
    })?;
    let (temporary, file) = temporary_in(folder).map_err(WriteFailure::NotWritten)?;
    let moved = fill(file, text).and_then(|()| rename(&temporary, path));
    if let Err(err) = moved {
        let _ = std::fs::remove_file(&temporary);
        return Err(WriteFailure::NotWritten(err));
    }
    // Readers may already see the new file, so a failed sync only reports.
    sync_folder(folder).map_err(WriteFailure::NotDurable)
}

/// Writes `text` into `file` and syncs it.
fn fill(mut file: File, text: &str) -> io::Result<()> {
    file.write_all(text.as_bytes())?;
    file.sync_all()
}

/// A fresh owner-only file in `folder`, named after this process and a counter so that no two
/// writers share it.
fn temporary_in(folder: &Path) -> io::Result<(PathBuf, File)> {
    let pid = std::process::id();
    let mut options = files::private_options();
    options.write(true).create_new(true);
    let mut attempt = 0u32;
    loop {
        let temporary = folder.join(format!(".{SESSION_FILE}.{pid}.{attempt}"));
        match options.open(&temporary) {
            Ok(file) => return Ok((temporary, file)),
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists && attempt < 100 => attempt += 1,
            Err(err) => return Err(err),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "86da4482-2bae-4a45-b193-a5664c19826a";

    fn folder(test: &str) -> crate::test_folder::TestFolder {
        crate::test_folder::TestFolder::new(&format!("session-{test}"))
    }

    fn saved(id: &str) -> Option<Reported> {
        Some(Reported::saved(id))
    }

    #[test]
    fn a_session_id_is_a_uuid_written_in_lowercase_or_opencode_s_as_it_is() {
        assert_eq!(parse_session_id(&ID.to_uppercase()).as_deref(), Some(ID));
        assert_eq!(
            parse_session_id("ses_1F2e3D").as_deref(),
            Some("ses_1F2e3D")
        );
        let longest = format!("ses_{}", "a".repeat(64));
        assert_eq!(parse_session_id(&longest), Some(longest.clone()));
        for wrong in [
            "",
            "86da4482",
            "86da4482-2bae-4a45-b193-a5664c19826",
            "86da4482-2bae-4a45-b193-a5664c19826g",
            " 86da4482-2bae-4a45-b193-a5664c19826a",
            "ses_",
            "ses_a-b",
            "SES_abc",
            &format!("{longest}a"),
        ] {
            assert!(parse_session_id(wrong).is_none(), "{wrong:?}");
        }
    }

    #[test]
    fn only_a_session_start_with_a_uuid_or_no_session_is_written() {
        let hook = |input: &str| session_from_hook(input.as_bytes());
        // An absolute path on this system.
        let transcript = match SYSTEM {
            System::Unix => "/x",
            System::Windows => "C:/x",
        };
        assert_eq!(
            hook(&format!(
                r#"{{"hook_event_name":"SessionStart","session_id":"{}","transcript_path":"{transcript}","cwd":"/w"}}"#,
                ID.to_uppercase()
            )),
            Some(Some(Reported {
                id: ID.into(),
                saved_in: Some(transcript.into())
            }))
        );
        for transcript in [r#""relative/x""#, r#""""#, "7", r#""/a\nb""#] {
            let input = format!(
                r#"{{"hook_event_name":"SessionStart","session_id":"{ID}","transcript_path":{transcript}}}"#
            );
            assert_eq!(
                hook(&input),
                Some(saved(ID)),
                "{input}: only an absolute path on one line names the file"
            );
        }
        assert_eq!(
            hook(r#"{"hook_event_name":"SessionStart","session_id":null}"#),
            Some(None)
        );
        assert_eq!(
            hook(r#"{"hook_event_name":"SessionStart","session_id":""}"#),
            Some(None)
        );
        for ignored in [
            r#"{"hook_event_name":"SessionStart"}"#.to_string(),
            format!(r#"{{"hook_event_name":"Stop","session_id":"{ID}"}}"#),
            format!(r#"{{"session_id":"{ID}"}}"#),
            r#"{"hook_event_name":"SessionStart","session_id":"not-a-uuid"}"#.to_string(),
            r#"{"hook_event_name":"SessionStart","session_id":7}"#.to_string(),
            "not json".to_string(),
        ] {
            assert_eq!(hook(&ignored), None, "{ignored}");
        }
    }

    #[test]
    fn a_session_file_reads_as_its_session_none_missing_or_unreadable() {
        let dir = folder("read");
        let path = dir.join(SESSION_FILE);
        assert_eq!(read_session_file(&path), SessionFile::Missing);
        write_session_file(&path, saved(ID).as_ref()).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), format!("{ID}\n"));
        assert_eq!(read_session_file(&path), SessionFile::Session(ID.into()));
        write_session_file(&path, None).unwrap();
        assert_eq!(read_session_file(&path), SessionFile::NoSession);
        for wrong in [
            ID.to_string(),
            format!("{}\n", ID.to_uppercase()),
            format!("{ID}\n{ID}\n"),
            format!("{ID}\n/a\n/b\n"),
            "x".repeat(5000),
        ] {
            std::fs::write(&path, wrong).unwrap();
            assert!(matches!(
                read_session_file(&path),
                SessionFile::Unreadable(_)
            ));
        }
        write_session_file(&path, saved(ID).as_ref()).unwrap();
        assert!(files::is_private(&path).unwrap());
        assert_eq!(
            std::fs::read_dir(&dir).unwrap().count(),
            1,
            "no temporary file is left"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Antigravity's title input names the conversation it shows, or none before it has one; other
    /// input changes nothing.
    #[test]
    fn antigravity_s_title_names_the_conversation_it_shows() {
        let title = |input: &str| session_from_title(input.as_bytes());
        let input = format!(
            r#"{{"product":"antigravity","session_id":"","conversation_id":"{}","agent_state":"idle"}}"#,
            ID.to_uppercase()
        );
        assert_eq!(title(&input), Some(saved(ID)));
        assert_eq!(
            title(
                r#"{"product":"antigravity","conversation_id":"","agent_state":"authenticating"}"#
            ),
            Some(None)
        );
        let camel =
            format!(r#"{{"product":"antigravity","conversationId":"{ID}","agentState":"idle"}}"#);
        assert_eq!(
            title(&camel),
            Some(saved(ID)),
            "named as Antigravity's hook payloads name it"
        );
        for ignored in [
            r#"{"product":"other","conversation_id":""}"#,
            r#"{"product":"antigravity"}"#,
            r#"{"product":"antigravity","conversation_id":"x"}"#,
            "{",
        ] {
            assert_eq!(title(ignored), None, "{ignored}");
        }
    }

    /// A session the CLI names the file of counts once that file exists: until it saved the
    /// session, nothing can resume it.
    #[test]
    fn a_session_counts_once_the_file_its_cli_saves_it_in_exists() {
        let dir = folder("saved");
        let path = dir.join(SESSION_FILE);
        let transcript = dir.join("transcript.jsonl");
        let reported = Reported {
            id: ID.into(),
            saved_in: Some(transcript.clone()),
        };
        write_session_file(&path, Some(&reported)).unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            format!("{ID}\n{}\n", transcript.display())
        );
        assert_eq!(
            read_session_file(&path),
            SessionFile::NoSession,
            "not saved yet"
        );
        std::fs::write(&transcript, "{}\n").unwrap();
        assert_eq!(read_session_file(&path), SessionFile::Session(ID.into()));
        std::fs::write(&path, format!("{ID}\nrelative.jsonl\n")).unwrap();
        assert!(
            matches!(read_session_file(&path), SessionFile::Unreadable(_)),
            "a path that is not absolute names no file"
        );
    }

    #[test]
    fn a_failure_before_the_rename_keeps_the_old_file_and_one_after_it_keeps_the_new_one() {
        let dir = folder("failures");
        let path = dir.join(SESSION_FILE);
        write_session_file(&path, saved(ID).as_ref()).unwrap();
        let other = "96da4482-2bae-4a45-b193-a5664c19826a";
        let refused = replace_with(
            &path,
            &Reported::saved(other).file_text(),
            &|_, _| Err(io::Error::other("rename refused")),
            &|_| Ok(()),
        );
        assert!(matches!(refused, Err(WriteFailure::NotWritten(_))));
        assert_eq!(
            read_session_file(&path),
            SessionFile::Session(ID.into()),
            "the old session stays"
        );
        assert_eq!(
            std::fs::read_dir(&dir).unwrap().count(),
            1,
            "the temporary file is removed"
        );
        let unsynced = replace_with(
            &path,
            &Reported::saved(other).file_text(),
            &|from, to| std::fs::rename(from, to),
            &|_| Err(io::Error::other("sync refused")),
        );
        assert!(matches!(unsynced, Err(WriteFailure::NotDurable(_))));
        assert_eq!(
            read_session_file(&path),
            SessionFile::Session(other.into()),
            "a published session is not taken back"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_session_file_whose_folder_was_removed_is_not_written() {
        let dir = folder("removed");
        std::fs::remove_dir(&dir).unwrap();
        assert!(matches!(
            write_session_file(&dir.join(SESSION_FILE), saved(ID).as_ref()),
            Err(WriteFailure::NotWritten(_))
        ));
        assert!(!dir.exists(), "the folder is never created again");
    }
}
