# Worktrees

A Git worktree is a directory containing a working copy of a repository. Facade
lists related worktrees together and lets people create, open and delete them.
Opening one adds it to the normal workspace folder list when necessary.

[WORKSPACE.md](WORKSPACE.md) owns folder switching, editors, terminals and window
lifetime. [ACTIVITY-BAR.md](ACTIVITY-BAR.md) defines the separate view icon bar.
W references below refer to WORKSPACE.md. This document owns the Git
operations and their effects on disk. [AGENT-LAUNCHER.md](AGENT-LAUNCHER.md) owns
agent lifetime, including agents working in directories outside the folder list.

WT rule numbers remain stable so code and tests can cite them. Acceptance cases
specify required behavior; they do not report implementation status.

# Part 1: Specification

```text
workspace   folders[] - the folders this window holds (WORKSPACE.md)
worktree    a working tree that shares its repository with others (git worktree add)
```

The two meet in one place: **a worktree somebody works in is a folder of the
workspace.** Everything the workspace does for a folder - fast switching, editors and
terminals kept per folder, source control and search narrowed to it - works for a
worktree with no new code. This part adds only what is about git. The top-level row is
a **folder**; the second level is a **worktree**. Worktrees agents make are
AGENT-ORCHESTRATION.md's beyond how they are made (WT-5.11).

| Decision | Choice |
| --- | --- |
| location | `~/.facade/worktrees/<repo>/<name>`, on every OS |
| creating | `git worktree add -b <branch> -- <path> <start point>`, HEAD unless given |
| Git LFS | the smudge skipped while creating, then `git lfs checkout`: local objects only |
| trust | a worktree's is its repository's, however it reaches a window (WT-3.9) |
| small ignored files | `.worktreeinclude` at the repository root, in gitignore syntax |
| dependencies | not installed for you; a repository's setup commands do it |
| setup | `.facade/worktrees.json`, with per-OS keys, run in a visible terminal |
| removal | `git worktree remove`, after a confirmation that lists what would be lost |
| the branch | kept when its worktree is removed |
| cleanup | nothing automatic |
| long paths | nothing special; git's own error is shown |
| listing | git's own files, read as upstream's `getWorktreesFS` reads them |

Each choice follows what most tools that manage worktrees do. Two go further, because
worktrees fail without them: skipping the LFS smudge (a repository with a missing LFS
object cannot otherwise be checked out), and making sure the directory is gone after
removal (on Windows git can drop its record and leave the directory behind).

Creating, joining the workspace and running setup are separate steps. Report which
steps succeeded when a later step fails. Deletion must distinguish a Git worktree
that still exists from a leftover directory whose Git record has already gone.

## WT-1. Repository and worktree rows

```text
📁 FacadeCode                   the main checkout IS the folder row
 ·  feature/8-worktrees         a worktree: a dot in the folder icon's slot, the name on the same line
 ·  fix/banner
📁 api-gateway                  a repository, closed
📁 solo                         a repository with no worktrees: nothing to open
📁 notes                        no .git of its own: no second level

under the pointer, a folder's row shows its + under the header's, and a repository's icon its triangle:
WORKSPACE                   +   the header's +; the collapse toggle is the title bar's first button
v  FacadeCode               +   New Worktree..., and v in the icon's slot to close it while it is open
>  api-gateway              +   > to open it while it is closed
📁 solo                     +   no worktrees: the folder stays a folder
📁 notes                    +   no .git: the + makes it a repository first (WT-5.8)
```

- **WT-1.1** Two levels: folder, then worktree. No third level.
- **WT-1.2** The main checkout has no row of its own. It is the folder row.
- **WT-1.3** The second level lists every worktree git records for the repository, in
  `folders[]` or not - including ones made on the command line or by another tool. The
  list comes from git's own files (WT-3), never from `ISCMService`.
- **WT-1.4** A worktree that is not in `folders[]` joins it the first time somebody
  goes to it (`IWorkspaceBarService.show`). Listing a worktree never adds it.
- **WT-1.5** Clicking a row selects its directory. Collapsing a repository while
  one of its worktrees is active first switches to the main checkout, then collapses
  the children. Add the main checkout to `folders[]` through the normal show flow
  if necessary. Collapse once the window is on the main checkout. If it cannot get
  there - the checkout is missing, adding it fails or is cancelled - keep the worktree
  active and its repository open, and show the reason. A restore that fails after the
  window reached the checkout is reported as W6.2 says, and the repository still
  closes: its row is the marked one. Collapsing another repository leaves the active
  folder unchanged. Expanding a
  repository only reveals its children; it does not select the previous worktree.
- **WT-1.6** Folder rows keep `folders[]` order, and Move Folder Up / Down. A worktree
  added to `folders[]` is appended and never moves a folder row. A repository whose
  main checkout is not in `folders[]` sits where its first member is.
- **WT-1.7** Worktrees are listed oldest first, by the creation time of git's record of
  each (`.git/worktrees/<name>`); ties by name, numerically (`w2` before `w10`). Once
  somebody moves one (Move Worktree Up / Down, Alt+Up / Alt+Down, always within its
  repository), the repository keeps their order, in the profile; a worktree made
  later goes after it.
- **WT-1.8** Only a repository with worktrees opens: no triangle and no Expand or
  Collapse otherwise, and none for a folder without its own `.git`. Every folder row
  offers the first worktree on its `+` (WT-5.8).
- **WT-1.9** A worktree git records whose folder is gone is listed, greyed, and can be
  deleted, which forgets git's record of it alone.
- **WT-1.10** Collapsed to its icons, the bar is the same tree without its words: an
  open repository shows its worktrees as dots, a closed one only their count on its
  icon (WT-1.15). Collapsing the bar never opens or closes a repository, and which
  repositories are closed is kept per workspace, across reloads. The window is never on
  a worktree whose row is hidden: arriving at a worktree of a closed repository, by any
  way in, opens the repository first (W5), and closing a repository while the window is
  on one of its worktrees moves the window (WT-1.5).
