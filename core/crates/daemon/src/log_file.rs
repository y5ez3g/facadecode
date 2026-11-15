//! `core/logs/daemon.log`, the daemon's own log and core's agents log: one line for each operation
//! and lifecycle fact, which the keeper points the daemon's standard error at. It keeps 30 days,
//! pruned by the hourly sweep, with no size cap, and the person's clients read its last lines for
//! the diagnostics report (`daemon.log`). It holds no message text, prompt, terminal content or
//! environment value.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use facade_base::jsonrpc::ErrorBody;

/// The most lines `daemon.log` gives.
pub(crate) const MAX_LOG_LINES: u32 = 200;
/// How long the log keeps a line.
const KEPT_FOR: std::time::Duration = std::time::Duration::from_secs(30 * 24 * 60 * 60);

/// The daemon's log file.
fn log_file() -> anyhow::Result<PathBuf> {
    Ok(facade_base::paths::core_dir()?
        .join("logs")
        .join("daemon.log"))
}

/// The time a line begins with, as `facade_base::log` writes it: `2026-11-15T12:46:57.955Z`.
fn time_of(line: &str) -> Option<&str> {
    let time = line.get(..24)?;
    let shape = time.bytes().enumerate().all(|(at, byte)| match at {
        4 | 7 => byte == b'-',
        10 => byte == b'T',
        13 | 16 => byte == b':',
        19 => byte == b'.',
        23 => byte == b'Z',
        _ => byte.is_ascii_digit(),
    });
    shape.then_some(time)
}

/// The lines of `text` written at `since` or later. A line that begins with no time, as one a
/// program the daemon started wrote, goes with the line before it.
fn kept_lines<'a>(text: &'a str, since: &str) -> Vec<&'a str> {
    let mut keep = false;
    text.lines()
        .filter(|line| {
            if let Some(time) = time_of(line) {
                keep = time >= since;
            }
            keep
        })
        .collect()
}

/// Drops the lines older than 30 days at `now` from the daemon's log, then points the daemon's
/// standard error at the file again: the daemon is its only writer. Blocks.
pub(crate) fn prune(now: SystemTime) -> anyhow::Result<()> {
    let file = log_file()?;
    let text = match std::fs::read_to_string(&file) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(err.into()),
    };
    let since =
        facade_base::time::iso_time(now.checked_sub(KEPT_FOR).unwrap_or(SystemTime::UNIX_EPOCH));
    let kept = kept_lines(&text, &since);
    if kept.len() == text.lines().count() {
        return Ok(());
    }
    let pruned = file.with_extension("log.pruned");
    let mut written = kept.join("\n");
    if !written.is_empty() {
        written.push('\n');
    }
    write_private(&pruned, &written)?;
    std::fs::rename(&pruned, &file)?;
    facade_base::service::redirect_stderr(&file)?;
    Ok(())
}

fn write_private(file: &Path, text: &str) -> std::io::Result<()> {
    use std::io::Write;
    let mut out = facade_base::files::create_private_file(file)?;
    out.write_all(text.as_bytes())
}

/// The last `lines` lines of the daemon's log, oldest first, the home folder written `~`
/// (`daemon.log`). None more than [`MAX_LOG_LINES`]; no file reads as no lines. Blocks.
pub(crate) fn last_lines(lines: u32) -> Result<Vec<String>, ErrorBody> {
    if lines > MAX_LOG_LINES {
        return Err(ErrorBody::invalid_argument(format!(
            "daemon.log gives at most {MAX_LOG_LINES} lines, not {lines}"
        )));
    }
    let file = log_file().map_err(ErrorBody::internal)?;
    let text = match std::fs::read_to_string(&file) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(ErrorBody::internal(err)),
    };
    let home = std::env::var("HOME").ok().filter(|home| !home.is_empty());
    let all: Vec<&str> = text.lines().collect();
    let first = all.len().saturating_sub(lines as usize);
    Ok(all[first..]
        .iter()
        .map(|line| match &home {
            Some(home) => with_home_as_tilde(line, home),
            None => line.to_string(),
        })
        .collect())
}

/// `line` with the home folder `home` written `~`: the folder itself, or a path under it, never
/// a longer name that only begins as it does.
fn with_home_as_tilde(line: &str, home: &str) -> String {
    let mut written = String::new();
    let mut rest = line;
    while let Some(at) = rest.find(home) {
        let after = &rest[at + home.len()..];
        let whole = after
            .chars()
            .next()
            .is_none_or(|next| next == '/' || !(next.is_alphanumeric() || "_-.".contains(next)));
        written.push_str(&rest[..at]);
        written.push_str(if whole { "~" } else { home });
        rest = after;
    }
    written.push_str(rest);
    written
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Lines older than the cutoff go, and a line with no time goes or stays with the one before.
    #[test]
    fn old_lines_go_with_the_lines_that_follow_them() {
        let text = "2026-10-01T00:00:00.000Z daemon[1] info: old\nno time, old\n\
                    2026-11-15T00:00:00.000Z daemon[1] info: new\nno time, new\n";
        assert_eq!(
            kept_lines(text, "2026-10-16T00:00:00.000Z"),
            vec![
                "2026-11-15T00:00:00.000Z daemon[1] info: new",
                "no time, new"
            ]
        );
    }
}
