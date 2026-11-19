//! The places an agent can work in and the worktrees Facade adds to them. A start checks its
//! folder on the running machine and can create a worktree at that checkout's current HEAD.
//!
//! Every folder of a window is a location. So is every checkout of the Git repository a folder sits
//! in: the main checkout leads, the folder follows where it is a place of its own, and the other
//! worktrees come last, by branch and path. Paths have their links resolved, and no place is listed
//! twice. Git is optional: a folder outside any repository, or a machine without Git, is still a
//! location. When Git cannot be asked or does not answer, the folder keeps what the last read found
//! and the catalog names the failure as a problem, because a failed read is no proof that a place
//! is gone.
//!
//! Git is started as WORKTREES-4.2 asks: straight from its arguments with no shell, with the
//! variables that would send it to another repository or to a prompt program removed, without
//! optional locks, in English, and for at most 10 seconds a read. Worktrees made into the same
//! `.worktrees` folder are made one after another; a single daemon serves every window of an
//! environment, so the turns are kept in memory.

use std::collections::HashMap;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use facade_base::daemon::{Kept, LocationInfo, LocationKind, Worktree, location_id};
use facade_base::files::{folder_key, real_path};
use facade_base::jsonrpc::{ErrorBody, Reason};

/// The longest a question to Git may take.
const READ_LIMIT: Duration = Duration::from_secs(10);
/// The longest `git worktree add` may take.
const ADD_LIMIT: Duration = Duration::from_secs(120);
/// The longest a creation waits while another fills the same `.worktrees` folder.
const TURN_LIMIT: Duration = Duration::from_secs(120);

/// Variables that would point Git at another repository or a prompt program; Git never sees them.
const UNSET_FOR_GIT: [&str; 8] = [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_NAMESPACE",
    "GIT_ASK_YESNO",
];

/// Characters a folder name cannot hold on some system; a branch's folder has `-` in their place.
const NOT_IN_FOLDER_NAMES: &str = "/\\<>:\"|?*";

/// A window's locations, and what of them could not be read.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Catalog {
    locations: Vec<LocationInfo>,
    /// Beside each location, the window folder whose read brought it.
    sources: Vec<String>,
    problems: Vec<String>,
}

impl Catalog {
    /// The main checkout first, then the folder itself, then the other worktrees.
    pub(crate) fn locations(&self) -> &[LocationInfo] {
        &self.locations
    }

    pub(crate) fn problems(&self) -> &[String] {
        &self.problems
    }

    /// The location at `path`, a path with its links resolved.
    pub(crate) fn location(&self, path: &str) -> Option<&LocationInfo> {
        self.locations
            .iter()
            .find(|place| same_folder(&place.path, path))
    }

    /// The innermost location whose path is `path` or one of its parents, by whole path
    /// components, `path` having its links resolved.
    pub(crate) fn holding(&self, path: &str) -> Option<&LocationInfo> {
        let path = folder_key(Path::new(path));
        self.locations
            .iter()
            .filter(|place| Path::new(&path).starts_with(folder_key(Path::new(&place.path))))
            .max_by_key(|place| Path::new(&place.path).components().count())
    }

    /// The paths of the locations that only folders missing from `folders` brought.
    pub(crate) fn left_by(&self, folders: &[String]) -> Vec<String> {
        self.with_sources()
            .filter(|(_, source)| !folders.iter().any(|folder| same_folder(folder, source)))
            .map(|(place, _)| place.path.clone())
            .collect()
    }

    fn with_sources(&self) -> impl Iterator<Item = (&LocationInfo, &str)> {
        self.locations
            .iter()
            .zip(self.sources.iter().map(String::as_str))
    }

    /// Lists `place` as brought by `source`, unless a location at its path is listed already.
    fn insert(&mut self, place: LocationInfo, source: &str) {
        if self.location(&place.path).is_some() {
            return;
        }
        self.locations.push(place);
        self.sources.push(source.to_owned());
    }
}

