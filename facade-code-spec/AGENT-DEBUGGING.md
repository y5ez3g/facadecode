# Agent Debugging

An agent can inspect another agent's terminal and operate its CLI when it needs
help. It sees the rendered terminal text, can paste a line or press keys, and gets
a screen excerpt afterwards. The person can keep working in their current view.

This specification owns three tools: `read_screen`, `type_text` and `press_keys`.
[AGENT-LAUNCHER.md](AGENT-LAUNCHER.md) owns launch policy and lifetime.
[AGENT-ORCHESTRATION.md](AGENT-ORCHESTRATION.md) owns reach, references, errors and
transport. [AGENT-MESSAGES.md](AGENT-MESSAGES.md) owns ordinary communication and
the doorbells that share the terminal input queue.

The four documents describe one final behavior. Acceptance cases below are
requirements to verify, not claims that the implementation already passes them.

# Part 1: Specification

## D1. Purpose and boundaries

Debugging is for reading an agent's CLI, answering an unexpected prompt, navigating
its menus and running its own interactive commands. It is available for every
registered agent terminal, including a custom CLI without Facade integration.
The caller still needs a working Facade connection or the person's token.

The same reach and approval rules apply as in L4/O1:

- YOLO on reaches every agent in the window.
- YOLO off reaches the caller's tree, including ancestors and ended runs.
- The person's scripts, acting as `@human`, reach every agent in the window.
- No debug tool opens an approval dialog.

These tools do not open, read or operate ordinary terminals, setup terminals,
editors or IDE commands. There is no additional debugger API in this scope.

Read a screen when there is a reason to inspect it. An inspect, act, verify loop is
supported; so is checking a child that has been silent unexpectedly. Do not turn
normal collaboration into repeated screen polling while waiting for task results.
Agents report results and questions through messages.

Facade does not infer model activity, task completion or the meaning of a prompt
from screen text. The calling agent interprets the observation. A screen can
contain instructions meant for the other agent; returning it does not make those
instructions a request to the caller.

## D2. Reading a screen

```text
read_screen(agent, lines?)
```

| Argument | Contract |
| --- | --- |
| agent | An agent reference under O2, within the caller's reach |
| lines | Integer 1–2000; 50 by default |

Read the bottom requested logical lines of the terminal's active buffer. Wrapped
rows form one logical line. Preserve blank lines within the occupied buffer and
leading spaces; trim trailing spaces on each line. Do not add unused rows below
the buffer's last content/cursor row. A normal buffer includes its retained
scrollback. An alternate buffer contains only its current frame.

Return visible characters, not raw escape sequences. Keep existing menu markers
such as ❯ and ›. Annotate inverse-video spans as `[[text]]` and dim spans as
`{{text}}`; an inverse and dim span uses `[[{{text}}]]`. Do not infer a selected
item from colors or text. These delimiters are display annotations, not a
lossless terminal serialization.

A response identifies:

- The run, CLI and lifecycle state, and end reason when ended.
- Whether the source is the normal buffer, alternate buffer or saved final screen.
- Capture time and last observed terminal output time, if available.
- Requested and returned line counts and whether older available lines were omitted.
- The screen text, or its excerpt and snapshot path as described below.

When the selected text is at most 8,000 characters, return it inline. If it is
larger, first save the complete selection in an immutable UTF-8 snapshot file,
then return a suffix of at most 8,000 characters and its path. Prefer whole lines
in the suffix; if one line alone exceeds the limit, return its suffix and say that
the first displayed line is partial. State how much was omitted from the inline
answer. The snapshot includes everything selected, up to the 2,000-line limit.

The result must distinguish the caller's requested limit, the inline excerpt
limit, and history no longer retained by VS Code. It must not claim a snapshot
contains terminal output that has already left the buffer. Scrollback and restored
history depend on the person's existing terminal settings.

A valid target can have no screen yet:

