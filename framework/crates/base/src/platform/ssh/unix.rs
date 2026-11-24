use std::ffi::{CStr, OsStr};
use std::fs::{self, DirBuilder, File, Metadata, OpenOptions, Permissions};
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::ptr;

use anyhow::{Context, ensure};

use super::files::Access;

pub fn ssh_account_name() -> anyhow::Result<String> {
    with_account(|account| {
        // SAFETY: a successful passwd result contains a NUL-terminated account name.
        let name = unsafe { CStr::from_ptr(account.pw_name) }.to_str()?;
        Ok(name.to_owned())
    })
}

pub(super) fn tilde_ssh_directory() -> anyhow::Result<PathBuf> {
    with_account(|account| {
        // SAFETY: the home directory string belongs to the live passwd record.
        let home = unsafe { CStr::from_ptr(account.pw_dir) }.to_bytes();
        Ok(Path::new(OsStr::from_bytes(home)).join(".ssh"))
    })
}

fn with_account<T>(read: impl FnOnce(&libc::passwd) -> anyhow::Result<T>) -> anyhow::Result<T> {
    let mut buffer = vec![0; 16 * 1024];
    let mut record = std::mem::MaybeUninit::<libc::passwd>::uninit();
    let mut result = ptr::null_mut();
    // SAFETY: record and buffer are writable, and the result points into them on success.
    let status = unsafe {
        libc::getpwuid_r(
            libc::geteuid(),
            record.as_mut_ptr(),
            buffer.as_mut_ptr(),
            buffer.len(),
            &mut result,
        )
    };
    if status != 0 {
        return Err(io::Error::from_raw_os_error(status)).context("resolving the SSH account");
    }
    ensure!(
        !result.is_null(),
        "the SSH account has no system user record"
    );
    // SAFETY: the non-null result points to the filled record and buffer above.
    read(unsafe { &*result })
}

pub(super) fn authorization_path() -> anyhow::Result<(PathBuf, Access)> {
    Ok((
        user_ssh_directory()?.join("authorized_keys"),
        Access::Account,
    ))
}

pub(super) fn user_ssh_directory() -> anyhow::Result<PathBuf> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .context("HOME is unset")?;
    ensure!(home.is_absolute(), "HOME must be an absolute path");
    Ok(home.join(".ssh"))
}

pub(super) fn host_key_directory() -> anyhow::Result<PathBuf> {
    Ok(PathBuf::from("/etc/ssh"))
}

pub(super) fn create_directory(path: &Path, _access: Access) -> io::Result<()> {
    DirBuilder::new().mode(0o700).create(path)
}

pub(super) fn create_file(path: &Path, _access: Access) -> io::Result<File> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
}

pub(super) fn protect_private_key(path: &Path) -> io::Result<()> {
    fs::set_permissions(path, Permissions::from_mode(0o600))
}

pub(super) fn check_private(path: &Path, directory: bool) -> anyhow::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    // SAFETY: geteuid has no preconditions.
    let uid = unsafe { libc::geteuid() };
    ensure!(
        (if directory {
            metadata.is_dir()
        } else {
            metadata.is_file()
        }) && metadata.uid() == uid
            && metadata.mode() & 0o777 == if directory { 0o700 } else { 0o600 },
        "{} must be private to the current account",
        path.display()
    );
    Ok(())
}

pub(super) fn check_known_hosts_access(path: &Path, directory: bool) -> anyhow::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    // SAFETY: geteuid has no preconditions.
    let uid = unsafe { libc::geteuid() };
    let owner_access = if directory { 0o700 } else { 0o600 };
    ensure!(
        (if directory {
            metadata.is_dir()
        } else {
            metadata.is_file()
        }) && metadata.uid() == uid
            && metadata.mode() & (owner_access | 0o022) == owner_access,
        "{} must be writable by the SSH account and protected from other users' writes",
        path.display()
    );
    Ok(())
}

pub(super) type KnownHostsFileId = (u64, u64);

pub(super) fn known_hosts_file_id(file: &File) -> io::Result<KnownHostsFileId> {
    let metadata = file.metadata()?;
    Ok((metadata.dev(), metadata.ino()))
}

pub(super) fn set_replacement_access(
    file: &File,
    original: &Path,
    metadata: &Metadata,
) -> io::Result<()> {
    let current = file.metadata()?;
    if (current.uid(), current.gid()) != (metadata.uid(), metadata.gid())
        // SAFETY: the temporary file is held open.
        && unsafe { libc::fchown(file.as_raw_fd(), metadata.uid(), metadata.gid()) } != 0
    {
        return Err(io::Error::last_os_error());
    }
    file.set_permissions(metadata.permissions())?;
    copy_acl(&File::open(original)?, file)
}

#[cfg(target_os = "linux")]
fn copy_acl(original: &File, replacement: &File) -> io::Result<()> {
    let key = c"system.posix_acl_access";
    // SAFETY: a null buffer with size zero asks for the attribute length.
    let size = unsafe { libc::fgetxattr(original.as_raw_fd(), key.as_ptr(), ptr::null_mut(), 0) };
    if size < 0 {
        let error = io::Error::last_os_error();
        if matches!(error.raw_os_error(), Some(libc::ENODATA | libc::ENOTSUP)) {
            return Ok(());
        }
        return Err(error);
    }
    let mut value = vec![0u8; size as usize];
    // SAFETY: value holds size writable bytes; both files are open.
    let size = unsafe {
        libc::fgetxattr(
            original.as_raw_fd(),
            key.as_ptr(),
            value.as_mut_ptr().cast(),
            value.len(),
        )
    };
    if size < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: fgetxattr wrote size bytes to value.
    if unsafe {
        libc::fsetxattr(
            replacement.as_raw_fd(),
            key.as_ptr(),
            value.as_ptr().cast(),
            size as usize,
            0,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn copy_acl(original: &File, replacement: &File) -> io::Result<()> {
    // SAFETY: the descriptors are open; a null state uses copyfile's default state.
    if unsafe {
        libc::fcopyfile(
            original.as_raw_fd(),
            replacement.as_raw_fd(),
            ptr::null_mut(),
            libc::COPYFILE_ACL,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
