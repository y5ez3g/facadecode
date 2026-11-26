//! The clipboard of the computer the person sits at.

/// Puts `text` on the clipboard, for the terminals that ignore a program's own copy sequence. It
/// never waits for the clipboard. It does nothing over SSH, where that is another computer's, and on
/// Windows, whose terminals follow the sequence.
pub fn copy(text: String) {
    #[cfg(unix)]
    if !super::over_ssh() {
        std::thread::spawn(move || imp::copy(&text));
    }
    #[cfg(windows)]
    drop(text);
}

#[cfg(unix)]
mod imp {
    use std::io::Write;
    use std::process::{Command, Stdio};

    type Program = (&'static str, &'static [&'static str]);

    pub(super) fn copy(text: &str) {
        programs()
            .into_iter()
            .any(|(program, args)| write(program, args, text));
    }

    /// The programs to try, in order, for the system and the display server in use.
    fn programs() -> Vec<Program> {
        if cfg!(target_os = "macos") {
            return vec![("/usr/bin/pbcopy", &[])];
        }
        let mut programs: Vec<Program> = Vec::new();
        if std::env::var_os("WAYLAND_DISPLAY").is_some() {
            programs.push(("wl-copy", &[]));
        }
        if std::env::var_os("DISPLAY").is_some() {
            programs.push(("xclip", &["-selection", "clipboard"]));
            programs.push(("xsel", &["--clipboard", "--input"]));
        }
        programs
    }

    fn write(program: &str, args: &[&str], text: &str) -> bool {
        let child = Command::new(program)
            .args(args)
            // The encoding macOS's program reads.
            .env("LC_CTYPE", "UTF-8")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        let Ok(mut child) = child else {
            return false;
        };
        let written = child
            .stdin
            .take()
            .is_some_and(|mut stdin| stdin.write_all(text.as_bytes()).is_ok());
        written && child.wait().is_ok_and(|status| status.success())
    }
}
