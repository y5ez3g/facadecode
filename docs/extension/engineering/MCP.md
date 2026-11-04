# MCP contract

Layer 4. Tool protocol **6** defines the contract. [Rules](../RULES.md) owns effects and
[Collaboration](../features/COLLABORATION.md) owns message experience.

| Group | Decides |
| --- | --- |
| 1 Common contract | Eight tools, outcomes, waits and validation |
| 2 Discover and start | Startup choices, required identity/location and optional prompt |
| 3 Inspect and stop | Scoped agent lists and single-agent stop |
| 4 Messages and history | One recipient, result reports and own inbox |
| 5 Terminal operations | Screen, unrestricted direct text and keys |
| 6 Technical design | Run routing, injection, versioning and schema ownership |

## 1 Common contract

### 1.1 Tools and validation

**Expose eight English tool contracts; validate complete arguments before effects.**

Tools in order: `start_agent`, `list_agents`, `stop_agent`, `send_message`,
`read_messages`, `read_screen`, `type_text`, `press_keys`.
There are no other tools: no operation query, message cancel, rename, worktree creation or deletion, batch stop or
separate startup discovery.

Arguments are JSON objects with known keys and correct types; an absent arguments object is `{}`. Do not coerce missing
choices into defaults except where explicitly allowed below. Every advertised argument has a JSON Schema `type` and no
`oneOf`, so that every model provider takes the tool list; a list argument also takes a single string, or the list
written as JSON text, as some CLIs send it. Report every problem of a call together in one INVALID answer: reason
`missing_argument` where a required field is absent, otherwise `invalid_argument`, with `data.missing` naming the
absent fields and `data.invalid` each other problem by field.
IDs are nonempty strings; references accept exact IDs and RULES-2.3's `#aN`, a name with or without `@`, or a
display-name-plus-ID form, plus the person's `#human`. Names can repeat; ambiguity requires an ID. A reference resolves
once within the caller's normal reach.

start_agent and send_message take an optional `request_id` of the caller's own, 1–200 code points: the same one again
from that caller to the same tool within an hour of the first call answers what the first call started or sent, as it
stands, with `request_id` and `repeated: true`, and does nothing again. It is kept on the run or message record - a
message to another window's agent carries it there, where its record is made - and a repeated start answers as its start
went: accepted while its process still starts, the start's failure where it could not start, success otherwise - its
prompt as it stands, pending included, with the first call's `call_id`, `result_message_id` and prompt `message_id`.
Concurrent calls share that operation. The recipient deduplicates a routed send before input, so a lost route reply
cannot make a retry send again. A send whose route answer was lost, so that the message may have arrived, keeps the
sender's copy with its outcome unknown; a retry with the same `request_id` asks the window that holds the message and
never resolves `to` again, which could now name another agent. Request-bearing run metadata remains available for the
original one-hour request period even after its card closes or its process exits; it does not restore a closed card or
process. An interrupted start whose outcome was not recorded reports unknown effects instead of starting again. Removing
a card does not prove process termination: a repeated request reports that process state as unknown where no exit was
recorded. No other tool takes one, and none takes a selectable YOLO/permission profile or input_policy. A new invocation
without one is a new request; a repeated start may create another agent. Facade may number internal work. The normal
shim supplies its run ID from launch context; it is an address, not a credential. A call travels within 5.2's transport
bound.

### 1.2 Result envelope and effects

**Every result provides English text and equivalent structured facts without overstating effects.**

Agent-facing results use one compact JSON object as both structured content and serialized text, without an additional
narrative headline. Keep the envelope below, meaningful field names, all actual effects and useful error diagnostics.
Public agent/message identities use their directly callable short references where known (`#aN`, `#mN`), with the full
ID as a fallback; do not repeat alias/reference variants, and leave `effects.agent_id` out where `data` names the same
agent. Internal routing and stored records retain their complete identities. Project only at the caller's public result
boundary, after cross-window routing and caller-side file transfer. This contract is tool protocol 6. All callers use
this contract; a call of another tool protocol fails as UNAVAILABLE `protocol_incompatible` before effects, with no
parallel result format or automatic downgrade.

Do not echo ordinary input bodies, routine character counts or requested key arrays in results. Preserve pending
deadlines/obstacles, repeated-request facts, prompt outcomes and partial/unknown effects. List detail under 3.1 keeps
infrequent facts retrievable. Message and screen bodies are complete, inline or through COLLABORATION-4.2's files.
Explicit false, null, empty and unknown values are not removed as though they were absent. Human-facing records and
notifications keep their own presentation; their wording is not the machine result contract.

