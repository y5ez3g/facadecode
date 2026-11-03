# Collaboration

Layer 3. Facade exposes operations, not a team workflow. [RULES-1](../RULES.md#1-agent-messages) owns delivery;
[MCP](../engineering/MCP.md) owns schemas. This document owns visible messages, history and collaboration surfaces.

| Group | Decides | Implementation evidence |
| --- | --- | --- |
| 1 Agent operations | Cross-window discovery, launch and terminal access | Pending |
| 2 Message experience | Payloads, creation prompt, human contact and errors | Pending |
| 3 History | Own inbox, window-local message history and automatic retention | Pending |
| 4 Technical design | Message records, rendering and cross-environment content | Pending |

## 1 Agent operations

### 1.1 One connected network

**Agents can operate across local/remote windows within their YOLO/creation-tree reach; human UI stays in its own window.**

The network is every Facade window open on this client computer, whatever execution environment each one uses.
Startup discovery includes open windows, valid locations and actual CLI choices, including empty-agent windows.
RULES-4.3 owns run YOLO and reach. A new child joins its creator's tree even when placed in another window.
Startup arguments follow MCP-2.2. Agent-created runs appear in the destination without changing human focus.
A disconnected window is not an absent agent. A cross-window failure states whether the request never reached the
execution path or whether its answer is missing; only the latter leaves an earlier effect uncertain.
No automatic child-idle, completion or exit reports are generated. Organization and reporting belong to prompt/skill.

### 1.2 Screens and deliberate terminal control

**Read screen observes; direct text and keys execute the caller's input without draft protection or an input-policy choice.**

Read rendered text without taking focus. Ended runs can expose a retained last screen with its observation time.
Direct input can edit, clear or submit a draft or operate a menu. Facade applies the requested text/keys and optional
Enter, reports what was written, and does not decide how the agent should operate its CLI. Do not add a single-line,
character/byte cap, compulsory screen-read step or extra confirmation. Preserve newlines/tabs and supplied text.
Direct operations share terminal serialization with ordinary messages; no interleaving or invented keys.
Ordinary send_message and post-start prompt/result delivery still protect drafts under RULES-1.4. Raw input does not
claim ordinary-message support. A frame returned after typing is observation, not proof of submission or model reading.

## 2 Message experience

### 2.1 Complete content with a clear author

**An agent message submits its full content, with a small identity header, to the recipient's CLI.**

Format (English terminal text):

```text
📨 Message from Ada (#a7) · #m42
<complete original text>
```

A reply adds `Reply to #m39` to the header; another window adds `From Design`. Same-window delivery omits the window.
Names are bounded single-line display text; empty names use the short ID alone. Bodies are data: control bytes and terminal
escapes are rejected by MCP validation; ordinary Unicode, blank lines and newlines are preserved without truncation.
There is no closing label, JSON wrapper, generic read_messages instruction or fetch-body notice. Each ordinary message is
one paste and one submission. Native adaptation may type the notification header before pasting the body when a CLI
requires typed context to treat pasted content as a request; it adds no extra message or model turn. Input already started
keeps its original rendered text through reload; formatting changes never trigger a second paste.
The header's message ID is the same across retries under RULES-1.1; MCP-6.2 teaches the receiving model to deduplicate it.
Oversized content fails before writing with the supported limit; a caller can explicitly send a file-reference message.
A path in such a message is just text; Facade never assumes a remote path is readable in another environment.

### 2.2 System results and creation prompt

**System results are Facade facts; a creation prompt is an ordinary message supplied by the caller.**

A system result starts with 🔔 and reports actual facts in natural English, without JSON or a closing label. Confirmed
delivery says `Your message #m42 has been passed on to Ada (#a7).` It references the original message, not a second visible
receipt number. An async start/stop result uses its reserved message number under MCP-1.3. Full call IDs stay in structured
records. Partial input, uncertain submission, process/tools/prompt distinctions and created worktrees remain explicit;
ordinary success needs no boilerplate. Receipt delivery is separate from the operation it reports. Existing permission,
question and sign-in notices use the same voice without changing recipients, frequency or authority.
An unavailable window before execution says the message could not be sent and confirms untouched input only when known.
After forwarding without an answer, it says delivery could not be confirmed; it never recommends a blind resend.
These distinctions refine existing failure notifications; they add no new notification or recipient.
These are Facade facts, not replies authored by the recipient, and request no response. An unreachable result ends;
do not notify a person, send another error to B, or resend the original content.
Use the native interactive prompt argument that CLIS-3.2 maps for the CLI, even while it is unverified, and report its
capability state with the prompt outcome. Without a mapping, start the CLI and automatically send the same prompt after
process startup through ordinary message delivery. The caller does not need to compensate for CLI differences. Start
that delivery budget when the CLI process starts, not after waiting indefinitely for ready.
Where a CLI's first turn could not use the Facade tools - Antigravity, which starts a folder's plugin servers only with
its first turn or its MCP panel - its start types what readies them before any other input: once its input first reads
empty, `/mcp` and Enter, then Escape once its panel shows the server ready or after ten seconds. It is given up, typing
nothing, where the input first reads anything else or the CLI is working: the person's own first turn then starts the
tools for the turns after it. Its creation prompt goes after that, as its first message, the budget starting then
(D100).
A blocked input box consumes the normal attempts. Both paths use RULES-1.3's meaning of delivery; native acceptance
does not require a terminal Enter effect.
Report process startup and prompt input separately. Failed prompt submission leaves the started agent available.
An unverified native prompt remains unconfirmed in its record and human history; it is neither confirmed delivery nor
a continuing background delivery. Reading its complete record can subsequently deliver it without another paste.
MCP-2.3 owns the final report when prompt input remains pending after process startup.
Do not duplicate a confirmed native prompt through the post-start path; uncertainty follows finite at-least-once rules.
There is no task, task result, child completion report or replay of a creation prompt.

### 2.3 Contacting the person

**An explicit send to the person notifies only the sender's window.**

Use a native information notification that names the source agent and shows a short plain-text summary, with actions
that open the complete saved message and the agent's terminal (UX-1.2). Existing terminal visibility does not suppress
an explicit call. Distinct calls remain distinct records. Success means handoff to the editor, not human reading or
action. A closed source window does not redirect the notification elsewhere or replay it on a later opening. Return a
reachable calling agent's error when delivery fails; otherwise end the report. No inferred urgency, inactivity or
failed agent-to-agent delivery automatically uses this path.

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

System-result records may retain structured operation facts beside their existing human-readable text. The agent gets
the structured facts in its receipt or MCP read; Message History keeps the readable text. Ordinary message bodies and
older text-only system results stay intact. Both representations identify the same operation and effects (MCP-1.2).

read_messages without IDs returns the caller's incoming records that are not yet delivered; all:true pages all retained
incoming records. Explicit IDs also resolve only inside the caller's inbox. Other agents' inboxes and the caller's own
sent messages are unavailable through this tool, including in YOLO. A message has one delivery state (RULES-1.3);
there is no separate fetch state. Its sender's result immediately says it was delivered through read_messages.
An unstarted paste is canceled; an already pasted complete owned draft may finish under RULES-1.5, with the same
message ID so the recipient recognizes the repeat. No person's edited draft is submitted or erased. A record
that reached its deadline undelivered and is read later becomes delivered; its sender already has the failure result
and receives no second one. An uncertain return can expose a record again with the same ID without another terminal
submission. No understanding or completion claim is inferred from reading.

### 3.2 Message history documents

**Message History is a read-only record of messages involving this window's agents.**

Use the command/picker title `Message History...`, not Chat Room. List one-to-one conversations by recent activity,
then show source, recipient, time, body, reply relation, delivery outcome and system-result references.
History may contain records from previous openings of this workspace within retention. Its UI does not expose a
client-wide or cross-window management surface. Each record labels its own transport outcome `Delivery`; a system result
then gives the readable operation outcome, with complete structured facts below it. It is Facade message history, not the vendor's whole CLI conversation.
No live composer, send/replay control, group conversation or delete/hide control is added. Render message content as
text; do not execute links or commands embedded in it.
Start/stop results retain the operation name and execution window explicitly, with the target's recorded short identity;
history labels the operation and agent without inferring them from prose. Full call/request IDs and route fields belong
below the original body in localized Technical details, together with the unchanged operation result. A reserved receipt
ID is not a fabricated record. Missing/expired original messages keep their references without invented content.

### 3.3 History retention

**Facade message history is view-only and uses the automatic retention in RULES-5.3.**

Do not provide manual Delete Messages/Chat Rooms, hide or restore-hidden actions. Expiration removes Facade's own
records and associated copies, not vendor conversations or work files. Request IDs on those records follow MCP-1.1's
one-hour reuse rule; no separate request ledger or deletion-consent workflow is required.

## 4 Technical design

### 4.1 Authoritative delivery record

**One message record supplies delivery results and history without a separate escalation subsystem.**

Keep message ID, sender/target run IDs, window/environment, original content, acceptance/deadline, current attempts
and actual outcome. The recipient's window owns the authoritative record and its terminal input; the sender's window
keeps its own copy of the messages its agents send, updated with the result it is given, so each window's Message
History stays local. A copy whose result never came back - a lost route, a window gone - reads as unconfirmed once its
deadline passed, never as still being delivered (D132). Internal bookkeeping can number operations; no public operation query or caller dedup key follows.
The execution owner serializes input; the client routes messages and the direct result. No authentication, delegated
proof or durable notification receipts are required. Sender closure follows the natural handover in RULES-1.9.
There are no doorbells, indefinite reminders, idle gates, automatic child reports or human fallback paths.

### 4.2 Cross-environment content

**Long read results are complete and available in the caller's execution environment.**

When screen/history content exceeds the inline result limit in MCP, write the full result as a temporary UTF-8 file
and return its readable path, size and source. Across environments, transfer that generated result before returning
the path; an inaccessible remote path is not a successful read. This is not arbitrary file transfer.
A transfer failure fails the read, not an already completed input operation. Message files are temporary copies:
if any included message expires, delete the whole file; a later read regenerates still-retained messages.
Screen-result files use the ordinary thirty-day diagnostic cleanup. Human history uses a read-only editor document.
Do not add protected-storage or authentication protocols to this generated-content transport.

## Checks

| Rules | Acceptance |
| --- | --- |
| 1.1–1.2 | Local/remote reach under RULES-4.3 across this computer's windows, direct text/keys with drafts and multiline content |
| 2.1–2.4 | Full CLI acceptance, repeated message IDs, native and post-start prompt, truthful result author, `#human` notification, no human message fallback |
| 3.1–3.3 | Own inbox only, one delivery state, reading cancels unstarted pastes and reports delivery, owned-draft completion under RULES-1.5, window-local Message History, thirty-day automatic cleanup |
| 4.1–4.2 | Recipient-owned record with a sender copy, natural sender-close handling, no replay, complete readable cross-environment files and expiry |

Evidence: [Verification](../engineering/VERIFICATION.md). Runtime behavior remains unverified.

## Change log

- 2026-11-01: D149 keeps unverified native prompt acceptance unconfirmed in machine results and readable history.

- 2026-11-01: 4.1 shows a sender's copy whose result never came back as unconfirmed after its deadline (D132).
- 2026-11-01: D148 separates structured system receipts for agents from readable Message History text, preserving
  ordinary bodies, old records, correlation and the existing delivery handoff.

- 2026-11-01: Describe competitive-analysis findings without naming individual products; message behavior is unchanged.
- 2026-10-31: 3.1 follows RULES-1.5's completion of an already pasted owned draft after read delivery (D119).
- 2026-10-31: 2.1 types `Act on this Facade message: ` before a message's paste for Claude Code (D108).
- 2026-10-31: 2.2 types what readies a CLI's tools before its first turn where that turn could not use them otherwise -
  Antigravity's MCP panel - and sends its creation prompt after it (D100).
- 2026-10-30: Step 2 of the Facade Code extension, carried from the Facade Dots collaboration rules with the owner's
  2026-10-30 decisions: one delivery state, in which read_messages delivers and stops a pending paste (D88); `#human`
  for the person (D91); the recipient's window owns the delivery record and the sender's keeps a copy (D93). Resume,
  Pin and panel filters are later steps.
