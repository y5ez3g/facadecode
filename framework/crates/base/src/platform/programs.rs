//! Programs: the one a command names, and Facade Code Framework's own, installed per build.
//!
//! Facade Code Framework's programs live in `framework/bin/`: each build's `facade` and `facade-mcp` in a folder named
//! after the build, which the services run from, and two launchers, `facade` and `facade-mcp`,
//! symbolic links into the current build's folder. A run is only ever given a launcher's path, so
//! whatever build started it, its next hook or MCP server is the current build's. The person may
//! replace or uninstall the program they started; a service's own program stays.
//!
//! A build's folder is removed when the launchers move to another build, unless it is the build
//! they moved from, a service still runs from it, or it changed in the last ten minutes.

use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, SystemTime};

use anyhow::{Context, bail, ensure};

#[cfg(unix)]
use std::fs::{OpenOptions, Permissions};
#[cfg(unix)]
use std::io::Read;
#[cfg(unix)]
use std::os::unix::fs::{FileExt, OpenOptionsExt, PermissionsExt, symlink};

#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows::{copy_from_start, place};
#[cfg(windows)]
pub use windows::{on_path, program_of, quoted_command, runnable};

/// Facade Code Framework's programs by file name: `facade`, then its MCP server, which lies beside it.
#[cfg(unix)]
pub const PROGRAMS: [&str; 2] = ["facade", "facade-mcp"];

/// Facade Code Framework's programs by file name: `facade.exe`, then its MCP server, which lies beside it.
#[cfg(windows)]
pub const PROGRAMS: [&str; 2] = ["facade.exe", "facade-mcp.exe"];

/// The folder beside a build's programs that holds the ConPTY package, which Windows terminals
/// need.
pub const CONPTY_FOLDER: &str = "conpty";

/// How long a build's folder is kept after it last changed, whatever else holds: a build installed
/// to become the next one is not removed before it does.
const NEW_BUILD_GRACE: Duration = Duration::from_secs(600);

/// How much of a program is compared at a time.
#[cfg(unix)]
const CHUNK_BYTES: usize = 1 << 20;

// The program a command names.

/// The program a `command` names (CONFIGURATION-2.2). A bare name, without `/`, is returned as it
/// is, for the `PATH` to find. `~` and `~/…` are under `HOME` as `env`, the environment it starts
/// with, gives it, else as this process has it. Any other relative path is from its folder `cwd`,
/// and an absolute one is itself.
#[cfg(unix)]
pub fn program_of(command: &str, env: &BTreeMap<String, String>, cwd: &str) -> String {
    let home_relative = match command.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => {
            Some(rest.trim_start_matches('/'))
        }
        _ => None,
    };
    let path = match home_relative {
        Some(rest) => {
            let home = match env.get("HOME") {
                Some(home) => home.clone(),
                None => std::env::var("HOME").unwrap_or_default(),
            };
            Path::new(&home).join(rest)
        }
        None if !command.contains('/') => return command.to_string(),
        None => Path::new(cwd).join(command),
    };
    path.to_string_lossy().into_owned()
}

/// Where `program` is found on `path`, the first entry that holds a file by that name that can
/// run. A relative entry, the empty one too, is from `folder`; without a `PATH`, `/usr/bin` and
/// `/bin` are searched.
#[cfg(unix)]
pub fn on_path(program: &str, path: Option<&str>, folder: &Path) -> Option<PathBuf> {
    let entries = path.unwrap_or("/usr/bin:/bin").split(':');
    let mut candidates = entries.map(|entry| folder.join(entry).join(program));
    candidates.find(|candidate| runnable(candidate))
}

/// Whether `file` is a file someone may run.
#[cfg(unix)]
pub fn runnable(file: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(file) else {
        return false;
    };
    meta.is_file() && meta.permissions().mode() & 0o111 != 0
}

/// The name of the program at `path`, as a person calls it: its file name, without the extension
/// that makes it runnable on Windows (`.exe`, `.com`, `.cmd` or `.bat`, in any case), so that
/// `C:\bin\codex.cmd` is `codex` as `/usr/bin/codex` is.
pub fn program_name(path: &Path) -> String {
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    #[cfg(windows)]
    if let Some((stem, extension)) = name.rsplit_once('.')
        && ["exe", "com", "cmd", "bat"].contains(&extension.to_ascii_lowercase().as_str())
        && !stem.is_empty()
    {
        return stem.to_string();
    }
    name.into_owned()
}

/// What runs `program` itself, where it is a wrapper: npm's wrapper of a Node script becomes
/// `[node, script]`, with Node beside the wrapper, else on `env`'s `PATH` where it is a program of
/// its own; a wrapper of a native program becomes that program. Anything else, and every program on
/// Unix, is `[program]`. `cwd` is the folder relative entries of the `PATH` are from.
pub fn direct_command(program: &Path, env: &BTreeMap<String, String>, cwd: &Path) -> Vec<String> {
    #[cfg(unix)]
    {
        let _ = (env, cwd);
        vec![program.to_string_lossy().into_owned()]
    }
    #[cfg(windows)]
    windows::direct_command(program, env, cwd)
}

