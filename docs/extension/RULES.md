# Shared rules

[Facade Code](../PRODUCT.md) defines the product. Group 6 owns the Orchestrator-backed VS Code entry point.
Groups 1–5 describe the legacy implementation during the transition.

| Group | Decides |
| --- | --- |
| 1 Agent messages | Delivery, results, notifications and closure |
| 2 Identity and locations | Client network, runs, references and locations |
| 3 State and feedback | Status evidence, exits and error ownership |
| 4 Lifetime and access | Window ownership, reach, YOLO and settings |
| 5 Side effects | Validation, cancellation and simple retention |
| 6 The VS Code entry point | Workspace ownership, agents, Attach, settings and the Window Component |

## 1 Agent messages

### 1.1 One request identifies one delivery

**A send has one sender, one recipient run, complete content and one Facade-assigned message ID.**

There are no recipient arrays or aggregate sends. A caller sending to several agents calls the same tool separately.
Resolve the target once under 2.3; keep that target and message ID through internal attempts. An optional reply-to ID
expresses a relationship, not a promise of a reply. Names and conversation IDs are not substitutes for the resolved run.
A caller may give a send its own request ID: the same one again from that caller within an hour answers the message it
sent as 1.2 says, and sends nothing again. Each new send invocation without one gets a new message ID; internal
attempts for a message retain its ID. Message IDs, including their displayed aliases, are unique across the
client network and never reassigned, including after reopening or history expiry: a window that cannot take a number
from the client network's counter refuses the send rather than give a number twice (ARCHITECTURE-1.1). A request ID is
kept on its message record, not in a separate deduplication ledger. Report invalid content or an unavailable target
before writing.

### 1.2 A send answers with its outcome

**Try immediately; an ordinary message's send returns success or failure within thirty seconds of ingress.**

| Response | Meaning |
| --- | --- |
| Success | The message was delivered under 1.3. |
| Failure | Delivery was refused or could not be confirmed within the thirty seconds; report the reason and actual or uncertain input effects. |

The thirty seconds start when the complete request reaches the Facade MCP shim or equivalent direct ingress, and hold
queueing, forwarding, the paste and its confirmation. A sender's next step depends on whether its message arrived, so
its call answers that, and no Facade result follows the answer (1.7); no automatic input occurs after the original
deadline. Where read_messages delivers the message during a paste already begun, only that unchanged own draft may
finish its Enter, within the original thirty seconds (1.5). Internal
forwarding, including forwarding to another window, consumes the same allowance; do not restart it at each hop. A send to
another window's agent gives that window what remains of the thirty seconds less half a second, kept for the answer's
way back. A repeated request ID (1.1) joins the original delivery: it answers that delivery's outcome within what remains
of its thirty seconds, never renewing them, and one already ended answers its record as it stands - a later
read_messages delivery included (COLLABORATION-3.1). A sender whose call was cut before its answer - its window reloaded
meanwhile - asks again with its request ID where it gave one; without one, its outcome stays unknown to it (MCP-1.2's
`inspect_effects`). A call its caller cancels does not stop its delivery, which goes on within the same thirty seconds:
an MCP cancellation reaches no Facade window, and only a repeat with its request ID tells its outcome. Return earlier
when the result is known. A creation prompt a start sends after its process starts (COLLABORATION-2.2) is no send of the caller's: its
outcome goes into the start's own result (MCP-2.3). B's answer is a separate ordinary message.


### 1.3 Delivery means the recipient has the complete message

**A message is delivered when the target CLI accepted the complete instruction or read_messages handed the complete record to its recipient.**

For terminal delivery, a complete frame drawn after the current submission key is issued confirms that
the input emptied before any intervening edit (1.6). An unfinished redraw or a draft drawn back in
the same output leaves confirmation pending. A CLI can accept the message into its own queue. Confirm a native
interactive startup prompt through the adapter's native launch path after the process starts.
A read_messages result that is handed back to the recipient delivers every record it contains (COLLABORATION-3.1).
Busy/idle transitions or unrelated output are not evidence that this particular instruction was submitted. The adapter
reports actual effects; uncertainty remains explicit. Never truncate content and report full success.
Each message has one delivery state: being delivered, delivered, not delivered, or unconfirmed where native prompt
acceptance is unknown. Unconfirmed native input starts no automatic post-start delivery; an explicit inbox read may
deliver that same record without another paste. There is no separate fetch state.
Human notification handoff is defined separately in COLLABORATION-2.3.

### 1.4 Input protection applies to every attempt

**Ordinary messages protect existing drafts and require usable message input at each attempt.**

