# Experience

Read this after [Product](PRODUCT.md). It walks the whole product from a person's perspective. Exact shared semantics
live in [Rules](RULES.md); feature specifications own controls and values. The journeys below are normative scenarios,
not evidence that today's code passes. All runtime checks remain to be executed.

| Group | Decides | Implementation evidence |
| --- | --- | --- |
| 1 Starting the first agent | The common path and its failures | Unverified |
| 2 Following an agent's work | Status, direct access and ending | Unverified |
| 3 Working with other agents | Agent launches, discovery, messages and results | Unverified |
| 4 Completing the work | Both complete journeys, changes of direction and optional features | Unverified |

## 1 Starting the first agent

### 1.1 A common entry

**New Agent is the same entry for a person directing agents and a person asking an agent to organize work.**

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
its own location. Canceling a picker or an agent-created launch does not change the human default. Details and
missing-location fallback belong to
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

The card and terminal identify one launch throughout setup and startup. A human launch comes to the front; an
agent-created launch appears in the background. Progress is shown in the existing surfaces.

### 1.7 Startup outcomes and collaboration availability

**A failed accepted launch retains its card and terminal; a usable CLI remains available if its Facade tools fail.**

The second line explains the actual error. Operation errors go to the initiator: human UI errors to that window's person,
agent operation errors to that agent, with no extra human popup. Closing the retained pair removes it immediately.
Native Git post-create preparation does not gate CLI startup once the worktree exists and Git recognizes it.

## 2 Following an agent's work

### 2.1 Observing work and continuing in the terminal

**The panel shows this window's agents; each editor terminal remains directly usable by the person.**

Starting or working is green, reliable idle is grey, native permission/answer/sign-in blockers are yellow, and errors or
unavailable reliable activity are red. The second line names a blocker or error; absence of reliable status is never
shown as idle. A turn ending becomes grey without a notification or a claim that the task is complete.
Clicking a card opens that same terminal. Human search and management stay within the current window.

### 2.2 Only errors and explicit calls to the person notify

**Only relevant human-operation errors and explicit calls to the person produce human notifications.**

Agent-operation errors return to the calling agent. Agent-to-agent delivery, replies and system-result handoff never
automatically fall back to a person; if no agent can receive an error, the report ends. Native runtime failures follow
RULES-1.8. No startup, idle, turn-end, permission or login news is announced. Each window shows only its own notifications.

### 2.3 A turn ends, a process exits, or the person closes an agent

**A turn end leaves the CLI available; normal process exit removes it; abnormal exit retains a red pair until closed.**

Unknown abnormal-exit cause has no guessed popup. Known errors follow the initiator/relevant-window rule. Explicit close
removes card and terminal immediately and cleans up the owned process in the background. It does not delete a worktree
or close the agents it started. There is no visible Stopping wait.

### 2.4 Reloading, closing and reconnecting

**Reload reconnects existing runs; closing a window ends that window's agents.**

Temporary remote loss retains observations and reconciles the original processes. A closed window's agents end five
minutes after it goes unless the workspace is opened again first, which shows them again (RULES-4.1). Other windows
continue their work. Pending messages to ended runs fail to their agent senders where reachable and are never replayed
on reopening. If only the sender closes, delivery already executing elsewhere may finish; work left at the closing side
may end. No extra handover machinery guarantees that edge case. System results that cannot return simply end.

## 3 Working with other agents

### 3.1 From one agent to collaboration

**The user supplies the instructions; Facade supplies the operations.**

The person may open several CLIs and direct them, or give one a prompt/skill that asks it to use others. No automatic
manager, judge, team hierarchy or “all work done” state is imposed.

### 3.2 An agent starts another agent

**An agent supplies a name, destination window, working location and CLI; model and effort can use CLI defaults.**

A child joins its creator's creation tree and uses RULES-4.3's launch-time YOLO rule. The API cannot choose YOLO.
It may request a new worktree as part of startup. A new child can be placed in another valid window on this computer,
local or remote, even when that window has no agents; a window without a folder has no working location.
An optional prompt follows COLLABORATION-2.2's native/post-start path. Process startup and prompt submission have
separate results; a pending prompt later reports its final outcome under MCP-2.3. Facade has no task concept or
automatic child report. Explicit model/effort in this call takes precedence under CLIS-1.4.

### 3.3 Discovering launch choices

**Agents can query open windows, valid locations and available CLIs before starting an agent.**

The catalog includes installed CLIs in the destination environment and previously successful model/effort choices.
Unknown choices are labeled unknown; omitting model/effort leaves the CLI's native defaults in control under CLIS-1.4.
No side effect or reservation occurs during discovery. Existing-agent queries and operations obey the caller's
YOLO/creation-tree scope.

### 3.4 Sending a message and receiving a reply

**Sending succeeds when the other agent has the complete message under RULES-1.3, without waiting for its answer.**