```ts
type Result<T> = {
  status: "success" | "failure" | "accepted";
  effects: {
    outcome: "none" | "confirmed" | "partial" | "unknown" | "pending";
    text_written?: "none" | "partial" | "full" | "unknown";
    enter_written?: boolean | null;
    keys_sent?: number;
    agent_id?: string;
    worktree_created?: string;
  };
  data: T;
  error?: {
    code: "INVALID" | "NOT_FOUND" | "REFUSED" | "UNAVAILABLE" | "FAILED";
    reason: string;
    message: string;
  };
  recovery?: {
    action: "correct_arguments" | "resolve_target" | "check_capability" | "resolve_blocker" | "inspect_effects"
      | "repeat_original_request" | "reconnect" | "update_tools";
    check?: { tool: "list_agents" | "read_screen"; arguments: object };
    request_id?: string;
    condition?: "within_original_hour";
  };
};
```

Failure sets MCP isError; accepted means finite work continues, not success. Unknown is not false/no effect.
Process and tools facts use `process_state` and `tools_state` consistently across starts, lists, repeated requests and
receipts. Activity remains separate; idle, delivery and input writes never establish task completion.
For native initial-prompt acceptance, use confirmed outcome without inventing terminal text/Enter writes; omit those
optional fields when that path did not use them. RULES-1.3 defines delivery for every path.
Agent and message IDs identify public objects; no public operation-query identity is required.

| Code | Reasons |
| --- | --- |
| INVALID | `missing_argument`, `invalid_argument`, `ambiguous_reference`, `unsupported` (an unknown tool, or a model or effort for a CLI that takes none), `ownership_lost` |
| NOT_FOUND | `not_found` |
| REFUSED | `out_of_tree` |
| UNAVAILABLE | `ended`, `not_started`, `unavailable`, `unsupported` (a CLI without an input reader), `configuration_invalid`, `protocol_incompatible`, `window_unavailable`, `timeout` (a route that did not answer in time), `capacity_exceeded` |
| FAILED | `input_draft`, `input_interaction`, `input_unknown`, `timeout` (a delivery that ran out of time), `submission_unconfirmed`, `partial_input`, `ended` (a start closed before it finished), `launch_failed`, `worktree_failed`, `termination_unconfirmed`, `cleanup_failed`, `route_failed`, `invalid_response`, `unexpected_error` |

An ordinary message to a CLI that has no input reader fails immediately with `unsupported`, a permanent obstacle under
RULES-1.5. A reader that does not recognize the input box leaves it untouched; the send ends at its deadline with
`input_unknown`, and the message names the CLI and the version Facade found (CLIS-2.1).
A request refused before it reached its effect reports no effect: a routed message the destination refuses before
recording it - its agent gone or out of reach - is `NOT_FOUND`, and direct text or keys that never reached the
terminal's runtime are `UNAVAILABLE`.
A failed route preserves timeout versus unavailable versus malformed-response reasons and the known destination.
Unreachable windows do not prove absent agents. Lost answers to pure queries report no agent/message-state effect;
read_messages is different because handoff can mark messages delivered. A malformed reply or disconnected route after
forwarding a mutation leaves its effect unknown. A failed lookup of an earlier uncertain request cannot erase that
uncertainty merely because its target is now gone. Only an authoritative original record can settle the earlier effect.
CLI/Git/transport errors retain their actual useful diagnostic.

A failure may include compact `recovery` facts, the first of these that applies: `repeat_original_request`, with the
call's `request_id` and `condition: within_original_hour`, for a start or send with a request ID whose route answer was
lost; `inspect_effects` where its effects are partial, unknown, confirmed or pending, or a worktree was created;
`update_tools` for `protocol_incompatible`; `resolve_target` for an ambiguous, missing, ended or out-of-tree target;
`correct_arguments` for any other INVALID; `check_capability` for `unsupported` or `configuration_invalid`; `reconnect`
where a window or its route failed and nothing took effect; and `resolve_blocker` otherwise - an obstacle, a launch
failure, or a delivery that ran out of time. `resolve_blocker`, `inspect_effects`, `check_capability` and an
ambiguous name's `resolve_target` may carry a read-only `check` naming the existing tool to look with and its
arguments: list_agents with the target for a start, a stop, pending work or a capability, list_agents with no arguments
for an ambiguous name, and otherwise read_screen with the target. A closed or unnamed target has no invented check.
Only original-request reuse includes `request_id`, and it never restarts that hour. Partial/unknown effects never
authorize automatic input replay, replacement starts, worktree deletion or escalation. A final failed request remains
failed when retrieved with the same ID; a deliberate new effect requires a new request after addressing its cause.
Normal success and accepted work have no recovery object. Prompt-level failure/uncertainty keeps its recovery alongside
that prompt. These are API mechanics, not instructions to organize or escalate work. Agent-operation errors never
create an automatic human notification.

### 1.3 Waits, progress and async completion

**Return current results promptly and keep ordinary-message deadlines independent from startup/cleanup waiting.**