| Situation | Result |
| --- | --- |
| Worktree/setup phase; no agent terminal created | Empty screen with phase and “terminal not created yet” |
| Terminal exists but has produced no text | Empty screen with “no text yet” |
| Terminal restoration in progress | Wait up to the configured timeout, then UNAVAILABLE; do not mark the run ended |
| Ended with a saved final screen | Read that saved screen |
| Ended without one | Empty screen with the recorded end reason and why no screen is available |

`@human` has no terminal and is REFUSED. Invalid arguments have no read or write
effects. Reads do not focus, reveal, scroll, resize or otherwise change the target
terminal. Background terminals must be readable without first opening their tab.

## D3. One input queue and a ten-second human-input guard

All automated input into a run shares one FIFO queue: initial typed task notices,
message doorbells, `type_text` and `press_keys`. One operation's text and Enter,
or its complete key sequence, is not interleaved with another Facade operation.
A tool's two-second observation delay is outside the input queue; its screen may
therefore also show the effects of a later queued operation.

Track direct human keyboard/paste input separately from Facade writes and terminal
protocol responses. Text or paste marks human input pending. Enter or Ctrl+C clears
that marker; subsequent input can set it again. While pending, any human key
updates the last-input time. This is a small input guard, not a parser of the CLI's
input field; other editing shortcuts need not prove that a draft is empty.

Before starting an operation:

1. Recheck the target's run id, current process and allowed state.
2. If human input is pending and its last key was less than ten seconds ago,
   leave the operation queued.
3. Continue when the person presses Enter/Ctrl+C, or after ten seconds without
   another human key.
4. At that point, type into the existing input as it stands. This may append after
   an unfinished draft and, if Enter is included, submit both.

Do not wait indefinitely for a draft to disappear, save/restore an input field,
steal focus or ask the person to approve the input. The guard is checked once at
the start of an operation. It does not lock the keyboard; a person who resumes
typing can still interleave with it.

A debug call can wait in the queue up to `facade.agents.timeout`. If it has not
begun by then, remove it and return UNAVAILABLE with `outcome: "not_applied"`.
It must not type later after reporting that outcome. Once it begins, report the
actual effect under D4/D5. Doorbells remain scheduled while guarded; they are not
silently dropped because a debug call's wait budget expired.

`stop_agent` does not wait behind terminal input. Stopping/ending a run rejects
its queued input and drops any remaining keys in an operation already in progress.
Never apply queued input to a replacement process, even if it has a similar title.

## D4. Typing text

```text
type_text(agent, text, enter?)
```

| Argument | Contract |
| --- | --- |
| agent | Reachable starting/running agent with an existing terminal |
| text | One nonempty line, 1–2000 Unicode code points, without control characters |
| enter | Boolean, false by default |

Preserve the text exactly, including spaces at its ends. Reject line breaks,
Escape, tabs, C0/C1 control characters and Unicode line/paragraph separators.
Refuse the whole request before typing anything. Use `press_keys` for controls
and an Enter with no text; use messages or a file for a long body.

Send the line as one paste. Use bracketed paste when the terminal has enabled
that mode, through the existing terminal paste path. A CLI may display a long
paste as a collapsed placeholder; Facade does not expand or interpret it.

With `enter: true`, wait the launch's configured `enterDelay` after pasting,
then send Enter once. The delay is the fixed launch value from L9, not a claim
that a quiet screen means the CLI is ready. Text and Enter remain one queued
operation. Without `enter`, send no Enter.

Two seconds after the last input, return what was sent and the last 20 lines under
D2. Include the actual character count, whether the paste was sent and whether
Enter was sent. This reports terminal writes, not whether the CLI accepted a
choice or the model acted on the text.

If the terminal ends between paste and Enter, send no Enter and return the
partial effect with its final screen when available. Failure to collect the
post-input screen does not turn a known completed write into “nothing happened”:
report the write and the screen's unavailability separately.

Ordinary work requests and answers use `send_message`. Text typed here is
indistinguishable from the person's terminal input to the receiving CLI, and is
not added to message history.