/// Shows the final program and arguments in the launch platform's command-line syntax.
/// Uses the launch environment for lookup and includes the keeper's batch wrapper on Windows.
/// The caller must redact any sensitive arguments before showing or storing the result.
pub fn display_command(
    program: &str,
    args: &[String],
    env: &BTreeMap<String, String>,
    cwd: &Path,
) -> Option<String> {
    if program.is_empty() {
        return None;
    }
    #[cfg(unix)]
    {
        let executable = if program.contains('/') {
            let path = cwd.join(program);
            runnable(&path).then_some(path)?
        } else {
            on_path(program, env.get("PATH").map(String::as_str), cwd)?
        };
        let words = std::iter::once(executable.to_str()?).chain(args.iter().map(String::as_str));
        if words.clone().any(|word| word.contains('\0')) {
            return None;
        }
        Some(words.map(quote_word).collect::<Vec<_>>().join(" "))
    }
    #[cfg(windows)]
    {
        let (_, command) = quoted_command(program, args, env, cwd).ok()?;
        String::from_utf16(command.strip_suffix(&[0])?).ok()
    }
}

/// A single POSIX shell word, with special characters and empty arguments preserved.
#[cfg(unix)]
fn quote_word(word: &str) -> String {
    if !word.is_empty()
        && word
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_@%+=:,./-".contains(&byte))
    {
        word.to_owned()
    } else {
        format!("'{}'", word.replace('\'', "'\\''"))
    }
}

/// A command that runs `program` for the daemon, such as Git, or a CLI's own program as it adds
/// its integration. On Windows it opens no console window.
pub fn command(program: impl AsRef<OsStr>) -> std::process::Command {
    #[cfg(unix)]
    return std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;
        let mut command = std::process::Command::new(program);
        command.creation_flags(CREATE_NO_WINDOW);
        command
    }
}

// Facade Code Framework's installed programs.

/// `framework/bin/`, where the programs are installed.
pub fn bin_dir() -> anyhow::Result<PathBuf> {
    Ok(Bin::here()?.0)
}

/// The launcher of `program`, `facade` or `facade-mcp`: the path a run is given, with the system's
/// suffix for programs (`facade.exe` on Windows). A name that has the suffix already, as
/// [`PROGRAMS`]' do, is taken as it is.
pub fn launcher(program: &str) -> anyhow::Result<PathBuf> {
    let suffix = std::env::consts::EXE_SUFFIX;
    let file = match program.strip_suffix(suffix) {
        Some(_) => program.to_string(),
        None => format!("{program}{suffix}"),
    };
    Ok(Bin::here()?.0.join(file))
}

/// Installs this build's programs, the running program and the `facade-mcp` beside it, and returns
/// the installed `facade` for a daemon starting under its service lock. Publication follows
/// keeper admission.
pub fn install_running() -> anyhow::Result<PathBuf> {
    let program = crate::this_program()?;
    let build = crate::build_id();
    let bin = Bin::here()?;
    let installed = bin.build(&build)?.join(PROGRAMS[0]);
    if bin.current().as_deref() == Some(&build) && installed.is_file() {
        return Ok(installed);
    }
    let _lock = bin.lock()?;
    if bin.current().as_deref() == Some(&build) && installed.is_file() {
        return Ok(installed);
    }
    ensure!(
        bin.should_select(&build)?,
        "Facade Code Framework {build} is no longer selected. Run {}",
        bin.0.join(PROGRAMS[0]).display()
    );
    bin.install_set(&program, &build)
}

/// Installs `program`, a `facade` of build `build`, with the `facade-mcp` beside it, and returns
/// the installed `facade`.
pub fn install(program: &Path, build: &str) -> anyhow::Result<PathBuf> {
    Bin::here()?.install(program, build)
}

/// The build the launchers point at, if any.
pub fn current_build() -> Option<String> {
    Bin::here().ok()?.current()
}

/// Checks the invoked build before a daemon command can take service locks.
pub fn validate_running_build() -> anyhow::Result<()> {
    Bin::here()?.validate_build(&crate::build_id())
}

/// Selects this candidate in a sleeping home, or returns the launcher already selected there.
pub fn select_running() -> anyhow::Result<PathBuf> {
    let launcher = launcher(PROGRAMS[0])?;
    select_running_if_idle()?.with_context(|| {
        format!(
            "Services for {} are running. Use 'facade daemon --takeover' with the candidate or stop the services before installing",
            launcher.display()
        )
    })
}

