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
    /// its own, since it breaks that process's standard error.
    #[test]
    fn a_line_that_cannot_be_written_is_dropped() {
        const OWN_PROCESS: &str = "FACADE_TEST_OWN_PROCESS";
        if std::env::var_os(OWN_PROCESS).is_none() {
            let child = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "log::tests::a_line_that_cannot_be_written_is_dropped",
                    "--exact",
                    "--test-threads=1",
                    "--nocapture",
                ])
                .env(OWN_PROCESS, "1")
                .output()
                .unwrap();
            let stdout = String::from_utf8_lossy(&child.stdout);
            let stderr = String::from_utf8_lossy(&child.stderr);
            assert!(
                child.status.success() && stdout.contains(" 1 passed"),
                "{stdout}{stderr}"
            );
            return;
        }
        let mut ends = [-1; 2];
        // SAFETY: these calls touch only descriptors of this process, which runs this test alone.
        unsafe {
            assert_eq!(libc::pipe(ends.as_mut_ptr()), 0);
            libc::close(ends[0]);
            assert_eq!(
                libc::dup2(ends[1], libc::STDERR_FILENO),
                libc::STDERR_FILENO
            );
            libc::close(ends[1]);
        }
        super::write("test", "warn", "nobody reads this line");
    }
}
