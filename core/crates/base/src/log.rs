//! Facade's log line.

use std::io::Write;

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

#[cfg(test)]
mod tests {
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
