//! What Facade's programs share.
//!
//! - Both protocols: the daemon's and the keeper's messages, their framing and errors, and a
//!   blocking daemon client ([`daemon`], [`keeper`], [`jsonrpc`], [`operations`],
//!   [`daemon_client`]).
//! - What differs between operating systems: which one this is, watching processes, terminals,
//!   the services' sockets and start, installing programs, private files and the person's
//!   console ([`system`], [`unix_process`], [`terminal`], [`terminal_lines`], [`sockets`],
//!   [`service`], [`programs`], [`files`], [`console`], [`paths`]).
//! - The settings file ([`settings`]), and the texts a model reads ([`instructions`], [`skill`],
//!   [`tools`]).
//! - Here: which build this is, the Facade home, timestamps and the log line.

mod build;
mod line;
mod platform;
mod protocol;
mod texts;
mod whitespace;

pub mod key_input;
pub mod log;
pub mod paths;
pub mod process;
pub mod settings;
pub mod start;
pub mod time;

pub use build::{
    TEST_BUILD_SUFFIX, VERSION, build_id, build_version, take_test_build, takes_over, this_program,
    version, version_of,
};
pub use platform::modules::*;
pub use protocol::{address, base64, daemon, daemon_client, jsonrpc, keeper, machine, operations};
pub use protocol::{api_v1, v3};
pub use texts::{instructions, skill, tools};

/// Eight random bytes from the operating system, for keys and names nobody may guess. Panics if
/// the system cannot give them, which a supported system never fails to, as the standard library
/// does for its own keys.
pub fn random_u64() -> u64 {
    platform::random_u64()
}

#[cfg(test)]
#[test]
fn two_random_numbers_differ() {
    assert_ne!(random_u64(), random_u64());
}

/// A temporary folder that one test owns.
#[cfg(test)]
pub(crate) mod test_folder {
    use std::ffi::OsStr;
    use std::path::{Path, PathBuf};

    /// An empty folder named for the test and this process, under the system's temporary folder,
    /// removed with what it holds once the test drops it.
    pub(crate) struct TestFolder(PathBuf);

    impl TestFolder {
        pub(crate) fn new(name: &str) -> TestFolder {
            let folder = std::env::temp_dir().join(format!("facade-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&folder);
            std::fs::create_dir_all(&folder).unwrap();
            TestFolder(folder)
        }
    }

    impl Drop for TestFolder {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
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
}
