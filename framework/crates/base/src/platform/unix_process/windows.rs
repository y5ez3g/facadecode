//! Processes on Windows. A process's birth is its creation time from `GetProcessTimes`, a decimal
//! count of 100-nanosecond intervals since 1601-01-01. Its parent and name come from a Toolhelp
//! snapshot, its environment from its process environment block, and its end from a wait
//! completion packet on a completion port.

use std::ffi::{OsString, c_void};
use std::io;
use std::os::windows::ffi::OsStringExt;
use std::os::windows::io::{AsHandle, AsRawHandle, BorrowedHandle, FromRawHandle, OwnedHandle};
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use windows_sys::Wdk::System::Threading::{NtQueryInformationProcess, ProcessBasicInformation};
use windows_sys::Win32::Foundation::{
    ERROR_INVALID_PARAMETER, FILETIME, HANDLE, INVALID_HANDLE_VALUE, NTSTATUS,
    RtlNtStatusToDosError, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::System::Diagnostics::Debug::ReadProcessMemory;
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
use windows_sys::Win32::System::SystemInformation::GetTickCount64;
use windows_sys::Win32::System::Threading::{
    GetExitCodeProcess, GetProcessTimes, OpenProcess, PROCESS_BASIC_INFORMATION,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_VM_READ,
    QueryFullProcessImageNameW, WaitForSingleObject,
};

use super::{Observed, PROC_POLL_INTERVAL, Presence, ProcessObservation};
use crate::process::{ProcessExit, ProcessIdentity};

/// The birth value of process `pid`; None where no process has that ID.
pub fn birth(pid: u32) -> io::Result<Option<String>> {
    let Some(process) = open(pid, PROCESS_QUERY_LIMITED_INFORMATION)? else {
        return Ok(None);
    };
    birth_of(process.as_handle()).map(Some)
}

pub(super) fn started_at(birth: &str) -> Option<SystemTime> {
    const UNIX_EPOCH_TICKS: u64 = 116_444_736_000_000_000;
    const TICKS_PER_SECOND: u64 = 10_000_000;

    let ticks = birth.parse::<u64>().ok()?.checked_sub(UNIX_EPOCH_TICKS)?;
    let elapsed = Duration::from_secs(ticks / TICKS_PER_SECOND)
        + Duration::from_nanos(ticks % TICKS_PER_SECOND * 100);
    SystemTime::UNIX_EPOCH.checked_add(elapsed)
}

/// Whether the process `identity` still runs. One the system no longer has, one born at another
/// moment, and one that exited have ended.
pub fn presence(identity: &ProcessIdentity) -> io::Result<Presence> {
    let access = PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE;
    let Some(process) = open(identity.pid, access)? else {
        return Ok(Presence::Ended);
    };
    if birth_of(process.as_handle())? != identity.birth || has_ended(process.as_handle())? {
        return Ok(Presence::Ended);
    }
    Ok(Presence::Running)
}

/// Nanoseconds on this machine's clock that does not jump, the clock of stop deadlines, the same
/// in every process.
pub fn monotonic_now() -> u64 {
    let (mut count, mut frequency) = (0i64, 0i64);
    // SAFETY: each call writes one i64; both succeed on every supported Windows.
    unsafe {
        QueryPerformanceCounter(&mut count);
        QueryPerformanceFrequency(&mut frequency);
    }
    let nanoseconds = count as u128 * 1_000_000_000 / frequency.max(1) as u128;
    u64::try_from(nanoseconds).unwrap_or(u64::MAX)
}

impl ProcessObservation {
    /// Starts watching the process `identity`, opened with the access a wait and its exit code
    /// need. One the system no longer has, or one born at another moment, has ended.
    pub fn open(identity: &ProcessIdentity) -> io::Result<Observed> {
        let access = PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE;
        let Some(process) = open(identity.pid, access)? else {
            return Ok(Observed::Ended);
        };
        if birth_of(process.as_handle())? != identity.birth {
            return Ok(Observed::Ended);
        }
        Ok(Observed::Watching(ProcessObservation {
            identity: identity.clone(),
            process,
        }))
    }

    /// Whether the process has ended, without waiting.
    pub fn ended(&self) -> io::Result<Option<bool>> {
        has_ended(self.process.as_handle()).map(Some)
    }

    /// Waits up to `timeout` for the process to end, and returns whether it did.
    pub fn wait(&self, timeout: Duration) -> io::Result<bool> {
        let milliseconds = u32::try_from(timeout.as_millis()).unwrap_or(u32::MAX - 1);
        wait_for(self.process.as_handle(), milliseconds.min(u32::MAX - 1))
    }

    /// The process's exit once it ended; None while it runs. For the keeper.
    pub fn exit(&self) -> io::Result<Option<ProcessExit>> {
        if !has_ended(self.process.as_handle())? {
            return Ok(None);
        }
        let mut code = 0u32;
        // SAFETY: the handle is open with PROCESS_QUERY_LIMITED_INFORMATION; code is writable.
        if unsafe { GetExitCodeProcess(self.process.as_raw_handle(), &mut code) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Some(ProcessExit {
            code: Some(code as i32),
            signal: None,
            reason: None,
            at: crate::time::iso_now(),
        }))
    }

    /// Returns once the process ended, through a wait completion packet on the terminal I/O
    /// thread's completion port. Needs a tokio runtime.
    pub async fn until_ended(&self) {
        let ended = crate::platform::io_thread::process_end(self.as_handle()).await;
        if ended.is_err() {
            while !matches!(self.ended(), Ok(Some(true))) {
                tokio::time::sleep(PROC_POLL_INTERVAL).await;
            }
        }
    }
}

impl AsHandle for ProcessObservation {
    fn as_handle(&self) -> BorrowedHandle<'_> {
        self.process.as_handle()
    }
}