| Observed input | Action |
| --- | --- |
| Usable, no draft, CLI working or not working | Attempt delivery. Activity is not a gate. |
| The message's own draft, written whole by an earlier attempt | Press Enter; never type its text again (1.6). |
| Another draft present | Leave it untouched; wait for it to go (1.5). |
| Menu, login, permission interaction or unusable input box | Do not type a message into it; wait for it to close (1.5). |
| Draft/input state unknown, including an input box the reader does not recognize | Treat as unavailable, without guessing an empty input. |
| Only row may be a hint or a draft (CLIS-2.1) | Probe it once a run, a space then Backspace, and act on what it found; else treat as unknown. |
| Run still starting, its input reader not yet known | Treat as an unknown input at each slot; once its launch shows its CLI has no reader, fail at once. |
| CLI without an input reader | Fail at once as a permanent obstacle; nothing is typed. |
| Run ended or explicitly closed | Fail; do not restart it. |

Every CLI version is attempted; CLIS-2.1 owns the input readers and their layout evidence, and the version is only a
diagnostic. Do not wait for keyboard silence. Human typing that starts after this check is outside the contract; do not
add another guard for that race, but for one: a probe's space and Backspace each go only while the person has typed nothing since
its reading, so that a probe never removes a character of theirs (CLIS-2.1). The recipient's MCP connection is not required when its terminal input is usable.
Native CLI prompts remain in the terminal. Direct text/keys use COLLABORATION-1.2, which deliberately has no draft
protection.

### 1.5 Every delivery stage has a finite budget

**Every delivery stage - an ordinary message, a creation prompt, a system result - tries every three seconds for thirty seconds, held input or not.**

| Value | Policy |
| --- | --- |
| Response | An ordinary message's within 30 seconds of Facade ingress, with its outcome (1.2) |
| Attempts per stage | At stage start, then every 3 seconds |
| Deadline per stage | 30 seconds from that stage's start; an ordinary message's stage starts at Facade ingress and ends half a second before its thirty seconds, kept for its answer's way back, routed or not |
| Input held by another draft, another delivery or a pending creation prompt (1.10), or a native menu or question | Waited for within the same 30 seconds; the deadline never moves |
| Permanent obstacle | Finish immediately; do not wait out unused slots |

An unavailable input consumes a slot without typing. Attempts do not overlap. Queueing and forwarding between windows
or environments consume the same budget. No extra attempts on input-change events, indefinite retries, or bursts to catch
missed slots. A draft that is not the message's own, or a native menu, login or question, is waited for within the
stage, so that the person can finish typing or answering: Facade never submits the person's text with the message. At the
deadline, cancel unstarted input and return success if confirmed, otherwise failure with the known effects. A stage ends
at its deadline, held or not: one deadline for every stage, because a sender waits on its send, and a
message its recipient's input could not take in that time is better sent again, knowingly, than typed in unseen minutes
later. An attempt begins a paste only where the paste, its Enter and the input's confirmation fit before the deadline at
CLIS-2.1's measured paste rates: one that would not fit is not begun, nothing typed, and the stage ends then, as no later
slot has more time. A text whose paste, Enter and confirmation could not fit even a whole stage at its recipient's rates -
many hundred lines for Antigravity, or eight thousand characters, CJK ones, for Codex on Windows - is a permanent
obstacle: a send of it fails at once as `invalid_argument` before its record is made - no message ID, nothing for
read_messages - asking for shorter parts, and a start with it as its first prompt is refused the same way, before
anything starts (MCP-2.3). In the legacy implementation, it still starts such an agent and gives the prompt
up, nothing typed, its result saying so and its record staying readable through read_messages. Fitting is an admission, not a guarantee that the CLI finishes in time: a
CLI that stalls still meets the deadline, the stage ending with its actual full, partial or unknown effects. A part of a message's text in the input, which no wait makes its own, is not waited for. An input still unavailable then means failure; delivery is not a promise to overcome a permanently
unavailable target. A read through read_messages delivers the message immediately and cancels any paste that has not
begun. If text is already being written or remains as this message's own complete draft, the existing stage may finish
its Enter within its original budget. It never types the text again, submits an edited draft or delays the read's result.
Result handoff - a start's, a stop's or a start's prompt's result - starts its own budget once that outcome is known.
Results for one terminal that come within 50 ms of one another, of operations that ended together, go in one paste under
the earliest one's deadline, each keeping its own: joining never restarts or extends a budget, a batch whose whole paste
would not fit before that deadline is not begun, and a paste a read has already delivered is never joined (1.7).
Window-close handling is 1.9 and does not extend a deadline.

### 1.6 A message is typed at most once

**A message owns the input from its paste through submission confirmation or cleanup.**

