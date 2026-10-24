# Remote Windows

A remote window is a VS Code window whose folders are on another machine: the window
draws on the person's computer while the extension host, the terminals and git run on
that machine. This document owns what Facade Code adds so that such a window works,
agents included: the SSH extension, the server package, and where each part of
Facade's agents runs. Everything else about remote windows is upstream's.

[AGENT-LAUNCHER.md](AGENT-LAUNCHER.md) and its three companions own the agents'
behavior, which a remote window does not change except where this document says so.
[IDENTITY.md](IDENTITY.md) owns the packages and the services Facade Code uses.
[RELEASE.md](RELEASE.md) says how a server package is made.

# Part 1: Specification

## R1. Scope

| Remote | Supported |
| --- | --- |
| SSH to a Linux x64 host | yes: the SSH extension is built in and every release has a server package for it (R6) |
| SSH to a macOS arm64 host | yes, as Linux |
| SSH to a Windows x64 host running OpenSSH Server | yes, as Linux |
| WSL | yes, through open-remote-wsl, built in (R5) |
| a container | through SSH into a container that runs sshd, as SSH to a Linux host; no container extension is built in or offered |
| other hosts: Linux arm64, an Intel Mac, Alpine | no: the server packages are the desktop packages' platforms, and no other. A Windows on Arm host is given the x64 package by the SSH extension and is not tested |
| tunnels, vscode.dev, a web build | no (IDENTITY.md I9) |

The same extension and the same agent code serve every one of them: the client's OS and
the remote's are independent, and an agent on a remote runs as it does in a local
window on that OS. A remote window has one remote, as upstream: no window holds
folders of two machines.

## R2. Where each part runs

Agents run where the code is. A remote window's agents run on the remote, as its
terminals do; the window only draws them.

| On the person's computer | On the remote |
| --- | --- |
| the window: the title bar's agent button, the workspace bar, notifications, Quick Picks | the extension host, with `facade-agents` and git |
| each terminal's screen, as it draws it, and the person's typing | each agent's process, in the remote's terminal host |
| | the agent CLIs, their logins and their settings |
| | the MCP shim and the pipe it reaches the extension host by (O8) |
| | the workspace record: `~/.facade/workspaces/<id>/`, its ledger, messages, screens, tokens and `agents.log` |
| | the worktrees agents make: `~/.facade/worktrees/` (WORKTREE.md) |
| | the person's scripts, which act as `@human` with the remote record's `you.token` |

Nothing in this table is a second implementation. It is where VS Code already puts an
extension of `extensionKind: ["workspace"]`, which `facade-agents` is, and its
terminals. Paths an agent, a message or a report gives are the remote's.

The workspace id is kept in the window's workspace storage, on the person's computer,
as in a local window (L12). The same workspace opened locally and remotely is two
workspaces, with two ids and two records; so is the same remote folder opened from two
computers (R3).

## R3. Agents in a remote window

Every rule of AGENT-LAUNCHER.md, AGENT-ORCHESTRATION.md, AGENT-MESSAGES.md and
AGENT-DEBUGGING.md holds in a remote window, with "this machine" read as the remote:

- **Detection** (L3) is the remote's. The agent menu asks the agents' extension host
  there which CLIs it finds, in one call, and it looks as a terminal of the remote
  would (L10): in the environment a remote terminal gets, its login shell's `PATH`
  included. The window never searches the remote's disk file by file, so the menu
  opens as quickly as in a local window.
- **No CLI on the remote**: the menu's empty state says "No agent CLI found on
  <host>. Install and sign in to one there.", with **Open Terminal**, a terminal of the
  remote in the selected folder, and **Configure Agents**. `<host>` is the remote as
  the window's remote indicator names it. Facade installs no CLI, on a remote as
  locally.
- **Signing in**: a CLI not yet signed in on the remote signs in from its agent's
  terminal, as it would in any terminal of the remote: with a code pasted back, or
  through a callback to a localhost port, which the window forwards as it forwards any
  port a remote process listens on. Where the window does not forward that port by
  itself - `remote.autoForwardPorts` off, or a port it did not notice - the person
  forwards it in the Ports view, or signs in with the CLI's device code where it has
  one. Facade adds nothing to signing in. A CLI that cannot sign in over SSH on a
  host's OS is a named limitation of that CLI there (L14), not a reason to hide it.
- **Settings** are machine-scoped (L7), and VS Code applies a machine-scoped setting
  in a remote window from that remote's settings only. The person's local values of
  `facade.agents.*` and `facade.orchestration.enabled` do not reach a remote, and a new
  remote starts from the defaults, YOLO on included: each machine has its own, as each
  has upstream's own auto-approval (`chat.tools.global.autoApprove`). In a remote
  window **Configure Agents** opens the remote's settings at the same search.
- **A folder to start in** (L3) is any folder of the window. Every folder of a remote
  window is on the remote.
- **The operating system** a rule depends on is the remote's: the terminal environment
  (`terminal.integrated.env.linux`, and on a Windows remote variable names that ignore
  case, so that a setting's `PATH` is the remote's `Path`), how a process is stopped
  (the hang-up, then the signals L6 escalates to), and how paths are spelled. A
  Windows computer's window on a Linux remote stops agents as Linux does.
- **Recovery** (L12) asks the remote's terminal host which processes survive: a
  reload finds the same agents still running there.
- **Worktree deletion** (WT-8, O5) stops the agents working in a worktree on the
  remote first, as it does locally.
- **Show Agents Log**, final screens (D6) and message files open from the remote.
  **Reveal in File Explorer** and **Reveal in Finder** are not offered for a remote
  folder or worktree, as VS Code offers them for local files only.