/// Selects a sleeping home's programs. None means a live service must admit the replacement.
pub fn select_running_if_idle() -> anyhow::Result<Option<PathBuf>> {
    use crate::service::{self, Service};

    let bin = Bin::here()?;
    let launcher = bin.0.join(PROGRAMS[0]);
    let build = crate::build_id();
    if !bin.should_select(&build)? {
        return Ok(Some(launcher));
    }
    let framework = crate::paths::framework_dir()?;
    let live = || -> io::Result<bool> {
        Ok(service::live_holder(&framework, Service::Daemon)?.is_some()
            || service::live_holder(&framework, Service::Keeper)?.is_some())
    };
    if live()? {
        return Ok(None);
    }
    let _lock = bin.lock()?;
    if bin.should_select(&build)? {
        if live()? {
            return Ok(None);
        }
        bin.install_set(&crate::this_program()?, &build)?;
        bin.point_at(&build, &[])?;
    }
    Ok(Some(launcher))
}

/// Publishes a candidate after the running daemon admitted it. Selection and publication share
/// the cold install lock.
pub fn select_for_takeover(program: &Path, build: &str, running: &[String]) -> anyhow::Result<()> {
    let bin = Bin::here()?;
    let eligible = || -> anyhow::Result<bool> {
        if bin.should_select(build)? {
            return Ok(true);
        }
        ensure!(
            bin.current().as_deref() == Some(build),
            "Facade Code Framework {build} was superseded. Run {}",
            bin.0.join(PROGRAMS[0]).display()
        );
        Ok(false)
    };
    if eligible()? {
        let _lock = bin.lock()?;
        if eligible()? {
            bin.install_set(program, build)?;
            bin.point_at(build, running)?;
        }
    }
    Ok(())
}

/// Points the launchers at build `build`. Where they pointed at another build, the build folders
/// no longer needed are removed: those of neither build, nor of one in `running`, which services
/// run from, nor changed in the last ten minutes. A process that runs a removed program runs on.
pub fn point_launchers_at(build: &str, running: &[String]) -> anyhow::Result<()> {
    let bin = Bin::here()?;
    if bin.current().as_deref() == Some(build) {
        return Ok(());
    }
    let _lock = bin.lock()?;
    if bin.should_select(build)? {
        bin.point_at(build, running)?;
    }
    ensure!(
        bin.current().as_deref() == Some(build),
        "Facade Code Framework {build} is no longer selected. Run {}",
        bin.0.join(PROGRAMS[0]).display()
    );
    Ok(())
}

/// Runs an ordinary Shell command through the target launcher if the invoked program belongs to
/// another home that supplied this shell's PATH.
pub fn run_in_selected_home() -> anyhow::Result<Option<i32>> {
    let program = crate::this_program()?;
    let Some(folder) = program.parent() else {
        return Ok(None);
    };
    let installed_bin = [Some(folder), folder.parent()]
        .into_iter()
        .flatten()
        .find(|folder| folder.ends_with(Path::new("framework").join("bin")));
    let Some(installed_bin) = installed_bin else {
        return Ok(None);
    };
    let bin = Bin::here()?;
    let launcher = bin.0.join(PROGRAMS[0]);
    if !launcher.is_file()
        || super::files::real_path(installed_bin)? == super::files::real_path(&bin.0)?
    {
        return Ok(None);
    }
    #[cfg(unix)]
    check_owned_directory(&bin.0)?;
    let mut command = std::process::Command::new(&launcher);
    command.args(std::env::args_os().skip(1));
    #[cfg(unix)]
    let outcome = {
        use std::os::unix::process::CommandExt;
        Err(command.exec())
    };
    #[cfg(windows)]
    let outcome = command
        .status()
        .map(|status| Some(status.code().unwrap_or(1)));
    outcome.with_context(|| format!("could not run {}", launcher.display()))
}

/// A programs' folder: `framework/bin/` of a home, or a test's.
struct Bin(PathBuf);

impl Bin {
    fn here() -> anyhow::Result<Bin> {
        Ok(Bin(crate::paths::framework_dir()?.join("bin")))
    }

    fn lock(&self) -> anyhow::Result<File> {
        let framework = self
            .0
            .parent()
            .expect("bin is inside the Facade Code Framework directory");
        #[cfg(unix)]
        if !framework.is_dir() {
            let home = framework.parent().expect("framework is inside the home");
            super::files::create_private_folder_all(home)?;
            check_owned_directory(&home.canonicalize()?)?;
        }
        super::files::create_private_folder_all(framework)?;
        #[cfg(unix)]
        check_owned_directory(framework)?;
        #[cfg(windows)]
        windows::check_managed_directory(framework)?;
        let path = framework.join("programs.lock");
        let file = super::files::private_options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .with_context(|| format!("could not open {}", path.display()))?;
        file.lock()
            .with_context(|| format!("could not lock {}", path.display()))?;
        Ok(file)
    }

