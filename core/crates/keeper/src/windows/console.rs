//! A CLI in a pseudo console of its own, made through the ConPTY package's `conpty.dll`, which
//! Facade ships beside its programs.
//!
//! The console reads its input from one named pipe and writes its output to another; Facade holds
//! the other end of each, and the write end of the console's signal pipe, which keeps the console
//! open while any copy of it is. The CLI starts suspended, joins a job of its own, then runs.

use std::ffi::{OsStr, c_void};
use std::io;
use std::mem;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::Path;
use std::ptr;

use facade_base::jsonrpc::{ErrorBody, Reason};
use facade_base::keeper::StartArgs;
use facade_base::programs::{self, CONPTY_FOLDER};
use facade_base::terminal::PtyMaster;
use windows_sys::Win32::Foundation::{
    DUPLICATE_SAME_ACCESS, DuplicateHandle, GENERIC_READ, GENERIC_WRITE, HANDLE,
    INVALID_HANDLE_VALUE, LocalFree,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAG_OVERLAPPED, OPEN_EXISTING, PIPE_ACCESS_INBOUND, PIPE_ACCESS_OUTBOUND,
};
use windows_sys::Win32::System::Console::{COORD, HPCON};
use windows_sys::Win32::System::JobObjects::{AssignProcessToJobObject, CreateJobObjectW};
use windows_sys::Win32::System::LibraryLoader::{
    GetProcAddress, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR, LOAD_LIBRARY_SEARCH_SYSTEM32, LoadLibraryExW,
};
use windows_sys::Win32::System::Pipes::{
    CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE, PIPE_WAIT,
};
use windows_sys::Win32::System::Threading::{
    CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessW, DeleteProcThreadAttributeList,
    EXTENDED_STARTUPINFO_PRESENT, GetCurrentProcess, InitializeProcThreadAttributeList,
    LPPROC_THREAD_ATTRIBUTE_LIST, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, PROCESS_INFORMATION,
    ResumeThread, STARTF_USESTDHANDLES, STARTUPINFOEXW, TerminateProcess,
    UpdateProcThreadAttribute,
};

use crate::log;

/// What each pipe of a console holds while nobody reads it, as node-pty makes them.
const PIPE_BYTES: u32 = 128 * 1024;

/// The pipes let in their owner alone.
const OWNER_ONLY: &str = "D:P(A;;GA;;;OW)";

/// The exit code a CLI gets when its start fails after it was made.
const FAILED_START_CODE: u32 = 1;

type CreatePseudoConsole = unsafe extern "system" fn(COORD, HANDLE, HANDLE, u32, *mut HPCON) -> i32;
type ReleasePseudoConsole = unsafe extern "system" fn(HPCON) -> i32;
type ClosePseudoConsole = unsafe extern "system" fn(HPCON);

/// The package's functions. Its module stays loaded for the life of the process.
pub(super) struct ConPty {
    create: CreatePseudoConsole,
    release: ReleasePseudoConsole,
    close: ClosePseudoConsole,
}

/// A CLI that runs in its console.
pub(super) struct Started {
    pub(super) pid: u32,
    /// Its process, with every access.
    pub(super) process: OwnedHandle,
    /// The keeper's copy of its terminal.
    pub(super) master: PtyMaster,
}

