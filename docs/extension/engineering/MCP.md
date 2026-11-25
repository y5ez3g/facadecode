# MCP contract

Group 7 describes the active MCP boundary. Groups 1–6 preserve the legacy implementation interface during the transition.

Layer 4. [Rules](../RULES.md) owns effects and
[Collaboration](../features/COLLABORATION.md) owns message experience.

| Group | Decides |
| --- | --- |
| 1 Common contract | Eight tools, outcomes, waits and validation |
| 2 Discover and start | Startup choices, required window/path/CLI and optional prompt |
| 3 Inspect and stop | Scoped agent lists and single-agent stop |
| 4 Messages and history | One recipient, result reports and own inbox |
| 5 Terminal operations | Screen, direct text and keys |
| 6 Technical design | Run routing, injection, versioning and schema ownership |
| 7 Orchestrator | Active tools and generated contracts |

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
written as JSON text, as some CLIs send it. Report every problem of a call together as `invalid_argument`: the
`message` names missing fields first, then each other problem by field, and says that nothing was done.
IDs are nonempty strings; references accept exact IDs and RULES-2.3's `#aN`, a name with or without `@`, or a
display-name-plus-ID form, plus the person's `#human`. Names can repeat; ambiguity requires an ID. A reference resolves
once within the caller's normal reach.

No tool takes `request_id`, a selectable YOLO/permission profile or input_policy. The relay numbers calls and keeps
that identity when it reconnects to a daemon, so a resumed start or send joins the original operation. The model does
not supply or repeat that number. A new tool invocation is a new request. The normal relay supplies its run ID from
launch context; it is an address, not a credential.

### 1.2 Result envelope and effects

**Every result provides English text and equivalent structured facts without overstating effects.**

Agent-facing results use one compact JSON object as both structured content and serialized text, without an additional
narrative headline. Parsing the text as JSON yields exactly `structuredContent`. A failure sets MCP `isError` to true;
a success sets it to false. There is no `accepted` status.

```ts
type Result<T, FailureData = never> =
  | { status: "success"; data?: T }
  | { status: "failure"; reason: string; message: string; data?: FailureData };
```

Success includes `data` only when it has facts to return. stop_agent, type_text and press_keys return status alone.
Failure has `status`, `reason` and `message`.
The message says what went wrong, whether anything was done, and what to do next. Partial or unknown effects must be
stated in that message; unknown does not mean nothing happened. CLI/Git/transport errors keep their useful diagnostic.

An object's own identity is `id`; references to other objects use `agent`, `window`, `to`, `from`, `creator` or
`reply_to`. Public agent and message IDs use directly callable short references (`#aN`, `#mN`). Internal routing and
stored records retain their own identities. Do not echo ordinary input bodies, character counts or requested keys.
Message and screen bodies are complete, inline or in a file whose path is the string `data.file`.
Human-facing records and notifications keep their own presentation.

Common failure reasons:

| Reason | Meaning |
| --- | --- |
| `invalid_argument` | Missing, unknown or invalid arguments, including an invalid startup window, path or CLI |
| `not_found` | No matching agent or message |
| `ambiguous_reference` | A name matches more than one agent; give an ID |
| `out_of_reach` | A target outside the caller's creation tree with YOLO off |
| `ended` | The target ended and cannot take the requested input |
| `unsupported` | An unknown tool or a CLI without message input support |
| `configuration_invalid` | Invalid settings or a server without a caller on the legacy implementation |
| `unavailable` | Facade or a window cannot be reached, or the result is unknown |
| `capacity_exceeded` | Input capacity is exhausted |
| `partial_input` | Only part of the input reached the terminal |
| `stop_unconfirmed` | A stop was requested but the process's end is not confirmed |
| `worktree_failed` | Worktree creation failed; the message keeps Git's diagnostic |
| `input_draft`, `input_interaction`, `input_unknown`, `timeout` | Message delivery could not finish in time |
| `submission_unconfirmed` | The message was pasted but its submission is not confirmed |

