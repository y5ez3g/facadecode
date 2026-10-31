# Shared rules

[Product](PRODUCT.md) sets scope. This document owns the meanings used by every feature and integration.
The owner recalibrated these contracts on 2026-10-28. They are implementation targets, not runtime certification.

| Group | Decides |
| --- | --- |
| 1 Agent messages | Delivery, results, notifications and closure |
| 2 Identity and locations | Client network, runs, references and locations |
| 3 State and feedback | Status evidence, exits and error ownership |
| 4 Lifetime and access | Window ownership, reach, YOLO and settings |
| 5 Side effects | Validation, cancellation and simple retention |

## 1 Agent messages

### 1.1 One request identifies one delivery

**A send has one sender, one recipient run, complete content and one Facade-assigned message ID.**

There are no recipient arrays or aggregate sends. A caller sending to several agents calls the same tool separately.
Resolve the target once under 2.3; keep that target and message ID through internal attempts. An optional reply-to ID
expresses a relationship, not a promise of a reply. Names and conversation IDs are not substitutes for the resolved run.
A caller may give a send its own request ID: the same one again from that caller within an hour answers the message it
sent, as it stands, and sends nothing again (D104). Each new send invocation without one gets a new message ID; internal
attempts for an accepted message retain its ID. Message IDs, including their displayed aliases, are unique across the client
network and never reassigned, including after reopening or history expiry. This uses ordinary ID allocation; a request ID is kept on its
message record, not in a separate deduplication ledger. Report invalid content or an unavailable target before writing.

### 1.2 The first response has three outcomes

**Try immediately and return success, failure or accepted within two seconds.**

| Response | Meaning |
| --- | --- |
| Success | The message was delivered under 1.3. |
| Failure | Delivery cannot continue; report the reason and actual or uncertain input effects. |
| Accepted | Finite delivery continues; return the message ID and deadline, then report its outcome to the sender. |

The two seconds start when the complete request reaches the Facade MCP shim or equivalent direct ingress. Internal
forwarding, including forwarding to another window, consumes the same allowance; do not restart it at each hop. Return
earlier when the result is known. An `accepted` response is not delivery, a model read or completed work. B's answer is
a separate ordinary message.

### 1.3 Delivery means the recipient has the complete message

**A message is delivered when the target CLI accepted the complete instruction or read_messages handed the complete record to its recipient.**

For terminal delivery, confirm the complete text and Enter submission: the CLI's input box empties after Enter, at that
attempt or a later one of the same delivery (1.6). Text without Enter is not delivery. For a native interactive startup prompt, confirm acceptance through the adapter's native
launch path; no synthetic Enter is required. Passing arguments to an unstarted process is not acceptance. A
read_messages result that is handed back to the recipient delivers every record it contains (COLLABORATION-3.1).
Busy/idle transitions or unrelated output are not evidence that this particular instruction was submitted. The adapter
reports actual effects; uncertainty remains explicit. Never truncate content and report full success.
Each message has one delivery state: being delivered, delivered or not delivered. There is no separate fetch state.
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
| CLI without an input reader | Fail at once as a permanent obstacle; nothing is typed. |
| Run ended or explicitly closed | Fail; do not restart it. |

Every CLI version is attempted; CLIS-2.1 owns the input readers and their layout evidence, and the version is only a
diagnostic. Do not wait for keyboard silence. Human typing that starts after this check is outside the contract; do not
add another guard for that race. The recipient's MCP connection is not required when its terminal input is usable.
Native CLI prompts remain in the terminal. Direct text/keys use COLLABORATION-1.2, which deliberately has no draft
protection.

### 1.5 Both delivery stages have a finite budget

**Ordinary delivery and a needed system-result handoff each try every three seconds for fifteen seconds, and wait up to ten minutes for an input a person or the CLI holds.**