/// Reads the locations of a window whose folders are `folders`, in that order. A folder Git could
/// not be asked about keeps what `before` had from it, and its failure becomes a problem.
pub(crate) async fn read(folders: &[String], before: &Catalog) -> Catalog {
    let mut catalog = Catalog::default();
    for folder in folders {
        let (found, problem) = look_at(folder).await;
        let carried: Vec<LocationInfo> = if problem.is_some() {
            before
                .with_sources()
                .filter(|(_, source)| *source == folder.as_str())
                .map(|(place, _)| place.clone())
                .collect()
        } else {
            Vec::new()
        };
        for place in found.into_iter().chain(carried) {
            catalog.insert(place, folder);
        }
        catalog.problems.extend(problem);
    }
    catalog
}

/// The locations one window folder brings, and why that folder's read failed where it did.
async fn look_at(folder: &str) -> (Vec<LocationInfo>, Option<String>) {
    let opened = resolve(folder);
    if !Path::new(&opened).is_dir() {
        return (
            Vec::new(),
            Some(format!("the folder {folder} cannot be read")),
        );
    }
    let as_folder = plain_folder(&opened);
    match Git::in_folder(Path::new(&opened)).checkouts().await {
        Ok(checkouts) => (repository_places(&opened, checkouts), None),
        Err(GitError::Missing | GitError::NotARepository) => (vec![as_folder], None),
        Err(error) => (
            vec![as_folder],
            Some(format!(
                "could not read the Git worktrees of {folder}: {error}"
            )),
        ),
    }
}

/// The places a repository's checkouts give a window that opened the folder `opened`: the main
/// checkout, then `opened` as whatever it is, then the other worktrees by branch and path. A
/// checkout Git may prune whose folder is gone is no place.
fn repository_places(opened: &str, listed: Vec<Checkout>) -> Vec<LocationInfo> {
    let checkouts: Vec<Checkout> = listed
        .into_iter()
        .map(|checkout| Checkout {
            path: resolve(&checkout.path),
            ..checkout
        })
        .filter(|checkout| !checkout.prunable || Path::new(&checkout.path).exists())
        .collect();
    let mut places = Vec::new();
    let Some((first, rest)) = checkouts.split_first() else {
        places.push(plain_folder(opened));
        return places;
    };
    if !first.bare {
        places.push(first.place(LocationKind::MainCheckout));
    }
    let opened_place = match checkouts
        .iter()
        .position(|checkout| same_folder(&checkout.path, opened))
    {
        Some(index) if !checkouts[index].bare => checkouts[index].place(if index == 0 {
            LocationKind::MainCheckout
        } else {
            LocationKind::Worktree
        }),
        _ => plain_folder(opened),
    };
    places.push(opened_place);
    let mut others: Vec<&Checkout> = rest.iter().collect();
    others.sort_by_cached_key(|checkout| (checkout.label(), checkout.path.clone()));
    places.extend(
        others
            .into_iter()
            .map(|checkout| checkout.place(LocationKind::Worktree)),
    );
    places
}

/// A folder as a location of its own, named by its last part.
fn plain_folder(path: &str) -> LocationInfo {
    place_at(path.to_owned(), last_part(path), LocationKind::Folder)
}

fn place_at(path: String, label: String, kind: LocationKind) -> LocationInfo {
    LocationInfo {
        location_id: location_id(&path),
        label,
        path,
        kind,
    }
}

/// Whether `a` and `b` name the same folder, as the system compares folders.
fn same_folder(a: &str, b: &str) -> bool {
    folder_key(Path::new(a)) == folder_key(Path::new(b))
}

/// `path` with its links resolved, or as it is where it does not exist.
fn resolve(path: &str) -> String {
    match real_path(Path::new(path)) {
        Ok(real) => real.to_string_lossy().into_owned(),
        Err(_) => path.to_owned(),
    }
}

fn last_part(path: &str) -> String {
    match Path::new(path).file_name() {
        Some(name) => name.to_string_lossy().into_owned(),
        None => path.to_owned(),
    }
}

/// One checkout of a repository, from `git worktree list --porcelain`.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Checkout {
    path: String,
    /// The branch it has out, without `refs/heads/`; None when detached or bare.
    branch: Option<String>,
    bare: bool,
    /// Git reports its folder missing, so it may be pruned.
    prunable: bool,
}

impl Checkout {
    /// Its branch, or its folder's name where it has none.
    fn label(&self) -> String {
        self.branch.clone().unwrap_or_else(|| last_part(&self.path))
    }

