//! Runs a program in a terminal of its own and parses its visible screen for assertions: a PTY on
//! Unix, the system's pseudo console on Windows, as the person's own terminal gives.

use std::fs::File;
#[cfg(unix)]
use std::io::Read;
use std::io::Write;
use std::process::{Command, ExitStatus};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::*;

#[cfg(unix)]
use std::process::Child;
#[cfg(windows)]
use windows::{Child, Console};

/// A test program with its own terminal and parsed screen.
pub struct TestTerminal {
    writer: Arc<Mutex<File>>,
    screen: Arc<Mutex<facade_screen::Screen>>,
    /// Every byte the program wrote, including text that later output covered.
    output: Arc<Mutex<Vec<u8>>>,
    /// Woken each time output arrives.
    arrived: Arc<std::sync::Condvar>,
    /// Pauses terminal reads to simulate a slow terminal.
    paused: Arc<std::sync::atomic::AtomicBool>,
    child: Child,
    rows: usize,
    /// The pseudo console, closed after the program ends.
    #[cfg(windows)]
    _console: Console,
}

/// Opens a terminal of `size` whose sides no child process inherits: each side is closed on exec
/// from the moment it opens, so not even a `facade` command another test starts meanwhile holds it.
/// Such a child would keep the terminal open after the test closed it. The program the test runs
/// gets the CLI side as its standard streams, which do not close on exec.
#[cfg(unix)]
fn open_terminal(size: &nix::pty::Winsize) -> nix::pty::OpenptyResult {
    use nix::fcntl::OFlag;
    use std::os::fd::AsRawFd;
    // ptsname names the CLI side in a buffer of its own, which a call on another thread could
    // overwrite meanwhile.
    static NAMING: Mutex<()> = Mutex::new(());
    let master = nix::pty::posix_openpt(OFlag::O_RDWR | OFlag::O_NOCTTY | OFlag::O_CLOEXEC)
        .expect("could not open a PTY");
    nix::pty::grantpt(&master).expect("could not open a PTY");
    nix::pty::unlockpt(&master).expect("could not open a PTY");
    let name = {
        let _naming = NAMING.lock().unwrap();
        // SAFETY: the name is copied out of ptsname's buffer before another call, which the lock
        // keeps out.
        unsafe { nix::pty::ptsname(&master) }.expect("could not name the PTY")
    };
    let slave = nix::fcntl::open(
        name.as_str(),
        OFlag::O_RDWR | OFlag::O_NOCTTY | OFlag::O_CLOEXEC,
        nix::sys::stat::Mode::empty(),
    )
    .expect("could not open the PTY");
    nix::ioctl_write_ptr_bad!(set_window_size, libc::TIOCSWINSZ, nix::pty::Winsize);
    // SAFETY: TIOCSWINSZ reads a winsize for the terminal this function opened.
    unsafe { set_window_size(slave.as_raw_fd(), size) }.expect("could not size the PTY");
    nix::pty::OpenptyResult {
        master: master.into(),
        slave,
    }
}

/// Starts `command` in a new PTY of `cols` by `rows`: its child, the master to write keys to, and
/// a copy of it to read output from.
#[cfg(unix)]
fn start(command: &mut Command, cols: u16, rows: u16) -> (Child, File, File) {
    use std::os::unix::process::CommandExt;
    let size = nix::pty::Winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    let pty = open_terminal(&size);
    let slave = File::from(pty.slave);
    command
        .stdin(
            slave
                .try_clone()
                .expect("could not clone the PTY descriptor"),
        )
        .stdout(
            slave
                .try_clone()
                .expect("could not clone the PTY descriptor"),
        )
        .stderr(slave);
    // SAFETY: setsid and the controlling-terminal ioctl are async-signal-safe and affect only
    // the spawned process.
    unsafe {
        command.pre_exec(|| {
            libc::setsid();
            libc::ioctl(0, libc::TIOCSCTTY as _, 0);
            Ok(())
        });
    }
    command.env("TERM", "xterm-256color");
    let child = command
        .spawn()
        .expect("could not start the test program in its terminal");
    let master = File::from(pty.master);
    let reader = master
        .try_clone()
        .expect("could not clone the PTY descriptor");
    (child, master, reader)
}

