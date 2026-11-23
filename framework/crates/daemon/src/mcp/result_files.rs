//! The result files under `framework/results/` that tools wrote when a result was too long for their
//! answer, readable by this user alone. A file's name says what it holds and when it may go:
//!
//! - `screen-<time>-<process>-<n>.txt`: a screen, deleted after 30 days;
//! - `messages-m<first>-<time>-<process>-<n>.json`: messages, deleted once its first, oldest
//!   message is no longer kept (COLLABORATION-4.2);
//! - `agents-<time>-<process>-<n>.json`: a list of agents, never deleted.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

const SCREEN: &str = "screen-";
const MESSAGES: &str = "messages-";

/// How long a screen's file is kept.
const SCREEN_KEPT_FOR: Duration = Duration::from_secs(30 * 24 * 60 * 60);

/// The folder of result files in the Framework folder `framework`.
pub(crate) fn results_folder(framework: &Path) -> PathBuf {
    framework.join("results")
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

    /// The name of a result file of messages gives its first message's number back; a screen's
    /// file, another file, or one an earlier build named without a message gives none.
    #[test]
    fn a_result_file_of_messages_is_named_by_its_first_message() {
        let name = "messages-m7-20261111T120000000Z-42-0.txt";
        assert_eq!(first_message_of(name), Some(7));
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