    fn should_select(&self, candidate: &str) -> anyhow::Result<bool> {
        self.validate_build(candidate)?;
        let Some(current) = self.current() else {
            return Ok(true);
        };
        match crate::compare_builds(candidate, &current) {
            Some(order) => Ok(order == Ordering::Greater),
            None => bail!(
                "cannot compare Facade Code Framework {candidate} with selected build {current} at {}. Both builds must be stable",
                self.0.join(PROGRAMS[0]).display()
            ),
        }
    }

    fn validate_build(&self, build: &str) -> anyhow::Result<()> {
        ensure!(
            crate::compare_builds(build, build).is_some(),
            "cannot select invalid or prerelease Facade Code Framework build {build} at {}. Use a stable build",
            self.0.join(PROGRAMS[0]).display()
        );
        Ok(())
    }

    /// Build `build`'s folder. A build's name must be one path component.
    fn build(&self, build: &str) -> anyhow::Result<PathBuf> {
        if build.starts_with('.') || !super::files::valid_folder_name(build) {
            anyhow::bail!("{build:?} is not a build's name");
        }
        Ok(self.0.join(build))
    }

    fn install_set(&self, program: &Path, build: &str) -> anyhow::Result<PathBuf> {
        let source = program
            .parent()
            .with_context(|| format!("{} has no folder", program.display()))?;
        let server = source.join(PROGRAMS[1]);
        ensure!(
            server.is_file(),
            "missing companion program {}",
            server.display()
        );
        #[cfg(windows)]
        windows::check_conpty(source)?;
        self.install(program, build)
    }

    /// Makes this folder and `build`'s, each private to this user.
    #[cfg(unix)]
    fn make_private(&self, build: &Path) -> anyhow::Result<()> {
        for folder in [&self.0, build] {
            super::files::create_private_folder_all(folder)?;
            check_owned_directory(folder)?;
            std::fs::set_permissions(folder, Permissions::from_mode(0o700))?;
        }
        Ok(())
    }

    /// See [`install`]. A `facade` in its build's folder is installed already. Without a
    /// `facade-mcp` beside `program`, only `facade` is installed.
    fn install(&self, program: &Path, build: &str) -> anyhow::Result<PathBuf> {
        let folder = self.build(build)?;
        let installed = folder.join(PROGRAMS[0]);
        if program.parent() == Some(folder.as_path()) {
            return Ok(installed);
        }
        self.make_private(&folder)?;
        let Some(source_folder) = program.parent() else {
            anyhow::bail!("{} has no folder", program.display());
        };
        // A test of a debug build may ask for links: copies of each test's programs would fill the
        // Linux test volume, and macOS checks every new copy the first time it runs.
        let link =
            cfg!(debug_assertions) && std::env::var_os("FACADE_TEST_LINK_PROGRAMS").is_some();
        let server = source_folder.join(PROGRAMS[1]);
        let mut sources = vec![(program.to_path_buf(), PROGRAMS[0])];
        if server.exists() {
            sources.push((server, PROGRAMS[1]));
        }
        for (source, name) in sources {
            if let Err(err) = place(&source, &folder.join(name), link) {
                let (source, folder) = (source.display(), folder.display());
                anyhow::bail!("{source} could not be installed in {folder}: {err}");
            }
        }
        if cfg!(debug_assertions) {
            carry_test_build(program, &installed)?;
        }
        // Marked as changed now, so that another build's start leaves it while it waits to become
        // current.
        let _ = mark_changed(&folder);
        Ok(installed)
    }

    /// The build the `facade` launcher points into.
    #[cfg(unix)]
    fn current(&self) -> Option<String> {
        let target = PROGRAMS
            .iter()
            .find_map(|name| std::fs::read_link(self.0.join(name)).ok())?;
        let first = target.iter().next()?;
        Some(first.to_string_lossy().into_owned())
    }

    /// See [`point_launchers_at`]. Where the launchers pointed at `build` already, nothing is
    /// removed.
    fn point_at(&self, build: &str, running: &[String]) -> anyhow::Result<()> {
        self.build(build)?;
        let before = self.current();
        self.link_launchers(build)?;
        if cfg!(debug_assertions) {
            let program = self.build(build)?.join(PROGRAMS[0]);
            carry_test_build(&program, &self.0.join(PROGRAMS[0]))?;
        }
        match before {
            Some(before) if before != build => self.remove_builds_but(&[build, &before], running),
            _ => Ok(()),
        }
    }

    /// Points each launcher at `build`'s program, by a link relative to this folder, where it does
    /// not already.
    #[cfg(unix)]
    fn link_launchers(&self, build: &str) -> anyhow::Result<()> {
        check_owned_directory(&self.0)?;
        check_owned_directory(&self.build(build)?)?;
        for name in PROGRAMS.into_iter().rev() {
            let target = Path::new(build).join(name);
            let launcher = self.0.join(name);
            if std::fs::read_link(&launcher).ok().as_ref() != Some(&target) {
                make_in_place(&launcher, |fresh| symlink(&target, fresh))?;
            }
        }
        Ok(())
    }

