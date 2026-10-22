# Agent Messages

Agents communicate through numbered messages. Facade stores each message, types a
short doorbell into the recipient's terminal, and lets the recipient fetch it with
read_messages. The person reads the agents' own terminal conversations and normally
directs the root agent they started.

This specification owns messages, tasks, doorbells and saved communication history.
[AGENT-LAUNCHER.md](AGENT-LAUNCHER.md) owns permissions and startup behavior;
[AGENT-ORCHESTRATION.md](AGENT-ORCHESTRATION.md) owns callers, reach, references and
management tools; [AGENT-DEBUGGING.md](AGENT-DEBUGGING.md) owns terminal input and
screen inspection. These are complementary parts of one specification.

# Part 1: Specification

## M1. The communication model

The two communication tools are send_message and read_messages. Messages are plain
text. Facade does not interpret a message as a workflow command, guess whether its
author is finished, or automatically make staffing decisions.

A mailbox contains the messages addressed to one agent or to @human. Each message
has a stable number, unique on the machine (L2), displayed as `#m42`, distinct from
an agent number such as `#a7`. A mailbox lives in the workspace its agent belongs to;
mail reaches it from any workspace.

A doorbell is generated text telling an agent that messages wait and asking it to
call read_messages. It does not contain the messages' bodies.

The normal sequence is:

```text
sender: send_message
    -> Facade records the message and returns its number
    -> Facade types a doorbell into the recipient terminal
recipient: read_messages
    -> recipient reads and acts on the message
    -> recipient sends a report, answer or further question when appropriate
```

Use this path for tasks and ordinary agent-to-agent communication. Do not add CLI
hooks, native vendor messaging, a second queue inside a vendor API, or message
payloads appended to unrelated tool results. The only asynchronous wake-up is
terminal typing.

The framework records process, connection, terminal-input and delivery facts.
It does not parse screens to decide whether an agent is busy or finished.
An agent can inspect a screen with the debug tools and make that judgment itself.

## M2. Sending and reach

```text
send_message(to, text, reply_to?)
```

| Argument | Contract |
| --- | --- |
| to | One agent reference or @human, or a nonempty list of them |
| text | Nonempty plain text, preserved as sent |
| reply_to | Optional message number of a message addressed to the caller |

Resolve agent references with O2. Deduplicate recipients resolving to the same
identity. Give each distinct recipient its own message number and delivery state.
Validate every recipient before sending to any; a known invalid target refuses the
whole call. The transport limit is 1 MiB of encoded request JSON, including text
and arguments. A larger payload must be shared by file path in a shorter message.

An agent can send to itself, its creator, another agent in its reach, or @human.
YOLO off restricts agent recipients to its tree, in whichever workspace each runs;
YOLO on reaches every workspace on the machine. Every agent retains the ability to
address @human, with the default escalation behavior in M8.

A recipient of another workspace gets the same message as one of the caller's own:
the recipient's workspace records it in the recipient's mailbox, gives it its
number and rings the recipient, and the caller's workspace keeps the sender's copy
(M11). The result reads the same, with the recipient's workspace named. While
recipients are checked, a recipient whose workspace is silent past O8's wait
refuses the whole call as UNAVAILABLE, naming the workspace, and nothing is sent.
A workspace lost after sending began gives a partial outcome (M11).

A starting agent can receive messages if its launch is configured for Facade.
Delivery waits until its terminal is ready under M5. A disconnected agent that
previously had integration also retains its mailbox. A launch with no Facade
integration cannot receive messages: refuse immediately, explain the missing
connect configuration, and do not create undeliverable mail.

A stopping or ended recipient is refused with its state/reason. No other agent is
substituted automatically. The caller chooses another recipient if appropriate.

Reach is intentionally asymmetric when modes differ. A YOLO-on agent may send into
another YOLO-off tree, but the recipient cannot reply outside its own reach.
The send result flags that reply limitation. Receiving a message does not expand
the recipient's permissions.

A successful send returns as soon as recording succeeds, with each number and
recipient. It does not wait for a fetch or reply:

```text
Sent #m42 to @lint #a3. Not yet fetched.
Agent replies trigger your mailbox doorbell. Continue independent work, or end this turn if you need a reply to proceed. Do not poll or sleep for it.
```

For a live agent, the result includes whether delivery is waiting for launch or
reconnection. For @human, it confirms the notification/history entry, not that the
person read it. Never promise the recipient has acted merely because send succeeded.

## M3. Delivery facts

An agent message has one delivery state:

| State | Meaning |
| --- | --- |
| unread | Recorded, not yet delivered or returned |
| delivered | A read_messages result for the recipient was successfully written to its shim connection |
| returned | The recipient ended while the message was unread |

The UI and list_agents may describe delivered as **fetched**. This boundary is
observable and inexpensive. It does not prove the CLI accepted the tool result,
the model read a referenced file, or the agent completed the work.

Keep a message unread if a fetch result fails before that boundary, so the next
fetch can return it again. Repeated retrieval carries the same message number.
There is no exactly-once execution guarantee for the work described by a message.

list_agents includes each agent's mailbox summary: unread count, up to the oldest
ten unread ids with sender and age, delivered count, last fetch time and initial
task id/state. This exposes a delivery problem without guessing a work status.
Do not include other agents outside the caller's reach.

Messages to @human are recorded as delivered when accepted into the notification
and history path. Human reading is not tracked.

## M4. Fetching messages

```text
read_messages(ids?, all?)
```

- No arguments: the caller's unread messages.
- ids: a nonempty list of message references, written `#m42` or `m42`. A single
  reference given alone is a list of one.
- all: boolean, false by default; true returns all messages addressed to the caller in the current session,
  including delivered and returned messages, for context recovery.

ids and all:true are mutually exclusive. Remove duplicate ids and return selected
messages in number order. Reject an invalid, missing or out-of-reach id before
marking any delivery. An agent number is not a message reference.

A caller with YOLO on may read any current-session message by number, in any
workspace: a number its own workspace does not have, or one at or below the
machine's shared mark (AGENT-LAUNCHER.md L12), is looked up in the others too. With YOLO
off, it may read messages to or from its own tree, including that tree's
conversation with @human, in whichever workspace each is held. Reading somebody
else's message does not deliver it for its recipient. A message's session and
delivery state are its recipient's workspace's; read through the sender's copy
(M11), the state is asked of that workspace, and while it does not answer the
result gives the last state its sender's workspace learned - returned, or its
recipient ended with a closed workspace (O8) - or says that it does not answer.
A sender's copy and its original are one message. An older number that two records hold as different
messages is refused as ambiguous, listing it for each workspace as `#m7 (workspace lab, 1a2b3c4d)`; an id
written that way reads that workspace's message (O2).

A message from a previous app session is available in its saved chat room, not in
the current mailbox. A request for that old number returns the saved history
location when retained, or says the saved history was deleted. A renderer recovery
that retains a live agent also retains that agent's current mailbox.

Each result opens with counts and contains the message number, sender, recipient,
time, reply reference, text length and delivery state at selection.

A recipient's own unread messages become delivered after this result is written
successfully. The state printed inside that result is the pre-delivery snapshot.

Repeated reads retain the same message number and content. The agent is responsible
for tracking what it has handled and recovering its own context. Facade keeps
delivery state, not a separate read history for each caller.

When the selected texts total at most 8,000 characters, return them inline.
Otherwise return one immutable UTF-8 snapshot file containing all selected messages,
plus a compact index and the path. The result tells the agent to read the whole
file before acting. The snapshot is created before returning its path, under the
caller's own workspace's record, whichever workspace holds the messages (O8). Every
supported CLI must be able to read message files with its effective sandbox,
without another approval; L14 verifies that launch capability.

A fetch takes all messages selected at its start. Messages arriving afterwards stay
unread for the next fetch. Serialize a recipient's fetches through result delivery:
one fetch settles before the next selects its unread set. This prevents accidental
simultaneous duplicate results; it does not require a distributed delivery protocol.

The result asks the agent to make newly received information visible in its terminal:
print a message up to 500 characters with its number and sender; summarize a longer
one in a sentence or two, retaining its number and source. This is instruction to
the agent, not a claim that Facade can verify what the model printed.

