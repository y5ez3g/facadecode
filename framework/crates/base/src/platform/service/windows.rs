//! The services on Windows: their home, locks, start and the checks on each side of their link.

use std::ffi::OsString;
use std::fs::{File, OpenOptions};
use std::io::{self, PipeReader, Read, Write};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{
    AsHandle, AsRawHandle, BorrowedHandle, FromRawHandle, IntoRawHandle, OwnedHandle,
};
use std::os::windows::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::ExitStatus;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{
    ERROR_BROKEN_PIPE, ERROR_LOCK_VIOLATION, GetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT,
    SetHandleInformation, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::Storage::FileSystem::{
    LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY, LockFileEx,
};
use windows_sys::Win32::System::Console::{
    GetStdHandle, STD_ERROR_HANDLE, STD_OUTPUT_HANDLE, SetStdHandle,
};
use windows_sys::Win32::System::IO::OVERLAPPED;
use windows_sys::Win32::System::Pipes::{
    GetNamedPipeClientProcessId, GetNamedPipeServerProcessId, PeekNamedPipe,
};
use windows_sys::Win32::System::Threading::{
    CREATE_UNICODE_ENVIRONMENT, CreateProcessW, DETACHED_PROCESS, DeleteProcThreadAttributeList,
    EXTENDED_STARTUPINFO_PRESENT, GetCurrentProcess, GetExitCodeProcess, INFINITE,
    InitializeProcThreadAttributeList, LPPROC_THREAD_ATTRIBUTE_LIST,
    PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROCESS_INFORMATION, STARTF_USESTDHANDLES, STARTUPINFOEXW,
    UpdateProcThreadAttribute, WaitForSingleObject,
};

use super::{Candidate, Locked, STARTUP_CHANNEL, Service, StartupChannel};
use crate::platform::socket_paths::ClientSocket;
use crate::platform::unix_process::{birth, fork_lock, own_identity};
use crate::process::ProcessIdentity;

/// How often a start's channel is checked for its report.
const REPORT_CHECK_INTERVAL: Duration = Duration::from_millis(10);

/// Makes the home and its `framework/` and `framework/logs/` where they are missing, and returns `framework/`.
/// They inherit their folders' access lists.
pub fn create_private_home() -> anyhow::Result<PathBuf> {
    let framework = crate::paths::facade_home()?.join("framework");
    std::fs::create_dir_all(framework.join("logs"))?;
    Ok(framework)
}

/// Takes `service`'s lock without waiting (`LockFileEx`). Where this process gets it, writes this
/// process's identity into the lock file as one JSON line, and holds the lock until this process
/// exits.
///
/// The lock is on one byte far past the record, so that others can read the record meanwhile: a
/// Windows lock keeps every other handle from reading what it covers.
pub fn lock_home(framework: &Path, service: Service) -> anyhow::Result<Locked> {
    let path = framework.join(service.lock_name());
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)?;
    // SAFETY: an all-zero OVERLAPPED is valid; it gives the lock's offset.
    let mut at: OVERLAPPED = unsafe { std::mem::zeroed() };
    at.Anonymous.Anonymous.OffsetHigh = u32::MAX;
    let flags = LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY;
    // SAFETY: the file is open and `at` outlives the call, which does not wait.
    if unsafe { LockFileEx(file.as_raw_handle(), flags, 0, 1, 0, &mut at) } == 0 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(ERROR_LOCK_VIOLATION as i32) {
            return Ok(Locked::Contended);
        }
        anyhow::bail!("could not lock {}: {error}", path.display());
    }
    let mut record = serde_json::to_vec(&own_identity()?)?;
    record.push(b'\n');
    file.set_len(0)?;
    file.write_all(&record)?;
    file.sync_data()?;
    // Never let go here: the system lets go of the lock when this process ends, after every task
    // that writes the home's files.
    std::mem::forget(file);
    Ok(Locked::Held)
}

/// The identity in `service`'s lock file; None where the file is missing, empty or incomplete.
pub fn lock_record(framework: &Path, service: Service) -> io::Result<Option<ProcessIdentity>> {
    let mut file = match File::open(framework.join(service.lock_name())) {
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        opened => opened?,
    };
    let mut text = Vec::new();
    file.read_to_end(&mut text)?;
    Ok(serde_json::from_slice(&text).ok())
}

