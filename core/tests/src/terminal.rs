//! Runs a program in a PTY and parses its visible screen for assertions.

use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, ExitStatus};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::*;

/// A test program with its own PTY and parsed screen.
pub struct TestTerminal {
    writer: Arc<Mutex<File>>,
    screen: Arc<Mutex<facade_screen::Screen>>,
    /// Every byte the program wrote, including text that later output covered.
    output: Arc<Mutex<Vec<u8>>>,
    /// Pauses PTY reads to simulate a slow terminal.
    paused: Arc<std::sync::atomic::AtomicBool>,
    child: Child,
    rows: usize,
}

/// Opens a terminal of `size` whose sides no child process inherits: each side is closed on exec
/// from the moment it opens, so not even a `facade` command another test starts meanwhile holds it.
/// Such a child would keep the terminal open after the test closed it. The program the test runs
/// gets the CLI side as its standard streams, which do not close on exec.
fn open_terminal(size: &nix::pty::Winsize) -> nix::pty::OpenptyResult {
    use nix::fcntl::OFlag;
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

impl TestTerminal {
    pub fn spawn(command: &mut Command, cols: u16, rows: u16) -> TestTerminal {
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
        let mut reader = master
            .try_clone()
            .expect("could not clone the PTY descriptor");
        let writer = Arc::new(Mutex::new(master));
        let screen = Arc::new(Mutex::new(facade_screen::Screen::new(cols, rows, 1000)));
        let output = Arc::new(Mutex::new(Vec::new()));
        let paused = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (screen_in, writer_in, paused_in, output_in) = (
            screen.clone(),
            writer.clone(),
            paused.clone(),
            output.clone(),
        );
        std::thread::spawn(move || {
            let mut buffer = [0u8; 65536];
            let fd = reader.as_raw_fd();
            loop {
                if paused_in.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(20));
                    continue;
                }
                let mut poll = libc::pollfd {
                    fd,
                    events: libc::POLLIN,
                    revents: 0,
                };
                // SAFETY: poll receives one valid pollfd for the duration of the call.
                let ready = unsafe { libc::poll(&mut poll, 1, 50) };
                let mut replies = Vec::new();
                if ready > 0 {
                    match reader.read(&mut buffer) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            output_in.lock().unwrap().extend_from_slice(&buffer[..n]);
                            replies
                                .extend(screen_in.lock().unwrap().feed(&buffer[..n]).query_replies)
                        }
                    }
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
            paused,
            child,
            rows: rows as usize,
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
            .expect("could not clone the PTY descriptor")
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

    /// Checks for cooked input with canonical line handling and echo.
    pub fn canonical_input_and_echo_enabled(&self) -> bool {
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
