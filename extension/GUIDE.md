# Facade Code Extension guide

Facade Code Extension is the VS Code entry point for Facade Code Framework. It starts and opens agents through Facade Code Framework on the
machine that hosts the workspace. The [product documentation](../docs/PRODUCT.md) covers the three entry points.

## Install for your workspace host

Choose the platform VSIX and matching Window Component from the same release or
[source package build](../docs/framework/FEATURES.md#build-matching-packages-from-source) as your API v1 Shell.
The platform VSIX has the target of the workspace host. In VS Code, use
[Extensions: Install from VSIX](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace#_install-from-a-vsix)
for the Facade Code Extension package in the workspace window. Install the Window Component for the local VS Code UI.
Set **Facade: Framework** to `auto` and reopen the workspace. In a remote window, confirm that Facade Code Extension
is installed on the remote workspace host. Use the same Facade home as your Shell on that host.

## One panel for your workspace

Use **New Agent** to pick a CLI. Choose **Change Working Location** to pick a workspace folder or a Git worktree.
To use a saved machine, pick it in the same step, then choose a recent directory or its login home, or enter a
path. Facade Code Extension wakes an asleep machine when you select it and shows that machine's CLI choices and availability.
To create a worktree while starting, choose a Git repository on either machine and enter a new branch name.
Use your usual Git commands to remove a worktree.

Use **Go to Agent** beside **Resume** on the Panel, or from the Command Palette, to search the running managed agents
that your Facade Code Framework can reach. Select one to open its terminal. The workspace remembers that agent and its
helpers, including helpers that were already running. Helper cards appear without opening tabs or moving focus.
Windows of the same workspace share the list and Pins.

Each card shows the agent's name, CLI, status and title. Open its information details to find the machine and
working folder. **Copy Agent Reference** copies an address such as `a3@devbox` for use in Shell or MCP.
Use **Filter** to narrow the cards and **Show Agents Log** for the extension's diagnostics.

## Attach, hide, stop or delete

Click a card or choose **Open Terminal** to Attach to the live terminal. Shell and VS Code can show the same
terminal at once. Closing the terminal tab detaches that view. The agent can keep running after VS Code closes.
After a disconnect, Attach shows the current screen and reports any dropped input in bytes.

| Card action | Effect |
| --- | --- |
| Open Terminal | Attach to the live terminal |
| Hide | Clear this workspace's card and Pin; the agent keeps running |
| Stop | End the agent's run and keep its card and Pin |
| Remove | Stop a running agent, remove its record and clear its card and Pin |
| Pin or Unpin | Choose whether to restore this agent when the workspace reopens |
| Rename | Change the name and keep the address |

## Resume and Pin

**Resume Agent** shows ended agents with sessions and saved CLI sessions for the workspace. It uses the same
Facade Code Framework results as `facade resume` for that scope. Resuming an ended agent uses its original address, folder,
session, model and effort. Choosing a saved session creates an agent at a new address. If the session is already
in use, Facade Code Extension identifies the agent that holds it.

Pin an agent after its CLI creates a session. On reopen, a running pinned agent reattaches. Facade Code Extension makes one
Resume attempt for each stopped or crashed pinned agent, and a red card explains a failure. Use **Unpin** before
**Stop** to leave that agent stopped across reopens. Editor tab pins and closes leave Facade Code Extension's Pin as it was.

Ended records expire after 30 days. An unpinned card then disappears. After confirmed expiry, a pinned agent can
continue from its saved session as a new agent. A machine that cannot be reached leaves a red card and its Pin.
Choose **Remove** on the card to delete its record, clear the Pin and end automatic recovery. If the session is
confirmed gone, Facade Code Extension clears the Pin and tells you. Reopen the same workspace and Facade home to recover its
saved roster and Pins. Restore an SSH route with `facade machine add` to refresh members already saved in that
roster.
See [workspace state and recovery](../docs/extension/engineering/ARCHITECTURE.md#62-workspace-state-and-upgrade).

## SSH and agent collaboration

A Remote-SSH editor connects to its remote host's Facade Code Framework. To reach more machines from that host, use Shell
there to register them with `facade machine add`. WSL and Dev Containers that you want to reach as machines also use
SSH configured inside those environments. You can use Facade Code Extension directly inside either environment. See the
[standalone Shell installation](../docs/framework/FEATURES.md#install-the-standalone-shell) and the
[MCP entry point](../docs/PRODUCT.md#mcp).

Agents use MCP to find and start agents, send messages, read screens, type and press keys. Ask an agent to start a
helper and have the helper report back to it. You can follow their work in the terminal and Panel. Use Shell to
send a message to an agent directly. An external MCP app joins as a Guest on its first tool call and can use the
reply-wait call returned by `send_message`.

## Settings and CLI behavior

Choose **Open Settings** to access the execution host's `facade.json`. To find the settings file on another machine,
connect over SSH and run `facade status` there. YOLO defaults to on. With YOLO off, an agent uses its CLI's
normal approval and sandbox settings, and its MCP reach is its creation tree. Settings are read at Start or Resume.

Use `clis` to add a named entry backed by a built-in CLI, for example Codex with a separate profile, or to launch a
custom program. A local launch uses the initiator's environment. A launch on another machine uses its login
environment. See the [settings example](README.md#settings) and the
[CLI differences](../docs/PRODUCT.md#cli-differences).

## Legacy implementation transition

Set **Facade: Framework** to `off` and reload to select the legacy implementation. Its **Facade Code Extension: Home** setting and Window
Component requirement still apply. During the transition, the legacy implementation retains its window grace periods and
its own Stop, Dismiss and Pin behavior. The [legacy implementation lifetime rules](../docs/extension/RULES.md#41-ownership-reload-and-closure)
describe those details.

If the editor falls back to the legacy implementation, it reports the execution host and the failed step. After fixing the
problem, set **Facade: Framework** to `auto` and reopen the window.

## Status and Known Limitations

See the [verification record](../docs/extension/engineering/VERIFICATION.md) for tested versions, native platforms,
isolated editor journeys and open gates. Those records identify which implementation and build each result covers.
