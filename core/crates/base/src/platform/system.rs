//! Which operating system this build runs on. Outside platform, only rules reads it, to choose the
//! rule data that differs by system.

/// The operating systems Facade builds for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum System {
    /// macOS and Linux.
    Unix,
    Windows,
}

/// The system this build runs on.
#[cfg(unix)]
pub const SYSTEM: System = System::Unix;

/// The system this build runs on.
#[cfg(windows)]
pub const SYSTEM: System = System::Windows;

/// The value of the variable `name` in `env`. Windows compares names without regard to case, as
/// it gives `Path` where Unix gives `PATH`; Unix compares them exactly.
pub fn env_var<'a>(
    env: &'a std::collections::BTreeMap<String, String>,
    name: &str,
) -> Option<&'a str> {
    #[cfg(unix)]
    return env.get(name).map(String::as_str);
    #[cfg(windows)]
    env.iter()
        .find(|(each, _)| each.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

/// The user's home folder as programs on this system find it in the environment `env`, as Node's
/// `os.homedir()` does: `USERPROFILE` on Windows, `HOME` on Unix; None where it is unset or empty.
pub fn home_folder_in(
    env: &std::collections::BTreeMap<String, String>,
) -> Option<std::path::PathBuf> {
    #[cfg(unix)]
    let name = "HOME";
    #[cfg(windows)]
    let name = "USERPROFILE";
    env_var(env, name)
        .filter(|home| !home.is_empty())
        .map(std::path::PathBuf::from)
}