impl ConPty {
    /// Loads `conpty.dll` from this build's ConPTY folder, searching only there and System32 for
    /// what it needs. It finds the console host, `OpenConsole.exe`, beside itself.
    pub(super) fn load() -> Result<ConPty, ErrorBody> {
        let folder = programs::bin_dir()
            .map(|bin| bin.join(facade_base::build_id()).join(CONPTY_FOLDER))
            .map_err(|err| unavailable(format!("could not find Facade's programs: {err:#}")))?;
        let missing = |detail: String| {
            unavailable(format!(
                "the console package in {} could not be loaded ({detail}); install Facade again \
                 to put conpty.dll and OpenConsole.exe there",
                folder.display()
            ))
        };
        let dll = wide(folder.join("conpty.dll").as_os_str());
        // SAFETY: a NUL-terminated absolute path; the module is never unloaded.
        let module = unsafe {
            LoadLibraryExW(
                dll.as_ptr(),
                ptr::null_mut(),
                LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32,
            )
        };
        if module.is_null() {
            return Err(missing(io::Error::last_os_error().to_string()));
        }
        let symbol = |name: &'static [u8]| {
            // SAFETY: the module is loaded and `name` is NUL-terminated.
            unsafe { GetProcAddress(module, name.as_ptr()) }.ok_or_else(|| {
                let name = String::from_utf8_lossy(&name[..name.len() - 1]);
                missing(format!("it has no {name}"))
            })
        };
        let (create, release, close) = (
            symbol(b"CreatePseudoConsole\0")?,
            symbol(b"ReleasePseudoConsole\0")?,
            symbol(b"ClosePseudoConsole\0")?,
        );
        // SAFETY: the package exports these functions with these signatures, as Windows does.
        unsafe {
            Ok(ConPty {
                create: mem::transmute::<unsafe extern "system" fn() -> isize, CreatePseudoConsole>(
                    create,
                ),
                release: mem::transmute::<unsafe extern "system" fn() -> isize, ReleasePseudoConsole>(
                    release,
                ),
                close: mem::transmute::<unsafe extern "system" fn() -> isize, ClosePseudoConsole>(
                    close,
                ),
            })
        }
    }

    /// Starts the CLI that `args` describes in a new `cols` × `rows` console, in a job of its own
    /// that does not kill it on close. Returns as soon as the CLI runs.
    pub(super) fn start(
        &self,
        args: &StartArgs,
        cols: u16,
        rows: u16,
    ) -> Result<Started, ErrorBody> {
        let program = match args.command.first() {
            Some(program) if !program.is_empty() => program,
            _ => {
                return Err(ErrorBody::invalid_argument(
                    "command must start with the CLI's program",
                ));
            }
        };
        let cannot_start =
            |detail: String| unavailable(format!("could not start {program}: {detail}"));
        let folder = Path::new(&args.path);
        let (application, mut command_line) =
            programs::quoted_command(&args.command, &args.env, folder).map_err(cannot_start)?;
        if command_line.last() != Some(&0) {
            command_line.push(0);
        }
        let environment = environment_block(args)?;
        let no_terminal = |err: io::Error| unavailable(format!("could not make a terminal: {err}"));
        let access = OwnerOnly::new().map_err(no_terminal)?;
        let (input_console, input) = pipe(&access, Direction::ToConsole).map_err(no_terminal)?;
        let (output_console, output) =
            pipe(&access, Direction::FromConsole).map_err(no_terminal)?;
        let console = self.console(cols, rows, &input_console, &output_console)?;
        // The console host has its own copies of its ends.
        drop((input_console, output_console));
        let signal = console.signal().map_err(no_terminal)?;
        let job = job().map_err(no_terminal)?;

        let (process, thread, pid) = console
            .spawn(&application, &mut command_line, &environment, folder)
            .map_err(|err| cannot_start(err.to_string()))?;
        let ran = join(&job, &process).and_then(|()| resume(&thread));
        if let Err(err) = ran {
            // SAFETY: the process is this keeper's and has not run.
            unsafe { TerminateProcess(process.as_raw_handle(), FAILED_START_CODE) };
            return Err(cannot_start(err.to_string()));
        }
        console.release();
        Ok(Started {
            pid,
            process,
            master: PtyMaster::from_handles(input, output, Some(signal), job),
        })
    }

    /// A pseudo console that reads `input` and writes `output`.
    fn console(
        &self,
        cols: u16,
        rows: u16,
        input: &OwnedHandle,
        output: &OwnedHandle,
    ) -> Result<Console<'_>, ErrorBody> {
        let size = COORD {
            X: cols as i16,
            Y: rows as i16,
        };
        let mut handle: HPCON = 0;
        // SAFETY: both pipe ends are open; `handle` receives the new console.
        let result = unsafe {
            (self.create)(
                size,
                input.as_raw_handle(),
                output.as_raw_handle(),
                0,
                &mut handle,
            )
        };
        if result < 0 {
            return Err(unavailable(format!(
                "could not make a pseudo console: HRESULT {result:#010x}"
            )));
        }
        Ok(Console {
            handle,
            conpty: self,
        })
    }
}

/// A pseudo console while it is being set up. Closing it closes the package's own copies of its
/// handles and frees it; its console lives on while a copy of its signal pipe is open elsewhere.
struct Console<'a> {
    handle: HPCON,
    conpty: &'a ConPty,
}

