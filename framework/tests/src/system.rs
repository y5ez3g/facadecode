//! What the harness does differently on each system: the variables and folders a test's processes
//! get, the shell its scripts run in, the programs it installs, and how it ends, pauses and finds
//! processes.

use std::path::{Path, PathBuf};

/// What separates the folders of `PATH`.
#[cfg(unix)]
pub const PATH_SEPARATOR: &str = ":";
#[cfg(windows)]
pub const PATH_SEPARATOR: &str = ";";

/// What a test's commands take from the environment the tests run in: its temporary folder, its
/// text encoding, and Rust's backtraces; on Windows also the variables every Windows program
/// expects. Nothing else reaches them, so no setting of the person's, such as `OPENCODE_CONFIG`,
/// reaches a test.
#[cfg(unix)]
pub const PASSED_THROUGH: &[&str] = &["TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "RUST_BACKTRACE"];
#[cfg(windows)]
pub const PASSED_THROUGH: &[&str] = &[
    "SystemRoot",
    "SystemDrive",
    "windir",
    "ComSpec",
    "PATHEXT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "RUST_BACKTRACE",
];

/// The system's folders: besides the test's own, the only ones a test's processes find programs
/// in. On Windows, the system's and Git's `cmd` folder, which holds only `git.exe` and its tools.
#[cfg(unix)]
pub fn system_folders() -> Vec<String> {
    ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]
        .map(String::from)
        .to_vec()
}
#[cfg(windows)]
pub fn system_folders() -> Vec<String> {
    let root = std::env::var("SystemRoot").expect("SystemRoot names the Windows folder");
    vec![
        format!("{root}\\System32"),
        format!("{root}\\System32\\WindowsPowerShell\\v1.0"),
        root,
        git_install().join("cmd").display().to_string(),
    ]
}

/// Codex's default Windows session shell: pwsh on PATH, otherwise Windows PowerShell.
#[cfg(windows)]
pub fn powershell() -> PathBuf {
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
        .map(|folder| folder.join("pwsh.exe"))
        .find(|program| program.is_file())
        .unwrap_or_else(|| {
            PathBuf::from(
                std::env::var_os("SystemRoot").expect("SystemRoot names the Windows folder"),
            )
            .join("System32/WindowsPowerShell/v1.0/powershell.exe")
        })
}

/// The script in an encoded PowerShell hook, also when it appears inside a CLI command line.
#[cfg(windows)]
pub fn powershell_script(command: &str) -> Option<String> {
    let marker = "powershell.exe -NoProfile -NonInteractive -EncodedCommand ";
    let start = command.find(marker)? + marker.len();
    let encoded: String = command[start..]
        .chars()
        .take_while(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '/' | '='))
        .collect();
    let bytes = facade_base::base64::decode(&encoded).ok()?;
    let (pairs, remainder) = bytes.as_chunks::<2>();
    if !remainder.is_empty() {
        return None;
    }
    let units: Vec<_> = pairs.iter().copied().map(u16::from_le_bytes).collect();
    String::from_utf16(&units).ok()
}

/// The variables that keep a process's settings inside `user`, the test's home folder, besides
/// `HOME`. On Windows, this also isolates OpenSSH's shared administrator authorization.
#[cfg(unix)]
pub fn home_variables(_user: &Path) -> Vec<(&'static str, String)> {
    Vec::new()
}
#[cfg(windows)]
pub fn home_variables(user: &Path) -> Vec<(&'static str, String)> {
    let roaming = user.join("AppData").join("Roaming");
    let local = user.join("AppData").join("Local");
    let program_data = user.join("ProgramData");
    for folder in [&roaming, &local, &program_data] {
        std::fs::create_dir_all(folder).expect("could not create the test's home folder");
    }
    vec![
        ("USERPROFILE", user.display().to_string()),
        ("APPDATA", roaming.display().to_string()),
        ("LOCALAPPDATA", local.display().to_string()),
        ("ProgramData", program_data.display().to_string()),
    ]
}

