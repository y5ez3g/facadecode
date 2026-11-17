//! Results too long for a tool's answer, each in a file of its own under `core/results/`, readable
//! by this user alone. A file's name says what it holds and when it may go:
//!
//! - `screen-<time>-<process>-<n>.txt`: a screen, deleted after 30 days;
//! - `messages-m<first>-<time>-<process>-<n>.json`: messages, deleted once its first, oldest
//!   message is no longer kept (COLLABORATION-4.2);
//! - `agents-<time>-<process>-<n>.json`: a list of agents, never deleted.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

const SCREEN: &str = "screen-";
const MESSAGES: &str = "messages-";
const AGENTS: &str = "agents-";

/// How long a screen's file is kept.
const SCREEN_KEPT_FOR: Duration = Duration::from_secs(30 * 24 * 60 * 60);

/// What a result file holds.
pub(super) enum ResultFile<'a> {
    Screen,
    /// Messages, the first of them, the oldest, by its ID, such as `m42`.
    Messages {
        first: &'a str,
    },
    Agents,
}

impl ResultFile<'_> {
    /// How the file's name starts, and its extension.
    fn name_parts(&self) -> (String, &'static str) {
        match self {
            ResultFile::Screen => (SCREEN.to_string(), "txt"),
            ResultFile::Messages { first } => (format!("{MESSAGES}{first}-"), "json"),
            ResultFile::Agents => (AGENTS.to_string(), "json"),
        }
    }
}

/// The folder of result files in the core folder `core`.
pub(crate) fn results_folder(core: &Path) -> PathBuf {
    core.join("results")
}

/// Writes `text` to a new result file of kind `kind` and answers its path.
pub(super) fn write(kind: ResultFile<'_>, text: &str) -> anyhow::Result<PathBuf> {
    static WRITTEN: AtomicU64 = AtomicU64::new(0);
    let folder = results_folder(&facade_base::paths::core_dir()?);
    facade_base::files::create_private_folder_all(&folder)?;
    let time: String = facade_base::time::iso_now()
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect();
    let (start, extension) = kind.name_parts();
    let count = WRITTEN.fetch_add(1, Ordering::Relaxed);
    let path = folder.join(format!(
        "{start}{time}-{}-{count}.{extension}",
        std::process::id()
    ));
    let mut file = facade_base::files::private_options()
        .write(true)
        .create_new(true)
        .open(&path)?;
    file.write_all(text.as_bytes())?;
    Ok(path)
}

/// Deletes the result files in `folder` that no one can use any more, at `now`: a screen's after 30
/// days, and messages' once their first message is no longer kept, as `kept` says of a message's
/// number. Other files stay.
pub(crate) fn clean_results(folder: &Path, now: SystemTime, kept: &dyn Fn(u64) -> bool) {
    let Ok(entries) = std::fs::read_dir(folder) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let unused = if name.starts_with(SCREEN) {
            let modified = entry.metadata().and_then(|metadata| metadata.modified());
            modified
                .ok()
                .and_then(|modified| now.duration_since(modified).ok())
                .is_some_and(|age| age > SCREEN_KEPT_FOR)
        } else if name.starts_with(MESSAGES) {
            first_message_of(&name).is_none_or(|first| !kept(first))
        } else {
            false
        };
        if !unused {
            continue;
        }
        match std::fs::remove_file(entry.path()) {
            Err(err) if err.kind() != std::io::ErrorKind::NotFound => facade_base::log::write(
                "daemon",
                "warn",
                &format!(
                    "could not delete the result file {}: {err}",
                    entry.path().display()
                ),
            ),
            _ => {}
        }
    }
}

/// The number of the first message in the messages' result file named `name`; None for another
/// file, or one whose name gives no message.
fn first_message_of(name: &str) -> Option<u64> {
    let rest = name.strip_prefix(MESSAGES)?.strip_prefix('m')?;
    let (digits, _) = rest.split_once('-')?;
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A result file of messages is named by its first message, and the name gives that message's
    /// number back; a screen's file, another file, or one an earlier build named without a message
    /// gives none.
    #[test]
    fn a_result_file_of_messages_is_named_by_its_first_message() {
        let (start, _) = ResultFile::Messages { first: "m7" }.name_parts();
        let name = format!("{start}20261111T120000000Z-42-0.txt");
        assert_eq!(name, "messages-m7-20261111T120000000Z-42-0.txt");
        assert_eq!(first_message_of(&name), Some(7));
        for other in [
            "messages-20261111T000000000Z-1-0.txt",
            "messages-m-1.txt",
            "messages-mx-1.txt",
            "screen-m7-1.json",
            "notes.txt",
        ] {
            assert_eq!(first_message_of(other), None, "{other}");
        }
    }
}