- **Two computers**: an agent belongs to the window that started it (L6). A window on
  the same remote folder from another computer has a record of its own, and the first
  computer's agents are another window's there: counted where W11 and WT-8 count other
  windows' agents, and never attached to its terminals or taken back by it, even while
  the first computer is away.

## R4. When the connection drops

An agent's process lives as long as the remote's server runs, as every terminal of
a window that dropped does: a dropped window never tells the remote's terminal host to
let its processes go, so they run until the server exits.

| What happens | Agents |
| --- | --- |
| The connection drops and comes back while VS Code still waits for it | keep running on the remote throughout. The window reconnects to the same processes, with no relaunch and no stop question |
| How long VS Code waits for a window | three hours, by default; five minutes once another connection reaches the same server - another folder, this folder reopened, another computer. Meanwhile the window's extension host, and Facade in it, runs on: the agents keep their tools |
| VS Code gives the window up | its extension host ends. The agents keep running on the remote, without Facade's tools, as long as the server runs |
| How long the server runs | while any window is connected to it or still waited for, and five minutes after the last; then it exits, and every process it started ends with it |
| A window of the workspace opens again, on the same computer, while its agents still run | it takes them back at once, with their tools: from its own earlier extension host if that one still runs (below), else as their processes' window |
| They ended before it opened | it records them lost (L12) and says once which agents ended while it was away, and when it was last connected to the host where Facade knows it: the last time the earlier extension host heard from its window, which that extension host keeps in the record as it hears |
| The person closes the window, quits, or closes the workspace while connected | as in a local window: W11's question first, then the agents end |
| The same while the window is away | W11's question says that <host> cannot be reached and that its agents keep running there as long as its server runs. Cancelling keeps the window; confirming closes it and leaves them running; a window opened on the folder before the server exits has them back, as after a reload |

**Its own earlier extension host is not another window.** When a window opens again
while its earlier extension host still runs on the remote, waiting for a connection
that will not come back, the new one asks the earlier one, through the earlier one's
pipe, to let go. That one stops taking calls, finishes recording what it was doing,
and lets go of the record, and the agents' tools reconnect to the new one. An earlier
one that does not answer within a few seconds is ended: the new one stops that
extension host's process - the record's lock names it, and it is checked to be an
extension host of this server first - and takes the record only once it has exited.
The agents are not touched, as their processes are the terminal host's. There is one
writer throughout, and no notice says that another window manages the agents.

While the window is away:

- Agents keep working, and what passes only between them and the remote works:
  messages are sent, recorded and fetched (M2, M4).
- An operation that needs the window waits for it within the call's timeout (L7).
  What its caller is told then stays true after the window is back, although the
  reconnection delivers the window's part late:
  - Typing and keys (D3) are taken on only as they leave the input queue to be
    written. One still queued when its wait ends is removed and reported not applied,
    and is never typed later; one being written as the connection broke is unknown
    (D5).
  - Reading a screen reports the window unavailable; a late read changes nothing.
  - A start past its wait is unconfirmed, with its phase (O3). It goes on: what it
    still needs of the window - its worktree, its terminal - is made when the window
    is back, which finishes that same run, unless the run is stopped first, and then
    nothing more is made (O4).
  - What a start asks of the window before it is recorded counts in its wait too. The
    environment its terminal will have, where the CLI is found (L10), is the one the
    window gave last for that folder, or for another of its repository, once the window
    has not answered for a moment: the start is recorded and goes on as above. With none
    given, or with no folder named for the person's start, whose folder is the one on
    their screen, it is refused at its time, nothing made.
  - A requested stop is carried out when the window is back, as a requested stop is
    after a reload (L12).
  - A worktree's deletion through `stop_agent` is taken on by the window - its ticket
    claimed (R7) - before anything is stopped or deleted. Not taken on within the
    call's time, it is not done, and the answer says nothing was stopped. Taken on and
    not finished, the answer says its outcome is unknown; it is not repeated, and how it
    ends is recorded once the window answers (WORKTREE.md WT-8.6).
- Doorbells are not calls. `send_message` records a message and answers at once (M2),
  and the recipient's doorbell rings once, after the window is back (M5); doorbells do
  not pile up while it is away. A delivery-delayed notice sent meanwhile (M6) names the
  window as what holds the doorbell up, and the agent it tells reads the screen once the
  window answers again: no CLI menu took the doorbell. One sent soon after the window is
  back says that the doorbell waited for it and rang only then, and the agent it tells
  reads the screen for what the recipient is still at.
- Taking back its agents as Facade comes back, which the tool calls wait for, asks the
  window after each process for a short while at most: one it cannot tell of then is
  looked for again later (L12).
- The pipe the agents' tools reach Facade by stays: it lives where the person's last
  SSH session ending does not remove it, and Facade makes it again if it is removed
  while the extension host runs.

The notice of agents that ended while the window was away is the one lost-agent notice
L6 does not suppress: in a remote window, unlike after a crash, the person did nothing
and was not there to see it. Facade adds no way for agents to outlive their server
(L6: no Detach Session), and no wait of its own beside VS Code's.

That the window was away is the window's own record of losing its connection, kept until
the extension host that recovers its agents reads it, or until an extension host that
outlived the cut is heard from, having seen each end in its terminal. Where the window
cannot say within half a minute, no agent is taken to have ended with the window: each
end is recorded as seen, or lost, and no notice names them.

## R5. The SSH and WSL extensions

