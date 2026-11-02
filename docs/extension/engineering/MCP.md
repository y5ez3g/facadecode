# MCP contract

Layer 4. Protocol **5** defines the target contract. [Rules](../RULES.md) owns effects and
[Collaboration](../features/COLLABORATION.md) owns message experience. This document does not certify implementation.

| Group | Decides |
| --- | --- |
| 1 Common contract | Nine tools, outcomes, waits and validation |
| 2 Discover and start | Startup choices, required identity/location and optional prompt |
| 3 Inspect and stop | Scoped agent lists and single-agent stop |
| 4 Messages and history | One recipient, result reports and own inbox |
| 5 Terminal operations | Screen, unrestricted direct text and keys |
| 6 Technical design | Run routing, injection, versioning and schema ownership |

## 1 Common contract

### 1.1 Tools and validation

**Expose nine English tool contracts; validate complete arguments before effects.**

Tools in order: `list_start_options`, `start_agent`, `list_agents`, `stop_agent`, `send_message`,
`read_messages`, `read_screen`, `type_text`, `press_keys`.
Do not expose get_operation, cancel_message, rename, independent worktree creation/deletion or batch stop.

Arguments are JSON objects with known keys and correct types; do not coerce missing choices into defaults except where
explicitly allowed below. Every advertised argument has a JSON Schema `type` and no `oneOf`, so that every model provider
takes the tool list; a list argument also takes a single string, or the list written as JSON text, as some CLIs send
it (D102). Return missing required arguments together.
IDs are nonempty strings; references accept exact IDs and RULES-2.3's `#aN`, `@name`, or display-name-plus-ID form,
plus the person's `#human`. Names can repeat; ambiguity requires an ID. A reference resolves once within the caller's
normal reach.

start_agent and send_message take an optional `request_id` of the caller's own: the same one again from that caller
within an hour answers what the first call started or sent, as it stands, and does nothing again. Competitive analysis
informed this request-identity approach to retries after a lost answer (D110). It is kept on the
run or message record - a message to another window's agent carries it there, where its record is made - and a repeated
start answers as its start went: accepted while its process still starts, the start's failure where it could not start,
success otherwise (D118). Concurrent calls share that operation. The recipient deduplicates a routed send before input,
so a lost route reply cannot make a retry send again. A send whose route answer was lost, so that the message may have
arrived, keeps the sender's copy with its outcome unknown; a retry with the same `request_id` asks the window that holds
the message and never resolves `to` again, which could now name another agent (D132). Request-bearing run metadata remains available for the original
one-hour request period even after its card closes or its process exits; it does not restore a closed card or process.
An interrupted start whose outcome was not recorded reports unknown effects instead of starting again. Removing a
card does not prove process termination: a repeated request reports that process state as unknown where no exit was
recorded (D119).
No other tool takes one, and none takes a selectable YOLO/permission profile or input_policy. A new
invocation without one is a new request; a repeated start may create another agent. Facade may number internal work.
The normal shim supplies its run ID from launch context; it is an address, not a credential. Protocol framing may
chunk large data, but no transport-frame limit becomes a total-content limit on direct text input.

### 1.2 Result envelope and effects

**Every result provides English text and equivalent structured facts without overstating effects.**

Agent-facing results use one compact JSON object as both structured content and serialized text, without an additional
narrative headline. Keep the envelope below, meaningful field names, all actual effects and useful error diagnostics.
Public agent/message identities use their directly callable short references where known, with the full ID as a fallback;
do not repeat alias/reference variants. Internal routing and stored records retain their complete identities. Project
only at the caller's public result boundary, after cross-window routing and caller-side file transfer. This contract
is tool protocol 5. All callers use this contract; earlier tool protocols fail explicitly before effects, with no
parallel result format or automatic downgrade.

Do not echo ordinary input bodies, routine character counts or requested key arrays in operation receipts. Preserve
pending deadlines/obstacles, repeated-request facts, prompt outcomes and partial/unknown effects. List detail under
3.1 keeps infrequent facts retrievable. Message and screen bodies are complete, inline or through the existing file
mechanism. Explicit false, null, empty and unknown values are not removed as though they were absent. Human-facing
history and notifications keep their own presentation; their wording is not the machine result contract (D148).

