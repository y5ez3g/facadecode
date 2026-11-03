# Locations and worktrees

Layer 3. Ordinary folders are the baseline; Git and worktrees are optional under PRODUCT-5.4. This document owns location
catalogs, native creation, the confirmed deletion of a linked worktree and observation of external location removal.
[Rules](../RULES.md) owns identities; [Lifecycle](LIFECYCLE.md) owns launch defaults.

| Group | Decides |
| --- | --- |
| 1 Location catalog | Folders, checkouts, order, refresh and optional Git |
| 2 Create and setup | Native creation, fixed destination and nonblocking native preparation |
| 3 Names and external removal | Naming/navigation, confirmed deletion of a linked worktree and observing external removal |
| 4 Technical design | Native Git integration, execution environment and command targets |

## 1 Location catalog

### 1.1 A folder works without Git

**An open workspace folder is a usable location without Git or a repository.**

Build the ordinary-folder catalog first; agents and panel do not wait for Git discovery. Missing Git/repository is
normal and does not trigger a notification or initialization suggestion. A genuine Git read failure keeps known
metadata as stale and is written to the agents log (ARCHITECTURE-3.3), without a notification, without removing agents
and without treating a worktree as deleted. A requested creation or deletion reports its own Git failure to its
initiator (RULES-1.8); Git-dependent creation explains a missing prerequisite when actually requested.

### 1.2 One catalog, context-appropriate pickers

**Use one current-window catalog of folders and associated registered worktrees.**

Preserve editor folder order. In each folder's location picker, put the repository's main checkout first, then the
opened location if different, then other worktrees by display name/path. Show each physical location once. Presentation
order does not choose the launch default: LIFECYCLE-1.2 retains the remembered location or the actual opened folder.
The catalog keeps the opened location first within each folder for that fallback; the picker orders a copy for display.
An opened subfolder remains a valid launch location. A successful Resume remembers its exact cwd as a known location
within the workspace or a related worktree; it becomes available in later launch choices, after the folder's worktrees.
An unavailable cwd is never registered. Confirmed deletion of its directory removes that location (3.3); failed reads
preserve its association. Discover worktrees made by any tool; no Facade-ownership gate applies. Related worktrees
outside the folder are normal. Deduplicate physical paths while preserving workspace associations. Paginate discovery
if needed; no arbitrary catalog cutoff makes a valid known location permanently inaccessible. A checkout's root is
labeled by its branch, else by its folder name; an opened subfolder and a remembered Resume cwd are labeled by their
folder names. Detached HEAD has no invented branch. Use environment and canonical paths for identity, never branch text.
Revalidate a selected location when starting; plain folders remain usable during optional Git reads. New Agent and MCP
discovery (MCP-3.1) read this same catalog.

### 1.3 Optional management and refresh

**Worktree creation is available when Git and the repository support it; there is no management switch.**

Refresh automatically on workspace changes, on relevant Git events - a worktree registered, removed or moved, a HEAD
changing - on opening a location catalog and after a creation or deletion. Coalesce repeated reads per repository; do
not add idle polling. Removing a workspace folder closes agents whose location association is removed. Confirmed
external worktree deletion does the same for agents there. Deletion is confirmed only when a successful Git read does not
list the worktree, or lists it as prunable, and its root path does not exist. A failed read, permission error or timeout
only makes the metadata stale; neither it nor a disconnected remote host establishes deletion.

## 2 Create and setup

### 2.1 Explicit creation

**New Agent and the view's New Worktree... menu create worktrees through native Git.**

In New Agent's Change Working Location flow, the person enters a branch for a new worktree of the chosen folder. Its
source is the current location where that is one of the folder's checkouts - a remembered Resume subfolder counting as
the checkout it is in - else the location the folder opened; another worktree becomes the source by choosing it first.
The base is the source checkout's HEAD. A source inside a checkout uses that checkout's branch in every `from` label,
rather than the subfolder's name; a detached checkout uses `HEAD`. The main checkout is not substituted for a selected
linked worktree. Show proposed branch/base and destination before acceptance. Uncommitted edits are not automatically
copied as a checkout snapshot. Use the native Git flow's branch validation and configured branch prefix. Unknown
repository/commit fails rather than initializing Git. Cancel before acceptance has no effect. In New Agent, choosing the
CLI accepts creation and opens the card/terminal immediately; errors belong to that launch's initiator.