The SSH extension is open-remote-ssh (`jeanp413.open-remote-ssh`, MIT), the one
VSCodium users install. Microsoft's Remote - SSH is licensed only for Microsoft's
builds (IDENTITY.md I9). The WSL extension is open-remote-wsl
(`jeanp413.open-remote-wsl`, MIT), by the same author, for the same reason.

- Both are built in, at a pinned version and checksum, fetched at build time from Open
  VSX as the other built-in extensions are (I9). They run on the person's computer only
  and are left out of the server packages. Both are listed in `ThirdPartyNotices.txt`.
- Facade does not change them but where listed here. Packaging changes each in the pinned
  version only, the line it is found by there exactly once, or the package is not made;
  each is reported to the author, and a version that fixes it drops the change.
  - open-remote-wsl 0.0.5, its last version, reads the first folder without checking
    there is one: in a workspace without folders - the default workspace before one is
    added - it fails to start, and none of its commands exist. open-remote-ssh had the
    same line until 0.5.0, which changed it the same way.
  - open-remote-ssh 0.5.0 looks for the server it started with a `ps` that, on macOS,
    lists only processes with a terminal. It never finds it: every connection, a
    reconnection too, starts another server, which refuses the window's reconnection,
    its terminals and agents left behind in the first. It looks by the process id
    instead.
  - open-remote-ssh's SSH library fails a channel whose request to forward the agent the
    host refuses, and Windows' OpenSSH server forwards none: with `ForwardAgent` set,
    nothing runs on a Windows host. It goes on without the agent, as OpenSSH does.
  - open-remote-ssh 0.5.0 parses `LocalForward` from SSH config but never opens its
    tunnels on an ssh2 connection. It opens TCP forwards through its existing tunnel
    manager after connecting, with the configured local bind address; a bad forward or
    an occupied port is logged without failing the remote connection. Its native SSH
    path already honors the config itself. On reconnection, the old connection's local
    listeners close before the new one binds those ports.
  - open-remote-ssh 0.5.0 takes its install lock with `flock`, which macOS lacks, and
    goes on without one there; its Windows setup takes none. Two windows connecting at
    once - a restart reopening both - each find no server and start one; the process id
    file keeps the one no window uses, which shuts itself down, and the next connection
    starts a third, the agents left in the other. On macOS, `lockf` locks the shell's
    open file descriptor for the same file that Linux's `flock` uses. The OS releases
    either lock when the installer exits; the long-lived server starts with that
    descriptor closed. If neither locker is available, setup reports a failure.
    On Windows it takes an exclusive OS file handle before validating or clearing an
    installed server and keeps it through setup until the server listens. The OS
    releases the handle if setup exits, so even an empty file left
    behind can be opened by the next setup immediately.
  - open-remote-ssh 0.5.0 puts its flock lock in $TMP_DIR/server_install.lock.
    When XDG_RUNTIME_DIR is absent, $TMP_DIR is shared /tmp: another user who
    created that file prevents this user from opening it, so server installation
    fails. The flock path uses $SERVER_DATA_DIR/.install.flock instead. The
    no-flock `lockf` path uses that same file and keeps its inode in place. Its
    contents, including an empty file left by a stopped setup, never block a new
    installer once the OS has released the lock.
  - On Windows, PowerShell 5.1's `Invoke-RestMethod` ignores `HTTP_PROXY` and
    `HTTPS_PROXY` unless its `-Proxy` argument is set. The setup script selects
    the proxy for the download URL's scheme and honors `NO_PROXY`, so it can
    install behind the same proxy settings as the Unix setup.
  - With cmd as the Windows SSH login shell, open-remote-ssh writes the whole
    PowerShell setup script in one command. A script above cmd's 8,191-character
    limit fails before installation. It writes longer scripts in bounded pieces
    before running them.
  - open-remote-ssh 0.5.0's Windows setup has several failure paths that end
    without the `start`, `exitCode`, and `end` block its own parser requires:
    directory creation and change, HTTP download, corrupt or unextractable
    archives, a missing server executable, a downloaded commit mismatch, and
    process startup. Packaging makes each failure print one nonzero result
    block and retain its specific cause in SSH Output. A lock timeout, a
    missing token or log, and a server that never listens also report failure.
    Its empty PowerShell initializers use explicit empty strings so that a
    missing listening port cannot be mistaken for a successful startup.
    Setup waits up to thirty seconds for the real server to listen, rather than
    three: a cold or busy host can take longer, and giving up closes its SSH
    setup and ends the server while it is still starting.
  - The Unix setup's failed directory change exits without a result, and its
    failed archive checks and directory creation exit only a subshell before
    the main setup can continue. Packaging makes those failures end the main
    script with one result block; opening its flock file reports a failure too.
- `product.json` enables the proposed APIs they declare, `resolvers` and
  `contribViewsRemote`, so that a newer version the person installs from Open VSX over
  the built-in keeps working.
- `product.json` also lets both run in a window in Restricted Mode, as a default that
  their own manifest still overrides. Neither says whether it supports an untrusted
  workspace, so VS Code would disable it there; but it is the window's connection and
  keeps running, and its view would be gone while it does, with an error. Neither runs
  anything of the folder's.
- On Windows the remote menu offers WSL beside SSH; elsewhere open-remote-wsl shows
  nothing, as its own manifest has it.
- Each keeps its own settings and commands (`remote.SSH.*`, `remote.WSL.*`), its own
  words and its own view. Facade does not reword or restyle them.
- Their own words are English in every language: neither ships translations, a
  `package.nls.json` or an l10n bundle, and a language pack translates only those
  (LOCALIZATION.md LC3). The remote menu's entries for them are Facade Code's own
  strings, translated with the window's.
