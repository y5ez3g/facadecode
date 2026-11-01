# Changelog

## 0.2.0

Agents that work together, and four more CLIs.

- **Four more CLIs.** Antigravity, Muse Code, OpenCode and Pi join Claude Code and Codex. Start them from the panel like the others; they work together like the others too.
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
- **Updating from 0.0.1.** Agents started before the update keep running in their own terminals, without cards, and cannot use the new features.
- **Fixed on Windows.** Closing an agent, or several agents ending at once, could crash the background process that keeps agents running, which ended every agent in every window.

## 0.0.1

First preview: Claude Code and Codex in VS Code terminals, with one panel for every agent, folders and worktrees, and agents that keep running across reloads.
