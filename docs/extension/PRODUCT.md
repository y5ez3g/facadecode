# Product

Facade Code is the product described here. This document sets direction; the lower layers define exact behavior.
The owner recalibrated this direction on 2026-10-28 after both top-down reviews and authorized this revision.
Specification status does not establish that the implementation already meets it.

| Group | Decides |
| --- | --- |
| 1 Purpose and audience | Why Facade exists and who uses it |
| 2 Ways of working | Super Engineer and Super Team |
| 3 Responsibility | Infrastructure, CLI and user boundaries |
| 4 Product principles | Familiarity and simplicity |
| 5 Scope and quality | Capabilities, environments and the quality bar |

## 1 Purpose and audience

### 1.1 Infrastructure for working with agents

**Facade Code is a VS Code extension that lets a person work with coding agents together in their editor.**

It runs the user's interactive CLIs, makes every agent visible and accessible, and provides the means for agents to
start, communicate with and operate one another. A useful session can contain one agent or many.

### 1.2 VS Code users

**Facade serves VS Code users, including people new to coding agents and those already using CLIs or vendor extensions.**

They keep their editor, project, CLI accounts and familiar tools. Facade removes the work of managing terminals and
relaying messages; it does not require learning a prescribed team process. The empty panel explains how to begin;
README and video material can teach further use. There is no separate in-product onboarding flow. This is one person's
editor extension, not a multi-user collaboration service.

## 2 Ways of working

### 2.1 Two equally important ways of working

**The same product supports Super Engineer and Super Team equally.**

| Way | Who organizes the work |
| --- | --- |
| Super Engineer | The person directs agents and can have them collaborate. |
| Super Team | The person's prompts or skills instruct an agent to organize and work with other agents. |

These are ways of using the product, not modes selected in the interface. A session can move between them freely.

### 2.2 The person can reach every agent

**Every agent has an interactive terminal that the person can inspect, use and close, whoever started it.**

Agents started by agents are ordinary visible agents in their destination window. A creator is not an access gate.

## 3 Responsibility

### 3.1 Infrastructure and workflows

**Facade provides basic MCP APIs; users define organization and workflow through prompts or skills.**

Its three surfaces are a window-local agent panel, one interactive editor terminal per agent, and MCP for agent
startup/query/stop, messages, screen reading and direct terminal input. MCP provides corresponding runtime effects;
it does not reproduce every human UI command. Human rename and close do not imply additional MCP tools.

Facade does not assign roles, task plans, review schedules, reporting duties, acceptance procedures or escalation
policies. Its API instructions explain capabilities, effects and failures. They do not instruct an agent how to run
the user's project. Delivery success and working status are infrastructure facts, never judgments of task quality.

### 3.2 Clear responsibilities

**Facade runs the infrastructure, CLIs perform the work, and the user defines goals and permissions.**

| Party | Owns |
| --- | --- |
| Facade | Agent lifecycle, locations, terminal access, communication and feedback about those operations |
| CLIs | Models, reasoning, tool execution, login, conversation storage and native permission interactions |
| User and their prompts/skills | Organization, delegation, review, acceptance, and when to commit, integrate or publish |

Facade supplies no model service, account, billing or hosted compute. It uses installed CLIs and the user's accounts.
Git review and integration remain with the user's usual tools; worktree management supports them.

## 4 Product principles

### 4.1 Familiar and natural

**Using Facade feels familiar to someone who uses a CLI directly or the Claude Code or Codex VS Code extension.**

Use VS Code's controls, wording, keyboard habits and visual language. Preserve the CLI's interactive experience. The
priority is **capability, then familiarity, then simplicity**. Capability means delivering the agreed scope, not adding
more features. Prefer straightforward native flows over speculative edge-case machinery, security infrastructure and
rarely used controls. Prefer one rule that covers the ordinary flows. Accept explicitly chosen finite failures and races
rather than add special recovery layers; agents and their skills handle deduplication, debugging and workflow decisions
where practical. Simplification removes duplicated responsibilities and unnecessary configuration, not demonstrated
usability needs.