- A person can disable either like any built-in extension. Disabled, the window behaves
  as if it were not there.

## R6. The server package

A remote window needs a server of exactly the window's build on the remote: the
connection is refused when the commits differ.

- Every release has one server package for each desktop package's platform,
  `facade-server-<release>-<os>-<arch>.tar.gz`: `linux-x64`, `darwin-arm64` and
  `win32-x64`. A platform added to the desktop packages adds its server package; there
  is no server package without a desktop package of the same platform, so each can be
  tested on a machine the release is made on. They are built from the same tagged
  commit as the desktop packages.
- Each is built on its own OS, as its desktop package is, because it carries native
  modules: the macOS one beside the disk image, the Windows one beside the installer,
  the Linux one beside the `.deb`. A server package is not part of a desktop package
  and is not installed with it.
- The Linux one is built against upstream's sysroot, glibc 2.28 and its libstdc++, as
  upstream's server is, and the binaries upstream's build checks are checked against
  that baseline: any one above it, or a check that cannot run, stops the package. It
  runs where upstream's server runs, Debian 10 and RHEL 8 included, not only on the
  release the build machine has.
- The Windows one's executables, native modules and PowerShell scripts are signed
  with the installer's certificate (I6), as upstream signs its own, so that Smart App
  Control and other application control on a Windows host accept them as they accept
  the installer. The macOS and Linux ones are not signed: a remote downloads its
  server with curl or wget, which marks nothing for Gatekeeper.
- The Windows one's remote CLI, the `facade` a terminal of the host opens a file in
  the window with, comes as upstream's `.cmd` and also as a POSIX shell script of the
  bare name, so that it runs in Git Bash on the host as in PowerShell and cmd, as the
  desktop's `bin/facade` does. Upstream's server has the `.cmd` alone, and Git Bash
  cannot run it by the bare name.
- The Linux one's launcher runs the server in a session of its own, its input nothing,
  under the process id and command it was started with. The WSL extension starts it
  from a `wsl.exe` that is a child of the window's extension host and ends with it - as
  a folder is added, or the window reloads - and in that session the server would end
  too, every terminal and agent of it with it. The process id and command stay, as both
  extensions find a running server by them.
- A release is published only with its three server packages attached, so that no
  desktop package is out before the server it connects to. Older releases keep theirs,
  for the people still on them.
- The release's checks cover them as they cover the desktop packages: I7's version
  check reads their version fields, the signature of every Windows executable, native
  module and PowerShell script is verified, and the Linux binaries are checked against
  the glibc 2.28 baseline.
- `product.json`'s `serverDownloadUrlTemplate` names that release's package under its tag, `facade/<release>`, the
  release version written in by the build from `facadeVersion` (I7) and `${os}` and
  `${arch}` left for the extension. The remote downloads its server from there itself.
- A remote that cannot reach GitHub gets its server one of two ways, which RELEASE.md
  describes: from a copy somewhere it can reach, named by the extension's
  `remote.SSH.serverDownloadUrlTemplate`; or from the package unpacked by hand into
  `~/.facade-server/bin/<commit>/`, which the extension then finds and uses. Facade adds
  no copy-over-SSH. A build not made from a release tag has no release with its server,
  and connects the same two ways.
- The server installs where `serverDataFolderName` says, `~/.facade-server/`, beside
  but never inside a VS Code or VSCodium server on the same remote.
- The server includes the built-in extensions that run on a remote,
  `facade-agents` among them, as upstream's server build selects them.

# Part 2: Technical Design

## R7. What changes

Upstream's remote machinery and the extension's layers stay as they are. The
extension host on a remote sees the remote's folders as `file` URIs, and the window
translates them on the way out, so the extension's "a local folder" checks already
mean "a folder on the machine this extension host runs on". What assumed the person's
computer, or an always-present window, changes:

| Where | What it must do |
| --- | --- |
| the agent menu's detection (`TerminalLauncherService`, `TerminalLauncherDetection`) | in a remote window, ask the agents' extension host which agents it finds, in one command; never look on the remote's disk from the window |
| `_facade.terminal.environment` | start from what a terminal of the remote starts from, which the remote builds itself - its server's environment, the login shell's over it, the resolver's - and the window cannot read: the agents' extension host there, built the same way, passes its own. Use the terminal backend of the window's remote authority, and the remote's OS for `terminal.integrated.env.<os>` and for whether variable names ignore case |
| `_facade.terminal.stop` | use the OS the run's process runs on, not the window's |
| `IFacadeRunsService`: taking runs back, learning exits while away | use the backend of the window's remote authority; keep a run's folder as its URI, not as a path spelled for the window's OS; take back only runs of this window's record |
| attaching to an agent's process (`mayAttachProcess`) | allow it only for a window of the agent's own record, orphaned or not (R3, two computers) |
| the worktree service: telling agents of a deletion, stopping agents inside it, other windows' agents in it | use the worktree's own scheme and authority, a remote worktree included |
| entering a workspace in a remote window | VS Code reloads a remote window as it enters a workspace - a folder added to a folder window, Save Workspace As - where it only restarts a local window's extension host. The window carries its record across that reload, in the new workspace's storage, for the next load to take back once, so that its agents stay its own (L12). It carries its terminals' layout so too, which the remote's pty host keeps by workspace and the window cannot give it under the new one before the reload, its connection down: the reload gives it to the pty host before reading it, so that the panel's terminals and those held in the background are back, as a local window keeps them. It reads the new workspace's configuration after the reload, not before: its extension hosts are stopped meanwhile, and with them the connection when the SSH extension holds it in the local one, so a remote folder's settings could not be read until the window gave the connection up. A folder opened as it joins - Open Folder, the bar's `+` - is the one the reloaded window starts on |
| the extension service: resolving the remote's authority while no extension host runs | temporarily not available for half a minute after they stop, not a permanent failure. Entering a workspace - adding a folder to a remote window - stops the extension hosts and starts them again, or reloads the window, within seconds, and open-remote-ssh keeps the SSH connection in the local one, so the connection drops as they stop: it is resolved again once they are back, and reconnects to the same server, its agents untouched. Past the half minute, with none started again, it fails as upstream's does, so that the window offers its reload rather than trying forever |
| the agents' tools: the CLIs this machine has, looked for again as a call comes | only for the calls that name them - `list_agents`, `start_agent` - and waited for two seconds at most, the last found used after that. The look asks the window, which does not answer while it is away, and every other call passes only between the agents and the remote (R2) |
| what the window keeps for each remote folder - the terminals held for it, agents' among them, the editors put away with it, its editors, its look in the bar - by `folderKey` | made again as the remote's file system registers, so that what was kept before is found after. The window is up before that file system is, and until then a key keeps the case of the path, which a Windows or macOS host's ignores once it is there. Kept both ways - set again before it registered - the one set since the window opened counts. Nothing kept for a folder of the remote is dropped as gone from the workspace before that file system is there: its key could not yet match the one it was kept by |
| workspace trust: whether a folder is a worktree, whose trust is its repository's (WORKTREE.md) | read only where git's files can be read without waiting on the window: this machine's folders, and the remote's once the remote is resolved, the trust calculated again then. The window connects to its remote and starts its extensions only after the trust is first calculated, so a read before the remote is resolved, or through a file system an extension provides, would wait for what waits for it. A request for the workspace's trust made before the remote is resolved - its terminals coming back - waits for that: trusted by then, as a trusted repository's worktree is, nothing is asked. Nothing is taken for trusted meanwhile, which the extension host, told once, would keep for the session. A folder of any other file system is no worktree |
| the terminals a reload brings back on a remote | those held in the background too - a folder's that a switch put away (WORKSPACE.md W6) - as for a local window, where upstream brings back only the panel's and the editor area's: else a reload loses every shell of the folders not on screen while their processes run on. The window saves no layout before it has taken back the one it had: an editor terminal laid out as it comes back - an agent's - would save one without the panel's terminals still to come back, in place of the one the pty host is about to give back |
| operations the extension host asks of the window: create, type, keys, stop, read, a worktree's deletion | each carries a ticket, which the window claims from the extension host at the moment it would act - for typing and keys, as the input leaves the queue to be written; for a deletion, before it stops or deletes anything. The extension host decides each ticket once, in order, and grants a claim only for an operation it still wants: input or a deletion whose caller has not been told it was not done, a start that has not been stopped. A refused claim is dropped, and the window does nothing (R4) |
| paste, then Enter (`FacadeAgentTerminal`) | in a remote terminal, count the Enter delay (L9 `enterDelay`) from when the remote's terminal host has the paste, not from when the window sent it |
| the pipe (`pipePath`) | on a remote, a private folder that no login session owns, not `XDG_RUNTIME_DIR`; checked while the extension host runs and made again if it is gone |
| the ledger lock | the live lock names its owner as well as its process. A live holder with this window's own owner is this window's earlier extension host on the remote. It is asked through its pipe to let go, and does so once it has stopped taking calls and recorded what was under way. One that does not answer within a few seconds is ended - its process, checked first to be an extension host of this server - and the lock is taken only after that process has exited, so that no write of its can come between a lock check and the write (R4) |
| the lost-while-away notice, W11's away wording | R4 |
| the empty state, Configure Agents, Reveal | R3 |
| the build | the three server packages (R6): the Linux one on the sysroot with its check, the Windows one signed; open-remote-ssh and open-remote-wsl built in from Open VSX, pinned, client only, changed in packaging only where R5 lists; the proposals for both; the WSL entry of the remote menu |

Two narrow rules keep this from coming back. A Facade window-side operation that needs
a terminal backend asks for the one of its folder's or the window's remote authority,
never the default, and one that needs the OS asks the remote environment when there is
one. An operation the extension host asks of the window goes with a ticket the window
checks before it acts.

# Part 3: Acceptance

## R8. Acceptance matrix

