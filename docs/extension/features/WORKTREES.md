# Locations and worktrees

Layer 3. Ordinary folders are the baseline; Git and worktrees are optional under PRODUCT-5.4. This document owns location
catalogs, native creation and observation of external location removal. [Rules](../RULES.md) owns identities; [Lifecycle](LIFECYCLE.md) owns launch defaults.

| Group | Decides | Implementation evidence |
| --- | --- | --- |
| 1 Location catalog | Folders, checkouts, order, refresh and optional Git | Pending |
| 2 Create and setup | Native creation, fixed destination and nonblocking native preparation | Pending |
| 3 Names and external removal | Naming/navigation, confirmed deletion of a linked worktree and observing external removal | Pending |
| 4 Technical design | Native Git integration, execution environment and command targets | Pending |

## 1 Location catalog

### 1.1 A folder works without Git

**An open workspace folder is a usable location without Git or a repository.**

Build the ordinary-folder catalog first; agents and panel do not wait for Git discovery. Missing Git/repository is
normal and does not trigger a notification or initialization suggestion. A genuine Git read failure retains known
metadata as stale and reports to its initiator, without removing agents or treating a worktree as deleted.
Git-dependent creation explains a missing prerequisite when actually requested.

### 1.2 One catalog, context-appropriate pickers

**Use one current-window catalog of folders and associated registered worktrees.**

Preserve editor folder order. In each folder's location picker, put the repository's main checkout first, then the
opened location if different, then other worktrees by display name/path. Show each physical location once. Presentation
order does not choose the launch default: LIFECYCLE-1.2 retains the remembered location or the actual opened folder.
The catalog keeps the opened location first within each folder for that fallback; the picker orders a copy for display.
An opened subfolder remains a valid launch location. A successful Resume remembers its exact cwd as a known location within the workspace or a related worktree; it becomes available in later launch choices. An unavailable cwd is never registered. Confirmed directory deletion removes that location; failed reads preserve its association. Discover
worktrees made by any tool, including legacy Facade paths; no Facade-ownership gate applies. Related worktrees outside
the folder are normal. Deduplicate physical paths while preserving workspace associations. Paginate discovery if needed;
no arbitrary catalog cutoff makes a valid known location permanently inaccessible. Labels use a display alias, then
branch, then folder name. Detached HEAD has no invented branch. Use environment and canonical paths for identity, never
branch text. Revalidate a selected location when starting; plain folders remain usable during optional Git reads.

### 1.3 Optional management and refresh

**Worktree creation is available when Git and the repository support it; there is no management switch.**

Refresh on workspace changes, relevant Git events and opening a location catalog. There is no separate Refresh command. Coalesce repeated
reads per repository; do not add idle polling. Removing a workspace folder closes agents whose location association is
removed. Confirmed external worktree deletion does the same for agents there. Deletion is confirmed only when a
successful Git read no longer lists the worktree, or lists it as prunable, and its root path does not exist. A failed
read, permission error or timeout only makes the metadata stale; neither it nor a disconnected remote host establishes
deletion.

## 2 Create and setup

### 2.1 Explicit creation

**New Agent and the view's New Worktree... menu create worktrees through native Git.**

In New Agent's Change Working Location flow, the person selects a source and enters a branch. The base is the selected
source checkout's HEAD. A source inside a checkout uses that checkout's branch in every `from` label, rather than the
subfolder's name; a detached checkout uses `HEAD`. The main checkout is not substituted for a selected linked worktree.
Show proposed branch/base and destination before
acceptance. Uncommitted edits are not automatically copied as a checkout snapshot. Use the native Git flow's branch
validation and configured branch prefix. Unknown repository/commit fails rather than initializing Git. Cancel before
acceptance has no effect. In New Agent, choosing the CLI accepts creation and opens the card/terminal immediately;
errors belong to that launch's initiator.

The standalone view-menu flow selects a workspace folder when needed and uses that repository's main checkout,
falling back to its first checkout when there is no main checkout. It asks for a branch, then shows branch, base and
destination before Create Worktree; Change Base... permits an explicit commit, branch or tag. Cancel creates nothing.
It creates no agent and does not change successful-launch history. The Command Palette does not expose this entry.
Its branch input uses LIFECYCLE-1.3's placeholder and source prompt, including an explicit base when one was chosen.

Both entries preview a valid plan as `{displayPath} (base: {sourceRef})`. Display paths have a 40-grapheme budget:
first use `~` for the home directory on macOS/Linux, then elide intermediate directories, then shorten long directory
names in the middle while retaining their beginning and end. Windows keeps its path syntax and root indication.
Only display text is shortened; creation and copying always use the complete absolute destination. A native Copy Path
button has tooltip `Copy Path ({fullPath})` and only copies the complete destination. It is available only for the
current validated input; editing, checking, invalid input and cancellation remove access to an earlier plan's path.
The standalone confirmation page offers the same button without adding another confirmation step.