/// Whether the terminal has output to read within `ms` milliseconds; None once it never will.
#[cfg(unix)]
fn readable(reader: &File, ms: i32) -> Option<bool> {
    use std::os::fd::AsRawFd;
    let mut poll = libc::pollfd {
        fd: reader.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    // SAFETY: poll receives one valid pollfd for the duration of the call.
    Some(unsafe { libc::poll(&mut poll, 1, ms) } > 0)
}

impl TestTerminal {
    pub fn spawn(command: &mut Command, cols: u16, rows: u16) -> TestTerminal {
        Self::spawn_with_colors(
            command,
            cols,
            rows,
            facade_screen::TerminalColors::default(),
        )
    }

    pub fn spawn_with_colors(
        command: &mut Command,
        cols: u16,
        rows: u16,
        colors: facade_screen::TerminalColors,
    ) -> TestTerminal {
        #[cfg(unix)]
        let (child, master, mut reader) = start(command, cols, rows);
        #[cfg(windows)]
        let (console, child, master, reader) = windows::start(command, cols, rows);
        let writer = Arc::new(Mutex::new(master));
        let mut screen = facade_screen::Screen::new(cols, rows, 1000);
        screen.set_colors(colors);
        let screen = Arc::new(Mutex::new(screen));
        let output = Arc::new(Mutex::new(Vec::new()));
        let arrived = Arc::new(std::sync::Condvar::new());
        let arrived_in = arrived.clone();
        let paused = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (screen_in, writer_in, paused_in, output_in) = (
            screen.clone(),
            writer.clone(),
            paused.clone(),
            output.clone(),
        );
        // An anonymous pipe has no wait for readiness: on Windows a thread of its own blocks in its
        // reads, and hands what it read over a channel, which the loop waits on.
        #[cfg(windows)]
        let chunks = windows::reading(reader, paused.clone());
        std::thread::spawn(move || {
            #[cfg(unix)]
            let mut buffer = [0u8; 65536];
            loop {
                if paused_in.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(20));
                    continue;
                }
                let mut replies = Vec::new();
                #[cfg(unix)]
                let read = match readable(&reader, 50) {
                    None => break,
                    Some(false) => None,
                    Some(true) => match reader.read(&mut buffer) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => Some(buffer[..n].to_vec()),
                    },
                };
                #[cfg(windows)]
                let read = match chunks.recv_timeout(Duration::from_millis(50)) {
                    Ok(chunk) => Some(chunk),
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => None,
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                };
                if let Some(bytes) = read {
                    output_in.lock().unwrap().extend_from_slice(&bytes);
                    arrived_in.notify_all();
                    replies.extend(screen_in.lock().unwrap().feed(&bytes).query_replies);
                }
                {
                    // Apply a synchronized update when its timeout expires.
                    let mut screen = screen_in.lock().unwrap();
                    if screen
                        .synchronized_update_deadline()
                        .is_some_and(|deadline| Instant::now() >= deadline)
                    {
                        replies.extend(screen.end_synchronized_update().query_replies);
                    }
                }
                if !replies.is_empty() {
                    let _ = writer_in.lock().unwrap().write_all(&replies);
                }
            }
        });
        TestTerminal {
            writer,
            screen,
            output,
            arrived,
            paused,
            child,
            rows: rows as usize,
            #[cfg(windows)]
            _console: console,
        }
    }

    /// Pauses or resumes terminal reads. Output waits while paused.
    pub fn pause(&self, paused: bool) {
        self.paused.store(paused, Ordering::SeqCst);
    }

    /// A second handle for writing keys, for typing from another thread without holding up this
    /// terminal.
    pub fn keyboard(&self) -> File {
        self.writer
            .lock()
            .unwrap()
            .try_clone()
            .expect("could not clone the terminal's input")
    }

    /// Writes keys and text to the terminal.
    pub fn send(&self, bytes: &[u8]) {
        if let Err(err) = self.writer.lock().unwrap().write_all(bytes) {
            panic!(
                "could not write terminal input: {err}; the program's screen:\n{}",
                self.text_with_scrollback()
            );
        }
    }

    /// Changes the actual terminal capacity and the screen that reads its output.
    pub fn resize(&mut self, cols: u16, rows: u16) {
        self.rows = usize::from(rows);
        let mut screen = self.screen.lock().unwrap();
        screen.resize(cols, rows);
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            let size = nix::pty::Winsize {
                ws_row: rows,
                ws_col: cols,
                ws_xpixel: 0,
                ws_ypixel: 0,
            };
            nix::ioctl_write_ptr_bad!(resize_terminal, libc::TIOCSWINSZ, nix::pty::Winsize);
            // SAFETY: the master descriptor stays open while the terminal owns it.
            unsafe { resize_terminal(self.writer.lock().unwrap().as_raw_fd(), &size) }
                .expect("could not resize the test terminal");
        }
        #[cfg(windows)]
        self._console.resize(cols, rows);
    }

    /// Visible cells before wrapped rows are joined into logical lines.
    pub fn view(&self) -> facade_screen::ScreenView {
        self.screen.lock().unwrap().view()
    }

    /// Whether the displayed program has taken the host's mouse events.
    pub fn reports_mouse(&self) -> bool {
        self.screen.lock().unwrap().reports_mouse()
    }

    /// Returns visible text with one line per screen row.
    pub fn text(&self) -> String {
        self.screen.lock().unwrap().text(self.rows).join("\n")
    }

    /// Waits until the program has written `text`, even if later output covered it on the screen.
    pub fn wait_for_output(&self, timeout: Duration, text: &str) -> bool {
        wait_until(timeout, || self.output_count(text) > 0)
    }

    /// How many times the program has written `text`, including text that later output covered.
    pub fn output_count(&self, text: &str) -> usize {
        String::from_utf8_lossy(&self.output.lock().unwrap())
            .matches(text)
            .count()
    }

    /// Waits up to `timeout` until the program writes `bytes` after its first `from`, woken as
    /// its output arrives: a wait by sleeps would add the system's timer tick, 15.6 ms on Windows.
    pub fn wait_for_bytes(&self, from: usize, bytes: &[u8], timeout: Duration) -> bool {
        let end = Instant::now() + timeout;
        let mut output = self.output.lock().unwrap();
        loop {
            let found = output
                .get(from..)
                .is_some_and(|new| new.windows(bytes.len()).any(|part| part == bytes));
            let now = Instant::now();
            if found || now >= end {
                return found;
            }
            output = self.arrived.wait_timeout(output, end - now).unwrap().0;
        }
    }

    /// How many bytes the program has written so far.
    pub fn output_len(&self) -> usize {
        self.output.lock().unwrap().len()
    }

    /// The bytes the program wrote after the first `from`.
    pub fn output_since(&self, from: usize) -> Vec<u8> {
        self.output
            .lock()
            .unwrap()
            .get(from..)
            .unwrap_or_default()
            .to_vec()
    }

    /// The visible screen's rows, one string per row.
    pub fn rows(&self) -> Vec<String> {
        let text = self.screen.lock().unwrap().text(self.rows);
        text.into_iter()
            .chain(std::iter::repeat(String::new()))
            .take(self.rows)
            .collect()
    }

    /// Returns the terminal's scrollback and visible text, one line per logical line.
    pub fn text_with_scrollback(&self) -> String {
        self.screen
            .lock()
            .unwrap()
            .text(self.rows + 1000)
            .join("\n")
    }

    pub fn wait_for(&self, timeout: Duration, check: impl Fn(&str) -> bool) -> bool {
        wait_until(timeout, || check(&self.text()))
    }

    /// Checks whether the alternate screen is active.
    pub fn on_alternate_screen(&self) -> bool {
        self.screen.lock().unwrap().on_alternate_screen()
    }

    /// Checks whether bracketed paste is enabled.
    pub fn bracketed_paste(&self) -> bool {
        self.screen.lock().unwrap().bracketed_paste()
    }

    /// Checks for cooked input with canonical line handling and echo. A pseudo console's modes
    /// belong to its console host, which another process cannot read, so this is Unix's alone.
    #[cfg(unix)]
    pub fn canonical_input_and_echo_enabled(&self) -> bool {
        use std::os::fd::AsRawFd;
        let fd = self.writer.lock().unwrap().as_raw_fd();
        // SAFETY: termios has a valid all-zero initial representation.
        let mut termios: libc::termios = unsafe { std::mem::zeroed() };
        // SAFETY: tcgetattr writes to a valid termios structure using a descriptor held open by the
        // terminal.
        let ok = unsafe { libc::tcgetattr(fd, &mut termios) } == 0;
        ok && termios.c_lflag & libc::ICANON != 0 && termios.c_lflag & libc::ECHO != 0
    }

    /// Waits up to `timeout` for the program to exit.
    pub fn wait_exit(&mut self, timeout: Duration) -> Option<ExitStatus> {
        let end = Instant::now() + timeout;
        loop {
            if let Ok(Some(status)) = self.child.try_wait() {
                return Some(status);
            }
            if Instant::now() >= end {
                return None;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    pub fn pid(&self) -> i32 {
        self.child.id() as i32
    }
}

impl Drop for TestTerminal {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// A pseudo console of the ConPTY package that Facade's build carries, as Windows Terminal, the
/// person's own terminal on Windows 11, runs one: its console host passes output on as it comes,
/// where the system's holds it to its frame cadence.
#[cfg(windows)]
mod windows {
    use std::ffi::OsStr;
    use std::fs::File;
    use std::io;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};
    use std::os::windows::process::ExitStatusExt;
    use std::process::{Command, ExitStatus};
    use std::time::Duration;

    use windows_sys::Win32::Foundation::{HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Console::{COORD, HPCON};
    use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryExW};
    use windows_sys::Win32::System::Pipes::CreatePipe;
    use windows_sys::Win32::System::Threading::{
        CREATE_UNICODE_ENVIRONMENT, CreateProcessW, DeleteProcThreadAttributeList,
        EXTENDED_STARTUPINFO_PRESENT, GetExitCodeProcess, INFINITE,
        InitializeProcThreadAttributeList, LPPROC_THREAD_ATTRIBUTE_LIST,
        PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, PROCESS_INFORMATION, STARTF_USESTDHANDLES,
        STARTUPINFOEXW, TerminateProcess, UpdateProcThreadAttribute, WaitForSingleObject,
    };

    type Create = unsafe extern "system" fn(COORD, HANDLE, HANDLE, u32, *mut HPCON) -> i32;
    type Close = unsafe extern "system" fn(HPCON);
    type Resize = unsafe extern "system" fn(HPCON, COORD) -> i32;

    /// The console functions from the `conpty` folder the build puts beside its programs.
    /// The package starts its `OpenConsole.exe` from there.
    fn package() -> (Create, Close, Resize) {
        static FUNCTIONS: std::sync::OnceLock<(Create, Close, Resize)> = std::sync::OnceLock::new();
        *FUNCTIONS.get_or_init(|| {
            let dll = crate::test_binaries()
                .facade
                .with_file_name("conpty")
                .join("conpty.dll");
            // LOAD_WITH_ALTERED_SEARCH_PATH: what it needs, from its own folder.
            // SAFETY: the path is NUL-terminated; the module stays loaded for the process.
            let module = unsafe {
                LoadLibraryExW(wide(dll.as_os_str()).as_ptr(), std::ptr::null_mut(), 0x8)
            };
            assert!(
                !module.is_null(),
                "could not load {}: {}",
                dll.display(),
                io::Error::last_os_error()
            );
            // SAFETY: all names are the package's exports, of these signatures.
            unsafe {
                let create = GetProcAddress(module, c"CreatePseudoConsole".as_ptr().cast())
                    .expect("the package's CreatePseudoConsole");
                let close = GetProcAddress(module, c"ClosePseudoConsole".as_ptr().cast())
                    .expect("the package's ClosePseudoConsole");
                let resize = GetProcAddress(module, c"ResizePseudoConsole".as_ptr().cast())
                    .expect("the package's ResizePseudoConsole");
                (
                    std::mem::transmute::<unsafe extern "system" fn() -> isize, Create>(create),
                    std::mem::transmute::<unsafe extern "system" fn() -> isize, Close>(close),
                    std::mem::transmute::<unsafe extern "system" fn() -> isize, Resize>(resize),
                )
            }
        })
    }

    /// A pseudo console, closed when dropped.
    pub struct Console(HPCON);

    impl Console {
        pub fn resize(&self, cols: u16, rows: u16) {
            let size = COORD {
                X: cols.try_into().unwrap(),
                Y: rows.try_into().unwrap(),
            };
            // SAFETY: the handle stays open while `self` lives.
            let result = unsafe { (package().2)(self.0, size) };
            assert!(
                result >= 0,
                "ResizePseudoConsole failed with HRESULT {result:#x}"
            );
        }
    }

    // SAFETY: an HPCON may be closed from any thread.
    unsafe impl Send for Console {}

    impl Drop for Console {
        fn drop(&mut self) {
            // SAFETY: the console was created by `start` and is closed once.
            unsafe { (package().1)(self.0) };
        }
    }

    /// The program in the console, by its process handle.
    pub struct Child {
        process: OwnedHandle,
        pid: u32,
    }

    impl Child {
        pub fn id(&self) -> u32 {
            self.pid
        }

        pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
            self.wait_for(0)
        }

        pub fn wait(&mut self) -> io::Result<ExitStatus> {
            self.wait_for(INFINITE)
                .map(|status| status.expect("the program ended"))
        }

        pub fn kill(&mut self) -> io::Result<()> {
            // SAFETY: the handle is open while `self` lives.
            if unsafe { TerminateProcess(self.handle(), 1) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }

        fn handle(&self) -> HANDLE {
            self.process.as_raw_handle() as HANDLE
        }

        fn wait_for(&self, ms: u32) -> io::Result<Option<ExitStatus>> {
            // SAFETY: the handle is open while `self` lives.
            if unsafe { WaitForSingleObject(self.handle(), ms) } != WAIT_OBJECT_0 {
                return Ok(None);
            }
            let mut code = 0u32;
            // SAFETY: the handle is open, and the code is written into a valid u32.
            if unsafe { GetExitCodeProcess(self.handle(), &mut code) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(Some(ExitStatus::from_raw(code)))
        }
    }

    fn owned(handle: HANDLE) -> OwnedHandle {
        // SAFETY: the caller passes a handle it opened and owns from here on.
        unsafe { OwnedHandle::from_raw_handle(handle as RawHandle) }
    }

    fn wide(text: &OsStr) -> Vec<u16> {
        text.encode_wide().chain(std::iter::once(0)).collect()
    }

    /// `argument` quoted for a Windows command line, as programs built with the C runtime and Rust
    /// split it back.
    fn quoted(argument: &OsStr) -> Vec<u16> {
        let text: Vec<u16> = argument.encode_wide().collect();
        let plain = !text.is_empty()
            && !text
                .iter()
                .any(|&c| c == ' ' as u16 || c == '\t' as u16 || c == '"' as u16);
        if plain {
            return text;
        }
        let mut out = vec!['"' as u16];
        let mut backslashes = 0;
        for &c in &text {
            if c == '\\' as u16 {
                backslashes += 1;
                continue;
            }
            let doubled = if c == '"' as u16 {
                backslashes * 2 + 1
            } else {
                backslashes
            };
            out.extend(std::iter::repeat_n('\\' as u16, doubled));
            backslashes = 0;
            out.push(c);
        }
        out.extend(std::iter::repeat_n('\\' as u16, backslashes * 2));
        out.push('"' as u16);
        out
    }

    /// The command's environment block: the variables it sets, with `TERM`, sorted without regard
    /// to case as Windows keeps them. The tests build terminal commands with `TestHome::command`,
    /// which clears every other variable.
    fn environment(command: &Command) -> Vec<u16> {
        let mut variables: Vec<(String, String)> = command
            .get_envs()
            .filter_map(|(name, value)| {
                Some((
                    name.to_string_lossy().into_owned(),
                    value?.to_string_lossy().into_owned(),
                ))
            })
            .filter(|(name, _)| !name.eq_ignore_ascii_case("TERM"))
            .collect();
        variables.push(("TERM".into(), "xterm-256color".into()));
        variables.sort_by_key(|(name, _)| name.to_uppercase());
        let mut block = Vec::new();
        for (name, value) in variables {
            block.extend(format!("{name}={value}").encode_utf16());
            block.push(0);
        }
        block.push(0);
        block
    }

    /// Starts `command` in a new pseudo console of `cols` by `rows`: the console, its program, the
    /// console's input to write keys to, and its output to read.
    pub fn start(command: &mut Command, cols: u16, rows: u16) -> (Console, Child, File, File) {
        let (mut input_read, mut input_write): (HANDLE, HANDLE) =
            (std::ptr::null_mut(), std::ptr::null_mut());
        let (mut output_read, mut output_write): (HANDLE, HANDLE) =
            (std::ptr::null_mut(), std::ptr::null_mut());
        // SAFETY: CreatePipe writes two handles into valid locations.
        unsafe {
            assert!(
                CreatePipe(&mut input_read, &mut input_write, std::ptr::null(), 0) != 0
                    && CreatePipe(&mut output_read, &mut output_write, std::ptr::null(), 0) != 0,
                "could not make the console's pipes: {}",
                io::Error::last_os_error()
            );
        }
        let (input_read, input_write) = (owned(input_read), owned(input_write));
        let (output_read, output_write) = (owned(output_read), owned(output_write));
        // SAFETY: an HPCON is a plain value, written by CreatePseudoConsole.
        let mut console: HPCON = unsafe { std::mem::zeroed() };
        let size = COORD {
            X: cols as i16,
            Y: rows as i16,
        };
        // SAFETY: the console host duplicates the two pipe ends it is given; ours are closed below.
        let made = unsafe {
            (package().0)(
                size,
                input_read.as_raw_handle() as HANDLE,
                output_write.as_raw_handle() as HANDLE,
                0,
                &mut console,
            )
        };
        assert!(made >= 0, "could not make a pseudo console: {made:#x}");
        let console = Console(console);
        drop((input_read, output_write));

        let mut line = quoted(command.get_program());
        for argument in command.get_args() {
            line.push(' ' as u16);
            line.extend(quoted(argument));
        }
        line.push(0);
        let env = environment(command);
        let folder = command
            .get_current_dir()
            .map(|folder| wide(folder.as_os_str()));

        let mut list_size = 0usize;
        // SAFETY: the first call only reports the size the list needs.
        unsafe { InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut list_size) };
        let mut list = vec![0u8; list_size];
        let list_ptr = list.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
        // SAFETY: the list has the size the system asked for, and lives until it is deleted below.
        // The pseudo console attribute takes the HPCON itself as its value.
        unsafe {
            assert!(
                InitializeProcThreadAttributeList(list_ptr, 1, 0, &mut list_size) != 0
                    && UpdateProcThreadAttribute(
                        list_ptr,
                        0,
                        PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
                        console.0 as *const core::ffi::c_void,
                        std::mem::size_of::<HPCON>(),
                        std::ptr::null_mut(),
                        std::ptr::null(),
                    ) != 0,
                "could not give the program its console: {}",
                io::Error::last_os_error()
            );
        }
        // SAFETY: STARTUPINFOEXW is plain data, valid with every byte zero.
        let mut startup: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
        startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        // Without this, a program started while the tests' own output is redirected takes that
        // output as its standard streams, in place of the console's.
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = INVALID_HANDLE_VALUE;
        startup.StartupInfo.hStdOutput = INVALID_HANDLE_VALUE;
        startup.StartupInfo.hStdError = INVALID_HANDLE_VALUE;
        startup.lpAttributeList = list_ptr;
        // SAFETY: PROCESS_INFORMATION is plain data, written by CreateProcessW.
        let mut process: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
        // SAFETY: every buffer is valid and NUL-terminated for the call, and no handle is inherited.
        let started = unsafe {
            CreateProcessW(
                std::ptr::null(),
                line.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
                env.as_ptr().cast(),
                folder
                    .as_ref()
                    .map_or(std::ptr::null(), |folder| folder.as_ptr()),
                &startup.StartupInfo,
                &mut process,
            )
        };
        let error = io::Error::last_os_error();
        // SAFETY: the list was initialized above and is deleted once.
        unsafe { DeleteProcThreadAttributeList(list_ptr) };
        assert!(
            started != 0,
            "could not start the test program in its terminal: {error}"
        );
        drop(owned(process.hThread));
        let child = Child {
            process: owned(process.hProcess),
            pid: process.dwProcessId,
        };
        let reader = File::from(output_read);
        (console, child, File::from(input_write), reader)
    }

    /// What the console writes, read by a thread of its own that blocks in each read, and sent
    /// as it comes; the channel closes once the console's output ends. While `paused`, it reads
    /// nothing, so that the output waits, as a slow terminal makes it.
    pub fn reading(
        mut reader: File,
        paused: std::sync::Arc<std::sync::atomic::AtomicBool>,
    ) -> std::sync::mpsc::Receiver<Vec<u8>> {
        use std::io::Read;
        let (chunks, read) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut buffer = [0u8; 65536];
            loop {
                if paused.load(std::sync::atomic::Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(20));
                    continue;
                }
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if chunks.send(buffer[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                }
            }
        });
        read
    }
}