| Value | Policy |
| --- | --- |
| Initial response | At most 2 seconds from Facade ingress |
| Attempts per stage | At stage start, then every 3 seconds |
| Deadline per stage | 15 seconds from that stage's start |
| Input held by another draft or a native menu or question | The deadline moves on while it holds, to at most 10 minutes from the stage's start (D100) |
| Permanent obstacle | Finish immediately; do not wait out unused slots |

An unavailable input consumes a slot without typing. Attempts do not overlap. Queueing and forwarding between windows
or environments consume the same budget. No extra attempts on input-change events, indefinite retries, or bursts to catch
missed slots. A draft that is not the message's own, or a native menu, login or question, is waited for: Orca holds its
notices while a person types, and so does Facade, never submitting the person's text with the message (D100). At the
deadline, cancel unstarted input and return success if confirmed, otherwise failure with the known effects. A stage
whose input was never held ends at fifteen seconds; once held, its deadline is ten minutes from its start, whatever the
input shows after. A long paste adds the time it takes, at CLIS-2.1's paste rates, to each of its stage's deadlines, so
that its Enter is never cut off by its own size; a part of a message's text in the input, which no wait makes its own, is
not waited for (D112). An input still unavailable then means failure; delivery is not a promise to overcome a permanently
unavailable target. A read through read_messages delivers the message immediately and cancels any paste that has not
begun. If text is already being written or remains as this message's own complete draft, the existing stage may finish
its Enter within its original budget. It never types the text again, submits an edited draft or delays the read's result.
Result handoff starts its own budget once the original result is known; a result joins others typed in one paste only
while a whole stage's time is still before them (1.7, D112). Window-close handling is 1.9 and does not
extend a deadline.

### 1.6 A message is typed at most once

**Once a message's text went into the input whole, later attempts never type it again; they press Enter only over the message's own draft.**

A submission the CLI takes slowly is not lost: Orca found that typing it again delivers it twice, and counts a written
prompt as delivered (D98). A later attempt of the same delivery reads the input: the message's own draft alone - its
text, or the placeholder its CLI draws for a paste of its size (CLIS-2.1) - gets Enter; an empty input after an Enter of
this delivery confirms the submission; anything else is waited for under 1.4 and 1.5. A paste that never showed in the
input is not typed again either: a CLI busy with its turn draws it late, and its own draft then gets Enter. A paste whose
answer was lost on its way counts as written with no Enter after it, so an empty input confirms nothing. Once a paste
showed as its CLI's placeholder, a later Enter goes only over that same placeholder, its paste number included, as a
person's later paste of the same size draws another (D112). Never press Enter over a draft that is not the message's own: a
person's text is never submitted, nor appended to, nor erased. Report partial or uncertain effects honestly at the
deadline: text without a confirmed submission is not delivery. A confirmed submission ends that stage. Internal effect
records may help explain what happened; they are not caller request keys or a reconciliation API. No automatic content
retry occurs after the budget ends.
A message can still arrive twice where a person submits its pasted text themselves, so the injected skill tells the
receiving model to recognize repeated message IDs and avoid repeating work for the same message; MCP-6.2 owns that
instruction. Facade does not add an exactly-once execution or platform deduplication service.

### 1.7 Deliver the result back to A, then stop

**Give an operation's result to its sender; an undeliverable system result ends quietly.**

A returned immediate final result needs no second notification. An accepted asynchronous send gives A a clearly
labeled Facade result with the original message ID, target and outcome - delivered, including delivery through
read_messages, or not delivered - using the finite result budget if needed. The result is not authored by B and
requests no response. Results that come for one terminal while none of them is typed yet go in one paste, one turn of its
model for them all, as T3 Code wakes a parent once for the tasks that finished together; a result read meanwhile is left out
of it (D109). Failure to return it never resends the original message. A message whose result already said
it was not delivered and that its recipient reads later becomes delivered without a second result.
If A is gone or result delivery fails, finish the handoff; do not generate another error for B or a human popup.
If B actually chooses to reply, B is that new send's caller: a closed A produces an error to B. If no agent can receive
that error, drop the undeliverable report. There is no chain of receipts about receipts.

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
| Agent explicitly sends to `#human` | Person in that agent's window; this is deliberate contact |