```ts
type Result<T> = {
  status: "success" | "failure" | "accepted";
  data: T;
  error?: {
    code: "INVALID" | "NOT_FOUND" | "REFUSED" | "UNAVAILABLE" | "FAILED";
    reason: string;
    message: string;
  };
  recovery?: { action: string; check?: { tool: string; arguments: object }; request_id?: string; condition?: "within_original_hour" };
  effects: {
    outcome: "none" | "confirmed" | "partial" | "unknown" | "pending";
    text_written?: "none" | "partial" | "full" | "unknown";
    enter_written?: boolean | null;
    keys_sent?: number;
    agent_id?: string;
    worktree_created?: string;
  };
};
```

Failure sets MCP isError; accepted means finite work continues, not success. Unknown is not false/no effect.
Process and tools facts use `process_state` and `tools_state` consistently across starts, lists, repeated requests and
receipts. Activity remains separate; idle, delivery and input writes never establish task completion.
For native initial-prompt acceptance, use confirmed outcome without inventing terminal text/Enter writes; omit those
optional fields when that path did not use them. RULES-1.3 defines delivery for every path.
Agent and message IDs identify public objects; no public operation-query identity is required.
Reason examples: missing_argument, invalid_argument, ambiguous_reference, not_found, ended, out_of_tree, unsupported,
configuration_invalid, protocol_incompatible, window_unavailable, input_draft, input_interaction, input_unknown,
timeout, submission_unconfirmed, partial_input, repository_required, commit_required, capacity_exceeded.
An ordinary message to a CLI that has no input reader fails immediately with `unsupported`, a permanent obstacle under
RULES-1.5. A reader that does not recognize the input box leaves it untouched; the send ends at its deadline with
`input_unknown`, and the message names the CLI and the version Facade found (CLIS-2.1).
A request refused before it reached its effect reports no effect: a routed message the destination refuses before
recording it - its agent gone or out of reach - is `NOT_FOUND`, and direct text or keys that never reached the terminal's
runtime are `UNAVAILABLE` (D132).
CLI/Git/transport errors retain their actual useful diagnostic. Exceptional results may include compact `recovery`
facts: an `action` naming correction, target/capability/blocker inspection, effect inspection, original-request reuse,
reconnection or tool update; an optional read-only `check` names an existing tool and its arguments. Only original-request
reuse includes `request_id` and `condition: within_original_hour`; it never restarts that hour. Partial/unknown effects
never authorize automatic input replay, replacement starts, worktree deletion or escalation. A final failed request
remains failed when retrieved with the same ID; a deliberate new effect requires a new request after addressing its cause.
Normal success has no recovery object. Prompt-level failure/uncertainty keeps its recovery alongside that prompt.
A closed target has no invented state/screen check. These are API mechanics, not instructions to organize or escalate work. Agent-operation errors never create an automatic human notification.

### 1.3 Waits, progress and async completion

**Return current results promptly and keep ordinary-message deadlines independent from startup/cleanup waiting.**

Queries use a ten-second route deadline and report unavailable windows rather than invent an empty result.
`facade.collaboration.waitSeconds` is 1–3600 seconds, default 120, for startup/stop/control waiting. Completion can return sooner.
A CLI that times its MCP calls is given 3660 seconds for one of Facade's - the longest wait and a minute for the call's
own route and answer - so that it never gives up on a call Facade is still answering within its wait (D132).
An actual continuing operation may return accepted with its run/effects; later completion returns to its initiating
agent through a Facade system result. The accepted response and later result identify the same originating tool call
and target run, using existing call correlation facts so concurrent calls, including calls to the same target, are
distinguishable. Accepted start/stop results expose `result_message_id`, reserved from the existing message namespace before acceptance.
The later receipt has that same ID. The full `call_id` stays in structured data and records; a same-request start lookup
keeps both original IDs, including after reload. Reservation creates no inbox item and promises no durable delivery. The original prompt/message ID identifies
prompt delivery separately. Message records retain originating-call correlation while delivery resumes after reload.
Local and routed receipts retain the target's known name and short reference even after its card closes; rendering
does not depend on looking up that removed target again.
This adds no public operation object or query API. Result handoff follows
RULES-1.7, including no duplicate receipt for an immediate final result and no human fallback when handoff fails.
Use list_agents for current run state; there is no separate operation inspection API. A pending operation continues
without another send/start. Final system results request no reply. Unknown outcomes with no active operation promise
no later verification. Receipt delivery remains finite and may end when its initiator is unreachable.
An earlier returned message deadline can extend under RULES-1.5; its passing or an empty inbox alone proves no final outcome.
send_message always uses the initial-response and delivery-stage budgets owned by RULES-1.2 and RULES-1.5.
A slow operation never keeps a closed card/terminal visible or extends a message budget. Native MCP progress may
describe a continuing call; it does not produce progress popups.

