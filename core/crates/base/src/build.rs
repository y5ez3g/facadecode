//! Which build of Facade this is, and which build takes over from which.
//!
//! A test of a debug build can have a program play another build: it runs the program through a
//! script of its own and names the build in `FACADE_TEST_BUILD`, the script in
//! `FACADE_TEST_PROGRAM`.

use std::path::PathBuf;

/// The package version of every Facade program in this build.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Whether a running Facade of build `running` hands over to one of build `newer`. Only a release
/// with a higher version takes over; a pre-release such as `0.2.0-rc1` neither takes over nor is
/// taken over. Both the command that asks and the daemon it asks go by this.
pub fn takes_over(newer: &str, running: &str) -> bool {
    version_of(newer)
        .zip(version_of(running))
        .is_some_and(|(newer, running)| newer > running)
}

/// The version `build` names, its three numbers before any `+` (`[0, 2, 1]` for `0.2.1+4f2a`).
/// None unless there are exactly three numbers.
pub fn version_of(build: &str) -> Option<[u64; 3]> {
    let (version, _commit) = build.split_once('+').unwrap_or((build, ""));
    let numbers: Vec<u64> = version
        .split('.')
        .map(str::parse)
        .collect::<Result<_, _>>()
        .ok()?;
    numbers.try_into().ok()
}

/// This build, as services compare it: [`VERSION`], then `+` and the commit that `FACADE_BUILD`
/// named when it was compiled, if any. In a test, the build the test has it play.
pub fn build_id() -> String {
    if let Some(played) = played() {
        return played.build.clone();
    }
    let commit = option_env!("FACADE_BUILD").unwrap_or_default();
    if commit.is_empty() {
        VERSION.to_string()
    } else {
        format!("{VERSION}+{commit}")
    }
}

/// This build's version without its commit.
pub fn version() -> String {
    let build = build_id();
    match build.split_once('+') {
        Some((version, _commit)) => version.to_string(),
        None => build,
    }
}

/// The program a service installs to run as this one: this program, or in a test, the test's
/// script.
pub fn this_program() -> std::io::Result<PathBuf> {
    match played() {
        Some(played) => Ok(played.program.clone()),
        None => std::env::current_exe(),
    }
}

/// Reads the build a test has this program play, and clears both variables, so that a program
/// this one starts plays it only when started through the test's script too. Call it first thing
/// in `main`, while no other thread runs. A release build ignores both variables.
pub fn take_test_build() {
    #[cfg(debug_assertions)]
    {
        let build = std::env::var("FACADE_TEST_BUILD").unwrap_or_default();
        let program = std::env::var_os("FACADE_TEST_PROGRAM");
        // SAFETY: no other thread runs yet to read the environment meanwhile.
        unsafe {
            std::env::remove_var("FACADE_TEST_BUILD");
            std::env::remove_var("FACADE_TEST_PROGRAM");
        }
        let played = match program {
            Some(program) if !build.is_empty() => Some(Played {
                build,
                program: program.into(),
            }),
            _ => None,
        };
        let _ = PLAYED.set(played);
    }
}

/// The build a test has this program play, and the script that runs it. Only a debug build makes
/// one.
#[cfg_attr(not(debug_assertions), allow(dead_code))]
struct Played {
    build: String,
    program: PathBuf,
}

#[cfg(debug_assertions)]
static PLAYED: std::sync::OnceLock<Option<Played>> = std::sync::OnceLock::new();

#[cfg(debug_assertions)]
fn played() -> Option<&'static Played> {
    PLAYED.get()?.as_ref()
}

/// A release build never plays another.
#[cfg(not(debug_assertions))]
fn played() -> Option<&'static Played> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A build's version is its three numbers before any `+`.
    #[test]
    fn a_build_s_version_is_its_numbers() {
        assert_eq!(version_of("0.2.1"), Some([0, 2, 1]));
        assert_eq!(version_of("0.10.0+4f2a"), Some([0, 10, 0]));
        assert!(version_of("0.10.0") > version_of("0.9.9"));
        for build in ["", "0.2", "0.2.1.4", "x.2.1", "0.2.1-rc"] {
            assert_eq!(version_of(build), None, "{build}");
        }
    }

    /// A build takes over from a running one where both versions are three numbers and its own are
    /// higher: never from a pre-release, and never as one.
    #[test]
    fn a_build_takes_over_from_a_lower_version_alone() {
        assert!(takes_over("0.2.1", "0.2.0"));
        assert!(takes_over("0.10.0", "0.9.9+4f2a"));
        for (newer, running) in [
            ("0.2.0", "0.2.0"),
            ("0.2.0+b", "0.2.0+a"),
            ("0.1.9", "0.2.0"),
            ("0.2.0", "0.2.0-rc1"),
            ("0.2.1-rc1", "0.2.0"),
        ] {
            assert!(!takes_over(newer, running), "{newer} over {running}");
        }
    }
}