/// The folder Git for Windows is installed in, from `git --exec-path`
/// (`<install>/mingw64/libexec/git-core`). The tests' scripts run in its `sh.exe`, and agents find
/// Git in its `cmd` folder.
#[cfg(windows)]
pub fn git_install() -> &'static Path {
    static INSTALL: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    INSTALL.get_or_init(|| {
        const NEEDED: &str = "the tests on Windows need Git for Windows, with git on PATH";
        let out = std::process::Command::new("git")
            .arg("--exec-path")
            .output()
            .unwrap_or_else(|err| panic!("{NEEDED}: could not run git: {err}"));
        let exec = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
        let install = exec
            .ancestors()
            .nth(3)
            .unwrap_or_else(|| panic!("{NEEDED}: git --exec-path gave {}", exec.display()))
            .to_path_buf();
        for program in ["bin\\sh.exe", "cmd\\git.exe"] {
            assert!(
                install.join(program).is_file(),
                "{NEEDED}: no {} in its install folder {}",
                program,
                install.display()
            );
        }
        install
    })
}

/// The shell the tests' scripts run in: `/bin/sh`, or Git for Windows' `bin\sh.exe`, which runs its
/// `usr\bin\sh.exe` as a child, as Git Bash does: run first in a pseudo console, that shell ends
/// once its console is resized.
#[cfg(unix)]
pub fn shell() -> PathBuf {
    PathBuf::from("/bin/sh")
}
#[cfg(windows)]
pub fn shell() -> PathBuf {
    git_install().join("bin").join("sh.exe")
}

/// Puts `program` in `folder` as `name`, which a test's `PATH` then finds: a link on Unix, a copy
/// named `<name>.exe` on Windows, where links need Developer Mode.
pub fn install_program(folder: &Path, name: &str, program: &Path) {
    std::fs::create_dir_all(folder).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(program, folder.join(name)).unwrap();
    #[cfg(windows)]
    {
        std::fs::copy(program, folder.join(format!("{name}.exe"))).unwrap();
    }
}

/// Puts the shell script `script` in `folder` as program `name`: on Unix the script itself, made
/// executable, which starts with `#!/bin/sh`; on Windows `<name>.exe`, a copy of the fake CLI that
/// runs `<name>.sh` beside it in the shell `<name>.shell` names ([`shell`]) with its arguments.
/// Returns the program.
pub fn install_script(folder: &Path, name: &str, script: &str) -> PathBuf {
    std::fs::create_dir_all(folder).unwrap();
    #[cfg(unix)]
    {
        let program = folder.join(name);
        std::fs::write(&program, script).unwrap();
        std::fs::set_permissions(
            &program,
            std::os::unix::fs::PermissionsExt::from_mode(0o755),
        )
        .unwrap();
        program
    }
    #[cfg(windows)]
    {
        let body = folder.join(format!("{name}.sh"));
        // The runner gives the script its arguments through the environment, which keeps them
        // whole; these first lines make them the script's own.
        let arguments = "set --\ni=1\nwhile [ \"$i\" -le \"${FAKECLI_ARGC:-0}\" ]; do\n\teval \
                         \"set -- \\\"\\$@\\\" \\\"\\$FAKECLI_ARG_$i\\\"\"\n\ti=$((i + 1))\ndone\n\
                         unset i\n";
        std::fs::write(&body, format!("{arguments}{script}")).unwrap();
        // A program of its own, not a .cmd: arguments cmd.exe would read reach the script whole.
        std::fs::write(
            folder.join(format!("{name}.shell")),
            shell().display().to_string(),
        )
        .unwrap();
        // The same program each time: one already there may be running, which Windows would not
        // let be replaced.
        let program = folder.join(format!("{name}.exe"));
        if !program.exists() {
            std::fs::copy(&crate::test_binaries().fakecli, &program).unwrap();
        }
        program
    }
}

/// Ends process `pid` at once: SIGKILL, or `TerminateProcess`.
#[cfg(unix)]
pub fn kill_process(pid: i32) {
    crate::send_signal(pid, libc::SIGKILL);
}
#[cfg(windows)]
pub fn kill_process(pid: i32) {
    use windows_sys::Win32::System::Threading::{PROCESS_TERMINATE, TerminateProcess};
    // SAFETY: the handle is open for the call.
    with_process(pid, PROCESS_TERMINATE, |process| unsafe {
        TerminateProcess(process, 1);
    });
}

/// Pauses every thread of process `pid`, as SIGSTOP does, until [`resume_process`].
#[cfg(unix)]
pub fn pause_process(pid: i32) {
    crate::send_signal(pid, libc::SIGSTOP);
}
#[cfg(windows)]
pub fn pause_process(pid: i32) {
    // SAFETY: the handle is open for the call.
    with_process(pid, PROCESS_SUSPEND_RESUME, |process| unsafe {
        ntdll::NtSuspendProcess(process);
    });
}

