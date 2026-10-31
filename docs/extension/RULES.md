# Shared rules

[Product](PRODUCT.md) sets scope. This document owns the meanings used by every feature and integration.
The owner recalibrated these contracts on 2026-10-28. They are implementation targets, not runtime certification.

| Group | Decides |
| --- | --- |
| 1 Agent messages | When Facade notifies the person |
| 2 Identity and locations | Runs and locations |
| 3 State and feedback | Status evidence, exits and error ownership |
| 4 Lifetime and access | Window ownership, YOLO and settings |
| 5 Side effects | Validation, cancellation and simple retention |

## 1 Agent messages

### 1.8 When Facade notifies the person

**An error belongs to the operation's initiator.**

| Origin | Error recipient |
| --- | --- |
| Human UI operation | Person in that operation's window |
| Known runtime/infrastructure failure requiring human handling, with no responsible agent | Person in the affected window |

Do not automatically escalate because an agent has ended, remained idle or failed to respond. Each window shows only its
own relevant notifications; no fallback to another window.

## 2 Identity and locations

### 2.2 Window, workspace and agent have different identities

**A run ID identifies one accepted launch; a workspace survives a different lifetime.**

| Identity | Meaning |
| --- | --- |
| Execution environment | Where files, CLIs and processes exist |
| Window | One current editor window; reload reconnects it; true reopening is a new window |
| Workspace | Saved editor workspace/folder context for preferences |
| Agent/run ID | One accepted launch, unique and never reassigned |

Keep the same run ID through startup, rename and reattachment of the same process. A fresh start has a new run ID.

### 2.4 Locations preserve the opened folder and execution authority

**A location is a qualified execution path associated with this window's folder or a related Git worktree.**

A plain folder is sufficient. Preserve the opened path for display and defaults; compare path components and canonical
paths in the owning environment. Nested folders use the matching workspace association; related worktrees can be outside
the folder. A successful Git read can discover worktrees made by any tool. Removing a workspace folder or actually
deleting a worktree closes the agents belonging to that removed location. A failed Git read or temporary remote
disconnect is not proof of deletion.

## 3 State and feedback

### 3.1 Process, activity and connection are separate facts

**Process lifetime, CLI activity and connection are observed independently.**

| Axis | Values |
| --- | --- |
| Internal lifecycle | starting, running, stopping, ended |
| Reachability | connected or disconnected, with last observation time |
| Activity | working, not working, unknown |
| Retained error | reason and source when known |

Internal cleanup may be stopping, but explicit close removes UI immediately. A stale observation is labeled as such
rather than treated as proof of exit.

### 3.2 The dot says only what is known

**Working is green, not working is yellow, and an error or unavailable reliable status is red.**

An unresolved error takes precedence. Without such an error, observed work/startup is green - startup lasting until the
CLI first shows its activity, within CLIS-2.3's bound - and observed not-working is yellow. Native permission/login questions are yellow unless a separate error exists. Unknown activity is an error:
use red and explain the unavailable status in the second line; there is no neutral/outline fourth state.
A quiet screen does not prove idle. A turn ending becomes yellow without a notification. Recovery clears only the
corresponding error. Reduced motion removes breathing, never the accessible state description.

### 3.3 Exit classification is independent of who caused it

**Normal CLI exit removes the pair; abnormal exit retains a red pair until closed.**

Normal means exit 0, a completed explicit stop, or a verified native exit/interrupt outcome such as the adapter's
Ctrl+C handling. An unexplained nonzero/signal exit is abnormal. Record its actual code/signal; do not guess a cause
or show an unknown-cause popup. A real known error follows 1.8's ownership. Connection loss alone proves neither exit.
Launch failure retains the accepted pair even when no CLI process was created.

### 3.4 Notifications without an attention queue

**Use native notifications, their Show action and Go to Agent; maintain no separate human-attention queue.**

Human notifications follow 1.8 and remain in the relevant window. There is no universal exactly-once-per-error popup
guarantee or durable notification claim/recovery protocol. This does not introduce repeated reminder popups. There is no
unseen/seen attention state, attention ordering or Next Agent Needing Attention command. Opening a source does not erase
its error or require a response. No turn-completion, login or permission-menu notification is generated merely from that
state transition.