A live paste that began in an empty input owns the draft that appears while Facade is its only writer.
A CLI that reads the paste as individual console keys has to draw its draft after the paste's first
write and show an unambiguous logical end or paste marker. A changed last grapheme uses the freshly
printed tail of the paste, including spaces across a soft wrap and any final line breaks.
Recovery matches the text or the CLI's paste placeholder (CLIS-2.1). A current frame drawn after the key
must show the same owned draft for a retry. The CLI rule can allow up to three submission keys in total.
An owned draft that changes can be erased once when its full range is readable. Pasting it again requires
a complete empty frame drawn after the erase write is issued. A paste that has yet to appear stays pending
under the same deadline. A late frame can authorize cleanup of a paste that timed out. Other deliveries wait for the input to become usable (1.10).
Once its stage ends unconfirmed it is a draft like any other: no later delivery submits, extends or erases it, and that
stage's own outcome reports its effects as unconfirmed. Once a paste
showed as its CLI's placeholder, a later Enter goes only over that same placeholder, its paste number included, as a
person's later paste of the same size draws another. Never press Enter over a draft that is not the message's own: a
person's text is never submitted, nor appended to, nor erased. Report partial or uncertain effects honestly at the
deadline: text without a confirmed submission is not delivery. A confirmed submission ends that stage. Internal effect
records may help explain what happened; they are not caller request keys or a reconciliation API. No automatic content
retry occurs after the budget ends.
A message can still arrive twice where a person submits its pasted text themselves, so the injected skill tells the
receiving model to recognize repeated message IDs and avoid repeating work for the same message; MCP-6.2 owns that
instruction. Facade does not add an exactly-once execution or platform deduplication service.

### 1.7 Deliver the result back to A, then stop

**Give an operation's result to its sender; an undeliverable system result ends quietly.**

A returned immediate final result needs no second notification. An ordinary message's send answers with its outcome
(1.2), so no Facade result follows it - also where its delivery went on after a reload, whose sender asks again with its
request ID where it gave one (1.2). An accepted start or stop, and a start's post-start prompt (MCP-1.3, 2.3), give A a clearly labeled Facade
result with the original IDs, target and outcome - for a prompt: delivered, including delivery through read_messages, or
not delivered - using the finite result budget if needed. The result is not authored by B and requests no response.
Results for one terminal that join under 1.5's condition go in one paste, one turn of its model for them all; a result
read meanwhile is left out of it. Failure to return it never resends the original message. A message whose result
already said it was not delivered and that its recipient reads later becomes delivered without a second result. If A is
gone or result delivery fails, finish the handoff; do not generate another error for B or a human popup. If B actually
chooses to reply, B is that new send's caller: a closed A produces an error to B. If no agent can receive that error,
drop the undeliverable report. There is no chain of receipts about receipts.

### 1.8 When Facade notifies the person

**An error belongs to the operation's initiator; agent-to-agent message failures never automatically notify a person.**

| Origin | Error recipient |
| --- | --- |
| Human UI operation | Person in that operation's window |
| Agent operation, including start, stop and input | Calling agent |
| A sends to B | A |
| B sends a reply to A | B |
| Facade cannot return a message result | End the result handoff; no human fallback |
| Known runtime/infrastructure failure requiring human handling, with no responsible agent | Person in the affected window |
| Agent explicitly sends to `#human` | Person through the sender's window under COLLABORATION-2.3 |

A retained red card is not permission to duplicate an agent's operation error as a human popup. Do not automatically
escalate because an agent has ended, remained idle or failed to respond. The agent's prompt/skill decides when it wants
to contact a person. One fact does go to an agent: a child whose CLI has waited twenty seconds on its own permission,
question or sign-in is reported to its running creator in the same window once each time it starts waiting. The Facade result names
who can answer - the person's permission and sign-in are theirs - because a child waiting on an unseen question can
stall its creator's work. A person is never told by it. The notice reports the blocker without asking its creator to
contact the person, forward the notice or escalate it. Whether an agent contacts the person follows the person's task
instructions, not this automatic notice. Permission and sign-in remain the person's to authorize or perform; reporting
the blocker grants no authority to answer it. Each window shows only its own relevant notifications; no fallback to
another window.

### 1.9 Window closure and pending messages

**Message delivery follows the agent's lifetime under 4.1 and keeps its original deadline.**

A window's runs end under 4.1. If the recipient ends before submission, fail to the current sender if
reachable. A different still-open window continues its own work. If only A's window closes, already handed-off delivery at B may
continue within its deadline; work still owned by the closing side can end with it. Do not add durable handover or
recovery solely to guarantee this edge case, and do not cancel B's independent work just to enforce a global rule.

Reload or temporary disconnect is not closure. Reuse an existing in-flight operation only while its original run and
deadline still apply; an expired operation does not get a fresh budget. On the legacy implementation, a delivery under way when
its window reloads goes on once the window shows its recipient again, within its original deadline. Use 1.6's
draft and paste rules. A recipient that is unavailable can return within that deadline. If it ends or the deadline
passes, end the delivery under 1.2 or 1.7. The old window relinquishes those deliveries when another window takes
over its workspace. Closing every legacy implementation window ends remaining volatile delivery work. A newly started agent
receives only messages addressed to its new run.
No notification or message is scheduled for replay on the next opening.