/// Lets a process [`pause_process`] or a pause gate paused go on, as SIGCONT does.
#[cfg(unix)]
pub fn resume_process(pid: i32) {
    crate::send_signal(pid, libc::SIGCONT);
}
#[cfg(windows)]
pub fn resume_process(pid: i32) {
    // SAFETY: the handle is open for the call.
    with_process(pid, PROCESS_SUSPEND_RESUME, |process| unsafe {
        ntdll::NtResumeProcess(process);
    });
}

/// Whether process `pid` is paused: stopped by a signal, or every thread of it suspended.
#[cfg(unix)]
pub fn stopped(pid: i32) -> bool {
    let state = std::process::Command::new("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .map(|out| crate::stdout(&out))
        .unwrap_or_default();
    state.trim_start().starts_with('T')
}
#[cfg(windows)]
pub fn stopped(pid: i32) -> bool {
    // A thread waiting with reason Suspended (KTHREAD_STATE Waiting = 5, KWAIT_REASON Suspended = 5),
    // read from the system's process list: SYSTEM_PROCESS_INFORMATION (0x100 bytes on x64, the
    // process ID at 0x50) followed by its SYSTEM_THREAD_INFORMATION (0x50 bytes, the state at 0x44 and
    // the reason at 0x48).
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let mut needed = 0u32;
        // SAFETY: the system writes at most `buffer.len()` bytes into it.
        let status = unsafe {
            ntdll::NtQuerySystemInformation(
                5,
                buffer.as_mut_ptr().cast(),
                buffer.len() as u32,
                &mut needed,
            )
        };
        if status == STATUS_INFO_LENGTH_MISMATCH {
            buffer = vec![0u8; (needed as usize).max(buffer.len()) * 2];
            continue;
        }
        if status != 0 {
            return false;
        }
        break;
    }
    let read_u32 = |at: usize| u32::from_ne_bytes(buffer[at..at + 4].try_into().unwrap());
    let mut entry = 0usize;
    loop {
        let threads = read_u32(entry + 4) as usize;
        let id = usize::from_ne_bytes(buffer[entry + 0x50..entry + 0x58].try_into().unwrap());
        if id == pid as usize {
            return threads > 0
                && (0..threads).all(|thread| {
                    let at = entry + 0x100 + thread * 0x50;
                    read_u32(at + 0x44) == 5 && read_u32(at + 0x48) == 5
                });
        }
        let next = read_u32(entry) as usize;
        if next == 0 {
            return false;
        }
        entry += next;
    }
}

/// The processes that belong to `folder`, a test's folder: on Unix those working in it or a folder
/// inside it; on Windows those whose program lies inside it, or whose environment names a Facade
/// home or a home folder inside it. macOS shows no environment for its own programs, such as
/// `/bin/sh` and `sleep`, so this is how a test finds the scripts it started, also once they
/// outlive the keeper that held their terminals.
#[cfg(unix)]
pub fn processes_in(folder: &Path) -> Vec<i32> {
    let Ok(folder) = std::fs::canonicalize(folder) else {
        return Vec::new();
    };
    let out = std::process::Command::new("ps")
        .args(["-axo", "pid="])
        .output()
        .expect("could not run ps");
    crate::stdout(&out)
        .lines()
        .filter_map(|pid| pid.trim().parse().ok())
        .filter(|pid| working_folder(*pid).is_some_and(|working| working.starts_with(&folder)))
        .collect()
}
#[cfg(windows)]
pub fn processes_in(folder: &Path) -> Vec<i32> {
    let inside = |path: &str| {
        facade_base::files::folder_key(Path::new(path))
            .starts_with(&facade_base::files::folder_key(folder))
    };
    all_processes()
        .into_iter()
        .filter(|&pid| {
            program_of(pid).is_some_and(|program| inside(&program.display().to_string()))
                || working_folder(pid).is_some_and(|working| inside(&working))
                || environment_of(pid).is_some_and(|env| {
                    env.iter().any(|(name, value)| {
                        ["FACADE_HOME", "HOME", "USERPROFILE"]
                            .iter()
                            .any(|home| name.eq_ignore_ascii_case(home))
                            && inside(value)
                    })
                })
        })
        .collect()
}