An ordinary message to a CLI without an input reader fails with `unsupported`. A reader that does not recognize the
input box leaves it untouched and can end with `input_unknown`. A message withdrawn before delivery may be sent again
later, as its failure message says. Pasted or unknown input is not safe to replay automatically; inspect the screen
first. An unreachable agent is not proof that it ended. Lost answers to pure queries change no agent/message state;
read_messages is different because reading delivers messages. Agent-operation errors never notify the person
automatically.

The examples use `<test>` for a fixture path and `<time>` for a fixture timestamp.

### 1.3 Waits, progress and async completion

**Return a start when its CLI runs, a stop when it ends, and a send within thirty seconds.**

start_agent answers success once the new agent's CLI runs. A prompt continues separately and produces one later
Facade result saying whether it reached the agent. stop_agent waits for the CLI to end; an unconfirmed stop fails with
`stop_unconfirmed`. Neither tool returns `accepted` or exposes `call_id` or `result_message_id`.
A Facade result is a message with its own `id`, `from: "facade"` and plain `text` (4.2). It asks for no reply and is
not the new agent's answer or proof that its task is complete. Use list_agents for current state; there is no operation
query API. Idle, delivery and input writes never establish task completion.

send_message answers within thirty seconds from the relay's ingress, connection and queue time included. Delivery gets
what remains less half a second reserved for the answer. The deadline is not extended by a draft, menu, pending prompt
or daemon reconnection. A message that could not be typed in time is withdrawn; pasted input whose submission is
uncertain cannot be withdrawn.
There is no later send result. The recipient's reply is a separate send.

Calls route to a window through the legacy implementation's tool link. A transport timeout ends waiting for a reply.
Locally measured elapsed time uses a monotonic clock; process clocks are never subtracted across environments.
read_messages and read_screen each read once and never wait for new activity. A continuing call sends no MCP progress
notification and produces no progress popup. Result delivery remains finite, with no automatic human fallback.

## 2 Discover and start

### 2.1 Launch context and history

**Current launch destinations and CLI availability are part of list_agents; historical facts are read from logs.**

There is no separate startup-discovery tool. MCP-3.1 returns connected windows, including empty ones, their folders
and worktrees, and the CLIs each can start. An agent's startup context identifies its window and folder. list_agents
does not return log paths or model histories. Existing window IDs and paths can be used without another discovery call.
The execution-time checks of start_agent remain authoritative; a snapshot reserves nothing.

CLIS-1.4 owns model/effort values. Facade logs requested settings and actual startup results under ARCHITECTURE-3.3;
it does not aggregate model histories, count model successes or mirror native transcripts. The skill explains how to
filter recent structured log events, when native history is useful, and how to inspect a CLI's own model/effort controls
when a new choice is needed. Defaults and already specified values require no exploratory launch or history query.

### 2.2 start_agent arguments

**Start a configured CLI in its launch folder.**

| Field | Type / meaning |
| --- | --- |
| cli | Required nonempty CLI entry name listed by list_agents for that window |
| window | Required nonempty destination window ID, such as `win-2` or `terminal` |
| path | Required nonempty folder path; relative to the caller's folder when not absolute |
| name | Optional display name string; spaces, duplicates and an empty string are allowed |
| model | Optional nonblank literal; this call's choice takes precedence under CLIS-1.4 |
| effort | Optional nonblank literal; defaults as model does |
| prompt | Optional nonblank initial message, checked as a message body (4.1) |
| worktree | Optional nonempty branch name; reuse its worktree or create one from the repository's current HEAD |

Without name, Facade gives the agent a default name. Without worktree, start directly in path, including an existing
worktree. An editor window requires a folder listed for it; `terminal` accepts any folder. The agent's display name
is not its branch. There is no location_id, base_ref or request_id argument.
A child joins the calling agent's creation tree, including across windows. Its run YOLO follows RULES-4.3;
the caller cannot pass permissions/yolo to choose a mode. No unattended override exists.
The destination checks that the window, folder and CLI are available before starting. Invalid choices fail as
`invalid_argument`; a closed or disconnected window is `unavailable`. A configuration error is `configuration_invalid`,
with the file or entry path and reason. Worktree failure is `worktree_failed`, with Git's diagnostic.

```json
{"name":"backend review","window":"win-2","path":"/work/app","cli":"claude",
 "prompt":"Review the changes in this folder."}
```

