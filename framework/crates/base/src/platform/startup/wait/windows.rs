//! Windows waits for service lock and startup record directory changes.

use std::io;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_NOTIFY_CHANGE_DIR_NAME, FILE_NOTIFY_CHANGE_FILE_NAME, FILE_NOTIFY_CHANGE_LAST_WRITE,
    FindCloseChangeNotification, FindFirstChangeNotificationW, FindNextChangeNotification,
};
use windows_sys::Win32::System::Threading::WaitForSingleObject;

pub(super) struct DirectoryChanges {
    change: Change,
    startup_path: Option<PathBuf>,
}

impl DirectoryChanges {
    pub(super) fn open(framework: &Path) -> io::Result<Self> {
        let path = framework.canonicalize()?;
        let startup_path = path.join("startup");
        if let Ok(change) = Change::open(&startup_path, true) {
            return Ok(Self {
                change,
                startup_path: None,
            });
        }
        Ok(Self {
            change: Change::open(&path, false)?,
            startup_path: Some(startup_path),
        })
    }

    pub(super) fn wait(&mut self, deadline: Instant) -> io::Result<bool> {
        let timeout = deadline.saturating_duration_since(Instant::now());
        let millis = u32::try_from(timeout.as_nanos().div_ceil(1_000_000)).unwrap_or(u32::MAX - 1);
        // SAFETY: the notification handle stays open until the wait returns.
        match unsafe { WaitForSingleObject(self.change.0, millis) } {
            WAIT_TIMEOUT => return Ok(false),
            WAIT_OBJECT_0 => {}
            _ => return Err(io::Error::last_os_error()),
        }
        // A publication creates a temporary file and renames it. Observe the whole batch together.
        std::thread::sleep(
            Duration::from_millis(50).min(deadline.saturating_duration_since(Instant::now())),
        );
        if let Some(path) = &self.startup_path
            && let Ok(change) = Change::open(path, true)
        {
            self.change = change;
            self.startup_path = None;
        } else {
            self.change.rearm()?;
        }
        Ok(true)
    }
}

struct Change(HANDLE);

impl Change {
    fn open(path: &Path, subtree: bool) -> io::Result<Self> {
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
        let names = FILE_NOTIFY_CHANGE_DIR_NAME | FILE_NOTIFY_CHANGE_FILE_NAME;
        let filter = if subtree {
            names
        } else {
            names | FILE_NOTIFY_CHANGE_LAST_WRITE
        };
        // SAFETY: the path is an owned, null-terminated absolute Windows path.
        let handle =
            unsafe { FindFirstChangeNotificationW(wide.as_ptr(), i32::from(subtree), filter) };
        if handle == INVALID_HANDLE_VALUE {
            Err(io::Error::last_os_error())
        } else {
            Ok(Self(handle))
        }
    }

    fn rearm(&self) -> io::Result<()> {
        // SAFETY: the wait just reported a pending directory change on this live handle.
        if unsafe { FindNextChangeNotification(self.0) } == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
}

impl Drop for Change {
    fn drop(&mut self) {
        // SAFETY: this is the only owner of the notification handle.
        unsafe { FindCloseChangeNotification(self.0) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn watches_a_startup_directory_created_after_the_wait_is_armed() {
        struct Home(PathBuf);
        impl Drop for Home {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let home = Home(
            std::env::temp_dir().join(format!("facade-startup-wake-{:016x}", crate::random_u64())),
        );
        std::fs::create_dir(&home.0).unwrap();
        let mut observation = DirectoryChanges::open(&home.0).unwrap();
        let until = || Instant::now() + Duration::from_secs(3);
        std::fs::write(home.0.join("daemon.lock"), b"lock holder").unwrap();
        assert!(observation.wait(until()).unwrap());
        let startup = home.0.join("startup");
        std::fs::create_dir(&startup).unwrap();
        assert!(observation.wait(until()).unwrap());

        std::fs::write(startup.join("window.tmp"), b"progress").unwrap();
        std::fs::rename(startup.join("window.tmp"), startup.join("window")).unwrap();
        assert!(observation.wait(until()).unwrap());
    }
}