    fn place(&self, kind: LocationKind) -> LocationInfo {
        place_at(self.path.clone(), self.label(), kind)
    }
}

/// The checkouts `git worktree list --porcelain` printed: the main checkout or bare repository,
/// then the linked worktrees. Each `worktree` line opens a checkout; the lines after it describe it.
fn parse_checkouts(porcelain: &str) -> Vec<Checkout> {
    let mut checkouts: Vec<Checkout> = Vec::new();
    for line in porcelain.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            checkouts.push(Checkout {
                path: path.to_owned(),
                branch: None,
                bare: false,
                prunable: false,
            });
            continue;
        }
        let Some(checkout) = checkouts.last_mut() else {
            continue;
        };
        if line == "bare" {
            checkout.bare = true;
        } else if line == "prunable" || line.starts_with("prunable ") {
            checkout.prunable = true;
        } else if let Some(reference) = line.strip_prefix("branch ") {
            let name = reference.strip_prefix("refs/heads/").unwrap_or(reference);
            checkout.branch = Some(name.to_owned());
        }
    }
    checkouts
}

/// Why Git gave no answer.
#[derive(Debug)]
enum GitError {
    /// There is no `git` program.
    Missing,
    /// The folder belongs to no repository.
    NotARepository,
    /// Git said why, in these words.
    Failed(String),
    /// Git did not finish within this long.
    TimedOut(Duration),
}

impl std::fmt::Display for GitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Missing => f.write_str("Git is not installed"),
            Self::NotARepository => f.write_str("it is not in a Git repository"),
            Self::Failed(words) => f.write_str(words),
            Self::TimedOut(limit) => {
                write!(f, "Git did not answer within {} seconds", limit.as_secs())
            }
        }
    }
}

/// Git, asked about one folder.
#[derive(Clone, Copy)]
struct Git<'a> {
    folder: &'a Path,
}

impl<'a> Git<'a> {
    fn in_folder(folder: &'a Path) -> Self {
        Self { folder }
    }

    /// Runs `git -C <folder> <args>` for at most `limit` and returns what it printed.
    async fn run(self, args: &[&str], limit: Duration) -> Result<String, GitError> {
        let mut command = tokio::process::Command::from(facade_base::programs::command("git"));
        command
            .arg("-C")
            .arg(self.folder)
            .args(args)
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("LC_ALL", "en_US.UTF-8")
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true);
        for name in UNSET_FOR_GIT {
            command.env_remove(name);
        }
        let output = match tokio::time::timeout(limit, command.output()).await {
            Ok(Ok(output)) => output,
            Ok(Err(error)) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(GitError::Missing);
            }
            Ok(Err(error)) => {
                return Err(GitError::Failed(format!("could not run Git: {error}")));
            }
            Err(_) => return Err(GitError::TimedOut(limit)),
        };
        if output.status.success() {
            return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
        }
        let said = String::from_utf8_lossy(&output.stderr);
        let said = said.trim();
        if said.contains("not a git repository") {
            Err(GitError::NotARepository)
        } else {
            Err(GitError::Failed(
                said.strip_prefix("fatal: ").unwrap_or(said).to_owned(),
            ))
        }
    }

    /// Whether a quick question to Git gets a yes.
    async fn agrees(self, args: &[&str]) -> bool {
        self.run(args, READ_LIMIT).await.is_ok()
    }

    async fn checkouts(self) -> Result<Vec<Checkout>, GitError> {
        let listed = self
            .run(&["worktree", "list", "--porcelain"], READ_LIMIT)
            .await?;
        Ok(parse_checkouts(&listed))
    }

    async fn names_a_commit(self, revision: &str) -> bool {
        let commit = format!("{revision}^{{commit}}");
        self.agrees(&["rev-parse", "--verify", "--quiet", &commit])
            .await
    }

    async fn has_branch(self, branch: &str) -> bool {
        let reference = format!("refs/heads/{branch}");
        self.agrees(&["show-ref", "--verify", "--quiet", &reference])
            .await
    }

    async fn require_new_branch(self, branch: &str) -> Result<(), ErrorBody> {
        if self.has_branch(branch).await {
            return Err(ErrorBody::invalid_argument(format!(
                "a branch named {branch} already exists"
            )));
        }
        Ok(())
    }
}

