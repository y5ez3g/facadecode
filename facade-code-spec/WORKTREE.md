# Worktrees

What Facade Code adds on top of the workspace so that a repository's git worktrees are rows in the
workspace bar.

Built on [`WORKSPACE.md`](./WORKSPACE.md) and changing nothing it promises. Its two promises and its
one principle - **one window, many folders** - hold here unchanged.

⭐ **The rule this plan was made by: do what most shipping products do, reuse what upstream already
has, and add nothing clever.** Every decision in §2 names the products that do it the same way. What
those products do, per platform, is in [`WORKTREE-RESEARCH.md`](./WORKTREE-RESEARCH.md); what this
repository measured on this machine is in §18.

---

## 1 A worktree is not a workspace

```
workspace   folders[] - the list of folders this window holds.          WORKSPACE.md owns it
worktree    a git fact: a working tree that shares one repository        this document owns it
            with other working trees. `git worktree add` makes one
```

The two meet in exactly one place: **a worktree somebody works in is a folder of the workspace.**
It is in `folders[]` like any other folder, so everything WORKSPACE.md built applies to it without
new code: switching in tens of milliseconds, a working set of editors per folder, terminals that stay
with the folder they were opened in, source control and search narrowed to it.

What this document adds is only what is about git: which folders are one repository, where a new
worktree goes, making and removing one, and what a new worktree needs that git does not give it.

**Vocabulary.** The top-level row stays a **folder**, the word the bar and WORKSPACE.md already use.
The second level is a **worktree**. ⚠️ Not "project": WORKSPACE.md §2.3 counts 136 user-visible strings
that say "Workspace" and cites microsoft/vscode#77718 for what a second meaning of one word costs.

---

## 2 The plan, and who does it this way

```
decision              what                                          the same in
location              ~/.facade/worktrees/<repo>/<name>, every OS    Cursor, Codex, Devin, Antigravity,
                                                                     Trae - five of eight products
creating              git worktree add -b <branch> <path> HEAD       every product
Git LFS               GIT_LFS_SKIP_SMUDGE=1 while creating           Codex, Claude Code
trust                 a worktree of a trusted repository is          Cursor (VS Code: inherited)
                      trusted
ignored small files   .worktreeinclude at the repository root,       Claude Code, Codex, Trae
  (.env and the like) gitignore syntax
dependencies          not the product's job                          every product
setup                 .facade/worktrees.json with per-OS keys,       format: Cursor. Per-OS setup:
                      run in a visible terminal                      Cursor, Codex, Devin
removal               git worktree remove; list changes and          VS Code agent host, Trae
                      confirm before --force; make sure the
                      directory is gone
the branch            kept when the worktree is removed              VS Code, Codex, Kiro
automatic cleanup     none                                           VS Code, Kiro, Trae, Antigravity
long paths            nothing special: short paths, and git's        eight of ten implementations
                      own error said on screen
listing               read git's own files                           VS Code (getWorktreesFS)
```

Two places go past "do nothing", each because §18 measured this repository failing without it:
**LFS** (a worktree of this repository cannot be created otherwise, §18.1) and **making sure the
directory is gone** after removal (git reported success and left one behind, §18.7).

---

## 3 The shape

```
▾ FacadeCode                    the main checkout IS the folder row
    feature/8-worktrees         a worktree
    fix/banner
▸ api-gateway                   a repository, collapsed
  notes                         no .git of its own: no second level
```

Numbered so that a test can cite the rule it checks.

- **WT-1.1** Two levels: folder, then worktree. ❌ No third level.
- **WT-1.2** The main checkout does not get a row of its own. It is the folder row.
- **WT-1.3** ⭐ The second level lists **every worktree git records** for that repository, whether or
  not it is in `folders[]` - including ones made on a command line or by another tool. The list comes
  from git's own files (§5), never from `ISCMService`.
- **WT-1.4** ⭐ A worktree that is not yet in `folders[]` joins it the first time somebody goes to it,
  through `IWorkspaceBarService.show()` - the seam WORKSPACE.md stage E built for "show me this
  folder". Listing a worktree never adds it; only going to it does.
- **WT-1.5** One click goes there. The twistie only expands and collapses. ❌ One click never does both.
- **WT-1.6** Folder rows keep `folders[]` order; Move Up / Move Down keep working as today. A worktree
  added to `folders[]` is appended and never moves a folder row. A folder row whose main checkout is
  not in `folders[]` - somebody added only a worktree of it - sits where its first member is.
- **WT-1.7** Worktrees sort by branch name, numerically: `w2` before `w10`.
- **WT-1.8** A folder with its own `.git` directory and no worktrees shows one row, "No worktrees yet —
  create one", which starts §7. A folder without its own `.git` has no second level and no offer.
- **WT-1.9** A worktree git still records but whose directory is gone is listed, greyed, and can be
  deleted, which runs `git worktree prune`.
- **WT-1.10** Collapsed to its column of icons, the bar shows folder rows only. When the window is on
  a worktree, its repository's row carries the active mark. (Decided 2026-09-24. A column of icons
  cannot tell a repository from a worktree, so the worktrees wait for the bar to open.)