A retained red card is not permission to duplicate an agent's operation error as a human popup. Do not automatically
escalate because an agent has ended, remained idle or failed to respond. The agent's prompt/skill decides when it wants
to contact a person. Each window shows only its own relevant notifications; no fallback to another window.

### 1.9 Window closure and pending messages

**Closing a window ends that window's agents and does not replay their old messages when it reopens.**

A window's runs end under 4.1. If the recipient ends before submission, fail to the current sender if reachable. A
different still-open window continues its own work. If only A's window closes, already handed-off delivery at B may
continue within its deadline; work still owned by the closing side can end with it. Do not add durable handover or
recovery solely to guarantee this edge case, and do not cancel B's independent work just to enforce a global rule.

Reload or temporary disconnect is not closure. Reuse an existing in-flight operation only while its original run and
deadline still apply; an expired operation does not get a fresh budget. A newly started agent receives only messages
addressed to its new run. Closing every window naturally ends the remaining volatile delivery work.
No notification or message is scheduled for replay on the next opening.

### 1.10 Concurrent sends share the terminal without interleaving

**Serialize automated input per terminal so two operations cannot splice their contents together.**

An ordinary message is one full paste plus Enter, not one Enter per line. Direct text/keys use the same serialization.
While another delivery's text may still be in that input - written, neither confirmed nor ended - no message is pasted
into it: that input is held for it, as by a draft (D112). Waiting in that sequence does not renew deadlines. Stop is independent of pending input and prevents further queued
input for the closed run. Use a simple bounded implementation; no agent workflow or general-purpose scheduler is added.

## 2 Identity and locations

### 2.1 A client network is distinct from an execution environment

**The client network joins one user's Facade windows on one client computer, including their local and remote execution environments.**

The window components maintain addresses and routes. Each workspace runtime owns paths, CLI accounts, Git and process
execution in its environment. Remote paths are not local paths. An open window with no folder can be discovered but
has no usable launch location. Distinguish a known empty catalog from an unavailable runtime.
There is no multi-user discovery, hosted service or assumption of shared home directories.

### 2.2 Window, workspace, agent and creation tree have different identities

**A run ID identifies one accepted launch; a workspace and creation tree survive different lifetimes.**

| Identity | Meaning |
| --- | --- |
| Client network | This user's connected editor windows on one client computer |
| Execution environment | Where files, CLIs and processes exist |
| Window | One current editor window; reload reconnects it, though its routing ID may change (ARCHITECTURE-2.2); true reopening is a new window |
| Workspace | Saved editor workspace/folder context for preferences |
| Agent/run ID | One accepted launch, unique across the client network and never reassigned |
| Creation tree | A human-created root and all agent-created descendants, including siblings |

Keep the same run ID through startup, rename and reattachment of the same process. A fresh start has a new run ID.
Tree membership does not disappear when an ancestor closes. IDs are routing addresses, not credentials; no token
issuance or anti-impersonation system is required.

### 2.3 References resolve once before effects

**Use an exact ID, or a name that identifies one eligible agent; an ambiguous name requires an ID.**

Names can repeat. Resolve within the caller's normal reach under 4.3 and return ambiguity instead of guessing. Once
resolved, the operation stays with that run through rename. An optional display name accompanying an ID is descriptive;
the ID decides the target. A missing or ended ID is an error, not a request to find another same-named agent.
`#human` is the person's reference and never names an agent. Because `human` is an allowed agent name
(LIFECYCLE-2.1), `@human` names the person only when no agent in the caller's reach is named `human`; otherwise it is
ambiguous like any other repeated name, and `#human` or the agent's ID decides.

### 2.4 Locations preserve the opened folder and execution authority

**A location is a qualified execution path associated with this window's folder or a related Git worktree.**

A plain folder is sufficient. Preserve the opened path for display and defaults; compare path components and canonical
paths in the owning environment. Nested folders use the matching workspace association; related worktrees can be outside
the folder. A successful Git read can discover worktrees made by any tool. Removing a workspace folder or actually
deleting a worktree closes the agents belonging to that removed location. A failed Git read or temporary remote
disconnect is not proof of deletion.