### 1.10 Concurrent sends share the terminal without interleaving

**Serialize automated input per terminal so two operations cannot splice their contents together.**

An ordinary message is one full paste plus Enter, not one Enter per line: none of its line breaks acts as the
CLI's own Enter (CLIS-2.1). Codex on Windows can take a tab in it for its own Tab key (CLIS-2.1). Direct text/keys use
the same serialization.
The Framework uses the CLI rule's paste brackets for automatic messages and first prompts, including when the mode
is missing from the screen recovered after a daemon crash.
While another delivery's text may still be in that input - written, neither confirmed nor ended - or its run's
post-start creation prompt, its preparation included, is neither delivered nor given up (COLLABORATION-2.2), no message
is pasted into it: that input is held for it, as by a draft. Waiting in that sequence does not renew deadlines. Stop is
independent of pending input and prevents further queued input for the closed run. Use a simple bounded implementation;
no agent workflow or general-purpose scheduler is added.

## 2 Identity and locations

### 2.1 A client network is distinct from an execution environment

**A window's connected scope and its execution environment have separate identities.**

The window components route between
one user's windows on one client computer, including their local and remote execution environments.
Each workspace runtime owns paths, CLI accounts, Git and process execution in its environment. Interpret a path in its
owning environment. An open window with no folder can be discovered with an empty location catalog. Distinguish a known
empty catalog from an unavailable runtime.
There is no multi-user discovery, hosted service or assumption of shared home directories.

### 2.2 Window, workspace, agent and creation tree have different identities

**An agent ID identifies one agent across its runs; a workspace and creation tree survive different lifetimes.**

| Identity | Meaning |
| --- | --- |
| Client network | This user's connected editor windows on one client computer on the legacy implementation |
| Execution environment | Where files, CLIs and processes exist |
| Window instance | One editor window through reload, identified by its local handover record (ARCHITECTURE-2.2). True reopening is a new instance. The legacy implementation routes by this identity. |
| Workspace | Saved editor workspace/folder context for preferences and Pin intent |
| Conversation key | Execution environment, CLI and exact vendor session ID |
| Pin | Saved intent to restore an exact conversation. |
| Agent ID | One agent from start until removal, unique across the client network and never reassigned there |
| Agent alias `#aN` | The agent's short reference, numbered by the client network |
| Run | One start or Resume of the agent's CLI, until that CLI ends |
| Creation tree | A human-created root and all agent-created descendants, including siblings |

Keep the same agent ID and `#aN` through startup, rename, reattachment and Resume. A fresh start is a new agent with a new
ID; Resume keeps the agent and starts a new run.
Tree membership does not disappear when an ancestor closes. IDs are routing addresses, not credentials; no token
issuance or anti-impersonation system is required.

### 2.3 References resolve once before effects

**Use an exact ID, or a name that identifies one eligible agent; an ambiguous name requires an ID.**

Names can repeat. Resolve within the caller's normal reach under 4.3 and return ambiguity instead of guessing. An exact
ID of an agent in the caller's window needs no other window, and a name resolves among agents of every window. While
a legacy implementation window cannot be listed, only the exact ID of a listed agent can resolve. Once resolved, the operation
stays with that target through rename. An optional display name accompanying an ID is descriptive. Return the error
for a missing record or a live-only operation on an ended agent. `#human` is the
person's reference and never names an agent. Because `human` is an allowed agent name (LIFECYCLE-2.1), `@human` names
the person only when no agent in the caller's reach, in any window, is named `human`; otherwise it is ambiguous like any
other repeated name, and `#human` or the agent's ID decides. While a window cannot be checked, `@human` fails as
unavailable and `#human` still names the person. `human` without `@` is read as `@human`, and `human` and `#human` match
whatever their case; any other name without `@` resolves as `@name` does.

### 2.4 Locations preserve the opened folder and execution authority

**A location is a qualified execution path associated with this window's folder or a related Git worktree.**

A plain folder is sufficient. Preserve the opened path for display and defaults; compare path components and canonical
paths in the owning environment. Nested folders use the matching workspace association; related worktrees can be outside
the folder. A successful Git read can discover worktrees made by any tool. Removing a
workspace folder or deleting a worktree closes the agents belonging to that removed location. Finding a Resume cwd
recorded within a location gone (WORKTREES-1.2, 3.3) ends the agents working in it while the location stays.
Location loss requires confirmation in the owning execution environment.

## 3 State and feedback

### 3.1 Process, activity, connection and input are separate facts

**Process lifetime, CLI activity, connection and input availability are observed independently.**