/// Points this process's standard error at `file`, appended to and made where it is missing.
pub fn redirect_stderr(file: &Path) -> io::Result<()> {
    static REBOUND_STDERR: Mutex<Option<OwnedHandle>> = Mutex::new(None);

    let log = OpenOptions::new().append(true).create(true).open(file)?;
    let _stderr = io::stderr().lock();
    let mut installed = REBOUND_STDERR.lock().unwrap();
    // SAFETY: these queries only read the process's standard handle slots.
    let (stderr, stdout) = unsafe {
        (
            GetStdHandle(STD_ERROR_HANDLE),
            GetStdHandle(STD_OUTPUT_HANDLE),
        )
    };
    // SAFETY: log remains open through the call and is retained on success.
    if unsafe { SetStdHandle(STD_ERROR_HANDLE, log.as_raw_handle()) } == 0 {
        return Err(io::Error::last_os_error());
    }
    if let Some(previous) = installed.replace(log.into())
        && (previous.as_raw_handle() != stderr || previous.as_raw_handle() == stdout)
    {
        // The previous handle can still be in use. Close only our displaced stderr-only handle.
        let _ = previous.into_raw_handle();
    }
    Ok(())
}

/// Starts `program`, a `facade.exe`, as `program <service> <words>`: detached, without a window,
/// its output appended to its log, with a startup channel, inheriting those two handles alone.
pub fn launch(service: Service, program: &Path, words: &[&str]) -> anyhow::Result<Candidate> {
    let framework = create_private_home()?;
    let log_path = framework.join("logs").join(service.log_name());
    let log = OpenOptions::new()
        .append(true)
        .create(true)
        .open(log_path)?;
    let _forks = fork_lock();
    let (channel, their_end) = std::io::pipe()?;
    let inherited = [log.as_raw_handle(), their_end.as_raw_handle()];
    for handle in inherited {
        // SAFETY: the handle is open; only its inheritance changes.
        if unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) } == 0 {
            return Err(io::Error::last_os_error().into());
        }
    }
    let mut line = quoted(&program.to_string_lossy());
    for word in [service.command()].iter().chain(words) {
        line.push(' ');
        line.push_str(&quoted(word));
    }
    let channel_value = (their_end.as_raw_handle() as usize).to_string();
    let child = spawn(program, &line, &channel_value, &inherited, &framework)?;
    drop(their_end);
    drop(log);
    Ok(Candidate {
        child,
        channel: Some(channel),
        received: Vec::new(),
    })
}

/// Starts `program` with the command line `line`, this process's environment and the startup
/// channel `channel`, detached, its output on `inherited[0]`, inheriting `inherited` alone.
/// Starts `program` with the command line `line` in the folder `folder`, which Windows then holds
/// open for as long as the service runs: the home's `framework/`, never the caller's folder.
fn spawn(
    program: &Path,
    line: &str,
    channel: &str,
    inherited: &[HANDLE; 2],
    folder: &Path,
) -> io::Result<Child> {
    let mut size = 0usize;
    // SAFETY: a size query with no list.
    unsafe { InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut size) };
    let mut list_buffer = vec![0u64; size.div_ceil(8)];
    let list: LPPROC_THREAD_ATTRIBUTE_LIST = list_buffer.as_mut_ptr().cast();
    // SAFETY: the buffer holds `size` bytes, aligned.
    if unsafe { InitializeProcThreadAttributeList(list, 1, 0, &mut size) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let list = AttributeList(list);
    // SAFETY: `inherited` outlives the list's use in CreateProcessW below.
    let updated = unsafe {
        UpdateProcThreadAttribute(
            list.0,
            0,
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
            inherited.as_ptr().cast(),
            size_of_val(inherited),
            std::ptr::null_mut(),
            std::ptr::null(),
        )
    };
    if updated == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: an all-zero STARTUPINFOEXW is valid; its size and fields are set below.
    let mut startup: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdOutput = inherited[0];
    startup.StartupInfo.hStdError = inherited[0];
    startup.lpAttributeList = list.0;
    let application: Vec<u16> = program.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut command: Vec<u16> = line.encode_utf16().chain(Some(0)).collect();
    let folder: Vec<u16> = folder.as_os_str().encode_wide().chain(Some(0)).collect();
    let environment = environment_block(channel);
    // SAFETY: an all-zero PROCESS_INFORMATION is valid; CreateProcessW fills it.
    let mut started: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    let flags = DETACHED_PROCESS | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT;
    // SAFETY: every string is NUL-terminated, the environment block ends with two NULs, and every
    // pointer outlives the call.
    let created = unsafe {
        CreateProcessW(
            application.as_ptr(),
            command.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
            flags,
            environment.as_ptr().cast(),
            folder.as_ptr(),
            &startup.StartupInfo,
            &mut started,
        )
    };
    if created == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: CreateProcessW made both handles, which nothing else owns.
    let (process, _thread) = unsafe {
        (
            OwnedHandle::from_raw_handle(started.hProcess),
            OwnedHandle::from_raw_handle(started.hThread),
        )
    };
    Ok(Child {
        pid: started.dwProcessId,
        process,
    })
}