## 3 State and feedback

### 3.1 Process, activity, connection and input are separate facts

**Process lifetime, CLI activity, connection and input availability are observed independently.**

| Axis | Values |
| --- | --- |
| Internal lifecycle | starting, running, stopping, ended |
| Reachability | connected or disconnected, with last observation time |
| Activity | working, not working, unknown |
| Tool connection | connecting, available, unavailable or not injected |
| Ordinary input | ready, draft, interaction, unknown or unavailable |
| Retained error | reason and source when known |

A live process can lack its Facade tools. A working CLI can accept a message. An idle CLI can contain a draft. An
unknown activity report does not prove unusable input. Internal cleanup may be stopping, but explicit close removes UI
immediately. A stale observation is labeled as such rather than treated as proof of exit.

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
its error or require a response. Explicit human contact is shown even while that agent's terminal is visible. No
turn-completion, child-idle, child-exit, login or permission-menu notification is generated merely from that state
transition.

## 4 Lifetime and access

### 4.1 Ownership, reload and closure

**A window owns its agents; creation relationships do not couple process lifetimes.**

Closing a creator leaves its children running in their own windows. Closing a window ends all its runs and removes
their UI. No public editor signal tells a close from a reload, so a window's runs end five minutes after its extension
host disconnects from the execution supervisor, unless a reloaded or reopened window of the same workspace claims them
first (D75). A reload or a temporary remote disconnect - during which the remote extension host stays connected -
retains/reconnects the original runs without launching duplicates. Explicit agent closure immediately removes card and
terminal; process cleanup happens in the background, using termination when needed. No fixed UI wait or Stopping card
is required. Actual termination and uncertain remote cleanup remain distinct facts in the operation record. The
five-minute timer is cleanup policy, not proof that a person closed the window: no other timer ends a process, and true
close detection remains a platform proof obligation.

### 4.3 Reach is client-wide and permissions remain explicit

**YOLO reaches the client network; non-YOLO reads and writes only within the caller's whole creation tree.**

The tree includes ancestors, descendants, siblings and other branches under the same root. Unrelated roots are outside
normal non-YOLO reach. The caller's own run YOLO decides reach.

Every launch reads the destination execution environment's current `facade.yolo` setting (default true) when the
launch is accepted and keeps that value for the run. This includes human starts and agent-created children. Changing
the setting does not change existing runs. Children keep their creator's tree, not their creator's YOLO value. There
is no API choice of YOLO.

Window/location/CLI discovery includes valid startup destinations even with no agents. A new child there joins its
creator's tree; tree membership alone grants no access to unrelated agents there. Each run's own YOLO still decides
its reach. Tool-specific limits still apply: read_messages is only the caller's inbox even in YOLO. Enable the CLI's
own sandbox in non-YOLO when supported; its own commands and edits keep its normal approvals, while calls to Facade's
own tools do not ask for approval in either mode (CLIS-2.2). Facade's tree rules are normal operating policy, not
authentication or a defense against deliberately spoofed IDs. Do not add credentials, scoped delegation or a new
security service.

### 4.4 Disabling optional services has bounded effects

**Launch settings affect subsequent starts; changing the MCP switch does not reconfigure current runs.**