/// The turns that keep creations into one `.worktrees` folder one at a time.
#[derive(Default)]
pub(crate) struct Creations {
    turns: Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>,
}

impl Creations {
    /// Waits, at most [`TURN_LIMIT`], until no other creation is filling `parent`.
    async fn wait_turn(
        &self,
        parent: &Path,
    ) -> Result<tokio::sync::OwnedMutexGuard<()>, ErrorBody> {
        let turn = Arc::clone(
            self.turns
                .lock()
                .unwrap()
                .entry(parent.to_path_buf())
                .or_default(),
        );
        tokio::time::timeout(TURN_LIMIT, turn.lock_owned())
            .await
            .map_err(|_| {
                worktree_failed(format!(
                    "another worktree was being created in {} for {} seconds",
                    parent.display(),
                    TURN_LIMIT.as_secs()
                ))
            })
    }
}

fn worktree_failed(message: String) -> ErrorBody {
    ErrorBody::new(Reason::WorktreeFailed, message)
}

/// Checks the selected folder on the running machine. Git is only needed for a new worktree.
#[allow(
    dead_code,
    reason = "The v3 start handlers are wired in the daemon layer"
)]
pub(crate) async fn preflight(source: &Path, branch: Option<&str>) -> Result<(), ErrorBody> {
    check_source_folder(source).await?;
    if let Some(branch) = branch {
        let repository = Repository::read(source).await?;
        let destination = repository.destination(branch).await?;
        repository.check_available(branch, &destination).await?;
    }
    Ok(())
}

/// Creates a branch at the source checkout's current HEAD and uses its name as the worktree path.
pub(crate) async fn create_worktree(
    source: &Path,
    branch: &str,
    creations: &Creations,
) -> Result<LocationInfo, ErrorBody> {
    check_source_folder(source).await?;
    let repository = Repository::read(source).await?;
    let destination = repository.destination(branch).await?;
    let _turn = creations.wait_turn(&repository.parent).await?;
    repository.check_available(branch, &destination).await?;
    add_worktree(repository.git, branch, &destination, "HEAD").await
}

async fn check_source_folder(source: &Path) -> Result<(), ErrorBody> {
    let shown = source.display();
    match tokio::fs::metadata(source).await {
        Ok(metadata) if metadata.is_dir() => Ok(()),
        Ok(_) => Err(ErrorBody::invalid_argument(format!(
            "{shown} is not a folder"
        ))),
        Err(error) if error.kind() == ErrorKind::NotFound => Err(ErrorBody::invalid_argument(
            format!("the folder {shown} does not exist"),
        )),
        Err(error) => Err(ErrorBody::invalid_argument(format!(
            "could not read the folder {shown}: {error}"
        ))),
    }
}

/// The source checkout and the paths Git already has registered in its repository.
struct Repository<'a> {
    git: Git<'a>,
    /// The `.worktrees` folder beside the main checkout.
    parent: PathBuf,
    registered: Vec<String>,
}

impl<'a> Repository<'a> {
    async fn read(source: &'a Path) -> Result<Self, ErrorBody> {
        let shown = source.display();
        let outside = || ErrorBody::invalid_argument(format!("{shown} is not in a Git repository"));
        let git = Git::in_folder(source);
        let checkouts = match git.checkouts().await {
            Ok(checkouts) => checkouts,
            Err(GitError::NotARepository) => return Err(outside()),
            Err(error) => {
                return Err(worktree_failed(format!(
                    "could not create a worktree from {shown}: {error}"
                )));
            }
        };
        let main = checkouts.first().ok_or_else(outside)?;
        if !git.names_a_commit("HEAD").await {
            return Err(ErrorBody::invalid_argument(format!(
                "{shown} has no commits yet"
            )));
        }
        Ok(Self {
            git,
            parent: PathBuf::from(format!("{}.worktrees", main.path.trim_end_matches('/'))),
            registered: checkouts
                .into_iter()
                .map(|checkout| checkout.path)
                .collect(),
        })
    }