/// The processes whose environment gives `name` the value `value`.
#[cfg(unix)]
pub fn processes_with(name: &str, value: &Path) -> Vec<i32> {
    let marker = format!("{name}={}", value.display());
    let out = std::process::Command::new("ps")
        .args(["axeww", "-o", "pid=,command="])
        .output()
        .expect("could not run ps");
    crate::stdout(&out)
        .lines()
        .filter(|line| line.split_whitespace().any(|word| word == marker))
        .filter_map(|line| {
            line.split_whitespace()
                .next()
                .and_then(|pid| pid.parse().ok())
        })
        .collect()
}
#[cfg(windows)]
pub fn processes_with(name: &str, value: &Path) -> Vec<i32> {
    let value = value.display().to_string();
    all_processes()
        .into_iter()
        .filter(|&pid| {
            environment_of(pid).is_some_and(|env| {
                env.iter()
                    .any(|(key, set)| key.eq_ignore_ascii_case(name) && *set == value)
            })
        })
        .collect()
}

/// The folder a process works in, where it can be read.
#[cfg(target_os = "macos")]
fn working_folder(pid: i32) -> Option<PathBuf> {
    use std::os::unix::ffi::OsStringExt;
    // SAFETY: proc_vnodepathinfo is plain data, valid with every byte zero.
    let mut info: libc::proc_vnodepathinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_vnodepathinfo>() as libc::c_int;
    // SAFETY: proc_pidinfo writes at most `size` bytes into `info`.
    let written = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDVNODEPATHINFO,
            0,
            (&raw mut info).cast(),
            size,
        )
    };
    if written != size {
        return None;
    }
    let path: Vec<u8> = info
        .pvi_cdir
        .vip_path
        .as_flattened()
        .iter()
        .map(|&byte| byte as u8)
        .take_while(|&byte| byte != 0)
        .collect();
    (!path.is_empty()).then(|| std::ffi::OsString::from_vec(path).into())
}

/// The folder a process works in, where it can be read.
#[cfg(target_os = "linux")]
fn working_folder(pid: i32) -> Option<PathBuf> {
    std::fs::read_link(format!("/proc/{pid}/cwd")).ok()
}

#[cfg(windows)]
const PROCESS_SUSPEND_RESUME: u32 = 0x0800;
#[cfg(windows)]
const STATUS_INFO_LENGTH_MISMATCH: i32 = 0xC000_0004_u32 as i32;

#[cfg(windows)]
mod ntdll {
    use windows_sys::Win32::Foundation::HANDLE;

    #[link(name = "ntdll", kind = "raw-dylib")]
    unsafe extern "system" {
        pub fn NtSuspendProcess(process: HANDLE) -> i32;
        pub fn NtResumeProcess(process: HANDLE) -> i32;
        pub fn NtQueryInformationProcess(
            process: HANDLE,
            class: u32,
            information: *mut core::ffi::c_void,
            length: u32,
            returned: *mut u32,
        ) -> i32;
        pub fn NtQuerySystemInformation(
            class: u32,
            buffer: *mut core::ffi::c_void,
            length: u32,
            returned: *mut u32,
        ) -> i32;
    }
}

/// Runs `act` with process `pid` opened for `access`; does nothing where it cannot be opened, as a
/// signal to an ended process does nothing.
#[cfg(windows)]
fn with_process(pid: i32, access: u32, act: impl FnOnce(windows_sys::Win32::Foundation::HANDLE)) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::OpenProcess;
    // SAFETY: OpenProcess has no memory-safety preconditions; the handle is closed after use.
    let process = unsafe { OpenProcess(access, 0, pid as u32) };
    if process.is_null() {
        return;
    }
    act(process);
    // SAFETY: the handle was opened above and is closed once.
    unsafe { CloseHandle(process) };
}

/// Every process's ID, from a Toolhelp snapshot.
#[cfg(windows)]
fn all_processes() -> Vec<i32> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
        TH32CS_SNAPPROCESS,
    };
    // SAFETY: the snapshot handle is checked and closed; each entry is a plain struct with its size
    // set, as Process32FirstW and Process32NextW require.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return Vec::new();
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut pids = Vec::new();
        let mut more = Process32FirstW(snapshot, &mut entry) != 0;
        while more {
            if entry.th32ProcessID > 4 && entry.th32ProcessID != std::process::id() {
                pids.push(entry.th32ProcessID as i32);
            }
            more = Process32NextW(snapshot, &mut entry) != 0;
        }
        CloseHandle(snapshot);
        pids
    }
}