## 2 Discover and start

### 2.1 list_start_options

**Query startup choices without side effects, including open windows that have no agents.**

Arguments, optional: `scope:"current"|"all"`, `window_id:string`, `location_id:string`, `cli:string`.
With no arguments or scope current, return the caller's registered launch location, window/environment and available
CLI choices in one query, without waiting for other windows. This is not the terminal's later cwd or the person's
last selection. A missing or removed launch location fails explicitly; never choose another location. The snapshot
includes catalog completeness and configuration problems, and startup revalidates the chosen destination.
Scope all lists every open Facade window on this client computer: window IDs/labels, environments when
present, location summaries and availability. Scope excludes explicit window/location/CLI selections.
With window_id, list the shared WORKTREES-1.2 location catalog. With
location_id, list its installed CLIs and any catalog configuration problems, each naming its setting. A malformed
custom catalog must not silently appear empty; valid built-ins remain available. With cli, include model/effort choices and actual operation capabilities. A
subordinate selection must identify its parent; do not silently choose a window/location. A window without a folder
has zero locations and cannot start an agent. Known absence differs from an unreachable runtime; include complete and
unavailable_windows where applicable.

Model/effort catalogs contain previously successful values and any reliable local vendor catalog, with source and
complete/partial/unknown status. Omitting a startup value adds no per-call override; CLIS-1.4 owns precedence over
the CLI's native defaults. Do not advertise a stale hardcoded list as complete or require a made-up not_applicable
object. Capabilities include activity, ordinary message input (whether the CLI has an input reader, with the version
Facade found), screen/input and native initial prompt. Report supported/unavailable/unverified with the reason.
Window/location discovery is not restricted to places already containing the caller's tree. Existing-agent data is
scoped under RULES-4.3. Selection is revalidated at start, without reservations.

### 2.2 start_agent arguments

**Name, CLI, window and location are required; model, effort, prompt and new-worktree creation are optional.**

| Field | Type / meaning |
| --- | --- |
| name | Required display name string; LIFECYCLE-2.1's label rules, so spaces, duplicates and an empty string are allowed |
| window_id | Required destination window ID |
| location_id | Required available location in that window |
| cli | Required built-in ID |
| model | Optional nonempty literal; this call's choice takes precedence under CLIS-1.4 |
| effort | Optional nonempty literal; this call's choice takes precedence under CLIS-1.4 |
| prompt | Optional nonblank initial message, subject to ordinary message length |
| worktree | Optional `{branch:string, base_ref:string}` to create a worktree from the selected location |
| request_id | Optional caller ID of the start, 1–200 characters: the same one again within an hour answers the agent it started (1.1) |

No worktree field means use location_id directly, including ordinary folders and worktrees made by other tools.
A new-worktree branch/base are explicit and validated by the Git flow; the agent's display name is not its branch.
A child joins the calling agent's creation tree, including across windows. Its run YOLO follows RULES-4.3;
the caller cannot pass permissions/yolo to choose a mode. No unattended override exists.

```json
{"name":"backend review","window_id":"win-2","location_id":"loc-7","cli":"claude",
 "prompt":"Review the changes in this folder."}
```