/// A process-thread attribute list, deleted when dropped.
struct AttributeList(LPPROC_THREAD_ATTRIBUTE_LIST);

impl Drop for AttributeList {
    fn drop(&mut self) {
        // SAFETY: the list was initialized, and is deleted once.
        unsafe { DeleteProcThreadAttributeList(self.0) };
    }
}

/// This process's environment with the startup channel `channel`, as the block `CreateProcessW`
/// takes: sorted by name without regard to case, each `name=value` ending with a NUL, and one NUL
/// more at the end.
fn environment_block(channel: &str) -> Vec<u16> {
    let mut variables: Vec<(OsString, OsString)> = std::env::vars_os()
        .filter(|(name, _)| !name.eq_ignore_ascii_case(STARTUP_CHANNEL))
        .collect();
    variables.push((STARTUP_CHANNEL.into(), channel.into()));
    variables.sort_by_key(|(name, _)| name.to_string_lossy().to_uppercase());
    let mut block = Vec::new();
    for (name, value) in variables {
        block.extend(name.encode_wide());
        block.push(u16::from(b'='));
        block.extend(value.encode_wide());
        block.push(0);
    }
    block.push(0);
    block
}

/// `arg` in double quotes, as programs read their command line: backslashes before a quote are
/// doubled, and a quote inside is escaped.
fn quoted(arg: &str) -> String {
    let mut quoted = String::from('"');
    let mut backslashes = 0;
    for c in arg.chars() {
        if c == '\\' {
            backslashes += 1;
        } else {
            if c == '"' {
                quoted.extend(std::iter::repeat_n('\\', backslashes + 1));
            }
            backslashes = 0;
        }
        quoted.push(c);
    }
    quoted.extend(std::iter::repeat_n('\\', backslashes));
    quoted.push('"');
    quoted
}

/// A started service's process, by its handle.
pub(super) struct Child {
    pid: u32,
    process: OwnedHandle,
}

impl Child {
    pub(super) fn id(&self) -> u32 {
        self.pid
    }

    /// Its exit status, where it has ended, without waiting.
    pub(super) fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.wait_for(0)
    }

    /// Waits for it to end, and returns its exit status.
    pub(super) fn wait(&mut self) -> io::Result<ExitStatus> {
        self.wait_for(INFINITE)
            .map(|status| status.unwrap_or(ExitStatus::from_raw(0)))
    }

    pub(super) fn as_handle(&self) -> BorrowedHandle<'_> {
        self.process.as_handle()
    }

    fn wait_for(&self, millis: u32) -> io::Result<Option<ExitStatus>> {
        let handle = self.process.as_raw_handle();
        // SAFETY: the process handle is open.
        match unsafe { WaitForSingleObject(handle, millis) } {
            WAIT_OBJECT_0 => {}
            WAIT_TIMEOUT => return Ok(None),
            _ => return Err(io::Error::last_os_error()),
        }
        let mut code = 0u32;
        // SAFETY: as above; `code` is written.
        if unsafe { GetExitCodeProcess(handle, &mut code) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Some(ExitStatus::from_raw(code)))
    }
}

