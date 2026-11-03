# Changelog

## 0.0.4

- **Fixed: agents retained across an update could not use their Facade tools.** Their terminal connections now carry tool calls and replies again, including after reconnection.
- **Fixed: Muse Code agents ended as they started.** A Muse Code agent in a folder whose `.mcp.json` already had a `facade` server - the Facade Code app leaves one - ended at once with "-c mcpServers.facade: refusing run: the server name is reserved", as Muse Code will not run with a second server of that name. Facade now takes the place of the app's entry there, as it does the app's other files; where the server is your own, or Muse Code would refuse to run for another reason in your configuration, the agent starts without working with other agents and says why.
- **Fixed: missing emoji and messages that were never delivered on Windows.** Newly started Codex and Muse Code agents keep emoji in typed and pasted text, including 📨 and 🔔 in messages. Long messages remain recognizable when the CLI shows the first character separately from its paste placeholder. Facade also waits for Muse Code to finish reading a long message. Existing agents keep their original terminal backend; start or resume an agent to use the corrected input handling.
- **Fixed: new agents failed after installing an update.** New starts use the updated terminal backend, so removal of the previous extension installation does not leave them with `Cannot create process`. Existing agents remain connected to their original processes.

## 0.0.3

Pin from the start, a calmer status display, and fixes from daily use.

- **Closing an agent's tab closes it.** Closing a running agent's terminal tab yourself - its close button, Close, Close Editor - no longer asks first. Facade still asks once when tabs close together, as with Close All or Close Others.
- **New agents join at the bottom.** New cards go to the bottom of the list, and a card you pin to the bottom of the pinned cards; a card you unpin goes to the top of the others, just below the pinned cards. Move Up and Move Down still reorder them.
- **Pin any time.** An agent can be pinned before its first message, and a resumed conversation as soon as it starts. Until its CLI names the conversation, the Pin keeps the agent's CLI, name and folder: a workspace opened before then starts a new conversation there.
- **Two dots.** The dot is green while an agent starts or works and red when something is wrong, with none otherwise; the hover says whether the agent is idle or waiting for you. An agent not ready 20 seconds after starting - its CLI silent, or unable to work with other agents - turns red, and a CLI pausing between two steps no longer blinks its dot.
- **What you sent, on the card.** A card's second line says what you last sent the agent - any text you sent with Enter, slash commands too - or a message another agent sent it, and stays so: its CLI's title shows only before anything was sent, without the spinner before it.
- **A spinner on a busy agent's tab.** A busy agent's tab turns a spinner between its logo and its name.
- **Fewer commands.** Copy Agent Reference, Message History..., Clear Filter, Filter by This Location, Filter by This Folder and Copy Diagnostics are removed. Go to Agent still copies an agent's reference, the first item of **Filter by Working Location...** clears a filter, and a message to you still opens from its notification.
- **Fixed: scrolling and selecting stopped after a reload.** After a window reload, an agent whose CLI takes the mouse - Claude Code among them - could no longer be scrolled or have its text selected, because the redrawn terminal sent mouse events in an encoding the CLI cannot read. A redrawn terminal now keeps the mouse encoding, a hidden cursor and the CLI's keyboard protocol. Agents started before this version get it once they are started again.
- **Fixed: "Cannot work with other agents: move or rename .agents/skills/facade/SKILL.md".** Codex, Antigravity and Muse Code agents could not work with other agents in a folder where another Facade - an earlier version, or one with its own data folder - had left its skill or plugin. Facade now recognizes its own files - and those the Facade Code app writes - and brings them up to date; a skill or server of your own named `facade` is still left alone.
- **Fixed: `aN;NaNm` typed into an agent.** Clicking a file link in an agent's terminal could type `aN;NaNm` into its CLI, because VS Code reported the click after the file had covered the terminal.
- **Fixed: a pinned card's name.** The pin stood further from a shortened name than from a whole one.
- **No frame on a card's menu.** Right-clicking a card no longer draws a frame around it.
- **Faster Resume Agent.** Saved conversations are read in about a third of the time, without holding up your agents' terminals meanwhile.

## 0.0.2

Agents that work together, six native CLIs, and saved conversations.