    async fn destination(&self, branch: &str) -> Result<PathBuf, ErrorBody> {
        let name = self
            .git
            .run(&["check-ref-format", "--branch", branch], READ_LIMIT)
            .await
            .map_err(|error| {
                ErrorBody::invalid_argument(format!("invalid branch name {branch:?}: {error}"))
            })?;
        if name.lines().next() != Some(branch) {
            return Err(ErrorBody::invalid_argument(format!(
                "{branch:?} must name the new branch directly"
            )));
        }
        let destination = self.parent.join(branch);
        if !branch.split('/').all(facade_base::files::valid_folder_name) {
            return Err(worktree_failed(format!(
                "the worktree path {} contains a folder name this machine does not support",
                destination.display()
            )));
        }
        Ok(destination)
    }

    async fn check_available(&self, branch: &str, destination: &Path) -> Result<(), ErrorBody> {
        self.git.require_new_branch(branch).await?;
        let shown = destination.display();
        let taken = || worktree_failed(format!("the worktree path {shown} is already in use"));
        if registered_at(destination, &self.registered) {
            return Err(taken());
        }
        match tokio::fs::symlink_metadata(destination).await {
            Ok(_) => return Err(taken()),
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => {
                return Err(worktree_failed(format!(
                    "could not use the worktree path {shown}: {error}"
                )));
            }
        }
        // A slash in the branch adds parent folders. A missing parent can be created by Git.
        for parent in destination
            .ancestors()
            .skip(1)
            .take_while(|path| path.starts_with(&self.parent))
        {
            let shown = parent.display();
            match tokio::fs::metadata(parent).await {
                Ok(metadata) if metadata.is_dir() => break,
                Ok(_) => {
                    return Err(worktree_failed(format!("{shown} is not a folder")));
                }
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(worktree_failed(format!(
                        "could not use the worktree parent {shown}: {error}"
                    )));
                }
            }
        }
        Ok(())
    }
}

/// A creation that passed every check that needs no turn.
struct Creation<'a> {
    repository: Repository<'a>,
    branch: &'a str,
    base: &'a str,
    /// The folder name the branch gives.
    folder: String,
}

/// Makes a worktree from the checkout `source` is in, on a new branch `worktree.branch` starting at
/// `worktree.base_ref`, in `<main checkout>.worktrees/<branch folder>`, and answers with the new
/// location: kind Worktree, labelled with the branch, at its path with links resolved. Nothing is
/// changed for a folder outside any repository, a repository with no commit, a base that is no
/// commit, a branch name Git refuses or already has, or a folder name some system cannot hold.
/// Creations into one `.worktrees` folder take turns, at most 120 seconds of waiting, and the branch
/// is checked again in the turn. When Git fails partway, the error's `data.kept` names what stays.
pub(crate) async fn create(
    source: &Path,
    worktree: &Worktree,
    branch_prefix: Option<&str>,
    creations: &Creations,
) -> Result<LocationInfo, ErrorBody> {
    let creation = Creation::check(source, worktree, branch_prefix).await?;
    let _turn = creations.wait_turn(&creation.repository.parent).await?;
    // Whoever had the turn before may have made this branch.
    creation
        .repository
        .git
        .require_new_branch(creation.branch)
        .await?;
    creation.make().await
}

impl<'a> Creation<'a> {
    async fn check(
        source: &'a Path,
        worktree: &'a Worktree,
        branch_prefix: Option<&str>,
    ) -> Result<Self, ErrorBody> {
        let shown = source.display();
        let branch = worktree.branch.trim();
        let base = worktree.base_ref.trim();
        if branch.is_empty() || base.is_empty() {
            return Err(ErrorBody::invalid_argument(
                "a worktree needs a branch and a base_ref",
            ));
        }
        let repository = Repository::read(source).await?;
        let git = repository.git;
        if !git.names_a_commit(base).await {
            return Err(ErrorBody::invalid_argument(format!(
                "Git knows no commit {base} in {shown}"
            )));
        }
        if !git.agrees(&["check-ref-format", "--branch", branch]).await {
            return Err(ErrorBody::invalid_argument(format!(
                "{branch} is not a branch name Git accepts"
            )));
        }
        let folder = branch_folder(branch, branch_prefix).ok_or_else(|| {
            ErrorBody::invalid_argument(format!(
                "{branch} makes a folder name that some systems cannot hold; choose another branch"
            ))
        })?;
        Ok(Self {
            repository,
            branch,
            base,
            folder,
        })
    }