## 4 Lifetime and access

### 4.1 Ownership, reload and closure

**A window owns its agents.**

Closing a window ends all its runs and removes their UI. No public editor signal tells a close from a reload, so a
window's runs end five minutes after its extension host disconnects from the execution supervisor, unless a reloaded or
reopened window of the same workspace claims them first (D75). A reload or a temporary remote disconnect - during which
the remote extension host stays connected - retains/reconnects the original runs without launching duplicates. Explicit agent closure immediately removes card and terminal; process
cleanup happens in the background, using termination when needed. No fixed UI wait or Stopping card is required. Actual
termination and uncertain remote cleanup remain distinct facts in the operation record. The five-minute timer is cleanup
policy, not proof that a person closed the window: no other timer ends a process, and true close detection remains a
platform proof obligation.

### 4.3 Permissions remain explicit

**Every launch reads the destination execution environment's current `facade.yolo` setting (default true) when the launch is accepted and keeps that value for the run.**

Changing the setting does not change existing runs. Enable the CLI's own sandbox in non-YOLO when supported.

### 4.4 Disabling optional services has bounded effects

**Launch settings affect subsequent starts.**

A disabled CLI cannot be newly started; existing processes remain (CLIS-1.1). YOLO uses 4.3's single launch-time rule. There is no
worktree-management switch: detect Git and offer creation where supported; ordinary locations remain usable without Git.

## 5 Side effects

### 5.1 Validate before changing and report actual effects

**Reject invalid arguments before mutation and report what actually happened after an accepted request.**

Accepted launches create their pair immediately. Later failure does not erase already created files or claim nothing
happened. Validate what is available before effects; CLIS-4.2 defines checks that require a newly created directory.
Facade may keep internal IDs for its own operations without turning them into a public feature.

### 5.2 Cancellation preserves completed effects

**Cancellation ends unstarted work and does not undo files or submitted input.**

Canceling a picker has no effects. Closing an accepted launch prevents later spawn; created worktrees/branches remain.
Native post-create environment preparation is not a Facade-managed job. There is no worktree-delete API or
stop-with-delete option; a person deletes a clean linked worktree only by WORKTREES-3.2's confirmed picker action,
otherwise with their usual Git tools. Facade observes actual location loss under 2.4.

### 5.3 Durable records have explicit retention and owners

**Keep simple bounded runtime records; vendor conversations are not deleted.**

Execution owners keep process facts; workspace storage keeps preferences; CLI stores own their conversations. Use simple
fixed runtime buffers and report real capacity failures rather than truncate this operation's content. No arbitrary
accumulated-operation counter may permanently disable an otherwise usable environment.

## Checks

| Rules | Acceptance |
| --- | --- |
| 1.8 | Errors to initiator in the related window only; no popup for an ended or idle agent |
| 2.2, 2.4 | Unique run IDs, remote paths, folder/worktree removal |
| 3.1–3.4 | Unknown red, idle yellow, exits, errors to initiator, no routine notices or attention queue |
| 4.1, 4.3–4.4 | Immediate close, reload/disconnect, current-setting YOLO on every launch, unchanged live runs |
| 5.1–5.3 | Invalid requests, simple cancellation/capacity |

[Verification](engineering/VERIFICATION.md) owns actual evidence; writing these rules does not certify runtime behavior.

## Change log

- 2026-10-30: 4.4 refers to CLIS-1.1's `.enabled`, now part of the extension.

- 2026-10-30: 3.2's startup lasts until the CLI first shows its activity, within CLIS-2.3's bound (D81).

- 2026-10-30: 4.1 states the owner's five-minute policy (D75) after a window's extension host disconnects, replacing the
  prohibition on timed cleanup; 4.4 notes that the disable setting joins in a later step.

- 2026-10-29: 5.2 allows WORKTREES-3.2's confirmed deletion of a clean linked worktree (D73).
- 2026-10-29: Step 1 of the Facade Code extension, carried from the Facade Dots specification: the rules step 1
  needs, each with its final number. Later steps add the others.