A disabled CLI cannot be newly started; existing processes remain (CLIS-1.1's `.enabled` joins in a later step). YOLO
uses 4.3's single launch-time rule. `facade.collaboration.enabled` controls injection on future starts only. It neither
disables existing injected tools nor injects tools into a process already started without them. Re-enabling does not
replay old messages. There is no worktree-management switch: detect Git and offer creation where supported; ordinary
locations remain usable without Git.

## 5 Side effects

### 5.1 Validate before changing and report actual effects

**Reject invalid arguments before mutation and report what actually happened after an accepted request.**

Accepted launches create their pair immediately. Later failure does not erase already created files or claim nothing
happened. Validate what is available before effects; CLIS-4.2 defines checks that require a newly created directory.
MCP-1.1's optional request_id makes a repeated start or send reuse its first operation, including concurrent calls,
lost cross-window replies and a run that has since ended. Without it, repeating a start may create another agent.
Facade may keep internal IDs for its own operations without turning them into a public feature.

### 5.2 Cancellation preserves completed effects

**Cancellation ends unstarted work and does not undo files or submitted input.**

Canceling a picker has no effects. Closing an accepted launch prevents later spawn and ends its own pending input;
created worktrees/branches remain. Native post-create environment preparation is not a Facade-managed job. There is no
message-recall tool, worktree-delete API or stop-with-delete option; a person deletes a clean linked worktree only by
WORKTREES-3.2's confirmed picker action, otherwise with their usual Git tools. Facade observes actual location loss
under 2.4.

### 5.3 Durable records have explicit retention and owners

**Keep simple bounded runtime records and thirty-day Facade message history; vendor conversations are not deleted.**

The window components own routing; execution owners keep process/input facts; workspace storage keeps preferences; CLI
stores own their conversations. No durable caller-key deduplication ledger or notification handover ledger is needed.
Use simple fixed runtime buffers and report real capacity failures rather than truncate this operation's content or
evict an in-progress delivery. Message records expire after 30 days with no manual delete/hide UI; associated temporary
copies expire under COLLABORATION-4.2. Creation-tree associations follow their runs, not message expiry.
No arbitrary accumulated-operation counter may permanently disable an otherwise usable environment.

## Checks

| Rules | Acceptance |
| --- | --- |
| 1.1–1.10 | One recipient; response/attempt budgets; delivery by terminal, native prompt or read_messages; one delivery state; stable duplicate IDs; drafts and unrecognized input boxes untouched; no human fallback; closure |
| 2.1–2.4 | Client network across local and remote windows, unique run IDs, duplicate names, `#human` and `@human`, tree survival, remote paths, folder/worktree removal |
| 3.1–3.4 | Unknown red, idle yellow, independent tool/input evidence, exits, errors to initiator, no routine notices or attention queue |
| 4.1, 4.3–4.4 | Immediate close, reload/disconnect, children outlive creators, tree reach, current-setting YOLO on every launch, unchanged live runs, future-only MCP setting |
| 5.1–5.3 | Invalid requests, repeated starts without idempotency, simple cancellation/capacity, thirty-day message cleanup |

[Verification](engineering/VERIFICATION.md) owns actual evidence; writing these rules does not certify runtime behavior.

## Change log

- 2026-10-31: Request IDs, owned drafts, bounded delivery and read-delivery follow D98-D104, D109, D112 and D113.
- 2026-10-30: Step 2 of the Facade Code extension: added the Facade Dots message rules 1.1–1.7 and 1.9–1.10, the client
  network (2.1), references (2.3), tool and input facts (3.1), client-wide reach (4.3), the MCP switch (4.4) and message
  retention (5.3), with the owner's decisions of that day: one delivery state, in which read_messages delivers (1.3, 1.7,
  D82); every CLI version attempted, with unrecognized input boxes left untouched (1.4, D83); Facade's tools without
  approval prompts (4.3, D84); `#human` for the person (2.3, D85); results for success and failure (1.7, D86). 4.1 keeps
  the five-minute policy (D75) and adds that creators do not end their children.
- 2026-10-30: 3.2's startup lasts until the CLI first shows its activity, within CLIS-2.3's bound (D81).

- 2026-10-30: 4.1 states the owner's five-minute policy (D75) after a window's extension host disconnects, replacing the
  prohibition on timed cleanup; 4.4 notes that the disable setting joins in a later step.

- 2026-10-29: 5.2 allows WORKTREES-3.2's confirmed deletion of a clean linked worktree (D73).
- 2026-10-29: Step 1 of the Facade Code extension, carried from the Facade Dots specification: the rules step 1
  needs, each with its final number. Later steps add the others.
