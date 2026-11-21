use std::ffi::c_void;
use std::fs::{self, File, Metadata, OpenOptions};
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::{Path, PathBuf};
use std::ptr::{self, null, null_mut};

use anyhow::{Context, ensure};
use windows_sys::Win32::Foundation::{
    GENERIC_READ, GENERIC_WRITE, GetLastError, HANDLE, INVALID_HANDLE_VALUE, LocalFree,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
    GetNamedSecurityInfoW, SDDL_REVISION_1, SE_FILE_OBJECT,
};
use windows_sys::Win32::Security::{
    ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, AdjustTokenPrivileges, DACL_SECURITY_INFORMATION,
    EqualSid, GetAce, GetTokenInformation, ImpersonateSelf, IsWellKnownSid, LUID_AND_ATTRIBUTES,
    LookupPrivilegeValueW, OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, RevertToSelf,
    SE_PRIVILEGE_ENABLED, SE_RESTORE_NAME, SECURITY_ATTRIBUTES, SecurityImpersonation,
    SetKernelObjectSecurity, TOKEN_ACCESS_MASK, TOKEN_ADJUST_PRIVILEGES, TOKEN_GROUPS,
    TOKEN_INFORMATION_CLASS, TOKEN_PRIVILEGES, TOKEN_QUERY, TOKEN_USER, TokenGroups, TokenUser,
    WinBuiltinAdministratorsSid, WinLocalSystemSid,
};
use windows_sys::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, CREATE_NEW, CreateDirectoryW, CreateFileW, FILE_ATTRIBUTE_NORMAL,
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    GetFileInformationByHandle, WRITE_DAC, WRITE_OWNER,
};
use windows_sys::Win32::System::SystemServices::ACCESS_ALLOWED_ACE_TYPE;
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetCurrentThread, OpenProcessToken, OpenThreadToken,
};
use windows_sys::Win32::System::WindowsProgramming::GetUserNameW;

use super::files::Access;

pub fn ssh_account_name() -> anyhow::Result<String> {
    let mut value = [0u16; 257];
    let mut length = value.len() as u32;
    // SAFETY: GetUserNameW receives a writable UTF-16 buffer and reports its length.
    win_ok(unsafe { GetUserNameW(value.as_mut_ptr(), &mut length) })?;
    Ok(String::from_utf16(&value[..length as usize - 1])?)
}

pub(super) fn authorization_path() -> anyhow::Result<(PathBuf, Access)> {
    let groups = token_info(TokenGroups)?;
    // SAFETY: GetTokenInformation filled this aligned buffer with a TOKEN_GROUPS header
    // followed by GroupCount entries whose SID data also lives in the buffer.
    let administrators = unsafe {
        let groups = groups.as_ptr().cast::<TOKEN_GROUPS>();
        let entries = std::slice::from_raw_parts(
            ptr::addr_of!((*groups).Groups).cast(),
            (*groups).GroupCount as usize,
        );
        entries
            .iter()
            .any(|group: &windows_sys::Win32::Security::SID_AND_ATTRIBUTES| {
                IsWellKnownSid(group.Sid, WinBuiltinAdministratorsSid) != 0
            })
    };
    if administrators {
        Ok((
            host_key_directory()?.join("administrators_authorized_keys"),
            Access::Administrators,
        ))
    } else {
        Ok((
            user_ssh_directory()?.join("authorized_keys"),
            Access::Account,
        ))
    }
}

pub(super) fn tilde_ssh_directory() -> anyhow::Result<PathBuf> {
    user_ssh_directory()
}

pub(super) fn user_ssh_directory() -> anyhow::Result<PathBuf> {
    Ok(absolute_env("USERPROFILE")?.join(".ssh"))
}

pub(super) fn host_key_directory() -> anyhow::Result<PathBuf> {
    Ok(absolute_env("ProgramData")?.join("ssh"))
}

fn absolute_env(name: &str) -> anyhow::Result<PathBuf> {
    let path = std::env::var_os(name)
        .map(PathBuf::from)
        .with_context(|| format!("{name} is unset"))?;
    ensure!(path.is_absolute(), "{name} must be an absolute path");
    Ok(path)
}

fn token_info(class: TOKEN_INFORMATION_CLASS) -> io::Result<Vec<usize>> {
    let mut token = null_mut();
    // SAFETY: OpenProcessToken writes an owned token handle on success.
    win_ok(unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) })?;
    // SAFETY: a successful OpenProcessToken returned a handle we own.
    let token = unsafe { OwnedHandle::from_raw_handle(token) };
    let mut length = 0;
    // SAFETY: a null buffer with length zero asks for the necessary size.
    unsafe { GetTokenInformation(token.as_raw_handle(), class, null_mut(), 0, &mut length) };
    if length == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut buffer = vec![0usize; (length as usize).div_ceil(size_of::<usize>())];
    // SAFETY: buffer is aligned and holds at least length writable bytes.
    win_ok(unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            class,
            buffer.as_mut_ptr().cast(),
            length,
            &mut length,
        )
    })?;
    Ok(buffer)
}

