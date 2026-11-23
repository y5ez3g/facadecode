//! Programs on Windows: `PATH` and `PATHEXT`, batch files through cmd.exe, and launchers that are
//! copies, pointed at another build by renaming the one in use aside and copying the new one in.

use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::{self, Read};
use std::os::windows::fs::FileExt;
use std::path::{Path, PathBuf};

use windows_sys::Win32::System::SystemInformation::GetSystemDirectoryW;

use super::{Bin, CONPTY_FOLDER, PROGRAMS};
use crate::platform::system::{env_var, home_folder_in};

/// The file in the programs' folder that names the build the launchers are copies of, alone.
const CURRENT_BUILD: &str = "current-build";

/// The extensions Windows tries where `PATHEXT` is not set.
const DEFAULT_PATHEXT: &str = ".COM;.EXE;.BAT;.CMD";

/// What cmd.exe reads as its own in an argument, or which ends one: text with any of these that
/// goes through it could run commands or lose what follows (CLIS-1.2). Parentheses reach a batch
/// file's `%*` whole, quoted or not, and are not among them.
const CMD_SPECIAL: [char; 9] = ['"', '%', '^', '&', '|', '<', '>', '!', '\n'];

/// How much of a program is compared at a time.
const CHUNK_BYTES: usize = 1 << 20;

// The program a command names.

/// The program a `command` names (CONFIGURATION-2.2), as on Unix, with `\` as well as `/` in a
/// path and the home folder from [`crate::platform::system::home_folder_in`]. A path is the file
/// itself, or else, as Windows finds programs, the first with one of `env`'s `PATHEXT` extensions
/// added that runs (CLIS-1.2): `~/bin/fakecli` is `~/bin/fakecli.exe`.
pub fn program_of(command: &str, env: &BTreeMap<String, String>, cwd: &str) -> String {
    let home_relative = match command.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with(['/', '\\']) => {
            Some(rest.trim_start_matches(['/', '\\']))
        }
        _ => None,
    };
    let path = match home_relative {
        Some(rest) => {
            let home = home_folder_in(env)
                .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
                .unwrap_or_default();
            home.join(rest)
        }
        None if !command.contains(['/', '\\']) => return command.to_string(),
        None => Path::new(cwd).join(command),
    };
    let found = candidates(&path, env_var(env, "PATHEXT"))
        .into_iter()
        .find(|candidate| runnable(candidate));
    found.unwrap_or(path).to_string_lossy().into_owned()
}

/// Where `program` is found on `path`, split on `;` with quoted entries, trying `PATHEXT`'s
/// extensions where the name has none. A relative entry is from `folder`.
pub fn on_path(program: &str, path: Option<&str>, folder: &Path) -> Option<PathBuf> {
    let pathext = std::env::var("PATHEXT").ok();
    which(program, path?, pathext.as_deref(), folder)
}

/// Where `program` is found on `path`, with the extensions `pathext` names: the first entry that
/// holds a file that runs.
fn which(program: &str, path: &str, pathext: Option<&str>, folder: &Path) -> Option<PathBuf> {
    let entries = path.split(';').filter(|entry| !entry.is_empty());
    for entry in entries {
        let entry = match entry
            .strip_prefix('"')
            .and_then(|rest| rest.strip_suffix('"'))
        {
            Some(unquoted) => unquoted,
            None => entry,
        };
        let base = folder.join(entry).join(program);
        if let Some(found) = candidates(&base, pathext).into_iter().find(|c| runnable(c)) {
            return Some(found);
        }
    }
    None
}

/// The files `base` can be: with each of `pathext`'s extensions, after `base` itself where it has
/// an extension already.
fn candidates(base: &Path, pathext: Option<&str>) -> Vec<PathBuf> {
    let extensions = pathext.unwrap_or(DEFAULT_PATHEXT).split(';');
    let mut names: Vec<PathBuf> = extensions
        .filter(|extension| !extension.is_empty())
        .map(|extension| {
            let mut name = base.as_os_str().to_owned();
            name.push(extension.to_lowercase());
            PathBuf::from(name)
        })
        .collect();
    if base.extension().is_some() {
        names.insert(0, base.to_path_buf());
    }
    names
}

/// Whether `file` is a file Windows can start: a `.exe`, `.com`, `.cmd` or `.bat`.
pub fn runnable(file: &Path) -> bool {
    let started = matches!(extension(file).as_str(), "exe" | "com" | "cmd" | "bat");
    started && file.is_file()
}

/// `file`'s extension in lower case; empty where it has none.
fn extension(file: &Path) -> String {
    let extension = file.extension().unwrap_or_default();
    extension.to_string_lossy().to_lowercase()
}

