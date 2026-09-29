# Worktrees

How Facade Code shows a repository's git worktrees as rows of the workspace bar, and how it creates
and deletes them. Built on [`WORKSPACE.md`](./WORKSPACE.md) - one window, many folders - and changing
nothing it promises.

Rules are numbered (WT-x.y) so that code and tests can cite them.

---

## 1 A worktree is not a workspace

```
workspace   folders[] - the folders this window holds (WORKSPACE.md)
worktree    a working tree that shares its repository with others (`git worktree add`)
```

The two meet in one place: **a worktree somebody works in is a folder of the workspace.** Everything
the workspace does for a folder - fast switching, editors and terminals kept per folder, source
control and search narrowed to it - works for a worktree with no new code.

This document adds only what is about git: which folders are one repository, where a new worktree
goes, making and removing one, and what a new worktree needs that git does not give it. The top-level
row is a **folder**; the second level is a **worktree**.

---

## 2 Decisions

```
location              ~/.facade/worktrees/<repo>/<name>, on every OS
creating              git worktree add -b <branch> <path> HEAD
Git LFS               the smudge skipped while creating, then git lfs checkout: local objects only
trust                 a worktree of a trusted repository is trusted
small ignored files   .worktreeinclude at the repository root, in gitignore syntax
dependencies          not installed for you; a repository's setup commands do it
setup                 .facade/worktrees.json, with per-OS keys, run in a visible terminal
removal               git worktree remove, after a confirmation that lists what would be lost
the branch            kept when its worktree is removed
cleanup               nothing automatic
long paths            nothing special; git's own error is shown
listing               git's own files, read as upstream's getWorktreesFS reads them
```

Each choice follows what most tools that manage worktrees do. Two go further, because worktrees fail
without them: skipping the LFS smudge (a repository with a missing LFS object cannot otherwise be
checked out), and making sure the directory is gone after removal (on Windows git can drop its
record and leave the directory behind).

---

## 3 The shape

```
📁 FacadeCode                   the main checkout IS the folder row
 ·  feature/8-worktrees         a worktree: a dot in the folder icon's slot, the name on the same line
 ·  fix/banner
📁 api-gateway                  a repository, closed
📁 solo                         a repository with no worktrees: nothing to open
📁 notes                        no .git of its own: no second level

under the pointer, a folder's row shows its pair of buttons, the last of them under the header's `+`:
WORKSPACE                   +   the header: Open Folder...; the collapse toggle is the title bar's first button
📁 FacadeCode             + ^   New Worktree..., and ^ to close it while it is open
📁 api-gateway            + v   v to open it while it is closed
📁 solo                   +     no worktrees: the + alone, still in its column
📁 notes                  +     no .git: the + makes it a repository first (WT-5.8)
```

- **WT-1.1** Two levels: folder, then worktree. No third level.
- **WT-1.2** The main checkout has no row of its own. It is the folder row.
- **WT-1.3** The second level lists every worktree git records for the repository, in `folders[]` or
  not - including ones made on the command line or by another tool. The list comes from git's own
  files (§5), never from `ISCMService`.
- **WT-1.4** A worktree that is not in `folders[]` joins it the first time somebody goes to it
  (`IWorkspaceBarService.show`). Listing a worktree never adds it.
- **WT-1.5** One click goes to a row; the triangle only opens and closes. One exception: closing a
  repository while the window is on one of its worktrees takes the window to the repository - adding
  the main checkout to `folders[]` if it is not there. Opening it again does not go back.
- **WT-1.6** Folder rows keep `folders[]` order, and Move Folder Up / Down. A worktree added to
  `folders[]` is appended and never moves a folder row. A repository whose main checkout is not in
  `folders[]` sits where its first member is.
- **WT-1.7** Worktrees are listed oldest first, by the creation time of git's record of each
  (`.git/worktrees/<name>`); ties by name, numerically (`w2` before `w10`). Once somebody moves one
  (Move Worktree Up / Down, Alt+Up / Alt+Down, always within its repository), the repository keeps
  their order, in the profile; a worktree made later goes after it.