/// The memory process `pid` has for itself alone, in bytes, with what it allocated and never touched:
/// what Windows counts against the system's commit limit.
#[cfg(windows)]
pub fn private_memory(pid: i32) -> usize {
    use windows_sys::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS_EX,
    };
    use windows_sys::Win32::System::Threading::PROCESS_QUERY_LIMITED_INFORMATION;
    // SAFETY: PROCESS_MEMORY_COUNTERS_EX is plain data, valid with every byte zero.
    let mut counters: PROCESS_MEMORY_COUNTERS_EX = unsafe { std::mem::zeroed() };
    counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
    let size = counters.cb;
    with_process(pid, PROCESS_QUERY_LIMITED_INFORMATION, |process| {
        // SAFETY: the process's handle is open and the system writes at most `size` bytes.
        unsafe { GetProcessMemoryInfo(process, (&raw mut counters).cast(), size) };
    });
    assert!(counters.PrivateUsage > 0, "no memory of {pid}");
    counters.PrivateUsage
}

/// The program process `pid` runs, where it can be opened.
#[cfg(windows)]
pub fn program_of(pid: i32) -> Option<PathBuf> {
    use windows_sys::Win32::System::Threading::{
        PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
    };
    let mut found = None;
    with_process(pid, PROCESS_QUERY_LIMITED_INFORMATION, |process| {
        let mut name = vec![0u16; 32768];
        let mut length = name.len() as u32;
        // SAFETY: the system writes at most `length` characters into `name`.
        if unsafe {
            QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, name.as_mut_ptr(), &mut length)
        } != 0
        {
            found = Some(PathBuf::from(String::from_utf16_lossy(
                &name[..length as usize],
            )));
        }
    });
    found
}

/// Process `pid`'s environment, where it can be read, through base's reading of another process's.
#[cfg(windows)]
fn environment_of(pid: i32) -> Option<std::collections::BTreeMap<String, String>> {
    let identity = facade_base::process::ProcessIdentity {
        pid: pid as u32,
        birth: facade_base::unix_process::birth(pid as u32).ok()??,
    };
    facade_base::unix_process::environment(&identity).ok()?
}

/// Whether a service listens at `socket`: its socket file, or on Windows its named pipe, whose
/// name a wait finds without connecting to it as `Path::exists` would.
#[cfg(unix)]
pub fn socket_exists(socket: &Path) -> bool {
    socket.exists()
}
#[cfg(windows)]
pub fn socket_exists(socket: &Path) -> bool {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, GetLastError};
    use windows_sys::Win32::System::Pipes::WaitNamedPipeW;
    let name: Vec<u16> = socket
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: the name is NUL-terminated and lives for the call.
    if unsafe { WaitNamedPipeW(name.as_ptr(), 1) } != 0 {
        return true;
    }
    // Every instance busy is still a pipe there; only a missing name means none.
    // SAFETY: GetLastError has no preconditions.
    let error = unsafe { GetLastError() };
    error != ERROR_FILE_NOT_FOUND
}

/// The command line of process `pid`: as `ps` shows it, or on Windows as the system keeps it.
#[cfg(unix)]
pub fn command_line_of(pid: i32) -> String {
    let ps = std::process::Command::new("ps")
        .args(["-o", "command=", "-p", &pid.to_string()])
        .output()
        .unwrap();
    String::from_utf8_lossy(&ps.stdout).trim().to_string()
}
#[cfg(windows)]
pub fn command_line_of(pid: i32) -> String {
    use windows_sys::Win32::System::Threading::PROCESS_QUERY_LIMITED_INFORMATION;
    // ProcessCommandLineInformation (60): a UNICODE_STRING (length in bytes, then the buffer's
    // address, 16 bytes on x64) followed by the text it points at, in the same buffer.
    let mut found = String::new();
    with_process(pid, PROCESS_QUERY_LIMITED_INFORMATION, |process| {
        let mut buffer = vec![0u64; 8192];
        let mut returned = 0u32;
        // SAFETY: the system writes at most the buffer's size into it.
        let status = unsafe {
            ntdll::NtQueryInformationProcess(
                process,
                60,
                buffer.as_mut_ptr().cast(),
                (buffer.len() * 8) as u32,
                &mut returned,
            )
        };
        if status != 0 {
            return;
        }
        let length = (buffer[0] & 0xffff) as usize / 2;
        let text = buffer[1] as *const u16;
        // SAFETY: the text lies in `buffer`, which the system filled, and is `length` units long.
        let text = unsafe { std::slice::from_raw_parts(text, length) };
        found = String::from_utf16_lossy(text);
    });
    found
}