Queries - list_agents, read_messages and read_screen - use a ten-second route deadline from the shim's ingress and
report unavailable windows rather than invent an empty result. `facade.collaboration.waitSeconds` is 1–3600 seconds,
default 120, for waiting on a start or a stop. Completion can return sooner. A start or stop routed to another window is
given that wait and ten seconds more, type_text and press_keys routed to another window thirty seconds, and a Facade
result routed back to its caller's window one fifteen-second stage. A CLI that times its MCP calls is given 3660 seconds
for one of Facade's - the longest wait and a minute for the call's own route and answer - so that it never gives up on a
call Facade is still answering within its wait. Every forwarding layer charges connection and queue time to the same
remaining route budget. A budget exhausted before forwarding writes no request; a forwarded request whose reply is lost
remains uncertain. Transport timeouts end waiting, not the destination's operation. Locally measured elapsed time uses a
monotonic clock; process clocks are never subtracted across environments. Query deadlines do not make
delivery-confirming reads side-effect-free. An actual continuing operation may return accepted with its run/effects;
later completion returns to its initiating agent through a Facade system result. The accepted response and later result
identify the same originating tool call and target run, using existing call correlation facts so concurrent calls,
including calls to the same target, are distinguishable. Accepted start/stop results, and a start answered while its
prompt is pending (2.3), expose `call_id` and `result_message_id`, reserved from the message namespace before
acceptance; a stop whose window cannot take that number answers without it and sends no later result (3.2). The later
receipt has that same ID. The full `call_id` stays in structured data and records; a same-request start lookup keeps
both original IDs, including after reload. Reservation creates no inbox item and promises no durable delivery. The
original prompt/message ID identifies prompt delivery separately. Message records retain originating-call correlation
while delivery resumes after reload. Local and routed receipts retain the target's known name and short reference even
after its card closes; rendering does not depend on looking up that removed target again. This adds no public operation
object or query API. Result handoff follows RULES-1.7, including no duplicate receipt for an immediate final result and
no human fallback when handoff fails. Use list_agents for current run state; there is no separate operation inspection
API. A pending operation continues without another send/start. Final system results request no reply. Unknown outcomes
with no active operation promise no later verification. Receipt delivery remains finite and may end when its initiator
is unreachable. An earlier returned message deadline can extend under RULES-1.5; its passing or an empty inbox alone
proves no final outcome. send_message always uses the initial-response and delivery-stage budgets owned by RULES-1.2 and
RULES-1.5. A slow operation never keeps a closed card/terminal visible or extends a message budget. A continuing call
sends no MCP progress notification and produces no progress popup.

## 2 Discover and start

### 2.1 Launch context and history

**Current launch destinations and CLI availability are part of list_agents; historical facts are read from logs.**

There is no separate startup-discovery tool. MCP-3.1 returns empty windows too, their folders and worktrees, and compact
CLI availability scoped to actual locations. An agent's startup context supplies its own window/location IDs and the
absolute path, in its execution environment, of its workspace's structured event log (ARCHITECTURE-3.3), which
list_agents also gives as each window's `history_log`. Existing IDs can be used without another discovery call.
The execution-time checks of start_agent remain authoritative; a snapshot reserves nothing.

CLIS-1.4 owns model/effort values. Facade logs requested settings and actual startup results under ARCHITECTURE-3.3;
it does not aggregate model histories, count model successes or mirror native transcripts. The skill explains how to
filter recent structured log events, when native history is useful, and how to inspect a CLI's own model/effort controls
when a new choice is needed. Defaults and already specified values require no exploratory launch or history query.

### 2.2 start_agent arguments

**Name, CLI, window and location are required; model, effort, prompt and new-worktree creation are optional.**

| Field | Type / meaning |
| --- | --- |
| name | Required display name string; LIFECYCLE-2.1's label rules, so spaces, duplicates and an empty string are allowed |
| window_id | Required destination window ID |
| location_id | Required available location in that window |
| cli | Required ID of a CLI that list_agents lists for that window: a built-in or a custom CLI (CLIS-3.4) |
| model | Optional nonempty literal; this call's choice takes precedence under CLIS-1.4 |
| effort | Optional nonempty literal; this call's choice takes precedence under CLIS-1.4 |
| prompt | Optional nonblank initial message, checked as a message body (4.1), at most 8,000 code points |
| worktree | Optional `{branch:string, base_ref:string}`, both nonblank, to create a worktree from the selected location |
| request_id | Optional caller ID of the start, 1–200 code points: the same one again within an hour answers the agent it started (1.1) |

No worktree field means use location_id directly, including ordinary folders and worktrees made by other tools.
A new-worktree branch/base are explicit and validated by the Git flow; the agent's display name is not its branch.
A child joins the calling agent's creation tree, including across windows. Its run YOLO follows RULES-4.3;
the caller cannot pass permissions/yolo to choose a mode. No unattended override exists.
A window_id of another window sends the call to that window, which checks and starts it. Before acceptance the
destination checks the location and that the CLI is listed and available there; a turned-off built-in is refused as
UNAVAILABLE `unavailable`, naming its `facade.<cli>.enabled` setting, and a `facade.yolo` that is neither true nor false
as `configuration_invalid` (UX-4.1). A model or effort for a CLI that takes none is INVALID `unsupported`.