An empty fetch returns "No unread messages" and has no further effect.
A queued doorbell can legitimately cause an empty fetch after the mailbox was
already drained.

## M5. Doorbells and retry timing

A first doorbell is scheduled two seconds after an empty mailbox becomes nonempty.
Coalesce arrivals during those two seconds without moving the deadline later.
The terminal must exist, the run must be running, and its connection must be
available. A launch's taskDelay is an additional earliest-send bound for its first
typed task notice, as M7 specifies.

A doorbell is one line, then Enter:

```text
[facade] 2 unread messages: #m42 from @lead #a1, #m43 from @review #a4. Call read_messages.
```

Name at most five messages, then say how many more. Use the unread set at the time
the line is sent, not a stale set captured when the timer began.

Do not inspect the screen to infer whether the CLI is busy. Type the notice into
its ordinary input; a busy CLI must accept or queue it in the supported launch
configuration. Test that behavior for each supported CLI. If input is consumed by
an unexpected prompt, unread mail remains and the recovery path is M6/D7.

While the mailbox has not drained:

- Retry a successful ring's still-unread messages after 1, 2, 4 and 8 minutes,
  then every 15 minutes. Each interval is measured from the preceding ring.
- New messages can bring a ring forward: two seconds after the first such arrival,
  but at least one minute after the last successful ring.
- Choose the earlier of that new-message deadline and the retry deadline.
- One ring describes all currently unread messages. A burst does not enqueue one
  doorbell per message.

Once the mailbox drains, cancel its pending retry and reset the schedule. The next
empty-to-nonempty transition receives a fresh two-second doorbell, even if the last
conversation was less than a minute ago. Normal question-and-answer exchanges
must not inherit a one-minute pause.

A terminal/input failure records no successful ring and retries after one minute.
A disconnected run waits for reconnection; an ended run follows M6 instead.
Reload reconstructs timing from recorded message/ring facts without restarting an
already completed task.

Doorbells run automatically with either YOLO mode. There is no manual Ring
requirement, approval dialog or extra notification for every unread child message.

## M6. Human input, delayed delivery and returns

All programmatic terminal input uses the queue and human-input guard in D3.
If the person has pending input and typed within the last ten seconds, defer the
operation. It proceeds when they submit/cancel that line or when ten seconds pass
without another key. It may then append after their unfinished draft and submit
both. Facade does not preserve and restore an input field, wait indefinitely for
the draft, or introduce a takeover dialog.

The guard may postpone M5's scheduled time. It is checked when the queued operation
starts; it does not lock the person's keyboard. An Enter in an unexpected CLI menu
can be consumed by that menu. This design deliberately relies on straightforward
terminal input and agent-led debug recovery rather than a universal prompt detector.

If a recipient's current unread episode exceeds facade.agents.timeout from its
first due ring, send one delivery-delayed notice to the oldest unread user/agent
message whose sender is still live. A ring deferred by the input guard or a lost
connection still starts this clock. An episode containing only Facade notices
does not generate another delivery warning. Include recipient id, outstanding ids, delay reason where
known and the read_screen recovery hint. Coalesce the warning per unread episode;
do not send a warning for every retry or message. An initial task uses the dedicated
notice below instead of a duplicate generic warning.

An initial task not fetched within the timeout after the agent reaches running
produces one notice to its creator, even if no ring could be attempted.
It remains unread. Lack of a fetch is not evidence that the work failed or that the
agent should be stopped automatically.

When a recipient ends, return each unread user/agent message to its live sender
as a new Facade message:

```text
#m42 was not fetched by @lint #a3 before it ended (stopped by @human).
Original message: ...
```