fn user_sid(user: &[usize]) -> PSID {
    // SAFETY: callers pass an aligned TokenUser buffer containing a TOKEN_USER.
    unsafe { (*user.as_ptr().cast::<TOKEN_USER>()).User.Sid }
}

/// Owns the LocalAlloc allocation returned by the security APIs.
struct Local(*mut c_void);

impl Drop for Local {
    fn drop(&mut self) {
        // SAFETY: these API results are allocated with LocalAlloc.
        unsafe { LocalFree(self.0) };
    }
}

fn account_sid_string() -> io::Result<String> {
    let user = token_info(TokenUser)?;
    let mut text = null_mut();
    // SAFETY: the SID remains in the TOKEN_USER buffer for the duration of the call.
    win_ok(unsafe { ConvertSidToStringSidW(user_sid(&user), &mut text) })?;
    let _owned = Local(text.cast());
    // SAFETY: ConvertSidToStringSidW returns a NUL-terminated UTF-16 string.
    let length = (0..)
        .find(|&index| unsafe { *text.add(index) } == 0)
        .unwrap();
    Ok(String::from_utf16_lossy(unsafe {
        std::slice::from_raw_parts(text, length)
    }))
}

fn descriptor(access: Access, directory: bool) -> io::Result<Local> {
    let flags = if directory { "OICI" } else { "" };
    let sddl = match access {
        Access::Account => {
            let sid = account_sid_string()?;
            format!("O:{sid}D:P(A;{flags};FA;;;{sid})")
        }
        Access::Administrators => format!("O:BAD:P(A;{flags};FA;;;BA)(A;{flags};FA;;;SY)"),
    };
    let sddl: Vec<u16> = sddl.encode_utf16().chain(Some(0)).collect();
    let mut security = null_mut();
    // SAFETY: sddl is NUL-terminated and the result pointer is writable.
    win_ok(unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut security,
            null_mut(),
        )
    })?;
    Ok(Local(security))
}

fn attributes(descriptor: &Local) -> SECURITY_ATTRIBUTES {
    SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: 0,
    }
}

pub(super) fn create_directory(path: &Path, access: Access) -> io::Result<()> {
    let descriptor = descriptor(access, true)?;
    let name = wide_path(path)?;
    // SAFETY: name is NUL-terminated and attributes reference a live security descriptor.
    win_ok(unsafe { CreateDirectoryW(name.as_ptr(), &attributes(&descriptor)) })
}

pub(super) fn create_file(path: &Path, access: Access) -> io::Result<File> {
    let descriptor = descriptor(access, false)?;
    let name = wide_path(path)?;
    // SAFETY: the path and attributes live across the call. CREATE_NEW never opens an old file.
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            GENERIC_READ | GENERIC_WRITE | WRITE_DAC | WRITE_OWNER,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            &attributes(&descriptor),
            CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: we own the newly created file handle.
    Ok(unsafe { File::from_raw_handle(handle) })
}

struct FileSecurity {
    descriptor: Local,
    owner: PSID,
    dacl: *mut ACL,
}

impl FileSecurity {
    fn read(path: &Path) -> io::Result<Self> {
        let name = wide_path(path)?;
        let mut descriptor = null_mut();
        let mut owner = null_mut();
        let mut dacl = null_mut();
        // SAFETY: the path is NUL-terminated and the output slots are writable.
        let status = unsafe {
            GetNamedSecurityInfoW(
                name.as_ptr(),
                SE_FILE_OBJECT,
                SECURITY,
                &mut owner,
                null_mut(),
                &mut dacl,
                null_mut(),
                &mut descriptor,
            )
        };
        if status != 0 {
            return Err(io::Error::from_raw_os_error(status as i32));
        }
        Ok(Self {
            descriptor: Local(descriptor),
            owner,
            dacl,
        })
    }
}

const SECURITY: u32 = OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION;

pub(super) fn protect_private_key(path: &Path) -> io::Result<()> {
    let file = OpenOptions::new()
        .access_mode(WRITE_DAC | WRITE_OWNER)
        .open(path)?;
    let security = descriptor(Access::Account, false)?;
    set_security(file.as_raw_handle(), security.0, SECURITY)
}

pub(super) fn check_private(path: &Path, directory: bool) -> anyhow::Result<()> {
    check_account_access(path, directory, false)
}

pub(super) fn check_known_hosts_access(path: &Path, directory: bool) -> anyhow::Result<()> {
    check_account_access(path, directory, true)?;
    if !directory {
        OpenOptions::new().read(true).write(true).open(path)?;
    }
    Ok(())
}

pub(super) type KnownHostsFileId = (u32, u32, u32);

pub(super) fn known_hosts_file_id(file: &File) -> io::Result<KnownHostsFileId> {
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: the file handle is live and info can receive the result.
    win_ok(unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) })?;
    Ok((
        info.dwVolumeSerialNumber,
        info.nFileIndexHigh,
        info.nFileIndexLow,
    ))
}