    /// Removes every build folder but those of `kept`, of `running`, and those changed lately.
    /// Nothing else here is a build's folder: the launchers, and files and folders whose name
    /// starts with a dot, which an install is making.
    fn remove_builds_but(&self, kept: &[&str], running: &[String]) -> anyhow::Result<()> {
        let changed_lately = |entry: &std::fs::DirEntry| {
            let changed = entry.metadata().and_then(|meta| meta.modified());
            changed.is_ok_and(|at| at.elapsed().unwrap_or_default() < NEW_BUILD_GRACE)
        };
        for entry in std::fs::read_dir(&self.0)?.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let needed = kept.contains(&name.as_str())
                || running.contains(&name)
                || PROGRAMS.contains(&name.as_str())
                || name.starts_with('.')
                || changed_lately(&entry);
            if !needed && entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
        Ok(())
    }
}

/// A build's programs, held open by the daemon since it installed them, so that what the person
/// deletes while it runs can be put back: macOS cannot open a deleted file again by its path.
pub struct Held {
    /// The programs' folder the build was installed in, where it is put back.
    bin: Bin,
    build: String,
    programs: Vec<(&'static str, File)>,
    /// Held while putting back, whose new files are named after this process: two at once would
    /// collide.
    restoring: Mutex<()>,
}

/// Opens a program to hold it. On Windows nobody may delete or rename it meanwhile: it is opened
/// without `FILE_SHARE_DELETE`.
fn open_held(program: &Path) -> io::Result<File> {
    #[cfg(unix)]
    return File::open(program);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;
        std::fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .open(program)
    }
}

impl Held {
    /// Opens `program`, the installed `facade` of build `build`, and the `facade-mcp` beside it
    /// where there is one. `program` is in its build's folder, `<bin>/<build>/facade`: what is
    /// missing is put back in that `<bin>`, never in another home's.
    pub fn open(program: &Path, build: &str) -> io::Result<Held> {
        let Some(bin) = program.parent().and_then(Path::parent) else {
            let message = format!("{} is not in a build's folder", program.display());
            return Err(io::Error::new(io::ErrorKind::InvalidInput, message));
        };
        let facade = open_held(program)?;
        let server = program.parent().map(|folder| folder.join(PROGRAMS[1]));
        let server = server.and_then(|server| open_held(&server).ok());
        let mut programs = vec![(PROGRAMS[0], facade)];
        programs.extend(server.map(|server| (PROGRAMS[1], server)));
        Ok(Held {
            bin: Bin(bin.to_path_buf()),
            build: build.to_string(),
            programs,
            restoring: Mutex::default(),
        })
    }

    /// Puts back what is missing of this build's programs, their folders, and the launchers. The
    /// launchers keep naming another build's programs, as while a newer build is on trial; they
    /// are pointed here only where one of them is missing.
    pub fn restore(&self) -> anyhow::Result<()> {
        let _alone = self
            .restoring
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let bin = &self.bin;
        let folder = bin.build(&self.build)?;
        let gone_from = |place: &Path| {
            let gone = self
                .programs
                .iter()
                .filter(|(name, _)| !place.join(name).is_file());
            gone.collect::<Vec<_>>()
        };
        if gone_from(&folder).is_empty() && gone_from(&bin.0).is_empty() {
            return Ok(());
        }
        let _lock = bin.lock()?;
        bin.make_private(&folder)?;
        for (name, file) in gone_from(&folder) {
            make_in_place(&folder.join(name), |fresh| copy_from_start(file, fresh))?;
        }
        if !gone_from(&bin.0).is_empty() {
            let selected = bin.current().unwrap_or_else(|| self.build.clone());
            bin.link_launchers(&selected)?;
            if cfg!(debug_assertions) {
                let program = bin.build(&selected)?.join(PROGRAMS[0]);
                carry_test_build(&program, &bin.0.join(PROGRAMS[0]))?;
            }
        }
        Ok(())
    }

    /// The `facade-mcp` launcher, a run's MCP server, once what is missing is put back.
    pub fn facade_mcp(&self) -> PathBuf {
        self.launcher(PROGRAMS[1])
    }

    /// The `facade` launcher, which a run's hooks call, once what is missing is put back.
    pub fn facade_launcher(&self) -> PathBuf {
        self.launcher(PROGRAMS[0])
    }

    /// `program`'s launcher, after putting back what is missing, so that a run is never given a
    /// path to nothing. A failure to put back is logged.
    fn launcher(&self, program: &str) -> PathBuf {
        if let Err(err) = self.restore() {
            let message = format!("could not put back Facade Code Framework's programs: {err:#}");
            crate::log::write("daemon", "warn", &message);
        }
        self.bin.0.join(program)
    }
}

// Files.