If the sender has ended, record that the message could not be returned.
A sender of another workspace receives the return, and the delivery-delayed notice
above, from its own workspace: the recipient's workspace writes it into that
workspace's outbox, keyed by its kind and message number, and rings it (O8). A
sender's workspace that is reloading or silent takes it when it answers again; one
with its framework off takes it on re-enable, as M10 keeps its own; a notice
written twice is recorded once. A sender whose workspace is gone ended with it, and
the message is recorded as not returned. A message the person's script sent from
another workspace goes back to the person there, the same way. A workspace closing ends its agents, which
returns their unread mail like any end (AGENT-LAUNCHER.md L6). The notices of M7
and M8 to a creator of another workspace travel the same way.
Messages to @human and Facade-generated notices are never returned. This prevents
return-message loops. Returned originals remain readable by number while retained.

Do not return mail merely because a recipient is slow. Existing unread messages
continue to retry until fetched or until their recipient ends.

## M7. Tasks use the same mailbox

A start with a task records a message from its creator immediately after allocating
the run, before launching the CLI. The start result contains its number. A child
started in another workspace (O3) gets its task from that workspace, which records
and numbers it in the child's mailbox; the creator's workspace keeps the sender's
copy, as for any message between workspaces (M11).

The initial prompt is a short generated notice:

```text
[facade] You are @lint #a7, created by @lead #a1. Your task is #m12.
Call read_messages to fetch it, then carry it out.
```

The actual emitted notice is one line. Claude Code, Codex, Muse Code and Qwen Code
receive it in the launch's task argument group. A compatible custom agent does the same.
Antigravity receives it by terminal typing after its existing MCP warm-up and
taskDelay. Use the normal input queue and guard.

Task text itself never appears in the command line. A long task is retrieved
through the ordinary message-file path. Generated notice text is still passed
through correct platform argument quoting; being generated is not a quoting rule.

The argument notice counts as the first ring once its process is launched.
Antigravity's first typed ring is recorded once submitted. An interrupted notice
may be repeated with the same task number; retrieving that number does not create
another task. Do not maintain a separate task.typing/task.typed recovery protocol.

Readiness and task acceptance remain separate:

- start_agent returns started once the required MCP connection exists.
- The task stays unread until its read_messages result is delivered.
- Fetching is not completion. The agent reports its outcome through send_message.
- A child normally remains available after reporting; it does not stop itself merely
  because its conversational turn ended.

A start without a task has no task message or initial task notice. Its normal input
prompt can later receive a doorbell. Antigravity's necessary warm-up still applies.

## M8. Asking questions and reporting lifecycle

Default startup guidance is the same for every CLI:

1. Resolve ordinary implementation choices within the task.
2. A child needing clarification sends its creator a message and continues
   independent work where possible.
3. The creator answers from its context or escalates to its own creator.
4. A UI-started agent asks the person through its normal CLI interaction, including
   its question tools.
5. A root started through start_agent asks @human by message. With no available
   creator in the chain, a child may also ask @human directly.

Only agents started through start_agent, including the person's scripts as @human,
apply L4's supported blocking-question suppressions. UI-started agents keep their
normal question tools. Do not ask the person to visit a child and click
AskUserQuestion options. If a vendor tool cannot be disabled and still opens a
question, its creator can inspect and answer it using read_screen, type_text and
press_keys. Missing information follows the escalation path above.

These defaults are instructions and launch configuration. send_message retains
the ability to contact @human. A tech-lead skill can define stricter team procedure,
roles and escalation policy without changing the transport or the eight tools.

An agent reports a useful result to its creator: what happened, where the result
is, validation performed and any remaining decision. A report does not require a
commit or worktree deletion; those depend on the requested workflow.

Notify a live agent creator when a child process ends, including exit code 0:
the creator needs to know that the child is no longer available even if it never
sent a report. Suppress a notice for a stop the creator requested, an immediately
reported definitive start failure, and a workspace closing that ends the creator
too. A creator in another workspace is told as its child's workspace closes
(AGENT-LAUNCHER.md L6), its notice and the unfetched-task notice of M6 recorded by
its own workspace (O8); when that workspace's app crashes, the creator's own
workspace tells it (O8). If a start was previously reported unconfirmed
and then fails, send the notice.

A lifecycle notice contains the end reason, actor, exit code and D6's final-screen
excerpt when available. It does not claim a successful exit proves a successful task.
Human-root exit notifications remain L6's less noisy policy.