The standalone view-menu flow selects a workspace folder when needed, titled `New Worktree · Select Folder`; that step is
LIFECYCLE-1.3's folder step, with Add Folder to Workspace... and folder removal. Its source is the checkout containing
that selected folder, including an opened linked worktree or a checkout subfolder; never substitute the repository's
main checkout. An unavailable source reports the prerequisite rather than guessing another checkout, in a notification:
`New Worktree is unavailable: {0}` with the reason, or
`New Worktree requires a working location in a Git repository with at least one commit.` where there is no folder or
location to start from. The branch input is titled `New Worktree` and uses LIFECYCLE-1.3's placeholder and source
prompt. Accepting a valid branch name immediately creates from that source's HEAD. Checking the source and creating
show the view's progress (UX-1.1). Typing, checking and cancellation before acceptance create nothing. Standalone
creation creates no agent and does not change successful-launch history. The Command Palette does not expose this
entry. Other starting refs are prepared through ordinary Git tools; 1.2 discovers their worktrees.

Both human entries preview a valid plan in the branch input as `{displayPath} (base: {sourceRef})`. Display paths have
a 40-grapheme budget: first use `~` for the home directory on macOS/Linux, then elide intermediate directories, then
shorten long directory names in the middle while retaining their beginning and end. Windows keeps its path syntax
and root indication. Only display text is shortened; creation and copying always use the complete absolute destination.
A native Copy Path button has tooltip `Copy Path ({fullPath})` and only copies the complete destination; a copy that
fails says `Could not copy path: {0}`. It is available only for the current validated input; editing, checking, invalid
input and cancellation remove access to a previous plan's path. For the default HEAD, show the known source branch, or
`HEAD` when detached. A display label does not change the resolved creation commit. Uncommitted edits are not copied as
a checkout snapshot.

Agent creation supplies its location, branch and base_ref through start_agent (MCP-2.2); there is no separate
create-worktree MCP tool. The structured command in 4.3 also takes an explicit base_ref. The human entries always start
from the source's HEAD; these two programmatic entries keep their base_ref.

### 2.2 Destination and creation effects

**New worktrees use the fixed sibling location `<main-folder>.worktrees/<branch-folder>`.**

The branch folder is the branch without a leading `git.branchPrefix`, with each `/`, `\`, `<`, `>`, `:`, `"`, `|`, `?`,
`*` and control character replaced by `-` on every system, so one branch gives one folder name everywhere. An occupied
path, whether a file, folder, link or registered worktree, takes the next free numeric suffix (`-1`, `-2` and so on).
Never overwrite an unrelated directory. A branch whose folder name some system cannot hold - empty, `.` or `..`, ending
in a period or space, or a Windows device name such as `CON` or `LPT1` - is refused on every system. A bare repository's
worktrees go beside its Git directory. Creation retains an exact destination/branch result from Git. Report actual
partial creation on failure; keep files and branches already created rather than inventing rollback. A successfully
created worktree becomes a location without automatically opening another window or adding a workspace folder. Native
Git owns its creation mechanics.

Failures use `Could not start {name}: {reason}.` for New Agent and `Could not create worktree: {reason}.` for standalone
creation. A shared presentation appends only confirmed effects: `Branch {branch} was created and kept.`,
`Folder {folder} was created and kept.`, or `Branch {branch} and folder {folder} were created and kept.`
No known creation adds no suffix; it does not assert rollback or absence of effects. A successful worktree creation
followed by CLI planning or startup failure retains both facts. Failed agent records persist these facts as structured
data so notifications and retained error cards use the same wording, including after reload.

### 2.3 No repository initialization

**Facade does not initialize Git repositories or create initial commits.**

No initialization button, modal, onboarding advice or hidden startup fallback is provided. Missing Git, repository or
commit is only the actual prerequisite error for the requested Git operation. Ordinary agents in the folder remain
available. Users or agents prepare repositories using their own tools and workflow.

Human diagnostics use `{path} has no commits yet.` and `{path} is not in a Git repository.`, with home-relative paths
where supported. An unavailable New Worktree... item shows its reason in the second-line detail and refuses
confirmation; the native picker does not promise a per-item disabled/greyed style.