## D5. Pressing keys and uncertain outcomes

```text
press_keys(agent, keys)
```

`agent` follows D4. `keys` is an array of 1–50 strings, each naming one supported
key or one printable Unicode character.

Supported names are Enter, Escape, Tab, Shift+Tab, Backspace, Delete, Up, Down,
Left, Right, Home, End, PageUp, PageDown, Space, and Ctrl+A through Ctrl+Z.
Names are case-insensitive and allow whitespace around/between their components.
Accept Return, Esc, ArrowUp/Down/Left/Right, and ^A through ^Z as aliases.
A single printable character is sent unchanged; a single space means Space.

Validate every element before sending the first. An unknown key rejects the
whole call with INVALID and the supported names. Do not guess at chords, function
keys or multi-character strings outside this list.

Send keys in order, 50 ms apart, using the target terminal's current input modes.
They go to the terminal process, not through VS Code's global keybindings.
Return two seconds after the last key, with the keys actually sent, their count,
and the last 20 screen lines. If the terminal disappears mid-sequence, drop the
rest and report the exact known prefix.

An agent may type into itself. Escape or Ctrl+C can interrupt the caller before
it receives the result. Some CLIs exit on repeated Ctrl+C or Ctrl+D. These are
ordinary CLI effects; use `stop_agent` when the intent is to end a registered run.

Neither the shim nor the host automatically retries text or keys after a lost
reply. If the caller cannot learn how much was written, return
`outcome: "unknown"`. The next step is to inspect the screen and run state,
then decide whether another action is appropriate. Do not replay a key sequence
merely because its response timed out.

## D6. Final screens and snapshot lifetime

Capture the final screen when a registered terminal closes, after available
process output has been flushed and before its buffer is disposed. This applies
to ordinary exit, launch failure after terminal creation, an explicit stop and
removal of the agent's folder.

If the CLI used an alternate screen and left it, retain the last alternate frame
as well as the final normal buffer. Save separately labeled sections, at most
2,000 logical lines in total: keep the last alternate frame first, then fill the
remaining budget with the newest normal-buffer lines. If the active final buffer
is alternate, save it once. Preserve the ordering/labels in the saved file.

`read_screen` on an ended run reads that file. When both sections exist, select
the newest requested lines of the final normal section first and use any remaining
line budget for the last alternate frame; include a notice that the full saved
snapshot contains the other section. The final-screen file path is available
even when the inline selection fits. A CLI's last menu must not become
irretrievable because it restored a mostly empty normal buffer on exit.

The final 20-line excerpt for a failure or lifecycle message follows the same
selection rule. It is an observation, not a conclusion about whether the task
succeeded. Include a snapshot path/read_screen hint when more information exists.

A run lost without an observed terminal, a failure before terminal creation or an
ordinary whole-window shutdown need not have a final screen. Say why it is
missing. Do not synthesize one from unrelated logs or imply that no screen means
no failure.

Store final screens and large live-screen snapshots under the workspace record's
`screens/` directory. Generated paths are local UTF-8 files readable by the
supported CLIs within their effective launch sandbox without another approval.
Snapshots are immutable once returned. Keep them through reloads and while the
run remains in the current list; delete them when that ended run is dropped at
a fresh start. Ancestor identity retained solely for a surviving tree does not
promise an expired screen is available.

The person's **Show** action opens a live terminal if one exists, otherwise a
read-only final-screen editor titled `@lint #a3 · last screen`. With no saved
screen, show the recorded launch/exit diagnostic. Do not reopen a CLI command.

Failed/unconfirmed starts include the current/final excerpt under O3.
Messages about a child's end use M8's notification policy; D6 does not create an
extra notification stream. Final capture and the person's Show action remain
available with the agent framework disabled.

## D7. Recovery and agent guidance

The hello instructions, Facade skill and tool descriptions teach this workflow:

1. Use messages for tasks, results and questions. Wait for replies through the
   mailbox instead of repeatedly reading a healthy child's screen.