For a branch's worktree, add `"worktree":"review-api"`.
Historical requested models/efforts are observations, not an exhaustive allowlist or proof of native acceptance.
Omitting either field leaves the launch configuration, then the CLI's own default, in control under CLIS-1.4. Report
ignored/rejected requested overrides honestly. Do not substitute another CLI, path or conversation.

### 2.3 Start result

**Startup confirms a process, while initial-prompt submission has a separate outcome.**

A success returns only `id`, `name`, `path` and `window` in data. With worktree, path is the resulting worktree's
folder. It does not expose process/tools state, requested settings, prompt details, effects or call correlation IDs.
The golden start of helper answers:

```json
{
  "status": "success",
  "data": {
    "id": "#a3",
    "name": "helper",
    "path": "<test>/project",
    "window": "terminal"
  }
}
```

A missing path answers:

```json
{
  "status": "failure",
  "reason": "invalid_argument",
  "message": "start_agent requires path; nothing was done"
}
```

A start with a prompt has the same result fields. Its later Facade message says whether the prompt reached the agent;
a prompt failure does not destroy a successfully started agent. The legacy implementation gives up a prompt its delivery window
cannot accommodate. Tool unavailability leaves a usable CLI running.
COLLABORATION-2.2 owns native/post-start prompt selection. A failure states any known or unknown startup effects in
message, including the path of a worktree that was created and kept. There is no task object, completion expectation
or automatic creator progress report.

## 3 Inspect and stop

### 3.1 list_agents

**One query returns window discovery and agents within the caller's reach.**

No arguments. There are no filters, details mode or pagination. Ended agents are included, oldest first.
YOLO permits every agent; otherwise only the creation tree is visible. Window/folder/CLI discovery is not restricted
to that tree. The execution-time checks of start_agent remain authoritative; a snapshot reserves nothing.

Return `windows` and `agents` in data. Each window has `id`, `name` and `clis`, the names of CLIs available there.
Editor windows also have `folders`, with worktrees included and each path listed once. The terminal window omits
folders because it can start an agent in any folder. Disconnected windows are omitted; absence from this connected
snapshot does not prove a window or its agents no longer exist. There are no counts or coverage fields.

Each agent has `id`, `name`, `cli`, `window`, `path`, `state` and `creator` (`#aN` or `#human`).
State is `starting`, `working`, `waiting_for_you`, `just_done`, `idle`, `error`, `ended` or `unknown`.
Only waiting_for_you adds `waiting_for`: `permission`, `question`, `auth` or `unknown`.
State describes the CLI's observed activity, not task completion. Model, effort, YOLO, tools state and detailed process
or terminal facts are not returned.

Above 8,000 code points in the serialized data, return only `data.file`, a path to a JSON file holding the complete
windows and agents object. Do not truncate or page it.

### 3.2 stop_agent

**Stop one identified agent's CLI and answer once it has ended; its record and screen stay.**

Arguments: `agent:string` required. No delete_worktree, discard_changes, recipient array or request ID.
Resolve an allowed agent, prevent new input and stop its process. Do not stop children. Missing IDs fail without
guessing. Stopping an agent that has already ended succeeds. Success returns no data:

```json
{
  "status": "success"
}
```

A requested stop whose end is not confirmed fails as `stop_unconfirmed`; its message says to check list_agents.
An unknown outcome is not proof of exit. Self-stop may end the caller before it receives a result; no operation query
is added. Errors go to the invoking agent, with no automatic human popup. External location deletion is observed
separately.

## 4 Messages and history

### 4.1 send_message

**Send exactly one complete message to one agent or explicitly to the person.**

Required `to:string`, `text:string`; optional `reply_to:string` naming a message in the caller's inbox - another is
`invalid_argument`. Resolve an exact ID or unique eligible name; an ended agent is no candidate for a name, and an
ambiguous name fails and requires an ID. `#human` addresses the person under COLLABORATION-2.3. RULES-2.3 decides
when `@human` does. The caller supplies one recipient and no request ID.
Text is nonblank, at most 8,000 Unicode code points and 540 lines. Preserve Unicode, line breaks and tabs as content;
control characters other than tab, line feed and carriage return - DEL, C1 controls and lone surrogates included -
would act outside the message paste, so they are refused as `invalid_argument` instead of transforming the body.
Raw terminal control is a separate tool. Never replace the body with a pointer and call that full-content delivery.
Text beginning with `[Earlier output truncated]` lost its beginning on its way: send_message, start_agent's prompt
and type_text refuse it as invalid_argument before any effect, asking for shorter parts.

