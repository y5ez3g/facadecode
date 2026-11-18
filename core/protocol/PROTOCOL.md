<!-- Generated from core/crates/base/src by core/crates/base/tests/protocol_files.rs: do not edit. -->

# Facade daemon protocol

Protocol version 2 (oldest accepted: 2). See `protocol.schema.json` for JSON Schema and `protocol.ts` for TypeScript types.

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
attempt. A client can retry temporary transport failures. Report a decoded refusal, invalid response, permission error,
or configuration error.

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

Wait for a successful `hello` before using the connection. Its `ops` and `topics` list the operations and topics offered
to clients, including machine management and queries. `window.deliver` and `agent.deliver_start_result` are
reserved for machine sessions. In this example, `→` is a client message and `←` is a daemon message. The redraw's
base64 value is abbreviated.

```text
→ {"jsonrpc":"2.0","id":1,"method":"hello","params":{"protocol":[2,2],"build":"1.4.2","kind":"terminal"}}
← {"jsonrpc":"2.0","id":1,"result":{"protocol":2,"build":"1.4.2","machine_id":"3f2504e0-4f89-41d3-9a0c-0305e82c3301","pid":4321,"agents":0,"topics":["agents","screen","messages","windows","machines"],"ops":["agent.start","agent.resume","agent.adopt","agent.stop","agent.remove","agent.inspect","agent.type","agent.screen","agent.resize","agent.rename","agent.send","hook.session-start","hook.prompt","hook.turn-end","hook.idle","hook.session-end","integration.add","integration.remove","integration.list","window.update","worktree.create","daemon.upgrade","daemon.log","machine.connect","machine.add","machine.list","machine.remove","machine.rename","agent.list","cli.list","location.list","agent.start_preflight"]}}
→ {"jsonrpc":"2.0","id":2,"method":"call","params":{"op":"agent.start","args":{"command":["claude"],"cwd":"/Users/me/project","env":{"HOME":"/Users/me","PATH":"/usr/bin:/bin"},"cols":120,"rows":30}}}
← {"jsonrpc":"2.0","id":2,"result":{"agent":{"agent_id":"a1","name":"Pixel","cli":"claude","cwd":"/Users/me/project","machine_id":"3f2504e0-4f89-41d3-9a0c-0305e82c3301","windows":[{"machine_id":"3f2504e0-4f89-41d3-9a0c-0305e82c3301","window_id":"terminal"}],"location_id":"loc-5f3c2a1b9e8d7c60","pid":5001,"process":"running","cols":120,"rows":30,"created_at":"2026-11-09T17:22:05.123Z","root":"a1","yolo":false,"state":"starting","tools_state":"connecting"}}}
→ {"jsonrpc":"2.0","id":3,"method":"watch","params":{"topic":"screen","args":{"agent":"a1"}}}
← {"jsonrpc":"2.0","id":3,"result":{"watch":1,"snapshot":{"agent_id":"a1","machine_id":"3f2504e0-4f89-41d3-9a0c-0305e82c3301","cols":120,"rows":30,"redraw":"G1s/MjAyNmw…","process":"running"}}}
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

A missing, empty, or blank name gets a random name from the settings file's `names`, or from the built-in names. The name
must be unused in all the initial member windows, ignoring case and surrounding spaces. If every name is taken or the list
is empty, Facade uses the agent's ID, such as `#a7`. Given names are trimmed and may repeat. Use an ID when names repeat.
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
- A call to `agent.resume` that starts a new run returns its running record. The `agents` topic reports the new `pid`,
  `running`, and no `exit`. See [Resume](#resume) for the response to an overlapping call.
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

`agent.resume` starts an ended agent's CLI again in its terminal, continuing its `session` in the record's `cwd`. The agent
keeps its ID, name, member windows, location source, `created_at`, and screen. The CLI uses the caller's `env`, filtered
as for `agent.start`, and its `cols` and `rows`.

If two resumes overlap, the later call waits for the first. If the run number changes while it waits, the later call
returns the agent's current record, even if the new run has already ended. If the run number stays the same, the
waiting call tries to resume. A removed record returns `not_found`. An agent already running when the call starts,
a session that cannot be continued, or a CLI or folder that cannot be used returns `unavailable`. A resume waits up to
10 seconds for the ended run's exit to be saved and its terminal released, then for the keeper as a start does.

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
The daemon lists Facade's version 3 tool definitions in `tools/list`. `list_agents` and `start_agent` results
identify the running machine and member windows. In `start_agent`, `window` can be a member window ID on the
originating machine (`win-2`) or a qualified ID (`win-2@gpu` or `win-2@id:3f9a2c1d`). A member window can be
disconnected. `location_source_window` is a bare ID of a connected window on the running machine. On a local
start, a relative `path` resolves from the calling agent's working directory. A remote start takes an absolute
`path` on the running machine.
`send_message` reports which windows' subscriptions took a notification.

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

`agent.start` with `worktree`, a `branch` and its `base_ref`, makes the worktree and starts in it in one call. With
`location_source_window`, the worktree branches from the supplied window location. Without it, the worktree branches from
the repository of `cwd`. A Git failure returns `worktree_failed` with what Git made in `data.kept`. A start that fails
after making the worktree keeps it and gives its location in `data.kept`. `worktree.create` makes a worktree for the
editor's New Worktree command.

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

`#human` is the person. The daemon takes the sending agent's member windows at send time. It offers the message to the
current `messages` subscriptions of each connected member window. A subscription channel accepting the notification
counts as delivery to that window. A send succeeds once at least one window accepts it. Its result has
`delivered_via: notified` and `windows: { delivered, not_delivered, outcome_unknown }`. All three arrays are present,
including empty ones. `delivered` contains window references. `not_delivered` contains `{ window, reason }` entries
for confirmed failures. Reasons include `window_disconnected`, `not_watching`, and `machine_unavailable`.
`outcome_unknown` contains windows that were sent a notification whose receipt was lost. With no confirmed delivery
and an unknown outcome, the daemon keeps the message and returns `unavailable` with `data.message_ref`,
`data.window_delivery`, and `data.unavailable.execution: outcome_unknown`. If all failures are confirmed, it keeps
no message and returns `unavailable` with the failures in `data.windows`. A send from the person to the person is refused.

The daemon saves the window outcomes before it responds. A repeat with the same request ID waits for an in-progress send
or returns the saved message and outcomes. If the daemon ended between saving the message and saving the outcomes, a
repeat returns that message as `pending` with `repeated: true` and no `windows`. The outcome is unknown and the daemon
sends nothing again.

The recipient's typist delivers a message to an agent. It waits until the input is empty, as the CLI's rule reads it, and
never types over a draft. The header names the sender, the message number and any message it replies to. If the sender has
one member window and the recipient has no membership there, the header also names that window from `from_window`. The
typist pastes the header and message, then presses
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

The `messages` topic reads the inbox of the agent the client acts for, which must be listed. For an `ide` client it reads
the person's inbox, `human`, as delivered to the client's bound logical window. Its snapshot only includes messages
delivered to that window. A client uses the snapshot to recognize duplicates and shows notifications for new changes.
Adopting an agent brings its future notifications into the window.

The arguments select messages:
by default those not yet delivered, including failed ones; `ids`, 1 to 100 message IDs, rereads those; `all` pages every
kept message; `cursor` continues from a page's `next_cursor`, and `limit` sets a page's size, 1 to 200, 100 by default;
`last` selects that many of the newest messages instead, in one page, without `ids`, `cursor` or `limit`. A snapshot
delivers every message it returns that was not yet delivered, through `read`: its typist never types a message it has not
begun, and its sender's `agent.send` responds. A message whose paste the typist had begun is finished in the terminal, and its
`text_written` is `unknown`, without `enter_written`. The snapshot's messages are delivered on disk before it is answered. Its
changes are `updated`, a message arriving or its delivery changing, and `removed`, a message no longer kept: withdrawn by its
send's `cancel`, past its 30 days, or gone with its inbox.

Messages and what became of them are kept 30 days across daemon restarts. A message ID is never given again, even after
its message is deleted. If the daemon ends during `agent.send`, the client loses its connection. The next daemon takes
up deliveries to agents within their original 30 seconds (see [Daemon replacement](#daemon-replacement)). A repeat of a
send to the person reads the saved window outcomes or reports an unknown outcome as described above.

### Editor windows

A Facade machine is a Facade home and its core. Its persistent `machine_id` is a lowercase UUID version 4, returned
by `hello`. A logical window reference has `machine_id` and `window_id`. The terminal window has the local machine ID
and `window_id: "terminal"`. `AgentInfo.machine_id` is the running machine. `AgentInfo.windows` lists the agent's
one or more member windows, unique and sorted by machine ID and window ID. An omitted `creator_machine_id` or
`root_machine_id` refers to the record's machine.

`agent.start` can supply `window` to choose one initial member, including a disconnected window. By default a listed
agent's call inherits all of its windows, and a person's `ide` call joins its bound window. A person's terminal call
joins `terminal`, as does an agent's call before its record is listed. A connected local `location_source_window`
can supply the location for `cwd`, which must be that location or
a folder inside it. Without that field, a start uses `cwd` under the terminal window's folder rules. The agent records
the location's `location_id` and the optional `location_source_window`.

An editor window connects as an `ide` client acting for the person. `hello.params.window` carries its description.
Its `WindowDescription.id` stays the same across reloads of an editor instance and changes when the window reopens.
The description also carries the window's name, `environment`, `workspace` where available, folders, Git branch prefix,
and optional terminal `colors` and `env`. `hello.result.window` gives the logical window bound to that connection
and is present for `ide` clients.

The daemon binds an editor connection to the logical window last bound to that instance, if one remains. Otherwise, a
workspace can reuse its earliest allocated logical window with no current connections. If neither applies, the daemon
allocates a new logical window. A binding that was replaced cannot publish updates for that window. Closing a connection
keeps the agents running. The last current connection closing sets `connected` to false and keeps the logical window.
On startup recovery the daemon removes a logical window if it has no workspace and no saved agent record refers to it
as a member window or location source. A window with a workspace stays available for reopening.

`agent.adopt` adds the bound editor window to a running or ended agent's members and returns the updated record.
An existing member gets the same record, guests are refused, and a missing record returns `not_found`. The
`agents` topic publishes an updated record when membership changes. Resuming retains the member windows. Removing
an agent removes all of its memberships.

`window.update` sends the whole description with the same instance ID and asks the daemon to read the logical
window's locations again. Locations are the window's folders and every checkout of a Git repository one of
them is in: the main checkout first, then the folder if it is another place, then other worktrees. Each path
appears once, with symbolic links resolved. The daemon reads them when the window describes itself and after a
worktree is made. A failed read keeps the last successful locations and reports `problems`. If the location
source window loses a location, the daemon stops the agents that used that source and location. A disconnected
window retains its prior locations.

The `windows` topic lists logical editor windows and the terminal window while it holds running agents.
`machine_id` and `window_id` identify a window, and a `removed` change carries both fields. For a client acting for an agent,
the window lists the CLIs that agent can start. An `ide` client also gets `clis` and `settings_problem` for a window
that gave `env`. Relative `PATH` entries resolve from the first folder, and a window with no folder lists no CLI.
The daemon keeps the window's `env` in memory.

`worktree.create` takes a local logical `window_id` or `terminal`. It makes a worktree and branch from the chosen
checkout at `<main folder>.worktrees/<branch>` and responds with the new location. `data.kept` describes any branch or
folder that remains after a failure.

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
An editor window's `colors` give replies to OSC 10, 11 and 12: foreground, background and cursor, each `#rrggbb`.
A malformed color refuses `hello` or `window.update` with `invalid_argument`. Each 8-bit channel is written twice, so
`#1e1e1e` replies `rgb:1e1e/1e1e/1e1e`, ended with the query's BEL or ST. A reply needs a window that provides the
requested color.

An editor resize sets the color source to that member window, including a resize with the same dimensions. A terminal
attach resize updates the size. An agent starts with its creating editor's colors or, for an agent start, with the
creator's color source if it is a member window. Other starts use the first member editor with colors in reference order.
The agent keeps the last colors when their window disconnects and across a resume. After a daemon restart or takeover,
the next resize or window description can supply colors again.

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

Each message to an agent still being delivered keeps its original deadline, at most 29.5 seconds after the restart.
A send repeated with its request ID joins it there. A message whose
paste had not begun goes to its recipient's typist. One whose paste had begun is never pasted again: the typist presses Enter
only once the input shows it whole as its own draft, an empty input confirms nothing, and at its deadline it fails as
`submission_unconfirmed`, with `text_written` `unknown` and no `enter_written`. That paste goes before the agent's other
messages. A message whose recipient ended fails as `ended`, one whose deadline passed as `timeout`, and one to an agent not
listed, whose record this build cannot read, waits for a snapshot until its deadline. A daemon that ended while writing a paste
longer than the terminal's buffer leaves the CLI inside it; the next daemon types nothing into it and logs that the CLI may
still be inside a paste.

The next daemon reads each saved logical window, its recent instance binding and its agent memberships from
`facade.db`. It starts with the windows disconnected. When an instance reconnects, the daemon uses the normal
window binding rules. Window colors and environments are supplied by the editor after it reconnects.

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

A `facade` command or editor of a newer build uses `daemon.upgrade` to take over from the older daemon. Every agent runs on,
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
A keeper holding CLIs starts the launcher's daemon, the new build, after its restart delay. When the old keeper exits
with no CLIs, the client starts the new build through the ordinary startup path.

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

Daemon clients send `hello` with `protocol: [2,2]` and expect the daemon to select 2. A version range that excludes
2 receives `protocol_incompatible` before the daemon reads the rest of the hello parameters. The relay contract and
keeper protocol are at version 1. MCP's date versions are independent of Facade's tool interface version.

Ignore fields you do not recognize and skip a change whose `kind` you do not recognize. Treat unrecognized enum
values as unknown locally. Rust uses `Unknown`, or `Unrecognized` where `unknown` is a protocol value.
The daemon refuses an unsupported client kind in `hello`.

### Machine sessions

A machine session is a bidirectional use of daemon protocol 2 over SSH. The first line is a
`hello` with `kind: machine` and the initiating daemon's `MachineHello`. The response gives the
answering daemon's introduction. Each introduction includes a machine ID and a boot ID for the
running daemon. Paths that reach the same boot ID are routes to the same daemon.

On Linux, `ssh_cleans_processes` reports whether logind will clean up processes when this user's
SSH session ends. Omit the field on other platforms or when the policy is unknown. If the policy
applies, advise the user to ask the remote administrator to add the SSH account to `KillExcludeUsers`
in `logind.conf`. The exclusion takes precedence over `KillOnlyUsers` and `KillUserProcesses`.

Each direction numbers its JSON-RPC requests independently. After `hello`, each daemon sends its
first full `advertise` as a request with an `id`. The receiving daemon verifies the machine ID and
`boot_id` against the introduction, checks for conflicts, and decides whether the sending machine
may join. It replies with an empty result (`{}`) or a structured JSON-RPC error. Each daemon
registers and advertises the directly connected machine after accepting that machine's first table
and receiving success for its own. Later `advertise` updates are full-table notifications without
an `id` and replace the sending machine's previous table.

The `route` of `forward` lists the remaining hops through the destination.
The forwarding machine removes its own hop and preserves the original `Caller`. The destination
reads the method and arguments. A start or send can carry a request ID scoped to the original
caller and target. A call that could not be sent is `not_executed`. A sent call that lost its
response can report `outcome_unknown`. A forwarded watch that loses its route ends with
`watch_ended`; a new watch begins with a fresh snapshot.

For a forwarded `call`, `params` is `ForwardCall`. The originating daemon sets `by_model` from
the authenticated local connection, attaches known sender names on `agent.send`, and takes
colors from the bound editor window on `agent.resize`. The destination reads these facts on
machine sessions. Local client calls use `CallParams`.

`machine.connect` first answers the authorized local client, then switches that connection to
machine frames. After the foreground handshake, the local daemon sends `connected` or
`connect_failed` to that client. `machine.add` answers once the daemon has verified the
saved destination on its own connection.

Agent views identify a record by machine and agent number. The `agents` snapshot has local
`agents` and remote `machines` rows. A `synced` row or change carries the machine's entire list,
including an empty list. A pending, unreachable or absent row keeps earlier records visible as
disconnected. A window notification to `#human` carries its full `MessageRef`. Window receipts
distinguish delivery, confirmed failure and an unknown outcome.

## Methods

| Name | Description |
|---|---|
| `hello` | Starts the connection (`HelloParams`). The result (`HelloResult`) describes the daemon. |
| `call` | Runs an operation (`CallParams`) and returns its result. |
| `watch` | Follows a topic (`WatchParams`). The result (`WatchResult`) contains its snapshot; `changed` notifications follow. |
| `unwatch` | Ends a watch (`UnwatchParams`). |
| `cancel` | Cancels a call still under way on this connection, by that call's request ID (`CancelParams`), and answers `{}`. It withdraws only an `agent.send` whose message's paste has not begun, which then answers `cancelled` and is not kept; every other call goes on, and its own answer says what it did. Closing the connection withdraws nothing. |
| `changed` | Reports a change for one watch (`ChangedParams`). |
| `watch_ended` | Ends a forwarded watch (`WatchEndedParams`). |
| `advertise` | Replaces the directly connected machine's table (`AdvertiseParams`). |
| `forward` | Forwards a request to its destination (`ForwardParams`). |
| `connected` | Reports the foreground connection's successful handshake to the local CLI (`ConnectedParams`). |
| `connect_failed` | Reports a foreground connection failure to the local CLI (`ConnectFailedParams`). |
| `closing` | From the daemon, a notification: a newer Facade takes over (`ClosingParams`). Every answer this connection waits for has been written. The client sends nothing more but `closing` back, a notification without params, and connects again; the new daemon answers within seconds. A client that does not answer within 0.2 seconds is cut. |

## Topics

Topics available to `watch`. Their types are defined below.

| Name | Arguments | Snapshot | Change | Description |
|---|---|---|---|---|
| `agents` | `AgentsWatchArgs` | `AgentsSnapshot` | `AgentsChange` | Lists agent records and machine sync states, then sends `updated` and `removed` by machine and agent ID. Starts, exits, removals, renames, and a state of waiting for the person or an error are published immediately. Other state changes, and title and size changes, are batched for up to 200 ms. |
| `screen` | `ScreenWatchArgs` | `ScreenSnapshot` | `ScreenChange` | Follows one agent's screen: a full redraw, then `output`, `redraw`, `exit`, and `removed` changes. A viewer that is behind during removal receives the last screen, any exit it missed, and then `removed`. |
| `messages` | `MessagesWatchArgs` | `MessagesSnapshot` | `MessagesChange` | Reads the inbox of the agent the client acts for: the selected messages, oldest first, then `updated` when a message arrives or its delivery changes, and `removed` when one is no longer kept: withdrawn by its send's `cancel`, gone after its 30 days, or gone with its inbox. A snapshot delivers every message it returns that was not yet delivered: its typist does not type it, or finishes a paste it began, and its sender learns that it was read. A change delivers nothing, so a client that hands messages to a model takes them through a snapshot. For an `ide` client it reads the person's inbox, `human`. Its snapshot includes the messages delivered to that logical window. Its changes carry new notifications sent to that window's subscription. Messages and what became of them are kept 30 days, across daemon restarts. |
| `windows` | `NoArgs` | `WindowInfo[]` | `WindowsChange` | Lists logical editor windows, including disconnected windows retained for reopening, and the terminal window while it holds running agents. Then sends `updated` to insert or replace a window and `removed` to remove it, by machine ID and window ID. For a client that acts for an agent, each window lists the CLIs a start by that agent can run. |
| `machines` | `NoArgs` | `MachineInfo[]` | `MachinesChange` | Follows the view of reachable machines and saved connections. |

## Operations

Operations available to `call`. Set `op` to the name and `args` to its arguments. Types are defined below.

| Name | Arguments | Result | Description |
|---|---|---|---|
| `agent.start` | `StartArgs` | `StartResult` | Starts an agent by running the CLI in a terminal of the requested size. A CLI rule's name starts that CLI as its rule says. The optional `window` selects the only initial member. Otherwise an agent's start inherits its members when listed. An editor start joins its bound window. A person's terminal start or a start from an agent not yet listed joins `terminal`. The optional `location_source_window` selects a connected local window that supplies `cwd`. Without it, `cwd` follows the terminal rules. A `prompt` is refused before anything starts where a message could not carry it. It is kept with the agent's record and answered pending, then delivered as the agent's first message once the CLI's tools connected or will not. A prompt from an agent owes it one result, under `result_message_id`, once the prompt is settled. A program or folder that cannot be used returns `unavailable`. With `worktree`, the start makes that worktree first, as `worktree.create` does, and starts in it: Git's failure answers `worktree_failed` with what it made in `data.kept`, and a start that fails after making the worktree keeps it, its error's `kept` naming it. A `request_id` of the creator's own is looked for before anything else: a start with the same ID under way answers once it does, and an agent the same creator started with it within the hour is answered as it stands now, `repeated`, with its prompt as it stands, starting nothing and making no worktree. A start that failed keeps no ID. Waits up to 10 seconds for a ready keeper before sending, then up to 10 more seconds for the reply. Either timeout returns `unavailable`. A timeout after sending leaves the outcome unknown. |
| `agent.resume` | `ResumeArgs` | `AgentInfo` | Starts an ended agent's CLI again in its terminal, continuing its recorded session in its original folder. The agent keeps its ID, name, members, record, and screen. The screen gets a fresh terminal's modes. Uses the caller's environment and terminal size, and the CLI's current rule. An overlapping resume waits for the first. If the run number changed while it waited, it returns the current record, even if the new run has already ended. Otherwise it tries to resume. Returns `not_found` if the agent was removed, or `unavailable` if the agent was already running at entry, for an agent without a CLI rule that resumes sessions, one without a recorded session, or a CLI or folder that cannot be used. Waits for the keeper like `agent.start`. If the CLI cannot start, the agent stays ended with its earlier exit. |
| `agent.adopt` | `AgentArgs` | `AgentInfo` | Adds a bound `ide` client's logical window to the agent's members and returns the record. Works for running and ended agents. An existing member is returned unchanged. Refuses a guest or a client without a bound editor window, and returns `not_found` for a missing record. |
| `agent.stop` | `AgentArgs` | `StopResult` | Stops a running agent's process group with SIGHUP and sends SIGKILL to anything left at the deadline. The daemon sets the deadline 3 seconds after accepting the stop, keeping an earlier pending deadline. Queueing can shorten the gap after SIGHUP. Signals are sent only if Facade can check that the group still belongs to the CLI. Waits up to 10 seconds for a ready keeper, up to 10 more seconds for its reply, then up to 10 more seconds for the CLI's exit. When no keeper runs, only the exit wait applies. Any timeout returns `unavailable`: the stop goes on. An agent with no terminal to stop returns `not_found`, and one whose actor stopped `internal`, both before anything is sent. Returns the recorded exit; its record stays listed. A timeout or service replacement does not cancel the stop or extend its deadline. An agent whose CLI had ended before the stop returns its recorded exit with `already_ended`, without another signal. |
| `agent.remove` | `AgentArgs` | `EmptyResult` | Removes the agent record. Stops a running agent first with `agent.stop`. Removing an ended agent sends no additional signal: processes left by a CLI that ended by itself can keep running if they ignore terminal hangup. |
| `agent.inspect` | `AgentArgs` | `InspectResult` | Reads the agent's record, its CLI rule, its message input as the screen shows it now, and whether its session is tracked. Sends no keys and starts nothing. Input reads `unknown` for an ended agent, without a rule, while a synchronized update is open, and after recovery or resume until the CLI writes again. A reading never means input may be typed. |
| `agent.type` | `TypeArgs` | `EmptyResult` | Types into the agent's terminal. `raw` bytes from an attached terminal are queued as they are. `text` and `keys` go through the agent's typist, one call at a time, and their call is answered once they reached the terminal. If the agent ends first, the call fails with `ended` when nothing of it was typed, or with `partial_input`, whose data says what went in. One call carries at most 1 MiB as written, a paste counted with its brackets and Enter. A call with an ID fails with `capacity_exceeded` if the input does not fit in the agent's 1 MiB of waiting input or a resize is pending. A notification waits without a response; disconnection drops its waiting input. Success confirms that raw bytes were queued or that text and keys reached the terminal, not that the CLI processed them. Daemon failure can lose input not yet written; a missing response leaves the outcome unknown. An ended agent returns `ended`. |
| `agent.screen` | `ScreenArgs` | `ScreenText` | Reads the last logical lines of the agent's screen and scrollback as they show, inverse and dim text marked, with whether older lines lie above them. An ended agent's screen is the one it left. |
| `agent.resize` | `ResizeArgs` | `EmptyResult` | Accepts a terminal size for all viewers; the last resize wins. When the applied size changes, every viewer receives a redraw at that size. If a full screen log is waiting for its checkpoint writer, only the latest requested size is kept and applied when the writer finishes. A daemon failure before application loses that request. Input sent afterward waits for the size: calls with IDs fail with `capacity_exceeded`, while notifications wait. An agent whose terminal closed accepts it without changing anything. |
| `agent.rename` | `RenameArgs` | `AgentInfo` | Renames an agent and returns its record; the `agents` topic sends it as `updated`. A blank name gets a default name chosen from the suggested names. |
| `agent.send` | `SendArgs` | `SendResult` | Sends a message to an agent, from the agent the client acts for or else from the person, `human`. The recipient's typist types it into its terminal with a header naming the sender and the message, and presses Enter. Answers within the send's 30 seconds with the message: delivered through the terminal or read through the recipient's `messages` topic, or failed with a reason and what reached the terminal. Its delivery has what is left of the 30 seconds as the call reaches the daemon, `time_left_ms`, at most 29.5 seconds, the rest kept for the answer's way back. A message to `#human` is delivered once a member window's current `messages` subscription takes it. The response reports the outcomes in `windows`. If none take it, `unavailable` lists their reasons in `data.windows` and the send keeps no message. A message to a guest waits for the guest's next turn: the send answers at once with its delivery `pending` and no deadline, and the guest's prompt or turn-end hook delivers it, through `read`. Refusals before the message exists are errors: invalid text, longer than 8,000 characters or 540 lines included, a sender or recipient not found, a recipient that ended, a message to the person from the person, or a reply to a message not in the sender's inbox. A recipient removed before the answer took the message with it: the call fails with `ended`. A daemon that ends before responding closes the connection. The next one goes on delivering a message to an agent within the same 30 seconds and never pastes again a message whose paste began. If the daemon ended after storing a `#human` message and before saving the window outcomes, a repeat returns the original message, still `pending` with no `windows`. Its outcome is unknown. A `request_id` of the sender's own is looked for before anything else: the same ID within the hour of the message it kept answers that message as it stands, `repeated`, joining its delivery while it lasts, and sends nothing again, across daemon restarts too. A refused or withdrawn send keeps no ID. A `cancel` of the call withdraws the message while its paste has not begun: it answers `cancelled`, and nothing of it is typed or kept; one whose paste began goes on. |
| `hook.session-start` | `HookSession` | `SessionStartResult` | For a CLI's session-start hook: a session of `cli` began. A session that is not of a run Facade started joins as a guest: the next agent ID, a default name and `guest: true`, listed until its session ends. Answers the guest's ID and what its model is told. In a run's own session it changes nothing: the session Facade records for the run of the same CLI that the client acts for, or any session while it records none. Another session of that CLI, nested in the run, is a guest's. |
| `hook.prompt` | `HookSession` | `HandOver` | For a CLI's prompt hook: a turn of the session began, and its guest reads `working`. Takes every message not yet delivered to the guest, which delivers them through `read`, for the hook to give its model with the prompt. A CLI whose prompt hook runs before each of a turn's model calls, Antigravity, reports only the turn's first. Claude Code's names `status_file`, where Claude Code reports how its session stands: while the guest reads `working`, the daemon reads it once a second, and `idle` there, written since the turn began, ends the turn as `hook.idle` does, for a turn the person cut short, which runs no hook. A session not yet known joins first, as at its start. A subagent's prompt, and a run's, takes nothing. |
| `hook.turn-end` | `HookSession` | `HandOver` | For a CLI's turn-end hook: the session ended a turn, and its guest reads `idle`. Takes every message not yet delivered to the guest, which delivers them through `read` as a snapshot does, for the hook to give its model before the turn ends. A session not yet known joins first. A subagent's turn, and a run's, takes nothing. |
| `hook.idle` | `HookSession` | `EmptyResult` | For a CLI's sign that its turn ended without its turn-end hook, as one the person cut short does, or Claude Code's that ended in an error: its guest reads `idle`, and nothing is taken: its messages wait for the next prompt. A session not yet known joins first. A subagent's, and a run's, change nothing. |
| `hook.session-end` | `HookSession` | `EmptyResult` | For a CLI's session-end hook: the session ended. Its guest is removed: `removed` on the `agents` topic, and its waiting messages dropped. |
| `integration.add` | `IntegrationArgs` | `IntegrationInfo` | Writes Facade's entries in a CLI's user configuration, so that the sessions the person starts join as guests: Facade's MCP server, an approval of its own tools only, and the hooks, plugin or extension that report a session's start, turns and end. Nothing else changes. Each file is read first, and nothing is written where one cannot be read as its CLI writes it, or holds a `facade` entry of the person's own. Adding again brings Facade's entries up to date. Answers each file's state. |
| `integration.remove` | `IntegrationArgs` | `IntegrationInfo` | Takes Facade's entries out of a CLI's user configuration. A file nothing else changed since is put back as it was, byte for byte, and one Facade made is deleted; in a file changed since, only Facade's entries go. Answers each file's state after. |
| `integration.list` | `IntegrationsArgs` | `IntegrationsList` | Says, for each CLI Facade can integrate, whether its user configuration holds Facade's entries, file by file, and as they would be written now. |
| `window.update` | `WindowDescription` | `EmptyResult` | For a bound `ide` client, replaces its window's description, keeping the same window instance ID, and reads its locations again, which the client asks for when a repository of the window changes. Responds once they are read. If the window stops offering an agent's location and is the agent's location source, the agent ends as `agent.stop` ends it. |
| `worktree.create` | `WorktreeCreateArgs` | `LocationInfo` | Makes a Git worktree from the checkout at `cwd`, a location of the window, with a new branch that starts at `base_ref`, at `<main folder>.worktrees/<branch>`: the branch less the window's branch prefix, with characters a folder name cannot hold replaced by `-`, and `-1`, `-2` and so on after it where that path is taken. Answers with the new location. Refuses before changing anything a branch Git does not accept, a folder name some system cannot hold, and a location that is not a checkout with a commit. Creations into one `.worktrees` folder run one at a time; one that waits more than 120 seconds for another fails. Git's failures answer `worktree_failed`: one partway keeps what it made, and its error says what in `data.kept`. |
| `daemon.upgrade` | `UpgradeArgs` | `UpgradeResult` | Hands the running Facade over to a newer build, `program`, while every agent runs on, and answers once the handover is under way; `closing` follows on every connection past `hello`. The build must be of a higher version than this daemon's and speak its daemon protocol version; while agents run, it must also speak the running keeper's protocol, as the keeper never changes build while it holds CLIs. This daemon installs the build, points the launchers at it, drains and exits; the keeper then starts the launcher's daemon, the new build, and starts it again with its restart delay where it does not come up. Nothing rolls back. Calls that arrive meanwhile answer `upgrading` and did nothing. A second request while a handover is under way answers when the first does. |
| `daemon.log` | `DaemonLogArgs` | `DaemonLogResult` | Reads the daemon's log, `core/logs/daemon.log`, which Facade keeps for 30 days: its last `lines` lines, oldest first. For the person's clients alone: the log names every agent and who sent whom a message, so a call that acts for an agent or a guest answers `refused`, YOLO or not. More than 200 lines answers `invalid_argument`. |
| `machine.connect` | `MachineConnectArgs` | `MachineConnectResult` | Authorizes foreground SSH and changes the client stream into the machine session. |
| `machine.add` | `MachineAddArgs` | `MachineAddResult` | Saves a verified connection and waits for its background session to connect. |
| `machine.list` | `NoArgs` | `MachineListResult` | Lists reachable machines and saved connections, with routes and connection states. |
| `machine.remove` | `MachineRemoveArgs` | `MachineRemoveResult` | Removes the local saved connection and reports remaining reachability. |
| `machine.rename` | `MachineRenameArgs` | `MachineRenameResult` | Changes the name on the selected machine. |
| `agent.list` | `MachineQueryArgs` | `AgentListResult` | Lists reachable agents from the selected machine or all known query destinations. Answers once they reply or after three seconds. The client receives agents oldest first, using the creation time recorded by each agent's own machine. Equal timestamps are ordered by machine ID, then by numeric agent ID. |
| `cli.list` | `MachineQueryArgs` | `CliListResult` | Lists the CLIs of the selected machine's login environment. |
| `location.list` | `MachineQueryArgs` | `LocationListResult` | Lists locations the selected machine's windows supply. |
| `agent.start_preflight` | `StartArgs` | `EmptyResult` | Checks a start's program and location without starting an agent or making a worktree. |
| `window.deliver` | `DeliverArgs` | `WindowDelivery` | Offers a message to the listed local window subscriptions and returns their outcomes. Machine sessions only. |
| `agent.deliver_start_result` | `DeliverStartResultArgs` | `EmptyResult` | Delivers the result of a start at its reserved message number. Machine sessions only. |

## Error reasons

The `data.reason` values of the daemon protocol.

| Reason | When |
|---|---|
| `invalid_argument` | An argument is missing, malformed, or out of range, or the request is unsupported. |
| `not_found` | The agent, run, message, or watch does not exist. |
| `ambiguous_reference` | A reference names more than one agent, or the person and an agent: select one by its ID. |
| `ended` | The agent ended: it takes no more input or messages. |
| `partial_input` | A text or keys call stopped partway: the agent ended, or its terminal stopped taking input, after part of the call reached the terminal. The error's data says what went in. |
| `unavailable` | The operation cannot complete: for example, a stop or a screen watch's snapshot timed out, or the keeper disconnected. |
| `protocol_incompatible` | The two sides share no protocol version, or a required client kind, operation, or field is unsupported. |
| `machine_id_conflict` | Two running daemons introduced themselves with the same machine ID. |
| `ssh_interaction_required` | A saved SSH connection needs a foreground login or verification. |
| `capacity_exceeded` | A message exceeds the line limit, or input exceeds the per-call limit or available queue room. |
| `internal` | An internal Facade error. |
| `refused` | The caller is not allowed to perform this operation. The keeper accepts only the daemon holding the daemon lock. |
| `configuration_invalid` | Facade's settings file, `facade.json` in the Facade home, cannot be read as it must, which stops every launch until it is fixed. The message says each problem, with the file's path and, where known, its line and column. |
| `cancelled` | The call was withdrawn by its `cancel` before it took effect: a message whose paste had not begun, which is not kept. |
| `worktree_failed` | Git could not make a worktree it was asked for: `data.kept` says what it made, which stays. |
| `upgrading` | A newer Facade is taking over: the call did nothing, and a client repeats it once the new daemon answers. |
| `unsupported` | The CLI cannot do what the call asks of it: take a model or an effort it has no way to set, or resume a session that a CLI of another type had. |

## Types

### AdvertiseParams

A complete replacement for a directly connected machine's table. Every row has a route, build and boot ID.

| Field | Type | Required | Description |
|---|---|---|---|
| `machines` | `MachineInfo[]` | yes |  |

### AgentArgs

Arguments for an operation on one agent.

| Field | Type | Required | Description |
|---|---|---|---|
| `agent` | `string` | yes | An agent ID (`a3`, `#a3`, or `3`), a unique name with or without `@`, or a name followed by its ID, such as `@Pixel #a3`. |

### AgentInfo

An agent record.

| Field | Type | Required | Description |
|---|---|---|---|
| `agent_id` | `string` | yes | The stable ID: `a` followed by a number, unique within the Facade home while its counter file remains. |
| `address` | `string` | no | The copyable address, including a machine selector. The serving daemon fills client views. |
| `label` | `string` | no | The label in the serving client's machine view. |
| `unreachable` | `boolean` | no | The running machine is currently unreachable. |
| `name` | `string` | yes | The display name. Names are nonempty but may repeat. |
| `cli` | `string` | yes | The CLI: the name of its entry in Facade's settings file, a built-in's such as `claude` or an added one such as `Codex · work` (CONFIGURATION-2.1), or the program's file name for a program started by its path or name. |
| `cwd` | `string` | yes | The CLI's working folder at startup. |
| `machine_id` | `string` | yes | The ID of the Facade machine that runs the agent. |
| `windows` | `WindowRef[]` | yes | One or more member windows, unique and sorted by machine ID and window ID. |
| `location_id` | `string` | yes | The ID of its location: the location `cwd` is, or the innermost one that contains `cwd`. |
| `location_source_window` | `WindowRef` | no | The window that provided the agent's running location, where a window supplied it. |
| `pid` | `number` | no | The CLI's process ID. Omitted for a guest, whose process Facade does not know. |
| `process` | `ProcessState` | yes | Whether the CLI is running or ended. |
| `cols` | `number` | no | Terminal width in columns. Omitted for a guest, which has no terminal of Facade's. |
| `rows` | `number` | no | Terminal height in rows. Omitted for a guest. |
| `created_at` | `string` | yes | The start time in UTC ISO 8601 format with milliseconds. |
| `creator` | `string` | no | The agent whose client started it. Omitted where the person started it, and for a guest. |
| `creator_machine_id` | `string` | no | The creator's machine ID. Omitted when it is the record's own machine. |
| `root` | `string` | yes | The first agent of its creation tree: itself where it has no creator, or else its creator's root. It stays when agents of the tree end or go. |
| `root_machine_id` | `string` | no | The root agent's machine ID. Omitted when it is the record's own machine. |
| `yolo` | `boolean` | yes | Whether its run has YOLO on: its CLI runs without asking, and it reaches every agent. With YOLO off, its CLI runs as it natively does, and it reaches only the agents of its creation tree. A launch takes it from Facade's settings file, `facade.json`, as it is accepted; a guest as it joins. |
| `exit` | `ProcessExit` | no | The recorded exit. Omitted while the agent is running. |
| `session` | `string` | no | The ID of the CLI session the agent's CLI last reported, which `agent.resume` continues. Omitted until one is reported. |
| `state` | `AgentState` | yes | What the agent is doing. |
| `state_detail` | `StateDetail` | no | More about the state: what the CLI waits for, its own words, how its process ended, or why the state is unknown. |
| `said` | `Said` | no | The last thing that went into the agent's message input. Omitted until something has. |
| `tools_state` | `ToolsState` | yes | Whether the agent's CLI can use Facade's tools. |
| `tools_reason` | `ToolsReason` | no | Why the agent's CLI cannot use Facade's tools. Omitted unless they are unavailable. |
| `guest` | `boolean` | no | A guest: a session of a CLI the person started outside Facade, which joined through the CLI's hooks. Its terminal is not Facade's: Facade cannot read its screen, type into it, resize, stop or resume it. Omitted for an agent Facade started. |

### AgentListResult

| Field | Type | Required | Description |
|---|---|---|---|
| `agents` | `AgentInfo[]` | yes |  |
| `machines` | `MachineQueryResult[]` | yes |  |

### AgentMachineState

How complete the agent view is for one remote running machine.

| Field | Type | Required | Description |
|---|---|---|---|
| `machine_id` | `string` | yes |  |
| `state` | `AgentSyncState` | yes |  |
| `agents` | `AgentInfo[]` | no | For a synced machine, its complete records, including an empty list. |

### AgentRef

An agent's durable identity, independently of names and routes.

| Field | Type | Required | Description |
|---|---|---|---|
| `machine_id` | `string` | yes |  |
| `agent_id` | `string` | yes |  |

### AgentState

What an agent is doing, from its CLI's own status reports, from its screen where its CLI's rule reads it, and from Facade's own facts. The first state that holds, in this order, is the agent's: `waiting_for_you`, `error`, `just_done`, `working`, `idle`, `starting`, then `unknown`; `ended` once its process ended.

`'starting' \| 'working' \| 'waiting_for_you' \| 'just_done' \| 'idle' \| 'error' \| 'ended' \| 'unknown'`

### AgentSyncState

`'synced' \| 'pending' \| 'unreachable'`

### AgentsChange

A change to the `agents` topic. Skip unknown change kinds.

`{ readonly kind: 'updated'; readonly agent: AgentInfo } \| { readonly kind: 'removed'; readonly machine_id: string; readonly agent_id: string } \| { readonly kind: 'machine_state'; readonly machine: AgentMachineState }`

### AgentsSnapshot

The agents view and the synchronization state of its remote contributors.

| Field | Type | Required | Description |
|---|---|---|---|
| `agents` | `AgentInfo[]` | yes | Records on the machine that serves this view. |
| `machines` | `AgentMachineState[]` | yes |  |

### AgentsWatchArgs

Arguments for the agents view. The member-machine filter is for internal forwarded watches.

| Field | Type | Required | Description |
|---|---|---|---|
| `member_machine_id` | `string` | no |  |

### CallParams

Parameters for `call`.

`{ readonly op: 'agent.start'; readonly args: StartArgs } \| { readonly op: 'agent.resume'; readonly args: ResumeArgs } \| { readonly op: 'agent.adopt'; readonly args: AgentArgs } \| { readonly op: 'agent.stop'; readonly args: AgentArgs } \| { readonly op: 'agent.remove'; readonly args: AgentArgs } \| { readonly op: 'agent.inspect'; readonly args: AgentArgs } \| { readonly op: 'agent.type'; readonly args: TypeArgs } \| { readonly op: 'agent.screen'; readonly args: ScreenArgs } \| { readonly op: 'agent.resize'; readonly args: ResizeArgs } \| { readonly op: 'agent.rename'; readonly args: RenameArgs } \| { readonly op: 'agent.send'; readonly args: SendArgs } \| { readonly op: 'hook.session-start'; readonly args: HookSession } \| { readonly op: 'hook.prompt'; readonly args: HookSession } \| { readonly op: 'hook.turn-end'; readonly args: HookSession } \| { readonly op: 'hook.idle'; readonly args: HookSession } \| { readonly op: 'hook.session-end'; readonly args: HookSession } \| { readonly op: 'integration.add'; readonly args: IntegrationArgs } \| { readonly op: 'integration.remove'; readonly args: IntegrationArgs } \| { readonly op: 'integration.list'; readonly args: IntegrationsArgs } \| { readonly op: 'window.update'; readonly args: WindowDescription } \| { readonly op: 'worktree.create'; readonly args: WorktreeCreateArgs } \| { readonly op: 'daemon.upgrade'; readonly args: UpgradeArgs } \| { readonly op: 'daemon.log'; readonly args: DaemonLogArgs } \| { readonly op: 'machine.connect'; readonly args: MachineConnectArgs } \| { readonly op: 'machine.add'; readonly args: MachineAddArgs } \| { readonly op: 'machine.list'; readonly args: NoArgs } \| { readonly op: 'machine.remove'; readonly args: MachineRemoveArgs } \| { readonly op: 'machine.rename'; readonly args: MachineRenameArgs } \| { readonly op: 'agent.list'; readonly args: MachineQueryArgs } \| { readonly op: 'cli.list'; readonly args: MachineQueryArgs } \| { readonly op: 'location.list'; readonly args: MachineQueryArgs } \| { readonly op: 'agent.start_preflight'; readonly args: StartArgs } \| { readonly op: 'window.deliver'; readonly args: DeliverArgs } \| { readonly op: 'agent.deliver_start_result'; readonly args: DeliverStartResultArgs }`

### Caller

The identity supplied by the daemon that accepted a local call.

`{ readonly kind: 'terminal'; readonly machine_id: string } \| { readonly kind: 'ide'; readonly window: WindowRef } \| { readonly kind: 'agent'; readonly agent: AgentRef; readonly root: AgentRef; readonly yolo: boolean }`

### ChangedParams

A `changed` notification for one watch.

| Field | Type | Required | Description |
|---|---|---|---|
| `watch` | `number` | yes | The watch number returned on this connection. |
| `change` | `AgentsChange \| ScreenChange \| MessagesChange \| WindowsChange \| MachinesChange` | yes | A change with the type defined by the watched topic. |

### CliInfo

A CLI a start can run: an entry of Facade's settings file (CONFIGURATION-2.1).

| Field | Type | Required | Description |
|---|---|---|---|
| `cli` | `string` | yes | The name a start gives: a built-in's, such as `claude`, or the name of a CLI the settings file adds. |
| `display_name` | `string` | yes | The name people know it by: a built-in's, such as `Claude Code`, or an added CLI's own. |
| `available` | `boolean` | yes | Whether it can be started: its entry is right and its program is found. |
| `problem` | `string` | no | Why it cannot be started: what is wrong with its entry, or that its program cannot run where it would start, each said by its setting. Omitted where it can. |
| `not_installed` | `boolean` | no | A built-in CLI whose entry has no problem and names no program of its own, and whose program is not found where the start would run: not installed. Only with `available` false. A client may leave it out of its list instead of showing it as one that cannot start. Omitted otherwise. |
| `overrides` | `Overrides` | yes | Whether a start can choose its model and its effort (CLIS-1.4). |

### CliListResult

| Field | Type | Required | Description |
|---|---|---|---|
| `clis` | `CliInfo[]` | yes |  |
| `settings_problem` | `string` | no |  |

### ClientKind

The kind of client connecting to the daemon.

`'terminal' \| 'mcp' \| 'ide' \| 'machine'`

### ConnectFailedParams

Foreground handshake failed after local authorization.

| Field | Type | Required | Description |
|---|---|---|---|
| `error` | `ErrorBody` | yes |  |

### ConnectedParams

Connection verified on the foreground stream.

| Field | Type | Required | Description |
|---|---|---|---|
| `machine` | `MachineHello` | yes |  |
| `first_connection` | `boolean` | yes |  |

### ConnectionKind

`'saved' \| 'temporary'`

### ConnectionState

`'connected' \| 'unavailable' \| 'ssh_interaction_required'`

### DaemonLogArgs

Arguments for `daemon.log`.

| Field | Type | Required | Description |
|---|---|---|---|
| `lines` | `number` | no | How many of the log's last lines to read: 200 where absent, and at most 200. |

### DaemonLogResult

The result of `daemon.log`.

| Field | Type | Required | Description |
|---|---|---|---|
| `lines` | `string[]` | yes | The last lines of `core/logs/daemon.log`, oldest first, the home folder written as `~`. Empty where there is no log. |

### DeliverArgs

A single message for the person, offered to its member windows on another machine.

| Field | Type | Required | Description |
|---|---|---|---|
| `message_ref` | `MessageRef` | yes |  |
| `message` | `Message` | yes |  |
| `windows` | `WindowRef[]` | yes |  |

### DeliverStartResultArgs

A start's result message for its creator, with the number the creator's machine reserved.

| Field | Type | Required | Description |
|---|---|---|---|
| `recipient` | `AgentRef` | yes |  |
| `message` | `Message` | yes |  |

### DeliveredVia

How a message was delivered.

`'terminal' \| 'read' \| 'notified'`

### Delivery

What became of a message.

| Field | Type | Required | Description |
|---|---|---|---|
| `status` | `DeliveryStatus` | yes | `pending` while the message is being delivered, then `success` or `failure`. |
| `reason` | `DeliveryFailure` | no | Why it was not delivered. Omitted unless it failed. |
| `text_written` | `TextWritten` | yes | How much of the message reached the recipient's terminal. |
| `enter_written` | `boolean` | no | Whether the Enter that submits it reached the recipient's terminal. Omitted when that is not known: the recipient read the message while its typist was typing it, its typist did not say by the deadline, what it typed was still queued then, or the daemon before a restart had begun its paste. |
| `deadline` | `string` | no | When a pending delivery fails if the message is not delivered by then. Omitted once it is settled. |
| `delivered_via` | `DeliveredVia` | no | How the message was delivered. Omitted unless it was. |
| `delivered_at` | `string` | no | When the message was delivered. Omitted unless it was. |

### DeliveryFailure

Why a message was not delivered.

`'ended' \| 'input_draft' \| 'input_interaction' \| 'input_unknown' \| 'timeout' \| 'submission_unconfirmed' \| 'unsupported'`

### DeliveryStatus

The state of a message's delivery.

`'pending' \| 'success' \| 'failure'`

### EmptyResult

An empty success result: `{}`.

`Record<string, never>`

### EndReason

Why an exit has no code or signal.

`'terminal_closed'`

### ErrorBody

A request error.

| Field | Type | Required | Description |
|---|---|---|---|
| `code` | `number` | yes | The JSON-RPC error code: -32700 for invalid JSON, -32600 for an invalid request, -32601 for an unknown method, -32602 for invalid arguments, and -32000 for other failures. |
| `message` | `string` | yes | A plain-language explanation of the error. |
| `data` | `ErrorData` | yes | Structured error details. |

### ErrorData

Error details for clients to inspect.

| Field | Type | Required | Description |
|---|---|---|---|
| `reason` | `Reason` | yes | The error reason for clients to inspect. |
| `text_written` | `TextWritten` | no | With `partial_input` for text: how much of the text reached the agent's terminal. |
| `enter_written` | `boolean` | no | With `partial_input` for text: whether its Enter reached the agent's terminal. |
| `keys_sent` | `number` | no | With `partial_input` for keys: how many keys reached the agent's terminal whole. |
| `kept` | `Kept` | no | With `worktree.create`, or `agent.start` with a `worktree`, that failed after Git made part or all of the worktree: what it made, which stays. |
| `entry` | `string` | no | With a refused start or resume that an entry of the settings file caused - its program not found, the entry turned off or wrong, or a model or effort the entry gives that its CLI cannot take - the entry's name, such as `claude`. A client offers to open the settings file. |
| `windows` | `WindowDeliveryFailure[]` | no | With `unavailable` when no member window took a message to `#human`: each window and why it could not take the message. |
| `window_delivery` | `WindowDelivery` | no | The receipt for a send whose remote window outcomes could not be confirmed. |
| `message_ref` | `MessageRef` | no | The original kept message, where its delivery outcome is unknown. |
| `machine_id_conflict` | `MachineIdConflict` | no |  |
| `ssh_interaction` | `SshInteraction` | no |  |
| `unavailable` | `Unavailable` | no |  |
| `candidates` | `string[]` | no | Complete references that matched a name or machine ID prefix. |
| `protocol` | `ProtocolMismatch` | no |  |

### ExecutionOutcome

`'not_executed' \| 'outcome_unknown'`

### ForwardCall

A call on a machine session with facts the originating daemon takes from the local caller.

| Field | Type | Required | Description |
|---|---|---|---|
| `call` | `CallParams` | yes |  |
| `by_model` | `boolean` | yes | The originating connection acts for a model through MCP. Selects the model's start rules. |
| `from_name` | `string` | no | The verified sender's name for `agent.send`, when known. |
| `from_window` | `string` | no | The name of the sender's sole member window for `agent.send`, when known. |
| `window_colors` | `TerminalColors` | no | Colors from the window in `Caller::Ide` for `agent.resize`. |

### ForwardParams

Parameters of `forward`. The outer JSON-RPC ID identifies this hop.

| Field | Type | Required | Description |
|---|---|---|---|
| `route` | `string[]` | yes | Remaining machine IDs. First is this hop's receiver and last is the final receiver. |
| `caller` | `Caller` | yes |  |
| `time_left_ms` | `number` | no | Milliseconds left where the call has a deadline. |
| `request_id` | `string` | no | The existing deduplication ID, carried only for `agent.start` and `agent.send`. |
| `method` | `string` | yes | The original JSON-RPC method, decoded at the final receiver. |
| `params` | `unknown` | yes | The method payload. A forwarded `call` carries `ForwardCall`. |

### HandOver

The messages `hook.prompt` and `hook.turn-end` take for a guest's model, at its next turn.

| Field | Type | Required | Description |
|---|---|---|---|
| `messages` | `Message[]` | yes | Every message that was not yet delivered to the guest, oldest first, now delivered through `read`. |

### HelloParams

Parameters for `hello`.

| Field | Type | Required | Description |
|---|---|---|---|
| `protocol` | `[number, number]` | yes | The oldest and newest daemon protocol versions the client supports. |
| `build` | `string` | yes | The client's build. |
| `kind` | `ClientKind` | yes | The client kind. Unsupported kinds are rejected at hello. |
| `agent` | `string` | no | The agent this client acts for, by ID: the agent of `facade-mcp`, or the agent in whose terminal a `facade` command runs. Messages the client sends come from that agent, and the `messages` topic reads its inbox. Required for `mcp`, whose agent must be listed: a hello naming one that is not is refused with `not_found`. |
| `sessions` | `string[]` | no | The sessions the client's CLI names in its environment, such as `CLAUDE_CODE_SESSION_ID`. The client acts for the agent that has one of them, the newest where several do, ahead of `agent`: a command a guest's model runs acts for the guest. |
| `window` | `WindowDescription` | no | The editor window this client is part of. Required for `ide`, and refused for any other kind. Every connection of a window describes it; the window is there while one of them is open. |
| `numbers_given` | `NumbersGiven` | no | For an `ide` client: the highest agent and message numbers its editor gave before, such as 41 for `#a41`. The daemon's next numbers are above both these and its own, from then on. Refused for any other kind with `invalid_argument`. |
| `machine` | `MachineHello` | no | Required on a machine session, absent on a local client connection. |

### HelloResult

The result of `hello`: daemon details and supported topics and operations.

| Field | Type | Required | Description |
|---|---|---|---|
| `protocol` | `number` | yes | The highest protocol version shared by the client and daemon. |
| `build` | `string` | yes | The daemon's build. |
| `machine_id` | `string` | yes | The daemon's Facade machine ID. |
| `machine` | `MachineHello` | no | The answering daemon's introduction on a machine session. |
| `window` | `WindowRef` | no | For an `ide` client, the logical window bound to this connection. |
| `pid` | `number` | yes | The daemon's process ID. |
| `agent` | `string` | no | The agent this client acts for, as `agent` and `sessions` decided. Omitted where it acts for none. |
| `agents` | `number` | yes | The number of agent records when `hello` runs. Watch `agents` to receive changes. |
| `keeper` | `KeeperInfo` | no | The keeper holding the agents' terminals. Omitted while no keeper runs; the daemon starts one for the first agent. |
| `topics` | `string[]` | yes | Topic names accepted by `watch`. |
| `ops` | `string[]` | yes | Operation names accepted by `call`. |

### HiddenRows

Rows of a draft scrolled out of the CLI's input, as the CLI marks them.

| Field | Type | Required | Description |
|---|---|---|---|
| `above` | `number` | yes | Rows hidden above the visible input. |
| `below` | `number` | yes | Rows hidden below the visible input. |

### HookSession

The session a CLI's hook reports on.

| Field | Type | Required | Description |
|---|---|---|---|
| `cli` | `string` | yes | The CLI, by its rule's name, such as `claude`. |
| `session` | `string` | yes | The session ID the CLI gives its hooks. |
| `cwd` | `string` | no | The CLI's working folder, where the hook knows it. |
| `pid` | `number` | no | For a CLI that has no hook for a session's end, Antigravity, the process of the CLI that ran the hook: its end is the session's end. Facade watches it for that alone, and a guest's record names no pid. |
| `parent` | `string` | no | The session this one is part of, as a subagent's session is the session that started it. A part acts for the guest of the session it is part of, and its own turns leave that guest's state alone. Omitted for a session of its own. |
| `env` | `{ readonly [key: string]: string }` | no | The environment the CLI gives the hook, or the server of this session alone, which joins it as it starts: an agent the guest starts runs with it. A server many sessions share gives none. Kept with the guest, in memory alone; a later one replaces it. |
| `status_file` | `string` | no | Where the CLI itself reports how the session stands, as Claude Code's prompt hook names it: Claude Code's file of its process, `sessions/<pid>.json` in its configuration folder. While the guest reads `working`, the daemon reads it once a second: `idle` there, written since the turn began, ends the turn as `hook.idle` does, for a turn the person cut short, which runs no hook. Omitted by the other hooks and CLIs. |

### HowEnded

How an agent's process ended.

`'normal' \| 'stopped' \| 'crashed'`

### InputInfo

An agent's message input as its screen shows it now.

| Field | Type | Required | Description |
|---|---|---|---|
| `state` | `InputState` | yes |  |
| `evidence` | `string` | yes | What on the screen the state rests on, such as `the input frame at row 22 is empty`. Never the draft's text. |
| `mechanism` | `InputMechanism` | no | The layout the agent's CLI rule reads. Omitted without a rule. |
| `hidden` | `HiddenRows` | no | Draft rows scrolled out of the input. Omitted unless the CLI marks such rows. |

### InputMechanism

The layout a CLI's rule reads its input from.

`'frame' \| 'prompt' \| 'editor' \| 'box' \| 'prompt_row'`

### InputState

How an agent's message input reads on its screen. A reading never means input may be typed.

`'usable' \| 'draft' \| 'interaction' \| 'unknown'`

### InspectResult

The result of `agent.inspect`.

| Field | Type | Required | Description |
|---|---|---|---|
| `agent` | `AgentInfo` | yes |  |
| `rule` | `string` | no | The CLI rule the agent was started by: its CLI's name, such as `claude`. Omitted for an agent started by a program path or a name without a rule. |
| `input` | `InputInfo` | yes |  |
| `session_tracking` | `boolean` | yes | Whether the running CLI reports its session to Facade. False for an ended agent. |

### IntegrationArgs

Arguments for `integration.add` and `integration.remove`.

| Field | Type | Required | Description |
|---|---|---|---|
| `cli` | `string` | yes | The CLI, by its rule's name: `claude`, `codex`, `opencode` or `pi`. |
| `env` | `{ readonly [key: string]: string }` | yes | The caller's environment, as `agent.start` takes it. It says where the CLI keeps its user configuration (`HOME`, `XDG_CONFIG_HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`), and `PATH` finds `claude`. |

### IntegrationInfo

A CLI's integration: Facade's entries in the CLI's user configuration, through which its sessions join as guests.

| Field | Type | Required | Description |
|---|---|---|---|
| `cli` | `string` | yes |  |
| `added_at` | `string` | no | When `integration.add` first wrote its files. Omitted where it did not, or the record is gone. |
| `parts` | `IntegrationPart[]` | yes |  |
| `notes` | `string[]` | no | What the person should know, such as that Codex asks to review new hooks once. |

### IntegrationPart

A file of a CLI's integration, and whether it holds Facade's entries.

| Field | Type | Required | Description |
|---|---|---|---|
| `file` | `string` | yes | The file, or `claude mcp` for Claude Code's user server, which only its own command changes. |
| `state` | `PartState` | yes |  |

### IntegrationsArgs

Arguments for `integration.list`.

| Field | Type | Required | Description |
|---|---|---|---|
| `env` | `{ readonly [key: string]: string }` | yes | The caller's environment, as for `integration.add`. |

### IntegrationsList

What `integration.list` answers: each CLI Facade can integrate.

| Field | Type | Required | Description |
|---|---|---|---|
| `integrations` | `IntegrationInfo[]` | yes |  |

### KeeperInfo

The keeper holding the agents' terminals.

| Field | Type | Required | Description |
|---|---|---|---|
| `pid` | `number` | yes | The keeper process ID. |
| `build` | `string` | yes | The keeper build identifier. |

### Kept

What a worktree creation that failed partway made, which stays: its branch, its folder, or both.

| Field | Type | Required | Description |
|---|---|---|---|
| `branch` | `string` | no | The branch it made. |
| `path` | `string` | no | The folder it made, an absolute path. |

### LocationInfo

A place an agent can work: a window's folder, or a checkout of a Git repository one of its folders is in.

| Field | Type | Required | Description |
|---|---|---|---|
| `location_id` | `string` | yes | `loc-` followed by 16 hexadecimal digits of the SHA-256 of the location's path: the same in every window that lists it. |
| `label` | `string` | yes | The checkout's branch, or else the folder's name. |
| `path` | `string` | yes | The absolute path, with symbolic links resolved. |
| `kind` | `LocationKind` | yes | What the location is: a folder, a repository's main checkout, or a linked worktree. |

### LocationKind

What a location is.

`'folder' \| 'main' \| 'worktree'`

### LocationListResult

| Field | Type | Required | Description |
|---|---|---|---|
| `locations` | `WindowLocation[]` | yes |  |

### MachineAddArgs

Save the identity verified in the foreground session.

| Field | Type | Required | Description |
|---|---|---|---|
| `ssh_destination` | `string` | yes |  |
| `remote_home` | `string` | no |  |
| `machine_id` | `string` | yes |  |

### MachineAddResult

The saved connection is ready.

| Field | Type | Required | Description |
|---|---|---|---|
| `machine` | `MachineHello` | yes |  |
| `first_connection` | `boolean` | yes |  |

### MachineConnectArgs

A foreground machine session to authorize.

| Field | Type | Required | Description |
|---|---|---|---|
| `transport` | `MachineTransport` | yes |  |
| `kind` | `ConnectionKind` | yes | A bridge is always temporary. |

### MachineConnectResult

Returned before switching the local client stream into a machine session.

| Field | Type | Required | Description |
|---|---|---|---|
| `ssh_destination` | `string` | no |  |
| `remote_home` | `string` | no |  |
| `expected_machine_id` | `string` | no |  |

### MachineConnection

One connection as seen from its machine table row.

| Field | Type | Required | Description |
|---|---|---|---|
| `machine_id` | `string` | yes | The other end of the connection. |
| `initiator_machine_id` | `string` | yes |  |
| `kind` | `ConnectionKind` | yes |  |
| `ssh_destination` | `string` | no |  |
| `remote_home` | `string` | no |  |
| `state` | `ConnectionState` | yes |  |
| `ssh_interaction` | `SshInteraction` | no |  |

### MachineHello

The introduction on each side of a machine hello.

| Field | Type | Required | Description |
|---|---|---|---|
| `machine_id` | `string` | yes |  |
| `boot_id` | `string` | yes | Changes each time the daemon starts. Distinguishes concurrent uses of a machine ID. |
| `name` | `string` | yes |  |
| `build` | `string` | yes |  |
| `protocol` | `[number, number]` | yes |  |
| `ssh_cleans_processes` | `boolean` | no | On Linux, whether the system clears this user's processes at the end of the SSH session. |

### MachineIdConflict

| Field | Type | Required | Description |
|---|---|---|---|
| `machine_id` | `string` | yes |  |
| `paths` | `[string, string]` | yes | Both conflicting connection paths, including their sources. |

### MachineIdentity

A machine's persistent identity and current display name.

| Field | Type | Required | Description |
|---|---|---|---|
| `machine_id` | `string` | yes |  |
| `name` | `string` | yes |  |

### MachineInfo

A row visible from the machine that supplies the table.

| Field | Type | Required | Description |
|---|---|---|---|
| `machine_id` | `string` | yes |  |
| `boot_id` | `string` | no | The running daemon, where observed. Every advertised route carries it. |
| `name` | `string` | yes |  |
| `build` | `string` | no |  |
| `route` | `string[]` | no | The remaining hops, ending at this machine. Empty for the table's own machine. Absent for a saved destination without a route. |
| `connections` | `MachineConnection[]` | yes |  |

### MachineListResult

| Field | Type | Required | Description |
|---|---|---|---|
| `machines` | `MachineInfo[]` | yes |  |

### MachineMessage

A frame from either direction of a machine session. A request without an ID is a notification.

`Request \| Response`

### MachineQueryArgs

Selects a machine for a query. An omitted selector uses the operation's default.

| Field | Type | Required | Description |
|---|---|---|---|
| `machine` | `string` | no |  |

### MachineQueryResult

The outcome of asking one machine for its reachable agents.

| Field | Type | Required | Description |
|---|---|---|---|
| `machine_id` | `string` | yes |  |
| `short_id` | `string` | yes |  |
| `name` | `string` | yes |  |
| `build` | `string` | no |  |
| `status` | `MachineQueryStatus` | yes |  |
| `answered_at` | `string` | no | The UTC time of the answer, to milliseconds, when a machine answered. |

### MachineQueryStatus

`'answered' \| 'unavailable' \| 'timed_out' \| 'error'`

### MachineRemoveArgs

| Field | Type | Required | Description |
|---|---|---|---|
| `machine` | `string` | yes | An input machine selector. |

### MachineRemoveResult

| Field | Type | Required | Description |
|---|---|---|---|
| `machine_id` | `string` | yes |  |
| `ssh_destination` | `string` | yes |  |
| `remote_home` | `string` | no |  |
| `reachable` | `boolean` | yes |  |

### MachineRenameArgs

| Field | Type | Required | Description |
|---|---|---|---|
| `machine` | `string` | yes | An input machine selector. |
| `name` | `string` | yes |  |

### MachineRenameResult

| Field | Type | Required | Description |
|---|---|---|---|
| `machine_id` | `string` | yes |  |
| `name` | `string` | yes |  |

### MachineTransport

The transport the local client will bridge to this machine session.

`{ readonly kind: 'ssh'; readonly ssh_destination: string; readonly remote_home?: string } \| { readonly kind: 'bridge' }`

### MachinesChange

A change to the machine table visible to a client.

`{ readonly kind: 'updated'; readonly machine: MachineInfo } \| { readonly kind: 'removed'; readonly machine_id: string }`

### Message

A message: one sender, one recipient, the complete text, and what became of it.

| Field | Type | Required | Description |
|---|---|---|---|
| `message_id` | `string` | yes | `m` followed by a number, unique within the Facade home. |
| `message_ref` | `MessageRef` | no | The full reference for a window notification to the person or a remote send receipt. |
| `from` | `string` | yes | The sender: an agent ID, `human` for the person, or `facade` for a result: Facade's own words on what became of a start, not an agent's. |
| `from_machine_id` | `string` | no | The sender's machine, when different from the one that stored the message. |
| `from_name` | `string` | no | The sender's name when it sent the message. Omitted for the person. |
| `to` | `string` | yes | The recipient's agent ID, or `human` for the person. |
| `text` | `string` | yes | The complete text as sent. |
| `reply_to` | `string` | no | The message this one answers. |
| `reply_to_machine_id` | `string` | no | The replied-to message's machine, when different from the one that stored this message. |
| `from_window` | `string` | no | The sender's window name if it had a single member window and the recipient did not belong to that window. |
| `call_id` | `string` | no | A result's call: the ID of the MCP `tools/call` it answers later. On a start's prompt, the call its result answers. |
| `result` | `StartOutcome` | no | A result's facts, which its text words. Omitted for any other message. |
| `at` | `string` | yes | When Facade received it, in UTC ISO 8601 format with milliseconds. |
| `delivery` | `Delivery` | yes |  |

### MessageRef

A message's identity on the machine that assigned its number.

| Field | Type | Required | Description |
|---|---|---|---|
| `machine_id` | `string` | yes |  |
| `message_id` | `string` | yes |  |

### MessagesChange

A change to the `messages` topic. Skip unknown change kinds.

`{ readonly kind: 'updated'; readonly message: Message } \| { readonly kind: 'removed'; readonly message_id: string }`

### MessagesSnapshot

The inbox at the start of a `messages` watch.

| Field | Type | Required | Description |
|---|---|---|---|
| `messages` | `Message[]` | yes | The selected messages, oldest first. |
| `not_found` | `string[]` | no | IDs in `ids` that are not in the inbox. |
| `next_cursor` | `string` | no | Pass as `cursor` to read the next page. Omitted on the last page. |

### MessagesWatchArgs

Arguments for the `messages` topic: which messages of the inbox to read. Without `ids` or `all`, the messages not yet delivered.

| Field | Type | Required | Description |
|---|---|---|---|
| `ids` | `string[]` | no | These messages, by ID (`m4` or `#m4`): 1 to 100. Excludes `all` and `cursor`. |
| `all` | `boolean` | no | Every message in the inbox, delivered or not: messages are kept 30 days. |
| `cursor` | `string` | no | Continues the previous page of the same selection from its `next_cursor`. |
| `limit` | `number` | no | The most messages in a page, 1 to 200. Defaults to 100. |
| `last` | `number` | no | The newest messages of the selection, this many, 1 to 200, in one page. Excludes `ids`, `cursor` and `limit`. |

### NoArgs

Empty arguments: `{}`. May be omitted for topics that take no arguments.

`Record<string, never>`

### Notification

A message without an ID or response, such as `changed`.

| Field | Type | Required | Description |
|---|---|---|---|
| `jsonrpc` | `string` | no | Always `2.0`. |
| `method` | `string` | yes | The notification method, such as `changed`. |
| `params` | `unknown` | no | Parameters for the notification method. |

### NumbersGiven

The highest numbers an editor gave before.

| Field | Type | Required | Description |
|---|---|---|---|
| `agent` | `number` | yes | The highest agent number, such as 41 for `#a41`; 0 for none. At most 2^53 - 1. |
| `message` | `number` | yes | The highest message number, such as 230 for `#m230`; 0 for none. At most 2^53 - 1. |

### Overrides

Whether a start can choose a CLI's model and its effort.

| Field | Type | Required | Description |
|---|---|---|---|
| `model` | `boolean` | yes |  |
| `effort` | `boolean` | yes |  |

### PartState

Whether a file of a CLI's integration holds Facade's entries.

`'as_written' \| 'changed' \| 'missing'`

### ProcessExit

A recorded CLI exit. Without a code or signal, its status is unavailable; do not treat it as exit code zero.

| Field | Type | Required | Description |
|---|---|---|---|
| `code` | `number` | no | The exit code, if the CLI exited normally and its status is known. On Windows every exit has one: the process's 32-bit exit code carried as an `i32`, so that 0xC000013A is -1073741510. |
| `signal` | `string` | no | The terminating signal name, such as `SIGKILL`. Signal numbers vary by system. Never on Windows. |
| `reason` | `EndReason` | no | Why no code or signal is available, if known. If all three fields are absent, the exit status is unavailable. |
| `at` | `string` | yes | The exit time in UTC ISO 8601 format with milliseconds. For an exit without a code or signal, the time Facade noticed it. |

### ProcessState

The reported process state of an agent.

`'running' \| 'ended'`

### PromptOutcome

A start prompt's message ID and what became of it.

| Field | Type | Required | Description |
|---|---|---|---|
| `message_id` | `string` | yes |  |
| `delivery` | `Delivery` | yes |  |

### ProtocolMismatch

| Field | Type | Required | Description |
|---|---|---|---|
| `local_build` | `string` | yes |  |
| `local_protocol` | `[number, number]` | yes |  |
| `remote_build` | `string` | yes |  |
| `remote_protocol` | `[number, number]` | yes |  |

### Reason

Error reasons shared by both protocols.

`'invalid_argument' \| 'not_found' \| 'ambiguous_reference' \| 'ended' \| 'partial_input' \| 'unavailable' \| 'protocol_incompatible' \| 'machine_id_conflict' \| 'ssh_interaction_required' \| 'capacity_exceeded' \| 'internal' \| 'refused' \| 'configuration_invalid' \| 'cancelled' \| 'worktree_failed' \| 'upgrading' \| 'unsupported'`

### RenameArgs

Arguments for `agent.rename`.

| Field | Type | Required | Description |
|---|---|---|---|
| `agent` | `string` | yes | An agent ID (`a3`, `#a3`, or `3`), a unique name with or without `@`, or a name followed by its ID, such as `@Pixel #a3`. |
| `name` | `string` | yes | The new name, trimmed. An empty or blank name gets a default name chosen from the suggested names: unused while one is available, otherwise reused. Names may repeat. |

### Request

A method call. Calls with an ID receive a response; calls without an ID are notifications.

| Field | Type | Required | Description |
|---|---|---|---|
| `jsonrpc` | `string` | no | Always `2.0`. |
| `id` | `number` | no | A non-negative integer request ID, at most u64::MAX. Omit it for a notification. The response repeats this ID. |
| `method` | `string` | yes | The method name, such as `hello` or `call`. |
| `params` | `unknown` | no | Parameters for the named method. |

### ResizeArgs

Arguments for `agent.resize`.

| Field | Type | Required | Description |
|---|---|---|---|
| `agent` | `string` | yes | An agent ID (`a3`, `#a3`, or `3`), a unique name with or without `@`, or a name followed by its ID, such as `@Pixel #a3`. |
| `cols` | `number` | yes | Terminal width in columns, at least 2. |
| `rows` | `number` | yes | Terminal height in rows, at least 1. |

### Response

A response containing either a result or an error.

| Field | Type | Required | Description |
|---|---|---|---|
| `jsonrpc` | `string` | no | Always `2.0`. |
| `id` | `number \| null` | yes | The request ID, or `null` for a malformed request. |
| `result` | `unknown` | no | The success result, with the type defined by the method or operation. |
| `error` | `ErrorBody` | no | The error on failure. Omitted when the response contains a result. |

### ResumeArgs

Arguments for `agent.resume`, supplied by the client.

| Field | Type | Required | Description |
|---|---|---|---|
| `agent` | `string` | yes | An agent ID (`a3`, `#a3`, or `3`), a unique name with or without `@`, or a name followed by its ID, such as `@Pixel #a3`. |
| `env` | `{ readonly [key: string]: string }` | no | The environment supplied by the client, filtered as for `agent.start`. The agent's earlier environment is not reused. |
| `cols` | `number` | yes | The terminal width in columns, at least 2. |
| `rows` | `number` | yes | The terminal height in rows, at least 1. |

### Said

What last went into an agent's message input with Enter: what the person submitted in its terminal and its CLI took, text typed with `agent.type` and `enter`, or a message delivered through the terminal.

| Field | Type | Required | Description |
|---|---|---|---|
| `text` | `string` | yes | The text on one line, at most 1,024 characters. |
| `from` | `string` | yes | Who said it: an agent ID, or `human` for the person. |
| `from_name` | `string` | no | The agent's name when it said it. Omitted for the person. |
| `at` | `string` | yes | When, in UTC ISO 8601 format with milliseconds. |

### ScreenArgs

Arguments for `agent.screen`.

| Field | Type | Required | Description |
|---|---|---|---|
| `agent` | `string` | yes | An agent ID (`a3`, `#a3`, or `3`), a unique name with or without `@`, or a name followed by its ID, such as `@Pixel #a3`. |
| `lines` | `number` | no | The number of lines to return, from 1 to 2000. Defaults to 50. |

### ScreenBuffer

The screen buffer a CLI shows.

`'normal' \| 'alternate'`

### ScreenChange

A change to the `screen` topic. `exit` follows all output the CLI wrote before ending; processes still holding its terminal may write afterward. On macOS, the terminal is taken from those processes when the CLI ends. `removed` is the watch's last change. Skip unknown change kinds.  `snapshot.redraw`, `output.data`, and `redraw.data` contain standard base64 with padding. Decode them to bytes and feed those bytes to the viewer's terminal parser. Set the viewer to `snapshot.cols` by `snapshot.rows` before the initial redraw. Each redraw change carries its own `cols` and `rows`; use that size before applying its `data`. Process changes for each watch in arrival order. Apply `output` as continuation bytes; `redraw` supplies a replacement terminal sequence. Preserve parser state between messages. Do not treat the decoded bytes as plain text; use `agent.screen` for plain text.

`{ readonly kind: 'output'; readonly data: string } \| { readonly kind: 'redraw'; readonly data: string; readonly cols: number; readonly rows: number } \| { readonly kind: 'exit'; readonly exit: ProcessExit } \| { readonly kind: 'removed' }`

### ScreenSnapshot

A full screen snapshot at the start of a watch.

| Field | Type | Required | Description |
|---|---|---|---|
| `agent_id` | `string` | yes | The ID of the agent being viewed. |
| `machine_id` | `string` | yes | The agent's running machine, for reconnecting to its exact reference. |
| `cols` | `number` | yes | Terminal width required to apply the redraw. |
| `rows` | `number` | yes | Terminal height required to apply the redraw. |
| `redraw` | `string` | yes | Base64-encoded terminal bytes that redraw the screen at this size. Restores cursor state, charsets, and modes. On the main screen, up to 1,000 rows of agent scrollback come first unless `include_scrollback` is false. `keep_scrollback` controls whether the viewer's existing scrollback is cleared before the redraw. |
| `exit` | `ProcessExit` | no | The recorded exit, if the agent has ended. |
| `process` | `ProcessState` | no | The agent's process state captured with this snapshot. |

### ScreenText

The result of `agent.screen`: the last logical lines of an agent's screen and scrollback, as they show.

| Field | Type | Required | Description |
|---|---|---|---|
| `agent_id` | `string` | yes |  |
| `process` | `ProcessState` | yes | Whether the agent's CLI is running. An ended agent's screen is the one it left. |
| `observed_at` | `string` | yes | When the screen was read, in UTC ISO 8601 format with milliseconds; for an ended agent, when it ended, as its screen is the one it left. |
| `buffer` | `ScreenBuffer` | yes |  |
| `text` | `string` | yes | The lines, joined by line feeds, each wrapped row joined into its line. Inverse text is between `[[` and `]]` and dim text between `{{` and `}}`, inverse outside dim. Each backslash, bracket, and brace of the screen's own text is escaped with a backslash, so removing the marks and the escapes gives the text exactly; see [`plain`]. |
| `line_count` | `number` | yes | How many lines `text` holds. |
| `older_lines` | `boolean` | yes | Whether output lies above the lines read. |
| `trimmed` | `boolean` | yes | Whether the scrollback let go of its oldest lines. |

### ScreenWatchArgs

Arguments for the `screen` topic.

| Field | Type | Required | Description |
|---|---|---|---|
| `agent` | `string` | yes | An agent ID (`a3`, `#a3`, or `3`), a unique name with or without `@`, or a name followed by its ID, such as `@Pixel #a3`. |
| `keep_scrollback` | `boolean` | no | Keep the viewer's existing scrollback. Defaults to false: every snapshot and redraw clears it first. A main-screen snapshot then replays up to 1,000 rows of the agent's scrollback unless `include_scrollback` is false. Later redraws include only the visible screen. `facade attach` sets this option to true. |
| `include_scrollback` | `boolean` | no | Include up to 1,000 main-screen scrollback rows before the visible screen in the snapshot. Defaults to true. `facade attach` sets it to false on reconnect so the viewer does not receive those rows twice. |

### SendArgs

Arguments for `agent.send`.

| Field | Type | Required | Description |
|---|---|---|---|
| `to` | `string` | yes | The recipient: an agent ID (`a3`, `#a3`, or `3`), a unique name of a running agent with or without `@`, a name followed by its ID such as `@Pixel #a3`, or `#human` for the person. |
| `text` | `string` | yes | The complete message: at most 8,000 characters and 540 lines of text, tabs, and line breaks, not blank. |
| `reply_to` | `string` | no | The message this one answers, by ID or qualified reference such as `#m4@gpu`. |
| `reply_to_machine_id` | `string` | no | The storage machine of the reply's reference, after the originating daemon verified it. |
| `request_id` | `string` | no | The caller's own ID of this send, 1 to 200 characters. The same ID again from the same sender, including its machine, and target within an hour answers that message as it stands, joining its delivery while it lasts, and sends nothing again. A send refused or withdrawn keeps none. |
| `time_left_ms` | `number` | no | What is left of the send's 30 seconds as it leaves the client, in milliseconds: its delivery's deadline counts that from the daemon's receipt, at most 29,500. Omitted, 29,500. |

### SendResult

The response to `agent.send`: the message as it stands, whether the call repeated an earlier one, and whether its failure withdrew it.

| Field | Type | Required | Description |
|---|---|---|---|
| `message_id` | `string` | yes | `m` followed by a number, unique within the Facade home. |
| `message_ref` | `MessageRef` | no | The full reference for a window notification to the person or a remote send receipt. |
| `from` | `string` | yes | The sender: an agent ID, `human` for the person, or `facade` for a result: Facade's own words on what became of a start, not an agent's. |
| `from_machine_id` | `string` | no | The sender's machine, when different from the one that stored the message. |
| `from_name` | `string` | no | The sender's name when it sent the message. Omitted for the person. |
| `to` | `string` | yes | The recipient's agent ID, or `human` for the person. |
| `text` | `string` | yes | The complete text as sent. |
| `reply_to` | `string` | no | The message this one answers. |
| `reply_to_machine_id` | `string` | no | The replied-to message's machine, when different from the one that stored this message. |
| `from_window` | `string` | no | The sender's window name if it had a single member window and the recipient did not belong to that window. |
| `call_id` | `string` | no | A result's call: the ID of the MCP `tools/call` it answers later. On a start's prompt, the call its result answers. |
| `result` | `StartOutcome` | no | A result's facts, which its text words. Omitted for any other message. |
| `at` | `string` | yes | When Facade received it, in UTC ISO 8601 format with milliseconds. |
| `delivery` | `Delivery` | yes |  |
| `repeated` | `boolean` | no | The call repeated an earlier one by its request ID: the message is that call's. Omitted otherwise. |
| `withdrawn` | `boolean` | no | Its delivery failed with nothing of it typed, and it was taken out of its recipient's inbox, so it can be sent again. Omitted otherwise. |
| `windows` | `WindowDelivery` | no | Which windows' subscriptions took the message for `#human`. Omitted for messages to agents and for a `pending` result whose daemon ended before saving the window outcomes. |

### ServerMessage

A response or notification received from a server.

`Notification \| Response`

### SessionStartResult

What `hook.session-start` answers.

| Field | Type | Required | Description |
|---|---|---|---|
| `agent_id` | `string` | no | The guest the session joined as. Omitted for a session of a run Facade started, which the hook leaves alone. |
| `instructions` | `string` | no | What the guest's model is told: its ID, and how its messages reach it; then Facade's skill. |

### SshInteraction

| Field | Type | Required | Description |
|---|---|---|---|
| `reason` | `string` | yes |  |
| `command` | `string[]` | yes | The complete command and arguments with which to repair the saved connection. |

### StartArgs

Arguments for `agent.start`, supplied by the client.

| Field | Type | Required | Description |
|---|---|---|---|
| `command` | `string[]` | yes | The CLI followed by more of its arguments. The exact name of a CLI of Facade's settings file, `facade.json` in the Facade home - a built-in's, such as `claude`, or one its `clis` adds - starts that CLI as its entry says, its entry's `args` before these (CONFIGURATION-2, 3). Any other word, including a path, runs as that program, as given. A start from an `mcp` client names one CLI of the file and nothing more; another name is refused with `not_found`, naming the CLIs there. A file that cannot be read as a whole refuses every start with `configuration_invalid`, and so does a CLI whose entry is wrong, saying each problem; a CLI its entry turns off is refused with `unavailable`, and one whose program cannot run where it starts with `not_found`, saying so by its setting. |
| `name` | `string` | no | The display name, trimmed. A missing, empty, or blank name gets a name from the settings file's `names`, else from the built-in names: one unused in any of the initial member windows, ignoring case and surrounding spaces. If every name is taken or the list is empty, uses the agent's ID, such as `#a7` (LIFECYCLE-2.1). Given names may repeat. |
| `cwd` | `string` | yes | The CLI's absolute working folder. If `location_source_window` is set, `cwd` must be that window's location or a folder inside one. |
| `machine` | `string` | no | The machine selector at the entrance to a start. Omitted to use the caller's machine. |
| `cwd_is_default` | `boolean` | no | The caller supplied its default cwd. A remote start uses the running machine's login home. |
| `window` | `WindowRef` | no | The one initial member window, when supplied. Omitted to use the caller's default. |
| `initial_windows` | `WindowRef[]` | no | The initial members the originating daemon verified for a forwarded start. |
| `location_source_window` | `WindowRef` | no | The connected local window that supplies the running location for `cwd`, if selected. |
| `env` | `{ readonly [key: string]: string }` | no | The environment supplied by the client. If omitted, the CLI gets only `TERM`, `COLORTERM`, and `PWD`. It does not inherit the daemon's environment. Facade removes terminal, editor, and CLI session variables, but keeps `TERM_PROGRAM` and `TERM_PROGRAM_VERSION`, which tell the CLI which terminal app displays it; then it sets `TERM`, `COLORTERM`, and `PWD`. Supply the user's remaining environment explicitly. `facade start` does this, omitting non-UTF-8 variables and naming them on stderr. A start from an `mcp` client takes its agent's environment instead, as that agent's CLI started with it, less what that CLI's rule added: a CLI chooses what it gives its MCP server, while a `facade` command sends its shell's. Where that environment cannot be read, as when the CLI is not running or the system hides it, the start fails with `unavailable` and starts nothing. A start that an agent asks for, from its tools or its terminal, inherits that environment as it is, including what the agent's own entry `env` set or removed, as a shell started from another inherits its variables; the started CLI's own entry applies on top (CONFIGURATION-2.1, 3.2). |
| `cols` | `number` | yes | The initial terminal width in columns, at least 2. |
| `rows` | `number` | yes | The initial terminal height in rows, at least 1. |
| `prompt` | `string` | no | The agent's first message, its text as `agent.send` takes it: from the agent the client acts for, or else from the person. It is kept as the start answers, and delivered once the CLI's tools connected or will not, before any other message. A prompt from an agent owes that agent a result once it is settled. Only a CLI of the settings file takes one: a program started by its path or name is refused one, and the program of a `custom` entry, whose input Facade does not read, starts and fails it as `unsupported` (CONFIGURATION-2.3). |
| `call_id` | `string` | no | The ID of the MCP `tools/call` that asked for the start, which the prompt's result names. |
| `result_message_id` | `string` | no | The creator's reserved result message number for a forwarded start with a prompt. |
| `result_message_machine_id` | `string` | no | The machine that reserved the result message number. |
| `request_id` | `string` | no | The caller's own ID of this start, 1 to 200 characters. The same ID again from the same creator, including its machine, and target within an hour answers that agent as it stands, and starts nothing. A start that failed keeps none, and the ID goes with its agent's record. |
| `worktree` | `Worktree` | no | A worktree with a new branch to make and start in. With a location source window, uses the supplied location. Otherwise, uses the repository of `cwd`. The daemon checks the request ID before it makes the worktree, so a repeat makes none. |
| `model` | `string` | no | The model this start chooses, over its entry's `model` (CONFIGURATION-3.3, CLIS-1.4). A CLI that takes none from Facade, as OpenCode and a program do not, refuses it with `unsupported`. Omitted, a model the command's own words choose, else the entry's, else the CLI's own. |
| `effort` | `string` | no | The effort this start chooses, over its entry's `effort`, as `model` is. |
| `session` | `string` | no | A session of the CLI to continue, as `agent.resume` continues one: the CLI's rule gives the arguments that continue it, the same way for every CLI. The start is a new agent, with its own number. A CLI whose rule does not resume sessions, and a program that is not a CLI of the settings file, refuse it with `unsupported` before anything starts. Refused from an `mcp` client, as more words are. |

### StartOutcome

What became of a start with a prompt, as its result tells the agent that started it.

| Field | Type | Required | Description |
|---|---|---|---|
| `agent` | `AgentInfo` | yes | The started agent as it was when its prompt was settled. |
| `prompt` | `PromptOutcome` | yes |  |

### StartResult

The result of `agent.start`.

| Field | Type | Required | Description |
|---|---|---|---|
| `agent` | `AgentInfo` | yes | The agent's record. |
| `prompt` | `Message` | no | The prompt, kept and pending, where one was given. |
| `result_message_id` | `string` | no | The ID of the result the prompt owes the agent the client acts for, a message from `facade` once the prompt is settled. Omitted where no result is owed. |
| `result_message_machine_id` | `string` | no | The machine that assigned `result_message_id`, when a result is owed. |
| `repeated` | `boolean` | no | The call repeated an earlier one by its request ID: the agent is that call's, as it stands now. Omitted otherwise. |

### StateDetail

More about an agent's state.

| Field | Type | Required | Description |
|---|---|---|---|
| `kind` | `WaitKind` | no | What the CLI waits for, on `waiting_for_you`. |
| `text` | `string` | no | The CLI's own words where it gave any, on `waiting_for_you` and on an `error` the CLI reported. Untrusted text on one line. |
| `how` | `HowEnded` | no | How the process ended, on `ended`. Omitted when its exit status is unavailable and Facade did not stop it; `exit.reason` says what is known. |
| `reason` | `StateReason` | no | Why nothing shows what the CLI is doing, on `unknown`, or what Facade found wrong, on an `error` it found: a start that showed nothing, or tools the CLI cannot use. |

### StateReason

Why nothing shows what an agent's CLI is doing, or what Facade found wrong with it.

`'not_shown' \| 'asked' \| 'taken_back' \| 'unrecognized' \| 'not_ready' \| 'tools_unavailable'`

### StopResult

The result of `agent.stop`: the CLI's recorded exit, and whether it had ended before this stop.

| Field | Type | Required | Description |
|---|---|---|---|
| `code` | `number` | no | The exit code, if the CLI exited normally and its status is known. On Windows every exit has one: the process's 32-bit exit code carried as an `i32`, so that 0xC000013A is -1073741510. |
| `signal` | `string` | no | The terminating signal name, such as `SIGKILL`. Signal numbers vary by system. Never on Windows. |
| `reason` | `EndReason` | no | Why no code or signal is available, if known. If all three fields are absent, the exit status is unavailable. |
| `at` | `string` | yes | The exit time in UTC ISO 8601 format with milliseconds. For an exit without a code or signal, the time Facade noticed it. |
| `already_ended` | `boolean` | no | The CLI had ended before this stop, so the stop signaled nothing. Omitted when false. |

### TerminalColors

The colors an editor window's terminals draw with, each `#rrggbb`. An agent of the window replies to its CLI's OSC 10, 11 and 12 queries with them; a color left out gets no reply.

| Field | Type | Required | Description |
|---|---|---|---|
| `foreground` | `string` | no |  |
| `background` | `string` | no |  |
| `cursor` | `string` | no |  |

### TextWritten

How much of a message reached the recipient's terminal.

`'none' \| 'partial' \| 'full' \| 'unknown'`

### ToolsReason

Why an agent's CLI cannot use the Facade tools it was given.

`'not_given' \| 'not_connected' \| 'not_started' \| 'disconnected' \| 'ended'`

### ToolsState

Whether an agent's CLI can use Facade's tools: `facade-mcp`, the MCP server that a CLI started by its rule is given for its run.

`'not_injected' \| 'connecting' \| 'available' \| 'unavailable'`

### TypeArgs

Arguments for `agent.type`: exactly one of `raw`, `text`, or `keys`.

| Field | Type | Required | Description |
|---|---|---|---|
| `agent` | `string` | yes | An agent ID (`a3`, `#a3`, or `3`), a unique name with or without `@`, or a name followed by its ID, such as `@Pixel #a3`. |
| `raw` | `string` | no | Bytes from an attached terminal, encoded as standard base64 with padding. They are queued as they are, also between a typed text and its Enter. |
| `text` | `string` | no | Text to paste as one input: printable characters, tabs, and line breaks. When the CLI turned on bracketed paste, the text goes between the paste brackets with each line break as a carriage return; otherwise it goes as given. |
| `enter` | `boolean` | no | Press Enter after `text`, in a write of its own 0.1 seconds and the CLI's settle time for the text after the whole text reached the terminal. Empty text with `enter` presses Enter alone. Defaults to false. |
| `keys` | `string[]` | no | Keys to press in order: Enter (or Return), Escape (or Esc), Tab, Shift+Tab, Backspace, Delete, Up, Down, Left, Right (or ArrowUp, ArrowDown, ArrowLeft, ArrowRight), Home, End, PageUp, PageDown, Space, and Ctrl+A to Ctrl+Z, in any letter case, or any one character other than a control character, exactly as given. Each goes as a terminal sends it in the CLI's modes. After an Escape, the next key waits 50 ms. |

### Unavailable

| Field | Type | Required | Description |
|---|---|---|---|
| `execution` | `ExecutionOutcome` | yes |  |
| `machine` | `MachineIdentity` | no |  |
| `window` | `WindowRef` | no |  |
| `matches` | `string[]` | no | Complete addresses returned before a name lookup could finish. |
| `unanswered` | `MachineIdentity[]` | no |  |

### UnwatchParams

Parameters for `unwatch`.

| Field | Type | Required | Description |
|---|---|---|---|
| `watch` | `number` | yes | The watch number returned by `watch` on this connection. |

### UpgradeArgs

Arguments for `daemon.upgrade`: the program of a newer build that takes over, as the command that asks runs it.

| Field | Type | Required | Description |
|---|---|---|---|
| `program` | `string` | yes | The program, a `facade`, with its `facade-mcp` beside it. |
| `build` | `string` | yes | Its build, as its `hello` says it. |
| `daemon_protocol` | `[number, number]` | yes | The daemon protocol range accepted for this takeover, lowest and highest. |
| `keeper_protocol` | `[number, number]` | yes | The keeper protocol versions it speaks, lowest and highest. |

### UpgradeResult

The result of `daemon.upgrade`.

| Field | Type | Required | Description |
|---|---|---|---|
| `from` | `string` | yes | The build that hands over. |
| `agents` | `number` | yes | The agents that keep running through the takeover: those whose run runs. |

### WaitKind

What a CLI waits for.

`'permission' \| 'question' \| 'auth' \| 'unknown'`

### WatchEndedParams

A forwarded watch ended. A new watch starts with a fresh snapshot.

| Field | Type | Required | Description |
|---|---|---|---|
| `watch` | `number` | yes |  |
| `error` | `ErrorBody` | yes |  |

### WatchParams

Parameters for `watch`.

`{ readonly topic: 'agents'; readonly args: AgentsWatchArgs } \| { readonly topic: 'screen'; readonly args: ScreenWatchArgs } \| { readonly topic: 'messages'; readonly args: MessagesWatchArgs } \| { readonly topic: 'windows'; readonly args?: NoArgs } \| { readonly topic: 'machines'; readonly args?: NoArgs }`

### WatchResult

The result of `watch`, sent before any changes for that watch.

| Field | Type | Required | Description |
|---|---|---|---|
| `watch` | `number` | yes | The watch number used by `changed` notifications and `unwatch`. |
| `snapshot` | `AgentsSnapshot \| ScreenSnapshot \| MessagesSnapshot \| WindowInfo[] \| MachineInfo[]` | yes | The topic snapshot. Later changes arrive as ordered `changed` notifications. |

### WindowDelivery

The member windows' outcomes for one message to the person.

| Field | Type | Required | Description |
|---|---|---|---|
| `delivered` | `WindowRef[]` | yes | Windows whose `messages` subscriptions took the notification. |
| `not_delivered` | `WindowDeliveryFailure[]` | yes | Windows whose subscriptions did not take the notification. |
| `outcome_unknown` | `WindowRef[]` | yes | The notification was sent, and its receipt was lost before delivery could be confirmed. |

### WindowDeliveryFailure

Why a member window did not take a notification.

| Field | Type | Required | Description |
|---|---|---|---|
| `window` | `WindowRef` | yes |  |
| `reason` | `string` | yes | `window_disconnected` if the window has no connection, or `not_watching` if no current subscription took the notification, or `machine_unavailable` if it could not be sent to the window's machine. |

### WindowDescription

An editor window as it describes itself, in `hello` and again with `window.update` whenever any of it changes.

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | yes | The editor window instance's ID. It survives reloads and changes when the window reopens. The daemon returns the logical window in `HelloResult.window`. |
| `label` | `string` | yes | The window's name. |
| `environment` | `string` | yes | `local`, or the remote authority, such as `ssh-remote+devbox`, of a window whose user interface is on another computer. |
| `workspace` | `string` | no | A workspace the daemon can use to bind a reopened window to an earlier logical window. Omitted for a window with no workspace. |
| `folders` | `string[]` | no | The window's folders, as absolute paths, in the editor's order. Each is a location, and so is every checkout of a Git repository one of them is in. |
| `branch_prefix` | `string` | no | The window's Git branch prefix, which a new worktree's folder name leaves out. Omitted where none is set. |
| `colors` | `TerminalColors` | no | The colors the window supplies for its agents' terminal color queries. `window.update` sends them again when the editor's theme changes. An omitted color gets no reply. |
| `env` | `{ readonly [key: string]: string }` | no | The environment the window's agents start with, as the editor works it out for its first folder's terminals. Facade looks for each CLI's program on its `PATH` to say in `clis` which can start. Omitted, the window lists neither `clis` nor `settings_problem` to an `ide` client. |

### WindowInfo

A window: an editor window, or the terminal window, `terminal`, which holds the agents started from a terminal.

| Field | Type | Required | Description |
|---|---|---|---|
| `machine_id` | `string` | yes | The ID of the Facade machine that owns the window. |
| `window_id` | `string` | yes | The logical window's ID, or `terminal`. |
| `label` | `string` | yes | The window's name. |
| `environment` | `string` | yes | `local`, or the remote authority of an editor window whose user interface is on another computer. |
| `connected` | `boolean` | yes | Whether the logical window has a current connection. The terminal window always reports connected. |
| `folders` | `string[]` | yes | The window's folders, in its order. The terminal window has none. |
| `locations` | `LocationInfo[]` | yes | Where an agent of the window can start: each folder and Git checkout once, a repository's main checkout first. The terminal window's are the folders its running agents work in. |
| `problems` | `string[]` | no | What Facade could not read of the window's locations, which are then as last read. |
| `observed_at` | `string` | no | When Facade last read the window's locations, in UTC ISO 8601 format with milliseconds; for the terminal window, when it was listed. Omitted for a window whose locations this daemon has not read yet. |
| `clis` | `CliInfo[]` | no | The CLIs a start can run in this window, each found on a `PATH` or not: for a client that acts for an agent, that agent's; for an `ide` client, the one in the window's own `env`. None for a window with no folder, and none where Facade's settings file cannot be read as a whole. Omitted for a client that acts for no agent, and for an `ide` client where the window gave no `env`. |
| `settings_problem` | `string` | no | For a client that acts for an agent, or an `ide` client where the window gave `env`, what is wrong with Facade's settings file where it cannot be read as a whole, which then lists no CLI and stops every start, as one text. Omitted where the file reads. |

### WindowLocation

| Field | Type | Required | Description |
|---|---|---|---|
| `window` | `WindowRef` | yes |  |
| `location` | `LocationInfo` | yes |  |

### WindowRef

A logical window on a Facade machine.

| Field | Type | Required | Description |
|---|---|---|---|
| `machine_id` | `string` | yes | The Facade machine's ID, a lowercase UUID version 4. |
| `window_id` | `string` | yes | The logical window's ID, or `terminal` for that machine's terminal window. |

### WindowsChange

A change to the windows.

`{ readonly kind: 'updated'; readonly window: WindowInfo } \| { readonly kind: 'removed'; readonly machine_id: string; readonly window_id: string }`

### Worktree

A new worktree: its branch and where the branch starts.

| Field | Type | Required | Description |
|---|---|---|---|
| `branch` | `string` | yes | The new branch, which must not exist yet. |
| `base_ref` | `string` | yes | The commit the branch starts from, as Git reads it: `HEAD`, a branch, a tag, or a commit. |

### WorktreeCreateArgs

Arguments for `worktree.create`.

| Field | Type | Required | Description |
|---|---|---|---|
| `window_id` | `string` | yes | A logical window ID on this machine, including `terminal`. |
| `cwd` | `string` | yes | A location of that window: the checkout the worktree branches from. |
| `branch` | `string` | yes | The new branch, which must not exist yet. |
| `base_ref` | `string` | yes | The commit the branch starts from, as Git reads it: `HEAD`, a branch, a tag, or a commit. |