- **WT-1.8** Only a repository with worktrees opens: no triangle and no Expand or Collapse otherwise,
  and none for a folder without its own `.git`. Every folder row offers the first worktree on its `+`
  (WT-5.8).
- **WT-1.9** A worktree git records whose folder is gone is listed, greyed, and can be deleted, which
  forgets git's record of it alone.
- **WT-1.10** Collapsed to its icons, the bar is the same tree without its words: an open repository
  shows its worktrees as dots, a closed one shows none. Collapsing the bar never opens or closes a
  repository, and which repositories are closed is kept per workspace, across reloads. When the window
  is on a worktree of a closed repository, the repository's row carries the active mark.
- **WT-1.11** The context menu follows the row, in three groups: making and seeing first, arranging,
  then what makes the row go.

  ```
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

  Collapse or Expand only on a repository with worktrees (WT-1.8). Collapsed to its icons, the menu
  is the only way to open or close a repository.
- **WT-1.12** A worktree row is not indented. Its glyph is a dot in the slot a folder's icon takes,
  so every name in the column starts on one line: the `circle-small-filled` codicon, registered as
  `workspace-bar-worktree` so a product icon theme can replace it, and the one glyph the agent picker
  draws a worktree with too. Customize... gives a worktree a display name (unnamed, it is called by
  its branch) and a colour, which paints the dot. No glyph to choose: the dot is what says worktree.
- **WT-1.13** A folder's row ends in two buttons, styled as the header's `+`: `+` (New Worktree...,
  there while it can be used) and the triangle - `^` while open, `v` while closed - which stands under
  the header's `+`. The triangle only on a repository with worktrees; elsewhere its column stays
  empty, so the `+` stays in place. Both show under the pointer only; the keyboard opens and closes with Left and Right. The
  glyph is swapped, never rotated.
- **WT-1.14** Everything in a row that changes takes one duration, `--facade-motion` (150ms, standard
  easing); `workbench.reduceMotion` sets it to 0. A row element the list hands to a different row
  shows that row at once.

---

## 4 Where worktrees live

- **WT-2.1** `<home>/.facade/worktrees/<repo>/<name>`, on every OS. `<home>` is
  `IPathService.userHome()`.
- **WT-2.2** `<repo>` is the main checkout's folder name. `<name>` is the branch name with `/` and every
  character Windows forbids in a file name (`< > : " | ? * \`) replaced by `-`, on every OS, so the
  same branch makes the same directory everywhere. A Windows device name (`con`, `prn`, `aux`, `nul`,
  `com1`-`com9`, `lpt1`-`lpt9`) is refused, with a sentence saying why.
- **WT-2.3** A path that is taken gets `-1`, `-2`, and so on. That also separates two repositories whose
  folders have the same name.
- **WT-2.4** Nothing is written into the repository: no `.gitignore` entry, no `.git/info/exclude`
  entry, no `files.exclude` default.
- **WT-2.5** No `core.longpaths` and no path-length check. A path too long for Windows fails with
  git's own "Filename too long", said on screen.

Outside the repository, a worktree is never a workspace folder nested inside another, and the
repository's own tools - tests, linters, search - never see its worktrees.

---

## 5 Reading: git's own files

The bar reads the files git writes, through `IFileService`, and runs no git. The SCM service is not a
source: the git extension closes and reopens repositories as the window changes folder, and a list
built on it would flicker on every switch.

```
<folder>/.git                          a directory: a repository's main checkout
                                       a file "gitdir: X": a worktree, X is its git dir
<git dir>/commondir                    in a worktree's git dir: the shared .git, relative
<common>/HEAD                          the main checkout's branch
<common>/worktrees/<name>/HEAD         each worktree's branch
<common>/worktrees/<name>/gitdir       each worktree's path, with /.git at the end
```

- **WT-3.1** Rows are grouped by the common git directory, canonicalised the way the bar canonicalises
  folders. Whether somebody added the main checkout or one of its worktrees, `commondir` leads to one
  directory.
- **WT-3.2** The main checkout is the parent of the common directory when that directory is named
  `.git`. A bare repository has no main checkout, so a worktree of one is a plain folder row.
- **WT-3.3** A branch is shown without `refs/heads/`. A detached HEAD shows its short hash, and a HEAD
  that names no branch (a reftable repository) the folder's name.