Within thirty seconds (1.3), return the message's `id` and `delivery`. Argument errors before a send use the
ordinary failure envelope.

| Delivery | Meaning |
| --- | --- |
| `typed_into_input` | Typed into the recipient's input and submitted |
| `read_by_recipient` | The recipient read it with read_messages before it was typed |
| `shown_to_person` | Handed to the person through the caller's editor window |

Ordinary delivery follows RULES-1.4–1.6's input checks. A message's text is typed at most once.
If delivery cannot start in time because of a draft, menu, unknown input box or timeout, withdraw the message from the
recipient's inbox and fail, saying it is safe to send again later. Pasted input whose submission is unconfirmed cannot
be withdrawn; the failure says to inspect the recipient's screen before sending again. A disconnected call may have
sent its message, as its failure says. There is no public cancel tool or later send result.
On the legacy implementation human contact means notification handoff in the sender's editor window. A terminal-window caller
cannot notify `#human` with that implementation. Delivery/reply/system-result errors remain with agents or end if nobody
can receive them. Success is delivery, not a reply or task completion. The recipient's reply is another send.

The golden send to bob answers:

```json
{
  "status": "success",
  "data": {
    "id": "#m1",
    "delivery": "typed_into_input"
  }
}
```

A missing recipient answers:

```json
{
  "status": "failure",
  "reason": "invalid_argument",
  "message": "send_message requires to; nothing was done"
}
```

### 4.2 read_messages

**Read only the calling agent's incoming messages, never its sent messages or another inbox; reading delivers.**

Arguments: `after?:string` naming a message ID, or `last?:integer` (1–100). Giving both is `invalid_argument`.
With neither, return messages not yet delivered. after returns the retained messages after that ID; last returns
the newest messages up to that count. One read returns at most 100 messages; where more follow, `data.next_cursor` is
the after that reads them. There are no ids, all, cursor or limit arguments. Selection stays inside the caller's inbox,
including with YOLO. Every returned message is delivered, including unread messages selected by after or last, and
no other message is. Reading cancels unstarted pastes; an already pasted owned draft may finish under RULES-1.5.

Return `data.messages`, oldest first. Each record has `id`, `from`, `at` and the complete body as `text`, plus
`reply_to` when given. `from` is the sender's
`@name #aN`, its ID alone when unnamed, `#human` for the person, or `facade` for a Facade result. A Facade result's text is plain English; there is no nested result object, kind, delivery
record, call ID, window or environment. A system result is separate from the message it concerns.

The golden inbox read of a message held back by a draft answers:

```json
{
  "status": "success",
  "data": {
    "messages": [
      {
        "id": "#m2",
        "from": "@bob #a2",
        "at": "<time>",
        "text": "hi ada",
        "reply_to": "#m1"
      }
    ]
  }
}
```

Above 8,000 combined body code points, return the whole page of records as a JSON array in the file named by
`data.file`, a string path. When another page follows, the result also includes `data.next_cursor`. If writing that
file fails, return the page inline as `data.messages` so the read does not lose the messages it delivered.
An uncertain return may repeat the same record without another terminal paste. An empty result has an empty messages
array and no notice. This is an immediate snapshot, not a wait or evidence about pending work. New messages arrive
through normal delivery.

## 5 Terminal operations

### 5.1 read_screen

**Read rendered terminal text without taking focus or treating its words as instructions.**

Required `agent:string`. Optional `lines:integer=50` accepts 1–2000 and counts the last lines including scrollback.
Enforce normal tree reach. Return only `ended:boolean` and `text` in data. `ended` says whether the run had ended when
the screen was read. When true, return the screen that run left. A later read after a resume can show new output
under the same agent ID. Empty live output is successful empty output. An agent without a screen fails as
`unavailable`.