For new-worktree creation, add for example `"worktree":{"branch":"review-api","base_ref":"HEAD"}`.
Previously successful models/efforts are choices, not an exhaustive allowlist where the CLI accepts literal overrides.
Omitting either field leaves the CLI's native defaults in control under CLIS-1.4. Report ignored/rejected requested
overrides honestly. Do not substitute another CLI, path or conversation.

### 2.3 Start result

**Startup confirms a process, while initial-prompt submission has a separate outcome.**

Return agent_id/name, window/environment, location, creator/tree, yolo, process_state, tools_state and
requested/observed model/effort where known. For prompt include message_id, the native or post-start path with its
capability state, and pending/success/failure/unknown with actual input effects under RULES-1.3 and MCP-1.2.
An unverified native prompt has unknown acceptance, with no invented pending delivery or promised later receipt.
Its message record retains that uncertainty and can be delivered by an explicit inbox read without another paste.
The run retains its original prompt message ID. A repeated start returns that record's current outcome, or explicit
unknown where the record is absent; it never replays the prompt or uses replacement prompt text from the retry.
Startup closed midway retains any known created-worktree path in its final effects and reports `closed:true` with
`process_state:unknown`. Closure alone does not establish that no process was started or that it exited.
For a delivered post-start prompt, include `delivered_via` so terminal submission and an inbox read remain distinct.
COLLABORATION-2.2 owns native/post-start prompt selection and budget start.
If the process has started but prompt delivery is still pending, return that separation and later report the final
prompt outcome to the caller with the same message ID and target run under 1.3. A successful process-start result
does not cancel this report or renew the prompt's delivery budget.
A prompt failure does not destroy a successfully started agent.
Acceptance creates the pair immediately in the destination; pre-acceptance validation failure creates none. Later
cwd-dependent validation or startup failure under CLIS-4.2 retains its error pair. Tool unavailability does not kill a usable CLI.
There is no task object, task_operation_id, completion expectation or automatic creator progress report.

## 3 Inspect and stop

### 3.1 list_agents

**List current run facts within the caller's normal YOLO/creation-tree scope.**

Arguments: `window_id?:string`, `agent?:string`, `details?:boolean=false`, `include_ended?:boolean=false`,
`cursor?:string`, `limit?:integer=100` (1–200).
Default searches connected windows within permitted reach: YOLO all; non-YOLO only the same creation tree, including
siblings/ancestors/descendants. Do not return unrelated agents and then ask the caller to ignore them.
Facts available across compact and detailed views include ID/name, window/environment/location, CLI, creator/tree,
yolo, process/activity/tools/input facts,
observation time/stale flag, title and actual error/exit where present. No task summaries, delegation credentials or
public pending-operation-query fields. Ended records never imply a live terminal.
The default compact projection keeps actionable identity/name, window/location/path/environment, CLI, YOLO,
process/activity/blocker, tools/input capability, observation freshness and actual error/exit. `details:true` also returns
creation time, creator/tree, window label, CLI title and activity reason. `agent` resolves one normal agent reference,
including a retained ended agent, and queries only its window; a conflicting window_id fails before effects. An agent
selection excludes cursor. Unknown-activity diagnostics remain in the compact view. Without
agent, include_ended keeps its existing meaning. Scope, completeness and pagination remain explicit in either view.
Pagination returns next_cursor; unavailable peers are explicit and complete:false is not an empty successful lookup.
The cursor binds window_id, include_ended and the caller's reach; changing them fails explicitly. Pages describe a
changing list ordered by creation time and ID, not an atomic snapshot. Known supported input reasons may be omitted
from compact rows; unavailable/unverified reasons remain, and details returns the complete capability facts.
state_observed_at is the source state-episode timestamp where available; observed_at is query time. Reload and queries
do not freshen source observations. stale reflects a lost current execution connection, not the age of an observation.
read_messages remains limited to the caller's inbox even if list_agents can see another agent.

### 3.2 stop_agent

**Stop one identified agent and remove its UI immediately; clean up its process in the background.**