    /// Runs `git worktree add` into the first free folder, and says what stayed when it fails.
    async fn make(self) -> Result<LocationInfo, ErrorBody> {
        let destination = free_destination(
            &self.repository.parent,
            &self.folder,
            &self.repository.registered,
        );
        add_worktree(self.repository.git, self.branch, &destination, self.base).await
    }
}

async fn add_worktree(
    git: Git<'_>,
    branch: &str,
    destination: &Path,
    base: &str,
) -> Result<LocationInfo, ErrorBody> {
    let path = destination.to_string_lossy();
    let added = git
        .run(&["worktree", "add", "-b", branch, &path, base], ADD_LIMIT)
        .await;
    let Err(error) = added else {
        return Ok(place_at(
            resolve(&path),
            branch.to_owned(),
            LocationKind::Worktree,
        ));
    };
    let kept = Kept {
        branch: git.has_branch(branch).await.then(|| branch.to_owned()),
        path: destination
            .symlink_metadata()
            .is_ok()
            .then(|| path.to_string()),
    };
    Err(partial_failure(&path, &error, kept))
}

/// The error of a `git worktree add` that failed, naming the branch and folder it left behind.
fn partial_failure(destination: &str, error: &GitError, kept: Kept) -> ErrorBody {
    let left = match (&kept.branch, &kept.path) {
        (None, None) => String::new(),
        (Some(branch), None) => format!("; branch {branch} was created and kept"),
        (None, Some(path)) => format!("; folder {path} was created and kept"),
        (Some(branch), Some(path)) => {
            format!("; branch {branch} and folder {path} were created and kept")
        }
    };
    let mut failure = worktree_failed(format!(
        "could not create the worktree {destination}: {error}{left}"
    ));
    if kept.branch.is_some() || kept.path.is_some() {
        failure.data.kept = Some(kept);
    }
    failure
}

/// The folder a worktree of `branch` gets (WORKTREES-2.2): the branch without a leading `prefix`,
/// with `-` for every control character and every character in [`NOT_IN_FOLDER_NAMES`], the same on
/// every system. None for a name some system cannot hold.
fn branch_folder(branch: &str, prefix: Option<&str>) -> Option<String> {
    let rest = match prefix {
        Some(prefix) if !prefix.is_empty() => branch.strip_prefix(prefix).unwrap_or(branch),
        _ => branch,
    };
    let name: String = rest
        .chars()
        .map(|c| {
            if c.is_control() || NOT_IN_FOLDER_NAMES.contains(c) {
                '-'
            } else {
                c
            }
        })
        .collect();
    holdable(&name).then_some(name)
}

/// Whether every system can hold a folder called `name`: not empty, `.` or `..`, not ending in a
/// period or a space, and no Windows device name such as `CON` or `LPT1`, with or without a suffix.
fn holdable(name: &str) -> bool {
    if matches!(name, "" | "." | "..") || name.ends_with(['.', ' ']) {
        return false;
    }
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    let numbered_port = stem.len() == 4
        && (stem.starts_with("COM") || stem.starts_with("LPT"))
        && matches!(stem.as_bytes()[3], b'1'..=b'9');
    !(numbered_port || ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str()))
}

/// `<folder>` in `parent`, or else `<folder>-1`, `<folder>-2` and on: the first that no file,
/// folder, link or registered worktree takes.
fn free_destination(parent: &Path, folder: &str, registered: &[String]) -> PathBuf {
    let mut candidate = parent.join(folder);
    let mut suffix = 0;
    while candidate.symlink_metadata().is_ok() || registered_at(&candidate, registered) {
        suffix += 1;
        candidate = parent.join(format!("{folder}-{suffix}"));
    }
    candidate
}