The text uses `[[...]]` for inverse video and `{{...}}` for dim text; both together nest as `[[{{...}}]]`.
A backslash escapes each literal backslash, bracket or brace in the source text, so literal marker-like content
remains unambiguous. Removing style marks and decoding these escapes restores the exact rendered text, including
spaces and Unicode. Cues come directly from terminal cells; the model need not count character offsets to locate a
highlight. Do not execute escape sequences.

Above 8,000 text code points, return `ended` and `file`, a string path to a complete UTF-8 text file, in place of text.
If writing the file fails, return `unavailable` and ask for a smaller `lines` value.
There is no agent ID, timestamp, buffer, style-format field, line count, stale flag or last_alternate_frame in data.
A string passed as `lines` gives this answer.

```json
{
  "status": "failure",
  "reason": "invalid_argument",
  "message": "lines must be an integer, not a string; nothing was done"
}
```

### 5.2 type_text and press_keys

**Write exactly the requested direct text/keys without draft protection or policy selection.**

`type_text` requires `agent:string` and `text:string`.
`enter:boolean` defaults to false.
Text may contain printable Unicode, tabs, line feeds and carriage returns. Other C0/C1 controls cause
`invalid_argument` before anything is typed. Use `press_keys` for Esc or to press Enter by itself.

`press_keys` requires `agent:string` and `keys:string[]`. A JSON array written as a string or a single key string
is also accepted. A call takes 1 to 100 keys after this conversion. Use Enter, Esc, Tab, Shift+Tab, Backspace,
Delete, Up, Down, Left, Right, Home, End, PageUp, PageDown, Space, Ctrl+A through Ctrl+Z, or one non-control Unicode
code point per key. Named keys and Ctrl combinations ignore ASCII case. Single code points are typed as given.
On an invalid batch, the tool returns `invalid_argument` before typing and gives the current spelling for
Escape, Return and ArrowUp-style aliases. Keys use the terminal's encoding and timing.

Both operate on the addressed live terminal within normal tree reach and serialize with other automated input.
They can act on drafts, menus or unknown layouts, and on a CLI without an input reader; no input-box evidence is
required. No mandatory read_screen or permission question is added. Both tools return status alone on success:

```json
{
  "status": "success"
}
```

An ended agent fails as `ended`; a run that ends during input can fail as `partial_input`. The message states any
partial or unknown effect and says to inspect the screen before typing again. No automatic raw-content retry occurs
after unknown effects. type_text's Enter goes in a write of its own after its text, once the CLI can have read the
text, because a CLI that reads a paste's end and an Enter together may drop the Enter.
Ordinary messages keep their own draft rules and are typed at most once (RULES-1.6).

## 6 Technical design

### 6.1 MCP identity and configuration

**A per-run stdio relay routes calls using its launch run ID, with no authentication or anti-impersonation protocol.**

Inject server `facade` through startup arguments/per-run files where supported, under CLIS-2.2's preservation/cleanup
rules. The relay's normal launch context supplies caller run, window and execution environment so routing and tree rules
are applied consistently. IDs are addresses, not credentials. Do not generate private run tokens, token files,
authenticated enrollment, source-binding proofs or scoped delegation. A deliberately forged caller ID is outside the
protection provided. Basic schema/routing validation remains.

The relay keeps a connection to the daemon and says hello with its process identity, environment and folder.
The run's MCP presence tells Facade that its tools are there (RULES-3.1). Each tool call opens a daemon connection of
its own (1.3). Failure to connect is `unavailable`, with a message saying that nothing was done.

Calls to Facade's own tools are approved in advance, with YOLO on or off, for each CLI that can approve one server's
tools (CLIS-2.2); Muse Code cannot, so with YOLO off its own approvals apply to them (RULES-4.3). The CLI's own commands
and edits keep the approval mode that RULES-4.3 chose for the run. The server is never marked required, so a failure to
start or connect it leaves a usable CLI with tools unavailable - except where Muse Code starts through cmd.exe,
whose project entry cannot say `mode: optional`, so there a Facade server that fails can fail the run (CLIS-2.2). The
six built-in types attempt injection on every start, with no MCP switch; custom programs have none (RULES-4.4).
Existing connected runs keep their launch snapshot. Version/integration failure follows CLIS-2.2.