Arguments: `agent:string` required. No delete_worktree, discard_changes, recipient array or request ID.
Resolve an allowed run, remove card/terminal, prevent new input, then terminate its process as needed.
Do not stop children. Already-ended known runs can return already_ended; missing IDs fail without guessing. A stop
while the agent's process is being started answers how that start's cleanup ended, never that none started (D131).
Return agent_id, actual process/cleanup state and effects. Accepted/unknown cleanup is not proof of exit, but does not
restore a Stopping card. Self-stop may end the caller before it receives a result; no public recovery tool is added.
Once removal occurred, `closed:true` records the closed card and terminal. Continuing cleanup is accepted; completed
but unconfirmed cleanup fails with `termination_unconfirmed` and partial effects, never a successful stop.
Errors go to the invoking agent, with no automatic human popup. External location deletion is observed separately.

## 4 Messages and history

### 4.1 send_message

**Send exactly one complete message to one agent or explicitly to the person.**

Required `to:string`, `text:string`; optional `reply_to:string` naming a message in the caller's inbox.
Resolve an exact ID or unique eligible name; ambiguous names fail and require ID. `#human` addresses the person in the
caller's window; RULES-2.3 decides when `@human` does. No array or merged recipient result.
Text is nonblank and at most 8,000 Unicode code points. Preserve Unicode, line breaks and tabs as content; reject
terminal-control encodings that would execute outside the message paste instead of silently transforming the body.
Raw terminal control is a separate tool. Never replace the body with a pointer and call that full-content delivery. A
text that begins with `[Earlier output truncated]` - how Antigravity marks a long argument it cut to its last 8,000
characters, a behavior identified during competitive analysis - lost its beginning on its way: send_message,
start_agent's prompt and type_text refuse it with invalid_argument before any effect, asking for shorter parts,
rather than pass a part on as the whole (D113).

Return message_id, resolved target, status/effects, and deadline/obstacle if accepted within RULES-1.2's response budget.
Ordinary delivery follows RULES-1.4–1.6's input checks and attempt budget; the deadline an accepted send returns moves on,
to at most ten minutes, while the recipient's input holds another draft or a native question (RULES-1.5). Message ID
allocation/reuse follows RULES-1.1; a message's text is typed at most once (RULES-1.6). Expiry is failure.
An optional `request_id` makes a retry safe under 1.1. No cancel_message is provided. B's actual reply is another send.
Human contact means notification handoff in the sender's window; no migration to another window on closure.
All A-to-B delivery/reply/system-result errors remain with agents or end if nobody can receive them.

```json
{"status":"success","data":{"message_id":"#m42","target":"#a2","disposition":"submitted_to_cli"},
 "effects":{"outcome":"confirmed","text_written":"full","enter_written":true}}
```

```json
{"status":"accepted","data":{"message_id":"#m42","target":"#a2",
 "deadline":"2026-10-28T23:00:15Z","obstacle":"input_draft"},
 "effects":{"outcome":"pending","text_written":"none","enter_written":false}}
```

### 4.2 read_messages

**Read only the calling agent's incoming messages, never its sent messages or another inbox; reading delivers.**

Arguments: `ids?:string[]` (1–100 IDs; one ID alone is taken too), `all?:boolean=false`, `cursor?:string`,
`limit?:integer=100` (1–200). Explicit ids exclude all/cursor. Without them, return the caller's incoming records
that are not yet delivered: still being delivered, not delivered at their deadline, uncertain, and Facade results that
were not pasted. all:true pages every retained incoming record. IDs accept message IDs or their `#mN` aliases, not
agent references. Lookup by ID is still inside that inbox, including for YOLO. An unavailable ID reports not_found
without exposing another recipient's record. Multiple read IDs are a query, not a multiple-recipient send.

Return records oldest first: message ID, sender, time, optional reply relation, message/system kind, exact
body, delivery state, how it was delivered and input effects. Once the result is handed back, every record
in it is delivered (RULES-1.3): its sender's result says it was delivered through read_messages. RULES-1.5 cancels
unstarted pastes and permits only completion of an already pasted owned draft. An uncertain return may repeat the same record without starting another paste to the
terminal. Above 8,000 combined code points, return the complete selected content in a file readable in the caller
environment, with path/size and per-message metadata. COLLABORATION-4.2 defines transfer and expiry.
An empty result describes only this read's snapshot. A next_cursor continues the same all/default selection and limit.
No instructions to poll, end a turn, print, answer, escalate or follow a workflow are embedded in results.
The compact projection omits duplicate identity spellings, the already-known recipient, routine length and delivery
attempt counts. A system result with structured operation facts returns those as `result` instead of repeating its
human-readable body; ordinary message bodies and old text-only system results remain exact. Large-result files carry
the same selected machine content, with message boundaries and correlation, and are still marked delivered only at handoff.