```json
{"name":"backend review","window_id":"win-2","location_id":"loc-7","cli":"claude",
 "prompt":"Review the changes in this folder."}
```

For new-worktree creation, add for example `"worktree":{"branch":"review-api","base_ref":"HEAD"}`.
Historical requested models/efforts are observations, not an exhaustive allowlist or proof of native acceptance.
Omitting either field leaves the launch configuration, then the CLI's own default, in control under CLIS-1.4. Report
ignored/rejected requested overrides honestly. Do not substitute another CLI, path or conversation.

### 2.3 Start result

**Startup confirms a process, while initial-prompt submission has a separate outcome.**

The call waits up to `facade.collaboration.waitSeconds` (1.3): `success` once the process runs - never waiting on a
post-start prompt, which goes on after the answer - `failure` where the launch failed, `accepted` while it still starts,
its outcome reported later under 1.3. Return `agent_id`, `name`, `window_id`, `window` (its label), `environment`,
`location_id`, `cwd`, `cli`, `creator`, `root`, `yolo`, `process_state` (`starting`, `running` or `failed`; `unknown`
with `closed: true`; a repeated start's run as it is now), `tools_state` (`connecting`, `available`, `unavailable` or
`not_injected`, with `tools_reason` where unavailable) and `requested_model` and `requested_effort` where given; an
accepted start, and one answered while its prompt is pending, add `call_id` and `result_message_id`, and a created
worktree is `effects.worktree_created`. Such a call has one later result, under that `result_message_id`, once the
process's start and its prompt's delivery have both settled - a prompt whose delivery stays unknown settling as unknown
- never one for each. `prompt` gives the prompt's `message_id`, its `path` (`native` or `post_start`) with its
`capability` (`supported`, `unverified` or `unavailable`, and why), its `status` (`success`, `pending`, `failure` or
`unknown`) and its actual input `effects` under RULES-1.3 and 1.2, with `reason`, `message`, `obstacle`, `deadline` and
`delivered_via` where they apply. An unverified native prompt has unknown acceptance, with no invented pending delivery
or promised later receipt. Its message record retains that uncertainty and can be delivered by an explicit inbox read
without another paste. The run retains its original prompt message ID. A repeated start returns that record's current
outcome, or explicit unknown (`prompt_unrecorded`) where the record is absent; it never replays the prompt or uses
replacement prompt text from the retry. Startup closed midway fails as `ended`, retains any known created-worktree path
in its final effects and reports `closed:true` with `process_state:unknown`. Closure alone does not establish that no
process was started or that it exited. For a delivered post-start prompt, `delivered_via` (`terminal` or `read`) keeps
terminal submission and an inbox read distinct. COLLABORATION-2.2 owns native/post-start prompt selection and budget
start. Answering that the process runs neither renews the prompt's delivery budget nor cancels the one later result
above. A prompt failure does not destroy a successfully started agent. Acceptance creates the pair immediately in the
destination, its terminal's tab hidden (LIFECYCLE-2.2); pre-acceptance validation failure creates none. Later
cwd-dependent validation or startup failure under CLIS-4.2 retains its error pair and fails as `launch_failed`, or as
`worktree_failed` where the worktree could not be created, with partial effects. Tool unavailability does not kill a
usable CLI. There is no task object, task_operation_id, completion expectation or automatic creator progress report.

## 3 Inspect and stop

### 3.1 list_agents

**One query returns current windows, launch locations, CLI availability and agents within the caller's reach.**

Arguments: `window_id?:string`, `location_id?:string`, `agent?:string`, `details?:boolean=false`,
`cursor?:string`, `limit?:integer=100` (1–200). A location filter requires its window. A single-agent selection excludes
cursor; conflicting window/location/agent filters fail explicitly. Default agent rows exclude ended records; targeted
lookup can return a retained terminal outcome for recovery. Bulk ended-agent history is read from logs instead.

Return `windows`, compact `agents`, `counts`, `complete`, `unavailable_windows`, `scope` (`all` with YOLO, otherwise
`creation_tree`) and `next_cursor` when paged. `counts` has `known_windows`, `responding_windows`, `folders`,
`locations`, `worktrees` and `agents`. Every responding window is represented, including windows without agents or
folders. Its record has `window_id`, `label`, `environment`, `observed_at`, `folders`, `locations`, `clis`, `problems`,
`counts`, `complete` and `history_log` (2.1); a targeted lookup, or a window without locations, has
`clis_queried: false`, and a location whose CLIs could not be read is in `unavailable_locations`. Count folders as
workspace folders, worktrees as non-main checkouts, and agents within the caller's reach. Deduplicate locations and
agents rather than nesting copies beneath every associated folder. Main checkout and plain-folder locations remain
launchable locations.
Window CLI rows have `cli`, `display_name`, `available`, `problem` where unavailable, and `overrides` for model and
effort (true, false or `unknown`); details:true adds `version`, `message_input` and `initial_prompt` capability. Equal
choices across all locations are represented once; a differing choice names the exact `location_ids` it applies to.
No model catalog or historical usage statistics are returned. Configuration problems and an incomplete Git catalog
remain explicit.