- **WT-1.11** The context menu follows the row, in three groups: making and seeing
  first, arranging, then what makes the row go.

  ```text
  repository                    plain folder                  worktree
  New Worktree...               New Worktree...               Reveal in File Explorer
  Collapse (or Expand)          Reveal in File Explorer       ---------------------
  Reveal in File Explorer       ---------------------         Customize...          F2
  ---------------------         Customize...        F2        Move Worktree Up    Alt+Up
  Customize...        F2        Move Folder Up    Alt+Up      Move Worktree Down  Alt+Down
  Move Folder Up    Alt+Up      Move Folder Down  Alt+Down    ---------------------
  Move Folder Down  Alt+Down    ---------------------         Delete Worktree...
  ---------------------         Remove Folder
  Remove Folder
  ```

  Collapse or Expand only on a repository with worktrees (WT-1.8). Collapsed to its
  icons, the menu is the only way to open or close a repository. Reveal in File
  Explorer is Reveal in Finder on macOS and Open Containing Folder on Linux.
- **WT-1.12** A worktree row is not indented. Its glyph is a dot in the slot a folder's
  icon takes, so every name in the column starts on one line: the
  `circle-small-filled` codicon, registered as `workspace-bar-worktree` so a product
  icon theme can replace it, and the one glyph the agent picker draws a worktree with
  too. Customize... gives a worktree a display name (unnamed, it is called by its
  branch) and a colour, which paints the dot. No icon to choose: the dot is what says
  worktree. A new worktree gets a colour none of its repository's other worktrees has,
  the first of WORKSPACE.md W10.6's ten in their order while one is left, so the dots
  of one repository can be told apart at a glance, collapsed too.
- **WT-1.13** A folder's row ends in one button, styled as the header's `+` and
  standing under it: `+`, New Worktree..., there while it can be used. A repository
  with worktrees has its triangle in its icon's slot, drawn over the icon and taking
  its place under the pointer, so nothing on the row moves: `v` while open, turned to
  `>` while closed, as the workbench's trees draw theirs, in the row's ink, its target
  the slot's full height. Both show under the pointer only; the keyboard opens and
  closes with Left and Right. Collapsed to its icons, the bar shows no triangle
  (WT-1.10).
- **WT-1.14** Everything in a row that changes takes one duration, `--facade-motion`
  (150 ms, standard easing); `workbench.reduceMotion` sets it to 0. A row element the
  list hands to a different row shows that row at once.
- **WT-1.15** A row says what is in it without being opened.
  - A closed repository counts its worktrees in a badge on its icon: the compact
    activity bar's, in its colours and where that bar puts it against the glyph, and
    still there collapsed to icons. Under the pointer it goes with the icon, the slot
    the triangle's.
  - Each row shows the agents its own folder runs, an open repository's row its main
    checkout's: their logos side by side, oldest first, up to three, then `+N` in the
    workbench's count badge. A closed repository speaks for its worktrees, as its
    count does: their agents after its own, in the order of their rows. An agent's
    worktree is a row like any other, whether or not it has joined the workspace. An
    agent Facade started for a folder is on that folder's row wherever its terminal
    is - a tab, held for the folder, or the panel; one that is the window's, in the
    panel or on screen while terminals do not follow folders, is on no row.
  - Under the pointer a folder's `+` takes the agents' place in the same cell, so the
    name does not move. Collapsed to icons the logos go, and a row with agents carries
    a dot on its icon's top corner, ringed in the bar's surface.
  - The logos can cut a long name short, so every row's hover is its name, whole, and
    not its path: a worktree's folder is named for where it lives, not for its branch.
  - A screen reader hears the same after the row's name: `lab, 1 worktree, 3 agents`.
  - The agent launchers tell the bar what runs where (`IWorkspaceBarAgentsService`):
    the bar sits below the terminals and cannot ask them.

  Blue counts worktrees, green marks agents. The worktree count keeps the activity
  bar's badge colours; everything that marks agents - the `+N`, the collapsed dot and
  the count on the title bar's agent button - takes `facadeAgentBadge.*`, a green of
  its own: the default themes give every workbench count one blue, and the two would
  read as one. Green because the workbench's green is "passed, started, running"; its
  orange is "warning, modified", and Claude's logo sits beside it.

## WT-2. Worktree location

- **WT-2.1** `<home>/.facade/worktrees/<repo>/<name>`, on every OS. `<home>` is
  `IPathService.userHome()`.
