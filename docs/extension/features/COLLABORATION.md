# Collaboration

Layer 3. Facade exposes operations, not a team workflow. [RULES-1](../RULES.md#1-agent-messages) owns delivery;
[MCP](../engineering/MCP.md) owns schemas. This document owns visible messages, message records and collaboration
surfaces.

| Group | Decides |
| --- | --- |
| 1 Agent operations | Cross-window discovery, launch and terminal access |
| 2 Message experience | Payloads, creation prompt, human contact and errors |
| 3 History | Own inbox, window-local message records and automatic retention |
| 4 Technical design | Message records, rendering and cross-environment content |

## 1 Agent operations

### 1.1 One connected network

**Agents can operate across local/remote windows within their YOLO/creation-tree reach; human UI stays in its own window.**

The network is every Facade window open on this client computer, whatever execution environment each one uses.
Startup discovery (MCP-3.1) includes open windows, valid locations and actual CLI choices, including empty-agent
windows. RULES-4.3 owns run YOLO and reach. The caller's window answers each call; an effect on another window's agent
or location - a start, a stop, a screen read, direct input or a message's delivery - is made by that window. A new child
joins its creator's tree even when placed in another window. Startup arguments follow MCP-2.2. Agent-created runs
appear in the destination without changing human focus.
A disconnected window is not an absent agent. A cross-window failure states whether the request never reached the
execution path or whether its answer is missing; only the latter leaves an earlier effect uncertain.
No automatic child-idle, completion or exit reports are generated; RULES-1.8's notice of a waiting child is the one
automatic report to a creator. Organization and reporting belong to prompt/skill.

### 1.2 Screens and deliberate terminal control

**Read screen observes; direct text and keys execute the caller's input without draft protection or an input-policy choice.**

Read rendered text without taking focus. Ended runs can expose a retained last screen with its observation time. Direct
input can edit, clear or submit a draft or operate a menu. Facade applies the requested text/keys and optional Enter,
reports what was written, and does not decide how the agent should operate its CLI. There is no single-line or
text-length cap; one call's size is bounded only by RULES-5.3's fixed runtime buffer (MCP-5.2). There is no compulsory
screen-read step or extra confirmation. Preserve newlines/tabs and supplied text. Direct operations share terminal
serialization with ordinary messages; no interleaving or invented keys. Ordinary send_message and post-start
prompt/result delivery still protect drafts under RULES-1.4. Raw input does not claim ordinary-message support, and it
also reaches a CLI that has no input reader. Direct input returns its input effects, not a screen; a screen read
afterwards is observation, not proof of submission or model reading.

## 2 Message experience

### 2.1 Complete content with a clear author

**An agent message submits its full content, with a small identity header, to the recipient's CLI.**

Format (English terminal text):

```text
📨 Message from Ada (#a7) · #m42
<complete original text>
```

A message from another window's agent adds ` · From Design`, that window's name, to the header line, and a reply adds
` · Reply to #m39` after it; same-window delivery omits the window. Names are bounded single-line display text; empty
names use the short ID alone. Bodies are data: control bytes and terminal escapes are rejected by MCP validation;
ordinary Unicode, blank lines and newlines are preserved without truncation. There is no closing label, JSON wrapper,
generic read_messages instruction or fetch-body notice. Each ordinary message is one paste and one submission.
Claude Code takes a paste alone as pasted material rather than as a request, so for Claude Code alone the header's first
words, `📨 Message from `, are typed in the same write ahead of a bracketed paste of the rest of the header and the body
(CLIS-2.1); every other CLI gets the whole text as one paste, and a Facade result has no typed lead. This adds no
message or model turn. Input already started keeps its original rendered text through reload, and a message keeps the
window name its header was first made with; formatting changes never trigger a second paste.
The header's message ID stays the same through the message's whole delivery (RULES-1.1); MCP-6.2 teaches the receiving
model to recognize a repeat by it. Oversized content fails before writing with the supported limit (MCP-4.1); a caller
can explicitly send a file-reference message. A path in such a message is just text; Facade never assumes a remote path
is readable in another environment.

### 2.2 System results and creation prompt

**System results are Facade facts; a creation prompt is an ordinary message supplied by the caller.**

A system result starts with 🔔 and reports actual facts in natural English, without JSON or a closing label. An
ordinary message has none: its send answers with its outcome (RULES-1.2, 1.7). A start's result that reports its prompt
delivered says `Your initial message #m42 has been passed on.` - ` through read_messages` before the period where a read
delivered it, ` with the launch` where its CLI took it as its start argument - referencing the original message, not a
second visible receipt number. A start or stop
result, and RULES-1.8's notice of a waiting child, end their first line with ` · #mN`, their own message number - for a
start or stop the one MCP-1.3 reserved. Full call IDs stay in structured records. Partial input, uncertain submission,
process/tools/prompt distinctions and created worktrees remain explicit; ordinary success needs no boilerplate. Receipt
delivery is separate from the operation it reports. RULES-1.8's notice uses the same voice - who waits, on what, and who
can answer - without changing its recipient, frequency or authority. A send's failure answer (MCP-4.1), where the
window was unavailable before execution, says the message could not be sent and confirms untouched input only when
known; after forwarding without an answer, it says delivery could not be confirmed; it never recommends a blind
resend. These wordings add no notification or recipient.
They are Facade facts, not replies authored by the recipient, and request no response. An unreachable result ends; do
not notify a person, send another error to B, or resend the original content. Use the native interactive prompt argument
that CLIS-3.2 maps for the CLI, even while it is unverified, and report its capability state with the prompt outcome.
Without a mapping, start the CLI and automatically send the same prompt after process startup through ordinary message
delivery. Either path gives the CLI the prompt with its 📨 header (2.1), under the message ID its record keeps. The
caller does not need to compensate for CLI differences. Start that delivery budget when the CLI process starts, not
after waiting indefinitely for ready. Where a CLI's first turn could not use the Facade tools - Antigravity, which
starts a folder's plugin servers only with its first turn or its MCP panel - its start types what readies them before
any other input. Once its input first reads empty, within thirty seconds, it types `/mcp`, then Enter once that alone
shows in the input, within two seconds; then Escape as soon as the panel shows the server ready, or after ten seconds
while the panel is still open. It is given up, typing nothing, where the input first reads anything else or nothing
within those thirty seconds, or the CLI is working, and Enter is not pressed where `/mcp` does not show alone: the
person's own first turn then starts the tools for the turns after it. Its creation prompt goes after that, as its first
message, its budget starting as that preparation is done or given up - never sooner because the start answered, which it
does once the process runs (MCP-2.3). A window reloaded during the preparation skips what is left of it, as it is kept
in memory alone: the prompt goes as the input allows, and that first turn may lack the tools. Until that prompt is
delivered or given up, its preparation included, the run's input is held for it (RULES-1.10): a message sent meanwhile
goes after it, within its own thirty seconds (RULES-1.5). A blocked input
box consumes the normal attempts. Both paths use RULES-1.3's meaning of delivery; native acceptance does not require a
terminal Enter effect. Report process startup and prompt input separately. Failed prompt submission leaves the started
agent available. An unverified native prompt remains unconfirmed in its record; it is neither confirmed delivery nor a
continuing background delivery. Reading its complete record through read_messages then delivers it without another
paste. MCP-2.3 owns the final report when prompt input remains pending after process startup. A native prompt, confirmed
or not, is never sent again through the post-start path, and no prompt is typed twice (RULES-1.6). There is no task,
task result, child completion report or replay of a creation prompt.

### 2.3 Contacting the person

**An explicit send to the person notifies only the sender's window.**

Use a native information notification that names the source agent with its short ID and shows the message's first
line, with Open Message, which opens the complete saved message (3.2), and Show Agent, which opens the agent's terminal
(UX-1.2). Existing terminal visibility does not suppress an explicit call. Distinct calls remain distinct records.
Success means handoff to the editor, not human reading or action. A closed source window does not redirect the
notification elsewhere or replay it on a later opening. Return a reachable calling agent's error when delivery fails;
otherwise end the report. No inferred urgency, inactivity or failed agent-to-agent delivery automatically uses this path.

### 2.4 Errors shown to the person

**Errors go to their initiator; only appropriate human errors appear in the related window.**

A human UI failure reports to that person. A tool/launch/message/input failure initiated by an agent reports to that
agent, without an additional popup. An agent's unreachable result is dropped, not escalated.
Known runtime/infrastructure failures with no agent able to handle them follow RULES-1.8; unknown exit cause is not
a guessed error. There is no durable exactly-once notification or human-fallback recovery machinery.
Show opens the actual run/record in this window, never a same-named replacement or another window's agent.

## 3 History

### 3.1 Reading delivers the record

**A record handed back by read_messages is delivered; reading starts no new terminal paste.**

System-result records may retain structured operation facts beside their human-readable text. The 🔔 text typed into
the agent's terminal is the readable text; read_messages returns the structured facts as `result` (MCP-4.2). Ordinary
message bodies and text-only system results, such as RULES-1.8's notice, stay exact. Both representations identify the
same operation and effects (MCP-1.2).

read_messages without IDs returns the caller's incoming records that are not yet delivered; all:true pages all retained
incoming records. Explicit IDs also resolve only inside the caller's inbox. Other agents' inboxes and the caller's own
sent messages are unavailable through this tool, including in YOLO. A message has one delivery state (RULES-1.3);
there is no separate fetch state. Every record a read hands back is delivered, however it was selected, and the sender's
result of a message still being delivered immediately says it was delivered through read_messages.
An unstarted paste is canceled; an already pasted complete owned draft may finish under RULES-1.5, with the same
message ID so the recipient recognizes the repeat. No person's edited draft is submitted or erased. A record
that reached its deadline undelivered and is read later becomes delivered; its sender already has the failure result
and receives no second one. An uncertain return can expose a record again with the same ID without another terminal
submission. No understanding or completion claim is inferred from reading.

### 3.2 Message records

**Facade keeps a read-only record of the messages involving this window's agents; the person opens one from its notification.**

A message to the person opens from its notification's Open Message (2.3) as a read-only document of its saved record,
read as it is when opened: its ID and time, source, recipient, reply relation, its delivery outcome labeled `Delivery`,
the complete body and, below it, localized Technical details with its call and request IDs and window. A record that
has expired opens as no longer available. No command or view lists the records: agents read their own inbox through
read_messages (MCP-4.2), and a request_id retry finds its original record (MCP-1.1). Records from previous openings of
this workspace remain within retention. A record is Facade's record of a message, not the vendor's whole CLI
conversation. No live composer, send/replay control, group conversation or delete/hide control is added. Render message
content as text; do not execute links or commands embedded in it.
A start or stop result records its operation and execution window explicitly, with the target's recorded short
identity, never inferred from its prose. A reserved receipt ID is not a fabricated record. Missing/expired original
messages keep their references without invented content.

### 3.3 History retention

**Facade's message records are read-only and use the automatic retention in RULES-5.3.**

There are no manual delete, hide or restore actions. Expiration removes Facade's own records, the sender's copies (4.1)
and the result files that hold them (4.2), not vendor conversations or work files. Request IDs on those records follow
MCP-1.1's one-hour reuse rule; no separate request ledger or deletion-consent workflow is required.

## 4 Technical design

### 4.1 Authoritative delivery record

**One message record supplies delivery results and history without a separate escalation subsystem.**

Keep message ID, sender/target run IDs, window/environment, original content, acceptance/deadline, current attempts
and actual outcome, with the originating call ID and the sender's request ID where given. The recipient's window owns
the authoritative record and its terminal input. The sender's window keeps a copy of each message its agents send to
another window's agent, updated with the result it is given; a request_id retry finds that copy and asks the window
that holds the message (MCP-1.1), and a copy whose answer was lost keeps its outcome unknown, never read as delivered.
Internal bookkeeping can number operations; no public operation query follows, and MCP-1.1's optional request_id, kept
on the record, is the only caller key. The execution owner serializes input; the client network routes messages and
the direct result. No authentication, delegated proof or durable notification receipts are required. Sender closure
follows the natural handover in RULES-1.9.
There are no doorbells, indefinite reminders, idle gates, automatic child idle, completion or exit reports or human
fallback paths; RULES-1.8's notice of a waiting child is the one automatic report to a creator.

### 4.2 Cross-environment content

**Long read results are complete and available in the caller's execution environment.**

When a read_screen or read_messages result exceeds MCP's inline limit, write the full result as a temporary UTF-8 file
in the `results` folder of the caller's execution environment's Facade directory and return its path, its size in bytes
and its code points. A screen read in another window comes back whole, and the caller's window writes its file; an
inaccessible remote path is not a successful read. This is not arbitrary file transfer.
A transfer failure fails the read, not an already completed input operation. Message files are temporary copies:
if any included message expires, delete the whole file; a later read regenerates still-retained messages.
Screen-result files use the ordinary thirty-day diagnostic cleanup. The person's view of a message is 3.2's read-only
document, not a result file. Do not add protected-storage or authentication protocols to this generated-content
transport.

## Checks

| Rules | Acceptance |
| --- | --- |
| 1.1–1.2 | Local/remote reach under RULES-4.3 across this computer's windows, direct text/keys with drafts and multiline content |
| 2.1–2.4 | Full CLI acceptance, Claude Code's typed lead, repeated message IDs, native and post-start prompt, truthful result author, `#human` notification, no human message fallback |
| 3.1–3.3 | Own inbox only, one delivery state, reading cancels unstarted pastes and reports delivery, owned-draft completion under RULES-1.5, window-local records, a message to the person opened from its notification, thirty-day automatic cleanup |
| 4.1–4.2 | Recipient-owned record with a sender copy, natural sender-close handling, no replay, complete readable cross-environment files and expiry |

[Verification](../engineering/VERIFICATION.md) owns the evidence.