Each tool carries `_meta: {"anthropic/alwaysLoad": true, "antigravity/alwaysLoad": true}` to request direct loading
by clients that support those keys.

The relay speaks MCP 2025-11-25, 2025-06-18, 2025-03-26 and 2024-11-05, answering in the client's version where it is
one of these and otherwise in the newest, and answers a method it does not know with JSON-RPC's method-not-found, so a
newer CLI is never left without tools. Its instructions tell a CLI that lists tools by name alone until they are
loaded, as Claude Code does, to load one before calling it. A test keeps the tool list, the instructions and the skill
within a byte budget, which every turn of every agent pays for.

### 6.2 Protocol and recovery

**Use one schema source for tools, descriptions and wire validation, and report incompatible protocols plainly.**

Text/structured results express the same facts. No incompatible old call is silently translated into another action.
Parsing the text as JSON yields exactly the structured object. The tool interface version is separate from the MCP
date versions in 6.1 and the internal relay contract. An incompatible relay contract fails as protocol_incompatible before
effects and says to restart the CLI; there is no recovery object or automatic downgrade. Old argument names fail
validation rather than being translated into another action.
A system result is a plain-text Facade message under its own ID (4.2). It is not parsed or guessed into structured
operation state.
Connection recovery reuses only actual surviving runs and unexpired work under RULES.
It never replays messages from closed runs.
The bundled skill teaches the eight tools, required startup fields, optional defaults, RULES-4.3's launch/reach policy,
normal creation trees, unique-name resolution, `#human`, own inbox, that read_messages without arguments returns the
messages not yet received, after selects newer messages and last selects the newest ones, and finite delivery.
It explicitly tells the model: “The same Facade message can arrive more than once.
Use its message ID to recognize a repeat and do not redo work for that same message.
A new send call has a new ID, even if its text matches.
A Facade system result about a message is a separate kind of information,
not another copy of that message's instruction.”
This is model-side handling of transport duplicates, not a Facade deduplication database or an exactly-once guarantee.
The skill does not prescribe project workflow, mandatory replies or escalation to a person.
Its frontmatter is valid YAML with string name/description fields. Quote descriptions so punctuation such as a colon
cannot become YAML structure; verify native skill loading separately from an MCP connection or successful tool call.
Initialization owns private launch facts and cross-tool delivery/reach semantics; each tool's description and parameters
own its use, effects and success/retry boundaries; the skill provides cross-tool examples and occasional reference.
Necessary facts remain local to a tool that a client loads alone, especially inbox delivery acknowledgment, raw input's
lack of draft protection, and the consequences of unknown input. The skill does not duplicate the eight argument
schemas.
The published 0.1.5 tag contains the legacy tool definitions. The current editor uses the [Framework tool catalog](../../../framework/crates/base/src/texts/tools.json). The MCP annotations are:

| Tools | readOnlyHint | destructiveHint | idempotentHint | openWorldHint |
| --- | --- | --- | --- | --- |
| list_agents, read_screen | true | omitted | omitted | false |
| stop_agent | false | true | true | false |
| start_agent, send_message, read_messages, type_text, press_keys | false | false | false | false |

read_messages acknowledges delivery. All tools act within Facade. Annotations are hints, never permissions or a reason
to change native approval behavior.
Per-run initialization instructions identify the agent, its creator (or person), its folder and window, and its reach
under YOLO. A creator's short ID is a callable send_message address, never a reporting requirement. Personalized
context is private to the run and survives relay reconnect/reload.
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
with incompatible arguments fails explicitly.


## 7 MCP through the Orchestrator

### 7.1 The Orchestrator serves the eight tools

**Agents and external applications use the Orchestrator's MCP tools through `facade-mcp`, the relay of Facade API
v1's MCP entry point.**

The [product](../../PRODUCT.md) describes machine-scoped starts, Guest identity, addressing and message delivery.
The [generated tool descriptions](../../../framework/crates/base/src/texts/tools.json) define the tool arguments and
results. The [daemon API](../../../framework/protocol/DAEMON.md) defines the wire contract. VS Code starts and attaches through
its own Orchestrator client. Background delivery failures and creator watchdog notices use the recipient's Facade
inbox. A startup incident and a failed initial prompt share one notice. See RULES-6.7.