Levels follow [WORKSPACE.md W15](WORKSPACE.md#w15-test-levels-and-evidence). `R`
cases in a remote setup run in two: upstream's test resolver (`--remote=test+test`),
which runs a server from the sources and is remote in every way an extension can tell,
for integration; and a real SSH connection from a packaged build, for V and H. A local
URI mock is not evidence of either (W19). The V and H cases run from the Windows build
against each of the four remotes R10 names - a Linux host, a Windows host running OpenSSH
Server, a macOS host and WSL - wherever the case can happen there, as L14 asks a live run
on every advertised OS: WSL has no network between the window and its server to cut,
delay or be away from, and no SSH sign-in; containers, old glibc and unsupported hosts
are Linux's. RM-23 and RM-24 name what is particular to the macOS and Windows hosts.

Fault and timing cases change nothing on the host. The connection is cut, delayed and
made lossy by a proxy on the person's computer in the SSH path, one proxy per window
where a case has two. VS Code's three hours are shortened by starting this build's
server by hand on the host first, with a short `--reconnection-grace-time`, its
connection token and its log where the SSH extension looks for a running server, so
that the extension uses that one: two minutes for RM-08, and more than five for RM-09,
since the five-minute wait is never longer than the long one. Each case records the
host's process ids and when the extension host, the agents and the server each ended.

| ID | Level | Setup and action | Required observation |
| --- | --- | --- | --- |
| RM-01 | U | The window-side operations of R7, given a remote authority and a local window | The remote's backend and OS in the first, the local ones in the second |
| RM-02 | I | The test resolver window: start an agent, send it a message, read its screen, type, press keys, reload, stop it | Each behaves as in a local window; the record is the server's; process ids and folders are the server's |
| RM-03 | V, H | A packaged Windows build connects to the Ubuntu host for the first time, its server on a public pre-release | The server downloads from the release, installs under `~/.facade-server/`, and the window opens on a remote folder |
| RM-04 | V, H | On the host, each built-in installed there: L16's journey | As L16 requires; every agent process, worktree and record file is on the host, none on the person's computer |
| RM-05 | V, H | A host with no agent CLI; then CLIs only on the login shell's `PATH` (`~/.local/bin`) | The empty state names the host and Open Terminal opens a terminal there; nothing is installed. Then every CLI is found, and the menu opens as quickly as a local one |
| RM-06 | V, H | Agents running; the network cut for one minute with the default timeout; a message, a typed line and a start sent during it | The same processes; the message is delivered; the line and the start take effect once, after the cut, and report done |
| RM-07 | V | The timeout set to 20 seconds; the network cut for a minute, or for as long as the calls take where one CLI makes them, which it does one at a time; during it `type_text`, `press_keys`, `start_agent` with and without `new_worktree`, a second `start_agent` stopped with `stop_agent` before the cut ends, and a `send_message` | Typing and keys are not applied and never typed later. The start without a worktree is unconfirmed, and after the cut its terminal opens for the same run. The start with `new_worktree` is unconfirmed with its phase, and after the cut its worktree, if it was not made yet, and then its terminal are made for the same run. The stopped start makes nothing after the cut: no terminal, and a worktree git had already made is kept, as O4 says. The message is recorded at once, and its doorbell rings once after the cut |
| RM-08 | V | VS Code's wait at two minutes; one window; the network cut for ten | After two minutes the extension host ends and the agents' tools report Facade unavailable while their processes run; five minutes later the server exits and they end; the next window records them lost and says once which ended and when it was last connected, within a minute of the cut; no relaunch |
| RM-09 | V | VS Code's wait above five minutes; two windows on the host from this computer, each through its own proxy; one cut off, then the other reconnecting | The cut window's extension host ends five minutes after the reconnection; its agents keep running while the other window keeps the server; reopening the cut window's folder takes them back with their tools; the server exits five minutes after the last window closes |
| RM-10 | V, H | Close the connected window with agents running; cancel, then confirm | W11's question; cancel keeps them; confirm ends them on the host |
| RM-11 | V, H | Close the window while it is away and cancel; close it again and confirm; reopen the folder before the server exits | The away wording; cancelling keeps the window; the agents keep running and are back in the reopened window |
| RM-12 | V, H | Reopen or reload the window while its earlier extension host still runs, a message being sent and a line being typed through it at that moment; then the same with that extension host not answering | The agents are back with their tools, through the new pipe; the one that did not answer is ended first; one writer throughout: no event recorded twice or lost, the line typed at most once; no notice says another window manages them |
| RM-13 | V, H | Every other session on the host logged out, the remote desktop included; SSH cut for a minute, then restored | The agents' tools still reach Facade; messages sent during the cut are delivered |
| RM-14 | V, H | Delete a worktree on the host with an agent working in it | The agent is stopped first, then the worktree goes (WT-8) |
| RM-15 | V | From the Windows build, stop an agent on the Linux host | The hang-up and its escalation, as Linux; the exit code recorded |
| RM-16 | V | 200 ms round trip, 50 ms jitter and 1% loss in the SSH path | The agent menu opens within a second; 20 doorbells and 20 typed lines with Enter each submit exactly once |
| RM-17 | V | A host without access to GitHub: the extension's template set to a reachable copy; then the package unpacked by hand | The server installs from the copy; then the hand-placed one is used |
| RM-18 | V | The Linux server package on glibc 2.28: a Debian 10 container running sshd, reached as RM-22 | It starts, its native modules load, and an agent's terminal opens |
| RM-19 | V, H | A CLI not signed in on the Ubuntu, macOS and Windows hosts: Claude Code's pasted code and Codex's localhost callback, each from its agent's terminal, with `remote.autoForwardPorts` on and then off | Each sign-in completes: on, through the window's forwarding; off, through a port forwarded by hand in the Ports view or the CLI's device code. The agent then works. A CLI that cannot sign in over SSH on a host's OS is a named limitation |
| RM-20 | V, H | The same remote folder from a second computer while the first is away | The first computer's agents are another window's there: counted, never attached or taken back; the first gets them back as it reconnects |
| RM-21 | V | On Windows, the remote menu's WSL entry, from the default workspace before a folder is added and from a new window; then a WSL Ubuntu with an agent CLI | The built-in open-remote-wsl connects from both, nothing installed first; the first connection installs the server from the release; a WSL window starts an agent and messages it |
| RM-22 | V | SSH into a container that runs sshd | As RM-04's start and message, in the container |
| RM-23 | V, H | A macOS arm64 host: RM-03, RM-04 with each built-in installed there, RM-06, RM-14 and RM-15; a folder under `~/Documents` | As there, with macOS's paths, socket and signals; the folder opens once Remote Login allows full disk access for remote users; Claude Code started over SSH has its sign-in, or that is a named limitation in its launch record (L14) |
| RM-24 | V, H | A Windows x64 host with OpenSSH Server and Smart App Control on: the same cases | As there, with Windows's paths, named pipe and `.cmd` launches; a stop closes the agent's console, as L6 on Windows; the signed package's modules load |
| RM-25 | V, H | Each client OS - macOS, Windows, Ubuntu - connects to one host | The same outcome from each: the client's OS changes nothing on the remote |
| RM-26 | I | A local window, the SSH extension built in and enabled | Nothing in the local window changes: LA-03, LA-14 and WTA-26 as before |
| RM-27 | U, I | A remote window: Configure Agents; `facade.agents.yolo: false` in local user settings only; a remote folder's context menu | The remote's settings open; YOLO is on for the remote's next agent; no Reveal |
| RM-28 | U, I | Tickets, with the window and the extension host driven by the test: input claimed just before its caller's timeout; input held in the queue behind the person's typing past the timeout; the write done but its answer lost; a claim after the caller was told not applied; a start stopped while its terminal waits for the window | Claimed input is done or unknown, never not applied; queued input past its wait is not applied and never written; the late claim and the stopped start's terminal are refused, and nothing is written or made; each outcome recorded once |
| RM-30 | U, I | The earlier extension host held between its lock check and its write as the takeover comes; then not answering at all | It is ended before the new one takes the record; the ledger's sequence has no gap or repeat; the agents' processes are untouched |
| RM-29 | V | A host where another build's server runs, and one with a server of another commit installed | The extension installs and starts this build's server beside it, and the other is left as it was; a connection to a server of another commit is refused with the extension's message |

## R9. The workspace on a remote

WORKSPACE.md and WORKTREE.md hold in a remote window as they do locally, with every
folder, worktree and process on the remote (R2). WORKSPACE.md W18 asks for evidence
from a real remote, never from local URI mocks; these cases are that evidence. They
run as R8's V and H cases do, through the window's own controls: a packaged build
connected to each of R10's four remotes, a fresh profile, as paths, locks and signals
differ between them. On each: repository A,
trusted, with a commit and a second branch; repository B, trusted; folder C, never
trusted; the built-in agent CLIs signed in. Each case records the window's
screenshots, the host's `git worktree list`, its process ids and the record's
`agents.log`.

| ID | Level | Setup and action | Required observation |
| --- | --- | --- | --- |
| RM-31 | V, H | A remote window on A, an agent running in it and a long command in a terminal of the panel; add B with File > Add Folder to Workspace; then a third folder with the bar's `+` | The window becomes an untitled workspace in place (W4): no Cannot reconnect, no reload asked for, the connection back by itself within seconds. The agent started before is still the window's: Show Active Agents lists it, it sends and receives messages, and the next agent started is numbered after it (L12). The panel's terminal is back, its command running on, the same process. The third folder restarts nothing (W4) |
| RM-32 | V, H | In a remote window, File > Open Folder on another folder of the host; then the same dialog's Show Local on a folder of the person's computer | The host's folder is shown in this window, its list kept (W5). The local folder opens in a window that can reach it, a local one; this window's list is unchanged |
| RM-33 | V, H | Two remote folders, each with an agent, a terminal running a process and an open editor; go back and forth by clicking rows and with the keyboard (W9.11) | Explorer, Source Control, editors and the title follow the folder (W6); the other folder's agent and terminal run on in the background and are there on return; the status bar's branch is the folder's own |
| RM-34 | V, H | New Worktree on A's row; then an agent started with `new_worktree` by another agent | The dialog names a folder on the host under `~/.facade/worktrees/`; git on the host lists the worktree; its row appears under A and the window goes to it; no trust question, A being trusted (WT-3.9). The agent's worktree arrives the same way |
| RM-35 | V, H | Delete Worktree on a remote worktree with an agent, a terminal running a process and an unsaved editor in it; Cancel, then Delete | One confirmation names the agent, the terminal and the unsaved file (WT-8). Cancel changes nothing. Delete stops the agent first, then the terminal, removes the directory on the host and keeps its branch; the row goes |
| RM-36 | V, H | Remove Folder on a remote folder with nothing running, then on one with an agent running; Cancel, then Remove | The first goes at once. The second asks first, naming the agent; Cancel keeps it; Remove stops the agent. Both folders are still on the host's disk (W9.6) |
| RM-37 | V, H | Add C to a trusted remote window; Cancel; again, Trust and Add; then a fresh untrusted folder with the question's link to open it in a new window | Facade's trust question comes before C joins (W5). Cancel: the list unchanged. Trust and Add: C added and the window still trusted. The link: a new window on the same host, restricted; this window unchanged |
| RM-38 | V, H | A remote workspace of two folders, an agent and a terminal in each, an unsaved editor in the folder not on screen; Reload Window | The active folder, the rows, the editors - the hidden unsaved one included - the terminals and the agents are back; the agents are the same processes, and nothing asks to stop them (W11) |
| RM-39 | V, H | Close the untitled remote workspace with agents running; Cancel; close again, Save, Terminate; then reopen it from Open Recent, and open another workspace file of the host with File > Open Workspace from File... | VS Code's save question and W11's terminate question; Cancel keeps everything. Save writes the workspace file on the host; Terminate ends the agents there. Open Recent connects to the host again and restores the folders; the other workspace opens in a new window (W4) |
| RM-40 | V, H | In a remote window, File > Open Default Workspace | The default workspace opens in a local window; the remote window is unchanged (W4; WS-02) |
| RM-41 | V, H | Two windows on the host, one on A's main checkout and one on a worktree of A, an agent in each; Delete Worktree in the first on the second's worktree | Nothing is asked: the deletion is refused at once, as a lock refuses it (WT-8, step 1), naming the second window's agent as another window's (R3); nothing happens to that agent or the worktree on the host |
| RM-42 | V, H | A remote row's menu; a color, an icon and a name set on remote rows; Reload Window | No Reveal in File Explorer or Reveal in Finder (R3). The color, icon and name are set, and kept through the reload |

## R10. Everyday use over SSH

What people do with VS Code over SSH, the most common first, as VS Code's Remote-SSH
documentation and its troubleshooting guide describe it and as the most-voted
Remote-SSH issues and the remote guides of university and HPC clusters show it. The SSH
part is the extensions' and VS Code's (R5), with the packaging changes listed there:
these cases check that
it works in Facade's build and that nothing Facade added gets in its way. They run in
this order, before R9's and then R8's V and H cases, through the window's own controls
as R9 says. "All four" is a Linux host, a Windows host running OpenSSH Server and a
macOS host, each over SSH, and WSL through its extension (R5); a case names the remotes
it cannot happen on otherwise. What R1 does not support is checked only for its message
(RM-59).

| ID | Level | Remotes | Use | Required observation |
| --- | --- | --- | --- | --- |
| RM-43 | V, H | all four | Connect: Connect to Host with `user@host`; then a host of `~/.ssh/config` by its alias, with its own user, port and key; from the remote indicator and from the Remote Explorer | The window opens on the host, the first connection installing the server; File > Open Folder lists the host's files; the Remote Explorer lists the config's hosts |
| RM-44 | V, H | all four | Files: create, rename, move, delete, edit and save files and folders in the Explorer; search the folder; drag a file from the person's computer into the Explorer; Download... a file of the host | Each change is on the host's disk; search finds text in the host's files; the dragged file is copied to the host; the download lands on the person's computer |
| RM-45 | V, H | all four | Terminal: new terminals in the default shell and in each other shell the host has; a command found only on the login shell's PATH; `facade <file>` typed in a terminal of the host | Terminals run on the host, in the folder; the login shell's PATH is there; the file opens in this window |
| RM-46 | V, H | all four; the agent half not on a Windows host, whose OpenSSH server forwards no agent | Git: Source Control on a repository of the host - stage, commit, branch, pull, push - first with the person's key through their SSH agent (`ForwardAgent yes`; in WSL, the person's credentials as WSL shares them), then with a key of the host | Each operation runs on the host; push and pull authenticate through the forwarded agent without a prompt, then with the host's key. A Windows host connects with `ForwardAgent yes` all the same, without the agent (R5) |
| RM-47 | V, H | all four | Extensions: a language extension installed into the host from the Extensions view; its language features on a file of the host; Install Local Extensions in SSH | It installs on the host from Open VSX and works there; UI extensions stay on the person's computer |
| RM-48 | V, H | all four | Close and reopen: File > Close Remote Connection; then the folder reopened from Open Recent, and from the Remote Explorer's list of the host's folders | Disconnects cleanly; reopening connects to the same folder, its editors back |
| RM-49 | V, H | Linux, Windows, macOS | Network: the connection cut for ten seconds and for a minute, and the person's computer asleep for five minutes, a terminal running a long command meanwhile | The window reconnects by itself; the command ran on and its output is there; agents as RM-06 |
| RM-50 | V, H | all four | Ports: a web server started in a terminal of the host; a port forwarded by hand in the Ports view; one by `LocalForward` in the SSH config | The first is forwarded by itself and opens in the person's browser; the other two work |
| RM-51 | V, H | all four | Debug: F5 on a Node.js program of the host, with a breakpoint | The program runs on the host and stops at the breakpoint; the variables are the host's |
| RM-52 | V, H | Linux, Windows, macOS; two-factor on Linux | Sign-in kinds: a host that asks for a password; a key with a passphrase; two-factor (keyboard-interactive); the key from the person's SSH agent, the Windows OpenSSH agent | Each asks in the window, or uses the agent, and connects; nothing typed is saved |
| RM-53 | V, H | Linux, Windows, macOS | A jump host: `ProxyJump` in the SSH config; then `ProxyCommand` | Connects to the inner host through the jump host; RM-43 to RM-45 hold there |
| RM-54 | V, H | all four | Several windows: two on the host, one on another host at the same time; New Window then Connect to Host; one closed | Each works on its own; closing one leaves the others connected |
| RM-55 | V, H | all four | Settings: Open Remote Settings and a machine setting there; `remote.SSH.connectTimeout` and `remote.SSH.serverInstallPath` in the person's settings | The remote settings apply on that host only; the extension honours its settings |
| RM-56 | V, H | all four | The host's login shell: zsh, then fish, on Linux; zsh, the default, on macOS; PowerShell, then cmd, on Windows | Connects; Linux and macOS terminals open in that login shell. Windows terminals use VS Code's Windows default profile (PowerShell unless configured otherwise); cmd remains selectable when it is the SSH login shell. The agent menu finds the CLIs on the remote terminal's PATH (R3) |
| RM-57 | V | all four; the proxy on Linux, Windows and macOS | A host without the internet, then behind a proxy (`HTTP_PROXY` on the host) | As RM-17; behind the proxy, the server downloads |
| RM-58 | V | Linux | A container that runs sshd | As RM-22 |
| RM-59 | V | Linux | Hosts outside R1: a Linux arm64 host; an Alpine host | The connection fails with the extension's own message that the server could not be installed - Facade does not reword it (R5) - and its log names the server package that is missing; nothing hangs |