- **WT-3.4** Watching is correlated (`IFileService.createWatcher`) and per directory: `<common>`,
  `<common>/worktrees`, and each `<common>/worktrees/<name>`.
- **WT-3.5** `git.detectWorktrees` keeps upstream's default. Nothing here depends on it.
- **WT-3.6** Rows are drawn from the last read, and `folders[]` can change before the next one is in.
  A folder that joined since is drawn where git's records put it - under its repository, as one of
  its worktrees or its main checkout - and only a folder they do not name is drawn at the end until
  it is read. A worktree just made has its record read before its folder joins, since git's writes
  reach the bar batched: its row never shows at the end first.
- **WT-3.7** A window's first read comes after the bar is first drawn, so the last read is kept for
  the next window of the workspace (workspace storage, this machine only) and the bar is drawn from
  it until then. Without it a reload drew every folder flat first: a worktree as a folder of its
  own, then as a dot under its repository. The kept read is an old read like any other (WT-3.6): a
  folder that has left the workspace since is not on it, and one that joined since is drawn where
  git's records put it. A first read that finds the same redraws nothing. A record that cannot be
  read is not drawn from, and the bar starts flat, as with none kept.

The reader is `workspaceBarGit.ts`, next to the bar's model. It knows nothing about the tree.

---

## 6 Writing: three commands in the git extension

The renderer cannot run git, and upstream's `git.createWorktree` and `git.deleteWorktree` open pickers
and modals of their own. So the git extension gets three internal, non-interactive commands:

```
_git.createWorktreeAt(root, path, branch)
    git worktree add -b <branch> <path> HEAD      with GIT_LFS_SKIP_SMUDGE=1
    git lfs checkout                              in the worktree, best effort: the LFS objects
                                                  already on this machine, nothing downloaded
    then copies .worktreeinclude (§8)
    returns { kind: 'created', copyFailures, hookFailure }, or { kind: 'error', code, message }

_git.deleteWorktreeAt(root, path, mode)
    'check'    the files whose changes would be lost, and whether submodules are checked out;
               returns { kind: 'checked', files, submodules } and removes nothing
    'remove'   git worktree remove <path>
    'force'    git worktree remove --force <path>
    returns { kind: 'removed' }, or { kind: 'error', code, message }

_git.prepareWorktreeBaseAt(root, mode, branch?)
    'inspect'      whether the folder needs git init or a first commit, changing nothing
    'initialize'   git init and the first commit (WT-5.8)
```

`root` and `path` are file URIs, not paths: a window on one OS can drive git on a remote of another.
Every command refuses, before git is asked anything, a path that is not absolute and a window that
inherited `GIT_DIR`, `GIT_WORK_TREE` or `GIT_INDEX_FILE`. Errors carry upstream's codes
(`BranchAlreadyExists`, `WorktreeAlreadyExists`, `InvalidBranchName`, `NotASafeGitRepository`, ...) or
the fork's own (`InvalidArgument`, `InheritedGitEnvironment`, `UnreadableGitDirectory`,
`InitialBranch`, `UnbornBranch`, `NoIdentity`), and the workbench says each in its own words.

A create that fails deletes the branch its `-b` made - never one that was there before it. A
post-checkout hook that fails still leaves a worktree, as git keeps it: it is created, and the hook's
output is shown as a warning. Where git answers a question by failing - whether a branch or a HEAD is
there - only git saying "no" counts as no; any other failure is an error.

- **WT-4.1** These three are the only change to `extensions/git`. Their logic lives in
  `worktreeAt.ts`; `commands.ts` only registers them.
- **WT-4.2** They do not call upstream's `Repository.createWorktree`, which also starts its own
  `git.worktreeIncludeFiles` copy and `runOn: worktreeCreated` tasks, without waiting for either.
- **WT-4.3** They run git through the extension's own `Git.exec`, with an argument array. No
  `Repository` is opened.
- **WT-4.4** They return failures as results and never throw: a thrown error becomes the extension's
  own modal, and the bar says what went wrong in its own words.