### 7.2 Connection identity and inline results

**The first tool call fixes the connection's identity. Tool results carry content inline.**

A Guest appears in `list` and can receive messages after its first tool call. Compatible service takeover
preserves the identity rules for already-running managed agents through the end of that run. Subsequent starts and
resumes use the current rules. A migrated Guest keeps its relay identity and inbox. If its saved YOLO value is
missing, migration reads the machine's setting once and saves the value.

`list_agents` rows and requested screen lines are returned in full inline. Use `after` to continue from `next_cursor`
with the same filter, or use `last` to select recent messages. Each returned inbox message has its full text in
`data.messages`.

### 7.3 Start on the selected machine

**The target machine supplies the available CLI entries and creates the worktree a start asks for.**

`start_agent` takes a CLI entry and can specify a machine, folder and worktree branch. The target's settings
extend the built-in CLI catalog. For each responding machine, `list_agents` can return a `clis` array of available
CLI names in its default start context. Copy a name and the machine's `selector` into `start_agent`. If the lookup
fails, the machine row can report `cli_error` with no `clis` field. Start checks the selected entry in the requested
context and reports the reason and available entries on refusal. A request for an unsupported model or effort uses
the same refusal in Shell, MCP and settings validation. See the [product's CLI table](../../PRODUCT.md#cli-differences).

For a Guest or a remote machine, the catalog uses the target login environment and directory. A local Guest start
uses its verified relay environment. A local managed agent's catalog uses its verified run environment and
working directory.

```json
{"cli":"claude","machine":"devbox","folder":"/work/app","worktree":"feat-x"}
```

### 7.4 Find an eligible agent for each operation

**An unqualified reference searches awake, reachable machines for an eligible agent.**

Use a machine-qualified address such as `a3@devbox` to select its machine and wake it if it is sleeping. `stop_agent`, `type_text` and
`press_keys` operate on running managed agents. `read_screen` can also read a stopped agent's saved screen.
`stop_agent` explains a stopped target or an unconfirmed stop. An ambiguity reports the usable agent addresses
the caller can choose from.

```json
{"agent":"a3@devbox","lines":50}
```

### 7.5 Delivery across reconnects

**An automatic resend recovers the original delivery outcome.**

Facade resends with the original caller, target and internal request identity. It reuses the outcome even when the
original attempt was withdrawn. Each new `send_message` call creates a message. By default, its receipt confirms
inbox acceptance, and `read_messages` takes an immediate snapshot.

Managed agents normally use inbox acceptance. Replies arrive in their terminals, and a failed background
delivery earns a Facade notice. A guest can wait for a linked reply with `wait_for: "result"` and a positive
`timeout_seconds`. A successful background delivery creates no notice. A repeat keeps the original delivery
and its notice decision.

Set `timeout_seconds` from 1 to 30 to wait. For a send, also set `wait_for` to `delivery` for receipt by the target or
`result` for its first linked reply. The duration covers the whole call. After `reply_timeout`, an agent can use the
original full `data.id` as `read_messages.reply_to` with a fresh timeout. A reply filter includes retained messages
already delivered or read.

To reply to a Shell request, pass its `#cN@machine` sender address as `to` and its inbox number as `reply_to`.
Only the original recipient can answer. The first linked reply reaches the waiting invocation and gets a
`returned_to_request` receipt. A reply after that wait ends fails with `ended`.

## Checks

| Rules | Acceptance |
| --- | --- |
| 1.1–1.3 | Eight schemas, complete validation, v2 envelopes, golden answers, relay-owned request IDs, finite waits |
| 2.1–2.3 | Window/path/CLI choices, optional name/model/effort, shared YOLO rule, branch worktrees, prompt result |
| 3.1–3.2 | Same-tree and ended-agent lists, duplicate names, retained screen after stop, no delete/query tools |
| 4.1–4.2 | One recipient, `#human`, delivery modes, withdrawal, own inbox after/last, reading delivers, long files |
| 5.1–5.2 | Current/final screen, last lines, text/key limits, drafts, rejected controls/aliases, partial input |
| 6.1–6.2 | Run identity, optional server, schemas, annotations, ID deduplication |

[Verification](VERIFICATION.md) owns the evidence.
