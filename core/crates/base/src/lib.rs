//! What Facade's programs share.
//!
//! - Both protocols: the daemon's and the keeper's messages, their framing and errors, and a
//!   blocking daemon client ([`daemon`], [`keeper`], [`jsonrpc`], [`operations`],
//!   [`daemon_client`]).
//! - What differs between operating systems: watching processes, passing descriptors, starting
//!   services, installing programs and the sockets' paths ([`unix_process`], [`descriptors`],
//!   [`service`], [`programs`], [`paths`]).
//! - The settings file ([`settings`]), and the texts a model reads ([`instructions`], [`skill`],
//!   [`tools`]).
//! - Here: which build this is, the Facade home, timestamps and the log line.

mod build;
mod line;
mod platform;
mod protocol;
mod texts;

pub mod log;
pub mod paths;
pub mod process;
pub mod settings;
pub mod time;

pub use build::{
    VERSION, build_id, take_test_build, takes_over, this_program, version, version_of,
};
pub use platform::{descriptors, files, limits, programs, service, unix_process};
pub use protocol::{base64, daemon, daemon_client, jsonrpc, keeper, operations};
pub use texts::{instructions, skill, tools};

/// Eight random bytes from the operating system, for keys and names nobody may guess. Panics if
/// the system cannot give them, which a supported system never fails to, as the standard library
/// does for its own keys.
pub fn random_u64() -> u64 {
    let mut bytes = [0u8; 8];
    // SAFETY: the buffer holds the 8 bytes asked for.
    match unsafe { libc::getentropy(bytes.as_mut_ptr().cast(), bytes.len()) } {
        0 => u64::from_ne_bytes(bytes),
        _ => panic!("no random bytes: {}", std::io::Error::last_os_error()),
    }
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