When the creator itself has ended, preserve the event in history; do not notify the
person about every descendant exit. A surviving child can use its retained creator
chain - across workspaces, as O11 keeps it - to choose the nearest available
ancestor for its next report or question.

## M9. The person's experience and saved history

The person normally writes directly into an agent terminal. That input is handled
by the CLI, has no Facade message number and is not copied into Facade chat rooms.
Facade chat rooms are histories of messages, not complete CLI transcripts.

For a message to @human, the sending agent prints its text in its own terminal
before sending the notification. The notification appears where the person directs
that tree: in the workspace of the sender's tree root, or in the sender's own
workspace when that root's workspace is closed. Show reveals the sender's terminal, bringing its window forward when it is
another workspace's - the person's explicit action, so no focus is stolen. Keep the
full message in history. The notification
shows the sender and a short first-line preview, with Show to reveal the terminal.
If the terminal has ended, Show opens the message in saved history.

Use one replaceable notification per sending agent. A new message updates it.
When that terminal is already focused, place the notification quietly in the
notification center instead of repeating a toast over the conversation. Otherwise
use a normal nonmodal notification. Respect VS Code's Do Not Disturb behavior.
The sender's choice to ask @human does not steal focus.

There is one saved **chat room** per human-created root. It contains messages to
or from that tree, with sender, recipient, time, number and reply reference.
Cross-tree messages appear in both histories. Chat rooms belong to the machine, not
to a workspace: one file per root in the Facade home, named by the root's number and
workspace, whichever workspaces its tree spans. Each message is written once into
each room it belongs to, by the workspace that records its original - its
recipient's, or for a message to @human its sender's - under a short lock on that
room, with each party's workspace named where it is not the root's. Open Chat Room
lists every room on the machine, naming the workspaces each spans. They are
ordinary readable Markdown artifacts; editing an artifact does not send a message.

| Command | Behavior |
| --- | --- |
| Agents: Open Chat Room... | List saved histories by most recent message and open the chosen one |
| Agents: Delete Chat Rooms... | Confirm deletion of saved history files and unused message attachments |

Delete Chat Rooms is history-file cleanup, not a reset of running agents or their
current-session mailboxes. The rooms are the machine's, so the confirmation says
what goes: how many rooms, and that they are every workspace's, not this one's
alone. It also states that current-session messages remain available to those
agents. With no room, it says so and asks nothing. Retain payloads still needed by the current
session, and remove them after that session ends if no retained history needs them.
Deletion removes the machine's rooms. Record a deletion watermark beside them - the
machine's message counter at that moment (AGENT-LAUNCHER.md L12) - so no workspace
regenerates old history files on reload. Later messages, numbered above it, can
begin a new saved history.

The person's scripts call send_message/read_messages as @human. Default unread
fetching has nothing to consume after human notifications are recorded delivered;
all or explicit ids reads the retained human mailbox of every workspace, each workspace
answering for its own (O8); a workspace silent past O8's query limit is named in
the result.
A script's reply_to may name a message to @human in any workspace; that workspace
confirms it.

## M10. Reload, shutdown and framework switch

A reload preserves messages, delivery facts and ring timing. Results
not confirmed written remain unread and may be returned again with the same ids.

A renderer crash with surviving agents behaves like a reload. After ordinary
shutdown, or an app crash with no surviving agents, end those runs before settling
returns so messages are not bounced between processes that are all gone.
Keep saved history. An ordinary fresh app start begins fresh mailboxes but continues
the message number sequence.

Framework off disables sends and fetches and cancels doorbells that have not
begun writing; an input operation already writing may finish. Lifecycle tracking
continues. Retain unread messages. Record ends and pending returns while off;
deliver the resulting notices only after re-enable to still-live recipients.
Re-enable resumes the retained mailbox schedule without re-sending a task as a
new message.

# Part 2: Technical Design

## M11. Mail service, record and terminal bridge

Keep the existing extension, shim and local pipe. Add a mail service and doorbell
scheduler inside the existing core; the tool contract maps to those services.
Use direct service calls for delivery decisions and VS Code events to observe
terminal/process changes.