For an implicit default HEAD, show the known source branch, or `HEAD` when detached. An explicit branch, tag, commit or
`HEAD` retains its actual ref text, even when it resolves to the same commit as another ref. Initial and validated
prompts follow this same source-label rule. A display label does not change the resolved creation commit.

The standalone confirmation placeholder is `Confirm worktree details or change base`; its Create Worktree item keeps
the full destination as description and uses `Branch {branch} · Base: {base} ({shortCommit})` as detail.
Change Base... describes `Commit, branch, or tag to start from`. Its input uses
`Commit, branch, or tag (e.g. HEAD)`, prompt `Base ref for {branch}`, and required-value message
`Enter a commit, branch, or tag.`

### 2.2 Destination and creation effects

**New worktrees use the fixed sibling location `<main-folder>.worktrees/<branch-folder>`.**

Translate branch separators and unsupported filename characters to a usable folder name, applying git.branchPrefix
consistently; an occupied path uses the next free numeric suffix. Never overwrite an unrelated directory.
Creation retains an exact destination/branch result from Git. Report actual partial creation on failure; keep files
and branches already created rather than inventing rollback. A successfully created worktree becomes a location
without automatically opening another window or adding a workspace folder. Native Git owns its creation mechanics.

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
The retired global Rename Working Location, Open Working Location in New Window, Copy Path, Reveal and Open Terminal
Here commands are not exposed. The person uses the editor's ordinary file, terminal and navigation controls. Reviews,
merge/commit/push and worktree deletion other than 3.2's also belong to ordinary editor/Git tools.

### 3.2 Deleting a linked worktree

**A person deletes a linked worktree only from Change Working Location, after confirming; Facade never deletes changes Git has not committed.**

Only a registered linked worktree is offered: not the main checkout, a plain folder, a location a workspace folder
opened, or one a workspace folder is in. LIFECYCLE-1.3 owns the confirmation. Facade then revalidates it with Git. Where
`git status --porcelain` in it lists anything - a change that is not committed or an untracked file - or a file Git is told
to assume unchanged or to skip differs from its index, it refuses with nothing touched:
`Cannot delete worktree "{0}": uncommitted changes present. Commit or stash them with Git, then try again.`
A worktree Git lists as locked is refused the same way, before any agent closes:
`Cannot delete worktree "{0}": worktree is locked. Unlock it with Git, then try again.` So is one another registered
worktree is inside, which Git would remove with it, whatever that one holds:
`Cannot delete worktree "{0}": worktree "{1}" is inside it. Delete or move that worktree first, then try again.`
Otherwise it takes the worktree out of the catalog, so that no launch goes there meanwhile, closes the agents whose launch
location is that worktree by the normal close (LIFECYCLE-3.1) and waits for their processes to end. Where one cannot be
confirmed ended it deletes nothing: `Cannot delete worktree "{0}": an agent's process in it could not be confirmed to have
ended. Try again once it has.` It then checks for changes again - what the agents wrote as they ended - refusing as above,
and runs `git worktree remove <path>` without `--force`, with 4.1's Git and execution environment; the branch is kept. Git's
own refusal is reported as `Could not delete worktree "{0}": {1}` and nothing is retried. The catalog is then read
again, which confirms the deletion under 1.3 (3.3). There is no deletion command or agent API, no stop-and-delete,
branch deletion, `--force`, discard flow or recursive removal by Facade. Stopping an agent does not delete its directory
or branch (D73).

### 3.3 Observe external removal

**Actual removal of a folder/worktree closes its associated agents.**

On workspace-folder removal, close agents associated with that removed location set. On confirmed external worktree
deletion under 1.3, close the agents whose launch location belongs to that worktree. Associate agents with a removed
location by their launch location, never by scanning process working directories. Remove their card/terminal
immediately and clean up owned processes in the background. Do not leave a live card whose working location no longer exists.
Do not equate temporary remote loss, failed Git reads or stale registration with proven deletion. Do not automatically
remove workspace roots, close editor windows or repair another tool's Git operation.

## 4 Technical design

### 4.1 One service in the owning environment

**One location service in the execution environment supplies human flows.**

The native creation interface is the VS Code Git extension API's repository worktree creation, feature-detected in
each supported editor. Where the editor does not supply it, worktree creation reports unavailable with its reason and
ordinary locations remain usable. Read-only discovery may use existing Git metadata and direct Git calls. Respect
resource-scoped git.path and execution environment.
Do not add an independent Facade setup subsystem to fill a native integration gap; Facade's one deletion is 3.2's.
Public API feasibility remains evidence to establish, not a claim already proved by this specification.

