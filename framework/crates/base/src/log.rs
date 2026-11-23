//! Facade's service log lines and their retention.

use std::io::{self, Write};
use std::path::Path;
use std::time::{Duration, SystemTime};

const KEPT_FOR: Duration = Duration::from_secs(30 * 24 * 60 * 60);

/// Writes one log line to standard error: the time, `program` and its process ID, `level` and
/// `message`. The keeper points standard error at a log file. A line that cannot be written, as on
/// a full disk or a closed pipe, is dropped; the program goes on.
pub fn write(program: &str, level: &str, message: &str) {
    let line = format!(
        "{} {program}[{}] {level}: {message}\n",
        crate::time::iso_now(),
        std::process::id()
    );
    let _ = std::io::stderr().lock().write_all(line.as_bytes());
}

/// Keep the last 30 days of a service log. The calling process must be its only writer and have
/// standard error directed there. If the file is replaced, use the new file for standard error.
pub fn prune(path: &Path, now: SystemTime) -> io::Result<()> {
    let _stderr = io::stderr().lock();
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    let since = crate::time::iso_time(now.checked_sub(KEPT_FOR).unwrap_or(SystemTime::UNIX_EPOCH));
    let kept = kept_lines(&text, &since);
    if kept.len() == text.lines().count() {
        return Ok(());
    }

    let pruned = path.with_extension("log.pruned");
    let mut contents = kept.join("\n");
    if !contents.is_empty() {
        contents.push('\n');
    }
    crate::files::create_private_file(&pruned)?.write_all(contents.as_bytes())?;
    std::fs::rename(pruned, path)?;
    crate::service::redirect_stderr(path)
}

/// A line without a timestamp belongs to the preceding entry.
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

/// The UTC timestamp at the beginning of a line written by `write`.
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

#[cfg(test)]
mod tests {
    #[test]
    fn old_lines_go_with_the_lines_that_follow_them() {
        let text = "2026-10-01T00:00:00.000Z daemon[1] info: old\nno time, old\n\
                    2026-11-15T00:00:00.000Z daemon[1] info: new\nno time, new\n";
        assert_eq!(
            super::kept_lines(text, "2026-10-16T00:00:00.000Z"),
            vec![
                "2026-11-15T00:00:00.000Z daemon[1] info: new",
                "no time, new"
            ]
        );
    }

    /// A line written to a pipe nobody reads is dropped, and `write` returns. Runs in a process of
    /// its own, whose standard error is a pipe whose reading end is closed before it starts.
    #[test]
    fn a_line_that_cannot_be_written_is_dropped() {
        const OWN_PROCESS: &str = "FACADE_TEST_OWN_PROCESS";
        if std::env::var_os(OWN_PROCESS).is_none() {
            let (unread, broken) = std::io::pipe().unwrap();
            drop(unread);
            let child = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "log::tests::a_line_that_cannot_be_written_is_dropped",
                    "--exact",
                    "--test-threads=1",
                    "--nocapture",
                ])
                .env(OWN_PROCESS, "1")
                .stderr(broken)
                .output()
                .unwrap();
            let stdout = String::from_utf8_lossy(&child.stdout);
            assert!(
                child.status.success() && stdout.contains(" 1 passed"),
                "{stdout}"
            );
            return;
        }
        super::write("test", "warn", "nobody reads this line");
    }
}
