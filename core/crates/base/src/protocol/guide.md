## Connect to the daemon

The Facade home is the absolute path in `FACADE_HOME`. If unset, use `HOME/.facade`, or `USERPROFILE/.facade` if `HOME` is
unset. On macOS and Linux the daemon socket is `/tmp/facade-core-<uid>/daemon-<key>.sock`, where `uid` is the process's real
user ID. Only that user can access the socket folder. On Windows the daemon listens on the named pipe
`\\.\pipe\facade-core-daemon-<key>`, and the keeper on `\\.\pipe\facade-core-keeper-<key>`. The pipes let in their owner
alone (DACL `D:P(A;;GA;;;OW)`). Before its `hello`, a Windows client checks that the server process runs as its own user
(`GetNamedPipeServerProcessId`, then that process's token's user SID), and closes the connection otherwise. An `ide`
client is the exception: Node.js, which runs the editor's extension, has no API for that check, so it relies on the
daemon pipe's DACL alone. Lines, framing and every operation are the same on every system.

To compute `key`, encode the home's path string as UTF-8. Replace invalid path bytes with U+FFFD, as Rust's
`Path::to_string_lossy` does. Take the first five bytes of its SHA-256 digest and write them as ten lowercase hexadecimal
digits. Use the path exactly as it was used to start Facade; do not resolve symlinks or normalize it before hashing.

If the socket does not answer, run `facade daemon --detach` with the same `FACADE_HOME`. It starts the keeper, which starts the
daemon, and returns code 0 when the daemon starts or another daemon holds the daemon lock. If the daemon is still starting after 10 seconds, it prints
`facade: Facade is still starting; see {home}/core/logs` and also returns 0. Startup failure returns code 1 with the reason.
Connect to the socket and retry `hello` for up to 10 seconds. A successful `hello` proves readiness; the `--detach` result
alone does not.

The daemon accepts connections after recovering its agents and screens. Recovery can take longer than one connection
attempt. Temporary transport failures can be retried. A decoded refusal, an invalid response, or a permission or configuration
error ends the attempt; report that error instead of treating the service as absent. `facade` commands follow these rules.

Nothing runs at login. A command starts the keeper, and the keeper starts the daemon; `hello.keeper` is absent while no keeper
runs. The daemon exits after 5 seconds with no running agent, connected client, or unfinished work, and the keeper, holding no
CLI, exits with it. Ended records and screens stay in the home. The next command starts them again and reads them. Linux needs
kernel 5.3 or newer, with process descriptors (`pidfd_open`) allowed.

### Messages

Send UTF-8 JSON followed by a newline, one JSON-RPC 2.0 object per message. Batch arrays are not supported. The incoming line
limit is 64 MiB including the newline. An oversized request receives `capacity_exceeded` with a `null` ID, and the connection
closes. Use a distinct non-negative integer ID for each outstanding request. IDs must fit an unsigned 64-bit integer;
JavaScript clients should stay within their exact integer range. String and fractional IDs are invalid. Omit the ID for a
notification, which receives no response, even when it fails.