## 5 Terminal operations

### 5.1 read_screen

**Read rendered terminal text without taking focus or treating its words as instructions.**

Required `agent:string`; optional `lines:integer=50` (1–2000). Enforce normal tree reach.
Return run/window, observation time, process state, stale flag, buffer mode and logical lines/text. Empty live output
is successful empty output. Retained ended output is dated and not described as live.
The single `text` body uses `text_format:"facade-styled"`: `[[...]]` marks inverse video and `{{...}}` marks dim text;
both together nest as `[[{{...}}]]`. A backslash escapes each literal backslash, bracket or brace in the source text,
so literal marker-like content remains unambiguous. Removing style marks and decoding these escapes restores the exact
rendered text, including spaces and Unicode. Cues come directly from terminal cells; the model need not count character
offsets to locate a highlight. A surviving older runtime that supplies no cues explicitly reports `styles_unavailable:true`;
absence of evidence never invents unstyled output. New launches use the current runtime. Do not execute escape sequences.
An available `last_alternate_frame` uses the same text format with its own observation time, separate
from current output. Above 8,000 code points in the complete serialized screen result, return a complete UTF-8 JSON
file under COLLABORATION-4.2, preserving the same body, cues and metadata without truncation.

### 5.2 type_text and press_keys

**Write exactly the requested direct text/keys without draft protection, policy selection or an artificial text limit.**

type_text: required `agent:string`, `text:string`; optional `enter:boolean=false`.
Text may contain any printable Unicode plus tab, line feed and carriage return, so it may be multiline or whitespace.
Empty text is valid only with `enter:true`; empty text with `enter:false` is INVALID. Other C0/C1 control characters,
including ESC, are rejected before writing with INVALID/`invalid_argument` pointing to press_keys. This is type
validation, not a length cap: there is no single-line, code-point, byte or whole-request cap that rejects otherwise
valid direct text. Transport may send chunks internally.

press_keys: required `agent:string`, `keys:string[]` (one key alone is taken too), a nonempty sequence of recognized terminal keys with no
count limit.
Names include Enter, Escape, Tab, Shift+Tab, Backspace, Delete, directions, Home, End, PageUp, PageDown, Space,
Ctrl+A through Ctrl+Z and printable characters. Normalize familiar Return/Esc/Arrow aliases; reject unsupported key
names before writing. Use the terminal's actual encoding; delay only when its input protocol requires it.

Both operate on the addressed live terminal within normal tree reach and serialize with other automated input.
They can act on drafts, menus or unknown layouts; no input-box evidence is required. No mandatory read_screen
or permission question is added. Return actual full/partial/unknown text, Enter fact, pasted count or keys_sent.
A supplementary screen is only observation; its failure does not undo input. No automatic raw-content retry occurs
after unknown effects. type_text's Enter goes in a write of its own after its text, once the CLI can have read the text -
a tenth of a second, and CLIS-2.1's time for a paste of its size and for Antigravity's lines - as a CLI that reads a
paste's end and an Enter together may drop the Enter, as identified for Claude Code during competitive analysis (D113).
Ordinary messages keep their own draft rules and are typed at most once (RULES-1.6).

## 6 Technical design

### 6.1 MCP identity and configuration

**A per-run stdio shim routes calls using its launch run ID, with no authentication or anti-impersonation protocol.**

Inject server `facade` through startup arguments/per-run files where supported, under CLIS-2.2's preservation/cleanup
rules. The shim's normal launch context supplies caller run, window and execution environment so routing and tree rules
are applied consistently. IDs are addresses, not credentials. Do not generate private run tokens, token files,
authenticated enrollment, source-binding proofs or scoped delegation. A deliberately forged caller ID is outside the
protection provided. Basic schema/routing validation remains.

