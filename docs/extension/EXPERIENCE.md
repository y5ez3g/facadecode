# VS Code experience

[Facade Code](../facade-code.md) defines the product. [Shared rules](RULES.md#6-the-vs-code-entry-point) and the feature
specifications define how these journeys behave in the Orchestrator-backed editor. The old engine retains its
transition rules in the corresponding feature specifications.

## 1 Start an agent

### 1.1 New Agent

**New Agent lets you start one CLI in a chosen folder.**

Choose a CLI and give it instructions in its terminal. The CLI handles sign-in and its questions. Change Working
Location offers the workspace's folders and worktrees, or a saved machine and one of its folders. A sleeping
machine wakes when selected. See LIFECYCLE-5.1 and RULES-6.5.

### 1.2 Start in a worktree

**A worktree can be created as the agent starts.**

Choose a Git repository and enter a new branch name. The agent starts in the new worktree. If Git or the CLI cannot
complete its step, show the reason. A plain folder needs only the CLI. See WORKTREES-5.1.

### 1.4 Initial exceptions

**Explain missing startup prerequisites where the person can correct them.**

If the chosen machine has no usable CLI, explain what is needed. The local Open Settings action opens the settings
file under CONFIGURATION-7.1. A start on another machine uses that machine's settings. Return an actionable
error when the machine or working folder is unavailable.

## 2 Follow an agent

### 2.1 Find and attach

**Go to Agent opens a running managed agent that the Orchestrator can reach.**

Start an agent from Shell, then select it in VS Code. Its terminal opens with the same screen and input as a Shell
Attach. Closing either view leaves the agent running. Read terminal output directly or use the card's state and
TITLE. The information button identifies its machine. See LIFECYCLE-5.2 and PANEL-4.

### 2.2 Follow a team

**When an agent starts helpers, their cards appear in its workspace list.**

Their terminals open when selected. The person can monitor or intervene from the terminals while the agents
coordinate using MCP. See COLLABORATION-5. Use Shell to configure connections between machines.

## 3 Continue or finish

### 3.1 Stop, Hide and Remove

**Choose the action that matches the intended effect.**

Stop leaves the card and saved work available. Hide removes the workspace's card and its Pin; the agent continues.
Remove also removes the agent's record. Closing its terminal tab only detaches. See RULES-6.3.

### 3.2 Resume and Pin

**Resume Agent offers saved work, and Pin opens an agent again when the workspace reopens.**

Resume a stopped agent at its original address, or resume a CLI session as a new agent. A reopened workspace
attaches to a running pinned agent or attempts to resume it once. A red card explains a failed attempt.
Use the card's Pin or Unpin action to change the saved intent. See LIFECYCLE-5.4 and LIFECYCLE-5.5.

### 3.3 Reconnect and upgrade

**Reopen the workspace to see its agents and Pins again.**

Finish pending workspace import in the prerelease editor before the first daemon API v1 switch. The reopened
workspace uses its saved agent list and Pins. The Window Component can clean up stale terminal tabs. Remote-SSH
works against the Orchestrator on the remote editor host. See RULES-6.1 and RULES-6.8.

## Checks

| Rules | Acceptance |
| --- | --- |
| 1 | Start locally and over SSH, including in a plain folder and a new worktree |
| 2 | Discover a Shell-started agent, attach from both entry points, and open a team including existing helpers |
| 3 | Distinguish Close, Hide, Stop and Remove; reopen and resume Pins and confirm the first-open upgrade migration |

[Verification](engineering/VERIFICATION.md) records evidence.