### 2.4 Copy, link and tasks

**Native post-create copying, links and environment preparation do not gate Facade CLI startup.**

Use the selected source checkout and the editor's existing worktree preparation configuration where supported.
Facade starts the CLI once the directory exists and Git recognizes the new worktree. It does not wait for subsequent
copy/link/worktreeCreated work to finish, enforce its success, track its jobs or rerun it.
This accepts that the CLI can start before the environment is fully prepared. Such preparation belongs to the existing
Git/editor workflow, not a new Facade task or orchestration concept. Do not implement a parallel copy-pattern engine
or preparation-completion protocol to improve this edge case.

### 2.5 Close during creation

**Closing a launch removes its UI immediately and prevents its later CLI spawn, without deleting the worktree.**

If native creation already made a directory/branch, leave it. If a native operation finishes after the launch was
closed, do not start the canceled CLI. Do not adopt, cancel or reconcile native setup jobs as Facade-managed tasks.

## 3 Names and external removal

### 3.1 Names and navigation

**Human location labels and navigation use this window's actual locations and their original environment.**

Location labels follow 1.2 and preserve qualified location identity; labels do not change Git branches or paths.
Facade adds no other location commands (UX-3.1): the person uses the editor's ordinary file, terminal and navigation
controls. Reviews, merge/commit/push and worktree deletion other than 3.2's also belong to ordinary editor/Git tools.

### 3.2 Deleting a linked worktree

**A person deletes a linked worktree only from Change Working Location, after confirming; Facade never deletes changes Git has not committed.**

Only a registered linked worktree is offered: not the main checkout, a plain folder, a location a workspace folder
opened, or one a workspace folder is in. LIFECYCLE-1.3 owns the confirmation. Facade then revalidates it with Git; one
that is not such a worktree now is refused:
`Cannot delete "{0}": only a linked worktree with no workspace folder in it can be deleted.`
Where `git status --porcelain` in it lists anything - a change that is not committed or an untracked file - or a file
Git is told to assume unchanged or to skip differs from its index, it refuses with nothing touched:
`Cannot delete worktree "{0}": uncommitted changes present. Commit or stash them with Git, then try again.`
A worktree Git lists as locked is refused the same way, before any agent closes:
`Cannot delete worktree "{0}": worktree is locked. Unlock it with Git, then try again.` So is one another registered
worktree is inside, which Git would remove with it, whatever that one holds:
`Cannot delete worktree "{0}": worktree "{1}" is inside it. Delete or move that worktree first, then try again.`
On Windows with a Git older than 2.54, which deletes through an NTFS junction or a link to a folder rather than the link
alone, a worktree that contains such a link is refused the same way, before any agent closes and again after they end:
`Cannot delete worktree "{0}": it contains a link to another folder ({1}), which this version of Git would delete through.
Remove the link, or update Git to 2.54 or later, then try again.`
Otherwise it takes the worktree and every location inside it out of the catalog, so that no launch or Resume goes there
meanwhile, closes the agents whose launch location is that worktree or a location inside it, such as a resumed
conversation's subfolder, by the normal close (LIFECYCLE-3.1) and waits for their processes to end. Where one cannot be
confirmed ended it deletes nothing:
`Cannot delete worktree "{0}": could not confirm that an agent process in it has ended. Try again once it has.`
It then checks for changes again - what the agents wrote as they ended - refusing as above, and runs
`git worktree remove <path>` without `--force`, with 4.1's Git and execution environment; the branch is kept. Git's own
refusal is reported as `Could not delete worktree "{0}": {1}` and nothing is retried. Where Git succeeds but leaves the
folder - newer Git leaves a link inside it in place - Facade says
`Deleted worktree "{0}", but folder {1} was left behind.` and deletes nothing itself. The catalog is then read again,
which confirms the deletion under 1.3 (3.3). There is no deletion command, MCP tool or other agent API, no
stop-and-delete, branch deletion, `--force`, discard flow or recursive removal by Facade. Stopping an agent does not
delete its directory or branch.

### 3.3 Observe external removal

**Actual removal of a folder/worktree closes its associated agents.**