Calls to Facade's own tools never ask for the CLI's approval, with YOLO on or off: CLIS-2.2 pre-approves the `facade`
server for each CLI that has a rule for one server's tools - Muse Code has none, and its own approvals apply (D100). The
CLI's own commands and edits keep the approval mode that RULES-4.3 chose for the run. The server is never marked
required, so a failure to start or connect it leaves a usable CLI with tools_state unavailable. The MCP switch affects
future injection, not existing connected runs. Version/integration failure leaves a usable CLI.

Each tool the server lists carries `_meta: {"antigravity/alwaysLoad": true}`, which Antigravity reads to give the model
the tool directly rather than on demand; other CLIs ignore it. A server started without a run's variables - by a session
the person started in a folder whose shared entry is a running agent's - speaks for no run: it lists no tools and says
so in its instructions, and a call to it fails with `configuration_invalid` and no effect.

The shim speaks MCP 2025-11-25 down to 2024-11-05, the client's version where it is one of these and else the newest, and
answers a method it does not know with JSON-RPC's method-not-found, so a newer CLI is never left without tools (D111). Its
instructions tell a CLI that lists tools by name alone until they are loaded, as Claude Code does, to load one before calling
it, following competitive analysis. A test keeps the tool list, the instructions and the skill within a byte budget,
which every turn of every agent pays for (D111).

### 6.2 Protocol and recovery

**Use one schema source for tools, descriptions and wire validation, and report incompatible protocols plainly.**

Text/structured results express the same facts. No incompatible old call is silently translated into another action.
Parsing the text as JSON yields exactly the structured object. Unsupported tool protocols, including protocol 2, fail
explicitly before effects. Cross-window calls carry the current tool protocol without a missing-version fallback.
A system receipt carries the same
operation facts as an immediate result, with its message/call correlation; human-readable history text is kept
separately. A text-only historical receipt is not parsed or guessed into structured state.
Connection recovery reuses only actual surviving runs and unexpired work under RULES; it never replays closed-run mail.
The bundled skill teaches the nine tools, required startup fields, optional defaults, RULES-4.3's launch/reach policy,
normal creation trees, unique-name resolution, `#human`, own inbox, that read_messages without arguments returns the
messages not yet received and that all:true returns every retained one, and finite delivery. It explicitly tells the
model: “The same Facade message can arrive more than once. Use its message ID to recognize a repeat and do not redo
work for that same message. A new send call has a new ID, even if its text matches. A Facade system result about a
message is a separate kind of information, not another copy of that message's instruction.”
This is model-side handling of transport duplicates, not a Facade deduplication database or an exactly-once guarantee.
The skill does not prescribe project workflow, mandatory replies or escalation to a person.
Per-run initialization instructions identify the agent, its creator (or person), initial message ID when present, and
launch window/environment/location including folder and worktree. A creator's short ID is a callable send_message
address, never a reporting requirement. Context is private to the run's launch and survives shim reconnect/reload.
The creator is named explicitly with its address; a general explanation of #human must not substitute for that fact.
The MCP launch explicitly carries the caller's short ID; a client's filtered child environment must not erase it.
Initialization explains that terminal delivery continues after a model turn ends, while read_messages is an immediate
snapshot rather than a wait operation. It tells agents not to poll inboxes or screens for automatic delivery, without
prescribing project workflow or a particular turn ending.
Shared skill/config files contain no personalized context. A client that does not expose server instructions to the
model receives the same instructions through its run-private native context hook; Pi uses a dedicated system-prompt
section in its existing per-run extension, Muse uses SessionStart additionalContext from its private session hook,
and Antigravity uses a PreInvocation ephemeral message from its shared plugin hook. That hook contains no run identity;
the same run environment as its MCP server supplies the private context, including after native resume. Transient
context must not accumulate in conversation history across invocations.
These preserve existing instructions and hooks and add no user message or model turn.
A proven client limitation may use the same initial message as fallback, never an extra welcome turn.
Missing facts stay absent, and launch context never claims to track shell cd.