impl Console<'_> {
    /// A copy of the signal pipe's write end, the first of the three handles behind an `HPCON`:
    /// the signal pipe, the reference to the console's server, the console host's process.
    fn signal(&self) -> io::Result<OwnedHandle> {
        // SAFETY: the package's `HPCON` points at those three handles, the signal pipe first.
        let signal = unsafe { *(self.handle as *const HANDLE) };
        duplicate(signal)
    }

    /// Creates the CLI in this console, suspended: its process, its first thread and its ID.
    fn spawn(
        &self,
        application: &Path,
        command_line: &mut [u16],
        environment: &[u16],
        folder: &Path,
    ) -> io::Result<(OwnedHandle, OwnedHandle, u32)> {
        let mut size = 0usize;
        // SAFETY: asks only for the size of a list of one attribute.
        unsafe { InitializeProcThreadAttributeList(ptr::null_mut(), 1, 0, &mut size) };
        let mut storage = vec![0usize; size.div_ceil(mem::size_of::<usize>())];
        let list = storage.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
        // SAFETY: `storage` holds `size` bytes, aligned for the list.
        if unsafe { InitializeProcThreadAttributeList(list, 1, 0, &mut size) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let attributes = AttributeList(list);
        // SAFETY: the list is initialized; the attribute's value is the `HPCON` itself.
        let set = unsafe {
            UpdateProcThreadAttribute(
                attributes.0,
                0,
                PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
                self.handle as *const c_void,
                mem::size_of::<HPCON>(),
                ptr::null_mut(),
                ptr::null(),
            )
        };
        if set == 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: STARTUPINFOEXW is plain data, for which all zeros is valid.
        let mut startup: STARTUPINFOEXW = unsafe { mem::zeroed() };
        startup.StartupInfo.cb = mem::size_of::<STARTUPINFOEXW>() as u32;
        // No standard handles: the CLI's are its console's, not the keeper's log.
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.lpAttributeList = attributes.0;
        // SAFETY: PROCESS_INFORMATION is plain data, for which all zeros is valid.
        let mut created: PROCESS_INFORMATION = unsafe { mem::zeroed() };
        let application = wide(application.as_os_str());
        let folder = wide(folder.as_os_str());
        // SAFETY: every string is NUL-terminated, the environment block ends with two NULs, and
        // the attribute list stays alive for the call; nothing is inherited.
        let ok = unsafe {
            CreateProcessW(
                application.as_ptr(),
                command_line.as_mut_ptr(),
                ptr::null(),
                ptr::null(),
                0,
                EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
                environment.as_ptr().cast(),
                folder.as_ptr(),
                &startup.StartupInfo,
                &mut created,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: CreateProcessW gave these two handles to this process alone.
        let (process, thread) = unsafe {
            (
                OwnedHandle::from_raw_handle(created.hProcess),
                OwnedHandle::from_raw_handle(created.hThread),
            )
        };
        Ok((process, thread, created.dwProcessId))
    }

    /// Lets the console end by itself once the last program in it ends: without this, it stays
    /// after the CLI ends and its output never reaches its end.
    fn release(&self) {
        // SAFETY: the console is open.
        let result = unsafe { (self.conpty.release)(self.handle) };
        if result < 0 {
            log(
                "warn",
                &format!("could not let a console end by itself: HRESULT {result:#010x}"),
            );
        }
    }
}

impl Drop for Console<'_> {
    fn drop(&mut self) {
        // SAFETY: the console is open, and this is its last use.
        unsafe { (self.conpty.close)(self.handle) };
    }
}

/// A process attribute list, deleted when dropped.
struct AttributeList(LPPROC_THREAD_ATTRIBUTE_LIST);

impl Drop for AttributeList {
    fn drop(&mut self) {
        // SAFETY: the list was initialized and its storage outlives this.
        unsafe { DeleteProcThreadAttributeList(self.0) };
    }
}

/// A security descriptor made from [`OWNER_ONLY`], freed when dropped.
struct OwnerOnly(PSECURITY_DESCRIPTOR);

impl OwnerOnly {
    fn new() -> io::Result<OwnerOnly> {
        let text = wide(OsStr::new(OWNER_ONLY));
        let mut descriptor: PSECURITY_DESCRIPTOR = ptr::null_mut();
        // SAFETY: a NUL-terminated descriptor string; the result is freed with LocalFree.
        let ok = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                text.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                ptr::null_mut(),
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(OwnerOnly(descriptor))
    }
}

impl Drop for OwnerOnly {
    fn drop(&mut self) {
        // SAFETY: the descriptor came from LocalAlloc inside the conversion.
        unsafe { LocalFree(self.0) };
    }
}

/// Which way a console's pipe carries bytes.
enum Direction {
    ToConsole,
    FromConsole,
}

/// A new named pipe: the console's end, the server, synchronous as ConPTY takes it; and
/// Facade's, the client, overlapped.
fn pipe(access: &OwnerOnly, direction: Direction) -> io::Result<(OwnedHandle, OwnedHandle)> {
    let name = format!(
        r"\\.\pipe\facade-console-{}-{:016x}",
        std::process::id(),
        facade_base::random_u64()
    );
    let name = wide(OsStr::new(&name));
    let (server_access, client_access) = match direction {
        Direction::ToConsole => (PIPE_ACCESS_INBOUND, GENERIC_WRITE),
        Direction::FromConsole => (PIPE_ACCESS_OUTBOUND, GENERIC_READ),
    };
    let attributes = SECURITY_ATTRIBUTES {
        nLength: mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: access.0,
        bInheritHandle: 0,
    };
    // SAFETY: a NUL-terminated name and a valid descriptor.
    let server = unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            server_access,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
            1,
            PIPE_BYTES,
            PIPE_BYTES,
            0,
            &attributes,
        )
    };
    let server = owned(server)?;
    // SAFETY: a NUL-terminated name; the pipe instance waits for this client.
    let client = unsafe {
        CreateFileW(
            name.as_ptr(),
            client_access,
            0,
            ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_OVERLAPPED,
            ptr::null_mut(),
        )
    };
    Ok((server, owned(client)?))
}