Unreachable windows are not empty: retain their identity and reason, with their counts unknown. A window whose window
component carries no requests between windows lists the other windows as unavailable, with `complete: false`, never as
absent. Aggregate counts are for responding windows and the caller's scope, never an implied complete machine census.
YOLO permits every agent; otherwise only the creation tree is visible. Window/location/CLI discovery is not restricted
to that tree.
Agent rows have `agent_id`, `name`, `window_id`, `environment`, `location_id`, `cwd`, `cli`, `requested_model` and
`requested_effort` where recorded, `yolo`, `process_state` (`starting`, `running` or `ended`), `activity` (`working`,
`not_working` or `unknown`), `blocker` (its `kind` - `permission`, `question`, `auth` or `unknown` - and `text`),
`tools_state`, `message_input` (its capability state, with its reason unless supported), `error`, `exit` (its `kind`,
`abnormal` or `failed`, with its code or signal), `observed_at`, `state_observed_at` and `stale`. Requested settings do
not claim the native CLI's current effective model. details:true adds `creator`, `root`, `created_at`, `window` (its
label), `title` and `activity_reason`; compact rows keep `activity_reason` where activity is unknown. A targeted lookup
reads only that agent's window and avoids unrelated CLI discovery.

Agents and locations page with the same opaque cursor, bound to selection, limit and reach. Counts describe the whole
matched scope, not the page. Pages observe changing state, not an atomic distributed snapshot. `complete` describes
response and catalog coverage, independently of pagination. state_observed_at comes from the source state episode;
observed_at is observation time. Reload/query never freshens source activity. Disconnection, not age alone, determines
stale.

### 3.2 stop_agent

**Stop one identified agent and remove its UI immediately; clean up its process in the background.**

Arguments: `agent:string` required. No delete_worktree, discard_changes, recipient array or request ID. Resolve an
allowed run, remove card/terminal, prevent new input, then terminate its process as needed. Do not stop children.
Missing IDs fail without guessing. A stop while the agent's process is being started answers how that start's cleanup
ended, never that none started. The call waits up to `facade.collaboration.waitSeconds` (1.3) and returns `agent_id`,
`closed: true`, `process_state` and `cleanup`: `terminated` or `already_exited` (success, `process_state: ended`);
`already_ended` (success, with `already_ended: true`); `not_started` (success: closed before its process was asked for,
so it never starts); `pending` (accepted, `process_state: stopping`, with `call_id` and `result_message_id`, its outcome
later under 1.3 - except where the window cannot take a number for that result (RULES-2.2): the answer then has no
`result_message_id` and reports the cleanup as still pending, and no later result comes; the closed agent is no longer
listed, which is no proof that its process ended); `unconfirmed` (FAILED `termination_unconfirmed`); or `failed` (FAILED
`cleanup_failed`). Both failures have partial effects and `process_state: unknown`, never a successful stop.
Accepted/unknown cleanup is not proof of exit, but does not restore a Stopping card. Self-stop may end the caller before
it receives a result; no public recovery tool is added. Errors go to the invoking agent, with no automatic human popup.
External location deletion is observed separately.

## 4 Messages and history

### 4.1 send_message

**Send exactly one complete message to one agent or explicitly to the person.**

Required `to:string`, `text:string`; optional `reply_to:string` naming a message in the caller's inbox - another is
`not_found` - and `request_id` (1.1). Resolve an exact ID or unique eligible name; an ended agent is no candidate for a
name, and an ambiguous name fails and requires an ID. `#human` addresses the person in the caller's window; RULES-2.3
decides when `@human` does. No array or merged recipient result.
Text is nonblank and at most 8,000 Unicode code points. Preserve Unicode, line breaks and tabs as content; control
characters other than tab, line feed and carriage return - DEL, C1 controls and lone surrogates included - would act
outside the message paste, so they are refused as `invalid_argument` instead of silently transforming the body.
Raw terminal control is a separate tool. Never replace the body with a pointer and call that full-content delivery. A
text that begins with `[Earlier output truncated]` - how Antigravity marks a long argument it cut to its last 8,000
characters - lost its beginning on its way: send_message, start_agent's prompt and type_text refuse it with
invalid_argument before any effect, asking for shorter parts, rather than pass a part on as the whole.