/// The application and the command line `CreateProcessW` takes for a program with its
/// arguments, environment and folder. `.exe` and `.com` run as they are; `.cmd` and `.bat` through
/// `cmd.exe /d /s /c` with batch quoting, refusing an argument cmd.exe would read as its own;
/// `.ps1` is refused. For the keeper. The command line ends with its NUL, ready to be passed.
pub fn quoted_command(
    named: &str,
    arguments: &[String],
    env: &BTreeMap<String, String>,
    cwd: &Path,
) -> Result<(PathBuf, Vec<u16>), String> {
    if let Some(at) = std::iter::once(named)
        .chain(arguments.iter().map(String::as_str))
        .position(|part| part.contains('\0'))
    {
        return Err(format!("part {at} of the command holds a NUL character"));
    }
    let program = if named.contains(['/', '\\']) {
        let path = cwd.join(named);
        let pathext = env_var(env, "PATHEXT");
        candidates(&path, pathext)
            .into_iter()
            .find(|candidate| candidate.is_file())
            .unwrap_or(path)
    } else {
        let path = env_var(env, "PATH").unwrap_or_default();
        which(named, path, env_var(env, "PATHEXT"), cwd).ok_or_else(|| {
            format!(
                "{named} was not found on the PATH of a terminal in {}",
                cwd.display()
            )
        })?
    };
    let shown = program.display();
    match extension(&program).as_str() {
        "exe" | "com" => {
            let mut line = quoted(&program.to_string_lossy());
            for argument in arguments {
                line.push(' ');
                line.push_str(&quoted_if_needed(argument));
            }
            Ok((
                program.clone(),
                line.encode_utf16().chain(Some(0)).collect(),
            ))
        }
        "cmd" | "bat" => {
            let path = program.to_string_lossy();
            if let Some(special) = path.chars().find(|&c| matches!(c, '%' | '!' | '\n' | '\r')) {
                return Err(format!(
                    "{shown} runs through cmd.exe, which would read the {special:?} in its path \
                     as its own; move it to a folder whose path has none"
                ));
            }
            for argument in arguments {
                if let Some(special) = argument
                    .chars()
                    .find(|c| CMD_SPECIAL.contains(c) || *c == '\r')
                {
                    return Err(format!(
                        "{shown} runs through cmd.exe, which would read the {special:?} in the \
                         argument {argument:?} as its own; leave that argument out, or start the \
                         program the batch file runs"
                    ));
                }
            }
            let cmd = system_folder()?.join("cmd.exe");
            let mut inner = quoted(&path);
            for argument in arguments {
                inner.push(' ');
                inner.push_str(&quoted_if_needed(argument));
            }
            let line = format!("{} /d /s /c \"{inner}\"", quoted(&cmd.to_string_lossy()));
            Ok((cmd, line.encode_utf16().chain(Some(0)).collect()))
        }
        "ps1" => Err(format!(
            "{shown} is a PowerShell script, which Windows cannot start as a program; name the \
             program it runs instead"
        )),
        _ => Err(format!(
            "{shown} is not a program Windows can start: it must be a .exe, .com, .cmd or .bat file"
        )),
    }
}

/// The system's own folder, where its cmd.exe is.
fn system_folder() -> Result<PathBuf, String> {
    let mut buffer = [0u16; 260];
    // SAFETY: the buffer holds the length given.
    let length = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) };
    if length == 0 || length as usize >= buffer.len() {
        let error = io::Error::last_os_error();
        return Err(format!("could not find the system folder: {error}"));
    }
    Ok(PathBuf::from(String::from_utf16_lossy(
        &buffer[..length as usize],
    )))
}