pub(super) fn parent(pid: u32) -> io::Result<Option<u32>> {
    Ok(listed(pid)?.map(|entry| entry.th32ParentProcessID))
}

pub(super) fn executable(pid: u32) -> io::Result<Option<PathBuf>> {
    let Some(process) = open(pid, PROCESS_QUERY_LIMITED_INFORMATION)? else {
        return Ok(None);
    };
    let mut path = vec![0; 32768];
    let mut length = path.len() as u32;
    // SAFETY: path holds length UTF-16 units and the handle allows querying the image.
    if unsafe {
        QueryFullProcessImageNameW(
            process.as_raw_handle(),
            0,
            path.as_mut_ptr(),
            &raw mut length,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(Some(PathBuf::from(OsString::from_wide(
        &path[..length as usize],
    ))))
}

/// The image's file name without `.exe`.
pub(super) fn name(pid: u32) -> io::Result<Option<String>> {
    Ok(listed(pid)?.map(|entry| {
        let length = entry.szExeFile.iter().position(|&unit| unit == 0);
        let name =
            String::from_utf16_lossy(&entry.szExeFile[..length.unwrap_or(entry.szExeFile.len())]);
        match name.len().checked_sub(4) {
            Some(stem) if name[stem..].eq_ignore_ascii_case(".exe") => name[..stem].to_string(),
            _ => name,
        }
    }))
}

/// The entries of the process environment block of process `pid`, each in UTF-8, leaving out
/// those that are not valid UTF-16.
pub(super) fn environment(pid: u32) -> io::Result<Vec<Vec<u8>>> {
    let access = PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ;
    let Some(process) = open(pid, access)? else {
        return Err(io::Error::from(io::ErrorKind::NotFound));
    };
    let process = process.as_raw_handle();
    // SAFETY: an all-zero PROCESS_BASIC_INFORMATION is valid.
    let mut basic: PROCESS_BASIC_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: basic is writable storage of the size given.
    nt_result(unsafe {
        NtQueryInformationProcess(
            process,
            ProcessBasicInformation,
            (&raw mut basic).cast(),
            size_of::<PROCESS_BASIC_INFORMATION>() as u32,
            std::ptr::null_mut(),
        )
    })?;
    // The 64-bit layouts: the PEB's ProcessParameters, then RTL_USER_PROCESS_PARAMETERS'
    // Environment and EnvironmentSize.
    let peb = basic.PebBaseAddress as usize;
    let parameters = read_word(process, peb + 0x20)?;
    let block = read_word(process, parameters + 0x80)?;
    let size = read_word(process, parameters + 0x3F0)?;
    let mut bytes = vec![0u8; size];
    read_memory(process, block, &mut bytes)?;
    let units: Vec<u16> = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|&unit| u16::from_le_bytes(unit))
        .collect();
    Ok(units
        .split(|&unit| unit == 0)
        .take_while(|entry| !entry.is_empty())
        .filter_map(|entry| String::from_utf16(entry).ok())
        .map(String::into_bytes)
        .collect())
}

/// When this machine last started: now less the milliseconds since it started.
pub(super) fn boot_time() -> Option<SystemTime> {
    // SAFETY: GetTickCount64 has no preconditions.
    let since = Duration::from_millis(unsafe { GetTickCount64() });
    SystemTime::now().checked_sub(since)
}

/// Process `pid` opened with `access`; None where no process has that ID.
fn open(pid: u32, access: u32) -> io::Result<Option<OwnedHandle>> {
    // SAFETY: OpenProcess returns a new handle or null.
    let raw = unsafe { OpenProcess(access, 0, pid) };
    if raw.is_null() {
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) {
            return Ok(None);
        }
        return Err(error);
    }
    // SAFETY: raw is a handle OpenProcess just returned and nothing else owns.
    Ok(Some(unsafe { OwnedHandle::from_raw_handle(raw) }))
}