### 4.2 Simple and intuitive

**A person understands what a screen shows and how to use it at a glance.**

The common path is short. Relevant information is visible; advanced choices appear where needed. Actions with the
same name have the same meaning. The owner's Apple-like reference means this clarity, not a new visual theme.
Everything a person sees says what happened in plain words; internal mechanisms and their names stay out of it.

## 5 Scope and quality

### 5.1 Capabilities that support users' workflows

**Facade provides agent operation, communication and work locations.**

Start, find, inspect, type into, resume, pin/unpin and stop agents; send messages with explicit results; contact the person; choose
locations and optionally create/use worktrees. Each feature
states its limits honestly, including unsupported CLI capabilities. None imposes a workflow.

### 5.2 Operating boundaries

**Facade Code is free, MIT open source, for desktop VS Code and compatible editors on macOS, Windows and Linux.**

- Built-in and configured custom CLIs run interactively. Facade does not supply a separate application or hosted agent.
- The product name is Facade Code; Facade is the short form. User interfaces follow VS Code's language; agent APIs use English.
- The supported desktop editor must supply the required extension APIs. Browser-only editors and virtual filesystems
  without an executable workspace environment are outside this release.
- Compatibility is demonstrated per editor, platform and integration; it is not inferred from a similar appearance.

### 5.3 Agents run in the workspace environment

**An agent runs where its workspace runs: locally, on Remote SSH, in WSL or inside a Dev Container.**

CLI discovery, accounts, settings, paths, Git, files and process execution belong to that environment. A local CLI is
not silently substituted for a missing remote CLI. The same user experience applies in each environment.

### 5.4 Git and worktrees are optional

**Starting and using agents works smoothly without Git installed, without a repository and without worktrees.**

Only Git-dependent actions require Git. A plain folder is a normal work location, not an error or an invitation to
initialize a repository. Worktrees are an optional way of separating changes.

### 5.5 One folder or several

**Single-folder and multi-folder workspaces are equally supported, including mixed ordinary folders, repositories and worktrees.**

Every agent has a clear launch location. Additional folders add choices without burdening a single-folder session.

### 5.6 Connected windows, separate management

**Agents in all Facade windows on the same client computer can discover, communicate with and operate one another.**

This includes windows connected to different execution environments. Each window displays and manages its own agents.
An agent created for another window runs and appears there. The network belongs to the signed-in operating-system
user's client; it does not discover other people's computers or users. CLI permissions remain distinct from reach.
Human UI manages the current window only. Agent reach and launch-time YOLO follow RULES-4.3; connectivity does not
imply unrestricted access for every caller.
These are normal MCP operating rules, not authentication or protection against deliberate impersonation.

### 5.7 Quality that can be demonstrated

**The complete journeys work coherently, and claims about behavior are backed by acceptance evidence.**

Local and remote interoperability is part of this release: verify a local environment and two remote environments
communicating and stopping agents, and verify that 100 agents in one window remain usable. 100 is a required test
scale, not a product cap; larger sessions may start without a claim that their usability has been tested. A real VS
Code user must walk the product before public use.

Normal use, cancellation, errors, reconnect and reopening have defined outcomes. The user sees what actually happened
and retains access to failures. A passing build alone does not prove the product works. Unsupported or unverified
capabilities are named; technical limitations do not quietly redefine the product.

## Change log

- 2026-10-31: Added the owner-authorized Resume and linked Pin/Unpin step, using Facade Dots as the reference.

- 2026-10-31: Configured custom CLIs run interactively beside the built-ins (CLIS-3.4).
- 2026-10-30: Step 2 of the Facade Code extension: agents start, message and operate one another across this computer's
  windows (1.1, 2.1, 3.1, 5.1, 5.6), with the Facade Dots wording; 4.2 adds the owner's plain-language rule (D96); 5.7
  requires local and two remote environments communicating and stopping agents.

- 2026-10-29: Step 1 of the Facade Code extension, carried from the Facade Dots specification: the rules step 1
  needs, each with its final number. Later steps add the others.