/// `arg` as a program reads it from its command line: as it is, or in quotes where it is empty or
/// holds a space, tab or quote.
fn quoted_if_needed(arg: &str) -> String {
    if arg.is_empty() || arg.contains([' ', '\t', '\n', '\u{b}', '"']) {
        quoted(arg)
    } else {
        arg.to_string()
    }
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

// What runs a program itself.

/// [`super::direct_command`] on Windows: `extension/src/clis/executable.ts`'s `launchTarget`.
pub(super) fn direct_command(
    program: &Path,
    env: &BTreeMap<String, String>,
    cwd: &Path,
) -> Vec<String> {
    let alone = || vec![program.to_string_lossy().into_owned()];
    let with = |runner: &Path, script: &Path| {
        vec![
            runner.to_string_lossy().into_owned(),
            script.to_string_lossy().into_owned(),
        ]
    };
    if !matches!(extension(program).as_str(), "cmd" | "bat") {
        return alone();
    }
    let text = std::fs::read(program).unwrap_or_default();
    let text = String::from_utf8_lossy(&text);
    let Some(folder) = program.parent() else {
        return alone();
    };
    if let Some((by_prog, script)) = npm_shim_script(&text) {
        let programs = npm_shim_programs(&text);
        let runs_node = !by_prog
            || (!programs.is_empty()
                && programs.iter().all(|named| {
                    named.eq_ignore_ascii_case(r"%dp0%\node.exe")
                        || named.eq_ignore_ascii_case("node")
                }));
        let beside = folder.join("node.exe");
        let node = || {
            if beside.exists() {
                Some(beside.clone())
            } else {
                node_on_path(env, cwd)
            }
        };
        if runs_node
            && let Some(target) = file_in(folder, script)
            && let Some(node) = node()
            && target.exists()
        {
            return with(&node, &target);
        }
    }
    if let Some(native) = npm_native_shim(&text)
        && let Some(native) = file_in(folder, native)
        && native.is_file()
    {
        return vec![native.to_string_lossy().into_owned()];
    }
    alone()
}

/// Node on `env`'s `PATH`, from `cwd`, where it is a program of its own: not a version manager's
/// `.cmd` or `.bat`.
fn node_on_path(env: &BTreeMap<String, String>, cwd: &Path) -> Option<PathBuf> {
    let node = which("node", env_var(env, "PATH")?, env_var(env, "PATHEXT"), cwd)?;
    matches!(extension(&node).as_str(), "exe" | "com").then_some(node)
}

/// `relative`, as a batch file names a file beside it, in `folder`; None for one that leaves it.
fn file_in(folder: &Path, relative: &str) -> Option<PathBuf> {
    let mut parts: Vec<&str> = Vec::new();
    for part in relative.split(['\\', '/']) {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            _ if part.contains(':') => return None,
            _ => parts.push(part),
        }
    }
    if parts.is_empty() {
        return None;
    }
    Some(
        parts
            .iter()
            .fold(folder.to_path_buf(), |path, part| path.join(part)),
    )
}

/// `text` without its first `prefix.len()` bytes, where they are `prefix` in any letter case.
fn strip_prefix_ci<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    let head = text.get(..prefix.len())?;
    head.eq_ignore_ascii_case(prefix)
        .then(|| &text[prefix.len()..])
}

/// `text` without its leading whitespace, where it has some.
fn after_space(text: &str) -> Option<&str> {
    let rest = text.trim_start();
    (rest.len() < text.len()).then_some(rest)
}