/// The birth value of `process`: its creation time in 100-nanosecond intervals since 1601.
fn birth_of(process: BorrowedHandle<'_>) -> io::Result<String> {
    let zero = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
    // SAFETY: the handle is open with PROCESS_QUERY_LIMITED_INFORMATION; each FILETIME is writable.
    let read = unsafe {
        GetProcessTimes(
            process.as_raw_handle(),
            &mut created,
            &mut exited,
            &mut kernel,
            &mut user,
        )
    };
    if read == 0 {
        return Err(io::Error::last_os_error());
    }
    let ticks = (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
    Ok(ticks.to_string())
}

fn has_ended(process: BorrowedHandle<'_>) -> io::Result<bool> {
    wait_for(process, 0)
}

/// Waits up to `milliseconds` for `process`, open with SYNCHRONIZE, to end.
fn wait_for(process: BorrowedHandle<'_>, milliseconds: u32) -> io::Result<bool> {
    // SAFETY: the handle is open with SYNCHRONIZE.
    match unsafe { WaitForSingleObject(process.as_raw_handle(), milliseconds) } {
        WAIT_OBJECT_0 => Ok(true),
        WAIT_TIMEOUT => Ok(false),
        _ => Err(io::Error::last_os_error()),
    }
}

/// Process `pid`'s entry in a Toolhelp snapshot; None where it has none.
fn listed(pid: u32) -> io::Result<Option<PROCESSENTRY32W>> {
    // SAFETY: CreateToolhelp32Snapshot returns a new handle or INVALID_HANDLE_VALUE.
    let raw = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if raw == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: raw is a handle the call just returned and nothing else owns.
    let snapshot = unsafe { OwnedHandle::from_raw_handle(raw) };
    // SAFETY: an all-zero PROCESSENTRY32W is valid.
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
    // SAFETY: the snapshot is open and entry is writable with its size set.
    let mut more = unsafe { Process32FirstW(snapshot.as_raw_handle(), &mut entry) } != 0;
    while more {
        if entry.th32ProcessID == pid {
            return Ok(Some(entry));
        }
        // SAFETY: as above.
        more = unsafe { Process32NextW(snapshot.as_raw_handle(), &mut entry) } != 0;
    }
    Ok(None)
}

/// The pointer-sized word at `address` in `process`.
fn read_word(process: HANDLE, address: usize) -> io::Result<usize> {
    let mut word = [0u8; size_of::<usize>()];
    read_memory(process, address, &mut word)?;
    Ok(usize::from_ne_bytes(word))
}

/// Fills `buf` from `address` in `process`.
fn read_memory(process: HANDLE, address: usize, buf: &mut [u8]) -> io::Result<()> {
    let mut read = 0usize;
    // SAFETY: the handle is open with PROCESS_VM_READ; buf is writable for its length.
    let done = unsafe {
        ReadProcessMemory(
            process,
            address as *const c_void,
            buf.as_mut_ptr().cast(),
            buf.len(),
            &mut read,
        )
    };
    if done == 0 {
        return Err(io::Error::last_os_error());
    }
    if read != buf.len() {
        return Err(io::Error::from(io::ErrorKind::UnexpectedEof));
    }
    Ok(())
}

/// An NTSTATUS as a result, with the Windows error it maps to.
fn nt_result(status: NTSTATUS) -> io::Result<()> {
    if status >= 0 {
        return Ok(());
    }
    // SAFETY: RtlNtStatusToDosError has no preconditions.
    let code = unsafe { RtlNtStatusToDosError(status) };
    Err(io::Error::from_raw_os_error(code as i32))
}