/// Checks that the process at the client end of `pipe` is this user's and holds `service`'s lock,
/// by its process ID and birth value. For the keeper. The pipe lets in this user's processes alone.
pub fn authenticate_client(
    pipe: BorrowedHandle<'_>,
    framework: &Path,
    service: Service,
) -> Result<ProcessIdentity, String> {
    let mut pid = 0u32;
    // SAFETY: the pipe is open; `pid` is written.
    if unsafe { GetNamedPipeClientProcessId(pipe.as_raw_handle(), &mut pid) } == 0 {
        let error = io::Error::last_os_error();
        return Err(format!("could not identify the peer: {error}"));
    }
    holder(pid, framework, service)
}

impl StartupChannel {
    /// The startup channel the environment names, where this process was started with one. Call it
    /// before any thread starts. The handle is no longer inherited by this process's children.
    pub fn take() -> Option<StartupChannel> {
        let named = std::env::var(STARTUP_CHANNEL).ok()?;
        let handle = named.parse::<usize>().ok().filter(|&value| value != 0)? as HANDLE;
        let mut flags = 0u32;
        // SAFETY: GetHandleInformation only reads the handle's flags; it fails for one not open.
        if unsafe { GetHandleInformation(handle, &mut flags) } == 0 {
            return None;
        }
        // SAFETY: as above; only its inheritance changes.
        unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) };
        // SAFETY: the starting process passed this open handle for this process alone; nothing
        // else in it owns the handle.
        Some(StartupChannel(unsafe { File::from_raw_handle(handle) }))
    }
}

/// [`super::authenticate_server`] on Windows. `connect` checked the server's user already.
pub(super) fn server_identity(
    socket: &ClientSocket,
    framework: &Path,
    service: Service,
) -> Result<ProcessIdentity, String> {
    let mut pid = 0u32;
    // SAFETY: the pipe is open; `pid` is written.
    if unsafe { GetNamedPipeServerProcessId(socket.handle().as_raw_handle(), &mut pid) } == 0 {
        let error = io::Error::last_os_error();
        return Err(format!("could not identify the server: {error}"));
    }
    holder(pid, framework, service)
}

/// The identity in `service`'s lock file, where it names process `pid` by its ID and birth.
fn holder(pid: u32, framework: &Path, service: Service) -> Result<ProcessIdentity, String> {
    let holder = super::lock_record(framework, service).map_err(|err| err.to_string())?;
    let holds = |holder: &ProcessIdentity| {
        holder.pid == pid && birth(pid).ok().flatten().as_ref() == Some(&holder.birth)
    };
    match holder {
        Some(holder) if holds(&holder) => Ok(holder),
        _ => Err(format!(
            "process {pid} does not hold {}",
            service.lock_name()
        )),
    }
}

/// Whether `channel` has something to read, or has ended, before `deadline`. An anonymous pipe
/// has no wait of its own, so it is checked every [`REPORT_CHECK_INTERVAL`].
pub(super) fn readable_by(channel: &PipeReader, deadline: Instant) -> io::Result<bool> {
    loop {
        let mut available = 0u32;
        // SAFETY: the pipe is open; only `available` is written.
        let peeked = unsafe {
            PeekNamedPipe(
                channel.as_raw_handle(),
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
                &mut available,
                std::ptr::null_mut(),
            )
        };
        if peeked == 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_BROKEN_PIPE as i32) {
                return Ok(true);
            }
            return Err(error);
        }
        if available > 0 {
            return Ok(true);
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Ok(false);
        }
        std::thread::sleep(left.min(REPORT_CHECK_INTERVAL));
    }
}

#[link(name = "ntdll", kind = "raw-dylib")]
unsafe extern "system" {
    fn NtSuspendProcess(process: HANDLE) -> i32;
}

/// Suspends this process, as SIGSTOP does on Unix, until a test lets it go on.
pub(super) fn stop_self() {
    // SAFETY: suspends every thread of this process, this one too, until it is resumed.
    unsafe { NtSuspendProcess(GetCurrentProcess()) };
}