/// A new job that keeps its processes running when its last handle closes.
fn job() -> io::Result<OwnedHandle> {
    // SAFETY: an unnamed job with default limits, owned by nobody else.
    let job = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
    if job.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the job was just created and is owned here alone.
    Ok(unsafe { OwnedHandle::from_raw_handle(job) })
}

fn join(job: &OwnedHandle, process: &OwnedHandle) -> io::Result<()> {
    // SAFETY: both handles are open.
    if unsafe { AssignProcessToJobObject(job.as_raw_handle(), process.as_raw_handle()) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn resume(thread: &OwnedHandle) -> io::Result<()> {
    // SAFETY: the thread is open.
    if unsafe { ResumeThread(thread.as_raw_handle()) } == u32::MAX {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// A copy of `handle` in this process, with the same access.
fn duplicate(handle: HANDLE) -> io::Result<OwnedHandle> {
    let mut copy: HANDLE = ptr::null_mut();
    // SAFETY: `handle` is open in this process; the copy is owned by the caller alone.
    let ok = unsafe {
        DuplicateHandle(
            GetCurrentProcess(),
            handle,
            GetCurrentProcess(),
            &mut copy,
            0,
            0,
            DUPLICATE_SAME_ACCESS,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the copy was just made for this process alone.
    Ok(unsafe { OwnedHandle::from_raw_handle(copy) })
}

/// The handle a create call returned, or its error.
fn owned(handle: HANDLE) -> io::Result<OwnedHandle> {
    if handle == INVALID_HANDLE_VALUE || handle.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: a handle just created for this process alone.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
}

/// The CLI's environment as CreateProcessW takes it: `name=value` strings, each ending in NUL,
/// then one more NUL.
fn environment_block(args: &StartArgs) -> Result<Vec<u16>, ErrorBody> {
    let mut block = Vec::new();
    for (name, value) in &args.env {
        if name.contains('\0') || value.contains('\0') {
            return Err(ErrorBody::invalid_argument(format!(
                "the environment variable {name:?} cannot be given to a program"
            )));
        }
        block.extend(OsStr::new(&format!("{name}={value}")).encode_wide());
        block.push(0);
    }
    if block.is_empty() {
        block.push(0);
    }
    block.push(0);
    Ok(block)
}

/// `text` as UTF-16, ending in NUL.
fn wide(text: &OsStr) -> Vec<u16> {
    text.encode_wide().chain(Some(0)).collect()
}

fn unavailable(message: String) -> ErrorBody {
    ErrorBody::new(Reason::Unavailable, message)
}