- **WT-4.5** A directory left behind after `remove` is deleted, with retries, only when git listed the
  path as a worktree before and no longer does - on Windows git can drop its record and then fail on
  the directory. A path git never listed is refused and left alone.

---

## 7 Creating a worktree

From the `+` on a folder row (WT-1.13), the row's menu (WT-1.11), or the command palette
(`New Worktree...`).

- **WT-5.1** Offered on every folder row while the bar lists worktrees and git can run - a folder
  without its own `.git` included (WT-5.8). In Restricted Mode, where the git extension does not run,
  New and Delete Worktree ask for trust first, then wait for the extension to start.
- **WT-5.2** A dialog, "New Worktree in <repository>", asks for the branch. Under it: that the worktree
  starts at the main checkout's current HEAD, and the folder it will go in - or, in the error colour,
  why the name cannot be used. Create stays disabled until the name can be made. The same dialog takes
  an optional display name and colour, as Customize... does. No base-ref choice.
- **WT-5.3** No checks of our own before creating: git's errors are the checks. A branch checked out in
  another worktree offers only Go There; a path that exists is said; anything else shows git's own
  message.
- **WT-5.4** Creating shows a progress notification. It cannot be cancelled: a half-made worktree is
  worse than waiting.
- **WT-5.5** A failure is always said on screen, never only logged.
- **WT-5.6** The flow, in this order:
  ```
  1  name     the branch (WT-5.2); the path by WT-2.2 and WT-2.3; the name and colour given kept
              for that path
  2  create   _git.createWorktreeAt, under the progress notification (WT-5.4)
  3  trust    the new worktree is trusted, as its repository is
  4  show     its record read (WT-3.6), then IWorkspaceBarService.show(worktree): into folders[],
              and the window moves onto it
  5  wait     for IWorkspaceBarService.onDidRestoreEditors
  6  setup    §9, in a terminal of the worktree, once the command has finished - a long setup
              holds up neither this worktree nor the repository's next one
  ```
- **WT-5.7** Step 5 matters: a switch restores the incoming folder's editors, and the restore closes
  whatever else is in the editor area - a setup terminal opened before it included.
- **WT-5.8** A folder with nothing to start a worktree from is prepared first. Without its own `.git`
  it gets `git init`; it, or a repository with no commit yet, gets everything `.gitignore` lets in
  committed as "Initial commit". The dialog says which, with the number of files, and its button reads
  Initialize and Create; nothing changes until it is pressed. Without a git user name and email the
  dialog says how to set them and stays disabled - unless an `includeIf` may supply them once the
  repository exists.
- **WT-5.9** Once made, the worktree's repository is opened in the bar before the window goes to it.

---

## 8 `.worktreeinclude`

For the small ignored files a checkout needs and git does not give it: `.env`, local config. The same
file other worktree tools read, so one file serves them all.

- **WT-6.1** A file named `.worktreeinclude` at the root of the main checkout, in gitignore syntax. No
  file, nothing copied.
- **WT-6.2** A path is copied when it is **both** ignored by the repository **and** matched by
  `.worktreeinclude`. The candidates come from
  `git ls-files --others --ignored --exclude-standard --directory`, where a wholly ignored directory is
  one entry, and are matched as gitignore reads a pattern file. A tracked file, or an untracked one
  that is not ignored, is never copied.
- **WT-6.3** Nothing is copied over what git checked out (`COPYFILE_EXCL`, `fs.cp` with
  `force: false`). Parent directories are created; links are skipped.
- **WT-6.4** A file that fails to copy stops nothing. One warning says how many failed, and names the
  first few.
- **WT-6.5** It is for small files. Dependencies belong to setup (§9).

---

## 9 Setup: `.facade/worktrees.json`

What a new worktree needs installed - `npm ci`, `uv sync`, `dotnet restore` - differs by language and
by repository, so a repository says what to run, per OS:

```
.facade/worktrees.json
{
    "setup-worktree":         ["npm ci"],     every OS, unless the OS has its own key
    "setup-worktree-windows": ["npm ci"],     Windows
    "setup-worktree-unix":    ["npm ci"]      macOS and Linux
}
```

- **WT-7.1** Read from the new worktree first, then from the main checkout, so an uncommitted file in
  the main checkout still works. No file, no setup.