| Axis | Values |
| --- | --- |
| Internal lifecycle | starting, running, ended; a close's process cleanup is a background operation, not a state |
| Reachability | connected or disconnected, with last observation time |
| Activity | working, not working, unknown |
| Tool connection | connecting, available, unavailable or not injected |
| Ordinary input | ready, draft, interaction, unknown or unavailable |
| Retained error | reason and source when known |

A live process can lack its Facade tools. A working CLI can accept a message. An idle CLI can contain a draft. An
unknown activity report does not prove unusable input. Process cleanup may still be under way, but explicit close
removes UI immediately. A stale observation is labeled as such rather than treated as proof of exit.

State observation time comes from the execution environment's current state episode, not the query or view refresh.
Repeated reports, title-only changes and reload preserve that source time. It is neither a heartbeat nor task duration;
missing source time stays absent. Lost execution connections mark retained activity observations stale without an age threshold.

### 3.2 The dot says only what is known

**Busy is green and a problem is red; anything else shows no dot.**

Green and breathing while the agent is busy: starting - until its CLI first shows its activity and its injected Facade
tools connect, within CLIS-2.3's bound - or working. Red where something is wrong: a failed launch, an abnormal exit, a
lost connection to its process, an error its CLI reported, Facade tools it cannot use - injected tools that failed or
went away - or a start not ready within its bound. Red comes before green. A native permission, answer or sign-in
question waiting for the person shows no dot even where its Facade tools are unusable or its start was not ready in
time, as the second line says what it waits for (PANEL-1.4); an error or an ended run stays red. Idle, a reported
blocker without a recognized kind and unknown activity show no dot either - a start whose CLI reports nothing within
the bound is red, except a custom program's, which awaits no report (CONFIGURATION-2.3), while activity unknown later in a
run shows no dot until the CLI's next report; the card's accessible
label says which in words, and its second line what a blocker waits for (PANEL-1.4, 1.5). Neither the details nor a hover says a state. A
blocker stays a blocker, never idle; idle still requires reliable evidence. Work that stops is shown so a second later,
as a CLI between two steps does not blink; a blocker or a problem is shown at once. A quiet screen or an unrecognized
working indicator does not prove idle. Screen evidence is invalidated by a full reset or an unrecognized completed
layout; incomplete synchronized drawing supplies no new observation. A turn ending removes the dot without a
notification or a task-completion claim. Recovery clears only the corresponding error. Reduced motion removes breathing,
never the accessible state description. Activity describes the agent's interactive turn: a command left running after
that turn, such as a development server, does not by itself keep the agent working. A tested adapter may tell that case
apart from a CLI's broader process report under CLIS-2.3. Available input, a quiet terminal and an earlier answer alone
never prove idle.

### 3.3 Exit classification is independent of who caused it

**Normal CLI exit removes the pair; abnormal exit retains a red pair until the person uses Dismiss Agent.**

Normal means exit 0, a completed explicit stop, or a verified native exit/interrupt outcome such as the adapter's
Ctrl+C handling. An unexplained nonzero/signal exit is abnormal. Record its actual code/signal; do not guess a cause
or show an unknown-cause popup. A real known error follows 1.8's ownership. Connection loss alone proves neither exit.
New Agent launch failure retains the accepted pair even when no CLI process was created. Resume failure follows LIFECYCLE-3.3.

### 3.4 Notifications without an attention queue

**Use native notifications and their Show action.**

Human notifications follow 1.8. The one-time settings migration notice follows
CONFIGURATION-6.3 and appears only in the window that created the file. There is no universal exactly-once-per-error popup
guarantee or durable notification claim/recovery protocol. This does not introduce repeated reminder popups. There is no
unseen/seen attention state, attention ordering or Next Agent Needing Attention command. Opening a source does not erase
its error or require a response. Explicit human contact is shown even while that agent's terminal is visible. No
turn-completion, child-idle, child-exit, login or permission-menu notification is generated merely from that state
transition.

## 4 Lifetime and access

### 4.1 Ownership, reload and closure

**The legacy implementation keeps one owning window per agent.**

Closing a creator leaves its children running in their own windows.

Closing a window ends all its runs and removes their UI, preserving
Pin intent. No public editor signal tells a close from a reload, so a window's runs end a grace period
after its extension host disconnects from the execution supervisor, unless a reloaded or reopened window of the same
workspace claims them first: 90 seconds for a local window, whose reload or extension host restart claims them well
within it, and five minutes for a remote one, whose network may come back. A window that opens the workspace within the
grace - a local window closed and opened again within its 90 seconds included - takes the runs over as a reload does. A
reload claims them well within the 90 seconds, as VERIFICATION G2 measures on a busy machine; a window that crashed and
is reopened after them finds its runs ended, as a closed window's. Runs that reach the grace end as a closed window's
do, and their Pins restore as the workspace next opens, once their end is confirmed: a run whose end is not confirmed
stays known, its conversation never started a second time (LIFECYCLE-3.5). Runs held by a supervisor of an earlier
protocol (ARCHITECTURE-2.4) keep its own policy - five minutes for every window - whichever window held them. A reload
or a temporary remote disconnect - during which the remote extension host stays connected - retains/reconnects the
original runs without launching duplicates. Explicit agent closure immediately removes card and terminal and Unpins;
process cleanup happens in the background, using termination when needed. A close whose Unpin cannot be saved keeps the
agent and tells its initiator. No fixed UI wait or Stopping card is required. Actual termination and uncertain remote
cleanup remain distinct facts in the operation record. The grace timer is cleanup policy, not proof that a person closed
the window: no other timer ends a process. Telling a close from a reload is a platform limitation; VERIFICATION G2
verifies this policy.