### 4.2 Git operations and recovery

**Git results preserve actual paths and effects and never change a local operation into a remote one.**

Use executable/argument arrays for needed direct reads; avoid shell interpolation. Classify missing Git separately
from a failed repository read and retain the actual diagnostic. Keep simple serialization for concurrent creates
using the same destination. Unknown results remain unknown; do not redo creation solely because a reply was lost.
No destructive rollback, hard reset, force push or recursive deletion belongs to Facade worktree management; its one
deletion is 3.2's. Background cleanup of an agent does not wait for native post-create preparation.

### 4.3 Creation entry boundary

**The standalone worktree command belongs to the view menu and targets current-window locations.**

`facade.newWorktree` is registered for the view's `…` menu and explicitly hidden from the Command Palette. With no
arguments - nothing, `null`, or the `{preserveFocus: boolean}` alone that the editor adds when a menu item is clicked
with the mouse - it opens 2.1's native picker flow. Its existing structured arguments are
`{location_id: string, branch: string, base_ref?: string}`; invalid arguments fail without guessing. The result identifies
the created location, destination and branch; failures report actual retained effects without claiming subsequent
environment setup completed. New Agent's contextual creation keeps its launch service under LIFECYCLE-1.3 and 4.1.
Retired location commands have no hidden registrations. There is no delete command. Existing locations remain usable
without requesting a new worktree.

Both creation entries use the same reference input in `ui/pickers/location.ts`: branch-prefix lookup, required-value
messages, asynchronous planning, validated-plan reuse and Back/Escape handling. The standalone base-edit step uses the
same planner. The preview formatter and Copy Path action are shared too. Each entry owns its surrounding steps and
final creation acceptance.

## Checks

| Rules | Acceptance |
| --- | --- |
| 1.1–1.3 | No Git, failed Git, mixed folders, main checkout first in the picker with the opened/default location preserved, external worktrees |
| 2.1–2.5 | Native creation, selected source, fixed destination, no Git initialization, launch without setup barrier, close during creation |
| 3.1–3.3 | Qualified location labels, no retired global location commands, deletion only of a confirmed clean linked worktree without `--force`, external removal closes, disconnection is not deletion |
| 4.1–4.3 | Native API evidence, local/remote paths, partial creation, view-menu registration with Command Palette exclusion, and structured argument validation |

Evidence: [Verification](../engineering/VERIFICATION.md). Git tests use disposable repositories.

## Change log

- 2026-10-31: Resume and linked Pin/Unpin extend the current step; 134 rules.

- 2026-10-31: 3.2 keeps work Git would delete with a worktree, found by the night verification: a worktree another one is
  inside is refused, as is an edit to a file Git assumes unchanged or skips; the worktree is out of the catalog while it is
  deleted; an agent whose process cannot be confirmed ended keeps it; and changes are checked again after its agents close.
- 2026-10-31: 4.3 takes a mouse click's `{preserveFocus}`, which the editor gives a menu command, as no arguments.

- 2026-10-30: Apply the three-reviewer approved IA wording for status, location actions and failure feedback; behavior and deletion safeguards remain unchanged.

- 2026-10-29: Applied the owner-approved IA-04/05 review: one compact preview, truthful source labels, current-plan
  Copy Path buttons, standalone confirmation/base copy, and shared structured reporting of confirmed creation effects.

- 2026-10-29: At the owner's request, share worktree reference input and validation between both creation entries;
  the standalone branch prompt follows LIFECYCLE-1.3. Their different creation acceptance points remain unchanged.

- 2026-10-29: Corrected the earlier removal scope after the owner's clarification: restore New Worktree... in the
  view's `…` menu and its existing creation flow, while explicitly hiding its Command Palette entry.

- 2026-10-29: Owner-approved: location pickers show the main checkout first without changing launch defaults or the
  selected creation source. New Worktree labels name the source checkout's branch, including when a subfolder is selected.

- 2026-10-29: The owner removes standalone New Worktree... and its command schema; Git owns that entry. Creation
  within New Agent remains unchanged, including cancellation, native Git execution and reporting actual effects.

- 2026-10-29: IA-01 removes the retired global location and Refresh commands and their argument contracts. Native
  editor navigation, automatic catalog refresh and the existing worktree creation/deletion flows remain their owners.

- 2026-10-29: 3.2 lets a person delete a clean, unlocked linked worktree (D73); 3.1, 4.1, 4.2 and Checks follow.
- 2026-10-29: Step 1 of the Facade Code extension, carried from the Facade Dots specification: the rules step 1
  needs, each with its final number. Later steps add the others.