#[cfg(unix)]
fn check_owned_directory(path: &Path) -> anyhow::Result<()> {
    use std::os::unix::fs::MetadataExt;

    let metadata = std::fs::symlink_metadata(path)
        .with_context(|| format!("could not inspect {}", path.display()))?;
    // SAFETY: getuid reads this process's user ID.
    ensure!(
        metadata.is_dir() && metadata.uid() == unsafe { libc::getuid() },
        "cannot use {}: it is not a directory owned by this user",
        path.display()
    );
    Ok(())
}

/// Puts `source` at `target`. With `link`, a link to the file `source` is, never to a link on the
/// way, which could lead back to `target`. Else a private copy, made only where `target` holds
/// other bytes. Either way the new file is made beside `target` and renamed onto it, so a process
/// already running the file there runs on.
#[cfg(unix)]
fn place(source: &Path, target: &Path, link: bool) -> io::Result<()> {
    if !link {
        if same_contents(source, target) {
            return Ok(());
        }
        return make_in_place(target, |fresh| {
            std::fs::copy(source, fresh)?;
            std::fs::set_permissions(fresh, Permissions::from_mode(0o700))
        });
    }
    let file = source.canonicalize()?;
    if std::fs::read_link(target).ok().as_ref() == Some(&file) {
        return Ok(());
    }
    make_in_place(target, |fresh| symlink(&file, fresh))
}

/// Sets the folder `folder`'s modification time to now. Windows opens a folder only with backup
/// semantics, and needs the right to write its attributes to set its times.
fn mark_changed(folder: &Path) -> io::Result<()> {
    #[cfg(unix)]
    let opened = File::open(folder);
    #[cfg(windows)]
    let opened = {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_WRITE_ATTRIBUTES,
        };
        std::fs::OpenOptions::new()
            .access_mode(FILE_WRITE_ATTRIBUTES)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(folder)
    };
    opened?.set_modified(SystemTime::now())
}

/// In a test of a debug build: puts the file that names the build `source` plays
/// ([`crate::TEST_BUILD_SUFFIX`]) beside `target` as well, or removes one there where `source` has
/// none, so that `target` plays the same build.
fn carry_test_build(source: &Path, target: &Path) -> io::Result<()> {
    let beside = |program: &Path| {
        let mut name = program.file_name().unwrap_or_default().to_os_string();
        name.push(crate::TEST_BUILD_SUFFIX);
        program.with_file_name(name)
    };
    let (from, to) = (beside(source), beside(target));
    if from == to {
        return Ok(());
    }
    match std::fs::copy(&from, &to) {
        Ok(_) => Ok(()),
        Err(err) if err.kind() == io::ErrorKind::NotFound && !from.exists() => {
            match std::fs::remove_file(&to) {
                Err(err) if err.kind() != io::ErrorKind::NotFound => Err(err),
                _ => Ok(()),
            }
        }
        Err(err) => Err(err),
    }
}

/// Makes `target` anew: `make` writes it under a name of this process's own beside it, which is
/// then renamed onto `target`. Where either fails, nothing `make` wrote is left.
fn make_in_place(target: &Path, make: impl FnOnce(&Path) -> io::Result<()>) -> io::Result<()> {
    let name = target.file_name().unwrap_or_default().to_string_lossy();
    let fresh = target.with_file_name(format!(".{name}.{}", std::process::id()));
    let _ = std::fs::remove_file(&fresh);
    match make(&fresh).and_then(|()| std::fs::rename(&fresh, target)) {
        Ok(()) => Ok(()),
        Err(err) => {
            let _ = std::fs::remove_file(&fresh);
            Err(err)
        }
    }
}

/// Whether `a` and `b` hold the same bytes; false where either cannot be read. Compares a chunk at
/// a time and stops at the first difference, so a program is never read whole.
#[cfg(unix)]
fn same_contents(a: &Path, b: &Path) -> bool {
    let (Ok(a), Ok(b)) = (File::open(a), File::open(b)) else {
        return false;
    };
    let size = |file: &File| file.metadata().map(|meta| meta.len()).ok();
    match (size(&a), size(&b)) {
        (Some(a), Some(b)) if a == b => {}
        _ => return false,
    }
    let (mut ours, mut theirs) = (vec![0; CHUNK_BYTES], vec![0; CHUNK_BYTES]);
    let mut offset = 0;
    loop {
        let read = match a.read_at(&mut ours, offset) {
            Ok(0) => return true,
            Ok(read) => read,
            Err(_) => return false,
        };
        let theirs = &mut theirs[..read];
        if b.read_exact_at(theirs, offset).is_err() || ours[..read] != *theirs {
            return false;
        }
        offset += read as u64;
    }
}

/// Copies all of the open `file`, from its start whatever its position, into `to`, a new file that
/// only this user can read or run.
#[cfg(unix)]
fn copy_from_start(file: &File, to: &Path) -> io::Result<()> {
    let mut copy = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o700)
        .open(to)?;
    io::copy(&mut FromStart { file, offset: 0 }, &mut copy).map(drop)
}

/// Reads a file from an offset of its own, leaving the file's position alone.
#[cfg(unix)]
struct FromStart<'a> {
    file: &'a File,
    offset: u64,
}