The first call returns success, failure, or accepted for bounded delivery. An accepted send later returns a system
result to its sender, whether the message was delivered or not. The recipient's reply is a separate message.
[RULES-1](RULES.md#1-agent-messages) owns the complete flow; [MCP](engineering/MCP.md) owns the schema.

### 3.5 When an ordinary message reaches the CLI

**Ordinary messages attempt usable draft-free input even while the target works; direct input deliberately has no draft guard.**

A draft, menu or unrecognized input box causes the fixed finite retries; Facade never types a message into an input it
cannot read, whatever the CLI's version. No typing-idle timer or extra protection for human typing that starts after
the check. At-least-once attempts may repeat an uncertain submission with the same message ID; the injected skill tells
the model how to recognize that repeat. Report actual partial or unknown effects if delivery fails. A message the
recipient instead reads with read_messages counts as delivered and is not pasted again. Direct text/keys execute what
the caller requests without a policy parameter or text-format/length restriction.

### 3.6 Returning the final result and involving the person

**Return the result to the agent that initiated the operation; an unreachable return path ends without notifying a person.**

A system receipt is not B's own reply and does not generate another failure message for B. If B independently replies
to a closed A, that send reports the error to B. If B also cannot receive it, drop the report. The original delivery
outcome remains unchanged. Only an agent's explicit decision to contact the person uses `#human`, which shows a
notification in that agent's window.

### 2.5 Resume and Pin

**Resume continues an exact saved conversation; Pin brings it back when this workspace opens again.**

Resume lists relevant vendor histories with the original CLI and location. Pin and the native terminal tab's Pin are
the same intent. Unpin keeps the current agent running. Explicit close and normal exit Unpin; abnormal exit and
whole-window close preserve the intent. RULES-4.2 and LIFECYCLE-3.2–3.4 own restoration and capability limits.

## 4 Completing the work

### 4.1 Both ways are followed through to the result

**Both ways of working cover starting, doing, inspecting, changing direction and ending.**

| Step | Super Engineer example | Super Team example | Facade's responsibility |
| --- | --- | --- | --- |
| Begin | Person starts two agents in chosen folders | Person starts one agent and supplies a prompt/skill | Launch and expose terminals |
| Divide work | Person assigns work directly | Agent queries choices and starts another under the launch rules | Validated creation; background visibility |
| Coordinate | Person asks agents to communicate | Agents exchange messages and inspect screens | Delivery, effects and failures |
| Intervene | Person opens a terminal and corrects instructions | Person opens any worker and redirects it | Direct access; no creator gate |
| Check results | Person reviews files, tests and replies | User's skill decides who reviews | No inferred acceptance from a dot or reply |
| Integrate | Usual editor/Git tools, or ordinary files without Git | Agents integrate only as instructed | Optional worktree tools, no auto-merge |
| End | Close agents; delete a clean linked worktree in Change Working Location or with Git | Agents stop selected runs as instructed | Independent lifetimes; immediate UI close and background cleanup |

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
with no enable/disable setting and no initialization wizard. Panel filters affect display only: every created agent
enters the normal panel data, and a filtered-out creation does not clear the person's filter.
Creation trees do not group the list or imply a team workflow.

## Checks

| Rules | Acceptance |
| --- | --- |
| 1.1–1.7 | Walk first use, last location, location change, no Git, no CLI, cancel, immediate surfaces and both startup failures |
| 2.1–2.3 | Observe actual activity, errors, native CLI prompts, normal exit, unknown abnormal exit and explicit closure |
| 2.4 | Reload, disconnect, true close/reopen, pending messages to ended runs |
| 3.1–3.6 | Two-way cross-window and local/remote operations; explicit launch choices; all initial/final message outcomes |
| 4.1–4.3 | Walk both complete journeys including review, redirected work, cleanup, multi-folder and plain-folder use |

Evidence is recorded in [Verification](engineering/VERIFICATION.md); these scenarios have not been run by this rewrite.

## Change log

- 2026-11-01: 2.1 follows the owner's four dot meanings and separates idle from a native blocker (D127).
- 2026-10-31: Added the owner-authorized Resume and linked Pin/Unpin step, using Facade Dots as the reference.

- 2026-10-30: 4.3 says a panel filter affects display only (PANEL-2.3).
- 2026-10-30: Step 2 of the Facade Code extension: group 3 and 4.1 carry the Facade Dots collaboration journeys across
  this computer's windows, without Resume, Pin or filters; 3.4–3.6 follow the owner's decisions of that day: a read
  message is delivered (D88), every CLI version is attempted (D89) and the person is `#human` (D91).

- 2026-10-30: 2.4 says when a closed window's agents end under the owner's five-minute policy (D75).

- 2026-10-29: Owner-approved IA-03: the editable name is a label and may be an empty string (LIFECYCLE-2.1).

- 2026-10-29: 4.2 says Facade deletes only a clean linked worktree the person confirms (D73).
- 2026-10-29: Step 1 of the Facade Code extension, carried from the Facade Dots specification: the rules step 1
  needs, each with its final number. Later steps add the others.