On workspace-folder removal, close agents associated with that removed location set. On confirmed external worktree
deletion under 1.3, close the agents whose launch location belongs to that worktree. A location 1.2 remembered from a
Resume whose directory a refresh finds missing - not merely unreadable - is removed the same way, closing its agents.
Associate agents with a removed location by their launch location, never by scanning process working directories.
Remove their card/terminal immediately, Unpin them (RULES-4.2) and clean up owned processes in the background. Do not
leave a live card whose working location is gone. Do not equate temporary remote loss, failed Git reads or stale
registration with proven deletion. Do not automatically remove workspace roots, close editor windows or repair
another tool's Git operation.

## 4 Technical design

### 4.1 One service in the owning environment

**One location service in the execution environment supplies human flows and MCP startup.**

The native creation interface is the VS Code Git extension API's repository worktree creation, feature-detected in
each supported editor; where that extension has not opened the source's repository, Facade asks it to. Where the editor
does not supply it, worktree creation reports unavailable with its reason and ordinary locations remain usable.
Read-only discovery may use existing Git metadata and direct Git calls. Respect resource-scoped git.path and execution
environment. Do not add an independent Facade setup subsystem to fill a native integration gap; Facade's one deletion
is 3.2's.

### 4.2 Git operations and recovery

**Git results preserve actual paths and effects and never change a local operation into a remote one.**

Use executable/argument arrays for needed direct reads; avoid shell interpolation. Classify missing Git separately
from a failed repository read and retain the actual diagnostic. Every Git call runs without the variables that point
Git at another repository (`GIT_DIR`, `GIT_WORK_TREE` and the like) or at a prompt program (`GIT_ASK_YESNO`), with
`GIT_OPTIONAL_LOCKS=0` and English messages (`LC_ALL=en_US.UTF-8`), so Git's own words reach the person in English. A
Git read times out after 10 s, which leaves its metadata stale. Creations into one `<main-folder>.worktrees` folder run
one at a time across the environment's windows; a creation waits up to 120 s for another window's, then fails. Unknown
results remain unknown; do not redo creation solely because a reply was lost. No destructive rollback, hard reset,
force push or recursive deletion belongs to Facade worktree management; its one deletion is 3.2's, which may take
300 s and on Windows runs with long paths enabled (`-c core.longpaths=true`), as a deep folder otherwise fails
partway. Background cleanup of an agent does not wait for native post-create preparation.

### 4.3 Creation entry boundary

**The standalone worktree command belongs to the view menu and targets current-window locations; agent creation uses MCP-2.2.**

`facade.newWorktree` is registered for the view's `…` menu and explicitly hidden from the Command Palette. With no
arguments - nothing, `null`, or the `{preserveFocus: boolean}` alone that the editor adds when a menu item is clicked
with the mouse - it opens 2.1's native picker flow. Its structured arguments are
`{location_id: string, branch: string, base_ref?: string}`; invalid arguments fail without guessing. The result identifies
the created location, destination and branch; failures report actual retained effects without claiming subsequent
environment setup completed. New Agent's contextual creation keeps its launch service under LIFECYCLE-1.3 and 4.1.
There is no delete command. Existing locations remain usable without requesting a new worktree.

Both human creation entries use the same branch input in `ui/pickers/location.ts`: branch-prefix lookup, required-value
messages, asynchronous HEAD planning, validated-plan reuse and Back/Escape handling. The preview formatter and Copy Path
action are shared too. Each entry owns its surrounding steps and final creation acceptance.

## Checks

| Rules | Acceptance |
| --- | --- |
| 1.1–1.3 | No Git, failed Git, mixed folders, main checkout first in the picker with the opened/default location preserved, external worktrees, remembered Resume locations |
| 2.1–2.5 | Native creation, selected source, fixed destination, no Git initialization, launch without setup barrier, close during creation |
| 3.1–3.3 | Qualified location labels, no other location commands, deletion only of a confirmed clean linked worktree without `--force`, external removal closes, disconnection is not deletion |
| 4.1–4.3 | Native API evidence, local/remote paths, partial creation, view-menu registration with Command Palette exclusion, and structured argument validation |

Evidence: [Verification](../engineering/VERIFICATION.md). Git tests use disposable repositories.