Old task workflows, operation-query/deletion tools, input_policy and authentication instructions are absent.
No migration guide for already-published user skills is required: this is the first release of the contract.

## Checks

| Rules | Acceptance |
| --- | --- |
| 1.1–1.3 | Nine-tool schemas, complete missing-field report, request IDs on start and send alone, current effects, `unsupported` and `input_unknown` reasons and message budgets |
| 2.1–2.3 | Empty/remote windows, optional model/effort, shared YOLO rule, cataloged/new-worktree locations, both prompt paths |
| 3.1–3.2 | Same-tree lists, duplicate names, one-agent stop, immediate UI close, no delete/query extensions |
| 4.1–4.2 | One recipient, `#human`, fixed retries/duplicates, no human fallback, own inbox including ID lookups, reading delivers and cancels unstarted pastes while an owned draft can finish, long-file expiry |
| 5.1–5.2 | Current/final screen, direct multiline/unbounded text and drafts, control characters refused toward press_keys, recognized keys, true input effects |
| 6.1–6.2 | Run routing without credentials, Facade tools never prompt for approval, optional server, future-only MCP setting, version errors, consistent schemas and explicit ID deduplication skill text |

[Verification](VERIFICATION.md) records tests actually run; this contract does not assert them passed.

## Change log

- 2026-11-01: D151 exposes original-call correlation for continuing starts/stops and preserves it through message
  reloads; async and inbox guidance distinguishes continuation, uncertainty, final receipts and empty snapshots.

- 2026-11-01: D150 permits compact recovery facts based on actual effects, retaining diagnostics and original request identity.

- 2026-11-01: D149 makes native prompt uncertainty and unconfirmed termination explicit, preserves prompt outcomes on
  repeated starts, and unifies process/tool field names under tool protocol 4.

- 2026-11-01: From the owner-requested release review: 1.1 retries a cross-window send whose answer was lost through the
  window holding it; 1.2 reports refusals before any effect as no effect; 3.2 answers a stop during a start with its
  actual cleanup (D131, D132).
- 2026-11-01: D148: compact machine results with equivalent JSON/text, one current tool protocol, targeted agent
  detail, and separate machine/human system-result representations; no change to operation or delivery effects.

- 2026-11-01: Describe competitive-analysis findings without naming individual products or their implementation identifiers; API behavior is unchanged.
- 2026-10-31: Request IDs cover concurrent calls, lost route replies and removed runs; read delivery does not orphan
  a complete Facade draft (D119).
- 2026-10-31: 1.1's repeated start answers as its start went, and a request ID travels with a message to another window
  (D118).
- 2026-10-31: 4.1 refuses a text that arrives with Antigravity's mark of a cut beginning; 5.2's Enter goes a moment after its
  text (D113).
- 2026-10-31: 6.1 speaks MCP 2025-11-25, tells a CLI that defers tools to load them, and keeps what every turn pays for
  within a tested byte budget (D111).
- 2026-10-31: 1.1, 2.2 and 4.1 take an optional `request_id` on start_agent and send_message (D110).
- 2026-10-31: 4.1's accepted deadline moves on while the recipient's input is held, and a message is typed at most once
  (D104, D106).
- 2026-10-31: 1.1 advertises every argument with a type and no `oneOf`, and takes a list given as one string or as
  JSON text; 4.2's `ids` and 5.2's `keys` are lists (D102).
- 2026-10-31: 6.1 marks the tools for Antigravity to give the model directly, lists none for a session the person started
  in a folder whose shared entry is a running agent's, and names Muse Code's own approvals (D100).
- 2026-10-30: Step 2 of the Facade Code extension, carried from the Facade Dots contract with the owner's 2026-10-30
  decisions: one delivery state in which read_messages delivers (D88), no CLI-version gate on message input, with
  `unsupported` and `input_unknown` replacing capability_unverified (D89), Facade's tools pre-approved in both YOLO modes
  and never required (D90), `#human` for the person (D91), the client network across this computer's windows (D93) and
  the `facade.collaboration.waitSeconds` setting (D95). Resume, Pin and custom CLIs are later steps.