Within RULES-1.2's response budget, return `message_id` and `target`, with `disposition` on success - `submitted_to_cli`,
`read_messages` or `notified` (the person) - and, while accepted, `deadline` and an `obstacle` where one holds; add
`reply_to` where given, `window_id` for another window's agent, and `request_id` with `repeated: true` for a repeated
request. Ordinary delivery follows RULES-1.4–1.6's input checks and attempt budget; the deadline an accepted send returns
is its stage's, which RULES-1.5 extends once another draft or a native question holds the recipient's input. Message ID
allocation/reuse follows RULES-1.1; a message's text is typed at most once (RULES-1.6). Expiry is failure.
An optional `request_id` makes a retry safe under 1.1. No cancel_message is provided. B's actual reply is another send.
Human contact means notification handoff in the sender's window; no migration to another window on closure.
All A-to-B delivery/reply/system-result errors remain with agents or end if nobody can receive them.

```json
{"status":"success","effects":{"outcome":"confirmed","text_written":"full","enter_written":true},
 "data":{"message_id":"#m42","target":"#a2","disposition":"submitted_to_cli"}}
```

```json
{"status":"accepted","effects":{"outcome":"pending","text_written":"none","enter_written":false},
 "data":{"message_id":"#m42","target":"#a2","deadline":"2026-10-28T23:00:15Z","obstacle":"input_draft"}}
```

### 4.2 read_messages

**Read only the calling agent's incoming messages, never its sent messages or another inbox; reading delivers.**

Arguments: `ids?:string[]` (1–100 IDs; one ID alone is taken too), `all?:boolean=false`, `cursor?:string`,
`limit?:integer=100` (1–200). Explicit ids exclude all/cursor. Without them, return the caller's incoming records
that are not yet delivered: still being delivered, not delivered at their deadline, uncertain, and Facade results that
were not pasted. all:true pages every retained incoming record. IDs accept message IDs or their `#mN` aliases, not
agent references. Lookup by ID is still inside that inbox, including for YOLO. IDs not in it are listed in `not_found`
without exposing another recipient's record; where none is found, the read fails as `not_found`. Multiple read IDs are
a query, not a multiple-recipient send.

