//! Tools the unit tests of every part of the daemon share.

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