fn check_account_access(path: &Path, directory: bool, known_hosts: bool) -> anyhow::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    ensure!(
        (if directory {
            metadata.is_dir()
        } else {
            metadata.is_file()
        }) && metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0,
        "expected a private SSH file or directory at {}",
        path.display()
    );
    let security = FileSecurity::read(path)?;
    let user = token_info(TokenUser)?;
    // SAFETY: owner and ACL are backed by the descriptor and the account SID by the token buffer.
    let private = unsafe {
        !security.owner.is_null()
            && EqualSid(security.owner, user_sid(&user)) != 0
            && !security.dacl.is_null()
            && (*security.dacl).AceCount != 0
            && (0..u32::from((*security.dacl).AceCount)).all(|index| {
                let mut ace = null_mut();
                if GetAce(security.dacl, index, &mut ace) == 0
                    || (*ace.cast::<ACE_HEADER>()).AceType != ACCESS_ALLOWED_ACE_TYPE as u8
                {
                    return false;
                }
                let sid = ptr::addr_of_mut!((*ace.cast::<ACCESS_ALLOWED_ACE>()).SidStart).cast();
                EqualSid(sid, user_sid(&user)) != 0
                    || (known_hosts
                        && (IsWellKnownSid(sid, WinLocalSystemSid) != 0
                            || IsWellKnownSid(sid, WinBuiltinAdministratorsSid) != 0))
            })
    };
    ensure!(
        private,
        "{} must have a safe SSH account access list",
        path.display(),
    );
    Ok(())
}

pub(super) fn set_replacement_access(
    file: &File,
    original: &Path,
    metadata: &Metadata,
) -> io::Result<()> {
    let original = FileSecurity::read(original)?;
    let handle = file.as_raw_handle();
    if let Err(error) = set_security(handle, original.descriptor.0, SECURITY) {
        // An elevated administrator may need SeRestorePrivilege to preserve a SYSTEM owner.
        if !matches!(error.raw_os_error(), Some(5 | 1307 | 1314)) {
            return Err(error);
        }
        let _restore = RestorePrivilege::enable()?;
        set_security(handle, original.descriptor.0, SECURITY)?;
    }
    file.set_permissions(metadata.permissions())
}

fn set_security(
    handle: HANDLE,
    descriptor: PSECURITY_DESCRIPTOR,
    information: u32,
) -> io::Result<()> {
    // SAFETY: the caller keeps the file handle and descriptor alive.
    win_ok(unsafe { SetKernelObjectSecurity(handle, information, descriptor) })
}

/// Changes only this thread's token while preserving an existing Windows file owner.
struct RestorePrivilege;

impl RestorePrivilege {
    fn enable() -> io::Result<Self> {
        // SAFETY: ImpersonateSelf attaches a copy of the process's token to this thread.
        win_ok(unsafe { ImpersonateSelf(SecurityImpersonation) })?;
        let guard = Self;
        let mut token = null_mut();
        let access: TOKEN_ACCESS_MASK = TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY;
        // SAFETY: the output slot holds an owned handle on success.
        win_ok(unsafe { OpenThreadToken(GetCurrentThread(), access, 1, &mut token) })?;
        // SAFETY: OpenThreadToken returned a handle we own.
        let token = unsafe { OwnedHandle::from_raw_handle(token) };
        let mut privilege = LUID_AND_ATTRIBUTES {
            Attributes: SE_PRIVILEGE_ENABLED,
            ..Default::default()
        };
        // SAFETY: the output LUID slot is writable and SE_RESTORE_NAME is NUL-terminated.
        win_ok(unsafe { LookupPrivilegeValueW(null(), SE_RESTORE_NAME, &mut privilege.Luid) })?;
        let privileges = TOKEN_PRIVILEGES {
            PrivilegeCount: 1,
            Privileges: [privilege],
        };
        // SAFETY: the token and its single-entry privileges structure are live.
        win_ok(unsafe {
            AdjustTokenPrivileges(
                token.as_raw_handle(),
                0,
                &privileges,
                0,
                null_mut(),
                null_mut(),
            )
        })?;
        // SAFETY: AdjustTokenPrivileges may report a missing privilege even when it returns true.
        let status = unsafe { GetLastError() };
        if status != 0 {
            return Err(io::Error::from_raw_os_error(status as i32));
        }
        Ok(guard)
    }
}

impl Drop for RestorePrivilege {
    fn drop(&mut self) {
        // SAFETY: this thread successfully impersonated itself in enable.
        if unsafe { RevertToSelf() } == 0 {
            std::process::abort();
        }
    }
}

fn wide_path(path: &Path) -> io::Result<Vec<u16>> {
    let name: Vec<u16> = path.as_os_str().encode_wide().collect();
    if name.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "SSH path contains NUL",
        ));
    }
    Ok(name.into_iter().chain(Some(0)).collect())
}

fn win_ok(result: i32) -> io::Result<()> {
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}
