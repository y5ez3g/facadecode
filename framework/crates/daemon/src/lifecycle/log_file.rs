//! `framework/logs/daemon.log`, the daemon's own log and framework's agents log: one line for each operation
//! and lifecycle fact, which the keeper points the daemon's standard error at. It keeps 30 days,
//! pruned when the daemon starts and on the hourly sweep, with no size cap. Clients read its last
//! lines for the diagnostics report (`daemon.log`). It holds no message text, prompt, terminal
//! content or environment value.

use std::path::PathBuf;
use std::time::SystemTime;

use facade_base::model::error::ErrorBody;

/// The most lines `daemon.log` gives.
pub(crate) const MAX_LOG_LINES: u32 = 200;

/// The daemon's log file.
fn log_file() -> anyhow::Result<PathBuf> {
    Ok(facade_base::paths::framework_dir()?
        .join("logs")
        .join("daemon.log"))
}

/// Drops lines older than 30 days at `now` and redirects standard error if the file is replaced.
/// The daemon is the only writer. Blocks.
pub(crate) fn prune(now: SystemTime) -> anyhow::Result<()> {
    facade_base::log::prune(&log_file()?, now)?;
    Ok(())
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
