# Experience

Read this after [Product](PRODUCT.md). It walks the whole product from a person's perspective. Exact shared semantics
live in [Rules](RULES.md); feature specifications own controls and values. The journeys below are normative scenarios,
not evidence that today's code passes. All runtime checks remain to be executed.

| Group | Decides | Implementation evidence |
| --- | --- | --- |
| 1 Starting the first agent | The common path and its failures | Unverified |
| 2 Following an agent's work | Status, direct access and ending | Unverified |
| 4 Completing the work | Changes of direction and optional features | Unverified |

## 1 Starting the first agent

### 1.1 A common entry

**New Agent is the entry for a person directing agents.**

When the panel has no agents, it briefly explains New Agent, with that action. A new VS Code user can start from that
explanation; there is no separate tutorial, team wizard or product-mode choice.

### 1.2 From starting to giving the first instruction

**The person sees the location and suggested name, chooses a CLI, and continues in its editor terminal.**

The last successfully used CLI is first and preselected; choosing it still starts only after the person's action.
Change Working Location and Change Name remain at the bottom of the same picker. A name has an editable
recommendation and may be empty, contain spaces or duplicate another name. CLI login and permissions remain in the terminal.
The current name and actual location remain visible while searching for a CLI, as specified in LIFECYCLE-1.1.
No account or CLI setup is silently performed by Facade.

### 1.3 Default working location

**Human New Agent uses the last successfully used location; first use starts with the first folder's first location.**

An opened main checkout is first; an opened worktree is first when that worktree is the folder opened. A plain folder is
its own location. Canceling a picker does not change the human default. Details and missing-location fallback belong to
[LIFECYCLE-1](features/LIFECYCLE.md#1-launch).

### 1.4 Initial exceptions

**A missing prerequisite is explained where the person can correct it without changing what they selected.**

No folder: the picker offers Open Folder. No CLI: the picker explains discovery in this environment. Missing Git does
not block either step. A removed location is reselected; no silent CLI substitution.

### 1.5 Changing the working location

**Change Working Location is an item in the same menu that shows the current location and CLI choices.**

Choose a folder, then its location/worktree when there are multiple choices, then return to CLI selection. Single-choice
steps are skipped. Back preserves selections; Escape makes no launch or worktree. Creating a worktree is an advanced
choice in this flow, with the same contract as [Worktrees](features/WORKTREES.md).

### 1.6 Seeing the agent start

**Choosing the CLI closes the menu and immediately creates the agent's card and terminal together.**

The card and terminal identify one launch throughout setup and startup. A human launch comes to the front. Progress is
shown in the existing surfaces.

### 1.7 Startup outcomes

**A failed accepted launch retains its card and terminal.**

The second line explains the actual error. Operation errors go to the initiator: human UI errors to that window's
person. Closing the retained pair removes it immediately. Native Git post-create preparation does not gate CLI startup
once the worktree exists and Git recognizes it.

## 2 Following an agent's work

### 2.1 Observing work and continuing in the terminal

**The panel shows this window's agents; each editor terminal remains directly usable by the person.**

Working is green, not working is yellow, and errors or unavailable reliable activity are red. The second line explains
an error; absence of reliable status is never a neutral fourth state. A turn ending becomes yellow without a notification.
Clicking a card opens that same terminal. Human search and management stay within the current window.

### 2.2 Only errors notify

**Only relevant human-operation errors produce human notifications.**

Native runtime failures follow RULES-1.8. No startup, idle, turn-end, permission or login news is announced. Each window
shows only its own notifications.

### 2.3 A turn ends, a process exits, or the person closes an agent

**A turn end leaves the CLI available; normal process exit removes it; abnormal exit retains a red pair until closed.**

Unknown abnormal-exit cause has no guessed popup. Known errors follow the initiator/relevant-window rule. Explicit close
removes card and terminal immediately and cleans up the owned process in the background. It does not delete a worktree.
There is no visible Stopping wait.

### 2.4 Reloading, closing and reconnecting

**Reload reconnects existing runs; closing a window ends that window's agents.**

Temporary remote loss retains observations and reconciles the original processes. A closed window's agents end five
minutes after it goes unless the workspace is opened again first, which shows them again (RULES-4.1). Other windows
continue their work.

## 4 Completing the work

### 4.2 Changing direction and partial work

**Stopping or cancellation does not undo completed input or user files.**

Canceling an unaccepted picker changes nothing. Closing an accepted launch immediately removes UI and prevents later
CLI startup; a worktree already created stays. Facade does not manage Git initialization, initial commits, or native
post-create preparation jobs; it deletes only a clean linked worktree the person confirms. External removal of a window
folder/worktree closes its affected agents.
An unconfirmed remote cleanup is not silently described as proven process exit.

### 4.3 Optional features never block the core journey

**Plain folders, optional Git and multi-folder/remote use follow the same agent flows.**

Git discovery never blocks ordinary agent use. Worktree creation is available where Git/repository prerequisites exist,
with no enable/disable setting and no initialization wizard.

## Checks

| Rules | Acceptance |
| --- | --- |
| 1.1–1.7 | Walk first use, last location, location change, no Git, no CLI, cancel, immediate surfaces and startup failure |
| 2.1–2.3 | Observe actual activity, errors, native CLI prompts, normal exit, unknown abnormal exit and explicit closure |
| 2.4 | Reload, disconnect, true close/reopen |
| 4.2–4.3 | Walk cancellation, cleanup, multi-folder and plain-folder use |

Evidence is recorded in [Verification](engineering/VERIFICATION.md); these scenarios have not been run by this rewrite.

## Change log

- 2026-10-30: 2.4 says when a closed window's agents end under the owner's five-minute policy (D75).

- 2026-10-29: Owner-approved IA-03: the editable name is a label and may be an empty string (LIFECYCLE-2.1).

- 2026-10-29: 4.2 says Facade deletes only a clean linked worktree the person confirms (D73).
- 2026-10-29: Step 1 of the Facade Code extension, carried from the Facade Dots specification: the rules step 1
  needs, each with its final number. Later steps add the others.