```text
send_message -> record message -> mailbox -> doorbell scheduler -> terminal input queue
read_messages -> select/snapshot -> pipe result -> delivery record
agent end -> settle unread mail -> return/lifecycle messages
@human message -> history + native notification
```

A message record contains id, sender, recipient, text or payload-file reference,
length, time, optional reply/task marker and optional Facade notice kind.
Its delivery record contains unread/delivered/returned and the relevant times.

Use the workspace ledger, and the machine's message counter (L12) for numbers.
Relevant events are message.sent, message.delivered,
message.returned, mailbox.rang and the keys of notices taken from the outbox; the
saved-history deletion watermark lies beside the machine's chat rooms (M9).
Use the existing versioned-record mechanism; messages between workspaces take the
next ledger version (AGENT-LAUNCHER.md L12).

Store text up to 8,000 characters inline in the record; larger text and fetch
snapshots are UTF-8 files under the workspace record's messages directory.
Files are readable by the user and are not written into the repository.
Give each fetch snapshot a unique name so a later fetch cannot change a file
already handed to an agent. Retain files according to M9/M10: fetch snapshots last through their current
session, including reload/recovery; payload files last while a current mailbox or
retained history needs them. Remove obsolete snapshots at a fresh session start.
Saved chat-room files persist until explicitly deleted.

Sequence of a send:

1. Resolve and validate all arguments, recipients and reach.
2. Allocate recipient message ids and record the messages.
3. Update saved histories and schedule recipient doorbells/notifications.
4. Return the ids.

Only prevalidation is all-or-nothing. A storage failure while recording a multi-send
can have partial effects; return the recorded ids when known, otherwise unknown.
Do not introduce a distributed transaction to cover that unusual failure.
No automatic send retry is permitted after an ambiguous response.

A recipient of another workspace (O8) changes only where steps 2 and 3 happen:

1. The caller's workspace resolves and validates every recipient, asking their
   workspaces for state where needed; a workspace silent past O8's wait refuses
   the whole call.
2. For each such recipient, it sends that workspace one delivery: sender identity,
   text and reply reference. The recipient's workspace numbers it, records it - a long
   text as a file under its own record - writes it into the machine's chat rooms
   and schedules the doorbell, then answers with the number.
3. The caller's workspace records the sender's copy under that number - its full
   text, a long one as a file under its own record - for reading by number, and
   returns the ids.

The recipient's workspace is the authority for that message: its delivery state, its
return and its session. The sender's copy carries no delivery state of its own; a
return reaches the sender as a notice (M6), which also marks the copy returned, and
a crash of the recipient's workspace marks it as possibly never fetched (O8).

A recipient that the recipient's workspace finds ended at step 2 is refused for that
recipient alone, and the result reports each recipient's outcome. A workspace that
disappears between step 1 and its answer is a partial outcome, as a storage failure
is: the ids recorded so far, and that recipient's outcome unknown. reply_to names a
message addressed to the caller: an agent's mailbox is in its own workspace, and
@human's reply follows M9.

Sequence of a fetch:

1. Serialize access to that recipient's fetch operation.
2. Select messages and snapshot their delivery state; write a long-result file
   if required.
3. Have the pipe report whether its result write completed or the connection failed.
4. Record delivery only for the recipient's own messages on successful write;
   otherwise retain unread state. Release the fetch operation in either case.

A failed or timed-out pipe write must not hold the mailbox lock indefinitely.
Successful socket write is the chosen delivery boundary, not an end-to-end
acknowledgment from the model. There is no additional acknowledgment tool.

The workbench exposes observed human input through the shared D3 tracker.
It distinguishes actual typing/pasting from terminal-generated protocol replies
and from Facade's own writes. The scheduler asks for the next allowed input time;
it does not parse the CLI's input field.

The notification bridge uses VS Code notification handles to update/close by key:

| Key | Content |
| --- | --- |
| message:<agent> | That agent's current message to @human, in the workspace M9 names; another workspace's agent's is shown there at its workspace's request (O8) |
| message:facade:<agent> | A Facade notice about that agent |
| ended:<batch> | Coalesced human-root end notifications under L6 |