- **Four more CLIs.** Antigravity, Muse Code, OpenCode and Pi join Claude Code and Codex. Start them from the panel like the others; they work together like the others too.
- **Resume Agent.** Find native conversations from this workspace, its subfolders and worktrees, and resume the exact conversation in its original CLI and working location. Native titles, activity and continuation history are preserved.
- **Pin and Unpin.** Pinned conversations return when the workspace opens again. Card and terminal-tab pins agree, stay saved across reloads, and follow native session changes. Unpin keeps the agent running; closing it removes the Pin. A failed save is reported instead of silently losing the intent.
- **Agents start agents.** An agent can start other agents, with any of the six CLIs, in any folder or new worktree of any Facade window on your computer, and give them their first task. Their cards appear without taking your focus, and their hover says who started them.
- **Messages.** Agents send each other messages. Facade pastes the whole message into the other agent's input box once and sends it. While someone's unsent text, or a question of that CLI, is in the way, it waits, for up to 10 minutes, and never sends their text with it; if it cannot read the input box within 15 seconds, or the wait runs out, the sender is told the message was not delivered. Facade's notices to an agent that come together arrive in one paste. Agents can also message you, with a notification that offers **Open Message** and **Show Agent**.
- **No duplicates on retry.** `start_agent` and `send_message` take a `request_id`: an agent that retries with the same one gets the first answer back instead of a second agent or message.
- **A stuck helper is reported.** When an agent started by another agent waits 20 seconds for permission, an answer or a sign-in, the agent that started it is told once, with who can answer.
- **Steadier starts.** Codex starts without its update question, which held back its first task, and gives Facade's tools time to start. Muse Code starts even if Facade's tools fail to. Facade no longer trusts your home folder, a folder above it or a drive's root for Claude Code, which would trust every folder below.
- **Copy Diagnostics.** **Facade Code: Copy Diagnostics** copies the versions, your agents with the last lines of their terminals, and Facade's log, to report a problem. Nothing is sent anywhere.
- **How long since an agent said it was working.** A working agent's hover says how long ago its CLI reported that.
- **Message History.** **Message History...** in the panel's `...` menu shows the messages of this window's agents, read-only. Messages are kept for 30 days.
- **Unsticking each other.** An agent can read another agent's terminal, type into it and press keys. Unlike messages, this typing does not wait for unsent text.
- **Across windows.** With `facade.yolo` on, an agent reaches every agent in your Facade windows on your computer, local and Remote - SSH alike; with it off, only its own group.
- **No approval prompts for Facade itself.** With `facade.yolo` off, each CLI's own commands and file changes still ask for approval, but starting, stopping and messaging agents do not. Muse Code has no setting for this, so there its own approval rules decide.
- **Antigravity's first turn.** Antigravity loads Facade's tools only once it is in use. Facade opens and closes its MCP list right after it starts, so that its first task can already use them.
- **New settings.** `facade.collaboration.enabled` (on by default) turns working together on or off for new agents. `facade.collaboration.waitSeconds` (120 by default) sets how long an agent waits for another agent to start or stop.
- **Installing in a remote window.** Facade Code now waits up to a minute for its Window Component while VS Code installs it, so a first install in a remote window usually needs no reload. If the component is missing or turned off, the panel says so and offers **Show Window Component**.
- **Updating from 0.0.1.** Agents started before the update keep their cards and terminals. Operations supported by their original runtime continue to work; new launch integrations apply to new agents. Agents started after the update are numbered after them, never with their `#a1`, `#a2`.
- **Fixed on Windows.** Closing an agent, or several agents ending at once, could crash the background process that keeps agents running, which ended every agent in every window.
- **Muse Code on Windows gets Facade's tools.** Facade gave them to it in the folder's `.mcp.json` in a form Muse Code 1.4.14 refuses, which turned off all its MCP servers in that folder; it now gives them to the agent's run alone, as on macOS and Linux, and leaves your `.mcp.json` as it is.
- **Many agents at once on Windows.** Starting many agents within seconds - twenty together, or a hundred one after another - no longer leaves some of them unstarted with "did not start within 10 seconds": Facade now starts their programs one at a time.
- **Safer worktree deletion.** Deleting a worktree now also closes agents working in its subfolders first. On Windows, a worktree that contains a link to another folder is not deleted with a Git older than 2.54, which would delete the linked folder's files too; long paths are handled, and Facade says when Git leaves the folder behind.
- **Claude Code on Windows starts without its trust question.** Facade now trusts the folder as Claude Code on Windows names it - the drive and folders as written, a worktree as itself - so agents no longer wait at "Do you trust this folder?" in new folders and worktrees.
- **OpenCode 1.x is not started.** Agents need OpenCode 2 (`@opencode/cli`). With OpenCode 1.x (npm's `opencode-ai`) installed, New Agent lists OpenCode as unavailable and says how to update, instead of starting an agent that exits at once or takes no message.
- **Claude Code's first agent takes messages.** In a VS Code terminal, Claude Code installed its VS Code extension and then waited for Enter at a welcome, which held back every message to that agent. Agents now start with that install turned off, unless you set `CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL` yourself.
- **Agents start with a clean environment.** Agents get the environment a VS Code terminal gets, without VS Code's internal variables or those of another agent session Facade Code was opened from.
- **Steadier after reloads.** Messages on their way when a window reloads are still delivered, or their senders are told; when the background process that keeps agents running is slow to answer, Facade waits for it instead of starting a second one; and a window keeps trying until every one of its agents shows.

## 0.0.1

First preview: Claude Code and Codex in VS Code terminals, with one panel for every agent, folders and worktrees, and agents that keep running across reloads.