#[cfg(unix)]
impl Read for FromStart<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let read = self.file.read_at(buffer, self.offset)?;
        self.offset += read as u64;
        Ok(read)
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::os::unix::fs::MetadataExt;

    use super::*;
    use crate::test_folder::TestFolder;

    /// A source folder with both programs, `facade` holding `facade`.
    fn sources(folder: &Path, facade: &str) -> PathBuf {
        let source = folder.join("source");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("facade"), facade).unwrap();
        std::fs::write(source.join("facade-mcp"), "server").unwrap();
        source.join("facade")
    }

    /// The names in `bin`, sorted.
    fn names(bin: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(bin)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    /// Makes every folder in `bin` an hour old, so that only the rules keep it.
    fn age(bin: &Path) {
        let old = SystemTime::now() - Duration::from_secs(3600);
        for entry in std::fs::read_dir(bin).unwrap().flatten() {
            if entry.file_type().unwrap().is_dir() {
                File::open(entry.path()).unwrap().set_modified(old).unwrap();
            }
        }
    }

    /// A build's programs are copied into its folder once: the same bytes again change nothing, and
    /// other bytes come as a new file renamed into place, so a process that has the file before it
    /// open reads it whole.
    #[test]
    fn a_build_s_programs_are_copied_once_and_replaced_by_a_new_file() {
        let folder = TestFolder::new("programs-install");
        let bin = folder.join("bin");
        let program = sources(&folder, "facade one");
        let installed = Bin(bin.clone()).install(&program, "0.2.0").unwrap();
        assert_eq!(installed, bin.join("0.2.0/facade"));
        assert_eq!(
            std::fs::read_to_string(bin.join("0.2.0/facade-mcp")).unwrap(),
            "server"
        );
        for path in [
            bin.clone(),
            bin.join("0.2.0"),
            installed.clone(),
            bin.join("0.2.0/facade-mcp"),
        ] {
            assert_eq!(
                std::fs::metadata(&path).unwrap().mode() & 0o777,
                0o700,
                "{}",
                path.display()
            );
        }
        let first = std::fs::metadata(&installed).unwrap().ino();
        Bin(bin.clone()).install(&program, "0.2.0").unwrap();
        assert_eq!(
            std::fs::metadata(&installed).unwrap().ino(),
            first,
            "the same bytes are left as they are"
        );
        let open = File::open(&installed).unwrap();
        std::fs::write(&program, "facade two").unwrap();
        Bin(bin.clone()).install(&program, "0.2.0").unwrap();
        assert_eq!(std::fs::read_to_string(&installed).unwrap(), "facade two");
        assert_ne!(
            std::fs::metadata(&installed).unwrap().ino(),
            first,
            "other bytes come as a new file"
        );
        assert_eq!(
            std::io::read_to_string(&open).unwrap(),
            "facade one",
            "the file before it stays whole for whoever has it open"
        );
        assert_eq!(
            Bin(bin.clone()).install(&installed, "0.2.0").unwrap(),
            installed,
            "a program in its build's folder is installed"
        );
        std::fs::remove_file(folder.join("source/facade-mcp")).unwrap();
        Bin(bin.clone()).install(&program, "0.2.1").unwrap();
        assert!(
            bin.join("0.2.1/facade").exists() && !bin.join("0.2.1/facade-mcp").exists(),
            "a missing server is left out"
        );
        assert!(
            Bin(bin.clone()).install(&program, "../x").is_err(),
            "a build's name is one path component"
        );
    }

    /// A linked install names the file its source is: a source run through a link, as a command run
    /// through a launcher is, would otherwise make a link that leads back to itself.
    #[test]
    fn a_linked_install_names_the_file_its_source_is() {
        let folder = TestFolder::new("programs-linked");
        let program = sources(&folder, "facade");
        let through = folder.join("through");
        std::os::unix::fs::symlink(&program, &through).unwrap();
        let target = folder.join("installed");
        place(&through, &target, true).unwrap();
        assert_eq!(
            std::fs::read_link(&target).unwrap(),
            program.canonicalize().unwrap()
        );
        place(&through, &target, true).unwrap();
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "facade",
            "the same link again changes nothing"
        );
    }

    /// An install that fails leaves no file of its own behind.
    #[test]
    fn a_failed_install_leaves_nothing_of_its_own() {
        let folder = TestFolder::new("programs-failed");
        let bin = folder.join("bin");
        let program = sources(&folder, "facade");
        // A folder where the program goes: the copy is made, and its rename fails.
        std::fs::create_dir_all(bin.join("0.2.0/facade/in-the-way")).unwrap();
        assert!(Bin(bin.clone()).install(&program, "0.2.0").is_err());
        assert_eq!(names(&bin.join("0.2.0")), ["facade"], "the copy is gone");
    }

    /// The launchers point at the current build. At a switch, the build before stays, as does one a
    /// service runs from and one changed in the last ten minutes, and every other goes. A start of
    /// the build the launchers point at already lets nothing go.
    #[test]
    fn the_launchers_point_at_the_current_build_and_a_switch_keeps_what_may_run() {
        let folder = TestFolder::new("programs-launchers");
        let bin = folder.join("bin");
        let program = sources(&folder, "facade");
        for build in ["0.1.0", "0.2.0", "0.2.1", "0.3.0"] {
            Bin(bin.clone()).install(&program, build).unwrap();
        }
        Bin(bin.clone()).point_at("0.2.0", &[]).unwrap();
        assert_eq!(
            std::fs::read_link(bin.join("facade")).unwrap(),
            Path::new("0.2.0/facade")
        );
        assert_eq!(
            std::fs::read_to_string(bin.join("facade-mcp")).unwrap(),
            "server",
            "the links are relative to the folder"
        );
        assert_eq!(Bin(bin.clone()).current().as_deref(), Some("0.2.0"));
        assert_eq!(
            names(&bin),
            ["0.1.0", "0.2.0", "0.2.1", "0.3.0", "facade", "facade-mcp"],
            "builds installed just now all stay"
        );
        age(&bin);
        Bin(bin.clone())
            .point_at("0.2.1", &["0.1.0".to_string()])
            .unwrap();
        assert_eq!(Bin(bin.clone()).current().as_deref(), Some("0.2.1"));
        assert_eq!(
            names(&bin),
            ["0.1.0", "0.2.0", "0.2.1", "facade", "facade-mcp"],
            "0.3.0 goes; 0.2.0 was the build before, and a service runs 0.1.0"
        );
        age(&bin);
        Bin(bin.clone()).point_at("0.2.1", &[]).unwrap();
        assert_eq!(
            names(&bin),
            ["0.1.0", "0.2.0", "0.2.1", "facade", "facade-mcp"],
            "the current build starting again lets nothing go"
        );
        age(&bin);
        Bin(bin.clone()).install(&program, "0.1.0").unwrap();
        Bin(bin.clone()).point_at("0.2.0", &[]).unwrap();
        assert_eq!(
            names(&bin),
            ["0.1.0", "0.2.0", "0.2.1", "facade", "facade-mcp"],
            "0.1.0, installed again just now, stays"
        );
    }

    /// What the person deletes of the current build's programs and launchers is put back from the
    /// programs held open, and nothing changes where nothing is missing.
    #[test]
    fn what_is_deleted_is_put_back_from_the_programs_held_open() {
        let folder = TestFolder::new("programs-held");
        let bin = folder.join("bin");
        let installed = Bin(bin.clone())
            .install(&sources(&folder, "facade"), "0.2.0")
            .unwrap();
        Bin(bin.clone()).point_at("0.2.0", &[]).unwrap();
        let held = Held::open(&installed, "0.2.0").unwrap();
        let first = std::fs::metadata(&installed).unwrap().ino();
        held.restore().unwrap();
        assert_eq!(
            std::fs::metadata(&installed).unwrap().ino(),
            first,
            "nothing missing, nothing changes"
        );
        std::fs::remove_dir_all(&bin).unwrap();
        held.restore().unwrap();
        assert_eq!(
            (
                std::fs::read_to_string(bin.join("facade")).unwrap(),
                std::fs::read_to_string(bin.join("facade-mcp")).unwrap()
            ),
            ("facade".into(), "server".into())
        );
        assert_eq!(
            std::fs::read_link(bin.join("facade-mcp")).unwrap(),
            Path::new("0.2.0/facade-mcp")
        );
        for path in [
            bin.clone(),
            bin.join("0.2.0"),
            installed.clone(),
            bin.join("0.2.0/facade-mcp"),
        ] {
            assert_eq!(
                std::fs::metadata(&path).unwrap().mode() & 0o777,
                0o700,
                "{}",
                path.display()
            );
        }
        std::fs::remove_file(bin.join("facade")).unwrap();
        held.restore().unwrap();
        assert_eq!(
            std::fs::read_link(bin.join("facade")).unwrap(),
            Path::new("0.2.0/facade"),
            "a launcher alone is put back"
        );
        // Launchers that name another build's programs stay, as while a newer build is on trial;
        // this build's are put back.
        Bin(bin.clone())
            .install(&sources(&folder, "facade"), "0.1.9")
            .unwrap();
        Bin(bin.clone())
            .point_at("0.1.9", &["0.2.0".into()])
            .unwrap();
        std::fs::remove_dir_all(bin.join("0.2.0")).unwrap();
        held.restore().unwrap();
        assert_eq!(
            std::fs::read_link(bin.join("facade")).unwrap(),
            Path::new("0.1.9/facade"),
            "the launchers stay"
        );
        assert!(
            installed.is_file() && bin.join("0.2.0/facade-mcp").is_file(),
            "this build's programs are back"
        );
    }
}