There is no unread:<agent> manual-Ring notification category.

Saved chat rooms append entries with stable message headings and full text.
Rebuild a missing or interrupted export from the retained record when possible -
each workspace adds the entries of its own originals that the room lacks - but never
re-export messages at or below the deletion watermark. Keep a small history
index for locating older ids; it is an index of artifacts, not a second source of
message truth.

All terminal typing, including initial Antigravity task notices, uses D3's queue.
Persist successful ring times and warned-episode facts needed for ordinary reload
recovery. Do not add vendor hooks, screen watchers or a background model.

# Part 3: Acceptance

## M12. Messaging acceptance matrix

Use L14's evidence gate and U/I/V/H modes. Verify message state in the record as
well as visible behavior; successful send alone is not an end-to-end pass.

| ID | Scenario | Required outcome | Mode |
| --- | --- | --- | --- |
| MS-01 | Send to agent, self, creator and @human | Distinct stable ids; immediate result; correct mailbox/history/notification | U,I,V |
| MS-02 | Several recipients, duplicate aliases, one invalid target | One message per distinct identity; invalid preflight sends nothing | U,I |
| MS-03 | Starting, disconnected, unintegrated, stopping and ended recipients | Accept only recoverably deliverable targets; clear capability/state errors | U,I |
| MS-04 | Both YOLO modes across two trees | Sending/reading scope holds; asymmetric reply limitation reported; @human reachable | U,I |
| MS-05 | reply_to valid/invalid; wrong id kind; unknown argument; empty text | Whole-request validation with actionable errors | U,I |
| MS-06 | Unread fetch, ids fetch and all | Correct selection, order and delivery states; another reader does not deliver the recipient's mail | U,I,V |
| MS-07 | 8,000-character boundary, 20,000-character task and many small messages | Correct inline/file path; full content accessible without approval in both modes | U,V |
| MS-08 | Concurrent fetches and arrivals during a fetch | Unread fetches serialize through delivery; later arrivals remain for the next fetch | U,I |
| MS-09 | Disconnect before result write, after write and while reading a file | Documented delivery boundary; retries retain message ids; no false execution claim | I,V |
| MS-10 | Three arrivals in two seconds; multiple unread senders | One coalesced doorbell using the current unread set | U,I,V |
| MS-11 | Mailbox drained, then reply within the same minute | Fresh two-second schedule; no inherited one-minute delay | U,I,V |
| MS-12 | Unread retries and new arrivals during backoff | 1/2/4/8/15-minute schedule and new-message bound; no per-message flood | U,I |
| MS-13 | Recipient idle, busy on a long tool call, and freshly connected | Each supported CLI takes/queues the doorbell and eventually fetches | V,H |
| MS-14 | Person typing continuously, submitting, cancelling, or pausing ten seconds | D3 guard and deliberate draft-submission behavior; no indefinite wait after pause | U,I,V,H |
| MS-15 | YOLO off, precise exemption and all-tools fallback | Automatic send/fetch/doorbell; no manual Ring or Facade approval | V,H |
| MS-16 | Ordinary mail delayed; initial task never fetched | One useful delay notice per episode/task, to the correct sender/creator | U,I,V |
| MS-17 | Recipient ends before fetch; sender also ends; Facade notice undelivered | Correct returns/history, with no bounce loop | U,I |
| MS-18 | Initial task for every CLI, including Antigravity warm-up | One numbered task; short bootstrap notice; actual body only through read_messages | V,H |
| MS-19 | Start with no task, then send a task | Agent wakes and works without a relaunch or manual first prompt | V,H |
| MS-20 | Reload between task notice text/Enter and during fetch | Same task id; retries do not allocate another task; ambiguity accurately reported | I,V |
| MS-21 | Child question, parent escalation and orphan child | Default parent-first messages; no child AskUserQuestion visit requested | V,H |
| MS-22 | Child exit 0 without report, unexpected failure and creator-requested stop | Creator learns relevant ends; requested stop not duplicated; no inferred success | I,V |
| MS-23 | Message to focused/background root; repeated message; DND | Quiet foreground behavior, replacement notification and correct Show target | I,V,H |
| MS-24 | Source terminal ends before Show | Full message available in saved history | I,H |
| MS-25 | Cross-tree history, quit/reload, history deletion and later messages | Correct copies and lifetimes; no deleted export resurrection; live mailbox retained | U,I,H |
| MS-26 | Framework off during unread mail and recipient exit, then on | No new ring starts while off; correct retained mail/returns afterwards | I,V |
| MS-27 | Send reply lost or storage fails during multi-send | No hidden retry; known ids/partial outcome reported | I |
| MS-28 | Fetch a retained task again by id or all:true | Same message number and content; no new task allocated | U,I |
| MS-29 | Agent of workspace A sends to an agent of workspace B, which replies; a 20,000-character message; several recipients across both workspaces, one of B's ending meanwhile; A and B sending to each other at once while each also sends locally | Doorbells in B, then A; one number per recipient, unique on the machine; each record takes the other's lower numbers; the tree's one chat room holds each message once; long text readable as a file in both; the ended recipient refused alone | U,I,V |
| MS-30 | Read by number, across workspaces, in both YOLO modes and as @human: unread, after B's agent fetches it, after it is returned, while B does not answer; an older number A and B both hold, read from A; @human all:true and a reply_to into B's human mailbox | YOLO on and @human read any current-session message with B's delivery state, or a note that B does not answer; YOLO off only its tree's; reading delivers nothing for the recipient; the older shared number is refused as ambiguous, a sender's copy never is; @human reads and replies across workspaces | U,I |
| MS-31 | Recipient in B ends or B closes with A's mail unread; A reloads or turns its framework off as B's recipient ends; A's sender ends or A closes first; B's notice is written twice; B is silent during a send; B's app crashes with A's mail unread | Return reaches A's live sender once, after A's reload or re-enable; a gone sender's return is recorded as not returned; the silent send is refused after the short wait or reported partial, never resent; after the crash A's sender is told which messages may never have been fetched, and reading the copy says so | U,I,V |
| MS-32 | An agent of workspace A starts a child in workspace B with a task; the child does not fetch it in time, then reports, then ends; B closes with another child of A running | The task is numbered and rung in B, its copy in A; A's agent is told of the unfetched task and of each end, also as B closes; the tree's one chat room holds the exchange | U,I,V |
| MS-33 | A tree rooted in workspace A has a child in B that messages @human while the person works in A; A's root workspace closes, and the child messages again; the person shows each; Delete Chat Rooms from B; both workspaces reload | The first notification appears in A and Show brings B forward on the child's terminal; after A closes it appears in B; Open Chat Room in either lists the machine's rooms, the tree's room naming both workspaces; deletion removes them for both and neither reload brings deleted history back | I,H |