/// The file name of program `name`, such as `facade`: `facade.exe` on Windows.
pub fn program_name(name: &str) -> String {
    format!("{name}{}", std::env::consts::EXE_SUFFIX)
}

/// The build the launchers in Facade home `home`'s `framework/bin` point at: on Unix the folder their
/// links lead into; on Windows, where they are copies, the build `framework/bin/current-build` names.
pub fn launcher_build(home: &Path) -> Option<String> {
    let bin = home.join("framework").join("bin");
    #[cfg(unix)]
    {
        let target = std::fs::read_link(bin.join("facade")).ok()?;
        Some(target.iter().next()?.to_string_lossy().into_owned())
    }
    #[cfg(windows)]
    {
        std::fs::read_to_string(bin.join("current-build")).ok()
    }
}

/// [`shell`] as text, for the lists of words and the JSON a test writes.
pub static SH: std::sync::LazyLock<String> =
    std::sync::LazyLock::new(|| shell().display().to_string());

/// The `PATH` of a test's own scripts: `/usr/bin:/bin`, or on Windows the system's folders.
#[cfg(unix)]
pub static SYSTEM_PATH: std::sync::LazyLock<String> =
    std::sync::LazyLock::new(|| "/usr/bin:/bin".to_string());
#[cfg(windows)]
pub static SYSTEM_PATH: std::sync::LazyLock<String> =
    std::sync::LazyLock::new(|| system_folders().join(PATH_SEPARATOR));

/// The folder process `pid` works in, from its process parameters (x64: ProcessParameters at
/// PEB+0x20, CurrentDirectory's path at +0x38), where the process can be read. An MSYS program
/// started by another keeps its variables out of its Windows environment, so this is how a test
/// finds the scripts it started once their parent ended.
#[cfg(windows)]
fn working_folder(pid: i32) -> Option<String> {
    use windows_sys::Win32::System::Diagnostics::Debug::ReadProcessMemory;
    use windows_sys::Win32::System::Threading::{
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ,
    };
    let mut found = None;
    with_process(
        pid,
        PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ,
        |process| {
            let read = |at: usize, buffer: &mut [u8]| {
                let mut done = 0usize;
                // SAFETY: the system writes at most `buffer.len()` bytes into `buffer`.
                unsafe {
                    ReadProcessMemory(
                        process,
                        at as *const core::ffi::c_void,
                        buffer.as_mut_ptr().cast(),
                        buffer.len(),
                        &mut done,
                    ) != 0
                        && done == buffer.len()
                }
            };
            // PROCESS_BASIC_INFORMATION: six pointer-sized fields, the PEB's address second.
            let mut basic = [0usize; 6];
            let mut returned = 0u32;
            // SAFETY: the system writes at most the buffer's size into it.
            let status = unsafe {
                ntdll::NtQueryInformationProcess(
                    process,
                    0,
                    basic.as_mut_ptr().cast(),
                    std::mem::size_of_val(&basic) as u32,
                    &mut returned,
                )
            };
            if status != 0 {
                return;
            }
            let mut word = [0u8; 8];
            if !read(basic[1] + 0x20, &mut word) {
                return;
            }
            let parameters = usize::from_ne_bytes(word);
            let mut path = [0u8; 16];
            if !read(parameters + 0x38, &mut path) {
                return;
            }
            let length = u16::from_ne_bytes([path[0], path[1]]) as usize;
            let buffer = usize::from_ne_bytes(path[8..16].try_into().unwrap());
            let mut text = vec![0u8; length];
            if length == 0 || !read(buffer, &mut text) {
                return;
            }
            let wide: Vec<u16> = text
                .as_chunks::<2>()
                .0
                .iter()
                .map(|pair| u16::from_ne_bytes(*pair))
                .collect();
            found = Some(String::from_utf16_lossy(&wide));
        },
    );
    found
}

/// `path` as a test's shell script names it: as it is, or on Windows with `/` in place of `\`,
/// which Git's sh would otherwise read as escapes.
pub fn sh_path(path: &Path) -> String {
    let text = path.display().to_string();
    if cfg!(windows) {
        text.replace('\\', "/")
    } else {
        text
    }
}