`cancel` names a call still under way on the same connection by that call's request ID:
`{"jsonrpc":"2.0","method":"cancel","params":{"id":7}}`. With an ID of its own it is answered `{}`, and the call it names
answers as usual, with what became of it. It withdraws only an `agent.send` whose message's paste has not begun (see
[Agent messages](#agent-messages)); every other call goes on. Closing a connection withdraws nothing.

Wait for a successful `hello` before using the connection. In this example, `→` is a client message and `←` is a daemon
message. The redraw's base64 value is abbreviated.

```text
→ {"jsonrpc":"2.0","id":1,"method":"hello","params":{"protocol":[1,1],"build":"1.4.2","kind":"terminal"}}
← {"jsonrpc":"2.0","id":1,"result":{"protocol":1,"build":"1.4.2","pid":4321,"agents":0,"topics":["agents","screen","messages","windows"],"ops":["agent.start","agent.resume","agent.stop","agent.remove","agent.inspect","agent.type","agent.screen","agent.resize","agent.rename","agent.send","hook.session-start","hook.prompt","hook.turn-end","hook.idle","hook.session-end","integration.add","integration.remove","integration.list","window.update","worktree.create","daemon.upgrade","daemon.log"]}}
→ {"jsonrpc":"2.0","id":2,"method":"call","params":{"op":"agent.start","args":{"command":["claude"],"cwd":"/Users/me/project","env":{"HOME":"/Users/me","PATH":"/usr/bin:/bin"},"cols":120,"rows":30}}}
← {"jsonrpc":"2.0","id":2,"result":{"agent":{"agent_id":"a1","name":"Pixel","cli":"claude","cwd":"/Users/me/project","window_id":"terminal","location_id":"loc-5f3c2a1b9e8d7c60","pid":5001,"process":"running","cols":120,"rows":30,"created_at":"2026-11-09T17:22:05.123Z","root":"a1","yolo":false,"state":"starting","tools_state":"connecting"}}}
→ {"jsonrpc":"2.0","id":3,"method":"watch","params":{"topic":"screen","args":{"agent":"a1"}}}
← {"jsonrpc":"2.0","id":3,"result":{"watch":1,"snapshot":{"agent_id":"a1","cols":120,"rows":30,"redraw":"G1s/MjAyNmw…","process":"running"}}}
← {"jsonrpc":"2.0","method":"changed","params":{"watch":1,"change":{"kind":"output","data":"aGVsbG8="}}}
→ {"jsonrpc":"2.0","method":"call","params":{"op":"agent.type","args":{"agent":"a1","raw":"aGk="}}}
→ {"jsonrpc":"2.0","id":4,"method":"call","params":{"op":"agent.type","args":{"agent":"a1","text":"run the tests","enter":true}}}
← {"jsonrpc":"2.0","id":4,"result":{}}
→ {"jsonrpc":"2.0","id":5,"method":"call","params":{"op":"agent.stop","args":{"agent":"a1"}}}
← {"jsonrpc":"2.0","method":"changed","params":{"watch":1,"change":{"kind":"exit","exit":{"signal":"SIGHUP","at":"2026-11-09T17:25:40.017Z"}}}}
← {"jsonrpc":"2.0","id":5,"result":{"signal":"SIGHUP","at":"2026-11-09T17:25:40.017Z"}}
→ {"jsonrpc":"2.0","id":6,"method":"unwatch","params":{"watch":1}}
← {"jsonrpc":"2.0","id":6,"result":{}}
```

The first `agent.type` message has no `id`: it is a notification. `facade attach` sends keys this way. The second types text
and presses Enter; it is answered once both reached the terminal.

### Agent IDs and names

An agent ID is `a` followed by a number, unique within its Facade home. The next number is committed to `core/facade.db` before
each number is assigned. Numbering continues across restarts while the home's files remain. Separate homes count separately;
deleting a home resets its counter. `a3`, `#a3`, and `3` select the same agent. A unique name also works, with or without `@`,
and so does a name followed by its ID, as Facade writes a message's sender, such as `@Pixel #a3`: the ID decides.

An `ide` client can send `numbers_given` in `hello`, the highest agent and message numbers its editor gave before, each at
most 2^53 - 1. The daemon keeps both counters in `core/facade.db` before responding: future numbers exceed its own and the
editor's; lower values change nothing. A number above that limit, or `numbers_given` from another client kind, refuses
`hello` with `invalid_argument`.

A missing, empty, or blank name gets a name from the settings file's `names`, else from the built-in names: at random, one no
agent of its window has, ignoring case and surrounding spaces; once every one is taken, or for a list of none, the agent's ID,
such as `#a7`. Given names are trimmed and may repeat. Use an ID when names repeat.
`agent.rename` gives an agent a new name the same way and returns its record; the `agents` topic sends it as `updated`.

### Responses and ordering

- Match responses by ID. Responses to calls on one connection can arrive in any order, and `changed` notifications can
  arrive between them. Handle those notifications while waiting for a response.
- Give `watch` an ID so its response supplies the watch number and snapshot. The response arrives before any of its changes.
  The snapshot and changes cover the topic without a gap.
- The `agents` topic sends `updated` to insert or replace the whole record by `agent_id`, including when an agent starts. It
  sends `removed` to remove a record by `agent_id`. Skip a change whose `kind` you do not know.
- A `screen` snapshot is a full redraw. Its changes are `output`, `redraw`, `exit`, and `removed`. `exit` follows all output the
  CLI wrote before ending. A process that still holds the CLI's terminal can write after `exit`; on macOS, the terminal is
  taken from those processes when the CLI ends. `removed` is the watch's last change.
- The `agent.stop` response and a screen watch's `exit` change can arrive in either order.
- Requests to type into or resize one agent run in the order sent on their connection. A text or keys request holds the
  connection's later typing and resizing of its agent until it is answered; other requests go on. Other operations may
  finish in a different order.
- `agent.start` responds once the CLI starts in its terminal, with the agent's record as `agent`. Failure to start is an error.
  A CLI that starts and immediately exits still creates an agent. The start response reports `running`; follow the `agents`
  topic or read a later snapshot for the recorded exit. A start's `prompt` is answered pending and delivered later, and a
  result may follow; see [Agent messages](#agent-messages).
- `agent.resume` responds once the agent's CLI runs again, with its running record. The `agents` topic then has an `updated`
  change with the new `pid`, `running`, and no `exit`.
- The `messages` topic sends `updated` to insert or replace a message by `message_id`: when it arrives in the inbox and when
  its delivery changes. A change delivers nothing; a client that hands messages to a model takes them through a snapshot.

### CLI rules

A `command` whose first word is the exact name of a CLI of Facade's settings file, `facade.json` - a built-in's, such as
`claude` or `codex`, or one its `clis` adds - starts that CLI as its entry says. An entry of a built-in's type runs with that
built-in's rule: its `command` in place of the rule's program, the arguments of its model and effort, then its `args`, before the
command's other words, and its `env` over `env`, each `${env:NAME}` read from `env`. A start or a resume that an agent asks for
takes nothing of that agent's own entry: what its `env` set or removed is taken back from `env` first, where `env` still has
it, so that a person's own change in that agent's terminal stays. The keeper holds what an entry did for the daemons after
this one, in memory alone, as its values can be secrets. A model or effort that the command's other
words choose, in any spelling the CLI reads, is the start's own, and the entry's is then not added. An entry of type `custom`
runs as a program. Any other first word, including a path, runs that program as given. A program is found on the `PATH` in
`env`, with a relative entry taken relative to `cwd`. `cwd` must be an absolute path; a relative one is `invalid_argument`. A
folder that cannot be used is `unavailable`, and so is a program started by its path or name that cannot run. `cli` in the agent
record is the entry's name, or the program's file name.

A settings file that cannot be read as a whole refuses every start and resume with `configuration_invalid`, saying each problem
with its line and column. An entry that is wrong refuses its own with `configuration_invalid`, saying each problem by its
setting path; then one its `enabled` turns off is refused with `unavailable`; then one whose program cannot run where it starts
with `not_found`, saying so by its setting; then a `model` or `effort` its CLI takes none of with `unsupported`. A resume runs
the entry its agent ran, as the file has it now, and refuses one that is gone with `unavailable`, and one that now runs another
CLI with `unsupported`.

A CLI whose rule reports sessions writes the session it selects to a file of its run, which the daemon reads: when the run
starts, once a second while it runs, when it ends, and after the daemon restarts, before it serves clients. A session the CLI
names the file of, the file it saves the session in, counts once that file exists: until the CLI saved it, the run has no
session to resume, the same for every CLI. `session` in the agent record is the last session the CLI reported that counts, saved
before it is shown. It stays when the agent ends. The session an agent's terminal selects is the agent's session, for every CLI
and however it was selected: by the CLI's own new or resume command, or in OpenCode by a session tab, as its tabs list every
session of the folder, other agents' among them.

`agent.inspect` reads an agent's record, its rule, its message input as the screen shows it now, and whether the running CLI
reports its session. It sends nothing to the CLI. `input.state` is `unknown` for an ended agent, one without a rule, during
a synchronized update, for a hidden terminal cursor without a cursor the CLI draws itself, and until the CLI writes after it
starts, resumes, or is recovered. `unknown` is a state of its own: clients decoding a state they do not recognize should treat
it as unrecognized, not as `unknown`. No input state means the CLI may be typed into.

### Resume

`agent.start` with `session` continues that CLI session as a new agent with its own number, using the same arguments as
`agent.resume`; the agent's `session` still comes from what its run reports. A CLI whose rule does not resume sessions, and a
program outside the settings file, refuse it with `unsupported` before anything starts, and an `mcp` client cannot
supply it. Prompt, worktree, request ID and name work as for any start.

`agent.resume` starts an ended agent's CLI again in its terminal, continuing the agent's `session` with the CLI's own resume
arguments. The agent keeps its ID, name, record, `cwd`, `created_at`, and screen, and takes no agent number. The CLI gets the
caller's `env`, filtered as for `agent.start`, and the terminal size in `cols` and `rows`. It is `unavailable` for a running
agent or one already resuming, an agent without a CLI rule that resumes sessions, one without a recorded session, and a CLI or
folder that cannot be used. A resume waits up to 10 seconds for the ended run's exit to be saved and its terminal released,
then for the keeper as a start does.

Before the new CLI starts, the screen gets a fresh terminal's modes and the new size, through the same output and log as the
CLI's own output: an open synchronized update ends, the alternate screen is left, and modes, charsets, the scrolling region,
the saved cursor, and tab stops are reset. Rows, scrollback, title, and cursor position stay. A viewer receives these bytes
as `output` or a `redraw`; they are not the CLI's.

Input admitted before the resume belongs to the ended run, and never reaches the new CLI, even a notification waiting for
room. If the CLI cannot start, the agent stays ended with its earlier exit. If the daemon ends after the new CLI started but
before its record was saved, the next daemon saves the new process and clears the exit before serving clients.

A screen watch lasts through a resume: it receives the ended run's `exit`, then the resume's output and the new CLI's. A
viewer that missed output first receives the ended run's last screen and its `exit`, even beyond its 1 MiB output budget. A
viewer still holding more than its budget from an earlier resume when the next one begins is dropped and its connection is
closed; reconnect and watch again for a fresh snapshot. Only `removed` ends a watch otherwise.

### States

`state` in an agent record says what the agent is doing: the first that holds of `waiting_for_you`, `error`, `just_done`,
`working`, `starting`, `idle`, and `unknown`, or `ended` once its process ended. `state_detail` says more:

- `waiting_for_you`: `kind` is `permission`, `question`, `auth`, or `unknown` where the CLI did not say, and `text` holds the
  CLI's own words, if any. A menu or question the CLI draws in place of its input counts, also while it starts, and the bounds
  on its start and its tools run again once it is answered.
- `error`: the CLI reported an error, or its screen shows that the turn it reported ended failed, and `text` holds its own
  words, if any; its CLI cannot use the Facade tools it was
  given, and `reason` is `tools_unavailable`; or a CLI that runs by a built-in's rule showed nothing of what it does within 60
  seconds of its start or resume, and `reason` is `not_ready`. A program without a rule is `unknown` instead: nothing
  promises it reports.
- `just_done`: a turn ended while no `screen` watch showed the agent. It stays until one does; `agent.screen` does not count.
  Work before the CLI is asked to do anything is no turn: an Enter typed into it asks, unless it answers a question the CLI
  shows. Words after the CLI's name at its start are the CLI's own and ask nothing.
- `working`: the CLI works, or stopped working less than a second ago.
- `starting`: the CLI has shown nothing of what it does yet, or its Facade tools have not connected yet, within 60 seconds of
  the start or resume of its process.
- `unknown`: nothing shows what the CLI does now, though it did before, or a program without a rule has shown nothing yet.
  `reason` says why: `not_shown`, `asked` (to report, without reporting since), `taken_back`, or `unrecognized` (a screen
  its rule does not recognize).
- `ended`: `how` is `stopped` where Facade stopped the agent, otherwise `normal` for exit code 0 and `crashed` for another
  code or a signal. It is omitted where neither is known; `exit.reason` says what is known.

States come from what the CLI reports of itself, the Program Status Protocol (OSC 7501, revision 0.4): a CLI that asks whether
the terminal takes reports is answered that it does, and viewers see neither the question nor the reports. A full reset takes
a report back, and so does a shell's new prompt (OSC 133 A) after work or a wait. Reports about a part of the CLI (`id=`) and
report titles are not read. Where a CLI's rule reads its screen, the screen speaks for the CLI too: Muse Code's, until the CLI
asks or reports, and Codex 0.166.0's and 0.167.0's, whose finished turn narrows a `working` report to idle while commands it
left running continue. Codex's version is read from the `codex-package.json` its installation keeps above its program; other
versions keep their own reports.

`said` is the last text that went into the agent's input with Enter, on one line, and who said it, as messages name their
sender: what the person submits in an attached terminal, once the CLI takes it, with each paste the CLI shows as a
placeholder said as the text pasted; `agent.type` text with `enter`, from the agent
the client acts for or else the person; and a message delivered through the terminal, from its sender. An Enter the person
types reaches the CLI once the CLI has drawn the keys before it and the daemon has read the draft they make, at most 150 ms
later, and keys sent meanwhile follow it; if the CLI drew nothing of them by then, the Enter goes and nothing is said.
`waiting_for_you` and `error` are published on the `agents` topic at once; other state changes and `said` follow within
200 ms. The facts states rest on and `said` are kept beside the agent's screen, so a daemon that starts again shows the same
states before it serves clients.

### Facade's tools

A CLI that runs by a built-in's rule is given Facade's tools for its run, the MCP server `facade-mcp`, where its rule gives them;
`facade-mcp` is the relay to the daemon's own MCP server, below.
Antigravity's runs get them from a plugin in the folder they start in, `.agents/plugins/facade/`, which the runs there share:
the only file Facade writes into a project. Its manifest names Facade core and the version that wrote it: a start brings one
an earlier version wrote, or one changed since, up to date, and leaves one a later version wrote as it is. It goes once no run
there uses it, if it is still exactly what this version writes; a daemon that starts again removes one whose runs ended while
no daemon ran, or whose start was cut before its agent was listed, as the run's folder names the project before the plugin
goes there. A `facade` server of the person's own, one that does not run `facade-mcp`, in any configuration the CLI reads,
means the run starts without the tools, and Facade changes nothing; for Pi, whose extensions would clash, that is an extension
that registers `facade`, and Pi starts without Facade's. Antigravity's runs get the tools beside such a server: Antigravity
names a plugin's server after the plugin too, so Facade's is `facade_facade` and neither takes the other's place. They start
without the tools where `.agents/plugins/facade/` is not Facade core's plugin, such as the person's own or the Facade Code
extension's, or holds a file a Facade core plugin never holds. Muse Code is stricter, as it refuses to run beside a second
`facade` server: any `facade` server in its configuration, even one that runs `facade-mcp`, means its run starts without the
tools, and so does a project MCP file Muse Code cannot load. Only the one Facade's integration writes in its settings does
not: it serves the run itself. Facade changes none of it.

`tools_state` in an agent record says whether its CLI can use them: `not_injected` where it was not given them, `connecting`
until its server has answered the CLI's `tools/list`, `available` while the server holds a connection, and `unavailable`
otherwise. `tools_reason` then says why: `not_given` where its rule gives them but Facade could not, as the daemon's log says;
`not_connected` where the server did not connect within 60 seconds of the run's start or resume, or of a daemon's recovery of
the run; `not_started` where the run's start could not have the CLI start its server before its first turn, as the daemon's
log says; `disconnected` where its last connection closed while the run went on; or `ended`. Every connection of a client of
kind `mcp` counts for the agent it acts for while it is open. The daemon's MCP server opens one for a relay's agent once it
has answered the CLI's `tools/list`, so a start's prompt or a message never reaches a CLI that has not loaded the tools yet.
A relay whose connection closes connects again at once, then after a moment that grows to 2 seconds, so a daemon that
replaces another learns that the tools are there.

Every tool the daemon's MCP server lists is marked to be loaded from the start rather than found through a CLI's tool search, as Claude
Code reads `anthropic/alwaysLoad` and Antigravity `antigravity/alwaysLoad`.

A CLI that starts a folder's servers only with its first turn or with its panel of servers, as Antigravity does, has them
started before its first turn. Once its input first reads empty, the daemon types the command that opens the panel, then
Enter once that command shows alone in the input, then the key that closes the panel once it shows the tools ready. Until
then it holds every input of the agent, from attached terminals, `agent.type` and messages alike, and lets it in after, in
the order it came. A menu or question of the CLI's own that shows first, such as Antigravity's trust question in a new
folder, is the person's to answer: the keys and `agent.type` calls held so far go to the CLI, and so do those that come
while it shows; messages still wait, and the time it takes counts toward no bound. It waits at most until 60 seconds after
the run's start or resume, or after the CLI's last question went. Where the input first reads a draft, or nothing it can
read by then, the CLI works, the command does not show alone within 2 seconds, or the panel does not show the tools ready
within 10 seconds, it stops, taking back the command it typed and closing the panel if it shows; the tools then read
`unavailable` with `not_started` until the server connects, as the CLI's first turn starts it.

### The relay

A relay connection carries MCP itself. `facade-mcp`, as a relay, passes on each line its CLI writes and each line the daemon
writes back, and the daemon's own MCP server answers. Its first line is a `hello` whose `params` hold `relay`, the relay
contract's version, 1, and what the CLI gave the relay's process: `args`, its words after its program, such as `--guest
codex`; `env`, its environment's variables that are UTF-8; `cwd`, the folder it runs in, where it could read it; and
`reconnect`, whether it connected to a daemon before. The daemon answers `{"relay": 1}`, then reads MCP's JSON-RPC lines and
answers each as it finishes, as `facade-mcp`'s own server did. It refuses a hello that names another version, and one for
an agent that is not listed yet; the relay tries again. A `send_message` or `start_agent` call's request ID is made from
the process at the connection's other end, when that process started, and the call's JSON-RPC ID, so that a call the relay
gives the next daemon repeats what the first did. The agent's tools count as there once the server has answered the CLI's
`tools/list`, or from the hello on where `reconnect` is true. Every request has one answer: a `send_message` the CLI
cancels while its message waits is withdrawn as `cancel` withdraws one, and answered with the JSON-RPC error `-32800`, as LSP
names a cancelled request's, which MCP has its client ignore. Once a newer Facade takes over, the daemon sends `closing` as
to any client; the relay answers with a line whose `method` is `closing`, sends that daemon nothing more, and gives the calls
it has had no answer to, and the lines that came since, to the next daemon.

### Starts, stops, and removal

Before a start or stop is sent to the keeper, it waits up to 10 seconds for a ready keeper. Once sent, it waits up to 10 more
seconds for the reply. Either timeout returns `unavailable`. A start that times out before sending did not start the CLI.
A timeout after sending leaves the outcome unknown. A stop then waits up to 10 more seconds for the CLI's exit, returning
`unavailable` if that wait times out. When no keeper runs, the daemon handles stops itself and only the exit wait applies.

`agent.stop` sends SIGHUP to a running agent's process group. The daemon sets the SIGKILL deadline 3 seconds after accepting
the stop, keeping an earlier pending deadline. It sends SIGKILL to anything left in the group at that deadline. Queueing or
a repeated stop can shorten the gap after SIGHUP. Facade signals the group only if it can check that it still belongs to the
CLI; it skips a group it cannot verify. Processes that left the group are not signalled.

The stop responds after the agent ends and returns its recorded exit. Its record stays listed. An accepted stop continues
after a timeout or service replacement with its original deadline. Stopping an agent whose CLI had ended returns its recorded
exit with `already_ended`, without sending another signal.

`agent.remove` stops a running agent first, then removes its record. If the CLI ended by itself, processes it left behind
that ignore terminal hangup keep running, as after closing a terminal. Removing that ended agent sends them no signal.

`agent.start` with `worktree`, a `branch` and its `base_ref`, makes that worktree from `cwd` as `worktree.create` does, then
starts in it, as one call. Git's failure answers `worktree_failed`, with what it made in `data.kept`. A start that fails after
making the worktree keeps it, and its error's `kept` names it. `worktree.create` makes a worktree alone, for the editor's New
Worktree.

A start's `request_id`, 1 to 200 characters, is its creator's own ID of it, kept on the agent's record. The daemon looks for
it before anything else. A start with the same ID under way gives its answer once it comes. An agent the same creator started
with it within the hour is answered as it stands now, with `repeated: true`, its prompt as it stands and its
`result_message_id`, and nothing starts, no worktree included. A start that failed keeps no ID, so the same ID starts again,
and an agent's ID goes with its record.

### Text and keys

`agent.type` takes one of `raw`, `text`, or `keys`. `facade attach` sends `raw`: the bytes a person types, queued as they come.
Programs send `text` or `keys`. The agent's typist types them one call at a time, each call whole:

- Text goes in as one paste. When the CLI turned on bracketed paste, the text goes between the paste brackets with each line
  break as a carriage return; otherwise it goes as given. Text takes printable characters, tabs, and line breaks; send Escape
  and other control keys as `keys`.
- With `enter`, Enter goes in a write of its own after the text. Empty text with `enter` presses Enter alone.
- Keys go as a terminal sends them in the CLI's modes, including application cursor keys.
- The typist pauses before its next stroke, even when that stroke belongs to the next call: after a paste reached the
  terminal, 0.1 seconds and the settle time the CLI's rule gives the paste, because a CLI that reads a paste's end and an Enter
  together may drop the Enter or take it as a line break; after an Escape, 50 ms, so the CLI does not read the two as Alt with
  that key.

A text or keys call is answered once its input reached the terminal. If the agent ends first, the call fails with `ended`
when nothing of it was typed. Otherwise it fails with `partial_input` and says what was typed, for example `#a3 ended; the
text was typed but not its Enter`; the error's data has `text_written` and `enter_written` for text, or `keys_sent` for keys.
Raw bytes can go in between a text and its Enter.

### Screen text

`agent.screen` returns the last logical lines of the screen and scrollback, each wrapped row joined into its line, with
`line_count`, `older_lines` when output lies above them, and `trimmed` when the scrollback let go of its oldest lines. In
`text`, inverse text is between `[[` and `]]` and dim text between `{{` and `}}`, inverse outside dim, and each backslash,
bracket, and brace of the screen's own text is escaped with a backslash: removing the marks and the escapes gives the text
exactly, as `facade screen` prints it. An ended agent's screen is the one it left; `process` says it ended, and
`observed_at` is when it ended. Text and keys have no draft protection: they can edit or submit a draft the person is typing.

### Agent messages

A client acts for an agent when its `hello` names one in `agent`. Facade sets `FACADE_AGENT`, the agent's ID, and `FACADE_HOME`
in every agent's environment; `facade` commands in an agent's terminal act for it. A `hello` can also name `sessions`, the
session IDs the CLIs a command runs under give it in their own variables (`CLAUDE_CODE_SESSION_ID`, `CODEX_SESSION_ID`,
`OPENCODE_SESSION_ID`, `MUSE_SESSION_ID`, `PI_SESSION_ID`, `ANTIGRAVITY_CONVERSATION_ID`): the client then acts for the running
agent that has one of them, the newest where several do, ahead of `agent`. So a command a guest's model runs acts for the
guest, also in another agent's terminal; `hello`'s answer names the agent it acts for. An `mcp` client must name the agent it
acts for, and that agent must be listed: a `hello` naming one that is not is refused with `not_found`. Messages a client sends
come from the agent it acts for, or from the person, `human`, if it acts for none.

`agent.send` takes `to`, `text`, and optionally `reply_to`, a message in the sender's inbox. Text is not blank and has at most
8,000 characters and 540 lines: printable characters, tabs, and line breaks. The limit is the same whoever receives the message:
the most that Antigravity, which takes a paste slowest, takes within the delivery time. A message that cannot be kept fails as
an error, and nothing is kept: invalid text, a recipient that is not listed or has ended (`ended`), a sender that is not listed,
a reply to a message not in the sender's inbox, and a message to the person that no one can be told (below). Otherwise the
message is kept with the next message ID, `m` followed by a number that is never given twice, and the response is the message
once its delivery is settled, within 30 seconds: `delivery.status` is `success`, with `delivered_via` `terminal`, `read` or
`notified`, or `failure`, with its `reason`. `text_written` and `enter_written` say what reached the recipient's terminal. A
failed delivery is a result, not an error.

A send's `request_id`, 1 to 200 characters, is its sender's own ID of it, kept on its message. The daemon looks for it before
anything else is checked or resolved. The same ID from the same sender within the hour of the message it kept answers that
message as it stands, with `repeated: true`, and sends nothing again, across daemon restarts too: while the message is
delivered, the repeat joins its delivery and answers by its deadline. Two calls with one ID keep one message. A send refused or
withdrawn keeps no ID. `facade-mcp` gives every `send_message` and `start_agent` one: the model's own, or else one of its own,
`facade-` followed by its process ID, when it started and the call's number.

A send's 30 seconds count from the client that took it first. `time_left_ms` says what is left of them as the call leaves the
client, and the delivery's deadline is the daemon's receipt plus that, at most 29.5 seconds, which a send without it gets.
`facade-mcp` counts from a line's arrival and gives the daemon what is left, less half a second for the answer's way back;
with nothing left, it sends nothing and answers `timeout`.

A `cancel` of an `agent.send` withdraws its message while its paste has not begun: waiting for an empty input, behind a draft,
or behind the paste of messages ahead of it. The message is taken out under the lock that guards a paste's beginning, so either
its paste began and it goes on, or none of it is ever typed. Its record is deleted, and its number stays unused: no read returns
it, and `messages` watchers get `removed`. The send fails with `cancelled`, as does a call that joined it by its request ID. A
message whose paste began goes on, and its answer says what reached the terminal. `facade-mcp` does the same for MCP's
`notifications/cancelled` of a `send_message`, and answers nothing to a call it withdrew, or cancelled before it wrote its
`agent.send`.

`#human`, the person, takes messages from the agents of editor windows. Such a message goes to the `ide` clients of the
sender's window that watch `messages`, which tell the person, and it is delivered as it reaches them: `delivered_via` is
`notified`, and nothing is typed. Where the sender's window has no such client now, where the sender is in the terminal window,
and where the sender is the person, the send is refused with nothing kept. A message to the person is never kept for later or
sent to another window.

The recipient's typist delivers the message. It waits until the input is empty, as the CLI's rule reads it, and never types
over a draft. It pastes the message under a header naming its sender, number, the sender's window where that is not the
recipient's, kept in the message as `from_window`, and the message it replies to, then presses
Enter once the input shows the paste as the message's own draft for the CLI's settle time, and again after 2 seconds while that
draft stays. The message is delivered once the input is empty again. A paste goes only where its delivery fits in the time
left: 2 seconds for its own draft to show, the settle time, and 3 seconds for the input to empty, each with the paste's own
time. The delivery fails after 29.5 seconds with what held the input: `input_draft`, `input_interaction`, `input_unknown`,
`timeout` when its paste would not fit in the time left, or `submission_unconfirmed` once it was pasted. No Enter goes after
that: a paste the terminal had not taken whole by then still goes in, without one. It fails at once with `unsupported` for an
agent without a rule, and with `ended` when the agent ends first. Messages waiting together go in one paste, each whole; one
that would make the paste too long for an earlier message's time waits for the next paste. Text and keys go before messages
waiting for the input; while a pasted message is in the input, they wait for it.

A start's `prompt` is the agent's first message. It is refused before anything starts where `agent.send` would refuse it as a
message to the new agent, and where the program has no CLI rule, whose input Facade can read. It comes from the agent the
client acts for, or from the person. It is kept with the agent's record, under the next message
ID, and the start answers it as `prompt`, pending, with no deadline yet. Once the CLI's tools connected, or will not, its 29.5
seconds begin and it is delivered as `agent.send` delivers a message, before any other: messages sent while it waits wait for
it, as behind a draft, within their own 29.5 seconds. A daemon that replaces another while a prompt waits for the tools gives
it its 29.5 seconds from then. `facade start` takes it from `--prompt`, which, like its other options, comes before the CLI's
name: every word after that is the CLI's.

A prompt from an agent, a guest among them, owes that agent one result, whose message ID the start answers as
`result_message_id`; a start's `call_id`, the MCP call that asked for it, goes with it. The transaction that settles the prompt,
delivered or not, by its typist or a read, writes the result: a message from `facade` to that agent, with the `call_id` and, as
`result`, the started agent as it was then and its prompt's message ID and delivery. Its text says the same in words, and its
terminal shows it under `🔔`, its first line and its own number, with no other header. It is delivered as a message is, and kept
and read as one: a guest's waits in its inbox for a take, as its other messages do. A prompt read after its result said it was
not delivered becomes delivered with no second result. Where the agent that is owed the result was removed or has ended by
then, or the guest is no longer listed, none is written, and its number goes unused. A prompt from the person owes none.

The `messages` topic reads the inbox of the agent the client acts for, which must be listed, or, for an `ide` client, the
person's inbox, `human`, whose changes are the messages the agents of its own window send the person. Its arguments select messages:
by default those not yet delivered, including failed ones; `ids`, 1 to 100 message IDs, rereads those; `all` pages every
kept message; `cursor` continues from a page's `next_cursor`, and `limit` sets a page's size, 1 to 200, 100 by default. A snapshot
delivers every message it returns that was not yet delivered, through `read`: its typist never types a message it has not
begun, and its sender's `agent.send` responds. A message whose paste the typist had begun is finished in the terminal, and its
`text_written` is `unknown`, without `enter_written`. The snapshot's messages are delivered on disk before it is answered. Its
changes are `updated`, a message arriving or its delivery changing, and `removed`, a message no longer kept: withdrawn by its
send's `cancel`, past its 30 days, or gone with its inbox.

Messages and what became of them are kept 30 days, across daemon restarts; a message ID is never given again, even after its
message is deleted. A daemon that ends before answering an `agent.send` answers nothing: the client's connection closes, and
what became of the message is not known to it. The next daemon goes on delivering the message within the 30 seconds it had
(see [Daemon replacement](#daemon-replacement)).

### Editor windows

Every agent is in a window: the editor window it was started or last resumed in, or the terminal window, `terminal`, which
holds the agents started or resumed from a terminal, guests among them. `AgentInfo.window_id` names the window, and
`location_id` its location: the agent's folder, or the innermost location the folder is inside. `agent.start` and
`agent.resume` take `window_id`; without it, the agent runs in the terminal window, where any folder will do. In an editor
window, the agent's folder must be one of the window's locations or a folder inside one; a window that is not there now is
`unavailable`. A resume keeps the agent's folder, so an editor window where it is neither a location nor inside one refuses
the resume.

An editor window connects as an `ide` client, which acts for the person. Its `hello` describes the window in `window`: its ID,
which stays the same across its reloads, its name, its `environment`, `local` or a remote authority, the `workspace` key its
agents are kept under, its folders, its Git branch prefix, and optionally its terminal `colors` and `env`.
`window.update` sends the whole description again whenever any of it changes, and asks the daemon to read the window's locations again, as the client does when a repository of the window
changes. A window's locations are its folders and every checkout of a Git repository one of them is in: the repository's main
checkout first, then the folder if it is another place, then the other worktrees, each place once, its path with symbolic
links resolved. The daemon reads them with Git when the window describes itself and after a worktree is made there, never on a
timer; a read that fails keeps the window's locations as last read and says so in `problems`.

The `windows` topic lists every editor window that is there or still holds agents, and the terminal window while it holds
running agents, with their locations; for a client that acts for an agent, each window also lists the CLIs a start by that
agent can run. An `ide` client also gets `clis` and `settings_problem` for each window that gave `env`: the programs are
looked for on that environment's `PATH`, with relative entries taken relative to the window's first folder. A window with
no folder lists no CLI. The environment is that of the first folder's terminals; a start sends its own location's
environment. A snapshot or change reads the settings file as it is now. The window's `env` stays in memory alone, never
in the store, a log or a response.

`worktree.create` makes a worktree from a checkout of a window, with a new branch, at
`<main folder>.worktrees/<branch>`, and answers with the new location; it keeps whatever a failure made, and says what in the
error's `data.kept`.

A window is there while one of its connections is open. Once its last one closes, its agents wait for it: 90 seconds for a
`local` window, five minutes for another. A connection of the same window within that time keeps them, and so does a window of
the same `workspace`, which takes them over from a window with no connection left; the first window, back, has none of them.
Once the time runs out, the window's running agents end as `agent.stop` ends them, and their records stay. A later window of the
same `workspace` takes over those ended agents too, so its client can resume or remove them. An agent ends too
once its location is known to be gone: its window no longer has the folder that brought it, or Git no longer lists its worktree
and its folder no longer exists. A failed read or a disconnected window proves nothing.

### YOLO and creation trees

Each launch, a start or a resume, from a terminal or into a window, reads `yolo` from Facade's settings file, `facade.json` in
the Facade home, as the launch is accepted, and keeps it for its run, as `AgentInfo.yolo`: changing the file changes only later
launches. A missing file, an empty one, one of only spaces and comments, and one without `yolo` mean on. The file is JSON with
comments and trailing commas, read strictly: one that cannot be read, that is not JSON with comments, has a key twice in one
object, holds something other than one object, or has a top-level key other than `yolo`, `names`, `clis` and `$schema` or one
of the wrong type, refuses every launch with `configuration_invalid`, its message saying each problem with the file's path and,
where known, its line and column. The core checks the whole file as the extension does: `yolo` decides YOLO, `names` the
default names (Agent IDs and names, above), and `clis` the CLIs a start runs (CLI rules, above). The daemon only reads the
file. No argument chooses YOLO.

With YOLO on, the CLI runs without asking: its approvals bypassed and its sandbox off wherever it has one, for that launch, and
the launch's folder trusted, for that launch where the CLI takes the trust by its own arguments or run settings.
Claude Code takes it neither way, so a run of it answers its question about the folder once, as a person would, each key once
the screen has been still for a second: Down, then Enter while the selection shows on the answer that trusts. The question is
answered once it leaves the screen; a selection that does not show there, a question that stays on after its answer, and the
question coming back are the person's. Claude Code keeps that trust in the person's `~/.claude.json`, so its later runs in the
folder find it trusted. With YOLO off, the CLI runs as it natively does, Facade's tools its only addition, and its questions are
the person's. Facade writes none of a CLI's own files for it.

An agent's record says who started it, fixed at its start: `creator`, the agent whose client started it, left out for a start
by the person's client; and `root`, the first agent of its creation tree, itself where it has no creator, else its creator's
root, which stays when agents of the tree end or go. A guest heads a tree of its own, with the YOLO the settings file gave as it
joined, for its reach; off where the file could not be read.

A client acting for an agent reaches every agent where that agent's run has YOLO on, and otherwise the agents of its tree,
those with its root: ancestors, descendants, siblings and other branches alike. The person's clients reach every agent. A
reference resolves among the agents in reach: an agent ID out of reach is `refused`, with nothing done, and a name names only
agents in reach. The `agents` topic gives such a client the agents in its reach. Windows, locations and CLIs are not limited by
reach: a start goes anywhere, and its agent joins its starter's tree. A client's own inbox is its own, and `#human` the person,
in reach or not.

### Guests

A guest is a session of a CLI the person started outside Facade, known by the CLI and the session ID the CLI gives its hooks;
never by its processes. The CLI's hooks report on their session: `hook.session-start` lists it as a guest, with the next agent
ID, a default name and `guest: true`, and answers what its model is told; `hook.prompt` makes it `working` and, where it begins
a turn, takes every message not yet delivered to it, as a snapshot does; `hook.turn-end` makes it `idle` and takes them too;
`hook.session-end` removes it, its waiting messages with it. A session Facade does not list yet joins at any of these.
`hook.idle` makes it `idle` and takes nothing, for a turn that ended without its turn-end hook: one the person cut short, or one
of Claude Code's that ended in an error (`StopFailure`). Claude Code runs no hook for a turn cut short: its `hook.prompt` names
`status_file`, where Claude Code reports how its session stands, and while the guest reads `working` the daemon reads that file
once a second; `idle` there, written since the turn began, makes the guest `idle`, taking nothing. A turn-end hook that comes
still hands over what waits.
A hook that names a `parent` reports a part of that session, as a subagent's session is the session that started it: the part
acts for the guest of the whole session, at its hooks, the tool calls that name it and the commands its CLI runs, while its own
turns leave the guest's state and messages alone and its end leaves the guest listed. The guest's end ends its parts. In a
run's own session they change nothing: the run reports its own session, and its typist delivers. That is the session Facade
records for the run of the same CLI that the client acts for, or any session while it records none. Another session of that
CLI, nested in the run, is a guest's. A CLI with no hook for a session's end, Antigravity, has its hooks name its process that ran them,
`pid`: that process ending ends the session, and a session that joins from the same process ends the one before. The process
is watched for that alone; the guest's record names no pid.

An MCP client that Facade did not start, and that no CLI's hooks report, joins as a guest through its relay: a `facade-mcp`
started without `--guest`, outside a run. When the relay passes on the client's `initialize`, the daemon lists the client
with the next agent ID, a default name and `guest: true`. Its `cli` is the `name` in the request's `clientInfo`, or `mcp`
where that is missing or is not a valid CLI name. The answer gives its ID, its name and how many messages wait for it. The
guest lasts as long as the relay's connection. When the connection closes without the daemon having said `closing`, the
guest ends, and its waiting messages go with it. After the daemon starts anew, the same relay process's hello finds the guest
again, with its number and its inbox. Its state is `unknown`, it takes its messages only with `read_messages`, and its tools
reach as a guest's do, with YOLO from the settings file of the relay's `cwd`.

A guest's terminal is not Facade's: reading its screen, typing, resizing, stopping, resuming, removing and a screen watch answer
`unavailable`, and `agent.inspect` reads its input as `unknown`. A message to a guest waits in its inbox, with no deadline,
until its side takes it: the prompt or turn-end hook of its next turn, or a snapshot. The send answers at once,
the delivery `pending`, and nothing answers the take. `facade hook prompt --cli <cli>` gives the messages to the model with the
prompt that begins a turn, and `facade hook turn-end --cli <cli>` before its turn ends, in its CLI's hook format. A turn the
person cut short, `hook.idle`, takes nothing.

Facade keeps each guest's record, so that a daemon started anew lists it again with its number and its inbox, reading
`unknown` until its next hook, which finds it by its CLI and session and gives its CLI's environment again. A guest ends at
its session's end, or for Antigravity its process's, and otherwise once Facade has not heard from it for 30 days, as long as
messages are kept, or at the first start after the machine started again, which ended its CLI.

### Integrations

`integration.add` writes Facade's entries in a CLI's user configuration, so that the sessions the person starts with it join
as guests; `integration.remove` takes them out; `integration.list` says, file by file, whether they are there as they would be
written now. Each takes the caller's environment, which says where the CLI keeps its configuration. The daemon writes one
integration at a time and keeps what each file held before, so that a file nothing else changed since goes back byte for byte.
It integrates `claude`, `codex`, `opencode`, `pi`, `muse` and `agy`.

### Viewers and queue limits

`snapshot.redraw`, `output.data`, and `redraw.data` contain standard base64 with padding. Decode them to bytes and feed those
bytes to the viewer's terminal parser. Process changes for each watch in arrival order. Apply `output` as continuation bytes;
`redraw` supplies a terminal sequence that replaces the visible screen. Preserve parser state between messages. Do not treat
the decoded bytes as plain text; use `agent.screen` when you want plain text.

An agent has one terminal size. Set the viewer to `snapshot.cols` columns and `snapshot.rows` rows before applying
`snapshot.redraw`. `agent.resize` changes the size for every viewer, and the last resize wins. When the size changes, every
viewer receives a `redraw` with its own `cols` and `rows`. Resize the viewer to those dimensions before applying its `data`.
These dimensions may differ from the snapshot, so a screen viewer does not need the `agents` topic to learn the redraw's size.

A successful `agent.resize` response accepts the request. If the screen log is full while its checkpoint is being written,
only the latest requested size is kept. It takes effect when the checkpoint writer finishes, whether publication succeeded
or failed. Input sent to that agent afterward, on any connection, waits for the size: calls with IDs fail with
`capacity_exceeded`, while notifications wait. Snapshots and agent records show the applied size. A daemon failure before
application loses the request.

Each viewer queues up to 1 MiB of incremental screen output. Output beyond that is dropped for that viewer. When the viewer
has room, it receives a full `redraw`, which may exceed the output budget. The agent does not wait for a viewer. Returning
from the alternate screen also causes a redraw. If an agent is removed while a viewer is behind, the viewer receives the
last screen, any exit it missed, and then `removed`.

A connection's outbox holds up to 8 MiB of responses and changes. When it is full, the daemon waits for the client to read.
A line larger than 8 MiB is sent alone once the outbox is empty. Up to 16 calls can run at once on a connection, with or without
an ID. If another call has to wait for one to finish, the daemon stops reading further requests from that connection, keys
included. `agent.type` and `agent.resize` do not count toward the 16.

Each agent's waiting input holds up to 1 MiB: queued bytes, including terminal-query replies, and text and keys waiting in its
typist. Kernel PTY buffers are separate. A connection holds up to 1 MiB more for each agent: input waiting behind that agent's
earlier input from the connection. One `agent.type` message carries at most 1 MiB as written, a paste counted with its
brackets and Enter. A call with an ID fails with `capacity_exceeded` if its input does not fit or a resize is waiting to take
effect. A notification waits; while its connection holds 1 MiB for its agent, the daemon reads no further requests from that
connection. If the connection closes while input waits, the input is dropped and nothing else from that connection runs.
Terminal-query replies that do not fit are dropped.

A successful `agent.type` result means that raw bytes entered the daemon's memory queue, or that text and keys reached the
terminal. It does not confirm that the CLI processed them. Daemon failure can lose input not yet written. Notifications
provide no response.

### Terminal queries and redraws

The daemon's headless terminal replies to supported cursor position, device status, device attributes, and mode queries.
An editor window's `colors` give replies to OSC 10, 11 and 12: foreground, background and cursor, each `#rrggbb`; a
malformed color refuses `hello` or `window.update` with `invalid_argument`. Each 8-bit channel is written twice, so
`#1e1e1e` replies `rgb:1e1e/1e1e/1e1e`, ended as the query was, with BEL or ST. A color left out gets no reply, and neither
does any color query from an agent of the terminal window. Agents use their current window's colors from their start or
resume, after a takeover, and from the next query after `window.update` when the editor's theme changes.

The terminal does not reply to clipboard, XTGETTCAP, DECRQSS, or kitty graphics queries. Viewers never receive terminal
queries, so they cannot send a second reply.

A redraw restores cells, attributes, wraps, cursor, saved cursor, pen, charsets, and modes from alacritty. Facade also tracks
and restores the scrolling region, tab stops, active charset, and modifyOtherKeys state, which alacritty keeps private.

On the main screen, a snapshot replays up to 1,000 rows of the agent's scrollback unless `include_scrollback` is false; a later
redraw draws only the visible screen. Set `keep_scrollback` to preserve the viewer's existing scrollback. It defaults to false:
every snapshot and redraw clears that scrollback first. `facade attach` sets `keep_scrollback` to true, and sets
`include_scrollback` to false when it reconnects, so the person's terminal does not get a second copy of the scrollback. A
reconnect therefore draws the visible rows only: output that scrolled off while the viewer was disconnected is not added to
its scrollback; `agent.screen` returns it.

### Disconnections and recovery

If a connection closes before a response arrives, the call may or may not have run. Disconnecting does not undo accepted
work. Do not repeat input: it may have arrived. Repeat an `agent.send` or `agent.start` only with the `request_id` it carried:
within its hour the repeat answers what the first call did, and does nothing again; without one, a repeat is a new call. Waiting
input notifications follow the discard rule above. The `facade` commands report an unknown outcome and point to `facade list`.

Disconnecting ends the client's watches; its agents keep running. Reconnect, send `hello`, and watch again. `facade attach`
reconnects by agent ID and starts the daemon if needed. Each attempt waits up to 10 seconds; a temporary failure is retried
0.5 seconds later for as long as the attachment lasts. It redraws before sending queued keys, never resends bytes handed to
an earlier connection, and uses `include_scrollback: false` to avoid repeating scrollback.

#### Daemon replacement

If the daemon ends while the keeper holds runs, the keeper retains them and starts a replacement. The delay begins at 0.5
seconds and doubles after repeated failures, up to 30 seconds, and starts over after a daemon that ran at least 60
seconds. The keeper's watchdog ends a daemon after 15 seconds without a ping. It counts from the start of supervision
until the first ping, then from the last ping. It waits for the daemon to end before starting its replacement.

Recovery reads the agent records, takes back terminals with `agent.sync`, and loads each checkpoint and screen log. Up to 16
agents recover at once. The daemon accepts connections after recovering the readable records and screens, including any
recorded exits, and after taking up the messages still being delivered. An exit already saved by the daemon takes precedence
over the keeper's inventory.

Each message still being delivered keeps the deadline it had from its send, at most 29.5 seconds from the restart, and a send
repeated with its request ID joins it there. One whose
paste had not begun goes to its recipient's typist. One whose paste had begun is never pasted again: the typist presses Enter
only once the input shows it whole as its own draft, an empty input confirms nothing, and at its deadline it fails as
`submission_unconfirmed`, with `text_written` `unknown` and no `enter_written`. That paste goes before the agent's other
messages. A message whose recipient ended fails as `ended`, one whose deadline passed as `timeout`, and one to an agent not
listed, whose record this build cannot read, waits for a snapshot until its deadline. A daemon that ended while writing a paste
longer than the terminal's buffer leaves the CLI inside it; the next daemon types nothing into it and logs that the CLI may
still be inside a paste.

To its editor windows, a daemon's restart is a lost connection, never a close. The next daemon keeps each window's description
in `facade.db`, apart from its `colors` and `env`, and a window that holds running agents waits from the restart as a window whose last
connection closed does: one that connects again keeps its agents, and one that never comes back ends them after its 90 seconds or five minutes.

A daemon failure can lose queued input and, for each agent, one output chunk read but not yet logged, at most 64 KiB. Missing
control sequences can make later output draw incorrectly until the CLI redraws. Recovery sets the terminal to its last logged
size. It asks a running CLI to redraw by narrowing it one column, then returning it to that size when it writes or after 0.2
seconds. The temporary size is not logged.

A checkpoint holds the screen and retained scrollback. The daemon takes one after every 4 MiB of output at a clean point:
main screen, no unfinished character or sequence, and no open synchronized update. At the 64 MiB log limit it forces a
checkpoint even without a clean point. Recovery from that checkpoint loses the hidden main screen, any unfinished character
or sequence, and the frame buffered by an open synchronized update.

A machine crash can lose the log's end that the system had not written to disk. A screen-log write failure leaves subsequent
output unsaved until a later checkpoint is published; the agent keeps running.

An error such as permission denied or an I/O read failure gives the agent an empty provisional screen. Its files remain
unchanged, and its output and resizes are not saved for the rest of this daemon's lifetime. A later restart can recover the
screen once the files are readable. The same rule applies if `current`, the file naming the published checkpoint, contains an
invalid number.

For a missing or malformed checkpoint, recovery tries an earlier checkpoint. If none is valid, it starts with an empty screen.
A missing log or an incomplete or malformed record ends replay at the last complete record. These cases do not by themselves
disable logging for the daemon's lifetime. Unreadable agent records are skipped and logged; their rows, runs, and files are
left alone. An unreadable database prevents startup.

#### Keeper replacement

If the keeper ends, the daemon keeps its clients, watches, screens, input queues, sizes, and terminal descriptors. It starts
a replacement keeper and hands over the runs. Screens and input continue throughout. Stops keep their original SIGKILL time.
Keeper replacement uses the same 0.5-to-30-second delay, reset after 60 healthy seconds.

For the separate waits on starts and stops, see [Starts, stops, and removal](#starts-stops-and-removal). A keeper that
disconnects before replying leaves the request's outcome unknown; Facade returns `unavailable`.
An unresponsive keeper that is still alive is never ended by the daemon. The daemon logs how to end that keeper process so
Facade can replace it; screens, input, and resizes continue. A broken connection to a living keeper is reconnected.

Only the keeper that started a CLI can report its exit code or signal. After that keeper ends, the keeper that the daemon
starts next holds the CLI and watches it through Linux process descriptors or macOS kqueue. When it ends, the agent is `ended`
with an exit that has neither `code` nor `signal`. Show `exit status is unavailable`. End of terminal output does not prove
exit.

On SIGTERM or SIGINT, the keeper sends SIGKILL to the groups it is stopping, and exits. A daemon that holds runs starts
another.

#### Both services ending

If both services end, the terminals close and most CLIs exit on SIGHUP. The next daemon recovers the screens and lists agents
without a recorded exit as `ended`. Their exit has `reason: "terminal_closed"`, no `code` or `signal`, and `at` set to the time
recovery found them. Show `the terminal closed; the CLI may still be running`.

A CLI that ignores hangup can keep running outside Facade. Facade never signals a process ID read from a saved agent record.
`agent.stop` returns the recorded exit; `agent.type` fails with `ended`; `agent.resize` succeeds without changing
anything; `agent.remove` removes the record; `agent.resume` starts its CLI again if it has a recorded session.

An exit without `code` or `signal` is not a zero exit code. Show its reason if recognized; otherwise show that its status is
unavailable.

#### A newer build taking over

A `facade` command of a newer build that finds an older daemon asks it to hand over with `daemon.upgrade`. Every agent runs on,
with the same process and terminal. The daemon refuses a build of its own version or an older one, and one whose daemon
protocol range does not include its own version (`protocol_incompatible`, saying what each side speaks). While agents run, the
new build must also speak the running keeper's protocol, as the keeper never changes build while it holds CLIs; one that does
not is refused, saying to close every agent first. Otherwise the daemon installs the build's programs, points the launchers at
it, and answers.

Then it drains. A new call, `watch` and `hello` fail with `upgrading` and do nothing, but for an attached terminal's keys and
size, `agent.type` and `agent.resize` without an `id`, which reach the agent until its client answers `closing`. Calls under
way have up to 3 seconds to finish, and answer as usual, but for `agent.send`, which is not waited for: its message is kept,
and one still waiting for its recipient is delivered by the new daemon. A message whose paste began is settled first, its
agent reading on until its CLI took it, and no other paste begins. Each agent stops typing and reading its terminal once the
input queued for it is written. The daemon then sends `closing` with the new build on every connection past `hello`, waits up
to 0.2 seconds for each client's `closing` back, and exits. Before its `hello` is answered, a connection is sent nothing else.
The keeper starts the launcher's daemon, the new build, after its restart delay.

A client reconnects and says `hello` until a daemon answers, and repeats a call refused as `upgrading`. A call cut off after
`closing` that carried a `request_id` is repeated with that ID; one without has an unknown outcome, as after any
disconnection. While a keeper runs, start no daemon: the keeper's is coming. `facade attach` answers `closing` once its last
key is written, so each key reaches the agent from one daemon: the daemon writes every key it read before that answer, and
then ends.

Every running agent keeps the skill and instructions of the build that started it until its CLI restarts, and new runs get
the new build's; Antigravity's plugin in a project stays while any run there uses it.

The new daemon serves the same agents. Every byte the old one read is in the screen logs, and the rest waits in each terminal,
so it asks no CLI to redraw, and reads each screen's status at once. It goes on writing each screen's log where the old daemon
stopped, without folding the log into a new checkpoint first, so it serves sooner. A new build that does not come up is started
again after the keeper's restart delay until a fixed build is installed; nothing rolls back.

### Compatibility

`hello` carries the oldest and newest protocol versions the client supports. The peers use the highest version they share,
or return `protocol_incompatible` if there is none. A newer build takes over only where it speaks the running build's
versions, so a version is raised with a range that still includes the one before it. Ignore fields you do not recognize. Treat an unrecognized enumeration
value as unknown locally, and skip a change whose `kind` you do not recognize. The Rust types provide `Unknown` variants for
this purpose, or `Unrecognized` where `unknown` is a value of its own. The daemon rejects an unsupported client kind during
`hello`.