Until a person closes it, it ends normally or its location is removed (2.4), every owned agent stays shown
by its card, with the terminal in an editor tab or hidden until the person opens it (LIFECYCLE-2.2),
across a reload, an extension host restart, an update and a lost connection alike; an agent started before an update
keeps working through the execution supervisor that holds it (ARCHITECTURE-2.4). Where Facade cannot reach an agent's
process, the card is red and says why (3.2); unknown activity alone shows no dot. Facade never leaves the agent out. The
one exception is a window that cannot know its own identity, so cannot tell its agents from another window's: one whose
identity record is damaged, where Facade does not start (ARCHITECTURE-2.2), and one without its window component, which
is what reads that identity. It shows and starts no agents. Its running agents go on for the grace period above (ARCHITECTURE-4.3).
A window that takes over
that workspace shows its agents in place of the old window.

### 4.2 Restoration preserves conversation and location

**Resume and Pin restore the exact conversation in its original location.**

Pin stores the conversation key, original location, name and order (LIFECYCLE-3.4). Keep the conversation/location
association for non-pinned Facade conversations too; short-lived message cleanup must not erase it. No copied account
credentials. Keep the CLI entry name and type, and use its current settings and 4.3's current YOLO for the new run.
Model and effort follow CONFIGURATION-3.3: this request, then the current entry, then the native saved session or
configuration. Historical requests are diagnostic only. A missing, disabled or changed-type entry refuses restoration
with the reason, without switching entries (CONFIGURATION-3.4).
Existing processes keep their actual plan.

A person's close of an agent's editor tab showing its pin mark (LIFECYCLE-3.4) unpins it. Whole-window close and a tab
hidden any other way preserve Pin. Unpin alone does not stop. Manual Resume does not silently re-pin a deliberately
unpinned conversation. If the exact conversation already runs in Facade, a second agent does not launch it.
Facade does not inspect or block an external application's writer. Vendor resume errors are returned as actual errors.

