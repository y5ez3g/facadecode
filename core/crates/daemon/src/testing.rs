//! Tools the unit tests of every part of the daemon share.

/// Terminals for tests.
#[cfg(test)]
pub(crate) mod test_terminal {
    use nix::fcntl::{FcntlArg, FdFlag, OFlag};

    /// Opens a terminal of `size` whose sides no child process inherits: each side is closed on
    /// exec from the moment it opens, so not even a child that another test starts meanwhile holds
    /// it. Such a child would keep the terminal open after the test closed it.
    pub(crate) fn open(size: Option<&nix::pty::Winsize>) -> nix::pty::OpenptyResult {
        // ptsname names the CLI side in a buffer of its own, which a call on another thread could
        // overwrite meanwhile.
        static NAMING: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let master =
            nix::pty::posix_openpt(OFlag::O_RDWR | OFlag::O_NOCTTY | OFlag::O_CLOEXEC).unwrap();
        nix::pty::grantpt(&master).unwrap();
        nix::pty::unlockpt(&master).unwrap();
        let name = {
            let _naming = NAMING.lock().unwrap();
            // SAFETY: the name is copied out of ptsname's buffer before another call, which the
            // lock keeps out.
            unsafe { nix::pty::ptsname(&master) }.unwrap()
        };
        let slave = nix::fcntl::open(
            name.as_str(),
            OFlag::O_RDWR | OFlag::O_NOCTTY | OFlag::O_CLOEXEC,
            nix::sys::stat::Mode::empty(),
        )
        .unwrap();
        if let Some(size) = size {
            nix::ioctl_write_ptr_bad!(set_window_size, libc::TIOCSWINSZ, nix::pty::Winsize);
            // SAFETY: TIOCSWINSZ reads a winsize for the terminal this function opened.
            unsafe { set_window_size(std::os::fd::AsRawFd::as_raw_fd(&slave), size) }.unwrap();
        }
        nix::pty::OpenptyResult {
            master: master.into(),
            slave,
        }
    }

    /// Both sides of a test terminal are closed on exec, so a child process started while it is
    /// open holds neither.
    #[test]
    fn a_test_terminal_is_never_a_child_s() {
        let pty = open(None);
        for (side, fd) in [("Facade's side", &pty.master), ("the CLI side", &pty.slave)] {
            let flags =
                FdFlag::from_bits_truncate(nix::fcntl::fcntl(fd, FcntlArg::F_GETFD).unwrap());
            assert!(
                flags.contains(FdFlag::FD_CLOEXEC),
                "a child would hold {side}"
            );
        }
    }
}

/// Helpers for tests that change the whole process.
#[cfg(test)]
pub(crate) mod test_process {
    /// Runs the calling test in a child process of this test binary, so that a process-wide change,
    /// such as a file size limit or a broken standard error, cannot reach the tests running
    /// alongside it. The child does not capture output, so what it writes goes to its real standard
    /// error. Returns true in the child, where the test runs.
    pub(crate) fn in_own_process(test: &str) -> bool {
        if std::env::var_os("FACADE_TEST_OWN_PROCESS").is_some() {
            return true;
        }
        let child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([test, "--exact", "--test-threads=1", "--nocapture"])
            .env("FACADE_TEST_OWN_PROCESS", "1")
            .output()
            .unwrap();
        let output = format!(
            "{}{}",
            String::from_utf8_lossy(&child.stdout),
            String::from_utf8_lossy(&child.stderr)
        );
        assert!(
            child.status.success() && output.contains(" 1 passed"),
            "{output}"
        );
        false
    }
}

#[cfg(test)]
pub(crate) mod test_folder {
    use std::ffi::OsStr;
    use std::path::{Path, PathBuf};

    /// A folder for one test, `facade-<name>-<process ID>` in the system's temporary folder. It is
    /// empty when made, and it is removed with everything in it when the test ends, so that test
    /// runs leave nothing behind.
    pub(crate) struct TestFolder(PathBuf);

    impl TestFolder {
        pub(crate) fn new(name: &str) -> TestFolder {
            let path = std::env::temp_dir().join(format!("facade-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).unwrap();
            TestFolder(path)
        }
    }

    impl std::ops::Deref for TestFolder {
        type Target = Path;

        fn deref(&self) -> &Path {
            &self.0
        }
    }

    impl AsRef<Path> for TestFolder {
        fn as_ref(&self) -> &Path {
            &self.0
        }
    }

    impl AsRef<OsStr> for TestFolder {
        fn as_ref(&self) -> &OsStr {
            self.0.as_os_str()
        }
    }

    impl Drop for TestFolder {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}