2. Inspect a failed or unconfirmed start, a task not fetched, a delayed message,
   an unexpected exit, or a run whose silence suggests an interactive problem.
3. Read before sending keys. Decide what the displayed CLI needs; do not infer it
   from a run title or a previous screen that may have changed.
4. Type or press the smallest useful sequence, then inspect the returned screen.
   Continue an intentional debug loop when needed.
5. If actual information is missing, ask the creator by message. Escalate up the
   creator chain; the root asks the person in ordinary text in their terminal.

Blocking question tools are disabled under L4, including for human-created roots.
If an unavoidable vendor prompt still appears in a child, its creator uses these
tools to resolve it from the available context. Do not send the person to click
a child's AskUserQuestion button. A login or credential that only the person can
supply follows the same escalation path, with clear instructions in the root's
conversation.

Debug input may also clear a menu that swallowed a doorbell. The original message
remains unread until fetched; answer the menu and let delivery continue.
Do not create another child or duplicate the task merely because startup or a
message was unconfirmed.

# Part 2: Technical Design

## D8. Extend the existing terminal bridge

Keep the launcher/orchestration architecture and add the small screen service to
its existing layers:

```text
contract/  readScreen, typeText, pressKeys: schemas and readable/structured results
core/      screens: reach, screen selection, input results and recovery guidance
record/    screen files and existing agents.log
host/      workbench terminal calls and read-only final-screen documents
```

The workbench owns the terminal buffer and the shared per-run input queue.
The extension owns tool validation, scope and the response. Do not introduce a
second terminal emulator, vendor-specific screen reader or prompt classifier.

| Internal operation | Responsibility |
| --- | --- |
| _facade.terminal.read(run, lines) | Snapshot the rendered buffer with D2's annotations and metadata |
| _facade.terminal.type(run, text, options) | Paste with the requested Enter behavior; return observed write effects |
| _facade.terminal.keys(run, keys) | Encode/send the validated keys in the current terminal modes; return the prefix sent |
| _facade.terminal.input(run) | Answer D3's observed human input - a draft pending and the last key - for the doorbell scheduler (M6) |
| Terminal creation/disposal hooks | Register run identity, input tracking and final-screen destination |

Use xterm's parsed buffers and cell attributes, joining wrapped rows. Ensure the
buffer exists for a hidden terminal without changing its visibility. Do not parse
raw PTY output as a substitute for the rendered screen. Output timestamps update
from terminal data events, not by repeatedly taking screenshots.

Use the existing terminal input/encoding paths for bracketed paste, application
cursor mode and supported keyboard protocols, including kitty when enabled by
the CLI. Do not dispatch DOM keyboard events that VS Code keybindings may consume.
If an additional narrow key-encoding helper is required, keep it in the existing
terminal service and test it against the supported CLI modes.

Direct-human-input tracking and automated writes must be distinguishable at the
terminal bridge. Reuse the actual keyboard/paste path and tag Facade writes.
A PTY response or Facade's own Enter must not reset the human-input guard.

Capture final text synchronously in the terminal's pre-disposal path, then write
it through the existing file service. Return a snapshot path only after its file
exists; the captured text can supply an immediate lifecycle excerpt. Retain the last
alternate frame just before xterm processes an alternate-buffer exit sequence,
using a narrow handler on registered agent terminals only. This keeps the
existing final-screen design without continuously recording every frame.

Resolve each operation by run id and current terminal process identity. Recheck
after queue waits. The same terminal service serializes task notices, doorbells
and explicit debug input; separate extension queues that cannot see each other's
writes do not satisfy D3.

Expose saved screens through a read-only `facade-screen:` text document, keyed by
workspace record identity and agent id. Open it with the existing editor service;
use standard themes, selection, copy and find. A custom webview is unnecessary.
Ordinary terminals keep their existing lifecycle and behavior.

## D9. Recording and failure handling

