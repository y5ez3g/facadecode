//! A fresh PTY for a CLI, already in the modes an editor terminal starts in.

use std::os::fd::{BorrowedFd, OwnedFd};

use facade_base::jsonrpc::{ErrorBody, Reason};
use nix::fcntl::{FcntlArg, FdFlag, fcntl};
use nix::pty::{Winsize, openpty};
use nix::sys::termios::{
    BaudRate, ControlFlags, InputFlags, LocalFlags, OutputFlags, SetArg,
    SpecialCharacterIndices as Cc, cfsetispeed, cfsetospeed, tcgetattr, tcsetattr,
};

/// Both ends of a CLI's PTY.
pub(super) struct Terminal {
    /// The side Facade reads and writes.
    pub(super) master: OwnedFd,
    /// The side the CLI gets as its standard input, output and error.
    pub(super) slave: OwnedFd,
}

/// Opens a `cols` × `rows` PTY. Neither end leaks into another CLI: both are close-on-exec.
pub(super) fn open(cols: u16, rows: u16) -> Result<Terminal, ErrorBody> {
    let window = Winsize {
        ws_col: cols,
        ws_row: rows,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    let opened = openpty(&window, None).map_err(|errno| no_terminal(errno.into()))?;
    let terminal = Terminal {
        master: opened.master,
        slave: opened.slave,
    };
    let cloexec = |fd: &OwnedFd| fcntl(fd, FcntlArg::F_SETFD(FdFlag::FD_CLOEXEC));
    cloexec(&terminal.master)
        .and_then(|_| cloexec(&terminal.slave))
        .map_err(|errno| no_terminal(errno.into()))?;
    set_modes(std::os::fd::AsFd::as_fd(&terminal.slave)).map_err(|errno| {
        ErrorBody::new(
            Reason::Unavailable,
            format!("could not set up the terminal: {errno}"),
        )
    })?;
    Ok(terminal)
}

/// Cooked mode with echo, signals from Ctrl+C and friends, CR/NL translation and UTF-8 input:
/// what VS Code's terminal hands a shell.
fn set_modes(slave: BorrowedFd<'_>) -> nix::Result<()> {
    let mut t = tcgetattr(slave)?;
    t.input_flags = InputFlags::IUTF8
        | InputFlags::ICRNL
        | InputFlags::BRKINT
        | InputFlags::IMAXBEL
        | InputFlags::IXON
        | InputFlags::IXANY;
    t.output_flags = OutputFlags::OPOST | OutputFlags::ONLCR;
    t.control_flags = ControlFlags::CS8 | ControlFlags::CREAD | ControlFlags::HUPCL;
    t.local_flags = LocalFlags::ICANON
        | LocalFlags::ECHO
        | LocalFlags::ECHOE
        | LocalFlags::ECHOK
        | LocalFlags::ECHOKE
        | LocalFlags::ECHOCTL
        | LocalFlags::ISIG
        | LocalFlags::IEXTEN;
    let cc = &mut t.control_chars;
    cc[Cc::VINTR as usize] = ctrl(b'C');
    cc[Cc::VQUIT as usize] = 0x1c;
    cc[Cc::VERASE as usize] = 0x7f;
    cc[Cc::VKILL as usize] = ctrl(b'U');
    cc[Cc::VEOF as usize] = ctrl(b'D');
    cc[Cc::VEOL as usize] = 0xff;
    cc[Cc::VEOL2 as usize] = 0xff;
    cc[Cc::VSTART as usize] = ctrl(b'Q');
    cc[Cc::VSTOP as usize] = ctrl(b'S');
    cc[Cc::VSUSP as usize] = ctrl(b'Z');
    cc[Cc::VREPRINT as usize] = ctrl(b'R');
    cc[Cc::VWERASE as usize] = ctrl(b'W');
    cc[Cc::VLNEXT as usize] = ctrl(b'V');
    cc[Cc::VDISCARD as usize] = ctrl(b'O');
    cc[Cc::VMIN as usize] = 1;
    cc[Cc::VTIME as usize] = 0;
    #[cfg(target_os = "macos")]
    {
        cc[Cc::VDSUSP as usize] = ctrl(b'Y');
        cc[Cc::VSTATUS as usize] = ctrl(b'T');
    }
    cfsetispeed(&mut t, BaudRate::B38400)?;
    cfsetospeed(&mut t, BaudRate::B38400)?;
    tcsetattr(slave, SetArg::TCSANOW, &t)
}

/// The byte Ctrl+`key` sends.
const fn ctrl(key: u8) -> u8 {
    key & 0x1f
}

/// The error for a PTY that could not be opened. Running out of PTYs is a macOS limit people hit,
/// so there the message says how many are in use and how to raise the limit.
fn no_terminal(err: std::io::Error) -> ErrorBody {
    let message = format!("could not open a terminal: {err}");
    #[cfg(target_os = "macos")]
    let mut message = message;
    #[cfg(target_os = "macos")]
    if let Some(limit) = macos::pty_limit() {
        let in_use = macos::ptys_in_use();
        message.push_str(&format!(
            ". macOS allows {limit} terminals at once (kern.tty.ptmx_max) and {in_use} are in use; \
             `sudo sysctl -w kern.tty.ptmx_max=999` raises the limit until the Mac restarts"
        ));
    }
    ErrorBody::new(Reason::Unavailable, message)
}

#[cfg(target_os = "macos")]
mod macos {
    /// `kern.tty.ptmx_max`, the most PTYs the system hands out.
    pub(super) fn pty_limit() -> Option<usize> {
        let mut value: libc::c_int = 0;
        let mut len = std::mem::size_of_val(&value);
        // SAFETY: the output buffer is a c_int and `len` is its exact size; nothing is written.
        let status = unsafe {
            libc::sysctlbyname(
                c"kern.tty.ptmx_max".as_ptr(),
                std::ptr::addr_of_mut!(value).cast(),
                &mut len,
                std::ptr::null_mut(),
                0,
            )
        };
        (status == 0).then(|| usize::try_from(value).unwrap_or(0))
    }

    /// PTYs in use, counted as `/dev/ttysNNN` nodes.
    pub(super) fn ptys_in_use() -> usize {
        let Ok(dev) = std::fs::read_dir("/dev") else {
            return 0;
        };
        dev.flatten()
            .filter(|entry| {
                let name = entry.file_name();
                let Some(rest) = name.to_str().and_then(|n| n.strip_prefix("ttys")) else {
                    return false;
                };
                !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit())
            })
            .count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_terminal_takes_utf8_lines_with_the_usual_control_keys() {
        let terminal = open(80, 24).unwrap();
        let modes = tcgetattr(&terminal.slave).unwrap();
        assert!(
            modes
                .input_flags
                .contains(InputFlags::IUTF8 | InputFlags::ICRNL | InputFlags::IXANY)
        );
        assert!(
            modes
                .local_flags
                .contains(LocalFlags::ICANON | LocalFlags::ECHOCTL)
        );
        assert_eq!(modes.control_chars[Cc::VERASE as usize], 0x7f);
    }

    #[test]
    fn neither_side_of_a_terminal_passes_to_a_child() {
        let terminal = open(80, 24).unwrap();
        for fd in [&terminal.master, &terminal.slave] {
            let flags = FdFlag::from_bits_truncate(fcntl(fd, FcntlArg::F_GETFD).unwrap());
            assert!(flags.contains(FdFlag::FD_CLOEXEC));
        }
    }
}
