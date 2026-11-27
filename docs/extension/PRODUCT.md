# VS Code product scope

[The product guide](../PRODUCT.md) defines the two products and their Shell, MCP and VS Code entry points. This page describes
the editor's scope. [Experience](EXPERIENCE.md) follows the editor journeys and [Shared rules](RULES.md) owns their
common behavior.

## 1 Purpose and audience

### 1.1 Working in the editor

**Facade Code Extension is the VS Code entry point for Facade Code Framework.**

It lets the person start agents, see their state, open their terminals, and pick up their work later. The extension
includes Facade Code Framework for the platform where its workspace host runs.

### 1.2 People who use VS Code

**People keep their editor, project and CLI accounts.**

They can use the editor with Shell and MCP against the same Facade Code Framework.

## 2 Ways of working

### 2.1 One agent or a team

**Starting one agent can grow into a team.**

The panel shows reachable running Managed Agents, including their helpers. The CLI and the person's instructions
decide how a team divides and reports work.

### 2.2 Reaching running agents

**Open a running Managed Agent's terminal from its card.**

The Shell and the editor can view the same terminal at the same time.

## 3 Responsibility

### 3.1 Editor work

**The workspace remembers agents opened or started there and its Pins.**

Machine connections and sending messages use Shell. Agent collaboration uses MCP.

### 3.2 Execution

**Facade Code Framework owns agents and their terminals.**

Each extension host connects to its machine's Facade Code Framework. The CLI owns its models, login and session contents.

## 4 Product principles

### 4.1 Native controls

**Use familiar VS Code surfaces and terminology.**

The shared [glossary](../framework/GLOSSARY.md) supplies terms. Pin, Resume, Attach, Detach, YOLO and Guest keep these
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

**The VS Code extension uses Facade Code Framework on its extension host's machine.**

Remote-SSH uses the remote host. WSL and Dev Containers each count as a machine. To reach one from outside,
configure SSH inside it and use `facade machine add`. Running Facade Code Extension inside that environment uses its local
Facade Code Framework.

### 5.4 Git is optional

**A folder is sufficient to start an agent.**

Facade Code Extension can create a worktree when it starts an agent. Use Git for worktree deletion.

### 5.5 One folder or several

**The location picker starts from the workspace and can select another machine.**

See RULES-6.5 for its choices.

### 5.6 Workspace visibility

**Windows of the same workspace share its list and Pins.**

See RULES-6.1 for the first-open upgrade behavior.

### 5.7 Transition

**New agents use Facade Code Framework. A planned transition from the legacy implementation restores saved Pins.**

ARCHITECTURE-1.4 owns the cutover. Compatible upgrades reconnect to the running agents.