For each accepted `type_text` or `press_keys` operation, write an intent entry
to `agents.log` before sending anything: time, caller, target, text length and
first 40 characters, or the normalized key sequence. Escape newlines/control
characters in log metadata. Follow it with the known effect, partial effect or
unknown outcome. Do not log a rejected request as a completed action.

Reads need no normal log entry. Input does not need a new durable task/delivery
state machine in the ledger. The log explains who operated a terminal; it is
not a reason to replay operations after reload.

Use O2's common error codes:

| Situation | Result |
| --- | --- |
| Invalid line count, text, key list or reference syntax | INVALID, no input |
| Unknown run | NOT_FOUND |
| Out of reach, @human, stopping/ended input target, or no terminal created for input | REFUSED with the specific reason |
| Restoration or queued-input wait expires before any write | UNAVAILABLE, not_applied |
| Terminal ends after a known prefix was sent | FAILED with the actual partial effect and available final screen |
| Reload/connection loss hides the write outcome | UNAVAILABLE, unknown; never claim not_applied |
| Input completed but the follow-up screen is unavailable | Successful input result with screenUnavailable and reason |

Framework-disabled calls fail immediately under O7. Inputs accepted before the
switch changed retain their existing outcome contract; new calls have no effects.
Reload does not replay any pending or partially sent input. A message scheduler
may later ring again using the same message numbers; that is not a retry of an
uncertain debug operation.

# Part 3: Acceptance

## D10. Debugging acceptance matrix

L14 defines the evidence and release gate. U means automated unit test, I a real
workbench integration test, V a live supported CLI test, and H a visible manual
UX check. Tests must assert both the returned facts and the terminal's actual
effects. A mocked write alone does not prove the CLI accepted the interaction.