/// The script npm's shim runs with Node, and nothing between the two: `"%_prog%"
/// "%dp0%\node_modules\...\cli.js" %*`, or in older shims `"%~dp0\node.exe"` or `node` before it.
/// The first such line, with whether it runs `%_prog%`.
fn npm_shim_script(text: &str) -> Option<(bool, &str)> {
    // `node` alone, not the end of another name.
    let starts_name = |before: Option<char>| {
        !before
            .is_some_and(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '%' | '\\' | '-'))
    };
    for (at, _) in text.char_indices() {
        let here = &text[at..];
        let before = text[..at].chars().next_back();
        let runner = [
            (r#""%_prog%""#, true),
            (r#""%~dp0\node.exe""#, false),
            (r#""%dp0%\node.exe""#, false),
        ]
        .into_iter()
        .find_map(|(runner, by_prog)| strip_prefix_ci(here, runner).map(|rest| (rest, by_prog)));
        let runner = runner.or_else(|| {
            let rest = strip_prefix_ci(here, "node").filter(|_| starts_name(before))?;
            Some((strip_prefix_ci(rest, ".exe").unwrap_or(rest), false))
        });
        let Some((rest, by_prog)) = runner else {
            continue;
        };
        let by_prog = by_prog && here.starts_with(r#""%_prog%""#);
        if let Some(script) = shim_script_after(rest) {
            return Some((by_prog, script));
        }
    }
    None
}

/// The script in `\s+"%dp0%\<script>"\s+%*` at the start of `rest`.
fn shim_script_after(rest: &str) -> Option<&str> {
    let rest = after_space(rest)?;
    let rest =
        strip_prefix_ci(rest, r#""%~dp0\"#).or_else(|| strip_prefix_ci(rest, r#""%dp0%\"#))?;
    let end = rest.find('"')?;
    let script = &rest[..end];
    let lower = script.to_ascii_lowercase();
    let named = [".js", ".cjs", ".mjs"]
        .iter()
        .any(|kind| lower.len() > kind.len() && lower.ends_with(kind));
    if !named || script.contains('%') {
        return None;
    }
    after_space(&rest[end + 1..])?
        .starts_with("%*")
        .then_some(script)
}

/// What npm's shim sets `_prog` to, at each `SET "_prog=…"`: Node beside it, or Node on PATH, or
/// another program.
fn npm_shim_programs(text: &str) -> Vec<&str> {
    let mut programs = Vec::new();
    for (at, _) in text.char_indices() {
        let Some(rest) = strip_prefix_ci(&text[at..], "set") else {
            continue;
        };
        let Some(rest) = after_space(rest).and_then(|rest| strip_prefix_ci(rest, r#""_prog="#))
        else {
            continue;
        };
        if let Some(end) = rest.find('"') {
            programs.push(&rest[..end]);
        }
    }
    programs
}

/// The program npm's shim for a package's native program runs, where the shim is that whole and
/// nothing else, as npm 7 and later write it.
fn npm_native_shim(text: &str) -> Option<&str> {
    let lines = [
        "@ECHO off",
        "GOTO start",
        ":find_dp0",
        "SET dp0=%~dp0",
        "EXIT /b",
        ":start",
        "SETLOCAL",
        "CALL :find_dp0",
    ];
    let mut rest = text;
    for line in lines {
        rest = strip_prefix_ci(rest, line)?;
        rest = rest
            .strip_prefix("\r\n")
            .or_else(|| rest.strip_prefix('\n'))?;
    }
    let rest = strip_prefix_ci(rest, r#""%dp0%\"#)?;
    let end = rest.find('"')?;
    let program = &rest[..end];
    let lower = program.to_ascii_lowercase();
    let named = [".exe", ".com"]
        .iter()
        .any(|kind| lower.len() > kind.len() && lower.ends_with(kind));
    if !named || program.contains(['%', '\r', '\n']) {
        return None;
    }
    let rest = &rest[end + 1..];
    let spaced = rest.trim_start_matches([' ', '\t']);
    if spaced.len() == rest.len() {
        return None;
    }
    let rest = spaced.strip_prefix("%*")?.trim_start_matches([' ', '\t']);
    let ends = rest.is_empty() || rest == "\n" || rest == "\r\n";
    ends.then_some(program)
}

// Facade's installed programs.

pub(super) fn check_conpty(source: &Path) -> anyhow::Result<()> {
    for name in ["conpty.dll", "OpenConsole.exe"] {
        let file = source.join(CONPTY_FOLDER).join(name);
        anyhow::ensure!(
            file.is_file(),
            "missing ConPTY companion {}",
            file.display()
        );
    }
    Ok(())
}

pub(super) fn check_managed_directory(path: &Path) -> io::Result<()> {
    use std::os::windows::fs::MetadataExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;

    let metadata = std::fs::symlink_metadata(path)?;
    if metadata.is_dir() && metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0 {
        return Ok(());
    }
    Err(io::Error::other(format!(
        "cannot use {}: expected a directory without a link",
        path.display()
    )))
}

impl Bin {
    /// Makes this folder and `build`'s.
    pub(super) fn make_private(&self, build: &Path) -> io::Result<()> {
        for folder in [&self.0, build] {
            std::fs::create_dir_all(folder)?;
            check_managed_directory(folder)?;
        }
        Ok(())
    }

    /// The build the `facade.exe` launcher is a copy of, as the record beside it names it.
    pub(super) fn current(&self) -> Option<String> {
        let build = std::fs::read_to_string(self.0.join(CURRENT_BUILD)).ok()?;
        (!build.is_empty()).then_some(build)
    }

    /// Makes each launcher a copy of `build`'s program, renaming one in use aside, and then records
    /// `build` as the current one. Renamed copies that nothing runs any more are deleted first.
    pub(super) fn link_launchers(&self, build: &str) -> anyhow::Result<()> {
        check_managed_directory(&self.0)?;
        check_managed_directory(&self.build(build)?)?;
        self.delete_set_aside();
        let current = self.current();
        for name in PROGRAMS.into_iter().rev() {
            let launcher = self.0.join(name);
            let source = self.0.join(build).join(name);
            place_file(&source, &launcher)?;
        }
        if current.as_deref() != Some(build) {
            replace(&self.0.join(CURRENT_BUILD), |fresh| {
                std::fs::write(fresh, build)
            })?;
        }
        Ok(())
    }

    /// Deletes the launchers renamed aside that nothing runs: Windows refuses to delete the others.
    fn delete_set_aside(&self) {
        let Ok(entries) = std::fs::read_dir(&self.0) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') && name.ends_with(SET_ASIDE) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

/// How the name of a file renamed aside, because a process ran it, ends.
const SET_ASIDE: &str = ".old";

/// Makes `target` anew: `make` writes it under a name of this process's own beside it, which is
/// then renamed onto `target`. Windows lets no file that a process runs be replaced, but lets it be
/// renamed: where the rename fails, `target` is renamed aside, to be deleted by a later install, and
/// the new file renamed in. Where `target` holds the new file's bytes by then, as when commands
/// install the same build at once, it is left as it is: renaming a running or held program aside
/// would leave no file there for a moment, or be refused. Where any step fails, nothing `make`
/// wrote is left.
fn replace(target: &Path, make: impl FnOnce(&Path) -> io::Result<()>) -> io::Result<()> {
    let name = target.file_name().unwrap_or_default().to_string_lossy();
    let pid = std::process::id();
    let fresh = target.with_file_name(format!(".{name}.{pid}"));
    let _ = std::fs::remove_file(&fresh);
    let replaced = make(&fresh).and_then(|()| match std::fs::rename(&fresh, target) {
        Err(_) if same_contents(&fresh, target) => Ok(()),
        Err(_) if target.is_file() => {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let aside = target.with_file_name(format!(".{name}.{pid}.{stamp}{SET_ASIDE}"));
            std::fs::rename(target, &aside)?;
            std::fs::rename(&fresh, target)?;
            let _ = std::fs::remove_file(&aside);
            Ok(())
        }
        renamed => renamed,
    });
    // Gone once it was renamed onto `target`; left where it failed or was not needed.
    let _ = std::fs::remove_file(&fresh);
    replaced
}

/// Puts a copy of `source` at `target`, made beside it and renamed onto it, where `target` holds
/// other bytes. Windows makes no links: `link` changes nothing. With `facade.exe`, the ConPTY
/// folder beside `source` comes too.
pub(super) fn place(source: &Path, target: &Path, link: bool) -> io::Result<()> {
    let _ = link;
    place_file(source, target)?;
    let is_facade = target.file_name().is_some_and(|name| name == PROGRAMS[0]);
    if let (true, Some(from), Some(to)) = (is_facade, source.parent(), target.parent()) {
        let conpty = from.join(CONPTY_FOLDER);
        if conpty.is_dir() {
            place_folder(&conpty, &to.join(CONPTY_FOLDER))?;
        }
    }
    Ok(())
}

/// Puts a copy of `source` at `target` where `target` holds other bytes.
fn place_file(source: &Path, target: &Path) -> io::Result<()> {
    if same_contents(source, target) {
        return Ok(());
    }
    replace(target, |fresh| std::fs::copy(source, fresh).map(drop))
}

/// Puts a copy of every file in the folder `source`, and in its folders, in `target`.
fn place_folder(source: &Path, target: &Path) -> io::Result<()> {
    std::fs::create_dir_all(target)?;
    check_managed_directory(target)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let (from, to) = (entry.path(), target.join(entry.file_name()));
        if entry.file_type()?.is_dir() {
            place_folder(&from, &to)?;
        } else {
            place_file(&from, &to)?;
        }
    }
    Ok(())
}

/// Whether `a` and `b` hold the same bytes; false where either cannot be read. Compares a chunk at
/// a time and stops at the first difference, so a program is never read whole.
fn same_contents(a: &Path, b: &Path) -> bool {
    let (Ok(mut a), Ok(mut b)) = (File::open(a), File::open(b)) else {
        return false;
    };
    let size = |file: &File| file.metadata().map(|meta| meta.len()).ok();
    match (size(&a), size(&b)) {
        (Some(a), Some(b)) if a == b => {}
        _ => return false,
    }
    let (mut ours, mut theirs) = (vec![0; CHUNK_BYTES], vec![0; CHUNK_BYTES]);
    loop {
        let read = match a.read(&mut ours) {
            Ok(0) => return true,
            Ok(read) => read,
            Err(_) => return false,
        };
        let theirs = &mut theirs[..read];
        if b.read_exact(theirs).is_err() || ours[..read] != *theirs {
            return false;
        }
    }
}

/// Copies all of the open `file`, from its start whatever its position, into `to`, a new file.
pub(super) fn copy_from_start(file: &File, to: &Path) -> io::Result<()> {
    let copy = OpenOptions::new().write(true).create_new(true).open(to)?;
    let mut buffer = vec![0; CHUNK_BYTES];
    let mut offset = 0u64;
    loop {
        let read = file.seek_read(&mut buffer, offset)?;
        if read == 0 {
            return Ok(());
        }
        let mut written = 0;
        while written < read {
            written += copy.seek_write(&buffer[written..read], offset + written as u64)?;
        }
        offset += read as u64;
    }
}
