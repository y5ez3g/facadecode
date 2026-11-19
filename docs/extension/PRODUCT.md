# VS Code product scope

[Facade Code](../facade-code.md) defines the product and its Shell, MCP and VS Code entry points. This page describes
the editor's scope. [Experience](EXPERIENCE.md) follows the editor journeys and [Shared rules](RULES.md) owns their
common behavior.

## 1 Purpose and audience

### 1.1 Working in the editor

**The extension is Facade Code's VS Code entry point.**

It lets the person start agents, see their state, open their terminals, and pick up their work later. The extension
includes the Orchestrator for the platform where its workspace host runs.

### 1.2 People who use VS Code

**People keep their editor, project and CLI accounts.**

They can use the editor with Shell and MCP against the same Orchestrator.

## 2 Ways of working

### 2.1 One agent or a team

**Starting one agent can grow into a team.**

The workspace shows agents the person starts or opens there, and their helpers. The CLI and the person's instructions
decide how a team divides and reports work.

### 2.2 Reaching running agents

**Go to Agent opens reachable running managed agents.**

Attach provides the live terminal. The Shell and the editor can view the same terminal at the same time.

## 3 Responsibility

### 3.1 Editor work

**The workspace remembers its card list and Pins.**

Machine connections and sending messages use Shell. Agent collaboration uses MCP.

### 3.2 Execution

**The Orchestrator owns agents and their terminals.**

Each extension host connects to its machine's Orchestrator. The CLI owns its models, login and session contents.

## 4 Product principles

### 4.1 Native controls

**Use familiar VS Code surfaces and terminology.**

The shared [glossary](../core/GLOSSARY.md) supplies terms. Pin, Resume, Go to Agent, Attach, YOLO and Guest keep these
names across languages.

### 4.2 Simple feedback

**Show the agent's state and report actionable editor errors.**

The terminal remains the place to read an agent's work or answer the CLI directly.

## 5 Scope and quality

### 5.1 Agent continuity

**Closing the editor's view leaves the agent running.**

Resume picks up saved work; a Pin records the workspace's intent to reopen an agent.

### 5.2 Environments

**Support claims follow verified editor and native platform combinations.**

The [verification gates](engineering/VERIFICATION.md) describe evidence for installation and the editor journeys.

### 5.3 Remote editors

**The VS Code extension uses the Orchestrator on its extension host's machine.**

Remote-SSH uses the remote host. WSL and Dev Containers each count as a machine. To reach one from outside,
configure SSH inside it and use `facade machine add`. Running Facade inside that environment uses its local
Orchestrator.

### 5.4 Git is optional

**A folder is sufficient to start an agent.**

Facade can create a worktree when it starts an agent. Use Git for worktree deletion.

### 5.5 One folder or several

**The location picker starts from the workspace and can select another machine.**

See RULES-6.5 for its choices.

### 5.6 Workspace visibility

**Windows of the same workspace share its list and Pins.**

See RULES-6.1 for the first-open upgrade behavior.

### 5.7 Transition

**The old engine remains selectable during the transition.**

The editor behaviors here describe the Orchestrator-backed entry point. The old engine keeps its existing rules.