Use fake recipients and a controllable clock for mailbox order, warning coalescing,
timers and reload. A small deterministic failure suite is sufficient; randomized
fault scheduling may supplement it but is not required to replace the live cases.

## M13. End-to-end communication gate

On a supported test OS, verify each built-in can send and fetch messages and receive
doorbells both while idle and during work. Include representative mixed-vendor
communication in the journey below, reusing O13's runs under L14's coverage policy.
On other supported operating systems, cover each CLI in both roles plus
platform-specific input/file access behavior.

The primary journey is a root delegating to two children, receiving a question,
answering it, receiving both results and summarizing to the person. A second
journey runs between two workspaces: a root in one starts a child in a folder of the
other, asks it for a result, gets a question back, answers and receives the result. Type a human
correction during a child report, then repeat with a ten-second unfinished draft.
The person should be able to remain in the root's terminal throughout.

The recovery journey blocks a child before its first fetch, lets the timeout warn
the parent, and has the parent inspect and repair it using the debug tools.
Also end a child after it fetched its task but before reporting, and verify the
parent receives the lifecycle notice rather than waiting for a nonexistent reply.

A pass requires the messages' numbers, content, delivery facts, printed summaries,
notifications and saved history to agree. Record vendor input behavior explicitly;
a message appearing in the terminal's input field without reaching the model is
not an end-to-end delivery pass.