| ID | Level | Setup and action | Required observation |
| --- | --- | --- | --- |
| DB-01 | U, I | Read reachable, ambiguous, missing, ended and @human references in both modes | O2 resolution and O1 scope are consistent with the other seven tools; explicit ended ids work |
| DB-02 | U, I | Read normal output with wrapping, blank lines, indentation, Unicode and styled spans | Logical lines join correctly; internal blanks/leading spaces remain; only documented annotations are added |
| DB-03 | I, V | Read an alternate-screen menu whose selection uses inverse video and whose hint is dim | Current selection/hint remains understandable; normal-buffer history is not substituted |
| DB-04 | U, I | Request default, minimum, maximum and invalid line counts; exceed 8,000 characters, including one very long line | Bounds/defaults hold; overflow has a readable complete snapshot and explicit excerpt/line omission facts |
| DB-05 | I, H | Read and type into a never-selected background terminal while another folder/editor is active | Correct target receives input; foreground, viewport, selection, terminal size and workspace selection do not change |
| DB-06 | I | Read during worktree setup, before first output, during restoration and after an end without a screen | The distinct empty/unavailable results match D2; no false exit or made-up output |
| DB-07 | U, I | Type empty, multiline, overlong or control-containing text and pass malformed arguments | Whole request rejected; no prefix, paste or Enter reaches the terminal |
| DB-08 | I, V | Paste leading/trailing spaces, non-ASCII text and a long valid line, with and without Enter | Text is preserved; bracketed paste follows terminal mode; Enter occurs once after configured enterDelay |
| DB-09 | I | End a terminal after paste but before Enter; lose its follow-up screen after a complete input | First case reports only the actual partial effect; second preserves successful write facts despite missing screen |
| DB-10 | U, I, V | Send every supported key/name alias and a list containing a final invalid key | Correct normalization/mode encoding; invalid list sends nothing; supported keys reach the CLI, not VS Code commands |
| DB-11 | I, V | Navigate menus in normal/application-cursor modes and a supported CLI's enabled keyboard protocol | The CLI makes the expected selection; no extra characters, global shortcuts or focus movement |
| DB-12 | I | Send multiple keys, end the process midway, and exercise a self-directed interrupt | Keys are 50 ms apart; remaining keys are dropped; known prefix/unknown response is honest and never replayed |
| DB-13 | I, H | Type part of a human draft; queue a doorbell or debug input; continue typing, submit, then repeat and pause | Input defers while recent typing continues; submit releases it; ten seconds of idle releases it even with a draft; no takeover dialog |
| DB-14 | I | Keep a human draft active past a debug call's queue timeout | Call returns not_applied and is removed; it never appears later; a pending mailbox doorbell is retained |
| DB-15 | I | Queue task notice, doorbell, text+Enter and keys together | Each Facade operation is contiguous and FIFO; its observation wait does not block the input queue |
| DB-16 | I | Stop a guarded/queued target, then start another terminal with the same display name | Stop does not wait for the guard; no queued input reaches the ended or replacement run |
| DB-17 | I, V, H | Exit/fail/stop a normal-screen CLI and a CLI that restores normal mode from an alternate screen | Final snapshot is captured before disposal; sections and limits are correct; the last menu remains retrievable; returned paths already exist |
| DB-18 | I, H | Use Show after failure, after exit without a screen and after reload | Standard read-only final-screen editor or accurate diagnostic opens; no CLI is relaunched |
| DB-19 | I | Reload mid-input or lose the MCP response after a write | No automatic replay; returned uncertainty/record agrees with actual writes; later inspection can guide recovery |
| DB-20 | I, V | Read a large live/final snapshot with YOLO off in every supported CLI | File path resolves and is readable without a new approval; full selected text is present |
| DB-21 | U, I | Inspect logs for completed, partial, refused and timed-out inputs and ordinary reads | Intent/effect are distinct; caller/target are correct; no ordinary read spam or false completed entry |
| DB-22 | I, H | Disable/re-enable the framework; reload; start the app again after ended runs | Tools follow O7; final capture/Show survive disable/reload; expired screen files are cleaned with their ended entries |
| DB-23 | I, H | Repeat representative reads, keys and lifecycle operations on ordinary terminals and across windows | Ordinary terminals are outside the API; their existing VS Code behavior is unchanged; no cross-window target is accepted |
| DB-24 | V, H | Give a parent an unconfirmed child or a deliberately blocked prompt and let it inspect, act and verify | Parent can recover through the three tools and resume the original task without sending the person to child buttons |

Timing tests use a controllable clock for the ten-second guard, 50 ms key spacing
and two-second observation delay, plus live checks that real CLIs accept the
configured paste/Enter behavior. Do not make model wording an exact-match test.

## D11. Integrated debugging gate

On the primary supported OS, exercise every built-in CLI as the target of a parent
agent's read, paste and menu-navigation recovery. On every other supported OS,
verify each advertised CLI's paste/Enter, key encoding, sandbox file access and
final-screen behavior. Record the CLI versions and launch configurations as L14
requires; unsupported vendor/platform combinations must be declared.

Use this continuous scenario with the launcher, management and messaging gates:

1. Keep the person's focus in one root terminal while it starts a child in another
   worktree. Deliberately arrange a diagnosable startup prompt or launch failure.
2. The start result provides the phase and screen. The parent inspects it, resolves
   a supported prompt through keys/text, and observes connection/task retrieval.
3. Delay a later message behind an unexpected menu. The parent receives the bounded
   delivery warning, diagnoses the menu and restores ordinary mailbox progress.
4. Confirm a human draft delays automated input only under D3's rule. After a
   ten-second pause, the chosen append-and-submit behavior happens without a dialog.
5. End a child after it fetched a task but before reporting. Its creator receives
   the M8 lifecycle notice and can inspect a final screen, including a saved menu.
6. Exercise a long-screen snapshot and a renderer reload. The relevant files remain
   readable, surviving agents reconnect, and no task/input is blindly duplicated.

The gate passes when observations, tool results and records agree and the parent
can complete recovery while the person stays in their normal conversation.
Reading a plausible screenshot or receiving an MCP success response alone is
insufficient evidence.