- **WT-2.2** `<repo>` is the main checkout's folder name. `<name>` is the branch name
  with `/` and every character Windows forbids in a file name (`< > : " | ? * \`)
  replaced by `-`, on every OS, so the same branch makes the same directory
  everywhere. A Windows device name (`con`, `prn`, `aux`, `nul`, `com1`-`com9`,
  `lpt1`-`lpt9`) is refused, with a sentence saying why.
- **WT-2.3** A path that is taken gets `-1`, `-2`, and so on. That also separates two
  repositories whose folders have the same name.
- **WT-2.4** Creation adds no ignore entries or settings to the source checkout:
  no `.gitignore` entry, no `.git/info/exclude` entry and no `files.exclude` default.
  Git necessarily writes branch and worktree metadata in the shared Git directory. While agents run in
  a worktree, the files put there for them get `info/exclude` lines that go with them
  (AGENT-ORCHESTRATION.md, O10).
- **WT-2.5** No `core.longpaths` and no path-length check. A path too long for Windows
  fails with git's own "Filename too long", said on screen.

Outside the repository, a worktree is never a workspace folder nested inside another,
and the repository's own tools - tests, linters, search - never see its worktrees.

## WT-3. Discovery and refresh

The bar reads the files git writes, through `IFileService`, and runs no git. The SCM
service is not a source: the git extension closes and reopens repositories as the
window changes folder, and a list built on it would flicker on every switch.

```text
<folder>/.git                          a directory: a repository's main checkout
                                       a file "gitdir: X": a worktree, X is its git dir
<git dir>/commondir                    in a worktree's git dir: the shared .git, relative
<common>/HEAD                          the main checkout's branch
<common>/worktrees/<name>/HEAD         each worktree's branch
<common>/worktrees/<name>/gitdir       each worktree's path, with /.git at the end
```

- **WT-3.1** Rows are grouped by the common git directory, canonicalised the way the
  bar canonicalises folders. Whether somebody added the main checkout or one of its
  worktrees, `commondir` leads to one directory.
- **WT-3.2** The main checkout is the parent of the common directory when that
  directory is named `.git`. A bare repository has no main checkout, so a worktree of
  one is a plain folder row.
- **WT-3.3** A branch is shown without `refs/heads/`. A detached HEAD shows its short
  hash, and a HEAD that names no branch (a reftable repository) the folder's name.
- **WT-3.4** Watching is correlated (`IFileService.createWatcher`) and per directory:
  `<common>`, `<common>/worktrees`, and each `<common>/worktrees/<name>`. A worktree
  made, removed, pruned or moved by any tool, and a branch checked out in one, reach
  the bar without a reload.
- **WT-3.5** `git.detectWorktrees` keeps upstream's default. Nothing here depends on it.
- **WT-3.6** Rows are drawn from the last read, and `folders[]` can change before the
  next one is in. A folder that joined since is drawn where git's records put it -
  under its repository, as one of its worktrees or its main checkout - and only a
  folder they do not name is drawn at the end until it is read. A worktree just made
  has its record read before its folder joins, since git's writes reach the bar
  batched: its row never shows at the end first.
- **WT-3.7** A window's first read comes after the bar is first drawn, so the last
  read is kept for the next window of the workspace (workspace storage, this machine
  only) and the bar is drawn from it until then. Without it a reload drew every folder
  flat first: a worktree as a folder of its own, then as a dot under its repository.
  The kept read is an old read like any other (WT-3.6): a folder that has left the
  workspace since is not on it, and one that joined since is drawn where git's records
  put it. A first read that finds the same redraws nothing. A record that cannot be
  read is not drawn from, and the bar starts flat, as with none kept.
- **WT-3.8** A folder of `folders[]` that git no longer records - its worktree removed
  or pruned by another tool, its repository moved, its `.git` naming a git directory
  that is gone - is a plain row in its place, marked as not on disk when its directory
  is gone (W9.3). Facade never takes it out of `folders[]` by itself, as VS Code leaves
  a folder that is gone.
- **WT-3.9** A worktree's trust is its repository's. A folder is a worktree of a
  repository only when git's files say so both ways: its `.git` names a record of the
  repository's own, `<common>/worktrees/<name>`, and that record's `gitdir` names the
  folder back. A folder can name any repository in a `.git` of its own; it cannot write
  itself into the records of a repository it has no hold on. Whatever trusts the common
  directory trusts the worktree - the main checkout or a folder above it, or a bare
  repository's own directory - however the worktree reaches a window: the bar, Add
  Folder to Workspace..., `facade --add`, a workspace opened with it in. Untrusting the
  repository untrusts its worktrees, and nothing is recorded for a worktree itself.
  Workspace trust reads these files as it decides, with no git. Two cases stay as VS
  Code leaves them: a repository whose git directory is kept apart from its checkout
  (`--separate-git-dir`) has its worktrees asked about as that directory, not as the
  checkout; and a trust entry and git's files that spell one folder two ways - through a
  symbolic link - do not meet, as VS Code's own entries do not.

## WT-4. Git command contracts

The renderer cannot run git, and upstream's `git.createWorktree` and
`git.deleteWorktree` open pickers and modals of their own. So the git extension gets
three internal, non-interactive commands:

```text
_git.createWorktreeAt(root, path, branch, startPoint?)
    git worktree add -b <branch> -- <path> <startPoint, or HEAD>
                                                  with GIT_LFS_SKIP_SMUDGE=1; a startPoint is a
                                                  full commit id, or the command answers
                                                  InvalidArgument
    git lfs checkout                              in the worktree, best effort: the LFS objects
                                                  already on this machine, nothing downloaded
    then copies .worktreeinclude (WT-6)
    returns { kind: 'created', copyFailures, hookFailure }, or { kind: 'error', code, message }

_git.deleteWorktreeAt(root, path, mode, recovery?)
    'check'    the files whose changes would be lost, and whether submodules are checked out;
               returns { kind: 'checked', files, ignoredPaths, submodules, restrictions } and removes nothing
    'remove'   git worktree remove <path>
    'force'    git worktree remove --force <path>
    'cleanup'  retry only an incomplete deletion, given the recovery token it returned
    returns { kind: 'removed' }, { kind: 'incomplete', path, gitRecord, recovery, message },
    or { kind: 'error', code, message }; gitRecord says whether it is present, absent or unknown

_git.prepareWorktreeBaseAt(root, mode, branch?)
    'inspect'      whether the folder needs git init or a first commit, changing nothing
    'initialize'   git init and the first commit (WT-5.8)
```

`root` and `path` are file URIs, not paths: a window on one OS can drive git on a
remote of another. Every command refuses, before git is asked anything, a path that is
not absolute and a window that inherited `GIT_DIR`, `GIT_WORK_TREE` or
`GIT_INDEX_FILE`. Errors carry upstream's codes (`BranchAlreadyExists`,
`WorktreeAlreadyExists`, `InvalidBranchName`, `NotASafeGitRepository`, ...) or the
fork's own (`InvalidArgument`, `InheritedGitEnvironment`, `UnreadableGitDirectory`,
`InitialBranch`, `UnbornBranch`, `NoIdentity`, `NotTheLeftover`), and the workbench says
each in its own words. The facts that identify a leftover - the repository, the
resolved directory and its identity on its file system - stay in the git extension;
the incomplete result carries only a token for them, so no caller can name a directory
of its own for `cleanup` to delete, and a window that reloads has lost the right to
retry. A path string alone is never authority for recursive deletion. If the same
target cannot be established, cleanup is refused with `NotTheLeftover` and nothing is
deleted.

A failed create may clean up only a branch it can establish this operation created,
provided no worktree uses it and its ref has not changed. Otherwise retain it and
report its name; a failed preflight check does not prove branch ownership. If a
post-checkout hook fails after Git created the requested worktree, return created
with a warning. Check that the resulting worktree actually matches this request;
being present in the list alone does not prove that this operation created it.
Where git answers a question by
failing - whether a branch or a HEAD is there - only git saying "no" counts as no; any
other failure is an error.

- **WT-4.1** Keep the operation logic in `worktreeAt.ts`; `commands.ts` registers
  the commands. The additional Git-extension UI change is WT-9.2's menu conditions.
- **WT-4.2** They do not call upstream's `Repository.createWorktree`, which also starts
  its own `git.worktreeIncludeFiles` copy and `runOn: worktreeCreated` tasks, without
  waiting for either.
- **WT-4.3** They run git through the extension's own `Git.exec`, with an argument
  array. No `Repository` is opened.
- **WT-4.4** They return failures as results and never throw: a thrown error becomes
  the extension's own modal, and the bar says what went wrong in its own words.
- **WT-4.5** Recursive cleanup is limited to the exact directory verified as this
  operation's linked worktree before removal, when Git no longer records it.
  Resolve and verify its path on the filesystem that owns it; never remove the main
  checkout or follow a replacement link. A path Git never listed is refused.
  If cleanup still fails after bounded retries, return the leftover path and the
  known Git-record state as a partial result (WT-8.6), not a generic failure that
  claims the worktree still exists. Retry must revalidate the recorded target;
  evidence of replacement or an uncertain target refuses automatic cleanup.

## WT-5. Creating a worktree

From the `+` on a folder row (WT-1.13), the row's menu (WT-1.11), or the command
palette (New Worktree...).

- **WT-5.1** Offered on every folder row while the bar lists worktrees and git can run
  - a folder without its own `.git` included (WT-5.8). In Restricted Mode, where the
  git extension does not run, New and Delete Worktree ask for trust first, then wait
  for the extension to start. VS Code's question, with two of its buttons: Trust
  Workspace & Continue (Trust Folder & Continue in a window of one folder) and
  Cancel - not Manage, which leads away from the worktree. A repository that is not
  trusted is asked for first: a worktree has its repository's trust (WT-3.9).
- **WT-5.2** A dialog, "New Worktree in `<repository>`", asks for the branch, a new
  one. Under it: that the worktree starts at the main checkout's current HEAD, and the
  folder it will go in - or, in the error colour, why the name cannot be used. Create
  stays disabled until the name can be made. The same dialog takes an optional display
  name and colour, as Customize... does. No other start point and no existing branch
  to pick: one field to fill, the branch's name.
- **WT-5.3** No checks of our own before creating beyond the name's shape: git's
  errors are the checks, since branches and paths can change while the dialog is open.
  A branch checked out in another worktree offers only Switch to Worktree; a path that
  exists is said; anything else shows git's own message.
- **WT-5.4** Creating shows a progress notification. It cannot be cancelled: a
  half-made worktree is worse than waiting.
- **WT-5.5** A failure is always said on screen, never only logged.
- **WT-5.6** Create in this order:
  1. Take the branch and choose an available destination. Prepare its
     display name and color. Preparation does not itself grant trust or run setup.
  2. Create through `_git.createWorktreeAt` under the progress notification.
  3. After confirmed creation, refresh its Git record. Its trust is its repository's
     (WT-3.9): nothing is recorded for it.
  4. For a human creation, open the repository row and add/show the new worktree.
     Await that worktree's completed activation, including editor restoration.
  5. Start setup in its own terminal after activation succeeds. Creation completes
     without waiting for a long setup to finish. Started earlier, the terminal could
     be closed by the activation's restore, which clears whatever else is in the
     editor area.
- **WT-5.7** Failure after Git creation does not undo or recreate the worktree.
  Report "Worktree created" with its path and the step that failed. If adding or
  activation failed, offer Open Worktree and defer automatic setup until that open
  succeeds. A lost response is an unknown outcome: inspect the requested path and
  Git record before retrying; do not create a second worktree or delete an existing
  branch on an assumption. An unrelated editor-restored event cannot release setup.
- **WT-5.8** A folder with nothing to start a worktree from is prepared first. Without
  its own `.git` it gets `git init`; it, or a repository with no commit yet, gets
  everything `.gitignore` lets in committed as "Initial commit". The dialog says which,
  with the number of files, and its button reads Initialize and Create; nothing changes
  until it is pressed. Without a git user name and email the dialog says how to set
  them and stays disabled - unless an `includeIf` may supply them once the repository
  exists. A folder inside another repository is told so.
- **WT-5.9** Once made, the worktree's repository is opened in the bar before the
  window goes to it.
- **WT-5.10** One repository makes one worktree at a time. A second New Worktree on a
  row still at work is a second click, and does nothing. The worktrees agents ask for
  in one repository are made one after another, none refused because another is being
  made; a New Worktree the person asks for meanwhile goes once the agent's is made.
- **WT-5.11** An agent's worktree (AGENT-ORCHESTRATION.md, O3 and O4) is made through
  `_facade.worktree.create` by the same service, without the dialog, at the commit the
  start resolved when it was accepted: the caller's HEAD, or, in another repository,
  that repository's main checkout's HEAD. It is refused, with the reason, in an
  untrusted workspace or repository and in a folder with no commit, rather than
  trusted or prepared (WT-5.8). It does not join `folders[]` and the window stays where
  it is: the worktree shows on the bar as any worktree git records while worktree
  management is enabled (WT-1.3, WT-9). Setup runs
  at once, in a terminal of its own held under the worktree's row, not revealed, once
  the repository's queue (WT-5.10) has moved on. The command answers once the worktree
  is made and its setup started; the setup's outcome is asked for apart: with shell
  integration, each line's exit code once the last has finished; without it, that the
  lines were sent, their completion unknown. A start cancelled meanwhile closes the
  setup terminal; the worktree stays.

## WT-6. Copying local files with `.worktreeinclude`

Use this for small ignored files such as local configuration that a checkout needs.
Dependency installation belongs in setup. The source is the main checkout, including
when an agent creates a worktree from a different commit.

- **WT-6.1** Read `.worktreeinclude` at the main checkout's root. No file means no
  copy. Report an unreadable file instead of silently treating it as absent.
- **WT-6.2** Copy only paths that are both ignored by Git and selected by the file.
  Use gitignore pattern syntax: a positive pattern selects a path, `!` excludes it,
  and later matching rules take precedence. Directory rules apply to descendants;
  still evaluate each descendant's applicable rules before copying it. A tracked
  file or an untracked file Git does not ignore is never eligible.
- **WT-6.3** Preserve existing destination files. Skip symbolic links/junctions and
  paths reached through them on either side. Resolve destination ancestors so a
  link checked out by Git cannot redirect a copy outside the new worktree.
- **WT-6.4** A copy failure does not invalidate creation. One warning gives the
  count and first few failed paths. Distinguish "nothing selected" from a read or
  copy failure.
- **WT-6.5** Avoid traversing unrelated ignored dependency directories. A Git query
  that returns `local/` as one ignored entry is not a complete list of eligible
  files: a pattern for `local/settings.json` still has to reach that file. Selective
  traversal and per-descendant matching must satisfy these examples:

| Ignore rules | Include rules | Files copied |
| --- | --- | --- |
| `local/` | `local/settings.json` | Only that file, when present |
| `local/` | `local/` followed by `!local/private/` | Eligible files under local except the private directory |
| `.env` | `.env` | The ignored .env; no tracked destination is overwritten |

A compressed Git directory listing is an optimization, not permission to copy its
entire subtree without applying the selection rules.

## WT-7. Setup: `.facade/worktrees.json`

What a new worktree needs installed - `npm ci`, `uv sync`, `dotnet restore` - differs
by language and by repository, so a repository says what to run, per OS:

```text
.facade/worktrees.json
{
    "setup-worktree":         ["npm ci"],     every OS, unless the OS has its own key
    "setup-worktree-windows": ["npm ci"],     Windows
    "setup-worktree-unix":    ["npm ci"]      macOS and Linux
}
```

- **WT-7.1** Read from the new worktree first, then from the main checkout, so an
  uncommitted file in the main checkout still works. No file, no setup. An empty list
  is how one OS says it needs none: no terminal opens.
- **WT-7.2** Each value is an array of command lines. A file that does not parse, or a
  value that is not an array of strings, is said in one warning, and nothing runs.
- **WT-7.3** It runs in one terminal named "Worktree Setup", opened in the worktree
  after the requested activation has completed (WT-5.6), with the default terminal
  profile, revealed. `ROOT_WORKTREE_PATH` is set to the main checkout's path, spelled
  for the OS the terminal runs on.
- **WT-7.4** The lines run one after another, whatever the line before did. With shell
  integration, each waits for the one before to finish; without it, they are typed
  ahead. Steps that depend on each other belong in a script, named on one line. A
  terminal closed midway stops the rest.
- **WT-7.5** A terminal, because the output is on screen, the person's own shell and
  environment are used, and a failed step can be run again. The worktree is usable
  either way.
- **WT-7.6** Upstream's `runOn: worktreeCreated` tasks are not used: the git extension
  runs them hidden, and only from `Repository.createWorktree` (WT-4.2).


- **WT-7.7** Record that setup has been started before submitting its commands. Do
  not start it again on a folder switch, reload, rediscovery or a repeated create
  response. If a crash makes command execution uncertain, say so and let the person
  inspect the terminal and explicitly rerun the repository's setup. Facade promises
  no automatic duplicate submission, not exactly-once execution of shell commands.

## WT-8. Deleting a worktree

Delete Worktree removes a directory from disk. Remove Folder changes workspace
membership only. Keep those meanings separate even though deletion also removes
membership. A worktree deleted outside Facade is reconciled from Git and filesystem
facts; it is not treated as a successful Facade delete.

Prepare and perform a deletion in this order:

1. Verify that Git records this exact linked worktree and that it is not the main
   checkout. Read tracked changes, untracked files, ignored local paths, submodule
   state and deletion restrictions. Reject a known lock before stopping any work.
2. In the workbench, collect dirty editors whose resources are inside the directory,
   including editors visible in another folder context and hidden editors. Also
   identify affected folder-owned editors and all related terminals/agents.
3. Show the single confirmation in WT-8.1/WT-8.2. Cancellation changes nothing.
   Once authorized, block new Facade agent starts into this target until the
   operation settles. Revalidate scope and authorization for work added during
   confirmation before continuing.
4. If this worktree is active, await a successful switch to its main checkout. If
   that fails, abort deletion while retaining the worktree and its work.
5. Remove workspace membership through the prepared removal flow, without another
   generic Remove Folder confirmation. Keep dirty working copies and processes
   intact until this edit succeeds; membership observers must not stop or discard
   them independently. An edit/cancellation failure aborts before stopping work or
   discarding content; report any preceding navigation or membership effects.
   Folder-owned editors whose files are outside the deleted directory stay
   available in the window.
6. Stop the confirmed terminals and agents, including terminals working inside the
   directory, and cancel pending starts and their setup terminals. Wait for their
   ends, then release unchanged Facade-owned configuration under
   AGENT-ORCHESTRATION.md O10. Recheck disk and dirty editor losses before removal.
   A new loss not covered by the authorization requires an updated confirmation;
   it is not silently authorized by the earlier snapshot. Close/discard only the
   authorized content. A late refusal or cancellation reports completed effects;
   it does not restore stopped processes or removed membership.
7. Run Git removal, then bounded directory cleanup under WT-4.5. Read the actual
   final state before reporting the outcome.

- **WT-8.1** Always confirm deletion. Name the worktree, as VS Code names what it deletes,
  and say that the entire directory, including ignored local files, will be removed and
  that this cannot be undone. Name running work that will stop.
  Retain the branch. On detached HEAD, do not claim a branch preserves its commits.
  No preference disables this confirmation.
- **WT-8.2** Show up to ten changed/untracked file names, then the remaining count.
  Separately show dirty editor names and ignored paths, ten of each likewise, and the
  agents and terminals that will stop, as WORKSPACE.md W10.7 lists them; summarize whole
  ignored directories instead of listing every dependency file. Warn that submodules and
  their local data are removed. Use Delete and Discard Changes when unsaved or
  changed content is involved, otherwise Delete. Do not offer Save and Delete as a
  way to preserve a file inside the directory: saving it there would still delete
  it. Cancellation lets the person save or copy needed content elsewhere.
- **WT-8.3** When deleting the active worktree, switch to the repository's main
  checkout before removing membership. That switch uses the ordinary preservation
  rules and must succeed; do not fall through to an unrelated neighboring folder.
- **WT-8.4** Serialize deletion of a target and show progress for the committed
  operation. Release Facade-owned directory handles before asking Git to remove it.
  External processes can still block removal; ending Facade terminals is not a
  guarantee that the directory can be deleted.
- **WT-8.5** A leftover directory is handled only under WT-4.5. Never use recursive
  deletion to bypass a Git refusal while its worktree record remains.
- **WT-8.6** Report one of these outcomes:
  - Removed: Git no longer lists it and the directory is gone. Clear customization,
    saved order and any trust an earlier build recorded for that path.
  - Removal failed with the worktree still registered: restore its ordinary row and
    retained customization. Membership may already have been removed and
    processes stopped; say so rather than pretending those effects were undone.
  - Git record removed, directory left behind: an error notification names the exact
    path, why it could not be deleted and the steps that completed, with Reveal in
    File Explorer (WT-1.11's name on each platform) and Retry. Retry revalidates the
    target under WT-4.5 before deleting anything. Customization, order and trust are
    cleared as for Removed. Nothing else keeps the case: the row is gone with git's
    record, and the directory stays under `~/.facade/worktrees` until removed. It
    happens on Windows when another program holds a file open, and a row, a store and
    a record that survives reload would cost more than the leftover directory does.
  - Outcome unknown: refresh and report what can be established, with the path and
    Reveal in File Explorer; do not report removal or automatically repeat a
    destructive operation while its target or effect is uncertain.
- **WT-8.7** Keep the branch after successful deletion. Never force-unlock a worktree
  or delete a branch as part of this flow.
- **WT-8.8** Remove Folder on a repository row removes its workspace members and
  applies W9.6 to its related running work, including agents in unjoined worktrees.
  The worktree directories and Git records remain. External membership edits affect
  only the members actually removed and use W9.6's preservation rule.
- **WT-8.9** Suppress the ordinary worktree row during the committed delete after
  moving off it. Resolve that suppression against a fresh Git/filesystem read.
  Success never flashes the old row back; a partial or unknown outcome is said in its
  notification (WT-8.6), even when Git no longer has a record.
- **WT-8.10** An agent's deletion (AGENT-ORCHESTRATION.md, O5) goes through
  `_facade.worktree.delete` by the same service, in the same order. Steps 1 and 2 come
  first: a lock refuses it, and so do files that would be lost - besides what Facade put
  there for agents and nobody changed (AGENT-ORCHESTRATION.md, O10) - and unsaved
  editors, listed, unless the call says to discard them. Asking for the deletion in the
  call is step 3's confirmation; nothing is asked. With the repository's main checkout
  gone, step 4 goes back to the folder the person was on before (AGENT-ORCHESTRATION.md,
  O5). Step 6 uses O5's stop timeout and explicit-retry rule, discards only content the
  call authorized, and refuses newly found unauthorized loss rather than asking.
  The shared delete operation refuses a main checkout or Restricted Mode with the
  reason; O5 defines the stop-only result for a main checkout. It does not ask for
  trust. Its progress is in the status bar, and its outcome is the call's answer,
  not a notification, saying what was done as WT-8.6 says it. A directory left behind
  is deleted on the caller's retry by the recovery this window holds for it (WT-4.5).

## WT-9. The switch

- **WT-9.1** `facade.workspaceBar.worktrees`, boolean, default `true`, controls
  Facade's worktree management across UI, commands and agent tools. Off, the bar is
  the flat list of `folders[]`; automatic worktree discovery neither reads nor
  watches Git's files. New Worktree, Delete Worktree and Move Worktree are not
  offered, and the shared service admits no new create, delete or move operation.
  On again, the rows are grouped from a fresh read. Toggling the setting alone never
  changes the selected folder.
- **WT-9.2** While it is on, the git extension's own Create Worktree... and Delete
  Worktree... are hidden from Source Control's menus and the palette: a worktree is
  made and deleted through Facade's shared service, with one result. Off, they are back.
- **WT-9.3** Off, `start_agent(new_worktree: true)` and
  `stop_agent(delete_worktree: true)` return `UNAVAILABLE`, naming the disabled
  setting. Reject the whole request before allocating a run, injecting configuration
  or stopping any agent; do not silently turn deletion into a stop-only request.
  Ordinary starts in known folders and stops without deletion remain available.
  Existing agents keep running, including those in unjoined worktrees, and remain
  reachable through Show Active Agents and `list_agents`.
- **WT-9.4** A create or delete already accepted when the setting turns off settles
  under its original contract, including any Git reads needed to finish it. Report
  its real success, failure or partial outcome; do not abandon it halfway or replay
  it when the setting turns on. Newly created unjoined worktrees appear in the bar
  when worktree management is enabled again.

## WT-10. Per platform

Everything above is the same on Windows, macOS and Linux, except:

```text
             Windows                                macOS and Linux
location     %USERPROFILE%\.facade\worktrees        ~/.facade/worktrees
setup key    setup-worktree-windows                 setup-worktree-unix
long paths   depends on Git/OS configuration;      -
             show the actual Git error
removal      a terminal inside the worktree         -
             blocks deleting it (WT-8.4)
```

# Part 2: Technical Design

## WT-11. Implementation boundaries

The workbench coordinates the dialog, workspace edits, terminal preparation and
visible result. The Git extension performs Git and filesystem operations through
the commands in WT-4. Both human and agent creation use the same service.

Keep Git execution in the extension and pass argument arrays through its Git API.
Keep the repository reader independent of SCM selection. Watcher events invalidate
the cached read; a refresh result is not permission to perform a destructive action.
Revalidate the target against Git before deletion.

Use direct calls to wait for a particular folder activation or worktree operation.
An unrelated editor-restored event must not release another operation's setup.
Publish events after state changes so views can redraw; do not use them as the only
way to determine whether a requested operation succeeded.

# Part 3: Acceptance

## WT-12. Acceptance matrix

Levels and evidence follow [WORKSPACE.md W15](WORKSPACE.md#w15-test-levels-and-evidence).
Its [W19](WORKSPACE.md#w19-shared-test-plan) defines the real-Git fixtures, fault
injection and integrated gate.

| ID | Level | Setup and action | Required observation |
| --- | --- | --- | --- |
| WTA-01 | U, I | A repository with no, one and three worktrees, made by Facade, by `git worktree add` in a terminal and by an agent; a plain folder; a folder without its own `.git` inside a repository; a worktree of a bare repository | WT-1.1-1.3, WT-1.8, WT-3.2: two levels, the checkout is the folder row, every worktree listed, plain rows where there is no main checkout |
| WTA-02 | U, I | Open the window with worktrees not in `folders[]`; go to one; go to it again | Listing adds nothing to the file; the first visit adds it once and shows it; the second only switches |
| WTA-03 | U | A repository added under two spellings; `worktree.useRelativePaths`; reftable; detached HEAD; a recorded worktree whose folder is gone; a `.git` naming a gone git directory | WT-3.1, WT-3.3, WT-1.9, WT-3.8 |
| WTA-04 | U, I | Worktrees made in the order w10, w2, w1 with one tie; move one up and down; make another; reload; switch profile | Oldest first, ties numeric; a move keeps the whole order in the profile; a new one goes after; the order follows the profile |
| WTA-05 | U, I | Close and open a repository by its triangle, Left/Right and the menu; collapse the bar; reload; reach a worktree of a closed repository by Open Recent, `facade <path>`, Switch to Worktree and Switch Folder... | The closed set is kept per workspace across reloads; collapsing the bar changes nothing; each arrival opens the repository first, so the marked row is in sight |
| WTA-06 | U, I | Collapse the active worktree's repository with and without the main checkout in the workspace; collapse another repository; expand again | WT-1.5: successful switch to main before collapse; add it when needed; unrelated collapse and expansion do not switch folders |
| WTA-07 | U, I | Move Folder Up/Down a repository whose worktrees are in `folders[]`; add a worktree to `folders[]`; a repository only a worktree of which is in `folders[]` | WT-1.6: the row moves with its folders; an added worktree never moves a folder row; the repository sits where its first member is |
| WTA-08 | I, H | Point at rows and read them: the triangle, the `+`, the count badge, agent logos with four agents, the collapsed dot, hover, screen reader labels; with reduced motion | WT-1.12-1.15 and WT-1.14 |
| WTA-09 | U | Each row kind's menu and keys, with worktrees on and off | WT-1.11 groups and items; Alt+Up/Down move the right kind of row |
| WTA-10 | I | From a terminal: `git worktree add`, `remove`, `prune`, `move`, and a branch checkout inside a worktree; then switch folders | WT-3.4: each reaches the bar without a reload; no row flickers on a switch |
| WTA-11 | U, I | Reload with worktrees in and out of `folders[]`; a folder that left and one that joined between windows; a corrupt kept read | WT-3.7: the first drawing is grouped; a first read that finds the same redraws nothing; a corrupt kept read starts flat |
| WTA-12 | U | Branch names with `/`, each forbidden character, leading and trailing spaces, device names, an empty name; a taken path; a case-insensitive disk | WT-2.2, WT-2.3: one folder name on every OS, device names refused with a reason, `-1` and `-2` |
| WTA-13 | I, H | Type in the New Worktree dialog: an empty name, a valid one, a taken one, a forbidden one; add a name and a colour | WT-5.2: one field for the branch and no start point to choose; the location line follows the typing; errors in the error colour; Create disabled until the name can be made |
| WTA-14 | U, I | Create from the row button, repository menu and palette, including a focused worktree and a plain folder | WT-5.6 order; record read before membership, name/color present on first row, setup waits for this worktree's completed activation |
| WTA-15 | U, I | Branch exists; branch checked out in another worktree; path exists; invalid branch name; unsafe repository; inherited `GIT_DIR`; git extension not running; Restricted Mode; an untrusted repository | WT-5.1, WT-5.3, WT-5.5: each said on screen in the product's words; Switch to Worktree only for a checked-out branch; trust asked before git runs; nothing runs without it |
| WTA-16 | U, I | The first worktree of a plain folder, of a repository with no commit, of a folder inside another repository; without a git identity; with an `includeIf` identity; a branch git refuses | WT-5.8: Initialize and Create with the file count; nothing changes before it is pressed; disabled with how-to without an identity; the refused branch is said before anything changes |
| WTA-17 | U, I | Two New Worktree clicks; two agents asking at once; New Worktree while an agent's is being made | WT-5.10 |
| WTA-18 | U, I | An agent's worktree from a given commit; with a start point that is not a full id; untrusted workspace; untrusted repository; no commit; `show` true and false | WT-5.11 and WT-4: no dialog; refused with reasons; the window stays and `folders[]` is unchanged unless asked; setup in a terminal held under its row, not revealed, its outcome asked for apart |
| WTA-19 | U | `_git.createWorktreeAt` with LFS objects present and missing, a failing post-checkout hook, a failure after `-b`, an existing branch | WT-4: LFS skipped then checked out from local objects; the hook warning keeps the worktree; only its own branch deleted; failures returned, never thrown |
| WTA-20 | U | `.worktreeinclude` with files, a wholly ignored directory, tracked and unignored files, a link, a file git checked out, an unreadable file | WT-6: only ignored and included paths copied; nothing overwritten; links skipped; one warning counting failures |
| WTA-21 | U, I | `worktrees.json` with each OS key, only the common key, an empty list, invalid JSON, a non-string; in the worktree and only in the main checkout; with and without shell integration; close the terminal midway | WT-7: the right lines, in order, in one revealed "Worktree Setup" terminal with `ROOT_WORKTREE_PATH`; one warning and nothing run when invalid; no terminal for an empty list; the rest stop when closed |
| WTA-22 | U, I | Delete a clean worktree, one with eleven changed files, one with submodules, one on a detached HEAD, one with a running terminal, while the window is on it | WT-8 order and dialog: always asked; ten files then "...1 additional file not shown"; the submodule warning, and the running terminal listed as stopping (WORKSPACE.md W10.7); no branch line on a detached HEAD; the window goes to the repository's row, not the next folder |
| WTA-23 | I | On Windows, hold a file/directory open; make Git drop its record before cleanup fails; also request a never-listed path | Owned terminals close before removal; eventual cleanup success, or WT-8.6's notification naming the leftover path; a never-listed path is refused |
| WTA-24 | U, I | Delete a locked worktree, fail removal while registered, then perform a successful delete | Reject a known lock before stopping work. Other failure restores a registered row with its customization and reports prior effects; success removes the row and directory and retains the branch |
| WTA-25 | U, I | Remove Folder on a repository row whose worktrees are in `folders[]` | WT-8.8: they leave `folders[]` and stay on disk and in git |
| WTA-26 | I | A worktree on a remote, with a terminal working inside it | The terminal is found by its path there, said to be running, and closed first |
| WTA-27 | U, I | Turn `facade.workspaceBar.worktrees` off and on with repositories, an active worktree, running agents and worktree commands bound to keys; repeat during accepted creation/deletion | WT-9: flat `folders[]`; no automatic worktree reads/watchers or new management operations; accepted operations settle truthfully without replay; agents remain reachable; on again, grouped from a fresh read; the toggle alone never changes the active folder |
| WTA-28 | U, I | Create a worktree and inspect source files; exercise Windows path limits under recorded Git/OS configuration | No added ignore/settings entries; Git metadata changes are expected. Show any actual path-length failure without asserting every path over 259 characters must fail |
| WTA-29 | U, I | Make three worktrees of one repository without choosing colours; collapse the bar | Each gets a colour its siblings do not have; the three dots are told apart collapsed |
| WTA-30 | I | With worktrees on, look for Create Worktree and Delete Worktree in Source Control's menus and the palette; turn worktrees off and look again | On: only the bar's New Worktree and Delete Worktree. Off: git's own are back |
| WTA-31 | U, I | Include one file inside a wholly ignored directory; exclude a descendant; place source/destination ancestor links | Correct per-file selection; excluded files and paths through links are never copied; tracked files are never overwritten |
| WTA-32 | U, I | Delete an ignored-only .env worktree, and one with dirty editors visible in another folder context; cancel first | Confirmation covers disk and editor losses despite an empty Git status; cancellation preserves them; no misleading Save and Delete path |
| WTA-33 | U, I | Fail directory cleanup after Git removes its record; press Retry; replace the path before a second Retry | A notification names the leftover path with Reveal in File Explorer and Retry; Retry deletes the same verified target or refuses a replacement; no false registered row |
| WTA-34 | U, I | Git creation succeeds but record refresh, add/show or restore fails; lose the create response | Report the existing worktree and failed step; no duplicate create, branch deletion or premature setup; unknown effects are inspected |
| WTA-35 | U, I | Change the affected work while delete confirmation is open; attempt a new agent start during deletion; fail the switch to main or membership removal; introduce loss after stopping | Revalidate authorization; block new starts until the operation settles; failed prerequisites preserve processes and dirty contents; recheck loss before discarding/removing; late refusal reports completed effects |
| WTA-36 | U, I | Reload before/after setup submission and lose its response; revisit or rediscover the worktree | No automatic duplicate setup submission; uncertain execution is reported for inspection and explicit retry |
| WTA-37 | U, I | Collapse the active repository while main is missing, and while it is untrusted with its admission cancelled; separately, make main's editor restoration fail | Missing or cancelled: the worktree stays active and its repository open, with the reason. Failed restoration: the window is on main and says why, and the repository closes |
| WTA-38 | U, I | Race branch creation/ref changes with failed checkout; an identical path was already registered before the request | Cleanup never deletes another operation's branch; an existing worktree is not falsely reported as a newly created hook-failure success |
| WTA-39 | U, I | With its repository trusted and the worktree's path not, add a worktree through the bar, Add Folder to Workspace... and `facade --add`, and open a workspace that has it; untrust the repository; give another folder a `.git` naming that worktree's record; add a worktree of a repository that is not trusted | WT-3.9: no question and a trusted window each time, and nothing recorded for the worktree; untrusted, a window holding the worktree is in Restricted Mode; the impostor is not trusted; the question names the repository's folder, and Trust and Add trusts it and every worktree of it |

## WT-13. Scope limits

Not included, for worktrees:

```text
worktrees inside the repository        they would need an ignore entry, and nest folders of the
                                       workspace
linking or copying dependencies        a repository can do it in its own setup script
automatic cleanup, limits              these worktrees are made by a person or an agent, and
                                       kept until deleted
deleting the branch                    keeping it loses nothing
cloning                                later, on its own
a running state on a worktree's dot    later: the dot is drawn, but does not yet say whether
                                       something runs in the worktree
other tools' config files              .cursor/worktrees.json and the like - one file of ours
```