- **WT-1.11** The context menu follows the row: `New Worktree...` on a repository row, `Delete
  Worktree...` on a worktree row, and Customize and Move Up/Down on folder rows only, as today.

---

## 4 Where worktrees live

- **WT-2.1** `<home>/.facade/worktrees/<repo>/<name>`, on every OS. `<home>` is
  `IPathService.userHome()`.
- **WT-2.2** `<repo>` is the main checkout's folder name. `<name>` is the branch name with `/` replaced
  by `-` (upstream's own rule, `extensions/git/src/repository.ts:1954`), and every character Windows
  forbids in a file name (`< > : " | ? * \`) replaced by `-` - on every OS, so the same branch makes
  the same directory everywhere. A name that is a Windows device name (`con`, `prn`, `aux`, `nul`,
  `com1`-`com9`, `lpt1`-`lpt9`) is refused with a sentence saying why.
- **WT-2.3** A path that is taken gets `-1`, `-2`, and so on (upstream's rule). That also separates two
  different repositories whose folders have the same name.
- **WT-2.4** Nothing is written into the repository: no `.gitignore` entry, no `.git/info/exclude`
  entry, no `files.exclude` default.

Why here and not inside or beside the repository: it is what most products do, and it keeps a
worktree out of every other folder. Every folder of this window stays resident (WORKSPACE.md §5.4), so
a worktree inside its repository would be a workspace folder nested in another one, and the narrowing
WORKSPACE.md stages A to C shipped would count one folder's files and repositories as the other's.
Outside, that never arises, and a repository's own tools - tests, linters, search - never see its
worktrees either.

**Long paths.** Nothing special (WT-2.5). With this location the prefix on this machine is
`C:/Users/y5ez3/.facade/worktrees/FacadeCode/` - 44 characters. §18.2 measured this repository's
limit exactly: its longest tracked path is 186 characters and Windows allows 259, so a worktree
`<name>` of up to 28 characters works here. Longer fails with git's own "Filename too long", which
WT-5.5 says on screen.

- **WT-2.5** ❌ No `core.longpaths`, no path-length pre-check. Eight of ten implementations do neither.

---

## 5 Reading: git's own files, through IFileService

⚠️ **The list is ours to read, not the SCM service's to lend.** Kumite first built the second level
from `ISCMService` - the repositories the git extension happens to have open right now - and rows
flickered, vanished and reordered on every switch, because the extension closes and reopens
repositories as the window changes folder. L1-PLAN.md step 2 already records this. What upstream's
`getWorktreesFS` (`extensions/git/src/git.ts:3030`) does, and what this does: read the files git
writes, and run no git at all.

```
<folder>/.git                          a directory: a repository's main checkout
                                       a file "gitdir: X": a worktree, X is its git dir
<git dir>/commondir                    in a worktree's git dir: the shared .git, relative
<common>/HEAD                          the main checkout's branch
<common>/worktrees/<name>/HEAD         each worktree's branch
<common>/worktrees/<name>/gitdir       each worktree's path, with /.git at the end
```

- **WT-3.1** Rows are grouped by the common git directory, canonicalised the way the bar already
  canonicalises folders (`canonicalUri` in `workspaceBar.ts`). Whether somebody added the main
  checkout or one of its worktrees, following `commondir` arrives at one directory.
- **WT-3.2** The main checkout is the parent of the common directory when that directory is named
  `.git`. A bare repository has no main checkout (§16).
- **WT-3.3** A branch is `ref: refs/heads/<name>` in `HEAD`, shown without the prefix. A detached HEAD
  shows its short hash.
- **WT-3.4** Watching is correlated (`IFileService.createWatcher`) and per directory: `<common>`,
  `<common>/worktrees`, and each `<common>/worktrees/<name>`. ⚠️ Kumite never verified that
  `git checkout` inside a worktree changes its row; it is a live test here (§14).
- **WT-3.5** `git.detectWorktrees` stays at upstream's default, `false`
  (`extensions/git/package.json:3720`). Nothing here depends on it.

The reader is its own file, `workspaceBarGit.ts`, next to the model. It knows nothing about the tree;
the view asks it for groups.

---

## 6 Writing: two commands in the git extension

The renderer is sandboxed and cannot run git (L1-PLAN.md step 2). Upstream's `git.createWorktree` and
`git.deleteWorktree` open their own pickers and modals, which cannot sit inside the bar's flow. So the
git extension gets two non-interactive commands:

```
git.createWorktreeAt(root, path, branch)
    git worktree add -b <branch> <path> HEAD      with GIT_LFS_SKIP_SMUDGE=1 in the environment
    then copies .worktreeinclude (§8)
    answers { path }, or { error: { code, message } } carrying upstream's own error codes:
      BranchAlreadyExists (always -b, so a branch that exists is this - checked out elsewhere or
      not), WorktreeAlreadyExists (the path), InvalidBranchName

git.deleteWorktreeAt(root, path, mode)
    'check'    git -C <path> status --porcelain; answers { dirty: files[] } and removes nothing
    'remove'   git worktree remove <path>
    'force'    git worktree remove --force <path>
    after a remove that git accepted: if the directory is still there, fs.rm it (recursive, force,
    maxRetries 5), then git worktree prune
    answers { removed: true }, or { error: { code, message } }
```

- **WT-4.1** These two are the only change to `extensions/git`. Their logic lives in one new file;
  `commands.ts` only registers them, so a merge from upstream has one line to look at.
- **WT-4.2** ❌ They do not call upstream's `Repository.createWorktree`. That method also starts the
  `git.worktreeIncludeFiles` copy, whose upward walk copies tracked directories (§18.4), and
  `runOn: worktreeCreated` tasks, without awaiting either. One command, one thing.
- **WT-4.3** They run git with the command centre's own `Git.exec(root, args, { env })` - the
  extension's runner, `execFile` with an argument array (ENGINEERING.md), the same error codes. No
  `Repository` object and no `openRepository`, so there is nothing to find or open first. (This
  replaces Kumite's route through `openRepository(root, true, true)`, whose missing flag made a
  command do nothing, silently.)
- **WT-4.4** ⚠️ **They answer, they never throw.** The extension wraps every command it registers,
  and a thrown error becomes its own modal error box (`createCommand` in `commands.ts`). The bar says
  what went wrong in its own words (WT-5.3), so the error has to come back to it as a result.
- **WT-4.5** ⚠️ The leftover directory is removed only when git has confirmed the path was a worktree:
  `git worktree remove` succeeded, or it failed but `git worktree list` named the path before it and
  no longer does (the Windows case in §18.7). A path git never listed fails the same way and is left
  alone - tested. Nothing else can make this command delete a directory.
- **WT-4.6** ⚠️ `npm run transpile-client` does not build extensions. After changing `extensions/git`,
  run `npm run gulp compile-extension:git`, or the window runs the old extension.

---

## 7 Creating a worktree

Entries: the `+` on a repository row, the empty-state row (WT-1.8), and the command palette
(`New Worktree...`).

- **WT-5.1** Not offered on a folder without its own `.git`. On an untrusted folder the entry is
  there, and says the folder has to be trusted first.
- **WT-5.2** A QuickPick asks for one thing: the branch name. Under the input it says where the
  worktree will be and that it starts at the main checkout's current HEAD. ❌ No base-ref choice.
- **WT-5.3** No checks of our own before creating. Git's errors are the checks, and each is said in
  words: the branch is used by another worktree → only "Go There"; the path exists → say so; anything
  else → git's own message as the detail.
- **WT-5.4** Creating shows a progress notification, "Creating worktree <branch>...". It takes 20 to
  30 seconds for this repository (§18.1). It cannot be cancelled: a half-made worktree is worse than
  waiting.
- **WT-5.5** ❌ A failure is never only in the log. Kumite's first version wrote failures to
  `logService` alone, and to the person it looked like a click that did nothing.
- **WT-5.6** The whole flow, in this order:
  ```
  1  name       the branch asked for (WT-5.2); the path worked out by WT-2.2, and WT-2.3's suffix
                chosen by asking IFileService whether the path exists
  2  create     git.createWorktreeAt, under the progress notification (WT-5.4)
  3  trust      IWorkspaceTrustManagementService.setUrisTrust([worktree], true), since it was made
                from a trusted repository
  4  show       IWorkspaceBarService.show(worktree): into folders[], and the window moves onto it
  5  wait       for IWorkspaceBarService.onDidRestoreEditors
  6  setup      §9, in a terminal of the worktree
  ```
- **WT-5.7** ⚠️ Step 5 is not optional. A switch restores the incoming folder's editors, and the
  restore closes whatever else is in the editor area; `onDidRestoreEditors` fires once it has
  finished (`workspaceBarService.ts`). A setup terminal opened as an editor before then is closed by
  the restore.

---

## 8 `.worktreeinclude`

For the small ignored files a checkout needs and git does not give it: `.env`, `local.properties`,
local config. The same file Claude Code, Codex and Trae read, so one file serves them all.

- **WT-6.1** A file named `.worktreeinclude` at the root of the main checkout, in gitignore syntax. No
  file, nothing copied.
- **WT-6.2** A path is copied when it is **both** ignored by the repository **and** matched by
  `.worktreeinclude`:
  ```
  candidates  git ls-files --others --ignored --exclude-standard --directory
              what git ignores, with a wholly ignored directory as one entry
  matched     each candidate against .worktreeinclude, read as gitignore reads a pattern file:
              # comments, ! negates, a trailing / for directories, no other / matches at any depth,
              the last matching rule wins, an included directory brings everything under it
  ```
  So a tracked file is never copied and an untracked file that is not ignored is never copied.
  ⚠️ **The candidates are listed with `--directory`, as Claude Code lists them.** A pattern like
  `*.local.json` then never reaches into `node_modules`, and a file inside a wholly ignored directory is
  reached by naming the directory. Listing every ignored file instead - the two-`ls-files` intersection
  this rule first said - took 9.8 s and 22 MB of output on this repository, and matched files deep
  inside `node_modules` (§18.9).
- **WT-6.3** A file with `fs.copyFile` and `COPYFILE_EXCL`, a directory with `fs.cp` and
  `force: false` - never over something git checked out. Parent directories are created; links are
  skipped.
- **WT-6.4** A file that fails to copy does not stop anything. One warning names how many failed and
  the first few.
- **WT-6.5** It is for small files. Listing a dependency directory in it copies every file one by one -
  for this repository's `node_modules` that is 223,114 files and about five minutes (§18.3, §18.4).
  Dependencies belong to setup (§9).

---

## 9 Setup: `.facade/worktrees.json`

What a new worktree needs installed - `npm ci`, `uv sync`, `dotnet restore`, `pod install` - differs by
language and by repository, and no product installs it for you. Cursor, Codex and Devin each let a
repository say what to run, per OS. This uses Cursor's format.

```
.facade/worktrees.json
{
    "setup-worktree":         ["npm ci"],     every OS, unless the OS has its own key
    "setup-worktree-windows": ["npm ci"],     Windows
    "setup-worktree-unix":    ["npm ci"]      macOS and Linux
}
```

- **WT-7.1** Read from the new worktree first, then from the main checkout - so an uncommitted file in
  main still works. No file, no setup, and nothing is offered.
- **WT-7.2** Each value is an array of command lines. A file that does not parse, or a value that is
  not an array of strings, is said in one warning and nothing runs.
- **WT-7.3** It runs in **one terminal, opened in the worktree after the switch has restored its
  editors** (WT-5.7), with the person's default terminal profile, named "Worktree Setup"
  (`ITerminalService.createTerminal` with `cwd`, `name` and `env`, then `sendText` per line). The
  environment carries `ROOT_WORKTREE_PATH`, the main checkout's path - Cursor's name for it, so a
  script written for Cursor works here.
- **WT-7.4** Each command line is sent as its own line, one after another, whatever the previous line
  did. Steps that depend on each other go into a script, named on one line
  (`./scripts/setup-worktree.sh`, `.\scripts\setup-worktree.ps1`).
- **WT-7.5** Why a terminal: the output is on screen, the person's own shell and environment are used,
  and there is nothing of ours to time out, kill or recover. A failure is visible, can be rerun, and
  never stops the worktree being usable.
- **WT-7.6** ❌ Upstream's `runOn: worktreeCreated` tasks are not used. The git extension runs them
  hidden, without the main checkout's path, and only from `Repository.createWorktree` (WT-4.2).

---

## 10 Removing a worktree

`Delete Worktree...` on a worktree row's context menu runs these steps, in this order. The order is
the design: everything that can hold the directory open is gone before git is asked to delete it.

```
1  check      git.deleteWorktreeAt(root, path, 'check') -> the files that would be lost
2  confirm    always (WT-8.1), naming the files from step 1 if there are any
3  move off   if the window is on this worktree, it moves to the repository's folder row
4  leave      WorkspaceBarModel.remove([worktree]) - out of folders[]
5  terminals  any terminal still working inside the worktree is closed
6  delete     git.deleteWorktreeAt(root, path, 'remove'), or 'force' when step 1 found changes
7  refresh    nothing to do: the reader's watchers see git's records change (§5)
```

- **WT-8.1** The confirmation is always asked, clean or not, and no setting turns it off: this
  deletes files from the disk. (Decided 2026-09-24. `facade.workspaceBar.confirmRemoveFolder` is not
  reused - that one guards a list edit that deletes nothing.) It says the branch is kept, and when a
  terminal of the worktree has something running, it says that too.
- **WT-8.2** With changes, every file that would be lost is listed by name, and `'force'` is used only
  after that confirmation. ❌ Never silently.
- **WT-8.3** ⚠️ Step 3 before step 4: otherwise `IActiveFolderService` moves the window to the
  neighbour in `folders[]`, which can be another repository entirely.
- **WT-8.4** ⚠️ Step 4 before step 6, and step 5 as well. On Windows a process whose working directory
  is inside a folder stops the folder being deleted (§18.7). Leaving `folders[]` makes
  `folderTerminals.ts` dispose the terminals it had parked for that folder - existing behaviour,
  nothing new. Step 5 closes the rest: terminals elsewhere (the panel, say) whose working directory is
  inside the worktree.
  ⚠️ Disposed is not exited. A terminal folderTerminals disposes in step 4 has left `instances` by
  step 5 while its shell is still exiting inside the worktree (found live in W5: git failed on the
  directory). So the terminals inside the worktree, and a promise for each one's `onExit`, are taken
  after the confirmation and before step 3; step 5 adds any new ones, disposes them all and waits for
  every exit, at most 3 s.
- **WT-8.5** Step 6 may leave a directory that git has let go of (§18.7) - after exit 0, or after
  "failed to delete ... Permission denied" when something outside the window still has it open; the
  command removes it (WT-4.5), retrying for about five seconds. `fs.rm` does not follow junctions or links, so nothing outside the worktree is touched
  (§18.5).
- **WT-8.6** If step 6 fails, the error is said in words (WT-5.5). The worktree stays out of
  `folders[]` and stays listed by git, so its row is still there to try again.
- **WT-8.7** The branch is kept. ❌ No option to delete it in this plan.
- **WT-8.8** `Remove Folder` on a repository row - which never touches the disk - takes that
  repository's worktrees out of `folders[]` with it. They stay on disk and in git.

---

## 11 The switch

`facade.workspaceBar.worktrees`, boolean, default `true`.

```
off   the bar is today's flat list of folders[], exactly
      the two git commands exist and nothing calls them
```

---

## 12 Per platform

Everything above is the same on Windows, macOS and Linux, except:

```
                   Windows                          macOS                         Linux
location           %USERPROFILE%\.facade\worktrees  ~/.facade/worktrees           ~/.facade/worktrees
setup key          setup-worktree-windows           setup-worktree-unix           setup-worktree-unix
setup shell        the default terminal profile     the default terminal profile  the default terminal
                   (PowerShell unless changed)                                    profile
long paths         259 characters; git's error      none                          none
                   is shown (WT-2.5)
removal            terminals closed first matters:  -                             -
                   an open cwd blocks deletion
```

That is the whole list. Which shell and environment the setup runs in is the terminal's business, as
it is for every other terminal in the window.

---

## 13 Implementation order

Each stage is its own `feature/<n>-<name>`, reviewed, merged with `--no-ff`, and lands with its tests
(ENGINEERING.md).

```
the division of work

  the bar - renderer, cannot run git                  the git extension - Node, runs git
  workspaceBarGit.ts        reads .git, groups rows    git.createWorktreeAt   create + .worktreeinclude
  workspaceBarView.ts       the two-level tree         git.deleteWorktreeAt   check / remove / force
  contrib/worktrees         create and delete flows,
    /browser/worktrees.ts   the setup terminal
            |                                                   ^
            +------------ ICommandService.executeCommand -------+
```

```
W0  measure            done - §18

W1  the reader         new  browser/parts/workspacebar/workspaceBarGit.ts
                       §5. Input folders[], output groups: a repository (its main checkout, and
                       each worktree with branch, in-folders[] and on-disk) or a plain folder.
                       IFileService reads, createWatcher per directory. No UI, no change to
                       existing files.
                       tests: upstream's FileService over an InMemoryFileSystemProvider, with .git
                       layouts written into it - real reads, not a mocked IFileService

W2  the tree           changed  workspaceBarView.ts, workspaceBarPart.ts, workspaceBarActions.ts,
                                media/workspacebarpart.css
                       WorkbenchList -> WorkbenchObjectTree, two levels (§3). The folder row's
                       renderer and every overrideStyles entry stay as they are; a second template
                       draws worktree rows with Codicon.gitBranch. One click on a row in folders[]
                       -> switcher.switchTo; on one that is not -> IWorkspaceBarService.show
                       (WT-1.4). A context key overlay per row - folder | repository | worktree -
                       drives the menus (WT-1.11). Collapsed: folder rows only (WT-1.10).
                       The switch (§11) is registered next to confirmRemoveFolder in
                       workspaceBarActions.ts

W3  the git commands   new      extensions/git/src/worktreeAt.ts
                       changed  extensions/git/src/commands.ts - registration only
                       §6 and §8. No package.json change: the commands are called, not listed.
                       tests: fixture repositories in a temporary directory, as §18.8 did

W4  create             new  contrib/worktrees/browser/worktrees.ts, worktrees.contribution.ts
                       §7 and §9: the QuickPick, names (WT-2.2, 2.3), the command, trust, show,
                       wait for onDidRestoreEditors, the setup terminal. The bar gains the `+` on a
                       repository's row and the "No worktrees yet" row, both calling the command,
                       and IWorkspaceBarService.repositoryFor.
                       ⚠️ In contrib/, not beside the bar as first planned: vs/workbench/browser may
                       not import contrib/terminal (valid-layers-check), and the setup step needs
                       it. folderTerminals sits in contrib/ for the same reason

W5  delete             contrib/worktrees/browser/worktrees.ts - §10, in its seven steps
                       workspaceBarActions.ts - Remove Folder on a repository row (WT-8.8)
                       extensions/git/src/worktreeAt.ts - the Permission denied case (WT-4.5)
```

⚠️ **W2: refresh the tree declaratively.** Kumite's first tree kept object caches, applied collapse
state by hand and diffed identities (`repositoryCache`, `worktreeCache`, `applyCollapsed`,
`diffIdentityProvider`), and still had expanded rows close by themselves. What it landed: one
`setChildren(null, children)` per change, each element carrying its own `collapsed`
(`ObjectTreeElementCollapseState.PreserveOrExpanded`), and expansion, focus and scroll saved together
through `getViewState()`. The model to copy is
`src/vs/sessions/contrib/sessions/browser/views/sessionsList.ts`, which is in this tree.

---

## 14 Tests

**Unit**

```
the reader         main + N worktrees · detached HEAD · a worktree whose directory is gone · a folder
                   without .git · a bare repository · one repository added under two spellings
grouping, order    folder order from folders[] · numeric branch sort · a group whose main checkout
                   is not in folders[]
names              "/" to "-" · Windows-forbidden characters · device names refused · "-1" suffix
.worktreeinclude   on fixture repositories: ignored AND matched is copied · tracked never · untracked
                   but not ignored never · no overwrite · symlink skipped
setup              the key chosen per OS · worktree file before main's · no file, no terminal · a
                   file that does not parse -> one warning, nothing runs
the commands       createWorktreeAt's error codes come back as results, never thrown · 'check'
                   lists dirty files and removes nothing · 'remove' on a dirty worktree -> the
                   WorktreeContainsChanges code · a directory a process still has open is removed
                   once git has let go of it · a folder git never listed, and the main checkout, are
                   refused and left on disk
menus              New Worktree only on repository rows · Delete Worktree only on worktree rows ·
                   Customize and Move only on folder rows
```

**Live, in a running window.** WORKSPACE.md's two standing checks apply to every row: switch folders
and read the surface again, and read it again with no editor open.

```
create             row appears · folders[] gained one entry · the window is on it · it is trusted
                   · the path is under ~/.facade/worktrees
this repository    a worktree of FacadeCode itself is created (LFS pointers, §18.1)
.worktreeinclude   a .env is copied; a file git checked out is not overwritten
setup              the terminal opens in the worktree and runs each line; ROOT_WORKTREE_PATH is set;
                   a failing line leaves the worktree usable; the terminal is still open after the
                   switch has restored the worktree's editors (WT-5.7)
git's errors       branch used elsewhere -> only Go There · path exists -> said
listed, not added  a worktree made on a command line is listed; folders[] unchanged until clicked
a branch change    git checkout in a worktree's terminal -> its row's label follows
delete             a clean worktree still asks first · dirty -> every file listed · the window on it
                   -> moves to its repository row, not a neighbour · a terminal open in it on
                   Windows, in the editor area and in the panel -> closed first, deletion succeeds ·
                   no directory left behind · the branch still exists
collapsed          folder rows only · on a worktree -> its repository row is marked
the switch         off -> the bar is today's list
restart            everything above survives a reload
```

**Gates, every stage:** `npm run valid-layers-check`, `npm run stylelint`, `npm run gulp -- hygiene`.

---

## 15 Traps

Each of these cost a wrong answer first, in Kumite or in W0.

```
refs/heads/<name>                compare branch names without the prefix
"a branch named ... already       git 2.55 writes it lower-case; upstream's getGitErrorCode matches
  exists"                        "A branch named" and misses it. worktreeAt.ts recognises it itself,
                                 or the bar cannot offer Go There (found live in W4)
a thrown error in a git command  becomes the git extension's own modal (WT-4.4) - answer, never throw
an editor opened mid-switch      is closed by the restore of the working set - wait for
                                 onDidRestoreEditors (WT-5.7)
transpile-client                 does not build extensions/git (WT-4.6)
ISCMService                      not a source for the list (§5)
git worktree remove -> 0         does not mean the directory is gone (§18.7)
git worktree remove -> 1         does not mean the worktree is still there: on Windows git deletes
                                 the files and its record, then fails on the directory (§18.7)
a shell inside the folder        on Windows, blocks deleting it (§18.7)
a disposed terminal              is not an exited one: its shell still holds the directory for a
                                 moment, and it has already left `instances` - take the exit
                                 promises before anything disposes it (WT-8.4, found live in W5)
filter.lfs.required=true         Git for Windows' system config: a missing LFS object fails the
                                 whole checkout (§18.1)
"verified" copy                  Kumite's dependency copy "passed" for a day while copying every
                                 byte, because the check was that it did not fail. Measure bytes on
                                 disk, not the absence of an error
```

---

## 16 Open

```
a bare repository             it has no main checkout to be the folder row (WT-3.2)
orphaned worktrees            a repository folder deleted from disk leaves its worktrees under
                              ~/.facade/worktrees, recorded nowhere
the .code-workspace file      a visited worktree is in the file, under the person's home. On another
                              machine it is an unavailable row - today's behaviour for any missing
                              folder. Acceptable?
the mark after a create       measured in W4: the window is on the new worktree 1.07 s after Enter,
                              its row appears 1.55 s after - half a second with no row marked,
                              while the reader reads git's files again. Harmless; worth closing
long names on Windows         whether git operations after creation - a checkout, a stash - also need
                              longpaths past 259 characters (§18.2). Only matters near the limit
```

---

## 17 Deliberately not in this plan

Each is something a product does, or something considered here, left out because the mainstream does
without it or because it adds a way to be wrong.

```
worktrees inside the repository     Claude Code's choice; it needs an ignore entry and, here, nested
                                    roots (§4)
linking or copying dependency       only Claude Code offers it (opt-in, and it fails on Windows without
  directories                       Developer Mode). A repository can do it in its setup script
copy-on-write                       only VS Code, only on macOS
path-length checks, longpaths       two of ten implementations
suggesting install commands         nobody does it
automatic cleanup, limits           built for agent worktrees that are thrown away; these are made by a
                                    person and kept until they delete them
a snapshot before deleting          Codex
deleting the branch                 half the products do, half do not; keeping it loses nothing
status dot, "+N more" folding       Kumite UI; later, on its own
choosing a base ref, git init,      later, each on its own
  clone, dragging
other products' config files        .cursor/worktrees.json, .codex/environments - one file of ours
a JSON schema for worktrees.json    associating a schema with the file is its own plumbing; WT-7.2
                                    says a bad file in one warning instead
upstream's git.worktreeIncludeFiles its walk copies tracked directories (§18.4)
  and runOn: worktreeCreated        hidden, and without the main checkout's path (WT-7.6)
```

---

## 18 W0 — measured

2026-09-23, on the development machine, against this repository at `761e7afa`. Measured before the
location was decided, so the worktrees here were made inside the repository, under `.facade/worktrees/`.

```
machine     Windows 11 Pro 10.0.26200 · C: and D: both NTFS · no Dev Drive
            Defender real-time protection on; its exclusions cannot be read without admin, so
            assume every file written is scanned
tools       git 2.55.0.windows.3 · Git LFS with filter.lfs.required=true (Git for Windows'
            system config) · node 24.18.0 · npm 11.16.0
worktrees   git worktree add --detach, under .facade/worktrees/, all removed afterwards
fixtures    throwaway repositories in a temporary directory, for anything that could damage the
            real one
```

### 18.1 Creating a worktree of this repository fails, before any path matters

```
git worktree add --detach .facade/worktrees/<name> HEAD
  -> error: external filter 'git-lfs filter-process' failed
     fatal: extensions/copilot/test/simulation/cache/base.sqlite: smudge filter lfs failed
     Smudge error: ... [404] Not Found
```

The vendored tree carries **98 Git LFS pointers** (`extensions/copilot/.gitattributes`:
`*.sqlite filter=lfs`). Their objects were never pushed to the Gitea remote. The main checkout never
had them either - `base.sqlite` in it is the 133-byte pointer, and `git lfs ls-files` marks all 98 with
`-`, not `*` - so nothing in main looks wrong. A new checkout runs the smudge filter, the filter is
required, and the download 404s.

```
GIT_LFS_SKIP_SMUDGE=1 for that one command     succeeds, and the worktree holds the same
                                               pointers main holds
time, 18909 tracked files                      26.6 s · 27.6 s · 18.1 s
```

⚠️ **This is not specific to this fork.** Any repository whose LFS objects are missing, or large, or
behind a slow link, makes worktree creation fail or crawl.

### 18.2 Path length: the boundary is exact

```
prefix measured           C:/Users/y5ez3/apps/FacadeCode/.facade/worktrees/<name>/  (49 + name + 1)
predicted                 186 + 49 + name + 1 <= 259: a name of 24 characters or more breaks
23 characters             created, 26.6 s
24 characters             error: unable to create file src/vs/workbench/contrib/notebook/test/
                          browser/__snapshots__/NotebookEditorStickyScroll_...0.snap: Filename too long
                          fatal: Could not reset index file to revision 'HEAD'.
                          git removed the half-made worktree itself; nothing was left behind
32 characters, with       created, 18.1 s. `-c` sets it for that one command: no config is written
  git -c core.longpaths=true
afterwards, in that one   git status WITHOUT longpaths: works, clean
                          Node reads the 268-character path
```

With the chosen location (§4) the prefix is `C:/Users/y5ez3/.facade/worktrees/FacadeCode/` - 44
characters - so the same arithmetic allows names of up to 28 characters for this repository.

### 18.3 What there is to copy

```
ignored node_modules directories     56 · 6502 MB · 223114 files · 26591 dirs · 1 symlink
  node_modules/                             1921 MB    40709 files
  extensions/copilot/node_modules/          1278 MB    73677 files
  remote/node_modules/                       871 MB     5760 files
  extensions/mermaid-markdown-features/      310 MB    23787 files
  build/node_modules/                        285 MB    21168 files
  the other 51                              1837 MB    58013 files
where they are                       1 at the repository root · 55 inside a tracked directory
walking them once                    35 s
listing them                         git ls-files --others --ignored --exclude-standard --directory
                                     0.33 s - the whole list, exact, without walking anything
```

### 18.4 Upstream's copy, as it is

Run as a **replica**, not through the extension: the same two rg invocations with the arguments
`ripgrepFileSearch.ts` builds for `findFiles2`, upstream's reduction to top-most paths copied verbatim,
and the same `fs.cp` with `{ force, recursive, verbatimSymlinks }`, fifteen at a time.

```
enumeration, both rg passes          2.0 - 2.2 s. Not a cost
"**/node_modules/**"                 ⚠️ reduces to 7 top-most paths - and 5 of them are TRACKED
                                     directories: .vscode  build  extensions  remote  test
                                     (the other two: .build  node_modules)
56 explicit patterns,                reduces to exactly the 56 directories
  "<dir>/node_modules/**"
copying those 56                     288 s · 6501 MB · 222871 files · 55 of 56 succeeded
  the one that failed                extensions/microsoft-authentication/node_modules - its `keytar`
                                     is a symlink, and making one needs Developer Mode or admin:
                                     EPERM. fs.cp stops there and keeps what it wrote: 2614 of 2887
                                     entries. Upstream says "Failed to copy 1 folder(s)/file(s)", and
                                     the worktree has a node_modules that is there and is not complete
disk                                 NTFS has no copy-on-write: every byte, for every worktree.
                                     25 worktrees of this repository would be 160 GB
```

⚠️ The 288 s overlapped a `du` of the same tree for about two minutes. Read it as roughly five minutes.

**Why `**/` overshoots**, in upstream's walk (`_getWorktreeIncludePaths`): from every ignored file it
walks up, adding each directory, until it reaches the pattern's fixed base. The base of
`**/node_modules/**` is the repository root, so every tracked ancestor of a nested `node_modules` is
added, and reduction to top-most paths then keeps the tracked ancestor. The same happens for a plain
nested file such as `apps/web/.env` (WORKTREE-RESEARCH.md). Proved on a fixture:

```
fixture   pkg/index.js tracked · pkg/node_modules/ ignored · in main, an uncommitted edit to
          pkg/index.js and an untracked pkg/scratch.txt
copy      top-most path: pkg - the whole directory, with force: true
result    the new worktree's git status:   M pkg/index.js   ?? pkg/scratch.txt
          ⭐ a worktree meant to start at HEAD starts with the main checkout's unfinished work in it
```

### 18.5 A junction instead

On a fixture only; nothing here touched the real repository's `node_modules`.

```
made with Node's fs.symlink(target, path, 'junction')   no Developer Mode needed · instant · 0 bytes
git in the worktree                  "!! node_modules/" - ignored; the worktree is clean
a write into it                      lands in main's node_modules
npm install in the worktree          ⭐ npm deletes the junction ("Removing non-directory ...") and
                                     installs a private node_modules. Main's is untouched
git worktree remove, no --force      removes the worktree; main's node_modules untouched
Node fs.rm, recursive                the same
```

So a junction is shared until the worktree's first `npm install`, which privatises it. Anything that
writes into `node_modules` without npm - build caches under `node_modules/.cache` - writes into main's.
A repository that wants this can make the junctions in its own setup script (§9).

### 18.6 `npm ci` in a fresh worktree

What a setup line (§9) costs for this repository. `.npmrc` builds native modules from source for
Electron 42.

```
npm ci, in a new worktree            486 s (8 min 6 s) · exit 0 · 1601 packages
result                               56 node_modules · 6502 MB · 223112 files · 1 symlink
                                     - the same tree as main, keytar's link included
cache                                the npm cache was already warm from the main install
                                     (populated 2026-09-22). 486 s is the best case
```

### 18.7 Removing

```
git worktree remove, no --force      exit 0 for all three - ignored files do not make a worktree "dirty"
  with 6.5 GB of node_modules        114 s (the copied one) · 110 s (the npm ci one)
  a bare checkout                    7 s
⚠️ git reported success and left     npm's postinstall had made two links inside the worktree
   a directory behind                (.claude/skills, and keytar under node_modules), each pointing
                                     at another path inside the same worktree. git deleted the
                                     targets, left both links dangling, and returned 0
⚠️ deleting the rest failed once      EPERM on the worktree's directory while a shell's working
                                     directory was inside it. With the shell elsewhere, Node's fs.rm
                                     removed it; main's files unchanged (2472 -> 2472)
⚠️ W5, live: git itself failed        a worktree whose setup terminal had been parked; the delete ran
                                     while that shell was still exiting. "error: failed to delete
                                     '...': Permission denied", exit 1 - and git had already deleted
                                     the files and dropped the worktree from its list, leaving an
                                     empty directory. After WT-8.4's wait and WT-4.5's fallback: the
                                     same case, and one with the window on the worktree, both leave
                                     nothing behind, branches kept, no error
```

So removal cannot trust `git worktree remove`'s exit code alone (WT-8.5), and on Windows nothing may
still be sitting inside the directory (WT-8.4).

### 18.8 The `.worktreeinclude` query

On a fixture: `.gitignore` ignores `node_modules/`, `.env`, `*.local.json`, `secrets/`;
`.worktreeinclude` lists `.env`, `*.local.json`, `secrets/`, `!secrets/skip.txt`, `apps/web/.env`.

```
ignored     .env · app.local.json · apps/web/.env · node_modules/x/i.js · secrets/key.txt · secrets/skip.txt
matched     .env · app.local.json · apps/web/.env · secrets/key.txt · secrets/skip.txt
copied      the intersection: every matched file above. node_modules is not in it; neither is the
            untracked-but-not-ignored file, nor the tracked one
!skip.txt   not re-included - gitignore does not re-include a file under an excluded directory.
            The same rule the file's syntax promises (WT-6.2)
```

### 18.9 Listing the candidates for `.worktreeinclude`

Measured in W3, on this repository, 2026-09-24:

```
git ls-files --others --ignored --exclude-standard -z               9808 ms · 22 MB of output
  every ignored file, one by one - 223 thousand of them are node_modules
git ls-files --others --ignored --exclude-from=<include> -z         4620 ms, and it matched
  every untracked file the include patterns name, at any depth     node_modules/*/.claude/
                                                                     settings.local.json among them
git ls-files --others --ignored --exclude-standard --directory -z    418 ms · 7.6 KB
  a wholly ignored directory is one entry                           <- what WT-6.2 uses
```

§18.8's fixture still describes what is copied, with one difference: `secrets/` is a wholly ignored
directory, so it is one candidate and is copied whole.

### 18.10 Not measured

```
a Dev Drive                          there is none, and making one needs admin
cloning on ReFS                      the same
later git operations past 259 chars  §18.2
```