A Pin can initially have no conversation key (LIFECYCLE-3.4). Explicit agent close, normal exit or
actual location removal unpins. Abnormal exit preserves Pin. Each activation,
after reattachment, restores the Pins no run holds (LIFECYCLE-3.4's Pin restoration), so a reload restarts none that
still run or were retained as failures; a failure is retained without a restart loop. Only their processes start in the
background, and their tabs then open in front by LIFECYCLE-3.5's tab procedure.

### 4.3 Reach is client-wide and permissions remain explicit

**YOLO reaches the connected scope under 2.1; non-YOLO reads and writes only within the caller's whole creation tree.**

The tree includes ancestors, descendants, siblings and other branches under the same root. Unrelated roots are outside
normal non-YOLO reach. The caller's own run YOLO decides reach.

Every launch reads `yolo` from the destination execution environment's current Facade settings file (default true)
when accepted and keeps that value for the run. This includes human starts, agent-created children, Resume and Pin
restoration. Changing the file does not change existing runs. A file error refuses new starts under CONFIGURATION-4.1.
Children keep their creator's tree, not their creator's YOLO value. There is no API choice of YOLO.

Window/location/CLI discovery includes valid startup destinations even with no agents. A new child there joins its
creator's tree; tree membership alone grants no access to unrelated agents there. Each run's own YOLO still decides
its reach. Tool-specific limits still apply: read_messages is only the caller's inbox even in YOLO. Enable the CLI's
own sandbox in non-YOLO when supported; its own commands and edits keep its normal approvals. Calls to Facade's own
tools are approved in advance in either mode wherever the CLI can approve one server's tools; Muse Code cannot, so with
YOLO off its own approvals apply to them too (CLIS-2.2). Facade's tree rules are normal operating policy, not
authentication or a defense against deliberately spoofed IDs. Do not add credentials, scoped delegation or a new
security service.

### 4.4 Configuration changes affect future runs

**Built-in types always receive Facade integration; configuration changes apply to new processes.**

Every start using one of the six built-in types attempts to inject its Facade tools and skill. There is no tools or
collaboration switch. An actual injection failure follows CLIS-2.2: keep the CLI usable where it can start, report the
tools unavailable and explain why. A `custom` program receives no integration (CONFIGURATION-2.3).

A valid disabled entry cannot be newly started or restored. Existing processes keep their launch snapshot, including
tools and 4.3's YOLO, and reconnecting to them does not reinject or replay messages. For example, disabling `codex`
leaves a running Codex agent alone and refuses the next start from that entry. CONFIGURATION-3.4 owns the shared
snapshot rule. There is no worktree-management switch: detect Git and offer creation where supported; ordinary
locations remain usable without Git.

## 5 Side effects

### 5.1 Validate before changing and report actual effects

**Reject invalid arguments before mutation and report what actually happened after an accepted request.**

Accepted launches create their pair immediately: the card, and the terminal, whose editor tab an agent's start leaves
hidden (LIFECYCLE-2.2). Later failure does not erase already created files or claim nothing happened. Validate what is
available before effects; CLIS-4.2 defines checks that require a newly created directory. MCP-1.1's optional request_id
makes a repeated start or send reuse its first operation, including concurrent calls, lost cross-window replies and a
run that has since ended. Without it, repeating a start may create another agent. Facade may keep internal IDs for its
own operations without turning them into a public feature.

### 5.2 Cancellation preserves completed effects

**Cancellation ends unstarted work and does not undo files or submitted input.**

Canceling a picker has no effects. Stopping an accepted launch with Stop Agent or stop_agent
(LIFECYCLE-3.1) prevents later spawn and ends its own pending input. Created worktrees and branches remain. Native
post-create environment preparation is not a Facade-managed job. There is no message-recall tool, worktree-delete API or
stop-with-delete option; a person deletes a clean linked worktree only by WORKTREES-3.2's confirmed picker action,
otherwise with their usual Git tools. Facade observes actual location loss under 2.4.

### 5.3 Durable records have explicit retention and owners

**Keep simple bounded runtime records and thirty-day Facade message records; vendor conversations are not deleted.**

The window components own routing; execution owners keep process/input facts; workspace storage keeps preferences; CLI
stores own their conversations. No durable caller-key deduplication ledger or notification handover ledger is needed.
Use simple fixed runtime buffers and report real capacity failures rather than truncate this operation's content or
evict an in-progress delivery. Message records expire after 30 days with no manual delete/hide UI; associated temporary
copies expire under COLLABORATION-4.2. Creation-tree associations follow their runs, not message expiry.
No arbitrary accumulated-operation counter may permanently disable an otherwise usable environment.

## 6 The VS Code entry point

### 6.1 Workspace presentation

**The panel shows every running Managed Agent visible to this window's Orchestrator.**

Agents started from Shell, other windows or other agents appear automatically. Opening a card opens its terminal.
The workspace remembers the agents started or opened there, their descendants and its Pins across reloads and
reopens. Those agents can keep cards after exit. Observing an unrelated live record leaves the saved roster alone
until its card is opened or pinned. Keep a last observed card and mark it unavailable when the source is
temporarily unreachable. The Orchestrator owns the records and processes. The extension owns presentation and
Pins under ARCHITECTURE-6.2.
A remote extension host connects to the Orchestrator on the machine where it runs.

### 6.2 References and results

**The editor uses the Orchestrator's addresses, state, title and scoped query results.**

An agent address is `a3@devbox` or `a3@9a0d44b2`; keep the full address for Copy Agent Reference. The panel follows
the same active Managed Agents as Shell's `facade list`. Resume Agent uses the same scoped results
as `facade resume`: ended agents with sessions and the CLI's own saved sessions. It resumes an ended agent at
its original address or resumes a saved session as a new agent. Show an actionable error if a session is already
in use. PANEL-4.1 owns the card presentation. The editor uses the complete identity for every operation.

### 6.3 Attach and card actions

**Attach shows the running agent's shared terminal grid. Closing a tab detaches that view.**

Each open view reports the rows and columns its pane can fit. The Orchestrator takes the smallest capacity in each
dimension across live Attach viewers that have reported it. Each view draws at the confirmed grid size. Closing a tab
recalculates the grid for the remaining views and leaves the agent running. Use VS Code for terminal colors.

Input entered during a disconnect is dropped. The reconnected view reports the number of input bytes dropped after
displaying the current screen. Stop Agent ends the run. The workspace keeps the cards it remembers under 6.1 and
their Pins. Other cards leave when their exit is confirmed. The existing Remove
command, where invoked explicitly, stops a running agent and removes its record. A successful Remove clears this
workspace's card, Pin and view. Rename keeps the address. PANEL-4 owns the available card actions.

### 6.4 Pin and reopening

**Pin is available as soon as Framework accepts a managed agent's start, including agents on reachable remote machines.**

When a workspace opens after its last window closed, make one recovery attempt per Pin. All windows share the
result. Wake a sleeping machine for the stored reference and Attach to a running agent. For a stopped, crashed
or expired agent, Resume its known session. If it had no saved session, start an agent at the same machine and
actual working directory using the Pin's startup settings. For an earlier Pin with no startup settings, use its
CLI, working directory and name with the CLI's current settings. Recover a sessionless legacy Pin only after its
execution environment is verified and the legacy cutover confirms exit under ARCHITECTURE-1.4.

Save the new reference in the same Pin. Persist the attempt before starting. Keep an unresolved attempt from
starting another agent after a lost result. On an unresolved lookup or a failure, keep the Pin and show the reason
on its red card. A confirmed missing saved session removes the Pin and tells the person. Explicit removal clears
the card and Pin and ends automatic recovery for it.

### 6.5 Start and location

**Choose machine and folder in the working-location step and use the selected machine's CLI catalog.**

On the editor's machine, show workspace folders and worktrees. For another machine, offer its login home, recent
folders and direct path entry. Show the CLI choices and explain unavailable CLI entries using the selected
machine's settings, chosen folder and environment (6.6). An ordinary folder works without Git. For a repository on either
machine, Facade can create a worktree as part of a start under WORKTREES-5.1. Git owns deletion.
When a folder is removed from the workspace or disappears on disk, the agent keeps running.
A later start or resume follows the Orchestrator's path validation.

### 6.6 Settings and permissions

**The Orchestrator applies settings and permissions on the agent's machine.**

Use that machine's `facade.json`. The editor resolves its execution home under CONFIGURATION-7.1. A local
start uses the initiating Shell, editor, or agent environment, including a Guest's
relay environment. A start on another machine uses its SSH login environment. Resume keeps the original session,
location, model, effort and CLI arguments, and uses the machine's current settings, including YOLO.

YOLO defaults to on. A managed agent reads it at start or resume. A Guest reads it when it joins. With YOLO off,
a caller's MCP reach is its creation tree and the CLI keeps its native sandbox and permissions. Every managed run
gets the approvals for Facade's tools and its Codex hook. YOLO enables the CLI's native approval and sandbox bypass
where available. Person starts keep the CLI's own startup prompts. Only MCP `start_agent` counts as an agent start.
Shell, editor and resume use person policy. Agent starts disable native automatic updates. With YOLO on an agent
start also clears supported startup prompts. Login remains a CLI interaction. See CLIS-6.3.
The [product's CLI table](../PRODUCT.md#cli-differences) owns the summary of differences.

### 6.7 Messages, machines and tools

**The editor entry point handles starts, opening terminals and recovery. Shell handles machines and sending messages.**

The Orchestrator owns the common Shell and MCP contracts, including Guest identity, delivery outcomes and the eight
tools. A failed background delivery or a watchdog incident produces a Facade notice (🔔). Startup trouble and
the first prompt's failure share one notice. The [product guide](../PRODUCT.md#messages) defines the outcomes.
The editor displays its own operation errors. Open the agent's terminal or inspect its state to see its work.
WSL and Dev Containers reached as machines use SSH you configure and `facade machine add`. Remote-SSH itself opens
an editor whose extension host uses that machine's Orchestrator.

### 6.8 Window Component

**The Window Component cleans up stale terminal tabs after reconnect or extension restart.**

Its existing legacy implementation duties apply during the transition. In the VS Code entry point, the Orchestrator has no
window membership or automatic Remote-SSH registration. The extension reads persisted workspace visibility under
6.1 and uses the Window Component's native key to locate saved Pins for a folderless window.

## Checks

| Rules | Acceptance |
| --- | --- |
| 1.1–1.10 | One recipient; response/attempt budgets; delivery by terminal, native prompt or read_messages; one delivery state; stable duplicate IDs; drafts and unrecognized input boxes untouched; no human fallback; closure |
| 2.1–2.4 | Client network across local and remote windows, unique agent IDs kept through Resume, duplicate names, `#human` and `@human`, tree survival, remote paths, folder/worktree removal |
| 3.1–3.4 | Work green, errors red, no dot otherwise, independent tool/input evidence, exits, errors to initiator, no routine notices or attention queue |
| 4.1, 4.3–4.4 | Immediate close, reload/disconnect, children outlive creators, every started agent remains shown across updates, tree reach, current-setting YOLO on every launch, unchanged live runs, future-only MCP setting |
| 5.1–5.3 | Invalid requests, request-ID retries and independent starts without a request ID, simple cancellation/capacity, thirty-day message cleanup |
| 6.1–6.8 | Shared workspace list and upgrade, Orchestrator agent list and Resume, shared Attach grid and card actions, Pin recovery, SSH locations, settings and transition cleanup |

[Verification](engineering/VERIFICATION.md) owns actual evidence.