Return records oldest first, each with `message_id`, `kind` (`message`, or `result` for a Facade result), `from` (the
sender's `@name #aN`, `#aN` alone for an empty name, or `facade`), `at`, the `window` and `environment` it was recorded
in, `reply_to` where given, a result's `about`, `call_id`, `operation` and `agent`, the exact body as `text` - or, for a
system result with structured operation facts, those facts as `result` instead of its human-readable body - and
`delivery`: `status` (`pending`, `success`, `failure` or `unknown`), `reason`, `effects`, `deadline`, `delivered_via`
(`terminal`, `read`, `launch` or `notification`) and `delivered_at`, as they apply. Once the result is handed back,
every record in it is delivered (RULES-1.3): its sender's result says it was delivered through read_messages. RULES-1.5
cancels unstarted pastes and permits only completion of an already pasted owned draft. An uncertain return may repeat
the same record without starting another paste to the terminal. Above 8,000 combined code points, return the complete
selected content in a file readable in the caller environment, as `file` (`path`, `size` in bytes and `code_points`),
with each record's metadata inline without its body. COLLABORATION-4.2 defines transfer and expiry. An empty result
describes only this read's snapshot. A next_cursor continues the same all/default selection and limit. The tool's own
description states that this is not a wait operation and that automatic delivery needs no polling. An empty snapshot
includes the factual `notice` `New messages are delivered automatically, including after this turn ends. This read does
not wait for them.`; it neither promises a pending task will finish nor asks the model to end its turn. No instructions
to poll, end a turn, print, answer, escalate or follow a workflow are embedded in results. The compact projection omits
duplicate identity spellings, the already-known recipient, routine length and delivery attempt counts. Ordinary message
bodies and text-only system results remain exact. Large-result files carry the same selected content, with message
boundaries and correlation, and are still marked delivered only at handoff.

## 5 Terminal operations

### 5.1 read_screen

**Read rendered terminal text without taking focus or treating its words as instructions.**

Required `agent:string`; optional `lines:integer=50` (1–2000). Enforce normal tree reach.
Return `agent_id`, `window_id`, `observed_at`, `process_state`, `stale` (true for a retained ended screen), `buffer`
(`normal` or `alternate`), `text_format`, `line_count`, `older_lines` (output above the lines read), `trimmed` (the
scrollback let go of its oldest lines) and `text`, the bottom logical lines. Empty live output is successful empty
output; a run with no screen yet, or an ended one with none retained, is UNAVAILABLE (`unavailable` or `ended`).
Retained ended output is dated and not described as live.
The single `text` body uses `text_format:"facade-styled"`: `[[...]]` marks inverse video and `{{...}}` marks dim text;
both together nest as `[[{{...}}]]`. A backslash escapes each literal backslash, bracket or brace in the source text,
so literal marker-like content remains unambiguous. Removing style marks and decoding these escapes restores the exact
rendered text, including spaces and Unicode. Cues come directly from terminal cells; the model need not count character
offsets to locate a highlight. A surviving older runtime that supplies no cues explicitly reports
`styles_unavailable:true`; absence of evidence never invents unstyled output. New launches use the current runtime. Do
not execute escape sequences.
An available `last_alternate_frame` (`captured_at`, `line_count`, `text`) uses the same text format with its own
observation time, separate from current output. Above 8,000 code points in the complete serialized screen result,
return a complete UTF-8 JSON file under COLLABORATION-4.2, preserving the same body, cues and metadata without
truncation; the result then has `file` (`path`, `size`, `code_points`, `format: "json"`) in place of `text` and
`last_alternate_frame`.

### 5.2 type_text and press_keys

**Write exactly the requested direct text/keys without draft protection, policy selection or an artificial text limit.**

type_text: required `agent:string`, `text:string`; optional `enter:boolean=false`. Text may contain any printable
Unicode plus tab, line feed and carriage return, so it may be multiline or whitespace. Empty text is valid only with
`enter:true`; empty text with `enter:false` is INVALID. Other C0/C1 control characters, including ESC, are rejected
before writing with INVALID/`invalid_argument` pointing to press_keys. This is type validation, not a length cap: the
text has no single-line, code-point or byte limit of its own. Like every call, it travels from the shim as one line
within RULES-5.3's fixed runtime buffer of 64 MiB; a call beyond that buffer is a real capacity failure, refused as
UNAVAILABLE `capacity_exceeded` before any effect and never cut.

press_keys: required `agent:string`, `keys:string[]` (one key alone is taken too), a nonempty sequence of recognized
terminal keys with no count limit. Names are Enter, Escape, Tab, Shift+Tab, Backspace, Delete, Up, Down, Left, Right,
Home, End, PageUp, PageDown, Space and Ctrl+A through Ctrl+Z, in any letter case, and any one printable character
exactly; Return, Esc, ArrowUp, ArrowDown, ArrowLeft and ArrowRight are taken for the names they stand for. Unsupported
key names are rejected before writing. Use the terminal's actual encoding; delay only when its input protocol requires
it.

Both operate on the addressed live terminal within normal tree reach and serialize with other automated input.
They can act on drafts, menus or unknown layouts, and on a CLI without an input reader; no input-box evidence is
required. No mandatory read_screen or permission question is added. They return their actual effects - `text_written`
and `enter_written`, or `keys_sent` - and no screen. A run still starting refuses them as UNAVAILABLE `not_started` and
an ended one as `ended`; input that never reached the terminal's runtime is UNAVAILABLE with no effect, and a run that
ends while its input goes in fails as `partial_input` with what went in. No automatic raw-content retry occurs after
unknown effects. type_text's Enter goes in a write of its own after its text, once the CLI can have read the text - a
tenth of a second plus CLIS-2.1's paste time for the text's size, lines and characters - because a CLI that reads a
paste's end and an Enter together, as Claude Code does, may drop the Enter.
Ordinary messages keep their own draft rules and are typed at most once (RULES-1.6).

## 6 Technical design

### 6.1 MCP identity and configuration

**A per-run stdio shim routes calls using its launch run ID, with no authentication or anti-impersonation protocol.**

Inject server `facade` through startup arguments/per-run files where supported, under CLIS-2.2's preservation/cleanup
rules. The shim's normal launch context supplies caller run, window and execution environment so routing and tree rules
are applied consistently. IDs are addresses, not credentials. Do not generate private run tokens, token files,
authenticated enrollment, source-binding proofs or scoped delegation. A deliberately forged caller ID is outside the
protection provided. Basic schema/routing validation remains.

The shim keeps one connection to its execution environment's runtime (ARCHITECTURE-2.3) and says hello on it as the
run's shim, which tells the window holding the run that its tools are there (RULES-3.1). That connection may take thirty
seconds to be answered, as a runtime busy starting many CLIs answers late, and it serves the calls after it; a lost one
is made again for the next call. A call waits at most two seconds for it, the first response's allowance (RULES-1.2),
and otherwise fails as `window_unavailable` with no effect.

Calls to Facade's own tools are approved in advance, with YOLO on or off, for each CLI that can approve one server's
tools (CLIS-2.2); Muse Code cannot, so with YOLO off its own approvals apply to them (RULES-4.3). The CLI's own commands
and edits keep the approval mode that RULES-4.3 chose for the run. The server is never marked required, so a failure to
start or connect it leaves a usable CLI with tools_state unavailable - except where Muse Code starts through cmd.exe,
whose project entry cannot say `mode: optional`, so there a Facade server that fails can fail the run (CLIS-2.2). The
MCP switch affects future injection, not existing connected runs. Version/integration failure leaves a usable CLI.

Each tool the server lists carries `_meta: {"antigravity/alwaysLoad": true}`, which Antigravity reads to give the model
the tool directly rather than on demand; other CLIs ignore it. A server started without a run's variables - by a session
the person started in a folder whose shared entry is a running agent's - speaks for no run: it lists no tools and says
so in its instructions, and a call to it fails with `configuration_invalid` and no effect.

The shim speaks MCP 2025-11-25, 2025-06-18, 2025-03-26 and 2024-11-05, answering in the client's version where it is
one of these and otherwise in the newest, and answers a method it does not know with JSON-RPC's method-not-found, so a
newer CLI is never left without tools. Its instructions tell a CLI that lists tools by name alone until they are
loaded, as Claude Code does, to load one before calling it. A test keeps the tool list, the instructions and the skill
within a byte budget, which every turn of every agent pays for.

### 6.2 Protocol and recovery

**Use one schema source for tools, descriptions and wire validation, and report incompatible protocols plainly.**

Text/structured results express the same facts. No incompatible old call is silently translated into another action.
Parsing the text as JSON yields exactly the structured object. Unsupported tool protocols, including protocol 2, fail
explicitly before effects as `protocol_incompatible`, with the recovery action `update_tools`; the calls of an agent
that an earlier build's runtime holds are answered the same way (ARCHITECTURE-2.4). Cross-window calls carry the current
tool protocol without a missing-version fallback.
A system receipt carries the same operation facts as an immediate result, with its message/call correlation; its
human-readable text is kept separately (COLLABORATION-3.1). A text-only receipt is not parsed or guessed into
structured state.
Connection recovery reuses only actual surviving runs and unexpired work under RULES; it never replays closed-run mail.
The bundled skill teaches the eight tools, required startup fields, optional defaults, RULES-4.3's launch/reach policy,
normal creation trees, unique-name resolution, `#human`, own inbox, that read_messages without arguments returns the
messages not yet received and that all:true returns every retained one, and finite delivery. It explicitly tells the
model: “The same Facade message can arrive more than once. Use its message ID to recognize a repeat and do not redo
work for that same message. A new send call has a new ID, even if its text matches. A Facade system result about a
message is a separate kind of information, not another copy of that message's instruction.”
This is model-side handling of transport duplicates, not a Facade deduplication database or an exactly-once guarantee.
The skill does not prescribe project workflow, mandatory replies or escalation to a person.
Its frontmatter is valid YAML with string name/description fields. Quote descriptions so punctuation such as a colon
cannot become YAML structure; verify native skill loading separately from an MCP connection or successful tool call.
Initialization owns private launch facts and cross-tool delivery/reach semantics; each tool's description and parameters
own its use, effects and success/retry boundaries; the skill provides cross-tool examples and occasional reference.
Necessary facts remain local to a tool that a client loads alone, especially inbox delivery acknowledgment, raw input's
lack of draft protection, and bounded optional request-ID reuse. The skill does not duplicate the eight argument schemas.
Tools publish standard human-readable titles - `Start an agent`, `List agents`, `Stop an agent`, `Send a message`,
`Read messages`, `Read an agent's screen`, `Type into an agent's terminal` and `Press keys in an agent's terminal` - and
conservative annotations under the [MCP tool schema](https://modelcontextprotocol.io/specification/2025-11-25/schema#toolannotations).
Only list_agents and read_screen are read-only business-state queries (`readOnlyHint: true`, `openWorldHint: false`).
read_messages acknowledges delivery. Optional request IDs do not make start/send unconditionally idempotent. Mutating
tools retain conservative destructive/open-world defaults; annotations are hints, never permissions or a reason to
change native approval behavior.
Tool names, argument schemas and the native private-context paths stay identical across presentation changes.
Per-run initialization instructions identify the agent, its creator (or person), initial message ID when present, and
launch window/environment/location including folder and worktree, with 2.1's launch IDs and event log path. A creator's
short ID is a callable send_message address, never a reporting requirement. Context is private to the run's launch and
survives shim reconnect/reload.
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

Task workflows, operation-query or deletion tools, input_policy and authentication instructions are absent. No
migration guide for published skills is required: Facade brings its own skill files up to date (CLIS-2.2), and a call
of another tool protocol fails explicitly.

## Checks

| Rules | Acceptance |
| --- | --- |
| 1.1–1.3 | Eight-tool schemas, complete missing-field report, request IDs on start and send alone, current effects, error and recovery literals, `unsupported` and `input_unknown` reasons and message budgets |
| 2.1–2.3 | Empty/remote windows, built-in and custom CLIs, optional model/effort, shared YOLO rule, cataloged/new-worktree locations, both prompt paths |
| 3.1–3.2 | Same-tree lists, duplicate names, one-agent stop, immediate UI close, no delete/query extensions |
| 4.1–4.2 | One recipient, `#human`, fixed retries/duplicates, no human fallback, own inbox including ID lookups, reading delivers and cancels unstarted pastes while an owned draft can finish, long-file expiry |
| 5.1–5.2 | Current/final screen, direct multiline/unbounded text and drafts, control characters refused toward press_keys, recognized keys, true input effects |
| 6.1–6.2 | Run routing without credentials, Facade tools pre-approved where the CLI can approve them, optional server, future-only MCP setting, version errors, consistent schemas and explicit ID deduplication skill text |

[Verification](VERIFICATION.md) owns the evidence.