- **WT-7.2** Each value is an array of command lines. A file that does not parse, or a value that is not
  an array of strings, is said in one warning, and nothing runs.
- **WT-7.3** It runs in one terminal named "Worktree Setup", opened in the worktree after the switch
  has restored its editors (WT-5.7), with the default terminal profile. `ROOT_WORKTREE_PATH` is set to
  the main checkout's path.
- **WT-7.4** The lines run one after another, whatever the line before did. With shell integration,
  each waits for the one before to finish; without it, they are typed ahead. Steps that depend on each
  other belong in a script, named on one line.
- **WT-7.5** A terminal, because the output is on screen, the person's own shell and environment are
  used, and a failed step can be run again. The worktree is usable either way.
- **WT-7.6** Upstream's `runOn: worktreeCreated` tasks are not used: the git extension runs them hidden,
  and only from `Repository.createWorktree` (WT-4.2).

---

## 10 Removing a worktree

`Delete Worktree...` on a worktree row. The order is the design: everything that can hold the
directory open is gone before git is asked to delete it.

```
1  check      _git.deleteWorktreeAt(root, path, 'check'): the files that would be lost, and
              whether submodules are checked out
2  confirm    always (WT-8.1)
3  move off   if the window is on this worktree, it moves to the repository's row; from here on
              the worktree has no row (WT-8.9)
4  leave      out of folders[]
5  terminals  any terminal still working inside the worktree is closed
6  delete     'remove', or 'force' when step 1 found changes or submodules
7  refresh    nothing to do: the reader's watchers see git's records change (§5)
```

- **WT-8.1** Always confirmed, clean or not; no setting turns it off, as this deletes files from disk.
  The dialog says the branch is kept, and warns when a terminal that goes with the worktree is still
  running something. The worktree's name, colour, place in a moved order and trust are forgotten with
  it.
- **WT-8.2** Files that would be lost are listed by name - the first ten, then how many more - and
  `force` is used only after that confirmation. With submodules checked out, it says they go with it.
- **WT-8.3** Step 3 before step 4, or the window would move to the next folder in `folders[]`, which
  can be another repository.
- **WT-8.4** Steps 4 and 5 before step 6: on Windows, a process whose working directory is inside a
  folder stops the folder being deleted. Steps 3 to 6 run under one progress notification, and a
  second Delete of the same worktree meanwhile does nothing.
- **WT-8.5** A directory git has let go of but left behind is removed (WT-4.5).
- **WT-8.6** If step 6 fails, the error is said. The worktree stays out of `folders[]` and listed by
  git, so its row comes back, to try again.
- **WT-8.7** The branch is kept.
- **WT-8.8** `Remove Folder` on a repository row - which never touches the disk - takes that
  repository's worktrees out of `folders[]` with it. They stay on disk and in git.
- **WT-8.9** Once the window is off the worktree, its row leaves the bar, although git's records keep
  it until step 6 is done - seconds, for a large worktree. When step 6 is over, git's files are read
  again before the row may come back: after a deletion that worked it does not, after one that
  failed it does.

---

## 11 The switch

`facade.workspaceBar.worktrees`, boolean, default `true`. Off, the bar is the flat list of
`folders[]`, and the worktree commands are neither offered nor run.

---

## 12 Per platform

Everything above is the same on Windows, macOS and Linux, except:

```
             Windows                                macOS and Linux
location     %USERPROFILE%\.facade\worktrees        ~/.facade/worktrees
setup key    setup-worktree-windows                 setup-worktree-unix
long paths   259 characters; git's error is shown   -
removal      a terminal inside the worktree         -
             blocks deleting it (WT-8.4)
```

---

## 13 Not included

```
worktrees inside the repository        they would need an ignore entry, and nest folders of the
                                       workspace
linking or copying dependencies        a repository can do it in its own setup script
automatic cleanup, limits              these worktrees are made by a person and kept until deleted
deleting the branch                    keeping it loses nothing
choosing a base ref, cloning           later, each on its own
a running state on a worktree's dot    later: the dot is drawn, but does not yet say whether
                                       something runs in the worktree
other tools' config files              .cursor/worktrees.json and the like - one file of ours
```