fn registered_at(path: &Path, registered: &[String]) -> bool {
    let key = folder_key(path);
    registered
        .iter()
        .any(|other| folder_key(Path::new(other)) == key)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A repository in `folder` with one commit on `main`, made without the person's own Git
    /// settings.
    fn repository(folder: &Path) {
        std::fs::create_dir_all(folder).unwrap();
        let run = |args: &[&str]| {
            let done = std::process::Command::new("git")
                .arg("-C")
                .arg(folder)
                .args(args)
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("LC_ALL", "en_US.UTF-8")
                .output()
                .unwrap();
            assert!(
                done.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&done.stderr)
            );
        };
        run(&["init", "-q", "-b", "main"]);
        run(&[
            "-c",
            "user.name=Facade",
            "-c",
            "user.email=facade@example.invalid",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "first",
        ]);
    }

    /// Each entry of the porcelain list: its path, its branch where it has one, bare, detached and
    /// prunable ones.
    #[test]
    fn the_porcelain_worktree_list_reads_as_checkouts() {
        let listed = "worktree /r\nHEAD 1\nbranch refs/heads/main\n\nworktree /r.worktrees/x\nHEAD \
                      2\ndetached\n\n\
                      worktree /gone\nHEAD 3\nbranch refs/heads/feature/y\nprunable gitdir file \
                      points to non-existent location\n\n";
        assert_eq!(
            parse_checkouts(listed),
            [
                Checkout {
                    path: "/r".into(),
                    branch: Some("main".into()),
                    bare: false,
                    prunable: false
                },
                Checkout {
                    path: "/r.worktrees/x".into(),
                    branch: None,
                    bare: false,
                    prunable: false
                },
                Checkout {
                    path: "/gone".into(),
                    branch: Some("feature/y".into()),
                    bare: false,
                    prunable: true
                },
            ]
        );
        assert_eq!(
            parse_checkouts("worktree /b.git\nbare\n"),
            [Checkout {
                path: "/b.git".into(),
                branch: None,
                bare: true,
                prunable: false
            }]
        );
    }

    /// A worktree's folder is its branch less the prefix, with the characters a folder name cannot
    /// hold replaced, and a name some system cannot hold is refused.
    #[test]
    fn a_branch_folder_drops_the_prefix_replaces_what_folders_cannot_hold_and_refuses_unholdable_names()
     {
        assert_eq!(
            branch_folder("aaron/review-api", Some("aaron/")).as_deref(),
            Some("review-api")
        );
        assert_eq!(
            branch_folder("feature/a:b*c?", None).as_deref(),
            Some("feature-a-b-c-")
        );
        assert_eq!(branch_folder("x\u{7}y", None).as_deref(), Some("x-y"));
        for refused in [
            "", ".", "..", "dot.", "space ", "CON", "con.txt", "LPT1", "com9",
        ] {
            assert_eq!(branch_folder(refused, None), None, "{refused:?}");
        }
        assert_eq!(
            branch_folder("aaron/", Some("aaron/")),
            None,
            "the prefix alone leaves no name"
        );
        assert_eq!(branch_folder("COM10", None).as_deref(), Some("COM10"));
    }

    /// The destination takes the next free suffix where a file, a folder or a registered worktree is
    /// in the way.
    #[test]
    fn a_destination_in_use_takes_the_next_free_suffix() {
        let parent = crate::test_folder::TestFolder::new("destinations");
        std::fs::create_dir_all(parent.join("x")).unwrap();
        std::fs::write(parent.join("x-1"), "").unwrap();
        let registered = vec![parent.join("x-2").to_string_lossy().into_owned()];
        assert_eq!(
            free_destination(&parent, "x", &registered),
            parent.join("x-3")
        );
        assert_eq!(
            free_destination(&parent, "y", &registered),
            parent.join("y")
        );
    }

    /// A window's folders read as locations: a repository's main checkout first, then the opened
    /// folder where it is another place, then the other worktrees; a plain folder alone; each place
    /// once.
    #[tokio::test]
    async fn a_window_s_folders_read_as_their_checkouts_and_plain_folders_each_once() {
        let root = crate::test_folder::TestFolder::new("catalog");
        let repo = root.join("app");
        repository(&repo);
        std::fs::create_dir_all(repo.join("src")).unwrap();
        let creations = Creations::default();
        let branch = "feature/review";
        let destination = root.join("app.worktrees/feature/review");
        preflight(&repo, Some(branch)).await.unwrap();
        assert!(!root.join("app.worktrees").exists());
        let created = create_worktree(&repo, branch, &creations).await.unwrap();
        let plain = root.join("notes");
        std::fs::create_dir_all(&plain).unwrap();
        preflight(&plain, None).await.unwrap();
        let text = |path: &Path| resolve(&path.to_string_lossy());
        let folders = vec![text(&repo.join("src")), text(&plain), text(&repo)];
        let catalog = read(&folders, &Catalog::default()).await;
        let listed: Vec<(String, String, LocationKind)> = catalog
            .locations()
            .iter()
            .map(|location| (location.path.clone(), location.label.clone(), location.kind))
            .collect();
        assert_eq!(
            listed,
            [
                (text(&repo), "main".into(), LocationKind::MainCheckout),
                (text(&repo.join("src")), "src".into(), LocationKind::Folder),
                (text(&destination), branch.into(), LocationKind::Worktree),
                (text(&plain), "notes".into(), LocationKind::Folder),
            ]
        );
        assert_eq!(created.path, text(&destination));
        assert!(catalog.problems().is_empty(), "{:?}", catalog.problems());
        assert_eq!(
            catalog.locations()[0].location_id,
            location_id(&text(&repo))
        );
    }

    /// A worktree is made at `<main>.worktrees/<branch folder>`, refused before anything changes
    /// where Git would not take it, and a failure says what it kept.
    #[tokio::test]
    async fn a_worktree_is_made_beside_the_main_checkout_and_refused_before_any_change_where_git_would_not_take_it()
     {
        let root = crate::test_folder::TestFolder::new("create");
        let repo = root.join("app");
        repository(&repo);
        let creations = Creations::default();
        let worktree = |branch: &str, base: &str| Worktree {
            branch: branch.into(),
            base_ref: base.into(),
        };
        let made = create(
            &repo,
            &worktree("aaron/review-api", "HEAD"),
            Some("aaron/"),
            &creations,
        )
        .await
        .unwrap();
        let path = resolve(&root.join("app.worktrees/review-api").to_string_lossy());
        assert_eq!(
            made,
            LocationInfo {
                location_id: location_id(&path),
                label: "aaron/review-api".into(),
                path,
                kind: LocationKind::Worktree,
            }
        );
        let again = create(
            &repo,
            &worktree("aaron/review-api", "HEAD"),
            Some("aaron/"),
            &creations,
        )
        .await
        .unwrap_err();
        assert_eq!(
            (again.data.reason, again.message.as_str()),
            (
                Reason::InvalidArgument,
                "a branch named aaron/review-api already exists"
            )
        );
        // The legacy prefix produced this folder for a different branch. A new start keeps its
        // destination fixed even when the branch itself is free.
        let collision = preflight(&repo, Some("review-api")).await.unwrap_err();
        assert_eq!(collision.data.reason, Reason::WorktreeFailed);
        assert!(collision.message.ends_with("review-api is already in use"));
        assert_eq!(
            create_worktree(&repo, "review-api", &creations)
                .await
                .unwrap_err()
                .message,
            collision.message
        );
        let refused = |error: ErrorBody| (error.data.reason, error.data.kept);
        assert_eq!(
            refused(
                create(&repo, &worktree("bad..name", "HEAD"), None, &creations)
                    .await
                    .unwrap_err()
            ),
            (Reason::InvalidArgument, None)
        );
        assert_eq!(
            refused(
                create(&repo, &worktree("ok", "nowhere"), None, &creations)
                    .await
                    .unwrap_err()
            ),
            (Reason::InvalidArgument, None)
        );
        assert_eq!(
            refused(
                create(&repo, &worktree("CON", "HEAD"), None, &creations)
                    .await
                    .unwrap_err()
            ),
            (Reason::InvalidArgument, None)
        );
        let plain = root.join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        let outside = create(&plain, &worktree("x", "HEAD"), None, &creations)
            .await
            .unwrap_err();
        assert!(
            outside.message.ends_with("is not in a Git repository"),
            "{}",
            outside.message
        );
        let empty = root.join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        assert!(
            std::process::Command::new("git")
                .arg("-C")
                .arg(&empty)
                .args(["init", "-q"])
                .status()
                .unwrap()
                .success()
        );
        let unborn = create(&empty, &worktree("x", "HEAD"), None, &creations)
            .await
            .unwrap_err();
        assert!(
            unborn.message.ends_with("has no commits yet"),
            "{}",
            unborn.message
        );
        let branches = std::process::Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(["branch", "--list"])
            .output()
            .unwrap();
        assert_eq!(
            String::from_utf8_lossy(&branches.stdout).lines().count(),
            2,
            "only main and the one worktree's branch"
        );
    }
}
